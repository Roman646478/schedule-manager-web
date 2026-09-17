'use strict';

// Две новые выгрузки: сводное за весь семестр (неделя = лист) и расписание одной
// дисциплины по выбранным группам.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-newexp-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { exportSemesterSummary } = require('../../src/services/weeklyExportService');
const { exportSubjectSchedule, subjectGroups } = require('../../src/services/groupExportService');

const GROUP_TEMPLATE = path.join(__dirname, '..', '..', 'Расписание группы', 'Образец группа.xlsx');

// Семестр из трёх недель — файл сводного получится на три листа.
const SEMESTER = { name: 'осень', start: '2026-08-31', end: '2026-09-19', selected: 1 };

// Раскладка шаблона недельного расписания: строка заголовка дня + номер пары.
const DAY_HEADER_ROW = { Пн: 4, Вт: 9, Ср: 14 };
const DAY_HEADER_ROW_FRI = 24; // строка заголовка Пт в шаблоне сводного
// Раскладка шаблона группы: пара = 3 строки.
const DAY_FIRST_ROW = { Пн: 7, Вт: 20, Ср: 33 };
const cellRow = (day, pairNo) => DAY_FIRST_ROW[day] + (pairNo - 1) * 3;
const weekCol = (weekNo) => 3 + weekNo;

test.before(() => {
  const db = getDb();
  saveSemester(SEMESTER, db);
  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  // Имена групп должны совпадать со столбцами шаблона «Еженедельное расписание».
  g.run('821-11', 20);
  g.run('821-12', 20);
  g.run('822-11', 20);

  const mk = (over) => createLesson(Object.assign({
    day: 'Пн', pairNo: 1, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', topic: 'Т.1',
    teacher: 'Панков Б.Б.', groups: ['821-11'], rooms: ['405-4'],
  }, over));

  mk({ weekNo: 1 });
  mk({ weekNo: 2, day: 'Вт', pairNo: 2 });
  // Другой преподаватель: тот же слот у того же занят — это запрет.
  mk({ weekNo: 2, day: 'Вт', pairNo: 2, groups: ['821-12'], rooms: ['406-4'], teacher: 'Сидоров С.С.' });
  mk({ weekNo: 3, day: 'Ср', subject: 'ОГП', type: 'Л', groups: ['822-11'], rooms: ['407-4'] });
  // ПОТОКОВОЕ занятие: одна пара сразу двум группам (проверяем, что в выгрузке по
  // одной группе чужая группа потока в ячейку не попадает).
  mk({ weekNo: 3, day: 'Пн', pairNo: 2, groups: ['821-11', '821-12'], rooms: ['408-4'], topic: 'Т.5' });
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* нет файла — ок */ }
  }
});

