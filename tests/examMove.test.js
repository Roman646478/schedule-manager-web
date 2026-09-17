'use strict';

// Чистая логика поиска «окон»-ЭкзС для переноса экзамена. БД не трогаем —
// проверяем экспортируемые findExamRows/examTargets на синтетике.
const test = require('node:test');
const assert = require('node:assert/strict');

// Пробрасываем внутренние чистые функции через require кеша модуля. Они не
// экспортируются наружу как публичный API, но доступны для проверки через
// прямой доступ к module (см. экспорт в конце scheduleService — getExamMoveTargets/moveExam
// обёрнуты в БД). Здесь тестируем через examTargets, вызывая getExamMoveTargets было бы с БД,
// поэтому используем чистые функции напрямую из модуля.
const sched = require('../src/services/scheduleService');

// findExamRows/examTargets — внутренние; экспонируем их для теста через __test при наличии,
// иначе тест проверяет поведение косвенно. Чтобы не усложнять, добавим их в экспорт.
const { __examInternals } = sched;

const L = (over) => Object.assign(
  { id: 1, weekNo: 25, day: 'Пн', pairNo: 1, type: 'Экз', subject: 'ТАК',
    subjectFull: 'Тактика', rooms: ['101'], teachers: ['Иванов'], groups: ['811'],
    parked: false, event: false }, over);
const ecs = (over) => L(Object.assign({ subject: 'ЭкзС', type: null, event: true, rooms: [], teachers: [] }, over));

test('findExamRows: собирает все пары экзамена', () => {
  const lessons = [L({ id: 1, pairNo: 1 }), L({ id: 2, pairNo: 2 }), L({ id: 3, pairNo: 3 })];
  const ex = __examInternals.findExamRows(lessons, 1);
  assert.deepEqual(ex.pairs, [1, 2, 3]);
  assert.deepEqual(ex.ids.sort(), [1, 2, 3]);
});

test('findExamRows: зачёт тоже переносится (kind=zachet)', () => {
  const z = __examInternals.findExamRows([L({ id: 1, type: 'зо' })], 1);
  assert.ok(z);
  assert.equal(z.kind, 'zachet');
});

test('findExamRows: обычное занятие → null', () => {
  assert.equal(__examInternals.findExamRows([L({ id: 1, type: 'Л' })], 1), null);
});

test('examTargets зачёт: свободная пара — день валиден, занятая — нет', () => {
  const z = __examInternals.findExamRows([L({ id: 1, type: 'зо', weekNo: 25, day: 'Пн', pairNo: 1 })], 1);
  const lessons = [
    L({ id: 1, type: 'зо', weekNo: 25, day: 'Пн', pairNo: 1 }),
    // нед.26 Вт пара 1 занята настоящим занятием у группы 811 → этот день исключён
    L({ id: 5, weekNo: 26, day: 'Вт', pairNo: 1, type: 'Л', subject: 'МАТ', groups: ['811'], teachers: ['Петров'], rooms: ['305'] }),
  ];
  const t = __examInternals.examTargets(lessons, z, null);
  assert.ok(!t.some((x) => x.weekNo === 26 && x.day === 'Вт'), 'занятая пара исключена');
  assert.ok(t.some((x) => x.weekNo === 26 && x.day === 'Ср'), 'свободный день включён');
});

test('examTargets экзамен: занятие в день подготовки → день отклоняется', () => {
  const semester = { name: 'весна', start: '2026-02-02', end: '2026-07-01' };
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн' })], 1);
  const base = [
    L({ id: 1, weekNo: 25, day: 'Пн' }),
    ecs({ id: 9, weekNo: 26, day: 'Чт', groups: ['811'] }),
  ];
  assert.equal(__examInternals.examTargets(base, exam, semester).length, 1); // дни подготовки свободны
  const withBusy = base.concat([
    L({ id: 5, weekNo: 26, day: 'Ср', pairNo: 1, type: 'Л', subject: 'МАТ', groups: ['811'], teachers: ['Петров'], rooms: ['305'] }),
  ]);
  assert.equal(__examInternals.examTargets(withBusy, exam, semester).length, 0); // занят день подготовки
});

test('examTargets: день с полным ЭкзС для всех групп — валиден', () => {
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн' })], 1);
  const lessons = [
    L({ id: 1, weekNo: 25, day: 'Пн' }),
    ecs({ id: 9, weekNo: 26, day: 'Вт', groups: ['811', '812'] }),
  ];
  const t = __examInternals.examTargets(lessons, exam, null);
  assert.equal(t.length, 1);
  assert.equal(t[0].weekNo, 26);
  assert.equal(t[0].day, 'Вт');
});

test('examTargets: день с настоящим занятием у группы — отклоняется', () => {
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн' })], 1);
  const lessons = [
    L({ id: 1, weekNo: 25, day: 'Пн' }),
    ecs({ id: 9, weekNo: 26, day: 'Вт', groups: ['811'] }),
    L({ id: 5, weekNo: 26, day: 'Вт', pairNo: 1, type: 'Л', subject: 'МАТ', groups: ['811'] }),
  ];
  assert.equal(__examInternals.examTargets(lessons, exam, null).length, 0);
});

test('examTargets: накладка по аудитории — отклоняется', () => {
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн', rooms: ['101'] })], 1);
  const lessons = [
    L({ id: 1, weekNo: 25, day: 'Пн', rooms: ['101'] }),
    ecs({ id: 9, weekNo: 26, day: 'Вт', groups: ['811'] }),
    // другая группа занимает ту же аудиторию 101 на той же паре
    L({ id: 6, weekNo: 26, day: 'Вт', pairNo: 1, type: 'Л', subject: 'ФИЗ', groups: ['999'], rooms: ['101'] }),
  ];
  assert.equal(__examInternals.examTargets(lessons, exam, null).length, 0);
});

test('examTargets: у преподавателя в этот день уже другой экзамен — отклоняется', () => {
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн', teachers: ['Иванов'] })], 1);
  const lessons = [
    L({ id: 1, weekNo: 25, day: 'Пн', teachers: ['Иванов'] }),
    ecs({ id: 9, weekNo: 26, day: 'Вт', groups: ['811'] }),
    // тот же преподаватель ведёт другой экзамен в тот же день, но на другой паре
    L({ id: 7, weekNo: 26, day: 'Вт', pairNo: 4, type: 'Экз', subject: 'ДРУГ', groups: ['999'], rooms: ['202'], teachers: ['Иванов'] }),
  ];
  assert.equal(__examInternals.examTargets(lessons, exam, null).length, 0);
});

test('examTargets: ЭкзС не у всех групп потока — отклоняется', () => {
  const exam = __examInternals.findExamRows([L({ id: 1, weekNo: 25, day: 'Пн', groups: ['811', '812'] })], 1);
  const lessons = [
    L({ id: 1, weekNo: 25, day: 'Пн', groups: ['811', '812'] }),
    ecs({ id: 9, weekNo: 26, day: 'Вт', groups: ['811'] }), // только 811
  ];
  assert.equal(__examInternals.examTargets(lessons, exam, null).length, 0);
});
