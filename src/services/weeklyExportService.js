'use strict';

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { getSummary } = require('./scheduleService');
const { loadLessons } = require('./conflictService');
const { getSemester, getCourses } = require('./settingsService');
const { getDb } = require('../config/database');
const { week1Monday, weekCount } = require('../utils/calendar');

const TEMPLATE_PATH = path.join(__dirname, '../../Еженедельное расписание/Образец.xlsx');

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Структура шаблона: строка заголовков дня → первая строка пар
// Пн строки 4(заг)+5-8(пары), Вт 9+10-13, Ср 14+15-18,
// Чт 19+20-23, Пт 24+25-28, Сб 29+30-32 (3 пары)
const DAY_HEADER_ROW = { Пн: 4, Вт: 9, Ср: 14, Чт: 19, Пт: 24, Сб: 29 };
const MAX_PAIR = { Пн: 4, Вт: 4, Ср: 4, Чт: 4, Пт: 4, Сб: 3 };
// Строка шаблона с именами учебных групп. Сами КОЛОНКИ не фиксированы: их
// читаем из этой строки (см. groupColumns) — в шаблоне группы добавляют и
// убирают, и жёсткие границы колонок молча теряли крайние столбцы.
const GROUP_ROW = 3;
// Ячейка выбора дисциплины для подсветки (просьба составителя — AI1, колонка 35)
// и скрытая колонка со списком дисциплин: у Excel список ПРЯМО в проверке данных
// ограничен 255 символами, а дисциплин в расписании больше сотни символов.
// Обе — только НАЧАЛЬНЫЕ позиции: групп может стать больше, чем в шаблоне, и
// тогда обе уезжают правее сетки (см. addSubjectPicker).
const SUBJECT_PICK_COL = 35; // AI
const SUBJECT_LIST_COL = 53; // BA — правее любых столбцов групп, колонка скрыта

// Текст ячейки шаблона: exceljs отдаёт строку, число или объект richText
// (Excel так хранит ячейку с разным оформлением внутри — имя группы могли
// подкрасить). Без разбора richText имя превратилось бы в «[object Object]».
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object' && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
  return String(v);
}

// Карта «имя группы → номер колонки» ПО САМОМУ ШАБЛОНУ (строка GROUP_ROW).
function groupColumns(ws) {
  const map = {};
  const last = Math.max(Number(ws.columnCount) || 0, 40);
  for (let col = 1; col <= last; col++) {
    const name = cellText(ws.getCell(GROUP_ROW, col).value).trim();
    if (name) map[name] = col;
  }
  return map;
}

// Буква колонки → номер (A=1, AA=27): объединения exceljs отдаёт строкой
// «D4:AG4», а обратное преобразование у него есть только в ws.getColumn().letter.
const colNum = (s) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
function parseRange(ref) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(ref).trim());
  return m ? { c1: colNum(m[1]), r1: Number(m[2]), c2: colNum(m[3]), r2: Number(m[4]) } : null;
}

/**
 * Подгоняет блок столбцов-групп под фактический список групп: лишние столбцы
 * шаблона стираются (значение, оформление, ширина), недостающие дописываются
 * копией последнего. Столбцы идут подряд, поэтому меняется только правый край.
 * Возвращает карту «группа → колонка».
 *
 * Объединения, доходящие до блока групп (шапка листа, строки дней), снимаются
 * ДО правки ячеек и восстанавливаются по новому краю: у слитой ячейки значение
 * принадлежит «главной», и очистка хвоста стёрла бы название дня.
 */
function fitGroupColumns(ws, groups) {
  const template = groupColumns(ws);
  const cols = Object.values(template).sort((a, b) => a - b);
  // Пустой шаблон или пустая база — трогать нечего, работаем как раньше.
  if (!cols.length || !groups.length) return template;
  const first = cols[0];
  const last = cols[cols.length - 1];
  const newLast = first + groups.length - 1;
  const rows = Math.max(ws.rowCount, GROUP_ROW);

  const spans = [];
  for (const ref of [...(ws.model.merges || [])]) {
    const m = parseRange(ref);
    if (!m || m.c2 < first) continue; // левее блока (день, часы) — не наше
    ws.unMergeCells(ref);
    spans.push(m);
  }

  for (let c = last + 1; c <= newLast; c++) { // групп больше, чем столбцов
    ws.getColumn(c).width = ws.getColumn(last).width;
    for (let r = 1; r <= rows; r++) {
      const cell = ws.getCell(r, c);
      cell.value = null;
      cell.style = ws.getCell(r, last).style;
    }
  }
  for (let c = newLast + 1; c <= last; c++) { // столбцов больше, чем групп
    for (let r = 1; r <= rows; r++) {
      const cell = ws.getCell(r, c);
      cell.value = null;
      cell.style = {};
    }
    ws.getColumn(c).width = undefined;
  }

  for (const m of spans) {
    if (m.c1 > newLast) continue; // объединение целиком за новым краем — не возвращаем
    try {
      ws.mergeCells(m.r1, m.c1, m.r2, Math.max(m.c1, newLast));
    } catch { /* объединение уже на месте */ }
  }

  const map = {};
  groups.forEach((g, i) => {
    map[g] = first + i;
    ws.getCell(GROUP_ROW, first + i).value = g;
  });
  return map;
}

