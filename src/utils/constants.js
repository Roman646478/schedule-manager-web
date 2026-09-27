'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Доменные константы, общие с фронтендом (см. public/js/shared-constants.js).
const SHARED = require(path.join(ROOT, 'public', 'js', 'shared-constants.js'));

const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'schedule.db');
const ACCESS_DB_PATH = process.env.ACCESS_DB_PATH || path.join(path.dirname(DB_PATH), 'access.db');

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 443,
  HOST: process.env.HOST || '127.0.0.1',
  DB_PATH,
  ACCESS_DB_PATH,
  // Архивы базы (снимки schedule.db) — рядом с самой базой, чтобы тесты с
  // временным DB_PATH не писали в рабочую папку data/.
  ARCHIVES_DIR: process.env.ARCHIVES_DIR || path.join(path.dirname(DB_PATH), 'archives'),
  CONFIG_PATH: process.env.CONFIG_PATH || path.join(ROOT, 'data', 'config.json'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PUBLIC_DB_PATH: process.env.PUBLIC_DB_PATH || path.join(ROOT, 'public', 'public_db.json'),

  // TLS. Если оба файла существуют (или заданы переменными окружения) — сервер
  // поднимается по HTTPS, а cookie сессии помечается secure. Сертификат —
  // самоподписанный, генерируется офлайн: `npm run gen-cert`.
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || path.join(ROOT, 'data', 'tls', 'key.pem'),
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || path.join(ROOT, 'data', 'tls', 'cert.pem'),
  // Доп. HTTP-порт только для редиректа на HTTPS (0 — выключено).
  HTTP_REDIRECT_PORT: Number(process.env.HTTP_REDIRECT_PORT) || 0,
  // HSTS включать ТОЛЬКО с доверенным сертификатом: с самоподписанным он
  // лишает браузер кнопки «всё равно продолжить» и закрывает доступ.
  HSTS_ENABLED: process.env.HSTS_ENABLED === '1',

  // Срок жизни сессии админки (мс). Куки персистентная и продлевается при
  // активности (rolling) — на одном компьютере повторный вход не запрашивается.
  // По умолчанию 30 дней; переопределяется через SESSION_MAX_AGE_MS.
  SESSION_MAX_AGE_MS: Number(process.env.SESSION_MAX_AGE_MS) || 1000 * 60 * 60 * 24 * 30,
  DEFAULT_USERNAME: process.env.DEFAULT_USERNAME || 'admin',
  DEFAULT_PASSWORD: process.env.DEFAULT_PASSWORD || 'admin',
  // Дефолтный пароль-подтверждение очистки БД (хэш хранится в config.json, СМЕНИТЬ!).
  DEFAULT_RESET_PASSWORD: process.env.DEFAULT_RESET_PASSWORD || '2707',

  // Дни недели, число пар, время пар — из общего модуля (public/js/shared-constants.js).
  DAYS: SHARED.DAYS,
  PAIRS_PER_DAY: SHARED.PAIRS_PER_DAY,
  PAIR_TIMES: SHARED.PAIR_TIMES,
  // Глобальные метки-мероприятия (ДП, ОП, Отп…) — общий список с фронтендом.
  EVENT_REASONS: SHARED.EVENT_REASONS,
  // Виды учебных занятий по умолчанию (перечень правится в справочнике).
  LESSON_TYPES: SHARED.LESSON_TYPES,
  // Дополнение столбца «Отчёт.» формами контроля из учебного плана.
  mergeReportValue: SHARED.mergeReportValue,

  // Типы файлов импорта.
  FILE_KIND: {
    GROUP: 'group',
    TEACHER: 'teacher',
    ROOM: 'room',
  },
};
