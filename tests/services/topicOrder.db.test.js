'use strict';

// Расстановка тем по порядку во ВРЕМЕННОЙ БД (путь задаём до require config/database).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-topics-test-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonTopic, sortTopics } = require('../../src/services/topicOrderService');
const { getDb, closeDb, reopenDb } = require('../../src/config/database');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP + ext);
    } catch {
      /* нет файла — ок */
    }
  }
});

// Занятие группы в слоте (неделя 1, Пн, пара n) с темой.
function makeLesson(db, groupIds, { pair, subject, type, topic, parked = 0 }) {
  const id = Number(
    db
      .prepare('INSERT INTO lessons (day, pair_no, week_no, subject, type, topic, parked) VALUES (?,?,?,?,?,?,?)')
      .run('Пн', pair, 1, subject, type, topic, parked).lastInsertRowid
  );
  for (const g of groupIds) db.prepare('INSERT INTO lesson_groups (lesson_id, group_id) VALUES (?,?)').run(id, g);
  return id;
}

const topicsOf = (db, ids) => ids.map((id) => db.prepare('SELECT topic FROM lessons WHERE id = ?').get(id).topic);

test('canonTopic: приводит написание к единому виду и даёт порядок', () => {
  assert.equal(canonTopic('вв.').text, 'ВВ');
  assert.equal(canonTopic('T.4.').text, 'Т.4'); // латинская T
  assert.equal(canonTopic('Т 7').text, 'Т.7');
  for (const s of ['ЗАКЛ', 'ЗАК.', 'ЗКЛ', 'ЗК', 'заключение']) assert.equal(canonTopic(s).text, 'ЗАКЛ.');
  assert.ok(canonTopic('ВВ').rank < canonTopic('Т.1').rank);
  assert.ok(canonTopic('Т.2').rank < canonTopic('Т.10').rank); // 10, а не «10» строкой
  assert.ok(canonTopic('Т.99').rank < canonTopic('ЗАКЛ.').rank);
  for (const s of ['КР', 'ЛР5', 'РГР', '', null]) assert.equal(canonTopic(s), null); // вне порядка
});

test('sortTopics: ВВ → Т.1…Т.N → ЗАКЛ. по слотам, набор тем сохраняется', () => {
  const db = getDb();
  const g = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('G1').lastInsertRowid);
  // Порядок в сетке заведомо перепутан: ЗАКЛ. в середине, ВВ в конце.
  const ids = [
    makeLesson(db, [g], { pair: 1, subject: 'ОТ', type: 'Л', topic: 'Т.2' }),
    makeLesson(db, [g], { pair: 2, subject: 'ОТ', type: 'Л', topic: 'ЗК' }),
    makeLesson(db, [g], { pair: 3, subject: 'ОТ', type: 'Л', topic: 'КР' }), // не участвует
    makeLesson(db, [g], { pair: 4, subject: 'ОТ', type: 'Л', topic: 'T.1' }),
    makeLesson(db, [g], { pair: 5, subject: 'ОТ', type: 'Л', topic: 'вв' }),
    makeLesson(db, [g], { pair: 6, subject: 'ОТ', type: 'Л', topic: 'Т.2' }),
  ];
  // Другой вид занятия той же дисциплины нумеруется отдельно, а не продолжает лекции.
  const pz = [
    makeLesson(db, [g], { pair: 1, subject: 'ОТ', type: 'ПЗ', topic: 'Т.5' }),
    makeLesson(db, [g], { pair: 2, subject: 'ОТ', type: 'ПЗ', topic: 'Т.3' }),
  ];
  const park = makeLesson(db, [g], { pair: 7, subject: 'ОТ', type: 'Л', topic: 'Т.1', parked: 1 });

  assert.equal(sortTopics().changed, 7); // 5 в лекциях + 2 в ПЗ
  assert.deepEqual(topicsOf(db, ids), ['ВВ', 'Т.1', 'КР', 'Т.2', 'Т.2', 'ЗАКЛ.']);
  assert.deepEqual(topicsOf(db, pz), ['Т.3', 'Т.5']);
  assert.deepEqual(topicsOf(db, [park]), ['Т.1'], 'отложенное в буфер не трогаем');
  assert.equal(sortTopics().changed, 0, 'повторный вызов ничего не меняет');
});

