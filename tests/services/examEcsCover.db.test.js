'use strict';

// Перенос экзамена в день с ЭкзС не должен ПРАВИТЬ саму метку. Раньше группы
// экзамена вычищались из метки насовсем (а метка целиком удалялась, если экзамен
// покрывал весь её состав): сессия пропадала у всего потока и не возвращалась,
// когда экзамен уезжал. Теперь экзамен просто встаёт поверх метки, а скрытием
// занимается hideCoveredEcs — ровно у групп экзамена и ровно в занятых парах.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-exam-ecs-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { createLesson, moveLesson, getExamMoveTargets, moveExam } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');

const HOME = { day: 'Пн', weekNo: 1 };   // где экзамен стоит изначально
const TARGET = { day: 'Чт', weekNo: 2 }; // день с ЭкзС, куда его переносим
const EXAM_PAIRS = [1, 2];               // экзамен занимает пары 1-2
const ALL_PAIRS = [1, 2, 3, 4];

// Группы метки: одна сдаёт экзамен, вторая — просто сосед по потоку.
const MINE = 'G1';
const OTHER = 'G2';

let examId = null;

// Группы метки ЭкзС в базе — как есть, в обход скрытия.
function markGroupsInDb(pairNo) {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM lessons WHERE category='event' AND subject='ЭкзС' AND week_no=? AND day=? AND pair_no=?")
    .get(TARGET.weekNo, TARGET.day, pairNo);
  if (!row) return null;
  return db
    .prepare('SELECT g.name FROM lesson_groups lg JOIN groups g ON g.id=lg.group_id WHERE lg.lesson_id=? ORDER BY g.name')
    .all(row.id)
    .map((r) => r.name);
}

// Группы, которые ВИДЯТ метку в сетке (после hideCoveredEcs).
function markGroupsVisible(pairNo) {
  const m = loadLessons().find(
    (l) => l.event && l.subject === 'ЭкзС' && l.weekNo === TARGET.weekNo && l.day === TARGET.day && l.pairNo === pairNo
  );
  return m ? [...m.groups].sort() : [];
}

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2026-02-02', end: '2026-07-01', selected: 1 }, db);
  for (const g of [MINE, OTHER]) db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(g, 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 30);

  // Экзамен на двух парах: две строки одной формы контроля.
  for (const p of EXAM_PAIRS) {
    const r = createLesson({
      ...HOME, pairNo: p, subject: 'УЭВ', type: 'Экз', teacher: 'Иванов И.И.', groups: [MINE], rooms: ['A'],
    });
    assert.equal(r.ok, true);
  }
  examId = loadLessons().find((l) => l.subject === 'УЭВ' && l.pairNo === EXAM_PAIRS[0]).id;

  // Метка сессии в целевом дне — одна запись на пару, обе группы в каждой.
  for (const p of ALL_PAIRS) {
    const r = createLesson({ ...TARGET, pairNo: p, subject: 'ЭкзС', category: 'event', groups: [MINE, OTHER] });
    assert.equal(r.ok, true);
  }
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('день с ЭкзС предлагается как цель переноса экзамена', () => {
  const r = getExamMoveTargets(examId);
  assert.equal(r.ok, true);
  assert.ok(
    r.targets.some((t) => t.weekNo === TARGET.weekNo && t.day === TARGET.day),
    'день с полным ЭкзС должен быть среди целей'
  );
});

test('перенос экзамена в ЭкзС: запись метки не меняется', () => {
  const res = moveExam(examId, TARGET.weekNo, TARGET.day);
  assert.equal(res.ok, true);
  for (const p of ALL_PAIRS) {
    assert.deepEqual(markGroupsInDb(p), [MINE, OTHER], `пара ${p}: метка в базе должна сохранить обе группы`);
  }
});

test('метка скрыта только у групп экзамена и только в занятых парах', () => {
  for (const p of EXAM_PAIRS) {
    assert.deepEqual(markGroupsVisible(p), [OTHER], `пара ${p}: метку видит только соседняя группа`);
  }
  for (const p of ALL_PAIRS.filter((p) => !EXAM_PAIRS.includes(p))) {
    assert.deepEqual(markGroupsVisible(p), [MINE, OTHER], `пара ${p}: экзамена нет — метку видят обе группы`);
  }
});

test('экзамен уехал — метка вернулась сама', () => {
  for (const l of loadLessons().filter((x) => x.subject === 'УЭВ')) {
    const res = moveLesson(l.id, { ...HOME, pairNo: l.pairNo, force: true });
    assert.equal(res.ok, true);
  }
  for (const p of ALL_PAIRS) {
    assert.deepEqual(markGroupsVisible(p), [MINE, OTHER], `пара ${p}: после ухода экзамена метку видят обе группы`);
  }
});
