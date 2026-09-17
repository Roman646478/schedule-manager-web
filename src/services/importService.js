'use strict';

const { parseSchedule } = require('../parsers/htmlScheduleParser');
const { transaction, getOrCreate, clearAll } = require('./dbService');
const {
  setTypeLegend,
  getTypeLegend,
  getGroupSubjects,
  setGroupSubjects,
  getHolidays,
  setHolidays,
  getCourses,
} = require('./settingsService');
const { week1Monday } = require('../utils/calendar');
const { FILE_KIND, mergeReportValue } = require('../utils/constants');
const { getDb } = require('../config/database');
const { loadLessons } = require('./conflictService');
const { runCheck } = require('./curriculumService');

// Аудитории занятия как массив. Поддержка и rooms[] (из парсера), и строки room
// (из БД/прежних данных, где могла встречаться запись "430-7, 435-7").
const roomsArr = (l) => {
  if (Array.isArray(l.rooms)) return l.rooms.filter(Boolean);
  return l.room ? String(l.room).split(',').map((s) => s.trim()).filter(Boolean) : [];
};
// Ключ физического занятия: слот + набор аудиторий (порядок не важен) +
// дисциплина + КУРС. Поток объединяет только группы одного курса: ФП у 1-го и
// 4-го курса в одном спортзале — два разных занятия со своими преподавателями.
const canonRooms = (l) => [...new Set(roomsArr(l))].sort().join(',');
const slotKey = (l) => [l.day, l.pairNo, l.weekNo, canonRooms(l), l.subject || '', l.course || ''].join('|');

// Курс записи по её группам (курс группы — префикс имени в настройке «курсы»).
// Группы с ненастроенным префиксом курса не знают — они его не задают. Смесь
// курсов (легаси-запись до разделения) даёт «1,4»: такая ни с чем не совпадёт.
const courseTag = (groups, courses) => {
  const set = new Set(
    (groups || []).map((g) => String(courses[String(g).slice(0, 2)] ?? '')).filter(Boolean)
  );
  return [...set].sort().join(',');
};

// Расщепляет запись с группами разных курсов на записи по курсам (в файле
// аудитории/преподавателя в одной ячейке стоят все группы, включая чужой курс).
function byCourse(l, courses) {
  const tag = courseTag(l.groups, courses);
  if (!tag.includes(',')) return [{ ...l, course: tag }];
  const m = new Map();
  for (const g of l.groups) {
    const c = String(courses[String(g).slice(0, 2)] ?? '');
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(g);
  }
  return [...m].map(([course, groups]) => ({ ...l, course, groups }));
}

/**
 * Сводит разобранные файлы в единый список занятий (чистая функция, без БД).
 * @param {{groups:object[], rooms:object[], teachers:object[]}} parsed массивы
 *        результатов parseSchedule по типам.
 * @param {object} courses префикс группы -> номер курса (настройка «курсы»)
 * @returns {{lessons, subjects, report}}
 */
