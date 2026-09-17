'use strict';

const path = require('path');
const { getDb } = require('../config/database');
const { findOverlaps, checkCapacity, checkReferences, validateMove, findAliasCandidates } = require('../utils/validators');
const { getSemester, getTypeLegend, getHolidays, getCourses } = require('./settingsService');
const { lessonDate, lessonDateISO } = require('../utils/calendar');
const { expandType } = require('../utils/lessonTypes');
// Классификатор формы контроля (экзамен/зачёт) — общий с фронтендом.
const { assessmentKind } = require(path.join(__dirname, '..', '..', 'public', 'js', 'shared-constants.js'));

// Кэш разбора занятий. Сбор всех 6000+ занятий стоит ~100 мс, а зовётся он по
// нескольку раз за запрос (проверка + представление + журнал), поэтому держим
// последний результат до ближайшей записи в БД. Сторож — total_changes():
// счётчик изменённых строк соединения (растёт и от триггеров, и при откате
// транзакции — лишний промах безопаснее устаревших данных).
// ponytail: объекты занятий отдаются из кэша как есть (копия массива, но не
// самих занятий: скопировать 6000 объектов — те же 40 мс). Значит их поля
// менять на месте нельзя; сейчас никто и не меняет, кроме добавочного
// isoDate в getSessionCalendar (пересчитывается из тех же данных).
let cache = null; // { db, changesStmt, changes, rows }

// Причина отказа при попытке перенести забронированное занятие — одна на все
// пути переноса (перетаскивание, карточка, журнал, календарь сессии).
const LOCKED_REASON = 'Занятие забронировано: снимите бронь в карточке занятия, чтобы перенести';

function loadLessons(db = getDb()) {
  if (!cache || cache.db !== db) cache = { db, changesStmt: db.prepare('SELECT total_changes() AS c'), changes: -1, rows: null };
  const changes = cache.changesStmt.get().c;
  if (cache.changes !== changes || !cache.rows) {
    cache.rows = buildLessons(db);
    cache.changes = changes;
  }
  return cache.rows.slice();
}

// Сбор занятий из БД в форму, понятную валидаторам (utils/validators.js).
// Дата вычисляется ИСКЛЮЧИТЕЛЬНО из настройки семестра по (неделя, день).
function buildLessons(db) {
  const rows = db
    .prepare(
      `SELECT l.id, l.day, l.pair_no AS pairNo, l.week_no AS weekNo, l.subject, l.type,
              l.topic, l.note, l.parked, l.orphan, l.locked, l.category, l.revision, s.full_name AS subjectFull,
              t.name AS teacher, r.name AS room
         FROM lessons l
         LEFT JOIN teachers t ON t.id = l.teacher_id
         LEFT JOIN rooms r ON r.id = l.room_id
         LEFT JOIN subjects s ON s.abbr = l.subject`
    )
    .all();

  const groupsByLesson = new Map();
  for (const r of db
    .prepare('SELECT lg.lesson_id AS id, g.name AS name FROM lesson_groups lg JOIN groups g ON g.id = lg.group_id')
    .all()) {
    if (!groupsByLesson.has(r.id)) groupsByLesson.set(r.id, []);
    groupsByLesson.get(r.id).push(r.name);
  }

  // Преподаватели занятия (для зачётов/экзаменов их может быть несколько).
  const teachersByLesson = new Map();
  for (const r of db
    .prepare('SELECT lt.lesson_id AS id, t.name AS name FROM lesson_teachers lt JOIN teachers t ON t.id = lt.teacher_id')
    .all()) {
    if (!teachersByLesson.has(r.id)) teachersByLesson.set(r.id, []);
    teachersByLesson.get(r.id).push(r.name);
  }

  // Все аудитории занятия (1 или 2) — из lesson_rooms (many-to-many).
  const roomsByLesson = new Map();
  for (const r of db
    .prepare('SELECT lr.lesson_id AS id, rm.name AS name FROM lesson_rooms lr JOIN rooms rm ON rm.id = lr.room_id')
    .all()) {
    if (!roomsByLesson.has(r.id)) roomsByLesson.set(r.id, []);
    roomsByLesson.get(r.id).push(r.name);
  }

  const semester = getSemester(db);
  const legend = getTypeLegend(db);
  // Дата и расшифровка вида повторяются тысячами раз при считанных десятках
  // разных значений — считаем каждое один раз (loadLessons в каждом запросе).
  const dateCache = new Map();
  const typeCache = new Map();
  for (const l of rows) {
    l.groups = groupsByLesson.get(l.id) || [];
    // Полный список преподавателей; если связей нет — основной (teacher_id).
    l.teachers = teachersByLesson.get(l.id) || (l.teacher ? [l.teacher] : []);
    // Аудитории: из lesson_rooms; основная (room_id) — первой. Если связей нет
    // (legacy), действует одиночная room из room_id.
    const lr = roomsByLesson.get(l.id);
    if (lr && lr.length) {
      // room (room_id) ставим первой, остальные следом — стабильный порядок.
      l.rooms = l.room ? [l.room, ...lr.filter((n) => n !== l.room)] : lr;
    } else {
      l.rooms = l.room ? [l.room] : [];
    }
    l.room = l.rooms[0] || null; // основная аудитория (для обратной совместимости)
    l.room2 = l.rooms[1] || null; // вторая аудитория (если есть)
    const dk = `${l.weekNo}|${l.day}`;
    if (!dateCache.has(dk)) dateCache.set(dk, lessonDate(l.weekNo, l.day, semester));
    l.date = dateCache.get(dk);
    const tk = l.type || '';
    if (!typeCache.has(tk)) typeCache.set(tk, expandType(l.type, legend));
    l.typeFull = typeCache.get(tk); // полное название вида занятия
    l.parked = !!l.parked; // отложено в буфер
    l.orphan = !!l.orphan; // не размещено при импорте (попало на ЭкзС группы)
    l.locked = !!l.locked; // бронь: перенос запрещён
    l.category = l.category || 'lesson';
    l.event = l.category === 'event'; // мероприятие (не занятие): вне проверок накладок
  }
  return hideCoveredEcs(rows);
}

