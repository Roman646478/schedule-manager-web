'use strict';

const { commandRouter } = require('../middleware/mutations');
const { requireAuth } = require('../middleware/auth');
const { validateBody, moveBodyErrors } = require('../middleware/validation');
const { listEntities, getView, getParked, getOrphans, clearOrphans, parkLesson, setLessonLocked, clearBuffer, moveLesson, getMoveLog, clearMoveLog, deleteMoveLogEntry, revertMove, setMoveLogNote, getMoveOptions, getSubjects, getFreeSlotsFor, getFreeRooms, getRoomOptions, getSummary, getRoomSummary, suggestSrPlacement, getStats, getTeacherOptions, editLesson, publish, guestEditLesson, resetDatabase, clearSchedule, deleteLesson, deleteEntitySchedule, replaceGroupTeacher, createLesson, createVacation, createGroupVacation, decommissionRoom, placeSelfStudy, clearSrWeek, previewHiddenGroupTeacherLessons, clearHiddenGroupTeacherLessons, blockTeacherSlot, saveSubjectRow, addSubjectRow, deleteSubjectRow, getExamMoveTargets, moveExam, getMoveMarks, publishStatus, getSessionSchedule } = require('../services/scheduleService');
const { buildErrorReport, getSessionCalendar } = require('../services/conflictService');
const { getSetting, setSetting, getSemester, getSemesters, saveSemester, selectSemester, deleteSemester, getCourses, setCourses, getHolidays, setHolidays, getDateNotes, setDateNotes, getAppearance, setAppearance, getTypeLegend, getGroupSubjects, getSubjectAliases, setSubjectAliases, getEventTypes, setEventTypes, getLessonTypes, setLessonTypes, getRoomPlanSettings, setRoomPlanSettings, ROOM_PLAN_RULES } = require('../services/settingsService');
const { suggestRoomPlan, applyRoomPlan } = require('../services/roomOptimizerService');
const { suggestPair4Relief, applyPair4Relief } = require('../services/pairReliefService');
const { peekUndo, performUndo } = require('../services/undoService');
const { applyAliasesToDb } = require('../services/importService');
const { verifyResetPassword } = require('../services/authService');
const { sortTopics } = require('../services/topicOrderService');
const { buildWidgetPackage, WEBVIEW2_INSTALLER } = require('../services/widgetPackageService');
const fs = require('node:fs');

const router = commandRouter();

// Проверка корректности дат семестра (реальная дата + начало не позже конца).
function validateSemesterDates(start, end) {
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isISO(start) || !isISO(end)) return 'нужны даты начала и конца (YYYY-MM-DD)';
  const isReal = (s) => {
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  if (!isReal(start) || !isReal(end)) return 'некорректная дата';
  if (start > end) return 'дата начала позже даты конца';
  return null;
}

// Текущая настройка семестра.
router.get('/semester', requireAuth, (req, res, next) => {
  try {
    res.json({ semester: getSemester() });
  } catch (err) {
    next(err);
  }
});

// Установка/сохранение семестра: { name, start, end }. Делает его активным
// и кладёт в память сохранённых семестров.
router.put('/semester', requireAuth, (req, res, next) => {
  try {
    const { name, start, end } = req.body || {};
    const bad = validateSemesterDates(start, end);
    if (bad) return res.status(400).json({ error: bad });
    const semester = saveSemester({ name: name || null, start, end });
    res.json({ success: true, semester });
  } catch (err) {
    next(err);
  }
});

// Память семестров: список сохранённых + текущий активный.
router.get('/semesters', requireAuth, (req, res, next) => {
  try {
    res.json({ semesters: getSemesters(), current: getSemester() });
  } catch (err) {
    next(err);
  }
});

// Сделать сохранённый семестр активным: { id }.
router.put('/semesters/select', requireAuth, (req, res, next) => {
  try {
    const result = selectSemester((req.body || {}).id);
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true, semester: result.semester });
  } catch (err) {
    next(err);
  }
});

