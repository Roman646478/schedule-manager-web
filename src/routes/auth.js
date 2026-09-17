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
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Минимальная длина при смене пароля через интерфейс.
const MIN_PASSWORD_LEN = 8; // пароль входа
const MIN_RESET_LEN = 4; // код подтверждения очистки БД

// Простейший лимит попыток входа по IP (защита от перебора).
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Периодическая уборка устаревших записей, чтобы Map не рос бесконечно.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (now - rec.ts > WINDOW_MS) attempts.delete(ip);
  }
}, WINDOW_MS);
sweeper.unref(); // не держим процесс живым ради таймера

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > WINDOW_MS) {
    rec.count = 0;
    rec.ts = now;
  }
  if (rec.count >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
  attempts.set(ip, rec);
  req._rateRec = rec;
  next();
}

router.post('/login', rateLimit, validateBody(loginBodyErrors), (req, res, next) => {
  const { username, password } = req.body;
  if (!verifyCredentials(username, password)) {
    req._rateRec.count += 1;
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  req._rateRec.count = 0;
  const csrf = req.session.csrf;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.csrf = csrf;
    req.session.isAdmin = true;
    req.session.username = username;
    req.session.save((error) => error ? next(error) : res.json({ success: true }));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/auth/check', (req, res) => {
  const authenticated = Boolean(req.session && req.session.isAdmin);
  const body = { authenticated };
  // Флаги «активны дефолтные пароли» отдаём только вошедшему админу — чтобы UI
  // показал баннер с предложением сменить пароль.
  if (authenticated) body.usingDefaults = usingDefaultCredentials();
  res.json(body);
});

// Смена пароля входа администратора. Тело: { currentPassword, newPassword }.
// Требует подтверждения текущим паролем (защита от смены при уведённой сессии).
router.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Новый пароль — минимум ${MIN_PASSWORD_LEN} символов` });
  }
  if (!verifyCredentials(req.session.username, currentPassword)) {
    return res.status(401).json({ error: 'Текущий пароль неверный' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'Новый пароль совпадает с текущим' });
  }
  changePassword(newPassword);
  res.json({ success: true });
});

// Смена пароля-подтверждения полной очистки БД. Тело: { currentPassword, newPassword }.
router.post('/reset-password', requireAuth, (req, res) => {
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
