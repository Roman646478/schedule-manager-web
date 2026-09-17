'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseExcelSchedule } = require('../../src/parsers/excelScheduleParser');

async function workbook(rowsPerPair, headerRow = 8) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Расписание');
  ws.getCell(2, 1).value = 'Расписание на весенний семестр';
  ws.getCell(3, 1).value = '2025/2026 учебный год';
  ws.getCell(4, 1).value = 'Учебная группа 823';
  ws.getCell(headerRow, 1).value = 'День   недели';
  ws.getCell(headerRow, 3).value = 'Уч. недели';
  ws.getCell(headerRow, 4).value = 1;
  ws.getCell(headerRow, 5).value = 2;
  ws.getCell(headerRow + 1, 3).value = 'Даты';
  ws.getCell(headerRow + 1, 4).value = new Date('2026-02-09T00:00:00Z');
  const row = headerRow + 2;
  for (let offset = 0; offset < rowsPerPair; offset += 1) {
    ws.getCell(row + offset, 1).value = 'Пн';
    ws.getCell(row + offset, 2).value = '1-2';
    ws.getCell(row + offset, 3).value = '9.00-10.35';
  }
  if (rowsPerPair === 1) ws.getCell(row, 4).value = 'П/Тема 7\nРОРТ\n430-7';
  else ['П/Тема 7', 'РОРТ', '430-7'].forEach((v, i) => { ws.getCell(row + i, 4).value = v; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

for (const [rows, format] of [[1, 'single-cell'], [3, 'three-rows']]) {
  test(`Excel: формат ${format}, шапка может иметь произвольную высоту`, async () => {
    const parsed = await parseExcelSchedule(await workbook(rows, 8), '823.xlsx');
    assert.equal(parsed.owner, '823');
    assert.equal(parsed.gridRow, 8);
    assert.equal(parsed.excelFormat, format);
    assert.equal(parsed.firstDate, '2026-02-09');
    assert.equal(parsed.firstDateVerified, true);
    assert.deepEqual(parsed.lessons[0], {
      fileKind: 'group', owner: '823', day: 'Пн', pairNo: 1, pairLabel: '1-2',
      timeStart: '9.00', timeEnd: '10.35', weekNo: 1, category: 'lesson',
      type: 'ПЗ', topic: 'Т.7', subject: 'РОРТ', groups: ['823'], rooms: ['430-7'],
    });
  });
}

test('Excel без ориентира «День недели» отклоняется с понятной ошибкой', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Лист1').getCell('A1').value = 'не расписание';
  await assert.rejects(
    parseExcelSchedule(Buffer.from(await wb.xlsx.writeBuffer()), 'bad.xlsx'),
    /День недели/
  );
});
