'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeSchedules, bestTeacherOffset } = require('../../src/services/importService');

// Хелпер для краткости создания «сырого» занятия из парсера.
const L = (o) => ({ category: 'lesson', pairLabel: '', timeStart: '9.00', timeEnd: '10.35', note: null, groups: [], ...o });

test('mergeSchedules: база групп, поток, добор аудиторий, простановка препода, кандидаты', () => {
  const groupG1 = {
    kind: 'group',
    owner: 'G1',
    subjects: {
      MATH: { fullName: 'Математика', dept: '1', lecturers: ['Иванов И.И.'], others: ['Петров П.П.'] },
      PHYS: { fullName: 'Физика', dept: '2', lecturers: ['Сидоров С.С.'], others: ['Кузнецов К.К.'] },
    },
    lessons: [
      L({ day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', subject: 'MATH', room: '101', groups: ['G1'] }),
    ],
  };
  // Тот же физический слот+аудитория+предмет у другой группы → поток.
  const groupG2 = {
    kind: 'group',
    owner: 'G2',
    subjects: {},
    lessons: [
      L({ day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', subject: 'MATH', room: '101', groups: ['G2'] }),
    ],
  };
  const roomFile = {
    kind: 'room',
    owner: '101',
    subjects: {},
    lessons: [
      // Уже есть в базе → не добавляем, но группа подтянется.
      L({ day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', subject: 'MATH', room: '101', groups: ['G1'] }),
      // Нет в базе → добор.
      L({ day: 'Пн', pairNo: 2, weekNo: 1, type: 'П', subject: 'PHYS', room: '101', groups: ['G1'] }),
    ],
  };
  const teacherFile = {
    kind: 'teacher',
    owner: 'Иванов И.И.',
    subjects: {},
    lessons: [
      L({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'MATH', room: '101', groups: ['G1'] }),
    ],
  };

  const { lessons, report } = mergeSchedules({
    groups: [groupG1, groupG2],
    rooms: [roomFile],
    teachers: [teacherFile],
  });

  assert.equal(lessons.length, 2, 'MATH (поток) + PHYS (добор)');
  assert.equal(report.addedFromRooms, 1);
  assert.equal(report.teachersAssigned, 1);
  assert.equal(report.streams, 1);

  const math = lessons.find((l) => l.subject === 'MATH');
  assert.deepEqual(math.groups.sort(), ['G1', 'G2']);
  assert.equal(math.teacher, 'Иванов И.И.');

  const phys = lessons.find((l) => l.subject === 'PHYS');
  assert.equal(phys.teacher, null);
  // PHYS — практическое (тип «П»), значит кандидаты из «других видов занятий».
  assert.deepEqual(phys.candidateTeachers, ['Кузнецов К.К.']);
});

test('mergeSchedules: занятие препода без совпадения в базе → аннотация teacherOnly', () => {
  const teacherFile = {
    kind: 'teacher',
    owner: 'Иванов И.И.',
    subjects: {},
    lessons: [L({ day: 'Вт', pairNo: 3, weekNo: 4, subject: 'MATH', room: '999', groups: ['G9'] })],
  };
  const { lessons, report } = mergeSchedules({ teachers: [teacherFile] });
  // Базового занятия в партии нет — заводим аннотацию преподавателя (teacherOnly):
  // при импорте она проставит ФИО уже существующему занятию, а если такого нет —
  // создаст занятие с чужой (скрытой) группой, см. importFiles.db.test.js.
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].teacherOnly, true);
  assert.equal(lessons[0].teacher, 'Иванов И.И.');
  assert.equal(report.teacherUnmatched, 1);
});

// Ключи слота как в importFiles: день|пара|неделя|дисциплина|группа (по ключу
// на группу; без групп — «голый» ключ с пустой группой).
const coreKey = (l) => [l.day, l.pairNo, l.weekNo, l.subject || ''].join('|');
const slotKeys = (l) => {
  const gs = l.groups || [];
  return gs.length ? gs.map((g) => `${coreKey(l)}|${g}`) : [`${coreKey(l)}|`];
};

test('bestTeacherOffset: подбирает сдвиг по максимуму совпадений, перекрывая кривой авто-сдвиг', () => {
  // Доверенные слоты групп: УПОС, Пн пара1, недели 5..10 (без групп).
  const refSlots = new Set();
  for (let w = 5; w <= 10; w += 1) refSlots.add(`${coreKey({ day: 'Пн', pairNo: 1, weekNo: w, subject: 'УПОС' })}|`);
  // Файл преподавателя: те же пары, но локальные недели 1..6.
  const file = {
    lessons: Array.from({ length: 6 }, (_, i) => L({ day: 'Пн', pairNo: 1, weekNo: i + 1, subject: 'УПОС' })),
  };
  // Авто-сдвиг (по кривой дате) = 0 → 0 совпадений. Верный сдвиг +4 → 6 совпадений.
  const res = bestTeacherOffset(file, refSlots, 0, slotKeys);
  assert.equal(res.offset, 4);
  assert.equal(res.matched, 6);
});

test('bestTeacherOffset: мало совпадений → авто-сдвиг сохраняется (без ложной коррекции)', () => {
  // Лишь одна пара пересекается — ниже порога уверенности, авто-сдвиг не трогаем.
  const refSlots = new Set([`${coreKey({ day: 'Пн', pairNo: 1, weekNo: 5, subject: 'УПОС' })}|`]);
  const file = { lessons: [L({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'УПОС' })] };
  const res = bestTeacherOffset(file, refSlots, 2, slotKeys);
  assert.equal(res.offset, 2, 'остался авто-сдвиг');
});

test('bestTeacherOffset: группы в ключе — периодичное расписание кафедры не сбивает верный сдвиг', () => {
  // Кафедральная аудитория занята РХБЗ каждую неделю (1..12) в тот же день/пару,
  // но каждый раз ДРУГОЙ группой. Без группы в ключе почти любой сдвиг даёт
  // «совпадения», и подбор промахивается (реальный случай: файл Ведманова,
  // сдвиг −2 вместо +6, чужая группа прицепилась к занятию 15.06).
  const refSlots = new Set();
  for (let w = 1; w <= 12; w += 1)
    refSlots.add(`${coreKey({ day: 'Пн', pairNo: 1, weekNo: w, subject: 'РХБЗ' })}|G${w}`);
  // Файл преподавателя: локальные недели 1..6 = общие 7..12 (верный сдвиг +6).
  const file = {
    lessons: Array.from({ length: 6 }, (_, i) =>
      L({ day: 'Пн', pairNo: 1, weekNo: i + 1, subject: 'РХБЗ', groups: [`G${i + 7}`] })
    ),
  };
  const res = bestTeacherOffset(file, refSlots, 0, slotKeys);
  assert.equal(res.offset, 6);
  assert.equal(res.matched, 6);
});

test('mergeSchedules: запись преподавателя не добавляет группы существующему занятию', () => {
  const groupG1 = {
    kind: 'group',
    owner: 'G1',
    subjects: {},
    lessons: [L({ day: 'Пн', pairNo: 1, weekNo: 1, type: 'Л', subject: 'MATH', room: '101', groups: ['G1'] })],
  };
  // Запись преподавателя в том же слоте упоминает и чужую группу G9 (например,
  // из-за неверного сдвига его файла) — G9 не должна прицепиться к занятию.
  const teacherFile = {
    kind: 'teacher',
    owner: 'Иванов И.И.',
    subjects: {},
    lessons: [L({ day: 'Пн', pairNo: 1, weekNo: 1, subject: 'MATH', room: '101', groups: ['G1', 'G9'] })],
  };
  const { lessons } = mergeSchedules({ groups: [groupG1], teachers: [teacherFile] });
  assert.equal(lessons.length, 1);
  assert.deepEqual(lessons[0].groups, ['G1'], 'группа из файла преподавателя не добавлена');
  assert.equal(lessons[0].teacher, 'Иванов И.И.');
});

test('mergeSchedules: поток только внутри курса — ФП 1-го и 4-го курса не сливаются', () => {
  const courses = { 86: 1, 83: 4 };
  // Файл спортзала: в одной ячейке стоят группы обоих курсов.
  const roomFile = {
    kind: 'room',
    owner: 'Сп. зал',
    subjects: {},
    lessons: [
      L({ day: 'Пн', pairNo: 1, weekNo: 1, type: 'ПЗ', subject: 'ФП', room: 'Сп. зал', groups: ['864', '861-11', '831-11'] }),
    ],
  };
  const { lessons, report } = mergeSchedules({ rooms: [roomFile] }, courses);

  assert.equal(lessons.length, 2, 'два потока: 1-й курс и 4-й курс');
  const c1 = lessons.find((l) => l.groups.includes('864'));
  const c4 = lessons.find((l) => l.groups.includes('831-11'));
  assert.deepEqual(c1.groups.sort(), ['861-11', '864']);
  assert.deepEqual(c4.groups, ['831-11']);
  assert.equal(report.streams, 1, 'поток остался один — из двух групп 1 курса');

  // Без настройки курсов (или у групп одного курса) слияние прежнее.
  const one = mergeSchedules({ rooms: [roomFile] }, { 86: 1, 83: 1 });
  assert.equal(one.lessons.length, 1);
});
