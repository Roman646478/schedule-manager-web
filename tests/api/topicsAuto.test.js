'use strict';

// Темы расставляются САМИ после любой правки через API (хук в server.js), плюс
// ручной прогон кнопкой /api/topics/sort.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-topics-api-'));
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

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const lessonsOf = async () => (await (await api('GET', '/api/schedule?view=group&id=901-11')).json()).lessons;

// Темы группы по дисциплине/виду в хронологическом порядке слотов.
async function topics(subject, type) {
  return (await lessonsOf())
    .filter((l) => l.subject === subject && l.type === type)
    .sort((a, b) => a.weekNo - b.weekNo || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.pairNo - b.pairNo)
    .map((l) => l.topic);
}

const add = (pairNo, topic, type = 'Л') =>
  api('POST', '/api/lessons', {
    day: 'Пн', pairNo, weekNo: 1, subject: 'ОТ', type, topic,
    teacher: 'Иванов И.И.', groups: ['901-11'], rooms: ['401'],
  });

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

test('добавленное занятие встаёт в порядок тем автоматически', async () => {
  await add(1, 'Т.1');
  await add(2, 'ЗАКЛ.');
  assert.deepEqual(await topics('ОТ', 'Л'), ['Т.1', 'ЗАКЛ.']);
  // Т.2 добавляем ПОСЛЕ заключительной — темы должны перетасоваться сами.
  await add(3, 'Т.2');
  assert.deepEqual(await topics('ОТ', 'Л'), ['Т.1', 'Т.2', 'ЗАКЛ.']);
});

test('перенос занятия переставляет темы, а не увозит тему с собой', async () => {
  const first = (await lessonsOf()).find((l) => l.day === 'Пн' && l.pairNo === 1); // сейчас Т.1
  // Двигаем первое занятие в конец недели: тема Т.1 остаётся первой в сетке,
  // а самому занятию достаётся заключительная.
  const res = await api('POST', '/api/move', { lessonId: first.id, day: 'Вт', pairNo: 1, weekNo: 1, rooms: ['401'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await topics('ОТ', 'Л'), ['Т.1', 'Т.2', 'ЗАКЛ.']);
  const moved = (await lessonsOf()).find((l) => l.id === first.id);
  assert.equal(moved.topic, 'ЗАКЛ.', 'тема не уехала вместе с занятием');
});

test('кнопка «Расставить темы» сообщает, что переставлять нечего', async () => {
  const r = await (await api('POST', '/api/topics/sort', {})).json();
  assert.deepEqual(r, { success: true, changed: 0 });
});