/**
 * Группы для столбцов файла: все незакрытые группы базы, по курсам — тот же
 * порядок, что в сводном на экране. pick — список с экрана (фильтры «Курсы» и
 * «Группы»): чужие и скрытые имена отбрасываем, пустой список = все группы.
 */
function exportGroups(pick) {
  const db = getDb();
  const courses = getCourses(db);
  // Список прислан — он и есть белый список (даже короткий). Отсутствие поля
  // (null) — «все группы»; пустой список до сюда не доходит, его отбивает роут.
  const want = Array.isArray(pick) ? new Set(pick.map((g) => String(g).trim())) : null;
  return db
    .prepare('SELECT name FROM groups WHERE hidden = 0')
    .all()
    .map((r) => r.name)
    .filter((g) => !want || want.has(g))
    .sort(
      (a, b) =>
        (courses[a.slice(0, 2)] ?? 99) - (courses[b.slice(0, 2)] ?? 99) || a.localeCompare(b, 'ru')
    );
}

// Дисциплины расписания для выпадающего списка (мероприятия — не дисциплины).
function subjectList(lessons) {
  return [...new Set(
    lessons
      .filter((l) => !l.event && l.category !== 'event' && l.subject)
      .map((l) => String(l.subject).trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Чистка условного форматирования, пришедшего из шаблона. exceljs читает не все
 * его виды: расширенные (x14) правила он теряет и пишет вместо них пустые
 * `<cfRule priority="N"/>` — без обязательного типа, а у правил «содержит текст»
 * не пишет обязательные operator/text. Excel считает такой файл повреждённым и
 * «восстанавливает» его, ВЫБРАСЫВАЯ всё форматирование — вместе с подсветкой
 * дисциплины. Поэтому пустышки убираем, а «содержит текст» переводим в
 * равнозначное правило-формулу: формула у них уже есть (NOT(ISERROR(SEARCH(…))))
 * и пишется целиком, поведение и цвета те же.
 */
function sanitizeConditionalFormatting(ws) {
  const cleaned = [];
  for (const cf of ws.conditionalFormattings || []) {
    const rules = (cf.rules || []).filter((r) => r && r.type && (r.formulae || []).length);
    for (const r of rules) {
      if (r.type === 'containsText') {
        r.type = 'expression';
        delete r.operator;
        delete r.text;
      }
    }
    if (rules.length) cleaned.push({ ...cf, rules });
  }
  ws.conditionalFormattings = cleaned;
}

/**
 * Выпадающий список дисциплин в AI1 + подсветка занятий выбранной дисциплины.
 * Делается КОДОМ, а не в самом шаблоне: список дисциплин живёт в базе (в шаблоне
 * он бы устарел), а сводное за семестр собирается копированием листа, которое
 * проверки данных и условное форматирование не переносит.
 */
function addSubjectPicker(ws, subjects, groupCols) {
  if (!groupCols.length || !subjects.length) return;

  // Столбцов групп может стать больше, чем в шаблоне: тогда и ячейка выбора, и
  // скрытый список уходят правее сетки, иначе они оказались бы внутри неё.
  const right = Math.max(...groupCols);
  const pickCol = Math.max(SUBJECT_PICK_COL, right + 2);
  const listCol = Math.max(SUBJECT_LIST_COL, pickCol + 2);
  const pickCell = `${ws.getColumn(pickCol).letter}1`;
  const pickAbs = `$${ws.getColumn(pickCol).letter}$1`;

  const letter = ws.getColumn(listCol).letter;
  subjects.forEach((name, i) => { ws.getCell(i + 1, listCol).value = name; });
  ws.getColumn(listCol).hidden = true;

  // Значение ячейки не трогаем: в шаблоне может стоять дисциплина «по умолчанию».
  ws.getCell(pickCell).dataValidation = {
    type: 'list',
    allowBlank: true,
    formulae: [`$${letter}$1:$${letter}$${subjects.length}`],
    showInputMessage: true,
    promptTitle: 'Подсветка дисциплины',
    prompt: 'Выберите дисциплину — её занятия подсветятся в сетке',
  };

  // Сравниваем ПЕРВОЕ слово ячейки (сокращение дисциплины) с выбранным, а не
  // ищем подстроку: «ОТ» иначе подсвечивало бы и «ОТП», и фамилию, и аудиторию.
  // Перевод строки заменяем пробелом — иначе у занятия без вида первое «слово»
  // склеилось бы с фамилией преподавателя со второй строки.
  const first = ws.getColumn(Math.min(...groupCols)).letter;
  const last = ws.getColumn(right).letter;
  const days = Object.entries(DAY_HEADER_ROW);
  const top = Math.min(...days.map(([, r]) => r)) + 1;
  const bottom = Math.max(...days.map(([d, r]) => r + (MAX_PAIR[d] ?? 4)));
  const anchor = `${first}${top}`;
  const plain = `SUBSTITUTE(${anchor},CHAR(10)," ")`;
  ws.addConditionalFormatting({
    ref: `${anchor}:${last}${bottom}`,
    rules: [{
      type: 'expression',
      priority: 1,
      formulae: [`AND(${pickAbs}<>"",LEFT(${plain},FIND(" ",${plain}&" ")-1)=${pickAbs})`],
      style: {
        fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFEB3B' } },
        font: { bold: true },
      },
    }],
  });
}

function fmtDate(d) {
  return `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`;
}

// Читает шаблон недельного расписания. Шаблон лежит рядом с сервером; окно
// выбора здесь открывалось бы НА СЕРВЕРЕ, поэтому его нет — просто говорим,
// какого файла не хватает.
async function openWeeklyTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Не найден шаблон «${path.basename(TEMPLATE_PATH)}» в папке «Еженедельное расписание»`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  return { wb, ws: wb.getWorksheet(1) };
}

// source — занятия опубликованного снимка (выгрузка гостя), иначе живая база.
async function exportWeeklySchedule(weekNo, groups, source = null) {
  const { wb, ws } = await openWeeklyTemplate();
  const semester = fillWeeklySheet(ws, Number(weekNo), source, exportGroups(groups));
  return { buffer: await wb.xlsx.writeBuffer(), filename: weekFileName(Number(weekNo), semester) };
}

/**
 * Сводное расписание за ВЕСЬ семестр: одна неделя — один лист в общем файле.
 * Лист копируется из шаблона поячеечно: exceljs не умеет дублировать готовый
 * лист, а шаблон маленький (97×30), поэтому копия обходится дёшево.
 */
async function exportSemesterSummary(groups) {
  const { ws: src } = await openWeeklyTemplate();
  const semester = getSemester();
  // Список групп один на весь файл: столбцы всех листов должны совпадать.
  const cols = exportGroups(groups);
  const weeks = Math.max(weekCount(semester) || 0, 1);

  // Занятия читаем ОДИН раз на весь файл: 25 недель × полное чтение базы дали бы
  // секунды на пустом месте (см. lessons/2026-08-21-performance-teacher-view).
  const all = loadLessons();
  const out = new ExcelJS.Workbook();
  for (let w = 1; w <= weeks; w++) {
    const ws = cloneSheet(src, out, `Неделя ${w}`);
    fillWeeklySheet(ws, w, all, cols);
  }
  const name = semester && semester.name ? ` ${semester.name}` : '';
  return { buffer: await out.xlsx.writeBuffer(), filename: `Сводное расписание${name}.xlsx`, weeks };
}

// Копия листа шаблона в другую книгу: значения, оформление, ширины столбцов,
// высоты строк и объединения. Формулы копируются как есть (в шаблоне их одна).
function cloneSheet(src, wb, name) {
  const ws = wb.addWorksheet(name, { pageSetup: { ...src.pageSetup } });
  src.columns.forEach((c, i) => {
    if (c && c.width) ws.getColumn(i + 1).width = c.width;
  });
  src.eachRow({ includeEmpty: true }, (row, rowNo) => {
    const dst = ws.getRow(rowNo);
    if (row.height) dst.height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      const d = dst.getCell(colNo);
      d.value = cell.value;
      d.style = cell.style;
    });
  });
  for (const m of (src.model.merges || [])) {
    try { ws.mergeCells(m); } catch { /* объединение уже есть */ }
  }
  return ws;
}

// Заполняет ОДИН лист расписанием указанной недели. Возвращает семестр —
// он нужен вызывающему для имени файла.
function fillWeeklySheet(ws, weekNo, preloaded = null, groups = null) {
  // Все занятия базы: из них берётся неделя (getSummary фильтрует сам) и список
  // дисциплин для выпадающего списка. loadLessons кэширован — лишнего чтения нет.
  const all = preloaded || loadLessons();
  const { lessons, semester } = getSummary(Number(weekNo), undefined, all);

  // Столбцы шаблона приводим к фактическому списку групп: лишние убираем,
  // недостающие дописываем (см. fitGroupColumns).
  const groupColMap = fitGroupColumns(ws, groups || exportGroups(null));
  const groupCols = Object.values(groupColMap);

  // Обновляем строку 2 (B2) — диапазон дат недели
  if (semester?.start) {
    const mon = week1Monday(semester.start);
    if (mon) {
      const monday = new Date(mon.getTime() + (weekNo - 1) * 7 * 86400000);
      const saturday = new Date(monday.getTime() + 5 * 86400000);
      const dateRange = `${fmtDate(monday)} – ${fmtDate(saturday)} ${saturday.getUTCFullYear()} г.`;
      ws.getCell('B2').value = dateRange;

      // Обновляем дату в заголовке каждого дня (колонка D)
      const DAYS_ORDER = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      DAYS_ORDER.forEach((day, idx) => {
        const headerRow = DAY_HEADER_ROW[day];
        if (!headerRow) return;
        const dayDate = new Date(monday.getTime() + idx * 86400000);
        ws.getCell(headerRow, 4).value = fmtDate(dayDate);
      });
    }
  }

  // Очищаем ячейки с занятиями (колонки групп × все строки пар)
  for (const [day, headerRow] of Object.entries(DAY_HEADER_ROW)) {
    const maxP = MAX_PAIR[day];
    for (let p = 1; p <= maxP; p++) {
      for (const col of groupCols) ws.getCell(headerRow + p, col).value = null;
    }
  }

  // Заполняем занятиями
  for (const lesson of lessons) {
    const { day, pairNo, subject, type, teachers, rooms, groups, category } = lesson;
    const headerRow = DAY_HEADER_ROW[day];
    if (!headerRow) continue;
    if (pairNo > (MAX_PAIR[day] ?? 4)) continue;

    // Мероприятие (Отп, ОП…) несёт метку, а метка сессии «ЭкзС» — ещё и
    // аудиторию (её проставляет расстановка СР): пишем обе строки по центру.
    // Занятие — три строки: «дисциплина тип», преподаватель, аудитория (сверху).
    const isEvent = category === 'event';
    let text, alignment;
    if (isEvent) {
      text = [subject || '', rooms?.length ? rooms.join('/') : ''].filter(Boolean).join('\n');
      alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    } else {
      const parts = [`${subject}${type ? ' ' + type : ''}`];
      if (teachers?.length) parts.push(teachers.join(', '));
      if (rooms?.length) parts.push(rooms.join('/'));
      text = parts.join('\n');
      alignment = { wrapText: true, vertical: 'top' };
    }

    for (const group of groups ?? []) {
      const col = groupColMap[group];
      if (!col) continue;
      const cell = ws.getCell(headerRow + pairNo, col);
      cell.value = text;
      cell.alignment = alignment;
      if (isEvent) cell.font = { italic: true };
    }
  }

  sanitizeConditionalFormatting(ws);
  addSubjectPicker(ws, subjectList(all), groupCols);

  return semester;
}

// Имя файла недели: «29 июня - 05 июля 2026.xlsx».
function weekFileName(weekNo, semester) {
  const mon = semester && semester.start ? week1Monday(semester.start) : null;
  if (!mon) return `неделя-${weekNo}.xlsx`;
  const monday = new Date(mon.getTime() + (weekNo - 1) * 7 * 86400000);
  const saturday = new Date(monday.getTime() + 5 * 86400000);
  return `${fmtDate(monday)} - ${fmtDate(saturday)} ${saturday.getUTCFullYear()}.xlsx`;
}

module.exports = { exportWeeklySchedule, exportSemesterSummary };