function mergeSchedules({ groups = [], rooms = [], teachers = [] }, courses = {}) {
  const map = new Map(); // slotKey -> unified lesson
  const subjects = {}; // abbr -> { abbr, fullName, dept, lecturers[], others[] }
  const legend = {}; // код вида занятия -> полное название (из подвала)
  const report = {
    fromGroups: 0,
    addedFromRooms: 0,
    teachersAssigned: 0,
    teacherUnmatched: 0,
    teacherConflicts: 0,
    streams: 0,
    withoutTeacher: 0,
  };

  // Индекс по «ядру» слота (день|пара|неделя|дисциплина) — для сопоставления
  // одно-аудиторных записей из файлов аудиторий/преподавателей с уже созданным
  // двух-аудиторным занятием из файла группы (см. findExisting).
  const byCore = new Map();
  const coreKey = (l) => [l.day, l.pairNo, l.weekNo, l.subject || ''].join('|');

  const ensure = (l, source) => {
    const key = slotKey(l);
    let u = map.get(key);
    if (!u) {
      u = {
        day: l.day,
        pairNo: l.pairNo,
        pairLabel: l.pairLabel,
        timeStart: l.timeStart,
        timeEnd: l.timeEnd,
        weekNo: l.weekNo,
        subject: l.subject || null,
        type: l.type || null,
        topic: l.topic || null,
        rooms: roomsArr(l), // массив аудиторий (1 или 2)
        category: l.category || 'lesson',
        course: l.course || '',
        groups: new Set(),
        teacher: null,
        source,
      };
      map.set(key, u);
      const ck = coreKey(u);
      if (!byCore.has(ck)) byCore.set(ck, []);
      byCore.get(ck).push(u);
    }
    return u;
  };

  // Находит уже созданное занятие для разбираемой записи: сначала точное
  // совпадение слота (вкл. набор аудиторий), затем — по «ядру» слота, если
  // аудитории записи ВХОДЯТ в набор аудиторий существующего занятия. Так одно-
  // аудиторная запись из файла аудитории «435-7» привязывается к занятию «435-7,
  // 426-7» из файла группы, а не плодит дубль.
  const findExisting = (l) => {
    const exact = map.get(slotKey(l));
    if (exact) return exact;
    const lr = roomsArr(l);
    for (const u of byCore.get(coreKey(l)) || []) {
      // Курс должен совпасть; запись без групп (маркер из файла преподавателя)
      // курса не знает — ей подходит занятие любого курса.
      if (l.course && u.course !== l.course) continue;
      const ur = u.rooms || [];
      if (lr.length ? ur.length && lr.every((r) => ur.includes(r)) : !ur.length) return u;
    }
    return null;
  };

  // Легенда видов занятий (из подвала любого файла; первое вхождение кода важнее).
  for (const file of [...groups, ...rooms, ...teachers]) {
    for (const [code, name] of Object.entries(file.legend || {})) {
      if (!legend[code]) legend[code] = name;
    }
  }

  // Проход 1 — файлы групп: база + справочник дисциплин.
  for (const file of groups) {
    mergeSubjects(subjects, file.subjects);
    for (const l of lessonsOf(file, courses)) {
      const u = ensure(l, 'group');
      l.groups.forEach((g) => u.groups.add(g));
      if (!u.type && l.type) u.type = l.type;
      if (!u.topic && l.topic) u.topic = l.topic;
      report.fromGroups += 1;
    }
  }

  // Проход 2 — файлы аудиторий: добор отсутствующих занятий. Одно-аудиторную
  // запись привязываем к уже созданному двух-аудиторному занятию (findExisting),
  // а не плодим дубль на каждую аудиторию.
  for (const file of rooms) {
    for (const l of lessonsOf(file, courses)) {
      const found = findExisting(l);
      const u = found || ensure(l, 'room');
      l.groups.forEach((g) => u.groups.add(g));
      if (!u.type && l.type) u.type = l.type;
      if (!found) report.addedFromRooms += 1;
    }
  }

  // Проход 3 — файлы преподавателей: простановка ФИО по совпадению слота.
  // Если занятия в текущей партии нет (например, преподавателей импортируют
  // ОТДЕЛЬНО, уже после групп/аудиторий) — заводим «аннотацию преподавателя»
  // (teacherOnly). При записи в БД она сначала пробует проставить ФИО уже
  // существующему занятию; если и в базе такого нет — занятие создаётся
  // (пара по чужой группе: группа заводится скрытой, см. persist).
  for (const file of teachers) {
    const teacherName = file.owner;
    for (const l of lessonsOf(file, courses)) {
      let u = findExisting(l);
      if (!u) {
        u = ensure(l, 'teacher');
        u.teacherOnly = true;
        report.teacherUnmatched += 1;
      }
      // Группы — только из файлов групп/аудиторий. Запись преподавателя группы
      // существующему занятию НЕ добавляет: при ошибочном сдвиге файла она
      // цепляла чужую группу к занятию другой группы (лишняя пара в сетке).
      if (u.teacherOnly) l.groups.forEach((g) => u.groups.add(g));
      if (u.teacher && u.teacher !== teacherName) {
        report.teacherConflicts += 1;
        continue; // оставляем уже проставленного
      }
      if (!u.teacher) {
        u.teacher = teacherName;
        report.teachersAssigned += 1;
      }
    }
  }

  // Финализация: кандидаты-преподаватели для занятий без ФИО.
  const lessons = [];
  for (const u of map.values()) {
    const groupsArr = [...u.groups];
    if (!u.teacherOnly && groupsArr.length > 1) report.streams += 1;
    let candidateTeachers = [];
    if (!u.teacher) {
      report.withoutTeacher += 1;
      candidateTeachers = candidatesFor(subjects, u.subject, u.type);
    }
    lessons.push({ ...u, groups: groupsArr, candidateTeachers });
  }

  return { lessons, subjects, legend, report };
}

// И занятия, и мероприятия (event): оба попадают в единый источник, но
// мероприятия помечаются категорией и не участвуют в проверках накладок.
function lessonsOf(file, courses = {}) {
  return (file.lessons || [])
    .filter((l) => l.category === 'lesson' || l.category === 'event')
    .flatMap((l) => byCourse(l, courses));
}

function mergeSubjects(acc, fileSubjects) {
  for (const [abbr, s] of Object.entries(fileSubjects || {})) {
    if (!acc[abbr]) {
      acc[abbr] = { abbr, fullName: s.fullName || null, dept: s.dept || null, lecturers: [], others: [] };
    }
    acc[abbr].lecturers = unionLists(acc[abbr].lecturers, s.lecturers);
    acc[abbr].others = unionLists(acc[abbr].others, s.others);
    if (!acc[abbr].fullName && s.fullName) acc[abbr].fullName = s.fullName;
    if (!acc[abbr].dept && s.dept) acc[abbr].dept = s.dept;
  }
}

