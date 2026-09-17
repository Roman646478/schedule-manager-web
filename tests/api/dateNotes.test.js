'use strict';

// Примечания к датам: сохранение, выдача и отсев мусора (без даты/текста).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-notes-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/server');
const { closeDb } = require('../../src/config/database');

let server;
let base;
let cookie = '';
let csrf = '';

function rememberCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
}

async function ensureCsrf() {
  if (csrf) return csrf;
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + '/api/csrf', { headers });
  rememberCookie(res);
  csrf = (await res.json()).token;
  return csrf;
}

async function api(method, urlPath, body) {
  const headers = {};
  if (method !== 'GET') headers['x-csrf-token'] = await ensureCsrf();
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  rememberCookie(res);
  return res;
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('без сессии примечания недоступны', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await api('GET', '/api/date-notes')).status, 401);
  cookie = saved;
});

test('пустой список по умолчанию', async () => {
  const res = await api('GET', '/api/date-notes');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).notes, []);
});

test('сохранение и чтение: текст и список групп', async () => {
  const notes = [
    { date: '2026-09-01', text: 'Занятия по расписанию пятницы', groups: ['861-11', '862-12'] },
    { date: '2026-09-02', text: 'Для всех групп', groups: [] },
  ];
  const put = await api('PUT', '/api/date-notes', { notes });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).count, 2);

  const got = (await (await api('GET', '/api/date-notes')).json()).notes;
  assert.deepEqual(got, notes);
});

test('мусор отсеивается: без текста, без даты, дубли групп', async () => {
  const put = await api('PUT', '/api/date-notes', {
    notes: [
      { date: '2026-09-03', text: '   ', groups: [] },
      { date: 'не дата', text: 'есть текст', groups: [] },
      { date: '2026-09-04', text: 'ок', groups: ['861-11', '861-11', ' '] },
    ],
  });
  assert.equal((await put.json()).count, 1);
  const got = (await (await api('GET', '/api/date-notes')).json()).notes;
  assert.deepEqual(got, [{ date: '2026-09-04', text: 'ок', groups: ['861-11'] }]);
});

test('notes не массив → 400', async () => {
  const res = await api('PUT', '/api/date-notes', { notes: 'нет' });
  assert.equal(res.status, 400);
});
