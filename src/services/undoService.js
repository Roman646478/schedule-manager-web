'use strict';

const { getDb } = require('../config/database');
const { transaction, getOrCreate } = require('./dbService');
const { PAIR_TIMES } = require('../utils/constants');

const UNDO_MAX = 50;

// Добавить снимок состояния ДО изменения в стек. Вызывать ВНУТРИ транзакции,
// передавая tx как первый аргумент. Обрезает стек до UNDO_MAX записей.
function pushUndo(db, action, description, snapshot) {
  db.prepare(
    'INSERT INTO undo_stack (action_at, action, description, snapshot) VALUES (?, ?, ?, ?)'
  ).run(new Date().toISOString(), action, description || null, JSON.stringify(snapshot));
  db.exec(
    `DELETE FROM undo_stack WHERE id NOT IN (SELECT id FROM undo_stack ORDER BY id DESC LIMIT ${UNDO_MAX})`
  );
}


// Журнал переносов должен отражать реальное положение дел: отменяя действие,
// снимаем и его след в журнале. Для переноса возвращаем ЦЕПОЧКУ шагов ровно в то
// состояние, в каком она была до него (снимок moveLogBefore), для добавления и
// удаления — просто убираем запись этого занятия.
const MOVE_LOG_COLS = [
  'lesson_id', 'moved_at', 'action', 'groups', 'subject', 'subject_full', 'type', 'topic',
  'from_date', 'from_day', 'from_pair', 'from_week',
  'to_date', 'to_day', 'to_pair', 'to_week', 'room', 'from_room', 'teacher', 'note',
];

