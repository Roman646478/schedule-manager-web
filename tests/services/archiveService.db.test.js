'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Отдельная временная папка: и база, и архивы должны жить вне рабочей data/.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `schedule-archives-${process.pid}-`));
process.env.DB_PATH = path.join(TMP_DIR, 'schedule.db');
process.env.ARCHIVES_DIR = path.join(TMP_DIR, 'archives');

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { getDb, closeDb } = require('../../src/config/database');
const { ensureSessionsTable } = require('../../src/config/sessionStore');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const {
  isValidArchiveId,
  listArchives,
  createArchive,
  setArchiveNote,
  deleteArchive,
  getArchiveFile,
  importArchive,
  restoreArchive,
} = require('../../src/services/archiveService');

const archiveFile = (id) => path.join(process.env.ARCHIVES_DIR, `${id}.db`);

const countLessons = () => getDb().prepare('SELECT COUNT(*) AS n FROM lessons').get().n;

let snapshotId;

test.before(() => {
  const db = getDb();
  ensureSessionsTable(db); // как при старте сервера — иначе таблицы сессий нет
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 10);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 40);
  createLesson({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: 'Иванов И.И.', groups: ['G1'], rooms: ['A'] });
  createLesson({ day: 'Вт', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: 'Иванов И.И.', groups: ['G1'], rooms: ['A'] });
});

test.after(() => {
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('идентификатор архива не пропускает выход за пределы папки архивов', () => {
  assert.ok(isValidArchiveId('2026-08-15_142530'));
  assert.ok(isValidArchiveId('2026-08-15_142530-1'));
  for (const bad of ['../../data/schedule', 'a/b', '2026-08-15', '', null, 'schedule.db', '2026-08-15_1425301']) {
    assert.equal(isValidArchiveId(bad), false, `должен отклоняться: ${bad}`);
  }
});

test('снимок сохраняет состояние базы и попадает в список с примечанием', () => {
  const arc = createArchive({ note: '  до правок  ' });
  snapshotId = arc.id;

  assert.equal(arc.note, 'до правок', 'примечание обрезается по краям');
  assert.equal(arc.lessons, 2);
  assert.ok(arc.size > 0);

  const found = listArchives().find((a) => a.id === snapshotId);
  assert.ok(found, 'снимок виден в списке');
  assert.equal(found.note, 'до правок');
  assert.equal(found.auto, false);
});

test('в снимке нет сессий — это рантайм-состояние, а не данные расписания', () => {
  getDb().prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?,?,?)')
    .run('sid-in-db', '{"isAdmin":true}', Date.now() + 60000);
  const arc = createArchive({ note: 'с активной сессией' });

  const file = archiveFile(arc.id);
  const snapshot = new DatabaseSync(file);
  const n = snapshot.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  snapshot.close();
  assert.equal(n, 0);

  deleteArchive(arc.id);
});

test('переключение на снимок возвращает прежнее состояние базы', () => {
  createLesson({ day: 'Ср', pairNo: 1, weekNo: 1, subject: 'РТС', teacher: 'Иванов И.И.', groups: ['G1'], rooms: ['A'] });
  assert.equal(countLessons(), 3, 'занятие добавлено после снимка');

  const result = restoreArchive(snapshotId);

  assert.equal(result.ok, true);
  assert.equal(countLessons(), 2, 'база вернулась к состоянию снимка');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1, 'справочники тоже из снимка');
});

test('перед переключением текущее состояние уходит в автоснимок — откат обратим', () => {
  const auto = listArchives().filter((a) => a.auto);
  assert.equal(auto.length, 1, 'создан ровно один автоснимок');
  assert.equal(auto[0].lessons, 3, 'в автоснимке — состояние до переключения');
  assert.match(auto[0].note, /перед переключением|перед откатом/i);

  restoreArchive(auto[0].id);
  assert.equal(countLessons(), 3, 'вернулись к состоянию до переключения');

  restoreArchive(snapshotId); // остальные проверки идут от состояния снимка
  assert.equal(countLessons(), 2);
});

test('активная сессия переживает переключение — администратора не выбрасывает', () => {
  const expires = Date.now() + 60000;
  getDb().prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?,?,?)')
    .run('live-session', '{"isAdmin":true}', expires);

  restoreArchive(snapshotId);

  const row = getDb().prepare('SELECT data, expires FROM sessions WHERE sid = ?').get('live-session');
  assert.ok(row, 'сессия перенесена в переключённую базу');
  assert.equal(row.data, '{"isAdmin":true}');
});

