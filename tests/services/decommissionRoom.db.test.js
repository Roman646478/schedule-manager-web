'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-decomm-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { createLesson, decommissionRoom, getMoveLog } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

// Синтетическая база: семестр в 1 неделю, аудитории с кафедрами/вместимостью.
test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);

  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  g.run('G1', 20); g.run('G2', 20); g.run('G3', 20);

  const r = db.prepare('INSERT INTO rooms(name, capacity, dept, hidden) VALUES(?,?,?,0)');
  r.run('A', 30, 'Каф1');   // выводимая
  r.run('B', 30, 'Каф1');   // та же кафедра — приоритетная цель
  r.run('C', 30, 'Каф2');   // другая кафедра
  r.run('Tiny', 5, 'Каф1'); // мала по вместимости

  // L1: занятие в A на Пн п1 — есть свободные B и C → должно уйти в B (та же кафедра).
  assert.equal(createLesson({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'РТС', groups: ['G1'], rooms: ['A'] }).ok, true);
  // L2: занятие в A на Пн п2 — B и C заняты, Tiny мала → должно уйти в буфер.
  assert.equal(createLesson({ day: 'Пн', pairNo: 2, weekNo: 1, subject: 'РТС', groups: ['G1'], rooms: ['A'] }).ok, true);
  assert.equal(createLesson({ day: 'Пн', pairNo: 2, weekNo: 1, subject: 'ИЭП', groups: ['G2'], rooms: ['B'] }).ok, true);
  assert.equal(createLesson({ day: 'Пн', pairNo: 2, weekNo: 1, subject: 'ИЭП', groups: ['G3'], rooms: ['C'] }).ok, true);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('decommissionRoom: переселяет на ту же кафедру, иначе — в буфер, и пишет в журнал', () => {
  const res = decommissionRoom('A', '2025-09-01', '2025-09-01', 'ремонт');
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.equal(res.movedCount, 1, 'одно занятие переселено');
  assert.equal(res.parked, 1, 'одно занятие ушло в буфер');

  const ls = loadLessons();
  const l1 = ls.find((l) => l.subject === 'РТС' && l.pairNo === 1);
  const l2 = ls.find((l) => l.subject === 'РТС' && l.pairNo === 2);

  // Приоритет кафедры: L1 ушёл в B (Каф1), а не в C (Каф2).
  assert.deepEqual(l1.rooms, ['B'], 'L1 переселён в аудиторию своей кафедры');
  assert.ok(!l1.parked, 'L1 не в буфере');

  // Буфер: L2 запаркован, аудитория A снята.
  assert.ok(l2.parked, 'L2 в буфере');
  assert.ok(!(l2.rooms || []).includes('A'), 'A снята с L2');

  // Журнал: запись о переселении (A → B) и об уходе в буфер (A → null) —
  // действием «смена аудитории», как ручная правка и подбор аудиторий.
  const log = getMoveLog();
  const relocate = log.find((e) => e.fromRoom === 'A' && e.room === 'B');
  const toBuffer = log.find((e) => e.fromRoom === 'A' && e.room == null);
  assert.ok(relocate, 'в журнале есть запись A → B');
  assert.ok(toBuffer, 'в журнале есть запись о буфере (A → null)');
  assert.equal(relocate.action, 'room');
  assert.equal(toBuffer.action, 'room');
});

test('decommissionRoom: undo возвращает аудитории и снимает буфер', () => {
  assert.equal(performUndo().ok, true);
  const ls = loadLessons();
  const l1 = ls.find((l) => l.subject === 'РТС' && l.pairNo === 1);
  const l2 = ls.find((l) => l.subject === 'РТС' && l.pairNo === 2);
  assert.deepEqual(l1.rooms, ['A'], 'L1 вернулся в A');
  assert.deepEqual(l2.rooms, ['A'], 'L2 вернулся в A');
  assert.ok(!l2.parked, 'L2 не в буфере после отмены');
  // Журнал отражает реальность: записей о выводе аудитории после отката нет.
  assert.equal(getMoveLog().filter((e) => e.action === 'room').length, 0);
});
