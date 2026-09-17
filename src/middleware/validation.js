'use strict';

const { DAYS, PAIRS_PER_DAY } = require('../utils/constants');

// Возвращает middleware, проверяющий тело запроса функцией-валидатором.
// Валидатор возвращает массив строк-ошибок (пустой = ок).
function validateBody(validator) {
  return (req, res, next) => {
    const errors = validator(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    next();
  };
}

function moveBodyErrors(b) {
  const e = [];
  if (!Number.isInteger(b.lessonId)) e.push('lessonId должен быть числом');
  if (!DAYS.includes(b.day)) e.push('некорректный день');
  if (!Number.isInteger(b.pairNo) || b.pairNo < 1 || b.pairNo > PAIRS_PER_DAY) e.push('некорректный номер пары');
  if (!Number.isInteger(b.weekNo) || b.weekNo < 1) e.push('некорректный номер недели');
  return e;
}

function loginBodyErrors(b) {
  const e = [];
  if (typeof b.username !== 'string' || !b.username) e.push('нужен логин');
  if (typeof b.password !== 'string' || !b.password) e.push('нужен пароль');
  return e;
}

module.exports = { validateBody, moveBodyErrors, loginBodyErrors };
