'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-freerooms-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, parkLesson, getFreeRooms } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');

// Контракт, на который опирается карточка занятия: в выпадающем списке аудиторий
// показываются только свободные для этого занятия в выбранном слоте.
const names = (lessonId, day, pairNo, weekNo) =>
  getFreeRooms(lessonId, day, pairNo, weekNo).rooms.map((r) => r.name);

let ownRoomLesson, hiddenRoomLesson, parkedLesson;

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 10);
  const room = db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,?)');
  room.run('A', 40, 0);
  room.run('B', 40, 0);
  room.run('C', 40, 1); // скрытая — в списках её быть не должно
  room.run('D', 40, 0);

  const make = (day, pairNo, rooms) =>
    createLesson({ day, pairNo, weekNo: 1, subject: 'РТС', teacher: 'Иванов И.И.', groups: ['G1'], rooms }).id;

  ownRoomLesson = make('Пн', 1, ['A']); // занятие, которое редактируем
  make('Пн', 2, ['B']); // занимает B в слоте Пн/2
  hiddenRoomLesson = make('Вт', 1, ['C']); // сидит в скрытой аудитории
  parkedLesson = make('Ср', 1, ['D']);
  parkLesson(parkedLesson); // отложено в буфер — аудиторию больше не занимает
});

test.after(() => {
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) fs.rmSync(f, { force: true });
});

test('своя аудитория занятия свободна в его собственном слоте', () => {
  const free = names(ownRoomLesson, 'Пн', 1, 1);
  assert.ok(free.includes('A'), 'в своём слоте занятие не занимает аудиторию само у себя');
  assert.ok(free.includes('B'), 'B занята в другом слоте — здесь свободна');
});

test('аудитория, занятая другим занятием в этом слоте, в список не попадает', () => {
  const free = names(ownRoomLesson, 'Пн', 2, 1);
  assert.equal(free.includes('B'), false, 'B занята занятием в слоте Пн/2');
  assert.ok(free.includes('A'), 'A в этом слоте свободна');
});

test('занятые аудитории отдаются отдельным списком busyRooms — с указанием, кто занимает', () => {
  const { rooms, busyRooms } = getFreeRooms(ownRoomLesson, 'Пн', 2, 1);
  const busyB = busyRooms.find((r) => r.name === 'B');
  assert.ok(busyB, 'B занята в слоте Пн/2 → попадает в busyRooms');
  assert.match(busyB.busyBy, /G1/, 'видно, чья пара занимает аудиторию');
  assert.equal(busyB.capacity, 40, 'вместимость есть и у занятых');
  assert.equal(rooms.some((r) => r.name === 'B'), false, 'в rooms остаются ТОЛЬКО свободные');
  // Скрытая аудитория не всплывает через занятые.
  assert.equal(busyRooms.some((r) => r.name === 'C'), false);
  // Своя аудитория в своём слоте занятой не считается.
  assert.equal(getFreeRooms(ownRoomLesson, 'Пн', 1, 1).busyRooms.some((r) => r.name === 'A'), false);
});

test('скрытая аудитория показывается только тому занятию, что в ней стоит', () => {
  assert.equal(names(ownRoomLesson, 'Пн', 1, 1).includes('C'), false, 'чужому занятию скрытую не предлагаем');
  assert.ok(names(hiddenRoomLesson, 'Вт', 1, 1).includes('C'), 'иначе при сохранении карточки аудитория потерялась бы');
});

test('отложенное в буфер занятие аудиторию не занимает', () => {
  assert.ok(names(ownRoomLesson, 'Ср', 1, 1).includes('D'));
});

test('вместимость возвращается вместе с признаком «вмещает»', () => {
  const rooms = getFreeRooms(ownRoomLesson, 'Пн', 1, 1).rooms;
  const a = rooms.find((r) => r.name === 'A');
  assert.equal(a.capacity, 40);
  assert.equal(a.fits, true, 'группа из 10 курсантов помещается в аудиторию на 40 мест');

  // Аудитория меньше группы остаётся в списке, но помечена как не вмещающая:
  // выбор за пользователем, а сортировка уводит такие вниз.
  getDb().prepare('UPDATE rooms SET capacity = 5 WHERE name = ?').run('B');
  const b = getFreeRooms(ownRoomLesson, 'Пн', 1, 1).rooms.find((r) => r.name === 'B');
  assert.equal(b.fits, false);
});
