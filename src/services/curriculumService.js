'use strict';

// Учебные планы: хранение разобранного плана и маппинга «дисциплина→аббревиатура»
// (JSON-блобами в settings, как courses/semester), плюс сверка расписания группы
// с планом за соответствующий семестр.

const { getDb } = require('../config/database');
const { getSetting, setSetting, getCourses, getSemester } = require('./settingsService');
const { loadLessons } = require('./conflictService');

const HOURS_PER_PAIR = 2; // 1 пара = 2 ак. часа (см. lessons/2026-06-27-pairs-to-hours)

// ── Хранение ──────────────────────────────────────────────────────────────
const planKey = (kaf) => `curriculum:${kaf}`;
const mapKey = (kaf) => `curriculumMap:${kaf}`;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveCurriculum(kaf, plan, db = getDb()) {
  const data = { ...plan, kafedra: kaf, uploadedAt: new Date().toISOString() };
  setSetting(planKey(kaf), JSON.stringify(data), db);
  return data;
}

function getCurriculum(kaf, db = getDb()) {
  return parseJson(getSetting(planKey(kaf), db), null);
}

function getMapping(kaf, db = getDb()) {
  return parseJson(getSetting(mapKey(kaf), db), {});
}

function saveMapping(kaf, map, db = getDb()) {
  setSetting(mapKey(kaf), JSON.stringify(map || {}), db);
  return getMapping(kaf, db);
}

// Список загруженных кафедр с краткими метаданными (для верхнего списка на странице).
function listKafedras(db = getDb()) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'curriculum:%'").all();
  return rows.map((r) => {
    const p = parseJson(r.value, {}) || {};
    return {
      kafedra: r.key.slice('curriculum:'.length),
      fileName: p.fileName || '',
      uploadedAt: p.uploadedAt || '',
      disciplines: Array.isArray(p.disciplines) ? p.disciplines.length : 0,
    };
  });
}

// ── Классификация вида занятия (как assessmentKind в shared-constants) ──────
const normType = (t) => String(t || '').trim().replace(/[.\s]+$/, '').toLowerCase();
const isExam = (t) => /^(э|экз|экзамен)$/.test(normType(t));
const isZachet = (t) => /^(зач|зч|зо|з\/о|зачет|зачёт)$/.test(normType(t));
const isCoursework = (t) => /^(кр|кп)$/.test(normType(t));
const isSelfStudy = (t) => /^ср$/.test(normType(t));

// Нормализация названия для сопоставления по имени.
const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const tokenize = (s) => new Set(normName(s).split(/[^a-zа-я0-9]+/i).filter((w) => w.length > 2));

// Фаззи-подбор аббревиатуры по полному имени: доля совпавших значимых токенов
// имени плана среди токенов полного имени предмета. Точное совпадение даёт 1.0 и
// побеждает; сокращения (РЛС↔радиолокационных станций) ловятся частично (≥0.5).
// Возвращает аббревиатуру лучшего кандидата или null.
function fuzzyAbbr(name, candidates) {
  const want = tokenize(name);
  if (!want.size) return null;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    let hit = 0;
    for (const w of want) if (c.tokens.has(w)) hit++;
    const score = hit / want.size;
    if (score > bestScore) { bestScore = score; best = c.abbr; }
  }
  return bestScore >= 0.5 ? best : null;
}

// Кафедра из имени группы: 1-я цифра (факультет) + 3-я цифра (кафедра). 821-11 → "81".
function kafedraOfGroup(group) {
  const g = String(group || '');
  return g[0] && g[2] ? g[0] + g[2] : '';
}

