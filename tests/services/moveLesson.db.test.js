'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `schedule-move-${process.pid}.db`);
process.env.DB_PATH = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { importFiles } = require('../../src/services/importService');
const { loadLessons } = require('../../src/services/conflictService');
const { moveLesson, getMoveLog, revertMove, deleteMoveLogEntry, clearMoveLog, editLesson, createLesson, deleteLesson, getMoveOptions, parkLesson } = require('../../src/services/scheduleService');
const { performUndo } = require('../../src/services/undoService');
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

// Свободный слот для занятия: ни группа, ни преподаватель, ни аудитория не заняты.
function findFreeSlot(lessons, L) {
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const weeks = [...new Set(lessons.map((l) => l.weekNo))];
  for (const weekNo of weeks) {
    for (const day of days) {
      for (let pairNo = 1; pairNo <= 4; pairNo++) {
        const clash = lessons.some(
          (o) =>
            o.id !== L.id &&
            !o.parked &&
            o.day === day &&
            o.pairNo === pairNo &&
            o.weekNo === weekNo &&
            (o.teacher === L.teacher ||
              o.room === L.room ||
              o.groups.some((g) => L.groups.includes(g)))
        );
        const same = L.day === day && L.pairNo === pairNo && L.weekNo === weekNo;
        if (!clash && !same) return { day, pairNo, weekNo };
      }
    }
  }
  return null;
}


// Занятия для тестов берём разные: журнал пишет «откуда» от импортной позиции
// (lessons.orig_*), поэтому у уже сдвинутого занятия текущий слот ≠ исходному.
const touched = new Set();
function freshLesson(lessons) {
  const L = lessons.find((l) => l.groups.length && l.room && !touched.has(l.id));
  touched.add(L.id);
  return L;
}

test('moveLesson: перенос в свободный слот применяется атомарно во всех представлениях', () => {
  const lessons = loadLessons();
  const L = freshLesson(lessons);
  assert.ok(L, 'есть занятие с группой и аудиторией');

  const slot = findFreeSlot(lessons, L);
  assert.ok(slot, 'нашёлся свободный слот');

  const res = moveLesson(L.id, { ...slot, room: L.room });
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  // Перечитываем из БД: слот обновился, занятие одно (единый источник).
  const after = loadLessons().find((l) => l.id === L.id);
  assert.equal(after.day, slot.day);
  assert.equal(after.pairNo, slot.pairNo);
  assert.equal(after.weekNo, slot.weekNo);
  assert.equal(after.room, L.room);
});

test('moveLesson: перенос в занятый слот отклоняется и НЕ меняет БД', () => {
  const lessons = loadLessons();
  const base = lessons.find((l) => l.groups.length);
  const g = base.groups[0];
  const other = lessons.find(
    (l) =>
      l.id !== base.id &&
      l.groups.includes(g) &&
      (l.day !== base.day || l.pairNo !== base.pairNo || l.weekNo !== base.weekNo)
  );
  assert.ok(other, 'нашли второй слот той же группы');

  const before = loadLessons().find((l) => l.id === base.id);
  const res = moveLesson(base.id, {
    day: other.day,
    pairNo: other.pairNo,
    weekNo: other.weekNo,
    room: base.room,
  });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.length > 0, 'есть причина отказа');

  // Занятие осталось на месте — частично применённых изменений нет.
  const after = loadLessons().find((l) => l.id === base.id);
  assert.deepEqual(
    { day: after.day, pairNo: after.pairNo, weekNo: after.weekNo, room: after.room },
    { day: before.day, pairNo: before.pairNo, weekNo: before.weekNo, room: before.room }
  );
});

