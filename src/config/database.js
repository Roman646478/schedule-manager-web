'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, EVENT_REASONS } = require('../utils/constants');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teachers (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS groups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  access_uid TEXT UNIQUE,
  headcount INTEGER,         -- число курсантов (заполняется вручную)
  dept      TEXT,            -- кафедра (заполняется вручную)
  hidden    INTEGER NOT NULL DEFAULT 0  -- 1 = скрыта из селектора просмотра
);

CREATE TABLE IF NOT EXISTS rooms (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  capacity INTEGER,          -- вместимость (заполняется вручную)
  kind     TEXT,             -- тип/оснащение (лаборатория, компьютерный класс…)
  dept     TEXT,             -- кафедра (заполняется вручную)
  hidden   INTEGER NOT NULL DEFAULT 0  -- 1 = скрыта из селектора просмотра
);

-- Настройки приложения (ключ-значение): семестр и пр.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Справочник дисциплин (из подвала файлов групп).
CREATE TABLE IF NOT EXISTS subjects (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  abbr      TEXT NOT NULL UNIQUE,   -- аббревиатура в сетке (РОРТ, УРЛС…)
  full_name TEXT,
  dept      TEXT
);

-- Кандидаты-преподаватели по дисциплине (для ручного выбора, если нет файла препода).
-- role: 'lecturer' (столбец «Лектор») | 'other' (столбец «Другие виды занятий»).
CREATE TABLE IF NOT EXISTS subject_teachers (
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  PRIMARY KEY (subject_id, teacher_id, role)
);

-- Единый источник данных: одно занятие = одна строка.
CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,    -- Пн, Вт…
  pair_no    INTEGER NOT NULL,    -- порядковый номер пары в дне (1..4)
  time_start TEXT,
  time_end   TEXT,
  week_no    INTEGER NOT NULL,    -- номер учебной недели (дата — из настройки семестра)
  subject    TEXT,
  type       TEXT,                -- Л, ПЗ, ЛР…
  topic      TEXT,                -- тема занятия (заполняется вручную)
  note       TEXT,                -- примечание (для потока — автотекст про совместные группы)
  parked     INTEGER NOT NULL DEFAULT 0, -- 1 = отложено в буфер (вне сетки)
  -- 1 = занятие не размещено при импорте: пара из файла преподавателя попала на
  -- метку «ЭкзС» группы, места в сетке для неё нет. Всегда вместе с parked = 1,
  -- поэтому вся логика «вне сетки» уже работает; флаг лишь отделяет такие
  -- занятия от обычного буфера (своя полоса под сеткой и своя очистка).
  orphan     INTEGER NOT NULL DEFAULT 0,
  locked     INTEGER NOT NULL DEFAULT 0, -- 1 = бронь: занятие нельзя перенести
  category   TEXT NOT NULL DEFAULT 'lesson', -- 'lesson' | 'event' (мероприятие: ОП, Экз, Отп… — не занятие)
  teacher_id INTEGER REFERENCES teachers(id),
  room_id    INTEGER REFERENCES rooms(id),
  -- Первая позиция занятия: та, с которой оно пришло из импорта (для созданных
  -- вручную — слот создания). Заполняется триггером и БОЛЬШЕ НЕ МЕНЯЕТСЯ, поэтому
  -- журнал переносов всегда показывает «изначально стояло → последний перенос».
  orig_day   TEXT,
  orig_pair  INTEGER,
  orig_week  INTEGER,
  revision   INTEGER NOT NULL DEFAULT 0
);

-- Связь занятие↔группы (many-to-many: потоковое занятие = несколько групп).
CREATE TABLE IF NOT EXISTS lesson_groups (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES groups(id),
  PRIMARY KEY (lesson_id, group_id)
);

-- Связь занятие↔аудитории (many-to-many: одно занятие может проходить в нескольких
-- аудиториях одновременно — напр. «430-7, 435-7»). Поле lessons.room_id сохраняется
-- как «основная» аудитория для обратной совместимости. При одной аудитории оба
-- поля совпадают; при нескольких — room_id = первая, lesson_rooms = все.
CREATE TABLE IF NOT EXISTS lesson_rooms (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  room_id   INTEGER NOT NULL REFERENCES rooms(id),
  PRIMARY KEY (lesson_id, room_id)
);

