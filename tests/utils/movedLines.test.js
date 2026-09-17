'use strict';

// Текст пометки «перенесено» — общий для админки и гостевой карточки
// (shared-constants.js), сами пометки считает сервер (getMoveMarks).

const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../../public/js/shared-constants.js');

test('нет пометки — нет строк', () => {
  assert.deepEqual(SC.movedLines(null), []);
});

test('перенос и отдельная смена аудитории — две строки, число изменений при цепочке', () => {
  const lines = SC.movedLines({
    steps: 3,
    lastMove: { fromDay: 'Пн', fromDate: '01.09', fromPair: 1, fromWeek: 1, fromRoom: 'А-1', room: 'А-1' },
    lastRoom: { fromRoom: 'А-1', room: 'А-2' },
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^↪ Перенесено с: Пн 01\.09, часы .+, неделя 1 \(изменений: 3\)$/);
  assert.equal(lines[1], '↪ Аудитория: А-1 → А-2');
});

test('один шаг без счётчика; смена аудитории внутри старой записи переноса', () => {
  const lines = SC.movedLines({
    steps: 1,
    lastMove: { fromDay: 'Вт', fromDate: null, fromPair: 2, fromWeek: 3, fromRoom: 'А-1', room: null },
    lastRoom: null,
  });
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[0], /изменений/);
  assert.equal(lines[1], '↪ Аудитория: А-1 → буфер');
});

test('только смена аудитории — одна строка', () => {
  assert.deepEqual(SC.movedLines({ steps: 1, lastMove: null, lastRoom: { fromRoom: null, room: 'Б-1' } }), ['↪ Аудитория: — → Б-1']);
});

test('ключ ячейки не зависит от порядка групп и типа номеров', () => {
  assert.equal(SC.movedKey('Пн', '1', 2, 'РТС', ['б', 'а']), SC.movedKey('Пн', 1, '2', 'РТС', ['а', 'б']));
  assert.equal(SC.movedKey('Пн', 1, 2, null, null), 'Пн|1|2||');
});
