'use strict';

// Журнал переносов: каждый перенос — отдельная запись цепочки. «Откуда» у шага —
// ячейка перед этим переносом, у самого раннего шага — импортная позиция.
// Возврат на импортное место снимает всю цепочку.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-movelog-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { loadLessons } = require('../../src/services/conflictService');
const { moveLesson, editLesson, getMoveLog, clearMoveLog, revertMove } = require('../../src/services/scheduleService');
const { performUndo } = require('../../src/services/undoService');
const { closeDb } = require('../../src/config/database');

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

let origin; // позиция занятия сразу после импорта
let lessonId;

test.before(() => {
  importFiles([{ buffer: fs.readFileSync(findExample('823.html')) }]);
  const L = loadLessons().find((l) => l.groups.length && !l.parked);
  lessonId = L.id;
  origin = { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo };
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

// Заведомо пустые недели за пределами импортированных — там накладок нет.
const freeWeek = (() => {
  let n = null;
  return () => {
    if (n === null) n = Math.max(...loadLessons().map((l) => l.weekNo)) + 1;
    return n++;
  };
})();

const entry = () => getMoveLog().find((e) => e.toDay);

// Цепочка переносов занятия, от раннего шага к позднему (журнал отдаёт DESC).
const chain = () => getMoveLog().filter((e) => e.lessonId === lessonId && e.action === 'move').reverse();

test('три переноса подряд — три шага: каждый «откуда» = предыдущая ячейка', () => {
  const slots = [
    { day: 'Вт', pairNo: 2, weekNo: freeWeek() },
    { day: 'Ср', pairNo: 3, weekNo: freeWeek() },
    { day: 'Чт', pairNo: 4, weekNo: freeWeek() },
  ];
  for (const s of slots) {
    const res = moveLesson(lessonId, { ...s, force: true });
    assert.equal(res.ok, true, JSON.stringify(res.reasons || []));
  }

  const steps = chain();
  assert.equal(steps.length, 3, 'каждый перенос — своя запись');

  // Первый шаг стартует с импортной позиции, дальше «откуда» = «куда» предыдущего.
  assert.deepEqual(
    [steps[0].fromDay, steps[0].fromPair, steps[0].fromWeek],
    [origin.day, origin.pairNo, origin.weekNo]
  );
  for (let i = 0; i < steps.length; i++) {
    const prev = i === 0 ? origin : slots[i - 1];
    assert.deepEqual([steps[i].fromDay, steps[i].fromPair, steps[i].fromWeek], [prev.day, prev.pairNo, prev.weekNo]);
    assert.deepEqual([steps[i].toDay, steps[i].toPair, steps[i].toWeek], [slots[i].day, slots[i].pairNo, slots[i].weekNo]);
  }

  // Верхняя запись журнала — последний шаг: предыдущая ячейка → новая.
  const head = getMoveLog()[0];
  assert.deepEqual([head.fromDay, head.fromPair, head.fromWeek], [slots[1].day, slots[1].pairNo, slots[1].weekNo]);
  assert.deepEqual([head.toDay, head.toPair, head.toWeek], [slots[2].day, slots[2].pairNo, slots[2].weekNo]);
});

test('отменить можно только последний шаг цепочки', () => {
  const steps = chain();
  const res = revertMove(steps[0].id); // самый ранний — занятие давно не там
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /не последнее изменение/i);

  const last = steps[steps.length - 1];
  assert.equal(revertMove(last.id).ok, true, 'последний шаг отменяется');
  const back = loadLessons().find((l) => l.id === lessonId);
  assert.equal(back.day, last.fromDay, 'занятие вернулось в предыдущую ячейку');
  assert.equal(chain().length, steps.length - 1, 'отменённый шаг из журнала убран');
});

test('после очистки журнала «откуда» — текущая ячейка, цепочка начинается заново', () => {
  const cur = loadLessons().find((l) => l.id === lessonId);
  clearMoveLog();
  assert.equal(getMoveLog().length, 0);

  const slot = { day: 'Пт', pairNo: 1, weekNo: freeWeek() };
  assert.equal(moveLesson(lessonId, { ...slot, force: true }).ok, true);

  const e = entry();
  assert.deepEqual([e.fromDay, e.fromPair, e.fromWeek], [cur.day, cur.pairNo, cur.weekNo]);
  assert.equal(e.toDay, slot.day);
});

test('возврат на импортное место убирает всю цепочку — чистого переноса нет', () => {
  moveLesson(lessonId, { day: 'Вт', pairNo: 2, weekNo: freeWeek(), force: true });
  assert.ok(chain().length >= 2, 'цепочка из нескольких шагов');

  assert.equal(moveLesson(lessonId, { ...origin, force: true }).ok, true);
  assert.equal(chain().length, 0, 'вся цепочка снята');

  const back = loadLessons().find((l) => l.id === lessonId);
  assert.equal(back.day, origin.day);
  assert.equal(back.pairNo, origin.pairNo);
  assert.equal(back.weekNo, origin.weekNo);
});

test('«Отменить» возвращает журнал в прежний вид — цепочку целиком', () => {
  clearMoveLog();
  const a = { day: 'Вт', pairNo: 2, weekNo: freeWeek() };
  const b = { day: 'Ср', pairNo: 3, weekNo: freeWeek() };
  assert.equal(moveLesson(lessonId, { ...a, force: true }).ok, true);
  assert.equal(moveLesson(lessonId, { ...b, force: true }).ok, true);
  const before = chain().map((e) => [e.fromDay, e.toDay]);
  assert.equal(before.length, 2);

  // Обычный перенос: отмена убирает добавленный шаг.
  assert.equal(moveLesson(lessonId, { day: 'Чт', pairNo: 4, weekNo: freeWeek(), force: true }).ok, true);
  assert.equal(chain().length, 3);
  assert.equal(performUndo().ok, true);
  assert.deepEqual(chain().map((e) => [e.fromDay, e.toDay]), before);

  // Возврат на импортное место стирает цепочку — отмена возвращает её целиком.
  assert.equal(moveLesson(lessonId, { ...origin, force: true }).ok, true);
  assert.equal(chain().length, 0);
  assert.equal(performUndo().ok, true);
  assert.deepEqual(chain().map((e) => [e.fromDay, e.toDay]), before);
});

// Вся история занятия (переносы и смены аудитории), от ранней записи к поздней.
const history = () => getMoveLog()
  .filter((e) => e.lessonId === lessonId && (e.action === 'move' || e.action === 'room'))
  .reverse();
const here = () => {
  const l = loadLessons().find((x) => x.id === lessonId);
  return [l.day, l.pairNo, l.weekNo];
};

test('ручной возврат в ячейку из цепочки обрезает цепочку до этого места, новый шаг не пишется', () => {
  clearMoveLog();
  const start = here();
  const s = ['Вт', 'Ср', 'Чт', 'Пт'].map((day, i) => ({ day, pairNo: i + 1, weekNo: freeWeek() }));
  for (const x of s) assert.equal(moveLesson(lessonId, { ...x, force: true }).ok, true);
  assert.equal(chain().length, 4);

  // В ячейку 2-го шага — шаги 3 и 4 сняты, как после двух нажатий ↩.
  assert.equal(moveLesson(lessonId, { ...s[1], force: true }).ok, true);
  const left = chain();
  assert.equal(left.length, 2, 'цепочка укорочена, а не удлинена');
  assert.deepEqual([left[1].toDay, left[1].toPair, left[1].toWeek], [s[1].day, s[1].pairNo, s[1].weekNo]);
  assert.deepEqual(here(), [s[1].day, s[1].pairNo, s[1].weekNo]);

  // В начало цепочки — снята целиком.
  assert.equal(moveLesson(lessonId, { day: start[0], pairNo: start[1], weekNo: start[2], force: true }).ok, true);
  assert.equal(chain().length, 0);
});

test('откат по цепочке снимает и смены аудитории после этого места; аудитория в журнале не расходится с расписанием', () => {
  const start = here();
  assert.equal(editLesson(lessonId, { rooms: ['ОТК-1'], force: true }).ok, true);
  clearMoveLog();
  const a = { day: 'Вт', pairNo: 1, weekNo: freeWeek() };
  const c = { day: 'Чт', pairNo: 3, weekNo: freeWeek() };
  assert.equal(moveLesson(lessonId, { ...a, force: true }).ok, true);
  assert.equal(editLesson(lessonId, { rooms: ['ОТК-2'], force: true }).ok, true);
  assert.equal(moveLesson(lessonId, { ...c, force: true }).ok, true);
  assert.deepEqual(history().map((e) => e.action), ['move', 'room', 'move']);

  // Обратно в a с той же аудиторией — остались перенос и смена аудитории.
  assert.equal(moveLesson(lessonId, { ...a, force: true }).ok, true);
  assert.deepEqual(history().map((e) => e.action), ['move', 'room']);

  // Снова в c и назад в a, но уже в ОТК-3: откат + честная запись ОТК-2 → ОТК-3.
  assert.equal(moveLesson(lessonId, { ...c, force: true }).ok, true);
  assert.equal(moveLesson(lessonId, { ...a, rooms: ['ОТК-3'], force: true }).ok, true);
  let h = history();
  assert.deepEqual(h.map((e) => e.action), ['move', 'room', 'room']);
  assert.deepEqual([h[2].fromRoom, h[2].room], ['ОТК-2', 'ОТК-3']);

  // В начало цепочки: всё снято, но аудитория-то сейчас ОТК-3, а была ОТК-1.
  assert.equal(moveLesson(lessonId, { day: start[0], pairNo: start[1], weekNo: start[2], force: true }).ok, true);
  h = history();
  assert.deepEqual(h.map((e) => e.action), ['room']);
  assert.deepEqual([h[0].fromRoom, h[0].room], ['ОТК-1', 'ОТК-3']);
});

test('«Отменить» после отката по цепочке возвращает обрезанные шаги', () => {
  clearMoveLog();
  const s = ['Вт', 'Ср', 'Чт'].map((day, i) => ({ day, pairNo: i + 1, weekNo: freeWeek() }));
  for (const x of s) assert.equal(moveLesson(lessonId, { ...x, force: true }).ok, true);
  assert.equal(moveLesson(lessonId, { ...s[0], force: true }).ok, true);
  assert.equal(chain().length, 1);

  assert.equal(performUndo().ok, true);
  assert.equal(chain().length, 3, 'шаги 2 и 3 вернулись');
  assert.deepEqual(here(), [s[2].day, s[2].pairNo, s[2].weekNo]);
});

test('возврат в ячейку с аудиторией, которая там уже была, обрезает до той записи — без лишних смен аудитории', () => {
  assert.equal(editLesson(lessonId, { rooms: ['ОТК-1'], force: true }).ok, true);
  clearMoveLog();
  const b = { day: 'Ср', pairNo: 2, weekNo: freeWeek() };
  const c = { day: 'Пт', pairNo: 4, weekNo: freeWeek() };
  assert.equal(moveLesson(lessonId, { ...b, force: true }).ok, true);              // перенос в B (ОТК-1)
  assert.equal(editLesson(lessonId, { rooms: ['ОТК-2'], force: true }).ok, true);  // в B: ОТК-1 → ОТК-2
  assert.equal(moveLesson(lessonId, { ...c, force: true }).ok, true);              // перенос B → C
  assert.deepEqual(history().map((e) => e.action), ['move', 'room', 'move']);

  // Назад в B с ОТК-1 — такая аудитория в B была сразу после переноса.
  assert.equal(moveLesson(lessonId, { ...b, rooms: ['ОТК-1'], force: true }).ok, true);
  const h = history();
  assert.deepEqual(h.map((e) => e.action), ['move'], 'остался только перенос в B');
  assert.equal(h[0].room, 'ОТК-1');
});
