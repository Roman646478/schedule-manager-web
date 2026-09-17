'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getSetting } = require('../services/settingsService');
const { readSnapshot } = require('../services/scheduleService');
const { exportWeeklySchedule, exportSemesterSummary } = require('../services/weeklyExportService');
const { exportGroupSchedule, exportAllGroups, exportTeacherSchedule, exportSubjectSchedule, subjectGroups } = require('../services/groupExportService');

// Файл уходит в браузер: сохраняет его пользователь у себя, сервер ничего не пишет
// на диск. Имя файла express кодирует сам (filename* для кириллицы), а что не
// поместилось в шаблон — заголовком, потому что тело занято файлом.
function sendFile(res, { buffer, filename, warnings }) {
  if (warnings && warnings.length) res.set('X-Export-Warnings', encodeURIComponent(warnings.join('; ')));
  res.attachment(filename);
  res.send(Buffer.from(buffer));
}

// Расписание группы, преподавателя, дисциплины и сводное за неделю гость скачивает
// БЕЗ входа —
// но только при включённом тумблере settings.guestExport. Админу выгрузка открыта всегда.
// Гость видит опубликованный снимок — из него же собирается и его файл
// (req.lessons), иначе правки после публикации попадали бы в Excel раньше, чем на
// экран. Админ выгружает живую базу (req.lessons не задан).
function allowGuestExport(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (getSetting('guestExport') !== '1') return res.status(403).json({ error: 'Скачивание расписания сейчас закрыто' });
  const snap = readSnapshot();
  if (!snap) return res.status(404).json({ error: 'Расписание ещё не опубликовано' });
  req.lessons = snap.lessons || [];
  next();
}

// Выбранные на экране группы из тела запроса — строками и без пустышек.
// Поля нет вовсе (старый клиент, гость) — null, это «выгружаем всё».
function pickedGroups(req) {
  const raw = (req.body || {}).groups;
  return Array.isArray(raw) ? raw.map((g) => String(g).trim()).filter(Boolean) : null;
}

// Пустой список — это НЕ «все группы»: так фильтр, скрывший всё, молча отдавал
// бы полный файл. Просим включить хотя бы один курс.
function noGroupsLeft(res, groups) {
  if (!groups || groups.length) return false;
  res.status(400).json({ error: 'Все группы скрыты фильтрами — включите хотя бы один курс' });
  return true;
}

router.post('/export/weekly', allowGuestExport, async (req, res, next) => {
  try {
    const weekNo = Number(req.query.weekNo || req.body.weekNo);
    if (!weekNo || weekNo < 1) return res.status(400).json({ error: 'Укажите корректный номер недели (weekNo)' });
    // groups — что видно на экране (фильтры «Курсы»/«Группы»); чужие имена
    // отсеивает сама выгрузка по справочнику групп.
    const groups = pickedGroups(req);
    if (noGroupsLeft(res, groups)) return;
    sendFile(res, await exportWeeklySchedule(weekNo, groups, req.lessons));
  } catch (err) {
    next(err);
  }
});

// Семестровое расписание одной группы → файл «<группа>.xlsx».
router.post('/export/group', allowGuestExport, async (req, res, next) => {
  try {
    const group = String(req.query.group || req.body.group || '').trim();
    if (!group) return res.status(400).json({ error: 'Укажите группу (group)' });
    sendFile(res, await exportGroupSchedule(group, null, req.lessons));
  } catch (err) {
    next(err);
  }
});

// Сводное расписание за ВЕСЬ семестр: каждая неделя — отдельный лист одного файла.
router.post('/export/summary', requireAuth, async (req, res, next) => {
  try {
    const groups = pickedGroups(req);
    if (noGroupsLeft(res, groups)) return;
    sendFile(res, await exportSemesterSummary(groups));
  } catch (err) {
    next(err);
  }
});

// Какие группы есть у дисциплины — для окна выбора перед выгрузкой.
router.get('/export/subject-groups', requireAuth, (req, res, next) => {
  try {
    const subject = String(req.query.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'Укажите дисциплину (subject)' });
    res.json({ subject, groups: subjectGroups(subject) });
  } catch (err) {
    next(err);
  }
});

// Расписание одной дисциплины по выбранным группам → файл «<дисциплина>.xlsx».
router.post('/export/subject', allowGuestExport, async (req, res, next) => {
  try {
    const subject = String((req.body || {}).subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'Укажите дисциплину (subject)' });
    const groups = Array.isArray((req.body || {}).groups) ? req.body.groups : [];
    sendFile(res, await exportSubjectSchedule(subject, groups, null, req.lessons));
  } catch (err) {
    next(err);
  }
});

// Семестровое расписание одного преподавателя → файл «<ФИО>.xlsx».
router.post('/export/teacher', allowGuestExport, async (req, res, next) => {
  try {
    const teacher = String(req.query.teacher || req.body.teacher || '').trim();
    if (!teacher) return res.status(400).json({ error: 'Укажите преподавателя (teacher)' });
    sendFile(res, await exportTeacherSchedule(teacher, null, req.lessons));
  } catch (err) {
    next(err);
  }
});

// Все группы — по файлу на группу, одним архивом.
router.post('/export/groups', requireAuth, async (req, res, next) => {
  try {
    sendFile(res, await exportAllGroups());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
