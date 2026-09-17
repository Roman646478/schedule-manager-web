'use strict';

// Проверка сборки единого источника из нескольких файлов (без записи в БД).
// Использование:
//   node scripts/inspect-import.js "примеры/823.html" "примеры/401А-7.html" "примеры/БулычевС.Н..html"
//   (доп. флаг --week N — показать занятия конкретной недели)

const fs = require('node:fs');
const path = require('node:path');
const { parseSchedule } = require('../src/parsers/htmlScheduleParser');
const { mergeSchedules } = require('../src/services/importService');

const args = process.argv.slice(2);
const weekIdx = args.indexOf('--week');
const weekFilter = weekIdx >= 0 ? Number(args[weekIdx + 1]) : null;
const files = args.filter((a) => !a.startsWith('--') && a !== String(weekFilter));

if (!files.length) {
  console.error('Укажите файлы расписаний (группы/аудитории/преподаватели).');
  process.exit(1);
}

const parsed = { groups: [], rooms: [], teachers: [] };
for (const f of files) {
  const r = parseSchedule(fs.readFileSync(path.resolve(f)));
  if (r.kind === 'group') parsed.groups.push(r);
  else if (r.kind === 'room') parsed.rooms.push(r);
  else if (r.kind === 'teacher') parsed.teachers.push(r);
  console.log(`  + ${r.kind?.padEnd(8) || '???'} ${r.owner}  (${f})`);
}

const { lessons, subjects, report } = mergeSchedules(parsed);

console.log('\n' + '='.repeat(80));
console.log('ОТЧЁТ СБОРКИ');
console.log('='.repeat(80));
console.log('Файлов: групп', parsed.groups.length, '| аудиторий', parsed.rooms.length, '| преподавателей', parsed.teachers.length);
console.log('Занятий из групп (записей):', report.fromGroups);
console.log('Добавлено из аудиторий:    ', report.addedFromRooms);
console.log('Преподаватель проставлен:  ', report.teachersAssigned);
console.log('Не совпало (файл препода): ', report.teacherUnmatched);
console.log('Конфликтов преподавателя:  ', report.teacherConflicts);
console.log('Потоковых занятий:         ', report.streams);
console.log('Всего занятий в источнике: ', lessons.length);
console.log('Без преподавателя:         ', report.withoutTeacher);
console.log('Дисциплин в справочнике:   ', Object.keys(subjects).length);

const shown = weekFilter ? lessons.filter((l) => l.weekNo === weekFilter) : lessons.slice(0, 25);
console.log('\n' + '—'.repeat(80));
console.log(weekFilter ? `Занятия недели №${weekFilter}` : 'Первые 25 занятий');
console.log('—'.repeat(80));
for (const l of shown) {
  const teacher = l.teacher
    ? '✔ ' + l.teacher
    : l.candidateTeachers.length
      ? '? [' + l.candidateTeachers.join(' / ') + ']'
      : '? —';
  console.log(
    [
      `н${String(l.weekNo).padStart(2)}`,
      l.day,
      `п${l.pairNo}`,
      (l.type || '·').padEnd(4),
      (l.subject || '·').padEnd(8),
      'ауд:' + (l.room || '·').padEnd(8),
      'гр:' + (l.groups.join(',') || '·').padEnd(14),
      teacher,
    ].join('  ')
  );
}