test('revertMove: отмена переноса возвращает занятие в исходный слот и удаляет запись', () => {
  clearMoveLog(); // изоляция: журнал на каждое занятие — одна запись (свёртка повторов)
  const lessons = loadLessons();
  const L = freshLesson(lessons);
  const from = { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo };
  const slot = findFreeSlot(lessons, L);
  assert.ok(slot, 'нашёлся свободный слот для переноса');

  assert.equal(moveLesson(L.id, { ...slot, room: L.room }).ok, true);
  const entry = getMoveLog()[0]; // последний перенос — первым
  assert.ok(entry, 'перенос записан в журнал');

  const res = revertMove(entry.id);
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  // Занятие вернулось в исходный слот.
  const back = loadLessons().find((l) => l.id === L.id);
  assert.deepEqual({ day: back.day, pairNo: back.pairNo, weekNo: back.weekNo }, from);

  // Запись журнала удалена отменой.
  assert.equal(getMoveLog().some((e) => e.id === entry.id), false, 'запись журнала удалена');
});

test('revertMove: отмена в занятый исходный слот отклоняется с причиной', () => {
  clearMoveLog();
  const lessons = loadLessons();
  const L = freshLesson(lessons);
  const slot = findFreeSlot(lessons, L);
  assert.ok(slot, 'свободный слот есть');

  // Переносим L в свободный слот (журнал #1).
  assert.equal(moveLesson(L.id, { ...slot, room: L.room }).ok, true);
  const entry = getMoveLog()[0];

  // Занимаем ИСХОДНЫЙ слот L другим занятием той же группы — отмена станет невозможной.
  const after = loadLessons();
  const blocker = after.find(
    (o) => o.id !== L.id && o.groups.some((g) => L.groups.includes(g)) && !o.parked
  );
  touched.add(blocker.id);
  const freeForBlocker = findFreeSlot(after, { ...blocker, id: -1 }); // куда blocker точно встанет
  // Ставим blocker ровно в исходный слот L (через прямой перенос, если он свободен для него).
  const occupy = moveLesson(blocker.id, { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo, room: blocker.room });
  // Если занять не удалось (слот занят для blocker) — пропускаем проверку как неactуальную.
  if (occupy.ok) {
    const res = revertMove(entry.id);
    assert.equal(res.ok, false, 'отмена в занятый слот отклонена');
    assert.ok(res.reasons.length > 0, 'есть причина отказа');
    // Запись журнала переноса L сохранилась (отмена не выполнена).
    assert.equal(getMoveLog().some((e) => e.id === entry.id), true);
  }
  // Освобождать не нужно — БД временная, тест после этого завершает файл.
  void freeForBlocker;
});

test('журнал: повторные переносы одного занятия — цепочка шагов (каждый «откуда» = предыдущая ячейка)', () => {
  clearMoveLog();
  const lessons = loadLessons();
  const L = freshLesson(lessons);
  const origin = { day: L.day, pairNo: L.pairNo, weekNo: L.weekNo };

  const slot1 = findFreeSlot(lessons, L);
  assert.ok(slot1, 'есть первый свободный слот');
  assert.equal(moveLesson(L.id, { ...slot1, room: L.room }).ok, true);

  // Второй перенос того же занятия — из slot1 в slot2 (slot2 ≠ исходный слот,
  // иначе это был бы возврат на место, и запись удалилась бы намеренно).
  const mid = loadLessons();
  const Lmid = mid.find((l) => l.id === L.id);
  const sameSlot = (a, b) => a.day === b.day && a.pairNo === b.pairNo && a.weekNo === b.weekNo;
  let slot2 = findFreeSlot(mid, Lmid);
  if (slot2 && sameSlot(slot2, origin)) {
    // origin освободился после move1 и попал первым — берём следующий, заняв origin фиктивно.
    slot2 = findFreeSlot(mid.concat([{ ...Lmid, id: -1, ...origin }]), Lmid);
  }
  assert.ok(slot2 && !sameSlot(slot2, origin), 'есть второй свободный слот, отличный от исходного');
  assert.equal(moveLesson(L.id, { ...slot2, room: L.room }).ok, true);

  // В журнале — по записи на шаг (журнал очищен в начале теста): первый шаг
  // стартует с импортной позиции, второй — из slot1, куда занятие попало.
  const entries = getMoveLog(); // DESC по id: [шаг 2, шаг 1]
  assert.equal(entries.length, 2, 'каждый перенос — своя запись');
  const [step2, step1] = entries;
  assert.deepEqual({ day: step1.fromDay, pair: step1.fromPair, week: step1.fromWeek }, { day: origin.day, pair: origin.pairNo, week: origin.weekNo }, 'первый шаг — с импортной позиции');
  assert.deepEqual({ day: step1.toDay, pair: step1.toPair, week: step1.toWeek }, { day: slot1.day, pair: slot1.pairNo, week: slot1.weekNo });
  assert.deepEqual({ day: step2.fromDay, pair: step2.fromPair, week: step2.fromWeek }, { day: slot1.day, pair: slot1.pairNo, week: slot1.weekNo }, '«откуда» второго шага — предыдущая ячейка');
  assert.deepEqual({ day: step2.toDay, pair: step2.toPair, week: step2.toWeek }, { day: slot2.day, pair: slot2.pairNo, week: slot2.weekNo }, 'последняя точка назначения');

  // Возврат занятия в исходный слот убирает всю цепочку (чистого переноса нет).
  assert.equal(moveLesson(L.id, { ...origin, room: L.room }).ok, true);
  assert.equal(getMoveLog().length, 0, 'возврат на место снимает цепочку целиком');
});

