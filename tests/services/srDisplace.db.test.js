'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-srmove-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { getMoveOptions, moveLesson, createLesson, editLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

// Занятие встаёт на место СР: самоподготовка — заполнитель свободного окна.
test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  g.run('81-1', 20); g.run('81-2', 20); g.run('81-3', 20);
  const r = db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)');
  r.run('Ауд1', 100); r.run('Ауд2', 100);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

// ── помощники ────────────────────────────────────────────────────────────────

// Занятие в слоте с перечисленными группами. room — имя аудитории или null.
function addLesson(day, pairNo, subject, groups, room, extra = {}) {
  const db = getDb();
  const roomId = room
    ? (db.prepare('SELECT id FROM rooms WHERE name = ?').get(room) || {}).id
    : null;
  const info = db.prepare(
    `INSERT INTO lessons(day, pair_no, week_no, subject, type, category, room_id, locked)
     VALUES(?, ?, 1, ?, ?, 'lesson', ?, ?)`
  ).run(day, pairNo, subject, extra.type || null, roomId ?? null, extra.locked ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  const insG = db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?');
  for (const g of groups) insG.run(id, g);
  if (roomId) db.prepare('INSERT INTO lesson_rooms(lesson_id, room_id) VALUES(?, ?)').run(id, roomId);
  return id;
}

const at = (day, pairNo) => loadLessons().filter((l) => l.day === day && l.pairNo === pairNo && l.weekNo === 1);
const wipe = () => getDb().prepare('DELETE FROM lessons').run();

// ── тесты ────────────────────────────────────────────────────────────────────

test('ячейка с СР предлагается как свободная для переноса', () => {
  addLesson('Пн', 1, 'СР', ['81-1'], 'Ауд1');
  const lessonId = addLesson('Вт', 1, 'ТПРН', ['81-1'], null, { type: 'ПЗ' });

  const { slots } = getMoveOptions(lessonId, 1);
  const target = slots.find((s) => s.day === 'Пн' && s.pairNo === 1);
  assert.equal(target.groupFree, true, 'слот с СР предлагается для переноса');
  wipe();
});

test('перенос на одиночную СР: СР удаляется вместе с аудиторией', () => {
  addLesson('Пн', 1, 'СР', ['81-1'], 'Ауд1');
  const lessonId = addLesson('Вт', 1, 'ТПРН', ['81-1'], null, { type: 'ПЗ' });

  const res = moveLesson(lessonId, { day: 'Пн', pairNo: 1, weekNo: 1 });
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const slot = at('Пн', 1);
  assert.equal(slot.length, 1, 'в слоте осталось одно занятие');
  assert.equal(slot[0].id, lessonId, 'это перенесённая пара, а не СР');
  assert.ok(!loadLessons().some((l) => l.subject === 'СР'), 'СР удалена целиком');

  // Отмена возвращает и занятие, и СР с её аудиторией.
  assert.equal(performUndo().ok, true);
  const back = at('Пн', 1);
  assert.equal(back.length, 1);
  assert.equal(back[0].subject, 'СР', 'СР вернулась на место');
  assert.deepEqual(back[0].groups, ['81-1']);
  assert.deepEqual(back[0].rooms, ['Ауд1'], 'аудитория СР восстановлена');
  assert.ok(at('Вт', 1).some((l) => l.id === lessonId), 'занятие вернулось в исходный слот');
  wipe();
});

test('перенос на потоковую СР: уходит только своя группа, остальные остаются', () => {
  const srId = addLesson('Ср', 1, 'СР', ['81-1', '81-2', '81-3'], 'Ауд2');
  const lessonId = addLesson('Чт', 1, 'ТПРН', ['81-2'], null, { type: 'ПЗ' });

  const res = moveLesson(lessonId, { day: 'Ср', pairNo: 1, weekNo: 1 });
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const sr = loadLessons().find((l) => l.id === srId);
  assert.ok(sr, 'потоковая СР не удалена — в ней остались группы');
  assert.deepEqual([...sr.groups].sort(), ['81-1', '81-3'], 'убрана только перенесённая группа');
  assert.deepEqual(sr.rooms, ['Ауд2'], 'оставшиеся группы сидят в той же аудитории');

  assert.equal(performUndo().ok, true);
  const after = loadLessons().find((l) => l.subject === 'СР');
  assert.deepEqual([...after.groups].sort(), ['81-1', '81-2', '81-3'], 'состав СР восстановлен');
  wipe();
});

test('накладка с настоящим занятием остаётся запретом', () => {
  addLesson('Пт', 1, 'МАТ', ['81-1'], 'Ауд1', { type: 'Л' });
  const lessonId = addLesson('Пн', 2, 'ТПРН', ['81-1'], null, { type: 'ПЗ' });

  const { slots } = getMoveOptions(lessonId, 1);
  assert.equal(slots.find((s) => s.day === 'Пт' && s.pairNo === 1).groupFree, false);
  const res = moveLesson(lessonId, { day: 'Пт', pairNo: 1, weekNo: 1 });
  assert.equal(res.ok, false, 'занятие поверх занятия по-прежнему нельзя');
  assert.match(String(res.reasons), /занята/);
  wipe();
});

test('забронированная СР не вытесняется', () => {
  addLesson('Пн', 3, 'СР', ['81-1'], 'Ауд1', { locked: true });
  const lessonId = addLesson('Вт', 3, 'ТПРН', ['81-1'], null, { type: 'ПЗ' });

  const { slots } = getMoveOptions(lessonId, 1);
  assert.equal(slots.find((s) => s.day === 'Пн' && s.pairNo === 3).groupFree, false, 'бронь закрывает слот');
  const res = moveLesson(lessonId, { day: 'Пн', pairNo: 3, weekNo: 1 });
  assert.equal(res.ok, false, 'забронированную СР не подвинуть');
  wipe();
});

test('вставка копии и правка слота тоже встают на место СР', () => {
  const srId = addLesson('Пн', 4, 'СР', ['81-1', '81-2'], 'Ауд1');

  // 1. Вставка копии (Ctrl+V / «Добавить занятие»).
  const created = createLesson({
    day: 'Пн', pairNo: 4, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', groups: ['81-1'], rooms: [],
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons || []));
  assert.deepEqual(loadLessons().find((l) => l.id === srId).groups, ['81-2'], 'из СР ушла только 81-1');

  // Отмена убирает созданное занятие и возвращает состав СР.
  assert.equal(performUndo().ok, true);
  assert.ok(!loadLessons().some((l) => l.id === created.id), 'вставленное занятие удалено');
  const sr = loadLessons().find((l) => l.subject === 'СР');
  assert.deepEqual([...sr.groups].sort(), ['81-1', '81-2'], 'состав СР восстановлен');

  // 2. Правка слота у существующего занятия.
  const otherId = addLesson('Сб', 2, 'ФИЗ', ['81-1'], null, { type: 'ПЗ' });
  const edited = editLesson(otherId, { day: 'Пн', pairNo: 4, weekNo: 1 });
  assert.equal(edited.ok, true, JSON.stringify(edited.reasons || []));
  assert.deepEqual(loadLessons().find((l) => l.subject === 'СР').groups, ['81-2'], 'правкой тоже вытеснили');
  wipe();
});

test('смена аудитории у самой СР не удаляет её (была ошибка 500)', () => {
  const srId = addLesson('Пн', 1, 'СР', ['81-1'], 'Ауд1');

  const res = editLesson(srId, { rooms: ['Ауд2'] });
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const sr = loadLessons().find((l) => l.id === srId);
  assert.ok(sr, 'СР осталась в базе — вытеснять саму себя нельзя');
  assert.deepEqual(sr.rooms, ['Ауд2'], 'аудитория заменена');
  assert.deepEqual(sr.groups, ['81-1'], 'группы на месте');
  wipe();
});

test('вторую СР можно подселить в аудиторию к чужой СР без «аудитория занята»', () => {
  addLesson('Вт', 2, 'СР', ['81-1'], 'Ауд1');

  const created = createLesson({
    day: 'Вт', pairNo: 2, weekNo: 1, subject: 'СР', groups: ['81-2'], rooms: ['Ауд1'],
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons || created.warnings || []));
  assert.equal(at('Вт', 2).filter((l) => l.rooms.includes('Ауд1')).length, 2, 'обе СР в одной аудитории');

  // Настоящее занятие в занятой аудитории — по-прежнему предупреждение с подтверждением.
  const over = createLesson({
    day: 'Вт', pairNo: 2, weekNo: 1, subject: 'МАТ', type: 'Л', groups: ['81-3'], rooms: ['Ауд1'],
  });
  assert.equal(over.ok, false);
  assert.equal(over.confirm, true, 'занятая аудитория — подтверждение, а не отказ');
  assert.match(String(over.warnings), /занята/);
  wipe();
});
