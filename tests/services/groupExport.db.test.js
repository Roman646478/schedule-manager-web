'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-export-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { getDb, closeDb } = require('../../src/config/database');
const { createLesson } = require('../../src/services/scheduleService');
const { saveSemester, setGroupSubjects } = require('../../src/services/settingsService');
const { exportGroupSchedule, exportTeacherSchedule } = require('../../src/services/groupExportService');

const TEMPLATE = path.join(__dirname, '..', '..', 'Расписание группы', 'Образец группа.xlsx');

// Раскладка образца: пара = 3 строки, первая строка каждого дня.
const DAY_FIRST_ROW = { Пн: 7, Вт: 20, Ср: 33, Чт: 46, Пт: 59, Сб: 72 };
const cellRow = (day, pairNo) => DAY_FIRST_ROW[day] + (pairNo - 1) * 3;
const weekCol = (weekNo) => 3 + weekNo;

// Семестр намеренно ДЛИННЕЕ шаблона (в образце 26 столбцов недель): так
// проверяется дописывание столбцов, а не только заполнение готовых.
const SEMESTER = { name: 'осень', start: '2026-08-31', end: '2027-03-15', selected: 1 };
const LONG_WEEK = 28;

let ws;

test.before(async () => {
  const db = getDb();
  saveSemester(SEMESTER, db);
  db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)').run('821-11', 20);
  setGroupSubjects({ '821-11': [
    { abbr: 'ТПРН', fullName: 'Тактика частей ПРН', dept: '84', lecturer: 'м-р Панков Б.Б.', others: 'м-р Панков Б.Б.', hours: '24-48', report: 'ЗО' },
  ] }, db);

  const mk = (over) => createLesson(Object.assign({
    day: 'Пн', pairNo: 1, weekNo: 4, subject: 'ТПРН', type: 'П', topic: 'Т.7',
    teacher: 'Панков Б.Б.', groups: ['821-11'], rooms: ['405-4'],
  }, over));

  mk({});
  mk({ day: 'Сб', pairNo: 3, weekNo: 4, rooms: ['405-4', '406-4'] }); // две аудитории
  mk({ day: 'Вт', pairNo: 2, weekNo: 4, category: 'event', subject: 'УМО', type: null, topic: null, rooms: [] });
  mk({ day: 'Ср', pairNo: 1, weekNo: LONG_WEEK }); // неделя за пределами шаблона

  // Экспорт возвращает содержимое файла (его сохраняет браузер), а не путь.
  const { buffer } = await exportGroupSchedule('821-11', TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  ws = wb.getWorksheet(1);
});

test.after(() => {
  closeDb();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) fs.rmSync(f, { force: true });
});

const txt = (r, c) => {
  const v = ws.getCell(r, c).value;
  if (v && typeof v === 'object') return String(v.text || v.result || '');
  return v == null ? '' : String(v);
};

test('занятие занимает три строки: вид/тема, дисциплина, аудитория', () => {
  const r = cellRow('Пн', 1);
  const c = weekCol(4);
  assert.deepEqual([txt(r, c), txt(r + 1, c), txt(r + 2, c)], ['П/Т.7', 'ТПРН', '405-4']);
});

test('две аудитории пишутся через запятую в третьей строке (Сб, 3-я пара)', () => {
  const r = cellRow('Сб', 3);
  const c = weekCol(4);
  assert.equal(txt(r + 2, c), '405-4, 406-4');
});

test('мероприятие — одна метка в средней строке, без вида и аудитории', () => {
  const r = cellRow('Вт', 2);
  const c = weekCol(4);
  assert.deepEqual([txt(r, c), txt(r + 1, c), txt(r + 2, c)], ['', 'УМО', '']);
});

test('семестр длиннее шаблона: столбцы недель дописываются с оформлением', () => {
  const c = weekCol(LONG_WEEK);
  assert.equal(txt(4, c), String(LONG_WEEK), 'номер недели проставлен в строке 4');
  const r = cellRow('Ср', 1);
  assert.deepEqual([txt(r, c), txt(r + 1, c), txt(r + 2, c)], ['П/Т.7', 'ТПРН', '405-4']);
  // Оформление скопировано с последнего размеченного столбца шаблона (26-й).
  const src = ws.getCell(r, weekCol(26)).style;
  assert.deepEqual(ws.getCell(r, c).border, src.border, 'границы у дописанного столбца те же');
});