function restoreMoveLog(db, lessonId, before) {
  if (lessonId == null) return;
  // Снимок — массив шагов; из старых записей undo-стека мог прийти один объект.
  const rows = Array.isArray(before) ? before : (before ? [before] : []);
  db.prepare("DELETE FROM move_log WHERE lesson_id = ? AND action IN ('move', 'room')").run(lessonId);
  for (const row of rows) {
    const cols = MOVE_LOG_COLS.filter((c) => row[c] !== undefined);
    if (!cols.length) continue;
    db.prepare(
      `INSERT INTO move_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map((c) => row[c] ?? null));
  }
}

const dropLogEntry = (db, lessonId, action) => {
  if (lessonId != null) db.prepare('DELETE FROM move_log WHERE lesson_id = ? AND action = ?').run(lessonId, action);
};

// Посмотреть последнее действие без удаления (для кнопки «Отменить»).
function peekUndo(db = getDb()) {
  return db.prepare('SELECT id, action, description FROM undo_stack ORDER BY id DESC LIMIT 1').get() || null;
}

// Отменить последнее действие: восстановить состояние из снимка, удалить запись.
// Конфликты при восстановлении НЕ проверяются — пользователь явно откатывает изменение.
function performUndo(expectedId = null) {
  if (expectedId !== null && (!Number.isInteger(expectedId) || expectedId <= 0)) {
    return { ok: false, code: 400, reasons: ['Некорректный идентификатор действия'] };
  }
  return transaction((db) => {
    const last = db
      .prepare('SELECT id, action, snapshot FROM undo_stack ORDER BY id DESC LIMIT 1')
      .get();
    if (!last) return { ok: false, reasons: ['Нечего отменять'] };

    if (expectedId !== null && last.id !== expectedId) {
      return {
        ok: false,
        code: 409,
        stale: true,
        currentId: last.id,
        reasons: ['Список действий изменился. Обновите страницу и повторите отмену.'],
      };
    }

    const snap = JSON.parse(last.snapshot);
    const times = PAIR_TIMES[snap.pairNo] || { start: null, end: null };
    const teacherId = snap.teacher ? getOrCreate(db, 'teachers', 'name', snap.teacher) : null;
    // Аудитории снимка (1–2): основная (room_id) — первая, все — в lesson_rooms.
    const snapRooms = snap.rooms && snap.rooms.length ? snap.rooms : (snap.room ? [snap.room] : []);
    const roomIds = snapRooms.map((n) => getOrCreate(db, 'rooms', 'name', n));
    const roomId = roomIds[0] ?? null;
    const snapTeachers = snap.teachers && snap.teachers.length
      ? snap.teachers
      : (snap.teacher ? [snap.teacher] : []);
    const restoreTeachers = (lessonId) => {
      db.prepare('DELETE FROM lesson_teachers WHERE lesson_id = ?').run(lessonId);
      const ins = db.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) VALUES (?, ?)');
      for (const t of snapTeachers) ins.run(lessonId, getOrCreate(db, 'teachers', 'name', t));
    };
    const restoreRooms = (lessonId) => {
      db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?').run(lessonId);
      const ins = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
      for (const id of roomIds) ins.run(lessonId, id);
    };

    if (last.action === 'move' || last.action === 'edit') {
      // Отмена переноса возвращает занятие в ЯЧЕЙКУ, из которой его взяли, даже
      // если до переноса оно лежало в буфере: у отложенного занятия день/пара/
      // неделя — это слот, откуда его сняли, и составитель ждёт возврата туда, а
      // не обратно в буфер (иначе занятие исчезало из сетки, а запись журнала
      // оставалась висеть). У правки флаг буфера сохраняем как был.
      const parked = last.action === 'move' ? 0 : (snap.parked ? 1 : 0);
      const orphan = last.action === 'move' ? 0 : (snap.orphan ? 1 : 0);
      const res = db
        .prepare(
          `UPDATE lessons SET day=?, pair_no=?, week_no=?, time_start=?, time_end=?,
           subject=?, type=?, topic=?, note=?, teacher_id=?, room_id=?, parked=?, orphan=? WHERE id=?`
        )
        .run(
          snap.day, snap.pairNo, snap.weekNo, times.start, times.end,
          snap.subject ?? null, snap.type ?? null, snap.topic ?? null, snap.note ?? null,
          teacherId, roomId, parked, orphan, snap.id
        );
      if (!res.changes) return { ok: false, reasons: ['Занятие не найдено (уже удалено?)'] };

      db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ?').run(snap.id);
      const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
      for (const g of (snap.groups || [])) {
        insLG.run(snap.id, getOrCreate(db, 'groups', 'name', g));
      }
      restoreTeachers(snap.id);
      restoreRooms(snap.id);
      // Перенос отменён — журнал возвращаем в прежний вид. Правка карточки тоже
      // пишет в журнал (смена слота или аудитории), поэтому её снимок несёт
      // цепочку; у снимков старого формата поля нет — журнал не трогаем.
      if (last.action === 'move' || snap.moveLogBefore !== undefined) {
        restoreMoveLog(db, snap.id, snap.moveLogBefore);
      }

    } else if (last.action === 'create') {
      db.prepare('DELETE FROM lessons WHERE id = ?').run(snap.id);
      dropLogEntry(db, snap.id, 'create');

    } else if (last.action === 'vacation') {
      // Массовый отпуск — удаляем созданные метки «Отп» и возвращаем из буфера
      // занятия, которые были туда перемещены.
      const del = db.prepare('DELETE FROM lessons WHERE id = ?');
      for (const id of (snap.ids || [])) del.run(id);
      const unpark = db.prepare('UPDATE lessons SET parked = 0 WHERE id = ?');
      for (const id of (snap.parkedIds || [])) unpark.run(id);
      // Аудитории, проставленные меткам ЭкзС при расстановке СР: их до этого не
      // было, поэтому откат — просто снять аудиторию (сама метка остаётся).
      const clrRoom = db.prepare('UPDATE lessons SET room_id = NULL WHERE id = ?');
      const clrLR = db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?');
      for (const id of (snap.ecsRoomIds || [])) {
        clrRoom.run(id);
        clrLR.run(id);
      }
      // Копии метки ЭкзС (курс сел в несколько аудиторий): копию удаляем, её
      // группы возвращаем исходной метке — расстановки не было, метка снова одна.
      const insLGe = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
      for (const sp of (snap.ecsSplit || [])) {
        del.run(sp.id);
        for (const g of (sp.groups || [])) insLGe.run(sp.from, getOrCreate(db, 'groups', 'name', g));
      }

    } else if (last.action === 'delete') {
      const info = db
        .prepare(
          `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no,
           subject, type, topic, note, teacher_id, room_id, parked, locked, orphan)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snap.day, snap.pairNo, times.start, times.end, snap.weekNo,
          snap.subject ?? null, snap.type ?? null, snap.topic ?? null, snap.note ?? null,
          teacherId, roomId, snap.parked ? 1 : 0, snap.locked ? 1 : 0, snap.orphan ? 1 : 0
        );
      const newId = Number(info.lastInsertRowid);
      const insLG = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
      for (const g of (snap.groups || [])) {
        insLG.run(newId, getOrCreate(db, 'groups', 'name', g));
      }
      restoreTeachers(newId);
      restoreRooms(newId);
      dropLogEntry(db, snap.id, 'delete');

    } else if (last.action === 'deleteEntity' || last.action === 'decommission') {
      // deleteEntity — восстановить снимки. Записи, созданные тем же действием
      // (метки причины у decommission, вставленное на место СР занятие), лежат в
      // snap.ids: их удаляем вместе со следом в журнале создания.
      const delMark = db.prepare('DELETE FROM lessons WHERE id = ?');
      for (const id of (snap.ids || [])) {
        delMark.run(id);
        dropLogEntry(db, id, 'create');
      }
      // Восстанавливаем каждый снимок: если занятие удалено — вставляем заново;
      // если только изменено (аудитория/группа/преподаватель) — обновляем поля.
      const insLG2 = db.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)');
      const insLT2 = db.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) VALUES (?, ?)');
      const insLR2 = db.prepare('INSERT OR IGNORE INTO lesson_rooms (lesson_id, room_id) VALUES (?, ?)');
      for (const s of (snap.snapshots || [])) {
        const sTimes = PAIR_TIMES[s.pairNo] || { start: null, end: null };
        const sTeacherId = s.teacher ? getOrCreate(db, 'teachers', 'name', s.teacher) : null;
        const sRooms = s.rooms && s.rooms.length ? s.rooms : (s.room ? [s.room] : []);
        const sRoomIds = sRooms.map((n) => getOrCreate(db, 'rooms', 'name', n));
        const sTeachers = s.teachers && s.teachers.length ? s.teachers : (s.teacher ? [s.teacher] : []);
        const exists = db.prepare('SELECT id FROM lessons WHERE id = ?').get(s.id);
        let lid;
        if (exists) {
          db.prepare(
            `UPDATE lessons SET day=?, pair_no=?, week_no=?, time_start=?, time_end=?,
             subject=?, type=?, topic=?, note=?, teacher_id=?, room_id=?, parked=?, locked=?, orphan=? WHERE id=?`
          ).run(s.day, s.pairNo, s.weekNo, sTimes.start, sTimes.end,
            s.subject ?? null, s.type ?? null, s.topic ?? null, s.note ?? null,
            sTeacherId, sRoomIds[0] ?? null, s.parked ? 1 : 0, s.locked ? 1 : 0, s.orphan ? 1 : 0, s.id);
          lid = s.id;
        } else {
          const info2 = db.prepare(
            `INSERT INTO lessons (day, pair_no, time_start, time_end, week_no,
             subject, type, topic, note, teacher_id, room_id, parked, locked, orphan)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(s.day, s.pairNo, sTimes.start, sTimes.end, s.weekNo,
            s.subject ?? null, s.type ?? null, s.topic ?? null, s.note ?? null,
            sTeacherId, sRoomIds[0] ?? null, s.parked ? 1 : 0, s.locked ? 1 : 0, s.orphan ? 1 : 0);
          lid = Number(info2.lastInsertRowid);
        }
        db.prepare('DELETE FROM lesson_groups WHERE lesson_id = ?').run(lid);
        for (const g of (s.groups || [])) insLG2.run(lid, getOrCreate(db, 'groups', 'name', g));
        db.prepare('DELETE FROM lesson_teachers WHERE lesson_id = ?').run(lid);
        for (const t of sTeachers) insLT2.run(lid, getOrCreate(db, 'teachers', 'name', t));
        db.prepare('DELETE FROM lesson_rooms WHERE lesson_id = ?').run(lid);
        for (const rid of sRoomIds) if (rid != null) insLR2.run(lid, rid);
        // Массовый ПЕРЕНОС (разгрузка 4-й пары) кладёт в снимок и состояние
        // журнала: иначе после отката оставался бы след переноса, которого
        // больше нет. У снимков без этого поля журнал не трогаем.
        if (s.moveLogBefore !== undefined) restoreMoveLog(db, s.id, s.moveLogBefore);
      }
    }

    db.prepare('DELETE FROM undo_stack WHERE id = ?').run(last.id);
    return { ok: true };
  });
}

module.exports = { pushUndo, peekUndo, performUndo };
