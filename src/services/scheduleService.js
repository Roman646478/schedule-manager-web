'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeSnapshot, readSnapshot } = require('./snapshotStore');
const { sortTopics } = require('./topicOrderService');

const { getDb } = require('../config/database');
const { transaction, getOrCreate, clearAll } = require('./dbService');
const { loadLessons, loadReference, validateMoveById, sessionKind, examPrepDays, isSelfStudyType, isPhysTraining, isEcs, LOCKED_REASON, getSessionCalendar, buildSessionSchedule } = require('./conflictService');
const { getSetting, setSetting, getSemester, getCourses, getHolidays, getGroupSubjects, setGroupSubjects, getTypeLegend, getLessonTypes } = require('./settingsService');
const { lessonDate, lessonDateISO, week1Monday, weekCount } = require('../utils/calendar');
const { teacherFio } = require('../utils/helpers');
const { PAIR_TIMES, PUBLIC_DB_PATH, DAYS, PAIRS_PER_DAY } = require('../utils/constants');
const { validateMove, physTeacherOk, isDisplaceableSr } = require('../utils/validators');
const { isPracticalType } = require('../utils/lessonTypes');
const { roomFitCmp, movedKey } = require(path.join(__dirname, '..', '..', 'public', 'js', 'shared-constants.js'));
const { pushUndo } = require('./undoService');
const { allGroupsSummary } = require('./curriculumService');
const { slotErrors, lessonFieldErrors, invalidInput } = require('../utils/lessonInput');
const { getScheduleGeneration } = require('../config/accessDatabase');

// Снимок состояния занятия для стека отмены.
function lessonSnapshot(l) {
  return {
    id: l.id,
    day: l.day,
    pairNo: l.pairNo,
    weekNo: l.weekNo,
    subject: l.subject ?? null,
    type: l.type ?? null,
    topic: l.topic ?? null,
    note: l.note ?? null,
    room: l.room ?? null,
    rooms: (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : [])).slice(),
    teacher: l.teacher ?? null,
    teachers: (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : [])).slice(),
    // groupsAll — полный состав метки ЭкзС, часть групп которой скрыта занятием
    // (hideCoveredEcs). Снимок должен возвращать метку целиком.
    groups: (l.groupsAll || l.groups || []).slice(),
    parked: l.parked ?? 0,
    orphan: l.orphan ? 1 : 0, // не размещённое при импорте — восстанавливается тем же флагом
    locked: l.locked ? 1 : 0, // бронь восстанавливается вместе с занятием (undo)
    category: l.category || (l.event ? 'event' : 'lesson'),
    revision: Number(l.revision || 0),
  };
}

/**
 * Занятие встаёт на место СР. Самоподготовка — заполнитель свободного окна, а не
 * занятость (см. isDisplaceableSr): у попавших групп её снимаем, причём в потоке
 * ТОЛЬКО у них — остальные группы продолжают сидеть в своей аудитории. Запись,
 * у которой групп не осталось, удаляем: её аудитория освобождается. Обратно СР
 * сама не возвращается — вернуть её можно «Отменить» или повторной расстановкой.
 * ponytail: тот же приём, что и в deleteEntitySchedule (удаление группы из потока).
 * @param {number|null} skipId id занятия, которое само сейчас правится/переносится:
 *   правка аудитории у СР не должна удалять эту же СР (её слот и группы совпадают).
 * @returns {object[]} снимки затронутых СР для стека отмены (пусто — СР не было)
 */
function displaceSelfStudy(db, lessons, groups, slot, skipId = null) {
  const want = new Set(groups || []);
  if (!want.size) return [];
  const snaps = [];
  for (const l of lessons) {
    if (skipId != null && l.id === skipId) continue; // сама СР себя не вытесняет
    if (l.parked || !isDisplaceableSr(l)) continue;
    if (l.day !== slot.day || l.pairNo !== Number(slot.pairNo) || l.weekNo !== Number(slot.weekNo)) continue;
    const hit = (l.groups || []).filter((g) => want.has(g));
    if (!hit.length) continue;
    snaps.push(lessonSnapshot(l));
    if (hit.length === (l.groups || []).length) {
      db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
    } else {
      const del = db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ? AND group_id = ?');
      for (const g of hit) del.run(l.id, getOrCreate(db, 'groups', 'name', g));
    }
  }
  return snaps;
}

// Нормализует целевые аудитории переноса/правки: массив rooms[] (1–2) или
// одиночная room; если ничего не задано — прежние аудитории занятия (before).
function targetRooms(target, before) {
  let list;
  if (Array.isArray(target.rooms)) list = target.rooms;
  else if (target.room != null) list = target.room ? [target.room] : [];
  else list = (before && before.rooms) || [];
  return [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))];
}

// Нормализует аудитории из тела запроса (создание/правка): массив rooms[] или
// одиночная room. Возвращает до 2 уникальных непустых имён.
function inputRooms(data) {
  const list = Array.isArray(data.rooms) ? data.rooms : data.room != null ? [data.room] : [];
  return [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 2);
}

// Записывает аудитории занятия в lesson_rooms (room_id основной выставляется
// отдельно в UPDATE вызывающей функции). roomIds — массив id (1–2), без дублей.
function setLessonRoomsRows(db, lessonId, roomIds) {
  db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?').run(lessonId);
  const ins = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
  for (const id of roomIds) if (id != null) ins.run(lessonId, id);
}

// Проверяет, попадает ли слот (weekNo, day) на нерабочий день; если да — возвращает
// текстовое предупреждение (мягкое: занятие всё равно сохраняется).
function holidayWarning(weekNo, day, semester, holidays) {
  const iso = lessonDateISO(weekNo, day, semester);
  return iso && holidays.has(iso) ? `${day} н${weekNo} — нерабочий день` : null;
}

// Списки сущностей для селекторов представлений. Скрытые (hidden=1) группы и
// аудитории из селектора исключаются — отдельно их посмотреть нельзя, но их
// занятия остаются в расписаниях других групп/аудиторий/преподавателей.
function listEntities(db = getDb()) {
  return {
    groups: db.prepare('SELECT name FROM groups WHERE hidden = 0 ORDER BY name').all().map((r) => r.name),
    teachers: db.prepare('SELECT name FROM teachers ORDER BY name').all().map((r) => r.name),
    rooms: db.prepare('SELECT name FROM rooms WHERE hidden = 0 ORDER BY name').all().map((r) => r.name),
    // Справка для подписи аудитории в селекторе просмотра (см. roomLabel в
    // shared-constants.js). rooms остаётся списком имён — его ждёт остальной код.
    roomsInfo: db.prepare('SELECT name, capacity, dept, note FROM rooms WHERE hidden = 0 ORDER BY name').all(),
    // Дисциплины, у которых есть занятия, — для представления «Дисциплина».
    subjects: db.prepare(
      `SELECT DISTINCT subject FROM lessons
        WHERE subject IS NOT NULL AND subject <> '' AND parked = 0
          AND (category IS NULL OR category <> 'event')
        ORDER BY subject COLLATE NOCASE`
    ).all().map((r) => r.subject),
  };
}

// Представление как выборка из единого источника: группа, преподаватель,
// аудитория или дисциплина (последнее — просмотр всей дисциплины сразу, группы
// отбираются уже на клиенте).
// Отложенные в буфер (parked) в сетку не попадают — они в отдельном буфере.
// preloaded — готовый набор занятий (снимок публикации для гостевой выгрузки).
function getView(kind, id, db = getDb(), preloaded = null) {
  const lessons = (preloaded || loadLessons(db)).filter((l) => !l.parked);
  if (!id) return lessons;
  if (kind === 'group') return lessons.filter((l) => l.groups.includes(id));
  if (kind === 'teacher') return lessons.filter((l) => (l.teachers || []).includes(id) || l.teacher === id);
  if (kind === 'room') return lessons.filter((l) => (l.rooms || []).includes(id) || l.room === id);
  if (kind === 'subject') return lessons.filter((l) => l.subject === id && l.category !== 'event');
  return lessons;
}

// Занятия в буфере (отложенные вручную). Показываются полосой справа.
// Не размещённые при импорте (orphan) сюда не попадают — у них своя полоса.
function getParked(db = getDb()) {
  return loadLessons(db).filter((l) => l.parked && !l.orphan);
}

// Не размещённые при импорте: пары преподавателя, попавшие на «ЭкзС» группы.
// Хранятся вне сетки (parked = 1), показываются отдельной полосой под сеткой.
function getOrphans(db = getDb()) {
  return loadLessons(db).filter((l) => l.orphan);
}

// Мягкие замечания проверки (занятая аудитория, нехватка посадочных мест) не
// запрещают размещение — их подтверждает составитель. Пока подтверждения нет
// (force !== true), возвращаем их отдельным ответом: интерфейс спрашивает
// «всё равно поставить?» и повторяет запрос с force: true.
// Возвращает null, если подтверждать нечего.
function confirmable(check, force) {
  const warnings = (check && check.warnings) || [];
  if (!warnings.length || force === true) return null;
  return { ok: false, code: 409, confirm: true, warnings, reasons: warnings };
}

// Поток объединяет группы ОДНОГО курса: ФП у 1-го и 4-го курса в одном зале —
// два разных занятия со своими преподавателями. Смесь курсов в одном занятии —
// предупреждение (решение за составителем), а не запрет.
function mixedCourseWarning(groups, db) {
  const courses = getCourses(db);
  const set = new Set((groups || []).map((g) => courses[groupPrefix(g)]).filter((c) => c != null));
  return set.size > 1 ? `Группы разных курсов (${[...set].sort().join(', ')}) в одном занятии` : null;
}

// Отложить занятие в буфер: убираем из сетки, слот освобождается.
function parkLesson(lessonId, db = getDb()) {
  const res = db.prepare('UPDATE lessons SET parked = 1 WHERE id = ?').run(lessonId);
  if (!res.changes) return { ok: false, reasons: ['Занятие не найдено'] };
  return { ok: true };
}

// Бронь занятия: пока стоит, занятие нельзя перенести (запрет живёт в
// validateMoveById, editLesson и moveExam — всех путях смены слота). Правку
// полей и удаление бронь не трогает: она держит только МЕСТО в сетке.
function setLessonLocked(lessonId, locked, db = getDb()) {
  const res = db.prepare('UPDATE lessons SET locked = ? WHERE id = ?').run(locked ? 1 : 0, lessonId);
  if (!res.changes) return { ok: false, code: 404, reasons: ['Занятие не найдено'] };
  return { ok: true, locked: !!locked };
}

// Очистка буфера: удаляет все отложенные занятия. Откат — через undo
// ('deleteEntity' восстанавливает занятия из снимков, в т.ч. флаг parked).
function clearBuffer() {
  return transaction((db) => {
    const parked = loadLessons(db).filter((l) => l.parked);
    if (!parked.length) return { ok: false, code: 404, reasons: ['Буфер пуст'] };
    pushUndo(db, 'deleteEntity', `Очистка буфера (${parked.length} занятий)`, { snapshots: parked.map(lessonSnapshot) });
    const del = db.prepare('DELETE FROM lessons WHERE id = ?');
    for (const l of parked) del.run(l.id);
    return { ok: true, deleted: parked.length };
  });
}

// Очистка полосы «Не размещённые»: удаляет все занятия, не размещённые при
// импорте. Откат — через undo (тот же путь, что и очистка буфера).
function clearOrphans() {
  return transaction((db) => {
    const orphans = loadLessons(db).filter((l) => l.orphan);
    if (!orphans.length) return { ok: false, code: 404, reasons: ['Список пуст'] };
    pushUndo(db, 'deleteEntity', `Очистка не размещённых (${orphans.length} занятий)`, {
      snapshots: orphans.map(lessonSnapshot),
    });
    const del = db.prepare('DELETE FROM lessons WHERE id = ?');
    for (const l of orphans) del.run(l.id);
    return { ok: true, deleted: orphans.length };
  });
}

/**
 * Атомарный перенос занятия. Валидация и запись выполняются ВНУТРИ одной
 * транзакции: между проверкой и UPDATE никто не может занять слот (нет
 * TOCTOU-гонки). Все три представления меняются согласованно. Поток
 * (несколько групп у одной записи) переносится целиком.
 * @returns {{ok:boolean, reasons?:string[]}}
 */
