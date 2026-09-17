// Единый источник доменных констант для сервера и браузера (UMD).
// Сервер: require('public/js/shared-constants.js'); браузер: <script src="/js/shared-constants.js">.
// Менять время пар/дни — ТОЛЬКО здесь.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SCHED_CONST = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Дни недели в том виде, как они приходят в HTML (сокращения 1С).
  const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  // Число пар в день (rowspan=4 в исходном HTML).
  const PAIRS_PER_DAY = 4;

  // Стандартное время пар (для пересчёта при переносе занятия).
  const PAIR_TIMES = {
    1: { start: '9.00', end: '10.35' },
    2: { start: '10.55', end: '12.30' },
    3: { start: '12.50', end: '14.25' },
    4: { start: '16.20', end: '17.55' },
  };

  // Номера пар для конкретного дня. В субботу всегда максимум 3 пары —
  // 4-й пары в субботу не бывает. В остальные дни — все пары до PAIRS_PER_DAY.
  function pairsForDay(day) {
    const all = Array.from({ length: PAIRS_PER_DAY }, (_, i) => i + 1);
    return day === 'Сб' ? all.filter((p) => p <= 3) : all;
  }

  // Часы занятий пары: пара N занимает учебные часы (2N−1)–(2N).
  // 1→«1–2», 2→«3–4», 3→«5–6», 4→«7–8». Используется в подписях вместо номера пары.
  function pairHours(p) {
    const n = Number(p);
    return n ? `${2 * n - 1}–${2 * n}` : '';
  }

  // Причины-мероприятия (метки, занимающие ячейку вне учебной нагрузки). Единый
  // ГЛОБАЛЬНЫЙ список: используется и в диалоге «Отпуск группы/преподавателя»
  // (выпадающий список причин), и как расшифровка этих же сокращений из расписания
  // при импорте. code — метка в сетке, name — расшифровка (пусто = только код).
  const EVENT_REASONS = [
    { code: 'ДП', name: 'дипломное проектирование' },
    { code: 'КШВИ', name: '' },
    { code: 'Н', name: 'наряд, караул' },
    { code: 'ОП', name: 'огневая подготовка' },
    { code: 'Отп', name: 'каникулярный отпуск' },
    { code: 'ПВ', name: 'полевой выход' },
    { code: 'ПрПр', name: 'производственная практика' },
    { code: 'РТУ', name: 'ротно-тактические учения' },
    { code: 'Стаж', name: 'войсковая стажировка' },
    { code: 'ТСУ', name: 'тактико-специальные учения' },
    { code: 'УМО', name: 'углуб. мед. освидетельствование' },
    { code: 'УПр', name: 'учебная практика' },
    { code: 'ЭПр', name: 'эксплуатационная практика' },
  ];

  // Виды учебных занятий по умолчанию: [{code, name}]. Перечень редактируется в
  // справочнике (settings.lessonTypes), этот список — только начальное значение и
  // запасной вариант, если справочник недоступен.
  const LESSON_TYPES = [
    { code: 'Л', name: 'Лекция' },
    { code: 'ПЗ', name: 'Практика' },
    { code: 'ЛР', name: 'Лаб. работа' },
    { code: 'КР', name: 'Курсовая' },
    { code: 'КП', name: 'Курсовой проект' },
    { code: 'Зач', name: 'Зачёт' },
    { code: 'ЗО', name: 'Зачёт с оценкой' },
    { code: 'Экз', name: 'Экзамен' },
  ];

  // Расшифровка метки-мероприятия по её коду (без учёта регистра/точек). Пусто,
  // если код не из списка EVENT_REASONS или расшифровки нет.
  function eventName(marker) {
    const m = String(marker || '').trim().replace(/[.\s]+$/, '').toLowerCase();
    if (!m) return '';
    const found = EVENT_REASONS.find((r) => r.code.toLowerCase() === m);
    return found ? found.name : '';
  }

  // Классификация вида занятия по форме контроля для подсветки в сетке:
  // 'exam' — экзамен, 'zachet' — зачёт / зачёт с оценкой, '' — обычное занятие.
  // Коды берутся из подвала файла (легенда): «э»→экзамен, «зч, з/о»→зачёт,
  // «зо/ЗО»→зачёт с оценкой; плюс развёрнутые написания на всякий случай.
  function assessmentKind(type) {
    const t = String(type || '')
      .trim()
      .replace(/[.\s]+$/, '')
      .toLowerCase();
    if (!t) return '';
    if (/^(э|экз|экзамен)$/.test(t)) return 'exam';
    if (/^(зач|зч|зо|з\/о|зачет|зачёт)$/.test(t)) return 'zachet';
    return '';
  }

  // Класс заливки мероприятия по его маркеру (Отп, ОП, УМО…). Разные виды —
  // разные цвета (см. .lesson.event.ev-* в styles.css). '' — маркер пуст.
  function eventKind(marker) {
    const m = String(marker || '')
      .trim()
      .replace(/[.\s]+$/, '')
      .toLowerCase();
    if (!m) return '';
    if (/^отп/.test(m)) return 'ev-otp'; // каникулярный отпуск
    if (/^оп$/.test(m)) return 'ev-op'; // огневая подготовка
    if (/^умо/.test(m)) return 'ev-umo'; // углубл. мед. освидетельствование
    if (/^(стаж|эпр|упр|прпр|дп)/.test(m)) return 'ev-practice'; // практики/стажировки/диплом
    if (/^(пв|рту|тсу|кшви)$/.test(m)) return 'ev-practice'; // полевые/тактические учения
    if (/^(вых|н)$/.test(m)) return 'ev-off'; // выходной / наряд / караул
    if (/экз/.test(m)) return 'ev-exam'; // экзамен-маркер
    return 'ev-other';
  }

  // Подпись аудитории в МЕНЮ и выпадающих списках: «418-4 (каф. 81, комп. класс,
  // 30 мест)». Пустые поля пропускаются, порядок всегда один. extra — пометки
  // конкретного списка («мало», «занята»), они идут последними.
  // В сетке расписания аудитория остаётся голым номером — там эту подпись не звать.
  function roomLabel(room, extra) {
    const r = room || {};
    const parts = [
      r.dept ? `каф. ${r.dept}` : '',
      r.note || '',
      r.capacity != null ? `${r.capacity} ${seats(r.capacity)}` : '',
      ...(extra || []),
    ].filter(Boolean);
    return parts.length ? `${r.name} (${parts.join(', ')})` : String(r.name || '');
  }

  // Сортировка списка аудиторий «по подходимости» к занятию: сверху те, где
  // посадочных мест ближе всего к числу курсантов (need). Цель — маленькая
  // группа не занимает большой зал.
  // Порядок групп: вмещающие → с неизвестной вместимостью → не вмещающие
  // (нехватка мест — предупреждение, но такие аудитории всегда внизу списка).
  // Внутри группы — по модулю разницы мест: чем ближе к need, тем выше.
  // Если численность неизвестна (need пустой), порядок остаётся по имени.
  function roomFitCmp(need) {
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    if (!need) return byName;
    const rank = (r) => (r.capacity == null ? 1 : r.capacity >= need ? 0 : 2);
    const slack = (r) => (r.capacity == null ? 0 : Math.abs(r.capacity - need));
    return (a, b) => rank(a) - rank(b) || slack(a) - slack(b) || byName(a, b);
  }

  // «1 место», «22 места», «31 место», «45 мест».
  function seats(n) {
    const d = Math.abs(n) % 10;
    const h = Math.abs(n) % 100;
    if (d === 1 && h !== 11) return 'место';
    if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'места';
    return 'мест';
  }

  /* ---------- Учебные группы по курсам ---------- */
  // Курс группы берётся из карты «первые 2 символа имени → номер курса»
  // (окно «Курсы», settings.courses). Группы, курс которых не задан, собираются
  // в блок «Без курса» в конце — так список выглядит одинаково везде.
  // Возвращает [{ course, label, groups[] }] по возрастанию курса.
  function groupsByCourse(groups, courses) {
    const map = new Map();
    for (const g of groups || []) {
      const c = (courses || {})[String(g).slice(0, 2)];
      const key = c == null || c === '' ? null : Number(c);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(g);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] == null ? 99 : a[0]) - (b[0] == null ? 99 : b[0]))
      .map(([course, list]) => ({
        course,
        label: course == null ? 'Без курса' : `${course} курс`,
        groups: list.slice().sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })),
      }));
  }

  // Список групп с галочками, разбитый на блоки по курсам. Заголовок блока —
  // сам чекбокс: отмечает/снимает весь курс. itemHtml(group) рисует строку
  // группы (у списков разные имена полей и подписи), остальное общее.
  function courseGroupsHtml(groups, courses, itemHtml) {
    return groupsByCourse(groups, courses)
      .map(
        (c) =>
          `<div class="crs-block"><label class="crs-head"><input type="checkbox" class="crs-all"> ` +
          `<b>${c.label}</b> <span class="crs-n">${c.groups.length}</span></label>` +
          c.groups.map(itemHtml).join('') +
          `</div>`
      )
      .join('');
  }

  // Ключ курса группы для фильтров: номер строкой, '' — курс не задан.
  function courseKeyOf(group, courses) {
    const c = (courses || {})[String(group).slice(0, 2)];
    return c == null || c === '' ? '' : String(Number(c));
  }

  // Курсы галочками — фильтр столбцов сводного расписания: один пункт на курс
  // (с числом групп). hidden — Set ключей курсов, которые скрыты.
  function courseFilterHtml(groups, courses, hidden) {
    return groupsByCourse(groups, courses)
      .map((c) => {
        const key = c.course == null ? '' : String(c.course);
        return `<label class="chk-lbl"><input type="checkbox" class="crs-vis" value="${key}"` +
          `${hidden.has(key) ? '' : ' checked'}> ${c.label} <span class="crs-n">${c.groups.length}</span></label>`;
      })
      .join('');
  }

  // Те же курсы, но для одиночного выбора: <optgroup> в <select>.
  // optionHtml(group) рисует один <option>.
  function courseOptionsHtml(groups, courses, optionHtml) {
    const blocks = groupsByCourse(groups, courses);
    // Один блок и тот без курса — заголовок не нужен, это обычный плоский список.
    if (blocks.length === 1 && blocks[0].course == null) return blocks[0].groups.map(optionHtml).join('');
    return blocks
      .map((c) => `<optgroup label="${c.label}">${c.groups.map(optionHtml).join('')}</optgroup>`)
      .join('');
  }

  // Связывает заголовок курса с группами внутри блока: клик по заголовку
  // отмечает/снимает весь курс, правка отдельных галочек возвращает заголовку
  // верное состояние (в т.ч. «частично» — indeterminate). Слушатель вешается на
  // контейнер один раз и в фазе перехвата — чтобы к обработчикам самого списка
  // галочки уже были проставлены. Вызывать после каждой перерисовки: заодно
  // синхронизирует заголовки.
  function bindCourseChecks(box) {
    if (!box) return;
    const itemsOf = (block) => [...block.querySelectorAll('input[type="checkbox"]:not(.crs-all)')];
    const sync = (block) => {
      const head = block.querySelector('.crs-all');
      if (!head) return;
      const list = itemsOf(block);
      const on = list.filter((i) => i.checked).length;
      head.checked = on > 0 && on === list.length;
      head.indeterminate = on > 0 && on < list.length;
    };
    if (!box.dataset.crsBound) {
      box.dataset.crsBound = '1';
      box.addEventListener(
        'change',
        (e) => {
          const block = e.target.closest && e.target.closest('.crs-block');
          if (!block) return;
          if (e.target.classList.contains('crs-all')) {
            for (const i of itemsOf(block)) i.checked = e.target.checked;
          }
          sync(block);
        },
        true
      );
    }
    box.querySelectorAll('.crs-block').forEach(sync);
  }

  // CSS-переменные шрифта для сводной сетки по числу столбцов (групп). Чем больше
  // групп — тем мельче шрифт ячеек/шапки, чтобы всё помещалось по ширине экрана.
  function summaryFontVars(n) {
    let fs = 10;
    let hs = 12;
    if (n > 32) { fs = 6; hs = 8; }
    else if (n > 24) { fs = 7; hs = 9; }
    else if (n > 16) { fs = 8; hs = 10; }
    else if (n > 10) { fs = 9; hs = 11; }
    return `--sum-fs:${fs}px;--sum-hs:${hs}px`;
  }

  // Номер учебной недели (1..maxWeek), на которую попадает дата date, при
  // начале семестра start (ГГГГ-ММ-ДД). Отсчёт — от ПОНЕДЕЛЬНИКА недели, в
  // которую попал start (так же считает сетка: weekDate/isoDate в guest.js).
  // Вне семестра номер зажимается в 1..maxWeek — «текущая неделя» всегда есть.
  function weekNoOn(start, date, maxWeek = 26) {
    if (!start) return null;
    const s = new Date(String(start).slice(0, 10) + 'T00:00:00Z');
    const d = date instanceof Date
      ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
      : new Date(String(date).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(s.getTime()) || Number.isNaN(d.getTime())) return null;
    s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7));
    const n = Math.floor((d - s) / (7 * 24 * 3600 * 1000)) + 1;
    return Math.min(maxWeek, Math.max(1, n));
  }

  // Отчётность из учебного плана в столбец «Отчёт.» подвала: дополняет уже
  // указанное недостающими формами (Экз/ЗО/Зч/КР), ничего не затирая и не
  // дублируя. r — строка сверки с планом (см. compareGroupToPlan) или ничего.
  // Используется и при импорте (пишем в подвал), и при показе таблицы дисциплин.
  function mergeReportValue(current, r) {
    const cur = String(current || '').trim();
    if (!r) return cur;
    const lc = cur.toLowerCase();
    const add = [];
    if (r.expExam && !/(э|экз|экзамен)/.test(lc)) add.push('Экз');
    if (r.expZach && !/(зач|зч|зо|з\/о|зачёт|зачет)/.test(lc)) add.push(r.expZachUngraded && !r.expZachGraded ? 'Зч' : 'ЗО');
    if (r.expCourse && !/(кр|кп|курс)/.test(lc)) add.push('КР');
    if (!add.length) return cur;
    return cur ? `${cur}, ${add.join(', ')}` : add.join(', ');
  }

  // Ключ пометки «перенесено» по ячейке — для старых записей журнала без id
  // занятия. Сервер строит его по ячейке «куда», админка — по ячейке занятия.
  function movedKey(day, pair, week, subject, groups) {
    return [day, Number(pair), Number(week), subject || '', [...(groups || [])].sort().join(',')].join('|');
  }

  // Строки «перенесено» для подсказки и карточки занятия — одни и те же в админке
  // и у гостя. m — пометка занятия (getMoveMarks на сервере): steps, lastMove,
  // lastRoom. «Откуда» — предыдущая ячейка, вся цепочка — в журнале.
  function movedLines(m) {
    if (!m) return [];
    const out = [];
    const mv = m.lastMove;
    if (mv) {
      const fromWhere = [mv.fromDay, mv.fromDate].filter(Boolean).join(' ');
      const tail = m.steps > 1 ? ` (изменений: ${m.steps})` : '';
      out.push(`↪ Перенесено с: ${fromWhere || '—'}, часы ${pairHours(mv.fromPair)}, неделя ${mv.fromWeek}${tail}`);
    }
    // Старые записи переноса несли и смену аудитории (fromRoom ≠ room).
    const rm = m.lastRoom || (mv && mv.fromRoom && mv.fromRoom !== (mv.room || '') ? mv : null);
    if (rm) out.push(`↪ Аудитория: ${rm.fromRoom || '—'} → ${rm.room || 'буфер'}`);
    return out;
  }

  // Оформление сетки — это просто CSS-переменные на :root. Список один на всех:
  // им пользуется и админка (сохраняет в settings.appearance на сервере), и
  // виджет (держит свой выбор в localStorage этого ПК). Значения по умолчанию
  // совпадают со светлой темой в theme.css.
  const APP_TYPES = [
    ['--type-lec', 'Лекция (Л)', '#4f7fd0'],
    ['--type-prac', 'Практическое (ПЗ)', '#2e9e57'],
    ['--type-lab', 'Лабораторная (ЛР)', '#8a5cd0'],
    ['--type-sem', 'Семинар (С)', '#d59a1f'],
    ['--type-grp', 'Групповое (ГЗ, ГУ)', '#17a2a2'],
    ['--type-ctrl', 'Контрольная/курсовая (КР)', '#cc5b8e'],
  ];
  const APP_STATES = [
    ['--grid-line-free', 'Свободная цель переноса', '#16a34a'],
    ['--grid-line-warn', 'Аудитория занята (предупреждение)', '#d97706'],
    ['--grid-line', 'Ячейка под курсором', '#e05d38'],
    ['--grid-line-error', 'Ошибка / нет аудитории', '#ef4444'],
    ['--grid-line-stream', 'Потоковое занятие', '#86a7c8'],
    ['--grid-line-holiday', 'Нерабочий день', '#ef4444'],
    ['--hl-color', 'Выделение в сетке', '#e05d38'],
    ['--grid-line-teacher', 'Подсказка «одна аудитория»', '#5a7ca6'],
    ['--grid-line-dept', 'Подсказка «своя кафедра»', '#16a34a'],
    ['--grid-line-cc', 'Подсказка «компьютерный класс»', '#8a5cd0'],
  ];
  const APP_SIZES = [
    ['--grid-row-h', 'Высота строки, px', 104, 40, 200],
    ['--grid-font', 'Шрифт занятия, px', 12, 8, 22],
    ['--grid-time-w', 'Ширина столбца времени, px', 110, 60, 220],
  ];
  // Шрифты, которые есть в самой Windows: список короткий намеренно —
  // queryLocalFonts() спрашивает разрешение и работает не везде.
  const APP_FONTS = ['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Georgia', 'Consolas', 'Times New Roman'];

  return { DAYS, PAIRS_PER_DAY, PAIR_TIMES, pairsForDay, pairHours, assessmentKind, eventKind, EVENT_REASONS, eventName, LESSON_TYPES, roomLabel, roomFitCmp, seats, summaryFontVars, weekNoOn, mergeReportValue, movedKey, movedLines,
    groupsByCourse, courseGroupsHtml, courseOptionsHtml, bindCourseChecks, courseKeyOf, courseFilterHtml,
    APP_TYPES, APP_STATES, APP_SIZES, APP_FONTS };
});
