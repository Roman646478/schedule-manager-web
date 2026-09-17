'use strict';

// Пометка перенесённых занятий: один тумблер (settings.moveMarks) на админку и
// гостевую страницу, а сами переносы гость получает со снимком публикации.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-movemarks-'));
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
  return async function api(method, urlPath, body) {
    const headers = {};
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

test('тумблер включён по умолчанию и читается без входа', async () => {
  assert.equal((await (await guest('GET', '/api/move-marks')).json()).enabled, true);
});

test('переключает только админ', async () => {
  assert.equal((await guest('PUT', '/api/move-marks', { enabled: false })).status, 401);
  assert.equal((await admin('PUT', '/api/move-marks', { enabled: false })).status, 200);
  assert.equal((await (await guest('GET', '/api/move-marks')).json()).enabled, false);
  assert.equal((await admin('PUT', '/api/move-marks', { enabled: true })).status, 200);
  assert.equal((await (await guest('GET', '/api/move-marks')).json()).enabled, true);
});

test('пометки считает сервер по занятию, и в снимок публикации уходят те же', async () => {
  assert.equal((await admin('POST', '/api/move', { lessonId, day: 'Вт', pairNo: 2, weekNo: 1, force: true })).status, 200);
  assert.equal((await admin('PUT', `/api/lesson/${lessonId}`, { rooms: ['А-2'], force: true })).status, 200);
  assert.equal((await admin('POST', '/api/publish')).status, 200);

  const { marks } = await (await admin('GET', '/api/move-log/marks')).json();
  const mine = marks.find((m) => m.key === `#${lessonId}`);
  assert.equal(mine.steps, 2, 'перенос и смена аудитории');
  assert.deepEqual([mine.lastMove.fromDay, mine.lastMove.fromPair, mine.lastMove.fromWeek], ['Пн', 1, 1]);
  assert.deepEqual([mine.lastRoom.fromRoom, mine.lastRoom.room], ['А-1', 'А-2']);
  assert.equal((await guest('GET', '/api/move-log/marks')).status, 401);

  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  assert.deepEqual((snap.moveMarks || []).find((m) => m.key === `#${lessonId}`), mine);
  // Сам журнал (примечания, кто и когда) гостю не уходит.
  assert.equal(snap.moveLog, undefined);
});

test('занятие из буфера в снимок не попадает — и его записей там тоже нет', async () => {
  assert.equal((await admin('POST', `/api/lesson/${lessonId}/park`)).status, 200);
  assert.equal((await admin('POST', '/api/publish')).status, 200);
  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  assert.equal((snap.lessons || []).some((l) => l.id === lessonId), false);
  assert.equal((snap.moveMarks || []).some((m) => m.key === `#${lessonId}`), false);
});