// ── Чистая сверка (без БД, экспортируется для теста) ────────────────────────
// lessons — занятия группы (не parked, не event); plan — нормализованный план;
// mapping — { имя дисциплины → аббревиатура }; planSem — номер семестра 1..10.
function compareGroupToPlan({ lessons, plan, mapping = {}, planSem }) {
  // агрегируем расписание по аббревиатуре предмета
  const byAbbr = new Map();
  for (const l of lessons) {
    if (isSelfStudy(l.type)) continue; // СР — самоподготовка, не считаем
    const abbr = l.subject;
    if (!byAbbr.has(abbr)) {
      byAbbr.set(abbr, { abbr, full: l.subjectFull || abbr, teach: 0, exam: 0, zachet: 0, coursework: 0, types: new Set() });
    }
    const e = byAbbr.get(abbr);
    e.types.add(l.type);
    if (isExam(l.type)) e.exam++;
    else if (isZachet(l.type)) e.zachet++;
    else {
      // КР/КП — это аудиторные занятия: часы идут в практические (teach), как и
      // у обычных видов. Отдельный счётчик coursework оставлен для проверки
      // «нет курсового» — она смотрит только на наличие такого занятия.
      if (isCoursework(l.type)) e.coursework++;
      e.teach++;
    }
  }
  // кандидаты для авто-сопоставления (по полному имени предмета из расписания)
  const candidates = [...byAbbr.values()].map((e) => ({ abbr: e.abbr, tokens: tokenize(e.full) }));

  const idx = planSem - 1;
  const relevant = (d) => {
    const sem = d.perSemester && d.perSemester[idx];
    return (sem && sem.aud > 0)
      || d.exams.includes(planSem)
      || d.zachetsGraded.includes(planSem)
      || d.zachetsUngraded.includes(planSem)
      || (d.coursework && d.coursework.semester === planSem);
  };

  const rows = [];
  const matched = new Set();
  for (const d of plan.disciplines) {
    if (d.kind !== 'discipline') continue; // практики идут мероприятиями, вне v1
    if (!relevant(d)) continue;

    // Явная ручная привязка приоритетна (включая явное «нет» = null). Если записи
    // в маппинге нет — авто-подбор фаззи по имени.
    let abbr;
    let auto = false;
    if (Object.prototype.hasOwnProperty.call(mapping, d.name)) {
      abbr = mapping[d.name] || null;
    } else {
      abbr = fuzzyAbbr(d.name, candidates);
      if (abbr) auto = true;
    }
    const sch = abbr ? byAbbr.get(abbr) : null;
    if (sch) matched.add(sch.abbr);

    const planH = d.perSemester && d.perSemester[idx] ? d.perSemester[idx].aud : 0;
    const factH = sch ? sch.teach * HOURS_PER_PAIR : 0;
    const expExam = d.exams.includes(planSem);
    const expZachGraded = d.zachetsGraded.includes(planSem);
    const expZachUngraded = d.zachetsUngraded.includes(planSem);
    const expZach = expZachGraded || expZachUngraded;
    const expCourse = !!(d.coursework && d.coursework.semester === planSem);

    const issues = [];
    if (!abbr) issues.push('не сопоставлено');
    else if (!sch) issues.push('нет в расписании');
    else {
      if (planH && planH !== factH) issues.push(`часы ${planH}≠${factH}`);
      if (expExam && !sch.exam) issues.push('нет экзамена');
      if (expZach && !sch.zachet) issues.push('нет зачёта');
      if (expCourse && !sch.coursework) issues.push('нет курсового');
    }

    rows.push({
      name: d.name,
      index: d.index,
      abbr: abbr || null,
      planHours: planH,
      factHours: factH,
      expExam, expZach, expZachGraded, expZachUngraded, expCourse,
      hasExam: !!(sch && sch.exam),
      hasZachet: !!(sch && sch.zachet),
      hasCoursework: !!(sch && sch.coursework),
      auto,
      status: issues.length ? issues.join('; ') : 'OK',
      ok: issues.length === 0,
    });
  }

  // предметы в расписании, не попавшие ни в одну дисциплину плана этого семестра
  const extra = [];
  for (const [abbr, e] of byAbbr) {
    if (matched.has(abbr)) continue;
    extra.push({ abbr, full: e.full, factHours: e.teach * HOURS_PER_PAIR, types: [...e.types] });
  }

  return { planSem, rows, extra };
}

// ── Сверка по группе из живой БД ────────────────────────────────────────────
/**
 * Сводка по группам преподавателя ОДНИМ запросом: на каждую группу — часы по
 * дисциплинам (лекции/практика/зачёт) и строки сверки с учебным планом.
 *
 * Раньше интерфейс собирал это сам: по два запроса на каждую группу
 * (`/api/schedule` + `/api/curriculum/check`). У преподавателя с 22 группами
 * получалось 45 запросов, и КАЖДЫЙ заново читал все занятия из базы (~170 мс) —
 * открытие семестра занимало секунды. Здесь занятия читаются один раз.
 *
 * Часы считаются так же, как показывает таблица: лекция — вид «Л», всё
 * остальное (включая зачёты/экзамены) — практика; зачёт дополнительно копится
 * отдельно, потому что в столбце «Уч. план» он прибавляется к аудиторным часам.
 */
