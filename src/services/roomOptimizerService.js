'use strict';

const path = require('node:path');
const { getDb } = require('../config/database');
const { transaction, getOrCreate } = require('./dbService');
const { loadLessons, loadReference, isPhysTraining } = require('./conflictService');
const { getCourses, getRoomPlanSettings } = require('./settingsService');
const { lessonSnapshot, teacherDepts, logRoomChange, moveLogChain } = require('./scheduleService');
const { isPracticalType } = require('../utils/lessonTypes');
const { assessmentKind } = require(path.join(__dirname, '..', '..', 'public', 'js', 'shared-constants.js'));
const { pushUndo } = require('./undoService');

/**
 * Подбор аудиторий на ОДНОЙ неделе (сводное расписание) — одно правило с явным
 * порядком приоритетов вместо нескольких независимых проходов.
 *
 * У расстановки есть вектор «плохости» — по числу на правило, в порядке
 * приоритета (меньше — лучше):
 *   1. ctrl         — подряд идущие формы контроля стоят в разных аудиториях;
 *   2. cc           — лабораторной (информатике) не досталось компьютерного класса
 *                     либо класс занят тем, кому он не нужен;
 *   3. teacherGroup — подряд идущие пары «преподаватель × группа» врозь;
 *   4. teacherAny   — подряд идущие пары преподавателя (любые группы) врозь;
 *   5. dept         — занятие не в аудитории кафедры своего преподавателя;
 *   6. capacity     — мест не столько, сколько курсантов (функция cost ниже).
 *
 * Ход принимается, только если ПЕРВАЯ ненулевая компонента вектора изменений
 * отрицательна. Отсюда и «одно правило не мешает другому»: выигрыш по
 * вместимости не может быть куплен потерей компьютерного класса — компонента 2
 * сравнивается раньше компоненты 6, и такой ход отбрасывается. Отдельные сторожа
 * («не разорви чужой блок», «не уводи из КК») больше не нужны: это тот же вектор.
 *
 * Порядок и включение правил, допуски и списки исключений — в настройках
 * (settings.roomPlan, см. settingsService.getRoomPlanSettings).
 *
 * ponytail: жадный перебор «юнит × аудитория» без поиска оптимума — как и было;
 * если понадобится оптимум по слоту, здесь встанет венгерский алгоритм.
 */
// Сколько вариантов показывать на одно предложение: больше — глазами не выбрать.
const MAX_OPTIONS = 4;

const teachersOf = (l) => (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : []));

// Помещения, которые подбором не двигаются: спортивные и казармы. Опознаём ПО
// ИМЕНИ — отдельного типа у них в справочнике нет, а называются они узнаваемо
// («Сп. зал», «Плац», «Каз. 81к», «Казарма»). Занятие идёт там, потому что оно
// только там и может идти: подбирать «аудиторию по размеру» тут нечего.
const isFixedRoom = (name) => /сп\.?\s*зал|спорт|стадион|бассейн|манеж|плац|^каз\.?\s*\d|казарм/i
  .test(String(name || '').trim());

// Физподготовка и «непереставляемые» помещения из подбора исключены целиком: ФП
// идёт там, где идёт, а «Сп. зал» на 500 мест иначе вечно выглядит «аудиторией не
// по размеру» для группы в 20 человек.
const skipForRooms = (l, room) => isPhysTraining(l) || isFixedRoom(room);

// Компьютерный класс. Отдельного типа в справочнике аудиторий нет — признак
// проставлен в примечании: «КК».
const isCC = (note) => /(^|[^А-ЯЁа-яё])КК([^А-ЯЁа-яё]|$)/.test(String(note || ''));

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
// Дисциплина из настроек против дисциплины занятия: полное название сверяем
// вхождением («информатик» ловит «Информатика и ИТ»), сокращение — целиком
// («Инф» ловится настройкой «информатик», но не наоборот с одной буквой).
const subjMatch = (l, name) => {
  const n = norm(name);
  if (!n) return false;
  const s = norm(l.subject);
  const f = norm(l.subjectFull);
  return (!!f && f.includes(n)) || (!!s && (s === n || (s.length >= 3 && n.startsWith(s))));
};

