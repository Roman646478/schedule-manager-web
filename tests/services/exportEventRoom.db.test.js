'use strict';

// Аудитория, проставленная МЕТКЕ (в первую очередь «ЭкзС» — её ставит
// расстановка СР), должна попадать в распечатку: и в расписание группы,
// и в сводное за неделю. Раньше обе выгрузки писали у мероприятия только метку.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-evroom-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { exportWeeklySchedule } = require('../../src/services/weeklyExportService');
const { exportGroupSchedule } = require('../../src/services/groupExportService');

const SEMESTER = { name: 'осень', start: '2026-08-31', end: '2026-09-19', selected: 1 };
const GROUP = '821-11';
const ROOM = '405-4';

const text = (cell) => {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.richText ? v.richText.map((t) => t.text).join('') : (v.text || v.result || ''));
  return String(v);
};

// Все непустые ячейки листа одной строкой — искать метку удобнее по всему листу,
// чем считать её место в двух разных шаблонах.
function sheetText(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const t = text(cell).trim();
      if (t) out.push(t);
    });
  });
  return out;
}

test.before(() => {
  saveSemester(SEMESTER, getDb());
  getDb().prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run(GROUP, 20);
  // Метка сессии с аудиторией — как её оставляет расстановка СР.
  const res = createLesson({
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ЭкзС', category: 'event',
    groups: [GROUP], rooms: [ROOM],
  });
  assert.equal(res.ok, true, 'метка создана');
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* нет файла — ок */ }
  }
});

test('расписание группы: у метки ЭкзС видна аудитория', async () => {
  const { buffer } = await exportGroupSchedule(GROUP);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const cells = sheetText(wb.worksheets[0]);
  assert.ok(cells.includes('ЭкзС'), 'метка в файле');
  assert.ok(cells.includes(ROOM), `аудитория ${ROOM} в файле`);
});

test('сводное за неделю: метка ЭкзС идёт вместе с аудиторией', async () => {
  const { buffer } = await exportWeeklySchedule(1, null);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const cell = sheetText(wb.worksheets[0]).find((t) => t.includes('ЭкзС'));
  assert.ok(cell, 'метка в файле');
  assert.equal(cell, `ЭкзС\n${ROOM}`, 'метка и аудитория в одной ячейке');
});
