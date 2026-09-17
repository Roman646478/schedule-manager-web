'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-conflict-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { findAllErrors, loadLessons, validateMoveById } = require('../../src/services/conflictService');
const { closeDb } = require('../../src/config/database');

// Тесты написаны под весенние примеры; в примеры/осень — тёзки другого года.
const EXAMPLES = path.join(__dirname, '..', '..', 'примеры', 'весна');
// Примеры разложены по подпапкам (группы/аудитории/преподователи) — ищем по имени.
function findExample(name) {
  const stack = [EXAMPLES];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  throw new Error(`Пример не найден: ${name}`);
}
const read = (name) => fs.readFileSync(findExample(name));

test.before(() => {
  importFiles([
    { buffer: read('823.html') },
    { buffer: read('262-7.html') },
    { buffer: read('ГребенникЕ.А..html') },
  ]);
});

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP + ext);
    } catch {
      /* ок */
    }
  }
});

test('findAllErrors: возвращает структурированный отчёт', () => {
  const r = findAllErrors();
  assert.ok(Array.isArray(r.overlaps));
  assert.ok(Array.isArray(r.capacity));
  assert.ok(Array.isArray(r.references));
  assert.equal(r.total, r.overlaps.length + r.capacity.length + r.references.length);
  // Импорт строит ссылки сам — битых ссылок быть не должно.
  assert.equal(r.references.length, 0, 'после импорта ссылки целостны');
});

test('validateMoveById: перенос на занятый группой слот → отказ', () => {
  const lessons = loadLessons();
  // Берём занятие и другой слот той же группы.
  const base = lessons.find((l) => l.groups.length);
  const g = base.groups[0];
  const other = lessons.find(
    (l) => l.id !== base.id && l.groups.includes(g) && (l.day !== base.day || l.pairNo !== base.pairNo || l.weekNo !== base.weekNo)
  );
  assert.ok(other, 'нашли второй слот той же группы');

  const res = validateMoveById(base.id, {
    day: other.day,
    pairNo: other.pairNo,
    weekNo: other.weekNo,
    room: base.room,
  });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((x) => /Группа/.test(x)), 'причина — занятость группы');
});
