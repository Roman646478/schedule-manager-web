'use strict';

// График сессии по группам — чистая сборка поверх календаря сессии, без БД.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionCalendar, buildSessionSchedule } = require('../src/services/conflictService');

const L = (over) => Object.assign(
  { id: 1, isoDate: '2026-06-10', date: '10.06', day: 'Ср', pairNo: 1, type: 'Экз',
    subject: 'ТАК', subjectFull: 'Тактика', rooms: ['101'], teachers: ['Иванов'], groups: ['811'] },
  over,
);

const schedule = (lessons, groups, extra) => buildSessionSchedule(
  { ...buildSessionCalendar(lessons, groups, []), groupCourse: { 811: 1, 812: 1, 821: 2 } },
  extra,
);
const rowsOf = (res, group) => res.groups.find((g) => g.group === group).rows;

test('поток: строка у каждой группы, остальные группы, численность и места, кафедра преподавателя', () => {
  const res = schedule(
    [L({ groups: ['811', '812'], rooms: ['101', '102'] })],
    ['811', '812'],
    { teacherDept: { Иванов: '81' }, groupHeadcount: { 811: 12, 812: 15 }, roomCapacity: { 101: 20, 102: 10 } },
  );
  assert.deepEqual(res.groups.map((g) => [g.group, g.course]), [['811', 1], ['812', 1]]);
  const [a] = rowsOf(res, '811');
  const [b] = rowsOf(res, '812');
  assert.deepEqual(a.stream, ['812']);
  assert.deepEqual(b.stream, ['811']);
  assert.equal(a.headcount, 27, 'курсантов всего потока');
  assert.equal(a.capacity, 30, 'места двух аудиторий');
  assert.deepEqual(a.teachers, [{ name: 'Иванов', dept: '81' }]);
});

test('строки группы по дате, дни после предыдущей формы контроля', () => {
  const res = schedule([
    L({ id: 3, isoDate: '2026-06-13', date: '13.06', subject: 'МАТ' }),
    L({ id: 1, isoDate: '2026-06-05', date: '05.06', type: 'зо', subject: 'ОТ' }),
    L({ id: 2, isoDate: '2026-06-10', date: '10.06' }),
  ], ['811']);
  const rows = rowsOf(res, '811');
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.gapDays), [null, 5, 3]);
  assert.deepEqual(rows.map((r) => r.kind), ['zachet', 'exam', 'exam']);
});

test('подготовка к экзамену — только конфликты этой группы; у зачёта проверки нет', () => {
  const res = schedule([
    L({ id: 1, groups: ['811', '812'] }),
    L({ id: 2, isoDate: '2026-06-09', date: '09.06', type: 'Л', subject: 'ИСТ', groups: ['811'] }), // занят день подготовки
    L({ id: 3, isoDate: '2026-06-20', date: '20.06', type: 'зо', subject: 'ОТ', groups: ['812'] }),
  ], ['811', '812']);
  assert.equal(rowsOf(res, '811')[0].prepConflicts.length, 1);
  assert.equal(rowsOf(res, '811')[0].prepConflicts[0].date, '09.06');
  assert.deepEqual(rowsOf(res, '812')[0].prepConflicts, [], 'у второй группы потока дни свободны');
  assert.equal(rowsOf(res, '812')[1].prepConflicts, null, 'зачёт');
});

test('без форм контроля и скрытые группы не выводятся; места неизвестны, если нет вместимости; примечание с любой пары', () => {
  const res = schedule([
    L({ id: 1, pairNo: 1, groups: ['811', '899'] }),
    L({ id: 2, pairNo: 2, groups: ['811', '899'], note: 'в спортзале' }),
  ], ['811', '821'], { roomCapacity: {} }); // 899 скрыта — её нет в списке групп
  assert.deepEqual(res.groups.map((g) => g.group), ['811']);
  const [r] = rowsOf(res, '811');
  assert.deepEqual([r.pairFrom, r.pairTo], [1, 2], 'две пары — одна форма контроля');
  assert.equal(r.capacity, null);
  assert.equal(r.headcount, null);
  assert.equal(r.note, 'в спортзале');
  assert.deepEqual(r.stream, ['899']);
});
