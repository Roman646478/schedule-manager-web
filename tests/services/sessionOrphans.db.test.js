'use strict';

// Занятие из файла преподавателя, попавшее на «ЭкзС» группы, раньше молча
// пропадало (в сетке группы там метка сессии, совпадать не с чем). Теперь оно
// сохраняется вне сетки, в полосе «Не размещённые при импорте».
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-orphans-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { getOrphans, getParked, getView, moveLesson } = require('../../src/services/scheduleService');
const { getDb, closeDb } = require('../../src/config/database');

// Занятие, размещённое первым тестом, и слот с меткой «ЭкзС» — их берёт второй тест.
let placedId = null;
let ecsSlot = null;

const EXAMPLES = path.join(__dirname, '..', '..', 'примеры', 'весна');
const GROUP_FILE = path.join(EXAMPLES, 'Расписание занятий', '8Ф', '823', '823.html');
// Преподаватель, у которого в файле есть пары группы 823.
const TEACHER_FILE = path.join(EXAMPLES, 'Загрузка преподавателей', '1Ф', '12 кафедра', 'БелянкинА.В', 'БелянкинА.В..html');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP + ext);
    } catch {
      /* нет файла — ок */
    }
  }
});

test('импорт: пара преподавателя на «ЭкзС» группы уходит в «не размещённые», а не теряется', () => {
  const group = { buffer: fs.readFileSync(GROUP_FILE) };
  const teacher = { buffer: fs.readFileSync(TEACHER_FILE) };
  importFiles([group], 'merge');
  importFiles([teacher], 'merge', { filterTeachers: false });

  const db = getDb();
  // Слот, где у группы 823 стоит пара этого преподавателя, отдаём сессии:
  // занятие убираем, вместо него — метка «ЭкзС» (как в файле группы на сессии).
  const L = db
    .prepare(
      `SELECT l.id, l.day, l.pair_no AS pairNo, l.week_no AS weekNo, l.subject
         FROM lessons l
         JOIN teachers t ON t.id = l.teacher_id
         JOIN lesson_groups lg ON lg.lesson_id = l.id
         JOIN groups g ON g.id = lg.group_id
        WHERE g.name = '823' AND t.name LIKE 'Белянкин%' LIMIT 1`
    )
    .get();
  assert.ok(L, 'в примерах есть пара группы 823 у этого преподавателя');
  db.prepare('DELETE FROM lessons WHERE id = ?').run(L.id);
  const gid = db.prepare("SELECT id FROM groups WHERE name = '823'").get().id;
  const mark = db
    .prepare("INSERT INTO lessons (day, pair_no, week_no, subject, category) VALUES (?, ?, ?, 'ЭкзС', 'event')")
    .run(L.day, L.pairNo, L.weekNo);
  db.prepare('INSERT INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)').run(Number(mark.lastInsertRowid), gid);

  // Повторный импорт файла преподавателя: пары в сетке нет — раньше она пропадала.
  const report = importFiles([teacher], 'merge', { filterTeachers: false });
  assert.equal(report.sessionOrphans, 1, 'пара учтена как не размещённая');

  const orphans = getOrphans();
  assert.equal(orphans.length, 1);
  const o = orphans[0];
  assert.equal(o.subject, L.subject);
  assert.deepEqual(o.groups, ['823']);
  assert.equal(getParked().length, 0, 'в обычный буфер не попадает');
  const inGrid = getView('group', '823').filter(
    (l) => l.day === L.day && l.pairNo === L.pairNo && l.weekNo === L.weekNo
  );
  assert.deepEqual(inGrid.map((l) => l.subject), ['ЭкзС'], 'в сетке по-прежнему метка сессии');

  // Расстановка вручную: перенос в свободное окно возвращает занятие в сетку.
  const moved = moveLesson(o.id, { day: 'Пт', pairNo: 4, weekNo: L.weekNo, rooms: [], force: true });
  assert.equal(moved.ok, true, 'занятие переносится в сетку');
  assert.equal(getOrphans().length, 0, 'после размещения оно уже не «не размещённое»');
  placedId = o.id;
  ecsSlot = { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo };
  assert.ok(
    getView('group', '823').some((l) => l.id === o.id && l.day === 'Пт' && l.pairNo === 4),
    'занятие видно в расписании группы'
  );
});

test('импорт файла группы возвращает «не размещённое» занятие в сетку', () => {
  const db = getDb();
  const teacher = { buffer: fs.readFileSync(TEACHER_FILE) };
  // Слот из первого теста (метка «ЭкзС» там осталась) — занятие снова убираем,
  // чтобы импорт преподавателя опять отложил его как не размещённое.
  const mark = ecsSlot;
  db.prepare('DELETE FROM lessons WHERE id = ?').run(placedId);

  const report = importFiles([teacher], 'merge', { filterTeachers: false });
  assert.equal(report.sessionOrphans, 1);
  const o = getOrphans()[0];

  // Файл группы говорит, что занятие в этом слоте настоящее (сессии там нет) —
  // значит место в сетке для него есть: возвращаем.
  importFiles([{ buffer: fs.readFileSync(GROUP_FILE) }], 'merge');
  assert.equal(getOrphans().length, 0, 'занятие вернулось в сетку');
  assert.ok(
    getView('group', '823').some((l) => l.id === o.id && l.day === mark.day && l.pairNo === mark.pairNo),
    'и видно в расписании группы на своём слоте'
  );
});
