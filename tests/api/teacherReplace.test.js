'use strict';

// Массовая замена преподавателя в расписании группы, суженная до вида занятия:
// «заменить Иванова на Петрова, но только у ПЗ».

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-treplace-api-'));
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

const GROUP = '905-11';
const OLD = 'Иванов И.И.';
const NEW = 'Петров П.П.';

const lessonsOf = async () =>
  ((await (await api('GET', `/api/schedule?view=group&id=${encodeURIComponent(GROUP)}`)).json()).lessons || []);

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });
  await api('POST', '/api/lessons', { day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', teacher: OLD, groups: [GROUP] });
  await api('POST', '/api/lessons', { day: 'Вт', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'Л', teacher: OLD, groups: [GROUP] });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('замена по виду занятия трогает только занятия этого вида', async () => {
  const res = await api('POST', '/api/group-teacher', { group: GROUP, from: OLD, to: NEW, mode: 'replace', type: 'ПЗ' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).count, 1);

  const byType = Object.fromEntries((await lessonsOf()).map((l) => [l.type, l.teacher]));
  assert.equal(byType['ПЗ'], NEW, 'у практического занятия новый преподаватель');
  assert.equal(byType['Л'], OLD, 'лекция осталась за прежним преподавателем');
});

test('если занятий такого вида нет — 404 с понятной причиной', async () => {
  const res = await api('POST', '/api/group-teacher', { group: GROUP, from: OLD, to: NEW, mode: 'replace', type: 'ЛР' });
  assert.equal(res.status, 404);
  assert.match(String((await res.json()).reasons), /вида «ЛР»/);
});
