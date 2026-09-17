'use strict';

// Разовое разделение потоков, в которые попали группы РАЗНЫХ курсов (ФП у 1-го
// и 4-го курса в одном спортзале — это два занятия со своими преподавателями).
// Импорт такие записи больше не создаёт (курс входит в ключ занятия), но в
// базе, собранной до этого, они остались.
//
// Использование (сервер остановить, потом запустить заново):
//   node scripts/split-course-streams.js --dry     — только показать, что найдено
//   node scripts/split-course-streams.js           — разделить
//
// Каждая часть сохраняет слот, аудитории, вид, тему, примечание и текущего
// преподавателя: после разделения «Поиск ошибок» покажет их как накладки
// преподавателя/аудитории — это и есть список того, что надо развести вручную.

const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../src/utils/constants');

const dry = process.argv.includes('--dry');
const db = new DatabaseSync(DB_PATH);

const raw = db.prepare("SELECT value FROM settings WHERE key = 'courses'").get();
const courses = JSON.parse((raw && raw.value) || '{}');
const courseOf = (g) => String(courses[String(g).slice(0, 2)] ?? '');

// Занятия с группами: id -> [{group, course}]
const byLesson = new Map();
for (const r of db
  .prepare('SELECT lg.lesson_id AS id, g.name AS name FROM lesson_groups lg JOIN groups g ON g.id = lg.group_id')
  .all()) {
  if (!byLesson.has(r.id)) byLesson.set(r.id, []);
  byLesson.get(r.id).push(r.name);
}

// Смешанные: два и более ИЗВЕСТНЫХ курса в одной записи. Группы с ненастроенным
// префиксом курса не задают — они остаются с самой большой частью.
const mixed = [];
for (const [id, groups] of byLesson) {
  const known = new Set(groups.map(courseOf).filter(Boolean));
  if (known.size > 1) mixed.push({ id, groups });
}

if (!mixed.length) {
  console.log('Потоков с группами разных курсов не найдено.');
  process.exit(0);
}

const info = db.prepare('SELECT * FROM lessons WHERE id = ?');
console.log(`Найдено записей: ${mixed.length}`);
for (const m of mixed.slice(0, 10)) {
  const l = info.get(m.id);
  console.log(`  #${m.id} ${l.subject || '?'} н${l.week_no} ${l.day} п${l.pair_no}: ${m.groups.join(', ')}`);
}
if (mixed.length > 10) console.log(`  … и ещё ${mixed.length - 10}`);

if (dry) {
  console.log('\n--dry: ничего не изменено.');
  process.exit(0);
}

const insLesson = db.prepare(
  `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, type, topic, note,
                        parked, category, teacher_id, room_id, orig_day, orig_pair, orig_week)
   SELECT day, pair_no, time_start, time_end, week_no, subject, type, topic, note,
          parked, category, teacher_id, room_id, orig_day, orig_pair, orig_week
     FROM lessons WHERE id = ?`
);
const copyRooms = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) SELECT ?, room_id FROM lesson_rooms WHERE lesson_id = ?');
const copyTeachers = db.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) SELECT ?, teacher_id FROM lesson_teachers WHERE lesson_id = ?');
const moveGroup = db.prepare('UPDATE lesson_groups SET lesson_id = ? WHERE lesson_id = ? AND group_id = (SELECT id FROM groups WHERE name = ?)');

let created = 0;
db.exec('BEGIN');
try {
  for (const { id, groups } of mixed) {
    const buckets = new Map(); // курс -> группы
    for (const g of groups) {
      const c = courseOf(g);
      if (!buckets.has(c)) buckets.set(c, []);
      buckets.get(c).push(g);
    }
    // Исходная запись остаётся за самой большой частью (за ней же — история
    // переносов и orig_*); группы без курса — вместе с ней.
    const order = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [course, gs] of order.slice(1)) {
      if (!course) continue; // группы без курса не выделяем
      const lid = Number(insLesson.run(id).lastInsertRowid);
      copyRooms.run(lid, id);
      copyTeachers.run(lid, id);
      for (const g of gs) moveGroup.run(lid, id, g);
      created += 1;
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log(`\nГотово: разделено ${mixed.length} записей, создано ${created} новых занятий.`);
console.log('Перезапустите сервер, чтобы он перечитал базу.');
