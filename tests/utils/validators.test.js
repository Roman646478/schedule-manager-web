'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findOverlaps, checkCapacity, checkReferences, validateMove, findAliasCandidates } = require('../../src/utils/validators');

const L = (o) => ({ groups: [], teacher: null, room: null, ...o });

test('findOverlaps: накладка преподавателя в одном слоте', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'Иванов', room: '101', groups: ['G1'] }),
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'Иванов', room: '102', groups: ['G2'] }),
  ];
  const c = findOverlaps(lessons);
  assert.equal(c.filter((x) => x.kind === 'teacher').length, 1);
  assert.deepEqual(c.find((x) => x.kind === 'teacher').lessonIds.sort(), [1, 2]);
});

test('findOverlaps: накладка аудитории и группы', () => {
  const lessons = [
    L({ id: 1, day: 'Вт', pairNo: 2, weekNo: 3, teacher: 'А', room: '200', groups: ['G1'] }),
    L({ id: 2, day: 'Вт', pairNo: 2, weekNo: 3, teacher: 'Б', room: '200', groups: ['G1'] }),
  ];
  const kinds = findOverlaps(lessons).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['group', 'room']);
});

test('findOverlaps: поток (одно занятие — много групп) не накладка', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'А', room: '101', groups: ['G1', 'G2'] }),
  ];
  assert.equal(findOverlaps(lessons).length, 0);
});

test('два преподавателя на одном занятии (любой вид): проверяется каждый', () => {
  // Вдвоём ведут не только зачёты — обычная лекция тоже. Сама пара двух
  // преподавателей на ОДНОМ занятии накладкой не считается.
  const pair = L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', teachers: ['Иванов', 'Петров'], room: '101', groups: ['G1'] });
  assert.equal(findOverlaps([pair]).length, 0);

  // А занятость ВТОРОГО преподавателя в том же слоте — накладка.
  const busySecond = findOverlaps([
    pair,
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', teacher: 'Петров', room: '102', groups: ['G2'] }),
  ]).filter((c) => c.kind === 'teacher');
  assert.equal(busySecond.length, 1);
  assert.match(busySecond[0].detail, /Петров/);

  // Тот же второй преподаватель блокирует и постановку занятия через validateMove.
  const moved = { id: 3, day: 'Пн', pairNo: 1, weekNo: 1, teachers: ['Сидоров', 'Петров'], rooms: ['103'], groups: ['G3'] };
  const res = validateMove(moved, moved, {
    lessons: [L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'Петров', room: '102', groups: ['G2'] })],
    roomCapacity: {},
    groupHeadcount: {},
  });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes('Петров')), `в причинах есть второй преподаватель: ${res.reasons.join('; ')}`);
});

test('findOverlaps: разные слоты — нет накладок', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'А', room: '101', groups: ['G1'] }),
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 2, teacher: 'А', room: '101', groups: ['G1'] }),
  ];
  assert.equal(findOverlaps(lessons).length, 0);
});

test('findAliasCandidates: разные сокращения на совпадающем слоте/группе/ауд.', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'], subject: 'ИЭП', subjectFull: 'Инф. эконом. процессы' }),
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'], subject: 'ИРТС', subjectFull: 'Инф. радиотехн. системы' }),
  ];
  const cands = findAliasCandidates(lessons);
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0].subjects.map((s) => s.abbr).sort(), ['ИРТС', 'ИЭП']);
  assert.equal(cands[0].occurrences, 1);
  assert.deepEqual(cands[0].lessonIds.sort(), [1, 2]);
});

test('findAliasCandidates: агрегирует одинаковую пару вариантов с разных слотов', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'], subject: 'ИЭП' }),
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'], subject: 'ИРТС' }),
    L({ id: 3, day: 'Вт', pairNo: 2, weekNo: 1, room: '102', groups: ['G2'], subject: 'ИЭП' }),
    L({ id: 4, day: 'Вт', pairNo: 2, weekNo: 1, room: '102', groups: ['G2'], subject: 'ИРТС' }),
  ];
  const cands = findAliasCandidates(lessons);
  assert.equal(cands.length, 1, 'одна пара вариантов — одна запись');
  assert.equal(cands[0].occurrences, 2);
});

