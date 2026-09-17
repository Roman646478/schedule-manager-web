'use strict';

const path = require('path');

const { getDb } = require('../config/database');
const { transaction, getOrCreate } = require('./dbService');
const { loadLessons, loadReference, isSelfStudyType, isPhysTraining, isEcs } = require('./conflictService');
const { getSemester, getHolidays, getCourses } = require('./settingsService');
const { lessonSnapshot, logMove, setLessonRoomsRows, moveLogChain } = require('./scheduleService');
const { validateMove } = require('../utils/validators');
const { lessonDate, lessonDateISO, weekCount } = require('../utils/calendar');
const { DAYS, PAIRS_PER_DAY, PAIR_TIMES } = require('../utils/constants');
const { pushUndo } = require('./undoService');
const { assessmentKind, roomFitCmp } = require(path.join(__dirname, '..', '..', 'public', 'js', 'shared-constants.js'));

/**
 * Разгрузка 4-й пары у группы.
 *
 * 4-я пара (часы 7–8, 16.20–17.55) идёт после большого перерыва, и её стараются
 * освободить: курсанты уходят раньше. Здесь ищутся переносы занятий с 4-й пары в
 * свободные окна пар 1–3 в пределах ±2 недель от самого занятия, пн–пт.
 *
 * Два вида ходов:
 *  - прямой: слот свободен у группы, преподавателя и аудитории;
 *  - цепочка из двух шагов: окно у группы есть, но преподаватель в это время
 *    ведёт ДРУГУЮ группу — сначала уезжает её пара (по тем же правилам), затем
 *    наша. Применяется целиком: половина цепочки оставила бы расписание в
 *    состоянии, ради которого ничего не делалось.
 *
 * Предложения только предлагаются: составитель отмечает галочками, что
 * применить, применение обратимо кнопкой «Отменить».
 */

const SOURCE_PAIR = 4;
// 4-я пара целью не бывает никогда: иначе разгрузка одной группы оплачивалась бы
// 4-й парой другой.
const TARGET_PAIRS = [1, 2, 3];
const WORK_DAYS = DAYS.slice(0, 5); // пн–пт; субботу не трогаем ни как источник, ни как цель
const WEEK_SPAN = 2; // ±2 недели от недели самого занятия
const MAX_OPTIONS = 4; // больше вариантов в строке глазами уже не выбрать

const normType = (t) => String(t || '').trim().replace(/[.\s]+$/, '').toLowerCase();
// Контрольная/курсовая работа: перенос — отдельное решение, как у зачётов и экзаменов.
const isControlWork = (t) => /^(кр|кп|кур)$/.test(normType(t));

/**
 * Что можно двигать: обычные учебные пары. Мероприятие — не занятие; бронь
 * запрещает перенос совсем; СР расставляется автоматически; ФП идёт там, где
 * идёт; формы контроля переносят вручную.
 */
function isMovable(l) {
  return !l.event && !l.locked && !l.orphan && !l.parked
    && !isSelfStudyType(l.type) && !isPhysTraining(l)
    && !assessmentKind(l.type) && !isControlWork(l.type);
}

const teachersOf = (l) => (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : []));
const roomsOf = (l) => (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []));
const slotKey = (day, pairNo, weekNo) => `${day}|${pairNo}|${weekNo}`;

// Общий для поиска и применения контекст: занятость по слотам, метки сессии,
// нерабочие дни, вместимость.
function buildContext(db) {
  const raw = loadLessons(db).filter((l) => !l.parked);
  const ref = loadReference(db);
  const semester = getSemester(db);
  const holidays = new Set(getHolidays(db));
  const courses = getCourses(db);

  // Метка ЭкзС занятостью не считается (занятие встаёт прямо поверх неё), но
  // ставить учебную пару в экзаменационную сессию нельзя — держим отдельным
  // списком: это тот же случай, ради которого заведены «Не размещённые при импорте».
  const live = raw.filter((l) => !isEcs(l));
  const session = new Set();
  for (const l of raw) {
    if (!isEcs(l)) continue;
    for (const g of (l.groupsAll || l.groups || [])) session.add(`${g}|${slotKey(l.day, l.pairNo, l.weekNo)}`);
  }

  const courseOf = (g) => String(courses[String(g).slice(0, 2)] ?? String(g).slice(0, 2));
  return {
    raw,
    live,
    ref,
    semester,
    session,
    weeks: weekCount(semester) || raw.reduce((m, l) => Math.max(m, l.weekNo || 0), 0),
    needOf: (l) => (l.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0),
    courseOK: (room, groups) => {
      const rc = ref.roomCourse[room];
      return rc == null || groups.every((g) => String(rc) === courseOf(g));
    },
    isWorkday: (day, w) => {
      const iso = lessonDateISO(w, day, semester);
      return !(iso && holidays.has(iso));
    },
    inSession: (l, day, p, w) => (l.groups || []).some((g) => session.has(`${g}|${slotKey(day, p, w)}`)),
  };
}