// Метка «ЭкзС» (экзаменационная сессия) — это не занятие, а пометка «в это время
// сессия». Занятие можно поставить прямо в такую ячейку: метка при этом уходит,
// а если занятие убрать — возвращается сама собой.
const isEcs = (l) => l.event && String(l.subject || '').trim().toLowerCase() === 'экзс';

// Убирает из выдачи метки ЭкзС, «перекрытые» настоящим занятием той же группы в
// том же слоте. Саму запись не трогаем: занятие уберут — метка вернётся сама,
// поэтому никакого учёта «что удалили и что восстановить» не нужно.
//
// Проход по всем занятиям здесь горячий (loadLessons зовётся в каждом запросе),
// поэтому сначала собираем слоты САМИХ меток (их единицы-сотни) и только для
// этих слотов сверяем группы: у остальных занятий дело ограничивается сравнением
// числа. Ключ слота — число, а не строка: строк на 6000 занятий заметно дороже.
function hideCoveredEcs(rows) {
  const marks = rows.filter((l) => isEcs(l) && !l.parked);
  if (!marks.length) return rows;
  const slotNo = (l) => l.weekNo * 1000 + DAY_NO(l.day) * 10 + l.pairNo;
  const wanted = new Map(); // слот метки → группы, которые в нём отмечены
  for (const m of marks) {
    const k = slotNo(m);
    if (!wanted.has(k)) wanted.set(k, new Set());
    for (const g of (m.groups || [])) wanted.get(k).add(g);
  }
  const covered = new Set(); // «слот|группа» настоящих занятий в слотах меток
  for (const l of rows) {
    if (l.event || l.parked) continue;
    const set = wanted.get(slotNo(l));
    if (!set) continue;
    for (const g of (l.groups || [])) if (set.has(g)) covered.add(`${slotNo(l)}|${g}`);
  }
  if (!covered.size) return rows;
  // Метка одна на несколько групп: скрываем её только у перекрытых групп,
  // остальным она остаётся. Полный список групп кладём в groupsAll — снимки
  // undo берут его, иначе восстановление обрезало бы метке группы.
  const out = [];
  for (const l of rows) {
    if (!isEcs(l) || l.parked) { out.push(l); continue; }
    const keep = (l.groups || []).filter((g) => !covered.has(`${slotNo(l)}|${g}`));
    if (!keep.length) continue; // перекрыта у всех групп — метки не видно
    if (keep.length !== l.groups.length) { l.groupsAll = l.groups; l.groups = keep; }
    out.push(l);
  }
  return out;
}

const DAY_INDEX = { Пн: 1, Вт: 2, Ср: 3, Чт: 4, Пт: 5, Сб: 6, Вс: 7 };
const DAY_NO = (d) => DAY_INDEX[d] || 0;