test('примечание можно изменить у существующего снимка', () => {
  assert.equal(setArchiveNote(snapshotId, 'новое примечание').ok, true);
  assert.equal(listArchives().find((a) => a.id === snapshotId).note, 'новое примечание');

  const missing = setArchiveNote('2000-01-01_000000', 'нет такого');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 404);
});

/* ---------- Перенос версии между устройствами ---------- */

test('примечание и дата хранятся ВНУТРИ файла — версия самодостаточна', () => {
  const arc = createArchive({ note: 'едет вместе с файлом' });

  // Читаем файл как посторонний, без индексов и служебных данных рядом.
  const snapshot = new DatabaseSync(archiveFile(arc.id), { readOnly: true });
  const meta = Object.fromEntries(
    snapshot.prepare('SELECT key, value FROM archive_meta').all().map((r) => [r.key, r.value])
  );
  snapshot.close();

  assert.equal(meta.note, 'едет вместе с файлом');
  assert.equal(meta.created_at, arc.createdAt);
  assert.equal(meta.auto, '0');
  deleteArchive(arc.id);
});

test('выгрузка отдаёт путь и латинское имя файла', () => {
  const arc = createArchive({ note: 'на выгрузку' });
  const out = getArchiveFile(arc.id);

  assert.equal(out.ok, true);
  assert.equal(out.path, archiveFile(arc.id));
  assert.match(out.filename, /^[\w.-]+\.db$/, 'имя переживёт любую файловую систему');
  assert.equal(fs.existsSync(out.path), true);

  assert.equal(getArchiveFile('2000-01-01_000000').code, 404);
  deleteArchive(arc.id);
});

test('загруженный файл сохраняет примечание и дату исходного устройства', () => {
  const source = createArchive({ note: 'снято на другом устройстве' });
  const bytes = fs.readFileSync(archiveFile(source.id));
  deleteArchive(source.id); // как будто версии здесь никогда не было

  const res = importArchive(bytes);

  assert.equal(res.ok, true);
  assert.equal(res.archive.note, 'снято на другом устройстве');
  assert.equal(res.archive.createdAt, source.createdAt, 'дата исходной версии сохранена');
  assert.equal(res.archive.lessons, source.lessons);
  assert.equal(res.archive.imported, true);
  deleteArchive(res.archive.id);
});

test('загруженная версия не считается автоснимком — автоочистка её не сотрёт', () => {
  const source = createArchive({ note: 'автоснимок на исходном устройстве', auto: true });
  const bytes = fs.readFileSync(archiveFile(source.id));
  deleteArchive(source.id);

  const res = importArchive(bytes, { note: 'привезено с ноутбука' });

  assert.equal(res.archive.auto, false, 'иначе привезённый файл удалила бы автоочистка');
  assert.equal(res.archive.note, 'привезено с ноутбука', 'своё примечание перебивает исходное');
  deleteArchive(res.archive.id);
});

test('посторонний файл версией не становится', () => {
  const before = listArchives().length;

  const garbage = importArchive(Buffer.from('это точно не база данных'));
  assert.equal(garbage.ok, false);
  assert.equal(garbage.code, 400);

  // Валидная база SQLite, но не расписание — тоже отказ.
  const alien = path.join(TMP_DIR, 'alien.db');
  const db = new DatabaseSync(alien);
  db.exec('CREATE TABLE notes(x TEXT)');
  db.close();
  const res = importArchive(fs.readFileSync(alien));
  assert.equal(res.ok, false);
  assert.match(res.error, /не база расписания/i);

  assert.equal(listArchives().length, before, 'битые файлы не оседают в папке архивов');
  assert.equal(fs.readdirSync(process.env.ARCHIVES_DIR).some((f) => f.endsWith('.part')), false);
});

test('переключение не тащит служебные метаданные снимка в рабочую базу', () => {
  const arc = createArchive({ note: 'проверка чистоты' });
  restoreArchive(arc.id);

  const tables = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archive_meta'")
    .all();
  assert.equal(tables.length, 0, 'archive_meta — свойство архива, а не рабочей базы');
  deleteArchive(arc.id);
});

test('удаление снимка убирает и файл, и запись в списке', () => {
  const arc = createArchive({ note: 'на удаление' });
  const file = archiveFile(arc.id);
  assert.ok(fs.existsSync(file));

  assert.equal(deleteArchive(arc.id).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(listArchives().some((a) => a.id === arc.id), false);
  assert.equal(deleteArchive(arc.id).code, 404, 'повторное удаление — 404');
});