function moveLesson(lessonId, target, actor = null) {
  const invalid = invalidInput([...slotErrors(target), ...lessonFieldErrors(target)]);
  if (invalid) return invalid;
  return transaction((tx) => {
    // Снимок занятия ДО переноса — для журнала (откуда переносим).
    const before = loadLessons(tx).find((l) => l.id === lessonId);

    const check = validateMoveById(lessonId, target, tx);
    if (!check.ok) return check;
    // Мягкие замечания (занятая аудитория, нехватка мест) не запрещают перенос,
    // но требуют подтверждения: без флага force возвращаем их интерфейсу.
    const soft = confirmable(check, target.force);
    if (soft) return soft;

    // В нерабочий день занятие не ставим (мероприятия — можно).
    if (before && !before.event &&
        holidayWarning(target.weekNo, target.day, getSemester(tx), new Set(getHolidays(tx)))) {
      return { ok: false, reasons: [`${target.day} н${target.weekNo} — нерабочий день (выходной)`] };
    }

    // Ячейка с СР — свободное окно: занятие встаёт на её место, попавшие группы
    // из самоподготовки уходят (в потоке — только они).
    const srSnaps = before ? displaceSelfStudy(tx, loadLessons(tx), before.groups, target, before.id) : [];

    const times = PAIR_TIMES[target.pairNo] || { start: null, end: null };
    // Аудитории цели: rooms[] (1–2) или одиночная room; если не заданы — прежние.
    const names = targetRooms(target, before);
    const ids = names.map((n) => getOrCreate(tx, 'rooms', 'name', n));
    // Перенос в слот всегда «достаёт» занятие из буфера и из «не размещённых».
    tx.prepare(
      `UPDATE lessons SET day = ?, pair_no = ?, week_no = ?, time_start = ?, time_end = ?, room_id = ?, parked = 0, orphan = 0
       WHERE id = ?`
    ).run(target.day, target.pairNo, target.weekNo, times.start, times.end, ids[0] ?? null, lessonId);
    setLessonRoomsRows(tx, lessonId, ids);

    if (before) {
      // Состояние журнала ДО переноса кладём в стек отмены: «Отменить»
      // возвращает не только занятие, но и журнал (иначе оставался бы след
      // переноса, которого больше нет). Снимаем ВСЮ цепочку шагов: перенос мог
      // не только добавить запись, но и стереть цепочку (возврат на импортное место).
      const logBefore = moveLogChain(tx, lessonId);
      const actionLogFloor = actor ? tx.prepare('SELECT COALESCE(MAX(id),0) AS id FROM move_log').get().id : 0;
      logMove(tx, before, { ...target, room: names.join(', ') || null });
      // Тот же слот, другая аудитория (выбор аудитории в окне переноса) — это не
      // перенос, а смена аудитории: своя запись журнала.
      const sameSlot = before.day === target.day
        && Number(before.pairNo) === Number(target.pairNo)
        && Number(before.weekNo) === Number(target.weekNo);
      if (sameSlot) logRoomChange(tx, before, before.rooms || (before.room ? [before.room] : []), names);
      const desc = `Перенос: ${before.subject || '?'} ${(before.groups || []).join(', ')} из ${before.day} п${before.pairNo} н${before.weekNo}`;
      const snap = { ...lessonSnapshot(before), moveLogBefore: logBefore };
      // Тронули СР — откатывать надо пачкой: 'deleteEntity' умеет и вернуть
      // изменённое занятие, и пере-вставить удалённое (см. undoService).
      if (srSnaps.length) pushUndo(tx, 'deleteEntity', desc, { snapshots: [snap, ...srSnaps] });
      else pushUndo(tx, 'move', desc, snap);
      if (actor) {
        const actionId = target.commandId || randomUUID();
        tx.prepare(
          `INSERT INTO move_actions(action_id, created_at, actor_user_id, actor_name, lesson_id, description, before_json, schedule_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username, lessonId, desc,
          JSON.stringify({ lesson: snap, displaced: srSnaps }), getScheduleGeneration());
        tx.prepare('UPDATE move_log SET action_id=? WHERE lesson_id=? AND id>?').run(actionId, lessonId, actionLogFloor);
        tx.prepare(
          `INSERT INTO move_action_events(action_id, happened_at, actor_user_id, actor_name, event)
           VALUES (?, ?, ?, ?, 'move')`
        ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username);
        check.actionId = actionId;
      }
    }

    const semester = getSemester(tx);
    const holidays = new Set(getHolidays(tx));
    const warning = holidayWarning(target.weekNo, target.day, semester, holidays);
    return { ok: true, warning: warning || undefined, actionId: check.actionId || undefined };
  });
}

// Финализируется после автоматической сортировки тем, чтобы revision отражал
// окончательное состояние ответа, а не промежуточную запись переноса.
function finalizeMoveAction(actionId, db = getDb()) {
  const row = db.prepare("SELECT lesson_id, before_json FROM move_actions WHERE action_id=? AND status='pending'").get(actionId);
  if (!row) return;
  const all = loadLessons(db);
  const beforeData = JSON.parse(row.before_json);
  const ids = Array.isArray(beforeData.batch) ? beforeData.batch.map((x) => x.id) : [row.lesson_id];
  const lessons = ids.map((id) => all.find((l) => l.id === id)).filter(Boolean);
  const lesson = lessons.find((l) => l.id === row.lesson_id) || lessons[0];
  if (!lesson) return;
  const affected = (beforeData.topicChanges || [])
    .map((c) => all.find((l) => l.id === c.id)).filter(Boolean).map(lessonSnapshot);
  db.prepare("UPDATE move_actions SET after_json=?, status='active' WHERE action_id=? AND status='pending'")
    .run(JSON.stringify(Array.isArray(beforeData.batch) || affected.length
      ? { lesson: lessonSnapshot(lesson), batch: Array.isArray(beforeData.batch) ? lessons.map(lessonSnapshot) : undefined, affected }
      : lessonSnapshot(lesson)), actionId);
}

function attachMoveActionTopicChanges(actionId, changes, db = getDb()) {
  if (!actionId || !Array.isArray(changes) || !changes.length) return;
  const row = db.prepare("SELECT lesson_id, before_json FROM move_actions WHERE action_id=? AND status='pending'").get(actionId);
  if (!row) return;
  const all = new Map(loadLessons(db).map((l) => [l.id, l]));
  const topicChanges = changes
    .filter((c) => Number(c.id) !== Number(row.lesson_id) && all.has(Number(c.id)))
    .map((c) => ({
      id: Number(c.id), beforeTopic: c.beforeTopic ?? null,
      beforeRevision: Number(c.beforeRevision || 0), groups: (all.get(Number(c.id)).groups || []).slice(),
    }));
  if (!topicChanges.length) return;
  const beforeData = JSON.parse(row.before_json);
  beforeData.topicChanges = topicChanges;
  db.prepare('UPDATE move_actions SET before_json=? WHERE action_id=?').run(JSON.stringify(beforeData), actionId);
}

// После аварийного завершения между записью переноса и отправкой ответа могли
// остаться pending-команды. Текущее состояние уже зафиксировано в БД, поэтому
// при запуске безопасно завершить их снимком фактического результата.
function finalizePendingMoveActions(db = getDb()) {
  const rows = db.prepare("SELECT action_id FROM move_actions WHERE status='pending'").all();
  for (const row of rows) finalizeMoveAction(row.action_id, db);
  return rows.length;
}

function getMoveActions(user, limit = 300, db = getDb()) {
  const capped = Math.max(1, Math.min(1000, Number(limit) || 300));
  const generation = getScheduleGeneration();
  const actions = db.prepare(
    `SELECT action_id AS actionId, created_at AS createdAt, actor_user_id AS actorUserId,
            actor_name AS actorName, lesson_id AS lessonId, description, before_json AS beforeJson,
            after_json AS afterJson, status, reverted_at AS revertedAt, reverted_by_name AS revertedByName,
            schedule_generation AS scheduleGeneration
       FROM move_actions ORDER BY created_at DESC LIMIT ?`
  ).all(capped).map((r) => {
    const before = JSON.parse(r.beforeJson).lesson;
    const parsedAfter = r.afterJson ? JSON.parse(r.afterJson) : null;
    const after = parsedAfter && (parsedAfter.lesson || parsedAfter);
    return {
      actionId: r.actionId, createdAt: r.createdAt, actorUserId: r.actorUserId,
      actorName: r.actorName, lessonId: r.lessonId, description: r.description,
      status: r.status, revertedAt: r.revertedAt, revertedByName: r.revertedByName,
      before: { day: before.day, pairNo: before.pairNo, weekNo: before.weekNo, room: before.room, groups: before.groups, subject: before.subject },
      after: after ? { day: after.day, pairNo: after.pairNo, weekNo: after.weekNo, room: after.room, groups: after.groups, subject: after.subject } : null,
      canRevert: r.status === 'active' && r.scheduleGeneration === generation
        && (user.role === 'admin' || Number(r.actorUserId) === Number(user.id)),
    };
  });
  const remaining = capped - actions.length;
  if (remaining <= 0) return actions;
  const legacy = db.prepare(
    `SELECT id, moved_at AS movedAt, groups, subject, from_day AS fromDay, from_pair AS fromPair,
            from_week AS fromWeek, to_day AS toDay, to_pair AS toPair, to_week AS toWeek,
            room, from_room AS fromRoom, action
       FROM move_log WHERE action_id IS NULL AND action IN ('move','room') ORDER BY id DESC LIMIT ?`
  ).all(remaining).map((r) => {
    const groups = String(r.groups || '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      actionId: `legacy-${r.id}`, createdAt: r.movedAt, actorUserId: null,
      actorName: 'Автор не указан — запись до обновления', lessonId: null,
      description: r.action === 'room' ? `Смена аудитории: ${r.subject || '?'} ${r.groups || ''}` : `Перенос: ${r.subject || '?'} ${r.groups || ''}`,
      status: 'legacy', canRevert: false,
      before: { day: r.fromDay, pairNo: r.fromPair, weekNo: r.fromWeek, room: r.fromRoom, groups, subject: r.subject },
      after: { day: r.toDay, pairNo: r.toPair, weekNo: r.toWeek, room: r.room, groups, subject: r.subject },
    };
  });
  return [...actions, ...legacy]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, capped);
}

function latestOwnMoveAction(user, db = getDb()) {
  const row = db.prepare(
    `SELECT action_id FROM move_actions WHERE actor_user_id=? AND status IN ('active','pending')
      ORDER BY created_at DESC LIMIT 1`
  ).get(user.id);
  if (!row) return null;
  return getMoveActions(user, 1000, db).find((x) => x.actionId === row.action_id) || null;
}

function restoreSnapshot(db, snap) {
  const groups = snap.groups || [];
  const teachers = snap.teachers || (snap.teacher ? [snap.teacher] : []);
  const rooms = snap.rooms || (snap.room ? [snap.room] : []);
  const teacherIds = teachers.map((n) => getOrCreate(db, 'teachers', 'name', n));
  const roomIds = rooms.map((n) => getOrCreate(db, 'rooms', 'name', n));
  const times = PAIR_TIMES[snap.pairNo] || {};
  db.prepare(
    `INSERT INTO lessons(id, day, pair_no, week_no, time_start, time_end, subject, type, topic, note,
      parked, orphan, locked, category, teacher_id, room_id, orig_day, orig_pair, orig_week)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET day=excluded.day, pair_no=excluded.pair_no, week_no=excluded.week_no,
       time_start=excluded.time_start, time_end=excluded.time_end, subject=excluded.subject, type=excluded.type,
       topic=excluded.topic, note=excluded.note, parked=excluded.parked, orphan=excluded.orphan,
       locked=excluded.locked, category=excluded.category,
       teacher_id=excluded.teacher_id, room_id=excluded.room_id`
  ).run(snap.id, snap.day, snap.pairNo, snap.weekNo, times.start || null, times.end || null,
    snap.subject, snap.type, snap.topic, snap.note, snap.parked ? 1 : 0, snap.orphan ? 1 : 0,
    snap.locked ? 1 : 0, snap.category || 'lesson', teacherIds[0] ?? null, roomIds[0] ?? null,
    snap.day, snap.pairNo, snap.weekNo);
  db.prepare('DELETE FROM lesson_groups WHERE lesson_id=?').run(snap.id);
  const addGroup = db.prepare('INSERT OR IGNORE INTO lesson_groups(lesson_id, group_id) VALUES (?, ?)');
  for (const name of groups) addGroup.run(snap.id, getOrCreate(db, 'groups', 'name', name));
  db.prepare('DELETE FROM lesson_teachers WHERE lesson_id=?').run(snap.id);
  const addTeacher = db.prepare('INSERT OR IGNORE INTO lesson_teachers(lesson_id, teacher_id) VALUES (?, ?)');
  for (const id of teacherIds) addTeacher.run(snap.id, id);
  setLessonRoomsRows(db, snap.id, roomIds);
}

function restoreMoveLogChain(db, lessonId, rows) {
  db.prepare("DELETE FROM move_log WHERE lesson_id=? AND action IN ('move','room')").run(lessonId);
  if (!Array.isArray(rows) || !rows.length) return;
  const cols = Object.keys(rows[0]);
  const sql = `INSERT INTO move_log (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const insert = db.prepare(sql);
  for (const row of rows) insert.run(...cols.map((c) => row[c]));
}

function revertMoveAction(actionId, user, force = false) {
  const { canEditGroups } = require('./userService');
  return transaction((db) => {
    const row = db.prepare('SELECT * FROM move_actions WHERE action_id=?').get(String(actionId));
    if (!row) return { ok: false, code: 404, reasons: ['Действие не найдено'] };
    if (row.status !== 'active') return { ok: false, code: 409, reasons: [row.status === 'reverted' ? 'Перенос уже отменён' : 'Перенос ещё не завершён'] };
    if (!row.schedule_generation || row.schedule_generation !== getScheduleGeneration()) {
      return { ok: false, code: 409, reasons: ['После восстановления версии расписания это действие больше нельзя отменить'] };
    }
    if (user.role !== 'admin' && Number(row.actor_user_id) !== Number(user.id)) {
      return { ok: false, code: 403, reasons: ['Можно отменять только собственные переносы'] };
    }
    const beforeData = JSON.parse(row.before_json);
    const before = beforeData.lesson;
    const afterData = JSON.parse(row.after_json);
    const after = afterData.lesson || afterData;
    const current = loadLessons(db).find((l) => l.id === row.lesson_id);
    if (!current) return { ok: false, code: 409, reasons: ['Занятие удалено после переноса'] };
    if (Number(current.revision) !== Number(after.revision)) {
      return { ok: false, code: 409, stale: true, reasons: ['Занятие изменено после этого переноса'] };
    }
    const beforeBatch = Array.isArray(beforeData.batch) ? beforeData.batch : [before];
    const afterBatch = Array.isArray(afterData.batch) ? afterData.batch : [after];
    const affectedAfter = Array.isArray(afterData.affected) ? afterData.affected : [];
    const currentById = new Map(loadLessons(db).map((l) => [l.id, l]));
    if ([...afterBatch, ...affectedAfter].some((snap) => !currentById.has(snap.id) || Number(currentById.get(snap.id).revision) !== Number(snap.revision))) {
      return { ok: false, code: 409, stale: true, reasons: ['Одно из занятий изменено после этого переноса'] };
    }
    const allGroups = [...beforeBatch, ...afterBatch, ...affectedAfter].flatMap((x) => x.groups || []);
    if (!canEditGroups(user, allGroups)) {
      return { ok: false, code: 403, reasons: ['Текущих прав на группы занятия недостаточно для отмены'] };
    }
    for (const snap of beforeBatch) {
      const target = { day: snap.day, pairNo: snap.pairNo, weekNo: snap.weekNo, rooms: snap.rooms || [] };
      const check = validateMoveById(snap.id, target, db);
      if (!check.ok) return check;
      const soft = confirmable(check, force);
      if (soft) return soft;
    }
    for (const snap of beforeBatch) restoreSnapshot(db, snap);
    for (const snap of beforeData.displaced || []) restoreSnapshot(db, snap);
    const setTopic = db.prepare('UPDATE lessons SET topic=? WHERE id=?');
    for (const change of beforeData.topicChanges || []) setTopic.run(change.beforeTopic, change.id);
    restoreMoveLogChain(db, before.id, before.moveLogBefore || []);
    const at = new Date().toISOString();
    db.prepare(
      `UPDATE move_actions SET status='reverted', reverted_at=?, reverted_by_user_id=?, reverted_by_name=?
       WHERE action_id=? AND status='active'`
    ).run(at, user.id, user.displayName || user.username, actionId);
    db.prepare(
      `INSERT INTO move_action_events(action_id, happened_at, actor_user_id, actor_name, event)
       VALUES (?, ?, ?, ?, 'revert')`
    ).run(actionId, at, user.id, user.displayName || user.username);
    return { ok: true };
  });
}

const sameSlotAs = (a, b) =>
  a.day === b.day && Number(a.pairNo) === Number(b.pairNo) && Number(a.weekNo) === Number(b.weekNo);
const splitRooms = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Откат по цепочке ручным переносом: цель — ячейка, где занятие уже стояло.
// Импортное место или начало цепочки → цепочка снимается целиком. «Куда» одной
// из записей → остаётся всё до ПОСЛЕДНЕЙ такой записи включительно (как если бы
// ↩ нажали нужное число раз), остальное удаляется — и переносы, и смены аудитории.
// Аудиторию откат не возвращает: если сейчас она не та, что была в этом месте
// цепочки, это смена аудитории — пишем её, чтобы журнал не расходился с сеткой.
// @returns {boolean} true — цель нашлась в цепочке, новый шаг писать не нужно
function rewindMoveLog(db, before, target) {
  const lessonId = before.id;
  if (lessonId == null) return false;
  const chain = moveLogChain(db, lessonId);
  const orig = db
    .prepare('SELECT orig_day AS day, orig_pair AS pairNo, orig_week AS weekNo FROM lessons WHERE id = ?')
    .get(lessonId);
  const first = chain[0];
  const toStart = Boolean(orig && orig.day && sameSlotAs(orig, target))
    || Boolean(first && sameSlotAs({ day: first.from_day, pairNo: first.from_pair, weekNo: first.from_week }, target));
  // В ячейке может быть несколько записей (перенос сюда + смены аудитории здесь).
  // Сначала ищем ту, после которой у занятия была ТА ЖЕ аудитория, что сейчас:
  // обрезка до неё не оставляет лишней пары «ОТК-1 → ОТК-2, ОТК-2 → ОТК-1».
  // Нет такой — последняя запись в ячейке, и ниже дописывается смена аудитории.
  const atTarget = toStart
    ? []
    : [...chain].reverse().filter((e) => sameSlotAs({ day: e.to_day, pairNo: e.to_pair, weekNo: e.to_week }, target));
  const wantRooms = splitRooms(target.room).join(', ');
  const hit = atTarget.find((e) => splitRooms(e.room).join(', ') === wantRooms) || atTarget[0] || null;
  if (!toStart && !hit) return false;

  if (hit) {
    db.prepare("DELETE FROM move_log WHERE lesson_id = ? AND action IN ('move', 'room') AND id > ?").run(lessonId, hit.id);
  } else {
    db.prepare("DELETE FROM move_log WHERE lesson_id = ? AND action IN ('move', 'room')").run(lessonId);
  }

  // Аудитория в этом месте цепочки. У старых записей без from_room она неизвестна —
  // тогда смену аудитории не придумываем.
  const roomThen = hit ? hit.room : (first ? first.from_room : null);
  if (hit || roomThen != null) {
    const at = { ...before, day: target.day, pairNo: target.pairNo, weekNo: target.weekNo };
    logRoomChange(db, at, splitRooms(roomThen), splitRooms(target.room));
  }
  return true;
}

// Запись выполненного переноса в журнал. Одна запись = ОДИН шаг: «откуда» —
// ячейка, в которой занятие стояло до этого переноса, «куда» — новая. Шаги
// копятся цепочкой, поэтому в журнале видно и последний перенос (верхняя
// запись), и весь путь от импорта (самая ранняя запись цепочки). Если занятие
// вернули туда, где оно уже стояло по цепочке, — это откат, а не новый шаг:
// цепочка укорачивается до этого места (rewindMoveLog).
function logMove(db, before, target) {
  // Мероприятия и СР в журнал не идут — как и при добавлении/удалении
  // (isLoggableLesson): их двигают пачками, и цепочка шагов журнал бы утопила.
  if (!isLoggableLesson(before)) return;
  const semester = getSemester(db);
  const toDate = lessonDate(target.weekNo, target.day, semester);
  const lessonId = before.id ?? null;

  // «Откуда» — слот перед ЭТИМ переносом. Первый шаг цепочки тем самым хранит
  // импортную позицию (lessons.orig_*), а дальше каждый шаг — свою.
  const from = {
    day: before.day,
    pairNo: before.pairNo,
    weekNo: before.weekNo,
    date: before.date || lessonDate(before.weekNo, before.day, semester),
  };

  // Слот не изменился — шага нет (могли поменять только аудиторию).
  if (sameSlotAs(from, target)) return;

  if (rewindMoveLog(db, before, target)) return;

  db.prepare(
    `INSERT INTO move_log
       (lesson_id, moved_at, groups, subject, subject_full, type, topic, teacher,
        from_date, from_day, from_pair, from_week,
        to_date, to_day, to_pair, to_week, room, from_room)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lessonId,
    new Date().toISOString(),
    (before.groups || []).join(', '),
    before.subject || null,
    before.subjectFull || null,
    before.type || null,
    before.topic || null,
    before.teacher || null,
    from.date,
    from.day,
    from.pairNo,
    from.weekNo,
    toDate,
    target.day,
    target.pairNo,
    target.weekNo,
    target.room ?? null,
    (before.rooms || (before.room ? [before.room] : [])).join(', ') || null
  );
}

// Запись о смене аудитории: слот тот же, меняется только место. Пишется отовсюду,
// где аудиторию занятия меняют — карточка занятия, «Подобрать аудитории», «Вывод
// аудитории». Пустая новая аудитория = занятие ушло в буфер (так это и читается
// в журнале). Столбцы дня/пары/недели заполняем текущим слотом, чтобы запись
// участвовала в фильтрах наравне с переносами.
function logRoomChange(db, lesson, fromRooms, toRooms) {
  if (!isLoggableLesson(lesson)) return;
  const from = (fromRooms || []).filter(Boolean).join(', ') || null;
  const to = (toRooms || []).filter(Boolean).join(', ') || null;
  if (from === to) return;
  const semester = getSemester(db);
  const date = lessonDate(lesson.weekNo, lesson.day, semester);
  db.prepare(
    `INSERT INTO move_log
       (lesson_id, moved_at, action, groups, subject, subject_full, type, topic, teacher,
        from_date, from_day, from_pair, from_week,
        to_date, to_day, to_pair, to_week, room, from_room)
     VALUES (?, ?, 'room', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lesson.id ?? null,
    new Date().toISOString(),
    (lesson.groups || []).join(', '),
    lesson.subject || null,
    lesson.subjectFull || null,
    lesson.type || null,
    lesson.topic || null,
    lesson.teacher || null,
    date, lesson.day, lesson.pairNo, lesson.weekNo,
    date, lesson.day, lesson.pairNo, lesson.weekNo,
    to, from
  );
}

// Запись в журнал о добавлении или удалении ЗАНЯТИЯ (не мероприятия и не СР —
// их составитель в журнале видеть не хочет). У добавления пусты столбцы «откуда»,
// у удаления — «куда»; различает их колонка action.
function logCreateDelete(db, action, lesson) {
  if (!isLoggableLesson(lesson)) return;
  const semester = getSemester(db);
  const date = lessonDate(lesson.weekNo, lesson.day, semester);
  const rooms = (lesson.rooms || (lesson.room ? [lesson.room] : [])).join(', ') || null;
  const isDelete = action === 'delete';
  db.prepare(
    `INSERT INTO move_log
       (lesson_id, moved_at, action, groups, subject, subject_full, type, topic, teacher,
        from_date, from_day, from_pair, from_week,
        to_date, to_day, to_pair, to_week, room, from_room)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lesson.id ?? null,
    new Date().toISOString(),
    action,
    (lesson.groups || []).join(', '),
    lesson.subject || null,
    lesson.subjectFull || null,
    lesson.type || null,
    lesson.topic || null,
    lesson.teacher || null,
    isDelete ? date : null, isDelete ? lesson.day : null,
    isDelete ? lesson.pairNo : null, isDelete ? lesson.weekNo : null,
    isDelete ? null : date, isDelete ? null : lesson.day,
    isDelete ? null : lesson.pairNo, isDelete ? null : lesson.weekNo,
    isDelete ? null : rooms, isDelete ? rooms : null
  );
}

// В журнал идут только учебные занятия: мероприятия (отпуск, ЭкзС, УМО…) и
// самоподготовка ставятся и снимаются пачками и журнал бы утопили.
function isLoggableLesson(l) {
  if (!l || l.event || l.category === 'event') return false;
  return Boolean(l.subject) && !isSelfStudyType(l.subject) && !isSelfStudyType(l.type);
}

// Журнал переносов: последние записи первыми. Имена столбцов приводим к
// camelCase, понятному фронтенду. Лимит с запасом: журнал хранит ЦЕПОЧКУ шагов
// на занятие, и на обрезанной выборке у цепочки пропало бы начало, а в сетке —
// пометка «перенесено» у занятий из хвоста журнала.
function getMoveLog(limit = 5000, db = getDb()) {
  return db
    .prepare(
      `SELECT id, lesson_id AS lessonId, moved_at AS movedAt, groups, subject, subject_full AS subjectFull,
              type, topic, teacher,
              from_date AS fromDate, from_day AS fromDay, from_pair AS fromPair, from_week AS fromWeek,
              to_date AS toDate, to_day AS toDay, to_pair AS toPair, to_week AS toWeek,
              room, from_room AS fromRoom, note, action
         FROM move_log ORDER BY id DESC LIMIT ?`
    )
    .all(Number(limit) || 5000);
}

// Сохранение пользовательского примечания к записи журнала.
function setMoveLogNote(id, note, db = getDb()) {
  const res = db.prepare('UPDATE move_log SET note = ? WHERE id = ?').run(note ?? null, Number(id));
  if (!res.changes) return { ok: false, reasons: ['Запись журнала не найдена'] };
  return { ok: true };
}

// Полная очистка журнала переносов. На расписание не влияет — удаляются только
// записи истории. Возвращает число удалённых строк.
function clearMoveLog(db = getDb()) {
  const res = db.prepare('DELETE FROM move_log').run();
  return { ok: true, deleted: Number(res.changes) };
}

// Цепочка изменений занятия (переносы и смены аудитории) — от первого шага к
// последнему. Нужна для снимка undo: действие может не только добавить запись,
// но и стереть цепочку (возврат на импортное место).
function moveLogChain(db, lessonId) {
  if (lessonId == null) return [];
  return db
    .prepare("SELECT * FROM move_log WHERE lesson_id = ? AND action IN ('move', 'room') ORDER BY id")
    .all(lessonId);
}

// Удаление ОДНОЙ записи журнала (история). На расписание не влияет.
function deleteMoveLogEntry(id, db = getDb()) {
  const res = db.prepare('DELETE FROM move_log WHERE id = ?').run(Number(id));
  if (!res.changes) return { ok: false, reasons: ['Запись журнала не найдена'] };
  return { ok: true };
}

// Совпадают ли наборы групп без учёта порядка.
function sameGroupSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

// Отмена смены аудитории по записи журнала: возвращает занятию прежнюю аудиторию.
// Занятость аудитории и нехватка мест — предупреждения (подтверждаются force),
// как и при обычной правке.
function revertRoomChange(tx, e, force) {
  const lessons = loadLessons(tx);
  const L = e.lesson_id != null ? lessons.find((l) => l.id === e.lesson_id) : null;
  if (!L) return { ok: false, reasons: ['Занятие не найдено — возможно, его уже удалили'] };

  const names = String(e.from_room || '').split(',').map((x) => x.trim()).filter(Boolean);
  const cur = L.rooms && L.rooms.length ? L.rooms : (L.room ? [L.room] : []);
  if (names.join(', ') !== cur.join(', ')) {
    // Отложенное занятие стоит вне сетки — накладки по нему не считаем (см. editLesson).
    if (!L.parked && !L.event) {
      const ref = loadReference(tx);
      const candidate = {
        id: L.id, day: L.day, pairNo: L.pairNo, weekNo: L.weekNo, subject: L.subject, type: L.type,
        teacher: L.teacher, teachers: L.teachers, rooms: names, groups: L.groups,
      };
      const check = validateMove(candidate, candidate, {
        lessons: lessons.filter((l) => !l.parked && !isEcs(l)),
        roomCapacity: ref.roomCapacity,
        groupHeadcount: ref.groupHeadcount,
      });
      if (!check.ok) return { ok: false, reasons: check.reasons };
      const soft = confirmable(check, force);
      if (soft) return soft;
    }
    const desc = `Отмена смены аудитории: ${L.subject || '?'} ${(L.groups || []).join(', ')}`;
    pushUndo(tx, 'edit', desc, { ...lessonSnapshot(L), moveLogBefore: moveLogChain(tx, L.id) });
    const ids = names.map((n) => getOrCreate(tx, 'rooms', 'name', n));
    tx.prepare('UPDATE lessons SET room_id = ? WHERE id = ?').run(ids[0] ?? null, L.id);
    setLessonRoomsRows(tx, L.id, ids);
  }
  tx.prepare('DELETE FROM move_log WHERE id = ?').run(e.id);
  return { ok: true };
}

/**
 * Отмена переноса по записи журнала: возвращает занятие из целевого слота записи
 * обратно в тот, из которого его на этом шаге забрали. Возврат валидируется как
 * обычный перенос: накладка преподавателя/группы — отказ, занятая аудитория и
 * нехватка мест — предупреждение (ответ confirm, повтор с force). Успешная отмена
 * удаляет запись журнала и кладёт действие в стек Undo.
 * @returns {{ok:boolean, reasons?:string[], confirm?:boolean, warnings?:string[]}}
 */
function revertMove(logId, force) {
  return transaction((tx) => {
    const e = tx.prepare('SELECT * FROM move_log WHERE id = ?').get(Number(logId));
    if (!e) return { ok: false, reasons: ['Запись журнала не найдена'] };

    // Журнал хранит цепочку изменений, а отменить можно только ПОСЛЕДНЕЕ: занятие
    // стоит в его целевой ячейке и аудитории, предыдущие шаги давно позади.
    const last = e.lesson_id != null
      ? tx.prepare('SELECT id FROM move_log WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(e.lesson_id)
      : null;
    if (last && last.id !== e.id) {
      return { ok: false, reasons: ['Это не последнее изменение занятия — сначала отмените более поздние'] };
    }
    if (e.action === 'room') return revertRoomChange(tx, e, force);
    if ((e.action || 'move') !== 'move') {
      return { ok: false, reasons: ['Отменить можно только перенос или смену аудитории'] };
    }

    // Занятие — по lesson_id записи: поиск по «ячейка + дисциплина + группы» ложно
    // отказывал, когда в ячейке два одинаковых занятия. Старые записи без id —
    // прежним поиском.
    const groupsArr = String(e.groups || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const atTarget = loadLessons(tx).filter(
      (l) =>
        !l.parked &&
        l.day === e.to_day &&
        l.pairNo === e.to_pair &&
        l.weekNo === e.to_week &&
        (e.lesson_id != null
          ? l.id === e.lesson_id
          : (e.subject == null || l.subject === e.subject) && sameGroupSet(l.groups, groupsArr))
    );
    if (!atTarget.length) {
      return {
        ok: false,
        reasons: ['Занятие не найдено в целевом слоте — возможно, его уже перенесли или удалили'],
      };
    }
    if (atTarget.length > 1) {
      return { ok: false, reasons: ['Под запись подходит несколько занятий — отмена неоднозначна'] };
    }
    const lesson = atTarget[0];

    // Возвращаем в исходный слот, сохраняя текущие аудитории занятия (1–2).
    const target = { day: e.from_day, pairNo: e.from_pair, weekNo: e.from_week, rooms: lesson.rooms };
    const check = validateMoveById(lesson.id, target, tx);
    if (!check.ok) return check; // накладка преподавателя/группы → запрет
    // Занятая аудитория и нехватка мест — предупреждения: решает составитель.
    const soft = confirmable(check, force);
    if (soft) return soft;

    const srSnaps = displaceSelfStudy(tx, loadLessons(tx), lesson.groups, target, lesson.id);
    const times = PAIR_TIMES[target.pairNo] || { start: null, end: null };
    const names = targetRooms(target, lesson);
    const ids = names.map((n) => getOrCreate(tx, 'rooms', 'name', n));
    const rDesc = `Отмена переноса: ${lesson.subject || '?'} ${(lesson.groups || []).join(', ')}`;
    if (srSnaps.length) pushUndo(tx, 'deleteEntity', rDesc, { snapshots: [lessonSnapshot(lesson), ...srSnaps] });
    else pushUndo(tx, 'move', rDesc, lessonSnapshot(lesson));
    tx.prepare(
      `UPDATE lessons SET day = ?, pair_no = ?, week_no = ?, time_start = ?, time_end = ?, room_id = ?, parked = 0
       WHERE id = ?`
    ).run(target.day, target.pairNo, target.weekNo, times.start, times.end, ids[0] ?? null, lesson.id);
    setLessonRoomsRows(tx, lesson.id, ids);

    tx.prepare('DELETE FROM move_log WHERE id = ?').run(Number(logId));
    return { ok: true };
  });
}

// Префикс группы для определения курса — первые 2 символа имени.
const groupPrefix = (name) => String(name || '').slice(0, 2);

// Сводное расписание за неделю: столбцы — группы (сортировка по курсу слева
// направо, курс — по префиксу группы из настройки), строки — слоты день/пара.
// preloaded — уже загруженные занятия: выгрузка за семестр строит 25 недель
// подряд, и без этого каждая неделя перечитывала бы всю базу заново.
function getSummary(weekNo, db = getDb(), preloaded = null) {
  const courses = getCourses(db);
  const lessons = (preloaded || loadLessons(db)).filter((l) => !l.parked && l.weekNo === Number(weekNo) && l.groups.length);

  // Скрытые группы (hidden=1) в сводное не выводим.
  const hidden = new Set(db.prepare('SELECT name FROM groups WHERE hidden = 1').all().map((r) => r.name));
  const present = new Set();
  for (const l of lessons) for (const g of l.groups) if (!hidden.has(g)) present.add(g);

  const columns = [...present]
    .map((group) => ({ group, course: courses[groupPrefix(group)] ?? null }))
    .sort((a, b) => (a.course ?? 99) - (b.course ?? 99) || a.group.localeCompare(b.group, 'ru'));

  return { weekNo: Number(weekNo), columns, lessons, courses, semester: getSemester(db) };
}

// Сводное расписание АУДИТОРИЙ за неделю: столбцы — все НЕскрытые аудитории,
// строки — слоты день/пара. В ячейке — занятия этой аудитории в слоте; пустая
// (свободная) аудитория подсвечивается на фронте зелёным. Возвращаем только
// занятия, занимающие аудиторию (с room/rooms), — остальное в этой сетке не нужно.
function getRoomSummary(weekNo, db = getDb()) {
  const lessons = loadLessons(db).filter(
    (l) => !l.parked && l.weekNo === Number(weekNo) && ((l.rooms && l.rooms.length) || l.room)
  );
  const columns = db
    .prepare('SELECT name, capacity, dept FROM rooms WHERE hidden = 0 ORDER BY name')
    .all()
    .map((r) => ({ room: r.name, capacity: r.capacity ?? null, dept: r.dept || null }));
  return { weekNo: Number(weekNo), columns, lessons, semester: getSemester(db) };
}

// Доступность слотов для переноса: по каждому (день, пара, неделя) — свободны ли
// группа, преподаватель и текущая аудитория. Если weekNo задан — считаем только
// для этой недели (недельный вид); иначе — по всем неделям (семестровый вид).
function getMoveOptions(lessonId, weekNo, db = getDb()) {
  const lessons = loadLessons(db);
  const L = lessons.find((l) => l.id === lessonId);
  if (!L) return { slots: [], current: null };

  const weeks = weekNo
    ? [Number(weekNo)]
    : [...new Set(lessons.map((l) => l.weekNo).filter(Boolean))].sort((a, b) => a - b);

  // Один проход: занятия по слотам (день|пара|неделя), чтобы не фильтровать
  // весь массив для каждого из weeks×days×pairs слотов.
  const bySlot = new Map();
  for (const o of lessons) {
    // Мероприятия учитываем как занятость: их слот заблокирован для занятий.
    // Кроме метки ЭкзС — занятие ставится прямо поверх неё (метка скрывается,
    // пока ячейка занята, и возвращается, когда занятие уходит).
    if (o.id === lessonId || o.parked || (o.event && isEcsMarker(o.subject))) continue;
    const k = `${o.day}|${o.pairNo}|${o.weekNo}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(o);
  }

  const semester = getSemester(db);
  const holidays = new Set(getHolidays(db));
  // СР, которую переносимое занятие заберёт целиком, освободит свою аудиторию.
  const vacatesRoom = (o) => isDisplaceableSr(o) && (o.groups || []).every((g) => L.groups.includes(g));

  const slots = [];
  for (const wk of weeks) {
    for (const day of DAYS.slice(0, 6)) {
      // Нерабочий день — занятие сюда не ставится: слот не свободен.
      const holiday = !!holidayWarning(wk, day, semester, holidays);
      for (let p = 1; p <= PAIRS_PER_DAY; p++) {
        const others = bySlot.get(`${day}|${p}|${wk}`) || [];
        slots.push({
          day,
          pairNo: p,
          weekNo: wk,
          holiday,
          // Занятость преподавателя: совмещение ФП (контроль + занятие) слот не
          // закрывает — иначе разрешённую пару некуда было бы поставить мышью.
          teacherFree: holiday ? false : (L.teacher ? !others.some((o) => o.teacher === L.teacher && !physTeacherOk([L, o])) : true),
          // Ячейка с СР — свободное окно: занятие встаёт на её место (см.
          // displaceSelfStudy). Вытесненная ЦЕЛИКОМ СР освобождает и аудиторию.
          groupFree: holiday ? false : !others.some((o) => !isDisplaceableSr(o) && o.groups.some((g) => L.groups.includes(g))),
          roomFree: L.rooms && L.rooms.length
            ? !others.some((o) => !vacatesRoom(o) && (o.rooms || []).some((r) => (L.rooms || []).includes(r)))
            : true,
        });
      }
    }
  }
  return { slots, current: { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo, rooms: L.rooms || [], room: L.room || null } };
}

// Справочник дисциплин: аббревиатура + полное название + преподаватели, которые
// её ведут (из subject_teachers, обе роли). Нужен для формы добавления занятия
// и взаимной фильтрации «дисциплина ↔ преподаватель».
function getSubjects(db = getDb()) {
  const subjects = db
    .prepare('SELECT id, abbr, full_name AS fullName FROM subjects ORDER BY abbr COLLATE NOCASE')
    .all();
  const links = db
    .prepare(
      `SELECT st.subject_id AS sid, t.name AS teacher
         FROM subject_teachers st JOIN teachers t ON t.id = st.teacher_id`
    )
    .all();
  const bySubject = new Map();
  for (const { sid, teacher } of links) {
    if (!bySubject.has(sid)) bySubject.set(sid, new Set());
    bySubject.get(sid).add(teacher);
  }
  return subjects.map((s) => ({
    abbr: s.abbr,
    fullName: s.fullName,
    teachers: [...(bySubject.get(s.id) || [])].sort((a, b) => a.localeCompare(b)),
  }));
}

// Свободные слоты для НОВОГО занятия (ещё нет в БД): по каждому (день, пара,
// неделя) — свободны ли группы, и — если заданы — преподаватель и аудитория.
// weekNo задан → одна неделя; иначе — все недели с занятиями.
function getFreeSlotsFor({ groups = [], teacher = null, room = null, weekNo = null, subject = null, type = null }, db = getDb()) {
  // Мероприятия учитываем как занятость — их слот заблокирован для нового занятия.
  const lessons = loadLessons(db).filter((l) => !l.parked);
  const weeks = weekNo
    ? [Number(weekNo)]
    : [...new Set(lessons.map((l) => l.weekNo).filter(Boolean))].sort((a, b) => a - b);

  const bySlot = new Map();
  for (const o of lessons) {
    const k = `${o.day}|${o.pairNo}|${o.weekNo}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(o);
  }

  const semester = getSemester(db);
  const holidaysSet = new Set(getHolidays(db));

  const slots = [];
  for (const wk of weeks) {
    for (const day of DAYS.slice(0, 6)) {
      const holiday = !!holidayWarning(wk, day, semester, holidaysSet);
      for (let p = 1; p <= PAIRS_PER_DAY; p++) {
        const others = bySlot.get(`${day}|${p}|${wk}`) || [];
        // subject/type нового занятия нужны только для послабления по ФП
        // (контроль + занятие у одного преподавателя) — см. physTeacherOk.
        const self = { subject, type, groups };
        const teacherFree = teacher ? !others.some((o) => o.teacher === teacher && !physTeacherOk([self, o])) : true;
        const groupFree = groups.length ? !others.some((o) => o.groups.some((g) => groups.includes(g))) : true;
        const roomFree = room ? !others.some((o) => (o.rooms || []).includes(room) || o.room === room) : true;
        // Нерабочий день — слот недоступен для нового занятия.
        slots.push({ day, pairNo: p, weekNo: wk, holiday, teacherFree, groupFree, roomFree, free: !holiday && teacherFree && groupFree && roomFree });
      }
    }
  }
  return { slots };
}

// Варианты аудитории для занятия в его ТЕКУЩЕМ слоте: свободные + вместимость.
// Используется в карточке занятия — выпадающий список смены аудитории.
function getRoomOptions(lessonId, db = getDb()) {
  const lessons = loadLessons(db);
  const ref = loadReference(db);
  const L = lessons.find((l) => l.id === lessonId);
  if (!L) return { rooms: [], need: 0, current: null };

  // Занятия в том же слоте (кроме самого занятия и отложенных в буфер).
  const others = lessons.filter(
    (o) => o.id !== lessonId && !o.parked && o.day === L.day && o.pairNo === L.pairNo && o.weekNo === L.weekNo
  );
  // Аудитории, занятые другими занятиями в этом слоте (проверяем rooms[], не только room).
  const busy = new Set();
  for (const o of others) for (const r of (o.rooms || (o.room ? [o.room] : []))) busy.add(r);

  // Для потока — суммарное количество курсантов всех групп.
  const need = L.groups.reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0);

  const rooms = [];
  for (const name of ref.rooms) {
    if (busy.has(name)) continue; // занята другим занятием
    // Скрытую аудиторию в список не показываем (кроме аудиторий текущего занятия).
    if (ref.roomHidden.has(name) && !(L.rooms || []).includes(name) && name !== L.room) continue;
    const cap = ref.roomCapacity[name] ?? null;
    rooms.push({ name, capacity: cap, fits: cap == null ? null : cap >= need, note: ref.roomNote[name] || null, dept: ref.roomDept[name] || null });
  }
  // По подходимости: сверху те, где мест ближе всего к числу курсантов
  // (см. SC.roomFitCmp), не вмещающие — вниз. Без численности — по имени.
  rooms.sort(roomFitCmp(need));
  return { rooms, need, current: (L.rooms && L.rooms.length ? L.rooms.join(', ') : L.room) || null };
}

// Свободные аудитории в указанном слоте + признак вместимости под группы занятия.
// Занятые отдаются отдельным списком `busyRooms` (с указанием, кто занимает):
// карточка занятия показывает их ниже свободных, чтобы аудиторию было видно, но
// сразу понятно, что слот занят. Поле `rooms` остаётся ТОЛЬКО свободными —
// на этом держатся автоперенос и диалог добавления занятия.
function getFreeRooms(lessonId, day, pairNo, weekNo, db = getDb()) {
  const lessons = loadLessons(db);
  const ref = loadReference(db);
  const L = lessons.find((l) => l.id === lessonId);
  const others = lessons.filter(
    (o) => o.id !== lessonId && !o.parked && o.day === day && o.pairNo === Number(pairNo) && o.weekNo === Number(weekNo)
  );
  // Кто занимает аудиторию — «группы дисциплина» первого найденного занятия.
  const occupiedBy = new Map();
  for (const o of others) {
    for (const r of (o.rooms || (o.room ? [o.room] : []))) {
      if (!occupiedBy.has(r)) occupiedBy.set(r, [(o.groups || []).join(', '), o.subject || ''].filter(Boolean).join(' '));
    }
  }
  const need = L ? L.groups.reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0) : 0;

  const rooms = [];
  const busyRooms = [];
  for (const name of ref.rooms) {
    // Скрытую аудиторию в список не показываем (кроме текущей аудитории занятия).
    if (ref.roomHidden.has(name) && !(L && (L.rooms || []).includes(name)) && !(L && name === L.room)) continue;
    const cap = ref.roomCapacity[name] ?? null;
    // note — примечание об оснащении (компьютерный класс, лаборатория…): показывается
    // рядом с аудиторией везде, где её выбирают.
    const room = { name, capacity: cap, fits: cap == null ? null : cap >= need, note: ref.roomNote[name] || null, dept: ref.roomDept[name] || null };
    if (occupiedBy.has(name)) busyRooms.push({ ...room, busyBy: occupiedBy.get(name) || null });
    else rooms.push(room);
  }
  // По подходимости к занятию (см. SC.roomFitCmp): сверху аудитории, где мест
  // ближе всего к числу курсантов. Свободные и занятые сортируются одинаково —
  // это две отдельные группы в списке выбора.
  const byFit = roomFitCmp(need);
  rooms.sort(byFit);
  busyRooms.sort(byFit);
  return { rooms, busyRooms, need };
}

// Сохранение пользовательских полей занятия. Обновляем только переданные
// поля (тема приходит из импорта и не редактируется — её не затираем).
function setLessonDetails(lessonId, { topic, note }, db = getDb()) {
  const sets = [];
  const vals = [];
  if (topic !== undefined) {
    sets.push('topic = ?');
    vals.push(topic ?? null);
  }
  if (note !== undefined) {
    sets.push('note = ?');
    vals.push(note ?? null);
  }
  if (!sets.length) return { ok: true };
  vals.push(lessonId);
  const res = db.prepare(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (!res.changes) return { ok: false, reasons: ['Занятие не найдено'] };
  return { ok: true };
}

// Кандидаты-преподаватели для занятия: по дисциплине (subjects.abbr) и виду
// занятия. Лекция (Л) → роль «lecturer»; иначе → «other». Если в нужной роли
// пусто — отдаём всех кандидатов по дисциплине. Плюс — полный список и текущий.
function getTeacherOptions(lessonId, db = getDb()) {
  const lesson = db.prepare('SELECT subject, type, teacher_id FROM lessons WHERE id = ?').get(lessonId);
  const all = db.prepare('SELECT name FROM teachers ORDER BY name').all().map((r) => r.name);
  if (!lesson) return { current: null, selected: [], candidates: [], all };

  const current = lesson.teacher_id
    ? (db.prepare('SELECT name FROM teachers WHERE id = ?').get(lesson.teacher_id) || {}).name || null
    : null;

  // Все назначенные преподаватели (для зачётов/экзаменов — несколько); если связей
  // нет, действует основной (teacher_id).
  let selected = db
    .prepare(
      `SELECT t.name FROM lesson_teachers lt JOIN teachers t ON t.id = lt.teacher_id
        WHERE lt.lesson_id = ? ORDER BY t.name`
    )
    .all(lessonId)
    .map((r) => r.name);
  if (!selected.length && current) selected = [current];

  const subj = db.prepare('SELECT id FROM subjects WHERE abbr = ?').get(lesson.subject);
  let candidates = [];
  if (subj) {
    const byRole = (role) =>
      db
        .prepare(
          `SELECT t.name FROM subject_teachers st JOIN teachers t ON t.id = st.teacher_id
            WHERE st.subject_id = ? AND st.role = ? ORDER BY t.name`
        )
        .all(subj.id, role)
        .map((r) => r.name);
    const lecturers = byRole('lecturer');
    const others = byRole('other');
    const isLecture = /^л$/i.test(String(lesson.type || '').trim());
    candidates = isLecture ? lecturers : others;
    if (!candidates.length) candidates = [...new Set([...lecturers, ...others])];
  }
  return { current, selected, candidates, all };
}

// Назначение преподавателя занятию. Пустое имя — снять преподавателя. Проверяем
// накладку: тот же преподаватель не может вести два занятия в один слот.
function setLessonTeacher(lessonId, teacherName) {
  return transaction((db) => {
    const lesson = db
      .prepare('SELECT day, pair_no AS pairNo, week_no AS weekNo FROM lessons WHERE id = ?')
      .get(lessonId);
    if (!lesson) return { ok: false, code: 404, reasons: ['Занятие не найдено'] };

    const name = String(teacherName || '').trim();
    let teacherId = null;
    if (name) {
      teacherId = getOrCreate(db, 'teachers', 'name', name);
      const clash = db
        .prepare(
          `SELECT COUNT(*) AS n FROM lessons
            WHERE id <> ? AND teacher_id = ? AND day = ? AND pair_no = ? AND week_no = ?`
        )
        .get(lessonId, teacherId, lesson.day, lesson.pairNo, lesson.weekNo);
      if (clash.n > 0) return { ok: false, code: 409, reasons: [`Преподаватель ${name} уже занят в этот слот`] };
    }
    db.prepare('UPDATE lessons SET teacher_id = ? WHERE id = ?').run(teacherId, lessonId);
    return { ok: true };
  });
}

// Кафедра (dept) и «только для курса» (courseOnly) обновляются только когда
// переданы (=== undefined → не трогаем), чтобы правка одного поля не стирала другое.
function setRoomCapacity(name, capacity, kind, dept, courseOnly, note, db = getDb()) {
  const id = getOrCreate(db, 'rooms', 'name', name);
  db.prepare('UPDATE rooms SET capacity = ?, kind = COALESCE(?, kind) WHERE id = ?').run(capacity, kind ?? null, id);
  if (dept !== undefined) db.prepare('UPDATE rooms SET dept = ? WHERE id = ?').run(dept || null, id);
  if (courseOnly !== undefined) db.prepare('UPDATE rooms SET course_only = ? WHERE id = ?').run(courseOnly ?? null, id);
  if (note !== undefined) db.prepare('UPDATE rooms SET note = ? WHERE id = ?').run(note || null, id);
}

function setGroupHeadcount(name, headcount, dept, db = getDb()) {
  const id = getOrCreate(db, 'groups', 'name', name);
  db.prepare('UPDATE groups SET headcount = ? WHERE id = ?').run(headcount, id);
  if (dept !== undefined) db.prepare('UPDATE groups SET dept = ? WHERE id = ?').run(dept || null, id);
}

// Сводка по всем преподавателям, у которых есть занятия: кафедра, дисциплины,
// число пар и отметка об изменениях: в журнале есть записи по этому
// преподавателю — перенос, создание или удаление занятия.
// Своей кафедры у преподавателя в исходных файлах нет, поэтому она считается по
// кафедрам его дисциплин; ручная правка (teachers.dept) эту оценку перекрывает.
// Преподаватели занятия: у зачётов/экзаменов их бывает двое.
const teachersOfLesson = (l) =>
  (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : []));

// Кафедра каждого преподавателя. Дисциплины бывают с разных кафедр, а кафедра у
// преподавателя одна: берём ту, откуда у него больше всего занятий; полный
// расклад отдаём для подсказки. Ручная правка (teachers.dept) оценку перекрывает.
// Общая для вида «Преподаватели» и статистики нагрузки.
function teacherDepts(lessons, db = getDb()) {
  const deptOf = new Map(
    db.prepare('SELECT abbr, dept FROM subjects').all().map((r) => [r.abbr, (r.dept || '').trim()])
  );
  const manual = new Map(
    db.prepare('SELECT name, dept FROM teachers').all().map((r) => [r.name, (r.dept || '').trim()])
  );
  const counts = new Map(); // преподаватель → Map(кафедра → пар)
  for (const l of lessons) {
    if (!l.subject || l.subject === 'СР') continue;
    const d = deptOf.get(l.subject);
    if (!d) continue;
    for (const t of teachersOfLesson(l)) {
      if (!counts.has(t)) counts.set(t, new Map());
      const m = counts.get(t);
      m.set(d, (m.get(d) || 0) + 1);
    }
  }
  const out = new Map();
  for (const name of new Set([...counts.keys(), ...manual.keys()])) {
    const ranked = [...(counts.get(name) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru', { numeric: true }));
    const auto = ranked.length ? ranked[0][0] : '';
    const own = manual.get(name) || '';
    out.set(name, {
      dept: own || auto,
      deptManual: Boolean(own),
      deptAuto: auto,
      deptAll: ranked.map(([d, n]) => `${d} (${n})`).join(', '),
    });
  }
  return out;
}

function getTeachersOverview(db = getDb()) {
  const changed = new Set(
    db.prepare("SELECT DISTINCT teacher FROM move_log WHERE teacher IS NOT NULL AND teacher <> ''")
      .all().map((r) => r.teacher)
  );
  // Мероприятия (Отп, ЭкзС…) — не нагрузка, но занятия в буфере считаем: они из
  // расписания не исчезли, просто отложены.
  const lessons = loadLessons(db).filter((x) => !x.event && x.category !== 'event');
  const depts = teacherDepts(lessons, db);
  const rows = new Map();
  for (const l of lessons) {
    for (const t of teachersOfLesson(l)) {
      if (!rows.has(t)) rows.set(t, { name: t, subjects: new Set(), lessons: 0 });
      const r = rows.get(t);
      r.lessons++;
      if (l.subject && l.subject !== 'СР') r.subjects.add(l.subject);
    }
  }

  return [...rows.values()]
    .map((r) => {
      const d = depts.get(r.name) || { dept: '', deptManual: false, deptAuto: '', deptAll: '' };
      return {
        name: r.name,
        dept: d.dept,
        deptManual: d.deptManual,
        deptAuto: d.deptAuto,
        deptAll: d.deptAll,
        subjects: [...r.subjects].sort((a, b) => a.localeCompare(b, 'ru')),
        lessons: r.lessons,
        changed: changed.has(r.name),
      };
    })
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ru', { numeric: true }) || a.name.localeCompare(b.name, 'ru'));
}

// Ручная кафедра преподавателя из вида «Преподаватели»: пусто = вернуться к
// расчёту по дисциплинам.
function setTeacherInfo(name, { dept }, db = getDb()) {
  const id = getOrCreate(db, 'teachers', 'name', name);
  if (dept !== undefined) db.prepare('UPDATE teachers SET dept = ? WHERE id = ?').run(dept || null, id);
}

// График сессии: экзамены и зачёты по группам (см. buildSessionSchedule). Кафедра
// преподавателя — та же, что в виде «Преподаватели» и в статистике.
function getSessionSchedule(db = getDb()) {
  const cal = getSessionCalendar(db);
  const ref = loadReference(db);
  const depts = teacherDepts(loadLessons(db).filter((l) => !l.event && l.category !== 'event'), db);
  const teacherDept = Object.fromEntries([...depts].map(([name, d]) => [name, d.dept || '']));
  return buildSessionSchedule(cal, { teacherDept, groupHeadcount: ref.groupHeadcount, roomCapacity: ref.roomCapacity });
}

// Скрыть/показать аудиторию или группу в селекторе просмотра (занятия не трогаются).
function setEntityHidden(kind, name, hidden, db = getDb()) {
  const table = kind === 'rooms' ? 'rooms' : 'groups';
  const id = getOrCreate(db, table, 'name', name);
  db.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
}

// Снимок расписания для гостевого просмотра (отложенные в буфер не публикуем).
// groupSubjects (подвал расписания группы), legend (обозначения видов занятий) и
// groupsSummary (часы группы + сверка с учебным планом) нужны подвалу группы и
// таблице итогов преподавателя на гостевой странице: API ей недоступен.
// ponytail: сверка с планом считается по каждой группе, и публикация подорожала
// с ~0.3 до ~2.8 с на 37 группах. Для кнопки это терпимо; станет мешать — считать
// groupsSummary лениво, отдельным эндпоинтом с кэшем по версии данных.
// Пометки «перенесено» по занятиям: сколько записей в цепочке журнала, последний
// перенос и последняя смена аудитории. Считаются здесь, а не на клиентах: админке
// не нужно тянуть весь журнал ради полосы в сетке, а гостю в снимок уходит ровно
// то же самое. key — '#id занятия'; у старых записей без lesson_id — ячейка «куда»
// (movedKey). lessonIds — только эти занятия (снимок), старые записи тогда не идут.
function getMoveMarks(db = getDb(), lessonIds = null) {
  const rows = db.prepare(
    `SELECT lesson_id AS lessonId, action, groups, subject,
            from_date AS fromDate, from_day AS fromDay, from_pair AS fromPair, from_week AS fromWeek,
            to_day AS toDay, to_pair AS toPair, to_week AS toWeek, room, from_room AS fromRoom
       FROM move_log WHERE COALESCE(action, 'move') IN ('move', 'room') ORDER BY id DESC`
  ).all();
  const marks = new Map();
  for (const e of rows) {
    if (lessonIds && !lessonIds.has(e.lessonId)) continue;
    const key = e.lessonId != null
      ? `#${e.lessonId}`
      : movedKey(e.toDay, e.toPair, e.toWeek, e.subject, String(e.groups || '').split(',').map((s) => s.trim()).filter(Boolean));
    let m = marks.get(key);
    if (!m) marks.set(key, (m = { key, steps: 0, lastMove: null, lastRoom: null }));
    m.steps++;
    // Журнал идёт от новых к старым: первая встреченная запись вида и есть последняя.
    if (e.action === 'room') m.lastRoom = m.lastRoom || { fromRoom: e.fromRoom, room: e.room };
    else m.lastMove = m.lastMove || { fromDate: e.fromDate, fromDay: e.fromDay, fromPair: e.fromPair, fromWeek: e.fromWeek, fromRoom: e.fromRoom, room: e.room };
  }
  return [...marks.values()];
}

// Есть ли правки, которых гости не видят: флаг ставит сервер после правки данных
// (server.js), снимает публикация. Снимка нет вовсе — тоже «не опубликовано».
function publishStatus() {
  return { unpublished: getSetting('unpublished') === '1' || !fs.existsSync(PUBLIC_DB_PATH) };
}

function publish(db = getDb()) {
  sortTopics();
  const lessons = loadLessons(db).filter((l) => !l.parked);
  const snapshot = {
    publicationId: randomUUID(),
    publishedAt: new Date().toISOString(),
    lessons,
    semester: getSemester(db),
    holidays: getHolidays(db),
    groupSubjects: getGroupSubjects(db),
    legend: getTypeLegend(db),
    // Виды занятий, на которые гость может менять вид практической пары
    // (справочник settings.lessonTypes без лекций и форм контроля).
    practicalTypes: getLessonTypes(db).map((t) => t.code).filter(isPracticalType),
    groupsSummary: allGroupsSummary(db),
    // Кафедра каждого преподавателя (ручная, иначе — по дисциплинам): по ней
    // гостевой вид «Кафедра» собирает недельные расписания всей кафедры в одну
    // таблицу. Без этого поля (старый снимок) вид просит перепубликовать.
    teacherDept: Object.fromEntries(
      [...teacherDepts(lessons, db)].map(([name, d]) => [name, d.dept || ''])
    ),
    // Курсы групп (префикс имени → номер): по ним гостевые списки групп
    // разбиваются на «1 курс», «2 курс»… как в админке.
    courses: getCourses(db),
    // Пометки «перенесено» занятий снимка — те же, что у админки: по ним гостевая
    // страница рисует полосу и «↪ Перенесено с…» в карточке. Сам журнал гостю
    // недоступен.
    moveMarks: getMoveMarks(db, new Set(lessons.map((l) => l.id))),
    ...listEntities(db),
  };
  writeSnapshot(snapshot);
  setSetting('unpublished', '0', db);
  return { ok: true, count: lessons.length };
}

// Правка занятия с гостевой страницы: только тема, примечание и вид занятия, и
// только когда администратор включил тумблер (проверка — в роуте). Слот не
// меняется, поэтому проверки накладок не затрагиваются. Помимо базы патчим и сам
// снимок: гостевая страница читает public_db.json, иначе правка «пропала бы» до
// перепубликации.
function guestEditLesson(lessonId, fields, expectedPublicationId, db = getDb()) {
  // Пустое поле — это NULL, а не пустая строка: editLesson бережёт note как есть,
  // и без нормализации очищенное примечание разошлось бы со снимком.
  const patch = {};
  if (fields.topic !== undefined) patch.topic = String(fields.topic ?? '').trim() || null;
  if (fields.note !== undefined) patch.note = String(fields.note ?? '').trim() || null;
  // Вид занятия: практическое → практическое. Лекции и формы контроля (зачёт,
  // экзамен) гость не трогает ни как исходный вид, ни как новый; список видов —
  // справочник settings.lessonTypes (тот же, что уходит в снимок публикации).
  if (fields.type !== undefined) {
    const next = String(fields.type ?? '').trim();
    const cur = (db.prepare('SELECT type FROM lessons WHERE id = ?').get(lessonId) || {}).type;
    const allowed = getLessonTypes(db).map((t) => t.code).filter(isPracticalType);
    if (!isPracticalType(cur) || !allowed.includes(next)) {
      return { ok: false, code: 403, reasons: ['Менять вид можно только у практического занятия и только на практический'] };
    }
    patch.type = next;
  }
  if (!Object.keys(patch).length) return { ok: false, code: 400, reasons: ['Менять можно только тему, вид занятия и примечание'] };

  const snap = readSnapshot();
  if (!expectedPublicationId || snap?.publicationId !== expectedPublicationId) {
    return { ok: false, code: 409, stale: true, reasons: ['Опубликованное расписание изменилось. Обновите страницу.'] };
  }
  if (!snap || !(snap.lessons || []).some(l => l.id === lessonId)) return { ok: false, code: 409, reasons: ['Занятие отсутствует в публикации. Обновите страницу.'] };
  return transaction(() => {
    const result = editLesson(lessonId, patch);
    if (result.ok) {
      sortTopics();
      patchPublished(lessonId, patch);
    }
    return result;
  });
}

// Точечное обновление занятия в опубликованном снимке (без перепубликации).
function patchPublished(lessonId, patch) {
  const snap = readSnapshot();
  if (!snap) return;
  const l = (snap.lessons || []).find(x => x.id === lessonId);
  if (!l) return;
  const current = getDb().prepare('SELECT topic, note, type FROM lessons WHERE id = ?').get(lessonId);
  for (const key of Object.keys(patch)) l[key] = current[key] ?? null;
  writeSnapshot(snap);
}

// Статистика нагрузки: число пар по неделям для каждого преподавателя / аудитории / группы.
function getStats(db = getDb()) {
  // Мероприятия (event) — не учебная нагрузка, в статистику не входят.
  const lessons = loadLessons(db).filter((l) => !l.parked && !l.event);
  const teachers = {};
  const rooms = {};
  const groups = {};

  for (const l of lessons) {
    const wk = l.weekNo;
    if (l.teacher) {
      if (!teachers[l.teacher]) teachers[l.teacher] = { byWeek: {}, total: 0 };
      teachers[l.teacher].byWeek[wk] = (teachers[l.teacher].byWeek[wk] || 0) + 1;
      teachers[l.teacher].total++;
    }
    for (const r of (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []))) {
      if (!rooms[r]) rooms[r] = { byWeek: {}, total: 0 };
      rooms[r].byWeek[wk] = (rooms[r].byWeek[wk] || 0) + 1;
      rooms[r].total++;
    }
    for (const g of (l.groups || [])) {
      if (!groups[g]) groups[g] = { byWeek: {}, total: 0 };
      groups[g].byWeek[wk] = (groups[g].byWeek[wk] || 0) + 1;
      groups[g].total++;
    }
  }

  const toArray = (obj) =>
    Object.entries(obj)
      .map(([name, d]) => ({ name, total: d.total, byWeek: d.byWeek }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ru'));

  // Кафедра — ТА ЖЕ, что в виде «Преподаватели»: считается по всем занятиям
  // преподавателя, включая отложенные в буфер (в статистику они не идут). Иначе
  // у человека с парой отложенных занятий кафедра в двух таблицах разошлась бы.
  const depts = teacherDepts(loadLessons(db).filter((l) => !l.event && l.category !== 'event'), db);
  const teacherRows = toArray(teachers).map((r) => ({ ...r, dept: (depts.get(r.name) || {}).dept || '' }));
  return { teachers: teacherRows, rooms: toArray(rooms), groups: toArray(groups) };
}

// Полная очистка: все данные расписания + справочники + настройки + снимок.
// Очистка ТОЛЬКО расписания: занятия, их связи и журнал переносов. Справочники
// (аудитории, группы, преподаватели, дисциплины) и настройки (семестры, курсы,
// праздники, перечень мероприятий и пр.) НЕ трогаются. Undo очищается — его снимки
// ссылаются на удаляемые занятия. Атомарно; счётчик удалённых — для отчёта.
function clearSchedule() {
  return transaction((db) => {
    const deleted = db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
    // Связи удаляем явно — не полагаемся на ON DELETE CASCADE (PRAGMA может быть выкл.).
    for (const t of ['move_action_events', 'move_actions', 'lesson_groups', 'lesson_rooms', 'lesson_teachers', 'lessons', 'move_log', 'undo_stack']) {
      db.exec(`DELETE FROM ${t}`);
    }
    return { ok: true, deleted };
  });
}

function resetDatabase() {
  transaction((tx) => {
    clearAll(tx);
    tx.prepare('DELETE FROM settings').run();
    tx.prepare('DELETE FROM undo_stack').run();
  });
  for (const f of [PUBLIC_DB_PATH, `${PUBLIC_DB_PATH}.gz`]) fs.rmSync(f, { force: true }); // снимка может не быть
  return { ok: true };
}

/**
 * Удаление всего расписания одной сущности (группа / преподаватель / аудитория).
 *  - group:   одиночные занятия удаляются; у потоковых только снимается эта группа.
 *  - teacher: teacher_id/lesson_teachers обнуляется (занятия остаются у групп).
 *  - room:    аудитория снимается с занятий (занятия остаются у групп).
 * Всё атомарно; один вход в стек Undo восстанавливает всё через 'deleteEntity'.
 * @returns {{ok:boolean, deleted?:number, modified?:number, total?:number, reasons?:string[]}}
 */
function deleteEntitySchedule(kind, id) {
  return transaction((db) => {
    if (!kind || !id) return { ok: false, reasons: ['Не указан тип и/или объект'] };
    const lessons = loadLessons(db);
    const snapshots = [];
    let deleted = 0;
    let modified = 0;

    if (kind === 'group') {
      const gRow = db.prepare('SELECT id FROM groups WHERE name = ?').get(id);
      if (!gRow) return { ok: false, reasons: ['Группа не найдена'] };
      for (const l of lessons) {
        if (!(l.groups || []).includes(id)) continue;
        snapshots.push(lessonSnapshot(l));
        if ((l.groups || []).length === 1) {
          db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
          deleted++;
        } else {
          db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ? AND group_id = ?').run(l.id, gRow.id);
          modified++;
        }
      }
    } else if (kind === 'teacher') {
      for (const l of lessons) {
        if (l.teacher !== id && !(l.teachers || []).includes(id)) continue;
        snapshots.push(lessonSnapshot(l));
        db.prepare('UPDATE lessons SET teacher_id = NULL WHERE id = ?').run(l.id);
        db.prepare('DELETE FROM lesson_teachers WHERE lesson_id = ?').run(l.id);
        modified++;
      }
    } else if (kind === 'room') {
      const rRow = db.prepare('SELECT id FROM rooms WHERE name = ?').get(id);
      if (!rRow) return { ok: false, reasons: ['Аудитория не найдена'] };
      for (const l of lessons) {
        if (!(l.rooms || []).includes(id) && l.room !== id) continue;
        snapshots.push(lessonSnapshot(l));
        db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ? AND room_id = ?').run(l.id, rRow.id);
        if (l.room === id) {
          const remaining = (l.rooms || []).filter((r) => r !== id);
          const newRoomId = remaining.length ? getOrCreate(db, 'rooms', 'name', remaining[0]) : null;
          db.prepare('UPDATE lessons SET room_id = ? WHERE id = ?').run(newRoomId, l.id);
        }
        modified++;
      }
    } else {
      return { ok: false, reasons: [`Неизвестный тип: ${kind}`] };
    }

    if (!snapshots.length) return { ok: false, reasons: ['Нет занятий для удаления'] };

    const kindLabel = { group: 'группы', teacher: 'преподавателя', room: 'аудитории' }[kind] || kind;
    pushUndo(db, 'deleteEntity', `Удаление расписания ${kindLabel} ${id} (${snapshots.length} занятий)`, { snapshots });
    return { ok: true, deleted, modified, total: snapshots.length };
  });
}

// Удаление занятия. lesson_groups удаляются каскадно (через FK ON DELETE CASCADE).
// Если занятие потоковое (групп несколько) — удаляется целиком.
// @returns {{ok:boolean, groups?:string[], reasons?:string[]}}
function deleteLesson(lessonId) {
  return transaction((db) => {
    const lesson = loadLessons(db).find((l) => l.id === lessonId);
    if (!lesson) return { ok: false, reasons: ['Занятие не найдено'] };
    const desc = `Удаление: ${lesson.subject || '?'} ${(lesson.groups || []).join(', ')}`;
    pushUndo(db, 'delete', desc, lessonSnapshot(lesson));
    logCreateDelete(db, 'delete', lesson);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(lessonId);
    return { ok: true, groups: lesson.groups || [] };
  });
}

/**
 * Создание занятия или мероприятия вручную. Для занятия проверяет накладки
 * группы / преподавателя / аудитории; мероприятие (category='event') добавляется
 * свободно (без проверки), но затем само блокирует слот для занятий.
 * @param {{day, pairNo, weekNo, subject?, type?, topic?, room?, teacher?, groups?:string[], category?:string}} data
 * @returns {{ok:boolean, id?:number, reasons?:string[]}}
 */
function createLesson(data) {
  const invalid = invalidInput([...slotErrors(data), ...lessonFieldErrors(data)]);
  if (invalid) return invalid;
  return transaction((db) => {
    const lessons = loadLessons(db);
    const ref = loadReference(db);
    const { day, pairNo, weekNo } = data;
    const isEvent = data.category === 'event';
    // Копия сразу в буфер: слот она не занимает, поэтому накладок не создаёт и
    // не проверяется. День/пара/неделя сохраняются как «откуда снято».
    const parked = Boolean(data.parked);

    if (!day || !pairNo || !weekNo) {
      return { ok: false, reasons: ['Необходимо указать день, пару и неделю'] };
    }

    const groups = Array.isArray(data.groups) ? data.groups.filter(Boolean) : [];
    const teacher = String(data.teacher || '').trim() || null;
    const rooms = inputRooms(data); // 1 или 2 аудитории

    const warnings = [];
    const mixed = mixedCourseWarning(groups, db);
    if (mixed) warnings.push(mixed);

    // Мероприятие добавляется свободно; занятие — с проверкой накладок (при этом
    // мероприятия учитываются как занятость — их слот заблокирован).
    if (!isEvent && !parked) {
      if (holidayWarning(Number(weekNo), day, getSemester(db), new Set(getHolidays(db)))) {
        return { ok: false, reasons: [`${day} н${weekNo} — нерабочий день (выходной)`] };
      }
      const candidate = {
        id: -1,
        day,
        pairNo: Number(pairNo),
        weekNo: Number(weekNo),
        // subject/type нужны проверке: по ним работают послабления для СР
        // (совмещение двух СР в аудитории) и для ФП (контроль + занятие).
        subject: String(data.subject || '').trim() || null,
        type: String(data.type || '').trim() || null,
        teacher,
        rooms,
        groups,
      };
      const check = validateMove(candidate, candidate, {
        // Метка ЭкзС занятостью не считается: занятие ставится прямо поверх неё
        // (метка скрывается, см. hideCoveredEcs) — так же, как при переносе.
        lessons: lessons.filter((l) => !l.parked && !isEcs(l)),
        roomCapacity: ref.roomCapacity,
        groupHeadcount: ref.groupHeadcount,
      });
      if (!check.ok) return { ok: false, reasons: check.reasons };
      warnings.push(...check.warnings);
    }
    const soft = confirmable({ warnings }, data.force);
    if (soft) return soft;

    // Ячейка с СР — свободное окно (см. displaceSelfStudy); буфер её не трогает.
    const srSnaps = isEvent || parked
      ? []
      : displaceSelfStudy(db, lessons, groups, { day, pairNo, weekNo });

    const times = PAIR_TIMES[Number(pairNo)] || { start: null, end: null };
    const teacherId = teacher ? getOrCreate(db, 'teachers', 'name', teacher) : null;
    const roomIds = rooms.map((n) => getOrCreate(db, 'rooms', 'name', n));

    const info = db
      .prepare(
        `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, type, topic, teacher_id, room_id, category, parked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        day,
        Number(pairNo),
        times.start,
        times.end,
        Number(weekNo),
        String(data.subject || '').trim() || null,
        String(data.type || '').trim() || null,
        String(data.topic || '').trim() || null,
        teacherId,
        roomIds[0] ?? null,
        isEvent ? 'event' : 'lesson',
        parked ? 1 : 0
      );
    const lid = Number(info.lastInsertRowid);

    const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    for (const g of groups) {
      const gid = getOrCreate(db, 'groups', 'name', g);
      insLG.run(lid, gid);
    }

    // Все аудитории занятия (1 или 2) — в lesson_rooms.
    setLessonRoomsRows(db, lid, roomIds);

    const cDesc = `${parked ? 'Копия в буфер' : 'Создание'}: ${String(data.subject || '?').trim()} ${groups.join(', ')}`;
    // Тронули СР — откатывать надо пачкой: 'deleteEntity' удалит созданное
    // занятие (snap.ids) и вернёт самоподготовку из снимков.
    if (srSnaps.length) pushUndo(db, 'deleteEntity', cDesc, { ids: [lid], snapshots: srSnaps });
    else pushUndo(db, 'create', cDesc, { id: lid });
    logCreateDelete(db, 'create', {
      id: lid, day, pairNo: Number(pairNo), weekNo: Number(weekNo), groups, rooms, teacher,
      subject: String(data.subject || '').trim() || null,
      type: String(data.type || '').trim() || null,
      topic: String(data.topic || '').trim() || null,
      event: isEvent,
    });

    const warning = parked
      ? null
      : holidayWarning(Number(weekNo), day, getSemester(db), new Set(getHolidays(db)));
    return { ok: true, id: lid, warning: warning || undefined };
  });
}

/**
 * Массовое проставление мероприятия «Отп» преподавателю на период отпуска.
 * Во все рабочие ячейки (день × пара) периода [fromISO, toISO] для преподавателя
 * проставляется событие-метка. Реальные занятия преподавателя, попавшие в период,
 * перемещаются в буфер (parked=1) — их потом расставляют вручную. Уже стоящие
 * мероприятия (Отп и т. п.) сохраняются и не дублируются. Воскресенья, 4-я пара
 * субботы и даты вне семестра пропускаются. Всё в одной транзакции с единой
 * записью отмены (action 'vacation': удаляет метки и возвращает занятия из буфера).
 * @returns {{ok:boolean, count?:number, moved?:number, reasons?:string[]}}
 */
function createVacation(teacher, fromISO, toISO, label = 'Отп') {
  const name = String(teacher || '').trim();
  if (!name) return { ok: false, reasons: ['Не указан преподаватель'] };
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isISO(fromISO) || !isISO(toISO)) {
    return { ok: false, reasons: ['Нужны даты начала и конца отпуска (ГГГГ-ММ-ДД)'] };
  }
  if (fromISO > toISO) return { ok: false, reasons: ['Дата начала позже даты конца'] };
  const mark = String(label || 'Отп').trim() || 'Отп';

  return transaction((db) => {
    const semester = getSemester(db);
    if (!semester || !semester.start) {
      return { ok: false, reasons: ['Не задан семестр — нет привязки дат к неделям'] };
    }
    const monday = week1Monday(semester.start);
    if (!monday) return { ok: false, reasons: ['Некорректная дата начала семестра'] };
    const weeks = weekCount(semester); // может быть null, если не задан конец

    const teacherId = getOrCreate(db, 'teachers', 'name', name);

    // Рабочие дни периода (в пределах семестра): набор и список «неделя|день».
    const periodDays = [];
    const periodDaySet = new Set();
    const from = new Date(fromISO + 'T00:00:00Z').getTime();
    const to = new Date(toISO + 'T00:00:00Z').getTime();
    for (let t = from; t <= to; t += 86400000) {
      const dayDiff = Math.round((t - monday.getTime()) / 86400000);
      if (dayDiff < 0) continue;
      const weekNo = Math.floor(dayDiff / 7) + 1;
      const dayIdx = dayDiff % 7;
      if (dayIdx === 6) continue; // воскресенье — занятий нет
      if (weeks && weekNo > weeks) continue; // за пределами семестра
      const day = DAYS[dayIdx];
      const key = `${weekNo}|${day}`;
      if (!periodDaySet.has(key)) {
        periodDaySet.add(key);
        periodDays.push({ weekNo, day });
      }
    }
    if (!periodDays.length) {
      return { ok: false, reasons: ['В выбранном периоде нет рабочих дней в пределах семестра'] };
    }

    // Занятия преподавателя в эти дни: реальные пары → в буфер; уже стоящие
    // мероприятия оставляем (и помечаем их слот, чтобы не дублировать «Отп»).
    const hasEvent = new Set(); // "неделя|день|пара"
    const parkedIds = [];
    const park = db.prepare('UPDATE lessons SET parked = 1 WHERE id = ?');
    for (const l of loadLessons(db)) {
      if (l.teacher !== name || l.parked) continue;
      if (!periodDaySet.has(`${l.weekNo}|${l.day}`)) continue;
      if (l.event) {
        hasEvent.add(`${l.weekNo}|${l.day}|${l.pairNo}`);
      } else {
        park.run(l.id);
        parkedIds.push(l.id);
      }
    }

    // «Отп» во все рабочие ячейки периода (кроме тех, где уже есть мероприятие).
    const ins = db.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, teacher_id, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'event')`
    );
    const ids = [];
    for (const { weekNo, day } of periodDays) {
      const maxPair = day === 'Сб' ? 3 : PAIRS_PER_DAY; // в субботу 4-й пары нет
      for (let p = 1; p <= maxPair; p++) {
        if (hasEvent.has(`${weekNo}|${day}|${p}`)) continue;
        const times = PAIR_TIMES[p] || { start: null, end: null };
        const info = ins.run(day, p, times.start, times.end, weekNo, mark, teacherId);
        ids.push(Number(info.lastInsertRowid));
      }
    }

    if (!ids.length && !parkedIds.length) {
      return { ok: false, reasons: ['В выбранном периоде нечего проставлять'] };
    }

    const desc = `Отпуск: ${name} (${fromISO}–${toISO}, ${ids.length} пар, в буфер: ${parkedIds.length})`;
    pushUndo(db, 'vacation', desc, { ids, parkedIds });
    return { ok: true, count: ids.length, moved: parkedIds.length };
  });
}

/**
 * Отпуск учебной ГРУППЫ: «Отп» во все рабочие ячейки периода для группы, реальные
 * занятия группы в этих днях — в буфер. Аналог createVacation, но привязка метки —
 * к группе (lesson_groups), а не к преподавателю. Откат — через undo (action
 * 'vacation'): удаляет созданные «Отп» и возвращает занятия из буфера.
 * ponytail: потоковое занятие паркуется целиком (как и у отпуска преподавателя) —
 * если у группы есть общая пара с другими группами, она уйдёт в буфер для всех;
 * вернуть можно через «Отменить».
 * @returns {{ok:boolean, count?:number, moved?:number, reasons?:string[]}}
 */
function createGroupVacation(group, fromISO, toISO, label = 'Отп') {
  const name = String(group || '').trim();
  if (!name) return { ok: false, reasons: ['Не указана группа'] };
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isISO(fromISO) || !isISO(toISO)) {
    return { ok: false, reasons: ['Нужны даты начала и конца отпуска (ГГГГ-ММ-ДД)'] };
  }
  if (fromISO > toISO) return { ok: false, reasons: ['Дата начала позже даты конца'] };
  const mark = String(label || 'Отп').trim() || 'Отп';

  return transaction((db) => {
    const semester = getSemester(db);
    if (!semester || !semester.start) {
      return { ok: false, reasons: ['Не задан семестр — нет привязки дат к неделям'] };
    }
    const monday = week1Monday(semester.start);
    if (!monday) return { ok: false, reasons: ['Некорректная дата начала семестра'] };
    const weeks = weekCount(semester);

    const groupId = getOrCreate(db, 'groups', 'name', name);

    // Рабочие дни периода (в пределах семестра): набор и список «неделя|день».
    const periodDays = [];
    const periodDaySet = new Set();
    const from = new Date(fromISO + 'T00:00:00Z').getTime();
    const to = new Date(toISO + 'T00:00:00Z').getTime();
    for (let t = from; t <= to; t += 86400000) {
      const dayDiff = Math.round((t - monday.getTime()) / 86400000);
      if (dayDiff < 0) continue;
      const weekNo = Math.floor(dayDiff / 7) + 1;
      const dayIdx = dayDiff % 7;
      if (dayIdx === 6) continue; // воскресенье — занятий нет
      if (weeks && weekNo > weeks) continue;
      const day = DAYS[dayIdx];
      const key = `${weekNo}|${day}`;
      if (!periodDaySet.has(key)) {
        periodDaySet.add(key);
        periodDays.push({ weekNo, day });
      }
    }
    if (!periodDays.length) {
      return { ok: false, reasons: ['В выбранном периоде нет рабочих дней в пределах семестра'] };
    }

    // Занятия группы в эти дни: реальные пары → в буфер; мероприятия — оставляем.
    const hasEvent = new Set(); // "неделя|день|пара"
    const parkedIds = [];
    const park = db.prepare('UPDATE lessons SET parked = 1 WHERE id = ?');
    for (const l of loadLessons(db)) {
      if (l.parked || !(l.groups || []).includes(name)) continue;
      if (!periodDaySet.has(`${l.weekNo}|${l.day}`)) continue;
      if (l.event) {
        hasEvent.add(`${l.weekNo}|${l.day}|${l.pairNo}`);
      } else {
        park.run(l.id);
        parkedIds.push(l.id);
      }
    }

    // «Отп» (event) во все рабочие ячейки периода, привязка к группе.
    const ins = db.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, category)
       VALUES (?, ?, ?, ?, ?, ?, 'event')`
    );
    const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    const ids = [];
    for (const { weekNo, day } of periodDays) {
      const maxPair = day === 'Сб' ? 3 : PAIRS_PER_DAY;
      for (let p = 1; p <= maxPair; p++) {
        if (hasEvent.has(`${weekNo}|${day}|${p}`)) continue;
        const times = PAIR_TIMES[p] || { start: null, end: null };
        const info = ins.run(day, p, times.start, times.end, weekNo, mark);
        const lid = Number(info.lastInsertRowid);
        insLG.run(lid, groupId);
        ids.push(lid);
      }
    }

    if (!ids.length && !parkedIds.length) {
      return { ok: false, reasons: ['В выбранном периоде нечего проставлять'] };
    }

    const desc = `Отпуск группы: ${name} (${fromISO}–${toISO}, ${ids.length} пар, в буфер: ${parkedIds.length})`;
    pushUndo(db, 'vacation', desc, { ids, parkedIds });
    return { ok: true, count: ids.length, moved: parkedIds.length };
  });
}

/**
 * Вывод аудитории из эксплуатации на период [fromISO, toISO]: все занятия этой
 * аудитории в рабочие дни периода переселяются в другие СВОБОДНЫЕ аудитории
 * (не занятые в том же слоте, нескрытые, с достаточной вместимостью). Приоритет
 * подбора — аудитория ТОЙ ЖЕ кафедры, что и выводимая; затем любая свободная.
 * Если свободной аудитории нет — занятие уходит в БУФЕР (parked). Каждое
 * переселение/уход в буфер фиксируется в журнале переносов (from_room → room).
 * Двух-аудиторное занятие сохраняет вторую аудиторию, заменяется только выводимая.
 * Откат — через undo (action 'decommission' восстанавливает прежние аудитории и
 * флаг parked, удаляет метки). Будущее размещение в этой аудитории НЕ блокируется.
 * @returns {{ok, room?, moved?:[{id,from,to}], movedCount?, parked?, unplaced?, marks?, reasons?}}
 */
function decommissionRoom(room, fromISO, toISO, reason) {
  const name = String(room || '').trim();
  if (!name) return { ok: false, reasons: ['Не указана аудитория'] };
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isISO(fromISO) || !isISO(toISO)) return { ok: false, reasons: ['Нужны даты начала и конца (ГГГГ-ММ-ДД)'] };
  if (fromISO > toISO) return { ok: false, reasons: ['Дата начала позже даты конца'] };

  return transaction((db) => {
    const semester = getSemester(db);
    if (!semester || !semester.start) return { ok: false, reasons: ['Не задан семестр — нет привязки дат к неделям'] };
    const monday = week1Monday(semester.start);
    if (!monday) return { ok: false, reasons: ['Некорректная дата начала семестра'] };
    const weeks = weekCount(semester);

    // (неделя|день) рабочих дней периода.
    const periodDaySet = new Set();
    const from = new Date(fromISO + 'T00:00:00Z').getTime();
    const to = new Date(toISO + 'T00:00:00Z').getTime();
    for (let t = from; t <= to; t += 86400000) {
      const dayDiff = Math.round((t - monday.getTime()) / 86400000);
      if (dayDiff < 0) continue;
      const weekNo = Math.floor(dayDiff / 7) + 1;
      const dayIdx = dayDiff % 7;
      if (dayIdx === 6) continue; // воскресенье
      if (weeks && weekNo > weeks) continue;
      periodDaySet.add(`${weekNo}|${DAYS[dayIdx]}`);
    }
    if (!periodDaySet.size) return { ok: false, reasons: ['В выбранном периоде нет рабочих дней в пределах семестра'] };

    const lessons = loadLessons(db).filter((l) => !l.parked);
    const ref = loadReference(db);
    const roomsOf = (l) => (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []));

    const affected = lessons.filter(
      (l) => !l.event && periodDaySet.has(`${l.weekNo}|${l.day}`) && roomsOf(l).includes(name)
    );

    // Занятость аудиторий по слоту (день|пара|неделя).
    const slotKey = (l) => `${l.day}|${l.pairNo}|${l.weekNo}`;
    const busyBySlot = new Map();
    for (const l of lessons) {
      const k = slotKey(l);
      if (!busyBySlot.has(k)) busyBySlot.set(k, new Set());
      for (const r of roomsOf(l)) busyBySlot.get(k).add(r);
    }

    const need = (l) => (l.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0);
    const srcDept = ref.roomDept[name] || null; // кафедра выводимой аудитории
    const candidates = [...ref.rooms].filter((r) => r !== name && !ref.roomHidden.has(r));
    const reasonText = (reason && String(reason).trim()) || '';

    const snapshots = [];
    const moved = [];
    const parked = []; // занятия, которым не нашлось аудитории → в буфер
    const updMain = db.prepare('UPDATE lessons SET room_id = ? WHERE id = ?');
    const parkStmt = db.prepare('UPDATE lessons SET parked = 1 WHERE id = ?');

    // Запись смены аудитории в журнал: слот не меняется, меняется только
    // аудитория (from_room → room; null room = буфер). Действие — 'room', как у
    // ручной правки и подбора аудиторий; в примечании — причина вывода.
    const insLog = db.prepare(
      `INSERT INTO move_log
         (lesson_id, moved_at, action, groups, subject, subject_full, type, topic, teacher,
          from_date, from_day, from_pair, from_week, to_date, to_day, to_pair, to_week,
          room, from_room, note)
       VALUES (?, ?, 'room', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const logRelocation = (l, toRoom, note) => {
      const d = lessonDate(l.weekNo, l.day, semester);
      insLog.run(
        l.id, new Date().toISOString(), (l.groups || []).join(', '),
        l.subject || null, l.subjectFull || null, l.type || null, l.topic || null, l.teacher || null,
        d, l.day, l.pairNo, l.weekNo, d, l.day, l.pairNo, l.weekNo,
        toRoom, name, note
      );
    };

    for (const l of affected) {
      const cur = roomsOf(l);
      const keep = cur.filter((r) => r !== name); // вторая аудитория (если была)
      const keepCap = keep.reduce((s, r) => s + (ref.roomCapacity[r] ?? 0), 0);
      const required = need(l);
      const busy = busyBySlot.get(slotKey(l)) || new Set();

      // Свободные в слоте кандидаты, подходящие по вместимости. Приоритет: та же
      // кафедра, что у выводимой аудитории → меньшая подходящая вместимость → имя.
      const pick = candidates
        .filter((r) => !busy.has(r))
        .map((r) => ({ r, cap: ref.roomCapacity[r] ?? null, sameDept: srcDept != null && ref.roomDept[r] === srcDept }))
        .filter((c) => !required || c.cap == null || keepCap + c.cap >= required)
        .sort(
          (a, b) =>
            (a.sameDept === b.sameDept ? 0 : a.sameDept ? -1 : 1) ||
            (a.cap == null ? Infinity : a.cap) - (b.cap == null ? Infinity : b.cap) ||
            a.r.localeCompare(b.r, 'ru')
        )[0];

      // В снимке — и цепочка журнала: «Отменить» снимает записи о переселении.
      snapshots.push({ ...lessonSnapshot(l), moveLogBefore: moveLogChain(db, l.id) });
      if (pick) {
        const roomIds = [...keep, pick.r].map((n) => getOrCreate(db, 'rooms', 'name', n));
        updMain.run(roomIds[0] ?? null, l.id);
        setLessonRoomsRows(db, l.id, roomIds);
        busy.add(pick.r); // занять новую аудиторию в этом слоте
        moved.push({ id: l.id, from: name, to: pick.r });
        logRelocation(l, pick.r, `Вывод ауд. ${name}${reasonText ? ': ' + reasonText : ''}${pick.sameDept || srcDept == null ? '' : ' (другая кафедра)'}`);
      } else {
        // Свободной аудитории нет — снимаем выводимую (оставляя вторую, если была)
        // и паркуем занятие в буфер.
        const roomIds = keep.map((n) => getOrCreate(db, 'rooms', 'name', n));
        updMain.run(roomIds[0] ?? null, l.id);
        setLessonRoomsRows(db, l.id, roomIds);
        parkStmt.run(l.id);
        parked.push(l.id);
        logRelocation(l, null, `Вывод ауд. ${name}${reasonText ? ': ' + reasonText : ''} — нет свободной, в буфер`);
      }
    }

    // Метка причины во все рабочие ячейки периода этой аудитории (как «Отп»):
    // кроме слотов, где аудитория ОСТАЁТСЯ занятой (непереселённые занятия или
    // уже стоящие там мероприятия) — поверх занятия метку не ставим.
    const leftIds = new Set([...moved.map((m) => m.id), ...parked]); // ушли из аудитории
    const occupied = new Set(); // "неделя|день|пара", где аудитория ещё занята
    for (const l of lessons) {
      if (!periodDaySet.has(`${l.weekNo}|${l.day}`) || !roomsOf(l).includes(name)) continue;
      if (leftIds.has(l.id)) continue; // переехало/в буфер — слот освободился
      occupied.add(`${l.weekNo}|${l.day}|${l.pairNo}`);
    }

    const mark = reasonText || 'Закрыто';
    const roomId = getOrCreate(db, 'rooms', 'name', name);
    const insMark = db.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, room_id, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'event')`
    );
    const insLR = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
    const markerIds = [];
    for (const key of periodDaySet) {
      const [wkStr, day] = key.split('|');
      const weekNo = Number(wkStr);
      const maxPair = day === 'Сб' ? 3 : PAIRS_PER_DAY;
      for (let p = 1; p <= maxPair; p++) {
        if (occupied.has(`${weekNo}|${day}|${p}`)) continue;
        const times = PAIR_TIMES[p] || { start: null, end: null };
        const info = insMark.run(day, p, times.start, times.end, weekNo, mark, roomId);
        const lid = Number(info.lastInsertRowid);
        insLR.run(lid, roomId);
        markerIds.push(lid);
      }
    }

    if (!moved.length && !parked.length && !markerIds.length) {
      return { ok: false, reasons: [`Аудиторию «${name}» нельзя вывести: нет занятий для переселения и нет свободных ячеек для отметки`] };
    }

    const desc = `Вывод аудитории ${name} (${fromISO}–${toISO}${reason ? `, причина: ${reason}` : ''}): переселено ${moved.length}${parked.length ? `, в буфер ${parked.length}` : ''}, меток ${markerIds.length}`;
    // action 'decommission' в undo: удалить созданные метки + вернуть прежние аудитории
    // и флаг parked (снимки сняты до переселения/парковки).
    pushUndo(db, 'decommission', desc, { ids: markerIds, snapshots });
    return { ok: true, room: name, moved, movedCount: moved.length, parked: parked.length, unplaced: 0, marks: markerIds.length };
  });
}

// Удаление всех занятий СР в пределах ОДНОЙ недели — парная операция к
// placeSelfStudy («Удалить СР» рядом с «Расставить СР»). Удаляются только занятия
// с дисциплиной «СР» этой недели (не в буфере). Откат — через undo ('deleteEntity'
// восстанавливает занятия из снимков).
function clearSrWeek(weekNo) {
  const wk = Number(weekNo);
  if (!wk || wk < 1) return { ok: false, code: 400, reasons: ['Не указана неделя (откройте сводное расписание и выберите неделю)'] };
  return transaction((tx) => {
    const week = loadLessons(tx).filter((l) => !l.parked && l.weekNo === wk);
    const sr = week.filter((l) => l.subject === 'СР');
    // Аудитории, проставленные меткам ЭкзС той же расстановкой, снимаем вместе с
    // СР: одна кнопка откатывает расстановку недели целиком. Сами метки остаются,
    // но расщеплённые (курс сел в несколько аудиторий) склеиваются обратно в одну:
    // иначе в слоте копились бы безаудиторные дубли, и повторный импорт файла
    // группы дописал бы одну и ту же группу сразу в несколько меток.
    const ecs = week.filter((l) => l.event && isEcsMarker(l.subject));
    const withRoom = ecs.filter((l) => (l.rooms || []).length);
    const bySlot = new Map(); // слот → метки этого слота
    for (const l of ecs) {
      const k = `${l.day}|${l.pairNo}`;
      if (!bySlot.has(k)) bySlot.set(k, []);
      bySlot.get(k).push(l);
    }
    const dupes = [...bySlot.values()].filter((list) => list.length > 1);
    if (!sr.length && !withRoom.length && !dupes.length) {
      return { ok: false, code: 404, reasons: [`На неделе ${wk} нет занятий СР`] };
    }
    // В снимок — и удаляемые копии, и выжившая метка (её состав групп меняется).
    const touched = [...new Set([...withRoom, ...dupes.flat()])];
    pushUndo(tx, 'deleteEntity', `Удаление СР недели ${wk} (${sr.length} занятий)`,
      { snapshots: [...sr, ...touched].map(lessonSnapshot) });
    const del = tx.prepare('DELETE FROM lessons WHERE id = ?');
    for (const l of sr) del.run(l.id);
    const clrRoom = tx.prepare('UPDATE lessons SET room_id = NULL WHERE id = ?');
    const clrLR = tx.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?');
    for (const l of withRoom) {
      clrRoom.run(l.id);
      clrLR.run(l.id);
    }
    // Склейка: остаётся метка с меньшим id, группы копий переезжают в неё.
    const insLG = tx.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    let merged = 0;
    for (const list of dupes) {
      const [keep, ...rest] = [...list].sort((a, b) => a.id - b.id);
      for (const l of rest) {
        for (const g of (l.groupsAll || l.groups || [])) insLG.run(keep.id, getOrCreate(tx, 'groups', 'name', g));
        del.run(l.id);
        merged += 1;
      }
    }
    return { ok: true, deleted: sr.length, ecsCleared: withRoom.length, ecsMerged: merged, weekNo: wk };
  });
}

// Занятия преподавателя, которые целиком относятся к скрытым группам (т.е. НИ ОДНА
// из групп занятия не входит в перечень отображаемых — hidden=0). Потоковые занятия,
// где отображается хотя бы одна группа, НЕ считаются — они всё ещё нужны видимой
// группе. Занятия без групп (мероприятия) не трогаем — им нечего сверять. Буфер
// (parked) не входит в расписание преподавателя — не учитывается.
// @returns {{teacher:string, groups:string[], count:number, lessonIds:number[]}}
function findHiddenGroupTeacherLessons(teacher, db = getDb()) {
  const ref = loadReference(db);
  const lessons = loadLessons(db).filter(
    (l) => !l.parked && (l.teacher === teacher || (l.teachers || []).includes(teacher))
  );
  const matched = lessons.filter(
    (l) => (l.groups || []).length > 0 && l.groups.every((g) => ref.groupHidden.has(g))
  );
  const groups = [...new Set(matched.flatMap((l) => l.groups))].sort();
  return { teacher, groups, count: matched.length, lessonIds: matched.map((l) => l.id), lessons: matched };
}

// Предпросмотр для кнопки «Удалить занятия скрытых групп» в расписании преподавателя:
// какие группы и сколько занятий попадут под удаление — без изменения БД.
function previewHiddenGroupTeacherLessons(teacher, db = getDb()) {
  if (!teacher) return { ok: false, code: 400, reasons: ['Не указан преподаватель'] };
  const { groups, count } = findHiddenGroupTeacherLessons(teacher, db);
  return { ok: true, teacher, groups, count };
}

// Удаляет из расписания преподавателя ВСЕ занятия, у которых ни одна группа не
// входит в перечень отображаемых (все группы занятия скрыты). Действует по всему
// расписанию преподавателя (а не только по открытой неделе). Откат — через undo
// ('deleteEntity' восстанавливает занятия из снимков).
function clearHiddenGroupTeacherLessons(teacher) {
  return transaction((tx) => {
    if (!teacher) return { ok: false, code: 400, reasons: ['Не указан преподаватель'] };
    const { groups, lessons } = findHiddenGroupTeacherLessons(teacher, tx);
    if (!lessons.length) return { ok: false, code: 404, reasons: ['Нет занятий скрытых групп в расписании этого преподавателя'] };
    pushUndo(
      tx,
      'deleteEntity',
      `Удаление занятий скрытых групп (${groups.join(', ')}) у преподавателя ${teacher} (${lessons.length} занятий)`,
      { snapshots: lessons.map(lessonSnapshot) }
    );
    const del = tx.prepare('DELETE FROM lessons WHERE id = ?');
    for (const l of lessons) del.run(l.id);
    return { ok: true, deleted: lessons.length, groups, teacher };
  });
}

// Ручная блокировка ОДНОЙ свободной ячейки в расписании преподавателя: ставит
// туда мероприятие-метку (category='event', без групп и аудитории) — она
// занимает слот преподавателя, поэтому новое занятие туда поставить будет
// нельзя (как и обычное мероприятие, блокировка учитывается как занятость в
// getFreeSlotsFor/getMoveOptions). Слот должен быть СВОБОДЕН у преподавателя —
// если там уже что-то есть (занятие, мероприятие, другая блокировка), отказ.
// Убрать блокировку можно как обычное занятие — открыть карточку и удалить.
// Откат — через undo (action 'create', как у ручного добавления занятия).
// @returns {{ok:boolean, id?:number, reasons?:string[]}}
function blockTeacherSlot(teacher, day, pairNo, weekNo, label = 'Блок') {
  const name = String(teacher || '').trim();
  if (!name) return { ok: false, code: 400, reasons: ['Не указан преподаватель'] };
  const d = String(day || '').trim();
  const p = Number(pairNo);
  const w = Number(weekNo);
  if (!DAYS.includes(d) || !p || p < 1 || !w || w < 1) {
    return { ok: false, code: 400, reasons: ['Нужны корректные день, пара и неделя'] };
  }
  const mark = String(label || 'Блок').trim() || 'Блок';

  return transaction((db) => {
    const busy = loadLessons(db).some(
      (l) =>
        !l.parked &&
        l.day === d &&
        l.pairNo === p &&
        l.weekNo === w &&
        (l.teacher === name || (l.teachers || []).includes(name))
    );
    if (busy) return { ok: false, code: 409, reasons: ['Ячейка уже занята — блокировка невозможна'] };

    const times = PAIR_TIMES[p] || { start: null, end: null };
    const teacherId = getOrCreate(db, 'teachers', 'name', name);
    const info = db
      .prepare(
        `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, teacher_id, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'event')`
      )
      .run(d, p, times.start, times.end, w, mark, teacherId);
    const lid = Number(info.lastInsertRowid);
    pushUndo(db, 'create', `Блокировка ячейки: ${name} ${d} п${p} н${w}`, { id: lid });
    return { ok: true, id: lid };
  });
}

/**
 * Автоматическая расстановка самостоятельной работы (СР) в пределах ОДНОЙ недели
 * (той, что открыта в сводном расписании). Во все свободные ячейки этой недели
 * (там, где у группы нет занятия) ставит занятие «СР», подбирая НЕскрытую аудиторию
 * по вместимости. Три фазы по приоритету аудиторий: (1) БОЛЬШИЕ аудитории (>25 мест)
 * — максимально набиваем, совмещая группы одного курса; (2) ПОКАФЕДРАЛЬНО — остаток
 * в аудитории своей кафедры; (3) ОСТАВШИЕСЯ — любые свободные. Аудитория «только для
 * курса» (course_only) занимается лишь группами своего курса во всех фазах. Группы
 * ОДНОГО курса в одном слоте объединяются в одну потоковую запись СР, делящую
 * аудиторию (сумма численностей ≤ вместимости). Курсы между собой не смешиваются,
 * а обслуживаются от СТАРШЕГО к младшему (5 → 1, без курса — в конце): пул
 * аудиторий на слот общий, и кто раньше, тот и выбирает. Аудитория берётся не
 * самая большая, а наименьшая, куда сядет весь хвост курса, — число мест стремится
 * к числу курсантов. Метке ЭкзС аудитория проставляется тем же способом; если
 * группы курса разошлись по разным аудиториям, метка расщепляется на копии по
 * одной на аудиторию (весь курс в одной аудитории сидеть не обязан).
 * Явная массовая операция (как отпуск): без проверки накладок, откат —
 * через undo (action 'vacation' удаляет созданные записи). Идемпотентна: повторный
 * запуск заполняет только оставшиеся свободные ячейки.
 * ponytail: группы без численности и аудитории без вместимости пропускаются — без
 * них вместимость не проверить; задайте их в «Справочниках».
 * @param {number} weekNo учебная неделя (1..N), в пределах которой расставляем
 * @returns {{ok:boolean, created?:number, unplaced?:number, reasons?:string[]}}
 */
function placeSelfStudy(weekNo) {
  return transaction((tx) => {
    const week = Number(weekNo);
    if (!week || week < 1) return { ok: false, code: 400, reasons: ['Не указана неделя для расстановки (откройте сводное расписание и выберите неделю)'] };
    const sem = getSemester(tx);
    const holidays = new Set(getHolidays(tx));
    const courses = getCourses(tx);
    const ref = loadReference(tx);
    const lessons = loadLessons(tx).filter((l) => !l.parked);

    // Группы с известной численностью и аудитории с известной вместимостью —
    // иначе вместимость не проверить. Аудитории сортируем по убыванию вместимости.
    const groups = [...ref.groups].filter((g) => !ref.groupHidden.has(g) && (ref.groupHeadcount[g] || 0) > 0);
    const rooms = [...ref.rooms]
      .filter((r) => !ref.roomHidden.has(r) && (ref.roomCapacity[r] || 0) > 0)
      .map((name) => ({
        name,
        cap: ref.roomCapacity[name],
        dept: ref.roomDept[name] || null,
        course: ref.roomCourse[name] != null ? String(ref.roomCourse[name]) : null, // только для курса
      }))
      .sort((a, b) => b.cap - a.cap);
    if (!groups.length || !rooms.length) {
      return { ok: false, reasons: ['Нет групп с численностью или аудиторий с вместимостью (задайте в «Справочниках»)'] };
    }

    // Допустимое превышение мест при расстановке СР: на самоподготовку курсанты
    // садятся плотнее (приставные места). Превышение считается НА АУДИТОРИЮ и не
    // накапливается: remaining не опускается ниже -SR_SLACK.
    const SR_SLACK = 2;
    const courseOf = (g) => String(courses[groupPrefix(g)] ?? groupPrefix(g));
    const hc = (g) => ref.groupHeadcount[g];
    // Аудитория «только для курса» доступна лишь группам этого курса; без ограничения — всем.
    const courseOK = (r, c) => r.course == null || r.course === c;
    // Порядок раздачи аудиторий по курсам: старшие первыми (5 → … → 1), группы с
    // ненастроенным курсом — в самом конце. Пул аудиторий на слот общий и убывает,
    // поэтому кто идёт раньше, тот и забирает подходящие аудитории.
    const known = new Set(Object.values(courses).map((v) => String(v)));
    const rank = (c) => (known.has(c) ? Number(c) || 0 : -1);
    const byCourseOrder = (a, b) =>
      rank(b[0]) - rank(a[0]) || String(a[0]).localeCompare(String(b[0]), 'ru', { numeric: true });

    // Упаковка групп ОДНОГО курса в аудитории из пула: совмещаем группы, пока влезают
    // по вместимости. eligible — предикат допустимой аудитории (фаза 1: большие;
    // фаза 2: своя кафедра; фаза 3: любая). Открытые аудитории удаляются из пула.
    // Возвращает потоки и не влезшие группы.
    const pack = (list, pool, eligible) => {
      const opened = [];
      const leftover = [];
      const order = [...list].sort((a, b) => hc(b) - hc(a));
      let left = order.reduce((s, g) => s + hc(g), 0); // курсантам ещё нужно мест
      for (const g of order) {
        const h = hc(g);
        // Best fit: садим в аудиторию с наименьшим достаточным остатком — большие
        // остатки берегутся под следующие группы.
        let spot = null;
        for (const o of opened) {
          if (o.remaining + SR_SLACK >= h && (!spot || o.remaining < spot.remaining)) spot = o;
        }
        if (spot) {
          spot.remaining -= h;
          spot.members.push(g);
          left -= h;
          continue;
        }
        // Главное правило: число мест стремится к числу курсантов. Берём наименьшую
        // аудиторию, куда сядет весь оставшийся хвост курса (left) — иначе зал на 100
        // мест уходит под две группы по 19. Если целиком не влезает никуда, берём
        // наибольшую подходящую: её добьют следующие группы (pool отсортирован по
        // убыванию, поэтому «наименьшая» — это поиск с конца).
        let idx = -1;
        for (let i = pool.length - 1; i >= 0; i--) {
          if (eligible(pool[i]) && pool[i].cap + SR_SLACK >= left) { idx = i; break; }
        }
        if (idx < 0) idx = pool.findIndex((r) => eligible(r) && r.cap + SR_SLACK >= h);
        if (idx >= 0) {
          const room = pool.splice(idx, 1)[0];
          opened.push({ room: room.name, remaining: room.cap - h, members: [g] });
        } else {
          leftover.push(g);
        }
        left -= h; // место этой группе больше не ищем — ни здесь, ни в следующей фазе
      }
      return { opened, leftover };
    };

    // Занятость по слотам "week|day|pair": группы и аудитории существующих занятий.
    // Метка ЭкзС занятостью НЕ считается: группе на сессии тоже нужна аудитория,
    // и мы подбираем её тем же способом — только вместо создания СР проставляем
    // аудиторию самой метке (см. ecsAt / createLessons).
    const slotKey = (w, d, p) => `${w}|${d}|${p}`;
    const groupBusy = new Set(); // "group@week|day|pair"
    const roomBusy = new Set(); // "room@week|day|pair"
    const ecsAt = new Map(); // "group@week|day|pair" → занятие-метка ЭкзС без аудитории
    for (const l of lessons) {
      const sk = slotKey(l.weekNo, l.day, l.pairNo);
      const ecsFree = l.event && isEcsMarker(l.subject) && !(l.rooms || []).length;
      for (const g of (l.groups || [])) {
        if (ecsFree) ecsAt.set(`${g}@${sk}`, l);
        else groupBusy.add(`${g}@${sk}`);
      }
      for (const r of (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []))) roomBusy.add(`${r}@${sk}`);
    }

    const insL = tx.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, type, teacher_id, room_id, category)
       VALUES (?, ?, ?, ?, ?, 'СР', NULL, NULL, ?, 'lesson')`
    );
    const insLG = tx.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    const insLR = tx.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
    const roomId = {}; // кэш id аудиторий
    const rid = (name) => (roomId[name] ??= getOrCreate(tx, 'rooms', 'name', name));
    const groupId = {};
    const gid = (name) => (groupId[name] ??= getOrCreate(tx, 'groups', 'name', name));

    // Проставить аудиторию существующему занятию (метке ЭкзС): и основную, и в
    // lesson_rooms — как у обычного занятия.
    const updRoom = tx.prepare('UPDATE lessons SET room_id = ? WHERE id = ?');
    const delLR = tx.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?');
    const setRoomFor = (lessonId, roomName) => {
      const id = rid(roomName);
      updRoom.run(id, lessonId);
      delLR.run(lessonId);
      insLR.run(lessonId, id);
    };
    // Копия метки ЭкзС под вторую (третью…) аудиторию: та же строка, другая аудитория.
    const cloneEcs = tx.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, type,
         topic, note, teacher_id, room_id, category, locked)
       SELECT day, pair_no, time_start, time_end, week_no, subject, type,
         topic, note, teacher_id, ?, category, locked FROM lessons WHERE id = ?`
    );
    const delLG = tx.prepare('DELETE FROM lesson_groups WHERE lesson_id = ? AND group_id = ?');

    const ids = [];
    const ecsRooms = []; // { id, room } — меткам ЭкзС проставлена аудитория
    const ecsSplit = []; // { id, from, groups } — копии метки под доп. аудитории
    let unplaced = 0;
    const unplacedCells = []; // { day, pairNo, group } — где не хватило аудитории

    const w = week; // строго в пределах открытой недели
    {
      for (const day of DAYS) {
        if (day === 'Вс') continue;
        if (holidayWarning(w, day, sem, holidays)) continue; // нерабочий день — без СР
        for (const p of (day === 'Сб' ? [1, 2, 3] : [1, 2, 3, 4])) {
          const sk = slotKey(w, day, p);
          // Свободные группы слота.
          const free = groups.filter((g) => !groupBusy.has(`${g}@${sk}`));
          if (!free.length) continue;
          // Свободные аудитории слота (по убыванию вместимости) — общий пул на слот.
          const pool = rooms.filter((r) => !roomBusy.has(`${r.name}@${sk}`)).map((r) => ({ ...r }));
          const times = PAIR_TIMES[p] || { start: null, end: null };
          const ecsRoom = new Map(); // id метки → аудитория, уже проставленная в этом слоте

          // Создаёт по одной записи СР на каждую открытую аудиторию (поток её групп).
          // Группам, у которых в этом слоте стоит ЭкзС, занятие не создаём —
          // аудиторию получает сама метка (сидят там же, где и остальные).
          const createLessons = (opened) => {
            for (const o of opened) {
              const ecsGroups = o.members.filter((g) => ecsAt.has(`${g}@${sk}`));
              const srGroups = o.members.filter((g) => !ecsAt.has(`${g}@${sk}`));
              // Группы одной метки ЭкзС могут разойтись по РАЗНЫМ аудиториям (весь
              // курс не обязан сидеть в одной): первой аудитории достаётся сама
              // метка, под каждую следующую метка расщепляется — её группы
              // переезжают в копию со своей аудиторией. Без этого аудиторию видела
              // бы только последняя из них.
              const byMarker = new Map(); // метка → её группы, попавшие в ЭТУ аудиторию
              for (const g of ecsGroups) {
                const ev = ecsAt.get(`${g}@${sk}`);
                if (!byMarker.has(ev)) byMarker.set(ev, []);
                byMarker.get(ev).push(g);
                ecsAt.delete(`${g}@${sk}`);
                groupBusy.add(`${g}@${sk}`);
              }
              for (const [ev, gs] of byMarker) {
                if (!ecsRoom.has(ev.id)) {
                  ecsRoom.set(ev.id, o.room);
                  setRoomFor(ev.id, o.room);
                  ecsRooms.push({ id: ev.id, room: o.room });
                  continue;
                }
                const lid = Number(cloneEcs.run(rid(o.room), ev.id).lastInsertRowid);
                insLR.run(lid, rid(o.room));
                for (const g of gs) {
                  delLG.run(ev.id, gid(g));
                  insLG.run(lid, gid(g));
                }
                ecsSplit.push({ id: lid, from: ev.id, groups: gs });
              }
              if (srGroups.length) {
                const info = insL.run(day, p, times.start, times.end, w, rid(o.room));
                const lid = Number(info.lastInsertRowid);
                ids.push(lid);
                for (const g of srGroups) {
                  insLG.run(lid, gid(g));
                  groupBusy.add(`${g}@${sk}`);
                }
                insLR.run(lid, rid(o.room));
              }
              roomBusy.add(`${o.room}@${sk}`);
            }
          };

          const byCourse = (list) => {
            const m = new Map();
            for (const g of list) {
              const c = courseOf(g);
              if (!m.has(c)) m.set(c, []);
              m.get(c).push(g);
            }
            return m;
          };

          // Фаза 1 — ПОКАФЕДРАЛЬНО: каждый курс сперва пробует СВОЮ кафедру, старшие
          // курсы идут первыми и разбирают кафедральные аудитории раньше младших
          // (общий пул на слот). Без кафедры у группы — сразу в фазу 2.
          const afterDept = [];
          const byDept = new Map();
          for (const g of free) {
            const d = ref.groupDept[g];
            if (!d) { afterDept.push(g); continue; }
            if (!byDept.has(d)) byDept.set(d, []);
            byDept.get(d).push(g);
          }
          for (const [d, list] of [...byDept.entries()].sort()) {
            for (const [c, clist] of [...byCourse(list).entries()].sort(byCourseOrder)) {
              const { opened, leftover } = pack(clist, pool, (r) => r.dept === d && courseOK(r, c));
              createLessons(opened);
              afterDept.push(...leftover);
            }
          }

          // Фаза 2 — ЛЮБАЯ оставшаяся аудитория (без ограничения по размеру и
          // кафедре, совмещая группы курса): чем младше курс, тем чаще он сюда и
          // попадает, а тем самым решает уже не кафедра, а плотность заполнения.
          // Что не влезло — оставляем без СР и помечаем ячейку (группа+слот).
          for (const [c, clist] of [...byCourse(afterDept).entries()].sort(byCourseOrder)) {
            const { opened, leftover } = pack(clist, pool, (r) => courseOK(r, c));
            createLessons(opened);
            unplaced += leftover.length;
            for (const g of leftover) unplacedCells.push({ day, pairNo: p, group: g });
          }
        }
      }
    }

    if (!ids.length && !ecsRooms.length && !ecsSplit.length) {
      return { ok: false, reasons: [`На неделе ${week} нет свободных ячеек под СР (или подходящих аудиторий)`] };
    }
    // Откат: созданные СР удаляются, у меток ЭкзС аудитория снимается (до
    // расстановки её не было — мы берём только метки без аудитории), а копии
    // расщеплённых меток удаляются с возвратом групп исходной.
    pushUndo(tx, 'vacation', `Авто-расстановка СР на неделе ${week} (${ids.length} занятий)`,
      { ids, parkedIds: [], ecsRoomIds: ecsRooms.map((e) => e.id), ecsSplit });
    return {
      ok: true, created: ids.length, unplaced, weekNo: week, unplacedCells,
      ecsRooms: ecsRooms.length + ecsSplit.length,
    };
  });
}

/**
 * Подсказки, как найти аудиторию для группы в конкретном слоте (когда после
 * расстановки СР места не нашлось). Считает:
 *  - direct: свободные аудитории, которые вмещают группу (и допускают её курс);
 *  - relocations: «потеснить» — перенести существующую запись СР из БОЛЬШОЙ
 *    аудитории (которая вместила бы группу) в меньшую свободную, освободив большую.
 * Двигаем только СР (нашу авто-расстановку), реальные занятия не трогаем.
 * @returns {{ok, group, need, course, direct:[], relocations:[]}}
 */
function suggestSrPlacement(group, day, pairNo, weekNo, db = getDb()) {
  const p = Number(pairNo);
  const w = Number(weekNo);
  if (!group || !day || !p || !w) return { ok: false, reasons: ['Нужны group, day, pairNo, weekNo'] };
  const ref = loadReference(db);
  const courses = getCourses(db);
  const need = ref.groupHeadcount[group] || 0;
  const courseOf = (g) => String(courses[String(g).slice(0, 2)] ?? String(g).slice(0, 2));
  const courseOK = (roomName, c) => {
    const rc = ref.roomCourse[roomName];
    return rc == null || String(rc) === c;
  };
  const cG = courseOf(group);

  const inSlot = loadLessons(db).filter((l) => !l.parked && l.day === day && l.pairNo === p && l.weekNo === w);
  const occ = new Map(); // аудитория → занятие, которое её занимает
  for (const l of inSlot) for (const r of (l.rooms && l.rooms.length ? l.rooms : (l.room ? [l.room] : []))) occ.set(r, l);

  const allRooms = [...ref.rooms]
    .filter((r) => !ref.roomHidden.has(r) && (ref.roomCapacity[r] || 0) > 0)
    .map((name) => ({ name, cap: ref.roomCapacity[name] }));
  const freeRooms = allRooms.filter((r) => !occ.has(r.name));

  // Прямой вариант: свободная аудитория, вмещающая группу (меньшие — выше).
  const direct = freeRooms
    .filter((r) => r.cap >= need && courseOK(r.name, cG))
    .sort((a, b) => a.cap - b.cap)
    .slice(0, 6)
    .map((r) => ({ room: r.name, cap: r.cap }));

  // Релокации: освободить большую занятую СР-аудиторию, переселив её в меньшую свободную.
  const relocations = [];
  for (const [rName, L] of occ) {
    if (L.subject !== 'СР') continue; // двигаем только СР
    const rCap = ref.roomCapacity[rName] || 0;
    if (rCap < need || !courseOK(rName, cG)) continue; // эта аудитория группе не подходит
    const people = (L.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0);
    const cL = courseOf((L.groups || [])[0] || '');
    const target = freeRooms
      .filter((r) => r.name !== rName && r.cap >= people && courseOK(r.name, cL))
      .sort((a, b) => a.cap - b.cap)[0]; // наименьшая подходящая свободная
    if (!target) continue;
    relocations.push({
      lessonId: L.id, groups: L.groups || [], people,
      fromRoom: rName, fromCap: rCap, toRoom: target.name, toCap: target.cap,
    });
  }
  relocations.sort((a, b) => a.toCap - b.toCap || a.fromCap - b.fromCap);

  const shared = [];
  for (const rName of occ.keys()) {
    const lessonsInRoom = inSlot.filter((l) => (l.rooms && l.rooms.includes(rName)) || l.room === rName);
    if (lessonsInRoom.some((l) => l.subject !== 'СР')) continue; // подселяем только к СР
    
    const rCap = ref.roomCapacity[rName] || 0;
    const peopleInRoom = lessonsInRoom.reduce((sum, l) => sum + (l.groups || []).reduce((s, g) => s + (ref.groupHeadcount[g] || 0), 0), 0);
    const remainCap = rCap - peopleInRoom;
    if (remainCap >= need) {
      shared.push({
        room: rName,
        cap: rCap,
        remain: remainCap,
        currentGroups: [...new Set(lessonsInRoom.flatMap((l) => l.groups || []))]
      });
    }
  }
  shared.sort((a, b) => b.remain - a.remain);

  return { ok: true, group, need, course: cG, direct, relocations: relocations.slice(0, 6), shared: shared.slice(0, 6) };
}

// ФИО (через ; , перенос строки) из «сырого» текста столбца подвала, без
// учёных степеней/званий — для справочника преподавателей и выпадающих списков.
function fiosFromText(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/[;\n]/)
        .map((part) => teacherFio(part).trim())
        .filter(Boolean)
    ),
  ];
}

// Синхронизация справочников по строке подвала: дисциплина + её преподаватели
// по ролям. Каждая фамилия из «Лектор»/«Другие виды занятий» заводится в
// teachers — с этого момента у преподавателя есть своё (пока пустое)
// расписание: он появляется в селекторе вида «Преподаватель» и в списках
// выбора, куда потом добавляются занятия.
// @returns {string[]} все ФИО строки (в порядке: лекторы, затем прочие)
function syncSubjectTeachers(db, entry) {
  const lecturers = fiosFromText(entry.lecturer);
  const others = fiosFromText(entry.others);
  const sid = getOrCreate(db, 'subjects', 'abbr', entry.abbr, {
    full_name: entry.fullName,
    dept: entry.dept,
  });
  const link = db.prepare(
    'INSERT OR IGNORE INTO subject_teachers (subject_id, teacher_id, role) VALUES (?, ?, ?)'
  );
  for (const [names, role] of [[lecturers, 'lecturer'], [others, 'other']]) {
    for (const n of names) link.run(sid, getOrCreate(db, 'teachers', 'name', n), role);
  }
  return [...new Set([...lecturers, ...others])];
}

/**
 * Сохранить строку таблицы «Дисциплины и преподаватели» (по индексу в группе):
 * обозначение, дисциплина, кафедра, лектор, другие виды занятий, часы, отчётность.
 * Из «Лектор» и «Другие виды занятий» извлекаются ФИО и синхронизируются со
 * справочником преподавателей (teachers) и связями дисциплина→преподаватель
 * (subject_teachers) — чтобы фамилии появились в выпадающих списках занятий.
 * @returns {{ok:boolean, code?:number, entry?:object, teachers?:string[], reasons?:string[]}}
 */
function saveSubjectRow(group, index, fields) {
  const g = String(group || '').trim();
  if (!g) return { ok: false, code: 400, reasons: ['Не указана группа'] };
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, code: 400, reasons: ['Некорректный номер строки'] };
  }
  const f = fields || {};
  const str = (v) => {
    const s = String(v == null ? '' : v).trim();
    return s || null;
  };

  return transaction((db) => {
    const map = getGroupSubjects(db);
    const list = map[g];
    if (!Array.isArray(list) || index >= list.length) {
      return { ok: false, code: 404, reasons: ['Дисциплина не найдена'] };
    }
    const entry = list[index];
    entry.abbr = str(f.abbr) || entry.abbr;
    entry.fullName = str(f.fullName);
    entry.dept = str(f.dept);
    entry.lecturer = str(f.lecturer);
    entry.others = str(f.others);
    entry.hours = str(f.hours);
    entry.report = str(f.report);

    const teachers = syncSubjectTeachers(db, entry);
    entry.teachers = teachers;

    setGroupSubjects(map, db);
    return { ok: true, entry, teachers };
  });
}

/**
 * Добавление дисциплины в подвал группы («Дисциплины и преподаватели»).
 * Аббревиатура обязательна и уникальна в пределах группы; остальные поля можно
 * подтянуть из общего справочника или заполнить вручную.
 * @returns {{ok:boolean, code?:number, entry?:object, index?:number, reasons?:string[]}}
 */
function addSubjectRow(group, fields) {
  const g = String(group || '').trim();
  if (!g) return { ok: false, code: 400, reasons: ['Не указана группа'] };
  const f = fields || {};
  const str = (v) => {
    const s = String(v == null ? '' : v).trim();
    return s || null;
  };
  const abbr = str(f.abbr);
  if (!abbr) return { ok: false, code: 400, reasons: ['Укажите обозначение дисциплины'] };

  return transaction((db) => {
    const map = getGroupSubjects(db);
    const list = Array.isArray(map[g]) ? map[g] : [];
    if (list.some((s) => String(s.abbr || '').trim().toLowerCase() === abbr.toLowerCase())) {
      return { ok: false, code: 409, reasons: [`Дисциплина «${abbr}» уже есть в списке группы`] };
    }
    const lecturer = str(f.lecturer);
    const others = str(f.others);
    const entry = {
      abbr,
      fullName: str(f.fullName),
      dept: str(f.dept),
      lecturer,
      others,
      hours: str(f.hours),
      report: str(f.report),
      teachers: [],
    };
    list.push(entry);
    map[g] = list;
    // Дисциплина и её преподаватели должны попасть в общие справочники: иначе
    // дисциплину не выбрать в форме занятия, а нового преподавателя не открыть
    // в виде «Преподаватель», чтобы добавить ему занятия.
    entry.teachers = syncSubjectTeachers(db, entry);
    setGroupSubjects(map, db);
    return { ok: true, entry, index: list.length - 1, teachers: entry.teachers };
  });
}

/**
 * Удаление дисциплины из подвала группы ВМЕСТЕ с её занятиями у этой группы.
 * Занятие, где группа не одна (поток), у остальных групп сохраняется — из него
 * убирается только эта группа. Действие обратимо кнопкой «Отменить».
 * @returns {{ok:boolean, code?:number, deleted?:number, modified?:number, reasons?:string[]}}
 */
function deleteSubjectRow(group, index) {
  const g = String(group || '').trim();
  if (!g) return { ok: false, code: 400, reasons: ['Не указана группа'] };
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, code: 400, reasons: ['Некорректный номер строки'] };
  }

  return transaction((db) => {
    const map = getGroupSubjects(db);
    const list = map[g];
    if (!Array.isArray(list) || index >= list.length) {
      return { ok: false, code: 404, reasons: ['Дисциплина не найдена'] };
    }
    const entry = list[index];
    const abbr = String(entry.abbr || '').trim();

    const gRow = db.prepare('SELECT id FROM groups WHERE name = ?').get(g);
    const snapshots = [];
    let deleted = 0;
    let modified = 0;
    if (abbr && gRow) {
      for (const l of loadLessons(db)) {
        if (String(l.subject || '').trim() !== abbr) continue;
        if (!(l.groups || []).includes(g)) continue;
        snapshots.push(lessonSnapshot(l));
        if ((l.groups || []).length === 1) {
          db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
          deleted++;
        } else {
          db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ? AND group_id = ?').run(l.id, gRow.id);
          modified++;
        }
      }
    }

    list.splice(index, 1);
    map[g] = list;
    setGroupSubjects(map, db);

    if (snapshots.length) {
      pushUndo(db, 'deleteEntity', `Удаление дисциплины ${abbr} у группы ${g} (${snapshots.length} занятий)`, { snapshots });
    }
    return { ok: true, deleted, modified };
  });
}

/**
 * Полное редактирование занятия: любые поля (слот, дисциплина, вид, тема,
 * примечание, аудитория, преподаватель, группы). Конфликты проверяются, только
 * если меняется размещение (слот/группы/преподаватель/аудитория) — чтобы можно
 * было править описание даже у занятия с уже существующей накладкой.
 * @returns {{ok:boolean, code?:number, reasons?:string[]}}
 */
function editLesson(lessonId, fields, actor = null) {
  const invalid = invalidInput(lessonFieldErrors(fields));
  if (invalid) return invalid;
  return transaction((db) => {
    const all = loadLessons(db);
    const ref = loadReference(db);
    const L = all.find((l) => l.id === lessonId);
    if (!L) return { ok: false, code: 404, reasons: ['Занятие не найдено'] };
    if (fields.expectedRevision != null) {
      const expected = Number(fields.expectedRevision);
      if (!Number.isSafeInteger(expected) || expected < 0) {
        return { ok: false, code: 400, reasons: ['Некорректная ревизия занятия'] };
      }
      if (expected !== Number(L.revision || 0)) {
        return {
          ok: false,
          code: 409,
          stale: true,
          currentRevision: Number(L.revision || 0),
          reasons: ['Занятие уже изменено в другой вкладке. Обновите расписание и повторите правку.'],
        };
      }
    }

    const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
    const str = (v) => (String(v || '').trim() || null);
    const next = {
      day: has('day') ? fields.day : L.day,
      pairNo: has('pairNo') ? Number(fields.pairNo) : L.pairNo,
      weekNo: has('weekNo') ? Number(fields.weekNo) : L.weekNo,
      subject: has('subject') ? str(fields.subject) : L.subject,
      type: has('type') ? str(fields.type) : L.type,
      topic: has('topic') ? str(fields.topic) : L.topic,
      note: has('note') ? (fields.note ?? null) : (L.note ?? null),
      groups: has('groups') && Array.isArray(fields.groups) ? fields.groups.filter(Boolean) : (L.groups || []),
    };
    // Аудитории: массив rooms[] (1–2) или одиночная room; иначе — как было.
    next.rooms = has('rooms') && Array.isArray(fields.rooms)
      ? [...new Set(fields.rooms.map((r) => str(r)).filter(Boolean))].slice(0, 2)
      : has('room')
        ? (str(fields.room) ? [str(fields.room)] : [])
        : (L.rooms || []);
    next.room = next.rooms[0] || null;
    // Преподаватели: массив teachers (зачёт/экзамен) или одиночный teacher; иначе
    // оставляем как было. Основной (teacher_id) — первый в списке.
    const prevTeachers = L.teachers && L.teachers.length ? L.teachers : (L.teacher ? [L.teacher] : []);
    next.teachers = has('teachers') && Array.isArray(fields.teachers)
      ? [...new Set(fields.teachers.map((t) => str(t)).filter(Boolean))]
      : has('teacher')
        ? (str(fields.teacher) ? [str(fields.teacher)] : [])
        : prevTeachers;
    next.teacher = next.teachers[0] || null;
    const invalidSlot = invalidInput(slotErrors(next));
    if (invalidSlot) return invalidSlot;
    if (!next.groups.length) return { ok: false, code: 400, reasons: ['Нужна хотя бы одна группа'] };

    // Смесью курсов предупреждаем только при смене состава групп — иначе правка
    // темы у давно склеенного занятия каждый раз требовала бы подтверждения.
    const warnings = [];
    if (next.groups.join('|') !== (L.groups || []).join('|')) {
      const mixed = mixedCourseWarning(next.groups, db);
      if (mixed) warnings.push(mixed);
    }

    // Бронь держит слот: остальные поля карточки правятся как обычно.
    if (L.locked && (next.day !== L.day || next.pairNo !== L.pairNo || next.weekNo !== L.weekNo)) {
      return { ok: false, code: 409, reasons: [LOCKED_REASON] };
    }

    const placementChanged =
      next.day !== L.day || next.pairNo !== L.pairNo || next.weekNo !== L.weekNo ||
      next.rooms.join('|') !== (L.rooms || []).join('|') ||
      next.teachers.join('|') !== prevTeachers.join('|') ||
      next.groups.join('|') !== (L.groups || []).join('|');

    // Само мероприятие переносится свободно; занятие — с проверкой накладок,
    // причём мероприятия учитываются как занятость (их слот заблокирован).
    // Отложенное в буфер занятие СТОИТ ВНЕ СЕТКИ: слот в базе у него технический
    // (поля NOT NULL), места он не занимает. Проверять по нему накладки нельзя —
    // иначе правку отложенного занятия блокировал бы чужой урок в старом слоте.
    if (placementChanged && !L.event && !L.parked) {
      if (holidayWarning(next.weekNo, next.day, getSemester(db), new Set(getHolidays(db)))) {
        return { ok: false, code: 409, reasons: [`${next.day} н${next.weekNo} — нерабочий день (выходной)`] };
      }
      const candidate = { id: lessonId, day: next.day, pairNo: next.pairNo, weekNo: next.weekNo, subject: next.subject, type: next.type, teacher: next.teacher, teachers: next.teachers, rooms: next.rooms, groups: next.groups };
      const check = validateMove(candidate, candidate, {
        // Метка ЭкзС — не занятость (см. createLesson выше и validateMoveById).
        lessons: all.filter((l) => !l.parked && !isEcs(l)),
        roomCapacity: ref.roomCapacity,
        groupHeadcount: ref.groupHeadcount,
      });
      if (!check.ok) return { ok: false, code: 409, reasons: check.reasons };
      warnings.push(...check.warnings);
    }
    const soft = confirmable({ warnings }, fields.force);
    if (soft) return soft;

    // Смена слота на ячейку с СР — то же, что перенос (см. displaceSelfStudy).
    const srSnaps = placementChanged && !L.event && !L.parked
      ? displaceSelfStudy(db, all, next.groups, next, lessonId)
      : [];

    // Снимок для «Отменить» — вместе с цепочкой журнала: правка карточки пишет в
    // него шаг переноса или смену аудитории (ниже), и откат должен снять и его.
    const desc = `Редактирование: ${L.subject || '?'} ${(L.groups || []).join(', ')}`;
    const editSnap = { ...lessonSnapshot(L), moveLogBefore: moveLogChain(db, lessonId) };
    const actionLogFloor = actor ? db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM move_log').get().id : 0;
    if (srSnaps.length) pushUndo(db, 'deleteEntity', desc, { snapshots: [editSnap, ...srSnaps] });
    else pushUndo(db, 'edit', desc, editSnap);

    const times = PAIR_TIMES[next.pairNo] || { start: null, end: null };
    const teacherId = next.teacher ? getOrCreate(db, 'teachers', 'name', next.teacher) : null;
    const roomIds = next.rooms.map((n) => getOrCreate(db, 'rooms', 'name', n));
    db.prepare(
      `UPDATE lessons SET day=?, pair_no=?, week_no=?, time_start=?, time_end=?,
              subject=?, type=?, topic=?, note=?, teacher_id=?, room_id=? WHERE id=?`
    ).run(next.day, next.pairNo, next.weekNo, times.start, times.end,
      next.subject, next.type, next.topic, next.note, teacherId, roomIds[0] ?? null, lessonId);

    db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ?').run(lessonId);
    const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    for (const g of next.groups) insLG.run(lessonId, getOrCreate(db, 'groups', 'name', g));

    // Перезаписываем список преподавателей (зачёт/экзамен — их несколько).
    db.prepare('DELETE FROM lesson_teachers WHERE lesson_id = ?').run(lessonId);
    const insLT = db.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) VALUES (?, ?)');
    for (const t of next.teachers) insLT.run(lessonId, getOrCreate(db, 'teachers', 'name', t));

    // Обновляем lesson_rooms: все аудитории занятия (1 или 2).
    setLessonRoomsRows(db, lessonId, roomIds);

    // Журнал: правка слота в карточке — такой же шаг переноса, как перетаскивание;
    // если слот тот же, а аудитория другая — запись о смене аудитории.
    if (next.day !== L.day || next.pairNo !== L.pairNo || next.weekNo !== L.weekNo) {
      logMove(db, L, { day: next.day, pairNo: next.pairNo, weekNo: next.weekNo, room: next.rooms.join(', ') || null });
    } else {
      logRoomChange(db, L, L.rooms || (L.room ? [L.room] : []), next.rooms);
    }

    let actionId;
    const moved = next.day !== L.day || next.pairNo !== L.pairNo || next.weekNo !== L.weekNo
      || next.rooms.join('|') !== (L.rooms || []).join('|');
    if (actor && moved) {
      actionId = fields.commandId || randomUUID();
      db.prepare(
        `INSERT INTO move_actions(action_id, created_at, actor_user_id, actor_name, lesson_id, description, before_json, schedule_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username, lessonId, desc,
        JSON.stringify({ lesson: editSnap, displaced: srSnaps }), getScheduleGeneration());
      db.prepare('UPDATE move_log SET action_id=? WHERE lesson_id=? AND id>?').run(actionId, lessonId, actionLogFloor);
      db.prepare(
        `INSERT INTO move_action_events(action_id, happened_at, actor_user_id, actor_name, event)
         VALUES (?, ?, ?, ?, 'move')`
      ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username);
    }

    return { ok: true, actionId };
  });
}

/**
 * Массовая смена преподавателя по расписанию группы — явная пользовательская
 * операция (как массовый отпуск/удаление расписания): применяется без проверки
 * накладок, любые возникшие конфликты ищет «Поиск ошибок», откат — через undo.
 * - mode 'replace': во всех занятиях группы заменяет преподавателя `from` на `to`
 *   (например, Иванов → Сидоров; занятия других преподавателей не трогаются).
 * - mode 'all': ставит преподавателя `to` на занятия группы в семестре. Если задан
 *   `subject` — только на занятия этой дисциплины (потоковые занятия — это общая
 *   запись, поэтому преподаватель проставляется и остальным группам потока).
 * ponytail: без валидации накладок — flag «на все занятия» намеренно сводит
 * подгрупповые пары к одному преподавателю; пред-проверка делала бы его бесполезным.
 * @returns {{ok:boolean, code?:number, count?:number, reasons?:string[]}}
 */
function replaceGroupTeacher(group, from, to, mode, subject, type, actor = null) {
  return transaction((db) => {
    const toName = String(to || '').trim();
    if (!group) return { ok: false, code: 400, reasons: ['Не указана группа'] };
    if (!toName) return { ok: false, code: 400, reasons: ['Не выбран преподаватель'] };
    const subj = subject != null && subject !== '' ? String(subject) : null;
    const kind = type != null && type !== '' ? String(type) : null;
    const all = loadLessons(db);
    // Занятия группы (включая потоковые, где группа — одна из участников). Мероприятия — мимо.
    // Если задана дисциплина — сужаем до неё (требование для «на все занятия группы»),
    // если задан вид (Л, ПЗ…) — только занятия этого вида.
    const groupLessons = all.filter(
      (l) => !l.event && !l.parked && (l.groups || []).includes(group) &&
        (!subj || (l.subject || '') === subj) && (!kind || (l.type || '') === kind)
    );
    const targets = mode === 'all'
      ? groupLessons
      : groupLessons.filter((l) => (l.teachers || []).includes(from));
    if (!targets.length) {
      const noneMsg = subj ? `У группы нет занятий по дисциплине «${subj}»` : 'У группы нет занятий';
      const replaceMsg = kind
        ? `Нет занятий вида «${kind}» у преподавателя «${from}»`
        : `Нет занятий преподавателя «${from}»`;
      return { ok: false, code: 404, reasons: [mode === 'all' ? noneMsg : replaceMsg] };
    }
    if (actor && actor.role !== 'admin') {
      const { canEditGroups } = require('./userService');
      if (!canEditGroups(actor, targets.flatMap((l) => l.groups || []))) {
        return { ok: false, code: 403, reasons: ['Массовая замена затрагивает занятие недоступной группы'] };
      }
      if (!db.prepare('SELECT 1 FROM teachers WHERE name=?').get(toName)) {
        return { ok: false, code: 403, reasons: ['Можно выбирать только существующих преподавателей'] };
      }
    }
    // Новый набор преподавателей для занятия: 'all' — только to; 'replace' — from→to.
    const newTeachers = (l) => mode === 'all'
      ? [toName]
      : [...new Set((l.teachers || []).map((t) => (t === from ? toName : t)))];

    pushUndo(db, 'deleteEntity', `Смена преподавателя на «${toName}» у группы ${group} (${targets.length} занятий)`,
      { snapshots: targets.map(lessonSnapshot) });

    const updMain = db.prepare('UPDATE lessons SET teacher_id = ? WHERE id = ?');
    const delLT = db.prepare('DELETE FROM lesson_teachers WHERE lesson_id = ?');
    const insLT = db.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) VALUES (?, ?)');
    for (const l of targets) {
      const names = newTeachers(l);
      updMain.run(getOrCreate(db, 'teachers', 'name', names[0]), l.id);
      delLT.run(l.id);
      for (const n of names) insLT.run(l.id, getOrCreate(db, 'teachers', 'name', n));
    }
    return { ok: true, count: targets.length };
  });
}

// ── Перенос экзамена в «окно» с полным ЭкзС (для календаря сессии) ───────────
const isEcsMarker = (s) => String(s || '').trim().toLowerCase() === 'экзс';

// Собрать все «пары» одной формы контроля (экзамена ИЛИ зачёта) по id любой из её
// строк: форма на нескольких парах хранится отдельными строками (один предмет/вид/
// дата/набор групп, разные пары).
function findExamRows(lessons, lessonId) {
  const L = lessons.find((l) => l.id === lessonId);
  if (!L || L.parked || L.event || !sessionKind(L.type)) return null; // только экз/зачёт
  const gkey = [...(L.groups || [])].sort().join(',');
  const rows = lessons.filter((x) =>
    !x.parked && !x.event && x.subject === L.subject && x.type === L.type &&
    x.weekNo === L.weekNo && x.day === L.day &&
    [...(x.groups || [])].sort().join(',') === gkey);
  return {
    ids: rows.map((r) => r.id),
    subject: L.subject, type: L.type, kind: sessionKind(L.type), weekNo: L.weekNo, day: L.day,
    groups: L.groups || [], teachers: L.teachers || [], rooms: L.rooms || [],
    pairs: [...new Set(rows.map((r) => r.pairNo).filter(Boolean))].sort((a, b) => a - b),
  };
}

// Куда можно перенести форму контроля (перетягиванием). Правила зависят от вида:
//  • экзамен — день, где у ВСЕХ групп стоит полный ЭкзС, нет настоящих занятий,
//    у преподавателя нет другого экзамена в этот день И за 3 дня до экзамена
//    (без воскресений/нерабочих) у всех групп нет занятий (дни на подготовку);
//  • зачёт — день, где у всех групп СВОБОДНЫ ровно те пары, что занимает зачёт
//    (столько же свободных пар), ЭкзС не требуется.
// Общее: день вмещает пары (Сб ≤3), нет накладок по преподавателю/аудитории.
// Возвращает [{weekNo, day, isoDate, date}], отсортировано по дате.
function examTargets(lessons, exam, semester, holidays = new Set()) {
  const examIds = new Set(exam.ids);
  const ecsBySlot = new Map();      // 'w|day' → Set(групп с ЭкзС)
  const realBySlot = new Map();     // 'w|day' → Set(групп с настоящим занятием)
  const teacherBusy = new Set();    // 'teacher|w|day|pair'
  const roomBusy = new Set();       // 'room|w|day|pair'
  const teacherExamDay = new Set(); // 'teacher|w|day' — у преподавателя экзамен в этот день
  const pairBusy = new Set();       // 'group|w|day|pair' — пара занята настоящим занятием
  const busyIso = new Set();        // 'group|iso' — занятие в этот день (для подготовки; без СР/физо)
  const weeks = new Set();
  for (const l of lessons) {
    if (l.parked) continue;
    weeks.add(l.weekNo);
    const slot = l.weekNo + '|' + l.day;
    if (l.event) {
      if (isEcsMarker(l.subject)) {
        let s = ecsBySlot.get(slot); if (!s) ecsBySlot.set(slot, (s = new Set()));
        for (const g of (l.groups || [])) s.add(g);
      }
      continue; // прочие мероприятия день/пары не занимают
    }
    if (examIds.has(l.id)) continue; // саму переносимую форму не учитываем
    let s = realBySlot.get(slot); if (!s) realBySlot.set(slot, (s = new Set()));
    for (const g of (l.groups || [])) s.add(g);
    const k = l.weekNo + '|' + l.day + '|' + l.pairNo;
    for (const t of (l.teachers || [])) teacherBusy.add(t + '|' + k);
    for (const r of (l.rooms || [])) roomBusy.add(r + '|' + k);
    for (const g of (l.groups || [])) pairBusy.add(g + '|' + k); // любая «настоящая» пара занята
    if (sessionKind(l.type) === 'exam') for (const t of (l.teachers || [])) teacherExamDay.add(t + '|' + slot);
    if (!isSelfStudyType(l.type) && !isPhysTraining(l)) {
      const iso = lessonDateISO(l.weekNo, l.day, semester);
      if (iso) for (const g of (l.groups || [])) busyIso.add(g + '|' + iso);
    }
  }

  const maxPairOf = (day) => (day === 'Сб' ? 3 : PAIRS_PER_DAY);
  const conflictAt = (weekNo, day) => exam.pairs.some((p) => {
    const k = weekNo + '|' + day + '|' + p;
    return exam.teachers.some((t) => teacherBusy.has(t + '|' + k)) || exam.rooms.some((r) => roomBusy.has(r + '|' + k));
  });

  const out = [];
  const push = (weekNo, day) => out.push({
    weekNo, day, isoDate: lessonDateISO(weekNo, day, semester), date: lessonDate(weekNo, day, semester),
  });

  if (exam.kind === 'exam') {
    for (const [slot, ecsGroups] of ecsBySlot) {
      const [wkStr, day] = slot.split('|');
      const weekNo = Number(wkStr);
      if (weekNo === exam.weekNo && day === exam.day) continue;
      if (!exam.groups.every((g) => ecsGroups.has(g))) continue;         // ЭкзС не у всех групп
      const real = realBySlot.get(slot);
      if (real && exam.groups.some((g) => real.has(g))) continue;        // есть настоящее занятие
      if (exam.pairs.some((p) => p > maxPairOf(day))) continue;
      if (exam.teachers.some((t) => teacherExamDay.has(t + '|' + slot))) continue; // другой экзамен у преп.
      if (conflictAt(weekNo, day)) continue;
      const iso = lessonDateISO(weekNo, day, semester);
      const prepBad = examPrepDays(iso, holidays).some((di) => exam.groups.some((g) => busyIso.has(g + '|' + di)));
      if (prepBad) continue;                                            // нет 3 дней на подготовку
      push(weekNo, day);
    }
  } else { // зачёт: нужны свободные пары (столько же, сколько занимает зачёт)
    for (const weekNo of weeks) {
      for (const day of DAYS.slice(0, 6)) { // Пн..Сб
        if (weekNo === exam.weekNo && day === exam.day) continue;
        if (exam.pairs.some((p) => p > maxPairOf(day))) continue;
        const freePairs = exam.groups.every((g) => exam.pairs.every((p) => !pairBusy.has(g + '|' + weekNo + '|' + day + '|' + p)));
        if (!freePairs) continue;                                        // не хватает свободных пар
        if (conflictAt(weekNo, day)) continue;
        push(weekNo, day);
      }
    }
  }
  out.sort((a, b) => String(a.isoDate).localeCompare(String(b.isoDate)));
  return out;
}

// Доступные окна для переноса формы контроля (для подсветки при перетягивании).
function getExamMoveTargets(lessonId, db = getDb()) {
  const lessons = loadLessons(db);
  const exam = findExamRows(lessons, Number(lessonId));
  if (!exam) return { ok: false, code: 404, reasons: ['Форма контроля не найдена'] };
  return {
    ok: true,
    exam: { subject: exam.subject, kind: exam.kind, groups: exam.groups, pairs: exam.pairs },
    targets: examTargets(lessons, exam, getSemester(db), new Set(getHolidays(db))),
  };
}

// Перенос формы контроля перетягиванием. Экзамен идёт на день с полным ЭкзС (оно
// заменяется у переносимых групп) и с соблюдением 3 дней подготовки; зачёт — на день
// со свободными парами. Двигаются все пары. Атомарно, обратимо кнопкой «Отменить».
function moveExam(lessonId, weekNo, day, actor = null, commandId = null) {
  return transaction((tx) => {
    const all = loadLessons(tx);
    const exam = findExamRows(all, Number(lessonId));
    if (!exam) return { ok: false, code: 404, reasons: ['Форма контроля не найдена'] };
    const wk = Number(weekNo);
    const t = examTargets(all, exam, getSemester(tx), new Set(getHolidays(tx))).find((x) => x.weekNo === wk && x.day === day);
    if (!t) {
      const why = exam.kind === 'exam'
        ? 'нужен день с полным ЭкзС у всех групп, без накладок и с 3 днями на подготовку'
        : 'нужен день со свободными парами у всех групп, без накладок';
      return { ok: false, code: 409, reasons: [`Сюда перенести нельзя: ${why}`] };
    }
    const examRows = all.filter((l) => exam.ids.includes(l.id));
    if (examRows.some((l) => l.locked)) return { ok: false, code: 409, reasons: [LOCKED_REASON] };
    // Метку ЭкзС не трогаем совсем. Раньше группы экзамена вычищались из неё
    // насовсем (а метка целиком удалялась, если экзамен покрывал весь её состав),
    // из-за чего сессия пропадала у всего потока сразу и не возвращалась, когда
    // экзамен уезжал. Теперь работает общее правило: экзамен встаёт ПОВЕРХ метки,
    // а hideCoveredEcs скрывает её ровно у тех групп и ровно в тех парах, что
    // занял экзамен. Ячейку освободили — метка снова видна, восстанавливать нечего.
    const snapshots = examRows.map(lessonSnapshot);

    for (const r of examRows) {
      const times = PAIR_TIMES[r.pairNo] || { start: null, end: null };
      tx.prepare('UPDATE lessons SET week_no=?, day=?, time_start=?, time_end=? WHERE id=?')
        .run(wk, day, times.start, times.end, r.id);
    }
    const label = exam.kind === 'zachet' ? 'зачёта' : 'экзамена';
    const desc = `Перенос ${label} ${exam.subject} ${exam.groups.join(', ')} на ${day} н${wk}`;
    pushUndo(tx, 'deleteEntity', desc, { snapshots });
    let actionId;
    if (actor) {
      actionId = commandId || randomUUID();
      tx.prepare(
        `INSERT INTO move_actions(action_id, created_at, actor_user_id, actor_name, lesson_id, description, before_json, schedule_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username, Number(lessonId), desc,
        JSON.stringify({ lesson: snapshots.find((x) => x.id === Number(lessonId)) || snapshots[0], batch: snapshots }), getScheduleGeneration());
      tx.prepare(
        `INSERT INTO move_action_events(action_id, happened_at, actor_user_id, actor_name, event)
         VALUES (?, ?, ?, ?, 'move')`
      ).run(actionId, new Date().toISOString(), actor.id, actor.displayName || actor.username);
    }
    return { ok: true, moved: examRows.length, date: t.date, actionId };
  });
}

module.exports = {
  listEntities,
  lessonSnapshot,
  getExamMoveTargets,
  moveExam,
  __examInternals: { findExamRows, examTargets }, // только для тестов
  editLesson,
  getView,
  getParked,
  getOrphans,
  clearOrphans,
  parkLesson,
  setLessonLocked,
  clearBuffer,
  moveLesson,
  finalizeMoveAction,
  attachMoveActionTopicChanges,
  finalizePendingMoveActions,
  getMoveActions,
  latestOwnMoveAction,
  revertMoveAction,
  getMoveLog,
  clearMoveLog,
  deleteMoveLogEntry,
  revertMove,
  setMoveLogNote,
  getMoveOptions,
  getSubjects,
  getFreeSlotsFor,
  getFreeRooms,
  getRoomOptions,
  getSummary,
  getRoomSummary,
  suggestSrPlacement,
  getStats,
  setLessonDetails,
  getTeacherOptions,
  setLessonTeacher,
  setRoomCapacity,
  setGroupHeadcount,
  getTeachersOverview,
  getSessionSchedule,
  teacherDepts, // кафедра преподавателя — нужна подбору аудиторий
  logMove, // запись в журнал переносов — нужна разгрузке 4-й пары
  logRoomChange, // запись о смене аудитории — нужна подбору аудиторий
  moveLogChain, // цепочка журнала для снимка undo
  setLessonRoomsRows, // аудитории занятия в lesson_rooms — там же
  setTeacherInfo,
  setEntityHidden,
  publish,
  publishStatus,
  readSnapshot, // опубликованный снимок — гостевой выгрузке
  getMoveMarks,
  guestEditLesson,
  resetDatabase,
  clearSchedule,
  deleteLesson,
  deleteEntitySchedule,
  replaceGroupTeacher,
  createLesson,
  createVacation,
  createGroupVacation,
  decommissionRoom,
  placeSelfStudy,
  clearSrWeek,
  previewHiddenGroupTeacherLessons,
  clearHiddenGroupTeacherLessons,
  blockTeacherSlot,
  saveSubjectRow,
  addSubjectRow,
  deleteSubjectRow,
};
