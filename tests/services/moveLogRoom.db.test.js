'use strict';

// Смена аудитории пишется в журнал отдельным действием ('room'): карточка
// занятия, окно переноса, «Вывод аудитории». Отменяется той же кнопкой ↩, что и
// перенос, — возвращает прежнюю аудиторию. «Отменить» (undo) убирает запись.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-movelog-room-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, editLesson, moveLesson, getMoveLog, clearMoveLog, revertMove } = require('../../src/services/scheduleService');
const { performUndo } = require('../../src/services/undoService');
const { loadLessons } = require('../../src/services/conflictService');
const { saveSemester } = require('../../src/services/settingsService');

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-12-31', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 10);
  for (const [name, cap] of [['А-1', 30], ['А-2', 30], ['А-3', 30]]) {
    db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run(name, cap);
  }
});

test.after(() => {
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) fs.rmSync(f, { force: true });
});

const make = (day, pairNo, rooms) =>
  createLesson({ day, pairNo, weekNo: 1, subject: 'РТС', type: 'ПЗ', teacher: 'Иванов И.И.', groups: ['G1'], rooms });

const roomsOf = (id) => {
  const l = loadLessons().find((x) => x.id === id);
  return l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []);
};
const roomEntries = (id) => getMoveLog().filter((e) => e.lessonId === id && e.action === 'room');

test('правка аудитории в карточке — запись «Смена аудитории», слот в ней не меняется', () => {
  const id = make('Пн', 1, ['А-1']).id;
  clearMoveLog();

  assert.equal(editLesson(id, { rooms: ['А-2'] }).ok, true);

  const log = roomEntries(id);
  assert.equal(log.length, 1);
  assert.equal(log[0].fromRoom, 'А-1');
  assert.equal(log[0].room, 'А-2');
  // День/пара/неделя в записи одинаковы с обеих сторон — переносом это не было.
  assert.deepEqual([log[0].fromDay, log[0].fromPair, log[0].fromWeek], ['Пн', 1, 1]);
  assert.deepEqual([log[0].toDay, log[0].toPair, log[0].toWeek], ['Пн', 1, 1]);
});

test('правка темы аудиторию не трогает — записи нет', () => {
  const id = make('Вт', 1, ['А-1']).id;
  clearMoveLog();
  assert.equal(editLesson(id, { topic: 'Т.9' }).ok, true);
  assert.equal(roomEntries(id).length, 0);
});

test('смена слота в карточке пишется как перенос, а не как смена аудитории', () => {
  const id = make('Ср', 1, ['А-1']).id;
  clearMoveLog();

  assert.equal(editLesson(id, { day: 'Чт', pairNo: 2, weekNo: 1 }).ok, true);

  const log = getMoveLog().filter((e) => e.lessonId === id);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'move');
  assert.deepEqual([log[0].fromDay, log[0].fromPair], ['Ср', 1]);
  assert.deepEqual([log[0].toDay, log[0].toPair], ['Чт', 2]);
});

test('перенос в тот же слот с другой аудиторией — это смена аудитории', () => {
  const id = make('Пт', 1, ['А-1']).id;
  clearMoveLog();

  assert.equal(moveLesson(id, { day: 'Пт', pairNo: 1, weekNo: 1, rooms: ['А-3'], force: true }).ok, true);

  const log = getMoveLog().filter((e) => e.lessonId === id);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'room');
  assert.equal(log[0].fromRoom, 'А-1');
  assert.equal(log[0].room, 'А-3');
});

test('↩ у записи возвращает прежнюю аудиторию и убирает запись', () => {
  const id = make('Сб', 1, ['А-1']).id;
  clearMoveLog();
  assert.equal(editLesson(id, { rooms: ['А-2'] }).ok, true);
  assert.deepEqual(roomsOf(id), ['А-2']);

  const e = roomEntries(id)[0];
  assert.equal(revertMove(e.id).ok, true);
  assert.deepEqual(roomsOf(id), ['А-1'], 'аудитория вернулась');
  assert.equal(roomEntries(id).length, 0, 'запись снята');
});

