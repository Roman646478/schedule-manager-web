'use strict';

// Импорт реальных примеров во ВРЕМЕННУЮ БД (полный путь до БД задаём до require).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-test-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { getGroupSubjects } = require('../../src/services/settingsService');
const { getView, editLesson, createLesson, listEntities } = require('../../src/services/scheduleService');
const { getDb, closeDb } = require('../../src/config/database');

// Тесты написаны под весенние примеры; в примеры/осень — тёзки другого года.
const EXAMPLES = path.join(__dirname, '..', '..', 'примеры', 'весна');
// Примеры разложены по подпапкам (группы/аудитории/преподователи) — ищем по имени.
function findExample(name) {
  const stack = [EXAMPLES];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  throw new Error(`Пример не найден: ${name}`);
}
const read = (name) => fs.readFileSync(findExample(name));

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP + ext);
    } catch {
      /* нет файла — ок */
    }
  }
});

test('importFiles merge: повторный импорт не удаляет старое и не дублирует', () => {
  const files = [{ buffer: read('823.html') }];
  importFiles(files, 'merge');
  const db = getDb();
  const after1 = db.prepare('SELECT COUNT(*) n FROM lessons').get().n;
  assert.ok(after1 > 0, 'первый импорт наполнил базу');

  // Ручная правка: ставим тему занятию — merge не должен её затереть.
  const some = db.prepare('SELECT id FROM lessons LIMIT 1').get().id;
  db.prepare("UPDATE lessons SET topic = 'РУЧНАЯ ТЕМА' WHERE id = ?").run(some);

  const report2 = importFiles(files, 'merge');
  const after2 = db.prepare('SELECT COUNT(*) n FROM lessons').get().n;

  assert.equal(after2, after1, 'повторный merge тех же данных не плодит дубли');
  assert.equal(report2.lessonsAdded, 0, 'новых занятий нет');
  assert.ok(report2.lessonsMatched > 0, 'занятия сопоставлены с существующими');
  const topic = db.prepare('SELECT topic FROM lessons WHERE id = ?').get(some).topic;
  assert.equal(topic, 'РУЧНАЯ ТЕМА', 'ручная правка сохранена');

  // Чистим для следующего теста (он ждёт пустую базу под полный импорт).
  importFiles(files, 'replace');
  db.exec('DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM subject_teachers; DELETE FROM subjects; DELETE FROM rooms; DELETE FROM groups; DELETE FROM teachers;');
});

test('importFiles: импорт 3 примеров в БД, проверка наполнения', () => {
  // filterTeachers:false — проверяем сам конвейер связывания (Гребенник ведёт ИЯ,
  // которой у группы 823 нет; с включённым отсевом она бы отсеялась — см. тест ниже).
  const report = importFiles([
    { buffer: read('823.html') },
    { buffer: read('262-7.html') },
    { buffer: read('ГребенникЕ.А..html') },
  ], 'merge', { filterTeachers: false });

  assert.ok(report.fromGroups > 0, 'занятия из групп есть');
  assert.ok(report.addedFromRooms >= 0);
  assert.ok(report.teachersAssigned > 0, 'преподаватель проставлен (файлы связаны)');

  const db = getDb();
  const lessons = db.prepare('SELECT COUNT(*) n FROM lessons').get().n;
  const links = db.prepare('SELECT COUNT(*) n FROM lesson_groups').get().n;
  const subjects = db.prepare('SELECT COUNT(*) n FROM subjects').get().n;
  const teachers = db.prepare('SELECT COUNT(*) n FROM teachers').get().n;

  assert.ok(lessons > 100, `ожидаем много занятий, получили ${lessons}`);
  assert.ok(links >= lessons, 'каждое занятие связано хотя бы с одной группой');
  assert.ok(subjects >= 5, 'дисциплины из подвала загружены');
  assert.ok(teachers >= 5, 'преподаватели-кандидаты загружены');

  // Все строки lessons обязаны иметь группу (через lesson_groups).
  const orphan = db
    .prepare('SELECT COUNT(*) n FROM lessons l WHERE NOT EXISTS (SELECT 1 FROM lesson_groups lg WHERE lg.lesson_id = l.id)')
    .get().n;
  assert.equal(orphan, 0, 'не должно быть занятий без группы');
});

