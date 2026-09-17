'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-api-'));
process.env.DB_PATH = path.join(TMPDIR, 'schedule.db');
process.env.CONFIG_PATH = path.join(TMPDIR, 'config.json');
process.env.PUBLIC_DB_PATH = path.join(TMPDIR, 'public_db.json');
process.env.BCRYPT_ROUNDS = '4'; // быстрые хэши в тестах

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/server');
const { closeDb } = require('../../src/config/database');

// Тесты написаны под весенние примеры; в примеры/осень — тёзки другого года.
const EXAMPLES = path.join(__dirname, '..', '..', 'примеры', 'весна');
// Примеры разложены по подпапкам (группы/аудитории/преподователи) — ищем по имени.
function findExample(name) {
  const stack = [EXAMPLES];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  throw new Error(`Пример не найден: ${name}`);
}
const read = (name) => fs.readFileSync(findExample(name));

let server;
let base;
let cookie = '';
let csrf = '';

function rememberCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
}

// Получить CSRF-токен (как клиент) — нужен для небезопасных методов.
async function ensureCsrf() {
  if (csrf) return csrf;
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + '/api/csrf', { headers });
  rememberCookie(res);
  csrf = (await res.json()).token;
  return csrf;
}

async function api(method, urlPath, { body, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = await ensureCsrf();
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + urlPath, { method, headers, body: payload });
  rememberCookie(res);
  return res;
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

test('health доступен без авторизации', async () => {
  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('защищённые роуты без сессии → 401', async () => {
  const res = await api('GET', '/api/entities');
  assert.equal(res.status, 401);
});

test('логин с дефолтными учётными данными', async () => {
  const bad = await api('POST', '/api/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);

  const ok = await api('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
  assert.equal(ok.status, 200);
  assert.ok(cookie, 'кука сессии получена');
});

test('CSRF: мутация без токена отклоняется (403)', async () => {
  // Прямой запрос в обход обёртки — с сессией, но без заголовка X-CSRF-Token.
  const res = await fetch(base + '/api/publish', { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 403);
});

test('импорт 3 примеров через multipart', async () => {
  const form = new FormData();
  form.append('files', new Blob([read('823.html')], { type: 'text/html' }), '823.html');
  form.append('files', new Blob([read('262-7.html')], { type: 'text/html' }), '262-7.html');
  form.append('files', new Blob([read('ГребенникЕ.А..html')], { type: 'text/html' }), 'teacher.html');
  form.append('filterTeachers', 'false'); // проверяем связывание без отсева

  const res = await api('POST', '/api/import', { form });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.success);
  assert.ok(data.report.fromGroups > 0);
  assert.ok(data.report.teachersAssigned > 0);
});

test('импорт: не-HTML файл отбрасывается → 400', async () => {
  const form = new FormData();
  form.append('files', new Blob(['just text'], { type: 'text/plain' }), 'note.txt');
  const res = await api('POST', '/api/import', { form });
  assert.equal(res.status, 400);
});

test('импорт: файл больше лимита → 400', async () => {
  const form = new FormData();
  const big = new Uint8Array(3 * 1024 * 1024); // 3 МБ > лимита 2 МБ
  form.append('files', new Blob([big], { type: 'text/html' }), 'big.html');
  const res = await api('POST', '/api/import', { form });
  assert.equal(res.status, 400);
});

test('представление группы и перенос занятия', async () => {
  const view = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  assert.ok(view.lessons.length > 0);

  const lesson = view.lessons[0];
  // Перенос на занятый группой слот другого занятия той же группы → 409.
  const other = view.lessons.find(
    (l) => l.id !== lesson.id && (l.day !== lesson.day || l.pairNo !== lesson.pairNo || l.weekNo !== lesson.weekNo)
  );
  const conflict = await api('POST', '/api/move', {
    body: { lessonId: lesson.id, day: other.day, pairNo: other.pairNo, weekNo: other.weekNo, room: lesson.room },
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.ok, false);
  assert.ok(conflictBody.reasons.length);

  // Перенос в свободный слот → успех. Слот ищем динамически (данные примеров
  // меняются: часть «дальних» ячеек занята мероприятиями «Отп» и т. п.).
  const opts = await (await api('GET', `/api/move-options?lessonId=${lesson.id}`)).json();
  const freeSlot = opts.slots.find((s) => s.teacherFree && s.groupFree && s.roomFree);
  assert.ok(freeSlot, 'нашёлся свободный слот для переноса');
  const free = await api('POST', '/api/move', {
    body: { lessonId: lesson.id, day: freeSlot.day, pairNo: freeSlot.pairNo, weekNo: freeSlot.weekNo, room: lesson.room },
  });
  assert.equal(free.status, 200);
});

test('правка карточки отклоняет пару вне сетки и не меняет занятие', async () => {
  const view = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  const lesson = view.lessons[0];
  assert.ok(lesson, 'в импортированном расписании есть занятие');

  const bad = await api('PUT', `/api/lesson/${lesson.id}`, { body: { pairNo: 99 } });
  assert.equal(bad.status, 400);
  const result = await bad.json();
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /номер пары/i);

  const after = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  assert.equal(after.lessons.find((item) => item.id === lesson.id).pairNo, lesson.pairNo);
});

test('устаревшая карточка получает 409 и не затирает новую правку', async () => {
  const view = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  const lesson = view.lessons[0];
  assert.equal(typeof lesson.revision, 'number');

  const first = await api('PUT', `/api/lesson/${lesson.id}`, {
    body: { expectedRevision: lesson.revision, topic: 'Т.актуальная' },
  });
  assert.equal(first.status, 200);

  const stale = await api('PUT', `/api/lesson/${lesson.id}`, {
    body: { expectedRevision: lesson.revision, topic: 'Т.устаревшая' },
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.stale, true);
  assert.ok(conflict.currentRevision > lesson.revision);

  const after = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  assert.equal(after.lessons.find((item) => item.id === lesson.id).topic, 'Т.актуальная');
});

test('устаревшая кнопка отмены не отменяет более новое действие', async () => {
  const oldUndo = await (await api('GET', '/api/undo')).json();
  assert.ok(Number.isInteger(oldUndo.id));

  const view = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  const lesson = view.lessons[0];
  const changedTopic = 'Т.для проверки отмены';
  const edit = await api('PUT', `/api/lesson/${lesson.id}`, {
    body: { expectedRevision: lesson.revision, topic: changedTopic },
  });
  assert.equal(edit.status, 200);

  const staleUndo = await api('POST', '/api/undo', { body: { expectedId: oldUndo.id } });
  assert.equal(staleUndo.status, 409);
  assert.equal((await staleUndo.json()).stale, true);

  const afterStale = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  assert.equal(afterStale.lessons.find((item) => item.id === lesson.id).topic, changedTopic);

  const currentUndo = await (await api('GET', '/api/undo')).json();
  assert.notEqual(currentUndo.id, oldUndo.id);
  const undo = await api('POST', '/api/undo', { body: { expectedId: currentUndo.id } });
  assert.equal(undo.status, 200);

  const restored = await (await api('GET', '/api/schedule?view=group&id=823')).json();
  assert.equal(restored.lessons.find((item) => item.id === lesson.id).topic, lesson.topic);
});

test('справочники вместимости/численности и проверка ошибок', async () => {
  assert.equal((await api('PUT', '/api/groups', { body: { name: '823', headcount: 25 } })).status, 200);
  assert.equal((await api('PUT', '/api/rooms', { body: { name: '262-7', capacity: 20 } })).status, 200);

  const errors = await (await api('GET', '/api/errors')).json();
  assert.ok(Array.isArray(errors.overlaps));
  assert.ok(Array.isArray(errors.capacity));
});

test('публикация снимка', async () => {
  const res = await api('POST', '/api/publish');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.ok && data.count > 0);
  assert.ok(fs.existsSync(process.env.PUBLIC_DB_PATH), 'public_db.json создан');
  // Гостевой вид «Дисциплина» берёт список дисциплин из снимка (при его
  // отсутствии — собирает из занятий, но снимок обязан его отдавать).
  const snap = JSON.parse(fs.readFileSync(process.env.PUBLIC_DB_PATH, 'utf8'));
  assert.ok(snap.subjects && snap.subjects.length, 'в снимке есть список дисциплин');
  // Гостевой вид «Кафедра» собирает блоки преподавателей по этой карте: без неё
  // вид показывает только просьбу перепубликовать.
  assert.ok(snap.teacherDept && typeof snap.teacherDept === 'object', 'в снимке есть кафедры преподавателей');
  assert.ok(
    (snap.teachers || []).every((t) => t in snap.teacherDept),
    'кафедра (пусть и пустая) указана для каждого преподавателя снимка'
  );
});

test('data-version: растёт после правки, GET-ы её не двигают', async () => {
  const version = async () => (await (await api('GET', '/api/data-version')).json()).version;

  const v0 = await version();
  await api('GET', '/api/entities');
  assert.equal(await version(), v0, 'чтение не меняет версию');

  assert.equal((await api('PUT', '/api/groups', { body: { name: '823', headcount: 26 } })).status, 200);
  assert.ok((await version()) > v0, 'успешная правка увеличивает версию');

  // Неудачная правка (400) версию не двигает: перерисовывать другим окнам нечего.
  const v1 = await version();
  assert.ok((await api('PUT', '/api/groups', { body: { name: '' } })).status >= 400);
  assert.equal(await version(), v1);

  // Выгрузка — POST, но данные не меняет: скачанный гостем Excel не должен
  // перерисовывать чужие вкладки (и сбивать подсветку окон для переноса).
  const v2 = await version();
  assert.equal((await api('POST', '/api/export/group', { body: { group: '823' } })).status, 200);
  assert.equal(await version(), v2, 'выгрузка не считается правкой');
});

test('logout завершает сессию', async () => {
  assert.equal((await api('POST', '/api/logout')).status, 200);
  cookie = '';
  csrf = '';
  assert.equal((await api('GET', '/api/entities')).status, 401);
});
