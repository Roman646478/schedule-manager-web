'use strict';

// Дисциплины в подвале группы: добавление из справочника и удаление строки
// вместе с занятиями этой дисциплины у группы (поток теряет только эту группу).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-subj-api-'));
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

const GROUP = '901-11';
const subjectsOf = async (group) =>
  ((await (await api('GET', '/api/group-subjects')).json()).groupSubjects || {})[group] || [];

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

test('добавление дисциплины в подвал группы', async () => {
  const res = await api('POST', '/api/group-subjects', {
    group: GROUP,
    fields: { abbr: 'ТПРН', fullName: 'Теория принятия решений', hours: '30-42', lecturer: 'Иванов И.И.' },
  });
  assert.equal(res.status, 201);
  const list = await subjectsOf(GROUP);
  assert.equal(list.length, 1);
  assert.equal(list[0].abbr, 'ТПРН');
  assert.deepEqual(list[0].teachers, ['Иванов И.И.'], 'ФИО разобраны в список преподавателей');

  // Дисциплина попала и в общий справочник — её видно в форме добавления занятия.
  const { subjects } = await (await api('GET', '/api/subjects')).json();
  assert.ok((subjects || []).some((s) => s.abbr === 'ТПРН'));

  // Новый преподаватель из подвала заведён в справочнике: у него появилось
  // собственное (пока пустое) расписание, куда дальше добавляются занятия.
  assert.deepEqual((await res.json()).teachers, ['Иванов И.И.']);
  const entities = await (await api('GET', '/api/entities')).json();
  assert.ok((entities.teachers || []).includes('Иванов И.И.'), 'фамилия есть в селекторе преподавателей');
  const view = await (await api('GET', '/api/schedule?view=teacher&id=' + encodeURIComponent('Иванов И.И.'))).json();
  assert.deepEqual(view.lessons || [], [], 'расписание нового преподавателя открывается пустым');
});

test('повторное добавление той же дисциплины отклоняется', async () => {
  const res = await api('POST', '/api/group-subjects', { group: GROUP, fields: { abbr: 'ТПРН' } });
  assert.equal(res.status, 409);
  assert.match(String((await res.json()).reasons), /уже есть/);
});

test('добавление без обозначения → 400', async () => {
  const res = await api('POST', '/api/group-subjects', { group: GROUP, fields: { fullName: 'Без кода' } });
  assert.equal(res.status, 400);
});

test('удаление строки убирает и занятия этой дисциплины у группы', async () => {
  // Одиночное занятие группы + потоковое с соседней группой.
  const solo = await (await api('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', groups: [GROUP],
  })).json();
  assert.ok(solo.id);
  const stream = await (await api('POST', '/api/lessons', {
    day: 'Вт', pairNo: 2, weekNo: 1, subject: 'ТПРН', type: 'Л', groups: [GROUP, '901-12'],
  })).json();
  assert.ok(stream.id);

  const res = await api('DELETE', '/api/group-subjects', { group: GROUP, index: 0 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.deleted, 1, 'одиночное занятие удалено');
  assert.equal(data.modified, 1, 'из потокового убрана только эта группа');

  assert.equal((await subjectsOf(GROUP)).length, 0, 'строка исчезла из подвала');

  const view = await (await api('GET', `/api/schedule?view=group&id=${encodeURIComponent(GROUP)}`)).json();
  assert.equal((view.lessons || []).filter((l) => l.subject === 'ТПРН').length, 0, 'у группы занятий ТПРН нет');

  const other = await (await api('GET', '/api/schedule?view=group&id=901-12')).json();
  assert.equal((other.lessons || []).filter((l) => l.subject === 'ТПРН').length, 1, 'у соседней группы поток остался');
});

test('удаление восстанавливается кнопкой «Отменить»', async () => {
  const res = await api('POST', '/api/undo');
  assert.equal(res.status, 200);
  const view = await (await api('GET', `/api/schedule?view=group&id=${encodeURIComponent(GROUP)}`)).json();
  assert.equal((view.lessons || []).filter((l) => l.subject === 'ТПРН').length, 2, 'оба занятия вернулись');
});

// Порядок строк подвала — алфавитный по обозначению, независимо от порядка
// добавления. Правка и удаление ходят по индексу, поэтому индекс обязан
// считаться от того же (отсортированного) порядка, который видит составитель.
test('дисциплины подвала отдаются по алфавиту, индексы строк — от того же порядка', async () => {
  const G = '902-11';
  for (const abbr of ['ЯДТ', 'АБВ', 'МА']) {
    assert.equal((await api('POST', '/api/group-subjects', { group: G, fields: { abbr } })).status, 201);
  }
  assert.deepEqual((await subjectsOf(G)).map((s) => s.abbr), ['АБВ', 'МА', 'ЯДТ']);

  // Индекс 1 — это «МА», средняя строка видимого порядка.
  assert.equal((await api('DELETE', '/api/group-subjects', { group: G, index: 1 })).status, 200);
  assert.deepEqual((await subjectsOf(G)).map((s) => s.abbr), ['АБВ', 'ЯДТ']);
});
