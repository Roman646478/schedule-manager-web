'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-blockslot-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { createLesson, blockTeacherSlot, getFreeSlotsFor } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

const TEACHER = 'Сидоров С.С.';

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 30);

  // Занятое занятие у преподавателя — Пн, пара 1, неделя 1. Пара 2 остаётся свободной.
  assert.equal(
    createLesson({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G1'], rooms: ['A'] }).ok,
    true
  );
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('blockTeacherSlot: некорректные параметры — отказ 400', () => {
  assert.equal(blockTeacherSlot('', 'Пн', 2, 1).ok, false);
  assert.equal(blockTeacherSlot(TEACHER, 'Плохой', 2, 1).ok, false);
  assert.equal(blockTeacherSlot(TEACHER, 'Пн', 0, 1).ok, false);
  assert.equal(blockTeacherSlot(TEACHER, 'Пн', 2, 0).ok, false);
});

test('blockTeacherSlot: занятая ячейка (уже есть занятие) — отказ 409', () => {
  const res = blockTeacherSlot(TEACHER, 'Пн', 1, 1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 409);
});

test('blockTeacherSlot: блокирует свободную ячейку — создаёт мероприятие без групп/аудитории', () => {
  const before = getFreeSlotsFor({ teacher: TEACHER, weekNo: 1 }).slots.find((s) => s.day === 'Пн' && s.pairNo === 2);
  assert.equal(before.free, true, 'пара 2 понедельника свободна у преподавателя до блокировки');

  const res = blockTeacherSlot(TEACHER, 'Пн', 2, 1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.ok(res.id);

  const created = loadLessons().find((l) => l.id === res.id);
  assert.ok(created);
  assert.equal(created.category, 'event');
  assert.equal(created.teacher, TEACHER);
  assert.deepEqual(created.groups, []);
  assert.equal(created.room, null);

  const after = getFreeSlotsFor({ teacher: TEACHER, weekNo: 1 }).slots.find((s) => s.day === 'Пн' && s.pairNo === 2);
  assert.equal(after.free, false, 'после блокировки ячейка больше не свободна у преподавателя');
});

test('blockTeacherSlot: повторная блокировка той же (уже заблокированной) ячейки — отказ 409', () => {
  const res = blockTeacherSlot(TEACHER, 'Пн', 2, 1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 409);
});

test('blockTeacherSlot: другая свободная ячейка (Пн, пара 3) блокируется независимо', () => {
  const res = blockTeacherSlot(TEACHER, 'Пн', 3, 1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
});

test('blockTeacherSlot: undo снимает последнюю блокировку', () => {
  const before = getFreeSlotsFor({ teacher: TEACHER, weekNo: 1 }).slots.find((s) => s.day === 'Пн' && s.pairNo === 3);
  assert.equal(before.free, false);

  assert.equal(performUndo().ok, true);

  const after = getFreeSlotsFor({ teacher: TEACHER, weekNo: 1 }).slots.find((s) => s.day === 'Пн' && s.pairNo === 3);
  assert.equal(after.free, true, 'после отмены ячейка снова свободна');
});
