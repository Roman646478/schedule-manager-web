'use strict';

// Разбор реального учебного плана (xlsx). Парсер и SheetJS — те же файлы, что
// грузит страница (public/), поэтому тест покрывает и браузерный разбор.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const XLSX = require('../public/vendor/xlsx.full.min.js');
const { parseCurriculum } = require('../public/js/curriculum-parser.js');

// Файл переименовывался («81 кафедра.xlsx» → «81.xlsx») — берём тот, что есть.
const dir = path.join(__dirname, '..', 'Учебные планы');
const file = ['81 кафедра.xlsx', '81.xlsx'].map((n) => path.join(dir, n)).find(fs.existsSync);
const wb = XLSX.read(fs.readFileSync(file));
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
const res = parseCurriculum(aoa, path.basename(file));

test('кафедра из имени файла', () => assert.equal(res.kafedra, '81'));

test('разобрано разумное число дисциплин', () =>
  assert.ok(res.disciplines.length >= 50 && res.disciplines.length <= 65, `получили ${res.disciplines.length}`));

test('Физподготовка: экз 2,4,6,8,10; зач.с оц 1,3,5,7,9', () => {
  const d = res.disciplines.find((x) => x.name.startsWith('Физическая подготовка') && x.index);
  assert.ok(d);
  assert.deepEqual(d.exams, [2, 4, 6, 8, 10]);
  assert.deepEqual(d.zachetsGraded, [1, 3, 5, 7, 9]);
});

test('Иностранный язык: экз сем.4, всего 288 ч, зач.с оц сем.1 и 3', () => {
  const d = res.disciplines.find((x) => x.name === 'Иностранный язык');
  assert.ok(d);
  assert.deepEqual(d.exams, [4]);
  assert.deepEqual(d.zachetsGraded, [1, 3]);
  assert.equal(d.totalHours, 288);
});

test('Д.12.О: курсовая работа 16 ч в сем.4, зачёт только сем.4', () => {
  const d = res.disciplines.find((x) => x.index === 'Д.12.О');
  assert.ok(d);
  assert.deepEqual(d.zachetsGraded, [4]);
  assert.ok(d.coursework && d.coursework.hours === 16 && d.coursework.semester === 4);
});

// В «81.xlsx» (пришёл на смену «81 кафедра.xlsx») у Д.28.О остался только экзамен —
// пара «экз+зач в одном семестре» из данных исчезла, поэтому случай B проверяем
// синтетической строкой, а не реальным файлом.
test('Д.28.О: экзамен сем.6, курсовой в файле больше не закодирован', () => {
  const d = res.disciplines.find((x) => x.index === 'Д.28.О');
  assert.ok(d);
  assert.deepEqual(d.exams, [6]);
  assert.deepEqual(d.zachetsGraded, []);
});

test('случай B: экз+зач в одном семестре → курсовой проект, не зачёт', () => {
  const row = [];
  row[0] = 1; // № — целое число => строка дисциплины
  row[1] = 'Д.99.О';
  row[2] = 'Синтетическая дисциплина';
  row[53] = 6; // экзамен сем.6
  row[54] = 6; // зачёт с оценкой сем.6 — должен стать курсовым проектом
  const d = parseCurriculum([row], '81.xlsx').disciplines[0];
  assert.deepEqual(d.exams, [6]);
  assert.deepEqual(d.zachetsGraded, []);
  assert.ok(d.coursework && d.coursework.kind === 'project' && d.coursework.semester === 6);
});

test('практика: недели → часы ×54 (Преддипломная 10 нед = 540 ч)', () => {
  const d = res.disciplines.find((x) => x.name === 'Преддипломная практика');
  assert.ok(d && d.kind === 'practice');
  assert.equal(d.weeks, 10);
  assert.equal(d.totalHours, 540);
});

test('физподготовка: «за счёт резерва» слита в один предмет', () => {
  const fiz = res.disciplines.filter((d) => /^физическая подготовка/i.test(d.name));
  assert.equal(fiz.length, 1, 'физподготовка — одна дисциплина');
  const d = fiz[0];
  assert.equal(d.reserveHours, 408, 'резерв 408 ч слит');
  assert.equal(d.audTotal, 622, 'ауд = 214 + 408');
  assert.equal(d.perSemester[7].aud, 74, 'сем.8 = 18 + 56');
  assert.equal(d.perSemester[0].aud, 68, 'сем.1 = 24 + 44');
});