function unionLists(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

// Заменяет сокращения дисциплин в одном разобранном файле ДО сборки: и в
// занятиях (subject), и в таблице дисциплин (ключ + abbr). Так записи с разными
// сокращениями одной дисциплины сводятся к одной (slotKey включает subject).
// Столкновение (ИЭП и ИРТС оба есть в файле) — объединяем преподавателей.
function applyAliases(parsedFile, aliases) {
  if (!aliases || !Object.keys(aliases).length) return;
  const to = (s) => (s && aliases[s]) || s;
  for (const l of parsedFile.lessons || []) {
    if (l.subject) l.subject = to(l.subject);
  }
  const out = {};
  for (const [abbr, s] of Object.entries(parsedFile.subjects || {})) {
    const key = to(abbr);
    if (out[key]) {
      out[key].lecturers = unionLists(out[key].lecturers, s.lecturers);
      out[key].others = unionLists(out[key].others, s.others);
    } else {
      out[key] = { ...s, abbr: key };
    }
  }
  parsedFile.subjects = out;
}

/**
 * Применяет замены сокращений к УЖЕ загруженной базе (в отличие от applyAliases,
 * который правит разобранные файлы при импорте): переименовывает дисциплину в
 * занятиях и справочнике, затем сводит образовавшиеся дубли в одно занятие.
 * Это та же реконсиляция, что делает импорт (по slotKey), применённая к БД.
 * @param {Record<string,string>} map  { отСокращения: кСокращению }
 * @returns {{renamed:number, merged:number}}
 */
function applyAliasesToDb(map) {
  const rules = Object.entries(map || {}).filter(([f, t]) => f && t && f !== t);
  if (!rules.length) return { renamed: 0, merged: 0 };

  return transaction((tx) => {
    let renamed = 0;
    for (const [from, to] of rules) {
      renamed += tx.prepare('UPDATE lessons SET subject = ? WHERE subject = ?').run(to, from).changes;
      // Справочник дисциплин: если цель уже есть — удаляем исходную (её
      // subject_teachers уйдут каскадом), иначе переименовываем аббревиатуру.
      const target = tx.prepare('SELECT 1 FROM subjects WHERE abbr = ?').get(to);
      if (target) tx.prepare('DELETE FROM subjects WHERE abbr = ?').run(from);
      else tx.prepare('UPDATE subjects SET abbr = ? WHERE abbr = ?').run(to, from);
    }

    // Дедуп: только занятия с целевыми сокращениями могли стать дублями.
    const toVals = [...new Set(rules.map(([, t]) => t))];
    const placeholders = toVals.map(() => '?').join(',');
    const roomsByLesson = new Map();
    for (const r of tx
      .prepare('SELECT lr.lesson_id AS id, rm.name AS name FROM lesson_rooms lr JOIN rooms rm ON rm.id = lr.room_id')
      .all()) {
      if (!roomsByLesson.has(r.id)) roomsByLesson.set(r.id, []);
      roomsByLesson.get(r.id).push(r.name);
    }
    const rows = tx
      .prepare(
        `SELECT id, day, pair_no AS pairNo, week_no AS weekNo, subject, type, topic, note,
                teacher_id AS teacherId, room_id AS roomId
           FROM lessons WHERE subject IN (${placeholders}) ORDER BY id`
      )
      .all(...toVals);
    for (const row of rows) row.rooms = roomsByLesson.get(row.id) || (row.roomId ? ['__room' + row.roomId] : []);

    const groups = new Map();
    for (const row of rows) {
      const k = slotKey(row); // день|пара|неделя|аудитории|дисциплина
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }

    let merged = 0;
    for (const grp of groups.values()) {
      if (grp.length < 2) continue;
      const keep = grp[0]; // минимальный id (rows отсортированы)
      for (const other of grp.slice(1)) {
        tx.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) SELECT ?, group_id FROM lesson_groups WHERE lesson_id = ?').run(keep.id, other.id);
        tx.prepare('INSERT OR IGNORE INTO lesson_rooms  (lesson_id, room_id)  SELECT ?, room_id  FROM lesson_rooms  WHERE lesson_id = ?').run(keep.id, other.id);
        tx.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) SELECT ?, teacher_id FROM lesson_teachers WHERE lesson_id = ?').run(keep.id, other.id);
        // Заполняем пустые поля сохраняемого занятия из удаляемого.
        if (!keep.teacherId && other.teacherId) { tx.prepare('UPDATE lessons SET teacher_id = ? WHERE id = ?').run(other.teacherId, keep.id); keep.teacherId = other.teacherId; }
        if (!keep.type && other.type) { tx.prepare('UPDATE lessons SET type = ? WHERE id = ?').run(other.type, keep.id); keep.type = other.type; }
        if (!keep.topic && other.topic) { tx.prepare('UPDATE lessons SET topic = ? WHERE id = ?').run(other.topic, keep.id); keep.topic = other.topic; }
        if (!keep.note && other.note) { tx.prepare('UPDATE lessons SET note = ? WHERE id = ?').run(other.note, keep.id); keep.note = other.note; }
        tx.prepare('DELETE FROM lessons WHERE id = ?').run(other.id); // каскад чистит join-таблицы
        merged += 1;
      }
    }
    return { renamed, merged };
  });
}

// Таблица дисциплин файла → список { abbr, fullName, teachers[] } для показа
// в расписании группы (преподаватели — лекторы + ведущие, без дублей).
function subjectsTableToList(fileSubjects) {
  return Object.values(fileSubjects || {})
    .map((s) => ({
      abbr: s.abbr,
      fullName: s.fullName || null,
      dept: s.dept || null,
      lecturer: s.lecturerText || null,
      others: s.othersText || null,
      hours: s.hours || null,
      report: s.report || null,
      // ФИО (без степеней/званий) — для отображения и выпадающих списков.
      teachers: unionLists(s.lecturers, s.others),
    }))
    .sort((a, b) => String(a.abbr).localeCompare(String(b.abbr), 'ru'));
}

// Кандидаты по виду занятия: лекция (Л) → лекторы, иначе → «другие виды занятий».
function candidatesFor(subjects, subjectAbbr, type) {
  const s = subjects[subjectAbbr];
  if (!s) return [];
  const isLecture = /^Л/i.test(type || '');
  const primary = isLecture ? s.lecturers : s.others;
  // Если в нужной роли пусто — отдаём всех (лучше показать, чем скрыть).
  return primary.length ? primary : unionLists(s.lecturers, s.others);
}

