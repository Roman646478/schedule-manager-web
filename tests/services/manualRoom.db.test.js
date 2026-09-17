'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-manualroom-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, editLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');

// Контракт поля «впишите аудиторию вручную» в карточке занятия: имя ищется среди
// ВСЕХ аудиторий (в т.ч. скрытых), новая заводится только если такой ещё нет.
const roomOf = (lessonId) =>
  getDb().prepare('SELECT r.name FROM lessons l JOIN rooms r ON r.id = l.room_id WHERE l.id = ?').get(lessonId).name;
// Плоские объекты: строки sqlite приходят с null-прототипом и не проходят deepEqual.
const roomRow = (name) =>
  getDb().prepare('SELECT name, hidden FROM rooms WHERE name = ?').all(name).map((r) => ({ name: r.name, hidden: r.hidden }));

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 10);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,?)').run('Скрытая-1', 40, 1);
});

test.after(() => {
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) fs.rmSync(f, { force: true });
});

const make = (day, rooms) =>
  createLesson({ day, pairNo: 1, weekNo: 1, subject: 'РТС', teacher: 'Иванов И.И.', groups: ['G1'], rooms });

test('вписанная скрытая аудитория переиспользуется, дубль не заводится', () => {
  const res = make('Пн', ['Скрытая-1']);
  assert.equal(res.ok, true);
  assert.equal(roomOf(res.id), 'Скрытая-1');
  assert.deepEqual(roomRow('Скрытая-1'), [{ name: 'Скрытая-1', hidden: 1 }]); // ровно одна, всё ещё скрытая
});

test('неизвестная аудитория заводится новой и видимой', () => {
  const res = make('Вт', ['Новая-9']);
  assert.equal(res.ok, true);
  assert.equal(roomOf(res.id), 'Новая-9');
  assert.deepEqual(roomRow('Новая-9'), [{ name: 'Новая-9', hidden: 0 }]);
});

test('правка карточки: вписанная аудитория так же ищется и заводится', () => {
  const res = make('Ср', ['Новая-9']);
  assert.equal(editLesson(res.id, { rooms: ['Ещё-одна'] }).ok, true);
  assert.equal(roomOf(res.id), 'Ещё-одна');
  assert.equal(roomRow('Ещё-одна').length, 1);
  // Повторная правка на уже существующее имя второй записи не создаёт.
  assert.equal(editLesson(res.id, { rooms: ['Скрытая-1'] }).ok, true);
  assert.equal(roomRow('Скрытая-1').length, 1);
});

// У ВТОРОЙ аудитории такое же поле ручного ввода, как у основной: вписанное имя
// ищется среди существующих и заводится новым, не затирая основную аудиторию.
test('вторая аудитория: вписанная вручную встаёт рядом с выбранной основной', () => {
  const rooms = (lessonId) => getDb()
    .prepare('SELECT r.name FROM lesson_rooms lr JOIN rooms r ON r.id = lr.room_id WHERE lr.lesson_id = ? ORDER BY r.name')
    .all(lessonId).map((r) => r.name);

  // Основная — существующая, вторая — вписана вручную.
  const res = make('Пт', ['Скрытая-1', 'Зал-Б']);
  assert.equal(res.ok, true);
  assert.deepEqual(rooms(res.id), ['Зал-Б', 'Скрытая-1'], 'сохранились обе аудитории');
  assert.equal(roomOf(res.id), 'Скрытая-1', 'основной осталась первая');
  assert.deepEqual(roomRow('Зал-Б'), [{ name: 'Зал-Б', hidden: 0 }], 'новая аудитория заведена один раз');

  // Правка: вторую меняем на уже существующую — дубля не появляется.
  assert.equal(editLesson(res.id, { rooms: ['Скрытая-1', 'Новая-9'] }).ok, true);
  assert.deepEqual(rooms(res.id), ['Новая-9', 'Скрытая-1']);
  assert.equal(roomRow('Новая-9').length, 1);

  // Одинаковые имена в обоих полях схлопываются в одну аудиторию.
  assert.equal(editLesson(res.id, { rooms: ['Зал-Б', 'Зал-Б'] }).ok, true);
  assert.deepEqual(rooms(res.id), ['Зал-Б']);
});

test('пробелы по краям не плодят двойников', () => {
  const res = make('Чт', ['  Новая-9  ']);
  assert.equal(roomOf(res.id), 'Новая-9');
  assert.equal(roomRow('Новая-9').length, 1);
});
