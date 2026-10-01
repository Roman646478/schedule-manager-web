// Гостевой просмотр опубликованного расписания (read-only) из public_db.json.
(function () {
  'use strict';

  // Доменные константы — из общего модуля /js/shared-constants.js.
  const SC = window.SCHED_CONST;
  const DAYS = SC.DAYS.slice(0, 6); // в сетке — Пн..Сб
  const PAIRS = Array.from({ length: SC.PAIRS_PER_DAY }, (_, i) => i + 1);
  const PAIR_TIMES = Object.fromEntries(
    Object.entries(SC.PAIR_TIMES).map(([p, t]) => [p, `${t.start}–${t.end}`])
  );
  const KIND_LABEL = { group: 'Группа', teacher: 'Преподаватель', room: 'Аудитория', subject: 'Дисциплина', dept: 'Кафедра' };
  // Преподаватели без заданной кафедры собираются в отдельный псевдо-пункт
  // списка: иначе их расписания не видно ни на одной кафедре.
  const NO_DEPT = '(без кафедры)';

  const state = {
    db: null, kind: 'group', entityId: null, week: 1, mode: 'week',
    // Вид «Кафедра»: строками идут преподаватели ('teacher') или аудитории ('room').
    deptKind: 'teacher',
    // Вид «День» — то же сводное, но за один день; по умолчанию сегодняшний.
    day: null,
    hl: { kind: '', value: '' },
    // Вид «Дисциплина»: выбранные галочками группы (Set) и полный их список.
    // null = «все» — пока список ещё не построен по занятиям дисциплины.
    subjGroups: null, subjAllGroups: [],
    canEdit: false, // тумблер «правка темы, примечания и вида занятия» из настроек админки
    canExport: false, // тумблер «гости скачивают расписание в Excel»
    canMoves: false, // тумблер «гости видят свободные окна для переноса»
    canColors: true, // тумблер «разные цвета занятий» (по дисциплине/группе)
    canMoveMarks: true, // тумблер «помечать перенесённые занятия» (общий с админкой)
    // Сводное: скрытые курсы (ключ — номер курса строкой, '' — курс не задан)
    // и показ преподавателя в карточке. Выбор личный, живёт в этом браузере.
    sumHiddenCourses: new Set(),
    sumTeacher: true,
  };
  // Виджет на рабочем столе открывает эту же страницу ссылкой с параметрами:
  // ?widget=1&mode=summary|week|month|semester&kind=teacher&e=Иванов&week=cur|N
  const Q = new URLSearchParams(location.search);

  // «Месяц» — та же семестровая таблица, но столбцов ровно четыре, начиная с
  // открытой недели (окно упирается в конец семестра).
  const MONTH_WEEKS = 4;

  // Заголовок окна-виджета: по нему сторож находит своё окно, и через него же
  // страница подаёт ему команду «закрепить» (суффикс #lock).
  const WIDGET_TITLE = 'Расписание — виджет';
  // Виджет-программа (native/WidgetHost.cs) открывает эту же страницу в своём
  // окне. Отличать её просто: у браузерного варианта канала chrome.webview нет.
  // В программе метка в заголовке окна больше не нужна — есть нормальный
  // двусторонний канал, а фон может быть по-настоящему полупрозрачным.
  const HOST = !!(window.chrome && window.chrome.webview);
  const toHost = (cmd) => { if (HOST) window.chrome.webview.postMessage(cmd); };

  const $ = (id) => document.getElementById(id);
  // Сводные виды: вся неделя и один день — данные и элементы управления общие.
  const isSummary = () => state.mode === 'summary' || (state.mode === 'day' && !deptRows('room-matrix'));
  // Открыт ли вид «Кафедра» со строками-преподавателями ('teacher') или
  // строками-аудиториями ('room').
  const deptRows = (what) => state.kind === 'dept' && state.deptKind === what;
  const TT = window.TeacherTables;
  let toastTimer = null;

  function toast(msg, isError) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 8000);
  }

  // Дата (дд.мм) для недели weekNo и смещения дня от понедельника (0=Пн … 6=Вс).
  function weekDate(weekNo, offset) {
    const sem = state.db && state.db.semester;
    if (!sem || !sem.start || !weekNo) return null;
    const d = new Date(sem.start + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow + (weekNo - 1) * 7 + offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`;
  }

  function dateOf(weekNo, day) {
    const idx = DAYS.indexOf(day);
    return idx < 0 ? null : weekDate(weekNo, idx);
  }

  // ISO-дата (ГГГГ-ММ-ДД) для (неделя, день) — для сверки с нерабочими днями.
  function isoDate(weekNo, offset) {
    const sem = state.db && state.db.semester;
    if (!sem || !sem.start || !weekNo) return null;
    const d = new Date(sem.start + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow + (weekNo - 1) * 7 + offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  // Нерабочий ли день (weekNo, day) по опубликованному списку holidays.
  function isHolidayDay(weekNo, day) {
    const hols = (state.db && state.db.holidays) || [];
    if (!hols.length) return false;
    const idx = DAYS.indexOf(day);
    const iso = idx < 0 ? null : isoDate(weekNo, idx);
    return !!iso && hols.includes(iso);
  }

  // Подпись недели с диапазоном дат: «Неделя 1 (01.09–07.09)».
  function weekLabel(n) {
    const a = weekDate(n, 0);
    const b = weekDate(n, 6);
    return a && b ? `Неделя ${n} (${a}–${b})` : `Неделя ${n}`;
  }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const res = await fetch('/public_db.json', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state.db = await res.json();
      buildMovedIndex(); // пометки переносов: журнал приходит в снимке
    } catch {
      $('guestRoot').innerHTML = '<p class="file-status">Расписание ещё не опубликовано.</p>';
      return;
    }
    // Правка темы/примечания и выгрузка в Excel открыты только тумблерами админки;
    // недоступный эндпоинт (старый сервер) — просто режим «только чтение».
    const flag = async (url, dflt = false) => {
      try {
        return Boolean((await api.get(url)).enabled);
      } catch {
        return dflt;
      }
    };
    state.canEdit = await flag('/api/guest-edit');
    state.canExport = await flag('/api/guest-export');
    state.canMoves = await flag('/api/guest-moves');
    // Цвета — оформление, а не доступ к данным: старый сервер без эндпоинта
    // оставляет их включёнными.
    state.canColors = await flag('/api/guest-colors', true);
    // Пометка переносов — та же настройка, что в админке (одна на всех).
    state.canMoveMarks = await flag('/api/move-marks', true);
    // Тумблер цветов для посетителя: виден, только если цвета разрешены админкой.
    // Выбор личный — храним в localStorage этого браузера, на сервер не ходим.
    if (state.canColors) {
      const box = $('tintToggle');
      $('tintWrap').hidden = false;
      box.checked = localStorage.getItem('guestTints') !== '0';
      state.canColors = box.checked;
      box.onchange = () => {
        state.canColors = box.checked;
        localStorage.setItem('guestTints', box.checked ? '1' : '0');
        render();
      };
    }
    $('btnGuestExport').onclick = downloadSchedule;
    bindSummaryControls();
    $('weekSelect').innerHTML = Array.from({ length: semesterWeeks() }, (_, i) => `<option value="${i + 1}">${esc(weekLabel(i + 1))}</option>`).join('');
    $('viewKind').onchange = (e) => {
      state.kind = e.target.value;
      fillEntities();
      syncDeptModes();
      // «Кафедра» живёт только в недельном виде — с месяца и семестра уводим сами.
      if (state.kind === 'dept' && (state.mode === 'month' || state.mode === 'semester')) {
        document.querySelector('.view-modes [data-mode="week"]').click(); // click уже перерисует
        return;
      }
      render();
    };
    $('deptKind').onchange = (e) => { state.deptKind = e.target.value; fillEntities(); render(); };
    $('entitySelect').onchange = (e) => {
      state.entityId = e.target.value;
      state.subjGroups = null;
      render();
    };
    $('weekSelect').onchange = (e) => { state.week = Number(e.target.value); render(); };
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = (event) => {
        document.querySelectorAll('[data-mode]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.mode = b.dataset.mode;
        // «День» всегда открывается на сегодня: виджету на столе нужен именно
        // текущий день, а не тот, где человек остановился неделю назад.
        if (state.mode === 'day') {
          state.day = todayDay();
          state.week = currentWeek();
          $('weekSelect').value = String(state.week);
        } else if (event.isTrusted && ['week', 'month', 'summary'].includes(state.mode)) {
          state.week = currentWeek();
          $('weekSelect').value = String(state.week);
        }
        // Сводный вид — за неделю (выбор недели нужен), но без выбора группы/преподавателя.
        $('weekSelect').disabled = state.mode === 'semester';
        $('viewKind').disabled = isSummary();
        $('entitySelect').disabled = isSummary();
        syncSummaryControls();
        render();
      };
    });
    // Горячие клавиши ← / →: семестровый вид — листать объект (группа/препод./
    // аудитория), недельный и сводный — учебные недели.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (document.querySelector('.modal-backdrop.open')) return;
      const t = e.target;
      if (t && (t.matches('input, select, textarea') || t.isContentEditable)) return;
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      if (state.mode === 'semester') { e.preventDefault(); stepEntity(delta); }
      else if (state.mode !== 'semester') { e.preventDefault(); stepWeek(delta); }
    });
    $('hlKind').onchange = (e) => {
      state.hl.kind = e.target.value;
      state.hl.value = '';
      $('hlValue').disabled = !e.target.value;
      fillHlValues();
      applyHighlights();
    };
    $('hlValue').onchange = (e) => {
      state.hl.value = e.target.value;
      applyHighlights();
    };
    $('hlReset').onclick = () => {
      state.hl = { kind: '', value: '' };
      $('hlKind').value = '';
      $('hlValue').disabled = true;
      fillHlValues();
      applyHighlights();
    };
    bindSubjGroups();
    setupLessonDetails();
    applyUrlParams();
    fillEntities();
    applyUrlEntity();
    syncDeptModes();
    render();
  }

  // Вид, неделя и оформление из ссылки. До fillEntities: она строит список
  // объектов уже по выбранному виду.
  function applyUrlParams() {
    if (Q.get('widget') === '1') {
      document.body.classList.add('widget');
      document.body.classList.toggle('widget-host', HOST);
      // Заголовок окна — по нему скрипт виджета находит своё окно среди
      // остальных окон браузера, чтобы прибить вниз именно его.
      document.title = WIDGET_TITLE;
      bindWidgetToggle();
      bindWidgetZoom();
      if (HOST) bindWidgetHandles();
      if (HOST) dropifySelects(['viewKind', 'deptKind', 'entitySelect', 'weekSelect']);
    }
    const kind = Q.get('kind');
    if (KIND_LABEL[kind]) { state.kind = kind; $('viewKind').value = kind; }
    // Что показать по кафедре: преподавателей или аудитории.
    const dk = Q.get('dk');
    if (dk === 'teacher' || dk === 'room' || dk === 'room-matrix') { state.deptKind = dk; $('deptKind').value = dk; }
    const raw = Q.get('week');
    const want = raw == null || raw === 'cur' ? currentWeek() : Number(raw);
    if (want) state.week = Math.min(semesterWeeks(), Math.max(1, want));
    $('weekSelect').value = String(state.week);
    // Вкладку режима жмём кликом: у обработчика уже есть вся обвязка
    // (активность вкладки, доступность селектов, фильтры сводного).
    const tab = document.querySelector(`.view-modes [data-mode="${CSS.escape(Q.get('mode') || '')}"]`);
    if (tab) tab.click();
  }

  // Масштаб окна-виджета: кнопками A−/A+, запоминается в этом браузере.
  // Окно у виджета маленькое и без адресной строки, штатный Ctrl+«+» там
  // неудобен, а сводное расписание без масштаба просто не читается.
  const ZOOM_STEPS = [50, 60, 70, 80, 90, 100, 110, 125, 150];

  function bindWidgetZoom() {
    let z = Number(localStorage.getItem('widgetZoom')) || 100;
    const apply = () => {
      // Масштабируем содержимое, а не всю страницу: zoom на body утаскивает
      // за собой и кнопки виджета, приклеенные к углу окна.
      const main = document.querySelector('.main');
      main.style.zoom = z / 100;
      // zoom ужимает и высоту тоже: 100vh внутри масштаба даёт z% окна, и
      // снизу остаётся полоса пустого стекла. Компенсируем обратным множителем.
      main.style.height = `${100 / (z / 100)}vh`;
      $('wzVal').textContent = `${z}%`;
      localStorage.setItem('widgetZoom', String(z));
    };
    const step = (d) => {
      const i = ZOOM_STEPS.indexOf(z);
      z = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.indexOf(100) : i) + d))];
      apply();
    };
    $('widgetTools').hidden = false;
    $('wzOut').onclick = () => step(-1);
    $('wzIn').onclick = () => step(1);
    $('wzReload').onclick = () => location.reload();
    // Виджет висит на столе сутками, а данные он берёт из снимка публикации
    // один раз при открытии. Раз в час перечитываем — чаще незачем: расписание
    // меняют не поминутно, а перезагрузка на секунду гасит сетку.
    setInterval(() => location.reload(), 60 * 60 * 1000);
    apply();
  }

  // Сквозной режим: окно перестаёт ловить мышь, клики уходят рабочему столу и
  // окнам под виджетом. Страница этого сделать не может: в программе мышь
  // снимает само окно (native/WidgetHost.cs), в браузерном виджете — сторож
  // (scripts/widget-window.ps1), которому метка #ghost в заголовке окна
  // единственный канал: он читает заголовок раз в 120 мс.
  // Плотность стекла сюда больше не входит: она зафиксирована в самом стороже
  // ($WIDGET_ALPHA), ползунка нет — вид виджета всегда одинаковый.
  const widgetState = { ghost: false };

  function pushWidgetState() {
    if (HOST) { toHost(`ghost:${widgetState.ghost ? 1 : 0}`); return; }
    document.title = `${WIDGET_TITLE}${widgetState.ghost ? ' #ghost' : ''}`;
  }

  // В программе движок рисует в визуал, и всплывающие окна ему рисовать негде:
  // нативный список <select> просто не раскрывается. Поэтому в режиме программы
  // каждый список подменяем своим — на <details>, как фильтр групп. Сам <select>
  // остаётся источником данных и получателем change: вся остальная логика
  // страницы (в т.ч. её перестройка при смене вида) работает как раньше.
  const dropSyncs = [];

  function dropifySelects(ids) {
    for (const id of ids) {
      const sel = $(id);
      if (!sel) continue;
      const drop = document.createElement('details');
      drop.className = 'wz-drop';
      const head = document.createElement('summary');
      head.className = 'btn secondary sm';
      const list = document.createElement('div');
      list.className = 'wz-drop-list';
      drop.append(head, list);
      sel.after(drop);
      const sync = () => {
        const opt = sel.options[sel.selectedIndex];
        head.textContent = opt ? opt.textContent : '—';
        drop.hidden = sel.hidden;
      };
      drop.ontoggle = () => {
        if (!drop.open) return;
        list.innerHTML = '';
        for (const opt of sel.options) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `wz-drop-item${opt.selected ? ' on' : ''}`;
          item.textContent = opt.textContent;
          item.onclick = () => {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            drop.open = false;
            sync();
          };
          list.append(item);
        }
      };
      sel.addEventListener('change', sync);
      // Список пересобирают при смене вида, а прятать/показывать могут атрибутом
      // hidden (так работает выбор строк кафедры) — следим за обоими.
      new MutationObserver(sync).observe(sel, { childList: true, attributes: true, attributeFilter: ['hidden'] });
      dropSyncs.push(sync);
      sync();
    }
  }

  // Фон виджета. В программе это матовое стекло: окно просит систему размыть
  // то, что под ним, и подкрасить выбранным цветом — плотность задаёт ползунок.
  // В браузерном виджете стекла нет: окно объявляет прозрачным ровно цвет-ключ
  // из styles.css (#010203), поэтому «сквозной» = убрать инлайновый фон, а
  // «цветной» = любой другой цвет, и окно в этом месте становится плотным.
  // Цвет берут палитрой ОС (<input type="color">) или пипеткой с экрана
  // (EyeDropper — нативный API браузера, никаких библиотек).
  // Заливки фона на выбор — вместо палитры ОС, которая в программе не
  // открывается. Тёмные намеренно: виджет лежит на обоях, и светлая плашка
  // на них смотрится тяжелее.
  const WIDGET_BG_COLORS = ['#101418', '#1b2430', '#232323', '#2a1f2e', '#12281f', '#3a2a1a', '#6b7280', '#ffffff'];

  function bindWidgetBg() {
    const chk = $('wzBgOn');
    const col = $('wzBgColor');
    const sld = $('wzBgAlpha');
    const pal = $('wzBgPalette');
    let on = localStorage.getItem('widgetBgOn') === '1';
    let color = localStorage.getItem('widgetBgColor') || '#101418';
    let alpha = Number(localStorage.getItem('widgetBgAlpha'));
    if (!Number.isFinite(alpha) || alpha < 10) alpha = 100;
    const apply = () => {
      chk.checked = on;
      col.value = color;
      sld.value = String(alpha);
      pal.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === color));
      $('wzBgAlphaVal').textContent = `${alpha}%`;
      // В программе фон рисует само окно — матовым стеклом: система размывает
      // обои под виджетом и подмешивает выбранный цвет, ползунок задаёт его
      // плотность. Страница так не умеет: за её пикселями ничего нет, и
      // полупрозрачная заливка просто показывала бы обои как есть, резкими.
      // В браузере стекла нет — там прозрачен ровно цвет-ключ, и фон сплошной.
      if (HOST) toHost(on ? `bg:${color}:${alpha}` : 'bg:off');
      else document.body.style.background = on ? color : '';
      localStorage.setItem('widgetBgOn', on ? '1' : '0');
      localStorage.setItem('widgetBgColor', color);
      localStorage.setItem('widgetBgAlpha', String(alpha));
    };
    pal.innerHTML = WIDGET_BG_COLORS
      .map((c) => `<button class="wz-swatch" type="button" data-c="${c}" style="background:${c}" title="Заливка ${c}"></button>`)
      .join('');
    pal.querySelectorAll('[data-c]').forEach((b) => {
      b.onclick = () => { color = b.dataset.c; on = true; apply(); };
    });
    chk.onchange = () => { on = chk.checked; apply(); };
    col.oninput = () => { color = col.value; on = true; apply(); };
    sld.oninput = () => { alpha = Number(sld.value); on = true; apply(); };
    $('wzBgPick').onclick = async () => {
      if (!window.EyeDropper) { toast('Пипетка доступна только в Chrome/Edge'); return; }
      try {
        color = (await new window.EyeDropper().open()).sRGBHex;
        on = true;
        apply();
      } catch {
        /* выбор отменили — оставляем как было */
      }
    };
    apply();
  }

  function bindWidgetGhost() {
    const btn = $('widgetGhost');
    const apply = (on) => {
      widgetState.ghost = on;
      // Класс на body: в сквозном режиме страница перестаёт отвечать на мышь
      // (см. styles.css). Саму мышь снимает окно — класс нужен, чтобы не
      // подсвечивались ячейки под курсором, пока он ещё над уголком кнопок.
      document.body.classList.toggle('widget-ghost', on);
      pushWidgetState();
      btn.classList.toggle('on', on);
      btn.textContent = on ? '👆' : '👻';
      btn.title = on
        ? 'Вернуть мышь виджету: сейчас клики проходят сквозь него'
        : 'Сквозной режим: мышь проходит виджет насквозь, клики достаются столу и окнам под ним. Эти кнопки остаются нажимаемыми';
      localStorage.setItem('widgetGhost', on ? '1' : '0');
    };
    btn.onclick = () => apply(!btn.classList.contains('on'));
    // Из сквозного режима выходят и по Ctrl+Alt+W: мышь до кнопки уже не
    // доходит, и окно само говорит странице, что режим сняли.
    window.widgetHostGhost = (state) => {
      if (state !== btn.classList.contains('on')) apply(state);
    };
    apply(localStorage.getItem('widgetGhost') === '1');
  }

  // Оформление виджета: те же CSS-переменные, что правит админка
  // (SC.APP_TYPES / APP_SIZES), но выбор личный и живёт в этом браузере —
  // виджет стоит на конкретном ПК, и хозяин подгоняет его под свои обои и
  // монитор. Серверный settings.appearance при этом не трогается.
  function bindWidgetLook() {
    const box = $('wzLookBody');
    const root = document.documentElement;
    let look = {};
    try { look = JSON.parse(localStorage.getItem('widgetLook') || '{}'); } catch { /* испорчено — начинаем с чистого */ }
    const save = () => {
      for (const [k, v] of Object.entries(look)) root.style.setProperty(k, v);
      localStorage.setItem('widgetLook', JSON.stringify(look));
    };
    const colorRow = ([k, label, def]) =>
      `<label class="wz-row">${label}<input type="color" data-var="${k}" value="${look[k] || def}"></label>`;
    const sizeRow = ([k, label, def, min, max]) =>
      `<label class="wz-row">${label}<input type="number" data-var="${k}" data-px="1" min="${min}" max="${max}" value="${parseInt(look[k] || def, 10)}"></label>`;
    const fonts = ['', ...SC.APP_FONTS]
      .map((f) => `<option value="${f}"${(look['--font-sans'] || '') === f ? ' selected' : ''}>${f || 'как на сайте'}</option>`)
      .join('');
    box.innerHTML = [
      `<label class="wz-row">Шрифт<select id="wzLookFont" data-var="--font-sans">${fonts}</select></label>`,
      `<label class="wz-row">Цвет текста<input type="color" data-var="--widget-fg" value="${look['--widget-fg'] || '#ffffff'}"></label>`,
      ...SC.APP_SIZES.map(sizeRow),
      ...SC.APP_TYPES.map(colorRow),
      '<button class="btn secondary sm" type="button" id="wzLookReset">Сбросить</button>',
    ].join('');
    box.querySelectorAll('[data-var]').forEach((inp) => {
      inp.oninput = () => {
        const key = inp.dataset.var;
        const value = inp.dataset.px ? `${parseInt(inp.value, 10) || 0}px` : inp.value;
        if (value) look[key] = value;
        else { delete look[key]; root.style.removeProperty(key); }
        save();
      };
    });
    // В программе нативный список не раскрывается — подменяем своим.
    if (HOST) dropifySelects(['wzLookFont']);
    $('wzLookReset').onclick = () => {
      for (const k of Object.keys(look)) root.style.removeProperty(k);
      look = {};
      localStorage.removeItem('widgetLook');
      bindWidgetLook();
    };
    save();
  }

  // Ручки перетаскивания и размера: страница только сообщает, за что взялись,
  // дальше окно само ходит за курсором, пока кнопка нажата. В браузерном
  // виджете этим занимается сторож, и ручек там нет.
  function bindWidgetHandles() {
    const grabs = { wzMove: 'move', wzSize: 'wh' };
    for (const [id, edge] of Object.entries(grabs)) {
      const el = $(id);
      if (el) el.onmousedown = (ev) => { if (ev.button === 0) toHost(`drag:${edge}`); };
    }
  }

  // Автозапуск виджета при входе в Windows. Хранит его не страница, а сама
  // программа (ключ Run текущего пользователя): она же сообщает состояние,
  // когда страница открылась. В браузерном виджете флажок не показываем —
  // там за автозапуск отвечает установить-виджет.bat.
  function bindWidgetAutostart() {
    const chk = $('wzAutostart');
    if (!chk) return;
    chk.onchange = () => toHost(`autostart:${chk.checked ? 1 : 0}`);
    window.widgetHostAutostart = (on) => { chk.checked = !!on; };
    // Спрашиваем состояние сами: страница готова позже, чем открывается
    // навигация (данные она тянет из снимка асинхронно).
    toHost('autostart:?');
  }

  // Панель управления виджета: по умолчанию свёрнута — на рабочем столе нужна
  // сетка, а не селекты. Разворачивает единственная кнопка «✎», выбор живёт в
  // этом браузере, чтобы виджет открывался в том же виде.
  function bindWidgetToggle() {
    const btn = $('widgetToggle');
    $('widgetBtns').hidden = false;
    // У окна нет системной рамки (её снимает scripts/widget-window.ps1),
    // поэтому закрывать виджет нечем — вот кнопка.
    $('widgetClose').onclick = () => { if (HOST) toHost('close'); else window.close(); };
    bindWidgetBg();
    bindWidgetGhost();
    bindWidgetLook();
    bindWidgetAutostart();
    const apply = (on) => {
      document.body.classList.toggle('widget-edit', on);
      btn.textContent = on ? '×' : '✎';
      btn.title = on ? 'Спрятать панель управления' : 'Показать панель управления виджетом';
      localStorage.setItem('widgetEdit', on ? '1' : '0');
    };
    btn.onclick = () => {
      const on = !document.body.classList.contains('widget-edit');
      apply(on);
      if (HOST) toHost(`ui:toggle:${on ? 1 : 0}`);
    };
    apply(localStorage.getItem('widgetEdit') === '1');
  }

  // Объект (группа/преподаватель/аудитория/дисциплина) из ссылки — уже после
  // fillEntities: она сбрасывает выбор на первый пункт списка.
  function applyUrlEntity() {
    const want = Q.get('e');
    const sel = $('entitySelect');
    if (!want || ![...sel.options].some((o) => o.value === want)) return;
    sel.value = want;
    state.entityId = want;
  }

  /* ---------- Вид «Дисциплина»: выбор учебных групп галочками ---------- */
  // Как в админке: дисциплина показывается целиком, а галочки сужают выдачу —
  // и в сетке, и в таблице итогов. Правки нет, поэтому список только фильтрует.
  function bindSubjGroups() {
    const btn = $('subjGroupsBtn');
    const list = $('subjGroupsList');
    btn.onclick = () => {
      list.hidden = !list.hidden;
      btn.setAttribute('aria-expanded', String(!list.hidden));
    };
    document.addEventListener('click', (e) => {
      if (list.hidden || e.target.closest('#subjGroupsWrap')) return;
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    list.addEventListener('change', (e) => {
      const all = state.subjAllGroups;
      const t = e.target;
      if (t.id === 'subjGroupsAll') {
        list.querySelectorAll('.subj-group').forEach((cb) => { cb.checked = t.checked; });
      } else if (!t.classList.contains('subj-group') && !t.classList.contains('crs-all')) {
        return;
      }
      // Галочка курса проставляет свои группы на перехвате (bindCourseChecks),
      // поэтому итог просто читаем из DOM.
      state.subjGroups = new Set([...list.querySelectorAll('.subj-group:checked')].map((cb) => cb.value));
      renderSubjGroups(all);
      render();
    });
  }

  function renderSubjGroups(all) {
    const picked = state.subjGroups || new Set(all);
    $('subjGroupsList').innerHTML = all.length
      ? `<label class="pick-item"><input type="checkbox" id="subjGroupsAll"${picked.size === all.length ? ' checked' : ''}> <b>Выделить все</b></label>` +
        SC.courseGroupsHtml(all, state.db.courses, (g) =>
          `<label class="pick-item"><input type="checkbox" class="subj-group" value="${esc(g)}"${picked.has(g) ? ' checked' : ''}> ${esc(g)}</label>`)
      : '<div class="muted-hint">Нет групп</div>';
    SC.bindCourseChecks($('subjGroupsList'));
    $('subjGroupsBtn').textContent = picked.size === all.length
      ? `Группы: все (${all.length})`
      : `Группы: ${picked.size} из ${all.length}`;
  }

  // Кафедра преподавателя из снимка публикации ('' — не задана).
  const deptOfTeacher = (name) => ((state.db && state.db.teacherDept) || {})[name] || '';

  // Все кафедры снимка по алфавиту; «(без кафедры)» — последним и только если
  // такие преподаватели есть.
  function deptList() {
    const teachers = (state.db && state.db.teachers) || [];
    const named = [...new Set(teachers.map(deptOfTeacher).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
    return teachers.some((t) => !deptOfTeacher(t)) ? [...named, NO_DEPT] : named;
  }

  // Преподаватели, у которых в расписании есть хоть одно занятие. Пустые записи
  // справочника блоками не делаем: их сотня, и каждая добавила бы четыре пустых
  // строки. Считаем один раз на загруженный снимок.
  let withLessons = null;
  function teachersWithLessons() {
    if (!withLessons) withLessons = new Set(((state.db && state.db.lessons) || []).flatMap(teachersOf));
    return withLessons;
  }

  // Преподаватели одной кафедры (из тех, у кого вообще есть занятия). Отбор по
  // открытой неделе — уже в renderDept: он зависит от недели, а этот список нет.
  const deptTeachers = (dept) =>
    ((state.db && state.db.teachers) || []).filter(
      (t) =>
        (dept === NO_DEPT ? !deptOfTeacher(t) : deptOfTeacher(t) === dept) && teachersWithLessons().has(t)
    );

  // Аудитории кафедр берём из справочника аудиторий в снимке (roomsInfo).
  // Аудитория без кафедры в кафедральный список не попадает — ей негде быть.
  const roomsInfo = () => (state.db && state.db.roomsInfo) || [];
  const byRu = (a, b) => a.localeCompare(b, 'ru', { numeric: true });

  const roomDeptList = () => [...new Set(roomsInfo().map((r) => r.dept).filter(Boolean))].sort(byRu);

  const deptRooms = (dept) => roomsInfo().filter((r) => r.dept === dept).map((r) => r.name).sort(byRu);

  function fillEntities() {
    if (state.kind === 'dept') {
      const depts = state.deptKind !== 'teacher' ? roomDeptList() : deptList();
      $('entitySelect').innerHTML =
        depts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('') || '<option value="">—</option>';
      state.entityId = ($('entitySelect').options[0] || {}).value || null;
      $('subjGroupsWrap').hidden = true;
      $('subjGroupsList').hidden = true;
      state.subjGroups = null;
      return;
    }
    // В снимке, опубликованном до появления вида «Дисциплина», списка subjects
    // нет — собираем его из занятий, чтобы вид работал без перепубликации.
    const list = state.kind === 'subject' && !(state.db.subjects || []).length
      ? [...new Set((state.db.lessons || [])
        .filter((l) => l.subject && l.category !== 'event' && !l.event)
        .map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ru'))
      : (state.db[state.kind + 's'] || []);
    // Аудитории подписываются кафедрой, примечанием и числом мест (roomsInfo из
    // снимка публикации). Значение option — голое имя: по нему идёт выборка занятий.
    const info = state.kind === 'room'
      ? new Map((state.db.roomsInfo || []).map((r) => [r.name, r]))
      : null;
    const label = (n) => (info ? SC.roomLabel(info.get(n) || { name: n }) : n);
    const option = (n) => `<option value="${esc(n)}">${esc(label(n))}</option>`;
    // Группы — с заголовками курсов (курсы приходят в снимке публикации; в
    // старом снимке их нет, тогда список остаётся плоским).
    $('entitySelect').innerHTML =
      (state.kind === 'group' ? SC.courseOptionsHtml(list, state.db.courses, option) : list.map(option).join('')) ||
      '<option value="">—</option>';
    // Первым берём первый пункт списка: у групп порядок задают курсы.
    state.entityId = ($('entitySelect').options[0] || {}).value || null;
    // Список групп строится по занятиям дисциплины (в render), здесь только
    // сбрасываем прежний выбор: у другой дисциплины свои группы.
    $('subjGroupsWrap').hidden = state.kind !== 'subject';
    $('subjGroupsList').hidden = true;
    state.subjGroups = null;
  }

  // Листание объекта (← / →) в семестровом виде.
  function stepEntity(delta) {
    const sel = $('entitySelect');
    const opts = [...sel.options].filter((o) => o.value);
    if (!opts.length) return;
    let idx = opts.findIndex((o) => o.value === state.entityId);
    if (idx < 0) idx = 0;
    const next = Math.min(opts.length - 1, Math.max(0, idx + delta));
    if (next === idx) return;
    state.entityId = opts[next].value;
    state.subjGroups = null;
    sel.value = state.entityId;
    render();
  }

  // Листание недель (← / →) в недельном и сводном видах (зажим 1..26).
  function semesterWeeks() {
    const sem = state.db && state.db.semester;
    if (sem && sem.start && sem.end) {
      const a = new Date(sem.start + 'T00:00:00Z');
      const b = new Date(sem.end + 'T00:00:00Z');
      if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
        a.setUTCDate(a.getUTCDate() - ((a.getUTCDay() + 6) % 7)); // понедельник недели 1
        const n = Math.floor((b.getTime() - a.getTime()) / (7 * 86400000)) + 1;
        if (n >= 1) return n;
      }
    }
    const maxData = (state.db && state.db.lessons || []).reduce((m, l) => Math.max(m, l.weekNo || 0), 0);
    return Math.max(maxData, 26);
  }

  // Начальная позиция следует локальной календарной дате устройства посетителя.
  const currentWeek = () => SC.weekNoOn(
    (state.db && state.db.semester || {}).start,
    new Date(),
    semesterWeeks()
  ) || 1;

  function stepWeek(delta) {
    const next = Math.min(semesterWeeks(), Math.max(1, Number(state.week) + delta));
    if (next === state.week) return;
    state.week = next;
    $('weekSelect').value = String(next);
    render();
  }

  // Аудитории занятия (1 или 2). Источник — rooms[]; для совместимости — room.
  const roomsOf = (l) => (l.rooms && l.rooms.length) ? l.rooms : (l.room ? [l.room] : []);
  const roomStr = (l) => roomsOf(l).join(', ');

  function lessonsFor() {
    const all = state.db.lessons || [];
    if (state.kind === 'group') return all.filter((l) => (l.groups || []).includes(state.entityId));
    if (state.kind === 'teacher') return all.filter((l) => l.teacher === state.entityId);
    if (state.kind === 'subject') {
      // Мероприятия к дисциплине не относятся. Список групп считаем по ВСЕМ
      // занятиям дисциплины и запоминаем: ниже выдача фильтруется галочками, и
      // по ней группы «исчезали» бы вместе со снятыми.
      const mine = all.filter((l) => l.subject === state.entityId && l.category !== 'event' && !l.event);
      state.subjAllGroups = [...new Set(mine.flatMap((l) => l.groups || []))].sort((a, b) => a.localeCompare(b, 'ru'));
      if (!state.subjGroups) state.subjGroups = new Set(state.subjAllGroups);
      renderSubjGroups(state.subjAllGroups);
      const picked = state.subjGroups;
      return mine.filter((l) => (l.groups || []).some((g) => picked.has(g)));
    }
    return all.filter((l) => roomsOf(l).includes(state.entityId));
  }

  // Выгрузка доступна во всех видах; вне сводного нужен выбранный объект.
  function syncExportBtn() {
    const kindOk = ['group', 'teacher', 'subject', 'room', 'dept'].includes(state.kind);
    $('btnGuestExport').hidden = !state.canExport || (!isSummary() && (!kindOk || !state.entityId));
  }

  // Тело запроса для выгрузки открытого вида. У дисциплины группы берём из тех же
  // галочек, по которым отрисована сетка: в файл уходит ровно видимое.
  function exportTarget() {
    if (isSummary()) return ['/api/export/weekly', { weekNo: state.week, groups: summaryGroups() }];
    if (state.kind === 'group') return ['/api/export/group', { group: state.entityId }];
    if (state.kind === 'teacher') return ['/api/export/teacher', { teacher: state.entityId }];
    if (state.kind === 'room' || state.kind === 'dept') {
      const weeks = state.kind === 'dept' || state.mode === 'week'
        ? [state.week]
        : weekWindow(maxWeekOf(lessonsFor()));
      return ['/api/export/guest-view', {
        kind: state.kind, id: state.entityId, deptKind: state.deptKind, weeks,
      }];
    }
    return ['/api/export/subject', { subject: state.entityId, groups: [...(state.subjGroups || [])] }];
  }

  // Excel собирает сервер по тем же шаблонам, что и для админки (/api/export/*).
  async function downloadSchedule() {
    const btn = $('btnGuestExport');
    const [url, body] = exportTarget();
    if (state.kind === 'subject' && !isSummary() && !body.groups.length) return toast('Отметьте хотя бы одну учебную группу', true);
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…сохраняю';
    try {
      // В сводном выгружаем ровно то, что видно: скрытые фильтром «🎓 Курсы»
      // группы в файл не попадают (сервер подгоняет столбцы под этот список).
      const res = await api.download(url, body);
      if (res.warnings && res.warnings.length) toast(res.warnings.join('; '), true);
      else toast(`Скачивается файл ${res.filename}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function render() {
    syncExportBtn();
    // Подписи своих списков (виджет-программа): значение <select> часто ставят
    // кодом, а на такое событий нет — обновляем их при каждой перерисовке.
    dropSyncs.forEach((sync) => sync());
    if (isSummary()) { renderSummary(); showFreeSlots(); return; }
    // Кафедра показывается только за неделю: месяц и семестр на десяток
    // преподавателей сразу не читаются, поэтому режим здесь не спрашиваем.
    if (state.kind === 'dept') {
      if (state.deptKind === 'room') renderRoomDept();
      else if (state.deptKind === 'room-matrix') renderRoomMatrix();
      else renderDept();
      showFreeSlots();
      return;
    }
    if (!state.entityId) { $('grid').innerHTML = ''; return; }
    const lessons = lessonsFor();
    buildTints(lessons);
    const tail = state.kind === 'subject' ? ` · группы: ${[...(state.subjGroups || [])].sort().join(', ') || '—'}` : '';
    if (state.mode === 'semester' || state.mode === 'month') {
      const wk = weekWindow(maxWeekOf(lessons));
      const span = state.mode === 'month' ? `недели ${wk[0]}–${wk[wk.length - 1]}` : 'весь семестр';
      $('title').textContent = `${KIND_LABEL[state.kind]}: ${state.entityId}${tail} · ${span}`;
      renderSemester(lessons);
    } else {
      $('title').textContent = `${KIND_LABEL[state.kind]}: ${state.entityId}${tail} · неделя ${state.week}`;
      renderWeek(lessons);
    }
    // Сетку перерисовали — подсветку выбранного занятия возвращаем на место.
    showFreeSlots();
  }

  /* ------------------ Свободные окна (только просмотр) ------------------ */
  // Занятие, для которого показаны свободные окна. Живёт между перерисовками,
  // чтобы подсветка не пропадала при листании недель и групп.
  let freeFor = null;

  const teachersOf = (l) => [l.teacher, ...(l.teachers || [])].filter(Boolean);

  // Свободен ли слот для занятия. Учитываем ТОЛЬКО группу и преподавателя:
  // аудитории в гостевом просмотре не проверяются (переноса всё равно нет).
  function slotFree(lesson, day, pairNo, weekNo) {
    const groups = new Set(lesson.groups || []);
    const teachers = new Set(teachersOf(lesson));
    return !(state.db.lessons || []).some(
      (x) =>
        x.id !== lesson.id &&
        !x.parked &&
        x.day === day &&
        x.pairNo === pairNo &&
        x.weekNo === weekNo &&
        ((x.groups || []).some((g) => groups.has(g)) || teachersOf(x).some((t) => teachers.has(t)))
    );
  }

  // Подсветка свободных окон занятия freeFor. Без аргумента — восстановление
  // после перерисовки сетки; с занятием — новый выбор.
  function showFreeSlots(lesson) {
    if (lesson) freeFor = lesson;
    const L = freeFor;
    $('grid').querySelectorAll('td.slot.free-target').forEach((td) => td.classList.remove('free-target'));
    if (!L || !state.canMoves) return;
    $('grid').querySelectorAll('td.slot[data-day]').forEach((td) => {
      const day = td.dataset.day;
      const pairNo = Number(td.dataset.pair);
      const weekNo = td.dataset.week ? Number(td.dataset.week) : state.week;
      // Сводный вид: переносить занятие можно только в колонках его групп.
      if (td.dataset.group && !(L.groups || []).includes(td.dataset.group)) return;
      // Кафедра: у каждого преподавателя свой блок — чужие блоки не подсвечиваем.
      if (td.dataset.teacher && !teachersOf(L).includes(td.dataset.teacher)) return;
      if (td.dataset.room && !roomsOf(L).includes(td.dataset.room)) return;
      if (isHolidayDay(weekNo, day)) return; // нерабочий день — не цель переноса
      if (day === L.day && pairNo === L.pairNo && weekNo === L.weekNo) return; // текущее место
      if (slotFree(L, day, pairNo, weekNo)) td.classList.add('free-target');
    });
  }

  function clearFreeSlots() {
    freeFor = null;
    $('grid').querySelectorAll('td.slot.free-target').forEach((td) => td.classList.remove('free-target'));
  }

  /* ------------------ Разные цвета занятий ------------------ */
  // Ключ окраски: в расписании ГРУППЫ — дисциплина, у ПРЕПОДАВАТЕЛЯ и в
  // ДИСЦИПЛИНЕ — учебная группа (у потока берём первую из показанных, чтобы
  // одна и та же группа всегда была одного цвета). Аудитория и сводный вид не
  // красятся: там колонка и так задаёт разбивку.
  function tintKey(l) {
    if (state.kind === 'group') return l.subject || '';
    if (state.kind === 'teacher' || state.kind === 'subject' || state.kind === 'dept') {
      const picked = state.kind === 'subject' ? state.subjGroups : null;
      return (l.groups || [])
        .filter((g) => !picked || picked.has(g))
        .sort((a, b) => a.localeCompare(b, 'ru'))[0] || '';
    }
    return '';
  }

  // Палитра открытого объекта: ключи раскладываем по цветовому кругу золотым
  // углом (137.5°) — соседние ключи получают максимально разные оттенки. Хэш
  // строки тут не годится: у «861-11» и «861-12» он соседний, а значит и цвет
  // почти одинаковый. Считаем по ВСЕМ занятиям объекта, а не по открытой
  // неделе, иначе цвет дисциплины менялся бы при листании недель.
  // Насыщенность и светлота фиксированы, фоном карточки разбавляет CSS
  // (.lesson.tint), поэтому цвета работают и в тёмной теме.
  let tints = new Map();

  function buildTints(lessons) {
    const keys = [...new Set(lessons.map(tintKey).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    tints = new Map(keys.map((k, i) => [k, `hsl(${((i * 137.508) % 360).toFixed(1)} 65% 52%)`]));
  }

  // Атрибут style с оттенком (или '' — цвета выключены/нет ключа). Формы
  // контроля не перекрашиваем: зачёт и экзамен имеют собственный цвет.
  function tintAttr(l) {
    if (!state.canColors || SC.assessmentKind(l.type)) return '';
    const c = tints.get(tintKey(l));
    return c ? ` style="--tint:${c}"` : '';
  }

  const isEvent = (l) => l.category === 'event' || l.event;

  /* ---------------- Пометка «перенесено» (как в админке) ---------------- */
  // Пометки приходят в снимке публикации (db.moveMarks) уже посчитанными сервером —
  // те же, что получает админка (getMoveMarks). Снимок старого формата (без поля)
  // пометок не даёт до перепубликации. Показ полосы включает общий тумблер
  // settings.moveMarks (/api/move-marks).
  let movedIndex = new Map(); // '#id занятия' → { steps, lastMove, lastRoom }
  function buildMovedIndex() {
    movedIndex = new Map(((state.db && state.db.moveMarks) || []).map((m) => [m.key, m]));
  }
  const movedEntryFor = (l) => movedIndex.get(`#${l.id}`) || null;
  // Полоса — и за перенос, и за смену аудитории (как в админке).
  function movedClass(l) {
    return state.canMoveMarks && movedEntryFor(l) ? ' moved' : '';
  }

  // Мероприятие (Отп, ЭкзС, ОП…) — не занятие, а метка «слот занят». Рисуем так
  // же, как админка: .lesson.event в styles.css позиционируется absolute
  // inset:0 внутри td.slot.slot-event, поэтому карточка занимает ровно ту же
  // высоту, что и соседние занятия строки (короткий текст её не ужимает).
  function eventCard(l) {
    const name = SC.eventName(l.subject || l.marker);
    const [a, b, c] = [l.type || '', l.subject || l.marker || '—', roomStr(l)].map(esc);
    return (
      `<div class="lesson event ${SC.eventKind(l.subject || l.marker)}" title="${esc(name || 'Мероприятие')}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="l1">${a}</div><div class="l2">${b}</div><div class="l3">${c}</div></div>`
    );
  }

  function card(l) {
    if (isEvent(l)) return eventCard(l);
    const t = tintAttr(l);
    return (
      `<div class="lesson ${SC.assessmentKind(l.type)}${t ? ' tint' : ''}${movedClass(l)}"${t} data-lesson='${esc(JSON.stringify(l))}'><div class="meta">${esc(l.type || '')}</div>` +
      `<div class="subj">${esc(l.subject || '—')}</div>` +
      // В виде «Кафедра» подпись блока (фамилия или аудитория) в карточке лишняя,
      // а лишняя строка × 4 пары × N блоков заметно тянет таблицу вниз.
      (deptRows('room') || deptRows('room-matrix') ? '' : `<div class="meta">${esc(roomStr(l) || '—')}</div>`) +
      `<div class="meta">${esc((l.groups || []).join(', '))}</div>` +
      (deptRows('teacher') ? '' : `<div class="meta">${esc(l.teacher || '')}</div>`) + '</div>'
    );
  }

  // 4 строки ячейки: вид, дисциплина, аудитория, преподаватель. Поле, и так
  // очевидное из текущего представления, заменяется на список групп —
  // раскладка зависит от представления.
  function sourceLines(l) {
    const top = l.topic ? `${l.type || ''}/${l.topic}` : l.type || '';
    // Тумблер «Преподаватель» гасит ФИО в сетке (список групп он не трогает).
    const fio = state.sumTeacher ? l.teacher || '' : '';
    if (state.kind === 'teacher') return [top, l.subject || '', roomStr(l), (l.groups || []).join(', ')];
    if (state.kind === 'room') return [top, l.subject || '', (l.groups || []).join(', '), fio];
    // Дисциплина одна на весь экран: в ячейке — вид/тема, ВЫБРАННЫЕ группы (чужие
    // группы потока не показываем, как в админке), аудитория и преподаватель.
    if (state.kind === 'subject') {
      const picked = state.subjGroups;
      const groups = (l.groups || []).filter((g) => !picked || picked.has(g));
      return [top, groups.join(', '), roomStr(l), fio];
    }
    return [top, l.subject || '', roomStr(l), fio];
  }

  // Пустые строки не выводим совсем: пустой div всё равно занимает высоту, и с
  // погашенным ФИО (тумблер «Преподаватель») таблица была бы на строку выше нужного.
  const SRC_LINE_CLASS = ['l1', 'l2', 'l3', 'l4'];

  function sourceCard(l) {
    if (isEvent(l)) return eventCard(l);
    const body = sourceLines(l)
      .map((text, i) => (text ? `<div class="${SRC_LINE_CLASS[i]}">${esc(text)}</div>` : ''))
      .join('');
    const t = tintAttr(l);
    return `<div class="lesson src ${SC.assessmentKind(l.type)}${t ? ' tint' : ''}${movedClass(l)}"${t} data-lesson='${esc(JSON.stringify(l))}'>${body}</div>`;
  }

  function renderWeek(lessons) {
    const ofWeek = lessons.filter((l) => l.weekNo === state.week);
    const at = (d, p) => ofWeek.filter((l) => l.day === d && l.pairNo === p);

    let html = '<table class="grid"><thead><tr><th class="time-col">Часы</th>';
    for (const d of DAYS) {
      const dt = dateOf(state.week, d);
      const hol = isHolidayDay(state.week, d);
      html += `<th${hol ? ' class="holiday-day"' : ''}>${d}${dt ? `<span class="head-date">${esc(dt)}</span>` : ''}${hol ? '<br><small class="hol-label">нерабочий</small>' : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const p of PAIRS) {
      html += `<tr><td class="time-cell"><b>${SC.pairHours(p)}</b><br>${PAIR_TIMES[p]}</td>`;
      for (const d of DAYS) {
        // В субботу 4-й пары не бывает — пустая неинтерактивная ячейка.
        if (!SC.pairsForDay(d).includes(p)) { html += '<td class="no-pair"></td>'; continue; }
        const hol = isHolidayDay(state.week, d);
        const cell = at(d, p);
        const ev = cell.some(isEvent);
        html += `<td class="slot${hol ? ' holiday-col' : ''}${ev ? ' slot-event' : ''}" data-day="${esc(d)}" data-pair="${p}">`;
        for (const l of cell) html += card(l);
        // Нерабочий день — отметка «Вых» в пустой ячейке.
        if (hol && !cell.length) html += '<div class="holiday-mark">Вых</div>';
        html += '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    $('grid').innerHTML = html;
    fillHlValues();
    applyHighlights();
  }

  // Вид «Кафедра»: недельные расписания всех преподавателей кафедры в одной
  // таблице. Блок преподавателя — точно та же сетка, что и в его недельном
  // расписании (строки — часы, столбцы — дни), блоки идут сверху вниз.
  function renderDept() {
    const dept = state.entityId;
    if (!state.db.teacherDept) {
      $('title').textContent = 'Кафедра';
      $('grid').innerHTML =
        '<p class="file-status">В опубликованном снимке нет кафедр преподавателей. Обновите публикацию в админке — вид появится.</p>';
      return;
    }
    $('title').textContent = `${KIND_LABEL.dept}: ${dept || '—'} · неделя ${state.week}`;
    const teachers = dept ? deptTeachers(dept) : [];
    if (!teachers.length) {
      $('grid').innerHTML = '<p class="file-status">На этой кафедре нет преподавателей.</p>';
      return;
    }
    const mine = new Set(teachers);
    // Цвета считаем по всем занятиям кафедры, а не по открытой неделе: иначе
    // группа меняла бы цвет при листании недель.
    const all = (state.db.lessons || []).filter((l) => teachersOf(l).some((t) => mine.has(t)));
    buildTints(all);
    const wk = all.filter((l) => l.weekNo === state.week);
    // Пусто на этой неделе — преподавателя не показываем: иначе половина
    // таблицы кафедры уходит под пустые сетки.
    const busy = new Set(wk.flatMap(teachersOf));
    const shown = teachers.filter((t) => busy.has(t));
    if (!shown.length) {
      $('grid').innerHTML = `<p class="file-status">На неделе ${state.week} у кафедры нет занятий.</p>`;
      return;
    }
    const at = (t, d, p) =>
      wk.filter((l) => l.day === d && l.pairNo === p && teachersOf(l).includes(t));

    let html = '<div class="grid-scroll"><table class="grid dept-grid"><thead><tr>';
    html += '<th class="tch-col">Преподаватель</th><th class="time-col">Часы</th>';
    for (const d of DAYS) {
      const dt = dateOf(state.week, d);
      const hol = isHolidayDay(state.week, d);
      html += `<th${hol ? ' class="holiday-day"' : ''}>${d}${dt ? `<span class="head-date">${esc(dt)}</span>` : ''}${hol ? '<br><small class="hol-label">нерабочий</small>' : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const t of shown) {
      for (let pi = 0; pi < PAIRS.length; pi++) {
        const p = PAIRS[pi];
        html += `<tr${pi === 0 ? ' class="dept-row1"' : ''}>`;
        if (pi === 0) html += `<td class="tch-col" rowspan="${PAIRS.length}">${esc(t)}</td>`;
        html += `<td class="time-cell"><b>${SC.pairHours(p)}</b><br>${PAIR_TIMES[p]}</td>`;
        for (const d of DAYS) {
          // В субботу 4-й пары не бывает — пустая неинтерактивная ячейка.
          if (!SC.pairsForDay(d).includes(p)) { html += '<td class="no-pair"></td>'; continue; }
          const hol = isHolidayDay(state.week, d);
          const cell = at(t, d, p);
          html += `<td class="slot${hol ? ' holiday-col' : ''}${cell.some(isEvent) ? ' slot-event' : ''}" data-teacher="${esc(t)}" data-day="${esc(d)}" data-pair="${p}">`;
          for (const l of cell) html += card(l);
          if (hol && !cell.length) html += '<div class="holiday-mark">Вых</div>';
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('grid').innerHTML = html;
    fillHlValues();
    applyHighlights();
  }

  // Тот же вид «Кафедра», но строками идут аудитории кафедры. Отличий от
  // renderDept ровно три: список берётся из справочника аудиторий, занятие
  // ищется по аудитории, и в подписи блока есть места с примечанием.
  function renderRoomDept() {
    const dept = state.entityId;
    if (!roomsInfo().length) {
      $('title').textContent = KIND_LABEL.dept;
      $('grid').innerHTML =
        '<p class="file-status">В опубликованном снимке нет справочника аудиторий. Обновите публикацию в админке — вид появится.</p>';
      return;
    }
    $('title').textContent = `${KIND_LABEL.dept}: ${dept || '—'} · аудитории · неделя ${state.week}`;
    const rooms = dept ? deptRooms(dept) : [];
    if (!rooms.length) {
      $('grid').innerHTML = '<p class="file-status">У этой кафедры нет аудиторий.</p>';
      return;
    }
    const mine = new Set(rooms);
    // Цвета — по всем занятиям кафедры, а не по открытой неделе: иначе группа
    // меняла бы цвет при листании недель.
    const all = (state.db.lessons || []).filter((l) => roomsOf(l).some((r) => mine.has(r)));
    buildTints(all);
    const wk = all.filter((l) => l.weekNo === state.week);
    // Пусто на этой неделе — аудиторию не показываем, как и преподавателя.
    const busy = new Set(wk.flatMap(roomsOf));
    const shown = rooms.filter((r) => busy.has(r));
    if (!shown.length) {
      $('grid').innerHTML = `<p class="file-status">На неделе ${state.week} у аудиторий кафедры нет занятий.</p>`;
      return;
    }
    const at = (r, d, p) => wk.filter((l) => l.day === d && l.pairNo === p && roomsOf(l).includes(r));
    // Кафедра в подписи не нужна — она и так выбрана в переключателе.
    const info = new Map(roomsInfo().map((r) => [r.name, r]));
    const sub = (r) => {
      const i = info.get(r) || {};
      return [i.note, i.capacity != null ? `${i.capacity} ${SC.seats(i.capacity)}` : ''].filter(Boolean).join(' · ');
    };

    let html = '<div class="grid-scroll"><table class="grid dept-grid"><thead><tr>';
    html += '<th class="tch-col">Аудитория</th><th class="time-col">Часы</th>';
    for (const d of DAYS) {
      const dt = dateOf(state.week, d);
      const hol = isHolidayDay(state.week, d);
      html += `<th${hol ? ' class="holiday-day"' : ''}>${d}${dt ? `<br><small>${esc(dt)}</small>` : ''}${hol ? '<br><small class="hol-label">нерабочий</small>' : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const r of shown) {
      for (let pi = 0; pi < PAIRS.length; pi++) {
        const p = PAIRS[pi];
        html += `<tr${pi === 0 ? ' class="dept-row1"' : ''}>`;
        if (pi === 0) {
          const s2 = sub(r);
          html += `<td class="tch-col" rowspan="${PAIRS.length}">${esc(r)}` +
            `${s2 ? `<div class="room-sub">${esc(s2)}</div>` : ''}</td>`;
        }
        html += `<td class="time-cell"><b>${SC.pairHours(p)}</b><br>${PAIR_TIMES[p]}</td>`;
        for (const d of DAYS) {
          // В субботу 4-й пары не бывает — пустая неинтерактивная ячейка.
          if (!SC.pairsForDay(d).includes(p)) { html += '<td class="no-pair"></td>'; continue; }
          const hol = isHolidayDay(state.week, d);
          const cell = at(r, d, p);
          html += `<td class="slot${hol ? ' holiday-col' : ''}${cell.some(isEvent) ? ' slot-event' : ''}" data-room="${esc(r)}" data-day="${esc(d)}" data-pair="${p}">`;
          for (const l of cell) html += card(l);
          if (hol && !cell.length) html += '<div class="holiday-mark">Вых</div>';
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('grid').innerHTML = html;
    fillHlValues();
    applyHighlights();
  }

  // Второй вид аудиторий кафедры: дни и пары идут строками, аудитории —
  // столбцами. Пустые аудитории остаются, чтобы структура не менялась от недели.
  function renderRoomMatrix() {
    const dept = state.entityId;
    if (!roomsInfo().length) {
      $('title').textContent = KIND_LABEL.dept;
      $('grid').innerHTML =
        '<p class="file-status">В опубликованном снимке нет справочника аудиторий. Обновите публикацию в админке — вид появится.</p>';
      return;
    }
    const rooms = dept ? deptRooms(dept) : [];
    const days = state.mode === 'day' ? [DAYS.includes(state.day) ? state.day : todayDay()] : DAYS;
    const dayLabel = state.mode === 'day' ? ` · ${days[0]}` : '';
    $('title').textContent = `${KIND_LABEL.dept}: ${dept || '—'} · Аудитории (2)${dayLabel} · неделя ${state.week}`;
    if (!rooms.length) {
      $('grid').innerHTML = '<p class="file-status">У этой кафедры нет аудиторий.</p>';
      return;
    }

    const mine = new Set(rooms);
    const all = (state.db.lessons || []).filter((l) => roomsOf(l).some((room) => mine.has(room)));
    buildTints(all);
    const weekLessons = all.filter((l) => l.weekNo === state.week);
    const at = (room, day, pairNo) => weekLessons.filter(
      (l) => l.day === day && l.pairNo === pairNo && roomsOf(l).includes(room)
    );
    const info = new Map(roomsInfo().map((room) => [room.name, room]));
    const roomDetails = (name) => {
      const room = info.get(name) || {};
      return [room.note, room.capacity != null ? `${room.capacity} ${SC.seats(room.capacity)}` : '']
        .filter(Boolean).join(' · ');
    };

    let html = '<div class="grid-scroll room-matrix-scroll"><table class="grid room-matrix"><thead><tr>';
    html += '<th class="day-col">День</th><th class="time-col">Пара / часы</th>';
    for (const room of rooms) {
      const details = roomDetails(room);
      html += `<th class="room-col" data-room="${esc(room)}" title="${esc(details)}">${esc(room)}` +
        `${details ? `<span class="room-sub">${esc(details)}</span>` : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const day of days) {
      for (const pairNo of PAIRS) {
        const hasPair = SC.pairsForDay(day).includes(pairNo);
        html += '<tr>';
        if (pairNo === PAIRS[0]) {
          const date = dateOf(state.week, day);
          html += `<td class="day-col" rowspan="${PAIRS.length}">${day}` +
            `${date ? `<span class="cell-date">${esc(date)}</span>` : ''}</td>`;
        }
        html += `<td class="time-cell"><b>${SC.pairHours(pairNo)}</b><br>${PAIR_TIMES[pairNo]}</td>`;
        for (const room of rooms) {
          if (!hasPair) { html += '<td class="no-pair"></td>'; continue; }
          const cell = at(room, day, pairNo);
          const holiday = isHolidayDay(state.week, day);
          html += `<td class="slot${holiday ? ' holiday-col' : ''}${cell.some(isEvent) ? ' slot-event' : ''}" data-room="${esc(room)}" data-day="${esc(day)}" data-pair="${pairNo}">`;
          for (const lesson of cell) html += card(lesson);
          if (holiday && !cell.length) html += '<div class="holiday-mark">Вых</div>';
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('grid').innerHTML = html;
    fillHlValues();
    applyHighlights();
  }

  // Недели-столбцы семестровой таблицы: весь семестр или окно «Месяца».
  const maxWeekOf = (lessons) => lessons.reduce((m, l) => Math.max(m, l.weekNo || 0), 0) || 26;

  function weekWindow(maxWeek) {
    if (state.mode !== 'month') return Array.from({ length: maxWeek }, (_, i) => i + 1);
    const n = Math.min(MONTH_WEEKS, maxWeek);
    const from = Math.min(Math.max(1, state.week), Math.max(1, maxWeek - n + 1));
    return Array.from({ length: n }, (_, i) => from + i);
  }

  function renderSemester(lessons) {
    const weeks = weekWindow(maxWeekOf(lessons));
    const at = (d, p, w) => lessons.filter((l) => l.day === d && l.pairNo === p && l.weekNo === w);

    let html = '<div class="grid-scroll"><table class="grid semester"><thead><tr><th class="day-col">День</th><th class="pair-col">Часы</th>';
    for (const w of weeks) html += `<th class="wk-head">${w}</th>`;
    html += '</tr></thead><tbody>';
    for (const d of DAYS) {
      const dayPairs = SC.pairsForDay(d);
      for (let pi = 0; pi < dayPairs.length; pi++) {
        const p = dayPairs[pi];
        html += '<tr>';
        if (pi === 0) html += `<td class="day-col" rowspan="${dayPairs.length}">${d}</td>`;
        html += `<td class="pair-col">${SC.pairHours(p)}<br>${PAIR_TIMES[p]}</td>`;
        for (const w of weeks) {
          const cell = at(d, p, w);
          html += `<td class="slot${cell.some(isEvent) ? ' slot-event' : ''}" data-day="${esc(d)}" data-pair="${p}" data-week="${w}">`;
          if (pi === 0 && dateOf(w, d)) html += `<div class="cell-date">${esc(dateOf(w, d))}</div>`;
          for (const l of cell) html += sourceCard(l);
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    html += teacherTables(lessons);
    html += groupFooter();
    $('grid').innerHTML = html;
    TT.bindList();
    fillHlValues();
    applyHighlights();
  }

  // Подвал расписания ГРУППЫ — как в админке, но только для чтения: таблица
  // «Дисциплины и преподаватели» из подвала исходного файла (groupSubjects в
  // снимке) и расшифровка видов занятий (legend). Правка подвала — в админке.
  const SUBJ_COLS = [
    { field: 'abbr', title: 'Обозн.' },
    { field: 'fullName', title: 'Дисциплина' },
    { field: 'dept', title: 'Каф.' },
    { field: 'lecturer', title: 'Лектор, уч. степень, уч. звание' },
    { field: 'others', title: 'Другие виды занятий' },
    { field: 'hours', title: 'Кол-во часов' },
    { field: 'report', title: 'Отчёт.' },
  ];

  // Переносы строк в полях подвала (лектор, другие виды занятий) — как в исходнике.
  const nl2br = (v) => String(v == null ? '' : v).replace(/\r?\n/g, '<br>');

  function groupFooter() {
    if (state.kind !== 'group') return '';
    return subjectsTable() + legendFooter();
  }

  function subjectsTable() {
    const subs = (state.db.groupSubjects && state.db.groupSubjects[state.entityId]) || [];
    if (!subs.length) return '';
    let html = '<div class="subjects-block"><h2 class="subjects-title">Дисциплины и преподаватели</h2>';
    html += '<div class="grid-scroll"><table class="grid subjects-table"><thead><tr>';
    for (const c of SUBJ_COLS) html += `<th class="subj-${c.field}">${esc(c.title)}</th>`;
    html += '</tr></thead><tbody>';
    for (const s of subs) {
      html += '<tr>';
      // Многострочные поля (лектор, другие виды занятий) переносим как в исходнике.
      for (const c of SUBJ_COLS) html += `<td class="subj-${c.field}">${nl2br(esc(s[c.field]))}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
    return html;
  }

  function legendFooter() {
    const entries = Object.entries((state.db && state.db.legend) || {});
    if (!entries.length) return '';
    entries.sort((a, b) => a[0].localeCompare(b[0], 'ru'));
    let html = '<div class="legend-footer"><h2 class="legend-title">Обозначения видов занятий:</h2>';
    html += '<div class="legend-grid">';
    for (const [code, name] of entries) {
      html += `<div class="legend-item"><span class="legend-code">${esc(code)}</span><span class="legend-name">${esc(name)}</span></div>`;
    }
    html += '</div></div>';
    return html;
  }

  // Под сеткой СЕМЕСТРА преподавателя — те же две таблицы, что в админке:
  // итоги по дисциплинам и построчный перечень занятий (общий модуль
  // /js/teacher-tables.js). Данные для сверки с планом и подвалом лежат в снимке
  // публикации: groupsSummary и groupSubjects.
  // Итоги отдельной функцией: после правки строки перечня они пересчитываются
  // на месте (вид занятия в них считается), а сам перечень не перерисовывается.
  function teacherSummary(lessons) {
    const real = lessons.filter((l) => l.subject && l.subject !== 'СР' && l.category !== 'event' && !l.event);
    return real.length ? TT.summaryHtml(real, tablesCtx()) : '';
  }

  function teacherTables(lessons) {
    if (state.kind !== 'teacher' && state.kind !== 'subject') return '';
    const sum = teacherSummary(lessons);
    // У дисциплины — только итоги (как в админке): построчный перечень с правкой
    // относится к преподавателю.
    if (!sum || state.kind === 'subject') return sum;
    return sum + TT.listHtml(lessons, tablesCtx());
  }

  // Контекст таблиц: сводка групп из снимка (plan — Map, как ждёт модуль) и, если
  // администратор разрешил, правка темы и примечания через гостевой эндпоинт.
  function tablesCtx() {
    const summary = (state.db && state.db.groupsSummary) || {};
    const teacherGroups = new Map(Object.entries(summary).map(([g, d]) => [g, {
      subjects: d.subjects || {},
      plan: d.plan ? new Map(Object.entries(d.plan)) : null,
    }]));
    return {
      teacherGroups,
      groupSubjects: (state.db && state.db.groupSubjects) || {},
      kind: state.kind,
      onlyGroups: state.kind === 'subject' ? state.subjGroups : null,
      dateOf,
      // Вид занятия (столбец 7) — списком: только практические пары и только на
      // практический вид. Список видов приходит в снимке публикации; у старого
      // снимка его нет — тогда вид просто не правится.
      editable: state.canEdit
        ? { 7: { field: 'type', options: (state.db && state.db.practicalTypes) || [] }, 8: 'topic', 12: 'note' }
        : {},
      save: (id, field, value) => api.put(`/api/guest/lesson/${id}`, {
        [field]: value,
        publicationId: state.db.publicationId,
      }),
      onSaved: () => {
        const sum = $('grid').querySelector('.sem-summary');
        if (sum) sum.outerHTML = teacherSummary(lessonsFor());
      },
      toast,
      onOpen: (id) => {
        const l = (state.db.lessons || []).find((x) => x.id === id);
        if (l) openLessonDetails(l);
      },
    };
  }

  // Месяц и семестр на всю кафедру не читаются — вкладки гасим, пока открыт
  // вид «Кафедра». Сводное и «День» кафедру не спрашивают: они показывают
  // группы и вид переключают сами.
  function syncDeptModes() {
    const dept = state.kind === 'dept';
    $('deptKind').hidden = !dept;
    document.querySelectorAll('.view-modes [data-mode]').forEach((b) => {
      b.disabled = dept && (b.dataset.mode === 'month' || b.dataset.mode === 'semester');
    });
  }

  /* ---------- Сводное: фильтр курсов и тумблер преподавателя ---------- */
  // Оба элемента — только вид: данные снимка не меняются, выбор хранится локально.
  function syncSummaryControls() {
    const on = isSummary();
    $('crsFilter').hidden = !on;
    if (!on) $('crsFilter').open = false;
    // Тумблер «Преподаватель» нужен и в семестре с месяцем: ФИО в их карточках
    // тоже есть, значит и гасить его должно там же, где он виден.
    $('sumTeacherWrap').hidden = !on && state.mode !== 'semester' && state.mode !== 'month';
  }

  function bindSummaryControls() {
    try {
      state.sumHiddenCourses = new Set(JSON.parse(localStorage.getItem('sumHiddenCourses') || '[]'));
    } catch { /* повреждённое значение — считаем, что скрытых нет */ }
    state.sumTeacher = localStorage.getItem('sumTeacher') !== '0';
    const box = $('crsFilterList');
    box.addEventListener('change', () => {
      state.sumHiddenCourses = new Set([...box.querySelectorAll('.crs-vis:not(:checked)')].map((cb) => cb.value));
      localStorage.setItem('sumHiddenCourses', JSON.stringify([...state.sumHiddenCourses]));
      render();
    });
    const box2 = $('sumTeacherToggle');
    box2.checked = state.sumTeacher;
    box2.onchange = () => {
      state.sumTeacher = box2.checked;
      localStorage.setItem('sumTeacher', box2.checked ? '1' : '0');
      render();
    };
    syncSummaryControls();
  }

  // Группы сводного: все группы снимка минус скрытые фильтром «🎓 Курсы».
  // Один список и для сетки, и для выгрузки — что на экране, то и в файле.
  function summaryGroups() {
    const shown = (state.db.groups || []).filter(
      (g) => !state.sumHiddenCourses.has(SC.courseKeyOf(g, state.db.courses))
    );
    // В виджете столбцы всегда идут курсами: 1 → 5, «без курса» в конец
    // (SC.groupsByCourse так и сортирует). На сайте порядок групп не трогаем —
    // там он привычен составителю.
    if (!document.body.classList.contains('widget')) return shown;
    return SC.groupsByCourse(shown, state.db.courses).flatMap((c) => c.groups);
  }

  // Первая группа каждого курса, кроме самого левого: по ней рисуется жирный
  // разделитель между курсами. Только в виджете — там столбцы отсортированы.
  function courseEdges(groups) {
    const edges = new Set();
    if (!document.body.classList.contains('widget')) return edges;
    let prev = null;
    for (const g of groups) {
      const key = SC.courseKeyOf(g, state.db.courses);
      if (prev !== null && key !== prev) edges.add(g);
      prev = key;
    }
    return edges;
  }

  function renderCrsFilter(all) {
    const box = $('crsFilterList');
    box.innerHTML = SC.courseFilterHtml(all, state.db.courses, state.sumHiddenCourses)
      || '<div class="muted-hint">Нет групп</div>';
    const off = box.querySelectorAll('.crs-vis:not(:checked)').length;
    $('crsFilterCount').textContent = off ? `(скрыто ${off})` : '';
  }

  // Сводное расписание: все группы по столбцам, строки — день × пара, за выбранную неделю.
  // Сегодняшний день сетки. Воскресенья в расписании нет, поэтому в воскресенье
  // показываем понедельник — ближайший учебный день.
  function todayDay() {
    const idx = (new Date().getDay() + 6) % 7;   // 0 = Пн … 6 = Вс
    return DAYS[Math.min(idx, DAYS.length - 1)];
  }

  // Строки сводной таблицы: вся неделя или один день (вид «День»).
  function summaryDays() {
    if (state.mode !== 'day') return DAYS;
    return [DAYS.includes(state.day) ? state.day : todayDay()];
  }

  function renderSummary() {
    const all = state.db.groups || [];
    const days = summaryDays();
    $('title').textContent = state.mode === 'day'
      ? `Сводное расписание · ${days[0]} ${dateOf(state.week, days[0]) || ''}`.trim()
      : `Сводное расписание · неделя ${state.week}`;
    renderCrsFilter(all);
    // Скрытые курсы просто не рисуем — занятия остальных групп не трогаются.
    const groups = summaryGroups();
    if (!all.length) { $('grid').innerHTML = '<p class="file-status">Нет групп для сводного вида.</p>'; return; }
    if (!groups.length) { $('grid').innerHTML = '<p class="file-status">Все курсы скрыты фильтром «🎓 Курсы» — включите нужные.</p>'; return; }

    const wk = (state.db.lessons || []).filter((l) => l.weekNo === state.week);
    const at = (g, d, p) => wk.filter((l) => l.day === d && l.pairNo === p && (l.groups || []).includes(g));

    const edges = courseEdges(groups);
    let html = `<div class="grid-scroll"><table class="grid semester summary gsum" style="${SC.summaryFontVars(groups.length)}"><thead><tr>`;
    html += '<th class="day-col">День</th><th class="pair-col">Часы</th>';
    for (const g of groups) html += `<th class="grp-head${edges.has(g) ? ' crs-edge' : ''}">${esc(g)}</th>`;
    html += '</tr></thead><tbody>';
    for (const d of days) {
      const dayPairs = SC.pairsForDay(d);
      for (let pi = 0; pi < dayPairs.length; pi++) {
        const p = dayPairs[pi];
        html += '<tr>';
        if (pi === 0) {
          const dt = dateOf(state.week, d);
          html += `<td class="day-col" rowspan="${dayPairs.length}">${d}${dt ? `<br><small class="cell-date">${esc(dt)}</small>` : ''}</td>`;
        }
        html += `<td class="pair-col">${SC.pairHours(p)}<br>${PAIR_TIMES[p]}</td>`;
        for (const g of groups) {
          const cell = at(g, d, p);
          html += `<td class="slot${cell.some(isEvent) ? ' slot-event' : ''}${edges.has(g) ? ' crs-edge' : ''}" data-group="${esc(g)}" data-day="${esc(d)}" data-pair="${p}">`;
          for (const l of cell) html += summaryCard(l);
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('grid').innerHTML = html;
    fillHlValues();
    applyHighlights();
  }

  // Карточка сводного вида (взгляд группы): вид, дисциплина, аудитория, преподаватель.
  function summaryCard(l) {
    if (isEvent(l)) return eventCard(l);
    const teacher = l.teacher ? esc(l.teacher) : (l.subject === 'СР' ? '' : '<span class="warn">?</span>');
    return (
      `<div class="lesson src ${SC.assessmentKind(l.type)}${movedClass(l)}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="l1">${esc(l.type || '')}</div>` +
      `<div class="l2">${esc(l.subject || '—')}</div>` +
      `<div class="l3">${esc(roomStr(l) || '—')}</div>` +
      (state.sumTeacher ? `<div class="l4">${teacher}</div>` : '') + '</div>'
    );
  }

  /* ----------------------- Подробности занятия ----------------------- */
  // «Тема 1»/«Т1»/«Т. 1»/«Т.1» → «Т.1»; прочее оставляем как есть.
  function topicLabel(t) {
    if (!t) return '';
    const m = String(t).match(/^(?:Тема|Т)\.?\s*(\d+)$/i);
    return m ? `Т.${m[1]}` : String(t);
  }

  // Поле карточки, открытое тем же тумблером, что и перечень занятий: список
  // (options) или поле ввода. Значение вне options не правится — так вид занятия
  // остаётся только для чтения у лекций и форм контроля: их кодов в списке нет.
  function lmField(el, l, field, text, options) {
    const v = l[field] || '';
    if (!state.canEdit || (options && !options.includes(v))) { el.textContent = text; return; }
    el.innerHTML = options
      ? `<select class="lm-inp" data-field="${field}">`
        + options.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')
        + '</select>'
      : `<input type="text" class="lm-inp" data-field="${field}" value="${esc(v)}">`;
  }

  function openLessonDetails(l) {
    fillMovedBanner(l);
    $('lmSubject').textContent = l.subjectFull || l.subject || '—';
    lmField($('lmType'), l, 'type', l.typeFull || l.type || '—', (state.db && state.db.practicalTypes) || []);
    lmField($('lmTopic'), l, 'topic', topicLabel(l.topic) || '—');
    $('lmTeacher').textContent = l.teacher || '— не задан —';
    $('lmRoom').textContent = roomStr(l) || '—';
    $('lmGroups').textContent = (l.groups || []).join(', ') || '—';
    const dt = l.date || dateOf(l.weekNo, l.day);
    $('lmSlot').textContent =
      `${l.day}, часы ${SC.pairHours(l.pairNo)} (${PAIR_TIMES[l.pairNo] || ''}), неделя ${l.weekNo}${dt ? ` (${dt})` : ''}`;
    lmField($('lmNote'), l, 'note', l.note || '—');
    detailsLesson = l;
    $('lmFreeSlots').hidden = !state.canMoves;
    $('lessonModal').classList.add('open');
  }

  // Плашка «перенесено» в карточке — та же логика, что в журнале админки:
  // последний перенос (предыдущая ячейка → текущая) и последняя смена аудитории.
  // Тумблер пометок её не гасит: он про полосу в сетке.
  function fillMovedBanner(l) {
    const banner = $('lmMoved');
    const lines = SC.movedLines(movedEntryFor(l));
    banner.textContent = lines.join('\n');
    banner.style.whiteSpace = 'pre-line';
    banner.hidden = !lines.length;
  }

  let detailsLesson = null; // занятие, открытое в карточке

  function closeLessonModal() {
    $('lessonModal').classList.remove('open');
  }

  // Сохранение правки из карточки. Правится ТО ЖЕ занятие, что и в перечне:
  // detailsLesson — объект из state.db.lessons, поэтому после ответа сервера
  // хватает перерисовать сетку, чтобы правка была видна и в ячейках, и в таблицах.
  async function saveLessonField(inp) {
    const l = detailsLesson;
    if (!l) return;
    const field = inp.dataset.field;
    const value = inp.value.trim();
    const before = l[field] || '';
    if (value === before) return;
    try {
      await api.put(`/api/guest/lesson/${l.id}`, {
        [field]: value || null,
        publicationId: state.db.publicationId,
      });
      l[field] = value || null;
      toast('Сохранено');
      render();
    } catch (err) {
      inp.value = before; // не сохранилось — возвращаем прежнее значение
      toast(((err.data && err.data.reasons) || [err.message]).join('; '), true);
    }
  }

  // Делегированный клик по любой карточке занятия + закрытие модалки.
  function setupLessonDetails() {
    $('lessonModal').addEventListener('change', (e) => {
      const inp = e.target.closest('.lm-inp');
      if (inp) saveLessonField(inp);
    });
    // Enter сохраняет поле, не перезагружая страницу.
    $('lessonModal').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('lm-inp')) e.target.blur();
    });
    $('lmFreeSlots').onclick = () => {
      if (!detailsLesson) return;
      closeLessonModal();
      showFreeSlots(detailsLesson);
      toast('Подсвечены свободные окна: группа и преподаватель свободны. Перенос в гостевом просмотре недоступен.');
    };
    $('grid').addEventListener('click', (e) => {
      const el = e.target.closest('.lesson');
      // Клик мимо занятия — снимаем подсветку свободных окон.
      if (!el || !el.dataset.lesson) { clearFreeSlots(); return; }
      try {
        // data-lesson — снимок на момент отрисовки; правим и показываем сам объект.
        const snap = JSON.parse(el.dataset.lesson);
        openLessonDetails((state.db.lessons || []).find((x) => x.id === snap.id) || snap);
      } catch {
        /* битые данные — игнорируем */
      }
    });
    document.querySelectorAll('[data-modal-close]').forEach((b) => { b.onclick = closeLessonModal; });
    $('lessonModal').addEventListener('click', (e) => {
      if (e.target === $('lessonModal')) closeLessonModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeLessonModal();
      clearFreeSlots();
    });
  }

  // Значения занятия по выбранному параметру подсветки: аудиторий может быть
  // две, групп у потока — несколько.
  function hlValuesOf(l, kind) {
    if (kind === 'room') return roomsOf(l);
    if (kind === 'group') return l.groups || [];
    return l.subject ? [l.subject] : [];
  }

  function fillHlValues() {
    const sel = $('hlValue');
    const { kind, value } = state.hl;
    if (!kind) { sel.innerHTML = '<option value="">—</option>'; return; }
    const set = new Set();
    document.querySelectorAll('#grid .lesson[data-lesson]').forEach((c) => {
      try {
        for (const v of hlValuesOf(JSON.parse(c.dataset.lesson), kind)) if (v) set.add(v);
      } catch { /* ignore */ }
    });
    const values = [...set].sort((a, b) => a.localeCompare(b, 'ru'));
    // Выбранное значение остаётся в списке, даже если на этой неделе его нет:
    // иначе пролистывание расписания сбрасывало бы подсветку.
    const missing = value && !values.includes(value);
    sel.innerHTML = '<option value="">—</option>'
      + (missing ? `<option value="${esc(value)}">${esc(value)} (нет здесь)</option>` : '')
      + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = value || '';
  }

  function applyHighlights() {
    const { kind, value } = state.hl;
    const cards = document.querySelectorAll('#grid .lesson[data-lesson]');
    if (!kind || !value) {
      cards.forEach((c) => c.classList.remove('hl', 'hl-dim'));
      return;
    }
    cards.forEach((c) => {
      try {
        const l = JSON.parse(c.dataset.lesson);
        const matches = hlValuesOf(l, kind).includes(value);
        c.classList.toggle('hl', matches);
        c.classList.toggle('hl-dim', !matches);
      } catch { /* ignore */ }
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