/* ----------------------- Импорт файлов в БД ----------------------- */

// Сдвиг недель файла относительно общего начала семестра. Берётся из реальной
// даты 1-й недели в файле (firstDate): если группа стартует позже, её «неделя 1»
// = более поздняя неделя общего календаря. Возвращает целое число недель.
function autoOffset(parsedFile, semester) {
  if (!semester || !semester.start || !parsedFile.firstDate) return 0;
  const g = week1Monday(semester.start);
  const f = week1Monday(parsedFile.firstDate);
  if (!g || !f) return 0;
  return Math.round((f.getTime() - g.getTime()) / (7 * 86400000));
}

// Сдвигает номера недель занятий файла на offset. Занятия, ушедшие до недели 1,
// отбрасываются (вне сетки семестра). Маркеры/занятия без weekNo не трогаем.
function shiftWeeks(parsedFile, offset) {
  parsedFile.lessons = (parsedFile.lessons || []).filter((l) => {
    if (typeof l.weekNo !== 'number') return true;
    l.weekNo += offset;
    return l.weekNo >= 1;
  });
}

// Подбор сдвига недель файла преподавателя по совпадению с доверенными слотами.
// firstDate в 1С-экспорте бывает разобран неверно (сдвинутая подпись месяца) →
// autoOffset уводит пары на чужие недели. Поэтому проверяем окрестность авто-
// сдвига и берём offset с максимумом совпадений слота (день|пара|неделя|
// дисциплина|ГРУППА) с уже доверенными занятиями (группы/аудитории + база в
// merge). Группа в ключе обязательна: кафедральное расписание периодично (та же
// дисциплина в те же дни/пары неделя за неделей, меняются только группы), и без
// группы неверный сдвиг набирает БОЛЬШЕ ложных совпадений, чем верный, — пары
// уезжают на чужие недели и цепляют чужие группы к существующим занятиям.
const OFFSET_WINDOW = 12; // ± недель вокруг авто-сдвига
const OFFSET_MIN_MATCH = 4; // минимум совпадений, чтобы доверять подбору
const OFFSET_MIN_GAP = 3; // насколько подбор должен превзойти авто-сдвиг

function countOffsetMatches(file, refSlots, off, slotKeys) {
  let n = 0;
  for (const l of file.lessons || []) {
    if (l.category === 'event' || typeof l.weekNo !== 'number') continue;
    if (slotKeys({ ...l, weekNo: l.weekNo + off }).some((k) => refSlots.has(k))) n += 1;
  }
  return n;
}

// Возвращает { offset, matched, autoMatched }. Авто-сдвиг заменяется только при
// уверенном превосходстве (порог + отрыв), иначе остаётся autoOff — на файлах с
// малым пересечением (преподаватель чужого факультета) поведение не меняется.
function bestTeacherOffset(file, refSlots, autoOff, slotKeys) {
  const autoMatched = countOffsetMatches(file, refSlots, autoOff, slotKeys);
  let best = { offset: autoOff, matched: autoMatched };
  for (let off = autoOff - OFFSET_WINDOW; off <= autoOff + OFFSET_WINDOW; off += 1) {
    if (off === autoOff) continue;
    const m = countOffsetMatches(file, refSlots, off, slotKeys);
    const closer = Math.abs(off - autoOff) < Math.abs(best.offset - autoOff);
    if (m > best.matched || (m === best.matched && closer)) best = { offset: off, matched: m };
  }
  const confident =
    best.offset !== autoOff && best.matched >= OFFSET_MIN_MATCH && best.matched >= autoMatched + OFFSET_MIN_GAP;
  return confident ? { ...best, autoMatched } : { offset: autoOff, matched: autoMatched, autoMatched };
}

/**
 * Парсит и импортирует набор файлов в БД.
 * @param {{buffer:Buffer, kindHint?:string}[]} files
 * @param {'merge'|'replace'} [mode='merge'] merge — дополнить существующую базу,
 *        сверяя занятия по слоту (старое не удаляется); replace — полная
 *        перезапись (как раньше).
 * @param {{semester?:object, manualOffset?:number|null}} [opts]
 *        semester — активный семестр для авто-выравнивания по датам файла;
 *        manualOffset — если задан (число), применяется ко всем файлам вместо
 *        авто-сдвига (для файлов без строки дат).
 */
