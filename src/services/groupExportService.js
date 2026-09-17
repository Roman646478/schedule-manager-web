'use strict';

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { getView, listEntities } = require('./scheduleService');
const { getGroupSubjects, getCourses, getSemester } = require('./settingsService');
const { week1Monday, weekCount } = require('../utils/calendar');
const { PAIR_TIMES } = require('../utils/constants');
const { pairHours } = require(path.join(__dirname, '..', '..', 'public', 'js', 'shared-constants.js'));
const JSZip = require('jszip');

// Месяцы в именительном падеже — как в шапке образца (строка 5).
const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTH_ROW = 5; // строка месяцев (по неделям)
const DAY_ORDER = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const TEMPLATE_PATH = path.join(__dirname, '../../Расписание группы/Образец группа.xlsx');

// Раскладка шаблона «Расписание группы/Образец группа.xlsx» (сверено с
// «заполненая пример.xlsx» — вёрстка листов совпадает, различается только число
// столбцов недель).
// Столбцы — недели: неделя 1 → колонка D(4). Сколько их в шаблоне — считаем по
// строке 4; если семестр длиннее, столбцы дописываются (см. ensureWeekColumns).
const WEEK_COL_START = 4; // D = неделя 1
const WEEK_ROW = 4; // строка номеров недель
// Первая строка КАЖДОГО дня. Пара занимает 3 строки (вид/тема, дисциплина,
// аудитория) — как три строки ячейки в исходном HTML. Строка дат дня — на 1 выше
// первой (6, 19, 32, 45, 58, 71).
const DAY_FIRST_ROW = { Пн: 7, Вт: 20, Ср: 33, Чт: 46, Пт: 59, Сб: 72 };
const ROWS_PER_PAIR = 3;
const MAX_PAIR = { Пн: 4, Вт: 4, Ср: 4, Чт: 4, Пт: 4, Сб: 3 };
// Таблица дисциплин внизу: строки данных (шапка 85–87) и колонки.
const LEGEND_FIRST_ROW = 88;
const LEGEND_LAST_TEMPLATE_ROW = 103; // до этой строки в шаблоне уже есть объединения
const LEGEND_COL = { abbr: 1, full: 2, dept: 9, lecturer: 10, others: 15, hours: 24, report: 25 };

const groupPrefix = (name) => String(name || '').slice(0, 2);
// Имя файла/листа без недопустимых для Excel символов.
const safeName = (s) => String(s || '').replace(/[\\/:*?[\]]/g, '-').trim();

// Три строки ячейки — как в сетке вида «группа» и в образце: «тип/тема»,
// дисциплина, аудитория. Мероприятие (Вых, Отп, УМО…) — одна метка в средней
// строке, как в заполненном примере. Несколько занятий в слоте не встречаются
// (одна группа — одна пара в слоте), но если появятся — склеиваем через « / ».
function cellLines(lessons) {
  const join = (parts) => [...new Set(parts.filter(Boolean))].join(' / ');
  const rooms = (list) => join(list.map((l) => (l.rooms || []).join(', ')));
  const events = lessons.filter((l) => l.category === 'event');
  // У метки тоже бывает аудитория: группе на сессии («ЭкзС») её проставляет
  // расстановка СР, и в распечатке она нужна так же, как у обычной пары.
  if (events.length) return ['', join(events.map((l) => String(l.subject || '').trim())), rooms(events)];
  return [
    join(lessons.map((l) => (l.topic ? `${l.type || ''}/${l.topic}` : l.type || ''))),
    join(lessons.map((l) => l.subject || '')),
    rooms(lessons),
  ];
}

// То же для расписания преподавателя: во второй строке к дисциплине добавляем
// группы — без них непонятно, кому пара (шаблон один и тот же, строк всё равно три).
function teacherCellLines(lessons) {
  const lines = cellLines(lessons);
  const groups = [...new Set(lessons.flatMap((l) => l.groups || []))].join(', ');
  if (lines[1] && groups) lines[1] = `${lines[1]} (${groups})`;
  return lines;
}

