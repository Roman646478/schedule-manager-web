'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseSchedule } = require('../../src/parsers/htmlScheduleParser');

// Тесты написаны под весенние примеры; в примеры/осень лежат файлы с теми же
// именами (823.html и т. п.), но другого учебного года — их не трогаем.
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

function lessonsOf(result) {
  return result.lessons.filter((l) => l.category === 'lesson');
}

test('файл группы (823): шапка, недели, занятия', () => {
  const r = parseSchedule(read('823.html'));
  assert.equal(r.kind, 'group');
  assert.equal(r.owner, '823');
  assert.equal(r.year, '2025/2026');
  assert.ok(['весенний', 'осенний'].includes(r.semester), 'семестр распознан');
  assert.equal(r.weeks.length, 26);
  assert.deepEqual(
    r.weeks.map((w) => w.weekNo),
    Array.from({ length: 26 }, (_, i) => i + 1)
  );

  const lessons = lessonsOf(r);
  assert.ok(lessons.length > 100, 'ожидаем много занятий');

  const first = lessons[0];
  assert.equal(first.day, 'Пн');
  assert.equal(first.pairNo, 1);
  assert.equal(first.timeStart, '9.00');
  assert.equal(first.timeEnd, '10.35');
  assert.ok(first.type, 'тип занятия определён');
  assert.ok(first.subject, 'предмет определён');
  assert.ok(Array.isArray(first.rooms) && first.rooms.length >= 1, 'аудитория определена');
  assert.deepEqual(first.groups, ['823']);

  // Подвальная таблица дисциплин: предмет → полное название + преподаватели.
  assert.ok(Object.keys(r.subjects).length >= 5);
  const withTeachers = Object.values(r.subjects).find((s) => s.lecturers.length || s.others.length);
  assert.ok(withTeachers, 'хотя бы у одной дисциплины есть преподаватели');
});

test('файл аудитории (262-7): тип + группа + предмет, владелец = аудитория', () => {
  const r = parseSchedule(read('262-7.html'));
  assert.equal(r.kind, 'room');
  assert.equal(r.owner, '262-7');
  assert.equal(r.weeks.length, 26);

  const lessons = lessonsOf(r);
  assert.ok(lessons.length > 50);
  for (const l of lessons.slice(0, 50)) {
    assert.deepEqual(l.rooms, ['262-7']);
    assert.ok(l.groups.length >= 1, 'в файле аудитории должна быть группа');
  }
  const sample = lessons[0];
  assert.ok(sample.type, 'тип определён');
  assert.ok(sample.subject, 'предмет определён');
});

test('файл преподавателя (Гребенник): аудитория + группа + предмет', () => {
  const r = parseSchedule(read('ГребенникЕ.А..html'));
  assert.equal(r.kind, 'teacher');
  assert.match(r.owner, /Гребенник/);
  assert.equal(r.weeks.length, 26);

  const lessons = lessonsOf(r);
  assert.ok(lessons.length > 20);
  const sample = lessons[0];
  assert.equal(sample.teacher, r.owner);
  assert.ok(sample.subject, 'предмет определён');
  assert.ok(Array.isArray(sample.rooms) && sample.rooms.length >= 1, 'аудитория определена');
  assert.ok(sample.groups.length >= 1, 'группа определена');
});

test('потоковое занятие: несколько групп в одной ячейке (синтетический HTML)', () => {
  const html = `
    <html><body>
    <table>
      <tr><td>Преподаватель: Тест Т.Т. Семестр: весенний</td><td>Факультет 8Ф</td></tr>
      <tr><td>2025/2026 учебный год</td></tr>
    </table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>9</td></tr>
      <tr>
        <td>Пн</td><td>1-2</td><td>9.00-10.35</td>
        <td><table>
          <tr><td>414-7</td></tr>
          <tr><td>821/11, 821/12</td></tr>
          <tr><td>УЭКС</td></tr>
        </table></td>
      </tr>
    </table>
    </body></html>`;

  const r = parseSchedule(html);
  assert.equal(r.kind, 'teacher');
  const lessons = lessonsOf(r);
  assert.equal(lessons.length, 1);
  // Группы из ячейки приводятся к каноническому дефисному виду (821/11 → 821-11).
  assert.deepEqual(lessons[0].groups, ['821-11', '821-12']);
  assert.deepEqual(lessons[0].rooms, ['414-7']);
  assert.equal(lessons[0].subject, 'УЭКС');
});