function importFiles(files, mode = 'merge', opts = {}) {
  const { semester = null, manualOffset = null, filterTeachers = true, subjectAliases = {} } = opts;
  const parsed = { groups: [], rooms: [], teachers: [] };
  const offsets = [];
  const coreKey = (l) => [l.day, l.pairNo, l.weekNo, l.subject || ''].join('|');
  // Ключи слота с группами: у занятия с группами — по ключу на каждую группу,
  // без групп — «голый» ключ. Совпадение засчитывается, только если совпала и
  // группа (см. комментарий у bestTeacherOffset).
  const slotKeysOf = (l) => {
    const ck = coreKey(l);
    const gs = l.groups || [];
    return gs.length ? gs.map((g) => `${ck}|${g}`) : [`${ck}|`];
  };

  // Группы/аудитории задают календарь — сдвигаем сразу. Файлы преподавателей
  // откладываем: их сдвиг подбираем по совпадению с уже доверенными занятиями.
  // Даты каждого файла проходят диагональную проверку в парсере (до 5 якорей:
  // пн нед.1 — база, вт нед.2, ср нед.3, …). Файл, чей сдвиг подтвердить нечем,
  // НЕ импортируется, а возвращается в problemFiles: пользователь задаёт его
  // сдвиг вручную в отдельном окне и импортирует повторно (weekOffset).
  const problemFiles = [];
  const problemOf = (r, name, off) => ({
    name: name || null,
    owner: r.owner || null,
    kind: r.kind || null,
    firstDate: r.firstDate || null,
    suggestedOffset: off || 0,
    reason: r.firstDate ? 'даты файла не прошли диагональную проверку' : 'в файле нет строки дат',
  });
  const teacherCandidates = []; // { file, autoOff, name }
  for (const f of files) {
    const r = parseSchedule(f.buffer, f.kindHint);
    applyAliases(r, subjectAliases);
    const off = manualOffset != null ? manualOffset : autoOffset(r, semester);
    if (r.kind === FILE_KIND.TEACHER) {
      teacherCandidates.push({ file: r, autoOff: off, name: f.name || null });
      continue;
    }
    // Для группы/аудитории запасного подбора нет: без подтверждённой даты сдвиг
    // недостоверен — файл уходит на ручной выбор сдвига.
    if (manualOffset == null && !r.firstDateVerified) {
      problemFiles.push(problemOf(r, f.name, off));
      continue;
    }
    if (off) shiftWeeks(r, off);
    offsets.push({
      owner: r.owner || null,
      kind: r.kind || null,
      offset: off,
      firstDate: r.firstDate || null,
      dateVerified: Boolean(r.firstDateVerified),
    });
    if (r.kind === FILE_KIND.GROUP) parsed.groups.push(r);
    else if (r.kind === FILE_KIND.ROOM) parsed.rooms.push(r);
  }

  // Набор доверенных core-слотов: группы/аудитории этого импорта + (только в
  // merge) уже загруженные занятия БД. По нему подбираем сдвиг преподавателей.
  const refSlots = new Set();
  const addRef = (l) => {
    for (const k of slotKeysOf(l)) refSlots.add(k);
    refSlots.add(`${coreKey(l)}|`); // «голый» ключ — для записей препода без групп
  };
  for (const r of [...parsed.groups, ...parsed.rooms]) {
    for (const l of r.lessons || []) if (l.category !== 'event') addRef(l);
  }
  if (mode === 'merge') {
    const rows = getDb()
      .prepare(
        `SELECT l.day, l.pair_no AS pairNo, l.week_no AS weekNo, l.subject, g.name AS grp
           FROM lessons l
           LEFT JOIN lesson_groups lg ON lg.lesson_id = l.id
           LEFT JOIN groups g ON g.id = lg.group_id`
      )
      .all();
    for (const row of rows) addRef({ ...row, groups: row.grp ? [row.grp] : [] });
  }

  // Сдвиг файлов преподавателей. Дате, подтверждённой диагональной проверкой,
  // верим как есть — подбор по совпадениям для неё НЕ запускается (кафедральное
  // расписание периодично, и подбор может «уверенно» промахнуться на период).
  // Подбор остаётся запасным путём для файлов без дат или с кривыми датами;
  // если и он не дал подтверждения — файл уходит на ручной выбор сдвига
  // (кроме «чужих» преподавателей без единого совпадения при включённом отсеве).
  const offsetWarnings = [];
  let teachersHeldSkipped = 0;
  for (const { file, autoOff, name } of teacherCandidates) {
    let off = autoOff;
    if (manualOffset == null && !file.firstDateVerified) {
      const best = bestTeacherOffset(file, refSlots, autoOff, slotKeysOf);
      if (best.offset !== autoOff) {
        off = best.offset;
        offsetWarnings.push({
          owner: file.owner || null,
          autoOffset: autoOff,
          chosenOffset: off,
          matched: best.matched,
        });
      } else if (best.matched < OFFSET_MIN_MATCH) {
        if (filterTeachers && best.matched === 0) {
          teachersHeldSkipped += 1; // ни одного совпадения в окне — чужой преподаватель
        } else {
          problemFiles.push(problemOf(file, name, autoOff));
        }
        continue;
      }
    }
    if (off) shiftWeeks(file, off);
    offsets.push({
      owner: file.owner || null,
      kind: file.kind || null,
      offset: off,
      firstDate: file.firstDate || null,
      dateVerified: Boolean(file.firstDateVerified),
    });
    parsed.teachers.push(file);
  }

  // Отсев лишних преподавателей: оставляем только тех, у кого есть пара,
  // совпадающая с доверенным слотом (день|пара|неделя|дисциплина). Снять отсев —
  // filterTeachers=false.
  let teachersSkipped = teachersHeldSkipped;
  if (filterTeachers && parsed.teachers.length) {
    const before = parsed.teachers.length;
    parsed.teachers = parsed.teachers.filter((tf) =>
      (tf.lessons || []).some(
        (l) => l.category !== 'event' && slotKeysOf(l).some((k) => refSlots.has(k))
      )
    );
    teachersSkipped += before - parsed.teachers.length;
  }

  // Таблица дисциплин с преподавателями ПО ГРУППАМ — прямо из подвала файла
  // каждой группы (не из расписания). Ключ — имя группы (owner файла).
  const groupSubjects = {};
  for (const r of parsed.groups) {
    if (r.owner) groupSubjects[r.owner] = subjectsTableToList(r.subjects);
  }

  // Нерабочие даты (выходные/праздники) из ячеек «Вых» всех файлов — для
  // авторазметки выходных в сетке. Даты абсолютные, от сдвига недель не зависят.
  const holidays = new Set();
  for (const r of [...parsed.groups, ...parsed.rooms, ...parsed.teachers]) {
    for (const iso of r.holidays || []) holidays.add(iso);
  }

  const merged = mergeSchedules(parsed, getCourses());
  merged.groupSubjects = groupSubjects;
  merged.holidays = [...holidays].sort();
  persist(merged, mode === 'replace' ? 'replace' : 'merge');
  merged.report.offsets = offsets;
  merged.report.shifted = offsets.filter((o) => o.offset).length;
  merged.report.teachersSkipped = teachersSkipped;
  merged.report.offsetWarnings = offsetWarnings;
  merged.report.problemFiles = problemFiles;
  return merged.report;
}

