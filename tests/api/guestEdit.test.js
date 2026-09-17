'use strict';

// Правка темы и примечания с гостевой страницы: работает БЕЗ входа, но только
// при включённом тумблере (settings.guestEdit), только эти два поля, и правка
// попадает не только в базу, но и в опубликованный снимок public_db.json.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-guest-api-'));
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

// Две независимые «сессии»: админ и гость (у гостя своя кука и свой CSRF).
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
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
    groups: ['999-11'], teacher: 'Иванов И.И.', topic: 'Т.1',
  });
  lessonId = (await res.json()).id;
  await admin('POST', '/api/publish');
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('тумблер выключен по умолчанию, правка гостем запрещена', async () => {
  assert.equal((await (await guest('GET', '/api/guest-edit')).json()).enabled, false);

  const res = await guest('PUT', `/api/guest/lesson/${lessonId}`, { topic: 'взлом' });
  assert.equal(res.status, 403);
});

test('тумблер переключает только админ', async () => {
  assert.equal((await guest('PUT', '/api/guest-edit', { enabled: true })).status, 401);
  assert.equal((await admin('PUT', '/api/guest-edit', { enabled: true })).status, 200);
  assert.equal((await (await guest('GET', '/api/guest-edit')).json()).enabled, true);
});

test('при включённом тумблере гость правит тему и примечание — и в базе, и в снимке', async () => {
  const res = await guest('PUT', `/api/guest/lesson/${lessonId}`, { topic: 'Т.7', note: 'перенос' });
  assert.equal(res.status, 200);

  const lessons = (await (await admin('GET', '/api/schedule?view=teacher&id=Иванов И.И.')).json()).lessons;
  const l = lessons.find((x) => x.id === lessonId);
  assert.equal(l.topic, 'Т.7');
  assert.equal(l.note, 'перенос');

  // Снимок патчится точечно, без перепубликации: гостевая страница читает его.
  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  const sl = snap.lessons.find((x) => x.id === lessonId);
  assert.equal(sl.topic, 'Т.7');
  assert.equal(sl.note, 'перенос');
});

test('гостю доступны ТОЛЬКО тема, примечание и вид занятия', async () => {
  const res = await guest('PUT', `/api/guest/lesson/${lessonId}`, {
    topic: 'Т.8', day: 'Пт', groups: ['777-11'],
  });
  assert.equal(res.status, 200);

  const lessons = (await (await admin('GET', '/api/schedule?view=teacher&id=Иванов И.И.')).json()).lessons;
  const l = lessons.find((x) => x.id === lessonId);
  assert.equal(l.topic, 'Т.8', 'тема изменилась');
  assert.equal(l.day, 'Пн', 'слот не тронут');
  assert.deepEqual(l.groups, ['999-11'], 'группы не тронуты');
});

// Вид занятия: практическое → практическое. Лекции и формы контроля вне игры —
// ни как исходный вид, ни как новый. Список видов — справочник lessonTypes.
test('вид занятия гость меняет только у практических и только на практический', async () => {
  const typeOf = async (id) => {
    const lessons = (await (await admin('GET', '/api/schedule?view=teacher&id=Иванов И.И.')).json()).lessons;
    return lessons.find((x) => x.id === id).type;
  };

  assert.equal((await guest('PUT', `/api/guest/lesson/${lessonId}`, { type: 'ЛР' })).status, 200);
  assert.equal(await typeOf(lessonId), 'ЛР', 'ПЗ → ЛР разрешено');

  // Снимок патчится вместе с базой — гостевая страница читает его.
  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  assert.equal(snap.lessons.find((x) => x.id === lessonId).type, 'ЛР');

  for (const type of ['Л', 'Экз', 'ЗО', 'НетТакого']) {
    assert.equal((await guest('PUT', `/api/guest/lesson/${lessonId}`, { type })).status, 403, `${type} запрещён`);
  }
  assert.equal(await typeOf(lessonId), 'ЛР', 'отказы ничего не изменили');

  // Лекцию не тронуть даже на практический вид.
  const lec = (await (await admin('POST', '/api/lessons', {
    day: 'Вт', pairNo: 1, weekNo: 1, subject: 'ТЕСТ', type: 'Л',
    groups: ['999-11'], teacher: 'Иванов И.И.',
  })).json()).id;
  assert.equal((await guest('PUT', `/api/guest/lesson/${lec}`, { type: 'ПЗ' })).status, 403);
  assert.equal(await typeOf(lec), 'Л');

  await guest('PUT', `/api/guest/lesson/${lessonId}`, { type: 'ПЗ' }); // вернули как было
});

test('снимок публикации несёт данные для таблицы итогов преподавателя', async () => {
  await admin('POST', '/api/publish');
  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  assert.ok(snap.groupsSummary, 'есть сводка по группам');
  assert.ok(snap.groupSubjects, 'есть подвал расписания групп');
  const g = snap.groupsSummary['999-11'];
  assert.ok(g && g.subjects, 'у группы посчитаны часы по дисциплинам');
  assert.equal(g.subjects['ТЕСТ'].pracH, 2, 'одна пара ПЗ = 2 часа практики');

  // Виды для выпадающего списка у гостя: справочник без лекций и форм контроля.
  assert.ok(snap.practicalTypes.includes('ПЗ'), 'ПЗ в списке');
  assert.deepEqual(
    snap.practicalTypes.filter((t) => ['Л', 'Зач', 'ЗО', 'Экз'].includes(t)),
    [], 'ни лекций, ни зачётов/экзаменов'
  );
});
