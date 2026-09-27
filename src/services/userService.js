'use strict';

const bcrypt = require('bcryptjs');
const { getAccessDb } = require('../config/accessDatabase');
const { getDb } = require('../config/database');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const LOGIN_RE = /^[a-zA-Z0-9._-]{3,64}$/;

const now = () => new Date().toISOString();
const normalizeLogin = (value) => String(value || '').trim().toLowerCase();
const passwordBytes = (value) => Buffer.byteLength(String(value || ''), 'utf8');

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Пароль — минимум 8 символов';
  if (passwordBytes(password) > 72) return 'Пароль — максимум 72 байта UTF-8';
  return null;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id), username: row.username, displayName: row.display_name || '',
    role: row.role, active: Boolean(row.active), authVersion: Number(row.auth_version),
    version: Number(row.row_version),
  };
}

function findUserByLogin(username) {
  return getAccessDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(normalizeLogin(username)) || null;
}

function findUserById(id) {
  return getAccessDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function ensureAdmin({ username, passwordHash }) {
  const db = getAccessDb();
  const login = normalizeLogin(username) || 'admin';
  const found = findUserByLogin(login);
  if (found) return publicUser(found);
  const at = now();
  const result = db.prepare(
    `INSERT INTO users(username, display_name, password_hash, role, active, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 1, ?, ?)`
  ).run(login, 'Администратор', passwordHash, at, at);
  return publicUser(findUserById(result.lastInsertRowid));
}

function verifyUser(username, password) {
  const row = findUserByLogin(username);
  if (!row || !row.active || typeof password !== 'string' || !bcrypt.compareSync(password, row.password_hash)) return null;
  return publicUser(row);
}

function audit(db, actorId, targetId, action, details = null) {
  db.prepare('INSERT INTO access_audit(happened_at, actor_user_id, target_user_id, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(now(), actorId || null, targetId || null, action, details == null ? null : JSON.stringify(details));
}

function permissionsOf(userId) {
  const db = getAccessDb();
  const assigned = db.prepare('SELECT group_name, group_uid FROM user_groups WHERE user_id = ? ORDER BY group_name').all(userId);
  const currentByUid = new Map(getDb().prepare('SELECT access_uid, name FROM groups WHERE access_uid IS NOT NULL').all().map((r) => [r.access_uid, r.name]));
  return {
    departments: db.prepare('SELECT dept FROM user_departments WHERE user_id = ? ORDER BY dept').all(userId).map((r) => r.dept),
    manualGroups: [...new Set(assigned.filter((r) => r.group_uid && currentByUid.has(r.group_uid)).map((r) => currentByUid.get(r.group_uid)))],
    staleManualGroups: assigned.filter((r) => !r.group_uid || !currentByUid.has(r.group_uid)).map((r) => r.group_name),
  };
}

function allowedGroups(user) {
  if (!user) return new Set();
  if (user.role === 'admin') return new Set(getDb().prepare('SELECT name FROM groups').all().map((r) => r.name));
  const p = permissionsOf(user.id);
  const out = new Set(p.manualGroups);
  if (p.departments.length) {
    const qs = p.departments.map(() => '?').join(',');
    for (const row of getDb().prepare(`SELECT name FROM groups WHERE TRIM(COALESCE(dept,'')) IN (${qs})`).all(...p.departments)) out.add(row.name);
  }
  return out;
}

function groupsForLesson(lessonId, db = getDb()) {
  return db.prepare(
    `SELECT g.name FROM lesson_groups lg JOIN groups g ON g.id=lg.group_id WHERE lg.lesson_id=? ORDER BY g.name`
  ).all(Number(lessonId)).map((r) => r.name);
}

function canEditGroups(user, groups) {
  if (!user || !user.active) return false;
  if (user.role === 'admin') return true;
  const list = [...new Set((groups || []).map(String))];
  if (!list.length) return false;
  const allowed = allowedGroups(user);
  return list.every((g) => allowed.has(g));
}

function canEditLesson(user, lessonId, db = getDb()) {
  return canEditGroups(user, groupsForLesson(lessonId, db));
}

function listUsers() {
  return getAccessDb().prepare('SELECT * FROM users ORDER BY role, username').all().map((row) => {
    const p = permissionsOf(row.id);
    const u = publicUser(row);
    return { ...u, ...p, effectiveGroups: [...allowedGroups(u)].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })) };
  });
}

function normalizePermissions(input = {}) {
  const departments = [...new Set((input.departments || []).map((x) => String(x).trim()).filter(Boolean))].sort();
  const manualGroups = [...new Set((input.manualGroups || []).map((x) => String(x).trim()).filter(Boolean))].sort();
  const known = new Set(getDb().prepare('SELECT name FROM groups').all().map((r) => r.name));
  const missing = manualGroups.filter((g) => !known.has(g));
  if (missing.length) return { error: `Группы не найдены: ${missing.join(', ')}` };
  return { departments, manualGroups };
}

function insertManualGroup(db, statement, userId, name) {
  const row = getDb().prepare('SELECT access_uid FROM groups WHERE name=?').get(name);
  statement.run(userId, name, row.access_uid);
}

