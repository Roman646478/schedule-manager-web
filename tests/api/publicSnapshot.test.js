'use strict';

// Снимок публикации: отдаётся из PUBLIC_DB_PATH (а не статикой из public/),
// пишется без отступов и со сжатой копией; админка знает, что снимок устарел.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-snapshot-'));
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

function client() {
  const st = { cookie: '', csrf: '' };
  const remember = (res) => {
    const c = res.headers.get('set-cookie');
    if (c) st.cookie = c.split(';')[0];
  };
  const ensureCsrf = async () => {
    if (st.csrf) return st.csrf;
    const res = await fetch(base + '/api/csrf', { headers: st.cookie ? { cookie: st.cookie } : {} });
    remember(res);
    st.csrf = (await res.json()).token;
    return st.csrf;
  };
  return async function api(method, urlPath, body, extra = {}) {
    const headers = { ...extra };
    if (method !== 'GET') headers['x-csrf-token'] = await ensureCsrf();
    if (st.cookie) headers.cookie = st.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + urlPath, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    remember(res);
    return res;
  };
}

const admin = client();
const guest = client();
let lessonId;

// Сырой ответ без распаковки: fetch сам снимает gzip, а здесь важно, что пришло.
function rawGet(urlPath, acceptEncoding) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers: { 'accept-encoding': acceptEncoding } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const unpublished = async () => (await (await admin('GET', '/api/publish/status')).json()).unpublished;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await admin('POST', '/api/login', { username: 'admin', password: 'admin' });
  await admin('PUT', '/api/semester', { name: 'осень', start: '2026-09-01', end: '2027-01-31' });
  const res = await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТЕСТ', type: 'ПЗ',
    groups: ['999-11'], teacher: 'Иванов И.И.', topic: 'Т.1', rooms: ['А-1'],
  });
  lessonId = (await res.json()).id;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('до публикации снимка нет — 404, и админка видит неопубликованные изменения', async () => {
  assert.equal((await rawGet('/public_db.json', 'gzip')).status, 404);
  assert.equal(await unpublished(), true);
});

test('снимок читается из PUBLIC_DB_PATH: без отступов, gzip-клиенту — сжатым', async () => {
  assert.equal((await admin('POST', '/api/publish')).status, 200);
  const onDisk = fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8');
  assert.equal(onDisk.includes('\n'), false, 'JSON без отступов');

  const zipped = await rawGet('/public_db.json', 'gzip, deflate');
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(zipped.body.length < onDisk.length, 'сжатый ответ меньше файла');
  const snap = JSON.parse(require('node:zlib').gunzipSync(zipped.body).toString('utf8'));
  assert.equal(snap.lessons.length, 1);

  const plain = await rawGet('/public_db.json', 'identity');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body.toString('utf8')).lessons.length, 1);
});

test('флаг «не опубликовано»: правка ставит, тумблер и примечание — нет, публикация снимает', async () => {
  assert.equal(await unpublished(), false, 'сразу после публикации');
  assert.equal((await admin('PUT', '/api/move-marks', { enabled: true })).status, 200);
  assert.equal(await unpublished(), false, 'тумблер в снимок не входит');

  assert.equal((await admin('POST', '/api/move', { lessonId, day: 'Вт', pairNo: 2, weekNo: 1, force: true })).status, 200);
  assert.equal(await unpublished(), true, 'перенос');

  assert.equal((await admin('POST', '/api/publish')).status, 200);
  const entry = (await (await admin('GET', '/api/move-log')).json()).entries[0];
  assert.equal((await admin('PUT', `/api/move-log/${entry.id}`, { note: 'по заявке' })).status, 200);
  assert.equal(await unpublished(), false, 'примечание к записи журнала гостю не уходит');
});

test('статус публикации — только админу', async () => {
  assert.equal((await guest('GET', '/api/publish/status')).status, 401);
});

test('отключённая гостевая правка не меняет опубликованный снимок', async () => {
  assert.equal((await admin('PUT', '/api/guest-edit', { enabled: true })).status, 410);
  const current = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  const before = current.lessons.find((l) => l.id === lessonId).topic;
  assert.equal((await guest('PUT', `/api/guest/lesson/${lessonId}`, {
    topic: 'Т.7',
    publicationId: current.publicationId,
  })).status, 401);
  const zipped = await rawGet('/public_db.json', 'gzip');
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  const snap = JSON.parse(require('node:zlib').gunzipSync(zipped.body).toString('utf8'));
  assert.equal(snap.lessons.find((l) => l.id === lessonId).topic, before);
  assert.equal(await unpublished(), false, 'запрещённая правка не меняет состояние');
});
