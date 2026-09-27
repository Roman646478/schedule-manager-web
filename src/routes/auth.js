'use strict';

const express = require('express');
const {
  verifyCredentials,
  changePassword,
  verifyResetPassword,
  changeResetPassword,
  usingDefaultCredentials,
} = require('../services/authService');
const { validateBody, loginBodyErrors } = require('../middleware/validation');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Минимальная длина при смене пароля через интерфейс.
const MIN_PASSWORD_LEN = 8; // пароль входа
const MIN_RESET_LEN = 4; // код подтверждения очистки БД

// Простейший лимит попыток входа по IP (защита от перебора).
const attemptsByIp = new Map();
const attemptsByLogin = new Map();
const MAX_IP_ATTEMPTS = 100;
const MAX_LOGIN_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Периодическая уборка устаревших записей, чтобы Map не рос бесконечно.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const map of [attemptsByIp, attemptsByLogin]) {
    for (const [key, rec] of map) if (now - rec.ts > WINDOW_MS) map.delete(key);
  }
}, WINDOW_MS);
sweeper.unref(); // не держим процесс живым ради таймера

function currentAttempt(map, key, now) {
  const rec = map.get(key) || { count: 0, ts: now };
  if (now - rec.ts > WINDOW_MS) { rec.count = 0; rec.ts = now; }
  map.set(key, rec);
  return rec;
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const ipRec = currentAttempt(attemptsByIp, req.ip || 'unknown', now);
  const loginRec = currentAttempt(attemptsByLogin, String((req.body || {}).username || '').trim().toLowerCase(), now);
  if (ipRec.count >= MAX_IP_ATTEMPTS || loginRec.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
  }
  req._rateRecs = [ipRec, loginRec];
  next();
}

router.post('/login', rateLimit, validateBody(loginBodyErrors), (req, res, next) => {
  const { username, password } = req.body;
  const user = verifyCredentials(username, password);
  if (!user) {
    for (const rec of req._rateRecs) rec.count += 1;
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  attemptsByLogin.delete(String(username || '').trim().toLowerCase());
  const csrf = req.session.csrf;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.csrf = csrf;
    req.session.userId = user.id;
    req.session.authVersion = user.authVersion;
    req.session.isAdmin = user.role === 'admin'; // совместимость со старым клиентом
    req.session.username = user.username;
    req.session.save((error) => error ? next(error) : res.json({ success: true, user }));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/auth/check', (req, res) => {
  const { findUserById, publicUser, permissionsOf, allowedGroups } = require('../services/userService');
  const row = req.session && req.session.userId ? findUserById(req.session.userId) : null;
  const authenticated = Boolean(row && row.active && Number(row.auth_version) === Number(req.session.authVersion));
  const user = authenticated ? publicUser(row) : null;
  const body = { authenticated, user };
  // Флаги «активны дефолтные пароли» отдаём только вошедшему админу — чтобы UI
  // показал баннер с предложением сменить пароль.
  if (authenticated) {
    const p = permissionsOf(user.id);
    body.permissions = { ...p, groups: [...allowedGroups(user)].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })) };
    if (user.role === 'admin') body.usingDefaults = usingDefaultCredentials();
  }
  res.json(body);
});

// Смена пароля входа администратора. Тело: { currentPassword, newPassword }.
// Требует подтверждения текущим паролем (защита от смены при уведённой сессии).
router.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Новый пароль — минимум ${MIN_PASSWORD_LEN} символов` });
  }
  const result = changePassword(req.user.id, currentPassword, newPassword);
  if (!result.ok) return res.status(result.code || 400).json({ error: result.error });
  req.session.destroy(() => res.json({ success: true, relogin: true }));
});

// Смена пароля-подтверждения полной очистки БД. Тело: { currentPassword, newPassword }.
router.post('/reset-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < MIN_RESET_LEN) {
    return res.status(400).json({ error: `Новый пароль очистки — минимум ${MIN_RESET_LEN} символа` });
  }
  if (!verifyResetPassword(currentPassword)) {
    return res.status(401).json({ error: 'Текущий пароль очистки неверный' });
  }
  changeResetPassword(newPassword);
  res.json({ success: true });
});

module.exports = router;
