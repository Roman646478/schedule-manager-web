'use strict';

// Календарь семестра: привязка (неделя + день) к реальной дате.
// Настройка семестра задаётся вручную: { name, start, end } (start/end — YYYY-MM-DD).

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Понедельник недели, содержащей дату start (неделя №1 семестра).
function week1Monday(startISO) {
  const d = new Date(startISO + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7; // Пн=0 … Вс=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

// Дата конкретного (неделя, день) в формате дд.мм. null — если семестр не задан.
function lessonDate(weekNo, day, semester) {
  if (!semester || !semester.start || !weekNo) return null;
  const idx = DAYS.indexOf(day);
  const m = week1Monday(semester.start);
  if (!m || idx < 0) return null;
  const d = new Date(m.getTime());
  d.setUTCDate(d.getUTCDate() + (weekNo - 1) * 7 + idx);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}`;
}

// Дата конкретного (неделя, день) в формате ГГГГ-ММ-ДД для сравнения с праздниками.
function lessonDateISO(weekNo, day, semester) {
  if (!semester || !semester.start || !weekNo) return null;
  const idx = DAYS.indexOf(day);
  const m = week1Monday(semester.start);
  if (!m || idx < 0) return null;
  const d = new Date(m.getTime());
  d.setUTCDate(d.getUTCDate() + (weekNo - 1) * 7 + idx);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Число недель в семестре по датам начала/конца (для генерации сетки).
function weekCount(semester) {
  if (!semester || !semester.start || !semester.end) return null;
  const a = week1Monday(semester.start);
  const b = new Date(semester.end + 'T00:00:00Z');
  if (!a || Number.isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / (7 * 86400000)) + 1;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

module.exports = { DAYS, week1Monday, lessonDate, lessonDateISO, weekCount };
