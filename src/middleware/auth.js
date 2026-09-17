'use strict';

// Пропускает дальше только аутентифицированного администратора.
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Требуется вход' });
}

module.exports = { requireAuth };
