// Страница «Календарь сессии»: сводная сетка «день × группа» из сессионных занятий
// (экз/зачёт/курсовая). Данные — проекция расписания (см. /api/session-calendar).
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = (msg, bad) => {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' error' : '');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  };

  const DAYS = (window.SCHED_CONST && SCHED_CONST.DAYS) || ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  // Короткий код вида контроля: ЭКЗ / ЗО / ЗАЧ.
  function vidLabel(l) {
    if (l.kind === 'exam') return 'ЭКЗ';
    const t = String(l.type || '').toLowerCase().replace(/[.\s]+$/, '');
    return t === 'зо' || t === 'з/о' ? 'ЗО' : 'ЗАЧ'; // зачёт с оценкой vs без
  }

  const PAIR_TIMES = (window.SCHED_CONST && SCHED_CONST.PAIR_TIMES) || {};
  const state = { data: null, byCell: new Map(), byId: new Map(), sort: 'group', courseFilter: 0, drag: null };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const { authenticated } = await api.get('/api/auth/check');
      if (!authenticated) return (location.href = '/login.html');
    } catch { return (location.href = '/login.html'); }

    $('btnLogout').onclick = async () => { await api.post('/api/logout'); location.href = '/login.html'; };
    $('from').onchange = render;
    $('to').onchange = render;
    document.querySelectorAll('.ses-sort').forEach((btn) => {
      btn.onclick = () => {
        state.sort = btn.dataset.sort;
        document.querySelectorAll('.ses-sort').forEach((b) => b.classList.toggle('active', b === btn));
        render();
      };
    });
    $('courseFilter').onchange = () => { state.courseFilter = Number($('courseFilter').value); render(); };
    // Клик по карточке формы контроля → подробности во всплывающем окне.
    $('grid').addEventListener('click', (e) => {
      const a = e.target.closest('.ses-a');
      if (!a) return;
      const l = state.byId.get(Number(a.dataset.id));
      if (l) openPop(l);
    });
    $('pop').addEventListener('click', (e) => {
      if (e.target.id === 'pop' || e.target.dataset.close) closePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
    // Перенос перетягиванием: карточку формы контроля тащим на подходящий день.
    const grid = $('grid');
    grid.addEventListener('dragstart', onDragStart);
    grid.addEventListener('dragover', onDragOver);
    grid.addEventListener('drop', onDrop);
    grid.addEventListener('dragend', onDragEnd);

    // Вкладки: «Календарь сессии» / «Список экзаменов и зачётов».
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });
    $('exSem').onchange = renderExams;
    $('exKaf').onchange = renderExams;
    ['schCourse', 'schDept'].forEach((id) => { $(id).onchange = renderSchedule; });
    ['schSubject', 'schTeacher'].forEach((id) => { $(id).oninput = renderSchedule; });
    $('schReset').onclick = () => {
      ['schCourse', 'schDept', 'schSubject', 'schTeacher'].forEach((id) => { $(id).value = ''; });
      renderSchedule();
    };
    $('schPrint').onclick = () => window.print();
    // Прямой переход на вкладку по ссылке: /session.html#exams, /session.html#schedule.
    if (location.hash === '#exams' || location.hash === '#schedule') switchTab(location.hash.slice(1));

    try { await loadData(); } catch (err) { toast(err.message, true); }
  }

  // ── Вкладки ─────────────────────────────────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('tabCalendar').hidden = tab !== 'calendar';
    $('tabExams').hidden = tab !== 'exams';
    $('tabSchedule').hidden = tab !== 'schedule';
    if (tab === 'exams' && !exState.plans) loadPlans().catch((err) => toast(err.message, true));
    // График перечитывается при каждом открытии: экзамен могли перенести в календаре.
    if (tab === 'schedule') loadSchedule().catch((err) => toast(err.message, true));
  }

  // ── График сессии: экзамены и зачёты списком по курсам и группам ────────────
  const schState = { data: null }; // ответ /api/session-schedule
  const uniq = (arr) => [...new Set(arr.filter((x) => x != null && x !== ''))];
  const byRu = (a, b) => String(a).localeCompare(String(b), 'ru', { numeric: true });

  async function loadSchedule() {
    if (!schState.data) renderSchedule(); // «Загрузка…» только в первый раз
    schState.data = await api.get('/api/session-schedule');
    const rows = schState.data.groups.flatMap((g) => g.rows);
    fillSelect('schCourse', 'Все курсы', uniq(schState.data.groups.map((g) => g.course)).sort((a, b) => a - b).map((c) => [c, `${c} курс`]));
    fillSelect('schDept', 'Все кафедры', uniq(rows.flatMap((r) => r.teachers.map((t) => t.dept))).sort(byRu).map((d) => [d, `Кафедра ${d}`]));
    $('schSubjects').innerHTML = uniq(rows.flatMap((r) => [r.subject, r.subjectFull])).sort(byRu).map((s) => `<option value="${esc(s)}">`).join('');
    $('schTeachers').innerHTML = uniq(rows.flatMap((r) => r.teachers.map((t) => t.name))).sort(byRu).map((s) => `<option value="${esc(s)}">`).join('');
    renderSchedule();
  }

  // Список заново, но выбранное остаётся выбранным (если оно ещё есть).
  function fillSelect(id, allLabel, items) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>`
      + items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    sel.value = items.some(([v]) => String(v) === keep) ? keep : '';
  }

  // Строка проходит поиск: кафедра преподавателя, дисциплина (сокращение или
  // полное название), преподаватель — по части ФИО, без учёта регистра.
  function rowMatches(r, f) {
    if (f.dept && !r.teachers.some((t) => t.dept === f.dept)) return false;
    if (f.subject && ![r.subject, r.subjectFull].some((s) => String(s || '').toLowerCase().includes(f.subject))) return false;
    if (f.teacher && !r.teachers.some((t) => t.name.toLowerCase().includes(f.teacher))) return false;
    return true;
  }

  const SCH_HEAD = ['№', 'Дата', 'День', 'Пары, время', 'Вид', 'Дисциплина', 'Аудитория', 'Преподаватель', 'Поток',
    '<span title="Курсантов всего потока / мест в аудиториях">Курсантов / мест</span>',
    '<span title="Дней после предыдущего экзамена или зачёта группы">Дней после предыдущей</span>', 'Примечание'];

  function renderSchedule() {
    const data = schState.data;
    if (!data) { $('schGrid').innerHTML = '<div class="ses-empty">Загрузка…</div>'; return; }
    const low = (id) => $(id).value.trim().toLowerCase();
    const f = { course: $('schCourse').value, dept: $('schDept').value, subject: low('schSubject'), teacher: low('schTeacher') };

    const byCourse = new Map(); // курс ('' — не задан) → [{ group, rows }]
    let rowsShown = 0;
    for (const g of data.groups) {
      if (f.course && String(g.course) !== f.course) continue;
      const rows = g.rows.filter((r) => rowMatches(r, f));
      if (!rows.length) continue;
      rowsShown += rows.length;
      const key = g.course ?? '';
      if (!byCourse.has(key)) byCourse.set(key, []);
      byCourse.get(key).push({ ...g, rows });
    }
    const groupsShown = [...byCourse.values()].reduce((s, a) => s + a.length, 0);
    const sem = data.semester;
    $('schMeta').textContent = `Групп: ${groupsShown} · экзаменов и зачётов по группам: ${rowsShown}`
      + (sem && sem.name ? ` · семестр: ${sem.name}` : '');
    if (!groupsShown) {
      $('schGrid').innerHTML = `<div class="ses-empty">${data.groups.length
        ? 'Под условия поиска ничего не подходит.'
        : 'В расписании нет экзаменов и зачётов. Загрузите расписание и задайте активный семестр.'}</div>`;
      return;
    }
    const order = [...byCourse.keys()].sort((a, b) => (a === '' ? 99 : a) - (b === '' ? 99 : b));
    $('schGrid').innerHTML = order.map((c) => `<section class="sch-course"><h2>${c === '' ? 'Курс не задан' : `${c} курс`}</h2>`
      + byCourse.get(c).map(groupTable).join('') + '</section>').join('');
  }

  function groupTable(g) {
    const dash = '<span class="ex-dash">—</span>';
    const body = g.rows.map((r, i) => {
      const rng = pairRange(r), tm = pairTime(r);
      const lack = r.capacity != null && r.headcount != null && r.capacity < r.headcount;
      const seats = r.headcount == null && r.capacity == null ? dash
        : `<span class="${lack ? 'sch-bad' : ''}"${lack ? ' title="Мест меньше, чем курсантов"' : ''}>${r.headcount ?? '?'} / ${r.capacity ?? '?'}</span>`;
      const prep = r.prepConflicts && r.prepConflicts.length
        ? `<div class="sch-bad" title="${esc(r.prepConflicts.map((c) => `${c.date}: ${c.items.map((x) => `${x.type || ''} ${x.subject || ''}`.trim()).join(', ')}`).join('\n'))}">⚠ заняты дни подготовки</div>`
        : '';
      const teachers = r.teachers.length
        ? r.teachers.map((t) => `<div>${esc(t.name)}${t.dept ? ` <span class="sch-sub">каф. ${esc(t.dept)}</span>` : ''}</div>`).join('')
        : dash;
      return '<tr>'
        + `<td class="c">${i + 1}</td>`
        + `<td class="c" title="${esc(r.isoDate || '')}">${esc(r.date) || dash}</td>`
        + `<td class="c">${esc(r.day) || dash}</td>`
        + `<td class="c">${rng ? esc(`${rng}${tm ? ' · ' + tm : ''}`) : dash}</td>`
        + `<td><span class="ex-mark ${r.kind === 'exam' ? 'exam' : 'zachet'}">${esc(vidFull(r))}</span></td>`
        + `<td><b>${esc(r.subject)}</b>${r.subjectFull && r.subjectFull !== r.subject ? `<div class="sch-sub">${esc(r.subjectFull)}</div>` : ''}</td>`
        + `<td>${r.rooms.length ? esc(r.rooms.join(', ')) : dash}</td>`
        + `<td>${teachers}</td>`
        + `<td>${r.stream.length ? esc(r.stream.join(', ')) : dash}</td>`
        + `<td class="c">${seats}</td>`
        + `<td class="c">${r.gapDays == null ? dash : r.gapDays}${prep}</td>`
        + `<td>${esc(r.note || '')}</td>`
        + '</tr>';
    }).join('');
    return `<div class="sch-group"><h3>Группа ${esc(g.group)}</h3>`
      + `<table class="ex sch"><thead><tr>${SCH_HEAD.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // ── Список экзаменов и зачётов (из учебных планов кафедр) ────────────────────
  const exState = { plans: null }; // { kaf → plan }

  async function loadPlans() {
    const { kafedras } = await api.get('/api/curriculum');
    const list = kafedras || [];
    const plans = {};
    for (const k of list) {
      try { plans[k.kafedra] = (await api.get('/api/curriculum/' + encodeURIComponent(k.kafedra))).plan; } catch { /* пропускаем */ }
    }
    exState.plans = plans;
    const sel = $('exKaf');
    sel.innerHTML = '<option value="">Все кафедры</option>'
      + Object.keys(plans).sort().map((k) => `<option value="${esc(k)}">Кафедра ${esc(k)}</option>`).join('');
    renderExams();
  }

  // Формы контроля дисциплины в заданном семестре.
  function formsInSem(d, sem) {
    const has = (a) => Array.isArray(a) && a.includes(sem);
    const exam = has(d.exams);
    const zg = has(d.zachetsGraded);
    const zu = has(d.zachetsUngraded);
    const course = !!(d.coursework && d.coursework.semester === sem);
    return { exam, zg, zu, course, any: exam || zg || zu || course };
  }

  // Дисциплина «есть в семестре»: ведётся (ауд. часы или самоподготовка) либо имеет
  // форму контроля в этом семестре.
  function inSem(d, sem) {
    const ps = d.perSemester && d.perSemester[sem - 1];
    return (ps && (ps.aud > 0 || ps.self > 0)) || formsInSem(d, sem).any;
  }

  function renderExams() {
    if (!exState.plans) { $('exGrid').innerHTML = '<div class="ses-empty">Загрузка учебных планов…</div>'; return; }
    const sem = Number($('exSem').value);
    const onlyKaf = $('exKaf').value;
    const kafs = Object.keys(exState.plans).sort().filter((k) => !onlyKaf || k === onlyKaf);
    if (!kafs.length) {
      $('exGrid').innerHTML = '<div class="ses-empty">Учебные планы не загружены. Загрузите их на странице «Проверить соответствие уч. плану».</div>';
      return;
    }

    const dash = '<span class="ex-dash">—</span>';
    let body = '';
    let total = 0;
    for (const kaf of kafs) {
      const plan = exState.plans[kaf];
      // Все предметы этого семестра, В ПОРЯДКЕ учебного плана (без пересортировки).
      // Практики (внизу плана) учитываем как дисциплины — у них тоже есть зачёт.
      const rows = (plan.disciplines || [])
        .filter((d) => (d.kind === 'discipline' || d.kind === 'practice') && inSem(d, sem))
        .map((d) => ({ d, f: formsInSem(d, sem) }));
      if (!rows.length) continue;
      total += rows.length;
      if (!onlyKaf) body += `<tr class="kaf-head"><td colspan="5">Кафедра ${esc(kaf)} — ${rows.length}</td></tr>`;
      for (const { d, f } of rows) {
        const zach = f.zg ? '<span class="ex-mark zachet">ЗО</span>' : f.zu ? '<span class="ex-mark zachet">Зачёт</span>' : dash;
        const course = f.course
          ? `<span class="ex-mark course">${d.coursework.kind === 'project' ? 'Курс. проект' : 'Курс. работа'}</span>`
          : dash;
        body += `<tr><td class="c">${esc(d.index || '')}</td><td>${esc(d.name || '')}</td>`
          + `<td class="c">${f.exam ? '<span class="ex-mark exam">Экзамен</span>' : dash}</td>`
          + `<td class="c">${zach}</td><td class="c">${course}</td></tr>`;
      }
    }

    if (!total) {
      $('exGrid').innerHTML = `<div class="ses-empty">В семестре ${sem} нет дисциплин${onlyKaf ? ` на кафедре ${onlyKaf}` : ''}.</div>`;
      return;
    }
    $('exGrid').innerHTML = '<table class="ex"><thead><tr>'
      + '<th>Индекс</th><th>Дисциплина</th><th>Экзамен</th><th>Зачёт</th><th>Курсовой</th>'
      + `</tr></thead><tbody>${body}</tbody></table>`;
  }

  async function loadData() {
    const data = await api.get('/api/session-calendar');
    state.data = data;
    index(data);
    $('from').value = data.from || '';
    $('to').value = data.to || '';
    buildCourseSelect(data);
    render();
  }

  function buildCourseSelect(data) {
    const sel = $('courseFilter');
    const courses = [...new Set(Object.values(data.groupCourse || {}))].sort((a, b) => a - b);
    sel.innerHTML = '<option value="0">Все курсы</option>'
      + courses.map((c) => `<option value="${c}">${c} курс</option>`).join('');
    state.courseFilter = 0;
  }

  function sortedGroups(data) {
    const gc = data.groupCourse || {}, gd = data.groupDept || {};
    let groups = data.groups.slice();
    if (state.courseFilter) groups = groups.filter((g) => gc[g] === state.courseFilter);
    if (state.sort === 'course') {
      groups.sort((a, b) => {
        const ca = gc[a] ?? 99, cb = gc[b] ?? 99;
        return ca !== cb ? ca - cb : a.localeCompare(b, 'ru', { numeric: true });
      });
    } else if (state.sort === 'dept') {
      groups.sort((a, b) => {
        const da = gd[a] || '￿', db = gd[b] || '￿';
        return da !== db ? da.localeCompare(db, 'ru') : a.localeCompare(b, 'ru', { numeric: true });
      });
    }
    return groups;
  }

  // Индекс «группа\nдата» → список форм контроля (сорт. по паре).
  function index(data) {
    const m = new Map();
    for (const l of data.lessons) {
      if (!l.isoDate) continue;
      for (const g of l.groups) {
        const key = g + '\n' + l.isoDate;
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(l);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.pairNo || 0) - (b.pairNo || 0));
    state.byCell = m;
    state.byId = new Map(data.lessons.map((l) => [l.id, l]));
  }

  // Перечень дат [from..to] включительно с подписями (дата + день недели + выходной).
  function dayColumns(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    const holidays = new Set(state.data.holidays || []);
    let d = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    let guard = 0;
    while (d <= end && guard++ < 400) {
      const iso = d.toISOString().slice(0, 10);
      const js = d.getUTCDay(); // 0=Вс…6=Сб
      out.push({
        iso,
        label: `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`,
        wd: DAYS[(js + 6) % 7],
        off: js === 0 || js === 6 || holidays.has(iso),
      });
      d = new Date(d.getTime() + 86400000);
    }
    return out;
  }

  function render() {
    const data = state.data;
    if (!data) return;
    const cols = dayColumns($('from').value, $('to').value);

    if (!data.from) {
      $('meta').textContent = '';
      $('grid').innerHTML = '<div class="ses-empty">В расписании нет сессионных занятий (экзаменов, зачётов, курсовых). Загрузите расписание и задайте активный семестр.</div>';
      return;
    }
    if (!cols.length) {
      $('grid').innerHTML = '<div class="ses-empty">Пустой диапазон дат: дата «по» должна быть не раньше «с».</div>';
      return;
    }

    const sem = data.semester;
    $('meta').textContent = `Групп: ${data.groups.length} · сессионных занятий: ${data.lessons.length}`
      + (sem && sem.name ? ` · семестр: ${sem.name}` : '');

    let head = '<thead><tr><th>Группа</th>';
    for (const c of cols) head += `<th class="${c.off ? 'off' : ''}">${esc(c.label)}<span class="wd">${esc(c.wd)}</span></th>`;
    head += '</tr></thead>';

    let body = '<tbody>';
    for (const g of sortedGroups(data)) {
      body += `<tr><th>${esc(g)}</th>`;
      for (const c of cols) {
        const arr = state.byCell.get(g + '\n' + c.iso);
        body += `<td class="${c.off ? 'off' : ''}" data-iso="${c.iso}">${arr ? arr.map(cell).join('') : ''}</td>`;
      }
      body += '</tr>';
    }
    body += '</tbody>';

    // Сохраняем позицию прокрутки сетки, чтобы перерисовка (в т.ч. после переноса)
    // не «прыгала» в начало.
    const prev = $('grid').querySelector('.ses-wrap');
    const sx = prev ? prev.scrollLeft : 0;
    const sy = prev ? prev.scrollTop : 0;
    $('grid').innerHTML = `<div class="ses-wrap"><table class="ses">${head}${body}</table></div>`;
    const wrap = $('grid').querySelector('.ses-wrap');
    if (wrap) { wrap.scrollLeft = sx; wrap.scrollTop = sy; }
  }

  // Диапазон пар: «1» или «1–3».
  function pairRange(l) {
    const a = l.pairFrom || l.pairNo, b = l.pairTo || l.pairNo;
    if (!a) return '';
    return a === b ? String(a) : `${a}–${b}`;
  }
  // Время от начала первой до конца последней пары: «9:00–14:25».
  function pairTime(l) {
    const a = l.pairFrom || l.pairNo, b = l.pairTo || l.pairNo;
    const s = PAIR_TIMES[a], e = PAIR_TIMES[b];
    if (!s || !e) return '';
    return `${s.start}–${e.end}`.replace(/\./g, ':');
  }

  // Карточка формы контроля: вид · пары/время · дисциплина · аудитория · преподаватели.
  function cell(l) {
    const rooms = (l.rooms || []).join(', ');
    const teachers = (l.teachers || []).join(', ');
    const bad = l.prep && !l.prep.ok;
    const rng = pairRange(l), tm = pairTime(l);
    const pairLine = rng ? `пары ${rng}${tm ? ' · ' + tm : ''}` : '';
    return `<div class="ses-a ${l.kind}${bad ? ' prep-bad' : ''}" data-id="${l.id}" draggable="true">`
      + `<div class="v">${bad ? '⚠ ' : ''}${esc(vidLabel(l))}</div>`
      + (pairLine ? `<div class="p">${esc(pairLine)}</div>` : '')
      + `<div class="d" title="${esc(l.subjectFull || '')}">${esc(l.subject)}</div>`
      + `<div class="r" title="${esc(rooms)}">${esc(rooms || '—')}</div>`
      + `<div class="t" title="${esc(teachers)}">${esc(teachers || '—')}</div>`
      + '</div>';
  }

  // Полное название вида: Экзамен / Зачёт с оценкой / Зачёт.
  function vidFull(l) {
    if (l.kind === 'exam') return 'Экзамен';
    const t = String(l.type || '').toLowerCase().replace(/[.\s]+$/, '');
    return t === 'зо' || t === 'з/о' ? 'Зачёт с оценкой' : 'Зачёт';
  }

  // Всплывающее окно со всей подробной информацией о форме контроля.
  function openPop(l) {
    const rng = pairRange(l), tm = pairTime(l);
    const rows = [
      ['Вид', vidFull(l)],
      ['Дисциплина', `${esc(l.subjectFull || l.subject)}${l.subjectFull && l.subject && l.subjectFull !== l.subject ? ` (${esc(l.subject)})` : ''}`],
      ['Дата', `${esc(l.date || '')}${l.day ? ', ' + esc(l.day) : ''}`],
      ['Пары', rng ? `${esc(rng)}${tm ? ' (' + esc(tm) + ')' : ''}` : '—'],
      ['Аудитория', esc((l.rooms || []).join(', ') || '—')],
      ['Преподаватели', esc((l.teachers || []).join(', ') || '—')],
      ['Группы', esc((l.groups || []).join(', ') || '—')],
    ];
    if (l.kind === 'exam' && l.prep) {
      if (l.prep.ok) {
        rows.push(['Подготовка', '3 дня перед экзаменом свободны ✓']);
      } else {
        const txt = l.prep.conflicts
          .map((c) => `${esc(c.date)} (${esc(c.group)}): ${c.items.map((i) => esc(i.subject)).join(', ')}`)
          .join('; ');
        rows.push(['⚠ Подготовка', `Нет 3 свободных дней до экзамена. Заняты: ${txt}`]);
      }
    }
    const hint = (l.kind === 'exam' || l.kind === 'zachet')
      ? `<p class="ses-sub" style="margin-top:12px">Перенос: закройте окно и перетащите карточку на подходящий день — допустимые подсветятся пунктиром. ${l.kind === 'exam' ? 'Экзамен — только день с полным ЭкзС и 3 днями на подготовку.' : 'Зачёт — день со свободными парами.'}</p>`
      : '';
    $('pop').innerHTML = '<div class="ses-pop-box">'
      + '<button class="ses-pop-x" data-close="1" aria-label="Закрыть">×</button>'
      + `<h3>${vidFull(l)}: ${esc(l.subject)}</h3>`
      + '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>'
      + hint
      + '</div>';
    $('pop').hidden = false;
  }

  // ── Перенос перетягиванием ────────────────────────────────────────────────
  function onDragStart(e) {
    const a = e.target.closest('.ses-a');
    if (!a) return;
    const id = Number(a.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id)); // нужно для Firefox
    a.classList.add('dragging');
    state.drag = { id, targets: null };
    // Подсветить допустимые дни (зависит от вида: ЭкзС+подготовка / свободные пары).
    api.get('/api/session-exam-targets?lessonId=' + id).then((r) => {
      if (!state.drag || state.drag.id !== id) return;
      state.drag.targets = r.targets || [];
      const valid = new Set(state.drag.targets.map((t) => t.isoDate));
      $('grid').querySelectorAll('td[data-iso]').forEach((td) => td.classList.toggle('drop-ok', valid.has(td.dataset.iso)));
    }).catch(() => {});
  }

  function onDragOver(e) {
    if (state.drag && e.target.closest('td')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  }

  function onDrop(e) {
    const td = e.target.closest('td');
    if (!state.drag || !td) return;
    e.preventDefault();
    const { id, targets } = state.drag;
    const iso = td.dataset.iso;
    clearDrag();
    if (!targets) return toast('Допустимые дни ещё загружаются — повторите перенос', true);
    const t = targets.find((x) => x.isoDate === iso);
    if (!t) return toast('Сюда перенести нельзя', true);
    doMove(id, t.weekNo, t.day);
  }

  function onDragEnd() { clearDrag(); }

  function clearDrag() {
    const g = $('grid');
    g.querySelectorAll('.drop-ok').forEach((td) => td.classList.remove('drop-ok'));
    const a = g.querySelector('.ses-a.dragging');
    if (a) a.classList.remove('dragging');
    state.drag = null;
  }

  // Выполнить перенос формы контроля в выбранный день и перерисовать календарь.
  async function doMove(id, weekNo, day) {
    try {
      const r = await api.post('/api/session-move-exam', { lessonId: id, weekNo, day });
      closePop();
      await loadData();
      toast(`Перенесено${r.date ? ' на ' + r.date : ''}. Отменить — кнопкой «Отменить» в админке.`);
    } catch (err) { toast(err.message, true); }
  }

  function closePop() { $('pop').hidden = true; }

  function pad(n) { return String(n).padStart(2, '0'); }
})();
