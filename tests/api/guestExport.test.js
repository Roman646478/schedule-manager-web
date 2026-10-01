'use strict';

// Выгрузка расписания группы, преподавателя, дисциплины и сводного за неделю с
// гостевой страницы: работает БЕЗ входа, но только при включённом тумблере
// (settings.guestExport). Остальные выгрузки (сводное за семестр, все группы)
// гостю закрыты всегда.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-guest-export-'));
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
  lessonId = (await (await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТЕСТ', type: 'ПЗ',
    groups: ['999-11'], teacher: 'Иванов И.И.', topic: 'Т.1', room: 'А-101',
  })).json()).id;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('тумблер выключен по умолчанию, гостю выгрузка запрещена', async () => {
  assert.equal((await guest('POST', '/api/export/guest-view', { kind: 'room', id: 'А-101', weeks: [1] })).status, 403);
  assert.equal((await (await guest('GET', '/api/guest-export')).json()).enabled, false);
  assert.equal((await guest('POST', '/api/export/group', { group: '999-11' })).status, 403);
  assert.equal((await guest('POST', '/api/export/teacher', { teacher: 'Иванов И.И.' })).status, 403);
  assert.equal((await guest('POST', '/api/export/weekly', { weekNo: 1 })).status, 403);
  assert.equal((await guest('POST', '/api/export/subject', { subject: 'ТЕСТ', groups: ['999-11'] })).status, 403);
});

test('тумблер переключает только админ', async () => {
  assert.equal((await guest('PUT', '/api/guest-export', { enabled: true })).status, 401);
  assert.equal((await admin('PUT', '/api/guest-export', { enabled: true })).status, 200);
  assert.equal((await (await guest('GET', '/api/guest-export')).json()).enabled, true);
});

test('при включённом тумблере гость получает xlsx группы, преподавателя, дисциплины и сводного', async () => {
  // Файл гостя строится из снимка: без публикации строить не из чего.
  const unpublished = await guest('POST', '/api/export/group', { group: '999-11' });
  assert.equal(unpublished.status, 404);
  assert.match((await unpublished.json()).error, /не опубликовано/);
  assert.equal((await admin('POST', '/api/publish')).status, 200);

  for (const [url, body] of [
    ['/api/export/group', { group: '999-11' }],
    ['/api/export/teacher', { teacher: 'Иванов И.И.' }],
    ['/api/export/weekly', { weekNo: 1 }],
    ['/api/export/subject', { subject: 'ТЕСТ', groups: ['999-11'] }],
  ]) {
    const res = await guest('POST', url, body);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-disposition') || '', /attachment/, url);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, `${url}: файл не пустой`);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', `${url}: это zip/xlsx`);
  }
});

// Тумблер «гостям видны свободные окна» — та же схема: читают все, меняет админ.
// Сама подсветка считается на клиенте по опубликованному снимку.
test('тумблер свободных окон: по умолчанию выключен, включает только админ', async () => {
  assert.equal((await (await guest('GET', '/api/guest-moves')).json()).enabled, false);
  assert.equal((await guest('PUT', '/api/guest-moves', { enabled: true })).status, 401);
  assert.equal((await admin('PUT', '/api/guest-moves', { enabled: true })).status, 200);
  assert.equal((await (await guest('GET', '/api/guest-moves')).json()).enabled, true);
});

// Тумблер «разные цвета занятий» — единственный из гостевых, включённый ПО
// УМОЛЧАНИЮ: он нужен, чтобы оформление выключить.
test('тумблер цветов: по умолчанию включён, выключает только админ', async () => {
  assert.equal((await (await guest('GET', '/api/guest-colors')).json()).enabled, true);
  assert.equal((await guest('PUT', '/api/guest-colors', { enabled: false })).status, 401);
  assert.equal((await admin('PUT', '/api/guest-colors', { enabled: false })).status, 200);
  assert.equal((await (await guest('GET', '/api/guest-colors')).json()).enabled, false);
  assert.equal((await admin('PUT', '/api/guest-colors', { enabled: true })).status, 200);
  assert.equal((await (await guest('GET', '/api/guest-colors')).json()).enabled, true);
});