test('сводное за семестр: по листу на каждую неделю, занятия на своих местах', async () => {
  const { buffer, filename, weeks } = await exportSemesterSummary();
  assert.equal(weeks, 3, 'три недели семестра — три листа');
  assert.match(filename, /Сводное расписание/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Неделя 1', 'Неделя 2', 'Неделя 3']);

  const text = (ws, r, c) => {
    const v = ws.getCell(r, c).value;
    if (v && typeof v === 'object') return String(v.text || v.result || '');
    return v == null ? '' : String(v);
  };
  // Столбец группы ищем по строке 3 шаблона — по ВСЕЙ ширине: в шаблоне группы
  // добавляют и убирают, жёсткие границы столбцов тут врут так же, как врали в
  // самой выгрузке (см. тест про крайние столбцы ниже).
  const colOf = (ws, group) => {
    for (let c = 1; c <= 40; c++) if (text(ws, 3, c).trim() === group) return c;
    return 0;
  };
  const w1 = wb.getWorksheet('Неделя 1');
  const c1 = colOf(w1, '821-11');
  assert.ok(c1, 'столбец группы 821-11 есть в шаблоне');
  assert.match(text(w1, DAY_HEADER_ROW['Пн'] + 1, c1), /ТПРН/, 'занятие первой недели на своём листе');

  // Неделя 2 — занятие в другой день/пару и у двух групп.
  const w2 = wb.getWorksheet('Неделя 2');
  assert.match(text(w2, DAY_HEADER_ROW['Вт'] + 2, colOf(w2, '821-11')), /ТПРН/);
  assert.match(text(w2, DAY_HEADER_ROW['Вт'] + 2, colOf(w2, '821-12')), /ТПРН/);
  // На листе первой недели этой пары быть не должно — недели не смешались.
  assert.equal(text(w1, DAY_HEADER_ROW['Вт'] + 2, colOf(w1, '821-12')), '');

  // Оформление шаблона доехало до копий: у листа есть объединения и ширины.
  assert.ok((w2.model.merges || []).length > 0, 'объединения шаблона скопированы');
  assert.ok(w2.getColumn(c1).width > 0, 'ширина столбца скопирована');
});

// Регрессия: столбцы групп берутся ИЗ ШАБЛОНА, а не из зашитых границ. Раньше
// диапазон был жёстким (E..AD), и стоило добавить группу с краю — её занятия
// молча не попадали в файл. Берём КРАЙНИЕ столбцы реального шаблона.
test('сводное: занятия попадают и в первый, и в последний столбец шаблона', async () => {
  const wbT = new ExcelJS.Workbook();
  await wbT.xlsx.readFile(path.join(__dirname, '..', '..', 'Еженедельное расписание', 'Образец.xlsx'));
  const wsT = wbT.getWorksheet(1);
  const cols = [];
  for (let c = 1; c <= Math.max(wsT.columnCount, 40); c++) {
    const v = wsT.getCell(3, c).value;
    const name = v == null ? '' : String(v.richText ? v.richText.map((t) => t.text).join('') : v).trim();
    if (name) cols.push({ col: c, name });
  }
  assert.ok(cols.length >= 2, 'в шаблоне есть столбцы групп');
  const edges = [cols[0], cols[cols.length - 1]];

  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  edges.forEach((e, i) => {
    ins.run(e.name, 20);
    assert.equal(
      createLesson({
        day: 'Пт', pairNo: i + 1, weekNo: 1, subject: 'КРАЙ', type: 'ПЗ',
        teacher: `Крайнев ${i}`, groups: [e.name], rooms: [`90${i}-9`],
      }).ok,
      true,
      `занятие для группы ${e.name}`
    );
  });

  const { buffer } = await exportSemesterSummary();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Неделя 1');
  const text = (r, c) => {
    const v = ws.getCell(r, c).value;
    if (v && typeof v === 'object') return String(v.text || v.result || '');
    return v == null ? '' : String(v);
  };
  edges.forEach((e, i) => {
    // Столбец ищем по имени в выгрузке: шаблон могли переверстать.
    let col = 0;
    for (let c = 1; c <= 40; c++) if (text(3, c).trim() === e.name) col = c;
    assert.ok(col, `столбец группы ${e.name} есть в выгрузке`);
    assert.match(text(DAY_HEADER_ROW_FRI + i + 1, col), /КРАЙ/, `занятие крайней группы ${e.name} попало в файл`);
  });
});

test('сводное: в AI1 выпадающий список дисциплин и подсветка выбранной', async () => {
  const { buffer } = await exportSemesterSummary();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Неделя 1');

  const dv = ws.getCell('AI1').dataValidation;
  assert.ok(dv && dv.type === 'list', 'на AI1 стоит выпадающий список');
  const m = /\$([A-Z]+)\$1:\$[A-Z]+\$(\d+)/.exec(dv.formulae[0]);
  assert.ok(m, `ссылка на диапазон со списком: ${dv.formulae[0]}`);

  const col = ws.getColumn(m[1]);
  assert.equal(col.hidden, true, 'служебная колонка со списком скрыта');
  const names = [];
  for (let r = 1; r <= Number(m[2]); r++) names.push(String(ws.getCell(r, col.number).value || ''));
  assert.ok(names.includes('ТПРН'), 'дисциплины расписания попали в список');
  assert.ok(!names.includes('Отп'), 'мероприятия — не дисциплины');

  const rules = (ws.conditionalFormattings || []).flatMap((c) => c.rules);
  const mine = rules.find((r) => r.type === 'expression' && /\$AI\$1/.test((r.formulae || [])[0] || ''));
  assert.ok(mine, 'правило подсветки по AI1 есть');
  assert.match(mine.formulae[0], /\$AI\$1/, 'ссылка на ячейку выбора абсолютная');

  // Пустые правила (их даёт exceljs на расширенном форматировании шаблона)
  // Excel считает повреждением файла и выбрасывает ВСЁ форматирование.
  for (const r of rules) {
    assert.ok(r.type && (r.formulae || []).length, `правило без типа/формулы: ${JSON.stringify(r)}`);
  }
});

test('расписание дисциплины: только выбранные группы, в ячейке группы вместо дисциплины', async () => {
  assert.deepEqual(subjectGroups('ТПРН'), ['821-11', '821-12'], 'группы дисциплины найдены по занятиям');

  const { buffer, filename, groups } = await exportSubjectSchedule('ТПРН', ['821-11'], GROUP_TEMPLATE);
  assert.equal(filename, 'ТПРН.xlsx');
  assert.deepEqual(groups, ['821-11'], 'вторая группа не выбрана — её в файле нет');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(1);
  const val = (a) => {
    const v = ws.getCell(a).value;
    return v && typeof v === 'object' ? String(v.text || v.result || '') : (v == null ? '' : String(v));
  };
  assert.equal(val('J3'), 'Дисциплина ТПРН');
  assert.equal(val('J2'), 'Группы: 821-11');

  const cell = (r, c) => {
    const v = ws.getCell(r, c).value;
    return v == null ? '' : String(v);
  };
  const r = cellRow('Пн', 1);
  assert.deepEqual(
    [cell(r, weekCol(1)), cell(r + 1, weekCol(1)), cell(r + 2, weekCol(1))],
    ['ПЗ/Т.1', '821-11', '405-4'],
    'три строки ячейки: вид/тема, группы, аудитория');

  // В том же слоте (нед. 2, Вт, 2-я пара) есть пара невыбранной группы 821-12 —
  // в ячейке должна остаться только выбранная.
  const r2 = cellRow('Вт', 2);
  assert.equal(cell(r2 + 1, weekCol(2)), '821-11', 'невыбранная группа в ячейку не попала');
});

test('расписание дисциплины: у потокового занятия в ячейке остаются только выбранные группы', async () => {
  const { buffer } = await exportSubjectSchedule('ТПРН', ['821-11'], GROUP_TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(1);
  const cell = (r, c) => {
    const v = ws.getCell(r, c).value;
    return v == null ? '' : String(v);
  };
  // Пн, 2-я пара, неделя 3 — потоковая пара групп 821-11 и 821-12.
  const r = cellRow('Пн', 2);
  assert.equal(cell(r, weekCol(3)), 'ПЗ/Т.5', 'вид и тема на месте');
  assert.equal(cell(r + 1, weekCol(3)), '821-11', 'вторая группа потока отсечена');
  assert.equal(cell(r + 2, weekCol(3)), '408-4', 'аудитория осталась');

  // Без выбора групп поток показывается целиком — это отдельный режим выгрузки.
  const full = await exportSubjectSchedule('ТПРН', [], GROUP_TEMPLATE);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(full.buffer);
  const ws2 = wb2.getWorksheet(1);
  const v = ws2.getCell(r + 1, weekCol(3)).value;
  assert.equal(String(v == null ? '' : v), '821-11, 821-12', 'без выбора — обе группы потока');
});

test('дисциплина без занятий у выбранных групп — понятная ошибка', async () => {
  await assert.rejects(
    () => exportSubjectSchedule('ТПРН', ['822-11'], GROUP_TEMPLATE),
    /не найдено/i
  );
});
