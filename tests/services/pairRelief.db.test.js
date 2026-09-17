'use strict';

// Разгрузка 4-й пары у группы: занятия с 7–8 часов уезжают в свободные окна пар
// 1–3 (пн–пт, ±2 недели от самого занятия). Если у группы окно есть, а
// преподаватель занят другой группой, сначала уезжает её пара — цепочка из двух
// шагов применяется целиком.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-pair4-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson, getMoveLog, setLessonLocked } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { loadLessons } = require('../../src/services/conflictService');
const { performUndo } = require('../../src/services/undoService');
const { suggestPair4Relief, applyPair4Relief } = require('../../src/services/pairReliefService');

// 4 недели пн–сб: хватает и на «±2 недели», и на выход за границу.
const SEMESTER = { name: 'T', start: '2026-09-07', end: '2026-10-03', selected: 1 };
const ids = {};

const lessonById = (id) => loadLessons().find((l) => l.id === id);
const itemFor = (res, id) => (res.items || []).find((x) => x.lessonId === id);

const mk = (over) => {
  const r = createLesson(Object.assign({
    subject: 'ТПРН', type: 'ПЗ', teacher: 'Основной О.О.', groups: ['811-11'], rooms: ['Каб20'], force: true,
  }, over));
  assert.equal(r.ok, true, JSON.stringify(r.reasons || []));
  return r.id;
};

test.before(() => {
  const db = getDb();
  saveSemester(SEMESTER, db);
  const room = (name, cap) => db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run(name, cap);
  const group = (name, n) => db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, n);
  room('Каб20', 20);
  room('Каб30', 30);
  group('811-11', 20);
  group('811-12', 20);

  // Неделя 2: единственное занятие группы — на 4-й паре. Окон вокруг предостаточно.
  ids.simple = mk({ day: 'Ср', pairNo: 4, weekNo: 2, subject: 'МА' });

  // Неделя 1, суббота: субботу не трогаем ни как источник, ни как цель.
  ids.saturday = mk({ day: 'Сб', pairNo: 4, weekNo: 1, subject: 'СБТ' });
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('занятие с 4-й пары зовут в свободное окно пар 1–3', () => {
  const res = suggestPair4Relief('811-11');
  assert.equal(res.ok, true);
  const s = itemFor(res, ids.simple);
  assert.ok(s, 'предложение для занятия с 4-й пары есть');
  assert.equal(s.pairNo, 4, 'источник — 4-я пара');
  assert.ok([1, 2, 3].includes(s.toPair), `цель — пара 1–3, а не ${s.toPair}`);
  assert.equal(s.toRoom, 'Каб20', 'аудитория сохраняется');
  // Все варианты — в пределах ±2 недель, пн–пт, пары 1–3.
  for (const o of s.options) {
    assert.ok([1, 2, 3].includes(o.toPair), `вариант на паре ${o.toPair}`);
    assert.ok(['Пн', 'Вт', 'Ср', 'Чт', 'Пт'].includes(o.toDay), `вариант в день ${o.toDay}`);
    assert.ok(Math.abs(o.toWeek - s.weekNo) <= 2, `вариант на неделе ${o.toWeek}`);
  }
});

test('субботу не трогаем', () => {
  const res = suggestPair4Relief('811-11');
  assert.ok(!itemFor(res, ids.saturday), 'занятие субботней 4-й пары в предложения не попадает');
  assert.ok(!(res.items || []).some((x) => x.options.some((o) => o.toDay === 'Сб')), 'в субботу ничего не зовут');
});

test('мероприятие, бронь, СР, ФП и формы контроля с 4-й пары не двигаем', () => {
  const cases = {
    event: mk({ day: 'Пн', pairNo: 4, weekNo: 3, subject: 'Отп', category: 'event', teacher: null, rooms: [] }),
    sr: mk({ day: 'Вт', pairNo: 4, weekNo: 3, subject: 'СР', type: 'СР' }),
    fp: mk({ day: 'Ср', pairNo: 4, weekNo: 3, subject: 'ФП' }),
    zachet: mk({ day: 'Чт', pairNo: 4, weekNo: 3, subject: 'МА', type: 'ЗО' }),
    kr: mk({ day: 'Пт', pairNo: 4, weekNo: 3, subject: 'МА', type: 'КР' }),
    locked: mk({ day: 'Пн', pairNo: 4, weekNo: 4, subject: 'ЭЛК' }),
  };
  setLessonLocked(cases.locked, true);

  const res = suggestPair4Relief('811-11');
  for (const [what, id] of Object.entries(cases)) {
    assert.ok(!itemFor(res, id), `${what} не предлагается к переносу`);
  }
});

test('препод занят другой группой — предложение из двух шагов', () => {
  const db = getDb();
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('811-13', 20);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('811-14', 20);
  db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)').run('Каб40', 40);

  // У 811-13 занято ВСЁ в парах 1–3 всех четырёх недель, кроме Ср-2 второй
  // недели: прямого окна нет ни одного. Заполнители без аудитории — чтобы не
  // отнимать аудитории у самой проверки.
  for (let w = 1; w <= 4; w++) {
    for (const d of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт']) {
      for (const p of [1, 2, 3]) {
        if (w === 2 && d === 'Ср' && p === 2) continue;
        mk({ day: d, pairNo: p, weekNo: w, subject: 'ЗАП', groups: ['811-13'], teacher: 'Заполнитель З.З.', rooms: [] });
      }
    }
  }
  // В единственном окне 811-13 преподаватель занят парой ДРУГОЙ группы.
  ids.blocker = mk({ day: 'Ср', pairNo: 2, weekNo: 2, subject: 'ИНФ', groups: ['811-14'], teacher: 'Цепной Ц.Ц.', rooms: ['Каб40'] });
  ids.chained = mk({ day: 'Пн', pairNo: 4, weekNo: 2, subject: 'РТС', groups: ['811-13'], teacher: 'Цепной Ц.Ц.', rooms: ['Каб40'] });

  const res = suggestPair4Relief('811-13');
  const s = itemFor(res, ids.chained);
  assert.ok(s, 'предложение для занятия, которому мешает преподаватель, есть');
  assert.ok(s.chain, 'это цепочка из двух шагов');
  assert.equal(s.chain.lessonId, ids.blocker, 'двигаем именно мешающую пару');
  assert.equal(s.toDay, 'Ср');
  assert.equal(s.toPair, 2);
  assert.equal(s.toWeek, 2);
  // Чужая пара тоже едет в пары 1–3 пн–пт, а не на чью-то 4-ю.
  assert.ok([1, 2, 3].includes(s.chain.toPair), `чужая пара на паре ${s.chain.toPair}`);
  assert.ok(['Пн', 'Вт', 'Ср', 'Чт', 'Пт'].includes(s.chain.toDay));
  assert.ok(Math.abs(s.chain.toWeek - s.chain.weekNo) <= 2);
  // И не на тот же слот — иначе преподаватель остался бы занят.
  assert.ok(!(s.chain.toDay === s.toDay && s.chain.toPair === s.toPair && s.chain.toWeek === s.toWeek));
});