test('findAliasCandidates: разные аудитории/группы — не кандидат', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'], subject: 'ИЭП' }),
    L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, room: '102', groups: ['G1'], subject: 'ИРТС' }),
    L({ id: 3, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G2'], subject: 'ИРТС' }),
  ];
  assert.equal(findAliasCandidates(lessons).length, 0);
});

test('checkCapacity: превышение вместимости (в т.ч. сумма по потоку)', () => {
  const ref = { roomCapacity: { 101: 30 }, groupHeadcount: { G1: 20, G2: 15 } };
  const single = checkCapacity(L({ id: 1, room: '101', groups: ['G1'] }), ref);
  assert.equal(single, null, '20 ≤ 30 — ок');

  const stream = checkCapacity(L({ id: 2, room: '101', groups: ['G1', 'G2'] }), ref);
  assert.ok(stream, '35 > 30 — превышение');
  assert.equal(stream.required, 35);
  assert.equal(stream.capacity, 30);
});

test('checkCapacity: неизвестные данные не дают ложных ошибок', () => {
  assert.equal(checkCapacity(L({ id: 1, room: '101', groups: ['G1'] }), { roomCapacity: {}, groupHeadcount: {} }), null);
});

test('checkReferences: битые ссылки на аудиторию/преподавателя/группу', () => {
  const known = { rooms: new Set(['101']), teachers: new Set(['Иванов']), groups: new Set(['G1']) };
  const ok = checkReferences(L({ id: 1, room: '101', teacher: 'Иванов', groups: ['G1'] }), known);
  assert.equal(ok.length, 0);

  const bad = checkReferences(L({ id: 2, room: '999', teacher: 'Нет', groups: ['GX'] }), known);
  assert.deepEqual(bad.map((r) => r.field).sort(), ['group', 'room', 'teacher']);
});

test('validateMove: успешный перенос в свободное окно', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'А', room: '101', groups: ['G1'] }),
    L({ id: 2, day: 'Пн', pairNo: 2, weekNo: 1, teacher: 'Б', room: '102', groups: ['G2'] }),
  ];
  const res = validateMove(lessons[0], { day: 'Пн', pairNo: 3, weekNo: 1, room: '101' }, { lessons });
  assert.equal(res.ok, true);
  assert.deepEqual(res.reasons, []);
});

test('validateMove: перенос в занятый слот → отказ с причинами', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'А', room: '101', groups: ['G1'] }),
    L({ id: 2, day: 'Пн', pairNo: 2, weekNo: 1, teacher: 'А', room: '102', groups: ['G1'] }),
  ];
  // Переносим занятие 1 в слот занятия 2: тот же преподаватель и та же группа заняты.
  const res = validateMove(lessons[0], { day: 'Пн', pairNo: 2, weekNo: 1, room: '102' }, { lessons });
  assert.equal(res.ok, false);
  // Преподаватель и группа — жёсткий запрет; занятая аудитория — предупреждение.
  assert.ok(res.reasons.some((r) => /Преподаватель/.test(r)));
  assert.ok(res.reasons.some((r) => /Группа/.test(r)));
  assert.ok(res.warnings.some((r) => /Аудитория/.test(r)));
  assert.ok(!res.reasons.some((r) => /Аудитория/.test(r)), 'аудитория не блокирует перенос');
});

