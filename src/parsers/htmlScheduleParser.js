'use strict';

// =====================================================================
// Парсер HTML-расписания (1С-экспорт). Преобразует один файл в плоский
// список занятий + справочник дисциплин. В БД не пишет (это делает Этап 2).
//
// РАСКЛАДКА 3 СТРОК ЯЧЕЙКИ РАЗНАЯ по типам файлов (подтверждено по примерам):
//   • группа (823):        [тип/прим., предмет,  аудитория]  ["Л/ВВ.","РОРТ","430-7"]
//   • аудитория (401А-7):  [тип,       группа,   предмет]    ["П","822","НИР"]
//   • преподаватель (Бул): [аудитория, группа,   предмет]    ["414-7","821/11","УЭКС"]
// Данные взаимодополняющие: тип — у группы/аудитории; аудитория — у группы/
// преподавателя; группы — у аудитории/преподавателя; предмет — везде.
// Сборка единого источника из трёх файлов — на Этапе 2 (importService).
// =====================================================================

const { parse } = require('node-html-parser');
const { decodeBuffer, clean, teacherFio, normalizeGroup, normalizeRoom } = require('../utils/helpers');
const { DAYS, FILE_KIND } = require('../utils/constants');

// Токены в позиции «предмета», которые НЕ являются занятием, а отмечают
// нерабочий слот (выходной). Такие ячейки пропускаем.
const DAY_OFF_TOKENS = new Set(['Вых']);

/**
 * Разбирает один HTML-файл расписания (группы/преподавателя/аудитории).
 * @param {Buffer|string} input сырое содержимое файла
 * @param {string} [kindHint] подсказка типа: 'group' | 'teacher' | 'room'
 * @returns {{kind, owner, year, semester, faculty, weeks, lessons, subjects}}
 */
function parseSchedule(input, kindHint) {
  const html = decodeBuffer(input);
  const root = parse(html, { blockTextElements: {} });

  const header = parseHeader(root, kindHint);
  const grid = findGridTable(root);
  const weeks = grid ? parseWeekColumns(grid) : [];
  const { lessons, daysOff } = grid ? parseDayRows(grid, weeks, header) : { lessons: [], daysOff: [] };
  const subjects = parseSubjectsTable(root);
  const legend = parseTypeLegend(root);
  // Реальная дата 1-й недели (понедельник) — для выравнивания групп с разным
  // началом семестра (см. importService.autoOffset). verified — дата прошла
  // диагональную проверку по сетке дат (см. parseFirstWeekDate).
  const fw = grid ? parseFirstWeekDate(grid, header) : null;
  const firstDate = fw ? fw.date : null;
  const firstDateVerified = Boolean(fw && fw.verified);
  // Нерабочие даты (ISO) из ячеек «Вых»: реальная дата = понедельник 1-й недели
  // + (номер колонки × 7) + индекс дня. Не зависит от сдвига недель при импорте.
  const holidays = daysOffToDates(daysOff, firstDate);

  return { ...header, weeks, lessons, subjects, legend, firstDate, firstDateVerified, holidays };
}

// Список уникальных ISO-дат нерабочих дней из собранных ячеек «Вых».
function daysOffToDates(daysOff, firstDate) {
  if (!firstDate || !daysOff.length) return [];
  const base = new Date(firstDate + 'T00:00:00Z');
  if (Number.isNaN(base.getTime())) return [];
  const out = new Set();
  for (const { day, col } of daysOff) {
    const idx = DAYS.indexOf(day);
    if (idx < 0) continue;
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + col * 7 + idx);
    out.add(d.toISOString().slice(0, 10));
  }
  return [...out].sort();
}

