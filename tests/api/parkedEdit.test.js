'use strict';

// Занятие в буфере стоит ВНЕ сетки: слот в базе у него технический. Правка
// такого занятия не должна упираться в накладки старого слота, который тем
// временем занял кто-то другой.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-parked-api-'));
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

const SLOT = { day: 'Пн', pairNo: 1, weekNo: 1 };
let parkedId;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });
  await api('PUT', '/api/rooms', { name: '401', capacity: 100 });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('занятие откладывается в буфер и пропадает из сетки', async () => {
  const created = await (await api('POST', '/api/lessons', {
    ...SLOT, subject: 'ТЕСТ', type: 'ПЗ', teacher: 'Иванов И.И.', groups: ['901-11'], rooms: ['401'],
  })).json();
  parkedId = created.id;
  assert.ok(parkedId);

  assert.equal((await api('POST', `/api/lesson/${parkedId}/park`)).status, 200);
  const parked = (await (await api('GET', '/api/parked')).json()).lessons;
  assert.equal(parked.length, 1);
  assert.equal(parked[0].id, parkedId);
});

test('освободившийся слот занимает другое занятие с тем же преподавателем и аудиторией', async () => {
  const res = await api('POST', '/api/lessons', {
    ...SLOT, subject: 'ДРУГОЕ', type: 'Л', teacher: 'Иванов И.И.', groups: ['901-12'], rooms: ['401'],
  });
  const data = await res.json();
  assert.ok(data.id, `отложенное занятие не должно занимать слот: ${JSON.stringify(data.reasons || data)}`);
});

test('правка отложенного занятия проходит, несмотря на занятый старый слот', async () => {
  const res = await api('PUT', `/api/lesson/${parkedId}`, { topic: 'Т.5', rooms: ['401'] });
  const data = await res.json();
  assert.equal(res.status, 200, `ожидали успех, получили ${res.status}: ${JSON.stringify(data.reasons || data)}`);
  assert.equal(data.success, true);

  const parked = (await (await api('GET', '/api/parked')).json()).lessons;
  assert.equal(parked.length, 1, 'занятие осталось в буфере');
  assert.equal(parked[0].topic, 'Т.5', 'правка сохранилась');
});

test('возврат из буфера в занятый слот по-прежнему отклоняется', async () => {
  const res = await api('POST', '/api/move', { lessonId: parkedId, ...SLOT, rooms: ['401'] });
  assert.notEqual(res.status, 200, 'вернуть в занятый слот нельзя');
});
