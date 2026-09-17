'use strict';

// Правила подбора аудиторий поверх «по размеру»:
//  1) предложение не должно разносить по аудиториям подряд идущие пары ДРУГОГО
//     преподавателя (правило «одна аудитория» нельзя чинить одному за счёт другого);
//  2) занятие стремится в аудиторию кафедры своего преподавателя — при условии,
//     что группа помещается и лишних мест не больше допуска;
//  3) лабораторные и практические по информатике стремятся в компьютерный класс
//     (примечание аудитории «КК»), а само оснащение подбор не ломает.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-optrules-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { suggestRoomPlan } = require('../../src/services/roomOptimizerService');

const SEMESTER = { name: 'T', start: '2026-09-07', end: '2026-09-12', selected: 1 };
const ids = {};

const touches = (s, id) => s.lessonId === id || s.withLessonId === id || (s.lessonIds || []).includes(id);

test.before(() => {
  const db = getDb();
  saveSemester(SEMESTER, db);
  const room = (name, cap, dept) =>
    db.prepare('INSERT INTO rooms(name, capacity, dept, hidden) VALUES(?,?,?,0)').run(name, cap, dept || null);
  const group = (name, n) => db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, n);

  room('Зал100', 100);
  room('Каб20', 20);
  room('Каф84', 25, '84');
  room('Каф81', 25, '81');
  group('811-11', 10);
  group('811-12', 10);
  group('811-13', 90);
  group('811-14', 25); // ровно по вместимости кафедральных аудиторий: правило «по размеру» тут молчит

  const mk = (over) => {
    const r = createLesson(Object.assign({
      day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', force: true,
    }, over));
    assert.equal(r.ok, true, JSON.stringify(r.reasons || []));
    return r.id;
  };

  // Пн: у «Блочного» пары 1 и 2 идут ПОДРЯД и уже в одной аудитории (Зал100).
  // Рядом, в 1-й паре, большая группа не помещается в Каб20 — обмен напрашивается,
  // но он разорвал бы «Блочного» по двум аудиториям.
  ids.blockP1 = mk({ teacher: 'Блочный Б.Б.', groups: ['811-11'], rooms: ['Зал100'] });
  ids.blockP2 = mk({ pairNo: 2, teacher: 'Блочный Б.Б.', groups: ['811-12'], rooms: ['Зал100'] });
  ids.tightMon = mk({ teacher: 'Тесный Т.Т.', groups: ['811-13'], rooms: ['Каб20'] });

  // Вт: та же расстановка, но у «Одиночного» соседней пары нет — обмен разрешён.
  ids.soloTue = mk({ day: 'Вт', teacher: 'Одиночный О.О.', groups: ['811-11'], rooms: ['Зал100'] });
  ids.tightTue = mk({ day: 'Вт', teacher: 'Тесный Т.Т.', groups: ['811-13'], rooms: ['Каб20'] });

  // Ср: занятие преподавателя кафедры 81 стоит в аудитории кафедры 84,
  // при этом аудитория той же вместимости своей кафедры свободна.
  ids.deptLesson = mk({ day: 'Ср', teacher: 'Кафедральный К.К.', groups: ['811-14'], rooms: ['Каф84'] });
  db.prepare('UPDATE teachers SET dept = ? WHERE name = ?').run('81', 'Кафедральный К.К.');
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('обмен, разрывающий пары другого преподавателя, не предлагается', () => {
  const { suggestions } = suggestRoomPlan(1);
  const bad = suggestions.filter((s) => touches(s, ids.blockP1) || touches(s, ids.blockP2));
  assert.deepEqual(bad, [], 'пары «Блочного» никто не трогает');
  // Обмена в понедельник нет — есть только безобидные ходы в свободные аудитории.
  assert.ok(!suggestions.some((s) => s.action === 'swap' && touches(s, ids.tightMon)), 'обмен в понедельник не предложен');
});

test('тот же обмен предлагается там, где рвать нечего', () => {
  const { suggestions } = suggestRoomPlan(1);
  const swap = suggestions.find((s) => s.action === 'swap' && touches(s, ids.tightTue));
  assert.ok(swap, 'во вторник обмен найден');
  assert.deepEqual(
    [swap.lessonId, swap.withLessonId].sort(),
    [ids.soloTue, ids.tightTue].sort(),
    'меняются местами именно эти два занятия'
  );
});

test('занятие зовут в аудиторию своей кафедры', () => {
  const { suggestions } = suggestRoomPlan(1);
  const dept = suggestions.find((s) => s.kind === 'dept' && s.lessonId === ids.deptLesson);
  assert.ok(dept, 'предложение по кафедре есть');
  assert.equal(dept.toRoom, 'Каф81');
  assert.equal(dept.dept, '81', 'кафедра преподавателя');
  assert.equal(dept.roomDept, '84', 'кафедра нынешней аудитории');
  assert.equal(dept.action, 'move');
});

test('в аудиторию своей кафедры не зовут, если группа туда не помещается', () => {
  const db = getDb();
  db.prepare('UPDATE rooms SET capacity = ? WHERE name = ?').run(15, 'Каф81'); // группа 25 человек
  const { suggestions } = suggestRoomPlan(1);
  assert.ok(!suggestions.some((s) => s.kind === 'dept' && s.lessonId === ids.deptLesson), 'мест не хватает — молчим');
  db.prepare('UPDATE rooms SET capacity = ? WHERE name = ?').run(25, 'Каф81');
});

test('перерасход мест ради кафедры ограничен', () => {
  const db = getDb();
  db.prepare('UPDATE rooms SET capacity = ? WHERE name = ?').run(90, 'Каф81'); // 90 − 25 = 65 лишних мест
  const { suggestions } = suggestRoomPlan(1);
  assert.ok(!suggestions.some((s) => s.kind === 'dept' && s.lessonId === ids.deptLesson), 'слишком большой зал — молчим');
  db.prepare('UPDATE rooms SET capacity = ? WHERE name = ?').run(25, 'Каф81');
});

test('правила подбора прогоняются по отдельности', () => {
  const kinds = (rules) => [...new Set(suggestRoomPlan(1, undefined, rules).suggestions.map((x) => x.kind))].sort();
  assert.deepEqual(kinds(['dept']), ['dept'], 'только кафедра');
  assert.deepEqual(kinds(['capacity']), ['capacity'], 'только вместимость');
  assert.deepEqual(kinds(null), kinds([]), 'пустой список = все правила');
  assert.ok(kinds(null).includes('dept') && kinds(null).includes('capacity'), 'без списка работают все');
});

test('физподготовку, спортзал и казармы подбор не трогает', () => {
  const db = getDb();
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('Сп. зал', 500);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('Каз. 81к', 20);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('811-15', 20);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('811-16', 10);
  // Группа 20 человек в зале на 500 мест — идеальная мишень для правила «по размеру»,
  // но это физподготовка в спортзале: переставлять её некуда.
  const fp = createLesson({
    day: 'Чт', pairNo: 1, weekNo: 1, subject: 'ФП', type: 'ПЗ',
    teacher: 'Спортивный С.С.', groups: ['811-15'], rooms: ['Сп. зал'], force: true,
  });
  assert.equal(fp.ok, true, JSON.stringify(fp.reasons || []));

  // Казарма: 10 человек в помещении на 20 — правило «по размеру» промолчит и тут.
  const kaz = createLesson({
    day: 'Чт', pairNo: 2, weekNo: 1, subject: 'ОВП', type: 'ПЗ',
    teacher: 'Казарменный К.К.', groups: ['811-16'], rooms: ['Каз. 81к'], force: true,
  });
  assert.equal(kaz.ok, true, JSON.stringify(kaz.reasons || []));

  const { suggestions } = suggestRoomPlan(1);
  assert.ok(!suggestions.some((x) => touches(x, fp.id)), 'занятие ФП без предложений');
  assert.ok(!suggestions.some((x) => touches(x, kaz.id)), 'занятие в казарме без предложений');
  const rooms = suggestions.flatMap((x) => [x.room, x.toRoom, ...((x.steps || []).map((st) => st.toRoom))]);
  assert.ok(!rooms.some((r) => /Сп\. зал|Каз\./.test(String(r || ''))), 'спортзал и казарму не предлагают как аудиторию');
});

// ── Правило «лабораторные — в компьютерном классе» ───────────────────────────
const mkCC = (over) => {
  const r = createLesson(Object.assign({
    weekNo: 1, teacher: 'Компьютерный К.К.', groups: ['811-17'], force: true,
  }, over));
  assert.equal(r.ok, true, JSON.stringify(r.reasons || []));
  return r.id;
};

test.before(() => {
  const db = getDb();
  db.prepare('INSERT INTO rooms(name, capacity, note, hidden) VALUES(?,?,?,0)').run('КК-1', 20, 'КК');
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('Каб10', 10);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('811-17', 20);

  // Пт: занятия в обычной аудитории ровно по размеру группы — правило
  // «по размеру» тут молчит, поэтому видно работу только нового правила.
  ids.lab = mkCC({ day: 'Пт', pairNo: 1, subject: 'ЭЛК', type: 'ЛР', rooms: ['Каб20'] });
  ids.infPract = mkCC({ day: 'Пт', pairNo: 2, subject: 'Инф', type: 'ПЗ', rooms: ['Каб20'] });
  ids.infLect = mkCC({ day: 'Пт', pairNo: 3, subject: 'Инф', type: 'Л', rooms: ['Каб20'] });
  // Пт, 4-я пара: маленькая группа в большом зале — правило «по размеру» захочет
  // её переставить, и компьютерный класс окажется самой подходящей целью.
  ids.plain = mkCC({ day: 'Пт', pairNo: 4, subject: 'ТПРН', type: 'ПЗ', groups: ['811-11'], rooms: ['Зал100'] });
  // Ср, 2-я пара: ЛР уже в компьютерном классе, рядом свободна аудитория ровно
  // по размеру группы — «по размеру» захочет увести, оснащение не должно дать.
  ids.labInCC = mkCC({ day: 'Ср', pairNo: 2, subject: 'ЭЛК', type: 'ЛР', groups: ['811-11'], rooms: ['КК-1'] });
});

test('лабораторную и практическое по информатике зовут в компьютерный класс', () => {
  const { suggestions } = suggestRoomPlan(1);
  for (const [id, what] of [[ids.lab, 'ЛР'], [ids.infPract, 'практическое по информатике']]) {
    const s = suggestions.find((x) => x.kind === 'cc' && x.lessonId === id);
    assert.ok(s, `предложение для «${what}» есть`);
    assert.equal(s.toRoom, 'КК-1');
    assert.equal(s.action, 'move');
  }
  assert.ok(!suggestions.some((x) => x.kind === 'cc' && x.lessonId === ids.infLect),
    'лекцию по информатике в компьютерный класс не зовут');
});

test('оснащение компьютерного класса подбор не ломает', () => {
  const { suggestions } = suggestRoomPlan(1);
  const toCC = suggestions.filter((x) => x.lessonId === ids.plain && x.toRoom === 'КК-1');
  assert.deepEqual(toCC, [], 'обычное занятие в компьютерный класс не ставят');
  assert.ok(!suggestions.some((x) => touches(x, ids.labInCC)),
    'лабораторную из компьютерного класса не уводят');
});

test('правило компьютерного класса прогоняется отдельно', () => {
  const kinds = [...new Set(suggestRoomPlan(1, undefined, ['cc']).suggestions.map((x) => x.kind))];
  assert.deepEqual(kinds, ['cc']);
});
