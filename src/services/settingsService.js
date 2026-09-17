'use strict';

const { getDb } = require('../config/database');

function getSetting(key, db = getDb()) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value, db = getDb()) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Семестр: { name: 'осень'|'весна', start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }.
// Активный (текущий) семестр хранится в ключе 'semester'. Сохранённые семестры
// (память) — списком в ключе 'semesters'. Натуральный ключ записи — semId().
function getSemester(db = getDb()) {
  const raw = getSetting('semester', db);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setSemester(semester, db = getDb()) {
  setSetting('semester', JSON.stringify(semester), db);
}

// Стабильный идентификатор семестра — по названию и датам.
function semId(s) {
  return s ? `${s.name || ''}|${s.start || ''}|${s.end || ''}` : null;
}

// Список сохранённых семестров. Миграция: если списка ещё нет, но есть активный
// семестр старого формата — заводим список из него.
function getSemesters(db = getDb()) {
  const raw = getSetting('semesters', db);
  let list = [];
  if (raw) {
    try {
      list = JSON.parse(raw) || [];
    } catch {
      list = [];
    }
  }
  if (!list.length) {
    const active = getSemester(db);
    if (active && active.start) {
      list = [{ id: semId(active), name: active.name || null, start: active.start, end: active.end }];
      setSetting('semesters', JSON.stringify(list), db);
    }
  }
  return list;
}

// Сохранить семестр в память и сделать его активным. Повторное сохранение того
// же (по semId) обновляет запись, а не плодит дубли.
function saveSemester(semester, db = getDb()) {
  const entry = { id: semId(semester), name: semester.name || null, start: semester.start, end: semester.end };
  const list = getSemesters(db).filter((s) => s.id !== entry.id);
  list.push(entry);
  list.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  setSetting('semesters', JSON.stringify(list), db);
  setSemester(entry, db);
  return entry;
}

// Сделать сохранённый семестр активным (по id).
function selectSemester(id, db = getDb()) {
  const entry = getSemesters(db).find((s) => s.id === id);
  if (!entry) return { ok: false, reasons: ['Семестр не найден'] };
  setSemester(entry, db);
  return { ok: true, semester: entry };
}

// Удалить семестр из памяти. Если удаляли активный — активный сбрасывается.
function deleteSemester(id, db = getDb()) {
  const list = getSemesters(db);
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reasons: ['Семестр не найден'] };
  setSetting('semesters', JSON.stringify(next), db);
  const active = getSemester(db);
  if (active && semId(active) === id) setSetting('semester', JSON.stringify(null), db);
  return { ok: true };
}