-- Связь занятие↔преподаватели (many-to-many: на зачётах/экзаменах их несколько).
-- Для обычных занятий обычно один (равен lessons.teacher_id — основному). Если
-- строк нет, действует основной teacher_id (legacy/импорт).
CREATE TABLE IF NOT EXISTS lesson_teachers (
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  PRIMARY KEY (lesson_id, teacher_id)
);

-- Занятия, у которых мог сбиться порядок тем: заполняется триггерами при любой
-- записи в lessons. Позволяет расставлять темы только в затронутых связках
-- «группа × дисциплина × вид», а не во всей базе (см. topicOrderService).
CREATE TABLE IF NOT EXISTS topic_dirty (
  lesson_id INTEGER PRIMARY KEY
);

CREATE INDEX IF NOT EXISTS idx_lessons_slot ON lessons(day, pair_no, week_no);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON lessons(teacher_id);
CREATE INDEX IF NOT EXISTS idx_lessons_room ON lessons(room_id);
CREATE INDEX IF NOT EXISTS idx_lesson_rooms_lesson ON lesson_rooms(lesson_id);

-- Журнал переносов занятий: одна строка = один выполненный перенос.
-- Хранит текстовый снимок данных на момент переноса (а не ссылки на id),
-- поэтому остаётся читаемым даже после переимпорта или смены семестра.
CREATE TABLE IF NOT EXISTS move_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id    INTEGER,           -- занятие (для свёртки повторных переносов в 1 запись)
  moved_at     TEXT NOT NULL,     -- дата и время переноса (ISO 8601)
  groups       TEXT,              -- группы занятия (через запятую)
  subject      TEXT,              -- дисциплина (аббревиатура)
  subject_full TEXT,              -- полное название дисциплины
  type         TEXT,              -- вид занятия (Л, ПЗ, ЛР…)
  topic        TEXT,              -- тема занятия
  from_date    TEXT,              -- исходная дата (дд.мм) на момент переноса
  from_day     TEXT,              -- исходный день недели
  from_pair    INTEGER,           -- исходная пара
  from_week    INTEGER,           -- исходная учебная неделя
  to_date      TEXT,              -- новая дата (дд.мм)
  to_day       TEXT,              -- новый день недели
  to_pair      INTEGER,           -- новая пара
  to_week      INTEGER,           -- новая учебная неделя
  room         TEXT,              -- аудитория после переноса (назначение)
  from_room    TEXT,              -- аудитория(и) до переноса (для вывода аудитории)
  teacher      TEXT,              -- преподаватель занятия на момент переноса
  note         TEXT,              -- примечание к записи (заполняется вручную)
  action       TEXT NOT NULL DEFAULT 'move',  -- 'move' | 'create' | 'delete'
  action_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_move_log_moved_at ON move_log(moved_at);

-- Адресные команды переноса. Каждая отменяется по собственному UUID.
CREATE TABLE IF NOT EXISTS move_actions (
  action_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  lesson_id INTEGER NOT NULL,
  description TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT,
  schedule_generation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','reverted')),
  reverted_at TEXT,
  reverted_by_user_id INTEGER,
  reverted_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_move_actions_created ON move_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_move_actions_actor ON move_actions(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS move_action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES move_actions(action_id),
  happened_at TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('move','revert'))
);

