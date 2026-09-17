'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { weekNoOn } = require('../../public/js/shared-constants.js');

// 31.08.2026 — понедельник: неделя 1 это 31.08–06.09.
test('weekNoOn: старт в понедельник — неделя по календарной семёрке', () => {
  assert.equal(weekNoOn('2026-08-31', '2026-08-31'), 1);
  assert.equal(weekNoOn('2026-08-31', '2026-09-06'), 1);
  assert.equal(weekNoOn('2026-08-31', '2026-09-07'), 2);
  assert.equal(weekNoOn('2026-08-31', '2026-10-05'), 6);
});

// Старт в середине недели (01.09.2026 — вторник): неделя 1 всё равно
// начинается с понедельника 31.08 — так же строит даты сетка гостевого вида.
test('weekNoOn: старт не в понедельник — отсчёт от понедельника его недели', () => {
  assert.equal(weekNoOn('2026-09-01', '2026-08-31'), 1);
  assert.equal(weekNoOn('2026-09-01', '2026-09-06'), 1);
  assert.equal(weekNoOn('2026-09-01', '2026-09-07'), 2);
});

// Виджет открывается с week=cur когда угодно, в том числе на каникулах:
// номер зажимается в 1..maxWeek, «текущей недели» без ответа не бывает.
test('weekNoOn: вне семестра номер зажимается в 1..maxWeek', () => {
  assert.equal(weekNoOn('2026-08-31', '2026-07-01'), 1);
  assert.equal(weekNoOn('2026-08-31', '2027-09-01'), 26);
  assert.equal(weekNoOn('2026-08-31', '2027-09-01', 18), 18);
});

test('weekNoOn: нет даты старта или мусор — null', () => {
  assert.equal(weekNoOn('', '2026-09-01'), null);
  assert.equal(weekNoOn(null, '2026-09-01'), null);
  assert.equal(weekNoOn('не дата', '2026-09-01'), null);
});

// Date вместо строки: виджет зовёт weekNoOn(start, new Date()) — берётся
// локальная календарная дата, а не UTC-полночь (иначе поздним вечером в
// плюсовом поясе неделя перескакивала бы на следующую).
test('weekNoOn: принимает Date по локальной дате', () => {
  assert.equal(weekNoOn('2026-08-31', new Date(2026, 8, 7, 23, 30)), 2);
});