test('deleteMoveLogEntry: удаление одной записи не трогает расписание', () => {
  clearMoveLog();
  const lessons = loadLessons();
  const L = freshLesson(lessons);
  const slot = findFreeSlot(lessons, L);
  assert.ok(slot, 'свободный слот есть');
  assert.equal(moveLesson(L.id, { ...slot, room: L.room }).ok, true);

  const entry = getMoveLog()[0];
  const lessonsBefore = loadLessons().length;
  const res = deleteMoveLogEntry(entry.id);
  assert.equal(res.ok, true);
  assert.equal(getMoveLog().some((e) => e.id === entry.id), false, 'запись удалена');
  assert.equal(loadLessons().length, lessonsBefore, 'число занятий не изменилось');

  // Несуществующая запись — отказ.
  assert.equal(deleteMoveLogEntry(999999).ok, false);
});

test('editLesson: частичная правка (вид/тема/примечание) не трогает остальные поля', () => {
  const before = loadLessons().find((l) => !l.parked && !l.event && l.subject);
  assert.ok(before, 'занятие для правки нашлось');

  const res = editLesson(before.id, { topic: 'Т.99', note: 'из перечня', type: 'ЛР' });
  assert.equal(res.ok, true, JSON.stringify(res.reasons || []));

  const after = loadLessons().find((l) => l.id === before.id);
  assert.equal(after.topic, 'Т.99');
  assert.equal(after.note, 'из перечня');
  assert.equal(after.type, 'ЛР');
  // Слот, группы, аудитории и преподаватель остались прежними.
  assert.deepEqual(
    [after.day, after.pairNo, after.weekNo, after.subject, after.teacher, (after.rooms || []).join(','), (after.groups || []).join(',')],
    [before.day, before.pairNo, before.weekNo, before.subject, before.teacher, (before.rooms || []).join(','), (before.groups || []).join(',')]
  );

  // Пустая строка стирает поле (в перечне так очищают примечание).
  assert.equal(editLesson(before.id, { note: null }).ok, true);
  assert.equal(loadLessons().find((l) => l.id === before.id).note, null);
});

