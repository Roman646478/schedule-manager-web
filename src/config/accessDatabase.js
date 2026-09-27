'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { ACCESS_DB_PATH } = require('../utils/constants');
const { ensureSessionsTable } = require('./sessionStore');

let db = null;

function getAccessDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(ACCESS_DB_PATH), { recursive: true });
  db = new DatabaseSync(ACCESS_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('admin','editor')),
      active INTEGER NOT NULL DEFAULT 1,
      auth_version INTEGER NOT NULL DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_departments (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dept TEXT NOT NULL,
      PRIMARY KEY(user_id, dept)
    );
    CREATE TABLE IF NOT EXISTS user_groups (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      group_uid TEXT,
      PRIMARY KEY(user_id, group_name)
    );
    CREATE TABLE IF NOT EXISTS access_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      happened_at TEXT NOT NULL,
      actor_user_id INTEGER,
      target_user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT
    );
    CREATE TABLE IF NOT EXISTS access_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO access_meta(key,value) VALUES ('schedule_generation', ?)").run(randomUUID());
  const userGroupCols = db.prepare('PRAGMA table_info(user_groups)').all().map((c) => c.name);
  if (!userGroupCols.includes('group_uid')) db.exec('ALTER TABLE user_groups ADD COLUMN group_uid TEXT');
  ensureSessionsTable(db);
  return db;
}

function getScheduleGeneration() {
  return getAccessDb().prepare("SELECT value FROM access_meta WHERE key='schedule_generation'").get().value;
}

function bumpScheduleGeneration() {
  const value = randomUUID();
  getAccessDb().prepare("INSERT OR REPLACE INTO access_meta(key,value) VALUES ('schedule_generation', ?)").run(value);
  return value;
}

function closeAccessDb() {
  if (!db) return;
  db.close();
  db = null;
}

module.exports = { getAccessDb, closeAccessDb, getScheduleGeneration, bumpScheduleGeneration };
