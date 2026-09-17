'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-clearhidden-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const {
  createLesson,
  parkLesson,
  previewHiddenGroupTeacherLessons,
  clearHiddenGroupTeacherLessons,
} = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

const TEACHER = 'Иванов И.И.';
const OTHER_TEACHER = 'Петров П.П.';

let lonelyHiddenId, mixedId, visibleId, streamHiddenId, otherTeacherId, parkedHiddenId;

// G1 — отображаемая группа, G2/G3 — скрытые.
test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);

  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,?)');
  g.run('G1', 10, 0);
  g.run('G2', 10, 1);
  g.run('G3', 10, 1);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 40);

  // Занятие целиком у скрытой группы — должно попасть под удаление.
  lonelyHiddenId = createLesson({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G2'], rooms: ['A'] }).id;
  assert.ok(lonelyHiddenId);

  // Потоковое занятие: одна группа отображается, одна скрыта — НЕ должно удаляться.
  mixedId = createLesson({ day: 'Пн', pairNo: 2, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G1', 'G2'], rooms: ['A'] }).id;
  assert.ok(mixedId);

  // Обычное занятие видимой группы — не трогаем.
  visibleId = createLesson({ day: 'Пн', pairNo: 3, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G1'], rooms: ['A'] }).id;
  assert.ok(visibleId);

  // Потоковое занятие ДВУХ скрытых групп — должно удалиться целиком.
  streamHiddenId = createLesson({ day: 'Вт', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G2', 'G3'], rooms: ['A'] }).id;
  assert.ok(streamHiddenId);

  // Занятие скрытой группы у ДРУГОГО преподавателя — не должно трогаться при чистке TEACHER.
  otherTeacherId = createLesson({ day: 'Ср', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: OTHER_TEACHER, groups: ['G2'], rooms: ['A'] }).id;
  assert.ok(otherTeacherId);

  // Занятие скрытой группы, но отложенное в буфер — вне расписания, не учитывается.
  parkedHiddenId = createLesson({ day: 'Чт', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: TEACHER, groups: ['G3'], rooms: ['A'] }).id;
  assert.ok(parkedHiddenId);
  assert.equal(parkLesson(parkedHiddenId).ok, true);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('previewHiddenGroupTeacherLessons: находит только занятия целиком скрытых групп', () => {
  const res = previewHiddenGroupTeacherLessons(TEACHER);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2, 'lonelyHidden + streamHidden (mixed/parked/visible исключены)');
  assert.deepEqual(res.groups, ['G2', 'G3']);
  // Предпросмотр не должен ничего менять.
  assert.equal(loadLessons().length, 6);
});

test('previewHiddenGroupTeacherLessons: без преподавателя — отказ', () => {
  const res = previewHiddenGroupTeacherLessons('');
  assert.equal(res.ok, false);
});

test('clearHiddenGroupTeacherLessons: удаляет только полностью скрытые занятия этого преподавателя', () => {
  const res = clearHiddenGroupTeacherLessons(TEACHER);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.groups.sort(), ['G2', 'G3']);

  const ids = loadLessons().map((l) => l.id);
  assert.ok(!ids.includes(lonelyHiddenId), 'занятие целиком скрытой группы удалено');
  assert.ok(!ids.includes(streamHiddenId), 'потоковое занятие двух скрытых групп удалено');
  assert.ok(ids.includes(mixedId), 'смешанное занятие (есть видимая группа) осталось');
  assert.ok(ids.includes(visibleId), 'занятие видимой группы осталось');
  assert.ok(ids.includes(otherTeacherId), 'занятие другого преподавателя не тронуто');
  assert.ok(ids.includes(parkedHiddenId), 'занятие в буфере не тронуто');
});

test('clearHiddenGroupTeacherLessons: повторный вызов — отказ (нечего удалять)', () => {
  const res = clearHiddenGroupTeacherLessons(TEACHER);
  assert.equal(res.ok, false);
});

test('clearHiddenGroupTeacherLessons: undo восстанавливает удалённые занятия', () => {
  assert.equal(performUndo().ok, true);
  // Восстановленные занятия получают новые id (как и в clearSrWeek/deleteEntitySchedule) —
  // сверяем по содержимому, а не по исходному id.
  const restored = loadLessons().filter((l) => !l.parked && l.teacher === TEACHER);
  assert.ok(restored.some((l) => (l.groups || []).join(',') === 'G2'), 'занятие целиком скрытой группы G2 вернулось');
  assert.ok(restored.some((l) => (l.groups || []).slice().sort().join(',') === 'G2,G3'), 'потоковое занятие G2+G3 вернулось');
});
