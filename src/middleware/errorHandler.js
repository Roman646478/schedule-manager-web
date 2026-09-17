'use strict';

const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('../utils/constants');

// Журнал ошибок рядом с базой. Сервер запускают двойным щелчком, и стек из
// console.error живёт только в окне консоли — до первой перезагрузки его уже не
// найти. ponytail: append в один файл, без ротации; разрастётся — обрезать вручную.
const ERROR_LOG = process.env.ERROR_LOG || path.join(path.dirname(DB_PATH), 'errors.log');
const ERROR_LOG_MAX_BYTES = Math.max(64 * 1024, Number(process.env.ERROR_LOG_MAX_BYTES) || 5 * 1024 * 1024);
const ERROR_LOG_KEEP = 3;

function rotateErrorLog(file = ERROR_LOG, maxBytes = ERROR_LOG_MAX_BYTES) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (size < maxBytes) return false;
  for (let i = ERROR_LOG_KEEP; i >= 1; i--) {
    const source = i === 1 ? file : `${file}.${i - 1}`;
    const target = `${file}.${i}`;
    if (!fs.existsSync(source)) continue;
    fs.rmSync(target, { force: true });
    fs.renameSync(source, target);
  }
  return true;
}

function logToFile(req, err) {
  try {
    rotateErrorLog();
    const stack = err && err.stack ? err.stack : String(err);
    const line = [`${new Date().toISOString()} ${req.method} ${req.originalUrl}`, stack, '', ''].join('\n');
    fs.appendFileSync(ERROR_LOG, line);
  } catch {
    /* не смогли записать — не мешаем ответу */
  }
}

// Централизованная обработка ошибок. Пользователю не показываем детали.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.dataSaved ? 503 : err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
    logToFile(req, err);
  }
  res.status(status).json({ error: err.dataSaved ? 'Изменение сохранено в базе, но публикация пока не записана на диск. Проверьте доступ к диску и повторите публикацию.' : err.publicMessage || 'Внутренняя ошибка сервера', ...(err.dataSaved ? { dataSaved: true } : {}) });
}

function notFound(req, res) {
  res.status(404).json({ error: 'Не найдено' });
}

module.exports = { errorHandler, notFound, ERROR_LOG, rotateErrorLog };
