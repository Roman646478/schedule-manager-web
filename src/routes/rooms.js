'use strict';

const { commandRouter } = require('../middleware/mutations');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../config/database');
const { setRoomCapacity, setGroupHeadcount, setEntityHidden, getTeachersOverview, setTeacherInfo } = require('../services/scheduleService');

const router = commandRouter();

// Справочник аудиторий с вместимостью.
router.get('/rooms', requireAuth, (req, res, next) => {
  try {
    res.json(getDb().prepare('SELECT id, name, capacity, kind, dept, course_only AS courseOnly, note, hidden FROM rooms ORDER BY name').all());
  } catch (err) {
    next(err);
  }
});

// Установка вместимости/типа/кафедры/курс-ограничения аудитории.
// Тело: {name, capacity, kind?, dept?, courseOnly?, note?}.
router.put('/rooms', requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const { name, capacity, kind } = body;
    if (!name) return res.status(400).json({ error: 'нужно имя аудитории' });
    if (capacity != null && (!Number.isInteger(capacity) || capacity < 0))
      return res.status(400).json({ error: 'вместимость — неотрицательное целое' });
    // dept/courseOnly трогаем только если поле прислано (правка одного не стирает другое).
    const dept = Object.prototype.hasOwnProperty.call(body, 'dept') ? (body.dept ?? null) : undefined;
    let courseOnly;
    if (Object.prototype.hasOwnProperty.call(body, 'courseOnly')) {
      const n = Number(body.courseOnly);
      courseOnly = body.courseOnly == null || body.courseOnly === '' ? null : n;
      if (courseOnly != null && (!Number.isInteger(courseOnly) || courseOnly < 1 || courseOnly > 5))
        return res.status(400).json({ error: 'курс — целое от 1 до 5' });
    }
    const note = Object.prototype.hasOwnProperty.call(body, 'note')
      ? String(body.note ?? '').trim().slice(0, 200) || null
      : undefined;
    setRoomCapacity(name, capacity ?? null, kind, dept, courseOnly, note);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Справочник групп с численностью.
router.get('/groups', requireAuth, (req, res, next) => {
  try {
    res.json(getDb().prepare('SELECT id, name, headcount, dept, hidden FROM groups ORDER BY name').all());
  } catch (err) {
    next(err);
  }
});

// Установка численности группы. Тело: {name, headcount}.
router.put('/groups', requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const { name, headcount } = body;
    if (!name) return res.status(400).json({ error: 'нужно имя группы' });
    if (headcount != null && (!Number.isInteger(headcount) || headcount < 0))
      return res.status(400).json({ error: 'численность — неотрицательное целое' });
    const dept = Object.prototype.hasOwnProperty.call(body, 'dept') ? (body.dept ?? null) : undefined;
    setGroupHeadcount(name, headcount ?? null, dept);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Сводка по преподавателям: кафедра, дисциплины, пары, отметки об изменениях.
router.get('/teachers-overview', requireAuth, (req, res, next) => {
  try {
    res.json({ rows: getTeachersOverview() });
  } catch (err) {
    next(err);
  }
});

// Ручная кафедра преподавателя. Тело: {name, dept}.
router.put('/teachers', requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'нужно имя преподавателя' });
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    if (!has('dept')) return res.status(400).json({ error: 'нечего менять' });
    setTeacherInfo(name, { dept: String(body.dept ?? '').trim().slice(0, 100) });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Скрыть/показать группу или аудиторию в селекторе просмотра.
// Тело: {kind: 'rooms'|'groups', name, hidden: boolean}.
router.put('/entity-visibility', requireAuth, (req, res, next) => {
  try {
    const { kind, name, hidden } = req.body || {};
    if (kind !== 'rooms' && kind !== 'groups') return res.status(400).json({ error: 'kind: rooms или groups' });
    if (!name) return res.status(400).json({ error: 'нужно имя' });
    setEntityHidden(kind, name, !!hidden);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
// Скрыть/показать все группы или аудитории.
// Тело: {kind: 'rooms'|'groups', hidden: boolean}.
router.put('/entity-visibility/bulk', requireAuth, (req, res, next) => {
  try {
    const { kind, hidden } = req.body || {};
    if (kind !== 'rooms' && kind !== 'groups') return res.status(400).json({ error: 'kind: rooms или groups' });
    const { transaction } = require('../services/dbService');
    transaction((db) => {
      db.prepare(`UPDATE ${kind} SET hidden = ?`).run(hidden ? 1 : 0);
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
