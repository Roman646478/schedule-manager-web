'use strict';

// Кэш loadLessons: результат живёт до ближайшей записи в БД. Проверяем, что
// правка занятия (в т.ч. внутри транзакции) видна следующему вызову.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-cache-test-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLessons } = require('../../src/services/conflictService');
const { transaction } = require('../../src/services/dbService');
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

test('loadLessons: кэш сбрасывается любой записью в БД', () => {
  const db = getDb();
  const gid = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('G1').lastInsertRowid);
  const id = Number(
    db.prepare('INSERT INTO lessons (day, pair_no, week_no, subject) VALUES (?,?,?,?)').run('Пн', 1, 1, 'ИЭП').lastInsertRowid
  );
  db.prepare('INSERT INTO lesson_groups (lesson_id, group_id) VALUES (?,?)').run(id, gid);

  assert.equal(loadLessons(db).find((l) => l.id === id).day, 'Пн');
  assert.deepEqual(loadLessons(db).find((l) => l.id === id).groups, ['G1']);

  db.prepare('UPDATE lessons SET day = ? WHERE id = ?').run('Вт', id);
  assert.equal(loadLessons(db).find((l) => l.id === id).day, 'Вт', 'правка вне транзакции видна сразу');

  transaction((tx) => {
    tx.prepare('UPDATE lessons SET day = ? WHERE id = ?').run('Ср', id);
    assert.equal(loadLessons(tx).find((l) => l.id === id).day, 'Ср', 'правка внутри транзакции видна ей же');
  });
  assert.equal(loadLessons(db).find((l) => l.id === id).day, 'Ср');

  // Массив отдаётся свой: сортировка/фильтрация у вызывающего не портит кэш.
  const first = loadLessons(db);
  first.length = 0;
  assert.equal(loadLessons(db).length, 1);
});
