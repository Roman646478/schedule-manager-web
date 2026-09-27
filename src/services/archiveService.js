'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { ARCHIVES_DIR, DB_PATH } = require('../utils/constants');
const { getDb, closeDb, reopenDb, initializeDatabase } = require('../config/database');
const { ensureSessionsTable } = require('../config/sessionStore');

// Архив = снимок всей базы (файл schedule.db) на момент создания. Снимок
// делается через VACUUM INTO — работает на живой базе, не требует остановки
// сервера.
//
// Примечание, дата и признаки версии лежат ВНУТРИ файла снимка (таблица
// archive_meta). Благодаря этому файл самодостаточен: его можно скопировать на
// другое устройство или флешку, и там он покажет то же примечание. Отдельного
// индекса рядом нет — списку неоткуда рассинхронизироваться с файлами.

const META_TABLE = 'archive_meta';
// Идентификатор = дата_время создания. Только цифры, дефис и подчёркивание —
// поэтому подставить сюда путь («../») невозможно.
const ID_RE = /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/;
const NOTE_MAX = 500;
// Сколько автоснимков «перед откатом» хранить (ручные и загруженные не трогаем).
const AUTO_KEEP = 5;
// Файл должен быть базой расписания, а не любой базой SQLite.
const REQUIRED_TABLES = ['lessons', 'groups', 'rooms', 'lesson_groups'];

function isValidArchiveId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function ensureDir() {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
}

function archivePath(id) {
  if (!isValidArchiveId(id)) throw new Error('Некорректный идентификатор архива');
  return path.join(ARCHIVES_DIR, `${id}.db`);
}

function cleanNote(note) {
  return String(note == null ? '' : note).trim().slice(0, NOTE_MAX);
}

// Идентификатор («2026-08-14_093000») человеку не читается — для примечаний
// показываем дату и время.
function humanId(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(id);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : id;
}

/* ---------- Метаданные внутри файла снимка ---------- */

function metaFromDb(arc) {
  const meta = {};
  try {
    for (const row of arc.prepare(`SELECT key, value FROM ${META_TABLE}`).all()) meta[row.key] = row.value;
  } catch {
    /* в файле, скопированном до появления archive_meta, метаданных нет */
  }
  return meta;
}

