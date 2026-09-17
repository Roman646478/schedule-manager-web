'use strict';

const fs = require('fs');
const path = require('path');
// Node.js 22 читает .env без сторонней зависимости. Переменные, уже заданные
// службой или консолью, process.loadEnvFile не перезаписывает.
try {
  const envFile = path.resolve(__dirname, '..', '.env');
  if (typeof process.loadEnvFile === 'function' && fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch (err) {
  console.warn(`[config] Не удалось прочитать .env: ${err.message}`);
}
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');

const {
  PORT,
  HOST,
  PUBLIC_DIR,
  SESSION_MAX_AGE_MS,
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  HTTP_REDIRECT_PORT,
  HSTS_ENABLED,
  PUBLIC_DB_PATH,
} = require('./utils/constants');
const { getDb } = require('./config/database');
const { SqliteSessionStore } = require('./config/sessionStore');
const { getSessionSecret, usingDefaultCredentials } = require('./services/authService');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { csrfToken, csrfProtection } = require('./middleware/csrf');
const { sortTopics } = require('./services/topicOrderService');
const { finalizeMutation } = require('./middleware/mutations');
const { transaction } = require('./services/dbService');
const { flushSnapshot } = require('./services/snapshotStore');
const { randomUUID } = require('crypto');
const { getSetting } = require('./services/settingsService');

// Читает пару ключ+сертификат, если оба файла на месте. Иначе null (HTTP).
function loadTls() {
  if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
    return { key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) };
  }
  return null;
}

function createApp(opts = {}) {
  const app = express();
  // Соединение защищено: либо встроенный HTTPS, либо доверенный прокси (прод).
  const isProd = process.env.NODE_ENV === 'production';
  const secureConn = Boolean(opts.https) || isProd;

  // CSP: все скрипты/стили/запросы — только со своего origin.
  // 'unsafe-inline' для стилей — из-за style-атрибутов в разметке.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // HSTS опасен с самоподписанным сертификатом — включаем только по флагу.
      hsts: HSTS_ENABLED ? undefined : false,
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  // Production может слушать HTTPS напрямую. Заголовкам доверяем только от
  // явно указанных адресов прокси, никогда по одному лишь NODE_ENV.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(x => x.trim()).filter(Boolean));
  const SESSION_MAX_AGE = SESSION_MAX_AGE_MS;
  app.use(
    session({
      // getDb (а не getDb()): при откате к архиву файл базы подменяется и
      // соединение переоткрывается — хранилище должно брать актуальное.
      store: new SqliteSessionStore(getDb, { ttlMs: SESSION_MAX_AGE }),
      secret: getSessionSecret(),
      resave: false,
      saveUninitialized: false,
      // rolling: продлевать срок сессии при каждом запросе — пока компьютером
      // пользуются, повторный вход не потребуется; куки персистентная (maxAge),
      // секрет и хранилище переживают перезапуск сервера.
      rolling: true,
      // secure: куку шлём только по защищённому соединению (HTTPS/доверенный прокси).
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureConn, maxAge: SESSION_MAX_AGE },
    })
  );

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // Выдача CSRF-токена клиенту (создаёт его в сессии при первом запросе).
  app.get('/api/csrf', (req, res) => res.json({ token: csrfToken(req) }));

  // Проверка CSRF для всех небезопасных методов /api (кроме /login).
  app.use('/api', csrfProtection);

  const epoch = randomUUID();
  app.use('/api', (req, res, next) => {
    const json = res.json;
    res.json = function (body) {
      try { transaction(() => finalizeMutation(req, res)); }
      catch (err) { return next(err); }
      return json.call(this, body);
    };
    next();
  });
  app.get('/api/data-version', (req, res) => res.json({ version: Number(getSetting('dataVersion') || 0), epoch }));

  // Роуты API (подключаются по мере реализации этапов)
  app.use('/api', require('./routes/auth'));
  app.use('/api', require('./routes/import'));
  app.use('/api', require('./routes/schedule'));
  app.use('/api', require('./routes/rooms'));
  app.use('/api', require('./routes/curriculum'));
  app.use('/api', require('./routes/export'));
  app.use('/api', require('./routes/archives'));

  // Главной страницы нет — корень открывает сразу расписание.
  app.get('/', (req, res) => res.redirect('/weekly.html'));

  // Снимок для гостей отдаётся оттуда, куда его пишет publish() (PUBLIC_DB_PATH),
  // а не статикой из public/: при переопределённом пути гости молча видели бы
  // старый файл. Рядом publish() кладёт сжатую копию (.gz) — ее и получает
  // браузер (Content-Encoding: gzip), если она не старше самого снимка.
  app.get('/public_db.json', (req, res) => {
    const file = path.resolve(PUBLIC_DB_PATH);
    const gz = `${file}.gz`;
    const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1);
    if (mtime(file) < 0) return res.status(404).end();
    const headers = { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding' };
    const zipped = mtime(gz) >= mtime(file) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const done = (err) => { if (err && !res.headersSent) res.status(404).end(); };
    if (zipped) res.sendFile(gz, { headers: { ...headers, 'Content-Encoding': 'gzip' } }, done);
    else res.sendFile(file, { headers }, done);
  });

  // no-cache: браузер всегда перепроверяет статику по ETag (обычно 304) — иначе
  // после правок JS/CSS зависает старая версия из эвристического кэша.
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}

function start() {
  getDb();
  flushSnapshot(); // Recover a publication interrupted after the database commit.
  // инициализация схемы при старте
  // Порядок тем на старте: база могла смениться, пока сервер не работал.
  try {
    const { changed } = sortTopics({ all: true });
    if (changed) console.log(`[темы] расставлено по порядку: ${changed}`);
  } catch (err) {
    console.error('[темы] расстановка при старте не удалась:', err.message);
  }
  const def = usingDefaultCredentials();
  if (def.password || def.resetPassword) {
    const which = [def.password && 'входа (admin/admin)', def.resetPassword && 'очистки БД']
      .filter(Boolean)
      .join(' и ');
    console.warn(
      `[БЕЗОПАСНОСТЬ] Используется пароль по умолчанию: ${which}. ` +
        'Смените его в админке (кнопка «Сменить пароль»).'
    );
  }
  const tls = loadTls();
  const app = createApp({ https: Boolean(tls) });

  if (tls) {
    https.createServer(tls, app).listen(PORT, HOST, () => {
      console.log(`schedule-manager слушает https://${HOST}:${PORT}`);
    });
    // Необязательный HTTP-порт: только редирект на HTTPS, данные по нему не ходят.
    if (HTTP_REDIRECT_PORT) {
      http
        .createServer((req, res) => {
          const host = (req.headers.host || HOST).replace(/:\d+$/, '');
          res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
          res.end();
        })
        .listen(HTTP_REDIRECT_PORT, HOST, () => {
          console.log(`HTTP→HTTPS редирект на порту ${HTTP_REDIRECT_PORT}`);
        });
    }
  } else {
    app.listen(PORT, HOST, () => {
      console.log(`schedule-manager слушает http://${HOST}:${PORT}`);
    });
  }
}

if (require.main === module) start();

module.exports = { createApp, start };