// Гостевая выгрузка сводного идёт со списком видимых групп (фильтр «Курсы»).
// Пустой список — не «все группы»: иначе фильтр, скрывший всё, молча отдавал бы
// полный файл, а раньше гость и вовсе слал один weekNo и получал все группы.
test('сводное гостю: список групп сужает файл, пустой список — отказ', async () => {
  const ExcelJS = require('exceljs');
  await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 2, weekNo: 1, subject: 'ТЕСТ2', type: 'ПЗ',
    groups: ['888-11'], teacher: 'Петров П.П.', topic: 'Т.1',
  });
  assert.equal((await admin('POST', '/api/publish')).status, 200);
  const cols = async (res) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.worksheets[0];
    const out = [];
    for (let c = 5; c <= 60; c++) {
      const v = ws.getCell(3, c).value;
      const t = v == null ? '' : String(v.richText ? v.richText.map((x) => x.text).join('') : v).trim();
      if (!t) break;
      out.push(t);
    }
    return out;
  };
  assert.deepEqual(await cols(await guest('POST', '/api/export/weekly', { weekNo: 1 })), ['888-11', '999-11']);
  assert.deepEqual(await cols(await guest('POST', '/api/export/weekly', { weekNo: 1, groups: ['999-11'] })), ['999-11']);
  const empty = await guest('POST', '/api/export/weekly', { weekNo: 1, groups: [] });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /скрыты фильтрами/);
});

test('остальные выгрузки гостю закрыты и с включённым тумблером', async () => {
  assert.equal((await guest('POST', '/api/export/groups', {})).status, 401);
  assert.equal((await guest('POST', '/api/export/summary', {})).status, 401);
});

test('аудитория и кафедра: Excel содержит только опубликованные занятия выбранных недель', async () => {
  const ExcelJS = require('exceljs');
  await admin('PUT', '/api/rooms', { name: 'А-101', dept: '81', capacity: 30 });
  await admin('POST', '/api/publish');
  await admin('PUT', `/api/lesson/${lessonId}`, { note: 'НЕ ОПУБЛИКОВАНО' });
  for (const target of [
    { kind: 'room', id: 'А-101' },
    { kind: 'dept', id: '81', deptKind: 'room' },
    { kind: 'dept', id: '81', deptKind: 'room-matrix' },
    { kind: 'dept', id: '(без кафедры)', deptKind: 'teacher' },
  ]) {
    const res = await guest('POST', '/api/export/guest-view', { ...target, weeks: [1, 2] });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map((ws) => ws.name), ['Неделя 1', 'Неделя 2']);
    const textOf = (ws) => JSON.stringify(ws.getSheetValues());
    assert.match(textOf(wb.worksheets[0]), /ТЕСТ/);
    assert.doesNotMatch(textOf(wb.worksheets[0]), /НЕ ОПУБЛИКОВАНО/);
    assert.doesNotMatch(textOf(wb.worksheets[1]), /ТЕСТ/);
  }
  assert.equal((await guest('POST', '/api/export/guest-view', { kind: 'room', id: 'А-101', weeks: [0] })).status, 400);
  assert.equal((await guest('POST', '/api/export/guest-view', { kind: 'room', id: 'нет', weeks: [1] })).status, 404);
});

// Гость видит опубликованный снимок — и Excel у него такой же, а перенос после
// публикации видит только админ.
test('файл гостя — из снимка: перенос после публикации в него не попадает', async () => {
  const ExcelJS = require('exceljs');
  const where = async (res) => {
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const out = [];
    wb.worksheets[0].eachRow((row, r) => row.eachCell((cell, c) => {
      const v = cell.value;
      const t = v && v.richText ? v.richText.map((x) => x.text).join('') : String(v ?? '');
      if (t.trim() === 'ТЕСТ') out.push(`${r}:${c}`);
    }));
    return out;
  };
  assert.equal((await admin('POST', '/api/publish')).status, 200);
  const published = await where(await guest('POST', '/api/export/group', { group: '999-11' }));
  assert.ok(published.length, 'занятие есть в файле');

  assert.equal((await admin('POST', '/api/move', { lessonId, day: 'Ср', pairNo: 3, weekNo: 2, force: true })).status, 200);
  assert.deepEqual(await where(await guest('POST', '/api/export/group', { group: '999-11' })), published, 'гость — как опубликовано');
  assert.notDeepEqual(await where(await admin('POST', '/api/export/group', { group: '999-11' })), published, 'админ — живая база');
});
