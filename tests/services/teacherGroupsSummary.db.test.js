'use strict';

// Сводка по группам преподавателя одним запросом: часы по дисциплинам считаются
// по ВСЕЙ группе (все преподаватели), сверка с планом идёт на тех же занятиях.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-tgs-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { teacherGroupsSummary, subjectGroupsSummary } = require('../../src/services/curriculumService');

const TEACHER = 'Первый П.П.';
const OTHER = 'Второй В.В.';

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'осень', start: '2026-08-31', end: '2027-01-31', selected: 1 }, db);
  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  g.run('811-11', 20);
  g.run('811-12', 20);
  g.run('812-11', 20);

  const mk = (over) => createLesson(Object.assign({
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', teacher: TEACHER, groups: ['811-11'],
  }, over));

  // Наш преподаватель: лекция + практика у 811-11, поток у 811-11 и 811-12.
  mk({ type: 'Л', weekNo: 1 });
  mk({ type: 'ПЗ', weekNo: 2 });
  mk({ type: 'Л', weekNo: 3, groups: ['811-11', '811-12'] });
  // Ту же дисциплину у 811-11 ведёт и другой преподаватель — его часы тоже
  // должны попасть в сводку (сверка идёт по всей группе).
  mk({ type: 'ПЗ', weekNo: 4, teacher: OTHER });
  // Зачёт: в практику идёт как обычное занятие и отдельно копится в zachetH.
  mk({ type: 'ЗО', weekNo: 5, teacher: OTHER });
  // СР не считается вовсе.
  mk({ subject: 'СР', type: 'СР', weekNo: 6 });
  // Чужая группа, где нашего преподавателя нет, — в сводку не попадает.
  mk({ weekNo: 7, teacher: OTHER, groups: ['812-11'] });
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* нет файла — ок */ }
  }
});

test('в сводку попадают только группы преподавателя', () => {
  const r = teacherGroupsSummary(TEACHER);
  assert.deepEqual(Object.keys(r.groups).sort(), ['811-11', '811-12']);
  assert.equal(r.teacher, TEACHER);
});

test('часы считаются по всей группе, а не только по этому преподавателю', () => {
  const s = teacherGroupsSummary(TEACHER).groups['811-11'].subjects.ТПРН;
  // Л ×2 (одна из них потоковая) = 4 ч; ПЗ ×2 + ЗО = 6 ч; зачёт отдельно 2 ч.
  assert.equal(s.lecH, 4, 'лекции: обе пары вида «Л»');
  assert.equal(s.pracH, 6, 'практика: ПЗ нашего, ПЗ чужого и зачёт');
  assert.equal(s.zachetH, 2, 'зачёт учтён отдельно — он идёт в сумму столбца «Уч. план»');
  assert.ok(!('СР' in teacherGroupsSummary(TEACHER).groups['811-11'].subjects), 'СР в часы не идёт');
});

test('потоковая пара учитывается каждой группе потока', () => {
  const r = teacherGroupsSummary(TEACHER);
  assert.equal(r.groups['811-12'].subjects.ТПРН.lecH, 2, 'у второй группы потока та же лекция');
});

test('без загруженного учебного плана столбец плана пуст, а часы считаются', () => {
  const r = teacherGroupsSummary(TEACHER);
  assert.equal(r.groups['811-11'].plan, null, 'плана кафедры нет — null, а не ошибка');
  assert.ok(r.groups['811-11'].subjects.ТПРН.lecH > 0);
});

test('без преподавателя — понятная ошибка', () => {
  assert.match(teacherGroupsSummary('').error, /преподавател/i);
});

// Та же сводка для вида «Дисциплина»: группы берутся по дисциплине, а часы
// в них — те же, что у преподавателя (по всей группе).
test('сводка дисциплины: все её группы, включая чужие для преподавателя', () => {
  const r = subjectGroupsSummary('ТПРН');
  assert.equal(r.subject, 'ТПРН');
  assert.deepEqual(Object.keys(r.groups).sort(), ['811-11', '811-12', '812-11']);
  assert.equal(r.groups['811-11'].subjects.ТПРН.lecH, 4, 'часы группы те же, что и в сводке преподавателя');
});

test('сводка дисциплины: без дисциплины — понятная ошибка', () => {
  assert.match(subjectGroupsSummary('').error, /дисциплин/i);
});
