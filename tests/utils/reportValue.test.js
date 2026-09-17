'use strict';

// Столбец «Отчёт.» подвала: дополнение формами контроля из учебного плана.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeReportValue } = require('../../src/utils/constants');

const exam = { expExam: true };
const zach = { expZach: true, expZachGraded: true };
const zachUngraded = { expZach: true, expZachUngraded: true };
const course = { expCourse: true };

test('пустое поле заполняется формой из плана', () => {
  assert.equal(mergeReportValue('', exam), 'Экз');
  assert.equal(mergeReportValue(null, zach), 'ЗО');
  assert.equal(mergeReportValue('', zachUngraded), 'Зч');
  assert.equal(mergeReportValue('', course), 'КР');
});

test('уже указанное не дублируется и не затирается', () => {
  assert.equal(mergeReportValue('ЗО', zach), 'ЗО');
  assert.equal(mergeReportValue('Экз', exam), 'Экз');
  assert.equal(mergeReportValue('ЗО', exam), 'ЗО, Экз', 'к зачёту добавляется экзамен');
});

test('без строки плана поле остаётся как есть', () => {
  assert.equal(mergeReportValue('ЗО', undefined), 'ЗО');
  assert.equal(mergeReportValue('', null), '');
});

test('несколько строк плана на дисциплину (ФП: экзамен и зачёт) дают обе формы', () => {
  // Импорт применяет функцию по каждой совпавшей строке плана подряд.
  let v = null;
  for (const r of [exam, zach]) v = mergeReportValue(v, r);
  assert.equal(v, 'Экз, ЗО');
});
