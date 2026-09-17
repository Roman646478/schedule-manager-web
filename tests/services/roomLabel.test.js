'use strict';

// Подпись аудитории в меню и выпадающих списках (SC.roomLabel): состав, порядок
// и склонение «мест». В сетке расписания аудитория показывается голым номером —
// эта подпись только для списков.

const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../../public/js/shared-constants.js');

test('состав подписи: кафедра, примечание, места — в этом порядке', () => {
  assert.equal(
    SC.roomLabel({ name: '418-4', dept: '81', note: 'комп. класс', capacity: 30 }),
    '418-4 (каф. 81, комп. класс, 30 мест)'
  );
});

test('пустые поля пропускаются, а без данных остаётся голое имя', () => {
  assert.equal(SC.roomLabel({ name: '453-4', dept: '84', capacity: 60 }), '453-4 (каф. 84, 60 мест)');
  assert.equal(SC.roomLabel({ name: '10-33', capacity: 25 }), '10-33 (25 мест)');
  assert.equal(SC.roomLabel({ name: '109-1' }), '109-1');
});

test('пометки списка идут последними', () => {
  assert.equal(
    SC.roomLabel({ name: '418-4', capacity: 20 }, ['мало', 'занята: 841-11']),
    '418-4 (20 мест, мало, занята: 841-11)'
  );
});

test('склонение «мест» — по последней цифре, с исключением 11–14', () => {
  const cap = (n) => SC.roomLabel({ name: 'A', capacity: n }).match(/\((.+)\)/)[1];
  assert.equal(cap(1), '1 место');
  assert.equal(cap(21), '21 место');
  assert.equal(cap(101), '101 место');
  assert.equal(cap(2), '2 места');
  assert.equal(cap(22), '22 места');
  assert.equal(cap(5), '5 мест');
  assert.equal(cap(11), '11 мест'); // не «11 место»
  assert.equal(cap(12), '12 мест'); // не «12 места»
  assert.equal(cap(114), '114 мест');
  assert.equal(cap(0), '0 мест');
});
