// Страница журнала переносов: читает /api/move-log и выводит таблицу.
// Заголовки работают как автофильтр Excel: клик по названию — сортировка,
// кнопка-воронка — фильтр по значениям столбца.
(function () {
  'use strict';

  const SC = window.SCHED_CONST;
  // Время пары для подписи («1 (9.00–10.35)»).
  const PAIR_TIMES = Object.fromEntries(
    Object.entries(SC.PAIR_TIMES).map(([p, t]) => [p, `${t.start}–${t.end}`])
  );
  const DAY_ORDER = { Пн: 0, Вт: 1, Ср: 2, Чт: 3, Пт: 4, Сб: 5, Вс: 6 };

  const $ = (id) => document.getElementById(id);
  let entries = [];
  let sortState = { key: null, dir: 1 }; // dir: 1 — по возрастанию, -1 — по убыванию
  const filters = Object.create(null); // key → Set выбранных значений (нет ключа = без фильтра)

  // ── Описание столбцов (единый источник: colgroup, шапка, ячейки, поиск) ──
  // value(e)  — текст для фильтра/поиска/сортировки по умолчанию
  // sortVal(e)— ключ сортировки (число или строка), если нужен иной порядок
  // html(e)   — содержимое ячейки (по умолчанию esc(value)||'—')
  // Вид записи: перенос, добавление занятия, удаление занятия. У добавления пусты
  // столбцы «откуда», у удаления — «куда»; здесь это названо словом.
  const ACTION_LABEL = { move: 'Перенос', create: 'Добавление', delete: 'Удаление', room: 'Смена аудитории' };
  const actionOf = (e) => ACTION_LABEL[e.action] || ACTION_LABEL.move;

  const COLS = [
    { key: 'action', label: 'Действие', width: 8, filterable: true, tdClass: 'nowrap',
      value: actionOf,
      html: (e) => `<span class="log-act log-act-${esc(e.action || 'move')}">${esc(actionOf(e))}</span>` },
    { key: 'groups', label: 'Группы', width: 7, filterable: true, value: (e) => e.groups || '' },
    { key: 'subject', label: 'Дисциплина', width: 10, filterable: true, value: subjectText },
    { key: 'teacher', label: 'Преподаватель', width: 8, filterable: true, value: (e) => e.teacher || '' },
    { key: 'fromRoom', label: 'Аудитория (откуда)', width: 7, filterable: true, tdClass: 'nowrap', value: fromRoomValue, html: fromRoomCell },
    { key: 'toRoom', label: 'Аудитория (куда)', width: 7, filterable: true, tdClass: 'nowrap', value: toRoomValue, html: toRoomCell },
    { key: 'fromSlot', label: 'С какой даты', width: 7, filterable: true, tdClass: 'nowrap',
      value: (e) => slotValue(e.fromDay, e.fromDate, e.fromWeek), sortVal: (e) => slotSort(e.fromDay, e.fromWeek), html: (e) => slot(e.fromDay, e.fromDate, e.fromWeek) },
    { key: 'fromPair', label: 'С каких часов', width: 6, filterable: true, tdClass: 'nowrap',
      value: (e) => SC.pairHours(e.fromPair) || '', sortVal: (e) => Number(e.fromPair) || 0, html: (e) => pair(e.fromPair) },
    { key: 'toSlot', label: 'На какую дату', width: 7, filterable: true, tdClass: 'nowrap',
      value: (e) => slotValue(e.toDay, e.toDate, e.toWeek), sortVal: (e) => slotSort(e.toDay, e.toWeek), html: (e) => slot(e.toDay, e.toDate, e.toWeek) },
    { key: 'toPair', label: 'На какие часы', width: 6, filterable: true, tdClass: 'nowrap',
      value: (e) => SC.pairHours(e.toPair) || '', sortVal: (e) => Number(e.toPair) || 0, html: (e) => pair(e.toPair) },
    { key: 'typeTopic', label: 'Вид / тема занятия', width: 7, filterable: true,
      value: (e) => [e.type, e.topic].filter(Boolean).join(' / ') },
    { key: 'movedAt', label: 'Дата и время', width: 7, tdClass: 'nowrap',
      value: (e) => formatMoment(e.movedAt), sortVal: (e) => e.movedAt || '' },
    { key: 'note', label: 'Примечание', width: 7, tdClass: 'note-cell',
      value: (e) => e.note || '',
      html: (e) => `<input type="text" class="log-note" data-id="${e.id}" value="${esc(e.note || '')}" placeholder="Примечание…">` },
    { key: 'actions', label: 'Действия', width: 6, sortable: false, tdClass: 'log-actions',
      html: (e) =>
        (revertableIds.has(e.id)
          ? `<button type="button" class="btn secondary sm" data-revert="${e.id}" title="${e.action === 'room' ? 'Вернуть прежнюю аудиторию' : 'Отменить перенос: вернуть занятие в предыдущую ячейку (с проверкой занятости)'}" aria-label="Отменить">↩</button>`
          : '') +
        `<button type="button" class="btn danger sm" data-del="${e.id}" title="Удалить запись журнала" aria-label="Удалить запись">🗑</button>` },
  ];
  const colByKey = Object.fromEntries(COLS.map((c) => [c.key, c]));

  // Журнал хранит ЦЕПОЧКУ изменений занятия: каждый шаг — своя запись, «откуда» =
  // предыдущая ячейка. Записи одного занятия собираются в группу: видна верхняя
  // (последнее изменение), остальные раскрываются стрелкой — от первого
  // появления и дальше. Записи приходят DESC по id, поэтому первая встреченная
  // запись занятия и есть последняя по времени.
  let groups = [];               // [{ key, head, rest }] в порядке журнала
  let revertableIds = new Set(); // id записей, у которых рисуется кнопка ↩
  // ?lesson=<id> — открыли журнал из карточки занятия: показываем только его
  // цепочку и сразу раскрытой. Сбрасывается кнопкой «Сбросить фильтры».
  let focusLesson = Number(new URLSearchParams(location.search).get('lesson')) || null;
  const expanded = new Set();    // ключи раскрытых цепочек (переживают перерисовку)

  function buildGroups() {
    const byKey = new Map();
    groups = [];
    for (const e of entries) { // журнал идёт DESC по id
      const key = e.lessonId != null ? `#${e.lessonId}` : `id${e.id}`; // без привязки — сама себе цепочка
      const g = byKey.get(key);
      if (g) g.rest.push(e);
      else {
        const fresh = { key, head: e, rest: [] };
        byKey.set(key, fresh);
        groups.push(fresh);
      }
    }
    for (const g of groups) g.rest.reverse(); // от первого появления к последнему
    if (focusLesson) expanded.add(`#${focusLesson}`); // пришли из карточки — цепочка раскрыта
    // Отменить можно только ПОСЛЕДНЕЕ изменение занятия: оно стоит в своей
    // целевой ячейке и аудитории. Добавление и удаление отменяются не отсюда.
    revertableIds = new Set(
      groups.map((g) => g.head).filter((e) => ['move', 'room'].includes(e.action || 'move')).map((e) => e.id)
    );
  }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const { authenticated } = await api.get('/api/auth/check');
      if (!authenticated) return (location.href = '/login.html');
    } catch {
      return (location.href = '/login.html');
    }

    $('btnLogout').onclick = async () => {
      await api.post('/api/logout');
      location.href = '/login.html';
    };
    $('logSearch').oninput = render;
    $('btnClearLog').onclick = clearLog;
    $('btnResetFilters').onclick = resetAll;

    renderHead();
    await loadLog();
  }

  // Полная очистка журнала (с подтверждением). Расписание не затрагивается.
  async function clearLog() {
    if (!entries.length) return toast('Журнал уже пуст');
    if (!confirm('Очистить весь журнал переносов? Это действие необратимо. На само расписание не повлияет.')) return;
    try {
      const r = await api.del('/api/move-log');
      toast(`Журнал очищен (удалено записей: ${r.deleted ?? 0})`);
      await loadLog();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function resetAll() {
    sortState = { key: null, dir: 1 };
    for (const k of Object.keys(filters)) delete filters[k];
    focusLesson = null;
    render();
  }

  async function loadLog() {
    try {
      const data = await api.get('/api/move-log');
      entries = data.entries || [];
    } catch (err) {
      entries = [];
      toast(err.message, true);
    }
    buildGroups();
    render();
  }

  function render() {
    closeFilter();
    const rows = visibleGroups();
    const total = entries.length;

    $('logCount').textContent = focusLesson
      ? `Показаны изменения одного занятия (всего в журнале: ${total})`
      : rows.length === groups.length
        ? `Всего записей: ${total} · занятий: ${groups.length}`
        : `Показано занятий: ${rows.length} из ${groups.length}`;

    const filtered = sortState.key || Object.keys(filters).length || focusLesson;
    $('btnResetFilters').style.display = filtered ? '' : 'none';

    const empty = $('logEmpty');
    if (!total) {
      empty.textContent = 'Переносов пока не было.';
      empty.style.display = 'block';
    } else if (!rows.length) {
      empty.textContent = focusLesson
        ? 'Записей об этом занятии в журнале нет — возможно, журнал очищали.'
        : 'Ничего не найдено по текущим фильтрам.';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
    }

    renderHead();
    $('logBody').innerHTML = rows.map(groupHtml).join('');
    bindNoteInputs();
    bindRowActions();
  }

  // Видимые цепочки: глобальный поиск + фильтры столбцов + сортировка. Цепочка
  // проходит, если подошла ЛЮБАЯ её запись: искали промежуточный слот — занятие
  // всё равно нашлось, а увидеть шаг можно, раскрыв цепочку.
  function visibleGroups() {
    const q = $('logSearch').value.trim().toLowerCase();
    const pass = (e) => {
      if (q && !globalMatch(e, q)) return false;
      for (const key in filters) {
        if (!filters[key].has(colByKey[key].value(e) || '—')) return false;
      }
      return true;
    };
    let rows = groups
      .filter((g) => !focusLesson || g.key === `#${focusLesson}`)
      .filter((g) => pass(g.head) || g.rest.some(pass));
    if (sortState.key) {
      const col = colByKey[sortState.key];
      rows = rows
        .map((g, i) => [g, i]) // стабильная сортировка: при равенстве — исходный порядок
        .sort((a, b) => cmp(sortKey(col, a[0].head), sortKey(col, b[0].head)) * sortState.dir || a[1] - b[1])
        .map((p) => p[0]);
    }
    return rows;
  }

  function sortKey(col, e) {
    return col.sortVal ? col.sortVal(e) : (col.value(e) || '').toString();
  }
  function cmp(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });
  }

  function globalMatch(e, q) {
    if ((e.subject || '').toLowerCase().includes(q)) return true; // короткое название тоже
    return COLS.some((c) => c.value && (c.value(e) || '').toLowerCase().includes(q));
  }

  // ── Шапка таблицы (colgroup + заголовки с сортировкой и воронкой) ──
  function renderHead() {
    $('logCols').innerHTML = COLS.map((c) => `<col style="width:${c.width}%">`).join('');
    $('logHead').innerHTML = '<tr>' + COLS.map(headCell).join('') + '</tr>';
    bindHead();
  }

  function headCell(c) {
    const sortable = c.sortable !== false;
    const arrow = sortState.key === c.key ? (sortState.dir > 0 ? ' ▲' : ' ▼') : '';
    const label = sortable
      ? `<button type="button" class="lh-label" data-sort="${c.key}" title="Сортировать">${esc(c.label)}<span class="lh-arrow">${arrow}</span></button>`
      : `<span class="lh-label">${esc(c.label)}</span>`;
    const funnel = c.filterable
      ? `<button type="button" class="lh-filter${filters[c.key] ? ' active' : ''}" data-filter="${c.key}" title="Фильтр" aria-label="Фильтр: ${esc(c.label)}">▾</button>`
      : '';
    return `<th><div class="lh-cell">${label}${funnel}</div></th>`;
  }

  function bindHead() {
    $('logHead').querySelectorAll('[data-sort]').forEach((el) => {
      el.onclick = () => toggleSort(el.dataset.sort);
    });
    $('logHead').querySelectorAll('[data-filter]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        openFilter(el.dataset.filter, el);
      };
    });
  }

  function toggleSort(key) {
    if (sortState.key === key) sortState.dir = -sortState.dir;
    else sortState = { key, dir: 1 };
    render();
  }

  // ── Выпадающий фильтр столбца (чекбоксы значений + поиск) ──
  function distinctValues(col) {
    const set = new Set();
    for (const e of entries) set.add(col.value(e) || '—');
    return [...set].sort(cmp);
  }

  function openFilter(key, anchor) {
    closeFilter();
    const col = colByKey[key];
    const values = distinctValues(col);
    const checked = filters[key] || null; // null = все отмечены

    const panel = document.createElement('div');
    panel.className = 'log-filter';
    panel.id = 'logFilter';

    const search = el('input', 'lf-search');
    search.type = 'search';
    search.placeholder = 'Поиск значений…';

    const allLabel = el('label', 'lf-all');
    const allBox = el('input');
    allBox.type = 'checkbox';
    allLabel.append(allBox, document.createTextNode(' (Выбрать все)'));

    const list = el('div', 'lf-list');
    const boxes = values.map((v) => {
      const item = el('label', 'lf-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = checked ? checked.has(v) : true;
      item.append(cb, document.createTextNode(' ' + v));
      list.appendChild(item);
      return { cb, item, v };
    });

    const actions = el('div', 'lf-actions');
    const apply = btn('Применить', 'btn primary sm');
    const reset = btn('Сбросить', 'btn secondary sm');
    actions.append(apply, reset);

    panel.append(search, allLabel, list, actions);
    document.body.appendChild(panel);
    positionPanel(panel, anchor);
    search.focus();

    const visible = () => boxes.filter((b) => b.item.style.display !== 'none');
    function syncAll() {
      const vis = visible();
      const on = vis.filter((b) => b.cb.checked).length;
      allBox.checked = vis.length > 0 && on === vis.length;
      allBox.indeterminate = on > 0 && on < vis.length;
    }
    syncAll();

    search.oninput = () => {
      const qq = search.value.trim().toLowerCase();
      boxes.forEach((b) => (b.item.style.display = b.v.toLowerCase().includes(qq) ? '' : 'none'));
      syncAll();
    };
    allBox.onchange = () => visible().forEach((b) => (b.cb.checked = allBox.checked));
    list.addEventListener('change', syncAll);

    apply.onclick = () => {
      const sel = boxes.filter((b) => b.cb.checked).map((b) => b.v);
      if (sel.length === values.length) delete filters[key]; // всё выбрано = фильтра нет
      else filters[key] = new Set(sel);
      render();
    };
    reset.onclick = () => {
      delete filters[key];
      render();
    };

    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    function onDocDown(ev) {
      if (!panel.contains(ev.target) && ev.target !== anchor) closeFilter();
    }
    function onEsc(ev) {
      if (ev.key === 'Escape') closeFilter();
    }
    panel._cleanup = () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onEsc, true);
    };
  }

  function closeFilter() {
    const p = $('logFilter');
    if (p) {
      if (p._cleanup) p._cleanup();
      p.remove();
    }
  }

  function positionPanel(panel, anchor) {
    const r = anchor.getBoundingClientRect();
    const maxLeft = window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 8;
    const left = Math.max(window.scrollX + 8, Math.min(window.scrollX + r.left, maxLeft));
    panel.style.left = left + 'px';
    panel.style.top = window.scrollY + r.bottom + 4 + 'px';
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  function btn(text, cls) {
    const b = el('button', cls);
    b.type = 'button';
    b.textContent = text;
    return b;
  }

  // Кнопки в строке: раскрытие цепочки, отмена переноса и удаление записи.
  function bindRowActions() {
    $('logBody').querySelectorAll('[data-chain]').forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.chain;
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        render();
      };
    });
    $('logBody').querySelectorAll('[data-revert]').forEach((b) => {
      b.onclick = () => revertEntry(Number(b.dataset.revert));
    });
    $('logBody').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => deleteEntry(Number(b.dataset.del));
    });
  }

  // Отмена последнего изменения занятия: перенос возвращается в предыдущую
  // ячейку, смена аудитории — к прежней аудитории. Сервер проверяет, что занятие
  // на месте и что цель свободна (иначе — причины отказа); занятая аудитория и
  // нехватка мест — предупреждение с подтверждением.
  async function revertEntry(id) {
    const entry = entries.find((e) => e.id === id);
    const isRoom = entry && entry.action === 'room';
    const ask = isRoom
      ? `Вернуть аудиторию ${entry.fromRoom || '—'}?`
      : 'Отменить этот перенос? Занятие вернётся в предыдущую ячейку, если она свободна.';
    if (!confirm(ask)) return;
    try {
      await send(id, false);
      toast(isRoom ? 'Аудитория возвращена' : 'Перенос отменён — занятие вернулось в предыдущую ячейку');
      await loadLog();
    } catch (err) {
      const d = (err && err.data) || {};
      // Предупреждение (аудитория занята, мало мест) — решает составитель.
      if (d.confirm && Array.isArray(d.warnings) && d.warnings.length) {
        if (!confirm(`${d.warnings.join('\n')}\n\n${isRoom ? 'Всё равно вернуть аудиторию?' : 'Всё равно вернуть занятие?'}`)) return;
        try {
          await send(id, true);
          toast(isRoom ? 'Аудитория возвращена' : 'Перенос отменён — занятие вернулось в предыдущую ячейку');
          await loadLog();
        } catch (err2) {
          toast(((err2.data && err2.data.reasons) || [err2.message]).join('; '), true);
        }
        return;
      }
      toast((d.reasons || [err.message]).join('; '), true);
    }
  }

  const send = (id, force) => api.post(`/api/move-log/${id}/revert`, force ? { force: true } : {});

  // Удаление записи журнала (история). На расписание не влияет.
  async function deleteEntry(id) {
    if (!confirm('Удалить эту запись журнала? На само расписание не повлияет.')) return;
    try {
      await api.del(`/api/move-log/${id}`);
      toast('Запись удалена');
      await loadLog();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Сохранение примечания: по потере фокуса и по Enter (если значение изменилось).
  function bindNoteInputs() {
    $('logBody')
      .querySelectorAll('.log-note')
      .forEach((inp) => {
        inp.onblur = () => saveNote(inp);
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') inp.blur();
        };
      });
  }

  async function saveNote(inp) {
    const id = Number(inp.dataset.id);
    const entry = entries.find((e) => e.id === id);
    const value = inp.value.trim();
    if (!entry || (entry.note || '') === value) return; // без изменений — не дёргаем сервер
    try {
      await api.put(`/api/move-log/${id}`, { note: value || null });
      entry.note = value;
      inp.style.borderColor = 'var(--primary)';
      toast('Примечание сохранено');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Дисциплина: полное название, а в скобках — сокращение (если есть оба).
  // Если полного нет — показываем только сокращение.
  function subjectText(e) {
    if (e.subjectFull) return e.subject ? `${e.subjectFull} (${e.subject})` : e.subjectFull;
    return e.subject || '';
  }

  // Аудитория до переноса. Для старых записей без from_room показываем текущую
  // (тогда аудитория не менялась — переносился только слот).
  function fromRoomValue(e) {
    return e.fromRoom || e.room || '';
  }
  function fromRoomCell(e) {
    return esc(fromRoomValue(e) || '—');
  }

  // Аудитория после переноса. Пустая аудитория при наличии исходной = уход в буфер.
  // У удаления занятия «куда» пусто по смыслу — это не отправка в буфер.
  function toRoomValue(e) {
    if (e.action === 'delete') return '';
    if (!e.room) return e.fromRoom ? 'буфер' : '';
    return e.room;
  }
  function toRoomCell(e) {
    return esc(toRoomValue(e) || '—');
  }

  // Цепочка занятия: верхняя запись + (если раскрыта) все предыдущие шаги,
  // от первого появления к последнему.
  function groupHtml(g) {
    const steps = g.rest.length + 1;
    let html = rowHtml(g.head, { key: g.key, rest: g.rest.length });
    if (g.rest.length && expanded.has(g.key)) {
      html += g.rest.map((e, i) => rowHtml(e, { step: i + 1, steps })).join('');
    }
    return html;
  }

  function rowHtml(e, opts = {}) {
    const cells = COLS.map((c) => {
      const html = c.key === 'action' ? actionCell(e, opts) : (c.html ? c.html(e) : esc(c.value(e) || '—'));
      return `<td class="${c.tdClass || ''}">${html}</td>`;
    });
    return `<tr${opts.step ? ' class="log-step"' : ''}>${cells.join('')}</tr>`;
  }

  // Столбец «Действие»: у верхней записи — ярлык и кнопка раскрытия цепочки
  // (число = сколько всего изменений у занятия), у шагов цепочки — их номер.
  function actionCell(e, opts) {
    const label = `<span class="log-act log-act-${esc(e.action || 'move')}">${esc(actionOf(e))}</span>`;
    if (opts.step) return `<div class="log-step-no">↳ шаг ${opts.step} из ${opts.steps}</div>${label}`;
    if (!opts.rest) return label;
    const open = expanded.has(opts.key);
    return label
      + `<button type="button" class="log-chain${open ? ' open' : ''}" data-chain="${esc(opts.key)}"`
      + ` title="Вся цепочка изменений занятия: с первого появления и дальше" aria-expanded="${open}">`
      + `${open ? '▾' : '▸'} ${opts.rest + 1}</button>`;
  }

  // «Пн 15.09 · нед 3» (дата может отсутствовать, если семестр не был задан).
  function slot(day, date, week) {
    const head = [esc(day || ''), esc(date || '')].filter(Boolean).join(' ');
    const w = week ? `<div class="muted">нед ${esc(week)}</div>` : '';
    return `${head || '—'}${w}`;
  }
  // Плоское значение слота для фильтра/поиска.
  function slotValue(day, date, week) {
    const head = [day, date].filter(Boolean).join(' ');
    return head ? head + (week ? ` нед ${week}` : '') : '';
  }
  // Хронологический ключ: неделя × 7 + день недели.
  function slotSort(day, week) {
    return (Number(week) || 0) * 7 + (DAY_ORDER[day] ?? 99);
  }

  // «5–6 (12.50–14.25)» — учебные часы пары + время.
  function pair(p) {
    if (!p) return '—';
    const t = PAIR_TIMES[p];
    return `${esc(SC.pairHours(p))}${t ? `<div class="muted">${esc(t)}</div>` : ''}`;
  }

  // ISO → «15.09.2025, 14:32».
  function formatMoment(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ` +
      `${p(d.getHours())}:${p(d.getMinutes())}`
    );
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 20000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
