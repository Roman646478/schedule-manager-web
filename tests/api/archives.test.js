'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-arc-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4'; // быстрые хэши в тестах

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/server');
const { getDb, closeDb } = require('../../src/config/database');

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
  // Токен берём до подстановки куки: запрос CSRF сам заводит сессию, и её кука
  // должна попасть уже в этот запрос — иначе отказ будет по CSRF, а не по правам.
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

const groupCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM groups').get().n;

let archiveId;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  getDb().prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 10);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('архивы недоступны без сессии', async () => {
  assert.equal((await api('GET', '/api/archives')).status, 401);
  assert.equal((await api('POST', '/api/archives', { note: 'чужой' })).status, 401);
});

test('логин', async () => {
  const res = await api('POST', '/api/login', { username: 'admin', password: 'admin' });
  assert.equal(res.status, 200);
  assert.ok(cookie, 'кука сессии получена');
});

test('создание архива без CSRF-токена отклоняется', async () => {
  const res = await fetch(base + '/api/archives', { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 403);
});

test('POST /api/archives сохраняет версию, GET отдаёт её в списке', async () => {
  const res = await api('POST', '/api/archives', { note: 'первая версия' });
  assert.equal(res.status, 200);
  const { archive } = await res.json();
  archiveId = archive.id;
  assert.equal(archive.note, 'первая версия');

  const list = await (await api('GET', '/api/archives')).json();
  assert.equal(list.archives.length, 1);
  assert.equal(list.archives[0].id, archiveId);
});

test('PUT /api/archives/:id меняет примечание', async () => {
  const res = await api('PUT', `/api/archives/${archiveId}`, { note: 'уточнённое примечание' });
  assert.equal(res.status, 200);

  const list = await (await api('GET', '/api/archives')).json();
  assert.equal(list.archives[0].note, 'уточнённое примечание');
});

test('идентификатор с выходом за папку архивов → 400, а не чтение чужого файла', async () => {
  for (const bad of ['..%2F..%2Fschedule', 'schedule.db', '2026-13-40']) {
    const res = await api('POST', `/api/archives/${bad}/restore`);
    assert.equal(res.status, 400, `должен отклоняться: ${bad}`);
  }
  assert.equal((await api('DELETE', '/api/archives/..%2F..%2Fconfig')).status, 400);
});

test('несуществующая версия → 404', async () => {
  assert.equal((await api('POST', '/api/archives/2000-01-01_000000/restore')).status, 404);
});

test('переключение на версию возвращает базу к её состоянию и не рвёт сессию', async () => {
  getDb().prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G2', 10);
  assert.equal(groupCount(), 2);

  const res = await api('POST', `/api/archives/${archiveId}/restore`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.safetyId, 'создан автоснимок текущего состояния');
  assert.equal(groupCount(), 1, 'база вернулась к состоянию версии');

  // Та же кука продолжает работать: подмена файла базы не выбрасывает из системы.
  const after = await api('GET', '/api/archives');
  assert.equal(after.status, 200);
  const list = await after.json();
  assert.equal(list.archives.length, 2, 'версия + автоснимок');
});

test('GET /api/archives/:id/download отдаёт файл версии', async () => {
  const res = await api('GET', `/api/archives/${archiveId}/download`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'скачан настоящий файл БД');
  assert.ok(bytes.length > 1000);
});

test('выгруженный файл принимается обратно как версия', async () => {
  const bytes = Buffer.from(await (await api('GET', `/api/archives/${archiveId}/download`)).arrayBuffer());

  const form = new FormData();
  form.append('files', new Blob([bytes]), 'schedule-archive.db');
  form.append('note', 'привезено с другого устройства');
  const res = await fetch(base + '/api/archives/import', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': await ensureCsrf() },
    body: form,
  });

  assert.equal(res.status, 200);
  const { archive } = await res.json();
  assert.equal(archive.imported, true);
  assert.equal(archive.note, 'привезено с другого устройства');
  assert.equal(archive.lessons, 0, 'содержимое версии сохранилось при переносе');

  assert.equal((await api('DELETE', `/api/archives/${archive.id}`)).status, 200);
});

test('загрузка постороннего файла отклоняется с понятной причиной', async () => {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('не база данных')]), 'fake.db');
  const res = await fetch(base + '/api/archives/import', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': await ensureCsrf() },
    body: form,
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /SQLite|расписания/i);
});

test('DELETE /api/archives/:id удаляет версию', async () => {
  assert.equal((await api('DELETE', `/api/archives/${archiveId}`)).status, 200);
  const list = await (await api('GET', '/api/archives')).json();
  assert.equal(list.archives.some((a) => a.id === archiveId), false);
});
