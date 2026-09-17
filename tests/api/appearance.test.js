'use strict';

// Оформление сетки хранится на сервере. Ключи и значения фильтруются: они
// попадают прямо в CSS-переменные страницы, произвольную строку пускать нельзя.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-appearance-api-'));
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

test('по умолчанию оформление пустое — работают цвета темы', async () => {
  const { appearance } = await (await api('GET', '/api/appearance')).json();
  assert.deepEqual(appearance, { colors: {}, sizes: {} });
});

test('сохранение цветов и размеров, чтение обратно', async () => {
  const res = await api('PUT', '/api/appearance', {
    appearance: { colors: { '--type-lec': '#123456' }, sizes: { '--grid-row-h': '90px' } },
  });
  assert.equal(res.status, 200);
  const { appearance } = await (await api('GET', '/api/appearance')).json();
  assert.equal(appearance.colors['--type-lec'], '#123456');
  assert.equal(appearance.sizes['--grid-row-h'], '90px');
});

test('чужие ключи и небезопасные значения отбрасываются', async () => {
  const res = await api('PUT', '/api/appearance', {
    appearance: {
      colors: { '--type-lec': 'url(http://зло/бэкграунд.png)', '--body-hack': '#000000' },
      sizes: { '--grid-font': '14px; background: red' },
    },
  });
  const { appearance } = await res.json();
  assert.deepEqual(appearance, { colors: {}, sizes: {} }, 'ничего не сохранилось');
});
