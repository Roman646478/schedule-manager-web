'use strict';

// applyAliasesToDb во ВРЕМЕННОЙ БД (путь задаём до require config/database).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-alias-test-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAliasesToDb } = require('../../src/services/importService');
const { getDb, closeDb } = require('../../src/config/database');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP + ext);
    } catch {
      /* нет файла — ок */
    }
  }
});

// Создаёт занятие со связями и возвращает его id.
function makeLesson(db, { subject, groupId, roomId, teacherId, type }) {
  const info = db
    .prepare('INSERT INTO lessons (day, pair_no, week_no, subject, type, teacher_id, room_id) VALUES (?,?,?,?,?,?,?)')
    .run('Пн', 1, 1, subject, type || null, teacherId || null, roomId);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups (lesson_id, group_id) VALUES (?,?)').run(id, groupId);
  db.prepare('INSERT INTO lesson_rooms (lesson_id, room_id) VALUES (?,?)').run(id, roomId);
  return id;
}

test('applyAliasesToDb: переименовывает и сливает дубль в одно занятие', () => {
  const db = getDb();
  const gid = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('G1').lastInsertRowid);
  const rid = Number(db.prepare('INSERT INTO rooms (name) VALUES (?)').run('101').lastInsertRowid);
  const tid = Number(db.prepare('INSERT INTO teachers (name) VALUES (?)').run('Иванов').lastInsertRowid);
  db.prepare('INSERT INTO subjects (abbr) VALUES (?)').run('ИЭП');
  db.prepare('INSERT INTO subjects (abbr) VALUES (?)').run('ИРТС');

  // Два дубля одного физического слота с разными сокращениями. У «ИЭП» есть
  // преподаватель и тип — они должны перейти на сохранённое занятие.
  makeLesson(db, { subject: 'ИЭП', groupId: gid, roomId: rid, teacherId: tid, type: 'Л' });
  makeLesson(db, { subject: 'ИРТС', groupId: gid, roomId: rid });

  const res = applyAliasesToDb({ 'ИЭП': 'ИРТС' });
  assert.equal(res.renamed, 1);
  assert.equal(res.merged, 1);

  const rows = db.prepare('SELECT id, subject, type, teacher_id FROM lessons').all();
  assert.equal(rows.length, 1, 'дубль слит — осталось одно занятие');
  assert.equal(rows[0].subject, 'ИРТС');
  assert.equal(rows[0].type, 'Л', 'тип перенесён с удалённого занятия');
  assert.equal(rows[0].teacher_id, tid, 'преподаватель перенесён');

  // Связи группы/аудитории целы, без дублей.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lesson_groups WHERE lesson_id = ?').get(rows[0].id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lesson_rooms WHERE lesson_id = ?').get(rows[0].id).n, 1);

  // Справочник: исходное сокращение убрано, целевое осталось.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM subjects WHERE abbr = 'ИЭП'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM subjects WHERE abbr = 'ИРТС'").get().n, 1);
});

test('applyAliasesToDb: разные аудитории — переименование без слияния', () => {
  const db = getDb();
  db.prepare('DELETE FROM lessons').run();
  const gid = db.prepare("SELECT id FROM groups WHERE name='G1'").get().id;
  const r2 = Number(db.prepare('INSERT INTO rooms (name) VALUES (?)').run('202').lastInsertRowid);
  const r1 = db.prepare("SELECT id FROM rooms WHERE name='101'").get().id;
  db.prepare('INSERT OR IGNORE INTO subjects (abbr) VALUES (?)').run('АБВ');

  makeLesson(db, { subject: 'АБВ', groupId: gid, roomId: r1 });
  makeLesson(db, { subject: 'ИРТС', groupId: gid, roomId: r2 });

  const res = applyAliasesToDb({ 'АБВ': 'ИРТС' });
  assert.equal(res.merged, 0, 'аудитории разные — не сливаем');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 2);
});
