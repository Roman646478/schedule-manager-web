'use strict';

const { getDb } = require('../config/database');

// Низкоуровневые операции над БД. Бизнес-логики здесь нет.

let sequence = 0;
let depth = 0;
let commitHooks = [];
function transaction(fn) {
  const db = getDb();
  const point = `operation_${++sequence}`;
  db.exec(`SAVEPOINT ${point}`);
  depth++;
  const hookStart = commitHooks.length;
  let result;
  try {
    result = fn(db);
    if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
    db.exec(`RELEASE ${point}`);
  } catch (err) {
    db.exec(`ROLLBACK TO ${point}`);
    db.exec(`RELEASE ${point}`);
    commitHooks.length = hookStart;
    throw err;
  } finally {
    depth--;
  }
  if (depth === 0) {
    const hooks = commitHooks;
    commitHooks = [];
    try { for (const hook of hooks) hook(); }
    catch (err) { err.dataSaved = true; throw err; }
  }
  return result;
}

function afterCommit(fn) {
  if (depth) commitHooks.push(fn);
  else fn();
}

// Универсальный get-or-create по уникальному столбцу. Возвращает id.
function getOrCreate(db, table, uniqueCol, value, extra = {}) {
  const cols = [uniqueCol, ...Object.keys(extra)];
  const found = db.prepare(`SELECT id FROM ${table} WHERE ${uniqueCol} = ?`).get(value);
  if (found) return found.id;
  const placeholders = cols.map(() => '?').join(', ');
  const values = [value, ...Object.values(extra)];
  const info = db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...values);
  return Number(info.lastInsertRowid);
}

function clearAll(db) {
  for (const t of ['lesson_groups', 'lessons', 'subject_teachers', 'subjects', 'rooms', 'groups', 'teachers']) {
    db.exec(`DELETE FROM ${t}`);
  }
}

module.exports = { transaction, afterCommit, getOrCreate, clearAll };
