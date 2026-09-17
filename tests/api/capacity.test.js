'use strict';

// Занятая аудитория и нехватка посадочных мест размещение НЕ запрещают: сервер
// возвращает список предупреждений с признаком confirm, а по force: true —
// сохраняет. Жёсткий запрет остаётся только на накладки преподавателя и группы.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cap-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4'; // быстрые хэши в тестах

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

const SLOT = { day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТЕСТ', type: 'ПЗ', groups: ['999-11'] };
let lessonId;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });
  await api('PUT', '/api/groups', { name: '999-11', headcount: 30 });
  await api('PUT', '/api/groups', { name: '999-12', headcount: 20 });
  await api('PUT', '/api/rooms', { name: 'МАЛАЯ', capacity: 10 });
  await api('PUT', '/api/rooms', { name: 'БОЛЬШАЯ', capacity: 40 });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('создание: тесная аудитория → запрос подтверждения, а не отказ', async () => {
  const res = await api('POST', '/api/lessons', { ...SLOT, rooms: ['МАЛАЯ'] });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.confirm, true, 'сервер просит подтверждение');
  assert.match(String(data.warnings), /мало для 30/);
});

test('создание: с подтверждением (force) занятие ставится в тесную аудиторию', async () => {
  const res = await api('POST', '/api/lessons', { ...SLOT, rooms: ['МАЛАЯ'], force: true });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.id);
  lessonId = data.id;
});

test('создание: занятая аудитория → подтверждение, затем два занятия в одной аудитории', async () => {
  const body = { ...SLOT, day: 'Вт', pairNo: 2, groups: ['999-12'], rooms: ['БОЛЬШАЯ'] };
  const first = await api('POST', '/api/lessons', body);
  assert.equal(first.status, 201, 'первое занятие встаёт свободно');

  const second = { ...body, groups: ['999-11'], teacher: 'Петров П.П.' };
  const ask = await api('POST', '/api/lessons', second);
  assert.equal(ask.status, 409);
  assert.match(String((await ask.json()).warnings), /занята/);

  const forced = await api('POST', '/api/lessons', { ...second, force: true });
  assert.equal(forced.status, 201, 'по подтверждению — размещается');
});

test('накладка группы и преподавателя остаётся жёстким запретом', async () => {
  const busy = { ...SLOT, day: 'Ср', pairNo: 3, teacher: 'Сидоров С.С.', rooms: ['БОЛЬШАЯ'] };
  assert.equal((await api('POST', '/api/lessons', busy)).status, 201);

  // Та же группа в том же слоте — отказ даже с force.
  const sameGroup = await api('POST', '/api/lessons', { ...busy, rooms: [], force: true });
  assert.equal(sameGroup.status, 409);
  const g = await sameGroup.json();
  assert.match(String(g.reasons), /Группа/);
  assert.notEqual(g.confirm, true, 'это отказ, а не запрос подтверждения');

  // Тот же преподаватель у другой группы в том же слоте — тоже отказ.
  const sameTeacher = await api('POST', '/api/lessons', {
    ...busy, groups: ['999-12'], rooms: [], force: true,
  });
  assert.equal(sameTeacher.status, 409);
  assert.match(String((await sameTeacher.json()).reasons), /Преподаватель/);
});

test('примечание аудитории сохраняется и приходит в списки выбора', async () => {
  assert.equal((await api('PUT', '/api/rooms', { name: 'МАЛАЯ', capacity: 10, note: 'компьютерный класс' })).status, 200);

  const list = await (await api('GET', '/api/rooms')).json();
  assert.equal((list.find((r) => r.name === 'МАЛАЯ') || {}).note, 'компьютерный класс');

  const free = await (await api('GET', '/api/free-rooms?day=Пт&pairNo=1&weekNo=1')).json();
  const small = [...(free.rooms || []), ...(free.busyRooms || [])].find((r) => r.name === 'МАЛАЯ');
  assert.equal(small.note, 'компьютерный класс', 'примечание отдаётся вместе с аудиторией');

  // Правка вместимости без поля note примечание не стирает.
  await api('PUT', '/api/rooms', { name: 'МАЛАЯ', capacity: 12 });
  const after = await (await api('GET', '/api/rooms')).json();
  assert.equal((after.find((r) => r.name === 'МАЛАЯ') || {}).note, 'компьютерный класс');
});

test('перенос: тесная/занятая аудитория проходит по force', async () => {
  const ask = await api('POST', '/api/move', { lessonId, day: 'Чт', pairNo: 4, weekNo: 1, rooms: ['МАЛАЯ'] });
  assert.equal(ask.status, 409);
  assert.equal((await ask.json()).confirm, true);

  const forced = await api('POST', '/api/move', {
    lessonId, day: 'Чт', pairNo: 4, weekNo: 1, rooms: ['МАЛАЯ'], force: true,
  });
  assert.equal(forced.status, 200);
});

test('правка карточки: тесная аудитория — подтверждение, затем сохранение', async () => {
  // Сначала уводим занятие в подходящую аудиторию, иначе смены аудитории нет
  // и проверять нечего (правка без смены размещения не валидируется).
  assert.equal((await api('PUT', `/api/lesson/${lessonId}`, { rooms: ['БОЛЬШАЯ'] })).status, 200);

  const ask = await api('PUT', `/api/lesson/${lessonId}`, { rooms: ['МАЛАЯ'], topic: 'Т.1' });
  assert.equal(ask.status, 409);
  assert.equal((await ask.json()).confirm, true);

  const forced = await api('PUT', `/api/lesson/${lessonId}`, { rooms: ['МАЛАЯ'], topic: 'Т.1', force: true });
  assert.equal(forced.status, 200);
});