-- Стек отмены действий: хранит снимок состояния ДО каждого изменения.
-- Поддерживает: move, edit, create, delete. Хранится не более 50 последних действий.
CREATE TABLE IF NOT EXISTS undo_stack (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_at   TEXT NOT NULL,
  action      TEXT NOT NULL,   -- 'move' | 'edit' | 'create' | 'delete'
  description TEXT,            -- человеко-читаемое описание
  snapshot    TEXT NOT NULL    -- JSON-снимок состояния занятия ДО изменения
);
`;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const connection = new DatabaseSync(DB_PATH);
  try {
    initializeDatabase(connection);
    db = connection;
    return db;
  } catch (err) {
    connection.close();
    throw err;
  }
}

// Применяется и к временной копии архива ДО замены рабочей базы.
function initializeDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Ждать освободившийся замок, а не падать сразу. По умолчанию таймаут нулевой:
  // второй писатель (второй запущенный сервер, архивация, подмена файла базы)
  // получает SQLITE_BUSY мгновенно, и правка отваливается «внутренней ошибкой».
  // Записи здесь короткие — 5 с хватает, чтобы переждать чужую транзакцию.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get()) {
      migrate(db);
      db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    }
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get()) {
      migrateLessonRevision(db);
      db.prepare('INSERT INTO schema_migrations VALUES (2, ?)').run(new Date().toISOString());
    }
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get()) {
      migrateGroupAccessUid(db);
      db.prepare('INSERT INTO schema_migrations VALUES (3, ?)').run(new Date().toISOString());
    }
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get()) {
      migrateMoveActions(db);
      db.prepare('INSERT INTO schema_migrations VALUES (4, ?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('INSERT OR IGNORE INTO topic_dirty (lesson_id) SELECT id FROM lessons');
}

function migrateMoveActions(db) {
  const actionCols = db.prepare('PRAGMA table_info(move_actions)').all().map((c) => c.name);
  if (!actionCols.includes('schedule_generation')) db.exec('ALTER TABLE move_actions ADD COLUMN schedule_generation TEXT');
  const logCols = db.prepare('PRAGMA table_info(move_log)').all().map((c) => c.name);
  if (!logCols.includes('action_id')) db.exec('ALTER TABLE move_log ADD COLUMN action_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_move_log_action_id ON move_log(action_id)');
}

function migrateGroupAccessUid(db) {
  const cols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  if (!cols.includes('access_uid')) db.exec('ALTER TABLE groups ADD COLUMN access_uid TEXT');
  db.exec("UPDATE groups SET access_uid=lower(hex(randomblob(16))) WHERE access_uid IS NULL OR access_uid=''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_access_uid ON groups(access_uid)');
  db.exec(`CREATE TRIGGER IF NOT EXISTS groups_access_uid_insert AFTER INSERT ON groups
    WHEN NEW.access_uid IS NULL OR NEW.access_uid=''
    BEGIN UPDATE groups SET access_uid=lower(hex(randomblob(16))) WHERE id=NEW.id; END;`);
}

function migrateLessonRevision(db) {
  const cols = db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name);
  if (!cols.includes('revision')) db.exec('ALTER TABLE lessons ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  // Любое изменение содержимого/размещения делает открытую в другой вкладке
  // карточку устаревшей. revision намеренно не входит в список UPDATE OF,
  // поэтому внутренний UPDATE триггера не запускает сам себя.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lessons_revision_upd AFTER UPDATE OF
      day, pair_no, time_start, time_end, week_no, subject, type, topic, note,
      parked, orphan, locked, category, teacher_id, room_id ON lessons
    BEGIN
      UPDATE lessons SET revision = OLD.revision + 1 WHERE id = NEW.id;
    END;
  `);
}

