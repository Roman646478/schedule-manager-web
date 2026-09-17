'use strict';

const { commandRouter } = require('../middleware/mutations');
const { requireAuth } = require('../middleware/auth');
const {
  saveCurriculum, getCurriculum, getMapping, saveMapping, listKafedras, runCheck, teacherGroupsSummary, subjectGroupsSummary,
} = require('../services/curriculumService');

const router = commandRouter();

// Список загруженных учебных планов (по кафедрам).
router.get('/curriculum', requireAuth, (req, res, next) => {
  try {
    res.json({ kafedras: listKafedras() });
  } catch (err) {
    next(err);
  }
});

// Сверка расписания группы с планом её кафедры. ?group=821-11
router.get('/curriculum/check', requireAuth, (req, res, next) => {
  try {
    const result = runCheck(req.query.group);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Сводка по группам преподавателя ОДНИМ запросом: часы по дисциплинам + сверка
// с планом на каждую группу. Заменяет два запроса на группу (schedule + check) —
// у преподавателя с 22 группами это было 45 запросов и несколько секунд.
router.get('/teacher-groups', requireAuth, (req, res, next) => {
  try {
    const result = teacherGroupsSummary(req.query.teacher);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// То же для дисциплины (вид «Дисциплина»): её группы + сверка каждой с планом.
router.get('/subject-groups', requireAuth, (req, res, next) => {
  try {
    const result = subjectGroupsSummary(req.query.subject);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// План + маппinг конкретной кафедры.
router.get('/curriculum/:kaf', requireAuth, (req, res, next) => {
  try {
    const plan = getCurriculum(req.params.kaf);
    if (!plan) return res.status(404).json({ error: 'План не найден' });
    res.json({ plan, mapping: getMapping(req.params.kaf) });
  } catch (err) {
    next(err);
  }
});

// Сохранить разобранный план (разбор xlsx сделан в браузере). Тело: {kafedra, plan}.
router.post('/curriculum', requireAuth, (req, res, next) => {
  try {
    const { kafedra, plan } = req.body || {};
    if (!kafedra || !plan || !Array.isArray(plan.disciplines)) {
      return res.status(400).json({ error: 'Ожидается {kafedra, plan:{disciplines:[…]}}' });
    }
    res.json({ success: true, saved: saveCurriculum(kafedra, plan) });
  } catch (err) {
    next(err);
  }
});

// Сохранить маппинг «дисциплина плана → аббревиатура». Тело: {mapping}.
router.put('/curriculum/:kaf/mapping', requireAuth, (req, res, next) => {
  try {
    const { mapping } = req.body || {};
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'Ожидается {mapping:{…}}' });
    }
    res.json({ success: true, mapping: saveMapping(req.params.kaf, mapping) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
