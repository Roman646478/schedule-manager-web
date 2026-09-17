'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-sr-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, closeDb } = require('../../src/config/database');
const { loadLessons } = require('../../src/services/conflictService');
const { placeSelfStudy, clearSrWeek, getMoveOptions, moveLesson, createLesson, editLesson } = require('../../src/services/scheduleService');
const { saveSemester } = require('../../src/services/settingsService');
const { performUndo } = require('../../src/services/undoService');

// Минимальная синтетическая база: семестр на 1 неделю, 2 курса, аудитории.
test.before(() => {
  const db = getDb();
  // Семестр из одной недели (Пн..Сб → слотов мало, тест быстрый).
  saveSemester({ name: 'T', start: '2025-09-01', end: '2025-09-06', selected: 1 }, db);

  // Курсы: префикс «81» → 1 курс, «72» → 2 курс.
  db.prepare("INSERT INTO settings(key,value) VALUES('courses',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ '81': 1, '72': 2 }));

  // Группы с численностью.
  const g = db.prepare('INSERT INTO groups(name, headcount, hidden) VALUES(?,?,0)');
  g.run('81-1', 20); g.run('81-2', 20); g.run('81-3', 20); // 1 курс, 60 всего
  g.run('72-1', 25); // 2 курс

  // Аудитории: одна большая (вмещает все 3 группы 1 курса), одна средняя, одна скрытая.
  const r = db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,?)');
  r.run('Большая', 100, 0);
  r.run('Средняя', 30, 0);
  r.run('Скрытая', 500, 1); // скрытую использовать нельзя
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('placeSelfStudy: заполняет слоты, совмещает курс в одну аудиторию по вместимости, не трогает скрытые', () => {
  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.ok(res.created > 0, 'СР созданы');

  const ls = loadLessons().filter((l) => l.subject === 'СР');
  assert.ok(ls.length, 'есть занятия СР');

  // Скрытая аудитория не используется.
  assert.ok(!ls.some((l) => (l.rooms || []).includes('Скрытая')), 'скрытая аудитория не задействована');

  // Берём один слот: 3 группы 1 курса (60 чел) должны слиться в одну запись в «Большой» (cap 100),
  // т.к. в «Среднюю» (30) все три не влезают, а большая вмещает.
  const slot = ls.filter((l) => l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  const course1 = slot.find((l) => (l.groups || []).every((g) => g.startsWith('81')) && l.groups.length > 1);
  assert.ok(course1, 'группы 1 курса объединены в один поток СР');
  assert.equal(course1.rooms[0], 'Большая', 'поток 1 курса попал в большую аудиторию');
  assert.deepEqual([...course1.groups].sort(), ['81-1', '81-2', '81-3'], 'в потоке все три группы курса');

  // 2 курс (одна группа) — отдельная запись, в другой аудитории (курсы не смешиваются).
  const course2 = slot.find((l) => l.groups.length === 1 && l.groups[0] === '72-1');
  assert.ok(course2, '2 курс расставлен отдельно');
  assert.notEqual(course2.rooms[0], 'Большая', '2 курс не в аудитории 1 курса (курсы не смешиваются)');

  // Вместимость соблюдена: сумма численностей каждой записи ≤ вместимости аудитории.
  const cap = { 'Большая': 100, 'Средняя': 30 };
  const hc = { '81-1': 20, '81-2': 20, '81-3': 20, '72-1': 25 };
  for (const l of ls) {
    const sum = l.groups.reduce((s, gr) => s + (hc[gr] || 0), 0);
    assert.ok(sum <= cap[l.rooms[0]], `вместимость ${l.rooms[0]} (${cap[l.rooms[0]]}) ≥ ${sum}`);
  }
});

test('placeSelfStudy: идемпотентна — повторный запуск не находит свободных ячеек', () => {
  const res = placeSelfStudy(1);
  assert.equal(res.ok, false, 'второй запуск ничего не добавляет');
});

test('placeSelfStudy: undo удаляет все созданные СР', () => {
  const before = loadLessons().filter((l) => l.subject === 'СР').length;
  assert.ok(before > 0);
  assert.equal(performUndo().ok, true);
  const after = loadLessons().filter((l) => l.subject === 'СР').length;
  assert.equal(after, 0, 'после отмены занятий СР не осталось');
});

test('placeSelfStudy: без кафедры группы курс всё равно максимально совмещается в одной аудитории', () => {
  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  const slot = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  // 3 группы 1 курса (60) совмещены в самой большой аудитории «Большая» (100).
  const c1 = slot.find((l) => l.groups.length === 3 && l.groups.every((g) => g.startsWith('81')));
  assert.ok(c1 && c1.rooms[0] === 'Большая', '1 курс набит в большую аудиторию');
  performUndo();
});

test('placeSelfStudy: аудитория «только для курса» занимается лишь своим курсом', () => {
  const db = getDb();
  // «Только1» (65 мест) — только для 1 курса и точнее всех подходит под его 60 чел.
  db.prepare('INSERT INTO rooms(name, capacity, course_only, hidden) VALUES(?,?,?,0)').run('Только1', 65, 1);
  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  const slot = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  const c1 = slot.find((l) => l.groups.every((g) => g.startsWith('81')));
  assert.ok(c1 && c1.rooms[0] === 'Только1', '1 курс занял аудиторию своего курса');
  const c2 = slot.find((l) => l.groups.includes('72-1'));
  assert.ok(c2, '2 курс расставлен');
  assert.notEqual(c2.rooms[0], 'Только1', '2 курс НЕ попал в аудиторию, закреплённую за 1 курсом');
  performUndo();
  db.prepare("DELETE FROM rooms WHERE name='Только1'").run();
});

test('placeSelfStudy: своя кафедра группы приоритетнее чужой большой аудитории', () => {
  const db = getDb();
  db.prepare("UPDATE rooms SET capacity=25, dept='КАФ-Б' WHERE name IN ('Большая','Средняя')").run();
  db.prepare("UPDATE groups SET dept='КАФ-А' WHERE name='72-1'").run();
  db.prepare("INSERT INTO rooms(name, capacity, dept, hidden) VALUES('МалаяА',25,'КАФ-А',0)").run();

  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  const slot = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  const c2 = slot.find((l) => l.groups.includes('72-1'));
  assert.ok(c2 && c2.rooms[0] === 'МалаяА', '2 курс ушёл в малую аудиторию своей кафедры (КАФ-А)');
  // Трёх групп 1 курса (по 20) на две аудитории по 25 не хватает → одна без места.
  assert.ok(res.unplacedCells.length > 0, 'есть ячейки без аудитории');
  assert.ok(res.unplacedCells.every((c) => c.day && c.pairNo && c.group), 'у каждой ячейки есть день/пара/группа');
  assert.ok(res.unplacedCells.some((c) => c.group.startsWith('81')), 'среди не размещённых — группа 1 курса');
  performUndo();
});

test('placeSelfStudy: ячейке с ЭкзС проставляется аудитория, занятие СР для неё не создаётся', () => {
  const db = getDb();
  // Метка ЭкзС у группы 72-1 в Пн 1 паре: аудитории нет.
  const info = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Пн', 1, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(ecsId, '72-1');

  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.ok(res.ecsRooms > 0, 'аудитории проставлены меткам ЭкзС');

  const ecs = loadLessons().find((l) => l.id === ecsId);
  assert.ok(ecs, 'метка ЭкзС на месте (её не подменили занятием)');
  assert.ok(ecs.rooms.length === 1, 'у метки появилась аудитория');

  const slot = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  assert.ok(!slot.some((l) => (l.groups || []).includes('72-1')), 'для группы с ЭкзС занятие СР не создано');

  // Откат снимает аудиторию у метки, саму метку не трогает.
  assert.equal(performUndo().ok, true);
  const after = loadLessons().find((l) => l.id === ecsId);
  assert.ok(after, 'метка ЭкзС осталась после отмены');
  assert.equal(after.rooms.length, 0, 'аудитория у метки снята');
  db.prepare('DELETE FROM lessons WHERE id = ?').run(ecsId);
});

test('занятие поверх ЭкзС: метка скрывается, а после освобождения ячейки возвращается', () => {
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Вт', 2, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(ecsId, '72-1');
  assert.ok(loadLessons().some((l) => l.id === ecsId), 'метка видна, пока ячейка свободна');

  // Настоящее занятие той же группы в том же слоте.
  const li = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, type, category) VALUES('Вт', 2, 1, 'ТПРН', 'ПЗ', 'lesson')"
  ).run();
  const lessonId = Number(li.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(lessonId, '72-1');

  assert.ok(!loadLessons().some((l) => l.id === ecsId), 'метка ЭкзС перекрыта занятием и не показывается');

  // Занятие ушло из ячейки — метка вернулась сама, без восстановления записей.
  db.prepare("UPDATE lessons SET day = 'Ср' WHERE id = ?").run(lessonId);
  assert.ok(loadLessons().some((l) => l.id === ecsId), 'метка вернулась после освобождения ячейки');

  db.prepare('DELETE FROM lessons WHERE id IN (?, ?)').run(ecsId, lessonId);
});

test('перенос: ячейка с ЭкзС предлагается как свободная и принимает занятие', () => {
  const db = getDb();
  const ecs = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Чт', 1, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(ecs.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(ecsId, '72-1');
  const li = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, type, category) VALUES('Пт', 1, 1, 'ТПРН', 'ПЗ', 'lesson')"
  ).run();
  const lessonId = Number(li.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(lessonId, '72-1');

  const { slots } = getMoveOptions(lessonId, 1);
  const target = slots.find((s) => s.day === 'Чт' && s.pairNo === 1 && s.weekNo === 1);
  assert.equal(target.groupFree, true, 'слот с ЭкзС предлагается для переноса');

  const moved = moveLesson(lessonId, { day: 'Чт', pairNo: 1, weekNo: 1 });
  assert.equal(moved.ok, true, JSON.stringify(moved.reasons || []));
  assert.ok(!loadLessons().some((l) => l.id === ecsId), 'метка ЭкзС ушла из занятой ячейки');

  db.prepare('DELETE FROM lessons WHERE id IN (?, ?)').run(ecsId, lessonId);
});

// Регрессия: слот с меткой ЭкзС подсвечивался как свободный (getMoveOptions), но
// createLesson/editLesson считали метку занятостью группы — вставка скопированного
// занятия и «Добавить занятие» падали с «Группа … уже занята в это время».
test('ЭкзС: в ячейку с меткой можно вставить копию и перевести занятие правкой', () => {
  const db = getDb();
  const ecs = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Ср', 3, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(ecs.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(ecsId, '72-1');

  // 1. Вставка копии (ПКМ/Ctrl+V идут этим же путём — POST /api/lessons).
  const created = createLesson({
    day: 'Ср', pairNo: 3, weekNo: 1, subject: 'ТПРН', type: 'ПЗ', groups: ['72-1'], rooms: [],
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons || []));

  // 2. Настоящая накладка группы остаётся запретом: метка — не индульгенция на слот.
  const second = createLesson({
    day: 'Ср', pairNo: 3, weekNo: 1, subject: 'ДРУГОЕ', type: 'Л', groups: ['72-1'], rooms: [],
  });
  assert.equal(second.ok, false, 'вторая пара той же группе в тот же слот запрещена');
  assert.match(String(second.reasons), /занята/);

  // 3. Правка слота у существующего занятия — тоже в ячейку с меткой.
  const other = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, type, category) VALUES('Сб', 2, 1, 'ФП', 'ПЗ', 'lesson')"
  ).run();
  const otherId = Number(other.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(otherId, '81-1');
  const ecs2 = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Ср', 4, 1, 'ЭкзС', 'event')"
  ).run();
  const ecs2Id = Number(ecs2.lastInsertRowid);
  db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?')
    .run(ecs2Id, '81-1');
  const edited = editLesson(otherId, { day: 'Ср', pairNo: 4, weekNo: 1 });
  assert.equal(edited.ok, true, JSON.stringify(edited.reasons || []));

  db.prepare('DELETE FROM lessons WHERE id IN (?, ?, ?, ?)')
    .run(ecsId, ecs2Id, otherId, created.id);
  db.prepare("DELETE FROM lessons WHERE subject = 'ТПРН' AND day = 'Ср' AND pair_no = 3").run();
});

