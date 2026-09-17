'use strict';

// Утилита для ручной проверки парсера на реальных файлах.
// Использование:
//   node scripts/inspect-parse.js "примеры/823.html"
//   node scripts/inspect-parse.js "примеры/823.html" --week 1   (фильтр по неделе)

const fs = require('node:fs');
const path = require('node:path');
const { parseSchedule } = require('../src/parsers/htmlScheduleParser');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const weekIdx = args.indexOf('--week');
const weekFilter = weekIdx >= 0 ? Number(args[weekIdx + 1]) : null;

if (!file) {
  console.error('Укажите файл, напр.: node scripts/inspect-parse.js "примеры/823.html"');
  process.exit(1);
}

const r = parseSchedule(fs.readFileSync(path.resolve(file)));
const lessons = r.lessons.filter((l) => l.category === 'lesson');

console.log('Файл:        ', file);
console.log('Тип:         ', r.kind);
console.log('Владелец:    ', r.owner);
console.log('Уч. год:     ', r.year, '| семестр:', r.semester, '| факультет:', r.faculty);
console.log('Недель:      ', r.weeks.length);
console.log('Занятий:     ', lessons.length, '| маркеров:', r.lessons.length - lessons.length);
console.log('Дисциплин в подвале:', Object.keys(r.subjects).length);
console.log('');

const shown = weekFilter ? lessons.filter((l) => l.weekNo === weekFilter) : lessons;
const header = weekFilter ? `Занятия недели №${weekFilter}` : 'Первые 30 занятий';
console.log('—'.repeat(80));
console.log(header);
console.log('—'.repeat(80));
for (const l of (weekFilter ? shown : shown.slice(0, 30))) {
  const cols = [
    `н${String(l.weekNo).padStart(2)}`,
    l.day,
    `п${l.pairNo}`,
    (l.timeStart + '-' + l.timeEnd).padEnd(13),
    (l.type || '·').padEnd(4),
    (l.subject || '·').padEnd(8),
    'ауд:' + (l.room || '·').padEnd(8),
    'гр:' + (l.groups.join(',') || '·'),
    l.teacher ? '| ' + l.teacher : l.note ? '(' + l.note + ')' : '',
  ];
  console.log(cols.join('  '));
}

if (Object.keys(r.subjects).length) {
  console.log('');
  console.log('—'.repeat(80));
  console.log('Справочник дисциплин (подвал)');
  console.log('—'.repeat(80));
  for (const s of Object.values(r.subjects)) {
    console.log(`${(s.abbr || '·').padEnd(7)} ${s.fullName}`);
    if (s.lecturers.length) console.log(`        лекторы:      ${s.lecturers.join(' | ')}`);
    if (s.others.length) console.log(`        др. занятия:  ${s.others.join(' | ')}`);
    const all = [...new Set([...s.lecturers, ...s.others])];
    if (all.length) console.log(`        ВСЕ препод.:  ${all.join(' | ')}`);
  }
}