// Справочники для проверок: вместимость аудиторий, численность групп, множества имён.
// Скрытые (hidden=1) аудитории/группы остаются в `rooms`/`groups` (нужны для
// проверок накладок и вместимости — их занятость учитывается), но отдельно
// помечаются в roomHidden/groupHidden, чтобы исключать их из выпадающих списков UI.
function loadReference(db = getDb()) {
  const roomCapacity = {};
  const roomDept = {};
  const roomCourse = {}; // course_only: аудитория только для этого курса
  const roomNote = {}; // примечание (оснащение): показывается при выборе аудитории
  const rooms = new Set();
  const roomHidden = new Set();
  for (const r of db.prepare('SELECT name, capacity, dept, course_only, note, hidden FROM rooms').all()) {
    rooms.add(r.name);
    if (r.capacity != null) roomCapacity[r.name] = r.capacity;
    if (r.dept) roomDept[r.name] = r.dept;
    if (r.note) roomNote[r.name] = r.note;
    if (r.course_only != null) roomCourse[r.name] = r.course_only;
    if (r.hidden) roomHidden.add(r.name);
  }
  const groupHeadcount = {};
  const groupDept = {};
  const groups = new Set();
  const groupHidden = new Set();
  for (const g of db.prepare('SELECT name, headcount, dept, hidden FROM groups').all()) {
    groups.add(g.name);
    if (g.headcount != null) groupHeadcount[g.name] = g.headcount;
    if (g.dept) groupDept[g.name] = g.dept;
    if (g.hidden) groupHidden.add(g.name);
  }
  const teachers = new Set(db.prepare('SELECT name FROM teachers').all().map((t) => t.name));
  return { roomCapacity, roomDept, roomCourse, roomNote, groupHeadcount, groupDept, rooms, groups, teachers, roomHidden, groupHidden };
}

/**
 * Полная проверка расписания: накладки + вместимость + битые ссылки.
 * @returns {{overlaps, capacity, references, total}}
 */
function findAllErrors(db = getDb()) {
  // Отложенные в буфер и мероприятия (не занятия) из проверок исключаем.
  const lessons = loadLessons(db).filter((l) => !l.parked && !l.event);
  const ref = loadReference(db);

  const overlaps = findOverlaps(lessons);
  const capacity = [];
  const references = [];
  for (const l of lessons) {
    const cap = checkCapacity(l, ref);
    if (cap) capacity.push(cap);
    references.push(...checkReferences(l, ref));
  }

  return { overlaps, capacity, references, total: overlaps.length + capacity.length + references.length };
}

/**
 * Проверка расписания + аннотации ПО КАЖДОМУ занятию для подсветки ячеек и
 * подсказок по исправлению: { ...findAllErrors, byLesson: { id: [{kind, detail, suggestion}] } }.
 * suggestion подбирается по виду ошибки: нехватка мест / занятая аудитория →
 * свободные аудитории слота (с учётом вместимости); накладка препод./группы →
 * перенос на другой слот; битая ссылка → исправить/добавить в справочник.
 */
