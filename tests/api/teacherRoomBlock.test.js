'use strict';

// Подбор аудиторий, правило «преподаватель ведёт подряд идущие пары в одной
// аудитории»: блок 1–3 пары в разных аудиториях собирается в одну.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-trblock-api-'));
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

// Вид предложения — это правило, которое оно чинит: пары преподавателя у одной
// группы (teacherGroup) или у разных (teacherAny).
const isBlock = (s) => s.kind === 'teacherGroup' || s.kind === 'teacherAny';

const TEACHER = 'Смирнов С.С.';
let p1;
let p2;
let p3; // пары преподавателя: Пн, 1-я, 2-я и 3-я
let neighbour; // чужое занятие, сидящее в целевой аудитории на 2-й паре

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/login', { username: 'admin', password: 'admin' });

  const db = getDb();
  const room = (name, cap) => db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run(name, cap);
  const group = (name, n) => db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, n);
  room('А-1', 30);
  room('А-2', 32);
  room('А-3', 34);
  room('Огромная', 200); // перерасход больше 15 мест — под блок не годится
  group('701-11', 25);
  group('701-12', 25);
  group('702-11', 28);

  const mk = async (over) => (await (await api('POST', '/api/lessons', Object.assign({
    day: 'Пн', weekNo: 1, subject: 'ТПРН', type: 'ПЗ', teacher: TEACHER, groups: ['701-11'],
  }, over))).json()).id;

  // Три пары подряд у одного преподавателя — в трёх разных аудиториях.
  p1 = await mk({ pairNo: 1, rooms: ['А-1'] });
  p2 = await mk({ pairNo: 2, rooms: ['А-2'] });
  p3 = await mk({ pairNo: 3, rooms: ['А-3'] });
  // Чужая пара занимает «А-1» на 2-й паре: собрать блок в «А-1» можно только обменом.
  neighbour = await mk({ pairNo: 2, rooms: ['А-1'], teacher: 'Другой Д.Д.', groups: ['702-11'], subject: 'ОГП' });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('блок преподавателя найден: пары подряд в разных аудиториях', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const block = suggestions.find(isBlock);
  assert.ok(block, 'предложение по блоку есть');
  assert.equal(block.teacher, TEACHER);
  assert.deepEqual(block.pairs, [1, 2, 3], 'блок из трёх подряд идущих пар');
  assert.deepEqual([...block.lessonIds].sort(), [p1, p2, p3].sort());
  assert.ok(!suggestions.some((s) => s.kind === 'capacity' && block.lessonIds.includes(s.lessonId)),
    'занятия блока не дублируются предложением по вместимости');
});

test('варианты сборки блока: только аудитории с перерасходом до 15 мест', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const block = suggestions.find(isBlock);
  assert.ok(block.options.length > 1, 'вариантов несколько');
  assert.ok(!block.options.some((o) => o.toRoom === 'Огромная'),
    'аудитория на 200 мест под группу в 25 человек не предлагается');
  for (const o of block.options) assert.ok(o.steps.length, 'у варианта есть шаги');
});

test('применение плана собирает все пары в одну аудиторию (с обменом)', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const block = suggestions.find(isBlock);
  // Вариант со сборкой в «А-1»: там нужен обмен с чужим занятием 2-й пары.
  const plan = block.options.find((o) => o.toRoom === 'А-1');
  assert.ok(plan, 'вариант «А-1» есть');
  assert.ok(plan.steps.some((s) => s.action === 'swap'), 'в плане есть обмен аудиториями');

  const res = await api('POST', '/api/room-plan/apply', { items: [{ ...block, ...plan }] });
  assert.equal(res.status, 200);
  assert.deepEqual(
    [await roomOf(p1), await roomOf(p2), await roomOf(p3)],
    ['А-1', 'А-1', 'А-1'],
    'все три пары преподавателя в одной аудитории');
  assert.equal(await roomOf(neighbour), 'А-2', 'соседнее занятие уехало в освобождённую аудиторию');

  // Откат возвращает всё как было.
  assert.equal((await api('POST', '/api/undo')).status, 200);
  assert.deepEqual(
    [await roomOf(p1), await roomOf(p2), await roomOf(p3), await roomOf(neighbour)],
    ['А-1', 'А-2', 'А-3', 'А-1']);
});

test('устаревший план блока не применяется частично', async () => {
  const { suggestions } = await (await api('GET', '/api/room-plan?weekNo=1')).json();
  const block = suggestions.find(isBlock);
  const plan = block.options.find((o) => o.toRoom === 'А-3') || block.options[0];
  // Ломаем план: занимаем целевую аудиторию на 1-й паре чужим занятием.
  await api('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ОГП', type: 'ПЗ',
    teacher: 'Третий Т.Т.', groups: ['701-12'], rooms: [plan.toRoom], force: true,
  });

  const res = await api('POST', '/api/room-plan/apply', { items: [{ ...block, ...plan }] });
  const data = await res.json();
  assert.equal(data.applied, 0, 'ни один шаг плана не применён');
  assert.equal(data.skipped, 1);
  assert.deepEqual([await roomOf(p1), await roomOf(p2), await roomOf(p3)], ['А-1', 'А-2', 'А-3'],
    'расписание не тронуто');
});
