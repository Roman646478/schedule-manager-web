'use strict';

// Чистая функция сверки расписания с планом — синтетика, без БД.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareGroupToPlan, kafedraOfGroup } = require('../src/services/curriculumService');

// Дисциплина плана: семестровые ауд.часы только для sem (1..10).
function disc(index, name, sem, aud, { exams = [], zachetsGraded = [], zachetsUngraded = [], coursework = null } = {}) {
  const perSemester = Array.from({ length: 10 }, () => ({ aud: 0, self: 0, sessZe: 0 }));
  perSemester[sem - 1].aud = aud;
  return { kind: 'discipline', index, name, perSemester, exams, zachetsGraded, zachetsUngraded, coursework };
}
const L = (subject, type, subjectFull) => ({ subject, type, subjectFull: subjectFull || subject });
const rep = (lessons, plan, mapping) => compareGroupToPlan({ lessons, plan, mapping, planSem: 8 });

test('kafedraOfGroup: 821-11 → 81', () => assert.equal(kafedraOfGroup('821-11'), '81'));

test('совпадение часов и наличие экзамена → OK', () => {
  const plan = { disciplines: [disc('Д.1', 'Тактика', 8, 120, { exams: [8] })] };
  const lessons = [...Array(60)].map(() => L('ТАК', 'Л', 'Тактика')).concat([L('ТАК', 'Экз', 'Тактика')]);
  const row = rep(lessons, plan, { Тактика: 'ТАК' }).rows[0];
  assert.equal(row.planHours, 120);
  assert.equal(row.factHours, 120);
  assert.equal(row.hasExam, true);
  assert.equal(row.ok, true);
});

test('расхождение часов = предупреждение (ok=false, статус про часы)', () => {
  const plan = { disciplines: [disc('Д.2', 'Защита', 8, 24, { zachetsGraded: [8] })] };
  const lessons = [...Array(9)].map(() => L('ЗГТ', 'ПЗ', 'Защита')).concat([L('ЗГТ', 'ЗО', 'Защита')]);
  const row = rep(lessons, plan, { Защита: 'ЗГТ' }).rows[0];
  assert.equal(row.factHours, 18);
  assert.ok(/часы 24/.test(row.status));
  assert.equal(row.hasZachet, true);
  assert.equal(row.ok, false);
});

test('дисциплина плана без занятий → «нет в расписании»', () => {
  const plan = { disciplines: [disc('Д.3', 'Пропавшая', 8, 72, { zachetsGraded: [8] })] };
  const row = rep([], plan, { Пропавшая: 'ПРП' }).rows[0];
  assert.ok(/нет в расписании/.test(row.status));
  assert.equal(row.ok, false);
});

test('СР не считается часами; лишний предмет уходит в extra', () => {
  const plan = { disciplines: [disc('Д.1', 'Тактика', 8, 4, { })] };
  const lessons = [
    L('ТАК', 'Л', 'Тактика'), L('ТАК', 'Л', 'Тактика'), // 2 пары = 4 ч
    L('ТАК', 'СР', 'Тактика'), // самоподготовка — игнор
    L('XXX', 'Л', 'Левый предмет'),
  ];
  const r = rep(lessons, plan, { Тактика: 'ТАК' });
  assert.equal(r.rows[0].factHours, 4);
  assert.equal(r.rows[0].ok, true);
  assert.ok(r.extra.some((e) => e.abbr === 'XXX'));
});

test('запасное сопоставление по полному имени, когда маппинга нет', () => {
  const plan = { disciplines: [disc('Д.1', 'Тактика частей ПРН', 8, 2, {})] };
  const lessons = [L('ТЧП', 'Л', 'Тактика частей ПРН')];
  const row = rep(lessons, plan, {}).rows[0]; // пустой маппинг
  assert.equal(row.abbr, 'ТЧП');
  assert.equal(row.factHours, 2);
});

test('фаззи-авто: имя с сокращениями (РЛС↔радиолокационных) сопоставляется само', () => {
  const plan = { disciplines: [disc('Д.16.В', 'Устройство и эксплуатация радиолокационных станций ВЗГ надгоризонтного обнаружения ПРН', 8, 156, { zachetsGraded: [8] })] };
  const lessons = [L('ВЗГ', 'Л', 'Устройство и эксплуатация РЛС ВЗГ НГО ПРН'), L('ВЗГ', 'ЗО', 'Устройство и эксплуатация РЛС ВЗГ НГО ПРН')];
  const row = rep(lessons, plan, {}).rows[0];
  assert.equal(row.abbr, 'ВЗГ', 'должно авто-сопоставиться по токенам');
  assert.equal(row.auto, true, 'помечено как авто');
  assert.equal(row.hasZachet, true);
});

test('отчётность: has-флаги отражают наличие экз/зач/курсового в расписании', () => {
  const plan = { disciplines: [disc('Д.1', 'Предмет', 8, 40, { exams: [8], zachetsGraded: [8], coursework: { semester: 8, kind: 'work', hours: 16 } })] };
  // в расписании есть лекции, экзамен и курсовой; зачёта НЕТ
  const lessons = [L('ПР', 'Л', 'Предмет'), L('ПР', 'Экз', 'Предмет'), L('ПР', 'КР', 'Предмет')];
  const row = rep(lessons, plan, { Предмет: 'ПР' }).rows[0];
  assert.equal(row.expExam, true); assert.equal(row.hasExam, true);
  assert.equal(row.expZach, true); assert.equal(row.hasZachet, false);
  assert.equal(row.expCourse, true); assert.equal(row.hasCoursework, true);
  // КР — аудиторное занятие: его часы входят в фактические (лекция + КР = 4 ч).
  assert.equal(row.factHours, 4, 'часы КР считаются как учебные');
});

test('ручная привязка переопределяет фаззи; явная пустая = не сопоставлено', () => {
  const plan = { disciplines: [disc('Д.1', 'Военная история', 8, 2, {})] };
  const lessons = [L('ВИ', 'Л', 'Военная история'), L('ВТ', 'Л', 'Военная топография')];
  // вручную привязали к «не та» аббревиатуре — должна победить ручная
  const row = rep(lessons, plan, { 'Военная история': 'ВТ' }).rows[0];
  assert.equal(row.abbr, 'ВТ');
  assert.equal(row.auto, false);
});
