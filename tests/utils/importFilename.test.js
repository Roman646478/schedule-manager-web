'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUploadName } = require('../../src/routes/import');

test('кириллическое имя multipart восстанавливается из latin1', () => {
  const expected = 'Копия 1165-1.xlsx';
  const fromMulter = Buffer.from(expected, 'utf8').toString('latin1');
  assert.equal(normalizeUploadName(fromMulter), expected);
});

test('обычное имя файла не меняется', () => {
  assert.equal(normalizeUploadName('schedule-1155.xlsx'), 'schedule-1155.xlsx');
});
