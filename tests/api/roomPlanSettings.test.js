'use strict';

// Настройки подбора аудиторий: порядок правил (он же приоритет), допуски и
// списки исключений. Проверяем дефолты, сохранение и то, что мусор в теле
// запроса не попадает в базу.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rpcfg-api-'));
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

const read = async () => (await (await api('GET', '/api/room-plan/settings')).json());

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

test('без настроек отдаются значения по умолчанию', async () => {
  const { settings, rules } = await read();
  assert.deepEqual(settings.rules.map((r) => r.id), rules, 'порядок — как в перечне правил');
  assert.ok(settings.rules.every((r) => r.on), 'все правила включены');
  assert.deepEqual(settings.rules.map((r) => r.id),
    ['ctrl', 'cc', 'teacherGroup', 'teacherAny', 'dept', 'capacity'],
    'приоритет: контроль, комп. класс, преподаватель, кафедра, вместимость');
  assert.deepEqual(settings.blockPairs, [1, 2, 3], '4-я пара в серии не собирается');
  assert.equal(settings.maxExtra, 15);
  assert.equal(settings.minCapacityGain, 10, 'мелкая подгонка мест по умолчанию не предлагается');
  assert.equal(settings.skipLocked, true);
});

test('порядок правил и исключения сохраняются', async () => {
  const res = await api('PUT', '/api/room-plan/settings', {
    settings: {
      rules: [{ id: 'capacity', on: true }, { id: 'cc', on: false }],
      ccSkipSubjects: [' химия ', 'химия', ''],
      maxExtra: 7,
      blockPairs: [1, 2],
      skipRooms: ['Каб. 1'],
      skipLocked: false,
    },
  });
  assert.equal(res.status, 200);

  const { settings } = await read();
  assert.deepEqual(settings.rules.slice(0, 2), [{ id: 'capacity', on: true }, { id: 'cc', on: false }],
    'заданный порядок и галочки сохранены');
  assert.deepEqual(settings.rules.map((r) => r.id).slice(2).sort(),
    ['ctrl', 'dept', 'teacherAny', 'teacherGroup'],
    'неупомянутые правила дописаны в конец, ни одно не потеряно');
  assert.deepEqual(settings.ccSkipSubjects, ['химия'], 'пробелы и дубли убраны');
  assert.equal(settings.maxExtra, 7);
  assert.deepEqual(settings.blockPairs, [1, 2]);
  assert.deepEqual(settings.skipRooms, ['Каб. 1']);
  assert.equal(settings.skipLocked, false);
});

test('мусор в теле запроса не ломает настройки', async () => {
  const res = await api('PUT', '/api/room-plan/settings', {
    settings: {
      rules: [{ id: 'выдумка', on: true }, { id: 'dept' }, { id: 'dept', on: false }],
      maxExtra: 'много',
      overWeight: 9999,
      minCapacityGain: 0,
      blockPairs: [0, 3, 9],
      ccSkipSubjects: 'не массив',
    },
  });
  assert.equal(res.status, 200);

  const { settings, rules } = await read();
  assert.deepEqual(settings.rules[0], { id: 'dept', on: true }, 'выдуманное правило отброшено, дубль — тоже');
  assert.equal(settings.rules.length, rules.length, 'правил столько же, сколько знает сервер');
  assert.equal(settings.maxExtra, 15, 'нечисло — вернулся дефолт');
  assert.equal(settings.minCapacityGain, 0, 'нулевой порог сохраняется как есть');
  assert.equal(settings.overWeight, 100, 'слишком большое значение обрезано');
  assert.deepEqual(settings.blockPairs, [3], 'пары вне 1–4 отброшены');
  assert.deepEqual(settings.ccSkipSubjects, []);
});

test('гостю настройки подбора не отдаются', async () => {
  await api('POST', '/api/logout');
  cookie = '';
  csrf = '';
  assert.equal((await api('GET', '/api/room-plan/settings')).status, 401);
});