// Лёгкие миграции для уже существующих БД (CREATE IF NOT EXISTS не добавляет колонки).
function migrate(db) {
  // Эти поля нужны заполнению orig_* ниже, в том числе у самых старых архивов.
  const moveCols = db.prepare('PRAGMA table_info(move_log)').all().map((c) => c.name);
  if (!moveCols.includes('lesson_id')) db.exec('ALTER TABLE move_log ADD COLUMN lesson_id INTEGER');
  const cols = db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name);
  if (!cols.includes('topic')) db.exec('ALTER TABLE lessons ADD COLUMN topic TEXT');
  if (!cols.includes('note')) db.exec('ALTER TABLE lessons ADD COLUMN note TEXT');
  if (!cols.includes('parked')) db.exec('ALTER TABLE lessons ADD COLUMN parked INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('orphan')) db.exec('ALTER TABLE lessons ADD COLUMN orphan INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('category')) db.exec("ALTER TABLE lessons ADD COLUMN category TEXT NOT NULL DEFAULT 'lesson'");
  // Бронь занятия: пока стоит, слот занятия менять нельзя (перенос, возврат из
  // журнала, смена дня/пары/недели в карточке). Правка полей и удаление — как обычно.
  if (!cols.includes('locked')) db.exec('ALTER TABLE lessons ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');

  // Исходная (импортная) позиция занятия — «откуда» в журнале переносов.
  {
    if (!cols.includes('orig_day')) db.exec('ALTER TABLE lessons ADD COLUMN orig_day TEXT');
    if (!cols.includes('orig_pair')) db.exec('ALTER TABLE lessons ADD COLUMN orig_pair INTEGER');
    if (!cols.includes('orig_week')) db.exec('ALTER TABLE lessons ADD COLUMN orig_week INTEGER');
    // У уже перенесённых занятий исходная позиция известна из журнала (первая
    // запись), у остальных исходная позиция — текущая.
    db.exec(`
      UPDATE lessons SET
        orig_day  = (SELECT m.from_day  FROM move_log m WHERE m.lesson_id = lessons.id ORDER BY m.id LIMIT 1),
        orig_pair = (SELECT m.from_pair FROM move_log m WHERE m.lesson_id = lessons.id ORDER BY m.id LIMIT 1),
        orig_week = (SELECT m.from_week FROM move_log m WHERE m.lesson_id = lessons.id ORDER BY m.id LIMIT 1)
       WHERE orig_day IS NULL AND EXISTS (SELECT 1 FROM move_log m WHERE m.lesson_id = lessons.id AND m.from_day IS NOT NULL)
    `);
    db.exec('UPDATE lessons SET orig_day = day, orig_pair = pair_no, orig_week = week_no WHERE orig_day IS NULL');
  }
  // Заполняет исходную позицию за все пути вставки занятия (импорт, ручное
  // создание, расстановка СР, отмена удаления) — вместо правки семи INSERT-ов.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lessons_orig_slot AFTER INSERT ON lessons
    WHEN NEW.orig_day IS NULL
    BEGIN
      UPDATE lessons SET orig_day = NEW.day, orig_pair = NEW.pair_no, orig_week = NEW.week_no
       WHERE id = NEW.id;
    END;
  `);

  // Пометки «пересчитать порядок тем». Триггер на UPDATE срабатывает только на
  // полях, от которых порядок зависит: смена аудитории или преподавателя темы
  // не двигает, а таких правок бывает много (подбор аудиторий).
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_dirty (lesson_id INTEGER PRIMARY KEY);

    CREATE TRIGGER IF NOT EXISTS topic_dirty_ins AFTER INSERT ON lessons
    BEGIN
      INSERT OR IGNORE INTO topic_dirty (lesson_id) VALUES (NEW.id);
    END;

    CREATE TRIGGER IF NOT EXISTS topic_dirty_upd AFTER UPDATE ON lessons
    WHEN NEW.topic IS NOT OLD.topic OR NEW.subject IS NOT OLD.subject
      OR NEW.type IS NOT OLD.type OR NEW.parked IS NOT OLD.parked
      OR NEW.day IS NOT OLD.day OR NEW.pair_no IS NOT OLD.pair_no
      OR NEW.week_no IS NOT OLD.week_no OR NEW.category IS NOT OLD.category
    BEGIN
      INSERT OR IGNORE INTO topic_dirty (lesson_id) VALUES (NEW.id);
    END;

    CREATE TRIGGER IF NOT EXISTS topic_dirty_del AFTER DELETE ON lessons
    BEGIN
      DELETE FROM topic_dirty WHERE lesson_id = OLD.id;
    END;

    -- Состав групп занятия меняет связку, в которую оно входит.
    CREATE TRIGGER IF NOT EXISTS topic_dirty_groups AFTER INSERT ON lesson_groups
    BEGIN
      INSERT OR IGNORE INTO topic_dirty (lesson_id) VALUES (NEW.lesson_id);
    END;
  `);
  // База могла прийти со стороны — откат к архиву, подмена файла schedule.db,
  // правка чужим инструментом: триггеры при этом не срабатывали, и пометок нет.
  // Поэтому при КАЖДОМ открытии базы помечаем всё: ближайшая расстановка тем
  // пройдёт по всей базе, а не по пустому списку.
  db.exec('INSERT OR IGNORE INTO topic_dirty (lesson_id) SELECT id FROM lessons');

  // Кафедра преподавателя: в виде «Преподаватели» она считается по дисциплинам,
  // а в столбце хранится только ручное переопределение.
  const tcols = db.prepare('PRAGMA table_info(teachers)').all().map((c) => c.name);
  if (!tcols.includes('dept')) db.exec('ALTER TABLE teachers ADD COLUMN dept TEXT');

  // Флаг скрытия группы/аудитории из селектора просмотра (занятия не трогаются).
  const gcols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  if (!gcols.includes('hidden')) db.exec('ALTER TABLE groups ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  const rcols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (!rcols.includes('hidden')) db.exec('ALTER TABLE rooms ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');

  // Таблица связи занятие↔аудитории (many-to-many, добавлена позже lesson_groups).
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_rooms (
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      room_id   INTEGER NOT NULL REFERENCES rooms(id),
      PRIMARY KEY (lesson_id, room_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lesson_rooms_lesson ON lesson_rooms(lesson_id);
  `);
  // Наполнить lesson_rooms из существующих lessons.room_id (однократно, только если пусто).
  const lrCount = db.prepare('SELECT COUNT(*) AS n FROM lesson_rooms').get();
  if (lrCount.n === 0) {
    db.exec(
      'INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) SELECT id, room_id FROM lessons WHERE room_id IS NOT NULL'
    );
  }

  // Преподаватель и пользовательское примечание в журнале переносов.
  const mlcols = db.prepare('PRAGMA table_info(move_log)').all().map((c) => c.name);
  if (!mlcols.includes('teacher')) db.exec('ALTER TABLE move_log ADD COLUMN teacher TEXT');
  if (!mlcols.includes('note')) db.exec('ALTER TABLE move_log ADD COLUMN note TEXT');
  // Привязка записи к занятию — чтобы повторные переносы одного занятия сворачивались
  // в одну запись (первый источник + последняя точка назначения).
  if (!mlcols.includes('lesson_id')) db.exec('ALTER TABLE move_log ADD COLUMN lesson_id INTEGER');
  // Цепочка занятия (перенос, откат по цепочке, ↩) ищется по lesson_id на каждом
  // переносе — без индекса это перебор всего журнала. Здесь, а не в SCHEMA: у
  // старой базы столбец появляется только строкой выше.
  db.exec('CREATE INDEX IF NOT EXISTS idx_move_log_lesson ON move_log(lesson_id)');
  // Аудитория ДО переноса (для записи «вывода аудитории»: from_room → room).
  if (!mlcols.includes('from_room')) db.exec('ALTER TABLE move_log ADD COLUMN from_room TEXT');
  // Вид записи журнала: 'move' — перенос, 'create' — занятие добавлено (в т.ч.
  // вставкой копии), 'delete' — удалено. Старые записи — переносы.
  if (!mlcols.includes('action')) {
    db.exec("ALTER TABLE move_log ADD COLUMN action TEXT NOT NULL DEFAULT 'move'");
  }

  // Кафедра у групп и аудиторий (заполняется вручную в справочниках).
  if (!gcols.includes('dept')) db.exec('ALTER TABLE groups ADD COLUMN dept TEXT');
  if (!rcols.includes('dept')) db.exec('ALTER TABLE rooms ADD COLUMN dept TEXT');

  // Аудитория только для одного курса (course_only: номер курса 1..5 или NULL —
  // без ограничения). При авто-расстановке СР такую аудиторию занимают лишь группы
  // указанного курса.
  if (!rcols.includes('course_only')) db.exec('ALTER TABLE rooms ADD COLUMN course_only INTEGER');

  // Примечание к аудитории (компьютерный класс, лаборатория, «только 1 курс»…).
  // Показывается везде, где выбирают аудиторию.
  if (!rcols.includes('note')) db.exec('ALTER TABLE rooms ADD COLUMN note TEXT');

  // Зачёт до этой правки импортировался как «ЗЧ» с темой «ЗЧ»/«ЗАЧЕТ». В сетке это
  // та же форма контроля, что «ЗО» без темы (см. GRADED_CREDIT_RE в парсере) —
  // приводим уже импортированные занятия к одному виду. Идемпотентно.
  db.exec(`
    UPDATE lessons SET type = 'ЗО', topic = NULL
     WHERE type IN ('ЗЧ', 'зч', 'ЗЧ.', 'ЗАЧЕТ', 'ЗАЧЁТ')
        OR (type = 'ЗО' AND topic IN ('ЗЧ', 'ЗО', 'ЗАЧЕТ', 'ЗАЧЁТ'))
  `);

  // Практическое занятие: в файлах его пишут «П», в учебных планах и справочниках —
  // «ПЗ» (см. PRACTICE_RE в парсере). Приводим уже импортированные занятия к «ПЗ»,
  // тема сохраняется. Идемпотентно.
  db.exec("UPDATE lessons SET type = 'ПЗ' WHERE type IN ('П', 'п', 'П.', 'п.', 'пз')");

  // Легенда видов занятий из подвала (settings.typeLegend): ключ «п» → «ПЗ».
  migratePracticeLegend(db);

  // То же для колонки «Отчет» в таблице дисциплин (settings.groupSubjects) —
  // она приходит из подвала файла и попадает в Excel-выгрузку группы.
  migrateSubjectReports(db);

  // Глобальные дисциплины-мероприятия (ДП, ОП, Отп, Стаж…) — доступны всем группам
  // в списке дисциплин. Добавляются один раз; существующие (из импорта) не трогаем.
  const insSubj = db.prepare('INSERT OR IGNORE INTO subjects (abbr, full_name) VALUES (?, ?)');
  for (const r of (EVENT_REASONS || [])) insSubj.run(r.code, r.name || null);
}

// Легенда видов занятий: код практического занятия «п»/«П» → «ПЗ», чтобы подвал
// совпадал с кодом в сетке. Порядок ключей сохраняется (Object.entries).
function migratePracticeLegend(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'typeLegend'").get();
  if (!row || !row.value) return;
  let map;
  try {
    map = JSON.parse(row.value);
  } catch {
    return; // повреждённую настройку не трогаем
  }
  const key = Object.keys(map || {}).find((k) => /^п\.?$/i.test(k));
  if (!key) return;
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k === key ? 'ПЗ' : k] = v;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'typeLegend'").run(JSON.stringify(out));
}

// Зачёт в колонке «Отчет» справочника дисциплин: «ЗЧ»/«ЗАЧЕТ» → «ЗО». Данные
// лежат JSON-строкой в settings, поэтому сначала дешёвая проверка по подстроке —
// без неё разбор/запись шли бы при каждом открытии базы.
const CREDIT_REPORTS = new Set(['ЗЧ', 'зч', 'ЗАЧЕТ', 'ЗАЧЁТ', 'Зач', 'зач']);
function migrateSubjectReports(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'groupSubjects'").get();
  if (!row || !row.value || ![...CREDIT_REPORTS].some((v) => row.value.includes(`"${v}"`))) return;
  let map;
  try {
    map = JSON.parse(row.value);
  } catch {
    return; // повреждённую настройку не трогаем
  }
  let changed = 0;
  for (const list of Object.values(map || {})) {
    for (const s of list || []) {
      if (s && CREDIT_REPORTS.has(String(s.report || '').trim())) {
        s.report = 'ЗО';
        changed++;
      }
    }
  }
  if (changed) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'groupSubjects'").run(JSON.stringify(map));
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  // Служебная БД живёт рядом с расписанием. Закрываем обе, чтобы резервное
  // восстановление и тестовые каталоги не оставались заблокированными Windows.
  try { require('./accessDatabase').closeAccessDb(); } catch { /* ещё не открыта */ }
}

// Переоткрыть базу — нужно после подмены файла schedule.db (откат к архиву).
// Все сервисы берут соединение через getDb() в момент вызова, поэтому после
// переоткрытия они автоматически работают с новым файлом.
function reopenDb() {
  closeDb();
  return getDb();
}

module.exports = { getDb, closeDb, reopenDb, initializeDatabase };
