'use strict';

const crypto = require('crypto');

// Защита от CSRF поверх sameSite=lax (defense-in-depth). Токен хранится в сессии
// и должен прийти в заголовке X-CSRF-Token при небезопасных методах. Кросс-сайтовый
// запрос не может ни прочитать токен, ни выставить произвольный заголовок без CORS.

// Возвращает токен текущей сессии, создавая его при первом обращении.
function csrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Логин устанавливает саму сессию — токена ещё нет, поэтому исключаем.
const EXEMPT_PATHS = new Set(['/login']);

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.path)) return next();
  const expected = req.session && req.session.csrf;
  const sent = req.get('X-CSRF-Token');
  if (
    expected &&
    typeof sent === 'string' &&
    Buffer.byteLength(sent) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))
  ) {
    return next();
  }
  return res.status(403).json({ error: 'CSRF-токен недействителен' });
}

module.exports = { csrfToken, csrfProtection };
