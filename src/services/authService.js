'use strict';

const fs = require('fs');
const { atomicWrite } = require('../utils/atomicFile');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { CONFIG_PATH, DEFAULT_USERNAME, DEFAULT_PASSWORD, DEFAULT_RESET_PASSWORD } = require('../utils/constants');

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
    return cache;
  }
  cache = {
    username: DEFAULT_USERNAME,
    passwordHash: bcrypt.hashSync(DEFAULT_PASSWORD, ROUNDS),
    resetPasswordHash: bcrypt.hashSync(DEFAULT_RESET_PASSWORD, ROUNDS),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
  save();
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
  const cfg = getConfig();
  return typeof password === 'string' && username === cfg.username && bcrypt.compareSync(password, cfg.passwordHash);
}

function changePassword(newPassword) {
  const cfg = getConfig();
  cfg.passwordHash = bcrypt.hashSync(newPassword, ROUNDS);
  save();
}

function getSessionSecret() {
  return getConfig().sessionSecret;
}

// Активны ли пароли по умолчанию — для предупреждения при старте и баннера в UI.
function usingDefaultCredentials() {
  const cfg = getConfig();
  return {
    password: bcrypt.compareSync(DEFAULT_PASSWORD, cfg.passwordHash),
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
