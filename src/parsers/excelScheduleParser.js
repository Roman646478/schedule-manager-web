'use strict';

const ExcelJS = require('exceljs');
const { FILE_KIND, DAYS } = require('../utils/constants');
const { normalizeRoom } = require('../utils/helpers');

const clean = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const linesOf = (value) => String(value ?? '').split(/\r?\n/).map(clean);
function cellText(cell) {
  try { return cell.text || ''; } catch { return ''; }
}
const DAY_OFF = new Set(['Вых']);
const EVENT = /^(Вых|ЭПр|СР|ЭкзС|УМО|ОП|Отп|Практика|Сессия)$/i;

function topicOf(value) {
  const text = clean(value);
  const m = text.match(/^(?:Тема|Т)\.?\s*(\d+)\.?$/i);
  return m ? `Т.${m[1]}` : text || null;
}

function typeOf(value, topic) {
  const type = clean(value).replace(/[.]+$/, '') || null;
  if (/^(э\/э|экз|экзамен)$/i.test(type || '') || /^(э\/э|экз|экзамен)$/i.test(topic || '')) return { type: 'Экз', topic: null };
  if (/^(зо|зч|зач[её]т)$/i.test(type || '') || /^(зо|зч|зач[её]т)$/i.test(topic || '')) return { type: 'ЗО', topic: null };
  return { type: /^(п|пз)$/i.test(type || '') ? 'ПЗ' : type, topic };
}

function cellLesson(rawLines, owner) {
  const positioned = rawLines.map(clean);
  const nonempty = positioned.filter(Boolean);
  if (!nonempty.length) return null;
  if (nonempty.length === 1 && EVENT.test(nonempty[0])) {
    return {
      category: 'event', isMarker: true, marker: nonempty[0], type: null,
      topic: null, subject: nonempty[0], groups: [owner], rooms: [],
      __dayOff: DAY_OFF.has(nonempty[0]),
    };
  }
  // В трёхстрочном файле позиции значимы; в одной ячейке пустые строки
  // встречаются только как оформление, поэтому берём три содержательные строки.
  const [first = '', subject = '', room = ''] = positioned.length === 3 ? positioned : nonempty;
  if (!first || !subject) return null;
  const [rawType, ...rawTopic] = first.split('/');
  const normalized = typeOf(rawType, topicOf(rawTopic.join('/')));
  return {
    category: 'lesson', type: normalized.type, topic: normalized.topic,
    subject, groups: [owner], rooms: room.split(/[,;]/).map(normalizeRoom).filter(Boolean),
  };
}

function isoOf(value, yearText) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const m = clean(value).match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (!year) {
    const years = String(yearText || '').match(/(\d{4})\D+(\d{4})/);
    if (!years) return null;
    year = Number(m[2]) >= 8 ? Number(years[1]) : Number(years[2]);
  } else if (year < 100) year += 2000;
  return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

async function parseExcelSchedule(buffer, name = '') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((sheet) => {
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      if (/^День\s*недели$/i.test(clean(cellText(sheet.getCell(r, 1))))) return true;
    }
    return false;
  });
  if (!ws) throw new Error(`${name || 'Excel'}: не найдена ячейка «День недели» в первом столбце`);

  let headerRow = 0;
  for (let r = 1; r <= ws.rowCount; r += 1) {
    if (/^День\s*недели$/i.test(clean(cellText(ws.getCell(r, 1))))) { headerRow = r; break; }
  }
  const headerText = [];
  for (let r = 1; r < headerRow; r += 1) {
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const value = clean(cellText(ws.getCell(r, c)));
      if (value) headerText.push(value);
    }
  }
  const header = [...new Set(headerText)].join(' ');
  const ownerMatch = header.match(/Учебная\s+группа\s*([\p{L}\d-]+)/iu);
  const owner = clean(ownerMatch?.[1] || name.replace(/\.xlsx?$/i, ''));
  if (!owner) throw new Error(`${name || 'Excel'}: не удалось определить учебную группу`);
  const year = header.match(/\d{4}\s*[/–-]\s*\d{4}/)?.[0]?.replace(/\s/g, '') || null;
  const semester = /осенн/i.test(header) ? 'осенний' : /весенн/i.test(header) ? 'весенний' : null;

  const weeks = [];
  for (let c = 4; c <= ws.columnCount; c += 1) {
    const n = Number(clean(cellText(ws.getCell(headerRow, c))));
    if (!Number.isInteger(n) || n < 1 || n > 104) break;
    weeks.push({ col: c, weekNo: n });
  }
  if (!weeks.length) throw new Error(`${name || 'Excel'}: после «Уч. недели» не найдены номера недель`);

  const firstDate = (() => {
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const cell = ws.getCell(r, weeks[0].col);
      const iso = isoOf(cell.value instanceof Date ? cell.value : cellText(cell), year);
      if (iso) return iso;
    }
    return null;
  })();
  const rowsPerPair = (() => {
    const counts = new Map();
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const day = clean(cellText(ws.getCell(r, 1)));
      const pair = clean(cellText(ws.getCell(r, 2)));
      if (DAYS.includes(day) && /^\d+\s*[-–]\s*\d+$/.test(pair)) {
        const key = `${day}|${pair}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return Math.max(1, ...counts.values()) >= 3 ? 3 : 1;
  })();

  const lessons = [];
  const holidays = new Set();
  for (let r = headerRow + 1; r <= ws.rowCount;) {
    const day = clean(cellText(ws.getCell(r, 1)));
    const pairLabel = clean(cellText(ws.getCell(r, 2)));
    const pairMatch = pairLabel.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!DAYS.includes(day) || !pairMatch) { r += 1; continue; }
    const pairNo = Math.floor((Number(pairMatch[1]) + 1) / 2);
    const time = clean(cellText(ws.getCell(r, 3))).match(/([\d.:]+)\s*[-–]\s*([\d.:]+)/);
    for (const week of weeks) {
      const raw = rowsPerPair === 3
        ? [0, 1, 2].map((offset) => cellText(ws.getCell(r + offset, week.col)))
        : linesOf(cellText(ws.getCell(r, week.col)));
      const cell = cellLesson(raw, owner);
      if (!cell) continue;
      if (cell.__dayOff && firstDate) {
        const date = new Date(`${firstDate}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + (week.weekNo - weeks[0].weekNo) * 7 + DAYS.indexOf(day));
        holidays.add(date.toISOString().slice(0, 10));
      }
      delete cell.__dayOff;
      lessons.push({
        fileKind: FILE_KIND.GROUP, owner, day, pairNo, pairLabel,
        timeStart: time?.[1] || null, timeEnd: time?.[2] || null, weekNo: week.weekNo, ...cell,
      });
    }
    r += rowsPerPair;
  }
  if (!lessons.length) throw new Error(`${name || 'Excel'}: в сетке не найдено ни одного занятия`);
  return {
    kind: FILE_KIND.GROUP, owner, year, semester, faculty: null,
    weeks, lessons, subjects: {}, legend: {}, firstDate,
    firstDateVerified: Boolean(firstDate), holidays: [...holidays].sort(),
    excelFormat: rowsPerPair === 3 ? 'three-rows' : 'single-cell',
    gridRow: headerRow,
  };
}

module.exports = { parseExcelSchedule };
