'use strict';

const { Store } = require('express-session');

// Схема таблицы сессий в одном месте: её же пересоздаёт откат к архиву базы.
function ensureSessionsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`);
}

// Хранилище сессий в той же SQLite-базе. Решает проблемы MemoryStore:
// сессии переживают рестарт сервера и не текут по памяти.
class SqliteSessionStore extends Store {
  /**
   * @param {import('node:sqlite').DatabaseSync|(() => import('node:sqlite').DatabaseSync)} db
   *   открытая БД либо функция, отдающая актуальное соединение. Функцию нужно
   *   передавать, если файл базы может быть подменён на ходу (откат к архиву):
   *   тогда хранилище само подхватит новое соединение.
   * @param {{ttlMs?:number, sweepMs?:number}} [opts]
   */
  constructor(db, opts = {}) {
    super();
    this._resolveDb = typeof db === 'function' ? db : () => db;
    this.ttlMs = opts.ttlMs || 1000 * 60 * 60 * 8; // дефолт = maxAge куки
    ensureSessionsTable(this.db);
    // Периодическая уборка просроченных сессий.
    const sweep = setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      } catch {
        /* БД может быть закрыта при остановке */
      }
    }, opts.sweepMs || 15 * 60 * 1000);
    sweep.unref();
  }

  get db() {
    return this._resolveDb();
  }

  _expiresOf(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    const t = exp ? new Date(exp).getTime() : NaN;
    return Number.isFinite(t) ? t : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`
        )
        .run(sid, JSON.stringify(sess), this._expiresOf(sess));
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  // rolling: true продлевает сессию на каждом запросе, но переписывать строку
  // ради нескольких секунд незачем — обновляем, только когда срок «просел»
  // заметно (на 1/10 ttl, т.е. раз в ~48 мин при 8 ч). Заодно запросы перестают
  // писать в БД на ровном месте: на этом держится кэш занятий (loadLessons).
  touch(sid, sess, cb) {
    try {
      const next = this._expiresOf(sess);
      const row = this.db.prepare('SELECT expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || next - row.expires > this.ttlMs / 10) {
        this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(next, sid);
      }
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = { SqliteSessionStore, ensureSessionsTable };
