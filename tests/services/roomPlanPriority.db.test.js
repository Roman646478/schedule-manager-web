'use strict';

// Единое правило подбора аудиторий: правила сравниваются по приоритету
// (порядок задаётся в настройках), и младшее НИКОГДА не применяется ценой
// старшего. Здесь проверяются сам порядок, каждое правило по отдельности и то,
// что настройки этот порядок действительно меняют.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-rpprio-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, setLessonLocked } = require('../../src/services/scheduleService');
const { saveSemester, setRoomPlanSettings } = require('../../src/services/settingsService');
const { suggestRoomPlan } = require('../../src/services/roomOptimizerService');

const SEMESTER = { name: 'T', start: '2026-09-07', end: '2026-09-12', selected: 1 };
const ids = {};

const plan = (rules) => suggestRoomPlan(1, undefined, rules).suggestions;
const touches = (s, id) => s.lessonId === id || s.withLessonId === id || (s.lessonIds || []).includes(id);
const forLesson = (id, rules) => plan(rules).filter((s) => touches(s, id));
// Настройки общие на всю базу — после проверки возвращаем как было.
const withSettings = (patch, fn) => {
  setRoomPlanSettings(patch);
  try {
    return fn();
  } finally {
    setRoomPlanSettings({});
  }
};

test.before(() => {
  const db = getDb();
  saveSemester(SEMESTER, db);
  const room = (name, cap, extra = {}) => db
    .prepare('INSERT INTO rooms(name, capacity, kind, dept, note, hidden) VALUES(?,?,?,?,?,0)')
    .run(name, cap, extra.kind || null, extra.dept || null, extra.note || null);
  const group = (name, n) => db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, n);

  room('Р12', 12);
  room('Р20', 20);
  room('Р22', 22);
  room('Р24', 24);
  room('КК20', 20, { note: 'КК' });
  room('КК30', 30, { note: 'КК' });
  room('Р40', 40);
  room('Р42', 42);
  room('Каф25', 25, { dept: '81' });
  // Отдельный тип аудиторий: «песочница» для правила «одна аудитория у разных
  // групп» — кандидатами будут только они, посторонние аудитории не мешают.
  room('С20', 20, { kind: 'спец' });
  room('С22', 22, { kind: 'спец' });
  group('A1-10', 10);
  group('A1-12', 12);
  group('A1-20', 20);
  group('A1-40', 40);

  const mk = (over) => {
    const r = createLesson(Object.assign({
      weekNo: 1, subject: 'ТПРН', type: 'ПЗ', groups: ['A1-10'], force: true,
    }, over));
    assert.equal(r.ok, true, JSON.stringify(r.reasons || []));
    return r.id;
  };

  // Пн: зачёт и экзамен подряд у одной группы, но в разных аудиториях.
  ids.zo = mk({ day: 'Пн', pairNo: 1, type: 'ЗО', teacher: 'Контрольный К.К.', rooms: ['Р20'] });
  ids.exam = mk({ day: 'Пн', pairNo: 2, type: 'Экз', teacher: 'Контрольный К.К.', rooms: ['Р22'] });

  // Вт: две пары подряд у одного преподавателя УЖЕ в одной аудитории. Рядом
  // свободна аудитория его кафедры — соблазн увести туда одну из пар.
  ids.pairA = mk({ day: 'Вт', pairNo: 1, teacher: 'Кафедральный К.К.', rooms: ['Р20'] });
  ids.pairB = mk({ day: 'Вт', pairNo: 2, teacher: 'Кафедральный К.К.', rooms: ['Р20'] });

  // Ср: аудитория заметно больше группы — обычная работа правила «по размеру».
  ids.locked = mk({ day: 'Ср', pairNo: 1, teacher: 'Замочный З.З.', rooms: ['Р24'] });

  // Чт: одиночная пара того же кафедрального преподавателя — рвать нечего.
  ids.solo = mk({ day: 'Чт', pairNo: 1, teacher: 'Кафедральный К.К.', rooms: ['Р20'] });

  // Чт, 2-я пара: обычное занятие сидит в компьютерном классе — его надо оттуда
  // убрать (то же правило, но в другую сторону).
  ids.inCC = mk({ day: 'Чт', pairNo: 2, teacher: 'Классный К.К.', rooms: ['КК20'] });

  // Пт: пары подряд у одного преподавателя, но у РАЗНЫХ групп; обе аудитории
  // «спец» заняты в соседнем слоте чужими занятиями — свободной нет.
  ids.diffA = mk({ day: 'Пт', pairNo: 1, teacher: 'Разный Р.Р.', rooms: ['С20'] });
  ids.diffB = mk({ day: 'Пт', pairNo: 2, teacher: 'Разный Р.Р.', groups: ['A1-12'], rooms: ['С22'] });
  mk({ day: 'Пт', pairNo: 2, teacher: 'Сосед С.С.', groups: ['A1-20'], rooms: ['С20'] });
  mk({ day: 'Пт', pairNo: 1, teacher: 'Второй В.В.', groups: ['A1-20'], rooms: ['С22'] });

  // Сб: лабораторная уже в компьютерном классе (рядом свободна тесная Р12) и
  // лабораторная в обычной аудитории (компьютерный класс в её слоте свободен).
  ids.labInCC = mk({ day: 'Сб', pairNo: 1, subject: 'ЭЛК', type: 'ЛР', teacher: 'Первый П.П.', rooms: ['КК30'] });
  ids.labOut = mk({ day: 'Сб', pairNo: 2, subject: 'ЭЛК', type: 'ЛР', teacher: 'Второй В.В.', rooms: ['Р20'] });

  ids.tight = mk({ day: 'Сб', pairNo: 4, teacher: 'Тесный Т.Т.', groups: ['A1-40'], rooms: ['Р42'] });
  ids.roomy = mk({ day: 'Сб', pairNo: 3, teacher: 'Просторный П.П.', groups: ['A1-20'], rooms: ['Р40'] });

  db.prepare('UPDATE teachers SET dept = ? WHERE name = ?').run('81', 'Кафедральный К.К.');
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('1) формы контроля подряд собираются в одну аудиторию', () => {
  const s = plan().find((x) => x.kind === 'ctrl');
  assert.ok(s, 'предложение по формам контроля есть');
  assert.deepEqual([...s.lessonIds].sort(), [ids.zo, ids.exam].sort());
  assert.equal(s.action, 'block', 'серия переставляется целиком');
  // Правило одно, поэтому дальше решает следующая по приоритету вместимость:
  // серия собирается в самую тесную подходящую аудиторию, свободную в обоих слотах.
  assert.equal(s.toRoom, 'Р12', 'выбрана аудитория ближе всего к размеру группы');
});

test('2) компьютерный класс освобождают от того, кому он не нужен', () => {
  const s = forLesson(ids.inCC)[0];
  assert.ok(s, 'предложение есть');
  assert.equal(s.kind, 'cc');
  assert.equal(s.ccNeeds, false, 'занятию класс не нужен — это ход ИЗ класса');
  assert.ok(!/КК/.test(s.toRoom), 'цель — обычная аудитория');
  // То же правило в обратную сторону: лабораторную зовут В класс.
  const lab = forLesson(ids.labOut).find((x) => x.kind === 'cc');
  assert.equal(lab.ccNeeds, true);
  assert.equal(lab.toRoom, 'КК20');
});

test('3) кафедра не покупается ценой разрыва пар преподавателя', () => {
  // Пары стоят вместе: увести одну из них на «свою» кафедру нельзя...
  assert.deepEqual(forLesson(ids.pairA), [], 'первую пару не трогают');
  assert.deepEqual(forLesson(ids.pairB), [], 'вторую пару не трогают');
  // ...а одиночную — можно: рвать нечего.
  const s = forLesson(ids.solo)[0];
  assert.ok(s, 'для одиночной пары предложение есть');
  assert.equal(s.kind, 'dept');
  assert.equal(s.toRoom, 'Каф25');
});

test('4) пары у разных групп собираются только в свободную, обменом — нет', () => {
  assert.deepEqual(forLesson(ids.diffA), [], 'обмен ради «одной аудитории» у разных групп не предлагается');
  assert.deepEqual(forLesson(ids.diffB), []);

  const db = getDb();
  db.prepare('INSERT INTO rooms(name, capacity, kind, hidden) VALUES(?,?,?,0)').run('С21', 21, 'спец');
  try {
    const s = forLesson(ids.diffA)[0];
    assert.ok(s, 'появилась свободная — предложение есть');
    assert.equal(s.kind, 'teacherAny');
    assert.equal(s.toRoom, 'С21');
    assert.deepEqual([...s.lessonIds].sort(), [ids.diffA, ids.diffB].sort());
    assert.ok(s.steps.every((st) => st.action === 'move'), 'в плане только переносы, без обменов');
  } finally {
    db.prepare('DELETE FROM rooms WHERE name = ?').run('С21');
  }
});

test('5) вместимость не покупается ценой компьютерного класса', () => {
  assert.deepEqual(forLesson(ids.labInCC), [], 'лабораторную из класса не уводят даже в аудиторию по размеру');
  // Но стоит поднять «вместимость» выше «комп. класса» — и тот же ход разрешён.
  const s = withSettings({
    rules: [{ id: 'capacity', on: true }, { id: 'cc', on: true }],
  }, () => forLesson(ids.labInCC)[0]);
  assert.ok(s, 'после смены приоритета предложение появилось');
  assert.equal(s.kind, 'capacity');
  assert.equal(s.toRoom, 'Р12');
});

test('6) мелкая подгонка мест не предлагается', () => {
  // 40 курсантов в аудитории на 42 места: переставлять их в 40-местную незачем —
  // перестановка есть, выигрыша нет.
  assert.deepEqual(forLesson(ids.tight), [], 'разница в 2 места предложения не даёт');
  // 20 курсантов в аудитории на 40 — разница больше порога, ход имеет смысл.
  const s = forLesson(ids.roomy)[0];
  assert.ok(s, 'заметная разница мест предлагается');
  assert.equal(s.kind, 'capacity');
  assert.equal(s.toRoom, 'Р20');
  // Порог настраивается: с нулевым порогом возвращается и мелкая подгонка.
  const small = withSettings({ minCapacityGain: 0 }, () => forLesson(ids.tight)[0]);
  assert.ok(small, 'с нулевым порогом мелкий ход снова предлагается');
  assert.equal(small.toRoom, 'Р40');
});

test('забронированное занятие подбор не трогает', () => {
  assert.ok(forLesson(ids.locked).length, 'до брони предложение есть');
  setLessonLocked(ids.locked, true);
  try {
    assert.deepEqual(forLesson(ids.locked), [], 'бронь — занятие остаётся на месте');
    // Настройкой это поведение можно выключить.
    const s = withSettings({ skipLocked: false }, () => forLesson(ids.locked));
    assert.ok(s.length, 'с выключенной настройкой предложение снова есть');
  } finally {
    setLessonLocked(ids.locked, false);
  }
});

test('дисциплина-исключение в компьютерный класс не зовётся', () => {
  const cc = () => forLesson(ids.labOut).filter((s) => s.toRoom === 'КК20');
  assert.ok(cc().length, 'по умолчанию лабораторную зовут в класс');
  assert.deepEqual(withSettings({ ccSkipSubjects: ['ЭЛК'] }, cc), [], 'дисциплина в исключениях — не зовут');
});

test('выключенное правило не даёт предложений', () => {
  const kinds = () => [...new Set(plan().map((s) => s.kind))];
  assert.ok(kinds().includes('dept'), 'по умолчанию правило кафедры работает');
  const off = withSettings({ rules: [{ id: 'dept', on: false }] }, kinds);
  assert.ok(!off.includes('dept'), 'выключенное правило молчит');
  assert.ok(off.includes('capacity'), 'остальные продолжают работать');
});

test('разовый прогон одного правила не трогает настройки', () => {
  assert.deepEqual([...new Set(plan(['ctrl']).map((s) => s.kind))], ['ctrl']);
  assert.deepEqual([...new Set(plan(['dept']).map((s) => s.kind))], ['dept']);
  assert.ok(plan().length > plan(['ctrl']).length, 'без списка работают все правила');
});