// Удалить семестр из памяти.
router.delete('/semesters/:id', requireAuth, (req, res, next) => {
  try {
    const result = deleteSemester(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Списки групп/преподавателей/аудиторий для селекторов.
router.get('/entities', requireAuth, (req, res, next) => {
  try {
    res.json(listEntities());
  } catch (err) {
    next(err);
  }
});

// Одно из трёх представлений: /schedule?view=group|teacher|room&id=НАЗВАНИЕ
router.get('/schedule', requireAuth, (req, res, next) => {
  try {
    const { view, id } = req.query;
    res.json({ view: view || null, id: id || null, lessons: getView(view, id), semester: getSemester() });
  } catch (err) {
    next(err);
  }
});

// Сводное расписание за неделю: /summary?weekNo=
router.get('/summary', requireAuth, (req, res, next) => {
  try {
    res.json(getSummary(Number(req.query.weekNo)));
  } catch (err) {
    next(err);
  }
});

// Сводное расписание АУДИТОРИЙ за неделю: /room-summary?weekNo=
router.get('/room-summary', requireAuth, (req, res, next) => {
  try {
    res.json(getRoomSummary(Number(req.query.weekNo)));
  } catch (err) {
    next(err);
  }
});

// Подсказки, как найти аудиторию для группы в слоте: /sr-suggestions?group=&day=&pairNo=&weekNo=
router.get('/sr-suggestions', requireAuth, (req, res, next) => {
  try {
    const { group, day, pairNo, weekNo } = req.query;
    const result = suggestSrPlacement(group, day, pairNo, weekNo);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Курсы (префикс группы → номер курса).
router.get('/courses', requireAuth, (req, res, next) => {
  try {
    res.json({ courses: getCourses() });
  } catch (err) {
    next(err);
  }
});

router.put('/courses', requireAuth, (req, res, next) => {
  try {
    const courses = (req.body && req.body.courses) || {};
    const clean = {};
    for (const [prefix, course] of Object.entries(courses)) {
      const n = Number(course);
      if (prefix && Number.isInteger(n) && n >= 1 && n <= 5) clean[prefix] = n;
    }
    setCourses(clean);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Замены сокращений дисциплин (применяются при импорте).
router.get('/subject-aliases', requireAuth, (req, res, next) => {
  try {
    res.json({ aliases: getSubjectAliases() });
  } catch (err) {
    next(err);
  }
});

router.put('/subject-aliases', requireAuth, (req, res, next) => {
  try {
    const aliases = (req.body && req.body.aliases) || {};
    const clean = {};
    for (const [from, toRaw] of Object.entries(aliases)) {
      const f = String(from).trim();
      const t = String(toRaw).trim();
      if (f && t && f !== t) clean[f] = t;
    }
    setSubjectAliases(clean);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Сохранить одно правило замены И сразу применить к загруженной базе
// (переименование дисциплины + слияние образовавшегося дубля). Используется из
// секции «разные сокращения одной дисциплины» в панели ошибок.
router.post('/subject-aliases/apply', requireAuth, (req, res, next) => {
  try {
    const from = String((req.body && req.body.from) || '').trim();
    const to = String((req.body && req.body.to) || '').trim();
    if (!from || !to || from === to) return res.status(400).json({ error: 'нужны разные from и to' });
    setSubjectAliases({ ...getSubjectAliases(), [from]: to });
    const result = applyAliasesToDb({ [from]: to });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Буфер: занятия, отложенные «на потом».
router.get('/parked', requireAuth, (req, res, next) => {
  try {
    res.json({ lessons: getParked() });
  } catch (err) {
    next(err);
  }
});

// Очистить буфер: удалить все отложенные занятия (откат — через undo).
router.post('/parked/clear', requireAuth, (req, res, next) => {
  try {
    const result = clearBuffer();
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, deleted: result.deleted });
  } catch (err) {
    next(err);
  }
});

// Не размещённые при импорте: пары, попавшие на «ЭкзС» группы (полоса под сеткой).
router.get('/orphans', requireAuth, (req, res, next) => {
  try {
    res.json({ lessons: getOrphans() });
  } catch (err) {
    next(err);
  }
});

// Очистить список не размещённых (откат — через undo).
router.post('/orphans/clear', requireAuth, (req, res, next) => {
  try {
    const result = clearOrphans();
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, deleted: result.deleted });
  } catch (err) {
    next(err);
  }
});

// Отложить занятие в буфер. Тело не требуется.
router.post('/lesson/:id/park', requireAuth, (req, res, next) => {
  try {
    const result = parkLesson(Number(req.params.id));
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Бронь занятия: { locked: true|false }. Пока стоит — занятие не переносится
// (ни перетаскиванием, ни из карточки, ни возвратом из журнала переносов).
router.post('/lesson/:id/lock', requireAuth, (req, res, next) => {
  try {
    const result = setLessonLocked(Number(req.params.id), Boolean(req.body && req.body.locked));
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, locked: result.locked });
  } catch (err) {
    next(err);
  }
});

// Доступность слотов для переноса: /move-options?lessonId=&weekNo=
router.get('/move-options', requireAuth, (req, res, next) => {
  try {
    res.json(getMoveOptions(Number(req.query.lessonId), Number(req.query.weekNo)));
  } catch (err) {
    next(err);
  }
});

// Свободные аудитории в слоте: /free-rooms?lessonId=&day=&pairNo=&weekNo=
router.get('/free-rooms', requireAuth, (req, res, next) => {
  try {
    const { lessonId, day, pairNo, weekNo } = req.query;
    res.json(getFreeRooms(Number(lessonId), day, pairNo, weekNo));
  } catch (err) {
    next(err);
  }
});

// Все мероприятия (category='event') из расписания, сортировка по неделе/дню/паре.
router.get('/events', requireAuth, (req, res, next) => {
  try {
    const DAY_ORDER = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const events = getView('group', null)
      .filter((l) => l.category === 'event' && !l.parked)
      .sort((a, b) => a.weekNo - b.weekNo || DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.pairNo - b.pairNo);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

// Справочник дисциплин (аббревиатура + полное название) для формы добавления.
router.get('/subjects', requireAuth, (req, res, next) => {
  try {
    res.json({ subjects: getSubjects() });
  } catch (err) {
    next(err);
  }
});

// Свободные слоты для нового занятия с учётом групп/преподавателя/аудитории:
// /free-slots?groups=811,823&teacher=…&room=…&weekNo=
router.get('/free-slots', requireAuth, (req, res, next) => {
  try {
    const { groups, teacher, room, weekNo, subject, type } = req.query;
    const groupList = groups ? String(groups).split(',').map((s) => s.trim()).filter(Boolean) : [];
    res.json(getFreeSlotsFor({
      groups: groupList,
      teacher: teacher || null,
      room: room || null,
      weekNo: weekNo ? Number(weekNo) : null,
      subject: subject || null,
      type: type || null,
    }));
  } catch (err) {
    next(err);
  }
});

// Перенос занятия (атомарно, с валидацией). Тело: {lessonId, day, pairNo, weekNo, room|rooms}.
router.post('/move', requireAuth, validateBody(moveBodyErrors), (req, res, next) => {
  try {
    const { lessonId, day, pairNo, weekNo, room, rooms, force } = req.body;
    // force: true — составитель подтвердил размещение с предупреждением
    // (занятая аудитория / нехватка мест).
    const target = { day, pairNo, weekNo, force: force === true };
    if (Array.isArray(rooms)) target.rooms = rooms;
    else target.room = room ?? null;
    const result = moveLesson(lessonId, target);
    if (!result.ok) return res.status(409).json(result);
    res.json({ success: true, warning: result.warning || null });
  } catch (err) {
    next(err);
  }
});

// Журнал всех выполненных переносов (последние первыми).
router.get('/move-log', requireAuth, (req, res, next) => {
  try {
    res.json({ entries: getMoveLog() });
  } catch (err) {
    next(err);
  }
});

// Пометки «перенесено» для сетки: по занятию — число записей, последний перенос и
// последняя смена аудитории. Весь журнал ради полосы грузить незачем.
router.get('/move-log/marks', requireAuth, (req, res, next) => {
  try {
    res.json({ marks: getMoveMarks() });
  } catch (err) {
    next(err);
  }
});

// Полная очистка журнала переносов (на само расписание не влияет).
router.delete('/move-log', requireAuth, (req, res, next) => {
  try {
    res.json(clearMoveLog());
  } catch (err) {
    next(err);
  }
});

// Сохранение примечания к записи журнала. Тело: {note}.
router.put('/move-log/:id', requireAuth, (req, res, next) => {
  try {
    const result = setMoveLogNote(Number(req.params.id), (req.body || {}).note);
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Удаление ОДНОЙ записи журнала (история). На расписание не влияет.
router.delete('/move-log/:id', requireAuth, (req, res, next) => {
  try {
    const result = deleteMoveLogEntry(Number(req.params.id));
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Отмена переноса по записи журнала: вернуть занятие в исходный слот. Проверяет
// возможность (занятие на месте) и занятость целевой ячейки — иначе 409 с причинами.
router.post('/move-log/:id/revert', requireAuth, (req, res, next) => {
  try {
    // force — подтверждение предупреждений (занятая аудитория, нехватка мест).
    const result = revertMove(Number(req.params.id), (req.body || {}).force === true);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Кандидаты-преподаватели для занятия (по дисциплине и виду занятия) + все.
router.get('/lesson/:id/teachers', requireAuth, (req, res, next) => {
  try {
    res.json(getTeacherOptions(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Свободные аудитории для занятия в его текущем слоте.
router.get('/lesson/:id/rooms', requireAuth, (req, res, next) => {
  try {
    res.json(getRoomOptions(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Удаление расписания одной сущности: ?view=group|teacher|room&id=НАЗВАНИЕ
router.delete('/entity-schedule', requireAuth, (req, res, next) => {
  try {
    const { view, id } = req.query;
    if (!view || !id) return res.status(400).json({ error: 'Нужны параметры view и id' });
    const result = deleteEntitySchedule(view, id);
    if (!result.ok) return res.status(result.code || 404).json(result);
    res.json({ success: true, deleted: result.deleted, modified: result.modified, total: result.total });
  } catch (err) {
    next(err);
  }
});

// Удаление занятия. Если потоковое — удаляется целиком (одна запись = весь поток).
router.delete('/lesson/:id', requireAuth, (req, res, next) => {
  try {
    const result = deleteLesson(Number(req.params.id));
    if (!result.ok) return res.status(404).json(result);
    res.json({ success: true, groups: result.groups });
  } catch (err) {
    next(err);
  }
});

// Массовая смена преподавателя по расписанию группы.
// Тело: { group, to, mode: 'replace'|'all', from?, subject?, type? }. 'replace' — from→to,
// 'all' — to на все; subject/type сужают до дисциплины/вида занятия (Л, ПЗ…).
router.post('/group-teacher', requireAuth, (req, res, next) => {
  try {
    const { group, from, to, mode, subject, type } = req.body || {};
    const result = replaceGroupTeacher(group, from, to, mode === 'all' ? 'all' : 'replace', subject || null, type || null);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, count: result.count });
  } catch (err) {
    next(err);
  }
});

// Подбор аудиторий «по размеру» на открытой неделе сводного расписания:
// GET — предложения (ничего не меняет), POST — применить выбранные галочками.
router.get('/room-plan', requireAuth, (req, res, next) => {
  try {
    // rules — какие правила подбора применять (галочки в админке). Пусто = все.
    const rules = String(req.query.rules || '').split(',').map((s) => s.trim()).filter(Boolean);
    const result = suggestRoomPlan(Number(req.query.weekNo), undefined, rules.length ? rules : null);
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Настройки подбора: порядок и включение правил, допуски, списки исключений.
// Порядок в settings.rules — он же приоритет: правило ниже по списку не может
// испортить то, что стоит выше.
router.get('/room-plan/settings', requireAuth, (req, res, next) => {
  try {
    res.json({ settings: getRoomPlanSettings(), rules: ROOM_PLAN_RULES });
  } catch (err) {
    next(err);
  }
});

router.put('/room-plan/settings', requireAuth, (req, res, next) => {
  try {
    const settings = setRoomPlanSettings((req.body || {}).settings || {});
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
});

router.post('/room-plan/apply', requireAuth, (req, res, next) => {
  try {
    const result = applyRoomPlan((req.body || {}).items);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, applied: result.applied, skipped: result.skipped });
  } catch (err) {
    next(err);
  }
});

// Разгрузка 4-й пары у группы: куда переставить занятия с 7–8 часов.
router.get('/pair4-relief', requireAuth, (req, res, next) => {
  try {
    const result = suggestPair4Relief(String(req.query.group || ''));
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/pair4-relief/apply', requireAuth, (req, res, next) => {
  try {
    const result = applyPair4Relief((req.body || {}).items);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, applied: result.applied, skipped: result.skipped });
  } catch (err) {
    next(err);
  }
});

// Авто-расстановка СР (самостоятельной работы) в пределах одной открытой недели.
// Тело: { weekNo } — неделя из сводного расписания.
router.post('/place-sr', requireAuth, (req, res, next) => {
  try {
    const result = placeSelfStudy(Number((req.body || {}).weekNo));
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, created: result.created, unplaced: result.unplaced, weekNo: result.weekNo, unplacedCells: result.unplacedCells || [], ecsRooms: result.ecsRooms || 0 });
  } catch (err) {
    next(err);
  }
});

// Удаление всех СР в пределах одной открытой недели (парная кнопка к place-sr).
// Тело: { weekNo } — неделя из сводного расписания.
router.post('/clear-sr', requireAuth, (req, res, next) => {
  try {
    const result = clearSrWeek(Number((req.body || {}).weekNo));
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, deleted: result.deleted, ecsCleared: result.ecsCleared || 0, weekNo: result.weekNo });
  } catch (err) {
    next(err);
  }
});

// Предпросмотр занятий преподавателя, у которых ВСЕ группы скрыты (не входят
// в перечень отображаемых) — для подтверждающего окна перед удалением.
// Query: ?teacher=ФИО.
router.get('/teacher-hidden-groups', requireAuth, (req, res, next) => {
  try {
    const result = previewHiddenGroupTeacherLessons(req.query.teacher);
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json({ teacher: result.teacher, groups: result.groups, count: result.count });
  } catch (err) {
    next(err);
  }
});

// Удаление занятий преподавателя, у которых ВСЕ группы скрыты (не входят
// в перечень отображаемых). Действует по всему расписанию преподавателя.
// Тело: { teacher }.
router.post('/teacher-hidden-groups/clear', requireAuth, (req, res, next) => {
  try {
    const result = clearHiddenGroupTeacherLessons((req.body || {}).teacher);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, deleted: result.deleted, groups: result.groups });
  } catch (err) {
    next(err);
  }
});

// Ручная блокировка одной свободной ячейки в расписании преподавателя —
// ставит туда мероприятие-метку, занимающее слот (новое занятие туда поставить
// нельзя). Слот должен быть свободен у преподавателя, иначе 409.
// Тело: { teacher, day, pairNo, weekNo, label? }.
router.post('/teacher-block', requireAuth, (req, res, next) => {
  try {
    const { teacher, day, pairNo, weekNo, label } = req.body || {};
    const result = blockTeacherSlot(teacher, day, pairNo, weekNo, label);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.status(201).json({ success: true, id: result.id });
  } catch (err) {
    next(err);
  }
});

// Создание занятия вручную. Тело: {day, pairNo, weekNo, subject?, type?, topic?, room?, teacher?, groups?}.
router.post('/lessons', requireAuth, (req, res, next) => {
  try {
    const result = createLesson(req.body || {});
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.status(201).json({ success: true, id: result.id, warning: result.warning || null });
  } catch (err) {
    next(err);
  }
});

// Отпуск преподавателя ИЛИ группы: метка «Отп» во все рабочие ячейки периода.
// Тело: { teacher, from, to } или { group, from, to } (from/to — ГГГГ-ММ-ДД).
router.post('/vacation', requireAuth, (req, res, next) => {
  try {
    const { teacher, group, from, to, label } = req.body || {};
    const mark = (label && String(label).trim()) || 'Отп';
    const result = group ? createGroupVacation(group, from, to, mark) : createVacation(teacher, from, to, mark);
    if (!result.ok) return res.status(409).json(result);
    res.status(201).json({ success: true, count: result.count, moved: result.moved });
  } catch (err) {
    next(err);
  }
});

// Вывод аудитории из эксплуатации: переселить её занятия периода в свободные.
// Тело: { room, from, to, reason? }.
router.post('/decommission-room', requireAuth, (req, res, next) => {
  try {
    const { room, from, to, reason } = req.body || {};
    const result = decommissionRoom(room, from, to, reason);
    if (!result.ok) return res.status(409).json(result);
    res.status(201).json({ success: true, room: result.room, moved: result.moved, movedCount: result.movedCount, unplaced: result.unplaced, marks: result.marks });
  } catch (err) {
    next(err);
  }
});

// Полное редактирование занятия. Тело — любые поля:
// {day?, pairNo?, weekNo?, subject?, type?, topic?, note?, room?, teacher?, groups?}.
// Конфликты (преподаватель/группа/аудитория, вместимость) проверяются при смене
// размещения; поток (несколько групп) обновляется атомарно.
router.put('/lesson/:id', requireAuth, (req, res, next) => {
  try {
    const r = editLesson(Number(req.params.id), req.body || {});
    if (!r.ok) return res.status(r.code || 409).json(r);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});


// Расставить темы по порядку (ВВ → Т.1…Т.N → ЗАКЛ.) во всём расписании.
// После любой правки затронутые связки пересчитываются сами; кнопка проходит
// всю базу целиком — на случай правок мимо приложения (подмена файла БД).
router.post('/topics/sort', requireAuth, (req, res, next) => {
  try {
    res.json({ success: true, ...sortTopics({ all: true }) });
  } catch (err) {
    next(err);
  }
});

// Полная проверка расписания на ошибки.
router.get('/errors', requireAuth, (req, res, next) => {
  try {
    res.json(buildErrorReport());
  } catch (err) {
    next(err);
  }
});

// Календарь сессии: сессионные занятия (экз/зо/курсовая) для сводной сетки
// «день × группа» + список групп, праздники и диапазон дат по умолчанию.
router.get('/session-calendar', requireAuth, (req, res, next) => {
  try {
    res.json(getSessionCalendar());
  } catch (err) {
    next(err);
  }
});

// График сессии: экзамены и зачёты списком по группам (вкладка «График сессии»).
router.get('/session-schedule', requireAuth, (req, res, next) => {
  try {
    res.json(getSessionSchedule());
  } catch (err) {
    next(err);
  }
});

// Доступные «окна»-ЭкзС для переноса экзамена: /session-exam-targets?lessonId=
router.get('/session-exam-targets', requireAuth, (req, res, next) => {
  try {
    const result = getExamMoveTargets(Number(req.query.lessonId));
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Перенос экзамена в день с полным ЭкзС. Тело: { lessonId, weekNo, day }.
router.post('/session-move-exam', requireAuth, (req, res, next) => {
  try {
    const { lessonId, weekNo, day } = req.body || {};
    const result = moveExam(Number(lessonId), Number(weekNo), day);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true, moved: result.moved, date: result.date });
  } catch (err) {
    next(err);
  }
});

// Полная очистка базы данных. Требует пароль-подтверждение в теле: {password}.
router.post('/reset', requireAuth, (req, res, next) => {
  try {
    if (!req.body || !verifyResetPassword(req.body.password)) {
      return res.status(403).json({ error: 'Неверный пароль очистки' });
    }
    res.json(resetDatabase());
  } catch (err) {
    next(err);
  }
});

// Очистить только расписание (занятия + журнал переносов). Справочники, семестры,
// курсы и прочие настройки сохраняются. Подтверждение — на стороне клиента.
router.post('/clear-schedule', requireAuth, (req, res, next) => {
  try {
    res.json(clearSchedule());
  } catch (err) {
    next(err);
  }
});

// Статистика нагрузки по преподавателям, аудиториям и группам.
router.get('/stats', requireAuth, (req, res, next) => {
  try {
    res.json(getStats());
  } catch (err) {
    next(err);
  }
});

// Легенда обозначений (виды занятий + прочие пометки) из подвала файлов.
router.get('/legend', requireAuth, (req, res, next) => {
  try {
    res.json({ legend: getTypeLegend() });
  } catch (err) {
    next(err);
  }
});

// Таблица дисциплин с преподавателями по группам (из подвала HTML-файлов).
// С ?group=<имя> — список для одной группы; без параметра — вся карта.
router.get('/group-subjects', requireAuth, (req, res, next) => {
  try {
    const all = getGroupSubjects();
    const group = req.query.group;
    if (group) return res.json({ subjects: all[group] || [] });
    res.json({ groupSubjects: all });
  } catch (err) {
    next(err);
  }
});

// Сохранить строку таблицы «Дисциплины и преподаватели» (по индексу в группе).
// Тело: { group, index, fields: { abbr, fullName, dept, lecturer, others, hours, report } }.
// ФИО из «Лектор»/«Другие виды занятий» попадают в справочник преподавателей.
router.put('/group-subjects', requireAuth, (req, res, next) => {
  try {
    const { group, index, fields } = req.body || {};
    const result = saveSubjectRow(group, Number(index), fields);
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json({ success: true, entry: result.entry, teachers: result.teachers });
  } catch (err) {
    next(err);
  }
});

// Перечень видов мероприятий: [{code, name}].
router.get('/event-types', requireAuth, (req, res, next) => {
  try {
    res.json({ types: getEventTypes() });
  } catch (err) {
    next(err);
  }
});

// Добавление дисциплины в подвал группы. Тело: { group, fields }.
router.post('/group-subjects', requireAuth, (req, res, next) => {
  try {
    const { group, fields } = req.body || {};
    const result = addSubjectRow(group, fields);
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.status(201).json({ success: true, entry: result.entry, index: result.index, teachers: result.teachers });
  } catch (err) {
    next(err);
  }
});

// Удаление дисциплины из подвала группы вместе с её занятиями. Тело: { group, index }.
router.delete('/group-subjects', requireAuth, (req, res, next) => {
  try {
    const { group, index } = req.body || {};
    const result = deleteSubjectRow(group, Number(index));
    if (!result.ok) return res.status(result.code || 400).json(result);
    res.json({ success: true, deleted: result.deleted, modified: result.modified });
  } catch (err) {
    next(err);
  }
});

// Перечень видов учебных занятий: [{code, name}]. Правится в справочнике.
router.get('/lesson-types', requireAuth, (req, res, next) => {
  try {
    res.json({ types: getLessonTypes() });
  } catch (err) {
    next(err);
  }
});

router.put('/lesson-types', requireAuth, (req, res, next) => {
  try {
    const list = (req.body && req.body.types) || [];
    if (!Array.isArray(list)) return res.status(400).json({ error: 'types должен быть массивом' });
    setLessonTypes(list);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/event-types', requireAuth, (req, res, next) => {
  try {
    const list = (req.body && req.body.types) || [];
    if (!Array.isArray(list)) return res.status(400).json({ error: 'types должен быть массивом' });
    setEventTypes(list);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Нерабочие дни: список ISO-дат (ГГГГ-ММ-ДД).
router.get('/holidays', requireAuth, (req, res, next) => {
  try {
    res.json({ holidays: getHolidays() });
  } catch (err) {
    next(err);
  }
});

router.put('/holidays', requireAuth, (req, res, next) => {
  try {
    const list = (req.body && req.body.holidays) || [];
    if (!Array.isArray(list)) return res.status(400).json({ error: 'holidays должен быть массивом' });
    const clean = list.map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    setHolidays(clean);
    res.json({ success: true, count: clean.length });
  } catch (err) {
    next(err);
  }
});

// Примечания к датам (в сетке подсвечивают дату). Тело PUT: { notes: [...] }.
router.get('/date-notes', requireAuth, (req, res, next) => {
  try {
    res.json({ notes: getDateNotes() });
  } catch (err) {
    next(err);
  }
});

router.put('/date-notes', requireAuth, (req, res, next) => {
  try {
    const list = (req.body && req.body.notes) || [];
    if (!Array.isArray(list)) return res.status(400).json({ error: 'notes должен быть массивом' });
    if (list.length > 2000) return res.status(400).json({ error: 'слишком много примечаний' });
    const clean = [];
    for (const n of list) {
      const date = String((n && n.date) || '').trim();
      const text = String((n && n.text) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !text) continue; // без даты или текста запись не нужна
      const groups = Array.isArray(n.groups)
        ? [...new Set(n.groups.map((g) => String(g || '').trim()).filter(Boolean))]
        : [];
      clean.push({ date, text: text.slice(0, 1000), groups });
    }
    setDateNotes(clean);
    res.json({ success: true, count: clean.length });
  } catch (err) {
    next(err);
  }
});

// Оформление сетки (цвета и размеры). Ключи — только из белого списка, значения —
// строго цвет #rrggbb или число+px: со страницы они попадают прямо в CSS-переменные
// на :root, и произвольную строку туда пускать нельзя.
const APPEARANCE_COLORS = [
  '--grid-line', '--grid-line-free', '--grid-line-warn', '--grid-line-error',
  '--grid-line-stream', '--grid-line-holiday', '--grid-line-teacher', '--grid-line-dept',
  '--grid-line-cc', '--hl-color',
  '--type-lec', '--type-prac', '--type-lab', '--type-sem', '--type-grp', '--type-ctrl',
];
const APPEARANCE_SIZES = ['--grid-row-h', '--grid-font', '--grid-time-w'];

function cleanAppearance(body) {
  const src = body || {};
  const pick = (obj, allowed, re) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const val = String(v == null ? '' : v).trim();
      if (allowed.includes(k) && re.test(val)) out[k] = val;
    }
    return out;
  };
  return {
    colors: pick(src.colors, APPEARANCE_COLORS, /^#[0-9a-f]{6}$/i),
    sizes: pick(src.sizes, APPEARANCE_SIZES, /^\d{1,3}px$/),
  };
}

router.get('/appearance', requireAuth, (req, res, next) => {
  try {
    res.json({ appearance: getAppearance() });
  } catch (err) {
    next(err);
  }
});

router.put('/appearance', requireAuth, (req, res, next) => {
  try {
    const clean = cleanAppearance(req.body && req.body.appearance);
    setAppearance(clean);
    res.json({ success: true, appearance: clean });
  } catch (err) {
    next(err);
  }
});

// Последнее действие для кнопки «Отменить».
router.get('/undo', requireAuth, (req, res, next) => {
  try {
    const last = peekUndo();
    res.json(last ? { id: last.id, action: last.action, description: last.description } : {});
  } catch (err) {
    next(err);
  }
});

// Отменить последнее действие.
router.post('/undo', requireAuth, (req, res, next) => {
  try {
    const expectedId = req.body?.expectedId ?? null;
    const result = performUndo(expectedId);
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Публикация снимка для гостевого просмотра.
router.post('/publish', requireAuth, (req, res, next) => {
  try {
    res.json(publish());
  } catch (err) {
    next(err);
  }
});

// Устарел ли снимок: есть правки, которых гости не видят (подсветка «Опубликовать»).
router.get('/publish/status', requireAuth, (req, res, next) => {
  try {
    res.json(publishStatus());
  } catch (err) {
    next(err);
  }
});

// Тумблер «правка темы и примечания в публичном расписании». Читать может кто
// угодно (гостевая страница решает, показывать ли поля ввода), менять — админ.
const guestEditOn = () => getSetting('guestEdit') === '1';

router.get('/guest-edit', (req, res, next) => {
  try {
    res.json({ enabled: guestEditOn() });
  } catch (err) {
    next(err);
  }
});

router.put('/guest-edit', requireAuth, (req, res, next) => {
  try {
    setSetting('guestEdit', req.body && req.body.enabled ? '1' : '0');
    res.json({ enabled: guestEditOn() });
  } catch (err) {
    next(err);
  }
});

// Архив с виджетом на рабочий стол. Открыт всем: внутри только .bat и скрипт
// запуска окна, никаких данных. Адрес сервера подставляется на месте — тот, по
// которому пришёл запрос, либо заданный вручную в settings.widgetHost.
router.get('/widget-package', async (req, res, next) => {
  try {
    const { buffer, filename } = await buildWidgetPackage({
      host: req.headers.host,
      protocol: req.protocol,
    });
    res.attachment(filename);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Офлайн-установщик движка WebView2 (~200 МБ). Виджет-программе он нужен там,
// где движка нет в системе, а интернета, чтобы взять его у Microsoft, нет тоже:
// файл раздаём сами, до нас клиент и так дотягивается. Открыт всем, как и сам
// виджет — внутри подписанный установщик Microsoft, никаких данных.
router.get('/webview2-installer', (req, res, next) => {
  try {
    if (!fs.existsSync(WEBVIEW2_INSTALLER)) {
      res.status(404).json({ error: 'В сборке нет установщика движка WebView2 (vendor/webview2-runtime)' });
      return;
    }
    res.download(WEBVIEW2_INSTALLER, 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  } catch (err) {
    next(err);
  }
});

// Адрес сервера для виджета: пусто — определяем по запросу, задан — берём его.
router.get('/widget-host', (req, res, next) => {
  try {
    res.json({ host: getSetting('widgetHost') || '' });
  } catch (err) {
    next(err);
  }
});

router.put('/widget-host', requireAuth, (req, res, next) => {
  try {
    setSetting('widgetHost', String((req.body && req.body.host) || '').trim());
    res.json({ host: getSetting('widgetHost') || '' });
  } catch (err) {
    next(err);
  }
});

// Тумблер «гости скачивают расписание группы/преподавателя в Excel». Сама
// выгрузка — в routes/export.js (allowGuestExport).
router.get('/guest-export', (req, res, next) => {
  try {
    res.json({ enabled: getSetting('guestExport') === '1' });
  } catch (err) {
    next(err);
  }
});

router.put('/guest-export', requireAuth, (req, res, next) => {
  try {
    setSetting('guestExport', req.body && req.body.enabled ? '1' : '0');
    res.json({ enabled: getSetting('guestExport') === '1' });
  } catch (err) {
    next(err);
  }
});

// Тумблер «гостям показывать свободные окна для переноса» (только подсветка,
// сам перенос гостю недоступен).
router.get('/guest-moves', (req, res, next) => {
  try {
    res.json({ enabled: getSetting('guestMoves') === '1' });
  } catch (err) {
    next(err);
  }
});

router.put('/guest-moves', requireAuth, (req, res, next) => {
  try {
    setSetting('guestMoves', req.body && req.body.enabled ? '1' : '0');
    res.json({ enabled: getSetting('guestMoves') === '1' });
  } catch (err) {
    next(err);
  }
});

// Тумблер «разные цвета занятий в гостевом просмотре» (по дисциплине — в
// расписании группы, по группе — у преподавателя и в дисциплине). Это только
// оформление, поэтому включён по умолчанию: тумблер нужен, чтобы ВЫключить.
router.get('/guest-colors', (req, res, next) => {
  try {
    res.json({ enabled: getSetting('guestColors') !== '0' });
  } catch (err) {
    next(err);
  }
});

router.put('/guest-colors', requireAuth, (req, res, next) => {
  try {
    setSetting('guestColors', req.body && req.body.enabled ? '1' : '0');
    res.json({ enabled: getSetting('guestColors') !== '0' });
  } catch (err) {
    next(err);
  }
});

// Тумблер «помечать перенесённые занятия» — полоса слева у занятия, которое
// двигали. Один на всех: админка и гостевая страница спрашивают его одинаково
// (гостю сам журнал недоступен, пометка приходит со снимком публикации).
// Включён по умолчанию: тумблер нужен, чтобы ВЫключить.
router.get('/move-marks', (req, res, next) => {
  try {
    res.json({ enabled: getSetting('moveMarks') !== '0' });
  } catch (err) {
    next(err);
  }
});

router.put('/move-marks', requireAuth, (req, res, next) => {
  try {
    setSetting('moveMarks', req.body && req.body.enabled ? '1' : '0');
    res.json({ enabled: getSetting('moveMarks') !== '0' });
  } catch (err) {
    next(err);
  }
});

// Правка занятия с гостевой страницы — БЕЗ входа, но только тема, примечание и
// вид занятия (практическое → практическое) и только при включённом тумблере.
// Остальные поля игнорируются на уровне сервиса.
router.put('/guest/lesson/:id', (req, res, next) => {
  try {
    if (!guestEditOn()) return res.status(403).json({ error: 'Правка расписания сейчас закрыта' });
    const { topic, note, type } = req.body || {};
    const result = guestEditLesson(Number(req.params.id), { topic, note, type });
    if (!result.ok) return res.status(result.code || 409).json(result);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