function buildErrorReport(db = getDb()) {
  const lessons = loadLessons(db).filter((l) => !l.parked && !l.event);
  const ref = loadReference(db);

  const overlaps = findOverlaps(lessons);
  const capacity = [];
  const references = [];
  for (const l of lessons) {
    const cap = checkCapacity(l, ref);
    if (cap) capacity.push(cap);
    references.push(...checkReferences(l, ref));
  }
  const total = overlaps.length + capacity.length + references.length;

  const byId = new Map(lessons.map((l) => [l.id, l]));
  const needOf = (L) => (L.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0);

  // Свободные в слоте занятия аудитории, вмещающие need курсантов (до 6 имён).
  const freeRoomsFor = (L, need) => {
    const busy = new Set();
    for (const o of lessons) {
      if (o.id === L.id || o.day !== L.day || o.pairNo !== L.pairNo || o.weekNo !== L.weekNo) continue;
      for (const r of (o.rooms && o.rooms.length ? o.rooms : o.room ? [o.room] : [])) busy.add(r);
    }
    const out = [];
    for (const name of ref.rooms) {
      if (busy.has(name) || ref.roomHidden.has(name)) continue;
      const cap = ref.roomCapacity[name];
      if (need && cap != null && cap < need) continue; // не вмещает
      out.push({ name, cap: cap == null ? null : cap });
    }
    out.sort((a, b) => (a.cap == null ? Infinity : a.cap) - (b.cap == null ? Infinity : b.cap) || a.name.localeCompare(b.name, 'ru'));
    return out.slice(0, 6).map((r) => (r.cap != null ? `${r.name} (${r.cap})` : r.name));
  };

  const byLesson = {};
  const push = (id, kind, detail, suggestion) => {
    (byLesson[id] = byLesson[id] || []).push({ kind, detail, suggestion: suggestion || null });
  };

  for (const c of overlaps) {
    if (c.kind === 'room') {
      for (const id of c.lessonIds) {
        const L = byId.get(id);
        const free = L ? freeRoomsFor(L, needOf(L)) : [];
        push(id, 'room', c.detail, free.length
          ? `Перенести занятие в свободную аудиторию: ${free.join(', ')}`
          : 'Свободных аудиторий в этом слоте нет — перенесите занятие на другое время');
      }
    } else {
      const what = c.kind === 'teacher' ? 'преподавателю' : 'группе';
      for (const id of c.lessonIds) {
        push(id, c.kind, c.detail, `Накладка по ${what}: перенесите одно из занятий на свободный слот`);
      }
    }
  }
  for (const c of capacity) {
    const L = byId.get(c.lessonId);
    const free = L ? freeRoomsFor(L, c.required) : [];
    push(c.lessonId, 'capacity', c.detail, free.length
      ? `Подойдут аудитории (мест ≥ ${c.required}): ${free.join(', ')}`
      : `Свободной аудитории на ${c.required} курсантов в этом слоте нет`);
  }
  for (const c of references) {
    const sug = c.field === 'room' ? 'Выберите существующую аудиторию или добавьте её в справочник'
      : c.field === 'teacher' ? 'Назначьте существующего преподавателя'
        : c.field === 'group' ? 'Исправьте группу занятия' : null;
    push(c.lessonId, 'ref', c.detail, sug);
  }

  // Предупреждения (не ошибки, в total не входят): разные сокращения одной
  // дисциплины на совпадающем слоте/группе/аудитории.
  const aliasCandidates = findAliasCandidates(lessons);

  return { overlaps, capacity, references, total, byLesson, aliasCandidates };
}

/**
 * Проверка переноса занятия по id в новый слот/аудиторию (без записи).
 * @param {number} lessonId
 * @param {{day, pairNo, weekNo, room}} target
 */
function validateMoveById(lessonId, target, db = getDb()) {
  const all = loadLessons(db);
  const ref = loadReference(db);
  const lesson = all.find((l) => l.id === lessonId);
  if (!lesson) return { ok: false, reasons: ['Занятие не найдено'] };
  // Бронь запрещает перенос совсем: это не «предупреждение», обойти нельзя —
  // сначала снимают бронь в карточке занятия.
  if (lesson.locked) return { ok: false, reasons: [LOCKED_REASON] };
  // Мероприятие переносится свободно: его собственный перенос накладок не создаёт.
  if (lesson.event) return { ok: true, reasons: [] };
  return validateMove(lesson, target, {
    // Мероприятия ВКЛючены: слот с мероприятием заблокирован для других занятий.
    // Исключение — метка ЭкзС: занятие ставится прямо поверх неё (метка скрывается,
    // см. hideCoveredEcs), поэтому слот сессии для переноса открыт.
    lessons: all.filter((l) => !l.parked && !isEcs(l)),
    roomCapacity: ref.roomCapacity,
    groupHeadcount: ref.groupHeadcount,
  });
}

// ── Календарь сессии ────────────────────────────────────────────────────────
// Сводная сетка зачётно-экзаменационной сессии: проекция уже существующих занятий
// сессионных видов (даты/аудитории/преподаватели берутся из расписания — в учебном
// плане их нет, только номер семестра).

// Форма контроля занятия: 'exam' | 'zachet' | null (не сессионное).
// Только зачёты и экзамены — курсовые на календарь не выводим.
function sessionKind(type) {
  return assessmentKind(type) || null; // 'exam' | 'zachet' | null
}

const isSelfStudyType = (t) => /^ср$/.test(String(t || '').trim().replace(/[.\s]+$/, '').toLowerCase());

// Физподготовка: правило «3 дня перед экзаменом» на неё не распространяется —
// такое занятие не считается занимающим день. ФП / «Физическая подготовка».
const isPhysTraining = (l) => /физ/i.test(String(l.subjectFull || '')) || String(l.subject || '').trim().toUpperCase() === 'ФП';