// Записать метаданные и заодно вычистить сессии: они рантайм-состояние, а не
// данные расписания, и в переносимом файле им точно не место.
function writeMeta(file, patch) {
  const arc = new DatabaseSync(file);
  try {
    arc.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
    const ins = arc.prepare(`INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
    for (const [key, value] of Object.entries(patch)) ins.run(key, String(value));
    try {
      arc.exec('DELETE FROM sessions');
    } catch {
      /* таблицы сессий может не быть */
    }
  } finally {
    arc.close();
  }
}

// Читает файл снимка: метаданные, число занятий и пригодность файла. Открываем
// только на чтение — список не должен менять архивы.
function inspectArchive(file) {
  let arc = null;
  try {
    arc = new DatabaseSync(file, { readOnly: true });
    if (arc.prepare('PRAGMA quick_check').all().some(row => Object.values(row)[0] !== 'ok')) {
      return { ok: false, error: 'Нарушена целостность базы SQLite' };
    }
    const tables = new Set(
      arc.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) {
      return { ok: false, error: `Это не база расписания: не хватает таблиц (${missing.join(', ')})` };
    }
    const meta = metaFromDb(arc);
    return {
      ok: true,
      note: cleanNote(meta.note),
      createdAt: meta.created_at || null,
      auto: meta.auto === '1',
      imported: meta.imported === '1',
      lessons: arc.prepare('SELECT COUNT(*) AS n FROM lessons').get().n,
    };
  } catch {
    return { ok: false, error: 'Файл повреждён или не является базой данных SQLite' };
  } finally {
    if (arc) {
      try {
        arc.close();
      } catch {
        /* уже закрыт */
      }
    }
  }
}

/* ---------- Список, создание, правка, удаление ---------- */

// Свободный идентификатор по текущему времени (с суффиксом при совпадении секунды).
function nextId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const base =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let id = base;
  for (let n = 1; fs.existsSync(path.join(ARCHIVES_DIR, `${id}.db`)); n++) id = `${base}-${n}`;
  return id;
}

function listArchives() {
  ensureDir();
  const list = [];
  for (const file of fs.readdirSync(ARCHIVES_DIR)) {
    if (!file.endsWith('.db')) continue;
    const id = file.slice(0, -3);
    if (!isValidArchiveId(id)) continue;
    const full = path.join(ARCHIVES_DIR, file);
    const stat = fs.statSync(full);
    const info = inspectArchive(full);
    list.push({
      id,
      note: info.ok ? info.note : '',
      auto: info.ok ? info.auto : false,
      imported: info.ok ? info.imported : false,
      lessons: info.ok ? info.lessons : null,
      // Дата берётся из файла: у версии, привезённой с другого устройства,
      // она остаётся исходной, и список сохраняет хронологию.
      createdAt: (info.ok && info.createdAt) || stat.mtime.toISOString(),
      size: stat.size,
      broken: !info.ok,
      error: info.ok ? undefined : info.error,
    });
  }
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// Удалить самые старые автоснимки, оставив AUTO_KEEP последних. Загруженные и
// созданные вручную версии не трогаем — ими распоряжается пользователь.
function pruneAuto() {
  for (const old of listArchives().filter((a) => a.auto).slice(AUTO_KEEP)) deleteArchive(old.id);
}

function createArchive({ note = '', auto = false } = {}) {
  ensureDir();
  const db = getDb();
  const id = nextId();
  const file = path.join(ARCHIVES_DIR, `${id}.db`);
  const createdAt = new Date().toISOString();

  db.prepare('VACUUM INTO ?').run(file);
  writeMeta(file, { note: cleanNote(note), created_at: createdAt, auto: auto ? '1' : '0' });
  if (auto) pruneAuto();

  const info = inspectArchive(file);
  return { id, note: info.note, createdAt, auto: Boolean(auto), imported: false, lessons: info.lessons, size: fs.statSync(file).size };
}

function setArchiveNote(id, note) {
  const file = archivePath(id);
  if (!fs.existsSync(file)) return { ok: false, code: 404, error: 'Архив не найден' };
  const clean = cleanNote(note);
  writeMeta(file, { note: clean });
  return { ok: true, id, note: clean };
}

function deleteArchive(id) {
  const file = archivePath(id);
  if (!fs.existsSync(file)) return { ok: false, code: 404, error: 'Архив не найден' };
  fs.rmSync(file, { force: true });
  return { ok: true, id };
}

/* ---------- Перенос между устройствами ---------- */

// Путь и имя файла для выгрузки. Имя — только латиница и цифры: так оно
// переживёт любую файловую систему и почтовый клиент.
function getArchiveFile(id) {
  const file = archivePath(id);
  if (!fs.existsSync(file)) return { ok: false, code: 404, error: 'Архив не найден' };
  return { ok: true, path: file, filename: `schedule-${id}.db` };
}

// Принять файл, привезённый с другого устройства. Содержимое проверяется до
// того, как файл станет версией: иначе в списке появился бы битый архив,
// переключение на который сломало бы рабочую базу.
function importArchive(buffer, { note = '' } = {}) {
  ensureDir();
  const id = nextId();
  const file = path.join(ARCHIVES_DIR, `${id}.db`);
  const temp = `${file}.part`;

  fs.writeFileSync(temp, buffer);
  const info = inspectArchive(temp);
  if (!info.ok) {
    fs.rmSync(temp, { force: true });
    return { ok: false, code: 400, error: info.error };
  }

  fs.renameSync(temp, file);
  // Загруженную версию никогда не считаем автоснимком, даже если она была им на
  // исходном устройстве: иначе автоочистка могла бы стереть привезённый файл.
  writeMeta(file, {
    note: cleanNote(note) || info.note || `Загружено ${humanId(id)}`,
    created_at: info.createdAt || new Date().toISOString(),
    auto: '0',
    imported: '1',
  });

  const saved = inspectArchive(file);
  return {
    ok: true,
    archive: {
      id,
      note: saved.note,
      createdAt: saved.createdAt,
      auto: false,
      imported: true,
      lessons: saved.lessons,
      size: fs.statSync(file).size,
    },
  };
}

/* ---------- Переключение на версию ---------- */

// Активные сессии переживают подмену файла базы — иначе переключение
// выбрасывало бы администратора из системы прямо посреди работы.
function readSessions() {
  try {
    return getDb().prepare('SELECT sid, data, expires FROM sessions').all();
  } catch {
    return [];
  }
}

function writeSessions(db, rows) {
  const ins = db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)');
  for (const row of rows) ins.run(row.sid, row.data, row.expires);
}

// Переключение на снимок: файл базы подменяется целиком, поэтому изменение
// атомарно — частично применённого состояния не бывает. Функция синхронная, так
// что параллельный запрос не может застать базу в момент подмены.
function restoreArchive(id) {
  const file = archivePath(id);
  if (!fs.existsSync(file)) return { ok: false, code: 404, error: 'Архив не найден' };

  const info = inspectArchive(file);
  if (!info.ok) return { ok: false, code: 400, error: `Версия непригодна: ${info.error}` };

  // Текущее состояние сохраняем автоснимком: само переключение тоже обратимо.
  const safety = createArchive({ note: `Перед переключением на версию от ${humanId(id)}`, auto: true });
  const sessions = readSessions();

  const tmp = `${DB_PATH}.restore-tmp`;
  const rollback = `${DB_PATH}.restore-original`;
  // Validate and migrate a disposable copy while the working database is open.
  let staged;
  try {
    fs.copyFileSync(file, tmp);
    staged = new DatabaseSync(tmp);
    initializeDatabase(staged);
    if (staged.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Нарушены связи в архиве');
    staged.exec(`DROP TABLE IF EXISTS ${META_TABLE}; DROP TABLE IF EXISTS publication_pending`);
    ensureSessionsTable(staged);
    staged.exec('DELETE FROM sessions');
    writeSessions(staged, sessions);
    staged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    if (staged) { staged.close(); staged = null; }
    fs.rmSync(tmp, { force: true });
    return { ok: false, code: 400, error: `Версия непригодна: ${err.message}` };
  } finally {
    if (staged) staged.close();
  }
  let moved = false;
  try {
    closeDb();
    fs.renameSync(DB_PATH, rollback);
    moved = true;
    fs.renameSync(tmp, DB_PATH);
    const db = reopenDb();
    const lessons = db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
    require('../config/accessDatabase').bumpScheduleGeneration();
    fs.rmSync(rollback, { force: true });
    return { ok: true, id, safetyId: safety.id, lessons };
  } catch (err) {
    closeDb();
    if (moved) {
      fs.rmSync(`${DB_PATH}-wal`, { force: true });
      fs.rmSync(`${DB_PATH}-shm`, { force: true });
      fs.renameSync(rollback, DB_PATH);
    }
    reopenDb();
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = {
  isValidArchiveId,
  listArchives,
  createArchive,
  setArchiveNote,
  deleteArchive,
  getArchiveFile,
  importArchive,
  restoreArchive,
};