test('firstDate: сдвинутая подпись месяца исправляется по шагу +7 (23 «Март» → 23 февраля)', () => {
  // 1С-экспорт иногда ставит «Март» над колонкой конца февраля. Числа верны:
  // понедельники 23 → 2 значат 23 фев + 7 дней = 2 мар, а не 23 мар + 7.
  // Якоря: пн недели 2 (23→2 фев+7=2мар), вт недели 2 (24→3), ср недели 3 (25→11).
  const html = `
    <html><body>
    <table><tr><td>Учебная группа 999</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td><td>2</td><td>3</td></tr>
      <tr><td></td><td></td><td>Месяц</td><td>Март</td><td>Апрель</td><td></td></tr>
      <tr><td></td><td></td><td>Даты</td><td>23</td><td>2</td><td>9</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>24</td><td>3</td><td>10</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>25</td><td>4</td><td>11</td></tr>
      <tr>
        <td>Пн</td><td>1-2</td><td>9.00-10.35</td>
        <td><table><tr><td>Л</td></tr><tr><td>МАТ</td></tr><tr><td>101</td></tr></table></td>
        <td></td><td></td>
      </tr>
    </table>
    </body></html>`;
  const fixed = parseSchedule(html);
  assert.equal(fixed.firstDate, '2026-02-23');
  assert.equal(fixed.firstDateVerified, true, 'диагональ сошлась после поправки месяца');

  // Согласованная подпись (2 «Март» → шаг сходится) остаётся как есть.
  const ok = html
    .replace('<td>23</td><td>2</td><td>9</td>', '<td>2</td><td>9</td><td>16</td>')
    .replace('<td>24</td><td>3</td><td>10</td>', '<td>3</td><td>10</td><td>17</td>')
    .replace('<td>25</td><td>4</td><td>11</td>', '<td>4</td><td>11</td><td>18</td>');
  const good = parseSchedule(ok);
  assert.equal(good.firstDate, '2026-03-02');
  assert.equal(good.firstDateVerified, true, 'диагональ сошлась с подписью месяца');

  // Числа в сетке не идут с шагом 7 (ср недели 3 разъехалась) — дата возвращается,
  // но помечается неподтверждённой: импорт покажет предупреждение о сдвиге.
  const broken = html.replace('<td>25</td><td>4</td><td>11</td>', '<td>25</td><td>4</td><td>12</td>');
  const bad = parseSchedule(broken);
  assert.ok(bad.firstDate, 'дата всё равно возвращается');
  assert.equal(bad.firstDateVerified, false, 'диагональная проверка не прошла');
});

test('тема занятия канонизируется к виду «Т.N» (Тема 9 → Т.9)', () => {
  const mk = (topic) => `
    <html><body>
    <table><tr><td>Учебная группа 999</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>9</td></tr>
      <tr>
        <td>Пн</td><td>1-2</td><td>9.00-10.35</td>
        <td><table><tr><td>Л/${topic}</td></tr><tr><td>МАТ</td></tr><tr><td>101</td></tr></table></td>
      </tr>
    </table>
    </body></html>`;
  const topicOf = (t) => lessonsOf(parseSchedule(mk(t)))[0].topic;
  assert.equal(topicOf('Тема 9'), 'Т.9');
  assert.equal(topicOf('тема 9'), 'Т.9');
  assert.equal(topicOf('Т9'), 'Т.9');
  assert.equal(topicOf('Т. 9'), 'Т.9');
  assert.equal(topicOf('Т.9'), 'Т.9');
  assert.equal(topicOf('ВВ'), 'ВВ', 'прочие темы не трогаем');
});

test('зачёт: ЗЧ / ЗЧ/ЗАЧЕТ / ЗАЧЁТ → вид «ЗО» без темы', () => {
  const mk = (cell) => `
    <html><body>
    <table><tr><td>Учебная группа 999</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>9</td></tr>
      <tr>
        <td>Пн</td><td>1-2</td><td>9.00-10.35</td>
        <td><table><tr><td>${cell}</td></tr><tr><td>КПСТО</td></tr><tr><td>101</td></tr></table></td>
      </tr>
    </table>
    </body></html>`;
  const at = (cell) => lessonsOf(parseSchedule(mk(cell)))[0];

  for (const cell of ['ЗЧ', 'ЗЧ/ЗАЧЕТ', 'ЗЧ/ЗЧ', 'ЗАЧЁТ', 'ЗО/ЗО', 'зо']) {
    const l = at(cell);
    assert.equal(l.type, 'ЗО', `вид занятия для «${cell}»`);
    assert.equal(l.topic, null, `тема для «${cell}»`);
    assert.equal(l.subject, 'КПСТО', 'дисциплина сохраняется');
  }

  // Обычное занятие с темой не задето.
  const usual = at('Л/Т.3');
  assert.equal(usual.type, 'Л');
  assert.equal(usual.topic, 'Т.3');
});