test('importFiles: отсев преподавателей, не ведущих занятий в нашем расписании', () => {
  // Гребенник ведёт только ИЯ — у группы 823 такой дисциплины нет → отсеивается.
  const report = importFiles([
    { buffer: read('823.html') },
    { buffer: read('262-7.html') },
    { buffer: read('ГребенникЕ.А..html') },
  ], 'replace');
  assert.equal(report.teachersSkipped, 1, 'лишний преподаватель отсеян');
});

test('importFiles: таблица дисциплин сохраняется ПО ГРУППАМ из подвала файла', () => {
  importFiles([{ buffer: read('823.html') }], 'replace');
  const gs = getGroupSubjects();

  assert.ok(gs['823'], 'есть запись для группы 823 (owner файла)');
  const list = gs['823'];
  assert.ok(list.length >= 5, `дисциплины группы загружены, получили ${list.length}`);

  const kuka = list.find((s) => s.abbr === 'КУКА');
  assert.ok(kuka, 'дисциплина КУКА из подвала есть');
  assert.ok(kuka.fullName && /конструкци/i.test(kuka.fullName), 'полное название из файла');
  assert.ok(kuka.teachers.length >= 1, 'преподаватели дисциплины взяты из файла');

  // Файл-аудитория не создаёт групповую запись (только файлы групп).
  importFiles([{ buffer: read('262-7.html') }], 'replace');
  assert.deepEqual(getGroupSubjects(), {}, 'у файла аудитории нет таблицы по группе');
});

test('двойная аудитория: занятие импортируется в обе аудитории (lesson_rooms)', () => {
  // 841-11 содержит занятия ИЯ в двух аудиториях «435-7, 426-7».
  importFiles([{ buffer: read('841-11.html') }], 'replace');
  const db = getDb();

  // В БД нет аудитории со слитным именем «435-7, 426-7» — это две записи.
  const comma = db.prepare("SELECT COUNT(*) n FROM rooms WHERE name LIKE '%,%'").get().n;
  assert.equal(comma, 0, 'нет аудиторий со склеенным именем');

  const dbl = getView('group', '841-11').find((l) => (l.rooms || []).length === 2);
  assert.ok(dbl, 'есть занятие с двумя аудиториями');
  assert.equal(dbl.rooms.length, 2);
  assert.equal(dbl.room, dbl.rooms[0], 'основная аудитория = первая');

  // Одно и то же занятие видно в расписании ОБЕИХ аудиторий.
  const [r1, r2] = dbl.rooms;
  assert.ok(getView('room', r1).some((l) => l.id === dbl.id), `видно в ${r1}`);
  assert.ok(getView('room', r2).some((l) => l.id === dbl.id), `видно в ${r2}`);
});

test('двойная аудитория: файлы аудиторий НЕ плодят дубли занятия', () => {
  // Группа 841-11 (ИЯ в «435-7, 426-7») + файлы обеих аудиторий: должно остаться
  // ОДНО занятие с двумя аудиториями, а не три (одно двойное + два одиночных).
  importFiles([
    { buffer: read('841-11.html') },
    { buffer: read('435-7.html') },
    { buffer: read('426-7.html') },
  ], 'replace');

  const iya = getView('group', '841-11').filter((l) => l.subject === 'ИЯ');
  const bySlot = new Map();
  for (const l of iya) {
    const k = `${l.day}|${l.pairNo}|${l.weekNo}`;
    bySlot.set(k, (bySlot.get(k) || 0) + 1);
  }
  const dupSlots = [...bySlot.values()].filter((n) => n > 1).length;
  assert.equal(dupSlots, 0, 'в одном слоте — одно занятие ИЯ (без дублей по аудиториям)');
  assert.ok(iya.some((l) => l.rooms.length === 2), 'занятие с двумя аудиториями сохранено');
});

// Синтетические файлы для тестов автосдвига. Нюансы формата: сетке нужно ≥3
// строк (findGridTable берёт таблицу с максимумом строк), а после имени
// владельца в шапке — ещё слово (текст соседних ячеек склеивается без пробела).
// Даты от 2 февраля: диагональ сходится (Пн нед.1 = 2, Вт нед.2 = 10,
// Ср нед.3 = 18) → firstDate=2026-02-02 verified, авто-сдвиг 0.
const synCell = (a, b, c) =>
  `<td><table><tr><td>${a}</td></tr><tr><td>${b}</td></tr><tr><td>${c}</td></tr></table></td>`;
