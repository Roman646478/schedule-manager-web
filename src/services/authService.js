'use strict';

const fs = require('fs');
const { atomicWrite } = require('../utils/atomicFile');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { CONFIG_PATH, DEFAULT_USERNAME, DEFAULT_PASSWORD, DEFAULT_RESET_PASSWORD } = require('../utils/constants');
const { ensureAdmin, verifyUser, findUserById, setPassword } = require('./userService');

// Стоимость bcrypt: 10 в проде; в тестах можно снизить (BCRYPT_ROUNDS=4) для скорости.
const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

let cache = null;

// Читает config.json (пароли + секрет сессии). Создаёт при первом запуске
// с дефолтными учётными данными — пароли СЛЕДУЕТ сменить.
function getConfig() {
  if (cache) return cache;
  if (fs.existsSync(CONFIG_PATH)) {
    cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Миграция старых config.json: без пароля очистки и/или без секрета сессии
    // (без sessionSecret express-session падает при старте).
    let changed = false;
    if (!cache.resetPasswordHash) {
      cache.resetPasswordHash = bcrypt.hashSync(DEFAULT_RESET_PASSWORD, ROUNDS);
      changed = true;
    }
    if (!cache.sessionSecret) {
      cache.sessionSecret = crypto.randomBytes(32).toString('hex');
      changed = true;
    }
    if (changed) save();
    ensureAdmin({ username: cache.username || DEFAULT_USERNAME, passwordHash: cache.passwordHash });
    return cache;
  }
  cache = {
    username: DEFAULT_USERNAME,
    passwordHash: bcrypt.hashSync(DEFAULT_PASSWORD, ROUNDS),
    resetPasswordHash: bcrypt.hashSync(DEFAULT_RESET_PASSWORD, ROUNDS),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
  save();
  ensureAdmin({ username: cache.username, passwordHash: cache.passwordHash });
  return cache;
}

function save() {
  try {
    atomicWrite(CONFIG_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    cache = null; // Do not retain credentials that were not saved.
    throw err;
  }
}

function verifyCredentials(username, password) {
  getConfig();
  return verifyUser(username, password);
}

function changePassword(userId, currentPassword, newPassword) {
  const result = setPassword(userId, newPassword, userId, currentPassword);
  if (result.ok) {
    const cfg = getConfig();
    const row = findUserById(userId);
    if (row && row.role === 'admin' && row.username === String(cfg.username || '').toLowerCase()) {
      cfg.passwordHash = row.password_hash;
      save();
    }
  }
  return result;
}

function getSessionSecret() {
  return getConfig().sessionSecret;
}

// Активны ли пароли по умолчанию — для предупреждения при старте и баннера в UI.
function usingDefaultCredentials() {
  const cfg = getConfig();
  const admin = verifyUser(cfg.username, DEFAULT_PASSWORD);
  return {
    password: Boolean(admin && admin.role === 'admin'),
    resetPassword: bcrypt.compareSync(DEFAULT_RESET_PASSWORD, cfg.resetPasswordHash),
  };
}

// Проверка пароля-подтверждения полной очистки БД.
function verifyResetPassword(password) {
  const cfg = getConfig();
  return typeof password === 'string' && bcrypt.compareSync(password, cfg.resetPasswordHash);
}

function changeResetPassword(newPassword) {
  const cfg = getConfig();
  cfg.resetPasswordHash = bcrypt.hashSync(newPassword, ROUNDS);
  save();
}

module.exports = {
  getConfig,
  verifyCredentials,
  changePassword,
  getSessionSecret,
  verifyResetPassword,
  changeResetPassword,
  usingDefaultCredentials,
};