// Лексикографическое сравнение векторов: первая различающаяся компонента решает.
const cmpVec = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/**
 * @param {number} weekNo — учебная неделя
 * @param {object} [db]
 * @param {string[]|null} [rules] — разово прогнать только эти правила: 'ctrl',
 *   'cc', 'teacherGroup', 'teacherAny', 'dept', 'capacity' (старое 'teacher' —
 *   оба «преподавательских»). null/пусто — все включённые в настройках.
 */
function suggestRoomPlan(weekNo, db = getDb(), rules = null) {
  const w = Number(weekNo);
  if (!w || w < 1) return { ok: false, code: 400, reasons: ['Укажите номер недели'] };

  const cfg = getRoomPlanSettings(db);
  const asked = new Set();
  for (const r of rules || []) {
    if (r === 'teacher') { asked.add('teacherGroup'); asked.add('teacherAny'); continue; }
    asked.add(String(r));
  }
  // Порядок правил — из настроек: он же порядок сравнения компонент вектора.
  const order = cfg.rules.filter((r) => r.on && (!asked.size || asked.has(r.id))).map((r) => r.id);
  if (!order.length) return { ok: true, weekNo: w, suggestions: [], wasted: 0, gain: 0, counts: {} };

  const ref = loadReference(db);
  const courses = getCourses(db);
  const kinds = {};
  for (const r of db.prepare('SELECT name, kind FROM rooms').all()) kinds[r.name] = r.kind || null;
  const roomNote = ref.roomNote || {};
  const roomDept = ref.roomDept || {};
  // «Цена» размещения: лишние места — по одному за место, нехватка — в overWeight
  // раз дороже. Без штрафа обмен двух аудиторий не менял бы ничего: сумма
  // (вместимость − курсанты) при обмене одна и та же.
  const cost = (cap, need) => (need > cap ? cfg.overWeight * (need - cap) : cap - need);

  const courseOf = (g) => String(courses[String(g).slice(0, 2)] ?? String(g).slice(0, 2));
  const courseOK = (roomName, groups) => {
    const rc = ref.roomCourse[roomName];
    return rc == null || groups.every((g) => String(rc) === courseOf(g));
  };
  const ccRoom = (name) => isCC(roomNote[name]);
  // Кому нужен компьютерный класс: лабораторные и дисциплины из настроек
  // (по умолчанию информатика), кроме лекций и форм контроля.
  const needsCC = (l) => !cfg.ccSkipSubjects.some((s) => subjMatch(l, s))
    && (norm(l.type) === 'лр'
      || (cfg.ccNeedSubjects.some((s) => subjMatch(l, s)) && isPracticalType(l.type)));

  const weekLessons = loadLessons(db)
    .filter((l) => !l.parked && !l.event && l.category !== 'event' && l.weekNo === w);
  const roomsOf = (l) => (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []));
  const slotKey = (l) => `${l.day}|${l.pairNo}`;

  // Занятость аудиторий по слотам: «день|пара» → аудитория → занятия в ней.
  // Список, а не счётчик: по нему же ищется «сосед» для обмена аудиториями.
  const occupied = new Map();
  for (const l of weekLessons) {
    const key = slotKey(l);
    if (!occupied.has(key)) occupied.set(key, new Map());
    const slot = occupied.get(key);
    for (const r of roomsOf(l)) {
      if (!slot.has(r)) slot.set(r, []);
      slot.get(r).push(l);
    }
  }
  const occupantsIn = (key, room) => ((occupied.get(key) || new Map()).get(room) || []);
  const needOf = (l) => (l.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0);
  const capOf = (name) => ref.roomCapacity[name] || 0;

  // Нынешняя расстановка. Занятия без аудитории или сразу в двух в подборе не
  // участвуют даже как фон: выигрыш по ним не посчитать.
  const byId = new Map();
  const roomById = new Map();
  for (const l of weekLessons) {
    const rooms = roomsOf(l);
    if (rooms.length !== 1) continue;
    byId.set(l.id, l);
    roomById.set(l.id, rooms[0]);
  }
  const now = (id) => roomById.get(id);

  // Кафедра преподавателя — та же, что в статистике загрузки и виде
  // «Преподаватели»: ручная, иначе по дисциплинам. Считается по ВСЕМ занятиям
  // (не только недели), иначе у человека кафедра плавала бы от недели к неделе.
  const depts = teacherDepts(loadLessons(db).filter((l) => !l.event && l.category !== 'event'), db);
  const deptCache = new Map();
  const deptOfTeacher = (l) => {
    if (deptCache.has(l.id)) return deptCache.get(l.id);
    let who = null;
    for (const t of teachersOf(l)) {
      const d = (depts.get(t) || {}).dept;
      if (d) { who = { teacher: t, dept: d }; break; }
    }
    deptCache.set(l.id, who);
    return who;
  };

  // Что подбору вообще разрешено двигать.
  const skipRooms = new Set(cfg.skipRooms);
  const movable = new Set();
  for (const l of weekLessons) {
    const room = now(l.id);
    if (!room || skipRooms.has(room) || skipForRooms(l, room)) continue;
    if (cfg.skipLocked && l.locked) continue; // бронь: занятие не переносят
    if (cfg.skipSubjects.some((s) => subjMatch(l, s))) continue;
    // Аудиторию делят несколько занятий (подгруппы, совмещённая СР) — их числа
    // курсантов складываются не здесь; такие пары оставляем человеку.
    if (occupantsIn(slotKey(l), room).length > 1) continue;
    if (needOf(l) > 0 && capOf(room) > 0) movable.add(l.id);
  }

  // ── Серии подряд идущих пар ────────────────────────────────────────────────
  // По ним считаются метрики 1, 3, 4; из них же берутся «юниты» — наборы
  // занятий, которым нужна одна общая аудитория. 4-я пара в серии не входит:
  // она после большого перерыва, переход между аудиториями там никому не мешает.
  const seriesBy = (keyOf) => {
    const byKey = new Map(); // ключ → пара → id занятия
    for (const l of weekLessons) {
      if (!roomById.has(l.id) || !cfg.blockPairs.includes(l.pairNo)) continue;
      for (const k of keyOf(l)) {
        if (!byKey.has(k)) byKey.set(k, new Map());
        // Два занятия в одном слоте — накладка, её чинит не подбор.
        if (!byKey.get(k).has(l.pairNo)) byKey.get(k).set(l.pairNo, l.id);
      }
    }
    const runs = [];
    for (const byPair of byKey.values()) {
      let run = [];
      const flush = () => { if (run.length > 1) runs.push(run.map((p) => byPair.get(p))); run = []; };
      for (const p of [...byPair.keys()].sort((a, b) => a - b)) {
        if (run.length && p !== run[run.length - 1] + 1) flush();
        run.push(p);
      }
      flush();
    }
    return runs;
  };
  const runsOf = {
    ctrl: seriesBy((l) => (assessmentKind(l.type) ? (l.groups || []).map((g) => `${g}|${l.day}`) : [])),
    teacherGroup: seriesBy((l) => teachersOf(l)
      .flatMap((t) => (l.groups || []).map((g) => `${t}|${g}|${l.day}`))),
    teacherAny: seriesBy((l) => teachersOf(l).map((t) => `${t}|${l.day}`)),
  };
  const runIndex = {};
  for (const [rule, runs] of Object.entries(runsOf)) {
    const idx = new Map();
    runs.forEach((run, i) => run.forEach((id) => {
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push(i);
    }));
    runIndex[rule] = idx;
  }

  // ── Метрики ────────────────────────────────────────────────────────────────
  const perLesson = {
    cc: (l, room) => (needsCC(l) ? (ccRoom(room) ? 0 : 1) : (ccRoom(room) ? 1 : 0)),
    dept: (l, room) => {
      const who = deptOfTeacher(l);
      return who && (roomDept[room] || '') !== who.dept ? 1 : 0;
    },
    capacity: (l, room) => cost(capOf(room), needOf(l)),
  };
  const breaksIn = (run, at) => {
    let n = 0;
    for (let i = 1; i < run.length; i++) if (at(run[i]) !== at(run[i - 1])) n++;
    return n;
  };
  const metric = (rule, changes, at) => {
    const f = perLesson[rule];
    let d = 0;
    if (f) {
      for (const [id, room] of changes) d += f(byId.get(id), room) - f(byId.get(id), now(id));
      return d;
    }
    const seen = new Set();
    for (const [id] of changes) {
      for (const i of runIndex[rule].get(id) || []) {
        if (seen.has(i)) continue;
        seen.add(i);
        d += breaksIn(runsOf[rule][i], at) - breaksIn(runsOf[rule][i], now);
      }
    }
    return d;
  };
  // Вектор изменения «плохости»: по числу на правило, в порядке приоритета.
  const deltaOf = (changes) => {
    const ov = new Map(changes);
    const at = (id) => (ov.has(id) ? ov.get(id) : now(id));
    return order.map((rule) => metric(rule, changes, at));
  };

  const allRooms = [...ref.rooms]
    .filter((r) => !ref.roomHidden.has(r) && capOf(r) > 0 && !isFixedRoom(r) && !skipRooms.has(r))
    .map((name) => ({ name, cap: capOf(name), kind: kinds[name] || null }));

  // Ход ради ОДНОЙ ТОЛЬКО вместимости должен что-то заметно менять: аудиторию
  // на 42 места под группу в 40 менять на 40-местную незачем — перестановка есть,
  // выигрыша нет. Порог считается по разнице мест, а не по цене размещения.
  // Нехватка мест проходит всегда: её починка важна при любом размере.
  const worthCapacity = (changes) => changes.some(([id, room]) => {
    const l = byId.get(id);
    const from = now(id);
    const need = needOf(l);
    return Math.max(0, need - capOf(from)) > Math.max(0, need - capOf(room))
      || Math.abs(capOf(room) - capOf(from)) > cfg.minCapacityGain;
  });

  // Жёсткие условия: их не покупает никакой выигрыш, поэтому они вне вектора.
  const feasible = (changes) => changes.every(([id, room]) => {
    const l = byId.get(id);
    const from = now(id);
    const need = needOf(l);
    const cap = capOf(room);
    if (!cap || room === from) return false;
    if ((kinds[room] || null) !== (kinds[from] || null)) return false; // тип/оснащение
    if (!courseOK(room, l.groups || [])) return false;
    // Нехватку мест ход не создаёт и не усугубляет...
    if (Math.max(0, need - cap) > Math.max(0, need - capOf(from))) return false;
    // ...и не покупает «одну аудиторию» переселением группы в лишний зал.
    return cap - need <= Math.max(cfg.maxExtra, capOf(from) - need);
  });

  // ── Юниты: наборы занятий, которым нужна одна общая аудитория ──────────────
  const units = [];
  const seenUnits = new Set();
  for (const rule of ['ctrl', 'teacherGroup', 'teacherAny']) {
    if (!order.includes(rule)) continue;
    for (const run of runsOf[rule]) {
      if (new Set(run.map(now)).size < 2) continue; // уже в одной аудитории
      const ids = run.filter((id) => movable.has(id));
      // Серия, где подбору доступно меньше двух занятий, юнитом не становится:
      // одиночный ход разберёт проход по занятиям, а метрика серии его оценит.
      if (ids.length < 2) continue;
      const key = ids.join('-');
      if (seenUnits.has(key)) continue;
      seenUnits.add(key);
      units.push(ids.map((id) => byId.get(id)));
    }
  }
  for (const l of weekLessons) if (movable.has(l.id)) units.push([l]);

  // Варианты для юнита: куда его целиком переставить.
  const optionsFor = (ls) => {
    const kind = kinds[now(ls[0].id)] || null;
    if (ls.some((l) => (kinds[now(l.id)] || null) !== kind)) return []; // разные типы не объединяем
    const need = Math.max(...ls.map((l) => needOf(l)));
    const out = [];
    for (const r of allRooms) {
      if (r.kind !== kind) continue;
      const changes = [];
      const steps = [];
      let ok = true;
      let swaps = 0;
      for (const l of ls) {
        const from = now(l.id);
        if (from === r.name) continue; // уже здесь
        const occ = occupantsIn(slotKey(l), r.name).filter((o) => o.id !== l.id);
        if (occ.length > 1) { ok = false; break; } // аудиторию делят — не лезем
        const step = { action: 'move', pairNo: l.pairNo, lessonId: l.id, toRoom: r.name, fromRoom: from };
        if (occ.length === 1) {
          // Аудитория занята — меняемся с этим занятием (оно уедет в нашу).
          const o = occ[0];
          if (!movable.has(o.id) || ls.some((x) => x.id === o.id)) { ok = false; break; }
          swaps++;
          Object.assign(step, {
            action: 'swap',
            withLessonId: o.id, withSubject: o.subject || '',
            withGroups: o.groups || [], withNeed: needOf(o),
          });
          changes.push([o.id, from]);
        }
        changes.push([l.id, r.name]);
        steps.push(step);
      }
      if (!ok || !steps.length || !feasible(changes)) continue;
      const d = deltaOf(changes);
      const i = d.findIndex((x) => x !== 0);
      if (i < 0 || d[i] > 0) continue; // ход ничего не улучшает или портит старшее правило
      const rule = order[i];
      // «Разные группы к одной аудитории» и «своя кафедра» работают только по
      // свободным аудиториям: чужое занятие ради них не двигаем.
      if (swaps && (rule === 'teacherAny' || rule === 'dept')) continue;
      if (rule === 'capacity' && !worthCapacity(changes)) continue; // мелкая подгонка мест
      out.push({ rule, d, gain: -d[i], toRoom: r.name, toCap: r.cap, steps, changes });
    }
    // Лучший — первым: сравниваем векторы, при равенстве берём аудиторию потеснее.
    out.sort((a, b) => cmpVec(a.d, b.d)
      || (a.toCap - need) - (b.toCap - need)
      || a.toRoom.localeCompare(b.toRoom, 'ru'));
    return out.slice(0, MAX_OPTIONS);
  };

  // ── Сбор предложений ───────────────────────────────────────────────────────
  const drafts = [];
  for (const ls of units) {
    const opts = optionsFor(ls);
    if (opts.length) drafts.push({ ls, opts });
  }
  // Разбираем в порядке приоритета правила, внутри правила — от выигрышного.
  drafts.sort((a, b) => order.indexOf(a.opts[0].rule) - order.indexOf(b.opts[0].rule)
    || b.opts[0].gain - a.opts[0].gain);

  const usedLessons = new Set(); // занятие участвует не больше чем в одном предложении
  const usedRooms = new Map(); // слот → аудитории, обещанные другим предложениям
  const slotOf = (id) => slotKey(byId.get(id));
  const conflicts = (o) => o.changes.some(([id]) => usedLessons.has(id))
    || o.steps.some((st) => (usedRooms.get(slotOf(st.lessonId)) || new Set()).has(st.toRoom));

  const asOption = (o, block) => {
    if (block) return { action: 'block', toRoom: o.toRoom, toCap: o.toCap, gain: o.gain, steps: o.steps };
    const st = o.steps[0];
    const base = { action: st.action, toRoom: o.toRoom, toCap: o.toCap, gain: o.gain };
    return st.action === 'swap'
      ? Object.assign(base, {
        withLessonId: st.withLessonId, withSubject: st.withSubject,
        withGroups: st.withGroups, withNeed: st.withNeed,
      })
      : base;
  };

  const suggestions = [];
  for (const { ls, opts } of drafts) {
    // Основной вариант — лучший из тех, что не спорит с уже выданными: свободную
    // аудиторию не обещаем дважды, занятие не участвует в двух перестановках.
    const pick = opts.find((o) => !conflicts(o));
    if (!pick) continue;
    for (const [id] of pick.changes) usedLessons.add(id);
    for (const st of pick.steps) {
      const k = slotOf(st.lessonId);
      if (!usedRooms.has(k)) usedRooms.set(k, new Set());
      usedRooms.get(k).add(st.toRoom);
    }
    const block = ls.length > 1;
    const who = deptOfTeacher(ls[0]);
    const options = [pick, ...opts.filter((o) => o !== pick)].map((o) => asOption(o, block));
    const rooms = [...new Set(ls.map((l) => now(l.id)))];
    suggestions.push({
      kind: pick.rule,
      key: `${pick.rule}:${ls.map((l) => l.id).join('-')}`,
      day: ls[0].day,
      weekNo: w,
      subject: [...new Set(ls.map((l) => l.subject || ''))].filter(Boolean).join(', '),
      type: ls[0].type || '',
      groups: [...new Set(ls.flatMap((l) => l.groups || []))],
      need: Math.max(...ls.map((l) => needOf(l))),
      teacher: teachersOf(ls[0])[0] || '',
      // Правило «комп. класс» работает в обе стороны: занятие зовут в класс или,
      // наоборот, освобождают класс от того, кому он не нужен. Тексту в UI нужно
      // знать, какая это из двух сторон.
      ccNeeds: needsCC(ls[0]),
      dept: who ? who.dept : '',
      roomDept: roomDept[rooms[0]] || '',
      room: rooms.join(', '),
      cap: capOf(rooms[0]),
      ...(block
        ? { pairs: ls.map((l) => l.pairNo), lessonIds: ls.map((l) => l.id) }
        : { pairNo: ls[0].pairNo, lessonId: ls[0].id }),
      ...options[0], // основной вариант дублируется полями верхнего уровня
      options,
    });
  }

  // Сколько лишних мест в неделе всего — чтобы показать «было / станет».
  const wasted = [...movable].reduce((s, id) => s + Math.max(0, capOf(now(id)) - needOf(byId.get(id))), 0);
  const gain = suggestions.filter((s) => s.kind === 'capacity').reduce((s, x) => s + x.gain, 0);
  const counts = {};
  for (const s of suggestions) counts[s.kind] = (counts[s.kind] || 0) + 1;
  return { ok: true, weekNo: w, suggestions, wasted, gain, counts };
}