// Открывает шаблон. Окон выбора файла здесь нет — они открывались бы на СЕРВЕРЕ,
// а не на машине, с которой работают (см. пункт про сохранение сетки).
async function openTemplate(templatePath) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Не найден шаблон «${path.basename(templatePath)}» в папке «Расписание группы»`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  return { wb, ws: wb.getWorksheet(1) };
}

// Сетка недель: шапка дат, очистка прежних данных и раскладка занятий по слотам.
// Общая для расписания группы и преподавателя — различаются только текстом ячейки.
function fillGrid(ws, lessons, lines) {
  // Сколько недель выгружаем: длина семестра, но не меньше, чем уже есть в
  // шаблоне (лишние столбцы шаблона просто останутся пустыми).
  const weeks = Math.max(templateWeeks(ws), weekCount(getSemester()) || 0, maxWeekOf(lessons));
  ensureWeekColumns(ws, weeks);

  // Шапка недель: месяцы и даты по дням — пересчёт под активный семестр.
  fillHeaderDates(ws, weeks);

  // 1) Чистим прежние данные сетки (только ячейки недель в строках пар).
  for (const [day, firstRow] of Object.entries(DAY_FIRST_ROW)) {
    for (let r = firstRow; r < firstRow + MAX_PAIR[day] * ROWS_PER_PAIR; r++) {
      for (let col = WEEK_COL_START; col < WEEK_COL_START + weeks; col++) ws.getCell(r, col).value = null;
    }
  }

  // 2) Группируем занятия по слоту (день|пара|неделя) и заполняем.
  const bySlot = new Map();
  for (const l of lessons) {
    if (!DAY_FIRST_ROW[l.day]) continue;
    if (l.pairNo > (MAX_PAIR[l.day] ?? 4)) continue;
    const k = `${l.day}|${l.pairNo}|${l.weekNo}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(l);
  }
  for (const [k, slotLessons] of bySlot) {
    const [day, pairNo, weekNo] = k.split('|');
    // Пара занимает три строки: вид/тема, дисциплина, аудитория.
    const firstRow = DAY_FIRST_ROW[day] + (Number(pairNo) - 1) * ROWS_PER_PAIR;
    const col = WEEK_COL_START + (Number(weekNo) - 1);
    lines(slotLessons).forEach((text, i) => {
      const cell = ws.getCell(firstRow + i, col);
      cell.value = text || null;
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    });
  }
}

// Готовит файл расписания группы и возвращает его СОДЕРЖИМОЕ (buffer): сохраняет
// файл браузер пользователя.
// source — занятия опубликованного снимка (выгрузка гостя), иначе живая база.
async function exportGroupSchedule(group, templatePathOverride = null, source = null) {
  const lessons = getView('group', group, undefined, source).filter((l) => l.weekNo >= 1);
  const { wb, ws } = await openTemplate(templatePathOverride || TEMPLATE_PATH);
  ws.name = safeName(group).slice(0, 31) || 'Группа';

  // Заголовок: номер группы и курс (если известен).
  ws.getCell('J3').value = `Учебная группа ${group}`;
  const course = getCourses()[groupPrefix(group)];
  if (course != null) ws.getCell('J2').value = `${course} курс `;

  fillGrid(ws, lessons, cellLines);

  // Таблица дисциплин из groupSubjects (если есть данные по группе).
  const skippedSubjects = fillLegend(ws, group);
  const warnings = skippedSubjects
    ? [`${group}: в таблицу дисциплин не поместилось ${skippedSubjects} строк(и) — в шаблоне ${LEGEND_LAST_TEMPLATE_ROW - LEGEND_FIRST_ROW + 1}`]
    : [];

  return { buffer: await wb.xlsx.writeBuffer(), filename: `${safeName(group)}.xlsx`, warnings };
}

