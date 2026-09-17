'use strict';

// Бронь занятия (lessons.locked): пока стоит — занятие не переносится ни одним
// путём (перенос, возврат из журнала, смена слота в карточке). Правка полей и
// удаление бронью не запрещены — она держит только МЕСТО в сетке.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-locked-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { createLesson, setLessonLocked, moveLesson, editLesson, revertMove, getMoveLog, deleteLesson } =
  require('../../src/services/scheduleService');
const { performUndo } = require('../../src/services/undoService');
const { saveSemester } = require('../../src/services/settingsService');

const SLOT = { day: 'Пн', pairNo: 1, weekNo: 1 };
const FREE = { day: 'Пн', pairNo: 2, weekNo: 1 };
let id;

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 30);
  const r = createLesson({ ...SLOT, subject: 'РТС', type: 'ПЗ', teacher: 'Иванов И.И.', groups: ['G1'], rooms: ['A'] });
  assert.equal(r.ok, true);
  id = loadLessons().find((l) => l.subject === 'РТС').id;
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('без брони занятие переносится, бронь запрещает перенос', () => {
  assert.equal(loadLessons().find((l) => l.id === id).locked, false);
  assert.equal(moveLesson(id, { ...FREE }).ok, true);

  assert.equal(setLessonLocked(id, true).ok, true);
  assert.equal(loadLessons().find((l) => l.id === id).locked, true);

  const res = moveLesson(id, { ...SLOT });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /забронировано/i);
  // Занятие осталось на месте.
  const after = loadLessons().find((l) => l.id === id);
  assert.equal(after.day, FREE.day);
  assert.equal(after.pairNo, FREE.pairNo);
});

test('бронь нельзя обойти подтверждением (force)', () => {
  assert.equal(moveLesson(id, { ...SLOT, force: true }).ok, false);
});

test('смена слота в карточке запрещена, правка полей — разрешена', () => {
  assert.equal(editLesson(id, { pairNo: SLOT.pairNo }).ok, false);
  assert.equal(editLesson(id, { topic: 'Т.1' }).ok, true);
  assert.equal(loadLessons().find((l) => l.id === id).topic, 'Т.1');
});

test('возврат из журнала переносов тоже упирается в бронь', () => {
  const entry = getMoveLog().find((m) => m.subject === 'РТС' && m.action === 'move');
  assert.ok(entry, 'запись о переносе есть в журнале');
  const res = revertMove(entry.id);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /забронировано/i);
});

test('снятая бронь возвращает перенос, удаление бронью не запрещено', () => {
  assert.equal(setLessonLocked(id, false).ok, true);
  assert.equal(moveLesson(id, { ...SLOT }).ok, true);
  assert.equal(setLessonLocked(id, true).ok, true);
  assert.equal(deleteLesson(id).ok, true);
  assert.equal(setLessonLocked(id, true).ok, false); // занятия больше нет
});

test('«Отменить» возвращает удалённое занятие ВМЕСТЕ с бронью', () => {
  assert.equal(performUndo().ok, true);
  const back = loadLessons().find((l) => l.subject === 'РТС');
  assert.ok(back, 'занятие восстановлено');
  assert.equal(back.locked, true);
  assert.equal(moveLesson(back.id, { ...FREE }).ok, false);
});
