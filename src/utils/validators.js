'use strict';

// Чистые функции проверки расписания. Работают над массивом «занятий» вида:
//   { id, day, pairNo, weekNo, subject, type, teacher, room, groups: string[] }
// и справочниками вместимости/численности. Без побочных эффектов и без БД.

// Классификатор формы контроля (зачёт/экзамен) — общий с фронтендом.
const { assessmentKind } = require('../../public/js/shared-constants.js');

const slotKey = (l) => `${l.day}|${l.pairNo}|${l.weekNo}`;

// Все преподаватели занятия. У зачётов/экзаменов их несколько (l.teachers); для
// обычных — основной (l.teacher). Так накладки/ссылки проверяются по каждому.
const teachersOf = (l) =>
  Array.isArray(l.teachers) && l.teachers.length ? l.teachers : l.teacher ? [l.teacher] : [];

// Все аудитории занятия (1 или 2). Источник — l.rooms[]; для совместимости —
// одиночная l.room. Накладки/вместимость/ссылки проверяются по каждой.
const roomsOf = (l) =>
  Array.isArray(l.rooms) && l.rooms.length ? l.rooms : l.room ? [l.room] : [];

// Исключение для физподготовки. Приём зачёта/экзамена по ФП идёт там же, где и
// обычное занятие ФП (спортзал/стадион), поэтому преподаватель физически может
// вести оба сразу: у одной группы контроль, у другой — пара. Условие: ВСЕ
// столкнувшиеся занятия по ФП и хотя бы одно из них — форма контроля. Две
// обычные пары ФП у разных групп так по-прежнему не совместить.
const isPhys = (l) =>
  /физ/i.test(String(l.subjectFull || '')) || String(l.subject || '').trim().toUpperCase() === 'ФП';
const physTeacherOk = (ls) => ls.every(isPhys) && ls.some((l) => assessmentKind(l.type));

/**
 * Ищет накладки преподавателя / группы / аудитории в одном слоте
 * (день + пара + неделя). Потоковое занятие (одно занятие — много групп)
 * накладкой НЕ считается: это одна запись.
 * @returns {Array<{kind, slot, lessonIds, key, detail}>}
 */
function findOverlaps(lessons) {
  const conflicts = [];
  const buckets = new Map();
  for (const l of lessons) {
    const k = slotKey(l);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }

  for (const [k, group] of buckets) {
    if (group.length < 2) continue;
    const slot = { day: group[0].day, pairNo: group[0].pairNo, weekNo: group[0].weekNo };

    collide(group, teachersOf, (key, ids) => {
      // Совмещение ФП (контроль + занятие) ошибкой не считается — см. physTeacherOk.
      if (physTeacherOk(group.filter((l) => ids.includes(l.id)))) return;
      conflicts.push({ kind: 'teacher', slot, lessonIds: ids, key: k, detail: `Преподаватель «${key}» занят дважды` });
    });
    
    // Аудитории: проверяем наложение, но разрешаем совмещение занятий, если все они — 'СР'
    const byRoom = new Map();
    for (const l of group) {
      for (const r of roomsOf(l)) {
        if (!byRoom.has(r)) byRoom.set(r, []);
        byRoom.get(r).push(l);
      }
    }
    for (const [r, lgroup] of byRoom) {
      if (lgroup.length > 1) {
        if (!lgroup.every((l) => l.subject === 'СР')) {
          conflicts.push({ kind: 'room', slot, lessonIds: lgroup.map((l) => l.id), key: k, detail: `Аудитория «${r}» занята дважды` });
        }
      }
    }
    
    collide(group, (l) => l.groups || [], (key, ids) =>
      conflicts.push({ kind: 'group', slot, lessonIds: ids, key: k, detail: `Группа «${key}» стоит на двух занятиях` })
    );
  }
  return conflicts;
}

// Внутри одного слота: группирует занятия по значениям key(l) и репортит
// те значения, что встречаются у >1 РАЗНЫХ занятий.
function collide(group, keysOf, report) {
  const byValue = new Map();
  for (const l of group) {
    for (const v of keysOf(l)) {
      if (!byValue.has(v)) byValue.set(v, new Set());
      byValue.get(v).add(l.id);
    }
  }
  for (const [v, ids] of byValue) {
    if (ids.size > 1) report(v, [...ids]);
  }
}

/**
 * Проверка вместимости: число курсантов (сумма по группам, для потока — всех)
 * не должно превышать вместимость аудитории.
 * @param {object} lesson
 * @param {{roomCapacity:Map|object, groupHeadcount:Map|object}} ref
 * @returns {null | {kind, lessonId, room, capacity, required, detail}}
 */