// Сколько столбцов недель размечено в шаблоне (строка 4: 1, 2, 3…).
function templateWeeks(ws) {
  let n = 0;
  for (let col = WEEK_COL_START; col <= WEEK_COL_START + 60; col++) {
    const v = ws.getCell(WEEK_ROW, col).value;
    if (v == null || String(v).trim() === '') break;
    n++;
  }
  return n;
}

const maxWeekOf = (lessons) => lessons.reduce((m, l) => Math.max(m, Number(l.weekNo) || 0), 0);

// Семестр может быть длиннее шаблона — дописываем недостающие столбцы недель,
// копируя оформление последнего размеченного столбца (границы, шрифт, ширину),
// иначе дописанные недели печатались бы без сетки.
function ensureWeekColumns(ws, weeks) {
  const have = templateWeeks(ws);
  if (weeks <= have) return;
  const srcCol = WEEK_COL_START + have - 1;
  const lastRow = DAY_FIRST_ROW['Сб'] + MAX_PAIR['Сб'] * ROWS_PER_PAIR - 1;
  for (let col = srcCol + 1; col < WEEK_COL_START + weeks; col++) {
    ws.getColumn(col).width = ws.getColumn(srcCol).width;
    for (let r = WEEK_ROW; r <= lastRow; r++) {
      const src = ws.getCell(r, srcCol);
      const dst = ws.getCell(r, col);
      dst.style = { ...src.style };
      dst.value = null;
    }
    ws.getCell(WEEK_ROW, col).value = col - WEEK_COL_START + 1; // номер недели
  }
}

// Пересчитывает шапку недель под активный семестр: строку месяцев (по понедельнику
// недели) и строки дат каждого дня (число месяца) — как в заполненном примере.
// Месяцы в образце объединены по диапазонам: снимаем объединения строки 5, чтобы
// писать по столбцам. Если семестр не задан — оставляем шапку образца как есть.
function fillHeaderDates(ws, weeks) {
  const semester = getSemester();
  const mon1 = semester && semester.start ? week1Monday(semester.start) : null;
  if (!mon1) return;

  // Снять объединения месяцев в строке 5 (диапазоны вида D5:E5).
  for (const range of (ws.model.merges || []).slice()) {
    if (/^[A-Z]+5:[A-Z]+5$/.test(range)) {
      try { ws.unMergeCells(range); } catch { /* уже снято */ }
    }
  }

  for (let w = 1; w <= weeks; w++) {
    const col = WEEK_COL_START + (w - 1);
    DAY_ORDER.forEach((day, idx) => {
      const d = new Date(mon1.getTime());
      d.setUTCDate(d.getUTCDate() + (w - 1) * 7 + idx);
      if (idx === 0) ws.getCell(MONTH_ROW, col).value = MONTHS_NOM[d.getUTCMonth()]; // месяц — по понедельнику
      ws.getCell(DAY_FIRST_ROW[day] - 1, col).value = d.getUTCDate(); // дата = число месяца
    });
  }
}

// Заполняет таблицу дисциплин внизу (строки 88–103): обозначение, дисциплина,
// каф., лектор, другие преподаватели, часы, отчёт. Строк в шаблоне 16 — с запасом
// (у самой большой группы 11 дисциплин). Если их вдруг окажется больше, лишние
// НЕ пишем: ниже идёт легенда видов занятий и подпись начальника факультета,
// затереть их молча хуже, чем не поместить строку. Возвращает число непомещённых.
function fillLegend(ws, group) {
  const subjects = getGroupSubjects()[group] || [];
  const capacity = LEGEND_LAST_TEMPLATE_ROW - LEGEND_FIRST_ROW + 1;

  // Чистим строки данных перед заполнением. Ниже LEGEND_LAST_TEMPLATE_ROW идёт
  // легенда видов занятий и подпись — туда не заходим.
  for (let r = LEGEND_FIRST_ROW; r <= LEGEND_LAST_TEMPLATE_ROW; r++) {
    for (let c = 1; c <= 29; c++) ws.getCell(r, c).value = null;
  }

  subjects.slice(0, capacity).forEach((s, i) => {
    const r = LEGEND_FIRST_ROW + i;
    ws.getCell(r, LEGEND_COL.abbr).value = s.abbr || '';
    ws.getCell(r, LEGEND_COL.full).value = s.fullName || '';
    ws.getCell(r, LEGEND_COL.dept).value = s.dept || '';
    ws.getCell(r, LEGEND_COL.lecturer).value = s.lecturer || '';
    ws.getCell(r, LEGEND_COL.others).value = s.others || '';
    ws.getCell(r, LEGEND_COL.hours).value = s.hours || '';
    ws.getCell(r, LEGEND_COL.report).value = s.report || '';
  });
  return Math.max(0, subjects.length - capacity);
}

