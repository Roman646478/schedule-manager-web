'use strict';

// Чистые функции календаря сессии — синтетика, без БД.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionKind, buildSessionCalendar } = require('../src/services/conflictService');

test('sessionKind: экзамены', () => {
  for (const t of ['э', 'Э.', 'экз', 'Экзамен']) assert.equal(sessionKind(t), 'exam', t);
});

test('sessionKind: зачёты (зо/зч/з/о/зачёт)', () => {
  for (const t of ['зо', 'ЗО', 'зч', 'з/о', 'зач', 'Зачёт']) assert.equal(sessionKind(t), 'zachet', t);
});

test('sessionKind: курсовые НЕ выводятся → null', () => {
  for (const t of ['кп', 'кпр']) assert.equal(sessionKind(t), null, t);
});

test('sessionKind: «кр» (контрольная) и обычные виды → null', () => {
  for (const t of ['кр', 'л', 'пз', 'ср', '']) assert.equal(sessionKind(t), null, t);
});

const L = (over) => Object.assign(
  { id: 1, isoDate: '2026-06-10', date: '10.06', day: 'Ср', pairNo: 1, type: 'Экз',
    subject: 'ТАК', subjectFull: 'Тактика', rooms: ['101'], teachers: ['Иванов'], groups: ['811'] },
  over,
);

test('buildSessionCalendar: фильтрует не-сессионные, parked и event', () => {
  const lessons = [
    L({ id: 1, type: 'Экз' }),
    L({ id: 2, type: 'Л' }),            // обычное занятие — выкинуть
    L({ id: 3, type: 'Экз', parked: true }), // в буфере — выкинуть
    L({ id: 4, type: 'Экз', event: true }),  // мероприятие — выкинуть
  ];
  const r = buildSessionCalendar(lessons, ['811'], []);
  assert.equal(r.lessons.length, 1);
  assert.equal(r.lessons[0].id, 1);
});

test('buildSessionCalendar: from/to = min/max дата', () => {
  const lessons = [
    L({ id: 1, isoDate: '2026-06-15' }),
    L({ id: 2, isoDate: '2026-06-10', type: 'зо' }),
    L({ id: 3, isoDate: '2026-06-20', type: 'э' }),
  ];
  const r = buildSessionCalendar(lessons, ['811'], []);
  assert.equal(r.from, '2026-06-10');
  assert.equal(r.to, '2026-06-20');
  assert.equal(r.lessons.length, 3);
});

test('buildSessionCalendar: экзамен на нескольких парах → одна запись со всеми парами', () => {
  // Один зачёт занимает пары 1–3 одного дня → 3 строки в БД, но одна форма контроля.
  const lessons = [
    L({ id: 1, pairNo: 1 }),
    L({ id: 2, pairNo: 2 }),
    L({ id: 3, pairNo: 3 }),
  ];
  const r = buildSessionCalendar(lessons, ['811'], []);
  assert.equal(r.lessons.length, 1);
  assert.deepEqual(r.lessons[0].pairs, [1, 2, 3]);
  assert.equal(r.lessons[0].pairFrom, 1);
  assert.equal(r.lessons[0].pairTo, 3);
});

// ── Проверка подготовки к экзамену (3 свободных дня) ──────────────────────────
const cls = (over) => Object.assign(
  { id: 100, type: 'Л', subject: 'МАТ', subjectFull: 'Математика', groups: ['811'],
    rooms: [], teachers: [], parked: false, event: false }, over);

test('prep: занятие в один из 3 дней перед экзаменом → ⚠ (ok=false)', () => {
  const exam = L({ id: 1, type: 'Экз', isoDate: '2026-06-11', day: 'Чт' }); // четверг
  const busy = cls({ id: 2, isoDate: '2026-06-10' }); // среда (за день до) — занято
  const r = buildSessionCalendar([exam, busy], ['811'], []);
  const e = r.lessons.find((x) => x.id === 1);
  assert.equal(e.prep.ok, false);
  assert.equal(e.prep.conflicts[0].isoDate, '2026-06-10');
});

test('prep: СР, физподготовка и мероприятия НЕ занимают день → ok', () => {
  const exam = L({ id: 1, type: 'Экз', isoDate: '2026-06-11' });
  const lessons = [
    exam,
    cls({ id: 2, isoDate: '2026-06-10', type: 'СР' }),                 // самоподготовка
    cls({ id: 3, isoDate: '2026-06-09', subject: 'ФП', subjectFull: 'Физическая подготовка', type: 'ПЗ' }),
    cls({ id: 4, isoDate: '2026-06-08', subject: 'ЭкзС', event: true }), // метка-мероприятие
  ];
  const e = buildSessionCalendar(lessons, ['811'], []).lessons.find((x) => x.id === 1);
  assert.equal(e.prep.ok, true);
});

test('prep: воскресенье и нерабочие дни пропускаются при отсчёте 3 дней', () => {
  // Экзамен в понедельник 2026-06-15. Дни назад: Вс 14 (пропуск), Сб 13 — но 13 нерабочий
  // → тоже пропуск, далее Пт 12, Чт 11, Ср 10. Занятие в Сб 13 НЕ должно влиять.
  const exam = L({ id: 1, type: 'Экз', isoDate: '2026-06-15', day: 'Пн' });
  const busySat = cls({ id: 2, isoDate: '2026-06-13' });
  const r = buildSessionCalendar([exam, busySat], ['811'], ['2026-06-13']);
  const e = r.lessons.find((x) => x.id === 1);
  assert.deepEqual(e.prep.days, ['2026-06-12', '2026-06-11', '2026-06-10']);
  assert.equal(e.prep.ok, true); // занятие 13-го не в окне подготовки
});

test('prep: экзамен по физподготовке — проверки нет (prep=null)', () => {
  const fp = L({ id: 1, type: 'Экз', subject: 'ФП', subjectFull: 'Физическая подготовка', isoDate: '2026-06-11' });
  const r = buildSessionCalendar([fp, cls({ id: 2, isoDate: '2026-06-10' })], ['811'], []);
  assert.equal(r.lessons.find((x) => x.id === 1).prep, null);
});

test('prep: для зачёта проверка не выполняется (prep=null)', () => {
  const z = L({ id: 1, type: 'зо', isoDate: '2026-06-11' });
  const r = buildSessionCalendar([z, cls({ id: 2, isoDate: '2026-06-10' })], ['811'], []);
  assert.equal(r.lessons.find((x) => x.id === 1).prep, null);
});

test('buildSessionCalendar: разные предметы в один день НЕ схлопываются', () => {
  const lessons = [
    L({ id: 1, pairNo: 1, subject: 'ТАК' }),
    L({ id: 2, pairNo: 2, subject: 'МАТ', type: 'зо' }),
  ];
  assert.equal(buildSessionCalendar(lessons, ['811'], []).lessons.length, 2);
});

test('buildSessionCalendar: потоковое занятие несёт обе группы', () => {
  const r = buildSessionCalendar([L({ groups: ['811', '812'] })], ['811', '812'], []);
  assert.deepEqual(r.lessons[0].groups, ['811', '812']);
});

test('buildSessionCalendar: пусто → from/to = null', () => {
  const r = buildSessionCalendar([L({ type: 'Л' })], ['811'], []);
  assert.equal(r.from, null);
  assert.equal(r.to, null);
  assert.equal(r.lessons.length, 0);
});