function checkCapacity(lesson, ref) {
  const rooms = roomsOf(lesson);
  if (!rooms.length) return null;

  // Для двух аудиторий курсанты распределяются между ними — считаем суммарную
  // вместимость. Если ни одной вместимости не задано — не проверяем.
  let capacity = 0;
  let capKnown = false;
  for (const rm of rooms) {
    const c = lookup(ref.roomCapacity, rm);
    if (c != null) {
      capacity += c;
      capKnown = true;
    }
  }
  if (!capKnown) return null;

  let required = 0;
  let known = false;
  for (const g of lesson.groups || []) {
    const h = lookup(ref.groupHeadcount, g);
    if (h != null) {
      required += h;
      known = true;
    }
  }
  if (!known) return null;
  // capacitySlack — согласованное превышение мест (используется авторасстановкой СР,
  // где несколько человек могут заниматься за приставными местами).
  if (required <= capacity + (ref.capacitySlack || 0)) return null;

  const label = rooms.join(', ');
  return {
    kind: 'capacity',
    lessonId: lesson.id,
    room: label,
    capacity,
    required,
    detail: `Аудитори${rooms.length > 1 ? 'й' : 'и'} «${label}» (${capacity}) мало для ${required} курсантов`,
  };
}

/**
 * Проверка ссылочной целостности занятия: существуют ли его группа(ы),
 * преподаватель и аудитория в справочниках.
 * @param {object} lesson
 * @param {{rooms:Set, teachers:Set, groups:Set}} known
 * @returns {Array<{kind:'ref', lessonId, field, value, detail}>}
 */
function checkReferences(lesson, known) {
  const out = [];
  for (const rm of roomsOf(lesson)) {
    if (known.rooms && !has(known.rooms, rm)) {
      out.push(ref(lesson, 'room', rm, `Несуществующая аудитория «${rm}»`));
    }
  }
  for (const tn of teachersOf(lesson)) {
    if (known.teachers && !has(known.teachers, tn)) {
      out.push(ref(lesson, 'teacher', tn, `Несуществующий преподаватель «${tn}»`));
    }
  }
  for (const g of lesson.groups || []) {
    if (known.groups && !has(known.groups, g)) {
      out.push(ref(lesson, 'group', g, `Несуществующая группа «${g}»`));
    }
  }
  return out;
}

function ref(lesson, field, value, detail) {
  return { kind: 'ref', lessonId: lesson.id, field, value, detail };
}

/**
 * Кандидаты на «разные сокращения одной дисциплины». Занятия, у которых
 * совпадают группы, слот (день+пара+неделя) и аудитории, но РАЗЛИЧАЕТСЯ
 * сокращение дисциплины — это, скорее всего, один физический слот, попавший в
 * базу дважды из-за разнобоя сокращений (slotKey импорта включает subject).
 * Агрегируем по множеству вариантов сокращений, чтобы пара (ИЭП/ИРТС)
 * показывалась один раз, а не на каждом слоте.
 * @param {object[]} lessons
 * @returns {Array<{subjects:{abbr,fullName}[], occurrences:number, lessonIds:number[], sample:object}>}
 */
function findAliasCandidates(lessons) {
  // Бакеты по группы+слот+аудитории.
  const buckets = new Map();
  for (const l of lessons) {
    if (!l.subject) continue;
    const k = [
      (l.groups || []).slice().sort().join(','),
      l.day, l.pairNo, l.weekNo,
      roomsOf(l).slice().sort().join(','),
    ].join('|');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }

  // По кластерам с разными сокращениями агрегируем по набору вариантов.
  const byVariants = new Map();
  for (const group of buckets.values()) {
    const subjects = [...new Set(group.map((l) => l.subject))];
    if (subjects.length < 2) continue;
    const vkey = subjects.slice().sort().join('|');
    let agg = byVariants.get(vkey);
    if (!agg) {
      const full = {};
      for (const l of group) if (l.subject && !full[l.subject]) full[l.subject] = l.subjectFull || null;
      const first = group[0];
      agg = {
        subjects: subjects.map((abbr) => ({ abbr, fullName: full[abbr] || null })),
        occurrences: 0,
        lessonIds: [],
        sample: {
          groups: first.groups || [],
          day: first.day, pairNo: first.pairNo, weekNo: first.weekNo,
          rooms: roomsOf(first),
        },
      };
      byVariants.set(vkey, agg);
    }
    agg.occurrences += 1;
    for (const l of group) agg.lessonIds.push(l.id);
  }
  return [...byVariants.values()];
}

// Самоподготовка — заполнитель свободного окна, а не занятость: занятие ставится
// прямо на её место, а попавшие группы из СР убираются (displaceSelfStudy в
// scheduleService). Забронированную СР не трогаем. Нормализация имени — как у
// isSelfStudyType в conflictService («СР.», «ср» — тоже СР).
const isDisplaceableSr = (l) =>
  !l.event && !l.locked && /^ср$/.test(String(l.subject || '').trim().replace(/[.\s]+$/, '').toLowerCase());