/**
 * Применяет выбранные предложения. Каждое проверяется заново: если аудиторию
 * успели занять (или занятие уже переставили), пункт пропускается и попадает в
 * skipped — молча создавать накладки оптимизатор не должен.
 * Откат — одной кнопкой «Отменить» (снимок всех затронутых занятий).
 */
function applyRoomPlan(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: false, code: 400, reasons: ['Не выбрано ни одного предложения'] };

  return transaction((db) => {
    const lessons = loadLessons(db);
    const byId = new Map(lessons.map((l) => [l.id, l]));
    const roomsOf = (l) => (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []));

    // Текущая занятость аудиторий по слотам — пересчитываем по ходу применения.
    const occupied = new Map();
    const slotKey = (l) => `${l.weekNo}|${l.day}|${l.pairNo}`;
    for (const l of lessons) {
      if (l.parked) continue;
      const key = slotKey(l);
      if (!occupied.has(key)) occupied.set(key, new Map());
      for (const r of roomsOf(l)) occupied.get(key).set(r, l.id);
    }

    const snapshots = [];
    const skipped = [];
    const changes = []; // [lessonId, roomName]

    // Один ход предложения. Возвращает список изменений или null, если ход
    // устарел (аудиторию заняли, занятие переставили). Занятость слотов правит
    // сразу: следующие ходы того же плана видят уже новую картину.
    const applyStep = (step) => {
      const L = byId.get(Number(step.lessonId));
      const target = String(step.toRoom || '').trim();
      if (!L || !target) return null;
      const key = slotKey(L);
      const slot = occupied.get(key) || new Map();
      const holder = slot.get(target);
      const from = roomsOf(L)[0];
      if (!from) return null;

      if (step.action === 'swap') {
        const O = byId.get(Number(step.withLessonId));
        if (!O || slotKey(O) !== key || holder !== O.id) return null;
        if (roomsOf(O)[0] !== target) return null;
        slot.set(target, L.id);
        slot.set(from, O.id);
        return { snapshots: [lessonSnapshot(L), lessonSnapshot(O)], changes: [[L.id, target], [O.id, from]] };
      }
      if (holder != null) return null; // аудиторию заняли
      slot.delete(from);
      slot.set(target, L.id);
      return { snapshots: [lessonSnapshot(L)], changes: [[L.id, target]] };
    };

    for (const item of list) {
      // План блока преподавателя применяется ЦЕЛИКОМ: половина плана оставила бы
      // его между двумя аудиториями — ровно то, от чего уходим.
      const steps = item.action === 'block' ? (item.steps || []) : [item];
      const done = [];
      let ok = steps.length > 0;
      for (const st of steps) {
        const res = applyStep(st);
        if (!res) { ok = false; break; }
        done.push(res);
      }
      if (!ok) {
        // Откатываем занятость, которую успели поправить неудавшиеся шаги плана.
        for (const res of done) {
          for (const [lessonId, roomName] of res.changes) {
            const L = byId.get(lessonId);
            const slot = occupied.get(slotKey(L));
            if (slot && slot.get(roomName) === lessonId) slot.delete(roomName);
          }
          for (const snap of res.snapshots) {
            const L = byId.get(snap.id);
            const slot = occupied.get(slotKey(L));
            if (slot && snap.rooms[0]) slot.set(snap.rooms[0], snap.id);
          }
        }
        skipped.push(item);
        continue;
      }
      for (const res of done) {
        snapshots.push(...res.snapshots);
        changes.push(...res.changes);
      }
    }

    if (!changes.length) return { ok: true, applied: 0, skipped: skipped.length };

    // В снимках — цепочка журнала: «Отменить» снимает и записи о смене аудитории.
    pushUndo(db, 'deleteEntity', `Оптимизация аудиторий (${changes.length} занятий)`, {
      snapshots: snapshots.map((sn) => ({ ...sn, moveLogBefore: moveLogChain(db, sn.id) })),
    });

    const upd = db.prepare('UPDATE lessons SET room_id = ? WHERE id = ?');
    const delLR = db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?');
    const insLR = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
    for (const [lessonId, roomName] of changes) {
      const roomId = getOrCreate(db, 'rooms', 'name', roomName);
      upd.run(roomId, lessonId);
      delLR.run(lessonId);
      insLR.run(lessonId, roomId);
      // Журнал: подбор аудиторий — такая же смена аудитории, как ручная.
      logRoomChange(db, byId.get(lessonId), roomsOf(byId.get(lessonId)), [roomName]);
    }
    return { ok: true, applied: changes.length, skipped: skipped.length };
  });
}

module.exports = { suggestRoomPlan, applyRoomPlan };
