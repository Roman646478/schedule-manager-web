'use strict';

// Прогон проверок (накладки/вместимость/ссылки) над собранным источником.
// Использование:
//   node scripts/inspect-errors.js "примеры/823.html" "примеры/262-7.html" "примеры/АлдохинаВ.Н..html"

const fs = require('node:fs');
const path = require('node:path');
const { parseSchedule } = require('../src/parsers/htmlScheduleParser');
const { mergeSchedules } = require('../src/services/importService');
const { findOverlaps, checkReferences } = require('../src/utils/validators');

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('Укажите файлы расписаний.');
  process.exit(1);
}

const parsed = { groups: [], rooms: [], teachers: [] };
for (const f of files) {
  const r = parseSchedule(fs.readFileSync(path.resolve(f)));
  if (r.kind === 'group') parsed.groups.push(r);
  else if (r.kind === 'room') parsed.rooms.push(r);
  else if (r.kind === 'teacher') parsed.teachers.push(r);
}

const { lessons } = mergeSchedules(parsed);
// Назначаем id для отчёта.
lessons.forEach((l, i) => (l.id = i + 1));

const known = {
  rooms: new Set(lessons.map((l) => l.room).filter(Boolean)),
  teachers: new Set(lessons.map((l) => l.teacher).filter(Boolean)),
  groups: new Set(lessons.flatMap((l) => l.groups)),
};

const overlaps = findOverlaps(lessons);
const references = lessons.flatMap((l) => checkReferences(l, known));
// Вместимость не проверяем — справочники ещё не заполнены (capacity/headcount пусты).

console.log('='.repeat(80));
console.log('ПРОВЕРКА РАСПИСАНИЯ');
console.log('='.repeat(80));
console.log('Занятий в источнике:', lessons.length);
console.log('Накладок:           ', overlaps.length);
console.log('  — преподаватель:  ', overlaps.filter((c) => c.kind === 'teacher').length);
console.log('  — аудитория:      ', overlaps.filter((c) => c.kind === 'room').length);
console.log('  — группа:         ', overlaps.filter((c) => c.kind === 'group').length);
console.log('Битых ссылок:       ', references.length);
console.log('(вместимость не проверяется — справочник ёмкости/численности ещё не заполнен)');

const byId = new Map(lessons.map((l) => [l.id, l]));
const fmt = (id) => {
  const l = byId.get(id);
  return `${l.day} п${l.pairNo} н${l.weekNo} ${l.subject || '·'} ауд:${l.room || '·'} гр:${l.groups.join(',')}`;
};

if (overlaps.length) {
  console.log('\n' + '—'.repeat(80));
  console.log('Накладки (первые 20)');
  console.log('—'.repeat(80));
  for (const c of overlaps.slice(0, 20)) {
    console.log(`[${c.kind}] ${c.detail}`);
    for (const id of c.lessonIds) console.log('     • ' + fmt(id));
  }
}