function teacherGroupsSummary(teacher, db = getDb()) {
  const name = String(teacher || '').trim();
  if (!name) return { error: 'Не указан преподаватель' };

  const all = loadLessons(db).filter((l) => !l.parked && !l.event);
  const mine = all.filter((l) => (l.teachers || []).includes(name) || l.teacher === name);
  const groups = [...new Set(mine.flatMap((l) => l.groups || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  return { teacher: name, groups: groupsSummary(groups, db, all) };
}

// То же для дисциплины: группы, у которых есть её занятия. Нужно виду
// «Дисциплина» — столбцы «Всего у группы» и «Уч. план» считают ВСЮ нагрузку
// группы, а не только пары этой дисциплины.
function subjectGroupsSummary(subject, db = getDb()) {
  const abbr = String(subject || '').trim();
  if (!abbr) return { error: 'Не указана дисциплина' };

  const all = loadLessons(db).filter((l) => !l.parked && !l.event);
  const groups = [...new Set(all.filter((l) => l.subject === abbr).flatMap((l) => l.groups || []))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
  return { subject: abbr, groups: groupsSummary(groups, db, all) };
}

// Та же сводка по ВСЕМ группам сразу — уходит в снимок публикации, чтобы
// гостевая страница показывала таблицу итогов преподавателя со сверкой плана
// и подвала, не имея доступа к API.
function allGroupsSummary(db = getDb()) {
  const all = loadLessons(db).filter((l) => !l.parked && !l.event);
  const groups = [...new Set(all.flatMap((l) => l.groups || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  return groupsSummary(groups, db, all);
}

// Ядро сводки: «дисциплина → часы группы» + сверка с планом для каждой группы.
// all — уже загруженные занятия (без parked/event), база больше не читается.
function groupsSummary(groups, db, all) {
  const byGroup = new Map();
  for (const l of all) {
    for (const g of (l.groups || [])) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(l);
    }
  }

  const isLecture = (t) => String(t || '').trim().toUpperCase() === 'Л';
  const out = {};
  for (const g of groups) {
    const gl = byGroup.get(g) || [];
    const subjects = {};
    for (const l of gl) {
      const s = l.subject;
      if (!s || s === 'СР') continue;
      const e = subjects[s] || (subjects[s] = { lecH: 0, pracH: 0, zachetH: 0 });
      if (isLecture(l.type)) e.lecH += HOURS_PER_PAIR;
      else e.pracH += HOURS_PER_PAIR;
      if (isZachet(l.type)) e.zachetH += HOURS_PER_PAIR;
    }
    // Сверка с планом — на тех же занятиях (второй раз базу не читаем).
    const check = runCheck(g, db, all);
    const plan = check.error ? null : Object.fromEntries((check.rows || [])
      .filter((r) => r.abbr).map((r) => [r.abbr, r]));
    out[g] = { subjects, plan };
  }
  return out;
}

// preloaded — уже загруженные занятия (см. teacherGroupsSummary): позволяет
// свериться с планом, не читая базу заново на каждую группу.
function runCheck(group, db = getDb(), preloaded = null) {
  if (!group) return { error: 'Не указана группа' };
  const kaf = kafedraOfGroup(group);
  const plan = getCurriculum(kaf, db);
  if (!plan) return { error: `Для кафедры ${kaf || '?'} не загружен учебный план` };

  const course = getCourses(db)[String(group).slice(0, 2)];
  if (!course) return { error: `Курс для группы ${group} не задан в настройках (Справочники → курсы)` };

  const semester = getSemester(db);
  const season = semester && semester.name;
  if (!season) return { error: 'Не выбран активный семестр (осень/весна)' };
  const planSem = season === 'весна' ? 2 * course : 2 * course - 1;

  const lessons = (preloaded || loadLessons(db)).filter((l) => !l.parked && !l.event && l.groups.includes(group));
  const mapping = getMapping(kaf, db);

  const result = compareGroupToPlan({ lessons, plan, mapping, planSem });
  return { group, kafedra: kaf, course, season, fileName: plan.fileName || '', ...result };
}

module.exports = {
  saveCurriculum,
  getCurriculum,
  getMapping,
  saveMapping,
  listKafedras,
  runCheck,
  teacherGroupsSummary,
  subjectGroupsSummary,
  allGroupsSummary,
  compareGroupToPlan,
  kafedraOfGroup,
};