// Регрессия: одна метка ЭкзС на несколько групп пропадала у ВСЕХ, стоило
// поставить занятие одной из них.
test('ЭкзС на несколько групп: занятие скрывает метку только у своей группы', () => {
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Пт', 5, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(info.lastInsertRowid);
  const insG = db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?');
  for (const g of ['81-1', '81-2', '81-3']) insG.run(ecsId, g);

  const li = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, type, category) VALUES('Пт', 5, 1, 'ТПРН', 'ПЗ', 'lesson')"
  ).run();
  const lessonId = Number(li.lastInsertRowid);
  insG.run(lessonId, '81-1');

  const mark = loadLessons().find((l) => l.id === ecsId);
  assert.ok(mark, 'метка осталась у групп без занятия');
  assert.deepEqual(mark.groups.sort(), ['81-2', '81-3'], 'скрыта только у группы с занятием');

  db.prepare('DELETE FROM lessons WHERE id IN (?, ?)').run(ecsId, lessonId);
  db.prepare('DELETE FROM lesson_groups WHERE lesson_id IN (?, ?)').run(ecsId, lessonId);
});

// ── Мест ≈ курсантов, порядок курсов 5→1, расщепление метки ЭкзС ─────────────

// Своя база аудиторий/групп: предыдущие тесты уже перекроили общий набор.
function resetRefs(db, rooms) {
  db.prepare('DELETE FROM lessons').run();
  db.prepare('DELETE FROM rooms').run();
  db.prepare("UPDATE groups SET dept = NULL").run();
  const r = db.prepare('INSERT INTO rooms(name, capacity, hidden) VALUES(?,?,0)');
  for (const [name, cap] of rooms) r.run(name, cap);
}