// Три учебных дня перед датой экзамена. Пропускаем воскресенья И нерабочие дни
// (праздники/каникулы из настройки holidays) — они не считаются днями подготовки.
function examPrepDays(iso, holidays = new Set()) {
  const out = [];
  let d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return out;
  let guard = 0;
  while (out.length < 3 && guard++ < 90) {
    d = new Date(d.getTime() - 86400000);
    const di = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 0) continue; // воскресенье
    if (holidays.has(di)) continue; // нерабочий день
    out.push(di);
  }
  return out;
}

const isoToDM = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');

// Чистая сборка данных календаря (без БД — тестируется отдельно). На вход —
// занятия из loadLessons (с полями isoDate/date), список групп и праздники.
function buildSessionCalendar(lessons, groups, holidays) {
  const holidaySet = new Set(holidays || []);

  // 1) Формы контроля. Одно занятие (экзамен/зачёт) часто занимает несколько пар
  //    подряд — в БД это отдельные строки с тем же предметом/видом/датой/группами.
  //    Схлопываем их в одну запись, агрегируя ВСЕ занятые пары (pairs/pairFrom/pairTo).
  const bySig = new Map();
  const items = [];
  for (const l of lessons) {
    if (l.parked || l.event) continue;
    const kind = sessionKind(l.type);
    if (!kind) continue;
    const rooms = l.rooms || [];
    const teachers = l.teachers || [];
    const groups0 = l.groups || [];
    const sig = [l.isoDate || '', l.subject, l.type,
      [...groups0].sort().join(','), rooms.join(','), teachers.join(',')].join('|');
    let it = bySig.get(sig);
    if (!it) {
      it = {
        id: l.id, isoDate: l.isoDate || null, date: l.date || null, day: l.day,
        pairNo: l.pairNo, pairs: [], kind, type: l.type, subject: l.subject,
        subjectFull: l.subjectFull || l.subject, rooms, teachers, groups: groups0,
        note: l.note || null,
      };
      bySig.set(sig, it);
      items.push(it);
    }
    if (!it.note && l.note) it.note = l.note; // примечание могли оставить у любой из пар
    if (l.pairNo && !it.pairs.includes(l.pairNo)) it.pairs.push(l.pairNo);
    if (l.pairNo && (it.pairNo == null || l.pairNo < it.pairNo)) { it.pairNo = l.pairNo; it.id = l.id; }
  }
  for (const it of items) {
    it.pairs.sort((a, b) => a - b);
    it.pairFrom = it.pairs.length ? it.pairs[0] : it.pairNo;
    it.pairTo = it.pairs.length ? it.pairs[it.pairs.length - 1] : it.pairNo;
  }

  // 2) Карта занятости групп по дням для проверки подготовки к экзамену. Занятым
  //    считается настоящее занятие (category lesson), КРОМЕ СР и физподготовки.
  //    Метки-мероприятия (ЭкзС, Отп…) — не занятие, день не блокируют.
  const busy = new Map(); // 'группа|дата' → [{subject, type}]
  for (const l of lessons) {
    if (l.parked || l.event || !l.isoDate) continue;
    if (isSelfStudyType(l.type) || isPhysTraining(l)) continue;
    for (const g of (l.groups || [])) {
      const k = g + '|' + l.isoDate;
      let arr = busy.get(k);
      if (!arr) busy.set(k, (arr = []));
      if (!arr.some((x) => x.subject === l.subject && x.type === l.type)) {
        arr.push({ subject: l.subject, type: l.type });
      }
    }
  }

  // 3) Проверка: 3 дня перед экзаменом (без воскресений и нерабочих) свободны.
  //    Для экзамена по физподготовке дни на подготовку не выделяются — проверки нет.
  for (const it of items) {
    if (it.kind !== 'exam' || !it.isoDate || isPhysTraining(it)) { it.prep = null; continue; }
    const days = examPrepDays(it.isoDate, holidaySet);
    const conflicts = [];
    for (const g of it.groups) {
      for (const iso of days) {
        const arr = busy.get(g + '|' + iso);
        if (arr && arr.length) conflicts.push({ group: g, isoDate: iso, date: isoToDM(iso), items: arr });
      }
    }
    it.prep = { ok: conflicts.length === 0, days, conflicts };
  }

  // Диапазон по умолчанию — от первой до последней даты сессионных занятий.
  let from = null, to = null;
  for (const it of items) {
    if (!it.isoDate) continue;
    if (!from || it.isoDate < from) from = it.isoDate;
    if (!to || it.isoDate > to) to = it.isoDate;
  }
  return { groups, holidays, from, to, lessons: items };
}

