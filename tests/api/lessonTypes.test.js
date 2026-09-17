'use strict';

// Перечень видов учебных занятий: список по умолчанию, правка, отсев мусора.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ltypes-api-'));
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

test('без сессии перечень недоступен', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await api('GET', '/api/lesson-types')).status, 401);
  cookie = saved;
});

test('по умолчанию — список из констант', async () => {
  const res = await api('GET', '/api/lesson-types');
  assert.equal(res.status, 200);
  const codes = (await res.json()).types.map((t) => t.code);
  assert.deepEqual(codes, ['Л', 'ПЗ', 'ЛР', 'КР', 'КП', 'Зач', 'ЗО', 'Экз']);
});

test('сохранение и чтение перечня', async () => {
  const types = [{ code: 'Л', name: 'Лекция' }, { code: 'ГЗ', name: 'Групповое занятие' }];
  assert.equal((await api('PUT', '/api/lesson-types', { types })).status, 200);
  assert.deepEqual((await (await api('GET', '/api/lesson-types')).json()).types, types);
});

test('мусор отсеивается: пустой код и дубль', async () => {
  await api('PUT', '/api/lesson-types', {
    types: [
      { code: ' ПЗ ', name: ' Практика ' },
      { code: '', name: 'без кода' },
      { code: 'ПЗ', name: 'дубль' },
      { code: 'ЛР' },
    ],
  });
  assert.deepEqual((await (await api('GET', '/api/lesson-types')).json()).types, [
    { code: 'ПЗ', name: 'Практика' },
    { code: 'ЛР', name: '' },
  ]);
});

test('types не массив → 400', async () => {
  assert.equal((await api('PUT', '/api/lesson-types', { types: 'нет' })).status, 400);
});