test('отменить можно только последнюю запись занятия', () => {
  const id = make('Пн', 3, ['А-1']).id;
  clearMoveLog();
  assert.equal(editLesson(id, { rooms: ['А-2'] }).ok, true);
  assert.equal(editLesson(id, { rooms: ['А-3'] }).ok, true);

  const [last, first] = roomEntries(id); // журнал DESC по id
  assert.equal(revertMove(first.id).ok, false);
  assert.equal(revertMove(last.id).ok, true);
  assert.deepEqual(roomsOf(id), ['А-2'], 'вернулась предыдущая аудитория, а не самая первая');
});

test('undo правки аудитории убирает и запись журнала', () => {
  const id = make('Вт', 3, ['А-1']).id;
  clearMoveLog();
  assert.equal(editLesson(id, { rooms: ['А-2'] }).ok, true);
  assert.equal(roomEntries(id).length, 1);

  assert.equal(performUndo().ok, true);
  assert.deepEqual(roomsOf(id), ['А-1']);
  assert.equal(roomEntries(id).length, 0, 'следа в журнале не осталось');
});

const slotOf = (id) => {
  const l = loadLessons().find((x) => x.id === id);
  return [l.day, l.pairNo];
};

test('↩ переноса в занятую аудиторию — предупреждение: без force спрашивает, с force возвращает', () => {
  const id = make('Ср', 3, ['А-1']).id;
  clearMoveLog();
  assert.equal(moveLesson(id, { day: 'Чт', pairNo: 3, weekNo: 1, rooms: ['А-1'], force: true }).ok, true);
  // Прежнюю аудиторию заняла другая группа с другим преподавателем: это не
  // накладка людей, а только занятая аудитория.
  createLesson({ day: 'Ср', pairNo: 3, weekNo: 1, subject: 'ФИЗ', type: 'ПЗ', teacher: 'Петров П.П.', groups: ['G2'], rooms: ['А-1'] });

  const e = getMoveLog().find((x) => x.lessonId === id);
  const soft = revertMove(e.id);
  assert.equal(soft.ok, false);
  assert.equal(soft.confirm, true, 'подтверждение, а не молчаливое размещение');
  assert.ok(soft.warnings.length > 0);
  assert.deepEqual(slotOf(id), ['Чт', 3], 'без подтверждения ничего не сдвинулось');

  assert.equal(revertMove(e.id, true).ok, true);
  assert.deepEqual(slotOf(id), ['Ср', 3]);
});

// Копия занятия в той же ячейке: такие дубли бывают после импорта.
function dupLesson(id) {
  const db = getDb();
  const cols = (t, skip) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((n) => !skip.includes(n));
  const lc = cols('lessons', ['id']).join(', ');
  const newId = Number(db.prepare(`INSERT INTO lessons (${lc}) SELECT ${lc} FROM lessons WHERE id = ?`).run(id).lastInsertRowid);
  for (const t of ['lesson_groups', 'lesson_rooms', 'lesson_teachers']) {
    const c = cols(t, ['id', 'lesson_id']).join(', ');
    db.prepare(`INSERT INTO ${t} (lesson_id, ${c}) SELECT ?, ${c} FROM ${t} WHERE lesson_id = ?`).run(newId, id);
  }
  return newId;
}

test('↩ находит занятие по id записи, даже если в ячейке есть такое же', () => {
  const id = make('Пт', 3, ['А-2']).id;
  clearMoveLog();
  assert.equal(moveLesson(id, { day: 'Сб', pairNo: 3, weekNo: 1, rooms: ['А-2'], force: true }).ok, true);
  const twin = dupLesson(id);

  const e = getMoveLog().find((x) => x.lessonId === id);
  const res = revertMove(e.id);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.deepEqual(slotOf(id), ['Пт', 3], 'вернулось занятие из записи');
  assert.deepEqual(slotOf(twin), ['Сб', 3], 'копия осталась на месте');
});