const MONTHS = {
  январь: 1, февраль: 2, март: 3, апрель: 4, май: 5, июнь: 6,
  июль: 7, август: 8, сентябрь: 9, октябрь: 10, ноябрь: 11, декабрь: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Дата (ISO yyyy-mm-dd) понедельника 1-й недели из строк «Месяц» и «Даты».
// Эти строки есть в 1С-экспорте: «Месяц» — список месяцев, «Даты» (по одной на
// каждый день недели Пн..Сб) — число месяца этого дня по неделям. null — если
// дат нет в файле. Возвращает { date, verified }: verified=true, когда дата
// подтверждена диагональной проверкой (до 5 якорей: вт нед.2, ср нед.3, …
// сб нед.6 — все сходятся с календарём). Неподтверждённая дата тоже
// возвращается, но импорт помечает её предупреждением (см. importFiles).
function parseFirstWeekDate(grid, header) {
  const rows = directRows(grid);
  const monthRow = rows.find((r) => directCells(r).some((td) => /Месяц/i.test(td.text)));
  // Строки «Даты» идут по дням недели: [0]=Пн, [1]=Вт, [2]=Ср, …
  const dateRows = rows.filter((r) => directCells(r).some((td) => /^\s*Даты\s*$/i.test(td.text)));
  if (!monthRow || !dateRows.length) return null;

  const firstMonth = directCells(monthRow).slice(3).map((td) => clean(td.text)).find(Boolean);
  // Числа дня по неделям (1, 2, …) для строки «Даты» weekdayIdx. NaN — пустая.
  const dayNums = (weekdayIdx) => {
    const row = dateRows[weekdayIdx];
    if (!row) return [];
    return directCells(row).slice(3).map((td) => parseInt(clean(td.text), 10));
  };
  const mon = dayNums(0); // понедельники по неделям
  const labelMonth = firstMonth ? MONTHS[firstMonth.toLowerCase()] : null;
  const day = mon[0]; // понедельник недели 1
  if (!labelMonth || !Number.isFinite(day)) return null;

  const years = (header.year || '').match(/(\d{4})\/(\d{4})/);
  if (!years) return null;
  // Месяцы первой половины учебного года — первый год пары, второй половины —
  // второй. Граница зависит от семестра: осенний может НАЧИНАТЬСЯ в конце
  // августа (авг → первый год), а весенний — заканчиваться в августе
  // (авг → второй год). Диагональная проверка год не различает (числа месяца
  // совпадают в любом невисокосном сдвиге), поэтому ошибка здесь уводила
  // осенние файлы на год вперёд.
  const pivotMonth = header.semester === 'осенний' ? 8 : 9;
  const yearOf = (m) => (m >= pivotMonth ? Number(years[1]) : Number(years[2]));

  // Подпись месяца первой колонки в 1С-экспорте бывает сдвинута (стоит «Март»,
  // хотя колонка относится к концу февраля). Числа же верны и идут с шагом 7
  // дней по неделям. Поэтому месяц недели 1 берём такой, при котором даты
  // согласуются с календарём. Якоря — ПО ДИАГОНАЛИ сетки дат: вт недели 2,
  // ср недели 3, чт недели 4 … (день недели i + неделя i+1). Смещение от
  // понедельника недели 1 = i·7 (недели) + i (день) = i·8.
  const anchors = [];
  for (let i = 1; i < dateRows.length; i += 1) {
    const expected = dayNums(i)[i]; // строка дня i, колонка недели i+1
    if (Number.isFinite(expected)) anchors.push({ offset: i * 8, expected });
  }

  const monthFits = (m) => {
    if (!anchors.length) return true; // нечем проверить — доверяем подписи
    return anchors.every((a) => {
      const d = new Date(Date.UTC(yearOf(m), m - 1, day));
      d.setUTCDate(d.getUTCDate() + a.offset);
      return d.getUTCDate() === a.expected;
    });
  };
  let month = labelMonth;
  if (!monthFits(month)) {
    const prev = month === 1 ? 12 : month - 1;
    if (monthFits(prev)) month = prev;
  }
  // Дата подтверждена, только если якорей хотя бы два и ВСЕ сходятся. Один
  // якорь может совпасть случайно; ноль якорей — проверять нечем.
  const verified = anchors.length >= 2 && monthFits(month);
  return { date: `${yearOf(month)}-${pad2(month)}-${pad2(day)}`, verified };
}

/* ----------------------------- Шапка ----------------------------- */

function parseHeader(root, kindHint) {
  const text = clean(root.text);

  let kind = kindHint || null;
  let owner = null;

  const group = text.match(/Учебная группа\s+([^\s<]+)/i);
  const teacher = text.match(/Преподаватель:\s*([^]+?)\s+Семестр/i);
  // Файл аудитории: «Загрузка учебной аудитории 401А-7 ... на весенний семестр».
  const room =
    text.match(/Загрузка учебной аудитории\s+([^\s<]+)/i) || text.match(/Аудитория\s+([^\s<]+)/i);

  if (!kind) {
    if (group) kind = FILE_KIND.GROUP;
    else if (teacher) kind = FILE_KIND.TEACHER;
    else if (room) kind = FILE_KIND.ROOM;
  }
  if (kind === FILE_KIND.GROUP && group) owner = normalizeGroup(group[1]);
  else if (kind === FILE_KIND.TEACHER && teacher) owner = teacherFio(teacher[1]); // только ФИО
  else if (kind === FILE_KIND.ROOM && room) owner = normalizeRoom(room[1]);
  else owner = clean((group && group[1]) || (teacher && teacher[1]) || (room && room[1]) || '');

  const yearMatch = text.match(/(\d{4})\/(\d{4})\s+учебный год/);
  const semester = /весенн/i.test(text) ? 'весенний' : /осенн/i.test(text) ? 'осенний' : null;
  const faculty = (text.match(/Факультет\s+([^\s]+)/i) || [])[1] || null;

  return {
    kind,
    owner,
    year: yearMatch ? `${yearMatch[1]}/${yearMatch[2]}` : null,
    semester,
    faculty: faculty ? clean(faculty) : null,
  };
}

/* ----------------------------- Сетка ----------------------------- */

// Основная таблица расписания — та, где больше всего строк.
function findGridTable(root) {
  let best = null;
  let bestRows = 0;
  for (const t of root.querySelectorAll('table')) {
    const n = directRows(t).length;
    if (n > bestRows) {
      bestRows = n;
      best = t;
    }
  }
  return best;
}

function directRows(table) {
  return table.querySelectorAll(':scope > tr');
}

function directCells(tr) {
  return tr.querySelectorAll(':scope > td');
}

// Колонки недель: строка «Уч. недели» — номера недель. Даты НЕ извлекаем —
// они задаются вручную через настройку семестра (см. utils/calendar.js).
function parseWeekColumns(grid) {
  const rows = directRows(grid);
  const weekRow = rows.find((r) => directCells(r).some((td) => /Уч\.?\s*недели/i.test(td.text)));
  if (!weekRow) return [];

  return directCells(weekRow)
    .slice(3)
    .map((td) => clean(td.text))
    .map((w, i) => ({ col: i, weekNo: /^\d+$/.test(w) ? Number(w) : null }));
}

// Обход строк дней. День занимает 4 строки (rowspan=4): первая строка дня
// содержит ячейку дня, остальные — нет. Число колонок-недель постоянно, поэтому
// «ведущие» служебные ячейки = всего ячеек − число недель.
function parseDayRows(grid, weeks, header) {
  const numWeeks = weeks.length;
  const lessons = [];
  const daysOff = []; // { day, col } — ячейки «Вых» (для расчёта нерабочих дат; сама метка при этом остаётся в сетке)
  let currentDay = null;
  let pairInDay = 0;

  for (const tr of directRows(grid)) {
    const tds = directCells(tr);
    const leading = tds.length - numWeeks;
    if (numWeeks === 0 || leading < 2 || leading > 3) continue; // не строка-день

    const firstText = clean(tds[0].text);
    const isDayStart = DAYS.includes(firstText);

    // Ячейка времени отличает настоящую строку-пару от повторных служебных
    // строк («Даты», «Месяц»), которые в некоторых файлах вставлены между днями.
    const pairLabel = clean(tds[leading - 2].text);
    const time = clean(tds[leading - 1].text);
    const [timeStart, timeEnd] = splitTime(time);
    if (!timeStart) continue; // не строка-пара — пропускаем, счётчик не трогаем

    if (isDayStart) {
      currentDay = firstText;
      pairInDay = 0;
    } else if (currentDay === null) {
      continue; // ещё не начались дни
    }
    pairInDay += 1;

    const weekCells = tds.slice(leading);

    weekCells.forEach((td, i) => {
      const week = weeks[i];
      const cell = parseCell(td, header);
      if (!cell) return;
      if (cell.__dayOff) {
        delete cell.__dayOff; // служебный флаг в занятие не переносим
        daysOff.push({ day: currentDay, col: i });
      }
      lessons.push({
        fileKind: header.kind,
        owner: header.owner,
        day: currentDay,
        pairNo: pairInDay,
        pairLabel,
        timeStart,
        timeEnd,
        weekNo: week ? week.weekNo : null,
        ...cell,
      });
    });
  }
  return { lessons, daysOff };
}

function splitTime(time) {
  const m = time.match(/([\d.:]+)\s*-\s*([\d.:]+)/);
  return m ? [m[1], m[2]] : [null, null];
}

// -----------------------------------------------------------------------
// Нормализация типа занятия по обозначениям экзамена / зачёта с оценкой.
// Если тип или тема совпадают с паттерном экзамена — тема очищается, тип
// заменяется на 'Экз'. Аналогично для зачёта с оценкой → 'ЗО'.
// Работает поверх уже разобранных полей { type, topic }.
// -----------------------------------------------------------------------
const EXAM_RE = /^(э\/э|экз\.?|экзамен(\/экзамен)?)$/i;
// Зачёт приходит из 1С в разных написаниях: «ЗО», «ЗЧ», «ЗЧ/ЗАЧЕТ», «ЗАЧЁТ».
// В сетке вуза все они означают одну форму контроля — приводим к «ЗО» без темы.
const CREDIT_WORD = String.raw`(зо|зч|зач[её]т)`;
const GRADED_CREDIT_RE = new RegExp(`^${CREDIT_WORD}(/${CREDIT_WORD})?\\.?$`, 'i');
// Практическое занятие в файлах обозначают «П», в учебных планах и справочниках —
// «ПЗ». Это один вид занятия: канонический код — «ПЗ» (тема сохраняется).
const PRACTICE_RE = /^(п|пз)\.?$/i;

function normalizeType(type, topic) {
  const candidate = type || '';
  const topicCandidate = topic || '';

  // Проверяем тип занятия
  if (EXAM_RE.test(candidate) || EXAM_RE.test(topicCandidate)) {
    return { type: 'Экз', topic: null };
  }
  if (GRADED_CREDIT_RE.test(candidate) || GRADED_CREDIT_RE.test(topicCandidate)) {
    return { type: 'ЗО', topic: null };
  }

  // Проверяем составной вид «тип/тема»: если тема — обозначение экзамена/ЗО
  if (EXAM_RE.test(topicCandidate)) return { type: 'Экз', topic: null };
  if (GRADED_CREDIT_RE.test(topicCandidate)) return { type: 'ЗО', topic: null };

  if (PRACTICE_RE.test(candidate)) return { type: 'ПЗ', topic };

  return { type, topic };
}

// Содержимое ячейки-занятия: вложенная таблица из 3 строк. Раскладка строк
// РАЗНАЯ по типу файла (подтверждено по примерам):
//   группа:        [тип/прим., предмет,  аудитория]
//   аудитория:     [тип,       группа,   предмет]
//   преподаватель: [аудитория, группа,   предмет]
function parseCell(td, header) {
  const inner = td.querySelector('table');
  const lines = inner ? directRows(inner).map((r) => clean(r.text)) : [clean(td.text)];
  const [l1 = '', l2 = '', l3 = ''] = lines;

  if (!l1 && !l2 && !l3) return null; // свободное окно

  // Маркер-мероприятие (УМО, Отп, ЭкзС, Вых, практика, сессия и т. п.): только средняя
  // строка, без аудитории. Это НЕ занятие, а дополнительное мероприятие из
  // «Обозначений видов занятий»: своя категория 'event'. В сетке показывается
  // отдельным стилем, но из проверок накладок/вместимости/статистики исключается.
  // Владелец (группа/преподаватель/аудитория) зависит от типа файла.
  if (!l1 && !l3 && l2) {
    const base = { category: 'event', isMarker: true, marker: l2, type: null, topic: null, subject: l2 };
    // Выходной (Вых) — такая же метка в сетке, как Отп/УМО (идёт в выгрузку и
    // гостям), но ещё и отметка нерабочего дня: parseDayRows заберёт из неё дату
    // для списка нерабочих дат (см. daysOffToDates).
    if (DAY_OFF_TOKENS.has(l2)) base.__dayOff = true;
    if (header.kind === FILE_KIND.TEACHER) return { ...base, groups: [], rooms: [], teacher: header.owner };
    if (header.kind === FILE_KIND.ROOM) return { ...base, groups: [], rooms: header.owner ? [header.owner] : [] };
    return { ...base, groups: header.owner ? [header.owner] : [], rooms: [] };
  }

  if (header.kind === FILE_KIND.TEACHER) {
    // [аудитория(и), группа(ы), предмет]; тип в файле преподавателя не указан.
    // l1 может содержать несколько аудиторий через запятую (напр. «430-7, 435-7»).
    return {
      category: 'lesson',
      type: null,
      topic: null,
      subject: l3 || null,
      groups: splitGroups(l2),
      rooms: splitRooms(l1),
      teacher: header.owner,
    };
  }

  if (header.kind === FILE_KIND.ROOM) {
    // [тип, группа(ы), предмет]; аудитория — владелец файла (одна, из имени файла).
    const normalized = normalizeType(l1 || null, null);
    return {
      category: 'lesson',
      type: normalized.type,
      topic: normalized.topic,
      subject: l3 || null,
      groups: splitGroups(l2),
      rooms: header.owner ? [header.owner] : [],
    };
  }

  // Файл группы (и по умолчанию): [тип/тема, предмет, аудитория].
  // В 1-й строке после «/» стоит тема занятия (напр. «Л/Т.1» → тип Л, тема Т.1).
  // l3 (аудитория) может содержать несколько аудиторий через запятую.
  const [typeRaw, ...topicParts] = l1.split('/');
  const rawType = clean(typeRaw) || null;
  const rawTopic = normalizeTopic(clean(topicParts.join('/'))) || null;
  const normalized = normalizeType(rawType, rawTopic);

  // При Экз/ЗО обнуляется только тема (topic), дисциплина (subject) сохраняется.
  return {
    category: 'lesson',
    type: normalized.type,
    topic: normalized.topic,
    subject: l2 || null,
    groups: header.owner ? [header.owner] : [],
    rooms: splitRooms(l3),
  };
}

// Канонизирует тему занятия к виду «Т.N»: «Тема 9», «тема 9», «Т9», «Т. 9»,
// «Т.9» → «Т.9». Прочие темы (ВВ, ЗАКЛ, и т. п.) оставляем как есть.
function normalizeTopic(text) {
  if (!text) return text;
  const m = String(text).match(/^(?:Тема|Т)\.?\s*(\d+)$/i);
  return m ? `Т.${m[1]}` : text;
}

function splitGroups(text) {
  return text ? text.split(/[,;]/).map(normalizeGroup).filter(Boolean) : [];
}

function splitRooms(text) {
  if (!text) return [];
  return text.split(/[,;]/).map(normalizeRoom).filter(Boolean);
}


/* ------------------- Подвал: таблица дисциплин ------------------- */

// Таблица с заголовком «Дисциплина»/«Обозн». Возвращает map: аббревиатура →
// { fullName, dept, lecturers[], others[], lecturerText, othersText, hours, report }.
function parseSubjectsTable(root) {
  const table = root
    .querySelectorAll('table')
    .find((t) => /Дисциплина/i.test(t.text) && /Обозн/i.test(t.text));
  const out = {};
  if (!table) return out;

  for (const tr of directRows(table)) {
    const cells = directCells(tr).map((td) => clean(td.text));
    const abbr = cells[0];
    if (!abbr) continue;
    if (/Обозн|^вид$/i.test(abbr)) continue; // заголовочные строки
    const fullName = cells[1] || null;
    if (!fullName) continue;
    out[abbr] = {
      abbr,
      fullName,
      dept: cells[2] || null,
      lecturers: splitTeachers(cells[3]),
      others: splitTeachers(cells[4]),
      // Сырой текст столбцов подвала — для отображения/редактирования в админке
      // (с учёной степенью/званием, как в файле).
      lecturerText: cells[3] || null,
      othersText: cells[4] || null,
      hours: cells[5] || null,
      // Форма отчётности: зачёт в файлах пишут «ЗЧ»/«ЗАЧЕТ», в сетке вуза это то
      // же, что «ЗО» (см. GRADED_CREDIT_RE). Экзамен («Э») не трогаем.
      report: normalizeReport(cells[6]),
    };
  }
  return out;
}

// Форма отчётности из подвала: все написания зачёта → «ЗО», прочее как есть.
function normalizeReport(text) {
  const v = String(text || '').trim();
  if (!v) return null;
  return GRADED_CREDIT_RE.test(v) ? 'ЗО' : v;
}

function splitTeachers(text) {
  if (!text) return [];
  // По подгруппам разделены «;»; от каждого оставляем только ФИО.
  return text.split(';').map(teacherFio).filter(Boolean);
}

/* ----------- Подвал: легенда сокращений видов занятий ----------- */

// Таблица «Обозначения видов занятий». Каждая ячейка — «код<пробелы>название»
// (код отделён несколькими &nbsp;). Возвращает map { код: полное название }.
// При дубле кода («л» = лекция и лабораторные) оставляем ПЕРВое вхождение.
function parseTypeLegend(root) {
  const table = root
    .querySelectorAll('table')
    .find((t) => /Обозначени[яй]\s+видов\s+занятий/i.test(t.text));
  const out = {};
  if (!table) return out;

  for (const tr of directRows(table)) {
    for (const td of directCells(tr)) {
      const raw = td.innerHTML.replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/[\t\r\n]+/g, ' ');
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      if (!collapsed || /Обозначени|Другие обознач/i.test(collapsed)) continue;
      // Код отделён от названия серией пробелов (бывшие &nbsp;).
      const parts = raw.split(/ {2,}/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      // «п» в легенде — тот же вид, что «ПЗ» в сетке (см. PRACTICE_RE).
      const raw0 = parts[0].replace(/[.,]+$/, '');
      const code = PRACTICE_RE.test(raw0) ? 'ПЗ' : raw0;
      const name = parts.slice(1).join(' ').trim();
      if (code && name && !out[code]) out[code] = name;
    }
  }
  return out;
}

module.exports = { parseSchedule, parseHeader, parseSubjectsTable, parseTypeLegend };
