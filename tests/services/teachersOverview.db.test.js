'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-tchr-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, moveLesson, getTeachersOverview, setTeacherInfo } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');

const IVANOV = 'Иванов И.И.';
const PETROV = 'Петров П.П.';
const SIDOROV = 'Сидоров С.С.';

test.before(() => {
  const db = getDb();
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-13', selected: 1 }, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('G1', 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('A', 30);
  // Кафедра у преподавателя берётся от его дисциплин; у ФП кафедры нет.
  db.prepare('INSERT INTO subjects(abbr, full_name, dept) VALUES(?,?,?)').run('РТС', 'Радиотехнические системы', '101');
  db.prepare('INSERT INTO subjects(abbr, full_name, dept) VALUES(?,?,?)').run('ТПРН', 'Технологии', '101');
  db.prepare('INSERT INTO subjects(abbr, full_name, dept) VALUES(?,?,?)').run('ФП', 'Физподготовка', null);

  const add = (subject, teacher, pairNo) =>
    createLesson({ day: 'Пн', pairNo, weekNo: 1, subject, type: 'ПЗ', teacher, groups: ['G1'], rooms: ['A'] });
  assert.equal(add('РТС', IVANOV, 1).ok, true);
  assert.equal(add('ТПРН', IVANOV, 2).ok, true);
  assert.equal(add('ФП', PETROV, 3).ok, true);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

const rowOf = (name) => getTeachersOverview().find((r) => r.name === name);

test('кафедра считается по дисциплинам, дисциплины и пары — по занятиям', () => {
  const r = rowOf(IVANOV);
  assert.equal(r.dept, '101');
  assert.equal(r.deptAuto, '101');
  assert.equal(r.deptManual, false);
  assert.deepEqual(r.subjects, ['РТС', 'ТПРН']);
  assert.equal(r.lessons, 2);
});

test('без кафедры у дисциплины преподаватель попадает в блок «не указана»', () => {
  const r = rowOf(PETROV);
  assert.equal(r.dept, '');
  assert.equal(r.subjects.length, 1);
});

test('ручная кафедра перекрывает автоматическую, пустая — возвращает расчёт', () => {
  setTeacherInfo(IVANOV, { dept: '113' });
  let r = rowOf(IVANOV);
  assert.equal(r.dept, '113');
  assert.equal(r.deptManual, true);
  assert.equal(r.deptAuto, '101'); // автоопределение видно как подсказка

  setTeacherInfo(IVANOV, { dept: '' });
  r = rowOf(IVANOV);
  assert.equal(r.dept, '101');
  assert.equal(r.deptManual, false);
});

test('«Изменения» — это любая запись в журнале: перенос, создание, удаление', () => {
  // Занятие, вставленное мимо журнала (так приходит импорт), изменений не даёт.
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO teachers(name) VALUES(?)').run(SIDOROV);
  const tid = db.prepare('SELECT id FROM teachers WHERE name = ?').get(SIDOROV).id;
  const gid = db.prepare("SELECT id FROM groups WHERE name = 'G1'").get().id;
  db.prepare('INSERT INTO lessons(day, pair_no, week_no, subject, type, teacher_id) VALUES(?,?,?,?,?,?)')
    .run('Пн', 4, 1, 'РТС', 'ПЗ', tid);
  const id = db.prepare('SELECT MAX(id) AS id FROM lessons').get().id;
  db.prepare('INSERT INTO lesson_teachers(lesson_id, teacher_id) VALUES(?,?)').run(id, tid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) VALUES(?,?)').run(id, gid);
  assert.equal(rowOf(SIDOROV).changed, false);

  // Перенос — запись в журнале, галочка появляется.
  assert.equal(moveLesson(id, { day: 'Вт', pairNo: 4, weekNo: 1 }).ok, true);
  assert.equal(rowOf(SIDOROV).changed, true);

  // Созданное через createLesson занятие журналируется сразу (action = create).
  assert.equal(rowOf(IVANOV).changed, true);
});

test('в списке только преподаватели с занятиями, порядок — по кафедре и имени', () => {
  getDb().prepare('INSERT OR IGNORE INTO teachers(name) VALUES(?)').run('Безуроков Б.Б.');
  const rows = getTeachersOverview();
  assert.equal(rows.some((r) => r.name === 'Безуроков Б.Б.'), false);
  const depts = rows.map((r) => r.dept);
  assert.deepEqual([...depts].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), depts);
});

test('при дисциплинах с разных кафедр берётся та, где больше занятий', () => {
  const db = getDb();
  db.prepare('INSERT INTO subjects(abbr, full_name, dept) VALUES(?,?,?)').run('ИБ', 'Информбезопасность', '117');
  // У Иванова 2 пары по кафедре 101 (РТС, ТПРН) и 1 по 117 — основная 101.
  assert.equal(
    createLesson({ day: 'Ср', pairNo: 1, weekNo: 1, subject: 'ИБ', type: 'ПЗ', teacher: IVANOV, groups: ['G1'], rooms: ['A'] }).ok,
    true
  );
  const r = rowOf(IVANOV);
  assert.equal(r.deptAuto, '101');
  assert.equal(r.deptAll, '101 (2), 117 (1)'); // подсказка показывает весь расклад с числом пар
});
