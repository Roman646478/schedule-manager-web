'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-access-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.ACCESS_DB_PATH = path.join(TMPDIR, 'access.db');
process.env.ARCHIVES_DIR = path.join(TMPDIR, 'archives');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4';

const { createApp } = require('../../src/server');
const { closeDb } = require('../../src/config/database');

let server;
let base;
let ownId;
let foreignId;

function client() {
  const state = { cookie: '', csrf: '' };
  const remember = (res) => {
    const c = res.headers.get('set-cookie');
    if (c) state.cookie = c.split(';')[0];
  };
  return async (method, url, body) => {
    const headers = state.cookie ? { cookie: state.cookie } : {};
    if (method !== 'GET') {
      if (!state.csrf) {
        const r = await fetch(base + '/api/csrf', { headers });
        remember(r);
        state.csrf = (await r.json()).token;
        if (state.cookie) headers.cookie = state.cookie;
      }
      headers['x-csrf-token'] = state.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    remember(res);
    return res;
  };
}

const admin = client();
const editor = client();
const other = client();
const manual = client();

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'admin' })).status, 200);
  await admin('PUT', '/api/groups', { name: '101-11', headcount: 20, dept: '10' });
  await admin('PUT', '/api/groups', { name: '202-22', headcount: 20, dept: '20' });
  ownId = (await (await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'СВОЁ', type: 'ПЗ', groups: ['101-11'], teacher: 'Иванов', room: '101',
  })).json()).id;
  foreignId = (await (await admin('POST', '/api/lessons', {
    day: 'Вт', pairNo: 1, weekNo: 1, subject: 'ЧУЖОЕ', type: 'ПЗ', groups: ['202-22'], teacher: 'Петров', room: '202',
  })).json()).id;
  assert.equal((await admin('POST', '/api/users', {
    username: 'dept10', password: 'password10', departments: ['10'], manualGroups: [],
  })).status, 200);
  assert.equal((await admin('POST', '/api/users', {
    username: 'dept20', password: 'password20', departments: ['20'], manualGroups: [],
  })).status, 200);
  assert.equal((await editor('POST', '/api/login', { username: 'dept10', password: 'password10' })).status, 200);
  assert.equal((await other('POST', '/api/login', { username: 'dept20', password: 'password20' })).status, 200);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('редактор видит всё, но признак editable зависит только от групп', async () => {
  const all = await (await editor('GET', '/api/schedule?view=teacher&id=Петров')).json();
  assert.equal(all.lessons.find((l) => l.id === foreignId).editable, false);
  const own = await (await editor('GET', '/api/schedule?view=teacher&id=Иванов')).json();
  assert.equal(own.lessons.find((l) => l.id === ownId).editable, true);
});

test('редактор меняет свою пару и не меняет чужую или системные настройки', async () => {
  const own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons[0];
  assert.equal((await editor('PUT', `/api/lesson/${ownId}`, { expectedRevision: own.revision, topic: 'Т.2' })).status, 200);
  assert.equal((await editor('PUT', `/api/lesson/${foreignId}`, { expectedRevision: 0, topic: 'ВЗЛОМ' })).status, 403);
  assert.equal((await editor('PUT', '/api/semester', { name: 'x', start: '2026-01-01', end: '2026-02-01' })).status, 403);
  assert.equal((await editor('POST', '/api/lessons', { day: 'Ср', pairNo: 1, weekNo: 1, groups: ['202-22'] })).status, 403);
});

test('общий журнал сохраняет авторов, адресная отмена не трогает чужой перенос', async () => {
  let own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  const a = await (await editor('POST', '/api/move', {
    lessonId: ownId, expectedRevision: own.revision, day: 'Чт', pairNo: 1, weekNo: 1, room: '101',
  })).json();
  let foreign = (await (await other('GET', '/api/schedule?view=group&id=202-22')).json()).lessons.find((l) => l.id === foreignId);
  const b = await (await other('POST', '/api/move', {
    lessonId: foreignId, expectedRevision: foreign.revision, day: 'Пт', pairNo: 1, weekNo: 1, room: '202',
  })).json();
  assert.ok(a.actionId && b.actionId && a.actionId !== b.actionId);
  const actions = (await (await editor('GET', '/api/move-actions')).json()).actions;
  assert.equal(actions.length, 2);
  assert.deepEqual(new Set(actions.map((x) => x.actorName)), new Set(['dept10', 'dept20']));
  assert.equal((await editor('POST', `/api/move-actions/${b.actionId}/revert`, {})).status, 403);
  assert.equal((await editor('POST', `/api/move-actions/${a.actionId}/revert`, {})).status, 200);
  assert.equal((await editor('POST', `/api/move-actions/${a.actionId}/revert`, {})).status, 409);
  own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  foreign = (await (await other('GET', '/api/schedule?view=group&id=202-22')).json()).lessons.find((l) => l.id === foreignId);
  assert.equal(own.day, 'Пн');
  assert.equal(foreign.day, 'Пт');
});

