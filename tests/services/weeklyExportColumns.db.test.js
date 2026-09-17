'use strict';

// Столбцы-группы в выгрузке сводного подгоняются под фактический список групп:
// лишние столбцы шаблона удаляются, недостающие дописываются.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-weekcols-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester, setCourses } = require('../../src/services/settingsService');
const { exportWeeklySchedule } = require('../../src/services/weeklyExportService');

const SEMESTER = { name: 'осень', start: '2026-08-31', end: '2026-09-19', selected: 1 };
const GROUP_ROW = 3;
const PN_FIRST_PAIR = 5; // строка первой пары понедельника в шаблоне

// Имена групп строки 3: значение бывает richText (в шаблоне имя подкрашено).
function headerGroups(ws) {
  const out = [];
  for (let c = 1; c <= Math.max(ws.columnCount, 60); c++) {
    const v = ws.getCell(GROUP_ROW, c).value;
    const name = v == null ? '' : String(v.richText ? v.richText.map((t) => t.text).join('') : v).trim();
    if (name) out.push({ col: c, name });
  }
  return out;
}

async function exportSheet(groups) {
  const { buffer } = await exportWeeklySchedule(1, groups);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.getWorksheet(1);
}

const addGroup = (name) => getDb().prepare('INSERT OR IGNORE INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(name, 20);

test.before(() => {
  saveSemester(SEMESTER, getDb());
  setCourses({ 82: 8, ZZ: 9 }, getDb());
  for (const g of ['821-11', '821-12', '822-11']) addGroup(g);
  createLesson({
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ',
    teacher: 'Панков Б.Б.', groups: ['821-11'], rooms: ['405-4'],
  });
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* нет файла — ок */ }
  }
});

test('групп меньше, чем столбцов шаблона — лишние столбцы удалены', async () => {
  const ws = await exportSheet(null);
  const cols = headerGroups(ws);
  assert.deepEqual(cols.map((c) => c.name), ['821-11', '821-12', '822-11'], 'в шапке только группы базы');
  const last = cols[cols.length - 1].col;
  // За последней группой — пустой столбец: ни значения, ни рамок, ширина
  // сброшена к умолчанию листа (уже не столбец расписания).
  assert.equal(ws.getCell(GROUP_ROW, last + 1).value, null);
  assert.equal(ws.getCell(PN_FIRST_PAIR, last + 1).value, null);
  const border = ws.getCell(PN_FIRST_PAIR, last + 1).border || {};
  assert.deepEqual(Object.keys(border), [], 'рамки шаблона с удалённого столбца сняты');
  assert.ok(ws.getColumn(last + 1).width < ws.getColumn(last).width, 'ширина столбца сброшена');
  // Занятие встало в свой (новый) столбец.
  assert.match(String(ws.getCell(PN_FIRST_PAIR, cols[0].col).value || ''), /ТПРН/);
  // Строка дня «схлопнулась» до нового края: объединение не тянется в пустоту.
  const merge = (ws.model.merges || []).find((m) => m.startsWith('D4:'));
  assert.ok(merge, 'объединение строки дня на месте');
  assert.equal(merge, `D4:${ws.getColumn(last).letter}4`);
});

test('групп больше, чем столбцов шаблона — столбцы добавлены', async () => {
  const base = headerGroups(await exportSheet(null)).length; // 3
  const extra = [];
  for (let i = 1; i <= base + 30; i++) extra.push(`ZZ-${String(i).padStart(2, '0')}`);
  for (const g of extra) addGroup(g);

  const ws = await exportSheet(null);
  const cols = headerGroups(ws);
  assert.equal(cols.length, base + extra.length, 'столбец на каждую группу базы');
  const last = cols[cols.length - 1];
  // Дописанный столбец получил ширину и оформление шаблона.
  assert.ok(ws.getColumn(last.col).width > 0, 'ширина у дописанного столбца');
  assert.ok(ws.getCell(PN_FIRST_PAIR, last.col).border, 'оформление у дописанного столбца');
  // Ячейка выбора дисциплины уехала правее сетки, а не осталась внутри неё.
  const pick = [...Array(80).keys()]
    .map((i) => i + 1)
    .find((c) => ws.getCell(1, c).dataValidation);
  assert.ok(pick > last.col, 'выбор дисциплины правее последнего столбца групп');
});

test('передан список групп — в файле только они', async () => {
  const ws = await exportSheet(['822-11', '821-11', 'нет-такой']);
  assert.deepEqual(headerGroups(ws).map((c) => c.name), ['821-11', '822-11'], 'по курсам, без чужих имён');
});