/**
 * Проверяет допустимость переноса занятия в новый слот/аудиторию.
 * Все проверки — относительно ОСТАЛЬНЫХ занятий (само переносимое исключается).
 *
 * Проверки делятся на два класса:
 *  - reasons  — ЖЁСТКИЙ запрет: преподаватель или группа уже заняты в этом слоте
 *               (человек физически не может быть в двух местах);
 *  - warnings — ПРЕДУПРЕЖДЕНИЕ: аудитория занята другим занятием или мест в ней
 *               меньше, чем курсантов. Такое размещение допускается по решению
 *               составителя (подтверждение спрашивает интерфейс).
 *
 * @param {object} lesson переносимое занятие (с id)
 * @param {{day, pairNo, weekNo, room}} target целевой слот/аудитория
 * @param {{lessons:object[], roomCapacity, groupHeadcount, capacitySlack?:number}} ctx
 *        capacitySlack — допустимое превышение мест (для авторасстановки СР)
 * @returns {{ok:boolean, reasons:string[], warnings:string[]}}
 */
function validateMove(lesson, target, ctx) {
  const reasons = [];
  const warnings = [];
  // Целевые аудитории: target.rooms[] (1–2) или одиночная target.room; иначе —
  // прежние аудитории занятия.
  const targetRooms =
    Array.isArray(target.rooms) ? target.rooms.filter(Boolean)
      : target.room != null ? (target.room ? [target.room] : [])
        : roomsOf(lesson);
  const moved = {
    ...lesson,
    day: target.day,
    pairNo: target.pairNo,
    weekNo: target.weekNo,
    rooms: targetRooms,
    room: targetRooms[0] || null,
  };
  const others = ctx.lessons.filter((l) => l.id !== lesson.id);
  const sameSlot = others.filter((l) => slotKey(l) === slotKey(moved));
  // СР целевого слота вытесняется занятием: у попавших групп её снимут, поэтому
  // занятостью группы она не считается. Ту, что группы забирают ЦЕЛИКОМ, удалят
  // вместе с аудиторией — такая аудитория тоже свободна. Усечённый поток СР
  // аудиторию сохраняет: оставшиеся группы продолжают там сидеть.
  const ousted = new Set(sameSlot
    .filter((l) => isDisplaceableSr(l) && (l.groups || []).some((g) => (moved.groups || []).includes(g)))
    .map((l) => l.id));
  const vacated = new Set(sameSlot
    .filter((l) => ousted.has(l.id) && (l.groups || []).every((g) => (moved.groups || []).includes(g)))
    .map((l) => l.id));

  for (const tn of teachersOf(moved)) {
    const busy = sameSlot.filter((l) => teachersOf(l).includes(tn));
    if (!busy.length) continue;
    // ФП: контроль у одной группы + занятие у другой — не запрет, а предупреждение.
    if (physTeacherOk([moved, ...busy])) {
      warnings.push(`Преподаватель «${tn}» уже занят в это время (ФП: приём зачёта/экзамена и занятие)`);
    } else {
      reasons.push(`Преподаватель «${tn}» уже занят в это время`);
    }
  }
  for (const rm of targetRooms) {
    const colliding = sameSlot.filter((l) => roomsOf(l).includes(rm) && !vacated.has(l.id));
    if (colliding.length > 0) {
      if (moved.subject === 'СР' && colliding.every((l) => l.subject === 'СР')) {
        const cap = ctx.roomCapacity && ctx.roomCapacity[rm] ? ctx.roomCapacity[rm] : 0;
        let req = 0;
        for (const g of moved.groups || []) req += (ctx.groupHeadcount && ctx.groupHeadcount[g] ? ctx.groupHeadcount[g] : 0);
        for (const l of colliding) {
          for (const g of l.groups || []) req += (ctx.groupHeadcount && ctx.groupHeadcount[g] ? ctx.groupHeadcount[g] : 0);
        }
        // Только если известна вместимость аудитории (cap > 0) проверяем переполнение.
        // capacitySlack — согласованное превышение (авторасстановка СР).
        if (cap > 0 && req > cap + (ctx.capacitySlack || 0)) {
          warnings.push(`Совмещение СР в «${rm}» превысит вместимость (${req} > ${cap})`);
        }
      } else {
        warnings.push(`Аудитория «${rm}» уже занята в это время`);
      }
    }
  }
  for (const g of moved.groups || []) {
    if (sameSlot.some((l) => !ousted.has(l.id) && (l.groups || []).includes(g))) {
      reasons.push(`Группа «${g}» уже занята в это время`);
    }
  }

  const cap = checkCapacity(moved, {
    roomCapacity: ctx.roomCapacity || {},
    groupHeadcount: ctx.groupHeadcount || {},
    capacitySlack: ctx.capacitySlack || 0,
  });
  if (cap) warnings.push(cap.detail);

  return { ok: reasons.length === 0, reasons, warnings };
}

/* --------------------------- helpers --------------------------- */

function lookup(store, key) {
  if (store == null) return null;
  const v = store instanceof Map ? store.get(key) : store[key];
  return v == null ? null : v;
}

function has(store, key) {
  return store instanceof Set || store instanceof Map ? store.has(key) : Object.prototype.hasOwnProperty.call(store, key);
}

module.exports = { slotKey, findOverlaps, checkCapacity, checkReferences, validateMove, findAliasCandidates, physTeacherOk, isDisplaceableSr };