test('устаревшая адресная отмена не затирает более новую правку того же занятия', async () => {
  let own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  const moved = await (await editor('POST', '/api/move', {
    lessonId: ownId, expectedRevision: own.revision, day: 'Сб', pairNo: 1, weekNo: 1, room: '101',
  })).json();
  own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  assert.equal((await editor('PUT', `/api/lesson/${ownId}`, { expectedRevision: own.revision, note: 'поздняя правка' })).status, 200);
  assert.equal((await editor('POST', `/api/move-actions/${moved.actionId}/revert`, {})).status, 409);
});

test('поток с чужой группой целиком доступен только для просмотра', async () => {
  const id = (await (await admin('POST', '/api/lessons', {
    day: 'Ср', pairNo: 2, weekNo: 2, subject: 'ПОТОК', type: 'Л',
    groups: ['101-11', '202-22'], teacher: 'Иванов', room: '101',
  })).json()).id;
  const lesson = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === id);
  assert.equal(lesson.editable, false);
  assert.equal((await editor('PUT', `/api/lesson/${id}`, { expectedRevision: lesson.revision, topic: 'нельзя' })).status, 403);
  assert.equal((await editor('DELETE', `/api/lesson/${id}`, { expectedRevision: lesson.revision })).status, 403);
});

test('редактор использует только существующие справочники и не создаёт мероприятия', async () => {
  const baseLesson = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  assert.equal((await editor('PUT', `/api/lesson/${ownId}`, {
    expectedRevision: baseLesson.revision, room: 'НОВАЯ-999',
  })).status, 403);
  assert.equal((await editor('POST', '/api/lessons', {
    day: 'Пн', pairNo: 2, weekNo: 3, subject: 'СВОЁ', type: 'ПЗ', groups: ['101-11'],
    teacher: 'Новый преподаватель', room: '101',
  })).status, 403);
  assert.equal((await editor('POST', '/api/lessons', {
    day: 'Пн', pairNo: 2, weekNo: 3, subject: 'ОП', category: 'event', groups: ['101-11'],
  })).status, 403);
});

test('операция откатывается целиком, если сортировка тем затрагивает смешанный поток', async () => {
  const ownSort = (await (await admin('POST', '/api/lessons', {
    day: 'Пн', pairNo: 1, weekNo: 4, subject: 'СОРТ', type: 'ПЗ', topic: 'Т.2',
    groups: ['101-11'], teacher: 'Иванов', room: '101',
  })).json()).id;
  await admin('POST', '/api/lessons', {
    day: 'Вт', pairNo: 1, weekNo: 4, subject: 'СОРТ', type: 'ПЗ', topic: 'Т.1',
    groups: ['101-11', '202-22'], teacher: 'Петров', room: '202',
  });
  const before = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownSort);
  const denied = await editor('POST', '/api/move', {
    lessonId: ownSort, expectedRevision: before.revision, day: 'Ср', pairNo: 1, weekNo: 4, room: '101', commandId: randomUUID(),
  });
  assert.equal(denied.status, 403);
  const after = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownSort);
  assert.equal(after.day, 'Пн');
});

test('ручной доступ привязан к стабильному id группы и не наследуется одноимённой новой группой', async () => {
  await admin('PUT', '/api/groups', { name: '303-33', headcount: 10, dept: '30' });
  assert.equal((await admin('POST', '/api/users', {
    username: 'manual303', password: 'password303', departments: [], manualGroups: ['303-33'],
  })).status, 200);
  assert.equal((await manual('POST', '/api/login', { username: 'manual303', password: 'password303' })).status, 200);
  assert.deepEqual((await (await manual('GET', '/api/me/permissions')).json()).groups, ['303-33']);
  const { getDb } = require('../../src/config/database');
  const db = getDb();
  db.prepare("DELETE FROM groups WHERE name='303-33'").run();
  db.prepare("INSERT INTO groups(name, dept) VALUES ('303-33', '30')").run();
  assert.deepEqual((await (await manual('GET', '/api/me/permissions')).json()).groups, []);
});

test('повтор команды с тем же ключом не выполняет перенос второй раз', async () => {
  const own = (await (await editor('GET', '/api/schedule?view=group&id=101-11')).json()).lessons.find((l) => l.id === ownId);
  const commandId = randomUUID();
  const body = { lessonId: ownId, expectedRevision: own.revision, day: 'Вт', pairNo: 3, weekNo: 3, room: '101', commandId };
  const first = await editor('POST', '/api/move', body);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).actionId, commandId);
  const replay = await editor('POST', '/api/move', body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const actions = (await (await editor('GET', '/api/move-actions')).json()).actions;
  assert.equal(actions.filter((a) => a.actionId === commandId).length, 1);
});

test('блокировка пользователя отзывает уже открытую сессию', async () => {
  const users = (await (await admin('GET', '/api/users')).json()).users;
  const target = users.find((u) => u.username === 'dept20');
  assert.ok(target);
  assert.equal((await admin('PATCH', `/api/users/${target.id}`, {
    displayName: target.displayName, active: false, expectedVersion: target.version,
    departments: target.departments, manualGroups: target.manualGroups,
  })).status, 200);
  assert.equal((await other('GET', '/api/entities')).status, 401);
});
