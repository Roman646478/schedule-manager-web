'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { getDb } = require('../config/database');
const { afterCommit } = require('./dbService');
const { PUBLIC_DB_PATH } = require('../utils/constants');
const { atomicWrite } = require('../utils/atomicFile');

function journal(db) {
  db.exec('CREATE TABLE IF NOT EXISTS publication_pending (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)');
}

function flushSnapshot() {
  const db = getDb();
  journal(db);
  const row = db.prepare('SELECT json FROM publication_pending WHERE id = 1').get();
  if (!row) return;
  // JSON is authoritative. Remove any old compressed copy before replacing it.
  // Failure leaves the journal available for a retry after restart.
  fs.rmSync(`${PUBLIC_DB_PATH}.gz`, { force: true });
  atomicWrite(PUBLIC_DB_PATH, row.json);
  atomicWrite(`${PUBLIC_DB_PATH}.gz`, zlib.gzipSync(row.json));
  db.exec('DELETE FROM publication_pending WHERE id = 1');
}

function writeSnapshot(snap) {
  const db = getDb();
  journal(db);
  db.prepare('INSERT OR REPLACE INTO publication_pending (id, json) VALUES (1, ?)').run(JSON.stringify(snap));
  afterCommit(flushSnapshot);
}

function readSnapshot() {
  const db = getDb();
  journal(db);
  const row = db.prepare('SELECT json FROM publication_pending WHERE id = 1').get();
  if (row) return JSON.parse(row.json);
  try { return JSON.parse(fs.readFileSync(PUBLIC_DB_PATH, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

module.exports = { writeSnapshot, readSnapshot, flushSnapshot };
