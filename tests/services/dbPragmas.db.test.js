'use strict';

// Настройки соединения с базой. busy_timeout — не косметика: без него второй
// писатель (второй запущенный сервер, архивация) получает «database is locked»
// мгновенно, и правка отваливается «внутренней ошибкой сервера».
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-pragmas-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* нет файла — ок */ }
  }
});

test('соединение ждёт занятую базу, а не падает сразу', () => {
  const db = getDb();
  assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout >= 1000, 'busy_timeout выставлен');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

// Цепочку занятия читают на каждом переносе: moveLogChain, откат по цепочке, ↩.
test('журнал ищет цепочку занятия по индексу, а не перебором', () => {
  const plan = getDb()
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM move_log WHERE lesson_id = ? AND action IN ('move', 'room') ORDER BY id")
    .all(1)
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /USING INDEX idx_move_log_lesson/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, 'сортировка по id берётся из индекса');
});

test('версия схемы и ревизия занятия сохраняются в SQLite', () => {
  const db = getDb();
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get());
  db.prepare("INSERT INTO lessons(day, pair_no, week_no, subject) VALUES('Пн', 1, 1, 'ТЕСТ')").run();
  const lesson = db.prepare("SELECT id, revision FROM lessons WHERE subject = 'ТЕСТ'").get();
  assert.equal(lesson.revision, 0);
  db.prepare('UPDATE lessons SET topic = ? WHERE id = ?').run('Т.1', lesson.id);
  assert.equal(db.prepare('SELECT revision FROM lessons WHERE id = ?').get(lesson.id).revision, 1);
});