const SYN_DATES = `
      <tr><td></td><td></td><td>Месяц</td><td>Февраль</td><td></td><td></td><td></td><td></td><td></td></tr>
      <tr><td></td><td></td><td>Даты</td><td>2</td><td>9</td><td>16</td><td>23</td><td></td><td></td></tr>
      <tr><td></td><td></td><td>Даты</td><td>3</td><td>10</td><td>17</td><td>24</td><td></td><td></td></tr>
      <tr><td></td><td></td><td>Даты</td><td>4</td><td>11</td><td>18</td><td>25</td><td></td><td></td></tr>`;
// Группа 821/11: РХБЗ по Пн пара 1 в колонках, помеченных неделями 5..10.
const synGroup = (withDates) => `
    <html><body>
    <table><tr><td>Учебная группа 821/11 Факультет 8Ф</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td></tr>
      ${withDates ? SYN_DATES : ''}
      <tr><td>Пн</td><td>1-2</td><td>9.00-10.35</td>${Array.from({ length: 6 }, () => synCell('П', 'РХБЗ', '101')).join('')}</tr>
      <tr><td>Вт</td><td>1-2</td><td>9.00-10.35</td>${'<td></td>'.repeat(6)}</tr>
    </table>
    </body></html>`;
// Преподаватель: те же пары на ЛОКАЛЬНЫХ неделях 1..6.
const synTeacher = (withDates) => `
    <html><body>
    <table><tr><td>Преподаватель: Тест Т.Т. Семестр: весенний</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr>
      ${withDates ? SYN_DATES : ''}
      <tr><td>Пн</td><td>1-2</td><td>9.00-10.35</td>${Array.from({ length: 6 }, () => synCell('101', '821/11', 'РХБЗ')).join('')}</tr>
      <tr><td>Вт</td><td>1-2</td><td>9.00-10.35</td>${'<td></td>'.repeat(6)}</tr>
    </table>
    </body></html>`;
const SYN_SEMESTER = { start: '2026-02-02', end: '2026-08-31' };

test('автосдвиг: дата, подтверждённая диагональю, не переопределяется подбором по совпадениям', () => {
  // Подбор по совпадениям предпочёл бы преподавателю сдвиг +4 (6 совпадений
  // против 2 при нуле) — но подтверждённая датами диагональ важнее.
  const report = importFiles(
    [{ buffer: synGroup(true) }, { buffer: synTeacher(true) }],
    'replace',
    { semester: SYN_SEMESTER, filterTeachers: false }
  );
  const t = report.offsets.find((o) => o.kind === 'teacher');
  assert.equal(t.dateVerified, true, 'диагональная проверка дат пройдена');
  assert.equal(t.offset, 0, 'применён авто-сдвиг по дате, подбор не вмешался');
  assert.equal(report.offsetWarnings.length, 0);
  assert.equal(report.problemFiles.length, 0, 'оба файла с подтверждёнными датами');

  // Преподаватель БЕЗ строк дат: запасной путь — подбор по совпадениям (+4).
  const report2 = importFiles(
    [{ buffer: synGroup(true) }, { buffer: synTeacher(false) }],
    'replace',
    { semester: SYN_SEMESTER, filterTeachers: false }
  );
  const t2 = report2.offsets.find((o) => o.kind === 'teacher');
  assert.equal(t2.dateVerified, false);
  assert.equal(t2.offset, 4, 'без дат сдвиг подобран по совпадениям');
  assert.equal(report2.offsetWarnings.length, 1, 'подбор отражён в предупреждениях');
  assert.equal(report2.problemFiles.length, 0, 'подбор подтвердил сдвиг — файл не проблемный');
});