/**
 * Столбец «Отчёт.» подвала: формы контроля берём из УЧЕБНОГО ПЛАНА кафедры.
 * В файлах расписания этот столбец часто пуст (в осенних — всегда), а план
 * знает, что положено группе в этом семестре. Уже указанное в файле не
 * затирается и не дублируется (см. mergeReportValue).
 * Без загруженного плана / курса группы / выбранного семестра шаг молча
 * пропускается — импорт от него не зависит.
 * @param {object} groupSubjects карта «группа → список дисциплин» (правится на месте)
 * @param {string[]} groups группы, подвал которых только что переимпортирован
 */
function fillReportsFromPlan(db, groupSubjects, groups) {
  const all = loadLessons(db); // одна выборка на все группы (см. runCheck(preloaded))
  for (const g of groups) {
    const list = groupSubjects[g];
    if (!Array.isArray(list) || !list.length) continue;
    let check;
    try {
      check = runCheck(g, db, all);
    } catch {
      continue; // план битый — подвал оставляем как в файле
    }
    if (!check || check.error || !Array.isArray(check.rows)) continue;
    // Дисциплина может стоять в плане несколькими строками (у ФП экзамен и зачёт
    // в разных семестрах — своя строка на каждую), поэтому дополняем по ВСЕМ
    // совпавшим строкам, а не по одной.
    for (const s of list) {
      let v = s.report;
      for (const r of check.rows) if (r.abbr && r.abbr === s.abbr) v = mergeReportValue(v, r);
      s.report = v || null;
    }
  }
}