test('validateMove: тесная аудитория — предупреждение, а не отказ', () => {
  const lessons = [L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, teacher: 'А', room: '101', groups: ['G1'] })];
  const res = validateMove(
    lessons[0],
    { day: 'Пн', pairNo: 5, weekNo: 1, room: 'small' },
    { lessons, roomCapacity: { small: 10 }, groupHeadcount: { G1: 25 } }
  );
  assert.equal(res.ok, true, 'нехватка мест размещение не запрещает');
  assert.ok(res.warnings.some((r) => /мало для 25/.test(r)));
});

test('validateMove: capacitySlack гасит предупреждение о нехватке мест', () => {
  const lessons = [L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, room: '101', groups: ['G1'] })];
  const ctx = { lessons, roomCapacity: { small: 20 }, groupHeadcount: { G1: 25 } };
  const target = { day: 'Пн', pairNo: 5, weekNo: 1, room: 'small' };

  assert.ok(validateMove(lessons[0], target, ctx).warnings.length, 'без допуска — предупреждение');
  assert.equal(
    validateMove(lessons[0], target, { ...ctx, capacitySlack: 5 }).warnings.length,
    0,
    'превышение ровно на 5 мест допускается молча'
  );
  assert.ok(
    validateMove(lessons[0], target, { ...ctx, capacitySlack: 4 }).warnings.length,
    'превышение больше допуска — снова предупреждение'
  );
});

// ── ФП: преподаватель принимает контроль у одной группы и ведёт занятие у другой ──

const FP = (o) => L({ subject: 'ФП', teacher: 'Тренеров', ...o });

test('ФП: зачёт у одной группы + пара у другой — не накладка преподавателя', () => {
  const lessons = [
    FP({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ЗО', room: 'Зал', groups: ['G1'] }),
    FP({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Стадион', groups: ['G2'] }),
  ];
  assert.equal(findOverlaps(lessons).filter((c) => c.kind === 'teacher').length, 0);
});

test('ФП: экзамен тоже попадает под послабление', () => {
  const lessons = [
    FP({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, type: 'Э', room: 'Зал', groups: ['G1'] }),
    FP({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Стадион', groups: ['G2'] }),
  ];
  assert.equal(findOverlaps(lessons).filter((c) => c.kind === 'teacher').length, 0);
});

test('ФП: две обычные пары у одного преподавателя — по-прежнему накладка', () => {
  const lessons = [
    FP({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Зал', groups: ['G1'] }),
    FP({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Стадион', groups: ['G2'] }),
  ];
  assert.equal(findOverlaps(lessons).filter((c) => c.kind === 'teacher').length, 1);
});

test('послабление только для ФП: зачёт по другой дисциплине + пара — накладка', () => {
  const lessons = [
    L({ id: 1, day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТМ', type: 'ЗО', teacher: 'Тренеров', room: '101', groups: ['G1'] }),
    FP({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Стадион', groups: ['G2'] }),
  ];
  assert.equal(findOverlaps(lessons).filter((c) => c.kind === 'teacher').length, 1);
});

test('validateMove: ФП-совмещение — предупреждение, а не запрет', () => {
  const other = FP({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', room: 'Стадион', groups: ['G2'] });
  const moved = FP({ id: 1, day: 'Вт', pairNo: 3, weekNo: 1, type: 'ЗО', room: 'Зал', groups: ['G1'] });
  const r = validateMove(moved, { day: 'Пн', pairNo: 1, weekNo: 1, room: 'Зал' }, { lessons: [other] });
  assert.equal(r.ok, true);
  assert.equal(r.reasons.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('Тренеров')));
});

test('validateMove: не-ФП накладка преподавателя остаётся запретом', () => {
  const other = L({ id: 2, day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТМ', type: 'Л', teacher: 'Тренеров', room: '101', groups: ['G2'] });
  const moved = FP({ id: 1, day: 'Вт', pairNo: 3, weekNo: 1, type: 'ЗО', room: 'Зал', groups: ['G1'] });
  const r = validateMove(moved, { day: 'Пн', pairNo: 1, weekNo: 1, room: 'Зал' }, { lessons: [other] });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('Тренеров')));
});