test('placeSelfStudy: берётся аудитория по размеру группы, а не самая большая', () => {
  const db = getDb();
  resetRefs(db, [['Зал', 100], ['Ср40', 40], ['Мал23', 23]]);
  // Только 2 курс (одна группа на 25) — 1 курс временно скрываем.
  db.prepare("UPDATE groups SET hidden = 1 WHERE name LIKE '81%'").run();

  assert.equal(placeSelfStudy(1).ok, true);
  const sr = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1);
  assert.equal(sr.length, 1);
  // 23 места + допуск 2 = 25 ≥ 25 — влезает совсем без пустых мест, это лучше,
  // чем 40-местная (15 пустых) или зал на 100 (75 пустых).
  assert.equal(sr[0].rooms[0], 'Мал23', 'группа на 25 села в самую тесную подходящую аудиторию');

  db.prepare("UPDATE groups SET hidden = 0 WHERE name LIKE '81%'").run();
  db.prepare('DELETE FROM lessons').run();
});

test('placeSelfStudy: старший курс получает кафедру раньше младшего, даже если свободна большая аудитория', () => {
  const db = getDb();
  // 81 → 1 курс, 72 → 5 курс (старший).
  db.prepare("UPDATE settings SET value = ? WHERE key = 'courses'").run(JSON.stringify({ '81': 1, '72': 5 }));
  resetRefs(db, [['Зал', 100], ['КафедраА', 30]]);
  db.prepare("UPDATE rooms SET dept = 'КАФ-А' WHERE name = 'КафедраА'").run();
  db.prepare("UPDATE groups SET dept = 'КАФ-А' WHERE name = '72-1'").run();
  db.prepare("UPDATE groups SET hidden = 1 WHERE name IN ('81-2', '81-3')").run();

  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  const slot = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1 && l.weekNo === 1);
  const senior = slot.find((l) => l.groups.includes('72-1'));
  assert.ok(senior && senior.rooms[0] === 'КафедраА', 'старший (5) курс сел на свою кафедру, а не в зал');
  const junior = slot.find((l) => l.groups.includes('81-1'));
  assert.ok(junior && junior.rooms[0] === 'Зал', 'младший (1) курс без кафедры занял оставшуюся аудиторию');

  db.prepare("UPDATE groups SET hidden = 0 WHERE name IN ('81-2', '81-3')").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'courses'").run(JSON.stringify({ '81': 1, '72': 2 }));
  db.prepare('DELETE FROM lessons').run();
});