// Выгрузка всех видимых групп — по файлу на группу, всё вместе одним zip
// (папку выбрать нельзя: сервер не видит диск пользователя).
async function exportAllGroups() {
  const { groups } = listEntities();
  const zip = new JSZip();
  const warnings = [];
  for (const g of groups) {
    const res = await exportGroupSchedule(g, TEMPLATE_PATH);
    zip.file(res.filename, res.buffer);
    warnings.push(...(res.warnings || []));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, filename: 'Расписания групп.zip', count: groups.length, warnings };
}

// Расписание ОДНОЙ дисциплины по выбранным группам: та же сетка недель, но в
// ячейке вместо дисциплины — группы (дисциплина одна на весь файл и вынесена в
// заголовок). Если в слоте совпали занятия разных групп, строки склеиваются
// через « / » — как и в остальных выгрузках.
//
// pick — выбранные группы. Потоковое занятие идёт сразу нескольким группам, но в
// файле по выбранным группам чужие группы потока не показываем: составителю нужен
// срез именно по своим группам. Пустой pick — показываем всё как есть.
const subjectCellLines = (pick) => (lessons) => {
  const join = (parts) => [...new Set(parts.filter(Boolean))].join(' / ');
  const groupsOf = (l) => (l.groups || []).filter((g) => !pick || !pick.size || pick.has(g));
  return [
    join(lessons.map((l) => (l.topic ? `${l.type || ''}/${l.topic}` : l.type || ''))),
    join(lessons.map((l) => groupsOf(l).join(', '))),
    join(lessons.map((l) => (l.rooms || []).join(', '))),
  ];
};

/**
 * Выгрузка расписания дисциплины. groups — какие учебные группы включить
 * (пустой список = все, у кого эта дисциплина есть).
 */
async function exportSubjectSchedule(subject, groups = [], templatePathOverride = null, source = null) {
  const abbr = String(subject || '').trim();
  if (!abbr) throw new Error('Не указана дисциплина');
  const pick = new Set((groups || []).map((g) => String(g).trim()).filter(Boolean));

  const lessons = getView(null, null, undefined, source)
    .filter((l) => l.weekNo >= 1 && l.category !== 'event' && l.subject === abbr)
    .filter((l) => !pick.size || (l.groups || []).some((g) => pick.has(g)));
  if (!lessons.length) {
    throw new Error(`Занятий по дисциплине «${abbr}»${pick.size ? ' у выбранных групп' : ''} не найдено`);
  }

  const { wb, ws } = await openTemplate(templatePathOverride || TEMPLATE_PATH);
  ws.name = safeName(abbr).slice(0, 31) || 'Дисциплина';

  const shown = [...new Set(lessons.flatMap((l) => (l.groups || []).filter((g) => !pick.size || pick.has(g))))].sort();
  ws.getCell('J3').value = `Дисциплина ${abbr}`;
  ws.getCell('J2').value = `Группы: ${shown.join(', ')}`;

  fillGrid(ws, lessons, subjectCellLines(pick));
  fillLegend(ws, null); // таблица дисциплин группы здесь не нужна

  return { buffer: await wb.xlsx.writeBuffer(), filename: `${safeName(abbr)}.xlsx`, groups: shown };
}

