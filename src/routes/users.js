'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listUsers, createUser, replacePermissions, updateUser, setPassword, permissionsOf, allowedGroups } = require('../services/userService');
const { getDb } = require('../config/database');
const { getAccessDb } = require('../config/accessDatabase');

const router = express.Router();
const send = (res, result) => result.ok ? res.json(result) : res.status(result.code || 400).json({ error: result.error });

router.get('/me/permissions', requireAuth, (req, res) => {
  const p = permissionsOf(req.user.id);
  res.json({ user: req.user, ...p, groups: [...allowedGroups(req.user)].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })) });
});

router.get('/users', requireAdmin, (req, res) => res.json({ users: listUsers() }));
router.get('/access-audit', requireAdmin, (req, res) => {
  const entries = getAccessDb().prepare(
    `SELECT a.id, a.happened_at AS happenedAt, a.action, a.details,
            actor.username AS actor, target.username AS target
       FROM access_audit a
       LEFT JOIN users actor ON actor.id=a.actor_user_id
       LEFT JOIN users target ON target.id=a.target_user_id
      ORDER BY a.id DESC LIMIT 500`
  ).all().map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  res.json({ entries });
});
router.post('/users', requireAdmin, (req, res) => send(res, createUser(req.body || {}, req.user.id)));
router.patch('/users/:id', requireAdmin, (req, res) => send(res, updateUser(Number(req.params.id), req.body || {}, req.user.id)));
router.put('/users/:id/permissions', requireAdmin, (req, res) => send(res, replacePermissions(Number(req.params.id), req.body || {}, req.user.id)));
router.post('/users/:id/password-reset', requireAdmin, (req, res) => send(res, setPassword(Number(req.params.id), (req.body || {}).password, req.user.id)));

router.get('/access-catalog', requireAdmin, (req, res) => {
  const db = getDb();
  const groups = db.prepare("SELECT name, TRIM(COALESCE(dept,'')) AS dept FROM groups ORDER BY name").all();
  const departments = [...new Set(groups.map((g) => g.dept).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  res.json({ departments, groups });
});

module.exports = router;