/**
 * Поиск предложений по разгрузке 4-й пары у одной группы.
 * @param {string} group имя группы
 * @param {object} [db]
 */
function suggestPair4Relief(group, db = getDb()) {
  const name = String(group || '').trim();
  if (!name) return { ok: false, code: 400, reasons: ['Не указана группа'] };

  const ctx = buildContext(db);
  const { ref, live, weeks } = ctx;

  const bySlot = new Map();
  for (const l of live) {
    const k = slotKey(l.day, l.pairNo, l.weekNo);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(l);
  }
  const at = (day, p, w) => bySlot.get(slotKey(day, p, w)) || [];

  const groupsFree = (l, day, p, w) =>
    !at(day, p, w).some((o) => o.id !== l.id && (o.groups || []).some((g) => (l.groups || []).includes(g)));

  // Занятия, из-за которых преподаватель нашего занятия в этом слоте несвободен.
  const teacherBlockers = (l, day, p, w) => {
    const mine = teachersOf(l);
    if (!mine.length) return [];
    return at(day, p, w).filter((o) => o.id !== l.id && teachersOf(o).some((t) => mine.includes(t)));
  };

  /**
   * Аудитория в целевом слоте: сначала пробуем оставить свою, а если её заняли —
   * ищем свободную с тем же оснащением и кафедрой. `freeIds` — занятия, которые
   * из слота уедут (шаг цепочки), их аудитории считаются свободными.
   * @returns {string[]|null} null — подходящей аудитории нет
   */
  function pickRooms(l, day, p, w, freeIds) {
    const skip = freeIds || new Set();
    const busy = new Set();
    for (const o of at(day, p, w)) {
      if (o.id === l.id || skip.has(o.id)) continue;
      for (const r of roomsOf(o)) busy.add(r);
    }
    const cur = roomsOf(l);
    if (!cur.length) return []; // занятие без аудитории — переносим как есть
    if (cur.every((r) => !busy.has(r))) return cur.slice();
    if (cur.length > 1) return null; // двойную аудиторию переподбирать не берёмся

    // Своя аудитория занята — заменяем только «той же породы»: та же кафедра, то
    // же оснащение (примечание), известная вместимость, группа помещается. Без
    // этих условий подбор уезжал в помещения вроде «Хранилище 1/85» — формально
    // свободные, а по смыслу не учебные аудитории.
    const need = ctx.needOf(l);
    const note = ref.roomNote[cur[0]] || null;
    const dept = ref.roomDept[cur[0]] || null;
    if (!dept) return null;
    const free = [...ref.rooms]
      .filter((r) => !busy.has(r) && !ref.roomHidden.has(r) && ctx.courseOK(r, l.groups || [])
        && (ref.roomDept[r] || null) === dept
        && (ref.roomNote[r] || null) === note
        && ref.roomCapacity[r] > 0 && (!need || ref.roomCapacity[r] >= need))
      .map((r) => ({ name: r, capacity: ref.roomCapacity[r] }));
    if (!free.length) return null;
    free.sort(roomFitCmp(need)); // мест ближе всего к числу курсантов
    return [free[0].name];
  }

  // «Дырки» в дне группы: сколько свободных пар между первой и последней занятой.
  // addPair — пара, которую собираемся занять; skipId — занятие, которое уедет.
  function dayShape(groups, day, w, skipId, addPair) {
    const busy = [];
    for (let p = 1; p <= PAIRS_PER_DAY; p++) {
      const taken = p === addPair
        || at(day, p, w).some((o) => o.id !== skipId && (o.groups || []).some((g) => groups.includes(g)));
      if (taken) busy.push(p);
    }
    const gaps = busy.length < 2 ? 0 : busy[busy.length - 1] - busy[0] + 1 - busy.length;
    return { gaps, count: busy.length };
  }

  const dayIndex = (d) => WORK_DAYS.indexOf(d);

  /**
   * Все годные цели для занятия, от лучшей к худшей.
   * @param {object} l занятие
   * @param {{allowChain?:boolean, forbid?:Set<string>}} opts
   */
  function findVariants(l, opts = {}) {
    const allowChain = opts.allowChain !== false;
    const forbid = opts.forbid || new Set();
    const groups = l.groups || [];
    const from = Math.max(1, l.weekNo - WEEK_SPAN);
    const to = weeks ? Math.min(weeks, l.weekNo + WEEK_SPAN) : l.weekNo + WEEK_SPAN;
    const out = [];

    for (let w = from; w <= to; w++) {
      for (const day of WORK_DAYS) {
        if (!ctx.isWorkday(day, w)) continue;
        const before = dayShape(groups, day, w, l.id, null);
        for (const p of TARGET_PAIRS) {
          const k = slotKey(day, p, w);
          if (forbid.has(k)) continue;
          if (day === l.day && p === l.pairNo && w === l.weekNo) continue;
          if (ctx.inSession(l, day, p, w)) continue;
          if (!groupsFree(l, day, p, w)) continue;

          const blockers = teacherBlockers(l, day, p, w);
          // Двоих сразу не разбираем: цепочка — ровно один шаг (глубина 1).
          if (blockers.length > 1 || (blockers.length && !allowChain)) continue;
          let chain = null;
          if (blockers.length === 1) {
            chain = chainVariant(blockers[0], k);
            if (!chain) continue;
          }

          const rooms = pickRooms(l, day, p, w, chain ? new Set([chain.lessonId]) : null);
          if (rooms === null) continue;

          const after = dayShape(groups, day, w, l.id, p);
          // Пустой у группы день: приехать ради одной пары — так себе размен.
          const shape = (after.gaps - before.gaps) + (before.count === 0 ? 2 : 0);
          const kept = roomsOf(l).join(',') === rooms.join(',');
          const cost = (chain ? 100 : 0) + shape * 10 + Math.abs(w - l.weekNo) * 3
            + (kept ? 0 : 1) + dayIndex(day) * 0.1 + p * 0.01;

          out.push({
            toDay: day, toPair: p, toWeek: w, toDate: lessonDate(w, day, ctx.semester),
            rooms, toRoom: rooms.join(', ') || null, keptRoom: kept, chain, cost,
          });
        }
      }
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  }

  // Куда уедет мешающее занятие. Считается один раз на занятие: цели у него свои
  // (±2 недели от ЕГО недели), от нашего слота зависит только запрет встать на него.
  const chainCache = new Map();
  function chainVariant(other, ourKey) {
    if (!chainCache.has(other.id)) {
      chainCache.set(other.id, isMovable(other) ? findVariants(other, { allowChain: false }) : []);
    }
    const v = chainCache.get(other.id).find((x) => slotKey(x.toDay, x.toPair, x.toWeek) !== ourKey);
    if (!v) return null;
    return {
      lessonId: other.id,
      subject: other.subject || '', type: other.type || '',
      teacher: other.teacher || '', groups: other.groups || [],
      day: other.day, pairNo: other.pairNo, weekNo: other.weekNo,
      room: roomsOf(other).join(', ') || null,
      toDay: v.toDay, toPair: v.toPair, toWeek: v.toWeek, toDate: v.toDate,
      rooms: v.rooms, toRoom: v.toRoom,
    };
  }

  // Занятия группы на 4-й паре, которые вообще можно двигать.
  const sources = live.filter((l) => l.pairNo === SOURCE_PAIR && WORK_DAYS.includes(l.day)
    && (l.groups || []).includes(name) && isMovable(l));

  // Первый проход — все варианты без учёта конкуренции.
  const scanned = sources.map((l) => ({ lesson: l, variants: findVariants(l) }));
  // Окон в парах 1–3 мало, и предложения соревнуются за одни и те же. Идём от
  // самых стеснённых занятий к самым свободным: у кого выбора почти нет, тот
  // получает своё окно первым.
  scanned.sort((a, b) => a.variants.length - b.variants.length
    || a.lesson.weekNo - b.lesson.weekNo || dayIndex(a.lesson.day) - dayIndex(b.lesson.day));

  // Второй проход — раздача окон. Занятое предложением место больше никому не
  // предлагается, поэтому «Применить всё отмеченное» безопасно.
  // ponytail: слот, который занятие освобождает, другим не предлагается —
  // жадность без пересчёта. Если окажется мало, здесь встанет второй проход.
  const takenGroup = new Set();
  const takenTeacher = new Set();
  const takenRoom = new Set();
  const usedLessons = new Set();

  const stamp = (l, v) => {
    const k = (x) => `${x}|${slotKey(v.toDay, v.toPair, v.toWeek)}`;
    for (const g of (l.groups || [])) takenGroup.add(k(g));
    for (const t of teachersOf(l)) takenTeacher.add(k(t));
    for (const r of (v.rooms || [])) takenRoom.add(k(r));
  };
  const fits = (l, v) => {
    const k = (x) => `${x}|${slotKey(v.toDay, v.toPair, v.toWeek)}`;
    if ((l.groups || []).some((g) => takenGroup.has(k(g)))) return false;
    if (teachersOf(l).some((t) => takenTeacher.has(k(t)))) return false;
    if ((v.rooms || []).some((r) => takenRoom.has(k(r)))) return false;
    return true;
  };

  const items = [];
  for (const { lesson: l, variants } of scanned) {
    if (usedLessons.has(l.id)) continue;
    const free = variants.filter((v) => {
      if (!fits(l, v)) return false;
      if (!v.chain) return true;
      if (usedLessons.has(v.chain.lessonId)) return false;
      const other = live.find((o) => o.id === v.chain.lessonId);
      return other ? fits(other, { rooms: v.chain.rooms, toDay: v.chain.toDay, toPair: v.chain.toPair, toWeek: v.chain.toWeek }) : false;
    });
    if (!free.length) continue;

    const options = free.slice(0, MAX_OPTIONS);
    const pick = options[0];
    items.push({
      kind: 'relief',
      key: `R${l.id}`,
      lessonId: l.id,
      subject: l.subject || '', type: l.type || '', topic: l.topic || '',
      teacher: l.teacher || '', groups: l.groups || [], need: ctx.needOf(l),
      day: l.day, pairNo: l.pairNo, weekNo: l.weekNo, date: l.date || null,
      room: roomsOf(l).join(', ') || null,
      ...pick,
      options,
    });
    usedLessons.add(l.id);
    stamp(l, pick);
    if (pick.chain) {
      usedLessons.add(pick.chain.lessonId);
      const other = live.find((o) => o.id === pick.chain.lessonId);
      if (other) stamp(other, { rooms: pick.chain.rooms, toDay: pick.chain.toDay, toPair: pick.chain.toPair, toWeek: pick.chain.toWeek });
    }
  }

  return {
    ok: true,
    group: name,
    items,
    total: sources.length,
    placed: items.length,
    chains: items.filter((i) => i.chain).length,
  };
}

// Ходы предложения: сначала уезжает чужая пара (если есть), потом наша.
function stepsOf(item) {
  const out = [];
  const c = item.chain;
  if (c) {
    out.push({
      lessonId: c.lessonId, fromDay: c.day, fromPair: c.pairNo, fromWeek: c.weekNo,
      day: c.toDay, pairNo: c.toPair, weekNo: c.toWeek, rooms: c.rooms || [],
    });
  }
  out.push({
    lessonId: item.lessonId, fromDay: item.day, fromPair: item.pairNo, fromWeek: item.weekNo,
    day: item.toDay, pairNo: item.toPair, weekNo: item.toWeek, rooms: item.rooms || [],
  });
  return out;
}

/**
 * Применяет выбранные предложения. Каждое проверяется заново на свежих данных:
 * устаревшее (окно успели занять, занятие уже переставили) попадает в skipped, а
 * не создаёт накладку. Цепочка применяется целиком или не применяется вовсе.
 * Откат — одной кнопкой «Отменить» (снимок всех затронутых занятий).
 */
function applyPair4Relief(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: false, code: 400, reasons: ['Не выбрано ни одного предложения'] };

  return transaction((db) => {
    const ctx = buildContext(db);
    const { ref, live } = ctx;
    // Копия занятий для проверки: второй шаг цепочки должен проверяться уже
    // против картины, в которой первый шаг выполнен.
    const sim = live.map((l) => ({ ...l }));
    const simById = new Map(sim.map((l) => [l.id, l]));
    const origById = new Map(live.map((l) => [l.id, l]));

    const snapshots = [];
    const changes = [];
    let skipped = 0;

    for (const item of list) {
      const steps = stepsOf(item || {});
      const rollback = [];
      let ok = steps.length > 0;

      for (const st of steps) {
        const L = simById.get(Number(st.lessonId));
        if (!L || !isMovable(L)) { ok = false; break; }
        // Занятие уже переставили — предложение устарело.
        if (L.day !== st.fromDay || Number(L.pairNo) !== Number(st.fromPair) || Number(L.weekNo) !== Number(st.fromWeek)) {
          ok = false;
          break;
        }
        const target = { day: st.day, pairNo: Number(st.pairNo), weekNo: Number(st.weekNo), rooms: (st.rooms || []).slice() };
        if (!WORK_DAYS.includes(target.day) || !TARGET_PAIRS.includes(target.pairNo)) { ok = false; break; }
        if (!ctx.isWorkday(target.day, target.weekNo)) { ok = false; break; }
        if (ctx.inSession(L, target.day, target.pairNo, target.weekNo)) { ok = false; break; }

        const check = validateMove(L, target, {
          lessons: sim, roomCapacity: ref.roomCapacity, groupHeadcount: ref.groupHeadcount,
        });
        // Занятая аудитория — «мягкое» замечание, но молча создавать накладку
        // разгрузка не должна: такое предложение пропускаем. А вот нехватка мест
        // — свойство пары «занятие + его аудитория», перенос по времени её не
        // создаёт: занятие приехало со своей аудиторией, с которой и стояло.
        if (!check.ok || (check.warnings || []).some((wr) => /занят/i.test(wr))) { ok = false; break; }

        rollback.push({ ...L });
        Object.assign(L, {
          day: target.day, pairNo: target.pairNo, weekNo: target.weekNo,
          rooms: target.rooms.slice(), room: target.rooms[0] || null,
        });
      }

      if (!ok) {
        for (const before of rollback.reverse()) Object.assign(simById.get(before.id), before);
        skipped++;
        continue;
      }
      for (const st of steps) {
        const before = origById.get(Number(st.lessonId));
        const snap = lessonSnapshot(before);
        // Журнал переносов тоже возвращается «Отменить» — иначе остался бы след
        // переноса, которого больше нет (см. restoreMoveLog в undoService).
        snap.moveLogBefore = moveLogChain(db, before.id);
        snapshots.push(snap);
        changes.push({ before, day: st.day, pairNo: Number(st.pairNo), weekNo: Number(st.weekNo), rooms: (st.rooms || []).slice() });
      }
    }

    if (!changes.length) return { ok: true, applied: 0, skipped };

    pushUndo(db, 'deleteEntity', `Разгрузка 4-й пары (${changes.length} занятий)`, { snapshots });

    const upd = db.prepare(
      `UPDATE lessons SET day = ?, pair_no = ?, week_no = ?, time_start = ?, time_end = ?, room_id = ?, parked = 0, orphan = 0
       WHERE id = ?`
    );
    for (const ch of changes) {
      const times = PAIR_TIMES[ch.pairNo] || { start: null, end: null };
      const ids = ch.rooms.map((n) => getOrCreate(db, 'rooms', 'name', n));
      upd.run(ch.day, ch.pairNo, ch.weekNo, times.start, times.end, ids[0] ?? null, ch.before.id);
      setLessonRoomsRows(db, ch.before.id, ids);
      logMove(db, ch.before, { day: ch.day, pairNo: ch.pairNo, weekNo: ch.weekNo, room: ch.rooms.join(', ') || null });
    }
    return { ok: true, applied: changes.length, skipped };
  });
}

module.exports = { suggestPair4Relief, applyPair4Relief };