test('два предложения не претендуют на одно окно', () => {
  const res = suggestPair4Relief('811-11');
  const taken = new Set();
  for (const s of res.items) {
    const k = `${s.toDay}|${s.toPair}|${s.toWeek}`;
    assert.ok(!taken.has(k), `окно ${k} предложено дважды`);
    taken.add(k);
  }
});

test('применение: цепочка выполняется целиком, откат возвращает всё', () => {
  const res = suggestPair4Relief('811-13');
  const s = itemFor(res, ids.chained);
  assert.ok(s && s.chain, 'цепочка на месте');
  const item = { ...s, ...s.options[0] };

  const r = applyPair4Relief([item]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 2, 'применены оба шага');

  const moved = lessonById(ids.chained);
  const blocker = lessonById(ids.blocker);
  assert.equal(moved.pairNo, item.toPair, 'занятие уехало с 4-й пары');
  assert.equal(moved.day, item.toDay);
  assert.equal(moved.weekNo, item.toWeek);
  assert.equal(blocker.pairNo, item.chain.toPair, 'чужая пара тоже переехала');
  // Перенос виден в журнале.
  const log = getMoveLog().filter((e) => e.action === 'move' && (e.subject === 'РТС' || e.subject === 'ИНФ'));
  assert.equal(log.length, 2, 'обе пары попали в журнал переносов');

  // Откат — одной кнопкой: возвращаются оба занятия и журнал.
  assert.equal(performUndo().ok, true);
  assert.equal(lessonById(ids.chained).pairNo, 4, 'занятие вернулось на 4-ю пару');
  assert.equal(lessonById(ids.blocker).pairNo, 2, 'чужая пара вернулась на место');
  assert.equal(getMoveLog().filter((e) => e.action === 'move' && (e.subject === 'РТС' || e.subject === 'ИНФ')).length, 0,
    'журнал переносов тоже откатился');
});

test('устаревшее предложение пропускается, а не создаёт накладку', () => {
  const res = suggestPair4Relief('811-11');
  const s = itemFor(res, ids.simple);
  assert.ok(s, 'предложение есть');
  // Занятие «успели переставить» — предложение говорит про 4-ю пару, а его там нет.
  const stale = { ...s, ...s.options[0], day: 'Пт', pairNo: 4, weekNo: 2 };
  const r = applyPair4Relief([stale]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 0, 'ничего не применено');
  assert.equal(r.skipped, 1, 'предложение пропущено');
  assert.equal(lessonById(ids.simple).pairNo, 4, 'занятие осталось на месте');
});
