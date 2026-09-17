'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-clearsr-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { createLesson, clearSrWeek } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

// Семестр в 2 недели — чтобы проверить, что чистится только выбранная.
test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-13', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 30);

  // 2 СР на неделе 1, одно обычное занятие на неделе 1, и одно СР на неделе 2.
  assert.equal(createLesson({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'СР', groups: ['G1'], rooms: ['A'] }).ok, true);
  assert.equal(createLesson({ day: 'Пн', pairNo: 2, weekNo: 1, subject: 'СР', groups: ['G1'], rooms: ['A'] }).ok, true);
  assert.equal(createLesson({ day: 'Пн', pairNo: 3, weekNo: 1, subject: 'РТС', groups: ['G1'], rooms: ['A'] }).ok, true);
  assert.equal(createLesson({ day: 'Пн', pairNo: 1, weekNo: 2, subject: 'СР', groups: ['G1'], rooms: ['A'] }).ok, true);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('clearSrWeek: удаляет только СР выбранной недели, не трогая прочее', () => {
  const res = clearSrWeek(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.equal(res.deleted, 2, 'удалены два СР недели 1');

  const ls = loadLessons();
  assert.equal(ls.filter((l) => l.subject === 'СР' && l.weekNo === 1).length, 0, 'СР недели 1 не осталось');
  assert.ok(ls.some((l) => l.subject === 'РТС' && l.weekNo === 1), 'обычное занятие недели 1 на месте');
  assert.ok(ls.some((l) => l.subject === 'СР' && l.weekNo === 2), 'СР недели 2 не тронуто');
});

test('clearSrWeek: на неделе без СР возвращает отказ', () => {
  const res = clearSrWeek(1);
  assert.equal(res.ok, false, 'повторный вызов — нечего удалять');
});

test('clearSrWeek: undo восстанавливает удалённые СР', () => {
  assert.equal(performUndo().ok, true);
  const ls = loadLessons();
  assert.equal(ls.filter((l) => l.subject === 'СР' && l.weekNo === 1).length, 2, 'оба СР недели 1 вернулись');
});