test('практическое: вид «П» → «ПЗ», тема сохраняется', () => {
  const mk = (cell) => `
    <html><body>
    <table><tr><td>Учебная группа 999</td></tr><tr><td>2025/2026 учебный год</td></tr></table>
    <table border=1>
      <tr><td>День недели</td><td></td><td>Уч. недели</td><td>1</td></tr>
      <tr><td></td><td></td><td>Даты</td><td>9</td></tr>
      <tr>
        <td>Пн</td><td>1-2</td><td>9.00-10.35</td>
        <td><table><tr><td>${cell}</td></tr><tr><td>КПСТО</td></tr><tr><td>101</td></tr></table></td>
      </tr>
    </table>
    </body></html>`;
  const at = (cell) => lessonsOf(parseSchedule(mk(cell)))[0];

  assert.equal(at('П').type, 'ПЗ');
  assert.equal(at('п.').type, 'ПЗ');
  assert.equal(at('ПЗ').type, 'ПЗ');
  const withTopic = at('П/Т.5');
  assert.equal(withTopic.type, 'ПЗ');
  assert.equal(withTopic.topic, 'Т.5', 'тема практического сохраняется');
  // Похожие коды не задеты.
  assert.equal(at('ПВ').type, 'ПВ');
  assert.equal(at('ПрПр').type, 'ПрПр');
});

test('подвал: форма отчётности «ЗЧ»/«ЗАЧЕТ» приводится к «ЗО», экзамен не трогаем', () => {
  const { parseSubjectsTable } = require('../../src/parsers/htmlScheduleParser');
  const { parse } = require('node-html-parser');
  const row = (abbr, report) =>
    `<tr><td>${abbr}</td><td>Дисциплина ${abbr}</td><td>81</td><td>Иванов И.И.</td><td>Иванов И.И.</td><td>24-48</td><td>${report}</td></tr>`;
  const root = parse(
    `<table><tr><td>Обозн</td><td>Дисциплина</td></tr>${row('А', 'ЗЧ')}${row('Б', 'ЗАЧЕТ')}${row('В', 'ЗО')}${row('Г', 'Э')}${row('Д', '')}</table>`
  );
  const t = parseSubjectsTable(root);
  assert.equal(t['А'].report, 'ЗО');
  assert.equal(t['Б'].report, 'ЗО');
  assert.equal(t['В'].report, 'ЗО');
  assert.equal(t['Г'].report, 'Э', 'экзамен остаётся как есть');
  assert.equal(t['Д'].report, null, 'пустая клетка — null, а не пустая строка');
});

test('двойная аудитория: «435-7, 426-7» в ячейке → rooms из двух аудиторий', () => {
  const r = parseSchedule(read('841-11.html'));
  const lessons = lessonsOf(r);
  // Все аудитории — массивом; есть занятия с одной и с двумя аудиториями.
  assert.ok(lessons.every((l) => Array.isArray(l.rooms)), 'rooms — всегда массив');
  const dbl = lessons.find((l) => l.rooms.length === 2);
  assert.ok(dbl, 'есть занятие с двумя аудиториями');
  assert.deepEqual(dbl.rooms, ['435-7', '426-7']);
});

test('выходные (Вых): ячейки нерабочих дней дают список ISO-дат', () => {
  const r = parseSchedule(read('823.html'));
  assert.ok(Array.isArray(r.holidays), 'holidays — массив');
  assert.ok(r.holidays.length > 0, 'в файле есть отметки выходных');
  // Все даты в формате ГГГГ-ММ-ДД и отсортированы по возрастанию.
  for (const iso of r.holidays) assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(r.holidays, [...r.holidays].sort(), 'даты отсортированы');
  // Государственные праздники весны 2026 распознаны (23 февраля, 9 мая).
  assert.ok(r.holidays.includes('2026-02-23'), 'День защитника Отечества');
  assert.ok(r.holidays.includes('2026-05-09'), 'День Победы');
  // Учебным занятием «Вых» не становится, но в сетке остаётся меткой-мероприятием
  // (как Отп/УМО) — иначе её не видно ни в выгрузке, ни у гостей.
  const lessons = lessonsOf(r);
  assert.ok(!lessons.some((l) => l.subject === 'Вых'), '«Вых» не стал учебным занятием');
  const marks = r.lessons.filter((l) => l.subject === 'Вых');
  assert.ok(marks.length > 0, '«Вых» осталась меткой в сетке');
  assert.ok(marks.every((l) => l.category === 'event' && l.isMarker), 'это мероприятие-метка');
  assert.ok(marks.every((l) => l.__dayOff === undefined), 'служебный флаг в занятие не утёк');
});

test('явная подсказка типа (kindHint) переопределяет автоопределение', () => {
  const r = parseSchedule(read('823.html'), 'group');
  assert.equal(r.kind, 'group');
});
