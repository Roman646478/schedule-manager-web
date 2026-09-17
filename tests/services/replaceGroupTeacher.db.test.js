'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-grpteacher-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { loadLessons } = require('../../src/services/conflictService');
const { replaceGroupTeacher } = require('../../src/services/scheduleService');
const { performUndo } = require('../../src/services/undoService');
const { closeDb } = require('../../src/config/database');

// Тесты написаны под весенние примеры; в примеры/осень — тёзки другого года.
const EXAMPLES = path.join(__dirname, '..', '..', 'примеры', 'весна');
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
    try { fs.unlinkSync(TMP + ext); } catch { /* ок */ }
  }
});

test('replaceGroupTeacher mode=all: ставит преподавателя на все занятия группы и откатывается undo', () => {
  const before = loadLessons();
  const group = before.find((l) => l.groups.length && !l.event)?.groups[0];
  assert.ok(group, 'есть группа с занятиями');
  const count = before.filter((l) => !l.event && !l.parked && l.groups.includes(group)).length;

  const res = replaceGroupTeacher(group, '', 'Тестовый Т.Т.', 'all');
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  assert.equal(res.count, count);

  // Все занятия группы теперь у нового преподавателя.
  const after = loadLessons().filter((l) => !l.event && !l.parked && l.groups.includes(group));
  assert.ok(after.every((l) => l.teacher === 'Тестовый Т.Т.'), 'у всех занятий новый преподаватель');

  // Undo возвращает прежних преподавателей.
  assert.equal(performUndo().ok, true);
  const reverted = loadLessons().filter((l) => !l.event && !l.parked && l.groups.includes(group));
  const wasMap = new Map(before.filter((l) => l.groups.includes(group)).map((l) => [l.id, l.teacher]));
  assert.ok(reverted.every((l) => l.teacher === wasMap.get(l.id)), 'преподаватели восстановлены');
});

test('replaceGroupTeacher mode=all с дисциплиной: трогает только занятия этой дисциплины', () => {
  const lessons = loadLessons().filter((l) => !l.event && !l.parked && l.groups.length);
  // Группа, у которой есть минимум две разные дисциплины — чтобы проверить сужение.
  let group = null;
  let subject = null;
  for (const g of new Set(lessons.flatMap((l) => l.groups))) {
    const subs = new Set(lessons.filter((l) => l.groups.includes(g)).map((l) => l.subject || ''));
    if (subs.size >= 2) { group = g; subject = [...subs].find(Boolean); break; }
  }
  assert.ok(group && subject, 'нашлась группа с двумя дисциплинами');

  const res = replaceGroupTeacher(group, '', 'Дисц Д.Д.', 'all', subject);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const after = loadLessons().filter((l) => !l.event && !l.parked && l.groups.includes(group));
  assert.ok(
    after.filter((l) => (l.subject || '') === subject).every((l) => l.teacher === 'Дисц Д.Д.'),
    'занятия выбранной дисциплины — у нового преподавателя'
  );
  assert.ok(
    after.filter((l) => (l.subject || '') !== subject).every((l) => l.teacher !== 'Дисц Д.Д.'),
    'занятия других дисциплин не затронуты'
  );
  performUndo();
});

test('replaceGroupTeacher mode=replace: меняет только занятия исходного преподавателя', () => {
  // В примере преподаватели не проставлены — сначала ставим «Алый А.А.» на всю группу.
  const group = loadLessons().find((l) => l.groups.length && !l.event)?.groups[0];
  assert.ok(group, 'есть группа');
  assert.equal(replaceGroupTeacher(group, '', 'Алый А.А.', 'all').ok, true);

  const res = replaceGroupTeacher(group, 'Алый А.А.', 'Синий С.С.', 'replace');
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const after = loadLessons().filter((l) => !l.event && l.groups.includes(group));
  assert.ok(!after.some((l) => l.teacher === 'Алый А.А.'), 'прежний преподаватель больше не ведёт занятий группы');
  assert.ok(after.every((l) => l.teacher === 'Синий С.С.'), 'все занятия — у нового преподавателя');
  performUndo(); // отменить replace
  performUndo(); // отменить all
});