function createUser(data, actorId) {
  const username = normalizeLogin(data.username);
  if (!LOGIN_RE.test(username)) return { ok: false, code: 400, error: 'Логин: 3–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание' };
  const pwError = validatePassword(data.password);
  if (pwError) return { ok: false, code: 400, error: pwError };
  const perms = normalizePermissions(data);
  if (perms.error) return { ok: false, code: 400, error: perms.error };
  const db = getAccessDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const at = now();
    const info = db.prepare(
      `INSERT INTO users(username, display_name, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'editor', 1, ?, ?)`
    ).run(username, String(data.displayName || '').trim() || null, bcrypt.hashSync(data.password, ROUNDS), at, at);
    const id = Number(info.lastInsertRowid);
    const addDept = db.prepare('INSERT INTO user_departments(user_id, dept) VALUES (?, ?)');
    const addGroup = db.prepare('INSERT INTO user_groups(user_id, group_name, group_uid) VALUES (?, ?, ?)');
    for (const dept of perms.departments) addDept.run(id, dept);
    for (const group of perms.manualGroups) insertManualGroup(db, addGroup, id, group);
    audit(db, actorId, id, 'user.create', perms);
    db.exec('COMMIT');
    return { ok: true, user: listUsers().find((u) => u.id === id) };
  } catch (err) {
    db.exec('ROLLBACK');
    if (String(err.code || '').includes('CONSTRAINT_UNIQUE') || /UNIQUE constraint/.test(err.message)) {
      return { ok: false, code: 409, error: 'Такой логин уже существует' };
    }
    throw err;
  }
}

function replacePermissions(id, data, actorId) {
  const perms = normalizePermissions(data);
  if (perms.error) return { ok: false, code: 400, error: perms.error };
  const db = getAccessDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = findUserById(id);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, code: 404, error: 'Пользователь не найден' }; }
    if (row.role === 'admin') { db.exec('ROLLBACK'); return { ok: false, code: 400, error: 'Права администратора не ограничиваются группами' }; }
    if (Number(data.expectedVersion) !== Number(row.row_version)) { db.exec('ROLLBACK'); return { ok: false, code: 409, error: 'Права уже изменены в другой вкладке' }; }
    db.prepare('DELETE FROM user_departments WHERE user_id=?').run(id);
    db.prepare('DELETE FROM user_groups WHERE user_id=?').run(id);
    const addDept = db.prepare('INSERT INTO user_departments(user_id, dept) VALUES (?, ?)');
    const addGroup = db.prepare('INSERT INTO user_groups(user_id, group_name, group_uid) VALUES (?, ?, ?)');
    for (const dept of perms.departments) addDept.run(id, dept);
    for (const group of perms.manualGroups) insertManualGroup(db, addGroup, id, group);
    db.prepare('UPDATE users SET row_version=row_version+1, updated_at=? WHERE id=?').run(now(), id);
    audit(db, actorId, id, 'permissions.replace', perms);
    db.exec('COMMIT');
    return { ok: true, user: listUsers().find((u) => u.id === Number(id)) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function updateUser(id, data, actorId) {
  const db = getAccessDb();
  const row = findUserById(id);
  if (!row) return { ok: false, code: 404, error: 'Пользователь не найден' };
  if (Number(data.expectedVersion) !== Number(row.row_version)) return { ok: false, code: 409, error: 'Пользователь уже изменён в другой вкладке' };
  const active = data.active === undefined ? Boolean(row.active) : Boolean(data.active);
  if (row.role === 'admin' && !active) return { ok: false, code: 400, error: 'Основного администратора нельзя заблокировать' };
  const hasPermissions = data.departments !== undefined || data.manualGroups !== undefined;
  const perms = hasPermissions ? normalizePermissions(data) : null;
  if (perms && perms.error) return { ok: false, code: 400, error: perms.error };
  if (row.role === 'admin' && hasPermissions) return { ok: false, code: 400, error: 'Права администратора не ограничиваются группами' };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE users SET display_name=?, active=?, auth_version=auth_version+?, row_version=row_version+1, updated_at=? WHERE id=?`)
      .run(String(data.displayName ?? row.display_name ?? '').trim() || null, active ? 1 : 0, active === Boolean(row.active) ? 0 : 1, now(), id);
    if (perms) {
      db.prepare('DELETE FROM user_departments WHERE user_id=?').run(id);
      db.prepare('DELETE FROM user_groups WHERE user_id=?').run(id);
      const addDept = db.prepare('INSERT INTO user_departments(user_id, dept) VALUES (?, ?)');
      const addGroup = db.prepare('INSERT INTO user_groups(user_id, group_name, group_uid) VALUES (?, ?, ?)');
      for (const dept of perms.departments) addDept.run(id, dept);
      for (const group of perms.manualGroups) insertManualGroup(db, addGroup, id, group);
    }
    if (!active) db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(Number(id));
    audit(db, actorId, id, active ? 'user.update' : 'user.block', { displayName: data.displayName, active, permissions: perms });
    db.exec('COMMIT');
    return { ok: true, user: listUsers().find((u) => u.id === Number(id)) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function setPassword(id, password, actorId, currentPassword = null) {
  const error = validatePassword(password);
  if (error) return { ok: false, code: 400, error };
  const db = getAccessDb();
  const row = findUserById(id);
  if (!row) return { ok: false, code: 404, error: 'Пользователь не найден' };
  if (currentPassword != null && !bcrypt.compareSync(currentPassword, row.password_hash)) return { ok: false, code: 401, error: 'Текущий пароль неверный' };
  if (currentPassword != null && bcrypt.compareSync(password, row.password_hash)) return { ok: false, code: 400, error: 'Новый пароль совпадает с текущим' };
  db.prepare('UPDATE users SET password_hash=?, auth_version=auth_version+1, row_version=row_version+1, updated_at=? WHERE id=?')
    .run(bcrypt.hashSync(password, ROUNDS), now(), id);
  db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(Number(id));
  audit(db, actorId, id, currentPassword == null ? 'password.reset' : 'password.change');
  return { ok: true };
}

module.exports = {
  normalizeLogin, validatePassword, ensureAdmin, verifyUser, findUserById, publicUser,
  allowedGroups, canEditGroups, canEditLesson, groupsForLesson, permissionsOf, listUsers,
  createUser, replacePermissions, updateUser, setPassword,
};
