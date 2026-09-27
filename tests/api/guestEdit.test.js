'use strict';

// После введения именных редакторов публичная страница всегда только для чтения.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-guest-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ACCESS_DB_PATH = path.join(TMPDIR, 'access.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4';

const { createApp } = require('../../src/server');
const { closeDb } = require('../../src/config/database');
let server;
let base;

function client() {
  const s = { cookie: '', csrf: '' };
  return async (method, url, body) => {
    const headers = s.cookie ? { cookie: s.cookie } : {};
    if (method !== 'GET') {
      if (!s.csrf) {
        const cr = await fetch(base + '/api/csrf', { headers });
        const cookie = cr.headers.get('set-cookie');
        if (cookie) s.cookie = cookie.split(';')[0];
        s.csrf = (await cr.json()).token;
      }
      headers.cookie = s.cookie;
      headers['x-csrf-token'] = s.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookie = res.headers.get('set-cookie');
    if (cookie) s.cookie = cookie.split(';')[0];
    return res;
  };
}

const admin = client();
const guest = client();
let lessonId;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await admin('POST', '/api/login', { username: 'admin', password: 'admin' });
  lessonId = (await (await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТЕСТ', type: 'ПЗ', groups: ['999-11'], teacher: 'Иванов',
  })).json()).id;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('анонимное редактирование выключено без возможности включить', async () => {
  assert.deepEqual(await (await guest('GET', '/api/guest-edit')).json(), { enabled: false });
  assert.equal((await admin('PUT', '/api/guest-edit', { enabled: true })).status, 410);
  assert.deepEqual(await (await guest('GET', '/api/guest-edit')).json(), { enabled: false });
});

test('гостевой запрос записи отклоняется и не меняет занятие', async () => {
  assert.equal((await guest('PUT', `/api/guest/lesson/${lessonId}`, { topic: 'ВЗЛОМ', groups: ['777'] })).status, 401);
  const lesson = (await (await admin('GET', '/api/schedule?view=group&id=999-11')).json()).lessons[0];
  assert.notEqual(lesson.topic, 'ВЗЛОМ');
  assert.deepEqual(lesson.groups, ['999-11']);
});