test('импорт: файл с неподтверждённым сдвигом не импортируется, а уходит в problemFiles на ручной выбор', () => {
  const db = getDb();
  db.exec(
    'DELETE FROM lesson_rooms; DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM subject_teachers; DELETE FROM subjects; DELETE FROM rooms; DELETE FROM groups; DELETE FROM teachers;'
  );
  // Файл группы БЕЗ строк дат: подтвердить сдвиг нечем, запасного подбора для
  // групп нет → файл удерживается.
  const r1 = importFiles([{ buffer: synGroup(false), name: '821-11.html' }], 'merge', {
    semester: SYN_SEMESTER,
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 0, 'занятия не импортированы');
  assert.equal(r1.problemFiles.length, 1);
  const p = r1.problemFiles[0];
  assert.equal(p.name, '821-11.html');
  assert.equal(p.kind, 'group');
  assert.equal(p.owner, '821-11');
  assert.ok(p.reason.includes('нет строки дат'));

  // Повторный импорт с ручным сдвигом (окно проблемных файлов → weekOffset):
  // файл принят, недели сдвинуты, проблем больше нет.
  const r2 = importFiles([{ buffer: synGroup(false), name: '821-11.html' }], 'merge', {
    semester: SYN_SEMESTER,
    manualOffset: 3,
  });
  assert.equal(r2.problemFiles.length, 0);
  const weeks = db
    .prepare('SELECT DISTINCT week_no FROM lessons ORDER BY week_no')
    .all()
    .map((x) => x.week_no);
  assert.deepEqual(weeks, [8, 9, 10, 11, 12, 13], 'недели 5..10 сдвинуты на +3');
});

test('импорт: преподаватель без дат и без совпадений при включённом отсеве — отсеян, не проблемный', () => {
  const db = getDb();
  db.exec(
    'DELETE FROM lesson_rooms; DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM subject_teachers; DELETE FROM subjects; DELETE FROM rooms; DELETE FROM groups; DELETE FROM teachers;'
  );
  // В базе пусто, в партии нет групп → у преподавателя ноль совпадений в любом
  // сдвиге: при filterTeachers=true это «чужой» файл — отсев, а не окно проблем.
  const rFiltered = importFiles([{ buffer: synTeacher(false), name: 't.html' }], 'merge', {
    semester: SYN_SEMESTER,
    filterTeachers: true,
  });
  assert.equal(rFiltered.problemFiles.length, 0);
  assert.equal(rFiltered.teachersSkipped, 1);

  // Без отсева тот же файл — проблемный (сдвиг подтвердить нечем).
  const rAll = importFiles([{ buffer: synTeacher(false), name: 't.html' }], 'merge', {
    semester: SYN_SEMESTER,
    filterTeachers: false,
  });
  assert.equal(rAll.problemFiles.length, 1);
  assert.equal(rAll.problemFiles[0].kind, 'teacher');
});

test('импорт: новые группы/аудитории создаются скрытыми, заведённые вручную — видимы', () => {
  const db = getDb();
  db.exec(
    'DELETE FROM lesson_rooms; DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM subject_teachers; DELETE FROM subjects; DELETE FROM rooms; DELETE FROM groups; DELETE FROM teachers;'
  );
  // «Ручная» подготовка справочника до импорта: группа 823 видима.
  db.prepare('INSERT INTO groups (name, hidden) VALUES (?, 0)').run('823');

  importFiles([{ buffer: read('823.html') }, { buffer: read('841-11.html') }], 'merge');

  assert.equal(db.prepare("SELECT hidden FROM groups WHERE name = '823'").get().hidden, 0, 'ручная группа осталась видимой');
  assert.equal(db.prepare("SELECT hidden FROM groups WHERE name = '841-11'").get().hidden, 1, 'новая группа скрыта');

  const rooms = db.prepare('SELECT COUNT(*) n, SUM(hidden) h FROM rooms').get();
  assert.ok(rooms.n > 0, 'аудитории созданы импортом');
  assert.equal(rooms.h, rooms.n, 'все новые аудитории скрыты');

  // Преподавателей правило не касается (колонки hidden у них нет).
  const tCols = db.prepare('PRAGMA table_info(teachers)').all().map((c) => c.name);
  assert.ok(!tCols.includes('hidden'), 'у преподавателей нет флага hidden');
});

test('editLesson: ручная установка двух аудиторий + накладка по второй', () => {
  importFiles([{ buffer: read('823.html') }], 'replace');
  const lesson = getView('group', '823').find((l) => !l.event && !l.parked);
  assert.ok(lesson, 'есть занятие группы 823');

  // Закрепляем за занятием две аудитории.
  const res = editLesson(lesson.id, { rooms: ['A-1', 'B-2'] });
  assert.ok(res.ok, 'правка с двумя аудиториями применилась');

  const upd = getView('group', '823').find((l) => l.id === lesson.id);
  assert.deepEqual(upd.rooms, ['A-1', 'B-2']);
  assert.ok(getView('room', 'A-1').some((l) => l.id === lesson.id), 'видно в A-1');
  assert.ok(getView('room', 'B-2').some((l) => l.id === lesson.id), 'видно в B-2');

  // Новое занятие в тот же слот во ВТОРОЙ аудитории — накладка (B-2 уже занята).
  const clash = createLesson({
    day: lesson.day, pairNo: lesson.pairNo, weekNo: lesson.weekNo,
    subject: 'X', room: 'B-2', groups: ['ZZ-9'],
  });
  assert.equal(clash.ok, false, 'вторая аудитория занята → отказ');
  assert.ok(clash.reasons.join(' ').includes('B-2'), 'причина указывает на B-2');
});

// Преподаватель ведёт и нашу группу (821/11), и чужую (999/11), которой в базе нет.
const synTeacherForeign = () => `
    <html><body>
    <table><tr><td>Преподаватель: Тест Т.Т. Семестр: весенний</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr>
      ${SYN_DATES}
      <tr><td>Пн</td><td>1-2</td><td>9.00-10.35</td>${Array.from({ length: 6 }, () => synCell('101', '821/11', 'РХБЗ')).join('')}</tr>
      <tr><td>Вт</td><td>1-2</td><td>9.00-10.35</td>${Array.from({ length: 6 }, () => synCell('202', '999/11', 'ТАКТ')).join('')}</tr>
    </table>
    </body></html>`;

test('импорт: пары преподавателя по чужим группам сохраняются, группа заводится скрытой', () => {
  const report = importFiles(
    [{ buffer: synGroup(true) }, { buffer: synTeacherForeign() }],
    'replace',
    { semester: SYN_SEMESTER } // filterTeachers по умолчанию включён: файл проходит по паре с 821-11
  );
  assert.equal(report.teacherOnlyAdded, 6, 'все пары по чужой группе сохранены');

  const teacher = listEntities().teachers.find((t) => /Тест/.test(t));
  assert.ok(teacher, 'преподаватель заведён');
  const foreign = getView('teacher', teacher).filter((l) => l.subject === 'ТАКТ');
  assert.equal(foreign.length, 6, 'пары по чужой группе видны в расписании преподавателя');
  assert.deepEqual(foreign[0].groups, ['999-11'], 'номер чужой группы сохранён');
  assert.deepEqual(foreign[0].rooms, ['202'], 'аудитория сохранена');

  // Чужая группа не засоряет списки: она скрытая (в селекторе и сводном её нет).
  assert.ok(!listEntities().groups.includes('999-11'), 'скрытой группы нет в списке групп');
  assert.equal(getDb().prepare('SELECT hidden FROM groups WHERE name = ?').get('999-11').hidden, 1);

  // Своя группа не пострадала: пары не продублированы, а там, где недели файлов
  // пересеклись, преподаватель проставлен существующему занятию.
  const own = getView('group', '821-11').filter((l) => l.subject === 'РХБЗ');
  assert.equal(own.length, 6, 'пары своей группы не продублированы');
  assert.ok(own.some((l) => l.teacher === teacher), 'ФИО проставлено занятию своей группы');
  // Пары преподавателя по СВОЕЙ группе без базового занятия (перекос недель)
  // по-прежнему не создаются — иначе в сетку лезли бы фантомные пары.
  assert.equal(own.filter((l) => !l.teacher).length, 4, 'несовпавшие недели не создали новых пар');
});

// Представление «Дисциплина»: вся дисциплина сразу, группы отбираются в интерфейсе.
test('вид «дисциплина»: занятия всех групп дисциплины, мероприятия не попадают', () => {
  const subjects = listEntities().subjects;
  assert.ok(Array.isArray(subjects) && subjects.length, 'список дисциплин отдаётся в /api/entities');
  assert.ok(!subjects.includes(''), 'пустых значений в списке нет');

  const abbr = subjects.find((s) => getView('subject', s).length > 1);
  const lessons = getView('subject', abbr);
  assert.ok(lessons.every((l) => l.subject === abbr), 'только занятия этой дисциплины');
  assert.ok(lessons.every((l) => l.category !== 'event'), 'мероприятия в вид дисциплины не идут');

  // Занятия видны независимо от группы: это объединение всех групп дисциплины.
  const groups = [...new Set(lessons.flatMap((l) => l.groups || []))];
  assert.ok(groups.length >= 1, 'у дисциплины есть группы');
  for (const g of groups) {
    const ofGroup = getView('group', g).filter((l) => l.subject === abbr);
    assert.ok(ofGroup.every((l) => lessons.some((x) => x.id === l.id)),
      `все пары ${abbr} у группы ${g} есть в виде дисциплины`);
  }
});
