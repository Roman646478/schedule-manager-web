// Страница «Учебные планы»: разбор xlsx в браузере (curriculum-parser.js + SheetJS),
// ручное сопоставление дисциплин с предметами расписания и сверка по группе.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = (msg, bad) => {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' error' : '');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  };

  const SEM_TYPES = [
    ['lectures', 'Лек'], ['seminars', 'Сем'], ['labs', 'Лаб'], ['practicals', 'Практ'],
    ['groupExercises', 'Гр.упр'], ['groupClasses', 'Гр.зан'], ['tactical', 'Такт'],
    ['kshu', 'КШУ'], ['conferences', 'Конф'], ['control', 'Контр'],
    ['consultations', 'Конс'], ['coursework', 'Курс'], ['other', 'Др'],
  ];

  const SC = window.SCHED_CONST;
  const state = { subjects: [], groups: [], courses: {}, plan: null, kaf: '', mapping: {} };

  const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
  const kafOfGroup = (g) => (g && g[0] && g[2] ? g[0] + g[2] : '');

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const { authenticated } = await api.get('/api/auth/check');
      if (!authenticated) return (location.href = '/login.html');
    } catch { return (location.href = '/login.html'); }

    $('btnLogout').onclick = async () => { await api.post('/api/logout'); location.href = '/login.html'; };
    $('fileInput').onchange = onFile;
    $('btnSavePlan').onclick = savePlan;
    $('btnSaveMap').onclick = saveMapping;
    $('btnCheck').onclick = runCheck;
    if ($('btnCheckAll')) $('btnCheckAll').onclick = runCheckAll;
    $('kafSel').onchange = () => loadKafedra($('kafSel').value);

    try {
      const [subj, ent, list, crs] = await Promise.all([
        api.get('/api/subjects'), api.get('/api/entities'), api.get('/api/curriculum'),
        api.get('/api/courses').catch(() => ({})), // курсы не заданы — список групп плоский
      ]);
      state.subjects = subj.subjects || subj || [];
      state.groups = (ent.groups || []);
      state.courses = (crs && crs.courses) || {};
      fillKafSel(list.kafedras || []);
    } catch (err) { toast(err.message, true); }
  }

  function fillKafSel(kafedras) {
    const sel = $('kafSel');
    sel.innerHTML = '<option value="">— нет —</option>' +
      kafedras.map((k) => `<option value="${esc(k.kafedra)}">Кафедра ${esc(k.kafedra)} (${k.disciplines} дисц.${k.fileName ? ', ' + esc(k.fileName) : ''})</option>`).join('');
  }

  // ── Загрузка/разбор xlsx ──────────────────────────────────────────────
  async function onFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
      state.plan = parseCurriculum(aoa, f.name);
      state.kaf = state.plan.kafedra;
      state.mapping = {};
      $('btnSavePlan').disabled = false;
      renderPlan();
      renderMapping();
      $('mapSection').style.display = '';
      toast('План разобран. Проверьте и сохраните.');
    } catch (err) { toast('Ошибка разбора: ' + err.message, true); }
    e.target.value = '';
  }

  async function savePlan() {
    if (!state.plan) return;
    try {
      await api.post('/api/curriculum', { kafedra: state.kaf, plan: state.plan });
      toast('План сохранён (кафедра ' + state.kaf + ')');
      const list = await api.get('/api/curriculum');
      fillKafSel(list.kafedras || []);
      $('kafSel').value = state.kaf;
      fillGroupSel();
      $('checkSection').style.display = '';
    } catch (err) { toast(err.message, true); }
  }

  async function loadKafedra(kaf) {
    if (!kaf) { $('mapSection').style.display = 'none'; $('checkSection').style.display = 'none'; return; }
    try {
      const { plan, mapping } = await api.get('/api/curriculum/' + encodeURIComponent(kaf));
      state.plan = plan; state.kaf = kaf; state.mapping = mapping || {};
      $('btnSavePlan').disabled = true;
      renderPlan(); renderMapping(); fillGroupSel();
      $('mapSection').style.display = ''; $('checkSection').style.display = '';
    } catch (err) { toast(err.message, true); }
  }

  // ── Рендер плана ───────────────────────────────────────────────────────
  function renderPlan() {
    const res = state.plan;
    $('planMeta').textContent = `Кафедра ${res.kafedra} · дисциплин/практик: ${res.disciplines.length}` + (res.fileName ? ` · ${res.fileName}` : '');
    $('planWarn').innerHTML = res.warnings && res.warnings.length
      ? `<div class="cur-warn"><b>Предупреждения (${res.warnings.length}):</b><ul>${res.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
      : '<div class="cur-ok">Разбор сошёлся со сводкой плана.</div>';

    const semHdr = Array.from({ length: 10 }, (_, i) => `<th title="ауд. часы">${i + 1}с</th>`).join('');
    const typeHdr = SEM_TYPES.map(([, l]) => `<th>${l}</th>`).join('');
    let cyc = null;
    const cell = (n) => (n ? esc(n) : '');
    const rows = res.disciplines.map((d) => {
      let pre = '';
      if (d.cycle !== cyc) { cyc = d.cycle; pre = `<tr class="cyc"><td colspan="31">${esc(cyc || '—')}</td></tr>`; }
      let cw = '';
      if (d.coursework) {
        const proj = d.coursework.kind === 'project';
        cw = ` <span class="cw" title="${proj ? 'курсовой проект' : 'курсовая работа, ' + d.coursework.hours + ' ч'}">${proj ? 'КП' : 'КР'}${d.coursework.semester ? ' с' + d.coursework.semester : ''}</span>`;
      }
      const types = SEM_TYPES.map(([k]) => `<td class="num">${cell(d.byType[k])}</td>`).join('');
      const sems = d.perSemester.map((s) => `<td class="num" title="самост. ${s.self}${s.weeks ? ', недель ' + s.weeks : ''}">${cell(s.aud)}</td>`).join('');
      return pre + `<tr${d.kind === 'practice' ? ' class="prac"' : ''}>
        <td>${esc(d.index || '·')}</td><td class="nm">${esc(d.name)}${cw}</td>
        <td class="num">${cell(d.ze.mandatory || d.ze.variable)}</td>
        <td class="num">${cell(d.totalHours)}</td><td class="num">${cell(d.audTotal)}</td>
        ${types}${sems}
        <td>${d.exams.join(',')}</td><td>${d.zachetsGraded.join(',')}</td><td>${d.zachetsUngraded.join(',')}</td></tr>`;
    }).join('');

    $('planTable').innerHTML = `<div class="cur-tbl"><table class="cur">
      <thead>
        <tr><th>Индекс</th><th>Дисциплина</th><th>з.е.</th><th>Всего</th><th>Ауд</th>
            <th colspan="13">Виды (всего по дисциплине)</th><th colspan="10">Ауд. часы по семестрам</th>
            <th>Экз</th><th>Зач.о</th><th>Зач.б</th></tr>
        <tr><th></th><th></th><th></th><th></th><th></th>${typeHdr}${semHdr}<th></th><th></th><th></th></tr>
      </thead><tbody>${rows}</tbody></table></div>`;
  }

  // ── Сопоставление ──────────────────────────────────────────────────────
  // Простая оценка близости: доля совпавших токенов имени плана среди токенов
  // полного имени предмета (учитывает разный порядок слов; сокращения не ловит).
  function bestSubject(name) {
    const want = new Set(normName(name).split(' ').filter((w) => w.length > 2));
    if (!want.size) return '';
    let best = '', bestScore = 0;
    for (const s of state.subjects) {
      const have = new Set(normName(s.fullName || '').split(' ').filter((w) => w.length > 2));
      if (!have.size) continue;
      let hit = 0;
      for (const w of want) if (have.has(w)) hit++;
      const score = hit / want.size;
      if (score > bestScore) { bestScore = score; best = s.abbr; }
    }
    return bestScore >= 0.5 ? best : '';
  }

  function renderMapping() {
    const disc = state.plan.disciplines.filter((d) => d.kind === 'discipline');
    const opts = (sel) => '<option value="">—</option>' +
      state.subjects.map((s) => `<option value="${esc(s.abbr)}"${s.abbr === sel ? ' selected' : ''}>${esc(s.abbr)} — ${esc(s.fullName || '')}</option>`).join('');
    const rows = disc.map((d) => {
      const cur = state.mapping[d.name];
      const auto = cur == null ? bestSubject(d.name) : '';
      const val = cur != null ? cur : auto;
      return `<tr>
        <td>${esc(d.index || '')}</td>
        <td class="nm">${esc(d.name)}</td>
        <td><select data-name="${esc(d.name)}">${opts(val)}</select>${auto && cur == null ? ' <span class="map-auto">авто</span>' : ''}</td>
      </tr>`;
    }).join('');
    $('mapTable').innerHTML = `<table class="cur map-tbl"><thead><tr><th>Индекс</th><th>Дисциплина плана</th><th>Предмет расписания (аббр. — полное)</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function saveMapping() {
    // Сохраняем только явные привязки; не выбранные дисциплины авто-сопоставляются
    // фаззи при проверке (поэтому пустые в маппинг не пишем).
    const map = {};
    for (const sel of $('mapTable').querySelectorAll('select[data-name]')) {
      if (sel.value) map[sel.getAttribute('data-name')] = sel.value;
    }
    try {
      await api.put('/api/curriculum/' + encodeURIComponent(state.kaf) + '/mapping', { mapping: map });
      state.mapping = map;
      toast('Сопоставление сохранено');
    } catch (err) { toast(err.message, true); }
  }

  // ── Проверка ───────────────────────────────────────────────────────────
  function fillGroupSel() {
    const groups = state.groups.filter((g) => kafOfGroup(g) === state.kaf);
    // Группы разложены по курсам (<optgroup>), как во всех списках групп.
    $('groupSel').innerHTML = SC.courseOptionsHtml(
      groups.length ? groups : state.groups,
      state.courses,
      (g) => `<option value="${esc(g)}">${esc(g)}</option>`
    );
  }

  async function runCheck() {
    const group = $('groupSel').value;
    if (!group) return;
    try {
      const r = await api.get('/api/curriculum/check?group=' + encodeURIComponent(group));
      $('checkMeta').textContent = '';
      $('checkTable').innerHTML = renderCheck(r);
    } catch (err) {
      $('checkMeta').textContent = '';
      $('checkTable').innerHTML = `<div class="cur-warn">${esc(err.message)}</div>`;
    }
  }

  async function runCheckAll() {
    const groups = Array.from($('groupSel').options).map(o => o.value).filter(Boolean);
    if (!groups.length) return;
    $('checkMeta').textContent = 'Проверка всех доступных групп...';
    $('checkTable').innerHTML = '';
    let html = '';
    for (const group of groups) {
      try {
        const r = await api.get('/api/curriculum/check?group=' + encodeURIComponent(group));
        html += renderCheck(r) + '<br><br>';
      } catch (err) {
        html += `<div style="font-weight:600; margin-bottom:8px;">Группа ${esc(group)}</div><div class="cur-warn">${esc(err.message)}</div><br><br>`;
      }
    }
    $('checkMeta').textContent = `Проверено групп: ${groups.length}`;
    $('checkTable').innerHTML = html;
  }

  function renderCheck(r) {
    const meta = `<div style="font-weight:600; margin-bottom:8px;">Группа ${esc(r.group)} · курс ${r.course} · ${r.season} → семестр плана ${r.planSem}</div>`;
    const flag = (b) => (b ? 'да' : '·');
    const cls = (row) => (row.ok ? 'st-ok' : (row.status.includes('нет в расписании') || row.status.includes('не сопоставлено') ? 'st-bad' : 'st-warn'));
    const rows = r.rows.map((row) => `<tr>
      <td>${esc(row.index || '')}</td><td class="nm">${esc(row.name)}</td>
      <td>${esc(row.abbr || '—')}${row.auto ? ' <span class="map-auto">авто</span>' : ''}</td>
      <td class="num">${row.planHours}/${row.factHours}</td>
      <td>${flag(row.expExam)}</td><td>${flag(row.expZach)}</td>
      <td class="${cls(row)}">${esc(row.status)}</td></tr>`).join('');
    const extra = r.extra.length
      ? `<p class="cur-sub" style="margin-top:12px">В расписании, но не в плане семестра:</p><table class="cur"><thead><tr><th>Аббр.</th><th>Полное</th><th>Часы</th><th>Виды</th></tr></thead><tbody>${
        r.extra.map((e) => `<tr><td>${esc(e.abbr)}</td><td class="nm">${esc(e.full)}</td><td class="num">${e.factHours}</td><td>${esc(e.types.join(','))}</td></tr>`).join('')}</tbody></table>`
      : '';
    return meta + `<div class="cur-tbl"><table class="cur">
      <thead><tr><th>Индекс</th><th>Дисциплина</th><th>Предмет</th><th>Часы пл/факт</th><th>Экз</th><th>Зач</th><th>Статус</th></tr></thead>
      <tbody>${rows}</tbody></table></div>${extra}`;
  }
})();
