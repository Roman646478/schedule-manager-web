'use strict';

// Журнал ошибок: 500 обязан оставить стек в файле — окно консоли сервера
// закрывается вместе с ним, и разбирать потом нечего.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LOG = path.join(os.tmpdir(), `schedule-errlog-${process.pid}.log`);
process.env.ERROR_LOG = LOG;

const test = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler, rotateErrorLog } = require('../../src/middleware/errorHandler');

test.after(() => {
  for (const suffix of ['', '.1', '.2', '.3']) {
    try { fs.unlinkSync(LOG + suffix); } catch { /* нет файла — ок */ }
  }
});

// Минимальные заглушки express: нужен только код ответа и тело.
const fakeRes = () => {
  const res = { code: null, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const fakeReq = (url) => ({ method: 'PUT', originalUrl: url });

test('500 пишет стек в журнал, пользователю — общее сообщение', () => {
  const err = new Error('FOREIGN KEY constraint failed');
  const res = fakeRes();
  errorHandler(err, fakeReq('/api/lesson/42'), res, () => {});

  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'Внутренняя ошибка сервера', 'детали наружу не отдаём');

  const log = fs.readFileSync(LOG, 'utf8');
  assert.match(log, /PUT \/api\/lesson\/42/, 'в журнале есть метод и адрес');
  assert.match(log, /FOREIGN KEY constraint failed/, 'в журнале есть текст ошибки');
  assert.match(log, /at /, 'в журнале есть стек');
});

test('ошибка с кодом < 500 в журнал не идёт', () => {
  const before = fs.readFileSync(LOG, 'utf8').length;
  const err = new Error('плохой запрос');
  err.status = 400;
  err.publicMessage = 'Плохой запрос';
  const res = fakeRes();
  errorHandler(err, fakeReq('/api/lesson/7'), res, () => {});

  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'Плохой запрос');
  assert.equal(fs.readFileSync(LOG, 'utf8').length, before, 'журнал не вырос');
});

test('достигший лимита журнал ротируется с ограниченным числом копий', () => {
  fs.writeFileSync(LOG, 'старый журнал');
  fs.writeFileSync(`${LOG}.1`, 'предыдущий');
  fs.writeFileSync(`${LOG}.2`, 'самый старый');

  assert.equal(rotateErrorLog(LOG, 1), true);
  assert.equal(fs.existsSync(LOG), false);
  assert.equal(fs.readFileSync(`${LOG}.1`, 'utf8'), 'старый журнал');
  assert.equal(fs.readFileSync(`${LOG}.2`, 'utf8'), 'предыдущий');
  assert.equal(fs.readFileSync(`${LOG}.3`, 'utf8'), 'самый старый');
});