// График сессии по группам — те же формы контроля, что в календаре, но списком:
// строка на форму контроля в КАЖДОЙ группе потока, по дате. К строке добавляются
// дни с предыдущей формы контроля группы, подготовка к экзамену именно этой
// группы, остальные группы потока, численность потока и места в аудиториях.
// cal — результат buildSessionCalendar (+ groupCourse); справочники передаются
// отдельно, чтобы функция оставалась чистой.
function buildSessionSchedule(cal, { teacherDept = {}, groupHeadcount = {}, roomCapacity = {} } = {}) {
  const byGroup = new Map((cal.groups || []).map((g) => [g, []]));
  for (const it of cal.lessons || []) {
    for (const g of it.groups || []) if (byGroup.has(g)) byGroup.get(g).push(it);
  }
  const groups = [];
  for (const [group, items] of byGroup) {
    if (!items.length) continue;
    items.sort((a, b) => (a.isoDate || '9999').localeCompare(b.isoDate || '9999') || (a.pairFrom || 0) - (b.pairFrom || 0));
    let prevIso = null;
    const rows = items.map((it) => {
      const gapDays = it.isoDate && prevIso ? Math.round((Date.parse(it.isoDate) - Date.parse(prevIso)) / 86400000) : null;
      if (it.isoDate) prevIso = it.isoDate;
      const caps = (it.rooms || []).map((r) => roomCapacity[r]);
      const headcount = it.groups.reduce((s, g) => s + (groupHeadcount[g] || 0), 0);
      return {
        id: it.id, isoDate: it.isoDate, date: it.date, day: it.day, pairFrom: it.pairFrom, pairTo: it.pairTo,
        kind: it.kind, type: it.type, subject: it.subject, subjectFull: it.subjectFull, note: it.note || null,
        rooms: it.rooms || [],
        // Места известны, только если известна вместимость каждой аудитории.
        capacity: caps.length && caps.every((c) => c != null) ? caps.reduce((s, c) => s + c, 0) : null,
        teachers: (it.teachers || []).map((name) => ({ name, dept: teacherDept[name] || '' })),
        stream: it.groups.filter((g) => g !== group),
        headcount: headcount || null,
        gapDays,
        // null — проверки нет (зачёт, ФП, нет даты); [] — дни подготовки свободны.
        prepConflicts: it.prep ? it.prep.conflicts.filter((c) => c.group === group) : null,
      };
    });
    groups.push({ group, course: (cal.groupCourse || {})[group] ?? null, rows });
  }
  return { semester: cal.semester || null, groups };
}

// Обвязка с БД: все группы (кроме скрытых), праздники, активный семестр для дат.
function getSessionCalendar(db = getDb()) {
  const semester = getSemester(db);
  const lessons = loadLessons(db);
  for (const l of lessons) l.isoDate = lessonDateISO(l.weekNo, l.day, semester);

  const ref = loadReference(db);
  const groups = [...ref.groups]
    .filter((g) => !ref.groupHidden.has(g))
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));

  const coursesMap = getCourses(db);
  const groupCourse = {};
  const groupDept = {};
  for (const g of groups) {
    const c = coursesMap[g.slice(0, 2)];
    if (c != null) groupCourse[g] = c;
    // Кафедра выводится ИЗ ИМЕНИ группы (факультет+кафедра = name[0]+name[2], как
    // kafedraOfGroup), а не из поля dept в БД — оно у части групп ошибочно (821-11
    // имеет dept=84 при кафедре 81). Имя — надёжный источник. Фолбэк — dept из БД.
    const kaf = (g[0] && g[2]) ? g[0] + g[2] : (ref.groupDept[g] || '');
    if (kaf) groupDept[g] = kaf;
  }

  return { semester, groupCourse, groupDept, ...buildSessionCalendar(lessons, groups, getHolidays(db)) };
}

module.exports = {
  loadLessons,
  isEcs,
  LOCKED_REASON,
  loadReference,
  findAllErrors,
  buildErrorReport,
  validateMoveById,
  sessionKind,
  buildSessionCalendar,
  getSessionCalendar,
  buildSessionSchedule,
  examPrepDays,
  isSelfStudyType,
  isPhysTraining,
};