// Какие группы есть у дисциплины — для окна выбора перед выгрузкой.
function subjectGroups(subject) {
  const abbr = String(subject || '').trim();
  if (!abbr) return [];
  const lessons = getView(null, null).filter((l) => l.category !== 'event' && l.subject === abbr);
  return [...new Set(lessons.flatMap((l) => l.groups || []))].sort((a, b) => a.localeCompare(b, 'ru'));
}

// Семестровое расписание преподавателя — по тому же шаблону, что и у группы:
// сетка недель одинаковая, меняются заголовок и текст ячеек. Таблицу дисциплин
// внизу чистим (она про группу), легенда видов занятий под ней остаётся.
async function exportTeacherSchedule(teacher, templatePathOverride = null, source = null) {
  const lessons = getView('teacher', teacher, undefined, source).filter((l) => l.weekNo >= 1);
  const { wb, ws } = await openTemplate(templatePathOverride || TEMPLATE_PATH);
  ws.name = safeName(teacher).slice(0, 31) || 'Преподаватель';

  ws.getCell('J3').value = `Преподаватель ${teacher}`;
  ws.getCell('J2').value = null;

  fillGrid(ws, lessons, teacherCellLines);
  fillLegend(ws, null);
  addTeacherLessonsSheet(wb, lessons);

  return { buffer: await wb.xlsx.writeBuffer(), filename: `${safeName(teacher)}.xlsx` };
}

// Второй лист файла преподавателя: построчный перечень занятий (одна строка —
// одно занятие). Столбцы те же, что в свёрнутой таблице под сеткой в интерфейсе
// (TEACHER_ROW_COLS в public/js/admin.js) — держать их согласованными.
const TEACHER_ROW_COLS = [
  { title: '№', width: 5 },
  { title: 'Нед.', width: 6 },
  { title: 'Дата', width: 9 },
  { title: 'День', width: 7 },
  { title: 'Пара', width: 7 },
  { title: 'Время', width: 13 },
  { title: 'Дисциплина', width: 14 },
  { title: 'Вид', width: 7 },
  { title: 'Тема', width: 28 },
  { title: 'Группы', width: 20 },
  { title: 'Аудитории', width: 16 },
  { title: 'Преподаватели', width: 24 },
  { title: 'Примечание', width: 30 },
];

function addTeacherLessonsSheet(wb, lessons) {
  // Мероприятия и СР в перечень не идут — только учебные пары (как в интерфейсе).
  const rows = lessons
    .filter((l) => l.category !== 'event' && l.subject && l.subject !== 'СР')
    .sort((a, b) => a.weekNo - b.weekNo || DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.pairNo - b.pairNo);

  const ws = wb.addWorksheet('Занятия');
  // Перечень должен быть ВТОРЫМ листом файла: сетка первая, служебный «Лист2»
  // шаблона (вспомогательный календарь автора образца) уезжает за ним.
  const others = wb.worksheets.filter((w) => w !== ws);
  if (others.length) others[0].orderNo = 0;
  ws.orderNo = 1;
  others.slice(1).forEach((w, i) => { w.orderNo = i + 2; });

  ws.columns = TEACHER_ROW_COLS.map((c) => ({ header: c.title, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }]; // шапка не уезжает при прокрутке

  rows.forEach((l, i) => {
    const times = PAIR_TIMES[l.pairNo] || {};
    ws.addRow([
      i + 1,
      l.weekNo,
      l.date || '', // «дд.мм» — считается из семестра (loadLessons)
      l.day,
      pairHours(l.pairNo),
      times.start && times.end ? `${times.start}-${times.end}` : '',
      l.subject || '',
      l.type || '',
      l.topic || '',
      (l.groups || []).join(', '),
      (l.rooms || []).join(', '),
      (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : [])).join(', '),
      l.note || '',
    ]);
  });

  // Рамки и перенос текста в длинных столбцах — лист печатается как есть.
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
  });
  return ws;
}

module.exports = { exportGroupSchedule, exportAllGroups, exportTeacherSchedule, exportSubjectSchedule, subjectGroups };