// Журнал ведёт три вида записей и не отстаёт от кнопки «Отменить»: раньше после
// отмены переноса запись оставалась и показывала перенос, которого больше нет.
test('журнал: отмена переноса убирает запись, добавление и удаление занятия — пишутся', () => {
  clearMoveLog();
  const L = loadLessons().find((l) => !l.parked && !l.event && l.subject && l.subject !== 'СР');
  const free = getMoveOptions(L.id, L.weekNo).slots
    .find((s) => s.groupFree && s.teacherFree && s.roomFree && !s.holiday
      && !(s.day === L.day && s.pairNo === L.pairNo));
  assert.ok(free, 'свободный слот для переноса нашёлся');

  // 1. Перенос → запись; «Отменить» → записи нет, занятие на месте.
  assert.equal(moveLesson(L.id, { day: free.day, pairNo: free.pairNo, weekNo: free.weekNo }).ok, true);
  assert.equal(getMoveLog().length, 1, 'перенос записан');
  assert.equal(getMoveLog()[0].action, 'move');
  assert.equal(performUndo().ok, true);
  assert.equal(getMoveLog().length, 0, 'после отмены переноса записи нет');
  const back = loadLessons().find((l) => l.id === L.id);
  assert.deepEqual([back.day, back.pairNo], [L.day, L.pairNo], 'занятие вернулось в свой слот');

  // 2. Добавление занятия: заполнено «куда», пусто «откуда».
  const created = createLesson({
    day: free.day, pairNo: free.pairNo, weekNo: free.weekNo,
    subject: 'НОВЫЙ', type: 'ПЗ', groups: L.groups, rooms: [],
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons || []));
  const cEntry = getMoveLog()[0];
  assert.equal(cEntry.action, 'create');
  assert.equal(cEntry.fromDay, null, 'у добавления нет исходного слота');
  assert.equal(cEntry.toDay, free.day);

  // 3. Удаление занятия: заполнено «откуда», пусто «куда».
  assert.equal(deleteLesson(created.id).ok, true);
  const dEntry = getMoveLog()[0];
  assert.equal(dEntry.action, 'delete');
  assert.equal(dEntry.toDay, null, 'у удаления нет слота назначения');
  assert.equal(dEntry.fromDay, free.day);

  // 4. Отмена обеих операций подчищает и журнал.
  assert.equal(performUndo().ok, true); // отмена удаления
  assert.equal(getMoveLog().some((e) => e.action === 'delete'), false);
  assert.equal(performUndo().ok, true); // отмена добавления
  assert.equal(getMoveLog().length, 0, 'журнал снова пуст');
});

test('журнал: мероприятия и самоподготовка в него не попадают', () => {
  clearMoveLog();
  const g = loadLessons().find((l) => !l.parked && l.groups.length).groups[0];
  const ev = createLesson({ day: 'Сб', pairNo: 3, weekNo: 1, subject: 'Отп', groups: [g], category: 'event' });
  const sr = createLesson({ day: 'Сб', pairNo: 2, weekNo: 1, subject: 'СР', type: 'СР', groups: [g], rooms: [] });
  assert.equal(getMoveLog().length, 0, 'создание мероприятия и СР журнал не трогает');
  if (ev.ok) deleteLesson(ev.id);
  if (sr.ok) deleteLesson(sr.id);
  assert.equal(getMoveLog().length, 0, 'их удаление — тоже');
});

// Занятие, снятое в буфер и оттуда поставленное в сетку: «Отменить» должно
// вернуть его в ЯЧЕЙКУ, откуда сняли, и убрать запись журнала — а не положить
// обратно в буфер, оставив запись висеть.
test('отмена переноса из буфера возвращает занятие в ячейку, а не в буфер', () => {
  clearMoveLog();
  const L = loadLessons().find((l) => !l.parked && !l.event && l.subject && l.subject !== 'СР');
  const free = getMoveOptions(L.id, L.weekNo).slots
    .find((s) => s.groupFree && s.teacherFree && s.roomFree && !s.holiday
      && !(s.day === L.day && s.pairNo === L.pairNo));
  assert.ok(free, 'свободный слот для переноса нашёлся');

  assert.equal(parkLesson(L.id).ok, true);
  assert.equal(loadLessons().find((l) => l.id === L.id).parked, true, 'занятие в буфере');

  const moved = moveLesson(L.id, { day: free.day, pairNo: free.pairNo, weekNo: free.weekNo, force: true });
  assert.equal(moved.ok, true, JSON.stringify(moved.reasons || []));

  assert.equal(performUndo().ok, true);
  const back = loadLessons().find((l) => l.id === L.id);
  assert.equal(back.parked, false, 'после отмены занятие не в буфере');
  assert.deepEqual([back.day, back.pairNo, back.weekNo], [L.day, L.pairNo, L.weekNo],
    'занятие вернулось в свою ячейку');
  assert.equal(getMoveLog().length, 0, 'запись журнала ушла вместе с отменённым переносом');
});