function persist(merged, mode) {
  return transaction((db) => {
    if (mode === 'replace') clearAll(db);

    const teacherId = (name) => (name ? getOrCreate(db, 'teachers', 'name', name) : null);
    // Новые группы/аудитории при импорте создаются СКРЫТЫМИ: видимы только те,
    // что заведены вручную до импорта (у существующих hidden не меняется —
    // getOrCreate применяет extra только при создании). К преподавателям не
    // применяется. NB: в режиме replace clearAll() удаляет и справочники, так
    // что после него ВСЕ группы/аудитории пересоздаются скрытыми.
    const groupId = (name) => getOrCreate(db, 'groups', 'name', name, { hidden: 1 });
    const roomId = (name) => (name ? getOrCreate(db, 'rooms', 'name', name, { hidden: 1 }) : null);

    // Справочник дисциплин + кандидаты-преподаватели (идемпотентно — дополняет).
    for (const s of Object.values(merged.subjects)) {
      const sid = getOrCreate(db, 'subjects', 'abbr', s.abbr, {
        full_name: s.fullName || null,
        dept: s.dept || null,
      });
      const addRole = (list, role) => {
        for (const t of list) {
          db.prepare(
            'INSERT OR IGNORE INTO subject_teachers (subject_id, teacher_id, role) VALUES (?, ?, ?)'
          ).run(sid, teacherId(t), role);
        }
      };
      addRole(s.lecturers, 'lecturer');
      addRole(s.others, 'other');
    }

    const insLesson = db.prepare(
      `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no, subject, type, topic, teacher_id, room_id, category, parked, orphan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
    const insLR = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');

    // В режиме merge сверяем с тем, что уже в базе: индекс по слоту (день, пара,
    // неделя, аудитория, дисциплина). Совпавшее занятие дополняется, новое —
    // добавляется. Ручные правки (преподаватель, тема, перенос) не затираются.
    const existing = new Map(); // slotKey -> прежнее занятие из БД
    const existingByCore = new Map(); // день|пара|неделя|дисциплина -> [занятия]
    const coreKeyOf = (l) => [l.day, l.pairNo, l.weekNo, l.subject || ''].join('|');
    const courses = getCourses(db);
    if (mode === 'merge') {
      // Аудитории каждого занятия — из lesson_rooms (их может быть несколько),
      // чтобы ключ слота совпадал с импортируемым двух-аудиторным занятием.
      const roomsByLesson = new Map();
      for (const r of db
        .prepare('SELECT lr.lesson_id AS id, rm.name AS name FROM lesson_rooms lr JOIN rooms rm ON rm.id = lr.room_id')
        .all()) {
        if (!roomsByLesson.has(r.id)) roomsByLesson.set(r.id, []);
        roomsByLesson.get(r.id).push(r.name);
      }
      const rows = db
        .prepare(
          `SELECT l.id, l.day, l.pair_no AS pairNo, l.week_no AS weekNo, l.subject,
                  l.type, l.topic, l.category, l.orphan, l.teacher_id AS teacherId, r.name AS room
             FROM lessons l LEFT JOIN rooms r ON r.id = l.room_id`
        )
        .all();
      // Группы занятия — для курса в ключе слота (поток = один курс).
      const groupsByLesson = new Map();
      for (const r of db
        .prepare('SELECT lg.lesson_id AS id, g.name AS name FROM lesson_groups lg JOIN groups g ON g.id = lg.group_id')
        .all()) {
        if (!groupsByLesson.has(r.id)) groupsByLesson.set(r.id, []);
        groupsByLesson.get(r.id).push(r.name);
      }
      for (const row of rows) {
        row.rooms = roomsByLesson.get(row.id) || (row.room ? [row.room] : []);
        row.course = courseTag(groupsByLesson.get(row.id), courses);
        const k = slotKey(row);
        if (!existing.has(k)) existing.set(k, row);
        const ck = coreKeyOf(row);
        if (!existingByCore.has(ck)) existingByCore.set(ck, []);
        existingByCore.get(ck).push(row);
      }
    }

    // Прежнее занятие в БД для импортируемого: точный слот, иначе — по «ядру»,
    // если аудитории импортируемого ВХОДЯТ в аудитории существующего (одно-
    // аудиторный файл аудитории не плодит дубль рядом с двух-аудиторным занятием).
    const findPrior = (l) => {
      const exact = existing.get(slotKey(l));
      if (exact) return exact;
      const lr = roomsArr(l);
      for (const row of existingByCore.get(coreKeyOf(l)) || []) {
        // Курс должен совпасть; запись без групп подходит к любому курсу.
        if (l.course && row.course !== l.course) continue;
        const rr = row.rooms || [];
        if (lr.length ? rr.length && lr.every((r) => rr.includes(r)) : !rr.length) return row;
      }
      return null;
    };

    // «Наши» группы — те, чьё расписание мы ведём: видимые в селекторе, с
    // подвалом дисциплин (значит был файл группы) либо встреченные в этой партии
    // в файлах групп/аудиторий. Всё остальное, что встретилось только в файлах
    // преподавателей, — чужие группы. Список считаем ОДИН раз до цикла: чужая
    // группа заводится по ходу вставки, и «живая» проверка по базе посчитала бы
    // её нашей уже со второй пары.
    const ourGroups = new Set([
      ...db.prepare('SELECT name FROM groups WHERE hidden = 0').all().map((r) => r.name),
      ...Object.keys(getGroupSubjects(db)),
      ...merged.lessons.filter((l) => !l.teacherOnly).flatMap((l) => l.groups || []),
    ]);
    const foreignGroupsOnly = (l) =>
      (l.groups || []).length > 0 && l.groups.every((g) => !ourGroups.has(g));

    // Слоты, в которых у группы стоит метка экзаменационной сессии «ЭкзС».
    // Пара из файла преподавателя в таком слоте не совпадёт ни с чем (у группы
    // там метка, а не занятие) и раньше молча пропадала — теперь она попадает в
    // «Не размещённые». Метки берём и из этой партии, и из базы: файл группы с
    // сессией мог быть загружен раньше файла преподавателя.
    const ecsSlots = new Set(); // "группа|день|пара|неделя"
    const ecsKey = (g, l) => `${g}|${l.day}|${l.pairNo}|${l.weekNo}`;
    const isEcsRow = (subject, category) =>
      (category || 'lesson') === 'event' && String(subject || '').trim().toLowerCase() === 'экзс';
    for (const l of merged.lessons) {
      if (isEcsRow(l.subject, l.category)) for (const g of l.groups || []) ecsSlots.add(ecsKey(g, l));
    }
    for (const r of db
      .prepare(
        `SELECT l.day, l.pair_no AS pairNo, l.week_no AS weekNo, l.subject, l.category, g.name AS grp
           FROM lessons l JOIN lesson_groups lg ON lg.lesson_id = l.id
           JOIN groups g ON g.id = lg.group_id
          WHERE l.category = 'event'`
      )
      .all()) {
      if (isEcsRow(r.subject, r.category)) ecsSlots.add(ecsKey(r.grp, r));
    }
    const onGroupSession = (l) => (l.groups || []).some((g) => ecsSlots.has(ecsKey(g, l)));

    const updTeacher = db.prepare('UPDATE lessons SET teacher_id = ? WHERE id = ?');
    const updType = db.prepare('UPDATE lessons SET type = ? WHERE id = ?');
    const updTopic = db.prepare('UPDATE lessons SET topic = ? WHERE id = ?');
    const updCategory = db.prepare('UPDATE lessons SET category = ? WHERE id = ?');
    const unOrphan = db.prepare('UPDATE lessons SET parked = 0, orphan = 0 WHERE id = ?');

    let lessonsAdded = 0;
    let lessonsMatched = 0;
    let groupsAdded = 0;
    let teacherOnlyAdded = 0; // пары преподавателя по группам, которых нет в базе
    let sessionOrphans = 0; // пары, попавшие на «ЭкзС» группы → «Не размещённые»

    for (const l of merged.lessons) {
      const category = l.category || 'lesson';
      const prior = mode === 'merge' ? findPrior(l) : null;
      if (prior) {
        // Дополняем только пустые поля — ручные значения важнее импортируемых.
        if (!prior.teacherId && l.teacher) updTeacher.run(teacherId(l.teacher), prior.id);
        if (!prior.type && l.type) updType.run(l.type, prior.id);
        if (!prior.topic && l.topic) updTopic.run(l.topic, prior.id);
        // Категория структурна (не ручная правка): приводим к актуальной.
        if ((prior.category || 'lesson') !== category) updCategory.run(category, prior.id);
        // «Не размещённое» занятие встретилось в файле группы/аудитории — значит
        // слот настоящий (сессию у группы отменили/сдвинули): возвращаем в сетку.
        if (prior.orphan && !l.teacherOnly) {
          unOrphan.run(prior.id);
          prior.orphan = 0;
        }
        // Аннотация преподавателя проставляет ФИО, но группы существующему
        // занятию не дописывает (группы достоверны только из файлов групп/ауд.).
        if (!l.teacherOnly) {
          for (const g of l.groups) groupsAdded += insLG.run(prior.id, groupId(g)).changes ? 1 : 0;
        }
        lessonsMatched += 1;
        continue;
      }
      // Занятие из файла преподавателя, которому не нашлось пары в базе.
      // Сохраняем ТОЛЬКО пары по чужим группам (ни одной нашей): раньше они
      // выбрасывались, и время преподавателя выглядело свободным. Группа при
      // этом заводится скрытой (в списке групп и в сводном её нет), аудитория
      // пишется как есть. Пара по ИЗВЕСТНОЙ группе, у которой в этом слоте
      // ничего нет, по-прежнему не создаётся: это почти всегда сдвиг файла
      // преподавателя, и такая пара была бы фантомной.
      // Пара по НАШЕЙ группе, у которой в этом слоте стоит «ЭкзС», — исключение:
      // занятие настоящее (преподаватель его ведёт), но в сетке группы места нет,
      // и раньше оно пропадало. Сохраняем его вне сетки, в «Не размещённых».
      let orphan = false;
      if (l.teacherOnly) {
        if (!foreignGroupsOnly(l)) {
          if (!onGroupSession(l)) continue;
          orphan = true;
          sessionOrphans += 1;
        } else {
          teacherOnlyAdded += 1;
        }
      }
      const rms = roomsArr(l); // 1 или 2 аудитории
      const info = insLesson.run(
        l.day,
        l.pairNo,
        l.timeStart,
        l.timeEnd,
        l.weekNo,
        l.subject,
        l.type,
        l.topic || null,
        teacherId(l.teacher),
        roomId(rms[0] || null), // основная аудитория = первая
        category,
        orphan ? 1 : 0, // вне сетки (как буфер) — иначе занятие встало бы поверх сессии
        orphan ? 1 : 0
      );
      const lid = Number(info.lastInsertRowid);
      for (const g of l.groups) insLG.run(lid, groupId(g));
      // Все аудитории занятия (1 или 2) — в lesson_rooms.
      for (const rm of rms) insLR.run(lid, roomId(rm));
      // Учитываем добавленное и в индексе — на случай дублей внутри одного импорта.
      if (mode === 'merge') {
        const row = { id: lid, type: l.type, topic: l.topic, category, orphan: orphan ? 1 : 0, teacherId: l.teacher ? 1 : null, rooms: rms, course: l.course || '' };
        existing.set(slotKey(l), row);
        const ck = coreKeyOf(l);
        if (!existingByCore.has(ck)) existingByCore.set(ck, []);
        existingByCore.get(ck).push(row);
      }
      lessonsAdded += 1;
    }

    // Легенда видов занятий: merge — дополняем существующую, replace — заменяем.
    const legend =
      mode === 'merge' ? { ...getTypeLegend(db), ...(merged.legend || {}) } : merged.legend || {};
    setTypeLegend(legend, db);

    // Таблицы дисциплин по группам: merge — обновляем записи переимпортированных
    // групп (прочие сохраняются), replace — начинаем с чистого листа.
    const prevGS = mode === 'merge' ? getGroupSubjects(db) : {};
    const gs = { ...prevGS, ...(merged.groupSubjects || {}) };
    fillReportsFromPlan(db, gs, Object.keys(merged.groupSubjects || {}));
    setGroupSubjects(gs, db);

    // Выходные/нерабочие дни из ячеек «Вых»: merge — объединяем с уже заданными
    // (в т.ч. внесёнными вручную), replace — берём только из импортируемых файлов.
    const importedHolidays = merged.holidays || [];
    if (importedHolidays.length || mode === 'replace') {
      const prevHol = mode === 'merge' ? getHolidays(db) : [];
      const allHol = [...new Set([...prevHol, ...importedHolidays])].sort();
      setHolidays(allHol, db);
      merged.report.holidaysAdded = allHol.length - (mode === 'merge' ? prevHol.length : 0);
    }

    merged.report.mode = mode;
    merged.report.lessonsAdded = lessonsAdded;
    merged.report.lessonsMatched = lessonsMatched;
    merged.report.groupsAdded = groupsAdded;
    merged.report.teacherOnlyAdded = teacherOnlyAdded;
    merged.report.sessionOrphans = sessionOrphans;
  });
}

module.exports = { mergeSchedules, importFiles, slotKey, bestTeacherOffset, applyAliasesToDb };
