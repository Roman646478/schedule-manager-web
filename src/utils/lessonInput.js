'use strict';

const { DAYS, PAIRS_PER_DAY } = require('./constants');

// Проверка одинаковая для карточки, переноса, копии и создания в буфере.
// Верхняя граница недели не привязана к текущему семестру: старые импортные
// записи за его границей должны оставаться доступными для редактирования.
function slotErrors({ day, pairNo, weekNo }) {
  const errors = [];
  if (!DAYS.includes(day)) errors.push('Некорректный день недели');
  if (!Number.isInteger(pairNo) || pairNo < 1 || pairNo > PAIRS_PER_DAY) errors.push('Некорректный номер пары');
  if (!Number.isSafeInteger(weekNo) || weekNo < 1 || weekNo > 520) errors.push('Некорректный номер недели');
  return errors;
}

function lessonFieldErrors(fields) {
  const errors = [];
  for (const key of ['subject', 'type', 'topic', 'note', 'teacher', 'room']) {
    const value = fields[key];
    const limit = key === 'note' ? 4000 : 500;
    if (value != null && (typeof value !== 'string' || value.length > limit)) errors.push(`Некорректное поле ${key} (максимум ${limit} символов)`);
  }
  for (const key of ['groups', 'teachers', 'rooms']) {
    const values = fields[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 200 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 500))) errors.push(`Некорректный список ${key}`);
  }
  return errors;
}

function invalidInput(reasons) {
  return reasons.length ? { ok: false, code: 400, reasons } : null;
}

module.exports = { slotErrors, lessonFieldErrors, invalidInput };
