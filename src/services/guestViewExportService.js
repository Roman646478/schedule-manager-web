'use strict';

const ExcelJS = require('exceljs');
const { DAYS, PAIR_TIMES } = require('../utils/constants');
const { pairsForDay } = require('../../public/js/shared-constants');

const roomsOf = (l) => l.rooms?.length ? l.rooms : l.room ? [l.room] : [];
const teachersOf = (l) => [...new Set([l.teacher, ...(l.teachers || [])].filter(Boolean))];

// Все данные, включая принадлежность кафедре, берём из опубликованного снимка.
async function exportGuestView(snapshot, { kind, id, deptKind, weeks }) {
  const byRoom = kind === 'room' || deptKind === 'room';
  const membersOf = byRoom ? roomsOf : teachersOf;
  let members;
  if (kind === 'room') members = (snapshot.rooms || []).filter((name) => name === id);
  else if (byRoom) members = (snapshot.roomsInfo || []).filter((r) => r.dept === id).map((r) => r.name);
  else members = (snapshot.teachers || []).filter((name) => {
    const dept = (snapshot.teacherDept || {})[name] || '';
    return id === '(без кафедры)' ? !dept : dept === id;
  });
  if (!members.length) {
    const error = new Error('Аудитория или кафедра отсутствует в опубликованном расписании');
    error.status = 404;
    throw error;
  }
  members.sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  const selected = new Set(members);
  const lessons = (snapshot.lessons || []).filter((l) => membersOf(l).some((m) => selected.has(m)));
  const wb = new ExcelJS.Workbook();
  for (const week of weeks) {
    const ws = wb.addWorksheet(`Неделя ${week}`, {
      pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.columns = [{ width: 26 }, { width: 16 }, ...DAYS.map(() => ({ width: 28 }))];
    ws.mergeCells(1, 1, 1, DAYS.length + 2);
    ws.getCell(1, 1).value = `${kind === 'room' ? 'Аудитория' : 'Кафедра'} ${id} · неделя ${week}`;
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.addRow([byRoom ? 'Аудитория' : 'Преподаватель', 'Пара / время', ...DAYS]);
    ws.getRow(2).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 2, xSplit: 2 }];
    ws.pageSetup.printTitlesRow = '1:2';
    const weekLessons = lessons.filter((l) => l.weekNo === week);
    const shown = kind === 'room' ? members : members.filter((m) => weekLessons.some((l) => membersOf(l).includes(m)));
    for (const member of shown) {
      for (const pair of Object.keys(PAIR_TIMES).map(Number)) {
        const time = PAIR_TIMES[pair];
        const row = ws.addRow([member, `${pair}\n${time.start}–${time.end}`, ...DAYS.map((day) => {
          if (!pairsForDay(day).includes(pair)) return '';
          return weekLessons.filter((l) => l.day === day && l.pairNo === pair && membersOf(l).includes(member))
            .map((l) => [
              [l.type, l.subject, l.topic].filter(Boolean).join(' '),
              (l.groups || []).join(', '),
              byRoom ? teachersOf(l).join(', ') : roomsOf(l).join(', '),
              l.note,
            ].filter(Boolean).join('\n')).join('\n\n');
        })]);
        row.height = Math.max(60, ...row.values.filter((v) => typeof v === 'string').map((v) => v.split('\n').length * 15));
      }
    }
    ws.eachRow((row) => row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      const line = { style: 'thin', color: { argb: 'FFCCCCCC' } };
      cell.border = { top: line, bottom: line, left: line, right: line };
    }));
  }
  const safeId = id.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
  return { buffer: await wb.xlsx.writeBuffer(), filename: `${kind === 'room' ? 'Аудитория' : 'Кафедра'} ${safeId}.xlsx` };
}

module.exports = { exportGuestView };
