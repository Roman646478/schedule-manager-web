'use strict';

// Порядок аудиторий в списках выбора (SC.roomFitCmp): сверху те, где посадочных
// мест ближе всего к числу курсантов, не вмещающие — внизу.

const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../../public/js/shared-constants.js');

const R = (name, capacity) => ({ name, capacity });
const order = (rooms, need) => rooms.slice().sort(SC.roomFitCmp(need)).map((r) => r.name);

test('сверху — вместимость ближе всего к числу курсантов', () => {
  const rooms = [R('зал', 200), R('в самый раз', 26), R('с запасом', 40), R('тесная', 20)];
  assert.deepEqual(order(rooms, 25), ['в самый раз', 'с запасом', 'зал', 'тесная']);
});

test('не вмещающие всегда ниже вмещающих, между собой — по величине нехватки', () => {
  const rooms = [R('мало на 15', 10), R('мало на 1', 24), R('впритык', 25)];
  assert.deepEqual(order(rooms, 25), ['впритык', 'мало на 1', 'мало на 15']);
});

test('неизвестная вместимость — после вмещающих, но выше тесных', () => {
  const rooms = [R('тесная', 5), R('без данных', null), R('подходит', 30)];
  assert.deepEqual(order(rooms, 25), ['подходит', 'без данных', 'тесная']);
});

test('численность неизвестна — порядок по имени', () => {
  const rooms = [R('б', 10), R('а', 300)];
  assert.deepEqual(order(rooms, null), ['а', 'б']);
  assert.deepEqual(order(rooms, 0), ['а', 'б']);
});
