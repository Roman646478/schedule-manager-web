'use strict';

// Оптимизация аудиторий на неделе: маленькая группа не должна занимать большую
// аудиторию. Проверяем и перестановку в свободную, и обмен двух занятий.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-roomplan-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4';

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

const roomOf = async (lessonId) => {
  const { lessons } = await (await api('GET', '/api/schedule?view=all')).json();
  const l = (lessons || []).find((x) => x.id === lessonId);
  return l ? (l.rooms || [])[0] : null;
};

let smallGroupLesson; // группа 10 человек в аудитории на 100 мест
let bigGroupLesson; // группа 90 человек в аудитории на 90 мест (обмен не нужен)
let swapA; // 12 человек в зале на 60
let swapB; // 55 человек в кабинете на 40 → обмен снимает нехватку мест

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });

  const db = getDb();
  const room = (name, cap, kind) => db.prepare('INSERT INTO rooms(name, capacity, kind, hidden) VALUES(?,?,?,0)').run(name, cap, kind || null);
  const group = (name, n) => db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, n);
  room('Большая', 100);
  room('Малая', 20);
  room('Лаборатория', 20, 'лаб');
  room('Зал', 60);
  room('Кабинет', 40);
  group('901-11', 10);
  group('901-12', 12);
  group('901-13', 35);
  group('901-14', 55);

  const mk = async (over) => (await (await api('POST', '/api/lessons', Object.assign({
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ',
  }, over))).json()).id;

  // Пн, 1 пара: маленькая группа в большой аудитории — есть свободная «Малая».
  smallGroupLesson = await mk({ groups: ['901-11'], rooms: ['Большая'] });
  // Пн, 2 пара: обмен — 12 человек в «Зале» (60), 55 человек в «Кабинете» (40, не влезают).
  swapA = await mk({ pairNo: 2, groups: ['901-12'], rooms: ['Зал'] });
  swapB = await mk({ pairNo: 2, groups: ['901-14'], rooms: ['Кабинет'], force: true });
  // Пн, 3 пара: 35 человек в «Кабинете» (40) — трогать нечего.
  bigGroupLesson = await mk({ pairNo: 3, groups: ['901-13'], rooms: ['Кабинет'] });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('предложения: перестановка в меньшую свободную и обмен аудиториями', async () => {
  const res = await api('GET', '/api/room-plan?weekNo=1');
  assert.equal(res.status, 200);
  const { suggestions } = await res.json();

  const move = suggestions.find((s) => s.lessonId === smallGroupLesson);
  assert.ok(move, 'занятие маленькой группы в большой аудитории найдено');
  assert.equal(move.action, 'move');
  assert.equal(move.toRoom, 'Малая', 'предложена самая тесная подходящая аудитория');

  const swap = suggestions.find((s) => s.action === 'swap');
  assert.ok(swap, 'обмен найден');
  assert.deepEqual(
    [swap.lessonId, swap.withLessonId].sort(), [swapA, swapB].sort(),
    'меняются местами именно эти два занятия');

  assert.ok(!suggestions.some((s) => s.lessonId === bigGroupLesson), 'плотно занятая аудитория не трогается');
});

test('лабораторию не предлагают вместо обычной аудитории', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  assert.ok(!suggestions.some((s) => s.toRoom === 'Лаборатория'), 'тип аудитории сохраняется');
});

test('применяются только отмеченные предложения, откат — «Отменить»', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const move = suggestions.find((s) => s.lessonId === smallGroupLesson);

  const res = await api('POST', '/api/room-plan/apply', { items: [move] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, 1);
  assert.equal(await roomOf(smallGroupLesson), 'Малая');
  assert.equal(await roomOf(swapA), 'Зал', 'неотмеченное предложение не применилось');

  // Подбор аудиторий — такое же изменение, как ручное: попадает в журнал.
  const logged = async () => ((await (await api('GET', '/api/move-log')).json()).entries || [])
    .filter((e) => e.action === 'room' && e.lessonId === smallGroupLesson);
  const after = await logged();
  assert.equal(after.length, 1, 'в журнале запись о смене аудитории');
  assert.deepEqual([after[0].fromRoom, after[0].room], ['Большая', 'Малая']);

  assert.equal((await api('POST', '/api/undo')).status, 200);
  assert.equal(await roomOf(smallGroupLesson), 'Большая', 'откат вернул прежнюю аудиторию');
  assert.equal((await logged()).length, 0, 'откат снял и запись журнала');
});

test('обмен переставляет обе аудитории сразу', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const swap = suggestions.find((s) => s.action === 'swap');

  const res = await api('POST', '/api/room-plan/apply', { items: [swap] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, 2);
  assert.equal(await roomOf(swapA), 'Кабинет');
  assert.equal(await roomOf(swapB), 'Зал');

  await api('POST', '/api/undo');
});

test('устаревшее предложение пропускается, а не создаёт накладку', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const move = suggestions.find((s) => s.lessonId === smallGroupLesson);
  // Пока пользователь думал, «Малую» заняли другим занятием.
  await api('POST', '/api/lessons', { day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ОГП', type: 'ПЗ', groups: ['901-12'], rooms: ['Малая'] });

  const res = await api('POST', '/api/room-plan/apply', { items: [move] });
  const data = await res.json();
  assert.equal(data.applied, 0);
  assert.equal(data.skipped, 1);
  assert.equal(await roomOf(smallGroupLesson), 'Большая');
});

test('на занятие предлагается несколько вариантов, лучший — первым', () => {
  return (async () => {
    const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
    const move = suggestions.find((s) => s.lessonId === smallGroupLesson);
    assert.ok(Array.isArray(move.options) && move.options.length > 1, 'вариантов больше одного');
    assert.deepEqual(
      move.options.map((o) => o.toRoom),
      ['Кабинет', 'Зал'], // «Малую» занял предыдущий тест — она уже не свободна
      'варианты идут от самого тесного подходящего к самому просторному');
    // Верхний уровень предложения — это первый вариант (его показывает таблица).
    assert.equal(move.toRoom, move.options[0].toRoom);
    assert.ok(move.options.every((o) => o.gain > 0), 'бесполезных вариантов нет');
  })();
});