test('sortTopics: потоковое занятие получает одну тему на все группы', () => {
  const db = getDb();
  db.exec('DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM groups;');
  const a = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('A').lastInsertRowid);
  const b = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('B').lastInsertRowid);
  const stream1 = makeLesson(db, [a, b], { pair: 1, subject: 'Ф', type: 'Л', topic: 'Т.3' });
  const soloA = makeLesson(db, [a], { pair: 2, subject: 'Ф', type: 'Л', topic: 'Т.1' });
  const stream2 = makeLesson(db, [a, b], { pair: 3, subject: 'Ф', type: 'Л', topic: 'Т.2' });

  sortTopics();
  assert.deepEqual(topicsOf(db, [stream1, soloA, stream2]), ['Т.1', 'Т.2', 'Т.3']);
  assert.equal(sortTopics().changed, 0, 'сходится: второй прогон уже без правок');
});

test('sortTopics: обычная правка считает только затронутую связку, кнопка — всю базу', () => {
  const db = getDb();
  db.exec('DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM groups; DELETE FROM topic_dirty;');
  const g = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('G2').lastInsertRowid);
  const тронем = [
    makeLesson(db, [g], { pair: 1, subject: 'A', type: 'Л', topic: 'Т.2' }),
    makeLesson(db, [g], { pair: 2, subject: 'A', type: 'Л', topic: 'Т.1' }),
  ];
  const мимо = [
    makeLesson(db, [g], { pair: 3, subject: 'B', type: 'Л', topic: 'Т.2' }),
    makeLesson(db, [g], { pair: 4, subject: 'B', type: 'Л', topic: 'Т.1' }),
  ];
  db.exec('DELETE FROM topic_dirty'); // как будто база уже разобрана
  assert.equal(sortTopics().changed, 0, 'без пометок обычный вызов не делает ничего');

  // Пометка появляется сама — от правки занятия (триггер на lessons). Правка
  // «ни на что» (то же значение) связку не помечает: триггер смотрит на разницу.
  db.prepare('UPDATE lessons SET topic = ? WHERE id = ?').run('Т.2', тронем[0]);
  assert.equal(sortTopics().changed, 0, 'запись того же значения пометки не даёт');
  db.prepare('UPDATE lessons SET topic = ? WHERE id = ?').run('T.2', тронем[0]); // латинская T
  assert.equal(sortTopics().changed, 2, 'пересчитана только связка A');
  assert.deepEqual(topicsOf(db, тронем), ['Т.1', 'Т.2']);
  assert.deepEqual(topicsOf(db, мимо), ['Т.2', 'Т.1'], 'чужая связка не тронута');

  assert.equal(sortTopics({ all: true }).changed, 2, 'кнопка проходит всю базу');
  assert.deepEqual(topicsOf(db, мимо), ['Т.1', 'Т.2']);
  assert.equal(sortTopics({ all: true }).changed, 0);
});

test('база пришла со стороны (откат к архиву): порядок восстанавливается при открытии', () => {
  const db = getDb();
  db.exec('DELETE FROM lesson_groups; DELETE FROM lessons; DELETE FROM groups; DELETE FROM topic_dirty;');
  const g = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run('G3').lastInsertRowid);
  const ids = [
    makeLesson(db, [g], { pair: 1, subject: 'C', type: 'Л', topic: 'Т.2' }),
    makeLesson(db, [g], { pair: 2, subject: 'C', type: 'Л', topic: 'Т.1' }),
  ];
  // Подменённый файл БД пометок не несёт — триггеры при подмене не срабатывали.
  db.exec('DELETE FROM topic_dirty');
  assert.equal(sortTopics().changed, 0, 'без переоткрытия пометок нет');

  reopenDb(); // как после отката к архиву
  assert.equal(sortTopics().changed, 2, 'открытие базы метит всё — проход по всей базе');
  assert.deepEqual(topicsOf(getDb(), ids), ['Т.1', 'Т.2']);
});
