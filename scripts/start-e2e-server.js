'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-e2e-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDir, 'schedule.db');
process.env.CONFIG_PATH = path.join(tempDir, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(tempDir, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4';

const { createApp } = require('../src/server');
const { closeDb } = require('../src/config/database');

const server = http.createServer(createApp());
server.listen(31847, '127.0.0.1');

function shutdown() {
  server.close(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
