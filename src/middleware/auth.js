'use strict';

function requireAuth(req, res, next) {
  const { findUserById, publicUser } = require('../services/userService');
  const row = req.session && req.session.userId ? findUserById(req.session.userId) : null;
  if (row && row.active && Number(row.auth_version) === Number(req.session.authVersion)) {
    req.user = publicUser(row);
    return next();
  }
  res.status(401).json({ error: 'Требуется вход' });
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'admin') return next();
    res.status(403).json({ error: 'Действие доступно только администратору' });
  });
}

const EDITOR_WRITES = [
  /^\/move$/,
  /^\/lessons$/,
  /^\/lesson\/\d+(?:\/(?:park|lock))?$/,
  /^\/session-move-exam$/,
  /^\/group-teacher$/,
  /^\/(?:room-plan|pair4-relief)\/apply$/,
  /^\/vacation$/,
  /^\/entity-schedule$/,
  /^\/move-actions\/[^/]+\/revert$/,
  /^\/password$/,
  /^\/logout$/,
];

function enforceWritePolicy(req, res, next) {
  // Выход должен работать и для уже заблокированной/отозванной сессии: он лишь
  // удаляет локальную сессию и не изменяет данные расписания.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/login' || req.path === '/logout' || /^\/export\//.test(req.path)) return next();
  requireAuth(req, res, () => {
    if (req.user.role === 'admin' || EDITOR_WRITES.some((re) => re.test(req.path))) return next();
    res.status(403).json({ error: 'Эта операция доступна только администратору' });
  });
}

module.exports = { requireAuth, requireAdmin, enforceWritePolicy };