// Курсы: { "<префикс группы, 2 символа>": <номер курса 1..5> }.
function getCourses(db = getDb()) {
  const raw = getSetting('courses', db);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setCourses(courses, db = getDb()) {
  setSetting('courses', JSON.stringify(courses || {}), db);
}

// Легенда видов занятий: { "<код>": "<полное название>" } (из подвала файлов).
function getTypeLegend(db = getDb()) {
  const raw = getSetting('typeLegend', db);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setTypeLegend(legend, db = getDb()) {
  setSetting('typeLegend', JSON.stringify(legend || {}), db);
}

// Таблица дисциплин с преподавателями ПО ГРУППАМ, как в подвале HTML-файла:
// { "<группа>": [ { abbr, fullName, teachers[] } ] }. Заполняется при импорте.
function getGroupSubjects(db = getDb()) {
  const raw = getSetting('groupSubjects', db);
  if (!raw) return {};
  try {
    const map = JSON.parse(raw) || {};
    // Подвал показываем по алфавиту (обозначение дисциплины): порядок строк из
    // файла не значим, а дописанные вручную иначе валятся в конец списка.
    // Правка и удаление строк ходят по индексу — но тоже через эту функцию,
    // поэтому индексы считаются от того же порядка, что видит составитель.
    const abbr = (s) => String((s && s.abbr) || '');
    for (const list of Object.values(map)) {
      if (Array.isArray(list)) list.sort((a, b) => abbr(a).localeCompare(abbr(b), 'ru'));
    }
    return map;
  } catch {
    return {};
  }
}

function setGroupSubjects(map, db = getDb()) {
  setSetting('groupSubjects', JSON.stringify(map || {}), db);
}

// Замены сокращений дисциплин, применяемые ПРИ ИМПОРТЕ до сборки расписания:
// { "<сокращение в файле>": "<на что заменить>" }, напр. { "ИЭП": "ИРТС" }.
function getSubjectAliases(db = getDb()) {
  const raw = getSetting('subjectAliases', db);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setSubjectAliases(map, db = getDb()) {
  setSetting('subjectAliases', JSON.stringify(map || {}), db);
}

// Перечень видов мероприятий: [{code, name}]. Defaults to EVENT_REASONS from constants.
function getEventTypes(db = getDb()) {
  const raw = getSetting('eventTypes', db);
  if (raw == null) {
    const { EVENT_REASONS } = require('../utils/constants');
    return (EVENT_REASONS || []).map(({ code, name }) => ({ code, name: name || '' }));
  }
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function setEventTypes(list, db = getDb()) {
  const clean = (list || [])
    .map(({ code, name }) => ({ code: String(code || '').trim(), name: String(name || '').trim() }))
    .filter(({ code }) => code);
  setSetting('eventTypes', JSON.stringify(clean), db);
  // Sync new codes into subjects table so they appear in the discipline dropdown.
  const ins = db.prepare('INSERT OR IGNORE INTO subjects (abbr, full_name) VALUES (?, ?)');
  for (const { code, name } of clean) ins.run(code, name || null);
}

// Перечень ВИДОВ УЧЕБНЫХ ЗАНЯТИЙ: [{code, name}]. По умолчанию — LESSON_TYPES.
// В отличие от мероприятий, в таблицу subjects коды не добавляются: вид занятия
// это не дисциплина.
function getLessonTypes(db = getDb()) {
  const raw = getSetting('lessonTypes', db);
  if (raw == null) {
    const { LESSON_TYPES } = require('../utils/constants');
    return (LESSON_TYPES || []).map(({ code, name }) => ({ code, name: name || '' }));
  }
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function setLessonTypes(list, db = getDb()) {
  const clean = [];
  for (const item of list || []) {
    const code = String((item && item.code) || '').trim();
    if (!code || clean.some((x) => x.code === code)) continue; // пустые и дубли кодов не храним
    clean.push({ code, name: String((item && item.name) || '').trim() });
  }
  setSetting('lessonTypes', JSON.stringify(clean), db);
}

// Список нерабочих дней (праздники, каникулы) — массив ISO-строк ГГГГ-ММ-ДД.
function getHolidays(db = getDb()) {
  const raw = getSetting('holidays', db);
  if (!raw) return [];
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function setHolidays(list, db = getDb()) {
  setSetting('holidays', JSON.stringify(list || []), db);
}

// Примечания к датам: [{ date: 'ГГГГ-ММ-ДД', text: '…', groups: ['861-11', …] }].
// Пустой groups = примечание для всех групп. Хранятся в settings — данных мало,
// отдельная таблица не нужна.
// ponytail: список пишется целиком (как holidays); понадобится многопользовательская
// правка — перейти на upsert по id.
function getDateNotes(db = getDb()) {
  const raw = getSetting('dateNotes', db);
  if (!raw) return [];
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function setDateNotes(list, db = getDb()) {
  setSetting('dateNotes', JSON.stringify(list || []), db);
}

// Оформление сетки: { colors: { '--grid-line-free': '#16a34a', … }, sizes: { … } }.
// Хранится на сервере, чтобы вид расписания был одинаковым на всех рабочих местах.
// Значения — обычные CSS-переменные, интерфейс просто ставит их на :root.
function getAppearance(db = getDb()) {
  const raw = getSetting('appearance', db);
  if (!raw) return { colors: {}, sizes: {} };
  try {
    const v = JSON.parse(raw) || {};
    return { colors: v.colors || {}, sizes: v.sizes || {} };
  } catch {
    return { colors: {}, sizes: {} };
  }
}

function setAppearance(value, db = getDb()) {
  const v = value || {};
  setSetting('appearance', JSON.stringify({ colors: v.colors || {}, sizes: v.sizes || {} }), db);
}

// ── Настройки подбора аудиторий (settings.roomPlan) ──────────────────────────
// Порядок в rules — это и есть приоритет правил: подбор сравнивает предложения
// по вектору «плохости» лексикографически, поэтому младшее правило не может
// испортить старшее. Всё, что раньше было зашито в код (число «информатика»,
// допуски, список неприкосновенных помещений), живёт здесь.
const ROOM_PLAN_RULES = ['ctrl', 'cc', 'teacherGroup', 'teacherAny', 'dept', 'capacity'];

const rpList = (v) => [...new Set((Array.isArray(v) ? v : [])
  .map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
const rpNum = (v, def, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// Нормализация одна на чтение и на запись: в БД кладём уже чистое значение,
// а незаданные ключи всегда получают дефолт (в т.ч. у старых записей).
function normalizeRoomPlan(saved) {
  const src = saved && typeof saved === 'object' ? saved : {};
  const rules = [];
  for (const r of Array.isArray(src.rules) ? src.rules : []) {
    const id = String((r && r.id) || '');
    if (!ROOM_PLAN_RULES.includes(id) || rules.some((x) => x.id === id)) continue;
    rules.push({ id, on: r.on !== false });
  }
  // Правило, которого в сохранённом порядке нет (например, добавленное позже),
  // дописывается в конец — приоритет, выставленный человеком, не теряется.
  for (const id of ROOM_PLAN_RULES) if (!rules.some((x) => x.id === id)) rules.push({ id, on: true });
  const pairs = Array.isArray(src.blockPairs) ? src.blockPairs : [1, 2, 3];
  return {
    rules,
    ccSkipSubjects: rpList(src.ccSkipSubjects),
    // Сверка идёт вхождением, поэтому по умолчанию — корень слова: он ловит
    // и «Инф», и «Основы информатики».
    ccNeedSubjects: src.ccNeedSubjects === undefined ? ['информатик'] : rpList(src.ccNeedSubjects),
    maxExtra: rpNum(src.maxExtra, 15, 0, 500),
    // Мелкая подгонка мест перестановки не стоит: аудиторию на 42 места под
    // группу в 40 менять на 40-местную незачем. Порог — на РАЗНИЦУ МЕСТ.
    minCapacityGain: rpNum(src.minCapacityGain, 10, 0, 500),
    overWeight: rpNum(src.overWeight, 10, 1, 100),
    blockPairs: [...new Set(pairs.map(Number).filter((p) => p >= 1 && p <= 4))].sort((a, b) => a - b),
    skipRooms: rpList(src.skipRooms),
    skipSubjects: rpList(src.skipSubjects),
    skipLocked: src.skipLocked !== false,
  };
}

function getRoomPlanSettings(db = getDb()) {
  const raw = getSetting('roomPlan', db);
  let saved = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  return normalizeRoomPlan(saved);
}

function setRoomPlanSettings(value, db = getDb()) {
  const clean = normalizeRoomPlan(value);
  setSetting('roomPlan', JSON.stringify(clean), db);
  return clean;
}

module.exports = {
  getSetting,
  setSetting,
  getAppearance,
  setAppearance,
  getSemester,
  setSemester,
  getSemesters,
  saveSemester,
  selectSemester,
  deleteSemester,
  getCourses,
  setCourses,
  getTypeLegend,
  setTypeLegend,
  getGroupSubjects,
  setGroupSubjects,
  getSubjectAliases,
  setSubjectAliases,
  getLessonTypes,
  setLessonTypes,
  ROOM_PLAN_RULES,
  getRoomPlanSettings,
  setRoomPlanSettings,
  getHolidays,
  setHolidays,
  getDateNotes,
  setDateNotes,
  getEventTypes,
  setEventTypes,
};