test('placeSelfStudy: аудитории раздаются со СТАРШЕГО курса (5 → 1)', () => {
  const db = getDb();
  // 81 → 1 курс, 72 → 5 курс: старший должен выбрать первым.
  db.prepare("UPDATE settings SET value = ? WHERE key = 'courses'").run(JSON.stringify({ '81': 1, '72': 5 }));
  // Аудитория одна на два курса (курсы не смешиваются) — достанется тому, кто раньше.
  resetRefs(db, [['Одна30', 30]]);
  db.prepare("UPDATE groups SET hidden = 1 WHERE name IN ('81-2', '81-3')").run();

  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  const sr = loadLessons().filter((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1);
  assert.equal(sr.length, 1, 'аудитории хватило только одному курсу');
  assert.deepEqual(sr[0].groups, ['72-1'], 'её получил 5 курс, а не 1-й');
  assert.ok(res.unplacedCells.some((c) => c.group === '81-1'), '1 курс обслуживается последним');

  db.prepare("UPDATE groups SET hidden = 0 WHERE name IN ('81-2', '81-3')").run();

  db.prepare("UPDATE settings SET value = ? WHERE key = 'courses'").run(JSON.stringify({ '81': 1, '72': 2 }));
  db.prepare('DELETE FROM lessons').run();
});

test('ЭкзС: курс не влезает в одну аудиторию — метка расщепляется по аудиториям', () => {
  const db = getDb();
  // Три группы 1 курса по 20 (60 чел) и ни одной аудитории на всех.
  resetRefs(db, [['A40', 40], ['B30', 30]]);
  db.prepare("UPDATE groups SET hidden = 1 WHERE name = '72-1'").run();
  const info = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Пн', 1, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(info.lastInsertRowid);
  const insG = db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?');
  for (const g of ['81-1', '81-2', '81-3']) insG.run(ecsId, g);

  const res = placeSelfStudy(1);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const marks = loadLessons().filter((l) => l.subject === 'ЭкзС' && l.day === 'Пн' && l.pairNo === 1);
  assert.equal(marks.length, 2, 'метка расщепилась на две аудитории');
  assert.equal(new Set(marks.map((l) => l.rooms[0])).size, 2, 'аудитории разные');
  const seated = marks.flatMap((l) => l.groups);
  assert.equal(seated.length, 3, 'ни одна группа не попала в две метки сразу');
  assert.deepEqual([...seated].sort(), ['81-1', '81-2', '81-3'], 'состав курса сохранён');
  assert.ok(!loadLessons().some((l) => l.subject === 'СР' && l.day === 'Пн' && l.pairNo === 1),
    'для групп с ЭкзС занятия СР не создаются');

  // Откат: снова одна метка со всеми группами и без аудитории.
  assert.equal(performUndo().ok, true);
  const back = loadLessons().filter((l) => l.subject === 'ЭкзС' && l.day === 'Пн' && l.pairNo === 1);
  assert.equal(back.length, 1, 'копия удалена');
  assert.equal(back[0].id, ecsId, 'осталась исходная метка');
  assert.deepEqual([...back[0].groups].sort(), ['81-1', '81-2', '81-3'], 'группы вернулись в неё');
  assert.equal(back[0].rooms.length, 0, 'аудитория снята');

  db.prepare("UPDATE groups SET hidden = 0 WHERE name = '72-1'").run();
  db.prepare('DELETE FROM lessons').run();
});

test('«Удалить СР» склеивает расщеплённые метки ЭкзС обратно в одну', () => {
  const db = getDb();
  resetRefs(db, [['A40', 40], ['B30', 30]]);
  db.prepare("UPDATE groups SET hidden = 1 WHERE name = '72-1'").run();
  const info = db.prepare(
    "INSERT INTO lessons(day, pair_no, week_no, subject, category) VALUES('Пн', 1, 1, 'ЭкзС', 'event')"
  ).run();
  const ecsId = Number(info.lastInsertRowid);
  const insG = db.prepare('INSERT INTO lesson_groups(lesson_id, group_id) SELECT ?, id FROM groups WHERE name = ?');
  for (const g of ['81-1', '81-2', '81-3']) insG.run(ecsId, g);

  assert.equal(placeSelfStudy(1).ok, true);
  assert.equal(loadLessons().filter((l) => l.subject === 'ЭкзС' && l.day === 'Пн' && l.pairNo === 1).length, 2);

  const cleared = clearSrWeek(1);
  assert.equal(cleared.ok, true, JSON.stringify(cleared.reasons || []));
  const marks = loadLessons().filter((l) => l.subject === 'ЭкзС' && l.day === 'Пн' && l.pairNo === 1);
  assert.equal(marks.length, 1, 'в слоте снова одна метка');
  assert.deepEqual([...marks[0].groups].sort(), ['81-1', '81-2', '81-3'], 'состав курса цел');
  assert.equal(marks[0].rooms.length, 0, 'аудитории сняты');

  db.prepare("UPDATE groups SET hidden = 0 WHERE name = '72-1'").run();
  db.prepare('DELETE FROM lessons').run();
});