test('шапка: группа, месяцы и даты пересчитаны под семестр', () => {
  assert.equal(txt(3, 10), 'Учебная группа 821-11');
  assert.equal(txt(5, 4), 'Август', 'неделя 1 начинается 31.08');
  assert.equal(txt(6, 4), '31', 'дата понедельника недели 1');
  assert.equal(txt(19, 4), '1', 'вторник недели 1 — 1 сентября');
});

test('таблица дисциплин заполняется с 88-й строки, легенда ниже не затирается', () => {
  assert.equal(txt(88, 1), 'ТПРН');
  assert.equal(txt(88, 2), 'Тактика частей ПРН');
  assert.equal(txt(88, 9), '84');
  assert.equal(txt(88, 24), '24-48');
  assert.equal(txt(88, 25), 'ЗО');
  assert.match(txt(105, 1), /Обозначения видов занятий/, 'легенда видов занятий на месте');
  assert.equal(txt(120, 26), 'С.БОРИН', 'подпись на месте');
});

test('расписание преподавателя: свой заголовок, группы в ячейке, таблица дисциплин пуста', async () => {
  const { buffer, filename } = await exportTeacherSchedule('Панков Б.Б.', TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const tws = wb.getWorksheet(1);
  const cell = (r, c) => {
    const v = tws.getCell(r, c).value;
    if (v && typeof v === 'object') return String(v.text || v.result || '');
    return v == null ? '' : String(v);
  };
  assert.equal(filename, 'Панков Б.Б..xlsx');
  assert.equal(cell(3, 10), 'Преподаватель Панков Б.Б.');
  const r = cellRow('Пн', 1);
  assert.deepEqual([cell(r, weekCol(4)), cell(r + 1, weekCol(4))], ['П/Т.7', 'ТПРН (821-11)']);
  assert.equal(cell(88, 1), '', 'таблица дисциплин группы очищена');
  assert.match(cell(105, 1), /Обозначения видов занятий/, 'легенда видов занятий на месте');
});

test('файл преподавателя: второй лист — построчный перечень занятий', async () => {
  const { buffer } = await exportTeacherSchedule('Панков Б.Б.', TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const list = wb.getWorksheet('Занятия');
  assert.ok(list, 'лист «Занятия» есть в том же файле');
  assert.equal(wb.worksheets[1].name, 'Занятия', 'перечень — второй лист файла');

  const val = (r, c) => {
    const v = list.getCell(r, c).value;
    if (v && typeof v === 'object') return String(v.text || v.result || '');
    return v == null ? '' : String(v);
  };
  assert.equal(val(1, 1), '№');
  assert.equal(val(1, 7), 'Дисциплина');
  assert.equal(val(1, 13), 'Примечание');

  // Строк — по числу учебных пар (мероприятие УМО из фикстуры не в счёт).
  assert.equal(list.rowCount - 1, 3, 'три занятия: Пн, Ср и Сб (мероприятие не попало)');
  // Первая строка — самое раннее занятие: неделя 4, Пн, 1-я пара.
  assert.equal(val(2, 2), '4', 'номер недели');
  assert.equal(val(2, 4), 'Пн');
  assert.equal(val(2, 7), 'ТПРН');
  assert.equal(val(2, 8), 'П', 'вид занятия как в занятии');
  assert.equal(val(2, 9), 'Т.7', 'тема');
  assert.equal(val(2, 10), '821-11', 'группа');
  assert.equal(val(2, 11), '405-4', 'аудитория');
  assert.equal(val(2, 12), 'Панков Б.Б.', 'преподаватель');
  // Порядок строк — хронологический: нед. 4 Пн, нед. 4 Сб (две аудитории), нед. 28 Ср.
  assert.equal(val(3, 11), '405-4, 406-4', 'две аудитории через запятую');
  assert.equal(val(4, 2), '28', 'последняя строка — самая поздняя неделя');
});
