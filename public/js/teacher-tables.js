// Две таблицы расписания преподавателя — итоги по дисциплинам и построчный
// перечень занятий. Общие для админки (public/js/admin.js) и гостевой страницы
// (public/js/guest.js): вёрстка и подсчёты одни, различается только контекст —
// откуда берутся данные и что разрешено делать со строкой.
//
// Контекст (ctx) обеих таблиц:
//   teacherGroups  Map «группа → { subjects, plan }» (в админке — /api/teacher-groups,
//                  у гостя — снимок publish)
//   groupSubjects  { группа: [{ abbr, hours }] } — подвал расписания группы
//   dateOf(w, day) дата ячейки (страницы считают её по-своему)
//   editable       { индекс столбца: поле } — что можно править в строке; {} — ничего.
//                  Вместо имени поля можно задать { field, options: [...] } — тогда
//                  вместо поля ввода будет список, а строки со значением вне
//                  options остаются нередактируемыми
//   onSave(id, field, value) → Promise, сохранение правки строки
//   onSaved(id)     после удачного сохранения строки: страница перерисовывает
//                  сетку и итоги (перечень не трогаем — в нём фокус и фильтры)
//   onMove(id) / onOpen(id)  — кнопки строки; кнопка рисуется, только если задан
//   kind           'teacher' (по умолчанию) или 'subject' — вид «Дисциплина»
//                  использует ту же таблицу итогов: строка дисциплины и под ней
//                  её группы. Меняются только заголовок и пояснение.
//   onlyGroups     Set — какие группы показывать подстроками (вид «Дисциплина»
//                  фильтрует их галочками; чужие группы потока не выводим)
window.TeacherTables = (function () {
  'use strict';

  const SC = window.SCHED_CONST;
  const DAYS = SC.DAYS.slice(0, 6);
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Порядок видов занятий в столбцах ────────────────────────────────────
  const TYPE_ORDER_START = ['Л', 'ПЗ', 'ГЗ', 'С', 'ЛР', 'КП'];
  const TYPE_ORDER_END = ['ЗО', 'Э'];

  function compareTypes(a, b) {
    if (a === b) return 0;
    if (a === '') return 1;
    if (b === '') return -1;

    const endA = TYPE_ORDER_END.findIndex((x) => x.toLowerCase() === a.toLowerCase());
    const endB = TYPE_ORDER_END.findIndex((x) => x.toLowerCase() === b.toLowerCase());
    if (endA !== -1 && endB !== -1) return endA - endB;
    if (endA !== -1) return 1;
    if (endB !== -1) return -1;

    const ia = TYPE_ORDER_START.findIndex((x) => x.toLowerCase() === a.toLowerCase());
    const ib = TYPE_ORDER_START.findIndex((x) => x.toLowerCase() === b.toLowerCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'ru');
  }

  const isLectureType = (t) => (t || '').trim().toUpperCase() === 'Л';

  // Ожидаемые ЧАСЫ из строки «Кол-во часов» подвала вида «30-42»:
  // 30 ч лекций, 42 ч практики. Сравниваем напрямую с фактом в часах.
  function parseHoursExpected(hours) {
    const m = String(hours || '').match(/(\d+)\s*[-–/]\s*(\d+)/);
    if (!m) return null;
    const lecH = Number(m[1]);
    const pracH = Number(m[2]);
    return { lecH, pracH, totalH: lecH + pracH };
  }

  /* ─────────────────── Таблица 1: итоги по дисциплинам ─────────────────── */
  // Строки — дисциплины преподавателя, под каждой её учебные группы. Часы в
  // строке дисциплины и в «Итого» — реальная нагрузка преподавателя: потоковая
  // пара считается ОДИН раз, хотя в строках групп она есть у каждой. Сверка с
  // учебным планом и подвалом — по ВСЕМ часам группы: план и подвал заданы на
  // группу целиком, а преподаватель может вести лишь часть дисциплины (иначе
  // любое совместное ведение краснело бы).
  function summaryHtml(real, ctx) {
    const gd = ctx.teacherGroups || new Map();
    const typeKey = (t) => (t || '').trim();
    const types = [...new Set(real.map((l) => typeKey(l.type)))].sort(compareTypes);
    const subjects = [...new Set(real.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ru'));

    const countByType = (list) => {
      const m = new Map();
      for (const l of list) m.set(typeKey(l.type), (m.get(typeKey(l.type)) || 0) + 1);
      return m;
    };
    const lecPrac = (list) => {
      const lec = list.filter((l) => isLectureType(typeKey(l.type))).length;
      return { lecH: lec * 2, pracH: (list.length - lec) * 2 };
    };
    // Часы группы по дисциплине — по ВСЕМ преподавателям (основа сверки).
    const groupHours = (g, s) => ((gd.get(g) || {}).subjects || {})[s] || { lecH: 0, pracH: 0, zachetH: 0 };

    // «Всего у группы»: часы из ПОДВАЛА расписания этой группы («Кол-во часов»,
    // напр. «48-48»). Цвет — сверка с фактом всей группы: зелёная часть совпала с
    // расписанием, красная нет; сами фактические часы — в подсказке.
    const footerCell = (g, s) => {
      const subs = (ctx.groupSubjects && ctx.groupSubjects[g]) || [];
      const exp = parseHoursExpected((subs.find((x) => x.abbr === s) || {}).hours);
      const { lecH, pracH } = groupHours(g, s);
      if (!exp) {
        return `<td class="ss-num" title="В подвале расписания группы ${esc(g)} нет часов по «${esc(s)}». В расписании группы сейчас ${lecH}-${pracH} ч">—</td>`;
      }
      const lc = lecH === exp.lecH ? 'hh-ok' : 'hh-bad';
      const pc = pracH === exp.pracH ? 'hh-ok' : 'hh-bad';
      const tip = `Подвал группы ${g}: лекции ${exp.lecH} ч, практ. ${exp.pracH} ч · в расписании группы: ${lecH} и ${pracH} ч`;
      return `<td class="ss-num" title="${esc(tip)}"><span class="${lc}">${exp.lecH}</span>-<span class="${pc}">${exp.pracH}</span></td>`;
    };

    // «Уч. план»: часы плана против фактических часов ВСЕЙ группы (аудиторные +
    // зачёт, как в расписании группы; экзамен в сумму часов не идёт).
    const planCell = (g, s) => {
      const plan = (gd.get(g) || {}).plan;
      if (!plan) return `<td class="ss-num ss-plan" title="Для группы ${esc(g)} учебный план не загружен">—</td>`;
      const r = plan.get(s);
      if (!r) return '<td class="ss-num ss-plan" title="Нет в учебном плане на этот семестр">—</td>';
      const zH = groupHours(g, s).zachetH;
      const fact = r.factHours + zH;
      const ok = r.planHours ? r.planHours === fact : r.ok;
      const label = ok ? `✓ ${r.planHours} ч` : `${r.planHours}/${fact}`;
      const tip = `${r.name}${r.auto ? ' (авто)' : ''}: ${r.status} · сверяется вся нагрузка группы (${fact} ч), а не только этого преподавателя`;
      return `<td class="ss-num ss-plan"><span class="${ok ? 'hh-ok' : 'hh-bad'}" title="${esc(tip)}">${label}</span></td>`;
    };

    const bySubject = ctx.kind === 'subject';
    const title = bySubject ? 'Итоги по группам за семестр' : 'Итоги по дисциплинам за семестр';
    const hint = bySubject
      ? 'Значения в часах (1 занятие = 2 ч). Под дисциплиной — её учебные группы. Часы дисциплины и «Итого» — сама дисциплина: потоковая пара считается один раз, хотя в строках групп она есть у каждой. В столбце «Всего у группы» — часы из подвала расписания этой группы, в «Уч. план» — часы плана; и то, и другое сверяется с часами группы по этой дисциплине у ВСЕХ преподавателей: зелёное — совпало, красное — нет, фактические часы в подсказке.'
      : 'Значения в часах (1 занятие = 2 ч). Под каждой дисциплиной — её учебные группы. Часы дисциплины и «Итого» — реальная нагрузка: потоковая пара считается один раз. В столбце «Всего у группы» — часы из подвала расписания этой группы, в «Уч. план» — часы плана; и то, и другое сверяется со ВСЕЙ нагрузкой группы (не только с парами этого преподавателя): зелёное — совпало, красное — нет, фактические часы в подсказке.';
    let html = `<div class="sem-summary"><h2 class="sem-summary-title">${title}</h2>`;
    html += `<p class="subjects-hint">${hint}</p>`;
    html += '<div class="grid-scroll"><table class="grid summary-table"><thead><tr>';
    html += '<th class="ss-subj">Дисциплина / группа</th>';
    for (const t of types) html += `<th>${esc(t || '—')}</th>`;
    html += '<th class="ss-total">Итого, ч<br><small>лек-практ</small></th>';
    html += '<th class="ss-total">Всего у группы<br><small>подвал, лек-практ</small></th>';
    html += '<th class="ss-plan">Уч. план<br><small>часы/статус</small></th>';
    html += '</tr></thead><tbody>';

    const colTotals = new Map(types.map((t) => [t, 0]));
    for (const s of subjects) {
      const mine = real.filter((l) => l.subject === s);
      const row = countByType(mine);
      html += `<tr><td class="ss-subj">${esc(s)}</td>`;
      for (const t of types) {
        const n = row.get(t) || 0;
        colTotals.set(t, colTotals.get(t) + n);
        html += `<td class="ss-num">${n ? n * 2 : ''}</td>`;
      }
      const own = lecPrac(mine);
      html += `<td class="ss-num ss-total">${own.lecH}-${own.pracH}</td><td class="ss-num"></td><td class="ss-plan"></td></tr>`;

      const groups = [...new Set(mine.flatMap((l) => l.groups || []))]
        .filter((g) => !ctx.onlyGroups || ctx.onlyGroups.has(g))
        .sort((a, b) => a.localeCompare(b, 'ru'));
      for (const g of groups) {
        const forGroup = mine.filter((l) => (l.groups || []).includes(g));
        const gRow = countByType(forGroup);
        html += `<tr class="ss-group"><td class="ss-subj">· ${esc(g)}</td>`;
        for (const t of types) {
          const n = gRow.get(t) || 0;
          html += `<td class="ss-num">${n ? n * 2 : ''}</td>`;
        }
        const gh = lecPrac(forGroup);
        html += `<td class="ss-num ss-total">${gh.lecH}-${gh.pracH}</td>`;
        html += footerCell(g, s);
        html += planCell(g, s);
        html += '</tr>';
      }
    }

    const all = lecPrac(real);
    html += '<tr class="ss-foot"><td class="ss-subj">Итого</td>';
    for (const t of types) html += `<td class="ss-num">${colTotals.get(t) * 2}</td>`;
    html += `<td class="ss-num ss-total">${all.lecH}-${all.pracH}</td><td class="ss-num"></td><td class="ss-plan"></td>`;
    html += '</tr></tbody></table></div></div>';
    return html;
  }

  /* ─────────────────── Таблица 2: перечень занятий ─────────────────────── */
  // Одна строка — одно занятие со всеми полями. Свёрнут (details), чтобы не
  // мешать сетке. Тот же набор столбцов уходит на ВТОРОЙ лист файла при выгрузке
  // — см. TEACHER_ROW_COLS в src/services/groupExportService.js.
  const TEACHER_ROW_COLS = ['№', 'Нед.', 'Дата', 'День', 'Пара', 'Время', 'Дисциплина',
    'Вид', 'Тема', 'Группы', 'Аудитории', 'Преподаватели', 'Примечание'];

  let tlCtx = {}; // контекст последнего построения — им живут обработчики
  let tlRows = []; // [{ l, cells, idx }] в хронологическом порядке
  let tlSort = { col: null, dir: 1 };
  let tlFilters = {}; // индекс столбца → значение фильтра
  let tlOpen = false; // раскрыт ли блок — переживает перерисовку сетки

  const tlCells = (l, i, ctx) => [
    i + 1,
    l.weekNo,
    ctx.dateOf(l.weekNo, l.day) || '',
    l.day,
    SC.pairHours(l.pairNo),
    // Время одной строкой: в сетке разрыв <br> уместен, в перечне — тире.
    `${(SC.PAIR_TIMES[l.pairNo] || {}).start || ''}–${(SC.PAIR_TIMES[l.pairNo] || {}).end || ''}`,
    l.subject || '',
    l.type || '',
    l.topic || '',
    (l.groups || []).join(', '),
    (l.rooms || []).join(', '),
    (l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : [])).join(', '),
    l.note || '',
  ];

  function listHtml(lessons, ctx) {
    tlCtx = ctx;
    // Мероприятия и СР в перечень не идут — только учебные пары.
    const rows = lessons
      .filter((l) => !l.event && l.subject && l.subject !== 'СР')
      .sort((a, b) => a.weekNo - b.weekNo || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.pairNo - b.pairNo);
    tlRows = rows.map((l, i) => ({ l, cells: tlCells(l, i, ctx), idx: i }));
    if (!rows.length) return '';

    return `<details class="lessons-list" id="tlBlock"${tlOpen ? ' open' : ''}>` +
      `<summary class="subjects-title">Все занятия преподавателя (${rows.length}) — раскрыть</summary>` +
      '<div class="grid-scroll"><table class="grid tl-table">' +
      `<thead id="tlHead">${tlHeadHtml()}</thead><tbody id="tlBody">${tlBodyHtml()}</tbody>` +
      '</table></div></details>';
  }

  // Шапка в ОДНУ строку, как в Excel: название + стрелка. Стрелка раскрывает
  // окно, где и сортировка, и поиск, и выбор значений из списка.
  function tlHeadHtml() {
    let h = '<tr>';
    TEACHER_ROW_COLS.forEach((c, i) => {
      const f = tlFilters[i];
      const on = f && (f.q || f.vals); // фильтр по столбцу активен
      const arrow = tlSort.col === i ? (tlSort.dir > 0 ? '▲' : '▼') : '▾';
      h += `<th class="tl-th${on ? ' tl-on' : ''}">${esc(c)}` +
        `<button type="button" class="tl-menu" data-menu="${i}" title="Сортировка и фильтр">${arrow}</button></th>`;
    });
    h += '<th><button type="button" class="btn secondary sm" id="tlReset" title="Снять все фильтры и сортировку">✕</button></th></tr>';
    return h;
  }

  // Значения столбца для списка выбора (по тому, что реально есть в перечне).
  const tlUniq = (i) => [...new Set(tlRows.map((r) => String(r.cells[i] || '')))]
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));

  let tlPopEl = null;
  let tlPopCol = null;

  function closeTlPop() {
    if (tlPopEl) tlPopEl.hidden = true;
    tlPopCol = null;
  }

  // Окно столбца: сортировка, поиск и список значений с галочками.
  function openTlPop(col, btn) {
    if (!tlPopEl) {
      tlPopEl = document.createElement('div');
      tlPopEl.className = 'tl-pop';
      tlPopEl.hidden = true;
      document.body.appendChild(tlPopEl);
      tlPopEl.addEventListener('click', onTlPopClick);
      tlPopEl.addEventListener('input', onTlPopInput);
      document.addEventListener('click', (e) => {
        if (tlPopEl.hidden) return;
        // Клик по «(Выделить все)» перерисовывает окно раньше, чем событие
        // всплывёт сюда, и target остаётся без предков — поэтому смотрим
        // сохранённый путь события, а не текущее дерево.
        const path = e.composedPath();
        if (path.includes(tlPopEl) || path.some((n) => n.classList?.contains('tl-menu'))) return;
        closeTlPop();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTlPop(); });
    }
    if (tlPopCol === col && !tlPopEl.hidden) return closeTlPop();
    tlPopCol = col;
    renderTlPop();
    tlPopEl.hidden = false;
    const r = btn.getBoundingClientRect();
    const p = tlPopEl.getBoundingClientRect();
    tlPopEl.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - p.width - 6))}px`;
    tlPopEl.style.top = `${Math.min(r.bottom + 4, window.innerHeight - p.height - 6)}px`;
  }

  function renderTlPop() {
    const col = tlPopCol;
    const f = tlFilters[col] || {};
    const q = (f.q || '').toLowerCase();
    // Поиск сужает и список значений, и сами строки таблицы.
    const values = tlUniq(col).filter((v) => !q || v.toLowerCase().includes(q));
    const checked = (v) => (!f.vals || f.vals.has(v) ? ' checked' : '');
    tlPopEl.innerHTML =
      '<div class="tl-pop-sort"><button type="button" class="btn secondary sm" data-dir="1">▲ По возрастанию</button>' +
      '<button type="button" class="btn secondary sm" data-dir="-1">▼ По убыванию</button></div>' +
      `<input class="tl-pop-q" placeholder="Поиск…" value="${esc(f.q || '')}">` +
      `<label class="tl-pop-v"><input type="checkbox" data-all="1"${f.vals ? '' : ' checked'}> <b>(Выделить все)</b></label>` +
      '<div class="tl-pop-list">' +
      (values.length
        ? values.map((v) => `<label class="tl-pop-v"><input type="checkbox" data-v="${esc(v)}"${checked(v)}> ${esc(v || '(пусто)')}</label>`).join('')
        : '<div class="muted-hint">Ничего не найдено</div>') +
      '</div>' +
      '<div class="tl-pop-acts"><button type="button" class="btn secondary sm" data-clear="1">Сбросить столбец</button></div>';
    const inp = tlPopEl.querySelector('.tl-pop-q');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }

  function onTlPopInput(e) {
    const q = e.target.closest('.tl-pop-q');
    if (!q) return;
    const f = tlFilters[tlPopCol] || (tlFilters[tlPopCol] = {});
    f.q = q.value;
    if (!f.q && !f.vals) delete tlFilters[tlPopCol];
    refreshTlBody();
    renderTlPop();
    refreshTlHead();
  }

  function onTlPopClick(e) {
    const col = tlPopCol;
    const dir = e.target.closest('[data-dir]');
    if (dir) {
      tlSort = { col, dir: Number(dir.dataset.dir) };
      refreshTlHead();
      refreshTlBody();
      closeTlPop();
      return;
    }
    if (e.target.closest('[data-clear]')) {
      delete tlFilters[col];
      refreshTlHead();
      refreshTlBody();
      closeTlPop();
      return;
    }
    const all = e.target.closest('[data-all]');
    if (all) {
      const f = tlFilters[col] || (tlFilters[col] = {});
      // «Выделить все» — снять ограничение по значениям; снятая галочка — пустой выбор.
      f.vals = all.checked ? null : new Set();
      if (!f.q && !f.vals) delete tlFilters[col];
      renderTlPop();
      refreshTlHead();
      refreshTlBody();
      return;
    }
    const box = e.target.closest('[data-v]');
    if (!box) return;
    const f = tlFilters[col] || (tlFilters[col] = {});
    if (!f.vals) f.vals = new Set(tlUniq(col)); // до первого снятия выбраны все
    if (box.checked) f.vals.add(box.dataset.v);
    else f.vals.delete(box.dataset.v);
    if (f.vals.size === tlUniq(col).length) f.vals = null; // выбраны все — фильтра нет
    if (!f.q && !f.vals) delete tlFilters[col];
    refreshTlHead();
    refreshTlBody();
  }

  // Ключ сортировки: у «числовых» столбцов — само число (иначе «10» встало бы
  // перед «9»), у даты — хронология, у остальных — текст.
  function tlKey(r, col) {
    if (col === 1) return r.l.weekNo;
    if (col === 2) return r.l.weekNo * 10 + DAYS.indexOf(r.l.day);
    if (col === 3) return DAYS.indexOf(r.l.day);
    if (col === 4 || col === 5) return r.l.pairNo;
    return String(r.cells[col] || '').toLowerCase();
  }

  function tlBodyHtml() {
    const edit = tlCtx.editable || {};
    const acts = Boolean(tlCtx.onMove || tlCtx.onOpen);
    // Строка проходит, если по КАЖДОМУ столбцу совпал поиск и значение выбрано.
    let rows = tlRows.filter((r) => Object.entries(tlFilters).every(([i, f]) => {
      const v = String(r.cells[i] || '');
      if (f.q && !v.toLowerCase().includes(String(f.q).toLowerCase())) return false;
      return !f.vals || f.vals.has(v);
    }));
    if (tlSort.col != null) {
      const c = tlSort.col;
      rows = [...rows].sort((a, b) => {
        const x = tlKey(a, c);
        const y = tlKey(b, c);
        const cmp = typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y), 'ru', { numeric: true });
        return (cmp || a.idx - b.idx) * (cmp ? tlSort.dir : 1);
      });
    }
    if (!rows.length) return `<tr><td colspan="${TEACHER_ROW_COLS.length + 1}">Ничего не найдено по фильтрам</td></tr>`;
    return rows.map(({ l, cells }) =>
      `<tr data-lid="${l.id}"${tlCtx.canEdit && !tlCtx.canEdit(l.id) ? ' class="read-only"' : ''}>` +
      cells.map((v, i) => tlCellHtml(l, tlCtx.canEdit && !tlCtx.canEdit(l.id) ? null : edit[i], String(v == null ? '' : v))).join('') +
      (acts
        ? '<td class="tl-acts">' +
          (tlCtx.onMove && (!tlCtx.canEdit || tlCtx.canEdit(l.id)) ? `<button type="button" class="btn secondary sm" data-tl-move="${l.id}" title="Перенести: сетка подсветит свободные окна, кликните нужное">⇄</button>` : '') +
          (tlCtx.onOpen ? `<button type="button" class="btn secondary sm" data-tl-open="${l.id}" title="Открыть карточку занятия">✎</button>` : '') +
          '</td>'
        : '<td class="tl-acts"></td>') +
      '</tr>').join('');
  }

  // Ячейка перечня: обычная, поле ввода или список (ed = { field, options }).
  // Значение вне options править нельзя — так вид занятия остаётся нередактируемым
  // у лекций и форм контроля: их кодов в списке нет.
  function tlCellHtml(l, ed, v) {
    if (!ed) return `<td>${esc(v)}</td>`;
    if (!ed.options) return `<td class="tl-ed"><input class="tl-inp" data-id="${l.id}" data-field="${ed}" value="${esc(v)}"></td>`;
    if (!ed.options.includes(v)) return `<td>${esc(v)}</td>`;
    return `<td class="tl-ed"><select class="tl-inp" data-id="${l.id}" data-field="${ed.field}">` +
      ed.options.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('') +
      '</select></td>';
  }

  // Правка поля прямо в перечне. Сохранение делает страница (ctx.save) — она же
  // знает свой эндпоинт; откат неудачной правки и обновление строки — здесь.
  // Занятия в tlRows — те же объекты, что у страницы, поэтому правка видна и в сетке.
  async function saveTlField(inp) {
    const id = Number(inp.dataset.id);
    const field = inp.dataset.field;
    const value = inp.value.trim();
    const row = tlRows.find((r) => r.l.id === id);
    const before = row ? (row.l[field] || '') : '';
    if (value === before || !tlCtx.save) return;
    const say = tlCtx.toast || (() => {});
    try {
      await tlCtx.save(id, field, value || null);
      if (row) {
        row.l[field] = value || null;
        row.cells = tlCells(row.l, row.idx, tlCtx);
      }
      // Занятие в сетке уже нарисовано старым — просим страницу его перерисовать.
      if (tlCtx.onSaved) tlCtx.onSaved(id);
      say('Сохранено');
    } catch (err) {
      inp.value = before; // не сохранилось — возвращаем прежнее значение
      say(((err.data && err.data.reasons) || [err.message]).join('; '), true);
    }
  }

  const refreshTlBody = () => { const b = $('tlBody'); if (b) b.innerHTML = tlBodyHtml(); };
  const refreshTlHead = () => { const h = $('tlHead'); if (h) h.innerHTML = tlHeadHtml(); };

  // Обработчики перечня: сортировка, фильтры, правка полей и кнопки строки.
  // Вызывать после каждой вставки listHtml в документ.
  function bindList() {
    const block = $('tlBlock');
    if (!block) return;
    block.addEventListener('toggle', () => { tlOpen = block.open; });

    block.addEventListener('click', (e) => {
      const menu = e.target.closest('.tl-menu');
      if (menu) return openTlPop(Number(menu.dataset.menu), menu);
      if (e.target.closest('#tlReset')) {
        closeTlPop();
        tlFilters = {};
        tlSort = { col: null, dir: 1 };
        refreshTlHead();
        refreshTlBody();
        return;
      }
      const mv = e.target.closest('[data-tl-move]');
      if (mv && tlCtx.onMove) return tlCtx.onMove(Number(mv.dataset.tlMove));
      const op = e.target.closest('[data-tl-open]');
      if (op && tlCtx.onOpen) tlCtx.onOpen(Number(op.dataset.tlOpen));
    });

    block.addEventListener('change', (e) => {
      const inp = e.target.closest('.tl-inp');
      if (inp) saveTlField(inp);
    });
    // Enter сохраняет поле, не перезагружая страницу.
    block.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('tl-inp')) e.target.blur();
    });
  }

  return {
    summaryHtml,
    listHtml,
    bindList,
    compareTypes,
    isLectureType,
    parseHoursExpected,
    TEACHER_ROW_COLS,
  };
})();
