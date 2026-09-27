// Логика админки: импорт, три представления, перенос, проверка ошибок, публикация.
(function () {
  'use strict';

  // Доменные константы — из общего модуля /js/shared-constants.js.
  const SC = window.SCHED_CONST;
  const DAYS = SC.DAYS.slice(0, 6); // в сетке — Пн..Сб
  const PAIRS = Array.from({ length: SC.PAIRS_PER_DAY }, (_, i) => i + 1);
  const PAIR_TIMES = Object.fromEntries(
    Object.entries(SC.PAIR_TIMES).map(([p, t]) => [p, `${t.start}<br>${t.end}`])
  );
  const KIND_LABEL = { group: 'Группа', teacher: 'Преподаватель', room: 'Аудитория', subject: 'Дисциплина' };
  // Сколько держать всплывающие уведомления/подсказки (тост и окно ошибки), мс.
  const HINT_MS = 20000;

  const state = { kind: 'group', entityId: null, week: 1, mode: 'semester', summaryKind: 'group', entities: null, lessons: [], semester: null, user: null, myGroupsOnly: true, hl: { kind: '', value: '' }, hl2: { kind: '', value: '' }, hlAny: false, holidays: new Set(), statsTab: 'teachers', statsDepts: new Set(), legend: {}, groupSubjects: {}, errors: {}, courses: {}, relocated: new Set(), srUnplaced: null, dateNotes: [], roomPlan: null, relief: null, teacherGroups: null, subjGroups: null, subjAllGroups: [] };
  const $ = (id) => document.getElementById(id);

  // Пометки «перенесено»: по занятию — сколько записей в цепочке журнала, последний
  // перенос и последняя смена аудитории. Считает сервер (GET /api/move-log/marks,
  // то же уходит гостям в снимок), весь журнал ради полосы в сетке не грузим.
  // Ключ — '#id'; у старых записей без id — ячейка «куда» (SC.movedKey).
  // Очистка журнала → пометок нет.
  let movedIndex = new Map();
  function movedEntryFor(l) {
    return movedIndex.get(`#${l.id}`)
      || movedIndex.get(SC.movedKey(l.day, l.pairNo, l.weekNo, l.subject, l.groups))
      || null;
  }
  // Полоса «перенесено» рисуется только при включённом тумблере (settings.moveMarks,
  // общий с гостевой страницей) — у занятий, которые переносили ИЛИ которым меняли
  // аудиторию (одна полоса на оба случая; что именно менялось — в карточке).
  // Плашка в карточке и журнал от тумблера не зависят.
  let moveMarks = true;
  function movedClass(l) {
    return moveMarks && movedEntryFor(l) ? 'moved' : '';
  }

  // Поток — занятие сразу у нескольких групп. Подсветка включается чекбоксом.
  function streamClass(l) {
    return (l.groups || []).length > 1 ? 'stream' : '';
  }

  async function loadMoveMarks() {
    try {
      const { marks } = await api.get('/api/move-log/marks');
      movedIndex = new Map((marks || []).map((m) => [m.key, m]));
    } catch {
      movedIndex = new Map();
    }
  }

  // «Опубликовать» подсвечивается, пока есть правки, которых гости ещё не видят.
  async function syncPublishState() {
    let unpublished = false;
    try {
      ({ unpublished } = await api.get('/api/publish/status'));
    } catch {
      /* старый сервер — без подсветки */
    }
    const btn = $('btnPublish');
    btn.classList.toggle('pending', Boolean(unpublished));
    btn.textContent = unpublished ? 'Опубликовать •' : 'Опубликовать';
    btn.title = unpublished ? 'Есть изменения, которых гости ещё не видят' : 'Гости видят актуальное расписание';
  }

  // Дата (дд.мм) для недели и дня по настройке семестра. null — если не задан.
  function dateOf(weekNo, day) {
    const sem = state.semester;
    if (!sem || !sem.start || !weekNo) return null;
    const idx = DAYS.indexOf(day);
    if (idx < 0) return null;
    const d = new Date(sem.start + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow + (weekNo - 1) * 7 + idx);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`;
  }

  // Число учебных недель в семестре (зеркало utils/calendar.weekCount): по датам
  // start/end семестра. Если семестр не задан — fallback на максимум недель в
  // данных, но не меньше 26. Используется для выпадающего списка недель,
  // навигации и сетки статистики (раньше было захардкожено 26).
  function semesterWeeks() {
    const sem = state.semester;
    if (sem && sem.start && sem.end) {
      const a = new Date(sem.start + 'T00:00:00Z');
      const b = new Date(sem.end + 'T00:00:00Z');
      if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
        a.setUTCDate(a.getUTCDate() - ((a.getUTCDay() + 6) % 7)); // понедельник недели 1
        const n = Math.floor((b.getTime() - a.getTime()) / (7 * 86400000)) + 1;
        if (n >= 1) return n;
      }
    }
    const maxData = (state.lessons || []).reduce((m, l) => Math.max(m, l.weekNo || 0), 0);
    return Math.max(maxData, 26);
  }

  const currentWeek = () => SC.weekNoOn(
    (state.semester || {}).start,
    new Date(),
    semesterWeeks()
  ) || 1;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    let auth;
    try {
      auth = await api.get('/api/auth/check');
      if (!auth.authenticated) return (location.href = '/login.html');
    } catch {
      return (location.href = '/login.html');
    }

    state.user = auth.user || null;
    bindEvents();
    applyRoleUi();
    maybeShowDefaultPwBanner(auth.usingDefaults);
    setupBufferDrop();
    setupErrorTooltip();
    setupRoomPlanTip();
    setupReliefTip();
    setupCopyPaste();
    applyBufferCollapsed(localStorage.getItem('bufferCollapsed') === '1');
    applySidebarCollapsed(localStorage.getItem('sidebarCollapsed') === '1');
    syncSummaryControls();
    // Вид страницы (что было открыто до F5) — до загрузки списков: от kind
    // зависит, какой список объектов строить.
    const savedView = readView();
    if (savedView) restoreView(savedView);
    await loadSemester();
    state.week = currentWeek();
    fillWeeks();
    // Недель в семестре могло стать меньше — тогда возвращаемся на первую.
    $('weekSelect').value = String(state.week);
    if (!$('weekSelect').value) { state.week = 1; $('weekSelect').value = '1'; }
    syncWeekNav();
    await loadCourses(); // до loadEntities: по курсам строится список групп
    await loadEntities();
    restoreEntity(savedView);
    await loadHolidays();
    await loadLegend();
    await loadGroupSubjects();
    await loadDateNotes();
    await loadHeadcounts();
    await loadRoomNotes();
    await loadAppearance();
    refreshUndo();
    render();
    // Правки, сделанные в другом окне, подхватываются сами — без перезагрузки.
    api.watchChanges(async () => {
      // Идёт выбор ячейки (перенос, копирование, блокировка) — перерисовка стёрла
      // бы подсветку свободных окон из-под руки. Отказываемся: обновимся, как
      // только выбор закончится (watchChanges повторит на следующем тике).
      if (dragLesson || $('gridWrap').querySelector('td.slot.free-target')) return false;
      await refreshEntities(); // чужой импорт мог добавить/убрать группы и аудитории
      await loadDateNotes(); // и примечания к датам могли поправить в другом окне
      render();
    });
  }

  function applyRoleUi() {
    const admin = state.user && state.user.role === 'admin';
    const adminIds = [
      'btnSemester', 'btnCourses', 'btnAliases', 'btnRefs', 'btnEvents', 'btnHolidays',
      'btnAppearance', 'btnUsers', 'btnPublish', 'guestExport', 'guestMoves', 'guestColors',
      'widgetHost', 'btnArchives', 'btnClearSchedule', 'btnReset', 'fileInput', 'folderInput',
      'btnPickFolder', 'importMerge', 'importAutoOffset', 'importTeacherFilter', 'importOffset',
      'btnImport', 'btnSortTopics', 'btnPlaceSR', 'btnRemoveSR', 'btnRoomPlanCfg',
      'btnDecommission', 'btnClearHiddenGroups', 'btnBlockCells', 'bufferClear',
    ];
    for (const id of adminIds) {
      const el = $(id);
      if (!el) continue;
      const holder = el.closest('label') || el;
      holder.hidden = !admin;
    }
    $('pwTarget').querySelector('option[value="reset"]').hidden = !admin;
    if (!admin) $('pwTarget').value = 'login';
    for (const id of ['dNewRoom', 'dNewRoom2', 'alNewRoom', 'alNewRoom2', 'alNewSubject', 'alIsEvent']) {
      const el = $(id);
      if (el) (el.closest('label') || el).hidden = !admin;
    }
  }

  let usersData = [];
  let accessCatalog = { departments: [], groups: [] };
  let userGroupSelection = new Set();

  async function openUsers() {
    try {
      const [u, c] = await Promise.all([api.get('/api/users'), api.get('/api/access-catalog')]);
      usersData = u.users || [];
      accessCatalog = c;
      renderUsersList();
      selectUser(usersData.find((x) => x.role === 'editor') || null);
      $('usersModal').classList.add('open');
    } catch (err) { toast(err.message, true); }
  }

  function renderUsersList() {
    $('usersList').innerHTML = usersData.map((u) =>
      `<button type="button" class="user-row${u.active ? '' : ' inactive'}" data-user-id="${u.id}">`
      + `<b>${esc(u.username)}</b>${u.displayName ? `<div>${esc(u.displayName)}</div>` : ''}`
      + `<small>${u.role === 'admin' ? 'Администратор' : `Групп: ${(u.effectiveGroups || []).length}`}</small></button>`
    ).join('');
    $('usersList').querySelectorAll('[data-user-id]').forEach((b) => {
      b.onclick = () => selectUser(usersData.find((u) => u.id === Number(b.dataset.userId)));
    });
  }

  function selectUser(user) {
    $('userMsg').textContent = '';
    $('userId').value = user ? user.id : '';
    $('userVersion').value = user ? user.version : '';
    $('userLogin').value = user ? user.username : '';
    $('userLogin').disabled = Boolean(user);
    $('userDisplayName').value = user ? user.displayName : '';
    $('userActive').checked = user ? user.active : true;
    $('userActiveWrap').hidden = !user || user.role === 'admin';
    $('userPasswordFields').hidden = Boolean(user);
    $('userPassword').value = '';
    $('userPassword2').value = '';
    $('userResetPassword').hidden = !user || user.role === 'admin';
    $('userForm').querySelector('button[type="submit"]').hidden = Boolean(user && user.role === 'admin');
    $('usersList').querySelectorAll('.user-row').forEach((b) => b.classList.toggle('active', user && Number(b.dataset.userId) === user.id));
    const deps = new Set((user && user.departments) || []);
    $('userDepartments').innerHTML = accessCatalog.departments.length
      ? accessCatalog.departments.map((d) => `<label class="chk-lbl"><input type="checkbox" name="userDept" value="${esc(d)}"${deps.has(d) ? ' checked' : ''}> ${esc(d)}</label>`).join('')
      : '<span class="muted-hint">У групп не указаны кафедры</span>';
    $('userDepartments').onchange = updateUserEffective;
    userGroupSelection = new Set(user ? (user.manualGroups || []) : []);
    renderUserGroups();
    updateUserEffective();
  }

  function renderUserGroups() {
    const q = $('userGroupSearch').value.trim().toLowerCase();
    const rows = (accessCatalog.groups || []).filter((g) => !q || g.name.toLowerCase().includes(q) || g.dept.toLowerCase().includes(q));
    $('userGroups').innerHTML = rows.map((g) =>
      `<label class="chk-lbl"><input type="checkbox" name="userGroup" value="${esc(g.name)}"${userGroupSelection.has(g.name) ? ' checked' : ''}> ${esc(g.name)}${g.dept ? ` <small>(${esc(g.dept)})</small>` : ''}</label>`
    ).join('') || '<span class="muted-hint">Ничего не найдено</span>';
    $('userGroups').onchange = (e) => {
      if (e.target.name === 'userGroup') {
        if (e.target.checked) userGroupSelection.add(e.target.value);
        else userGroupSelection.delete(e.target.value);
      }
      updateUserEffective();
    };
  }

  function userPermissionForm() {
    return {
      departments: [...$('userDepartments').querySelectorAll('input:checked')].map((x) => x.value),
      manualGroups: [...userGroupSelection],
    };
  }

  function updateUserEffective() {
    const p = userPermissionForm();
    const depts = new Set(p.departments);
    const effective = new Set(p.manualGroups);
    for (const g of accessCatalog.groups || []) if (g.dept && depts.has(g.dept)) effective.add(g.name);
    $('userEffective').textContent = effective.size
      ? `Итоговый доступ: ${effective.size} групп — ${[...effective].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })).join(', ')}`
      : 'Пользователь сможет только просматривать расписание.';
  }

  async function saveUser(e) {
    e.preventDefault();
    $('userMsg').textContent = '';
    const id = Number($('userId').value) || null;
    const perms = userPermissionForm();
    try {
      if (!id) {
        if ($('userPassword').value !== $('userPassword2').value) throw new Error('Пароли не совпадают');
        await api.post('/api/users', {
          username: $('userLogin').value, displayName: $('userDisplayName').value,
          password: $('userPassword').value, ...perms,
        });
      } else {
        await apiRequestUserPatch(id, perms);
      }
      toast(id ? 'Пользователь и права обновлены' : 'Пользователь создан');
      await openUsers();
    } catch (err) { $('userMsg').textContent = err.message; }
  }

  async function apiRequestUserPatch(id, perms) {
    return api.patch(`/api/users/${id}`, {
      displayName: $('userDisplayName').value,
      active: $('userActive').checked,
      expectedVersion: Number($('userVersion').value),
      ...perms,
    });
  }

  async function resetUserPassword() {
    const id = Number($('userId').value);
    if (!id) return;
    const password = window.prompt('Введите новый пароль (минимум 8 символов):');
    if (password == null) return;
    try {
      await api.post(`/api/users/${id}/password-reset`, { password });
      toast('Пароль задан, прежние сессии завершены');
    } catch (err) { $('userMsg').textContent = err.message; }
  }

  async function loadLegend() {
    try {
      const { legend } = await api.get('/api/legend');
      state.legend = legend || {};
    } catch {
      state.legend = {};
    }
  }

  // Курсы: { "<префикс группы>": номер курса } — для группировки списка групп по курсам.
  async function loadCourses() {
    try {
      const { courses } = await api.get('/api/courses');
      state.courses = courses || {};
    } catch {
      state.courses = {};
    }
  }

  // Карта «группа → таблица дисциплин из её HTML-файла» (для расписания группы).
  async function loadGroupSubjects() {
    try {
      const { groupSubjects } = await api.get('/api/group-subjects');
      state.groupSubjects = groupSubjects || {};
    } catch {
      state.groupSubjects = {};
    }
  }

  async function loadSemester() {
    try {
      const { semester } = await api.get('/api/semester');
      state.semester = semester || null;
    } catch {
      state.semester = null;
    }
  }

  function bindEvents() {
    $('btnLogout').onclick = async () => {
      await api.post('/api/logout');
      location.href = '/login.html';
    };
    $('viewKind').onchange = async (e) => {
      exitBlockMode();
      state.kind = e.target.value;
      // Выделение относилось к прежнему представлению: в расписании аудитории
      // выделенная группа или дисциплина уже про другое — сбрасываем.
      resetHighlights();
      fillEntities();
      render();
    };
    $('entitySelect').onchange = (e) => {
      exitBlockMode();
      state.entityId = e.target.value;
      state.subjGroups = null; // у другой дисциплины свои группы
      render();
    };
    bindSubjGroups();
    $('weekSelect').onchange = (e) => {
      exitBlockMode();
      state.week = Number(e.target.value);
      syncWeekNav();
      render();
    };
    $('weekPrev').onclick = () => stepWeek(-1);
    $('weekNext').onclick = () => stepWeek(1);

    // Горячие клавиши ← / →: в семестровом виде листают объект (группа/препод./
    // аудитория), в недельном и сводном — учебные недели. Не перехватываем,
    // если фокус в поле ввода, открыта модалка или идёт выбор ячейки в сетке.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (pickMode || blockMode) return;
      if (document.querySelector('.modal-backdrop.open')) return;
      const t = e.target;
      if (t && (t.matches('input, select, textarea') || t.isContentEditable)) return;
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      if (state.mode === 'semester') {
        e.preventDefault();
        stepEntity(delta);
      } else if (state.mode === 'week' || state.mode === 'summary') {
        e.preventDefault();
        stepWeek(delta);
      }
    });
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = (event) => {
        exitBlockMode();
        if (event.isTrusted && (b.dataset.mode === 'week' || b.dataset.mode === 'summary')) {
          state.week = currentWeek();
          $('weekSelect').value = String(state.week);
        }
        applyMode(b.dataset.mode);
        render();
      };
    });
    // Переключение содержимого сводного: группы ↔ аудитории.
    $('summaryKind').onchange = (e) => {
      state.summaryKind = e.target.value;
      syncSummaryControls();
      render();
    };
    // Тумблер «Преподаватель»: только вид сводного, данные не трогаются.
    $('sumTeacherToggle').checked = sumTeacher;
    $('sumTeacherToggle').onchange = (e) => {
      sumTeacher = e.target.checked;
      localStorage.setItem('sumTeacher', sumTeacher ? '1' : '0');
      render();
    };
    // Фильтр столбцов сводного: показать все / скрыть все.
    $('grpFilterAll').onclick = () => setHiddenSummaryGroups([]);
    $('grpFilterNone').onclick = () => setHiddenSummaryGroups(state.summaryGroups);
    // Кнопки экспорта устроены одинаково: блокируем кнопку на время запроса
    // (сборка файла по шаблону занимает секунды), затем показываем результат.
    // Файл отдаётся в браузер и сохраняется туда, куда настроены загрузки.
    const exportBtn = (id, busy, run) => {
      $(id).onclick = async () => {
        const btn = $(id);
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = busy;
        try {
          const res = await run();
          if (res) toast(res);
        } catch (err) {
          toast(err.message, true);
        } finally {
          btn.disabled = false;
          btn.textContent = old;
        }
      };
    };
    // Что не поместилось в шаблон — отдельным сообщением, иначе потеря молчит.
    const exportWarnings = (res) => {
      if (res.warnings && res.warnings.length) toast(res.warnings.join('; '), true);
    };
    // Печать — родная браузерная: что скрыть на листе, решает @media print в
    // styles.css, тёмную тему на время печати снимает theme.js.
    $('btnPrint').onclick = () => window.print();
    exportBtn('btnExportGroup', '…сохраняю', async () => {
      if (state.kind !== 'group' || !state.entityId) {
        throw new Error('Выберите группу в списке слева — выгружается расписание открытой группы');
      }
      const res = await api.download('/api/export/group', { group: state.entityId });
      exportWarnings(res);
      return `Скачивается файл ${res.filename}`;
    });
    exportBtn('btnExportTeacher', '…сохраняю', async () => {
      if (state.kind !== 'teacher' || !state.entityId) {
        throw new Error('Выберите преподавателя в списке слева — выгружается расписание открытого преподавателя');
      }
      const res = await api.download('/api/export/teacher', { teacher: state.entityId });
      return `Скачивается файл ${res.filename}`;
    });
    exportBtn('btnExportGroups', '…формирую', async () => {
      const res = await api.download('/api/export/groups', {});
      exportWarnings(res);
      return `Скачивается архив ${res.filename}`;
    });
    exportBtn('btnExportWeekly', '…сохраняю', async () => {
      const res = await api.download('/api/export/weekly', { weekNo: state.week, groups: exportSummaryGroups() });
      return `Скачивается файл ${res.filename}`;
    });
    exportBtn('btnExportSummary', '…формирую', async () => {
      const res = await api.download('/api/export/summary', { groups: exportSummaryGroups() });
      return `Скачивается файл ${res.filename} (неделя — отдельный лист)`;
    });
    $('btnExportSubject').onclick = openSubjectExport;
    $('seCancel').onclick = () => $('subjExportModal').classList.remove('open');
    $('seSubject').onchange = () => fillSubjectGroups($('seSubject').value);
    $('seAll').onclick = () => setSubjectGroups(true);
    $('seNone').onclick = () => setSubjectGroups(false);
    $('seSave').onclick = downloadSubjectSchedule;
    $('bufferToggle').onclick = toggleBuffer;
    $('bufferClear').onclick = clearBuffer;
    $('orphanClear').onclick = clearOrphans;
    $('sidebarToggle').onclick = toggleSidebar;
    // Клик по СВЁРНУТОЙ полоске разворачивает её целиком. Сворачивание — только
    // кнопкой-стрелкой: обработчик панели лишь разворачивает, а клик по самой
    // кнопке пропускаем (её переключает toggle*), поэтому двойного срабатывания нет.
    document.querySelector('.sidebar').addEventListener('click', (e) => {
      if (e.target.closest('#sidebarToggle')) return;
      if (document.querySelector('.admin-layout').classList.contains('sidebar-collapsed')) {
        applySidebarCollapsed(false);
        localStorage.setItem('sidebarCollapsed', '0');
      }
    });
    document.querySelector('.buffer').addEventListener('click', (e) => {
      if (e.target.closest('#bufferToggle')) return;
      if (document.querySelector('.admin-layout').classList.contains('buffer-collapsed')) {
        applyBufferCollapsed(false);
        localStorage.setItem('bufferCollapsed', '0');
      }
    });
    $('btnImport').onclick = doImport;
    $('importAutoOffset').onchange = (e) => {
      $('offsetManualWrap').hidden = e.target.checked;
    };
    $('btnPickFolder').onclick = () => $('folderInput').click();
    $('fileInput').onchange = updateImportPicked;
    $('folderInput').onchange = updateImportPicked;
    $('btnErrors').onclick = checkErrors;
    $('btnHolidays').onclick = openHolidays;
    $('btnAppearance').onclick = openAppearance;
    $('appSave').onclick = saveAppearance;
    $('appReset').onclick = resetAppearance;
    $('appCancel').onclick = () => { $('appearanceModal').classList.remove('open'); revertAppearance(); };
    $('btnStats').onclick = () => {
      state.mode = 'stats';
      document.querySelectorAll('.view-modes .tab').forEach((b) => b.classList.remove('active'));
      $('weekSelect').disabled = true;
      syncWeekNav();
      render();
    };
    $('btnTeachers').onclick = () => {
      state.mode = 'teachers';
      document.querySelectorAll('.view-modes .tab').forEach((b) => b.classList.remove('active'));
      $('weekSelect').disabled = true;
      syncWeekNav();
      render();
    };
    $('holidaysCancel').onclick = () => $('holidaysModal').classList.remove('open');
    $('holidaysSave').onclick = saveHolidays;
    $('btnUndo').onclick = doUndo;
    $('btnPublish').onclick = doPublish;
    setupGuestEdit();
    setupMoveMarks();
    $('btnRefs').onclick = openRefs;
    $('btnEvents').onclick = openEvents;
    $('btnSemester').onclick = openSemester;
    $('btnCourses').onclick = openCourses;
    $('coursesCancel').onclick = () => $('coursesModal').classList.remove('open');
    $('coursesSave').onclick = saveCourses;
    $('btnAliases').onclick = openAliases;
    $('aliasesAdd').onclick = () => $('aliasesList').insertAdjacentHTML('beforeend', aliasRow('', ''));
    $('aliasesCancel').onclick = () => $('aliasesModal').classList.remove('open');
    $('aliasesSave').onclick = saveAliases;
    $('importProblemsCancel').onclick = () => $('importProblemsModal').classList.remove('open');
    $('importProblemsApply').onclick = applyImportProblems;
    $('btnArchives').onclick = openArchives;
    $('btnUsers').onclick = openUsers;
    $('usersClose').onclick = () => $('usersModal').classList.remove('open');
    $('userNew').onclick = () => selectUser(null);
    $('userForm').onsubmit = saveUser;
    $('userGroupSearch').oninput = renderUserGroups;
    $('userResetPassword').onclick = resetUserPassword;
    $('myGroupsToggle').onclick = () => {
      state.myGroupsOnly = !state.myGroupsOnly;
      fillEntities();
      $('myGroupsToggle').textContent = state.myGroupsOnly ? 'Показать все группы' : 'Показать мои группы';
      render();
    };
    $('arcClose').onclick = () => $('archivesModal').classList.remove('open');
    $('arcCreate').onclick = createArchive;
    $('arcImport').onclick = () => $('arcFile').click();
    $('arcFile').onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importArchiveFile(file);
    };
    $('arcList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.arc-row');
      if (btn.dataset.act === 'restore') restoreArchive(row);
      else deleteArchive(row);
    });
    $('arcList').addEventListener('change', (e) => {
      const inp = e.target.closest('.arc-note-inp');
      if (inp) saveArchiveNote(inp);
    });
    $('btnReset').onclick = () => {
      $('resetPass').value = '';
      $('resetMsg').textContent = '';
      $('resetModal').classList.add('open');
    };
    $('resetCancel').onclick = () => $('resetModal').classList.remove('open');
    $('resetConfirm').onclick = doReset;
    $('btnClearSchedule').onclick = doClearSchedule;
    $('btnPassword').onclick = openPassword;
    $('pwCancel').onclick = () => $('passwordModal').classList.remove('open');
    $('pwConfirm').onclick = doChangePassword;
    $('roomCancel').onclick = () => $('roomModal').classList.remove('open');
    $('refClose').onclick = () => $('refModal').classList.remove('open');
    $('semCancel').onclick = () => $('semesterModal').classList.remove('open');
    $('semSave').onclick = saveSemester;
    $('semStart').onchange = updateWeekCount;
    $('semEnd').onchange = updateWeekCount;
    $('detailsCancel').onclick = () => $('detailsModal').classList.remove('open');
    $('detailsSave').onclick = saveDetails;
    $('detailsDelete').onclick = deleteLesson;
    $('detailsLock').onclick = toggleLock;
    // Смена основного преподавателя — перестроить список дополнительных (без него).
    $('dTeacher').onchange = rebuildExtraTeachers;
    // Отметка дополнительного — обновить подпись свёрнутого блока (без перестроения).
    $('dExtraTeachers').onchange = showExtraCount;
    // Флажки массовой смены преподавателя — взаимоисключающие (режим один).
    const bulkBoxes = ['dReplaceTeacher', 'dReplaceTeacherType', 'dSetTeacherAll'];
    for (const id of bulkBoxes) {
      $(id).onchange = () => {
        if (!$(id).checked) return;
        for (const other of bulkBoxes) if (other !== id) $(other).checked = false;
      };
    }
    // Смена слота в карточке — обновить дату и список свободных аудиторий.
    // Смена аудитории/групп меняет расклад по местам — обновляем подсказку.
    $('dRoom').addEventListener('change', detailsUpdateNeed);
    $('dRoom2').addEventListener('change', detailsUpdateNeed);
    $('dGroups').addEventListener('change', detailsUpdateNeed);
    $('dDay').onchange = () => { detailsUpdateDate(); fillDetailsRooms(); };
    $('dPair').onchange = () => fillDetailsRooms();
    $('dWeek').onchange = () => { detailsUpdateDate(); fillDetailsRooms(); };
    $('dDate').onchange = () => {
      const s = dateToWeekDay($('dDate').value);
      if (s) { $('dWeek').value = s.weekNo; $('dDay').value = s.day; fillDetailsRooms(); }
    };
    $('btnAddLesson').onclick = openAddLesson;
    $('btnPlaceSR').onclick = placeSelfStudy;
    $('btnRemoveSR').onclick = clearSelfStudy;
    $('btnRoomPlan').onclick = openRoomPlan;
    $('btnRoomPlanCfg').onclick = openRoomPlanCfg;
    $('rpSave').onclick = saveRoomPlanCfg;
    $('rpClose').onclick = () => $('rpModal').classList.remove('open');
    $('btnPair4').onclick = () => openPair4Relief();
    $('btnSortTopics').onclick = sortTopics;
    $('btnVacation').onclick = openVacation;
    $('btnDeleteEntity').onclick = doDeleteEntity;
    $('vacCancel').onclick = () => $('vacationModal').classList.remove('open');
    $('vacSave').onclick = saveVacation;
    fillVacReasons();
    $('vacReason').onchange = () => { $('vacCustom').hidden = $('vacReason').value !== '__custom'; };
    $('btnDecommission').onclick = openDecommission;
    $('btnClearHiddenGroups').onclick = clearHiddenGroupLessons;
    $('btnBlockCells').onclick = startBlockMode;
    $('blockDone').onclick = exitBlockMode;
    $('decommCancel').onclick = () => $('decommModal').classList.remove('open');
    $('decommSave').onclick = saveDecommission;
    $('asCancel').onclick = () => $('addSubjectModal').classList.remove('open');
    $('asSave').onclick = saveNewSubject;
    $('asPick').onchange = applySubjectPick;
    $('dnCancel').onclick = () => $('dateNoteModal').classList.remove('open');
    $('dnSave').onclick = saveDateNote;
    $('dnDelete').onclick = deleteDateNote;
    $('alCancel').onclick = () => $('addLessonModal').classList.remove('open');
    $('alSave').onclick = saveNewLesson;
    $('alIsEvent').onchange = applyEventMode;
    $('alDay').onchange = () => { fillAddRooms(); alUpdateDate(); };
    $('alPair').onchange = fillAddRooms;
    $('alWeek').onchange = () => { fillAddRooms(); alUpdateDate(); };
    // Проверка «влезает ли группа»: пересчитываем при смене аудиторий.
    $('alRoom').addEventListener('change', alUpdateNeed);
    $('alRoom2').addEventListener('change', alUpdateNeed);
    $('alDate').onchange = () => {
      const s = dateToWeekDay($('alDate').value);
      if (s) { $('alWeek').value = s.weekNo; $('alDay').value = s.day; fillAddRooms(); }
    };
    $('alSubject').onchange = () => renderTeacherOptions($('alSubject').value);
    $('alTeacher').onchange = () => renderSubjectOptions($('alTeacher').value);
    $('alFindSlot').onclick = startSlotPick;
    $('moveCancel').onclick = exitMoveMode;
    $('pickCancel').onclick = () => {
      exitPickMode();
      $('addLessonModal').classList.add('open');
    };
    // Клик по подсвеченной ячейке в режиме выбора — выбрать слот для занятия.
    $('gridWrap').addEventListener('click', (e) => {
      // Дисциплины группы: добавить строку / удалить строку с её занятиями.
      if (e.target.closest('#btnAddSubject')) return openAddSubject();
      const del = e.target.closest('.subj-del-btn');
      if (del) return deleteSubjectRow(Number(del.dataset.index), del.dataset.abbr);
      // Свёртка кафедры в виде «Преподаватели».
      const dhead = e.target.closest('tr.tchr-dept');
      if (dhead) return toggleTeacherDept(dhead);
      // Переключение учёта зачёта/экзамена в сумме часов столбца «Уч. план».
      const tog = e.target.closest('.ss-plan-tog');
      if (tog) {
        const s = tog.dataset.subj;
        const opt = { ...planOptOf(s) };
        opt[tog.dataset.kind] = !opt[tog.dataset.kind];
        planHoursOpt.set(s, opt);
        buildSemesterGrid(state.lessons);
        return;
      }
      if (moveMode) {
        const cell = e.target.closest('td.slot.free-target');
        if (cell) { onDrop(cell); exitMoveMode(); }
        return;
      }
      if (blockMode) {
        const bcell = e.target.closest('td.slot.block-target');
        if (bcell) handleBlockCellClick(bcell);
        return;
      }
      if (!pickMode) return;
      const cell = e.target.closest('td.slot.pick-target');
      if (cell) finishSlotPick(cell);
    });
    // Редактирование таблицы «Дисциплины и преподаватели» и строк вида «Преподаватели».
    $('gridWrap').addEventListener('change', (e) => {
      const inp = e.target.closest('.subj-input');
      if (inp) return saveSubjectRow(inp);
      if (e.target.matches('.tchr-dept-inp')) saveTeacherRow(e.target);
    });
    // Enter сохраняет только в однострочных полях; в textarea — перенос строки.
    $('gridWrap').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT'
        && (e.target.classList.contains('subj-input') || e.target.classList.contains('tchr-dept-inp'))) {
        e.target.blur();
      }
    });
    // Авто-рост многострочных полей при вводе.
    $('gridWrap').addEventListener('input', (e) => {
      if (e.target.matches('textarea.subj-input')) autoGrow(e.target);
    });
    // Esc отменяет режим выбора и возвращает форму.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pickMode) {
        exitPickMode();
        $('addLessonModal').classList.add('open');
      }
      if (e.key === 'Escape' && blockMode) {
        exitBlockMode();
      }
    });
    document.querySelectorAll('[data-ref-tab]').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('[data-ref-tab]').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        loadRefList(t.dataset.refTab);
      };
    });
    // Закрытие модального окна по клику на фон (вне .modal).
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.remove('open');
      });
    });
    setupModalA11y();
    // Два независимых параметра выделения. Сочетаются «И», а с галочкой «Любое
    // из двух» — «ИЛИ».
    const bindHl = (kindSel, valueSel, hl) => {
      $(kindSel).onchange = (e) => {
        hl.kind = e.target.value;
        hl.value = '';
        $(valueSel).disabled = !e.target.value;
        fillHlValues();
        applyHighlights();
      };
      $(valueSel).onchange = (e) => {
        hl.value = e.target.value;
        applyHighlights();
      };
    };
    bindHl('hlKind', 'hlValue', state.hl);
    bindHl('hlKind2', 'hlValue2', state.hl2);
    // Частый случай — посмотреть, где стоят 4-е пары (часы 7-8): кнопка ставит
    // первым параметром выделения «Пара = 4», повторное нажатие его снимает.
    $('hlPair4').onclick = () => {
      const on = state.hl.kind === 'pair' && state.hl.value === '4';
      state.hl.kind = on ? '' : 'pair';
      state.hl.value = on ? '' : '4';
      fillHlValues();
      applyHighlights();
    };
    // Сброс обоих параметров выделения одной кнопкой.
    $('hlReset').onclick = resetHighlights;
    $('hlAny').onchange = (e) => {
      state.hlAny = e.target.checked;
      applyHighlights();
    };
    $('hlStream').onchange = (e) => {
      document.body.classList.toggle('highlight-streams', e.target.checked);
      saveView();
    };
  }

  // Доступность всех модальных окон. Окна открываются/закрываются в ~40 местах
  // переключением класса .open, поэтому ARIA-роль вешаем один раз, а фокус ловим
  // через MutationObserver на класс — без правок этих мест.
  function setupModalA11y() {
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let lastFocused = null;

    document.querySelectorAll('.modal-backdrop').forEach((modal, i) => {
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const h = modal.querySelector('h3');
      if (h) {
        if (!h.id) h.id = `modal-title-${i}`;
        modal.setAttribute('aria-labelledby', h.id);
      }
      // Открытие: запомнить активный элемент и перевести фокус в окно.
      // Закрытие: вернуть фокус туда, откуда окно открыли.
      new MutationObserver(() => {
        if (modal.classList.contains('open')) {
          lastFocused = document.activeElement;
          const first = modal.querySelector(FOCUSABLE);
          if (first) first.focus();
        } else if (lastFocused) {
          lastFocused.focus();
          lastFocused = null;
        }
      }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    // Esc закрывает верхнее открытое окно; Tab держит фокус внутри него.
    document.addEventListener('keydown', (e) => {
      const modal = document.querySelector('.modal-backdrop.open');
      if (!modal) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        modal.classList.remove('open');
        return;
      }
      if (e.key === 'Tab') {
        const items = [...modal.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  function fillWeeks() {
    const cur = $('weekSelect').value;
    $('weekSelect').innerHTML = Array.from({ length: semesterWeeks() }, (_, i) => {
      const w = i + 1;
      return `<option value="${w}">${esc(weekLabel(w))}</option>`;
    }).join('');
    if (cur) $('weekSelect').value = cur;
    syncWeekNav();
  }

  // Переключение недели кнопками ◀ ▶ (с зажимом в диапазон 1..кол-во недель семестра).
  function stepWeek(delta) {
    if ($('weekSelect').disabled) return;
    const next = Math.min(semesterWeeks(), Math.max(1, Number(state.week) + delta));
    if (next === state.week) return;
    exitBlockMode();
    state.week = next;
    $('weekSelect').value = String(next);
    syncWeekNav();
    render();
  }

  // Переключение объекта (группа/преподаватель/аудитория) ← / → в семестровом
  // виде: листаем по списку #entitySelect в пределах диапазона.
  function stepEntity(delta) {
    const sel = $('entitySelect');
    const opts = [...sel.options].filter((o) => o.value);
    if (!opts.length) return;
    let idx = opts.findIndex((o) => o.value === state.entityId);
    if (idx < 0) idx = 0;
    const next = Math.min(opts.length - 1, Math.max(0, idx + delta));
    if (next === idx) return;
    state.entityId = opts[next].value;
    sel.value = state.entityId;
    render();
  }

  // Блокируем стрелки в «Семестре» и на границах диапазона недель.
  function syncWeekNav() {
    const semester = state.mode === 'semester';
    $('weekPrev').disabled = semester || state.week <= 1;
    $('weekNext').disabled = semester || state.week >= semesterWeeks();
  }

  // Подпись недели с диапазоном дат: «Неделя 1 (01.09 - 06.09)».
  function weekLabel(w) {
    const mon = dateOf(w, 'Пн');
    const sat = dateOf(w, 'Сб');
    return mon && sat ? `Неделя ${w} (${mon} - ${sat})` : `Неделя ${w}`;
  }

  async function loadEntities() {
    state.entities = await api.get('/api/entities');
    fillEntities();
  }

  function fillEntities() {
    let list = (state.entities && state.entities[state.kind + 's']) || [];
    const editorGroups = new Set((state.entities && state.entities.editableGroups) || []);
    const toggle = $('myGroupsToggle');
    toggle.hidden = !(state.kind === 'group' && state.user && state.user.role !== 'admin');
    if (!toggle.hidden && state.myGroupsOnly) list = list.filter((g) => editorGroups.has(g));
    // У аудиторий в подписи — кафедра, примечание и число мест (roomsInfo из
    // /api/entities). Значение option остаётся голым именем: по нему идут запросы.
    const label = optionLabeller();
    const option = (n) => `<option value="${esc(n)}">${esc(label(n))}</option>`;
    $('entitySelect').innerHTML = list.length
      ? (state.kind === 'group' ? SC.courseOptionsHtml(list, state.courses, option) : list.map(option).join(''))
      : `<option value="">${state.kind === 'group' && state.myGroupsOnly ? '— нет назначенных групп —' : '— нет данных —'}</option>`;
    // Первой берём не list[0], а первый пункт списка: у групп порядок задают курсы.
    state.entityId = ($('entitySelect').options[0] || {}).value || null;
    fillSubjGroups();
  }

  // Раскрытие списка и отметки. Галочка сразу перерисовывает сетку — отдельной
  // кнопки «Показать» нет: список маленький, а результат виден мгновенно.
  function bindSubjGroups() {
    const btn = $('subjGroupsBtn');
    const list = $('subjGroupsList');
    btn.onclick = () => {
      const open = list.hidden;
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    document.addEventListener('click', (e) => {
      if (list.hidden) return;
      if (e.target.closest('#subjGroupsWrap')) return;
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    list.addEventListener('change', (e) => {
      const all = subjGroupsAll();
      const t = e.target;
      if (t.id === 'subjGroupsAll') {
        list.querySelectorAll('.subj-group').forEach((cb) => { cb.checked = t.checked; });
      } else if (!t.classList.contains('subj-group') && !t.classList.contains('crs-all')) {
        return;
      }
      // Галочки курса проставляются на перехвате (bindCourseChecks), поэтому
      // выбор просто читаем из DOM — и для курса, и для отдельной группы.
      state.subjGroups = new Set([...list.querySelectorAll('.subj-group:checked')].map((cb) => cb.value));
      const master = $('subjGroupsAll');
      if (master) master.checked = state.subjGroups.size === all.length;
      SC.bindCourseChecks(list);
      updateSubjGroupsBtn(all);
      render();
    });
  }

  /* ---------- Вид «Дисциплина»: выбор учебных групп галочками ---------- */
  // Показываем всю дисциплину сразу, а список групп сужает выдачу. Выбор живёт в
  // state.subjGroups (Set) и сбрасывается при смене дисциплины: у другой
  // дисциплины свои группы. null = «все» (пока список ещё не построен).
  function fillSubjGroups() {
    const wrap = $('subjGroupsWrap');
    wrap.hidden = state.kind !== 'subject';
    if (wrap.hidden) {
      state.subjGroups = null;
      $('subjGroupsList').hidden = true;
      return;
    }
    // Группы считаются по занятиям дисциплины, а они грузятся в render(): здесь
    // только сбрасываем выбор, иначе он остался бы от прежней дисциплины.
    state.subjGroups = null;
    $('subjGroupsList').innerHTML = '';
    $('subjGroupsBtn').textContent = 'Группы: все';
  }

  // Все группы открытой дисциплины: запомнены в render() ДО фильтрации по
  // галочкам — иначе снятие последней галочки убирало бы и сам список.
  const subjGroupsAll = () => state.subjAllGroups || [];

  function renderSubjGroups(all) {
    const list = $('subjGroupsList');
    const picked = state.subjGroups || new Set(all);
    list.innerHTML = all.length
      ? `<label class="pick-item"><input type="checkbox" id="subjGroupsAll"${picked.size === all.length ? ' checked' : ''}> <b>Выделить все</b></label>` +
        SC.courseGroupsHtml(all, state.courses, (g) =>
          `<label class="pick-item"><input type="checkbox" class="subj-group" value="${esc(g)}"${picked.has(g) ? ' checked' : ''}> ${esc(g)}</label>`)
      : '<div class="muted-hint">Нет групп</div>';
    SC.bindCourseChecks(list);
    updateSubjGroupsBtn(all);
  }

  function updateSubjGroupsBtn(all) {
    const picked = state.subjGroups || new Set(all);
    const btn = $('subjGroupsBtn');
    btn.textContent = picked.size === all.length
      ? `Группы: все (${all.length})`
      : `Группы: ${picked.size} из ${all.length}`;
  }

  // Как подписывать элемент селектора «Объект»: аудитории — с их справкой,
  // группы и преподаватели — просто именем.
  function optionLabeller() {
    if (state.kind !== 'room') return (n) => n;
    const info = new Map(((state.entities && state.entities.roomsInfo) || []).map((r) => [r.name, r]));
    return (n) => SC.roomLabel(info.get(n) || { name: n });
  }

  /* ------------------- Вид страницы переживает F5 ------------------- */
  // Вкладку обновляют часто (правки в другом окне, перезапуск сервера), и каждый
  // раз возвращаться к «группе, первой в списке» неудобно. sessionStorage, а не
  // localStorage: у каждой вкладки свой вид — два окна админки не перетирают
  // выбор друг друга, а после закрытия вкладки состояние не копится.
  const VIEW_KEY = 'adminView';

  function saveView() {
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({
        kind: state.kind, entityId: state.entityId, week: state.week, mode: state.mode,
        summaryKind: state.summaryKind, hl: state.hl, hl2: state.hl2, hlAny: state.hlAny,
        hlStream: $('hlStream').checked,
      }));
    } catch { /* приватный режим или переполнение — вид просто не запомнится */ }
  }

  function readView() {
    try { return JSON.parse(sessionStorage.getItem(VIEW_KEY)) || null; } catch { return null; }
  }

  // Синхронизация интерфейса с режимом просмотра: вкладка, доступность выбора
  // недели и элементы сводного. Общая для кнопок-вкладок и восстановления вида.
  function applyMode(mode) {
    state.mode = mode;
    const tab = document.querySelector(`.view-modes .tab[data-mode="${mode}"]`);
    document.querySelectorAll('.view-modes .tab').forEach((b) => b.classList.toggle('active', b === tab));
    $('weekSelect').disabled = !tab || mode === 'semester';
    $('summaryKind').hidden = mode !== 'summary';
    syncSummaryControls();
    syncWeekNav();
  }

  // Восстановление вида ДО загрузки списков: от kind зависит, какой список
  // объектов строить. Сам объект возвращает restoreEntity — уже после загрузки.
  function restoreView(v) {
    if (v.kind && KIND_LABEL[v.kind]) { state.kind = v.kind; $('viewKind').value = v.kind; }
    if (v.week) state.week = Number(v.week) || 1;
    if (v.summaryKind) { state.summaryKind = v.summaryKind; $('summaryKind').value = v.summaryKind; }
    // ТОЛЬКО правка на месте: обработчики селекторов выделения (bindHl) держат
    // ссылку на эти объекты с момента bindEvents. Замена объекта осиротила бы
    // обработчики — выбранное значение уходило бы «в никуда», а селектор
    // сбрасывался бы обратно.
    if (v.hl) Object.assign(state.hl, { kind: v.hl.kind || '', value: v.hl.value || '' });
    if (v.hl2) Object.assign(state.hl2, { kind: v.hl2.kind || '', value: v.hl2.value || '' });
    state.hlAny = !!v.hlAny;
    $('hlAny').checked = state.hlAny;
    $('hlStream').checked = !!v.hlStream;
    document.body.classList.toggle('highlight-streams', !!v.hlStream);
    if (v.mode) applyMode(v.mode);
  }

  // Объект возвращаем ПОСЛЕ загрузки списков: fillEntities ставит первый пункт,
  // а сохранённого объекта может уже не быть (переимпорт, удаление, скрытие).
  function restoreEntity(v) {
    const sel = $('entitySelect');
    if (!v || !v.entityId || ![...sel.options].some((o) => o.value === v.entityId)) return;
    state.entityId = v.entityId;
    sel.value = v.entityId;
  }

  let renderGeneration = 0;
  async function render() {
    const generation = ++renderGeneration;
    saveView(); // вид запоминается при каждой перерисовке — отдельных вызовов не нужно
    const title = $('gridTitle');
    renderBuffer(); // буфер обновляется при каждом рендере
    renderOrphans(); // и полоса «Не размещённые при импорте»
    // Пометки «перенесено» (снимаются после очистки журнала) и подсветка «Опубликовать».
    await Promise.all([loadMoveMarks(), syncPublishState()]);
    if (generation !== renderGeneration) return;
    // Кнопка «Отпуск» — в расписании преподавателя и группы (с разной подписью).
    const vacKind = state.kind === 'teacher' || state.kind === 'group';
    $('btnVacation').hidden = !vacKind || !state.entityId;
    $('btnVacation').textContent = state.kind === 'group' ? '🏖 Отпуск группы' : '🏖 Отпуск преподавателя';
    // «Вывод аудитории» — только в расписании аудитории.
    $('btnDecommission').hidden = state.kind !== 'room' || !state.entityId;
    // «Удалить занятия скрытых групп» — только в расписании преподавателя.
    $('btnClearHiddenGroups').hidden = state.kind !== 'teacher' || !state.entityId;
    // «Заблокировать ячейки» — только в расписании преподавателя, и только там,
    // где реально видна сетка с кликабельными ячейками (неделя/семестр, не сводное/статистика).
    const blockAvailable = state.kind === 'teacher' && !!state.entityId && (state.mode === 'week' || state.mode === 'semester');
    $('btnBlockCells').hidden = !blockAvailable;
    if (!blockAvailable) exitBlockMode();
    $('btnDeleteEntity').hidden = !state.entityId;
    // «Подобрать аудитории» — только в сводном: перестановки ищутся по всей неделе.
    $('btnRoomPlan').hidden = state.mode !== 'summary';
    $('btnRoomPlanCfg').hidden = state.mode !== 'summary';
    if (state.mode !== 'summary') hideRoomPlan();
    // «Разгрузить 4-ю пару» — в расписании группы: ищем по всем её 4-м парам.
    const reliefAvailable = state.kind === 'group' && !!state.entityId && (state.mode === 'week' || state.mode === 'semester');
    $('btnPair4').hidden = !reliefAvailable;
    if (!reliefAvailable || (state.relief && state.relief.group !== state.entityId)) hideRelief();
    if (state.mode === 'stats') return renderStats();
    if (state.mode === 'teachers') return renderTeachers();
    if (state.mode === 'summary') return state.summaryKind === 'room' ? renderRoomSummary() : renderSummary();
    if (!state.entityId) {
      title.textContent = 'Загрузите расписание (нет данных)';
      $('gridWrap').innerHTML = '';
      return;
    }
    const data = await api.get(`/api/schedule?view=${state.kind}&id=${encodeURIComponent(state.entityId)}`);
    if (generation !== renderGeneration) return;
    state.lessons = data.lessons || [];
    state.semester = data.semester || null;
    // Дисциплина: сначала узнаём её группы (список галочек строится по занятиям),
    // потом оставляем в сетке только занятия отмеченных групп.
    if (state.kind === 'subject') {
      // Список групп считаем по ВСЕМ занятиям дисциплины и запоминаем: state.lessons
      // ниже фильтруется, и по нему группы «исчезали» бы вместе со снятыми галочками.
      state.subjAllGroups = [...new Set(state.lessons.flatMap((l) => l.groups || []))]
        .sort((a, b) => a.localeCompare(b, 'ru'));
      if (!state.subjGroups) state.subjGroups = new Set(state.subjAllGroups);
      renderSubjGroups(state.subjAllGroups);
      const picked = state.subjGroups;
      state.lessons = state.lessons.filter((l) => (l.groups || []).some((g) => picked.has(g)));
    }
    const subjTail = state.kind === 'subject' ? ` · группы: ${[...(state.subjGroups || [])].sort().join(', ') || '—'}` : '';
    if (state.mode === 'semester') {
      title.textContent = `${KIND_LABEL[state.kind]}: ${state.entityId}${subjTail} · весь семестр`;
      state.planCheck = state.kind === 'group' ? await loadPlanCheck(state.entityId) : null;
      if (state.kind === 'teacher') await loadLessonTypes(); // список «Вид» в перечне занятий
      state.teacherGroups = state.kind === 'teacher'
      ? await loadGroupsSummary(`/api/teacher-groups?teacher=${encodeURIComponent(state.entityId)}`)
      : state.kind === 'subject'
        ? await loadGroupsSummary(`/api/subject-groups?subject=${encodeURIComponent(state.entityId)}`)
        : null;
      buildSemesterGrid(state.lessons);
    } else {
      title.textContent = `${KIND_LABEL[state.kind]}: ${state.entityId}${subjTail} · неделя ${state.week}`;
      buildGrid(state.lessons);
    }
  }

  function bindLessonClicks() {
    $('gridWrap').querySelectorAll('.lesson').forEach((el) => {
      const lesson = JSON.parse(el.dataset.lesson);
      const editable = lesson.editable !== false;
      el.classList.toggle('read-only', !editable);
      if (!editable) {
        el.draggable = false;
        el.removeAttribute('draggable');
        el.title = `${el.title ? `${el.title}\n` : ''}🔒 Только просмотр — ${lesson.readOnlyReason || 'чужая группа'}`;
      }
      el.onclick = () => openDetails(lesson);
    });
    applyErrorMarks();
    applyRelocatedMarks();
  }

  // Подсветка ячеек с ошибками + данные для всплывающей подсказки. Берёт карту
  // state.errors (id занятия → [{kind, detail, suggestion}]) и проставляет класс
  // has-error и dataset.errs на карточки. Вызывается после каждого ре-рендера.
  function applyErrorMarks() {
    const map = state.errors || {};
    const hasAny = Object.keys(map).length > 0;
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      el.classList.remove('has-error');
      delete el.dataset.errs;
      if (!hasAny) return;
      let l;
      try { l = JSON.parse(el.dataset.lesson); } catch { return; }
      const errs = map[l.id];
      if (errs && errs.length) {
        el.classList.add('has-error');
        el.dataset.errs = JSON.stringify(errs);
      }
    });
  }

  // Всплывающее окно с ошибкой(ами) и подсказкой по исправлению при наведении.
  function setupErrorTooltip() {
    let tip = $('errTooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'errTooltip';
      tip.className = 'err-tooltip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    const grid = $('gridWrap');
    grid.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.lesson.has-error');
      if (!el || !el.dataset.errs) return;
      let errs;
      try { errs = JSON.parse(el.dataset.errs); } catch { return; }
      // Описание занятия (нативный title) показываем ВНУТРИ окна ошибки и убираем
      // сам title — иначе браузерная подсказка перекрывает/сменяет наше окно.
      if (el.dataset.fullTitle == null && el.getAttribute('title') != null) {
        el.dataset.fullTitle = el.getAttribute('title');
      }
      el.removeAttribute('title');
      const info = el.dataset.fullTitle || '';
      tip.innerHTML =
        errs
          .map((x) =>
            `<div class="et-item"><div class="et-detail">${esc(x.detail)}</div>` +
            (x.suggestion ? `<div class="et-sug">💡 ${esc(x.suggestion)}</div>` : '') +
            `</div>`)
          .join('') +
        (info ? `<div class="et-item et-info">${esc(info).replace(/\n/g, '<br>')}</div>` : '');
      tip.hidden = false;
    });
    grid.addEventListener('mousemove', (e) => {
      if (tip.hidden) return;
      const pad = 14;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, y) + 'px';
    });
    grid.addEventListener('mouseout', (e) => {
      if (e.target.closest('.lesson.has-error')) tip.hidden = true;
    });
  }

  /* ---------- Сводное представление (столбцы — группы) ---------- */
  // Шрифт сводной сетки по числу столбцов — общий с гостевым видом (SC).
  const summaryFontVars = SC.summaryFontVars;

  // Набор из localStorage: фильтры сводного общие на весь браузер, поэтому
  // читаем их же и перед выгрузкой — в соседней вкладке набор могли изменить
  // уже после загрузки этой страницы.
  const readHidden = (key) => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch {
      return new Set(); // повреждённое значение — считаем, что скрытых нет
    }
  };

  // Скрытые столбцы-группы сводного: только вид, данные не трогаются. Помним
  // между сессиями — набор групп у пользователя устойчив.
  let sumHidden = readHidden('sumHiddenGroups');
  let lastSummary = null; // последний ответ /api/summary — чтобы перерисовать фильтр без запроса

  // Скрытые курсы: фильтр «🎓 Курсы» убирает из сводного все группы курса разом.
  // Ключ курса — номер строкой, '' — группы с ненастроенным префиксом.
  let sumHiddenCourses = readHidden('sumHiddenCourses');
  const courseKey = (c) => (c == null || c === '' ? '' : String(c));

  // Показывать ли преподавателя в карточках сводного (тумблер рядом с вкладками).
  let sumTeacher = localStorage.getItem('sumTeacher') !== '0';

  // Фильтры и тумблер сводного: «👁 Группы» и «🎓 Курсы» — только в сводном по
  // группам (в сводном по аудиториям столбцы другие), тумблер — в обоих.
  // Тумблер «Преподаватель» показываем и в семестровой сетке: ФИО в её карточках
  // тоже есть, значит и гасить его должно там же, где он виден.
  function syncSummaryControls() {
    const byGroup = state.mode === 'summary' && state.summaryKind === 'group';
    for (const id of ['grpFilter', 'crsFilter']) {
      $(id).hidden = !byGroup;
      if ($(id).hidden) $(id).open = false;
    }
    $('sumTeacherWrap').hidden = state.mode !== 'summary' && state.mode !== 'semester';
  }

  // Список курсов галочками + счётчик скрытых у кнопки. Курсы берём по ВСЕМ
  // группам базы, а не по столбцам недели: иначе курс, у которого на этой
  // неделе нет занятий, нечем было бы скрыть — и он всё равно попадал бы в
  // выгрузку (столбцы файла считаются по тому же набору).
  function renderCrsFilter(allCols) {
    const box = $('crsFilterList');
    const groups = (state.entities && state.entities.groups) || allCols.map((c) => c.group);
    box.innerHTML = SC.courseFilterHtml(groups, state.courses, sumHiddenCourses)
      || '<div class="file-status">Нет групп</div>';
    const off = box.querySelectorAll('.crs-vis:not(:checked)').length;
    $('crsFilterCount').textContent = off ? `(скрыто ${off})` : '';
    if (!box.dataset.visBound) {
      box.dataset.visBound = '1';
      box.addEventListener('change', () => {
        sumHiddenCourses = new Set([...box.querySelectorAll('.crs-vis:not(:checked)')].map((cb) => cb.value));
        localStorage.setItem('sumHiddenCourses', JSON.stringify([...sumHiddenCourses]));
        if (lastSummary) buildSummaryGrid(lastSummary);
      });
    }
  }

  function setHiddenSummaryGroups(names) {
    sumHidden = new Set(names);
    localStorage.setItem('sumHiddenGroups', JSON.stringify([...sumHidden]));
    if (lastSummary) buildSummaryGrid(lastSummary);
  }

  // Список чекбоксов «какие группы показывать» + счётчик скрытых у кнопки.
  // Группы разбиты по курсам: галочка в заголовке показывает/прячет весь курс.
  function renderGrpFilter(allCols) {
    state.summaryGroups = allCols.map((c) => c.group);
    const hiddenHere = state.summaryGroups.filter((g) => sumHidden.has(g)).length;
    $('grpFilterCount').textContent = hiddenHere ? `(скрыто ${hiddenHere})` : '';
    const box = $('grpFilterList');
    box.innerHTML = SC.courseGroupsHtml(state.summaryGroups, state.courses, (g) =>
      `<label class="chk-lbl"><input type="checkbox" class="grp-vis" value="${esc(g)}"${sumHidden.has(g) ? '' : ' checked'}> ${esc(g)}</label>`);
    SC.bindCourseChecks(box);
    if (!box.dataset.visBound) {
      box.dataset.visBound = '1';
      // Один обработчик на список: и курс, и отдельная группа меняют набор
      // скрытых столбцов одинаково — читаем итог из DOM (галочки курса уже
      // проставлены: bindCourseChecks работает на перехвате).
      box.addEventListener('change', () => {
        const shown = new Set([...box.querySelectorAll('.grp-vis:checked')].map((cb) => cb.value));
        const next = new Set(sumHidden);
        for (const g of state.summaryGroups) {
          if (shown.has(g)) next.delete(g);
          else next.add(g);
        }
        setHiddenSummaryGroups([...next]);
      });
    }
  }

  // Группы для выгрузки сводного в Excel: все группы базы минус скрытые
  // фильтрами «👁 Группы» и «🎓 Курсы» — что видно на экране, то и в файле.
  // Столбцы шаблона сервер подгоняет под этот список (лишние убирает,
  // недостающие добавляет). Фильтры перечитываем из хранилища: их могли
  // поменять в другой вкладке, а переменные этой страницы остались бы прежними.
  function exportSummaryGroups() {
    sumHidden = readHidden('sumHiddenGroups');
    sumHiddenCourses = readHidden('sumHiddenCourses');
    const all = (state.entities && state.entities.groups) || [];
    const shown = all.filter(
      (g) => !sumHidden.has(g) && !sumHiddenCourses.has(SC.courseKeyOf(g, state.courses))
    );
    if (!shown.length) {
      throw new Error('Все группы скрыты фильтрами «👁 Группы» и «🎓 Курсы» — выгружать нечего');
    }
    return shown;
  }

  async function renderSummary() {
    $('gridTitle').textContent = `Сводное расписание · неделя ${state.week}`;
    const data = await api.get(`/api/summary?weekNo=${state.week}`);
    state.semester = data.semester || null;
    buildSummaryGrid(data);
  }

  function buildSummaryGrid(data) {
    lastSummary = data;
    renderGrpFilter(data.columns || []);
    renderCrsFilter(data.columns || []);
    // Скрытые фильтрами группы и курсы просто не рисуем (занятия остаются в базе).
    const cols = (data.columns || []).filter(
      (c) => !sumHidden.has(c.group) && !sumHiddenCourses.has(courseKey(c.course))
    );
    const lessons = data.lessons || [];
    if ((data.columns || []).length && !cols.length) {
      $('gridWrap').innerHTML = '<div class="file-status">Все группы скрыты фильтрами «👁 Группы» и «🎓 Курсы» — включите нужные.</div>';
      return;
    }
    if (!cols.length) {
      $('gridWrap').innerHTML = '<div class="file-status">Нет занятий за эту неделю (или не загружены группы).</div>';
      return;
    }
    const at = (group, day, pair) =>
      lessons.filter((l) => l.day === day && l.pairNo === pair && (l.groups || []).includes(group));

    // Динамический шрифт: чем больше групп, тем мельче — чтобы все столбцы влезли
    // в ширину без горизонтальной прокрутки (table-layout:fixed делит ширину поровну).
    let html = `<div class="grid-scroll"><table class="grid semester summary gsum" style="${summaryFontVars(cols.length)}"><thead><tr>`;
    html += '<th class="day-col">День</th><th class="pair-col">Часы</th>';
    for (const c of cols) {
      html += `<th class="grp-head">${esc(c.group)}<br><small>${c.course ? c.course + ' курс' : '— курс'}</small></th>`;
    }
    html += '</tr></thead><tbody>';

    for (const d of DAYS) {
      const dayPairs = SC.pairsForDay(d);
      const hol = isHolidayDay(state.week, d); // нерабочий день этой недели
      for (let pi = 0; pi < dayPairs.length; pi++) {
        const p = dayPairs[pi];
        html += '<tr>';
        if (pi === 0) {
          const dt = dateOf(state.week, d);
          // Дата в сводном общая для всех столбцов — подсвечиваем, если примечание
          // есть у любой группы (в подсказке — все примечания этой даты).
          const n = dateCellAttrs(state.week, d, '');
          html += `<td class="day-col${hol ? ' holiday-day' : ''}${n.cls}"${n.attrs}${n.tip} rowspan="${dayPairs.length}">${d}${dt ? `<br><small class="cell-date">${esc(dt)}</small>` : ''}${hol ? '<br><small class="hol-label">нерабочий</small>' : ''}</td>`;
        }
        html += `<td class="pair-col">${SC.pairHours(p)}<br>${PAIR_TIMES[p]}</td>`;
        for (const c of cols) {
          const cell = at(c.group, d, p);
          // Свободное окно группы (не нерабочий день) → класс slot-free (зелёная обводка).
          const free = !hol && !cell.length;
          html += `<td class="slot${hol ? ' holiday-col' : ''}${free ? ' slot-free' : ''}" data-group="${esc(c.group)}" data-day="${d}" data-pair="${p}">`;
          for (const l of cell) html += summaryCard(l);
          if (hol && !cell.length) html += '<div class="holiday-mark">Вых</div>';
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('gridWrap').innerHTML = html;
    bindLessonClicks();
    setupDnD();
    fillHlValues();
    applyHighlights();
    applySrUnplaced();
    applyRoomPlanMarks();
  }

  // Подсветка ячеек, которым при расстановке СР не хватило аудитории (группа+слот
  // выбранной недели). Держится до смены недели или повторной расстановки.
  function applySrUnplaced() {
    if (!(state.srUnplaced && state.srUnplaced.week === state.week)) return;
    $('gridWrap').querySelectorAll('td.slot[data-group]').forEach((c) => {
      const key = `${c.dataset.day}|${c.dataset.pair}|${c.dataset.group}`;
      // Подсвечиваем только ещё пустые ячейки (после ручной доустановки СР — пропадает).
      if (!state.srUnplaced.keys.has(key) || c.querySelector('.lesson')) return;
      c.classList.add('sr-unplaced');
      c.title = 'Нет аудитории — нажмите, чтобы увидеть варианты';
      c.onclick = () => openSrHelp(c.dataset.group, c.dataset.day, Number(c.dataset.pair));
    });
  }

  /* ------------- Подбор аудиторий по вместимости (только сводное) ------------- */
  // Считает сервер (/api/room-plan) в пределах открытой недели. Здесь — показ:
  // подсветка занятий в сетке, всплывающее окно с вариантами прямо на ячейке и
  // таблица предложений с галочками под сеткой.
  // Пропущенные занятия помним до следующего нажатия «Подобрать аудитории»:
  // пересчёт после каждого применения иначе возвращал бы их обратно.
  let roomPlanSkipped = new Set();

  async function openRoomPlan(reset = true) {
    if (state.mode !== 'summary' || !state.week) {
      return toast('Откройте сводное расписание — подбор идёт по всей неделе', true);
    }
    if (reset) roomPlanSkipped = new Set();
    const panel = $('optPanel');
    panel.style.display = 'block';
    if (reset) panel.innerHTML = '<div class="err-item">Подбираем варианты…</div>';
    try {
      const r = await api.get(`/api/room-plan?weekNo=${state.week}`);
      // key — устойчивый признак предложения (занятие или блок преподавателя).
      const items = (r.suggestions || []).filter((x) => !roomPlanSkipped.has(x.key));
      for (const s of items) s.pick = 0; // выбранный вариант (индекс в s.options)
      state.roomPlan = { week: state.week, items };
      renderRoomPlan();
      applyRoomPlanMarks();
    } catch (err) {
      panel.innerHTML = `<div class="err-item">${esc(err.message)}</div>`;
    }
  }

  function hideRoomPlan() {
    state.roomPlan = null;
    hideOptTip();
    $('optPanel').style.display = 'none';
  }

  const planOptions = (s) => (s.options && s.options.length ? s.options : [s]);
  // Вид предложения — это правило, которое оно чинит (порядок правил и есть их
  // приоритет, задаётся в «Настройках подбора»). cls — цвет метки и подсветки.
  const RULE_INFO = {
    ctrl: { cls: 'ctrl', why: 'контроль подряд' },
    cc: { cls: 'cc', why: 'комп. класс' },
    teacherGroup: { cls: 'teacher', why: 'одна аудитория' },
    teacherAny: { cls: 'teacher', why: 'одна аудитория' },
    dept: { cls: 'dept', why: 'кафедра' },
    capacity: { cls: 'waste', why: 'вместимость' },
  };
  const ruleInfo = (s) => RULE_INFO[s.kind] || RULE_INFO.capacity;
  // Предложение на несколько занятий сразу (серия подряд идущих пар): такой
  // план применяется целиком, половина плана оставила бы серию разорванной.
  const isBlock = (s) => Array.isArray(s.lessonIds) && s.lessonIds.length > 1;
  const isDept = (s) => s.kind === 'dept';
  const isCc = (s) => s.kind === 'cc';
  // Правило «комп. класс» в обе стороны: занятие зовут В класс (ccNeeds) или
  // класс освобождают от того, кому он не нужен.
  const ccIn = (s) => !!s.ccNeeds;
  // Подпись варианта: куда переставляем и с кем меняемся (если это обмен).
  function optionLabel(o) {
    const where = SC.roomLabel({ ...roomInfoOf(o.toRoom), name: o.toRoom, capacity: o.toCap });
    if (o.action === 'block') {
      const swaps = (o.steps || []).filter((s) => s.action === 'swap').length;
      const moves = (o.steps || []).length - swaps;
      const how = [moves ? `перенос: ${moves}` : '', swaps ? `обмен: ${swaps}` : ''].filter(Boolean).join(', ');
      return `⇒ собрать в ${where} (${how})`;
    }
    return o.action === 'swap'
      ? `⇄ ${where} — обмен с «${o.withSubject || '—'}» (${(o.withGroups || []).join(', ')}, ${o.withNeed} курс.)`
      : `→ ${where} — свободна`;
  }
  // Расшифровка шагов плана блока — показывается в подсказке на ячейке.
  const stepLabel = (st) => (st.action === 'swap'
    ? `${SC.pairHours(st.pairNo)}: обмен с «${st.withSubject || '—'}» (${(st.withGroups || []).join(', ')}) → ${st.toRoom}`
    : `${SC.pairHours(st.pairNo)}: перенос → ${st.toRoom}`);
  // Предложение + выбранный вариант в виде одной записи для /room-plan/apply.
  const planItem = (s, k) => ({ ...s, ...planOptions(s)[k ?? s.pick ?? 0] });

  function renderRoomPlan() {
    const panel = $('optPanel');
    const items = (state.roomPlan && state.roomPlan.items) || [];
    if (!items.length) {
      panel.innerHTML = '<div class="err-head"><h3>Аудитории подобраны оптимально ✔</h3>' +
        '<button type="button" class="btn secondary sm" id="optHide">Скрыть</button></div>';
      $('optHide').onclick = hideRoomPlan;
      return;
    }
    const rows = items.map((s, i) => {
      const what = isBlock(s) || isDept(s)
        ? `${s.teacher}: ${s.subject || '—'} · ${(s.groups || []).join(', ')}`
        : `${s.subject || '—'} · ${(s.groups || []).join(', ')} · ${s.need} курс.`;
      const when = isBlock(s)
        ? `${s.day}, пары ${s.pairs.map((p) => SC.pairHours(p)).join(', ')}`
        : `${s.day}, часы ${SC.pairHours(s.pairNo)}`;
      const info = ruleInfo(s);
      const label = isCc(s) && !ccIn(s) ? 'освободить класс' : info.why;
      const extra = isDept(s) ? ' ' + esc(s.dept) : (isCc(s) && s.type ? ' · ' + esc(s.type) : '');
      const why = `<span class="opt-why opt-why-${info.cls}">${label}${extra}</span>`;
      const opts = planOptions(s);
      // Вариантов может быть несколько — выбор списком прямо в строке.
      const variant = opts.length > 1
        ? `<select class="opt-var" data-i="${i}">${opts.map((o, k) =>
          `<option value="${k}"${k === s.pick ? ' selected' : ''}>${esc(optionLabel(o))}</option>`).join('')}</select>`
        : esc(optionLabel(opts[0]));
      const now = isBlock(s)
        ? `${esc(s.room)} <span class="muted-hint">разные</span>`
        : isDept(s)
          ? `${esc(s.room)} <span class="muted-hint">${s.roomDept ? 'каф. ' + esc(s.roomDept) : 'без кафедры'}</span>`
          : isCc(s)
            ? `${esc(s.room)} <span class="muted-hint">${ccIn(s) ? 'не комп. класс' : 'класс не нужен'}</span>`
            : `${esc(s.room)} <span class="muted-hint">${s.cap} мест</span>`;
      return `<tr><td><input type="checkbox" class="opt-pick" data-i="${i}" checked></td>` +
        `<td>${why}</td><td>${esc(when)}</td><td>${esc(what)}</td>` +
        `<td>${now}</td><td>${variant}</td></tr>`;
    }).join('');
    panel.innerHTML =
      `<div class="err-head"><h3>Предложения по аудиториям: ${items.length}</h3>` +
      '<div class="opt-acts">' +
      '<button type="button" class="btn secondary sm" id="optAll">Отметить все</button>' +
      '<button type="button" class="btn secondary sm" id="optNone">Снять все</button>' +
      '<button type="button" class="btn sm" id="optApply">Применить отмеченные</button>' +
      '<button type="button" class="btn secondary sm" id="optHide">Скрыть</button></div></div>' +
      '<div class="err-hint">Занятия из списка подсвечены в сетке — наведите на такое занятие, чтобы применить или пропустить его отдельно. Цвет метки = правило: контроль подряд, комп. класс, одна аудитория у преподавателя, кафедра, вместимость. Правила идут по приоритету («⚙ Настройки подбора»): предложение никогда не чинит одно правило ценой более важного. Отменить всё можно кнопкой «Отменить».</div>' +
      '<div class="opt-table-wrap"><table class="opt-table"><thead><tr><th></th><th>Причина</th><th>Когда</th><th>Занятие</th><th>Сейчас</th><th>Вариант</th></tr></thead>' +
      `<tbody>${rows}</tbody></table></div>`;
    const setAll = (v) => panel.querySelectorAll('.opt-pick').forEach((c) => { c.checked = v; });
    $('optAll').onclick = () => setAll(true);
    $('optNone').onclick = () => setAll(false);
    $('optHide').onclick = () => { hideRoomPlan(); applyRoomPlanMarks(); };
    $('optApply').onclick = applyCheckedRoomPlan;
    panel.querySelectorAll('.opt-var').forEach((sel) => {
      sel.onchange = () => { items[Number(sel.dataset.i)].pick = Number(sel.value); };
    });
  }

  function applyCheckedRoomPlan() {
    const items = (state.roomPlan && state.roomPlan.items) || [];
    const picked = [...$('optPanel').querySelectorAll('.opt-pick')]
      .filter((c) => c.checked)
      .map((c) => items[Number(c.dataset.i)])
      .filter(Boolean)
      .map((s) => planItem(s));
    if (!picked.length) return toast('Отметьте хотя бы одно предложение', true);
    return applyRoomPlanItems(picked);
  }

  async function applyRoomPlanItems(list) {
    try {
      const r = await api.post('/api/room-plan/apply', { items: list });
      const tail = r.skipped ? ` · пропущено (аудиторию успели занять): ${r.skipped}` : '';
      toast(`Переставлено занятий: ${r.applied}${tail}`, !!r.skipped);
      refreshUndo();
      hideOptTip();
      await render();
      await openRoomPlan(false); // пересчёт: часть предложений уже неактуальна
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  /* -- Всплывающее окно подбора прямо на подсвеченной ячейке (наведение) -- */
  let optTipEl = null;
  let optTipTimer = null;

  function hideOptTip() {
    clearTimeout(optTipTimer);
    if (optTipEl) optTipEl.hidden = true;
  }

  // Окно живёт, пока курсор над карточкой ИЛИ над самим окном: иначе до кнопок
  // «Выполнить»/«Пропустить» не дотянуться.
  function setupRoomPlanTip() {
    optTipEl = document.createElement('div');
    optTipEl.className = 'opt-tip';
    optTipEl.hidden = true;
    document.body.appendChild(optTipEl);
    optTipEl.addEventListener('mouseenter', () => clearTimeout(optTipTimer));
    optTipEl.addEventListener('mouseleave', () => { optTipTimer = setTimeout(hideOptTip, 200); });
    optTipEl.addEventListener('click', onOptTipClick);

    const grid = $('gridWrap');
    grid.addEventListener('mouseover', (e) => {
      const card = e.target.closest && e.target.closest('.lesson.room-waste, .lesson.room-teacher, .lesson.room-dept, .lesson.room-cc, .lesson.room-ctrl');
      if (!card) return;
      const s = planForCard(card);
      if (!s) return;
      clearTimeout(optTipTimer);
      showOptTip(s, card);
    });
    grid.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('.lesson.room-waste, .lesson.room-teacher, .lesson.room-dept, .lesson.room-cc, .lesson.room-ctrl')) return;
      optTipTimer = setTimeout(hideOptTip, 200);
    });
  }

  // Предложение для карточки: занятие может быть и «второй стороной» обмена.
  function planForCard(card) {
    const items = (state.roomPlan && state.roomPlan.items) || [];
    let id;
    try { id = JSON.parse(card.dataset.lesson).id; } catch { return null; }
    return items.find((s) => (s.lessonIds || []).includes(id)) ||
      items.find((s) => s.lessonId === id) ||
      items.find((s) => s.withLessonId === id) || null;
  }

  function showOptTip(s, card) {
    const i = (state.roomPlan.items || []).indexOf(s);
    const opts = planOptions(s);
    // Блок преподавателя: показываем, из каких пар он состоит и что делает план.
    const head = isBlock(s)
      ? `${esc(s.teacher)} · ${esc(s.day)}, пары ${esc(s.pairs.map((p) => SC.pairHours(p)).join(', '))}`
      : `${isDept(s) ? esc(s.teacher) + ' · ' : ''}${esc(s.subject || '—')} · ${esc((s.groups || []).join(', '))} · ${s.need} курс.`;
    const now = isBlock(s)
      ? `Пары идут подряд в разных аудиториях: ${esc(s.room)}`
      : isDept(s)
        ? `Сейчас: ${esc(s.room)} — ${s.roomDept ? 'кафедра ' + esc(s.roomDept) : 'кафедра не задана'}; у преподавателя кафедра ${esc(s.dept)}`
        : isCc(s)
          ? (ccIn(s)
            ? `Сейчас: ${esc(s.room)} — не компьютерный класс, а занятию он нужен`
            : `Сейчас: ${esc(s.room)} — компьютерный класс, а занятию он не нужен: класс освободится`)
          : `Сейчас: ${esc(s.room)} — ${s.cap} мест`;
    const steps = (o) => (o.action === 'block'
      ? `<div class="ot-steps">${(o.steps || []).map((st) => esc(stepLabel(st))).join('<br>')}</div>`
      : '');
    optTipEl.innerHTML =
      `<div class="ot-head">${head}</div>` +
      `<div class="ot-now">${now}</div>` +
      opts.map((o, k) =>
        `<div class="ot-opt"><span>${esc(optionLabel(o))}${steps(o)}</span>` +
        `<button type="button" class="btn sm" data-do="${i}" data-opt="${k}">Выполнить</button></div>`).join('') +
      `<div class="ot-acts"><button type="button" class="btn secondary sm" data-skip="${i}">Пропустить</button></div>`;
    optTipEl.hidden = false;
    // Позиционируем рядом с карточкой, не вылезая за окно.
    const r = card.getBoundingClientRect();
    const t = optTipEl.getBoundingClientRect();
    let x = r.right + 8;
    let y = r.top;
    if (x + t.width > window.innerWidth) x = Math.max(4, r.left - t.width - 8);
    if (y + t.height > window.innerHeight) y = Math.max(4, window.innerHeight - t.height - 4);
    optTipEl.style.left = `${x}px`;
    optTipEl.style.top = `${y}px`;
  }

  function onOptTipClick(e) {
    const doBtn = e.target.closest('[data-do]');
    const items = (state.roomPlan && state.roomPlan.items) || [];
    if (doBtn) {
      const s = items[Number(doBtn.dataset.do)];
      if (s) applyRoomPlanItems([planItem(s, Number(doBtn.dataset.opt))]);
      return;
    }
    const skipBtn = e.target.closest('[data-skip]');
    if (!skipBtn) return;
    const s = items[Number(skipBtn.dataset.skip)];
    if (!s) return;
    // «Пропустить» — только убрать из подбора: расписание не меняется.
    roomPlanSkipped.add(s.key);
    state.roomPlan.items = items.filter((x) => x !== s);
    hideOptTip();
    renderRoomPlan();
    applyRoomPlanMarks();
  }

  // Подсветка занятий, по которым есть предложение (для открытой недели).
  // Цвет — по правилу: контроль, комп. класс, пары преподавателя, кафедра,
  // вместимость. Предложения идут по приоритету, поэтому первое, где занятие
  // встретилось, и есть самое важное для него.
  const MARK_CLASSES = ['ctrl', 'cc', 'teacher', 'dept', 'waste'];
  function applyRoomPlanMarks() {
    const plan = state.roomPlan && state.roomPlan.week === state.week ? state.roomPlan : null;
    const mark = new Map();
    for (const s of (plan ? plan.items : [])) {
      const cls = ruleInfo(s).cls;
      const ids = isBlock(s) ? s.lessonIds : [s.lessonId, s.withLessonId];
      for (const id of ids) if (id != null && !mark.has(id)) mark.set(id, cls);
    }
    const cells = MARK_CLASSES.map((c) => `cell-${c}`);
    const cards = MARK_CLASSES.map((c) => `room-${c}`);
    $('gridWrap').querySelectorAll('td.slot').forEach((c) => c.classList.remove(...cells));
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      el.classList.remove(...cards);
      if (!mark.size) return;
      let l;
      try { l = JSON.parse(el.dataset.lesson); } catch { return; }
      const cls = mark.get(l.id);
      if (!cls) return;
      el.classList.add(`room-${cls}`);
      const cell = el.closest('td.slot');
      if (cell) cell.classList.add(`cell-${cls}`);
    });
  }

  /* ---------------- Настройки подбора (порядок правил = приоритет) ---------- */
  const RULE_TEXT = {
    ctrl: 'Формы контроля подряд — в одной аудитории',
    cc: 'Лабораторные и информатика — в компьютерном классе',
    teacherGroup: 'Пары преподавателя у одной группы — в одной аудитории',
    teacherAny: 'Пары преподавателя у разных групп — в одной аудитории (только свободные)',
    dept: 'Аудитория кафедры преподавателя (только свободные)',
    capacity: 'Аудитория по размеру группы',
  };
  let roomPlanCfg = null;

  async function openRoomPlanCfg() {
    try {
      roomPlanCfg = (await api.get('/api/room-plan/settings')).settings;
    } catch (err) {
      return toast(err.message, true);
    }
    renderRoomPlanCfg();
    $('rpModal').classList.add('open');
  }

  function renderRoomPlanCfg() {
    const cfg = roomPlanCfg;
    $('rpRules').innerHTML = cfg.rules.map((r, i) =>
      '<div class="rp-rule">' +
      `<label class="chk-lbl"><input type="checkbox" class="rp-on" data-i="${i}"${r.on ? ' checked' : ''}> ` +
      `${i + 1}. ${esc(RULE_TEXT[r.id] || r.id)}</label>` +
      `<span class="rp-move"><button type="button" class="btn secondary sm" data-up="${i}"${i ? '' : ' disabled'}>↑</button>` +
      `<button type="button" class="btn secondary sm" data-down="${i}"${i < cfg.rules.length - 1 ? '' : ' disabled'}>↓</button></span></div>`).join('');
    $('rpRules').querySelectorAll('.rp-on').forEach((el) => {
      el.onchange = () => { cfg.rules[Number(el.dataset.i)].on = el.checked; };
    });
    $('rpRules').querySelectorAll('[data-up],[data-down]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.up != null ? b.dataset.up : b.dataset.down);
        const j = b.dataset.up != null ? i - 1 : i + 1;
        const rs = cfg.rules;
        [rs[i], rs[j]] = [rs[j], rs[i]];
        renderRoomPlanCfg();
      };
    });
    $('rpCcNeed').value = cfg.ccNeedSubjects.join(', ');
    $('rpCcSkip').value = cfg.ccSkipSubjects.join(', ');
    $('rpMaxExtra').value = cfg.maxExtra;
    $('rpOverWeight').value = cfg.overWeight;
    $('rpMinGain').value = cfg.minCapacityGain;
    $('rpSkipSubjects').value = cfg.skipSubjects.join(', ');
    $('rpSkipLocked').checked = cfg.skipLocked;
    document.querySelectorAll('.rp-pair').forEach((el) => { el.checked = cfg.blockPairs.includes(Number(el.value)); });
    // Аудитории берём из справочника; уже сохранённые оставляем, даже если
    // такой аудитории в справочнике больше нет.
    const known = ((state.entities && state.entities.roomsInfo) || []).map((r) => r.name);
    const chosen = new Set(cfg.skipRooms);
    $('rpSkipRooms').innerHTML = [...new Set([...known, ...cfg.skipRooms])]
      .sort((a, b) => String(a).localeCompare(String(b), 'ru'))
      .map((n) => `<option value="${esc(n)}"${chosen.has(n) ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  async function saveRoomPlanCfg() {
    const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const settings = {
      ...roomPlanCfg,
      ccNeedSubjects: list($('rpCcNeed').value),
      ccSkipSubjects: list($('rpCcSkip').value),
      maxExtra: Number($('rpMaxExtra').value),
      overWeight: Number($('rpOverWeight').value),
      minCapacityGain: Number($('rpMinGain').value),
      skipSubjects: list($('rpSkipSubjects').value),
      skipLocked: $('rpSkipLocked').checked,
      blockPairs: [...document.querySelectorAll('.rp-pair')].filter((el) => el.checked).map((el) => Number(el.value)),
      skipRooms: [...$('rpSkipRooms').selectedOptions].map((o) => o.value),
    };
    try {
      await api.put('/api/room-plan/settings', { settings });
    } catch (err) {
      return toast(err.message, true);
    }
    $('rpModal').classList.remove('open');
    toast('Настройки подбора сохранены');
    // Открытый список предложений считался по старым правилам — пересчитываем.
    if (state.roomPlan) await openRoomPlan();
  }

  /* ------------------ Разгрузка 4-й пары (расписание группы) ------------------ */
  // Считает сервер (/api/pair4-relief): куда переставить занятия группы с 4-й
  // пары (часы 7–8) — свободные окна пар 1–3, пн–пт, ±2 недели от занятия.
  // Здесь — таблица предложений с галочками под сеткой и подсветка занятий
  // открытой недели, для которых предложение нашлось.
  let reliefSkipped = new Set();

  async function openPair4Relief(reset = true) {
    const group = state.entityId;
    if (state.kind !== 'group' || !group) return toast('Откройте расписание группы', true);
    if (reset) reliefSkipped = new Set();
    const panel = $('reliefPanel');
    panel.style.display = 'block';
    if (reset) panel.innerHTML = '<div class="err-item">Ищем свободные окна…</div>';
    try {
      const r = await api.get(`/api/pair4-relief?group=${encodeURIComponent(group)}`);
      const items = (r.items || []).filter((x) => !reliefSkipped.has(x.key));
      for (const s of items) s.pick = 0; // выбранный вариант (индекс в s.options)
      state.relief = { group, items, total: r.total, placed: r.placed, chains: r.chains };
      renderRelief();
      applyReliefMarks();
    } catch (err) {
      panel.innerHTML = `<div class="err-item">${esc(err.message)}</div>`;
    }
  }

  function hideRelief() {
    if (!state.relief && $('reliefPanel').style.display === 'none') return;
    state.relief = null;
    hideReliefTip();
    $('reliefPanel').style.display = 'none';
    applyReliefMarks();
  }

  const reliefOptions = (s) => (s.options && s.options.length ? s.options : [s]);
  const reliefItem = (s, k) => ({ ...s, ...reliefOptions(s)[k ?? s.pick ?? 0] });
  const slotLabel = (day, pair, week) => `${day}, часы ${SC.pairHours(pair)}, неделя ${week}`;
  // Подпись варианта: куда едет занятие и что ради этого двигаем ещё.
  function reliefOptionLabel(s, o) {
    const room = o.toRoom && o.toRoom !== s.room ? ` · ауд. ${o.toRoom}` : '';
    const chain = o.chain
      ? ` (сначала уедет «${o.chain.subject || '—'}» ${(o.chain.groups || []).join(', ')} → ${slotLabel(o.chain.toDay, o.chain.toPair, o.chain.toWeek)})`
      : '';
    return `→ ${slotLabel(o.toDay, o.toPair, o.toWeek)}${room}${chain}`;
  }

  function renderRelief() {
    const panel = $('reliefPanel');
    const st = state.relief || { items: [], total: 0 };
    const items = st.items || [];
    if (!items.length) {
      panel.innerHTML = '<div class="err-head"><h3>Свободных окон для 4-й пары не нашлось' +
        `${st.total ? ` (занятий на 4-й паре: ${st.total})` : ''}</h3>` +
        '<button type="button" class="btn secondary sm" id="reliefHide">Скрыть</button></div>' +
        '<div class="err-hint">Переносить некуда: в парах 1–3 у группы нет свободных окон, где свободны ещё и преподаватель с аудиторией.</div>';
      $('reliefHide').onclick = hideRelief;
      return;
    }
    const rows = items.map((s, i) => {
      const opts = reliefOptions(s);
      const variant = opts.length > 1
        ? `<select class="rel-var" data-i="${i}">${opts.map((o, k) =>
          `<option value="${k}"${k === s.pick ? ' selected' : ''}>${esc(reliefOptionLabel(s, o))}</option>`).join('')}</select>`
        : esc(reliefOptionLabel(s, opts[0]));
      const chainCell = s.chain
        ? `<span class="rel-chain">${esc(s.chain.subject || '—')} · ${esc((s.chain.groups || []).join(', '))}</span>`
        : '<span class="muted-hint">—</span>';
      return `<tr><td><input type="checkbox" class="rel-pick" data-i="${i}" checked></td>` +
        `<td>${esc(slotLabel(s.day, s.pairNo, s.weekNo))}</td>` +
        `<td>${esc(s.subject || '—')}${s.type ? ' ' + esc(s.type) : ''} <span class="muted-hint">${esc(s.teacher || '')}</span></td>` +
        `<td>${esc(s.room || '—')}</td><td>${variant}</td><td>${chainCell}</td></tr>`;
    }).join('');
    panel.innerHTML =
      `<div class="err-head"><h3>Разгрузка 4-й пары: ${items.length} из ${st.total}</h3>` +
      '<div class="opt-acts">' +
      '<button type="button" class="btn secondary sm" id="reliefAll">Отметить все</button>' +
      '<button type="button" class="btn secondary sm" id="reliefNone">Снять все</button>' +
      '<button type="button" class="btn sm" id="reliefApply">Применить отмеченные</button>' +
      '<button type="button" class="btn secondary sm" id="reliefHide">Скрыть</button></div></div>' +
      '<div class="err-hint">Занятия из списка подсвечены в сетке — наведите на такое занятие, чтобы применить или пропустить его отдельно. ' +
      'Занятия едут в свободные окна пар 1–3, пн–пт, в пределах ±2 недель от своего места; суббота не трогается. ' +
      'Аудитория сохраняется (заменяется только на свободную той же кафедры и того же оснащения). ' +
      `Если у группы окно есть, а преподаватель занят другой группой, сначала уезжает её пара — такие предложения (${st.chains || 0}) применяются целиком. ` +
      'Отменить всё можно кнопкой «Отменить».</div>' +
      '<div class="opt-table-wrap"><table class="opt-table"><thead><tr><th></th><th>Сейчас</th><th>Занятие</th><th>Аудитория</th><th>Куда</th><th>Ещё двигаем</th></tr></thead>' +
      `<tbody>${rows}</tbody></table></div>`;
    const setAll = (v) => panel.querySelectorAll('.rel-pick').forEach((c) => { c.checked = v; });
    $('reliefAll').onclick = () => setAll(true);
    $('reliefNone').onclick = () => setAll(false);
    $('reliefHide').onclick = hideRelief;
    $('reliefApply').onclick = applyCheckedRelief;
    panel.querySelectorAll('.rel-var').forEach((sel) => {
      sel.onchange = () => {
        items[Number(sel.dataset.i)].pick = Number(sel.value);
        applyReliefMarks();
      };
    });
  }

  function applyCheckedRelief() {
    const items = (state.relief && state.relief.items) || [];
    const picked = [...$('reliefPanel').querySelectorAll('.rel-pick')]
      .filter((c) => c.checked)
      .map((c) => items[Number(c.dataset.i)])
      .filter(Boolean)
      .map((s) => reliefItem(s));
    if (!picked.length) return toast('Отметьте хотя бы одно предложение', true);
    return applyReliefItems(picked);
  }

  async function applyReliefItems(list) {
    try {
      const r = await api.post('/api/pair4-relief/apply', { items: list });
      const tail = r.skipped ? ` · пропущено (окно успели занять): ${r.skipped}` : '';
      toast(`Переставлено занятий: ${r.applied}${tail}`, !!r.skipped);
      refreshUndo();
      hideReliefTip();
      await render();
      await openPair4Relief(false); // пересчёт: часть предложений уже неактуальна
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Подсветка занятий открытой недели, по которым есть предложение: и само
  // занятие с 4-й пары, и чужая пара, которую ради него предлагается сдвинуть.
  function applyReliefMarks() {
    const items = (state.relief && state.relief.items) || [];
    const ids = new Set();
    for (const s of items) {
      ids.add(s.lessonId);
      const o = reliefOptions(s)[s.pick || 0];
      if (o && o.chain) ids.add(o.chain.lessonId);
    }
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      el.classList.remove('relief-src');
      if (!ids.size) return;
      let l;
      try { l = JSON.parse(el.dataset.lesson); } catch { return; }
      if (ids.has(l.id)) el.classList.add('relief-src');
    });
  }

  /* -- Всплывающая подсказка о переносе прямо на подсвеченном занятии -- */
  // Как и у подбора аудиторий: окно живёт, пока курсор над карточкой ИЛИ над
  // самим окном, иначе до кнопки «Выполнить» не дотянуться.
  let reliefTipEl = null;
  let reliefTipTimer = null;

  function hideReliefTip() {
    clearTimeout(reliefTipTimer);
    if (reliefTipEl) reliefTipEl.hidden = true;
  }

  // Предложение по карточке: занятие может быть и «чужой парой» из цепочки.
  function reliefForCard(card) {
    const items = (state.relief && state.relief.items) || [];
    let id;
    try { id = JSON.parse(card.dataset.lesson).id; } catch { return null; }
    return items.find((s) => s.lessonId === id)
      || items.find((s) => reliefOptions(s).some((o) => o.chain && o.chain.lessonId === id))
      || null;
  }

  function showReliefTip(s, card) {
    const items = (state.relief && state.relief.items) || [];
    const i = items.indexOf(s);
    const opts = reliefOptions(s);
    let l;
    try { l = JSON.parse(card.dataset.lesson); } catch { l = null; }
    const chainCard = !!l && l.id !== s.lessonId; // навели на чужую пару из цепочки
    const head = `${esc(s.subject || '—')}${s.type ? ' ' + esc(s.type) : ''} · ${esc((s.groups || []).join(', '))}` +
      (s.teacher ? ` · ${esc(s.teacher)}` : '');
    const now = `Сейчас: ${esc(slotLabel(s.day, s.pairNo, s.weekNo))}${s.room ? ' · ауд. ' + esc(s.room) : ''}`;
    const note = chainCard
      ? '<div class="ot-now">Эту пару предлагается сдвинуть, чтобы освободить преподавателя под 4-ю пару выше.</div>'
      : '';
    reliefTipEl.innerHTML =
      `<div class="ot-head">${head}</div><div class="ot-now">${now}</div>${note}` +
      opts.map((o, k) =>
        `<div class="ot-opt"><span>${esc(reliefOptionLabel(s, o))}</span>` +
        `<button type="button" class="btn sm" data-rdo="${i}" data-ropt="${k}">Выполнить</button></div>`).join('') +
      `<div class="ot-acts"><button type="button" class="btn secondary sm" data-rskip="${i}">Пропустить</button></div>`;
    reliefTipEl.hidden = false;
    // Позиционируем рядом с карточкой, не вылезая за окно.
    const r = card.getBoundingClientRect();
    const t = reliefTipEl.getBoundingClientRect();
    let x = r.right + 8;
    let y = r.top;
    if (x + t.width > window.innerWidth) x = Math.max(4, r.left - t.width - 8);
    if (y + t.height > window.innerHeight) y = Math.max(4, window.innerHeight - t.height - 4);
    reliefTipEl.style.left = `${x}px`;
    reliefTipEl.style.top = `${y}px`;
  }

  function onReliefTipClick(e) {
    const items = (state.relief && state.relief.items) || [];
    const doBtn = e.target.closest('[data-rdo]');
    if (doBtn) {
      const s = items[Number(doBtn.dataset.rdo)];
      if (!s) return;
      hideReliefTip();
      applyReliefItems([{ ...s, ...reliefOptions(s)[Number(doBtn.dataset.ropt)] }]);
      return;
    }
    const skipBtn = e.target.closest('[data-rskip]');
    if (!skipBtn) return;
    const s = items[Number(skipBtn.dataset.rskip)];
    if (!s) return;
    // «Пропустить» — только убрать из подбора: расписание не меняется.
    reliefSkipped.add(s.key);
    state.relief.items = items.filter((x) => x !== s);
    hideReliefTip();
    renderRelief();
    applyReliefMarks();
  }

  function setupReliefTip() {
    reliefTipEl = document.createElement('div');
    reliefTipEl.className = 'opt-tip';
    reliefTipEl.hidden = true;
    document.body.appendChild(reliefTipEl);
    reliefTipEl.addEventListener('mouseenter', () => clearTimeout(reliefTipTimer));
    reliefTipEl.addEventListener('mouseleave', () => { reliefTipTimer = setTimeout(hideReliefTip, 200); });
    reliefTipEl.addEventListener('click', onReliefTipClick);

    const grid = $('gridWrap');
    grid.addEventListener('mouseover', (e) => {
      const card = e.target.closest && e.target.closest('.lesson.relief-src');
      if (!card) return;
      const s = reliefForCard(card);
      if (!s) return;
      clearTimeout(reliefTipTimer);
      showReliefTip(s, card);
    });
    grid.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('.lesson.relief-src')) return;
      reliefTipTimer = setTimeout(hideReliefTip, 200);
    });
  }

  // Окно подсказок для ячейки без аудитории: свободные аудитории + предложения
  // «потеснить» (перенести СР из большой аудитории в меньшую, освободив большую).
  async function openSrHelp(group, day, pairNo) {
    const weekNo = state.week;
    const prefill = { day, pairNo, weekNo, subject: 'СР', group };
    $('srHelpInfo').textContent = `Группа ${group} · ${day}, часы ${SC.pairHours(pairNo)}, неделя ${weekNo}`;
    $('srHelpList').innerHTML = '<div class="file-status">Подбираем варианты…</div>';
    $('srHelpManual').onclick = () => { $('srHelpModal').classList.remove('open'); openAddLesson(prefill); };
    $('srHelpClose').onclick = () => $('srHelpModal').classList.remove('open');
    $('srHelpModal').classList.add('open');
    let r;
    try {
      r = await api.get(`/api/sr-suggestions?group=${encodeURIComponent(group)}&day=${encodeURIComponent(day)}&pairNo=${pairNo}&weekNo=${weekNo}`);
    } catch (err) {
      $('srHelpList').innerHTML = `<div class="file-status">Ошибка: ${esc(err.message)}</div>`;
      return;
    }
    $('srHelpInfo').textContent = `Группа ${group} (${r.need} к-т) · ${day}, часы ${SC.pairHours(pairNo)}, неделя ${weekNo}`;
    let html = '';
    if (r.direct.length) {
      html += '<div class="lbl">Свободные аудитории — поставить сразу:</div>';
      html += r.direct.map((d) =>
        `<button type="button" class="room-opt sr-act" data-act="direct" data-room="${esc(d.room)}">` +
        `<span>В аудиторию ${esc(d.room)}</span><span class="cap">мест: ${d.cap}</span></button>`).join('');
    }
    if (r.relocations.length) {
      html += '<div class="lbl" style="margin-top:8px">Потеснить — освободить большую аудиторию:</div>';
      html += r.relocations.map((x, i) =>
        `<button type="button" class="room-opt sr-act" data-act="reloc" data-i="${i}">` +
        `<span>Перенести СР ${esc(x.groups.join(', ') || '—')} из ${esc(x.fromRoom)} (${x.fromCap}) → ${esc(x.toRoom)} (${x.toCap})` +
        `<br><small class="cap">и поставить группу ${esc(group)} в ${esc(x.fromRoom)}</small></span></button>`).join('');
    }
    if (r.shared && r.shared.length) {
      html += '<div class="lbl" style="margin-top:8px">Совместить — подселить к другой СР:</div>';
      html += r.shared.map((s) =>
        `<button type="button" class="room-opt sr-act" data-act="shared" data-room="${esc(s.room)}">` +
        `<span>В аудиторию ${esc(s.room)} к ${esc(s.currentGroups.join(', '))}</span><span class="cap">осталось мест: ${s.remain} (из ${s.cap})</span></button>`).join('');
    }
    if (!html) {
      html = '<div class="file-status">Автоматических вариантов нет. Поставьте вручную или сначала освободите аудиторию (перенос/вывод).</div>';
    }
    $('srHelpList').innerHTML = html;
    $('srHelpList').querySelectorAll('.sr-act').forEach((b) => {
      b.onclick = async () => {
        try {
          // Мягкие замечания (нехватка мест при совмещении) — через подтверждение,
          // как везде: показывать их как ошибку размещения нельзя.
          const addSr = (room) => withConfirm((extra) =>
            api.post('/api/lessons', { day, pairNo, weekNo, subject: 'СР', groups: [group], rooms: [room], ...extra }));
          if (b.dataset.act === 'direct' || b.dataset.act === 'shared') {
            if ((await addSr(b.dataset.room)).cancelled) return;
          } else {
            const x = r.relocations[Number(b.dataset.i)];
            const moved = await withConfirm((extra) => api.put(`/api/lesson/${x.lessonId}`, { rooms: [x.toRoom], ...extra })); // потеснили СР
            if (moved.cancelled) return;
            if ((await addSr(x.fromRoom)).cancelled) return;
          }
          $('srHelpModal').classList.remove('open');
          toast(`Аудитория назначена группе ${group}`);
          refreshUndo();
          render();
        } catch (err) {
          const reasons = (err.data && err.data.reasons) || [err.message];
          toast(reasons.join('; '), true);
        }
      };
    });
  }

  // Сводное расписание АУДИТОРИЙ: столбцы — нескрытые аудитории, строки — слоты.
  // Свободные ячейки (в аудитории нет занятия) подсвечиваются зелёным.
  async function renderRoomSummary() {
    $('gridTitle').textContent = `Сводное по аудиториям · неделя ${state.week}`;
    const data = await api.get(`/api/room-summary?weekNo=${state.week}`);
    state.semester = data.semester || null;
    buildRoomSummaryGrid(data);
  }

  function buildRoomSummaryGrid(data) {
    const cols = data.columns || [];
    const lessons = data.lessons || [];
    if (!cols.length) {
      $('gridWrap').innerHTML = '<div class="file-status">Нет аудиторий (добавьте их в «Справочниках» или загрузите расписание).</div>';
      return;
    }
    const at = (room, day, pair) =>
      lessons.filter((l) => l.day === day && l.pairNo === pair && roomsOf(l).includes(room));

    let html = '<div class="grid-scroll"><table class="grid semester summary"><thead><tr>';
    html += '<th class="day-col">День</th><th class="pair-col">Часы</th>';
    for (const c of cols) {
      const sub = [c.dept || '', c.capacity != null ? `${c.capacity} мест` : ''].filter(Boolean).join(' · ');
      html += `<th class="grp-head">${esc(c.room)}<br><small>${esc(sub || '—')}</small></th>`;
    }
    html += '</tr></thead><tbody>';

    for (const d of DAYS) {
      const dayPairs = SC.pairsForDay(d);
      for (let pi = 0; pi < dayPairs.length; pi++) {
        const p = dayPairs[pi];
        html += '<tr>';
        if (pi === 0) {
          const dt = dateOf(state.week, d);
          html += `<td class="day-col" rowspan="${dayPairs.length}">${d}${dt ? `<br><small class="cell-date">${esc(dt)}</small>` : ''}</td>`;
        }
        html += `<td class="pair-col">${SC.pairHours(p)}<br>${PAIR_TIMES[p]}</td>`;
        for (const c of cols) {
          const here = at(c.room, d, p);
          // Свободная аудитория в этом слоте → класс slot-free (зелёная обводка).
          html += `<td class="slot${here.length ? '' : ' slot-free'}" data-room="${esc(c.room)}" data-day="${d}" data-pair="${p}">`;
          for (const l of here) html += roomSummaryCard(l);
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    $('gridWrap').innerHTML = html;
    bindLessonClicks();
    fillHlValues();
    applyHighlights();
    applyRoomPlanMarks();
  }

  // Карточка для сводного вида аудиторий: вид, дисциплина, группы, преподаватель.
  // Аудитория тут и так очевидна (это её столбец), поэтому вместо неё — группы.
  function roomSummaryCard(l) {
    const teacher = l.teacher ? esc(l.teacher) : (isSR(l) ? '' : '<span class="warn">?</span>');
    return (
      `<div class="lesson src ${l.teacher || isSR(l) ? '' : 'no-teacher'} ${typeClass(l.type)} ${SC.assessmentKind(l.type)} ${movedClass(l)} ${streamClass(l)}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="l1">${esc(l.type || '')}</div>` +
      `<div class="l2">${esc(l.subject || '—')}</div>` +
      `<div class="l3">${esc((l.groups || []).join(', ') || '—')}</div>` +
      (sumTeacher ? `<div class="l4">${teacher}</div>` : '') + '</div>'
    );
  }

  // Все аудитории занятия через «, »: использует rooms[] если есть, иначе room.
  function roomStr(l) {
    if (l.rooms && l.rooms.length) return l.rooms.join(', ');
    return l.room || '';
  }
  // Аудитории занятия массивом (1 или 2).
  const roomsOf = (l) => (l.rooms && l.rooms.length) ? l.rooms : (l.room ? [l.room] : []);

  // Кафедра и примечание аудитории одной строкой — для списков, где вместимость
  // выведена отдельной колонкой (окно переноса); в остальных местах — SC.roomLabel.
  const roomSub = (r) => [r.dept ? `каф. ${r.dept}` : '', r.note || ''].filter(Boolean).join(', ');

  // Справка об аудитории по имени (кафедра, примечание, места) — из /api/entities.
  const roomInfoOf = (name) => ((state.entities && state.entities.roomsInfo) || []).find((r) => r.name === name) || {};
  // Все преподаватели занятия: список teachers[] или одиночный teacher.
  const teachersOf = (l) => (l.teachers && l.teachers.length) ? l.teachers : (l.teacher ? [l.teacher] : []);
  // Самостоятельная работа (СР) — преподаватель не нужен, поэтому подсветку
  // «нет преподавателя» для неё не показываем.
  const isSR = (l) => l.subject === 'СР';

  // Постоянная окраска карточки по виду занятия (см. .lesson.t-* в styles.css).
  // Только в расписании ПРЕПОДАВАТЕЛЯ: там вид занятия — главный признак, по
  // которому смотрят нагрузку. В расписаниях группы/аудитории и в сводном цвет
  // занят другими смыслами (поток, перенос, форма контроля), поэтому не красим.
  // Неизвестные виды и СР остаются с обычным фоном.
  const TYPE_CLASS = {
    л: 't-lec',
    пз: 't-prac',
    п: 't-prac',
    лр: 't-lab',
    лз: 't-lab',
    с: 't-sem',
    гз: 't-grp',
    гу: 't-grp',
    кр: 't-ctrl',
    кп: 't-ctrl',
  };
  function typeClass(type) {
    if (state.kind !== 'teacher' || state.mode === 'summary') return '';
    return TYPE_CLASS[String(type || '').trim().replace(/[.\s]+$/, '').toLowerCase()] || '';
  }

  // Полная подсказка по занятию (нативный title при наведении): дисциплина
  // целиком, вид, тема, аудитория, преподаватель. Мероприятия — свой текст.
  function lessonTitle(l) {
    if (l.category === 'event') return '';
    const tlist = (l.teachers && l.teachers.length) ? l.teachers : (l.teacher ? [l.teacher] : []);
    const subj = l.subjectFull ? `${l.subjectFull} (${l.subject || ''})` : (l.subject || '—');
    const lines = [`Дисциплина: ${subj}`];
    const vid = l.typeFull || l.type;
    if (vid) lines.push(`Вид: ${vid}`);
    if (l.topic) lines.push(`Тема: ${l.topic}`);
    const roomsText = roomsOf(l).map(roomWithNote).join(', ');
    lines.push(`Аудитория: ${roomsText || '—'}`);
    lines.push(`Преподаватель: ${tlist.length ? tlist.join(', ') : (isSR(l) ? '—' : 'не назначен')}`);
    // Если занятие перенесено — показываем информацию о переносе (п.7).
    for (const line of movedLines(l)) lines.push(line);
    return lines.join('\n');
  }

  // Строки «перенесено» для подсказки занятия: смена слота и/или аудитории
  // (текст общий с гостевой карточкой). Пусто, если занятия нет в журнале.
  const movedLines = (l) => SC.movedLines(movedEntryFor(l));

  // Карточка для сводного вида (взгляд группы): вид, дисциплина, аудитория, преподаватель.
  function summaryCard(l) {
    const teacher = l.teacher ? esc(l.teacher) : (isSR(l) ? '' : '<span class="warn">?</span>');
    return (
      `<div class="lesson src ${l.teacher || isSR(l) ? '' : 'no-teacher'} ${typeClass(l.type)} ${SC.assessmentKind(l.type)} ${movedClass(l)} ${streamClass(l)}" draggable="true" title="${esc(lessonTitle(l))}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="l1">${esc(l.type || '')}</div>` +
      `<div class="l2">${esc(l.subject || '—')}</div>` +
      `<div class="l3">${esc(roomStr(l) || '—')}</div>` +
      (sumTeacher ? `<div class="l4">${teacher}</div>` : '') + '</div>'
    );
  }

  /* ---------- Курсы (префикс группы → номер курса) ---------- */
  async function openCourses() {
    const [{ courses }, entities] = await Promise.all([api.get('/api/courses'), api.get('/api/entities')]);
    const prefixes = [...new Set((entities.groups || []).map((g) => g.slice(0, 2)))].sort();
    $('coursesList').innerHTML = prefixes.length
      ? prefixes
          .map(
            (p) =>
              `<div class="ref-row"><span>${esc(p)}* (группы на «${esc(p)}»)</span>` +
              `<input type="number" min="1" max="5" value="${courses[p] ?? ''}" data-prefix="${esc(p)}"></div>`
          )
          .join('')
      : '<div class="file-status">Нет загруженных групп.</div>';
    $('coursesModal').classList.add('open');
  }

  async function saveCourses() {
    const courses = {};
    $('coursesList')
      .querySelectorAll('input')
      .forEach((inp) => {
        const n = Number(inp.value);
        if (Number.isInteger(n) && n >= 1 && n <= 5) courses[inp.dataset.prefix] = n;
      });
    try {
      await api.put('/api/courses', { courses });
      state.courses = courses; // чтобы списки групп сразу учли курсы
      $('coursesModal').classList.remove('open');
      toast('Курсы сохранены');
      await refreshEntities(); // перестроить селектор групп под новые курсы
      if (state.mode === 'summary') render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------- Замены сокращений дисциплин (при импорте) ---------- */
  function aliasRow(from, to) {
    return (
      `<div class="ref-row"><input type="text" placeholder="ИЭП" value="${esc(from)}" data-k="from">` +
      ` → <input type="text" placeholder="ИРТС" value="${esc(to)}" data-k="to">` +
      `<button class="btn secondary sm" type="button" onclick="this.parentNode.remove()">×</button></div>`
    );
  }

  async function openAliases() {
    const { aliases } = await api.get('/api/subject-aliases');
    const rows = Object.entries(aliases || {});
    $('aliasesList').innerHTML = (rows.length ? rows : [['', '']]).map(([f, t]) => aliasRow(f, t)).join('');
    $('aliasesModal').classList.add('open');
  }

  async function saveAliases() {
    const aliases = {};
    $('aliasesList')
      .querySelectorAll('.ref-row')
      .forEach((row) => {
        const f = row.querySelector('[data-k="from"]').value.trim();
        const t = row.querySelector('[data-k="to"]').value.trim();
        if (f && t && f !== t) aliases[f] = t;
      });
    try {
      await api.put('/api/subject-aliases', { aliases });
      $('aliasesModal').classList.remove('open');
      toast('Замены сохранены');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------- Архив базы (версии всей базы) ---------- */
  function arcSize(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }

  function arcWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function arcRow(a) {
    // «занятий: N» — форма родительного падежа верна при любом числе.
    const meta = [arcSize(a.size), a.lessons == null ? null : `занятий: ${a.lessons}`]
      .filter(Boolean)
      .join(' · ');
    const badges =
      (a.auto ? '<span class="sem-badge arc-badge-auto" title="Создана автоматически перед переключением">авто</span>' : '') +
      (a.imported ? '<span class="sem-badge arc-badge-auto" title="Файл загружен с другого устройства">импорт</span>' : '');
    const dl = `<a class="btn secondary sm" href="/api/archives/${encodeURIComponent(a.id)}/download" download title="Выгрузить файл версии — его можно перенести на другое устройство">⬇</a>`;
    // Битый файл (недокачан, повреждён) переключением сломал бы рабочую базу —
    // оставляем только выгрузку и удаление.
    const acts = a.broken
      ? dl + '<button class="btn secondary sm" type="button" data-act="del" title="Удалить версию">🗑</button>'
      : dl +
        '<button class="btn secondary sm" type="button" data-act="restore" title="Заменить текущую базу этой версией">↩ Переключиться</button>' +
        '<button class="btn secondary sm" type="button" data-act="del" title="Удалить версию">🗑</button>';
    const middle = a.broken
      ? `<div class="arc-broken">${esc(a.error || 'Файл непригоден')}</div>`
      : `<input type="text" class="arc-note-inp" maxlength="500" placeholder="Примечание…" value="${esc(a.note)}">`;
    return (
      `<div class="arc-row" data-id="${esc(a.id)}">` +
      `<div><div class="arc-when">${esc(arcWhen(a.createdAt))}${badges}</div>` +
      `<div class="arc-meta">${esc(meta)}</div></div>` +
      middle +
      `<div class="arc-acts">${acts}</div></div>`
    );
  }

  async function renderArchives() {
    const list = $('arcList');
    try {
      const { archives } = await api.get('/api/archives');
      list.innerHTML = archives.length
        ? archives.map(arcRow).join('')
        : '<div class="arc-empty">Сохранённых версий пока нет. Нажмите «Сохранить текущую», чтобы создать первую.</div>';
    } catch (err) {
      list.innerHTML = `<div class="arc-empty">${esc(err.message)}</div>`;
    }
  }

  async function openArchives() {
    $('arcNote').value = '';
    await renderArchives();
    $('archivesModal').classList.add('open');
  }

  async function createArchive() {
    const btn = $('arcCreate');
    btn.disabled = true;
    try {
      await api.post('/api/archives', { note: $('arcNote').value.trim() });
      $('arcNote').value = '';
      await renderArchives();
      toast('Текущая версия базы сохранена');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function importArchiveFile(file) {
    const btn = $('arcImport');
    btn.disabled = true;
    try {
      const { archive } = await api.upload('/api/archives/import', [file], { note: $('arcNote').value.trim() });
      $('arcNote').value = '';
      await renderArchives();
      toast(`Версия загружена: занятий ${archive.lessons}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      $('arcFile').value = ''; // иначе повторный выбор того же файла не вызовет change
    }
  }

  function arcLabel(row) {
    const when = row.querySelector('.arc-when').textContent.trim();
    const note = row.querySelector('.arc-note-inp').value.trim();
    return when + (note ? ` («${note}»)` : '');
  }

  async function restoreArchive(row) {
    const msg =
      `Переключиться на версию от ${arcLabel(row)}?\n\n` +
      'Текущая база будет заменена этой версией целиком. Перед заменой текущее ' +
      'состояние сохранится отдельной версией, поэтому переключение можно отменить.';
    if (!confirm(msg)) return;
    try {
      await api.post(`/api/archives/${row.dataset.id}/restore`);
      // Сменилась вся база (справочники, семестр, недели) — перечитываем страницу.
      location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteArchive(row) {
    if (!confirm(`Удалить версию от ${arcLabel(row)}? Файл снимка будет удалён безвозвратно.`)) return;
    try {
      await api.del(`/api/archives/${row.dataset.id}`);
      await renderArchives();
      toast('Версия удалена');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function saveArchiveNote(inp) {
    try {
      await api.put(`/api/archives/${inp.closest('.arc-row').dataset.id}`, { note: inp.value.trim() });
      toast('Примечание сохранено');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------- Перенос перетаскиванием (недельная сетка) ---------- */
  let dragLesson = null;
  // Перенос занятия кликом (запускается кнопкой ⇄ из перечня занятий).
  let moveMode = false;
  let dragFromBuffer = false; // тянем из буфера (а не из сетки)
  let pickMode = false; // режим выбора свободной ячейки в сетке для нового занятия
  let blockMode = false; // режим ручной блокировки свободных ячеек преподавателя

  function setupDnD() {
    const wrap = $('gridWrap');
    // Обработчики через on*, а не addEventListener: setupDnD вызывается и после
    // точечной перерисовки карточек, а присваивание дублей не плодит.
    wrap.querySelectorAll('.lesson[draggable="true"]').forEach((el) => {
      el.ondragstart = (e) => onDragStart(e, JSON.parse(el.dataset.lesson), el);
      el.ondragend = clearDnD;
    });
    wrap.querySelectorAll('td.slot').forEach((cell) => {
      cell.ondragover = (e) => {
        if (cell.classList.contains('free-target')) {
          e.preventDefault();
          cell.classList.add('drag-over');
        }
      };
      cell.ondragleave = () => cell.classList.remove('drag-over');
      cell.ondrop = (e) => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        if (cell.classList.contains('free-target')) onDrop(cell);
      };
    });
  }

  async function onDragStart(e, lesson, el) {
    if (lesson.editable === false) { e.preventDefault(); return; }
    dragLesson = lesson;
    dragFromBuffer = el.classList.contains('parked');
    el.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', String(lesson.id));
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* некоторые браузеры */
    }
    // Буфер тоже подсвечиваем как валидную цель (туда можно отложить из сетки).
    if (!dragFromBuffer) $('bufferPanel').classList.add('free-buffer');
    await highlightMoveTargets(lesson, el);
  }

  // Подсветка свободных окон для переноса занятия. Используется и при
  // перетаскивании, и при переносе из перечня занятий (там карточки нет — el = null).
  async function highlightMoveTargets(lesson, el) {
    // Подсветим свободные окошки (где свободны и группа, и преподаватель).
    // Недельный — слоты текущей недели; семестровый — все недели;
    // сводное — только столбец своей группы (перенос в пределах группы).
    const sem = state.mode === 'semester';
    const summary = state.mode === 'summary';
    const originGroup = summary
      ? ((el && el.closest('td.slot') && el.closest('td.slot').dataset.group) || (lesson.groups || [])[0])
      : null;

    // Одиночный вид (неделя/семестр) показывает расписание ОДНОЙ сущности
    // (state.entityId), а ячейки не помечены группой. Поэтому занятие из буфера
    // нельзя класть в чужую сетку — оно всё равно уйдёт в свою группу/к своему
    // преподавателю. Разрешаем перенос только в расписание-владельца.
    if (!summary && !lessonBelongsToView(lesson)) {
      const where =
        state.kind === 'group'
          ? `группы ${(lesson.groups || []).join(', ') || '—'}`
          : state.kind === 'teacher'
            ? `преподавателя ${lesson.teacher || '—'}`
            : `аудитории ${lesson.room || '—'}`;
      toast(`Это занятие ${where}. Откройте её расписание или сводный вид.`, true);
      return;
    }

    const url = sem
      ? `/api/move-options?lessonId=${lesson.id}`
      : `/api/move-options?lessonId=${lesson.id}&weekNo=${state.week}`;
    const { slots } = await api.get(url);

    for (const s of slots) {
      if (!(s.groupFree && s.teacherFree)) continue;
      let sel;
      if (sem) sel = `td.slot[data-day="${s.day}"][data-pair="${s.pairNo}"][data-week="${s.weekNo}"]`;
      else if (summary) sel = `td.slot[data-group="${cssEsc(originGroup)}"][data-day="${s.day}"][data-pair="${s.pairNo}"]`;
      else sel = `td.slot[data-day="${s.day}"][data-pair="${s.pairNo}"]`;
      const cell = $('gridWrap').querySelector(sel);
      if (!cell) continue;
      const curWeek = sem ? lesson.weekNo : state.week;
      // Из буфера разрешаем и исходный слот; из сетки — пропускаем текущий.
      if (!dragFromBuffer && s.day === lesson.day && s.pairNo === lesson.pairNo && s.weekNo === curWeek) continue;
      cell.classList.add('free-target');
      cell.classList.toggle('room-busy', !s.roomFree);
      cell.dataset.roomFree = s.roomFree ? '1' : '0';
    }
  }

  // Принадлежит ли занятие текущему одиночному виду (его сущности-владельцу).
  // group — занятие должно включать отображаемую группу; teacher/room —
  // совпадать по преподавателю/аудитории.
  function lessonBelongsToView(lesson) {
    if (state.kind === 'group') return (lesson.groups || []).includes(state.entityId);
    if (state.kind === 'teacher') return (lesson.teachers || []).includes(state.entityId) || lesson.teacher === state.entityId;
    if (state.kind === 'room') return lesson.room === state.entityId;
    return true;
  }

  // Экранирование значения для CSS-селектора (имена групп: цифры, «/», «-»).
  function cssEsc(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  function clearDnD() {
    dragLesson = null;
    dragFromBuffer = false;
    document.querySelectorAll('.lesson.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.lesson.moving').forEach((el) => el.classList.remove('moving'));
    document.querySelectorAll('tr.tl-moving').forEach((el) => el.classList.remove('tl-moving'));
    $('gridWrap').querySelectorAll('td.slot').forEach((c) => {
      c.classList.remove('free-target', 'room-busy', 'drag-over');
      delete c.dataset.roomFree;
    });
    $('bufferPanel').classList.remove('free-buffer', 'drag-over');
  }

  async function onDrop(cell) {
    const lesson = dragLesson;
    if (!lesson) return;
    const weekNo = cell.dataset.week ? Number(cell.dataset.week) : state.week;
    const target = { day: cell.dataset.day, pairNo: Number(cell.dataset.pair), weekNo };
    if (cell.dataset.roomFree === '1') {
      // Обе аудитории (1–2) свободны — переносим как есть, сохраняя весь набор.
      await doMove({ lessonId: lesson.id, expectedRevision: lesson.revision, ...target, rooms: roomsOf(lesson) });
    } else {
      openRoomPicker(lesson, target);
    }
  }

  // Мягкие замечания сервера (аудитория занята / не хватает мест) размещение не
  // запрещают: показываем их пользователю и по согласию повторяем запрос с
  // force. send(extra) должен слать запрос, подмешав extra в тело.
  // Возвращает { ok, data } или { ok: false, cancelled: true }.
  async function withConfirm(send) {
    try {
      return { ok: true, data: await send({}) };
    } catch (err) {
      const d = (err && err.data) || {};
      if (!d.confirm || !Array.isArray(d.warnings) || !d.warnings.length) throw err;
      if (!confirm(`${d.warnings.join('\n')}\n\nВсё равно разместить занятие здесь?`)) {
        return { ok: false, cancelled: true };
      }
      return { ok: true, data: await send({ force: true }), forced: true };
    }
  }

  async function doMove(body) {
    try {
      const commandId = window.crypto.randomUUID();
      const r = await withConfirm((extra) => api.post('/api/move', { ...body, commandId, ...extra }));
      if (r.cancelled) return;
      toast(r.data.warning ? `Перенесено · ⚠ ${r.data.warning}` : 'Занятие перенесено');
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Выбор свободной аудитории, когда текущая занята в целевом слоте. Для занятия
  // с двумя аудиториями свободные оставляем, а для каждой занятой просим замену
  // (нужно выбрать столько аудиторий, сколько занято).
  // onPick(rooms) — что сделать с выбранным набором; по умолчанию — перенос.
  async function openRoomPicker(lesson, target, onPick) {
    const apply = onPick || ((rooms) => doMove({ lessonId: lesson.id, expectedRevision: lesson.revision, ...target, rooms }));
    const { rooms, need } = await api.get(
      `/api/free-rooms?lessonId=${lesson.id}&day=${encodeURIComponent(target.day)}&pairNo=${target.pairNo}&weekNo=${target.weekNo}`
    );
    // free-rooms возвращает только свободные аудитории → занятые отсутствуют.
    const freeNames = new Set(rooms.map((r) => r.name));
    const current = roomsOf(lesson);
    const kept = current.filter((n) => freeNames.has(n)); // свободные — оставляем
    const pickN = Math.max(1, current.length - kept.length); // сколько занятых заменить
    // Свои свободные аудитории не предлагаем как варианты замены (уже оставлены).
    const options = rooms.filter((r) => !kept.includes(r.name));
    const selected = new Set();

    // Потребность в местах выносим отдельной строкой: по ней выбирают аудиторию.
    const tail = pickN > 1
      ? `выберите ${pickN} аудитории`
      : (kept.length ? `оставляем: ${kept.join(', ')}` : '');
    $('roomInfo').innerHTML =
      `<b class="need-seats">Нужно мест: ${need || '—'}</b><br>` +
      `${esc(lesson.subject || '')} · ${esc(target.day)} часы ${esc(SC.pairHours(target.pairNo))}` +
      `${tail ? ' · ' + esc(tail) : ''}`;
    // Первым пунктом — оставить занятие в СВОИХ аудиториях, даже если они заняты
    // (сервер спросит подтверждение). Это не ошибка, а решение составителя.
    const keepBtn = current.length
      ? `<div class="room-opt keep-busy" data-keep="1">` +
        `<span>Оставить ${esc(current.join(', '))}</span>` +
        `<span class="cap bad">аудитория занята — поставить с предупреждением</span></div>`
      : '';
    $('roomList').innerHTML =
      keepBtn +
      (options.length
        ? options
            .map(
              (r) =>
                `<div class="room-opt ${r.fits === false ? 'no-fit' : ''}" data-room="${esc(r.name)}">` +
                `<span>${esc(r.name)}${roomSub(r) ? `<br><small class="room-note">${esc(roomSub(r))}</small>` : ''}</span>` +
                `<span class="cap ${r.fits === false ? 'bad' : ''}">${r.capacity == null ? 'вместимость ?' : 'мест: ' + r.capacity}${r.fits === false ? ' · мало' : ''}</span></div>`
            )
            .join('')
        : '<div class="file-status">Нет свободных аудиторий в этот слот</div>');
    $('roomList')
      .querySelectorAll('.room-opt')
      .forEach((el) => {
        el.onclick = async () => {
          if (el.dataset.keep) {
            $('roomModal').classList.remove('open');
            await apply(current); // свои аудитории как есть — подтверждение спросит сервер
            return;
          }
          if (pickN <= 1) {
            $('roomModal').classList.remove('open');
            await apply([...kept, el.dataset.room]);
            return;
          }
          // Многократный выбор: копим, переносим по достижении нужного числа.
          const name = el.dataset.room;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          el.classList.toggle('selected', selected.has(name));
          if (selected.size === pickN) {
            $('roomModal').classList.remove('open');
            await apply([...kept, ...selected]);
          }
        };
      });
    $('roomModal').classList.add('open');
  }

  /* ---------- Копирование/удаление: ПКМ и горячие клавиши ---------- */
  // ПКМ по занятию — меню «Копировать/Удалить». Копирование подсвечивает ячейки,
  // где свободны группа(ы) потока и преподаватель (данные /api/move-options —
  // исходный слот пропускается, т.к. копия задвоила бы оригинал). Вставка — ПКМ
  // или Ctrl+V по подсвеченной ячейке; занятая аудитория (пунктир) — через выбор
  // замены. Сервер (POST /api/lessons) повторно валидирует поток/накладки/вместимость.
  let copyLesson = null; // занятие в «буфере копирования» (режим вставки активен)
  let copyOriginGroup = null; // столбец-группа в сводном виде
  let copyOriginRoom = null; // столбец-аудитория в сводном по аудиториям
  let hoverLessonEl = null; // карточка занятия под курсором (для Ctrl+C/Delete)
  let hoverCell = null; // ячейка под курсором (для Ctrl+V)
  let ctxMenu = null;

  function hideCtxMenu() {
    if (ctxMenu) ctxMenu.classList.remove('open');
  }

  function showCtxMenu(e, items) {
    if (!ctxMenu) {
      ctxMenu = document.createElement('div');
      ctxMenu.className = 'ctx-menu';
      document.body.appendChild(ctxMenu);
      document.addEventListener('click', hideCtxMenu);
      document.addEventListener('scroll', hideCtxMenu, true);
    }
    ctxMenu.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${esc(it.label)}${it.hk ? `<span class="hk">${it.hk}</span>` : ''}`;
      b.onclick = (ev) => {
        ev.stopPropagation();
        hideCtxMenu();
        it.run();
      };
      ctxMenu.appendChild(b);
    }
    ctxMenu.classList.add('open');
    // Позиционирование у курсора, не выезжая за край окна.
    ctxMenu.style.left = '0px';
    ctxMenu.style.top = '0px';
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 4)}px`;
    ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 4)}px`;
  }

  // Ячейка сетки → предзаполнение формы добавления: слот + столбец сводного вида
  // (группа или аудитория) либо открытый объект (группа/аудитория) обычного вида.
  function slotPrefill(cell) {
    if (!cell) return undefined;
    const weekNo = cell.dataset.week ? Number(cell.dataset.week) : state.week;
    return {
      day: cell.dataset.day,
      pairNo: Number(cell.dataset.pair),
      weekNo,
      group: cell.dataset.group || (state.kind === 'group' ? state.entityId : '') || '',
      room: cell.dataset.room || (state.kind === 'room' ? state.entityId : '') || '',
    };
  }

  // Начать копирование: подсветить ячейки, куда занятие можно вставить.
  async function startCopy(lesson, el) {
    exitCopyMode();
    const sem = state.mode === 'semester';
    const summary = state.mode === 'summary';
    // Сводное по аудиториям: столбец — аудитория, цели ищем в столбце своей аудитории.
    const roomSum = summary && state.summaryKind === 'room';
    const cellOf = el.closest('td.slot');
    copyOriginGroup = summary && !roomSum
      ? (cellOf && cellOf.dataset.group) || (lesson.groups || [])[0]
      : null;
    copyOriginRoom = roomSum ? ((cellOf && cellOf.dataset.room) || roomsOf(lesson)[0]) : null;

    const url = sem
      ? `/api/move-options?lessonId=${lesson.id}`
      : `/api/move-options?lessonId=${lesson.id}&weekNo=${state.week}`;
    let slots;
    try {
      ({ slots } = await api.get(url));
    } catch (err) {
      return toast(err.message, true);
    }

    let count = 0;
    for (const s of slots) {
      if (!(s.groupFree && s.teacherFree)) continue;
      // Исходный слот пропускаем: копия рядом с оригиналом — двойная накладка.
      if (s.day === lesson.day && s.pairNo === lesson.pairNo && s.weekNo === lesson.weekNo) continue;
      let sel;
      if (sem) sel = `td.slot[data-day="${s.day}"][data-pair="${s.pairNo}"][data-week="${s.weekNo}"]`;
      else if (roomSum) sel = `td.slot[data-room="${cssEsc(copyOriginRoom)}"][data-day="${s.day}"][data-pair="${s.pairNo}"]`;
      else if (summary) sel = `td.slot[data-group="${cssEsc(copyOriginGroup)}"][data-day="${s.day}"][data-pair="${s.pairNo}"]`;
      else sel = `td.slot[data-day="${s.day}"][data-pair="${s.pairNo}"]`;
      const cell = $('gridWrap').querySelector(sel);
      if (!cell) continue;
      cell.classList.add('free-target', 'copy-target');
      cell.classList.toggle('room-busy', !s.roomFree);
      cell.dataset.roomFree = s.roomFree ? '1' : '0';
      count++;
    }
    copyLesson = lesson;
    // Буфер — такая же цель вставки, как ячейка: копия ложится туда без слота.
    $('bufferPanel').classList.add('free-buffer', 'copy-target');
    const where = count ? 'подсвеченной ячейке или буферу' : 'буферу (свободных ячеек в этом виде нет)';
    toast(`Копирование «${lesson.subject || '—'}»: ПКМ или Ctrl+V по ${where} — вставить, Esc — отмена`);
  }

  function exitCopyMode() {
    copyLesson = null;
    copyOriginGroup = null;
    copyOriginRoom = null;
    $('bufferPanel').classList.remove('free-buffer', 'copy-target');
    $('gridWrap').querySelectorAll('td.slot.copy-target').forEach((c) => {
      c.classList.remove('free-target', 'copy-target', 'room-busy');
      delete c.dataset.roomFree;
    });
  }

  async function pasteCopy(cell) {
    const lesson = copyLesson;
    if (!lesson) return;
    const weekNo = cell.dataset.week ? Number(cell.dataset.week) : state.week;
    const target = { day: cell.dataset.day, pairNo: Number(cell.dataset.pair), weekNo };
    const roomOk = cell.dataset.roomFree === '1';
    exitCopyMode();
    if (roomOk) await doCopy(lesson, target, roomsOf(lesson));
    else openRoomPicker(lesson, target, (rooms) => doCopy(lesson, target, rooms));
  }

  // Вставка копии в буфер: слот не занимается, поэтому ни аудитории, ни
  // подтверждений не требуется — день/пара/неделя остаются как «снято с».
  async function pasteCopyToBuffer() {
    const lesson = copyLesson;
    if (!lesson) return;
    exitCopyMode();
    try {
      await api.post('/api/lessons', {
        day: lesson.day,
        pairNo: lesson.pairNo,
        weekNo: lesson.weekNo,
        subject: lesson.subject || '',
        type: lesson.type || '',
        topic: lesson.topic || '',
        teacher: lesson.teacher || '',
        groups: lesson.groups || [],
        rooms: roomsOf(lesson),
        category: lesson.category === 'event' ? 'event' : undefined,
        parked: 1,
      });
      toast('Копия занятия — в буфере');
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  async function doCopy(lesson, target, rooms) {
    try {
      const res = await withConfirm((extra) => api.post('/api/lessons', {
        ...target,
        subject: lesson.subject || '',
        type: lesson.type || '',
        topic: lesson.topic || '',
        teacher: lesson.teacher || '',
        groups: lesson.groups || [],
        rooms,
        category: lesson.category === 'event' ? 'event' : undefined,
        ...extra,
      }));
      if (res.cancelled) return;
      const r = res.data;
      toast(r.warning ? `Скопировано · ⚠ ${r.warning}` : 'Занятие скопировано');
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Удаление с подтверждением (общая часть ПКМ/Delete и карточки занятия).
  async function removeLesson(lesson) {
    if (lesson.editable === false) { toast(lesson.readOnlyReason || 'Занятие доступно только для просмотра', true); return false; }
    const isStream = (lesson.groups || []).length > 1;
    const msg = isStream
      ? `Это потоковое занятие для групп: ${(lesson.groups || []).join(', ')}. Вы уверены, что хотите удалить его для всего потока?`
      : 'Удалить это занятие?';
    if (!confirm(msg)) return false;
    try {
      await api.del(`/api/lesson/${lesson.id}`, { expectedRevision: lesson.revision });
      toast('Занятие удалено');
      refreshUndo();
      render();
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  function setupCopyPaste() {
    const wrap = $('gridWrap');

    // Отслеживание, что под курсором (для горячих клавиш).
    wrap.addEventListener('mouseover', (e) => {
      hoverLessonEl = e.target.closest('.lesson[data-lesson]');
      hoverCell = e.target.closest('td.slot');
    });

    wrap.addEventListener('contextmenu', (e) => {
      hideCtxMenu();
      // Режим копирования: ПКМ по подсвеченной ячейке — вставить.
      const cell = e.target.closest('td.slot.copy-target');
      if (copyLesson && cell) {
        e.preventDefault();
        pasteCopy(cell);
        return;
      }
      // ПКМ по ячейке с датой — примечание к этой дате (подсветит дату в сетке).
      const dateCell = e.target.closest('[data-date]');
      if (dateCell) {
        e.preventDefault();
        const has = noteIndexFor(dateCell.dataset.date, noteGroupOf(dateCell)) >= 0;
        showCtxMenu(e, [
          {
            label: has ? '📝 Изменить примечание к дате' : '📝 Добавить примечание к дате',
            run: () => openDateNote(dateCell),
          },
        ]);
        return;
      }
      const el = e.target.closest('.lesson[data-lesson]');
      if (!el) {
        // ПКМ по ячейке без занятия — добавить занятие прямо в этот слот. В сводном
        // виде столбец задаёт группу (или аудиторию) — подставляем их в форму.
        const slot = e.target.closest('td.slot');
        if (!slot || !slot.dataset.day || !slot.dataset.pair) return;
        e.preventDefault();
        showCtxMenu(e, [
          { label: '+ Добавить занятие сюда', run: () => openAddLesson(slotPrefill(slot)) },
        ]);
        return;
      }
      e.preventDefault();
      const lesson = JSON.parse(el.dataset.lesson);
      if (lesson.editable === false) {
        showCtxMenu(e, [{ label: '🔒 Только просмотр', run: () => openDetails(lesson) }]);
        return;
      }
      showCtxMenu(e, [
        { label: 'Копировать', hk: 'Ctrl+C', run: () => startCopy(lesson, el) },
        { label: 'Удалить', hk: 'Delete', run: () => removeLesson(lesson) },
        { label: '+ Добавить занятие сюда', run: () => openAddLesson(slotPrefill(el.closest('td.slot'))) },
      ]);
    });

    // Горячие клавиши: Ctrl+C — копировать занятие под курсором, Ctrl+V —
    // вставить в подсвеченную ячейку под курсором, Delete — удалить занятие
    // под курсором, Esc — отменить копирование. e.code — независимо от раскладки.
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.matches('input, select, textarea') || t.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop.open')) return;
      if (pickMode) return;

      if (e.key === 'Escape') {
        hideCtxMenu();
        if (copyLesson) {
          e.preventDefault();
          exitCopyMode();
          toast('Копирование отменено');
        }
        return;
      }
      const overLesson = hoverLessonEl && hoverLessonEl.isConnected ? hoverLessonEl : null;
      if (e.key === 'Delete') {
        if (overLesson) {
          e.preventDefault();
          removeLesson(JSON.parse(overLesson.dataset.lesson));
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.code === 'KeyC') {
        // Выделенный текст пользователь копирует как текст — не перехватываем.
        if (String(document.getSelection())) return;
        if (overLesson) {
          e.preventDefault();
          startCopy(JSON.parse(overLesson.dataset.lesson), overLesson);
        }
      } else if (e.code === 'KeyV') {
        if (!copyLesson) return;
        if (hoverCell && hoverCell.isConnected && hoverCell.classList.contains('copy-target')) {
          e.preventDefault();
          pasteCopy(hoverCell);
        } else if ($('bufferPanel').matches(':hover')) {
          e.preventDefault();
          pasteCopyToBuffer();
        }
      }
    });
  }

  /* ---------- Буфер занятий (временное хранение) ---------- */

  // Компактная карточка-иконка для узкого буфера. Полные данные — в подсказке
  // (title) и по клику (карточка занятия).
  function bufferCard(l) {
    const tip =
      `${l.subject || '—'} ${l.type || ''}\n` +
      `ауд: ${roomStr(l) || '—'}\n` +
      `гр: ${(l.groups || []).join(', ') || '—'}\n` +
      `${l.teacher || (isSR(l) ? 'СР' : '? преподаватель')}\n` +
      // Занятие в буфере ко времени не привязано — слот показываем только как
      // «откуда его сняли», чтобы было понятно, что вернуть можно куда угодно.
      `в буфере (без даты) · снято с: ${l.day || '—'} часы ${SC.pairHours(l.pairNo) || '?'} · нед ${l.weekNo || '?'}`;
    return (
      `<div class="lesson parked ${l.teacher || isSR(l) ? '' : 'no-teacher'}" draggable="true" title="${esc(tip)}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="bc-subj">${esc(l.subject || '—')}</div>` +
      `<div class="bc-type">${esc(l.type || '')}</div></div>`
    );
  }

  async function renderBuffer() {
    let lessons = [];
    try {
      const d = await api.get('/api/parked');
      lessons = d.lessons || [];
    } catch {
      lessons = [];
    }
    const list = $('bufferList');
    list.innerHTML = lessons.map(bufferCard).join('');
    list.querySelectorAll('.lesson[draggable="true"]').forEach((el) => {
      el.addEventListener('dragstart', (e) => onDragStart(e, JSON.parse(el.dataset.lesson), el));
      el.addEventListener('dragend', clearDnD);
      el.addEventListener('click', () => openDetails(JSON.parse(el.dataset.lesson)));
    });
  }

  /* ---------- Не размещённые при импорте (полоса под сеткой) ---------- */
  // Пары из файлов преподавателей, попавшие на «ЭкзС» группы: в сетке для них
  // места нет, но и терять их нельзя. Карточка несёт класс parked — весь путь
  // перетаскивания в сетку у неё общий с буфером (см. onDragStart).
  function orphanCard(l) {
    const tip =
      `${l.subject || '—'} ${l.type || ''}
` +
      `гр: ${(l.groups || []).join(', ') || '—'}
` +
      `${l.teacher || '? преподаватель'}
` +
      `ауд: ${roomStr(l) || '—'}
` +
      `из файла преподавателя: ${l.day || '—'} часы ${SC.pairHours(l.pairNo) || '?'} · нед ${l.weekNo || '?'} (у группы там ЭкзС)`;
    return (
      `<div class="lesson parked ${l.teacher ? '' : 'no-teacher'}" draggable="true" title="${esc(tip)}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="oc-sub">${esc(l.subject || '—')} ${esc(l.type || '')}</div>` +
      `<div class="oc-meta">${esc((l.groups || []).join(', ') || '—')}</div>` +
      `<div class="oc-meta">${esc(l.teacher || '? преподаватель')}</div>` +
      `<div class="oc-meta">${esc(l.day || '—')} · ${esc(SC.pairHours(l.pairNo) || '?')} · нед ${esc(String(l.weekNo || '?'))}</div></div>`
    );
  }

  async function renderOrphans() {
    let lessons = [];
    try {
      const d = await api.get('/api/orphans');
      lessons = d.lessons || [];
    } catch {
      lessons = [];
    }
    $('orphanPanel').hidden = !lessons.length;
    if (!lessons.length) return;
    $('orphanCount').textContent = `(${lessons.length})`;
    const list = $('orphanList');
    list.innerHTML = lessons.map(orphanCard).join('');
    list.querySelectorAll('.lesson[draggable="true"]').forEach((el) => {
      el.addEventListener('dragstart', (e) => onDragStart(e, JSON.parse(el.dataset.lesson), el));
      el.addEventListener('dragend', clearDnD);
      el.addEventListener('click', () => openDetails(JSON.parse(el.dataset.lesson)));
    });
  }

  // Очистить полосу «Не размещённые» (откат — кнопкой «Отменить»).
  async function clearOrphans() {
    if (!confirm('Удалить все не размещённые занятия? Действие можно отменить кнопкой «Отменить».')) return;
    try {
      const r = await api.post('/api/orphans/clear');
      toast(`Удалено не размещённых: ${r.deleted}`);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Очистить буфер: удалить все отложенные занятия (с подтверждением; откат — «Отменить»).
  async function clearBuffer() {
    if (!confirm('Удалить все отложенные занятия из буфера? Действие можно отменить кнопкой «Отменить».')) return;
    try {
      const r = await api.post('/api/parked/clear');
      toast(`Буфер очищен: удалено ${r.deleted}`);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Отложить занятие в буфер (через перетаскивание из сетки).
  async function park(lessonId) {
    try {
      const lesson = (state.lessons || []).find((l) => l.id === lessonId);
      await api.post(`/api/lesson/${lessonId}/park`, { expectedRevision: lesson && lesson.revision });
      toast('Занятие отложено в буфер');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Свернуть/развернуть правую полосу буфера (с запоминанием в localStorage).
  function applyBufferCollapsed(collapsed) {
    document.querySelector('.admin-layout').classList.toggle('buffer-collapsed', collapsed);
    const btn = $('bufferToggle');
    btn.textContent = collapsed ? '⟨' : '⟩';
    btn.setAttribute('aria-label', collapsed ? 'Развернуть буфер' : 'Свернуть буфер');
  }

  function toggleBuffer() {
    const collapsed = !document.querySelector('.admin-layout').classList.contains('buffer-collapsed');
    applyBufferCollapsed(collapsed);
    localStorage.setItem('bufferCollapsed', collapsed ? '1' : '0');
  }

  // Свернуть/развернуть левую панель (импорт/представление/действия).
  function applySidebarCollapsed(collapsed) {
    document.querySelector('.admin-layout').classList.toggle('sidebar-collapsed', collapsed);
    const btn = $('sidebarToggle');
    btn.textContent = collapsed ? '⟩' : '⟨';
    btn.setAttribute('aria-label', collapsed ? 'Развернуть панель' : 'Свернуть панель');
  }

  function toggleSidebar() {
    const collapsed = !document.querySelector('.admin-layout').classList.contains('sidebar-collapsed');
    applySidebarCollapsed(collapsed);
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  }

  // Буфер как зона сброса: туда можно перетащить занятие из сетки.
  function setupBufferDrop() {
    const panel = $('bufferPanel');
    panel.addEventListener('dragover', (e) => {
      if (dragLesson && !dragFromBuffer) {
        e.preventDefault();
        panel.classList.add('drag-over');
      }
    });
    panel.addEventListener('dragleave', (e) => {
      if (e.target === panel) panel.classList.remove('drag-over');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('drag-over');
      if (dragLesson && !dragFromBuffer) park(dragLesson.id);
    });
    // Режим копирования: ПКМ по буферу — вставить копию туда (как по ячейке).
    panel.addEventListener('contextmenu', (e) => {
      if (!copyLesson) return;
      e.preventDefault();
      hideCtxMenu();
      pasteCopyToBuffer();
    });
  }

  // Семестровая сетка: строки — дни недели (с парами), столбцы — учебные недели.
  function buildSemesterGrid(lessons) {
    const maxWeek = lessons.reduce((m, l) => Math.max(m, l.weekNo || 0), 0) || 26;
    const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
    const at = (day, pair, wk) => lessons.filter((l) => l.day === day && l.pairNo === pair && l.weekNo === wk);

    let html = '<div class="grid-scroll"><table class="grid semester"><thead><tr><th class="day-col">День</th><th class="pair-col">Часы</th>';
    for (const w of weeks) html += `<th class="wk-head">${w}</th>`;
    html += '</tr></thead><tbody>';

    for (const d of DAYS) {
      const dayPairs = SC.pairsForDay(d);
      // Даты дня — отдельной строкой над парами (как в бумажном образце). Раньше
      // дата жила внутри ячейки первой пары: она разъезжалась с сеткой и на
      // печати «съедала» нижнюю границу этой строки.
      html += `<tr class="date-row"><td class="day-col" rowspan="${dayPairs.length + 1}">${d}</td>`;
      html += '<td class="pair-col date-label">Даты</td>';
      for (const w of weeks) {
        const hol = isHolidayDay(w, d);
        const n = dateCellAttrs(w, d); // примечание к дате: подсветка + подсказка
        html += `<td class="date-cell${hol ? ' holiday-col' : ''}${n.cls}"${n.attrs}${n.tip}>${esc(dateOf(w, d) || '')}</td>`;
      }
      html += '</tr>';

      for (const p of dayPairs) {
        html += '<tr>';
        html += `<td class="pair-col">${SC.pairHours(p)}<br>${PAIR_TIMES[p]}</td>`;
        for (const w of weeks) {
          const cellLessons = at(d, p, w);
          const hasEvent = cellLessons.some((l) => l.category === 'event');
          const hol = isHolidayDay(w, d);
          html += `<td class="slot${hol ? ' holiday-col' : ''}${hasEvent ? ' slot-event' : ''}" data-day="${d}" data-pair="${p}" data-week="${w}">`;
          for (const l of cellLessons) html += sourceCard(l);
          if (hol && !cellLessons.length) html += '<div class="holiday-mark">Вых</div>';
          html += '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>';
    html += semesterSummaryTable(lessons);
    if (state.kind === 'teacher') html += TT.listHtml(lessons, teacherTablesCtx());
    html += subjectsTable();
    html += legendFooter();
    $('gridWrap').innerHTML = html;
    TT.bindList();
    bindLessonClicks();
    setupDnD();
    fillHlValues();
    applyHighlights();
    sizeSubjectTextareas();
    applyReliefMarks();
  }

  // Подгоняет высоту авто-растущих полей таблицы дисциплин под их содержимое.
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  function sizeSubjectTextareas() {
    $('gridWrap').querySelectorAll('textarea.subj-input').forEach(autoGrow);
  }

  // Таблица дисциплин ИЗ HTML-ФАЙЛА выбранной группы (подвал файла). Все столбцы
  // редактируемые. Показывается только в расписании группы — у каждой свой
  // перечень. Источник — карта state.groupSubjects (импорт). Фамилии из «Лектор»
  // и «Другие виды занятий» попадают в выпадающие списки преподавателей занятий.
  // multi: широкий столбец со свободным текстом — рендерится как авто-растущая
  // textarea с переносом строк (узкие поля остаются однострочными input).
  const SUBJ_COLS = [
    { field: 'abbr', title: 'Обозн.', ph: 'Обозн.' },
    { field: 'fullName', title: 'Дисциплина', ph: 'Название дисциплины', multi: true },
    { field: 'dept', title: 'Каф.', ph: '№' },
    { field: 'lecturer', title: 'Лектор, уч. степень, уч. звание', ph: 'Фамилия И.О., степень, звание', multi: true },
    { field: 'others', title: 'Другие виды занятий', ph: 'Фамилии через ; или с новой строки', multi: true },
    { field: 'hours', title: 'Кол-во часов', ph: 'напр. 32-40' },
    { field: 'report', title: 'Отчёт.', ph: '' },
  ];

  function subjectsTable() {
    if (state.kind !== 'group' || !state.entityId) return '';
    const subs = (state.groupSubjects && state.groupSubjects[state.entityId]) || [];
    if (!subs.length) return '';

    let html = '<div class="subjects-block"><h2 class="subjects-title">Дисциплины и преподаватели</h2>';
    html += '<p class="subjects-hint">Все поля редактируются (сохранение по Enter или при уходе из поля). Несколько преподавателей — через «;». Фамилии из «Лектор» и «Другие виды занятий» появляются в списке преподавателей при добавлении/правке занятия. «×» удаляет дисциплину вместе с её занятиями у этой группы (обратимо кнопкой «Отменить»).</p>';
    html += '<div class="grid-scroll"><table class="grid subjects-table"><thead><tr>';
    for (const c of SUBJ_COLS) html += `<th class="subj-${c.field}">${esc(c.title)}</th>`;
    html += '<th class="subj-del"></th>';
    html += '</tr></thead><tbody>';
    const planCheck = state.planCheck || null;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      html += '<tr>';
      for (const c of SUBJ_COLS) {
        let value = s[c.field] == null ? '' : s[c.field];
        let tdClass = `subj-${c.field}`;
        let titleAttr = '';
        let missClass = '';
        // «Отчёт.» — вносим отчётность прямо в поле из учебного плана (дополняя
        // имеющееся), а ячейку красим + подсказка, если её нет в расписании.
        if (c.field === 'report' && planCheck) {
          const r = planCheck.get(s.abbr);
          value = SC.mergeReportValue(value, r);
          const info = planReportInfo(r);
          if (info) {
            titleAttr = ` title="${esc(info.tip)}"`;
            if (info.miss) { tdClass += ' rep-miss-cell'; missClass = ' rep-miss-field'; }
          }
        }
        const attrs = `class="subj-input${missClass}" data-index="${i}" data-field="${c.field}" placeholder="${esc(c.ph)}"${titleAttr}`;
        const field = c.multi
          ? `<textarea ${attrs} rows="1">${esc(value)}</textarea>`
          : `<input ${attrs} type="text" value="${esc(value)}">`;
        html += `<td class="${tdClass}">${field}</td>`;
      }
      html += `<td class="subj-del"><button type="button" class="subj-del-btn" data-index="${i}" data-abbr="${esc(s.abbr || '')}" title="Удалить дисциплину и её занятия у этой группы">×</button></td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<button type="button" class="btn secondary sm" id="btnAddSubject">+ Дисциплина</button>';
    html += '</div>';
    return html;
  }

  // Подсказка/флаг для ячейки «Отчёт.»: что положено по плану в этом семестре и
  // есть ли это в расписании. Если формы контроля нет в сетке — miss=true (красим
  // ячейку) и подсказка с действием: какие коды (ЭКЗ/ЗО/КР) внести в расписание.
  function planReportInfo(r) {
    if (!r) return null;
    const forms = []; // [метка плана, код для сетки, есть ли в расписании]
    if (r.expExam) forms.push(['Экз', 'ЭКЗ', r.hasExam]);
    if (r.expZach) forms.push(['Зач', r.expZachUngraded && !r.expZachGraded ? 'Зч' : 'ЗО', r.hasZachet]);
    if (r.expCourse) forms.push(['Курс.', 'КР', r.hasCoursework]);
    if (!forms.length) return null;
    const missing = forms.filter((f) => !f[2]).map((f) => f[1]);
    if (missing.length) {
      return {
        miss: true,
        tip: `Нет в сетке: ${missing.join(', ')}. Внесите ${missing.join(' / ')} в расписание — по уч. плану положено в этом семестре.`,
      };
    }
    return {
      miss: false,
      tip: 'Отчётность по уч. плану есть в расписании: ' + forms.map((f) => f[0]).join(', '),
    };
  }

  // Сохранить всю строку таблицы дисциплин (собираем все поля строки). Локальную
  // карту обновляем на месте, чтобы правки не потерялись при ре-рендере сетки.
  /* ---------- Дисциплины группы: добавление и удаление строк ---------- */
  // Справочник дисциплин для выпадающего списка формы добавления.
  let asSubjects = [];

  async function openAddSubject() {
    const group = state.entityId;
    if (!group) return;
    $('asGroup').textContent = `Группа ${group}`;
    $('asMsg').textContent = '';
    for (const id of ['asAbbr', 'asFull', 'asDept', 'asHours', 'asReport', 'asLecturer', 'asOthers']) $(id).value = '';
    try {
      const { subjects } = await api.get('/api/subjects');
      asSubjects = subjects || [];
    } catch {
      asSubjects = [];
    }
    // Уже добавленные группе дисциплины в списке не предлагаем.
    const have = new Set(((state.groupSubjects && state.groupSubjects[group]) || []).map((s) => String(s.abbr || '')));
    $('asPick').innerHTML =
      '<option value="">— новая дисциплина —</option>' +
      asSubjects
        .filter((s) => !have.has(s.abbr))
        .map((s) => `<option value="${esc(s.abbr)}">${esc(s.abbr)}${s.fullName ? ' — ' + esc(s.fullName) : ''}</option>`)
        .join('');
    $('addSubjectModal').classList.add('open');
  }

  // Выбор из справочника подставляет известные поля; их можно поправить руками.
  function applySubjectPick() {
    const abbr = $('asPick').value;
    if (!abbr) return;
    const s = asSubjects.find((x) => x.abbr === abbr) || {};
    $('asAbbr').value = s.abbr || abbr;
    $('asFull').value = s.fullName || '';
    $('asDept').value = s.dept || '';
    const teachers = s.teachers || [];
    if (teachers.length && !$('asLecturer').value) $('asLecturer').value = teachers[0];
  }

  async function saveNewSubject() {
    const group = state.entityId;
    const fields = {
      abbr: $('asAbbr').value.trim() || $('asPick').value.trim(),
      fullName: $('asFull').value.trim(),
      dept: $('asDept').value.trim(),
      hours: $('asHours').value.trim(),
      report: $('asReport').value.trim(),
      lecturer: $('asLecturer').value.trim(),
      others: $('asOthers').value.trim(),
    };
    if (!fields.abbr) return ($('asMsg').textContent = 'Укажите обозначение дисциплины');
    try {
      const r = await api.post('/api/group-subjects', { group, fields });
      $('addSubjectModal').classList.remove('open');
      const added = (r.teachers || []).join(', ');
      toast(`Дисциплина ${fields.abbr} добавлена группе ${group}` + (added ? ` · преподаватели: ${added}` : ''));
      await loadGroupSubjects();
      // Новые фамилии из подвала — это новые преподаватели: перечитываем списки,
      // чтобы их расписание сразу открывалось в виде «Преподаватель».
      await refreshEntities();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      $('asMsg').textContent = reasons.join('; ');
    }
  }

  // Удаление строки вместе с занятиями этой дисциплины у группы (обратимо).
  async function deleteSubjectRow(index, abbr) {
    const group = state.entityId;
    if (!group) return;
    const msg =
      `Удалить дисциплину «${abbr || '—'}» из списка группы ${group}?\n\n` +
      'Вместе с ней будут удалены её занятия у этой группы в расписании. ' +
      'Действие можно отменить кнопкой «Отменить».';
    if (!confirm(msg)) return;
    try {
      const r = await api.del('/api/group-subjects', { group, index });
      const parts = [`Дисциплина ${abbr || ''} удалена`];
      if (r.deleted) parts.push(`занятий удалено: ${r.deleted}`);
      if (r.modified) parts.push(`из потоковых убрана группа: ${r.modified}`);
      toast(parts.join(' · '));
      await loadGroupSubjects();
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  async function saveSubjectRow(inp) {
    const group = state.entityId;
    const index = Number(inp.dataset.index);
    const tr = inp.closest('tr');
    const fields = {};
    tr.querySelectorAll('.subj-input').forEach((el) => { fields[el.dataset.field] = el.value; });
    try {
      const r = await api.put('/api/group-subjects', { group, index, fields });
      const list = state.groupSubjects && state.groupSubjects[group];
      // Строки подвала отсортированы по обозначению: смена обозначения двигает
      // строку, и локальные индексы (по ним идут правка и удаление) устаревают —
      // перечитываем список целиком, а не патчим строку на месте.
      const moved = list && list[index] && r.entry && list[index].abbr !== r.entry.abbr;
      if (list && r.entry) list[index] = r.entry;
      inp.style.borderColor = 'var(--primary)';
      toast(r.teachers && r.teachers.length ? `Сохранено · преподаватели: ${r.teachers.join(', ')}` : 'Сохранено');
      await refreshEntities(); // вписанная фамилия могла завести нового преподавателя
      if (moved) {
        await loadGroupSubjects();
        render();
      }
    } catch (err) {
      inp.style.borderColor = 'var(--destructive)';
      toast(`Не удалось сохранить: ${err.message}`, true);
    }
  }

  // Подвал с обозначениями видов занятий — как в исходном HTML-файле расписания.
  function legendFooter() {
    const entries = Object.entries(state.legend || {});
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

  // Порядок видов занятий, разбор часов подвала и обе таблицы преподавателя —
  // в общем модуле /js/teacher-tables.js: те же таблицы показывает гостевая
  // страница, поэтому вёрстка и подсчёты живут в одном месте.
  const TT = window.TeacherTables;
  const { compareTypes, isLectureType, parseHoursExpected } = TT;

  // Карта «дисциплина → ожидаемые {lecH,pracH,totalH}» (часы) из подвала. Только
  // в виде группы — там есть таблица «Кол-во часов» (state.groupSubjects).
  function expectedCountsBySubject() {
    const map = new Map();
    if (state.kind !== 'group' || !state.entityId) return map;
    const subs = (state.groupSubjects && state.groupSubjects[state.entityId]) || [];
    for (const s of subs) {
      const exp = parseHoursExpected(s.hours);
      if (exp && s.abbr) map.set(s.abbr, exp);
    }
    return map;
  }

  // Сверка группы с учебным планом её кафедры. Возвращает Map(аббревиатура →
  // строка отчёта) или null, если плана/курса/семестра нет (тогда колонку не
  // показываем). Раскладку по семестру и сопоставление делает сервер.
  async function loadPlanCheck(group) {
    try {
      const r = await api.get('/api/curriculum/check?group=' + encodeURIComponent(group));
      const map = new Map();
      for (const row of r.rows || []) if (row.abbr) map.set(row.abbr, row);
      return map;
    } catch {
      return null;
    }
  }

  // Данные групп открытого преподавателя или дисциплины: расписание группы целиком
  // и сверка с её учебным планом. Нужны для столбцов «Всего у группы» и «Уч. план» —
  // они считают ВСЮ нагрузку группы, а не только пары этого преподавателя/дисциплины.
  async function loadGroupsSummary(url) {
    try {
      const r = await api.get(url);
      const m = new Map();
      for (const [g, d] of Object.entries(r.groups || {})) {
        m.set(g, {
          subjects: d.subjects || {}, // дисциплина → { lecH, pracH, zachetH } по ВСЕЙ группе
          plan: d.plan ? new Map(Object.entries(d.plan)) : null,
        });
      }
      return m;
    } catch {
      return new Map(); // без сводки таблица просто покажет прочерки
    }
  }

  // Сводная таблица за семестр: строки — дисциплины, столбцы — виды занятий.
  // Значения — в ЧАСАХ (1 занятие = 2 ч). Столбец «Итого» — «лекции-практика»
  // (часы), каждая часть сверяется с «Кол-во часов» подвала по отдельности
  // (зелёная — совпала, красная — нет).
  // Что из контроля включать в фактическую сумму часов столбца «Уч. план»:
  // по умолчанию зачёт учитываем, экзамен — нет. Переключается кликом по чипу.
  const planHoursOpt = new Map(); // subject → { zachet, exam }
  const planOptOf = (s) => planHoursOpt.get(s) || { zachet: true, exam: false };

  function semesterSummaryTable(lessons) {
    const real = lessons.filter((l) => l.subject && l.subject !== 'СР' && l.category !== 'event');
    if (!real.length) return '';
    // У преподавателя и дисциплины своя таблица: часы разбиты по учебным группам,
    // а сверка идёт по всей нагрузке группы (см. TeacherTables.summaryHtml).
    if (state.kind === 'teacher' || state.kind === 'subject') return TT.summaryHtml(real, teacherTablesCtx());

    // Колонка «Уч. план» — только для группы с загруженным планом (см. loadPlanCheck).
    const planCheck = state.planCheck || null;
    const planCell = (s) => {
      const r = planCheck.get(s);
      if (!r) return '<td class="ss-num ss-plan" title="Нет в учебном плане на этот семестр">—</td>';
      // Часы зачёта/экзамена из сетки (1 контроль = 2 ч). По умолчанию зачёт
      // идёт в сумму часов, экзамен — нет; клик по чипу переключает (planHoursOpt).
      const row = counts.get(s) || new Map();
      let zH = 0, eH = 0;
      for (const [t, n] of row) {
        const k = SC.assessmentKind(t);
        if (k === 'zachet') zH += n * 2;
        else if (k === 'exam') eH += n * 2;
      }
      const opt = planOptOf(s);
      const fact = r.factHours + (opt.zachet ? zH : 0) + (opt.exam ? eH : 0);
      const ok = r.planHours ? r.planHours === fact : r.ok;
      const cls = ok ? 'hh-ok' : 'hh-bad';
      const label = ok ? `✓ ${r.planHours} ч` : `${r.planHours}/${fact}`;
      const exp = [r.expExam ? 'экз' : '', r.expZach ? 'зач' : ''].filter(Boolean).join(', ');
      const tip = `${r.name}${r.auto ? ' (авто)' : ''}: ${r.status}${exp ? ' · ожид.: ' + exp : ''}`;
      const chip = (kind, lbl, h, on) =>
        `<span class="ss-plan-tog${on ? ' on' : ''}" data-subj="${esc(s)}" data-kind="${kind}" title="${esc(lbl)} ${h} ч ${on ? 'учитывается' : 'не учитывается'} в сумме часов — клик переключает">${on ? '✓' : '+'}${lbl}</span>`;
      let chips = '';
      if (zH) chips += chip('zachet', 'зач', zH, opt.zachet);
      if (eH) chips += chip('exam', 'экз', eH, opt.exam);
      return `<td class="ss-num ss-plan"><span class="${cls}" title="${esc(tip)}">${label}</span>${chips ? `<div class="ss-plan-togs">${chips}</div>` : ''}</td>`;
    };

    const expected = expectedCountsBySubject();
    const typeKey = (t) => (t || '').trim();
    const types = [...new Set(real.map((l) => typeKey(l.type)))].sort(compareTypes);
    const subjects = [...new Set(real.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ru'));

    const counts = new Map(); // subject → (type → число занятий)
    for (const l of real) {
      const row = counts.get(l.subject) || new Map();
      const t = typeKey(l.type);
      row.set(t, (row.get(t) || 0) + 1);
      counts.set(l.subject, row);
    }

    const colTotals = new Map(types.map((t) => [t, 0])); // в занятиях
    let grandLec = 0;
    let grandPrac = 0;

    let html = '<div class="sem-summary"><h2 class="sem-summary-title">Итоги по дисциплинам за семестр</h2>';
    html += '<p class="subjects-hint">Значения в часах (1 занятие = 2 ч). Столбец «Итого» — лекции-практика; сверяется с «Кол-во часов» подвала: зелёным — совпало, красным — нет.</p>';
    html += '<div class="grid-scroll"><table class="grid summary-table"><thead><tr>';
    html += '<th class="ss-subj">Дисциплина</th>';
    for (const t of types) html += `<th>${esc(t || '—')}</th>`;
    html += '<th class="ss-total">Итого, ч<br><small>лек-практ</small></th>';
    if (planCheck) html += '<th class="ss-plan">Уч. план<br><small>часы/статус</small></th>';
    html += '</tr></thead><tbody>';

    for (const s of subjects) {
      const row = counts.get(s) || new Map();
      let rowTotal = 0; // занятий всего
      let lecLessons = 0;
      html += `<tr><td class="ss-subj">${esc(s)}</td>`;
      for (const t of types) {
        const n = row.get(t) || 0;
        rowTotal += n;
        if (isLectureType(t)) lecLessons += n;
        colTotals.set(t, colTotals.get(t) + n);
        html += `<td class="ss-num">${n ? n * 2 : ''}</td>`; // часы
      }
      grandLec += lecLessons;
      grandPrac += rowTotal - lecLessons;

      const lecH = lecLessons * 2;
      const pracH = (rowTotal - lecLessons) * 2;
      // Сверка с подвалом по отдельности: лекции и практика.
      const exp = expected.get(s);
      let cell;
      let title = '';
      if (exp) {
        const lecCls = lecH === exp.lecH ? 'hh-ok' : 'hh-bad';
        const pracCls = pracH === exp.pracH ? 'hh-ok' : 'hh-bad';
        cell = `<span class="${lecCls}">${lecH}</span>-<span class="${pracCls}">${pracH}</span>`;
        title = ` title="Лекции: ${lecH}/${exp.lecH} ч · Практ.: ${pracH}/${exp.pracH} ч (факт/план)"`;
      } else {
        cell = `${lecH}-${pracH}`;
      }
      html += `<td class="ss-num ss-total"${title}>${cell}</td>`;
      if (planCheck) html += planCell(s);
      html += '</tr>';
    }

    html += '<tr class="ss-foot"><td class="ss-subj">Итого</td>';
    for (const t of types) html += `<td class="ss-num">${colTotals.get(t) * 2}</td>`;
    html += `<td class="ss-num ss-total">${grandLec * 2}-${grandPrac * 2}</td>`;
    if (planCheck) html += '<td class="ss-plan"></td>';
    html += '</tr>';
    html += '</tbody></table></div></div>';
    return html;
  }

  // Контекст таблиц преподавателя для общего модуля: данные, правка строки и
  // кнопки переноса/карточки. В админке правятся вид занятия, тема и примечание.
  function teacherTablesCtx() {
    return {
      teacherGroups: state.teacherGroups,
      groupSubjects: state.groupSubjects,
      kind: state.kind,
      // В виде «Дисциплина» подстроки — только отмеченные галочками группы
      // (чужие группы потока в этом виде не показываются нигде).
      onlyGroups: state.kind === 'subject' ? state.subjGroups : null,
      dateOf,
      editable: { 7: { field: 'type', options: typeOptions() }, 8: 'topic', 12: 'note' },
      canEdit: (id) => ((state.lessons || []).find((l) => l.id === id) || {}).editable !== false,
      // Шлём ТОЛЬКО изменённое поле: editLesson обновляет переданное, остальное
      // оставляет как есть, а слот не меняется — проверки накладок не трогаем.
      save: (id, field, value) => {
        const lesson = (state.lessons || []).find((l) => l.id === id);
        return api.put(`/api/lesson/${id}`, { [field]: value, expectedRevision: lesson && lesson.revision });
      },
      toast,
      onSaved: refreshLessonInGrid,
      onMove: startMoveFromList,
      onOpen: (id) => {
        const l = (state.lessons || []).find((x) => x.id === id);
        if (l) openDetails(l);
      },
    };
  }

  // Виды занятий для выпадающего списка в перечне: справочник плюс виды, которые
  // реально стоят в занятиях (иначе строка с видом вне справочника стала бы
  // нередактируемой). Первый пункт пустой — «вид не указан».
  function typeOptions() {
    const used = (state.lessons || []).map((l) => l.type || '');
    const all = new Set([...(lessonTypes || []).map((t) => t.code), ...used].filter(Boolean));
    return ['', ...[...all].sort(compareTypes)];
  }

  // Правка строки перечня меняет сам объект занятия, но карточка в сетке и итоги
  // уже нарисованы старым значением. Перерисовываем ТОЛЬКО их: перечень не
  // трогаем, иначе пропадёт фокус в соседнем поле и уедет прокрутка таблицы.
  async function refreshLessonInGrid(id) {
    const l = (state.lessons || []).find((x) => x.id === id);
    if (!l) return;
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      let cur;
      try { cur = JSON.parse(el.dataset.lesson); } catch { return; }
      if (cur.id === id) el.outerHTML = sourceCard(l);
    });
    bindLessonClicks();
    setupDnD();
    applyHighlights();
    const sum = $('gridWrap').querySelector('.sem-summary');
    if (!sum) return;
    // Итоги считают виды занятий, а столбец «Всего у группы» — сервер по ВСЕМ
    // преподавателям группы, поэтому сводку перезапрашиваем (пустой ответ —
    // сеть подвела: оставляем прежнюю, иначе столбец схлопнется в прочерки).
    const fresh = await loadGroupsSummary(`/api/teacher-groups?teacher=${encodeURIComponent(state.entityId)}`);
    if (fresh.size) state.teacherGroups = fresh;
    sum.outerHTML = semesterSummaryTable(state.lessons);
  }

  // Перенос занятия из перечня: поднимаемся к сетке, подсвечиваем свободные окна
  // (те же, что при перетаскивании) и ждём клика по одному из них.
  async function startMoveFromList(id) {
    const l = (state.lessons || []).find((x) => x.id === id);
    if (!l) return;
    clearDnD();
    exitMoveMode();
    dragLesson = l;
    dragFromBuffer = false;
    moveMode = true;
    $('moveInfo').textContent =
      `Перенос: ${l.subject || '—'} ${(l.groups || []).join(', ')} · ${l.day}, ${SC.pairHours(l.pairNo)}, неделя ${l.weekNo}. Кликните подсвеченное окно.`;
    $('moveBanner').hidden = false;
    markMovingLesson(l.id); // затемняем то занятие, которое переносим
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await highlightMoveTargets(l, null);
    if (!$('gridWrap').querySelector('td.slot.free-target')) {
      exitMoveMode();
      toast('Свободных окон для этого занятия не нашлось', true);
    }
  }

  function exitMoveMode() {
    moveMode = false;
    $('moveBanner').hidden = true;
    clearDnD();
  }

  // Затемняет карточку переносимого занятия в сетке и подсвечивает его строку в
  // перечне: при переносе кликом (в отличие от перетаскивания) иначе не видно,
  // что именно едет. Снимается в clearDnD.
  function markMovingLesson(id) {
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      let l;
      try { l = JSON.parse(el.dataset.lesson); } catch { return; }
      if (l.id === id) el.classList.add('moving');
    });
    const row = $('gridWrap').querySelector(`tr[data-lid="${id}"]`);
    if (row) row.classList.add('tl-moving');
  }

  function buildGrid(lessons) {
    const ofWeek = lessons.filter((l) => l.weekNo === state.week);
    const at = (day, pair) => ofWeek.filter((l) => l.day === day && l.pairNo === pair);

    let html = '<table class="grid"><thead><tr><th class="time-col">Часы</th>';
    for (const d of DAYS) {
      const dt = dateOf(state.week, d);
      const hol = isHolidayDay(state.week, d);
      const n = dateCellAttrs(state.week, d); // примечание к дате
      html += `<th class="date-head${hol ? ' holiday-day' : ''}${n.cls}"${n.attrs}${n.tip}>${d}${dt ? `<br><small>${esc(dt)}</small>` : ''}${hol ? '<br><small class="hol-label">нерабочий</small>' : ''}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const p of PAIRS) {
      html += `<tr><td class="time-cell"><b>${SC.pairHours(p)}</b><br>${PAIR_TIMES[p]}</td>`;
      for (const d of DAYS) {
        // В субботу 4-й пары не бывает — рисуем пустую неинтерактивную ячейку.
        if (!SC.pairsForDay(d).includes(p)) {
          html += '<td class="no-pair"></td>';
          continue;
        }
        const hol = isHolidayDay(state.week, d);
        const cellLessons = at(d, p);
        const hasEvent = cellLessons.some((l) => l.category === 'event');
        html += `<td class="slot${hol ? ' holiday-col' : ''}${hasEvent ? ' slot-event' : ''}" data-day="${d}" data-pair="${p}">`;
        for (const l of cellLessons) html += lessonCard(l, true);
        // Нерабочий день — отметка «Вых» в пустой ячейке (слот заблокирован).
        if (hol && !cellLessons.length) html += '<div class="holiday-mark">Вых</div>';
        html += '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    $('gridWrap').innerHTML = html;
    bindLessonClicks();
    setupDnD();
    fillHlValues();
    applyHighlights();
    applyReliefMarks();
  }

  // 4 строки ячейки: вид, дисциплина, аудитория, преподаватель. Поле, и так
  // очевидное из текущего представления (аудитория — в виде аудитории и т. д.),
  // заменяется на список групп — раскладка зависит от представления.
  function sourceLines(l) {
    const top = l.topic ? `${l.type || ''}/${l.topic}` : l.type || '';
    // Тумблер «Преподаватель» гасит ФИО в сетке (список групп он не трогает:
    // это не фамилия, а единственный признак, по которому видно чужую пару).
    const fio = sumTeacher ? teacherFio(l) : '';
    // В расписании преподавателя сам преподаватель очевиден — вместо него группы.
    if (state.kind === 'teacher') return [top, l.subject || '', roomStr(l), (l.groups || []).join(', ')];
    // В расписании аудитории сама аудитория очевидна — вместо неё группы.
    if (state.kind === 'room') return [top, l.subject || '', (l.groups || []).join(', '), fio];
    // Дисциплина одна на весь экран — вместо неё ВЫБРАННЫЕ группы (чужие группы
    // потока не показываем, как и в выгрузке); аудитория и преподаватель — на
    // своих строках, у одной дисциплины их обычно несколько.
    if (state.kind === 'subject') {
      const picked = state.subjGroups;
      const groups = (l.groups || []).filter((g) => !picked || picked.has(g));
      return [top, groups.join(', '), roomStr(l), fio];
    }
    return [top, l.subject || '', roomStr(l), fio];
  }

  // Фамилия преподавателя занятия для ячейки дисциплины (двух — через «;»).
  function teacherFio(l) {
    const list = l.teachers && l.teachers.length ? l.teachers : (l.teacher ? [l.teacher] : []);
    return list.join('; ');
  }

  // Карточка мероприятия (ОП, Экз, Отп…) — не занятие: одна метка во всю ячейку,
  // свой стиль. Слот заблокирован для занятий, но мероприятие можно двигать/удалять.
  function eventCard(l, draggable) {
    const name = SC.eventName(l.subject || l.marker); // расшифровка метки (если есть)
    const title = (name ? `${name}\n` : '') + 'Мероприятие — слот заблокирован для занятий (вне нагрузки)';
    // 3 строки, как в семестровой сетке: вид/т, дисциплина (метка), аудитория.
    // Метку держим посередине в ЛЮБОМ представлении (sourceLines зависит от вида).
    const [a, b, c] = [l.type || '', l.subject || l.marker || '—', roomStr(l)].map(esc);
    return (
      `<div class="lesson event ${SC.eventKind(l.subject || l.marker)}"${draggable ? ' draggable="true"' : ''} data-lesson='${esc(JSON.stringify(l))}' title="${esc(title)}">` +
      `<div class="l1">${a}</div><div class="l2">${b}</div><div class="l3">${c}</div></div>`
    );
  }

  // Классы строк карточки по позициям: вид / дисциплина / аудитория / преподаватель.
  const SRC_LINE_CLASS = ['l1', 'l2', 'l3', 'l4'];

  // Пустые строки не выводим совсем: в семестровой сетке пустой div всё равно
  // занимает высоту, и с погашенным ФИО (тумблер «Преподаватель») вся таблица
  // была бы на строку выше нужного.
  function srcLinesHtml(l) {
    return sourceLines(l)
      .map((text, i) => (text ? `<div class="${SRC_LINE_CLASS[i]}">${esc(text)}</div>` : ''))
      .join('');
  }

  function sourceCard(l) {
    if (l.category === 'event') return eventCard(l, true);
    const hasTeacher = (l.teachers && l.teachers.length) || l.teacher || isSR(l);
    return (
      `<div class="lesson src ${hasTeacher ? '' : 'no-teacher'} ${typeClass(l.type)} ${SC.assessmentKind(l.type)} ${movedClass(l)} ${streamClass(l)}" draggable="true" title="${esc(lessonTitle(l))}" data-lesson='${esc(JSON.stringify(l))}'>` +
      srcLinesHtml(l) + '</div>'
    );
  }

  function lessonCard(l, draggable) {
    if (l.category === 'event') return eventCard(l, draggable);
    const tlist = (l.teachers && l.teachers.length) ? l.teachers : (l.teacher ? [l.teacher] : []);
    const noTeacher = !tlist.length && !isSR(l);
    const teacher = tlist.length
      ? esc(tlist.join(', '))
      : (isSR(l) ? '' : `<span class="warn">? преподаватель</span>`);
    return (
      `<div class="lesson ${noTeacher ? 'no-teacher' : ''} ${typeClass(l.type)} ${SC.assessmentKind(l.type)} ${movedClass(l)} ${streamClass(l)}" ${draggable ? 'draggable="true"' : ''} title="${esc(lessonTitle(l))}" data-lesson='${esc(JSON.stringify(l))}'>` +
      `<div class="meta">${esc(l.type || '')}</div>` +
      `<div class="subj">${esc(l.subject || '—')}</div>` +
      `<div class="meta">${esc(roomStr(l) || '—')}</div>`+
      `<div class="meta">${esc((l.groups || []).join(', '))}</div>` +
      `<div class="meta">${teacher}</div>` +
      `</div>`
    );
  }

  /* ----------------------- Карточка занятия ----------------------- */
  let detailing = null;
  let dRooms = []; // аудитории слота (свободные + занятые) — для подсказки о местах

  // Сколько мест нужно занятию в карточке: сумма численностей отмеченных групп.
  function detailsNeed() {
    const groups = Array.from(document.querySelectorAll('input[name="dGroup"]:checked')).map((el) => el.value);
    return needSeats(groups);
  }

  // Подсказка «нужно N мест» рядом с выбором аудитории в карточке занятия.
  // Пересчитывается при смене групп и аудиторий. Запрета нет: если мест мало,
  // сервер лишь спросит подтверждение — подсказка показывает это заранее.
  function detailsUpdateNeed() {
    const info = $('dNeedInfo');
    if (!info) return;
    const need = detailsNeed();
    if (need == null) {
      info.textContent = 'численность групп не задана';
      info.classList.remove('bad');
      return;
    }
    const picked = [$('dRoom').value, $('dRoom2').value].filter(Boolean);
    const caps = picked
      .map((n) => (dRooms.find((r) => r.name === n) || {}).capacity)
      .filter((c) => c != null);
    const total = caps.reduce((s, c) => s + c, 0);
    const short = caps.length && total < need;
    info.textContent = short ? `нужно ${need} мест, в аудиториях ${total} — не вмещает` : `нужно ${need} мест`;
    info.classList.toggle('bad', !!short);
  }

  // Группа-цель для массовой смены преподавателя: открытая в виде «Группа», иначе
  // первая группа занятия.
  function bulkGroupOf(lesson) {
    if (state.kind === 'group' && state.entityId && (lesson.groups || []).includes(state.entityId)) return state.entityId;
    return (lesson.groups || [])[0] || '';
  }

  async function openDetails(lesson) {
    detailing = lesson;
    // Плашка «перенесено» — если занятие есть в журнале переносов.
    const m = movedEntryFor(lesson);
    const banner = $('dMovedInfo');
    banner.innerHTML = '';
    banner.hidden = !m;
    if (m) {
      // Текст — по той же логике, что в журнале: последний шаг (предыдущая
      // ячейка → текущая) и последняя смена аудитории. Вся цепочка — по ссылке
      // в журнал, отфильтрованной по этому занятию.
      for (const line of movedLines(lesson)) {
        const div = document.createElement('div');
        div.textContent = line;
        banner.appendChild(div);
      }
      const a = document.createElement('a');
      a.className = 'btn secondary sm';
      a.style.marginTop = '6px';
      a.href = `/log.html?lesson=${lesson.id}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = m.steps > 1 ? `Вся цепочка в журнале (${m.steps})` : 'Показать в журнале';
      banner.appendChild(a);
    }
    // Плашка «в буфере»: у отложенного занятия привязки ко времени нет —
    // поля слота показывают, откуда его сняли, а накладки не проверяются.
    const parkedBanner = $('dParkedInfo');
    parkedBanner.hidden = !lesson.parked;
    parkedBanner.textContent = lesson.parked
      ? '⏸ Занятие в буфере — ко времени не привязано. Поля дня/пары/недели показывают, откуда оно снято; слот задаётся при возврате в сетку.'
      : '';
    // Слот
    $('dDay').value = lesson.day;
    $('dPair').value = String(lesson.pairNo);
    $('dWeek').value = lesson.weekNo;
    detailsUpdateDate();
    // Вид занятия (перечень из справочника; текущий добавляется, если его там нет)
    fillTypeSelect($('dType'), lesson.type);
    // Тема (исходное значение, не «человеческая» подпись — поле редактируемое)
    $('dTopic').value = lesson.topic || '';
    // Группы — чекбоксы всех видимых групп, текущие отмечены. Скрытые группы в
    // списке не показываем, НО собственные группы занятия добавляем всегда (даже
    // скрытые) — иначе при сохранении карточки они бы потерялись из занятия.
    const cur = new Set(lesson.groups || []);
    const visibleGroups = state.user && state.user.role === 'admin'
      ? ((state.entities && state.entities.groups) || [])
      : ((state.entities && state.entities.editableGroups) || []);
    const allGroups = [...new Set([...visibleGroups, ...cur])];
    $('dGroups').innerHTML = groupColumnsHtml(allGroups, cur);
    SC.bindCourseChecks($('dGroups'));
    // Флажки массовой смены преподавателя — сброс + подпись группы-цели.
    $('dReplaceTeacher').checked = false;
    $('dReplaceTeacherType').checked = false;
    $('dSetTeacherAll').checked = false;
    $('dBulkGroup').textContent = `(${bulkGroupOf(lesson)})`;
    $('dBulkGroup2').textContent = `(${bulkGroupOf(lesson)})`;
    // Замена «только по виду» имеет смысл, лишь когда вид у занятия задан.
    $('dBulkType').textContent = `«${lesson.type || ''}»`;
    $('dReplaceTypeWrap').hidden = !lesson.type;
    $('dBulkTeacherWrap').hidden = lesson.editable === false;
    // Примечание (для потока — авто-текст, если пусто)
    $('dNote').value = lesson.note || ((lesson.groups || []).length > 1 ? streamNote(lesson) : '');
    // Режим: занятие vs мероприятие
    const isEvent = lesson.category === 'event';
    $('detailsTitle').textContent = isEvent ? 'Редактирование мероприятия' : 'Редактирование занятия';
    $('dEventSection').hidden = !isEvent;
    if (isEvent) $('dEventLabel').value = lesson.subject || '';
    document.querySelectorAll('#detailsModal .d-lesson-only').forEach((el) => { el.hidden = isEvent; });
    syncLockBtn(lesson.locked);
    $('detailsModal').classList.add('open');
    $('dNewRoom').value = ''; // ручной ввод не тянем из прошлой карточки
    $('dNewRoom2').value = '';
    const lessonRooms = (lesson.rooms && lesson.rooms.length) ? lesson.rooms : (lesson.room ? [lesson.room] : []);
    await Promise.all([fillDetailsSubjects(lesson), fillTeacherSelect(lesson), fillDetailsRooms(lessonRooms)]);
    const editable = lesson.editable !== false;
    $('detailsModal').querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !editable; });
    $('detailsSave').hidden = !editable;
    $('detailsDelete').hidden = !editable;
    $('detailsLock').hidden = !editable;
    const oldAccess = $('dAccessInfo');
    if (oldAccess) oldAccess.remove();
    if (!editable) {
      $('detailsTitle').textContent += ' · только просмотр';
      const notice = document.createElement('div');
      notice.className = 'moved-banner';
      notice.id = 'dAccessInfo';
      notice.textContent = `🔒 ${lesson.readOnlyReason || 'Нет доступа ко всем группам занятия'}`;
      $('detailsModal').querySelector('.modal-body').prepend(notice);
    }
  }

  // Чекбоксы групп, разбитые на блоки по курсам (заголовок курса — сам чекбокс,
  // отмечает весь курс). Разметка и поведение общие для всех списков групп —
  // см. courseGroupsHtml/bindCourseChecks в shared-constants.js.
  // name — имя чекбоксов: карточка занятия использует dGroup, окно выгрузки
  // дисциплины — seGroup (иначе выборки пересекались бы).
  // hint(g) — необязательная приписка к группе (например численность).
  function groupColumnsHtml(allGroups, cur, name = 'dGroup', hint = null) {
    return SC.courseGroupsHtml(allGroups, state.courses, (g) =>
      `<label class="chk-lbl"><input type="checkbox" name="${name}" value="${esc(g)}"${cur.has(g) ? ' checked' : ''}> ${esc(g)}` +
      `${hint && hint(g) ? ` <span class="muted-hint">${esc(hint(g))}</span>` : ''}</label>`
    );
  }

  // Добавляет в select опцию value, если её там ещё нет (чтобы не терять
  // нестандартный текущий вид/дисциплину/аудиторию).
  // Виды учебных занятий для выпадающих списков (перечень правится в справочнике).
  // Кешируем: справочник меняется редко, а карточка открывается на каждый клик.
  // Сбрасывается в null после сохранения перечня — см. loadTypesTab.
  let lessonTypes = null;

  // Справочник видов занятий: кеш на страницу. Нужен и карточке занятия, и
  // выпадающему списку «Вид» в перечне занятий преподавателя (typeOptions).
  async function loadLessonTypes() {
    if (!lessonTypes) {
      try {
        lessonTypes = (await api.get('/api/lesson-types')).types || [];
      } catch {
        lessonTypes = SC.LESSON_TYPES || []; // справочник недоступен — список по умолчанию
      }
    }
    return lessonTypes;
  }

  async function fillTypeSelect(sel, value) {
    await loadLessonTypes();
    sel.innerHTML = '<option value="">— не указан —</option>' + lessonTypes
      .map((t) => `<option value="${esc(t.code)}">${esc(t.name ? `${t.code} — ${t.name}` : t.code)}</option>`)
      .join('');
    ensureOption(sel, value); // вид, которого нет в перечне, из занятия не пропадёт
    sel.value = value || '';
  }

  // Аудитории занятия для отправки на сервер: вписанная вручную заменяет выбранную
  // в своём списке — отдельно для основной и для второй аудитории. Пустые и дубли
  // убираем — их всё равно отсеивает inputRooms на сервере.
  function manualRooms(manualInp, sel, sel2, manualInp2) {
    const typed = (inp) => (inp ? inp.value.trim() : '');
    return [...new Set([
      typed(manualInp) || sel.value,
      typed(manualInp2) || sel2.value,
    ].filter(Boolean))];
  }

  function ensureOption(sel, value) {
    if (!value) return;
    if (![...sel.options].some((o) => o.value === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value;
      sel.appendChild(o);
    }
  }

  function detailsUpdateDate() {
    $('dDate').value = toISODate(Number($('dWeek').value), $('dDay').value);
  }

  // Список дисциплин «аббревиатура — полное название»; текущая выбрана.
  // Опции для списка дисциплин: обычные дисциплины сверху, глобальные
  // метки-мероприятия (ДП, ОП, Отп…) — отдельной группой «Мероприятия» в конце.
  function disciplineOptions(subjects) {
    const eventCodes = new Set((SC.EVENT_REASONS || []).map((r) => r.code));
    const opt = (s) => {
      const label = s.fullName ? `${s.abbr} — ${s.fullName}` : s.abbr;
      return `<option value="${esc(s.abbr)}">${esc(label)}</option>`;
    };
    const regular = subjects.filter((s) => !eventCodes.has(s.abbr));
    const events = subjects.filter((s) => eventCodes.has(s.abbr));
    let html = regular.map(opt).join('');
    if (events.length) html += `<optgroup label="Мероприятия">${events.map(opt).join('')}</optgroup>`;
    return html;
  }

  async function fillDetailsSubjects(lesson) {
    let subjects = [];
    try {
      subjects = (await api.get('/api/subjects')).subjects || [];
    } catch {
      /* справочник недоступен — оставим только текущую */
    }
    $('dDiscipline').innerHTML = '<option value="">— не задана —</option>' + disciplineOptions(subjects);
    ensureOption($('dDiscipline'), lesson.subject);
    $('dDiscipline').value = lesson.subject || '';
  }

  // Аудитории, свободные в ВЫБРАННОМ в форме слоте (само занятие исключается,
  // поэтому его текущая аудитория остаётся доступной). Выбор сохраняется.
  // preferred — какую аудиторию выбрать после перезагрузки списка. Передаётся при
  // ОТКРЫТИИ карточки (аудитория самого занятия). Без аргумента (смена дня/пары/
  // недели) сохраняем уже выбранное в форме значение. Иначе в select остаётся
  // value от ПРЕДЫДУЩЕГО открытого занятия → показывалась/сохранялась чужая ауд.
  // preferred — массив аудиторий [осн., вторая] для предвыбора (при ОТКРЫТИИ
  // карточки). Без аргумента (смена дня/пары/недели) сохраняем выбранное в обоих
  // списках. За занятием можно закрепить 1 или 2 аудитории (dRoom + dRoom2).
  async function fillDetailsRooms(preferred) {
    const day = $('dDay').value;
    const pairNo = $('dPair').value;
    const weekNo = $('dWeek').value;
    const sel = $('dRoom');
    const sel2 = $('dRoom2');
    const curRooms = (detailing && detailing.rooms) || [];
    const prev = preferred !== undefined ? (preferred[0] || '') : (sel.value || curRooms[0] || '');
    const prev2 = preferred !== undefined ? (preferred[1] || '') : (sel2.value || curRooms[1] || '');
    sel.innerHTML = '<option value="">— загрузка… —</option>';
    let opts = '';
    let loaded = false;
    const free = new Set(); // имена свободных — для предупреждения о занятой
    try {
      const id = detailing ? detailing.id : '';
      const { rooms, busyRooms } = await api.get(`/api/free-rooms?lessonId=${id}&day=${encodeURIComponent(day)}&pairNo=${pairNo}&weekNo=${weekNo}`);
      for (const r of rooms || []) free.add(r.name);
      dRooms = [...(rooms || []), ...(busyRooms || [])];
      // Свободные — сверху, занятые — отдельной группой ниже. Занятую выбрать
      // можно: сервер спросит подтверждение (накладка аудитории — предупреждение).
      // «· мало» — вместимость меньше числа курсантов выбранных групп.
      const need = detailsNeed();
      // Порядок — по подходимости: сверху аудитории, где мест ближе всего к числу
      // курсантов. Считаем по группам ИЗ ФОРМЫ (их могли переотметить), поэтому
      // сортируем здесь, а не полагаемся на порядок ответа сервера.
      const byFit = SC.roomFitCmp(need);
      (rooms || []).sort(byFit);
      (busyRooms || []).sort(byFit);
      // Подпись — общая для всех списков аудиторий (кафедра, примечание, места),
      // плюс «мало», если вместимость меньше числа курсантов выбранных групп.
      const label = (r) => SC.roomLabel(r, [need != null && r.capacity != null && r.capacity < need ? 'мало' : '']);
      const optionsOf = (list, suffix) =>
        (list || []).map((r) => `<option value="${esc(r.name)}">${esc(label(r))}${suffix(r)}</option>`).join('');
      const group = (label, html) => (html ? `<optgroup label="${label}">${html}</optgroup>` : '');
      opts =
        group('Свободные', optionsOf(rooms, () => '')) +
        group('Занятые', optionsOf(busyRooms, (r) => (r.busyBy ? ` — занята: ${esc(r.busyBy)}` : ' — занята')));
      loaded = true;
    } catch {
      /* список недоступен — оставим только текущие значения */
    }
    sel.innerHTML = '<option value="">— не задана —</option>' + opts;
    sel2.innerHTML = '<option value="">— нет —</option>' + opts;

    // Дописывать выбранное значение вручную нужно, только если список не
    // загрузился (иначе потеряли бы текущий выбор) — во всех остальных случаях
    // аудитория есть в одной из двух групп.
    // sameSlot: слот в форме совпадает с исходным слотом занятия — тогда его
    // собственная аудитория «занята» им же, и предупреждать не о чем.
    const sameSlot =
      Boolean(detailing) &&
      day === detailing.day &&
      Number(pairNo) === Number(detailing.pairNo) &&
      Number(weekNo) === Number(detailing.weekNo);
    const own = new Set(curRooms);
    const busy = [];
    const apply = (el, value) => {
      if (!loaded) ensureOption(el, value);
      const listed = [...el.options].some((o) => o.value === value);
      el.value = listed ? value : '';
      // Выбор сохраняем, но о занятости предупреждаем: молча оставленная занятая
      // аудитория всплыла бы только отказом при сохранении.
      if (value && loaded && !free.has(value) && !(sameSlot && own.has(value))) busy.push(value);
    };
    apply(sel, prev);
    apply(sel2, prev2);
    detailsUpdateNeed();
    if (busy.length) {
      // Занятая аудитория — не отказ, а предупреждение: сообщаем и оставляем выбор.
      toast(`${[...new Set(busy)].join(', ')} — занята в этом слоте (сохранение спросит подтверждение)`);
    }
  }

  // Справочник преподавателей текущей карточки (для перестроения доп. списка).
  let detailAllTeachers = [];

  // Выпадающий список преподавателей: кандидаты по дисциплине и виду занятия
  // (отдельной группой), затем все остальные. Текущий (основной) выбран. Плюс
  // строится список дополнительных преподавателей (для зачёта/экзамена).
  async function fillTeacherSelect(lesson) {
    const sel = $('dTeacher');
    sel.innerHTML = '<option value="">— не задан —</option>';
    const opt = (name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      return o;
    };
    const group = (label, names) => {
      if (!names.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      names.forEach((n) => g.appendChild(opt(n)));
      sel.appendChild(g);
    };
    let current = lesson.teacher || '';
    let selected = (lesson.teachers && lesson.teachers.length) ? lesson.teachers.slice() : (current ? [current] : []);
    let all = (state.entities && state.entities.teachers) || [];
    try {
      const data = await api.get(`/api/lesson/${lesson.id}/teachers`);
      current = data.current || current;
      if (data.selected && data.selected.length) selected = data.selected;
      if (data.all && data.all.length) all = data.all;
      const cand = data.candidates || [];
      const others = all.filter((n) => !cand.includes(n));
      group('По дисциплине и виду занятия', cand);
      group('Другие преподаватели', others);
      if (current && !cand.includes(current) && !others.includes(current)) sel.appendChild(opt(current));
    } catch {
      if (current) sel.appendChild(opt(current));
    }
    sel.value = current;

    detailAllTeachers = all;
    buildExtraTeachers(all, new Set(selected), current);
  }

  // Чекбоксы всех преподавателей (кроме основного) с отметкой уже выбранных.
  // Список длинный (все преподаватели вуза), а второй преподаватель — редкий
  // случай, поэтому он свёрнут в <details> и раскрывается сам, если кто-то отмечен.
  function buildExtraTeachers(all, checkedSet, primary) {
    const names = (all || []).filter((n) => n && n !== primary);
    $('dExtraTeachers').innerHTML =
      names
        .map((n) =>
          `<label class="chk-lbl"><input type="checkbox" name="dExtraTeacher" value="${esc(n)}"${checkedSet.has(n) ? ' checked' : ''}> ${esc(n)}</label>`
        )
        .join('') || '<span class="lbl">нет других преподавателей</span>';
    $('dExtraWrap').open = names.some((n) => checkedSet.has(n));
    showExtraCount();
  }

  // Отмеченные дополнительные преподаватели и подпись свёрнутого блока.
  const extraChecked = () =>
    Array.from(document.querySelectorAll('input[name="dExtraTeacher"]:checked')).map((e) => e.value);

  function showExtraCount() {
    const chosen = extraChecked();
    $('dExtraCount').textContent = chosen.length ? `— ${chosen.join(', ')}` : '— нет';
  }

  // Перестроить список доп. преподавателей при смене основного (сохранив отметки).
  function rebuildExtraTeachers() {
    buildExtraTeachers(detailAllTeachers, new Set(extraChecked()), $('dTeacher').value);
  }

  // Текст для потока: «Потоковое занятие совместно с <группы>, преподаватель <ФИО>».
  function streamNote(lesson) {
    const groups = lesson.groups || [];
    // В представлении группы перечисляем остальные группы потока; иначе — все.
    const others = state.kind === 'group' ? groups.filter((g) => g !== state.entityId) : groups;
    const list = others.join(', ');
    const teacher = lesson.teacher ? `, преподаватель ${lesson.teacher}` : '';
    return `Потоковое занятие совместно с ${list || '—'}${teacher}`;
  }

  async function saveDetails() {
    if (!detailing) return;
    const groups = Array.from(document.querySelectorAll('input[name="dGroup"]:checked')).map((el) => el.value);
    if (!groups.length) return toast('Выберите хотя бы одну группу', true);
    // Преподаватели: основной + отмеченные дополнительные (любой вид занятия —
    // вдвоём ведут не только зачёты). Проверки накладок идут по каждому из них.
    const primary = $('dTeacher').value || '';
    const teachers = [...new Set([primary, ...extraChecked()].filter(Boolean))];
    // Массовая смена преподавателя по группе (если отмечен один из флажков).
    const byType = $('dReplaceTeacherType').checked;
    const bulkMode = $('dSetTeacherAll').checked ? 'all' : (($('dReplaceTeacher').checked || byType) ? 'replace' : null);
    // Замена «только по виду» — та же замена from→to, но суженная до вида занятия.
    const bulkType = byType ? (detailing.type || null) : null;
    const bulkGroup = bulkGroupOf(detailing);
    const fromTeacher = detailing.teacher || ''; // кого заменяем (исходный преподаватель)
    if (bulkMode && !primary) return toast('Выберите преподавателя для массовой замены', true);
    try {
      const commandId = window.crypto.randomUUID();
      const saved = await withConfirm((extra) => api.put(`/api/lesson/${detailing.id}`, {
        commandId,
        expectedRevision: detailing.revision,
        day: $('dDay').value,
        pairNo: Number($('dPair').value),
        weekNo: Number($('dWeek').value),
        subject: (detailing.category === 'event' ? $('dEventLabel').value.trim() : $('dDiscipline').value) || null,
        type: $('dType').value || null,
        topic: $('dTopic').value.trim() || null,
        note: $('dNote').value.trim() || null,
        teachers,
        // 1 или 2 аудитории (вторая — опционально); дубли/пустые убираем.
        // Вписанная вручную перебивает выбранную в списке: сервер сам найдёт её по
        // имени (в т.ч. среди скрытых) или заведёт новую — см. getOrCreate.
        rooms: manualRooms($('dNewRoom'), $('dRoom'), $('dRoom2'), $('dNewRoom2')),
        groups,
        ...extra,
      }));
      if (saved.cancelled) return;
      if (bulkMode) {
        // «На все занятия» — только в рамках выбранной дисциплины (поток затрагивается
        // автоматически, т.к. это общая запись занятия). «Заменить» — по всему расписанию.
        const bulkSubject = bulkMode === 'all' ? ($('dDiscipline').value || null) : null;
        const r = await api.post('/api/group-teacher', { group: bulkGroup, from: fromTeacher, to: primary, mode: bulkMode, subject: bulkSubject, type: bulkType });
        const scope = bulkType ? ` (только «${bulkType}»)` : '';
        toast(`Преподаватель обновлён в ${r.count} занятиях группы ${bulkGroup}${scope}`);
      } else {
        toast('Сохранено');
      }
      $('detailsModal').classList.remove('open');
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Бронь занятия. Держит только МЕСТО: перенос сервер запрещает (validateMoveById,
  // editLesson, moveExam), правка полей и удаление работают как обычно. Сетку не
  // перерисовываем — карточка открыта, а в ячейках бронь никак не показана.
  function syncLockBtn(locked) {
    $('detailsLock').textContent = locked ? '🔓 Снять бронь' : '🔒 Забронировать';
  }

  async function toggleLock() {
    if (!detailing) return;
    const next = !detailing.locked;
    try {
      await api.post(`/api/lesson/${detailing.id}/lock`, { locked: next, expectedRevision: detailing.revision });
      detailing.locked = next;
      detailing.revision = Number(detailing.revision || 0) + 1;
      syncLockBtn(next);
      toast(next ? 'Занятие забронировано: перенос запрещён' : 'Бронь снята');
    } catch (err) {
      toast(((err.data && err.data.reasons) || [err.message]).join('; '), true);
    }
  }

  async function deleteLesson() {
    if (!detailing) return;
    if (await removeLesson(detailing)) $('detailsModal').classList.remove('open');
  }

  /* ----------------------- Добавление нового занятия ----------------------- */
  // Переключение «занятие ↔ мероприятие»: в режиме мероприятия скрываем поля
  // дисциплины/вида/темы и показываем поле обозначения (Экз, Отп, ОП…).
  function applyEventMode() {
    const ev = $('alIsEvent').checked;
    document.querySelectorAll('#addLessonModal .al-lesson-only').forEach((el) => { el.hidden = ev; });
    document.querySelectorAll('#addLessonModal .al-event-only').forEach((el) => { el.hidden = !ev; });
    $('alTitle').textContent = ev ? '+ Новое мероприятие' : '+ Новое занятие';
  }

  // prefill (необязательно): { day, pairNo, weekNo, subject, group } — открыть форму
  // уже заполненной (например, по клику на ячейку без аудитории после расстановки СР).
  async function openAddLesson(prefill) {
    $('alMsg').innerHTML = '';
    // Предзаполняем день и неделю из текущего представления (если возможно).
    // В сводном виде неделя тоже выбрана — подставляем её (в семестровом недели нет).
    if ((state.mode === 'week' || state.mode === 'summary') && state.week) {
      $('alWeek').value = state.week;
    }
    // Сброс полей
    $('alIsEvent').checked = !!(prefill && prefill.isEvent);
    $('alEventLabel').value = '';
    applyEventMode();
    fillTypeSelect($('alType'), '');
    $('alTopic').value = '';
    $('alSubject').innerHTML = '<option value="">— загрузка… —</option>';
    if ($('alNewSubject')) $('alNewSubject').value = '';
    $('alNewRoom').value = '';
    $('alNewRoom2').value = '';
    $('alTeacher').innerHTML = '<option value="">— не задан —</option>';
    $('alRoom').innerHTML = '<option value="">— выберите слот —</option>';
    $('alRoom2').innerHTML = '<option value="">— нет —</option>';
    $('alGroups').innerHTML = '';
    $('alNeedInfo').textContent = '';

    // Загружаем дисциплины (с их преподавателями), преподавателей, группы и
    // численность групп (для проверки «влезает ли группа в аудиторию»).
    try {
      const [{ subjects }, { teachers, groups, editableGroups }, groupRows] = await Promise.all([
        api.get('/api/subjects'),
        api.get('/api/entities'),
        api.get('/api/groups').catch(() => []),
      ]);
      setHeadcounts(groupRows);
      const allSubjects = subjects || [];
      if (state.kind === 'group' && state.entityId) {
        const combined = [];
        const usedAbbrs = new Set();
        const base = state.groupSubjects && state.groupSubjects[state.entityId] ? state.groupSubjects[state.entityId] : [];
        for (const s of base) {
          if (!usedAbbrs.has(s.abbr)) {
            combined.push({ abbr: s.abbr, fullName: s.fullName, teachers: [] });
            usedAbbrs.add(s.abbr);
          }
        }
        if (state.planCheck) {
          for (const [abbr, row] of state.planCheck.entries()) {
            if (!usedAbbrs.has(abbr)) {
              combined.push({ abbr: row.abbr, fullName: row.title || '', teachers: [] });
              usedAbbrs.add(abbr);
            }
          }
        }
        alSubjects = combined.map(c => {
          const orig = allSubjects.find(x => x.abbr === c.abbr);
          if (orig) return { ...orig, fullName: c.fullName || orig.fullName };
          return c;
        });
      } else {
        alSubjects = allSubjects;
      }
      alAllTeachers = teachers || [];
      renderSubjectOptions(null); // все дисциплины
      renderTeacherOptions(null); // все преподаватели

      const createGroups = state.user && state.user.role === 'admin' ? (groups || []) : (editableGroups || []);
      $('alGroups').innerHTML = groupColumnsHtml(
        createGroups,
        new Set(),
        'alGroup',
        (g) => (headcountOf(g) != null ? `${headcountOf(g)} к-т` : '')
      );
      // Заголовки курсов — до onchange: слушатель курсов работает в фазе
      // перехвата, поэтому alUpdateNeed увидит уже проставленные галочки.
      SC.bindCourseChecks($('alGroups'));
      // Смена набора групп меняет нужное число мест — пересчитываем подсказку.
      $('alGroups').onchange = alUpdateNeed;
      // Авто-отметка группы: из prefill (клик по ячейке) или открытого вида «Группа».
      if (prefill && prefill.group) {
        $('alGroups').querySelectorAll('input[name="alGroup"]').forEach((cb) => { cb.checked = cb.value === prefill.group; });
      } else if (state.kind === 'group' && state.entityId) {
        $('alGroups').querySelectorAll('input[name="alGroup"]').forEach((cb) => {
          if (cb.value === state.entityId) cb.checked = true;
        });
      }
      SC.bindCourseChecks($('alGroups')); // авто-отметка меняла галочки — обновить курсы
    } catch (err) {
      $('alMsg').innerHTML = `Ошибка загрузки справочников: ${esc(err.message)}`;
    }

    // Предзаполнение слота/дисциплины ДО загрузки свободных аудиторий (fillAddRooms
    // читает день/пару/неделю). Используется при ручной доустановке СР.
    if (prefill) {
      if (prefill.day) $('alDay').value = prefill.day;
      if (prefill.pairNo) $('alPair').value = String(prefill.pairNo);
      if (prefill.weekNo) $('alWeek').value = prefill.weekNo;
      if (prefill.subject) { ensureOption($('alSubject'), prefill.subject); $('alSubject').value = prefill.subject; }
    }

    $('addLessonModal').classList.add('open');
    alUpdateDate();
    await fillAddRooms();
    // Аудитория из столбца сводного вида (или открытого расписания аудитории):
    // подставляем, даже если она занята — сервер проверит и объяснит отказ.
    if (prefill && prefill.room) {
      ensureOption($('alRoom'), prefill.room);
      $('alRoom').value = prefill.room;
    }
    alUpdateNeed();
  }

  // Справочники формы добавления (дисциплины с преподавателями и все преподаватели).
  let alSubjects = [];
  let alAllTeachers = [];
  let alRooms = []; // свободные аудитории слота с вместимостью

  // Сколько мест нужно выбранным группам (потоку — сумма). null, если ни у одной
  // группы численность не задана: тогда проверять нечего.
  function alNeed() {
    const picked = Array.from(document.querySelectorAll('input[name="alGroup"]:checked')).map((el) => el.value);
    return needSeats(picked);
  }

  // Подпись аудитории в списке: вместимость, пометка «мало» (не вмещает группы)
  // и «занята» (в этот слот уже стоит другое занятие). И то, и другое — только
  // предупреждение: выбрать такую аудиторию можно, сервер спросит подтверждение.
  function alRoomOption(r, need) {
    const marks = [
      need != null && r.capacity != null && r.capacity < need ? 'мало' : '',
      r.busy ? (r.busyBy ? `занята: ${r.busyBy}` : 'занята') : '',
    ].filter(Boolean);
    return `<option value="${esc(r.name)}">${esc(SC.roomLabel(r, marks))}</option>`;
  }

  // Пересчёт «нужно N мест» и предупреждения по выбранным аудиториям. Вызывается
  // при смене групп/аудиторий/слота. Сохранение всё равно проверит сервер — это
  // подсказка, чтобы не жать «Сохранить» вслепую.
  function alUpdateNeed() {
    const need = alNeed();
    const info = $('alNeedInfo');
    if (need == null) {
      info.textContent = 'численность групп не задана';
      info.classList.remove('bad');
    } else {
      const picked = [$('alRoom').value, $('alRoom2').value].filter(Boolean);
      const caps = picked.map((n) => (alRooms.find((r) => r.name === n) || {}).capacity);
      const known = caps.filter((c) => c != null);
      const total = known.reduce((s, c) => s + c, 0);
      const short = known.length && total < need;
      info.textContent = short
        ? `нужно ${need} мест, в выбранных аудиториях ${total} — не вмещает`
        : `нужно ${need} мест`;
      info.classList.toggle('bad', !!short);
    }
    // Пометка «мало» у вариантов списка (набор групп мог измениться). Группировку
    // «Свободные/Занятые» сохраняем — она объясняет, почему аудитория помечена.
    if (alRooms.length) {
      const group = (label, list) =>
        list.length ? `<optgroup label="${label}">${list.map((r) => alRoomOption(r, need)).join('')}</optgroup>` : '';
      // Порядок пересобирается вместе с пометками: сменили набор групп — сменилось
      // и число курсантов, а значит и то, какая аудитория подходит лучше.
      const byFit = SC.roomFitCmp(need);
      const body = group('Свободные', alRooms.filter((r) => !r.busy).sort(byFit)) + group('Занятые', alRooms.filter((r) => r.busy).sort(byFit));
      for (const sel of [$('alRoom'), $('alRoom2')]) {
        const cur = sel.value;
        const head = sel.id === 'alRoom' ? '<option value="">— не задана —</option>' : '<option value="">— нет —</option>';
        sel.innerHTML = head + body;
        sel.value = cur;
      }
    }
  }

  // Список дисциплин «аббревиатура — полное название». Если задан преподаватель —
  // только дисциплины, которые он ведёт (с откатом ко всем, если связей нет).
  function renderSubjectOptions(filterTeacher) {
    const prev = $('alSubject').value;
    let list = alSubjects;
    if (filterTeacher) {
      const f = alSubjects.filter((s) => (s.teachers || []).includes(filterTeacher));
      list = f.length ? f : alSubjects;
    }
    $('alSubject').innerHTML = '<option value="">— выберите дисциплину —</option>' + disciplineOptions(list);
    if (prev && list.some((s) => s.abbr === prev)) $('alSubject').value = prev;
  }

  // Список преподавателей. Если задана дисциплина — только её преподаватели
  // (с откатом ко всем, если у дисциплины нет привязанных преподавателей).
  function renderTeacherOptions(filterSubject) {
    const prev = $('alTeacher').value;
    let list = alAllTeachers;
    if (filterSubject) {
      const s = alSubjects.find((x) => x.abbr === filterSubject);
      const t = (s && s.teachers) || [];
      list = t.length ? t : alAllTeachers;
    }
    $('alTeacher').innerHTML = '<option value="">— не задан —</option>' +
      list.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (prev && list.includes(prev)) $('alTeacher').value = prev;
  }

  function alUpdateDate() {
    $('alDate').value = toISODate(Number($('alWeek').value), $('alDay').value);
  }

  // YYYY-MM-DD для <input type="date">
  function toISODate(weekNo, day) {
    const sem = state.semester;
    if (!sem || !sem.start || !weekNo) return '';
    const idx = DAYS.indexOf(day);
    if (idx < 0) return '';
    const d = new Date(sem.start + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow + (weekNo - 1) * 7 + idx);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  // Обратное: YYYY-MM-DD → { weekNo, day } относительно семестра. null если вне семестра.
  function dateToWeekDay(isoDate) {
    const sem = state.semester;
    if (!sem || !sem.start || !isoDate) return null;
    const target = new Date(isoDate + 'T00:00:00Z');
    if (Number.isNaN(target.getTime())) return null;
    const d = new Date(sem.start + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow); // понедельник 1-й недели
    const diffDays = Math.round((target - d) / 86400000);
    if (diffDays < 0) return null;
    const weekNo = Math.floor(diffDays / 7) + 1;
    const dayIdx = diffDays % 7;
    if (dayIdx > 5 || weekNo < 1 || weekNo > semesterWeeks()) return null;
    return { weekNo, day: DAYS[dayIdx] };
  }

  async function fillAddRooms() {
    const day = $('alDay').value;
    const pairNo = $('alPair').value;
    const weekNo = $('alWeek').value;
    if (!day || !pairNo || !weekNo) return;

    const sel = $('alRoom');
    const sel2 = $('alRoom2');
    const prev = sel.value; // сохраняем выбранные аудитории, чтобы не слетали
    const prev2 = sel2.value;
    sel.innerHTML = '<option value="">— загрузка… —</option>';
    try {
      const { rooms, busyRooms } = await api.get(`/api/free-rooms?day=${encodeURIComponent(day)}&pairNo=${pairNo}&weekNo=${weekNo}`);
      // Занятые аудитории тоже даём выбрать: занятие туда поставить можно —
      // сервер спросит подтверждение (см. withConfirm).
      const busy = (busyRooms || []).map((r) => ({ ...r, busy: true }));
      alRooms = [...(rooms || []), ...busy];
      if (!alRooms.length) {
        sel.innerHTML = '<option value="">— нет аудиторий —</option>';
        sel2.innerHTML = '<option value="">— нет —</option>';
        alUpdateNeed();
        return;
      }
      const need = alNeed();
      const group = (label, list) =>
        list.length ? `<optgroup label="${label}">${list.map((r) => alRoomOption(r, need)).join('')}</optgroup>` : '';
      const opts = group('Свободные', (rooms || []).sort(SC.roomFitCmp(need))) + group('Занятые', busy.sort(SC.roomFitCmp(need)));
      sel.innerHTML = '<option value="">— не задана —</option>' + opts;
      sel2.innerHTML = '<option value="">— нет —</option>' + opts;
      // Восстанавливаем прежний выбор, если аудитория есть в этом слоте.
      if (prev && alRooms.some((r) => r.name === prev)) sel.value = prev;
      if (prev2 && alRooms.some((r) => r.name === prev2)) sel2.value = prev2;
      alUpdateNeed();
    } catch {
      sel.innerHTML = '<option value="">— ошибка загрузки —</option>';
      sel2.innerHTML = '<option value="">— нет —</option>';
    }
  }

  // Запуск выбора свободной ячейки ПРЯМО В СЕТКЕ: форма скрывается, доступные
  // ячейки подсвечиваются как при переносе. Учитываются выбранные группы, а
  // также преподаватель/аудитория, если заданы. Неделя: текущая (или все — в
  // семестровом виде).
  async function startSlotPick() {
    exitBlockMode();
    const groups = Array.from(document.querySelectorAll('input[name="alGroup"]:checked')).map((el) => el.value);
    const teacher = $('alTeacher').value;
    const room = $('alRoom').value;
    const weekNo = state.mode === 'semester' ? null : (Number($('alWeek').value) || state.week || 1);

    const used = [
      groups.length ? `группы ${groups.join(', ')}` : null,
      teacher ? `преп. ${teacher}` : null,
      room ? `ауд. ${room}` : null,
    ].filter(Boolean).join(' · ');
    $('pickInfo').textContent = used
      ? `Кликните свободную ячейку (с учётом: ${used})`
      : 'Кликните свободную ячейку для нового занятия';

    const qs = new URLSearchParams();
    if (weekNo) qs.set('weekNo', String(weekNo));
    if (groups.length) qs.set('groups', groups.join(','));
    if (teacher) qs.set('teacher', teacher);
    if (room) qs.set('room', room);
    // Дисциплина и вид нужны серверу только ради послабления по ФП
    // (приём зачёта/экзамена и занятие у одного преподавателя одновременно).
    if ($('alSubject').value) qs.set('subject', $('alSubject').value);
    if ($('alType').value) qs.set('type', $('alType').value);

    let free = [];
    try {
      const { slots } = await api.get(`/api/free-slots?${qs.toString()}`);
      free = (slots || []).filter((s) => s.free);
    } catch (err) {
      return toast(`Не удалось получить свободные ячейки: ${err.message}`, true);
    }
    if (!free.length) return toast('Свободных ячеек нет для выбранных параметров', true);

    // Скрываем форму, входим в режим выбора, подсвечиваем ячейки в текущей сетке.
    $('addLessonModal').classList.remove('open');
    pickMode = true;
    $('pickBanner').hidden = false;

    const freeSet = new Set(free.map((s) => `${s.day}|${s.pairNo}|${s.weekNo}`));
    const seen = new Set();
    $('gridWrap').querySelectorAll('td.slot').forEach((cell) => {
      const day = cell.dataset.day;
      const pair = Number(cell.dataset.pair);
      const week = cell.dataset.week ? Number(cell.dataset.week) : (weekNo || state.week);
      if (!day || !pair) return;
      if (freeSet.has(`${day}|${pair}|${week}`)) {
        // В сводном виде одна и та же (день,пара) встречается в нескольких
        // столбцах-группах — помечаем все, выбор любого даёт тот же слот.
        cell.classList.add('free-target', 'pick-target');
        cell.dataset.pickWeek = String(week);
        seen.add(`${day}|${pair}|${week}`);
      }
    });
    if (!seen.size) {
      exitPickMode();
      $('addLessonModal').classList.add('open');
      toast('Свободные ячейки есть, но не видны в текущем виде — смените неделю/режим', true);
    }
  }

  function finishSlotPick(cell) {
    $('alDay').value = cell.dataset.day;
    $('alPair').value = cell.dataset.pair;
    $('alWeek').value = cell.dataset.pickWeek || cell.dataset.week || state.week;
    exitPickMode();
    $('addLessonModal').classList.add('open');
    alUpdateDate();
    fillAddRooms();
  }

  function exitPickMode() {
    pickMode = false;
    $('pickBanner').hidden = true;
    $('gridWrap').querySelectorAll('.pick-target').forEach((c) => {
      c.classList.remove('free-target', 'room-busy', 'pick-target', 'drag-over');
      delete c.dataset.pickWeek;
    });
  }

  /* ------------- Ручная блокировка свободных ячеек преподавателя ------------- */
  // Режим держится активным между кликами: подсвечивает свободные ячейки
  // преподавателя, по клику ставит блокировку и сразу пересчитывает подсветку
  // (заблокированная ячейка перестаёт быть свободной), пока пользователь не
  // нажмёт «Готово»/Esc или не сменит вид/объект/неделю.
  async function startBlockMode() {
    if (state.kind !== 'teacher' || !state.entityId) return;
    exitPickMode();
    blockMode = true;
    $('blockBanner').hidden = false;
    await refreshBlockHighlight();
  }

  // Пересчитывает и подсвечивает свободные ячейки преподавателя заново
  // (после каждой блокировки набор свободных ячеек меняется).
  async function refreshBlockHighlight() {
    if (!blockMode) return;
    const weekNo = state.mode === 'semester' ? null : state.week;
    const qs = new URLSearchParams({ teacher: state.entityId });
    if (weekNo) qs.set('weekNo', String(weekNo));

    let free = [];
    try {
      const { slots } = await api.get(`/api/free-slots?${qs.toString()}`);
      free = (slots || []).filter((s) => s.free);
    } catch (err) {
      exitBlockMode();
      return toast(`Не удалось получить свободные ячейки: ${err.message}`, true);
    }

    $('gridWrap').querySelectorAll('.block-target').forEach((c) => {
      c.classList.remove('free-target', 'block-target');
      delete c.dataset.blockWeek;
    });

    const freeSet = new Set(free.map((s) => `${s.day}|${s.pairNo}|${s.weekNo}`));
    let seen = 0;
    $('gridWrap').querySelectorAll('td.slot').forEach((cell) => {
      const day = cell.dataset.day;
      const pair = Number(cell.dataset.pair);
      const week = cell.dataset.week ? Number(cell.dataset.week) : (weekNo || state.week);
      if (!day || !pair) return;
      if (freeSet.has(`${day}|${pair}|${week}`)) {
        cell.classList.add('free-target', 'block-target');
        cell.dataset.blockWeek = String(week);
        seen++;
      }
    });
    if (!seen) {
      exitBlockMode();
      toast('Свободных ячеек для блокировки больше нет', true);
    }
  }

  function exitBlockMode() {
    if (!blockMode) return;
    blockMode = false;
    $('blockBanner').hidden = true;
    $('gridWrap').querySelectorAll('.block-target').forEach((c) => {
      c.classList.remove('free-target', 'block-target');
      delete c.dataset.blockWeek;
    });
  }

  // Клик по подсвеченной свободной ячейке в режиме блокировки: ставит
  // мероприятие-метку, занимающее слот преподавателя, и обновляет подсветку —
  // режим остаётся активным для следующей ячейки.
  async function handleBlockCellClick(cell) {
    const day = cell.dataset.day;
    const pairNo = Number(cell.dataset.pair);
    const weekNo = Number(cell.dataset.blockWeek || cell.dataset.week || state.week);
    try {
      await api.post('/api/teacher-block', { teacher: state.entityId, day, pairNo, weekNo });
      toast('Ячейка заблокирована');
      refreshUndo();
      await render();
      await refreshBlockHighlight();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  async function saveNewLesson() {
    const isEvent = $('alIsEvent').checked;
    const groups = Array.from(document.querySelectorAll('input[name="alGroup"]:checked')).map(el => el.value);
    const data = {
      day: $('alDay').value,
      pairNo: Number($('alPair').value),
      weekNo: Number($('alWeek').value),
      // 1 или 2 аудитории (вторая — опционально); дубли/пустые убираем.
      rooms: manualRooms($('alNewRoom'), $('alRoom'), $('alRoom2'), $('alNewRoom2')),
      teacher: $('alTeacher').value,
      groups,
    };
    if (isEvent) {
      data.category = 'event';
      data.subject = $('alEventLabel').value.trim();
      if (!data.subject) return $('alMsg').innerHTML = 'Укажите обозначение мероприятия';
    } else {
      const manualSubj = $('alNewSubject') ? $('alNewSubject').value.trim() : '';
      data.subject = manualSubj || $('alSubject').value.trim();
      data.type = $('alType').value;
      data.topic = $('alTopic').value.trim();
      if (!data.subject) return $('alMsg').innerHTML = 'Укажите дисциплину';
    }
    if (!data.groups.length) return $('alMsg').innerHTML = 'Выберите хотя бы одну группу';

    try {
      $('alMsg').innerHTML = '';
      const res = await withConfirm((extra) => api.post('/api/lessons', { ...data, ...extra }));
      if (res.cancelled) return;
      const r = res.data;
      $('addLessonModal').classList.remove('open');
      const what = isEvent ? 'Мероприятие добавлено' : 'Занятие добавлено';
      toast(r.warning ? `${what} · ⚠ ${r.warning}` : what);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      $('alMsg').innerHTML = `<ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
    }
  }

  /* ----------------------- Отпуск преподавателя ----------------------- */
  // Заполняет выпадающий список причин из ГЛОБАЛЬНОГО списка SC.EVENT_REASONS
  // (те же сокращения, что и в расписании) + пункт «Другое мероприятие…».
  function fillVacReasons() {
    const opts = (SC.EVENT_REASONS || [])
      .map((r) => `<option value="${esc(r.code)}">${esc(r.name ? `${r.code} — ${r.name}` : r.code)}</option>`)
      .join('');
    $('vacReason').innerHTML = opts + '<option value="__custom">Другое мероприятие…</option>';
  }

  // Открывает диалог отпуска для преподавателя, чьё расписание сейчас открыто.
  // По умолчанию подставляет период текущей недели (Пн–Сб).
  function openVacation() {
    if (!(state.kind === 'teacher' || state.kind === 'group') || !state.entityId) {
      return toast('Откройте расписание преподавателя или группы', true);
    }
    const isGroup = state.kind === 'group';
    $('vacTitle').textContent = isGroup ? '🏖 Отпуск группы' : '🏖 Отпуск преподавателя';
    $('vacTeacher').textContent = (isGroup ? 'Группа: ' : 'Преподаватель: ') + state.entityId;
    $('vacReason').value = 'Отп';
    $('vacCustom').value = '';
    $('vacCustom').hidden = true;
    $('vacMsg').innerHTML = '';
    const wk = state.week || 1;
    $('vacFrom').value = toISODate(wk, 'Пн') || '';
    $('vacTo').value = toISODate(wk, 'Сб') || '';
    $('vacationModal').classList.add('open');
  }

  // Проставляет «Отп» во все рабочие ячейки периода для преподавателя или группы.
  async function saveVacation() {
    const isGroup = state.kind === 'group';
    const subject = state.entityId;
    const from = $('vacFrom').value;
    const to = $('vacTo').value;
    if (!from || !to) return $('vacMsg').innerHTML = 'Укажите даты начала и конца периода';
    if (from > to) return $('vacMsg').innerHTML = 'Дата начала позже даты конца';
    const reason = $('vacReason').value;
    const label = reason === '__custom' ? $('vacCustom').value.trim() : reason;
    if (!label) return $('vacMsg').innerHTML = 'Укажите метку мероприятия';
    try {
      $('vacMsg').innerHTML = '';
      const base = { from, to, label };
      const r = await api.post('/api/vacation', isGroup ? { group: subject, ...base } : { teacher: subject, ...base });
      $('vacationModal').classList.remove('open');
      const extra = r.moved ? ` · перемещено в буфер: ${r.moved}` : '';
      toast(`«${label}» проставлено: ${r.count} пар${extra}`);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      $('vacMsg').innerHTML = `<ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    }
  }

  /* ----------------------- Вывод аудитории из эксплуатации ----------------------- */
  function openDecommission() {
    if (state.kind !== 'room' || !state.entityId) return toast('Откройте расписание аудитории', true);
    $('decommRoom').textContent = 'Аудитория: ' + state.entityId;
    $('decommReason').value = '';
    $('decommMsg').innerHTML = '';
    const wk = state.week || 1;
    $('decommFrom').value = toISODate(wk, 'Пн') || '';
    $('decommTo').value = toISODate(wk, 'Сб') || '';
    $('decommModal').classList.add('open');
  }

  async function saveDecommission() {
    const room = state.entityId;
    const from = $('decommFrom').value;
    const to = $('decommTo').value;
    const reason = $('decommReason').value.trim();
    if (!from || !to) return $('decommMsg').innerHTML = 'Укажите даты начала и конца периода';
    if (from > to) return $('decommMsg').innerHTML = 'Дата начала позже даты конца';
    try {
      $('decommMsg').innerHTML = '';
      const r = await api.post('/api/decommission-room', { room, from, to, reason });
      $('decommModal').classList.remove('open');
      // Подсветка переселённых занятий — до обновления страницы (хранится в state).
      state.relocated = new Set((r.moved || []).map((m) => m.id));
      const tail = r.parked ? ` · в буфер: ${r.parked} (не нашлось свободной аудитории)` : '';
      toast(`Аудитория «${room}» выведена: переселено ${r.movedCount}, отмечено ячеек ${r.marks || 0}${tail}`, !!r.parked);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      $('decommMsg').innerHTML = `<ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    }
  }

  // Подсветка переселённых занятий (после вывода аудитории) — до обновления страницы.
  function applyRelocatedMarks() {
    const set = state.relocated;
    const has = set && set.size;
    $('gridWrap').querySelectorAll('.lesson[data-lesson]').forEach((el) => {
      el.classList.remove('relocated');
      if (!has) return;
      let l;
      try { l = JSON.parse(el.dataset.lesson); } catch { return; }
      if (set.has(l.id)) el.classList.add('relocated');
    });
  }

  /* ----------------------- Нерабочие дни ----------------------- */

  async function loadHolidays() {
    try {
      const { holidays } = await api.get('/api/holidays');
      state.holidays = new Set(holidays || []);
    } catch {
      state.holidays = new Set();
    }
  }

  /* ---------- Численность групп (проверка посадочных мест) ---------- */
  // Общий справочник «группа → число курсантов»: нужен и форме добавления, и
  // карточке занятия, поэтому живёт в state, а не в конкретной форме.
  let headcounts = {};

  function setHeadcounts(rows) {
    headcounts = {};
    for (const g of rows || []) headcounts[g.name] = g.headcount ?? null;
  }

  const headcountOf = (group) => (headcounts[group] == null ? null : headcounts[group]);

  // Сколько мест нужно набору групп (поток — сумма). null, если ни у одной
  // группы численность не задана: сравнивать не с чем.
  function needSeats(groups) {
    const known = (groups || []).filter((g) => headcountOf(g) != null);
    if (!known.length) return null;
    return known.reduce((sum, g) => sum + Number(headcountOf(g)), 0);
  }

  async function loadHeadcounts() {
    try {
      setHeadcounts(await api.get('/api/groups'));
    } catch {
      headcounts = {};
    }
  }

  // Примечания аудиторий (оснащение) — для подсказки занятия в сетке.
  let roomNotes = {};

  async function loadRoomNotes() {
    try {
      roomNotes = {};
      for (const r of (await api.get('/api/rooms')) || []) if (r.note) roomNotes[r.name] = r.note;
    } catch {
      roomNotes = {};
    }
  }

  // «401-7 (компьютерный класс)» — имя аудитории с примечанием, если оно задано.
  const roomWithNote = (name) => (roomNotes[name] ? `${name} (${roomNotes[name]})` : name);

  // Примечания к датам: [{date: ISO, text, groups[]}]. Пустой groups — для всех групп.
  async function loadDateNotes() {
    try {
      const { notes } = await api.get('/api/date-notes');
      state.dateNotes = notes || [];
    } catch {
      state.dateNotes = [];
    }
  }

  // Группа, в чьей сетке смотрим дату: столбец сводного или открытое расписание.
  function noteGroupOf(cell) {
    return (cell && cell.dataset.group) || (state.kind === 'group' ? state.entityId : '') || '';
  }

  // Индекс примечания для даты и группы (-1 — нет). Примечание без групп видно всем.
  function noteIndexFor(iso, group) {
    if (!iso) return -1;
    return (state.dateNotes || []).findIndex(
      (n) => n.date === iso && (!n.groups || !n.groups.length || !group || n.groups.includes(group))
    );
  }

  // Все примечания даты, видимые группе (для подсказки в сетке).
  function notesTextFor(iso, group) {
    return (state.dateNotes || [])
      .filter((n) => n.date === iso && (!n.groups || !n.groups.length || !group || n.groups.includes(group)))
      .map((n) => n.text)
      .join('\n');
  }

  // Открытое примечание: индекс в state.dateNotes (-1 — новое) и его дата.
  let noteEditing = { index: -1, date: null };

  // Форма примечания к дате: текст + группы, в чьих сетках дата подсветится.
  function openDateNote(cell) {
    const iso = cell.dataset.date;
    if (!iso) return;
    const group = noteGroupOf(cell);
    const index = noteIndexFor(iso, group);
    const note = index >= 0 ? state.dateNotes[index] : null;
    noteEditing = { index, date: iso };

    const [y, m, dd] = iso.split('-');
    $('dnDate').textContent = `${dd}.${m}.${y}`;
    $('dnText').value = note ? note.text : '';
    $('dnMsg').textContent = '';
    $('dnDelete').hidden = index < 0;

    // Отмечены: группы примечания, либо (для нового) текущая группа сетки.
    const picked = new Set(note ? note.groups || [] : (group ? [group] : []));
    const all = (state.entities && state.entities.groups) || [];
    $('dnGroups').innerHTML = groupColumnsHtml(all, picked, 'dnGroup');
    SC.bindCourseChecks($('dnGroups'));
    $('dateNoteModal').classList.add('open');
    $('dnText').focus();
  }

  async function saveDateNotes(notes, okMsg) {
    try {
      await api.put('/api/date-notes', { notes });
      state.dateNotes = notes;
      $('dateNoteModal').classList.remove('open');
      toast(okMsg);
      render();
    } catch (err) {
      $('dnMsg').textContent = err.message;
    }
  }

  function saveDateNote() {
    const text = $('dnText').value.trim();
    if (!text) return ($('dnMsg').textContent = 'Введите текст примечания (или удалите его)');
    const groups = Array.from(document.querySelectorAll('input[name="dnGroup"]:checked')).map((el) => el.value);
    const notes = [...(state.dateNotes || [])];
    const entry = { date: noteEditing.date, text, groups };
    if (noteEditing.index >= 0) notes[noteEditing.index] = entry;
    else notes.push(entry);
    return saveDateNotes(notes, 'Примечание сохранено');
  }

  function deleteDateNote() {
    if (noteEditing.index < 0) return;
    const notes = (state.dateNotes || []).filter((_, i) => i !== noteEditing.index);
    saveDateNotes(notes, 'Примечание удалено');
  }

  // Атрибуты ячейки с датой: ISO для меню ПКМ + подсветка, если есть примечание.
  // Возвращает строку для вставки в тег (class дописывается отдельно).
  function dateCellAttrs(weekNo, day, group) {
    const iso = toISODate(weekNo, day);
    if (!iso) return { attrs: '', cls: '', tip: '' };
    const text = notesTextFor(iso, group === undefined ? (state.kind === 'group' ? state.entityId : '') : group);
    return {
      attrs: ` data-date="${iso}"`,
      cls: text ? ' has-note' : '',
      tip: text ? ` title="${esc(text)}"` : '',
    };
  }

  // Проверяет, является ли (weekNo, day) нерабочим днём по настройке семестра.
  function isHolidayDay(weekNo, day) {
    if (!state.holidays || !state.holidays.size) return false;
    const iso = toISODate(weekNo, day);
    return !!(iso && state.holidays.has(iso));
  }

  /* ------------------------- Оформление сетки (цвета/размеры) ------------------------- */
  // Настройки — это просто CSS-переменные, которые ставятся на :root. Значения по
  // умолчанию совпадают со светлой темой в theme.css: сохранённый цвет действует
  // в обеих темах (он выбран человеком осознанно), несохранённые берутся из темы.
  // Список токенов — общий с виджетом: public/js/shared-constants.js.
  const { APP_TYPES, APP_STATES, APP_SIZES } = SC;
  let appearance = { colors: {}, sizes: {} };

  function applyAppearance() {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(appearance.colors || {})) root.style.setProperty(k, v);
    for (const [k, v] of Object.entries(appearance.sizes || {})) root.style.setProperty(k, v);
  }

  // Закрытие без сохранения: снимаем всё, что наставил предпросмотр, и
  // возвращаем сохранённое на сервере.
  function revertAppearance() {
    const root = document.documentElement;
    for (const [k] of [...APP_TYPES, ...APP_STATES, ...APP_SIZES]) root.style.removeProperty(k);
    applyAppearance();
  }

  async function loadAppearance() {
    try {
      const r = await api.get('/api/appearance');
      appearance = r.appearance || { colors: {}, sizes: {} };
      applyAppearance();
    } catch { /* оформление не критично — остаётся тема по умолчанию */ }
  }

  function openAppearance() {
    const colorRow = ([k, label, def]) =>
      `<label class="app-row">${esc(label)}<input type="color" data-color="${k}" value="${appearance.colors[k] || def}"></label>`;
    const sizeRow = ([k, label, def, min, max]) =>
      `<label class="app-row">${esc(label)}<input type="number" data-size="${k}" min="${min}" max="${max}" step="1" value="${parseInt(appearance.sizes[k] || def, 10)}"></label>`;
    $('appTypes').innerHTML = APP_TYPES.map(colorRow).join('');
    $('appStates').innerHTML = APP_STATES.map(colorRow).join('');
    $('appSizes').innerHTML = APP_SIZES.map(sizeRow).join('');
    // Правка сразу видна в сетке — иначе цвет не подобрать вслепую.
    $('appearanceModal').querySelectorAll('input').forEach((inp) => {
      inp.oninput = () => {
        const value = inp.dataset.color ? inp.value : `${inp.value}px`;
        document.documentElement.style.setProperty(inp.dataset.color || inp.dataset.size, value);
      };
    });
    $('appearanceModal').classList.add('open');
  }

  function collectAppearance() {
    const colors = {};
    const sizes = {};
    $('appearanceModal').querySelectorAll('input[data-color]').forEach((i) => { colors[i.dataset.color] = i.value; });
    $('appearanceModal').querySelectorAll('input[data-size]').forEach((i) => { sizes[i.dataset.size] = `${parseInt(i.value, 10) || 0}px`; });
    return { colors, sizes };
  }

  async function saveAppearance() {
    try {
      const r = await api.put('/api/appearance', { appearance: collectAppearance() });
      appearance = r.appearance || { colors: {}, sizes: {} };
      applyAppearance();
      $('appearanceModal').classList.remove('open');
      toast('Оформление сохранено');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Сброс: убираем переопределения с :root — сетка возвращается к цветам темы.
  async function resetAppearance() {
    const root = document.documentElement;
    for (const [k] of [...APP_TYPES, ...APP_STATES, ...APP_SIZES]) root.style.removeProperty(k);
    appearance = { colors: {}, sizes: {} };
    try {
      await api.put('/api/appearance', { appearance });
      toast('Вернули стандартное оформление');
      $('appearanceModal').classList.remove('open');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ------------- Выгрузка расписания дисциплины (с выбором групп) ------------- */
  // Группы берём не из справочника, а по занятиям этой дисциплины: показывать
  // группы, у которых её нет, бессмысленно.
  async function openSubjectExport() {
    const sel = $('seSubject');
    try {
      const { subjects } = await api.get('/api/subjects');
      const list = (subjects || []).map((s) => s.abbr).filter(Boolean);
      if (!list.length) return toast('Дисциплин пока нет — загрузите расписание', true);
      const prev = sel.value;
      sel.innerHTML = list.map((a) => `<option>${esc(a)}</option>`).join('');
      sel.value = list.includes(prev) ? prev : list[0];
    } catch (err) {
      return toast(err.message, true);
    }
    $('subjExportModal').classList.add('open');
    await fillSubjectGroups(sel.value);
  }

  async function fillSubjectGroups(subject) {
    const box = $('seGroups');
    box.innerHTML = '<div class="file-status">Загружаю группы…</div>';
    try {
      const { groups } = await api.get(`/api/export/subject-groups?subject=${encodeURIComponent(subject)}`);
      const list = groups || [];
      box.innerHTML = list.length
        ? groupColumnsHtml(list, new Set(list), 'seGroup') // по умолчанию отмечены все
        : '<div class="file-status">У этой дисциплины нет занятий</div>';
      SC.bindCourseChecks(box);
      $('seCount').textContent = list.length ? `(${list.length})` : '';
    } catch (err) {
      box.innerHTML = `<div class="file-status">${esc(err.message)}</div>`;
    }
  }

  const setSubjectGroups = (on) => {
    $('seGroups').querySelectorAll('input[name="seGroup"]').forEach((c) => { c.checked = on; });
    SC.bindCourseChecks($('seGroups')); // пересчитать галочки курсов
  };

  async function downloadSubjectSchedule() {
    const subject = $('seSubject').value;
    const groups = [...$('seGroups').querySelectorAll('input[name="seGroup"]:checked')].map((c) => c.value);
    if (!groups.length) return toast('Отметьте хотя бы одну учебную группу', true);
    const btn = $('seSave');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…формирую';
    try {
      const res = await api.download('/api/export/subject', { subject, groups });
      toast(`Скачивается файл ${res.filename}`);
      $('subjExportModal').classList.remove('open');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function openHolidays() {
    try {
      const { holidays } = await api.get('/api/holidays');
      $('holidaysList').value = (holidays || []).join('\n');
    } catch {
      $('holidaysList').value = '';
    }
    $('holidaysMsg').textContent = '';
    $('holidaysModal').classList.add('open');
  }

  async function saveHolidays() {
    const raw = $('holidaysList').value;
    const holidays = raw.split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    const invalid = raw.split('\n').map((s) => s.trim()).filter((s) => s && !/^\d{4}-\d{2}-\d{2}$/.test(s));
    if (invalid.length) {
      $('holidaysMsg').textContent = `Неверный формат (нужен ГГГГ-ММ-ДД): ${invalid.slice(0, 3).join(', ')}`;
      return;
    }
    try {
      await api.put('/api/holidays', { holidays });
      state.holidays = new Set(holidays);
      $('holidaysModal').classList.remove('open');
      toast(`Нерабочих дней сохранено: ${holidays.length}`);
      render();
    } catch (err) {
      $('holidaysMsg').textContent = err.message;
    }
  }

  /* ----------------------- Undo (отмена) ----------------------- */

  async function refreshUndo() {
    try {
      const btn = $('btnUndo');
      if (state.user && state.user.role !== 'admin') {
        const data = await api.get('/api/move-actions/latest-own');
        const action = data.action;
        if (action) {
          btn.disabled = !action.canRevert;
          btn.dataset.actionId = action.actionId;
          btn.title = action.canRevert ? (action.description || 'Отменить мой перенос') : 'Последний перенос уже нельзя безопасно отменить';
        } else {
          btn.disabled = true;
          delete btn.dataset.actionId;
          btn.title = '';
        }
        return;
      }
      const data = await api.get('/api/undo');
      if (data && data.action) {
        btn.disabled = false;
        btn.dataset.undoId = String(data.id);
        btn.title = data.description || data.action;
      } else {
        btn.disabled = true;
        delete btn.dataset.undoId;
        btn.title = '';
      }
    } catch {
      $('btnUndo').disabled = true;
    }
  }

  async function doUndo() {
    try {
      if (state.user && state.user.role !== 'admin') {
        const actionId = $('btnUndo').dataset.actionId;
        if (!actionId) throw new Error('Нет доступного переноса для отмены');
        await api.post(`/api/move-actions/${encodeURIComponent(actionId)}/revert`, {});
        toast('Ваш перенос отменён');
        await refreshUndo();
        render();
        return;
      }
      const expectedId = Number($('btnUndo').dataset.undoId);
      if (!Number.isInteger(expectedId) || expectedId <= 0) {
        await refreshUndo();
        throw new Error('Список действий изменился. Повторите отмену.');
      }
      await api.post('/api/undo', { expectedId });
      toast('Действие отменено');
      state.relocated = new Set(); // снять подсветку переселённых после отмены
      state.srUnplaced = null; // снять подсветку «не хватило аудитории» после отмены
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  async function doDeleteEntity() {
    if (!state.entityId) return;
    const label = (KIND_LABEL[state.kind] || state.kind).toLowerCase();
    if (!confirm(`Удалить всё расписание ${label} «${state.entityId}»?\n\nДействие можно отменить кнопкой «Отменить».`)) return;
    try {
      const r = await api.del(`/api/entity-schedule?view=${encodeURIComponent(state.kind)}&id=${encodeURIComponent(state.entityId)}`);
      toast(`Удалено ${r.total} занятий`);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  /* ----------------------- Статистика нагрузки ----------------------- */

  async function renderStats() {
    $('gridTitle').textContent = 'Статистика нагрузки';
    $('gridWrap').innerHTML = '<div class="file-status" style="padding:16px">Загрузка…</div>';
    try {
      const data = await api.get('/api/stats');
      buildStatsView(data);
    } catch (err) {
      $('gridWrap').innerHTML = `<div class="file-status" style="padding:16px">Ошибка: ${esc(err.message)}</div>`;
    }
  }

  function buildStatsView(data) {
    const tabs = [
      { key: 'teachers', label: 'Преподаватели' },
      { key: 'rooms', label: 'Аудитории' },
      { key: 'groups', label: 'Группы' },
    ];
    let html = '<div class="stats-view">';
    html += '<div class="tabs stats-tabs">';
    for (const t of tabs) {
      html += `<div class="tab${t.key === state.statsTab ? ' active' : ''}" data-stats-tab="${t.key}">${esc(t.label)}</div>`;
    }
    html += '</div>';
    // Кафедра есть только у преподавателей — на других вкладках фильтр не нужен.
    const byDept = state.statsTab === 'teachers';
    const rows = data[state.statsTab] || [];
    const pick = state.statsDepts;
    // Ни одной галочки = показываем всех: так фильтр не «схлопывает» таблицу,
    // пока пользователь не выбрал ни одной кафедры.
    const shown = () => (byDept && pick.size ? rows.filter((r) => pick.has(r.dept || '')) : rows);
    if (byDept) {
      const counts = new Map();
      for (const r of rows) counts.set(r.dept || '', (counts.get(r.dept || '') || 0) + 1);
      const depts = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
      html += `<details class="grp-filter stats-filter" id="statsDeptFilter"${statsDeptOpen ? ' open' : ''}>`
        + '<summary class="btn secondary sm" title="Какие кафедры показывать; можно отметить несколько">'
        + `🏛 Кафедры <span class="muted-hint" id="statsDeptLabel">${esc(statsDeptLabel(depts.length))}</span></summary>`
        + '<div class="grp-filter-pop"><div class="grp-filter-acts">'
        + '<button type="button" class="btn secondary sm" id="statsDeptAll">Выбрать все</button>'
        + '<button type="button" class="btn secondary sm" id="statsDeptNone">Снять все</button></div>'
        + '<div class="grp-filter-list">'
        + depts.map((d) => `<label class="pick-item"><input type="checkbox" value="${esc(d)}"${pick.has(d) ? ' checked' : ''}> `
          + `${d ? 'Кафедра ' + esc(d) : 'Без кафедры'} (${counts.get(d)})</label>`).join('')
        + '</div></div></details>';
    }
    html += `<div id="statsTableWrap">${buildStatsTable(shown(), byDept)}</div>`;
    html += '</div>';
    $('gridWrap').innerHTML = html;

    $('gridWrap').querySelectorAll('[data-stats-tab]').forEach((el) => {
      el.onclick = () => {
        state.statsTab = el.dataset.statsTab;
        buildStatsView(data);
      };
    });
    if (!byDept) return;
    const box = $('statsDeptFilter');
    const depts = [...box.querySelectorAll('input[type="checkbox"]')].map((c) => c.value);
    // Перерисовываем ТОЛЬКО таблицу: пересборка вида закрыла бы список кафедр,
    // а отмечают их обычно несколько подряд.
    const redraw = () => {
      $('statsTableWrap').innerHTML = buildStatsTable(shown(), true);
      $('statsDeptLabel').textContent = statsDeptLabel(depts.length);
    };
    box.ontoggle = () => { statsDeptOpen = box.open; };
    box.onchange = (e) => {
      const cb = e.target;
      if (cb.type !== 'checkbox') return;
      if (cb.checked) pick.add(cb.value); else pick.delete(cb.value);
      redraw();
    };
    $('statsDeptAll').onclick = () => {
      depts.forEach((d) => pick.add(d));
      box.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = true; });
      redraw();
    };
    $('statsDeptNone').onclick = () => {
      pick.clear();
      box.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = false; });
      redraw();
    };
  }

  let statsDeptOpen = false; // список кафедр раскрыт — переживает перерисовку вкладки

  // Подпись на кнопке фильтра: «все», одна кафедра или сколько выбрано.
  function statsDeptLabel(total) {
    const pick = state.statsDepts;
    if (!pick.size || pick.size === total) return 'все';
    if (pick.size === 1) return [...pick][0] || 'без кафедры';
    return `выбрано ${pick.size} из ${total}`;
  }

  function buildStatsTable(rows, withDept) {
    if (!rows.length) return '<div class="file-status" style="padding:16px">Нет данных</div>';
    const weeks = Array.from({ length: semesterWeeks() }, (_, i) => i + 1);
    let html = '<div class="grid-scroll"><table class="stats-table"><thead><tr>';
    html += '<th class="stats-name">Название</th>';
    if (withDept) html += '<th class="stats-dept">Кафедра</th>';
    for (const w of weeks) html += `<th class="stats-week">${w}</th>`;
    html += '<th class="stats-total">Итого</th></tr></thead><tbody>';
    for (const row of rows) {
      html += `<tr><td class="stats-name-cell">${esc(row.name)}</td>`;
      if (withDept) html += `<td class="stats-dept-cell">${esc(row.dept) || '—'}</td>`;
      for (const w of weeks) {
        const cnt = row.byWeek[w] || 0;
        const cls = heatClass(cnt);
        html += `<td class="stats-cell${cls ? ' ' + cls : ''}"${cnt ? ` title="${cnt} пар"` : ''}>${cnt || ''}</td>`;
      }
      html += `<td class="stats-total-cell"><strong>${row.total}</strong></td></tr>`;
    }
    html += '</tbody></table></div>';
    return html;
  }

  function heatClass(n) {
    if (!n) return '';
    if (n <= 2) return 'heat-1';
    if (n <= 5) return 'heat-2';
    if (n <= 9) return 'heat-3';
    return 'heat-4';
  }

  /* --------------------- Все преподаватели --------------------- */
  // Вид «Преподаватели»: все, у кого есть занятия, блоками по кафедрам.
  // Кафедра и отметка правятся прямо в таблице; остальное считает сервер.
  async function renderTeachers() {
    $('gridTitle').textContent = 'Преподаватели';
    $('gridWrap').innerHTML = '<div class="file-status" style="padding:16px">Загрузка…</div>';
    try {
      buildTeachersView((await api.get('/api/teachers-overview')).rows || []);
    } catch (err) {
      $('gridWrap').innerHTML = `<div class="file-status" style="padding:16px">Ошибка: ${esc(err.message)}</div>`;
    }
  }

  const TEACHER_COLS = ['Преподаватель', 'Кафедра', 'Дисциплины', 'Пар', 'Изменения'];
  const tchrCollapsed = new Set(); // свёрнутые кафедры — переживают перерисовку вида

  function buildTeachersView(rows) {
    if (!rows.length) {
      $('gridWrap').innerHTML = '<div class="file-status" style="padding:16px">Нет преподавателей с занятиями</div>';
      return;
    }
    const withChanges = rows.filter((r) => r.changed).length;
    // Заголовок вида уже стоит в шапке страницы (gridTitle) — второй не нужен.
    let html = '<div class="sem-summary">';
    html += `<p class="subjects-hint">Все преподаватели, у которых есть занятия (${rows.length}); блоками по кафедрам. `
      + 'Кафедра считается по кафедрам дисциплин преподавателя — её можно перебить вручную, тогда значение сохраняется. '
      + 'Столбец «Изменения» — ✓, если в журнале есть записи по этому преподавателю: перенос, '
      + `создание или удаление занятия; такие строки подсвечены зелёным (сейчас их ${withChanges}). `
      + 'Клик по строке кафедры сворачивает её.</p>';
    html += '<div class="grid-scroll"><table class="grid tl-table tchr-table"><thead><tr>';
    for (const c of TEACHER_COLS) html += `<th>${esc(c)}</th>`;
    html += '</tr></thead><tbody>';
    let dept = null;
    for (const r of rows) {
      if (r.dept !== dept) {
        dept = r.dept;
        const n = rows.filter((x) => x.dept === dept).length;
        const off = tchrCollapsed.has(dept);
        html += `<tr class="tchr-dept" data-dept="${esc(dept)}" title="Свернуть/развернуть кафедру">`
          + `<td colspan="${TEACHER_COLS.length}"><span class="tchr-caret">${off ? '▸' : '▾'}</span> `
          + `${dept ? 'Кафедра ' + esc(dept) : 'Кафедра не указана'} · ${n}</td></tr>`;
      }
      html += `<tr data-tname="${esc(r.name)}" data-dept="${esc(r.dept)}"`
        + `${r.changed ? ' class="tchr-changed"' : ''}${tchrCollapsed.has(r.dept) ? ' hidden' : ''}><td>${esc(r.name)}</td>`
        + `<td class="tl-ed"><input class="tl-inp tchr-dept-inp" value="${esc(r.deptManual ? r.dept : '')}"`
        + ` placeholder="${esc(r.deptAuto || '—')}" title="Пусто — кафедра считается по дисциплинам, в скобках число пар: ${esc(r.deptAll || 'не определена')}"></td>`
        + `<td class="tchr-subj" title="${esc(r.subjects.join(', '))}">${esc(r.subjects.join(', ')) || '—'}</td>`
        + `<td>${r.lessons}</td>`
        + `<td class="tchr-moved">${r.changed ? '✓' : '—'}</td></tr>`;
    }
    html += '</tbody></table></div></div>';
    $('gridWrap').innerHTML = html;
  }

  // Свернуть/развернуть кафедру в виде «Преподаватели». Строки прячем на месте:
  // перерисовка таблицы сбросила бы прокрутку, а данные от этого не меняются.
  function toggleTeacherDept(head) {
    const dept = head.dataset.dept;
    const off = !tchrCollapsed.has(dept);
    if (off) tchrCollapsed.add(dept); else tchrCollapsed.delete(dept);
    head.querySelector('.tchr-caret').textContent = off ? '▸' : '▾';
    $('gridWrap').querySelectorAll(`tr[data-tname][data-dept="${CSS.escape(dept)}"]`)
      .forEach((tr) => { tr.hidden = off; });
  }

  // Правка кафедры в виде «Преподаватели». Обработчик делегированный и вешается
  // один раз при старте (см. bind ниже) — иначе каждый рендер добавлял бы ещё один.
  // Строка после правки переезжает в блок другой кафедры, поэтому таблица
  // перестраивается целиком.
  async function saveTeacherRow(target) {
    const row = target.closest('tr[data-tname]');
    if (!row) return;
    try {
      await api.put('/api/teachers', { name: row.dataset.tname, dept: target.value.trim() });
    } catch (err) {
      toast(err.message, true);
    }
    renderTeachers();
  }

  /* ----------------------- Ошибки ----------------------- */
  async function checkErrors() {
    const [errors, all] = await Promise.all([api.get('/api/errors'), api.get('/api/schedule')]);
    const byId = new Map((all.lessons || []).map((l) => [l.id, l]));
    const fmt = (id) => {
      const l = byId.get(id);
      return l ? `${l.day} часы ${SC.pairHours(l.pairNo)} н${l.weekNo} ${l.subject || ''} (ауд ${roomStr(l) || '—'}, гр ${(l.groups || []).join(',')})` : `#${id}`;
    };
    // Кликабельная ссылка на занятие — переход к нему в сетке (п.8).
    const jumpLink = (id, text) =>
      byId.has(id)
        ? `<a href="#" class="err-jump" data-jump="${id}" title="Перейти к занятию">${esc(text)}</a>`
        : esc(text);

    const items = [];
    for (const c of errors.overlaps) items.push(`<span class="err-badge">накладка</span>${esc(c.detail)}: ` + c.lessonIds.map((id) => jumpLink(id, fmt(id))).join(' ↔ '));
    for (const c of errors.capacity) items.push(`<span class="err-badge">вместимость</span>${jumpLink(c.lessonId, c.detail)}`);
    for (const c of errors.references) items.push(`<span class="err-badge">ссылка</span>${jumpLink(c.lessonId, c.detail)}`);

    // Карта «занятие → ошибки» для подсветки ячеек и всплывающих подсказок.
    state.errors = errors.byLesson || {};
    applyErrorMarks();

    // Предупреждения: разные сокращения одной дисциплины (совпали группы/слот/ауд.).
    const cands = errors.aliasCandidates || [];
    const candHtml = cands.length
      ? '<div class="err-aliases"><h3>Возможно, разные сокращения одной дисциплины</h3>' +
        '<div class="err-hint">Совпали группы, слот и аудитория, но дисциплина сокращена по-разному. Выберите правильный вариант — он сохранится в «Замены сокращений» и применится к расписанию.</div>' +
        cands.map((c, i) => {
          const s = c.sample;
          const where = `${(s.groups || []).join(',')} · ${s.day} ${SC.pairHours(s.pairNo)} н${s.weekNo} · ауд ${(s.rooms || []).join(', ') || '—'}`;
          const opts = c.subjects.map((v, j) =>
            `<label class="ac-opt"><input type="radio" name="ac${i}" value="${esc(v.abbr)}"${j === 0 ? ' checked' : ''}> <b>${esc(v.abbr)}</b>${v.fullName ? ' — ' + esc(v.fullName) : ''}</label>`
          ).join('');
          return `<div class="err-item ac-item" data-ac="${i}"><div class="ac-where">${esc(where)} · встречается ${c.occurrences}</div>${opts}` +
            `<button type="button" class="btn sm ac-apply" data-ac="${i}">Сохранить и применить</button></div>`;
        }).join('') +
        '</div>'
      : '';

    const panel = $('errorsPanel');
    panel.style.display = 'block';
    panel.innerHTML =
      `<div class="err-head"><h3>Найдено проблем: ${errors.total}</h3>` +
      `<button type="button" class="btn secondary sm" id="errHide">Скрыть подсветку</button></div>` +
      (errors.total ? '<div class="err-hint">Ячейки с ошибками подсвечены — наведите на занятие, чтобы увидеть причину и подсказку.</div>' : '') +
      (items.length ? items.map((i) => `<div class="err-item">${i}</div>`).join('') : '<div class="err-item">Ошибок не найдено ✔</div>') +
      candHtml;
    $('errHide').onclick = () => {
      state.errors = {};
      applyErrorMarks();
      panel.style.display = 'none';
    };
    panel.querySelectorAll('[data-jump]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        jumpToLesson(byId.get(Number(a.dataset.jump)));
      };
    });
    panel.querySelectorAll('.ac-apply').forEach((btn) => {
      btn.onclick = async () => {
        const i = Number(btn.dataset.ac);
        const c = cands[i];
        const to = (panel.querySelector(`input[name="ac${i}"]:checked`) || {}).value;
        if (!to) return;
        btn.disabled = true;
        try {
          for (const v of c.subjects) {
            if (v.abbr !== to) await api.post('/api/subject-aliases/apply', { from: v.abbr, to });
          }
          toast('Замена применена');
          await checkErrors();
        } catch (err) {
          btn.disabled = false;
          toast(err.message, true);
        }
      };
    });
  }

  // Переход к занятию из списка ошибок: открыть его представление (по группе,
  // иначе по преподавателю/аудитории) на нужной неделе и подсветить ячейку.
  function jumpToLesson(l) {
    if (!l) return;
    let kind = 'group';
    let entity = (l.groups || [])[0] || null;
    if (!entity && l.teacher) { kind = 'teacher'; entity = l.teacher; }
    if (!entity) { const r = (l.rooms || [])[0] || l.room; if (r) { kind = 'room'; entity = r; } }
    if (!entity) return;

    state.kind = kind;
    $('viewKind').value = kind;
    fillEntities();            // перезаполняет #entitySelect под выбранный вид
    state.entityId = entity;
    $('entitySelect').value = entity;

    // Недельный вид нужной недели.
    state.mode = 'week';
    document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'week'));
    $('weekSelect').disabled = false;
    $('summaryKind').hidden = true;
    syncSummaryControls();
    if (l.weekNo) { state.week = l.weekNo; $('weekSelect').value = String(l.weekNo); }
    syncWeekNav();
    render();

    // Прокрутка и кратковременная подсветка ячейки занятия (после ре-рендера).
    requestAnimationFrame(() => flashLesson(l));
  }

  function flashLesson(l) {
    const wrap = $('gridWrap');
    let target = null;
    for (const c of wrap.querySelectorAll('.lesson[data-lesson]')) {
      try { if (JSON.parse(c.dataset.lesson).id === l.id) { target = c; break; } } catch { /* ignore */ }
    }
    if (!target) target = wrap.querySelector(`td.slot[data-day="${cssEsc(l.day)}"][data-pair="${l.pairNo}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 2000);
  }

  // Авто-расстановка СР в пределах ОДНОЙ открытой недели. Доступна только когда
  // выбрана неделя (сводное/недельное представление). Обратима через «Отменить».
  async function placeSelfStudy() {
    if (state.mode === 'semester' || !state.week) {
      return toast('Откройте сводное расписание и выберите неделю — СР ставится в пределах этой недели', true);
    }
    const week = state.week;
    if (!confirm(`Заполнить свободные ячейки недели ${week} занятием СР? Группы одного курса совмещаются в аудитории по вместимости (число мест стремится к числу курсантов, сначала по своей кафедре), аудитории раздаются со старшего курса к младшему. Ячейкам с мероприятием ЭкзС аудитория проставляется тем же способом — курс при нехватке мест садится в несколько аудиторий. Действие можно отменить кнопкой «Отменить».`)) return;
    try {
      const r = await api.post('/api/place-sr', { weekNo: week });
      const tail = r.unplaced ? ` · без аудитории осталось групп: ${r.unplaced} (выделены красным)` : '';
      const ecs = r.ecsRooms ? ` · аудитория проставлена ЭкзС: ${r.ecsRooms}` : '';
      toast(`Расставлено СР на неделе ${week}: ${r.created}${ecs}${tail}`, !!r.unplaced);
      // Ячейки, которым не хватило аудитории — подсветим в сводном по группам.
      const cells = r.unplacedCells || [];
      state.srUnplaced = cells.length
        ? { week: r.weekNo || week, keys: new Set(cells.map((c) => `${c.day}|${c.pairNo}|${c.group}`)) }
        : null;
      if (state.srUnplaced) { state.summaryKind = 'group'; $('summaryKind').value = 'group'; } // подсветка — в сводном по группам
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Удаление всех СР открытой недели — парная кнопка к «Расставить СР».
  // Расстановка тем по порядку. Сервер делает это сам после каждой правки —
  // кнопка нужна для разового прогона и чтобы увидеть, сколько тем переставлено.
  async function sortTopics() {
    try {
      const r = await api.post('/api/topics/sort', {});
      toast(r.changed ? `Тем переставлено: ${r.changed}` : 'Темы уже стоят по порядку');
      if (r.changed) render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function clearSelfStudy() {
    if (state.mode === 'semester' || !state.week) {
      return toast('Откройте сводное расписание и выберите неделю — удаление СР работает в пределах недели', true);
    }
    const week = state.week;
    if (!confirm(`Удалить все занятия СР недели ${week}? У мероприятий ЭкзС этой недели аудитории тоже снимутся. Действие можно отменить кнопкой «Отменить».`)) return;
    try {
      const r = await api.post('/api/clear-sr', { weekNo: week });
      const ecsTail = r.ecsCleared ? ` · снята аудитория у ЭкзС: ${r.ecsCleared}` : '';
      toast(`Удалено СР на неделе ${week}: ${r.deleted}${ecsTail}`);
      state.srUnplaced = null; // снять подсветку «не хватило аудитории»
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // «Удалить занятия скрытых групп» — в расписании преподавателя удаляет все
  // занятия, у которых ВСЕ группы скрыты (не входят в перечень отображаемых).
  // Сначала предпросмотр (какие группы затронуты), потом подтверждение и удаление.
  // Действует по всему расписанию преподавателя (все недели), не только по открытой.
  async function clearHiddenGroupLessons() {
    if (state.kind !== 'teacher' || !state.entityId) return;
    const teacher = state.entityId;
    try {
      const preview = await api.get(`/api/teacher-hidden-groups?teacher=${encodeURIComponent(teacher)}`);
      if (!preview.count) return toast('Нет занятий скрытых групп в расписании этого преподавателя', true);
      const groupsList = preview.groups.join(', ');
      const ok = confirm(
        `Будут удалены занятия групп: ${groupsList}\n(${preview.count} занятий, отсутствующих в перечне отображаемых групп)\n\n` +
        `Удаление затронет всё расписание преподавателя «${teacher}», не только текущую неделю.\n` +
        `Действие можно отменить кнопкой «Отменить».`
      );
      if (!ok) return;
      const r = await api.post('/api/teacher-hidden-groups/clear', { teacher });
      toast(`Удалено занятий: ${r.deleted} (группы: ${r.groups.join(', ')})`);
      refreshUndo();
      render();
    } catch (err) {
      const reasons = (err.data && err.data.reasons) || [err.message];
      toast(reasons.join('; '), true);
    }
  }

  // Тумблеры гостевых прав — состояние живёт на сервере (settings.guest*),
  // гостевая страница спрашивает их при загрузке.
  async function setupGuestEdit() {
    await setupGuestToggle('guestEdit', '/api/guest-edit', 'Гости могут править тему, примечание и вид практического занятия', 'Правка гостями закрыта');
    await setupGuestToggle('guestExport', '/api/guest-export', 'Гости могут скачивать расписание в Excel', 'Скачивание гостями закрыто');
    await setupGuestToggle('guestMoves', '/api/guest-moves', 'Гости видят свободные окна', 'Показ свободных окон закрыт');
    await setupGuestToggle('guestColors', '/api/guest-colors', 'Занятия у гостей разноцветные', 'Цвета занятий у гостей выключены');
    await setupWidgetHost();
  }

  // Адрес сервера для виджета: пусто — сервер подставит тот, по которому открыта
  // гостевая страница. Пригодится, когда гости заходят по имени, которое с их
  // компьютеров не разрешается, или через промежуточный сервер.
  async function setupWidgetHost() {
    const box = $('widgetHost');
    if (!box) return;
    try {
      box.value = (await api.get('/api/widget-host')).host || '';
    } catch {
      box.disabled = true;
      box.placeholder = 'сервер не знает этой настройки — обновите сборку';
      return;
    }
    box.onchange = async () => {
      try {
        const r = await api.put('/api/widget-host', { host: box.value });
        box.value = r.host || '';
        toast(box.value ? `Виджет будет ходить на ${box.value}` : 'Адрес для виджета определяется автоматически');
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  // Тумблер пометки переносов: состояние на сервере (одно на админку и гостей),
  // после переключения перерисовываем сетку — полоса появляется/уходит сразу.
  async function setupMoveMarks() {
    const box = $('moveMarks');
    if (!box) return;
    await setupGuestToggle('moveMarks', '/api/move-marks', 'Перенесённые занятия помечаются', 'Пометки переносов скрыты');
    moveMarks = box.checked;
    const save = box.onchange;
    box.onchange = async () => {
      if (save) await save();
      moveMarks = box.checked;
      render();
    };
  }

  async function setupGuestToggle(id, url, onMsg, offMsg) {
    const box = $(id);
    try {
      box.checked = Boolean((await api.get(url)).enabled);
    } catch {
      // Состояние неизвестно — переключать вслепую нельзя. Чаще всего это старый
      // запущенный сервер, который ещё не знает нового эндпоинта, поэтому пишем
      // причину в подсказку: иначе тумблер просто «не работает» без объяснений.
      box.disabled = true;
      // Причина видна СРАЗУ, а не только в подсказке при наведении: иначе тумблер
      // выглядит просто сломанным (реальный случай — сервер запущен до правок кода).
      const lbl = box.parentElement;
      if (lbl) {
        lbl.title = 'Тумблер недоступен: сервер не отвечает на ' + url + '. Если код обновляли — перезапустите сервер.';
        if (!lbl.querySelector('.chk-warn')) {
          const warn = document.createElement('span');
          warn.className = 'chk-warn';
          warn.textContent = ' — нужен перезапуск сервера';
          lbl.appendChild(warn);
        }
      }
      return;
    }
    box.onchange = async () => {
      try {
        await api.put(url, { enabled: box.checked });
        toast(box.checked ? onMsg : offMsg);
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message, true);
      }
    };
  }

  async function doPublish() {
    try {
      const r = await api.post('/api/publish');
      toast(`Опубликовано: ${r.count} занятий`);
      syncPublishState();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ----------------------- Импорт ----------------------- */
  // Собирает выбранные HTML/XLSX-файлы из обычного инпута и выбранной папки
  // (подпапки тоже — браузер отдаёт все файлы дерева).
  function pickedImportFiles() {
    const all = [...$('fileInput').files, ...$('folderInput').files];
    const seen = new Set();
    return all.filter((f) => {
      if (!/\.(html?|xlsx)$/i.test(f.name)) return false;
      const key = (f.webkitRelativePath || f.name) + ':' + f.size;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function doImport() {
    const files = pickedImportFiles();
    if (!files.length) return toast('Выберите .html/.xlsx-файлы или папку с расписанием', true);
    // Позднее распознавание выбранных файлов не должно затирать итог импорта.
    importPreviewRevision++;
    const mode = $('importMerge').checked ? 'merge' : 'replace';
    const fields = { mode };
    // Авто-выравнивание по датам файла (по умолчанию) либо ручной сдвиг.
    if (!$('importAutoOffset').checked) {
      fields.weekOffset = String(Number($('importOffset').value) || 0);
    }
    if (!$('importTeacherFilter').checked) fields.filterTeachers = 'false';
    $('importStatus').textContent = `Загрузка ${files.length} файл(ов)…`;
    try {
      const { report } = await api.upload('/api/import', files, fields);
      const total = report.fromGroups + report.addedFromRooms;
      const extra =
        report.mode === 'merge'
          ? ` · добавлено ${report.lessonsAdded ?? 0}, дополнено ${report.lessonsMatched ?? 0}`
          : ' · база перезаписана';
      const shifted = report.shifted ? ` · сдвинуто файлов: ${report.shifted}` : '';
      const skipped = report.teachersSkipped ? ` · отсеяно преподавателей: ${report.teachersSkipped}` : '';
      // Пары преподавателя по группам, которых нет в базе: раньше они пропадали.
      const foreign = report.teacherOnlyAdded ? ` · пар по чужим группам: ${report.teacherOnlyAdded}` : '';
      // Пары, попавшие на «ЭкзС» группы: раньше пропадали, теперь ждут в полосе под сеткой.
      const orph = report.sessionOrphans ? ` · не размещено (сессия у группы): ${report.sessionOrphans}` : '';
      $('importStatus').textContent = `Готово: занятий ${total}${extra}${shifted}, преподаватель проставлен ${report.teachersAssigned}${skipped}${foreign}${orph}`;
      // Подобранный сдвиг недель разошёлся с авто-расчётом по дате — даты в файле
      // могут быть кривыми. Показываем заметно, чтобы проверили вручную.
      const warns = report.offsetWarnings || [];
      if (warns.length) {
        const fmt = (n) => (n > 0 ? `+${n}` : String(n));
        const list = warns
          .map((w) => `${w.owner || '?'} — авто-сдвиг ${fmt(w.autoOffset)}, применён ${fmt(w.chosenOffset)} (совпало ${w.matched})`)
          .join('; ');
        $('importStatus').textContent += ` · ⚠ Проверьте даты: ${list}`;
        toast(`Сдвиг недель скорректирован: ${warns.length} файл(ов) — проверьте даты`, true);
      }
      // Файлы, чей сдвиг не подтверждён датами, НЕ импортированы — открываем
      // окно ручного выбора сдвига для повторного импорта.
      const problems = report.problemFiles || [];
      if (problems.length) {
        $('importStatus').textContent += ` · ⚠ Не импортировано файлов: ${problems.length} — сдвиг не подтверждён`;
        openImportProblems(problems, files);
      }
      await loadEntities();
      await loadLegend();
      await loadGroupSubjects();
      render();
      toast('Импорт завершён');
    } catch (err) {
      $('importStatus').textContent = err.message;
      toast(err.message, true);
    }
  }

  /* ---------- Проблемные файлы импорта: ручной выбор сдвига ---------- */
  // Файлы, не прошедшие диагональную проверку дат, сервер не импортирует и
  // возвращает в report.problemFiles. Держим исходные File по имени, чтобы
  // повторно отправить их с выбранным вручную сдвигом (weekOffset).
  let problemImportFiles = new Map(); // имя файла -> File

  function openImportProblems(problems, pickedFiles) {
    problemImportFiles = new Map(pickedFiles.map((f) => [f.name, f]));
    const kindLabel = { group: 'группа', room: 'аудитория', teacher: 'преподаватель' };
    $('importProblemsList').innerHTML = problems
      .map(
        (p) =>
          `<div class="ref-row" data-name="${esc(p.name || '')}">` +
          `<label class="chk-lbl"><input type="checkbox" checked data-k="use"> ${esc(p.name || p.owner || '?')}</label>` +
          `<span class="file-status">${kindLabel[p.kind] || '?'}${p.owner ? ` · ${esc(p.owner)}` : ''} — ${esc(p.reason || '')}</span>` +
          `<input type="number" data-k="off" value="${Number(p.suggestedOffset) || 0}" min="-52" max="52" step="1" title="Сдвиг недель">` +
          `</div>`
      )
      .join('');
    $('importProblemsModal').classList.add('open');
  }

  async function applyImportProblems() {
    // Группируем отмеченные файлы по выбранному сдвигу — по запросу на сдвиг.
    const byOffset = new Map(); // сдвиг -> File[]
    const missing = [];
    $('importProblemsList')
      .querySelectorAll('.ref-row')
      .forEach((row) => {
        if (!row.querySelector('[data-k="use"]').checked) return;
        const file = problemImportFiles.get(row.dataset.name);
        if (!file) return missing.push(row.dataset.name);
        const off = Math.max(-52, Math.min(52, Number(row.querySelector('[data-k="off"]').value) || 0));
        if (!byOffset.has(off)) byOffset.set(off, []);
        byOffset.get(off).push(file);
      });
    if (missing.length) toast(`Не найдены среди выбранных файлов: ${missing.join(', ')}`, true);
    if (!byOffset.size) return;
    try {
      let added = 0;
      let matched = 0;
      for (const [off, files] of byOffset) {
        const fields = { mode: 'merge', weekOffset: String(off) };
        if (!$('importTeacherFilter').checked) fields.filterTeachers = 'false';
        const { report } = await api.upload('/api/import', files, fields);
        added += report.lessonsAdded ?? 0;
        matched += report.lessonsMatched ?? 0;
      }
      $('importProblemsModal').classList.remove('open');
      $('importStatus').textContent = `Импорт со сдвигом: добавлено ${added}, дополнено ${matched}`;
      toast('Проблемные файлы импортированы');
      await loadEntities();
      await loadLegend();
      await loadGroupSubjects();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Перед записью показываем, что именно сервер нашёл в каждом файле.
  let importPreviewRevision = 0;
  async function updateImportPicked() {
    const revision = ++importPreviewRevision;
    const n = pickedImportFiles().length;
    $('importStatus').textContent = n ? `Выбрано файлов: ${n} · определяю структуру…` : '';
    $('importPreview').textContent = '';
    if (!n) return;
    try {
      const { files } = await api.upload('/api/import/preview', pickedImportFiles(), {});
      if (revision !== importPreviewRevision) return;
      const format = { html: 'HTML', 'single-cell': 'Excel: пара в одной ячейке', 'three-rows': 'Excel: три строки на пару' };
      $('importPreview').innerHTML = files.map((f) => {
        const examples = (f.examples || []).map((x) => esc(
          `${x.day}, нед. ${x.weekNo}, пара ${x.pairNo}: ${[x.type, x.topic, x.subject, x.room].filter(Boolean).join(' · ')}`
        )).join('<br>');
        return `<div><b>${esc(f.name)}</b>: ${esc(format[f.format] || f.format)}, группа ${esc(f.owner || '?')}, ` +
          `сетка со строки ${f.gridRow || '—'}, недель ${f.weeks}, записей ${f.lessons}` +
          `${f.firstDate ? `, первая дата ${esc(f.firstDate)}` : ', ⚠ дата не найдена'}` +
          `${examples ? `<br><span>Проверьте примеры:<br>${examples}</span>` : ''}</div>`;
      }).join('<hr>');
      $('importStatus').textContent = `Выбрано файлов: ${n} · проверьте распознавание ниже`;
    } catch (err) {
      if (revision !== importPreviewRevision) return;
      $('importStatus').textContent = `Не удалось распознать: ${err.message}`;
    }
  }

  /* ----------------------- Полная очистка ----------------------- */
  async function doReset() {
    try {
      await api.post('/api/reset', { password: $('resetPass').value });
      $('resetModal').classList.remove('open');
      toast('База данных очищена');
      await loadEntities();
      await loadGroupSubjects();
      $('errorsPanel').style.display = 'none';
      state.errors = {};
      render();
    } catch (err) {
      $('resetMsg').textContent = err.message;
    }
  }

  // Очистить только расписание: занятия и журнал переносов. Справочники, семестры,
  // курсы и настройки сохраняются. Действие необратимо (Undo тоже очищается) —
  // поэтому подтверждаем явно.
  async function doClearSchedule() {
    if (!confirm('Очистить расписание?\n\nБудут удалены ВСЕ занятия и журнал переносов.\nСправочники (аудитории, группы, преподаватели, дисциплины), семестры и курсы сохранятся.\n\nДействие необратимо.')) return;
    try {
      const { deleted } = await api.post('/api/clear-schedule', {});
      toast(`Расписание очищено (удалено занятий: ${deleted ?? 0})`);
      await loadGroupSubjects();
      $('errorsPanel').style.display = 'none';
      state.errors = {};
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ----------------------- Смена пароля ----------------------- */
  function openPassword() {
    $('pwTarget').value = 'login';
    $('pwCurrent').value = '';
    $('pwNew').value = '';
    $('pwNew2').value = '';
    $('pwMsg').textContent = '';
    $('passwordModal').classList.add('open');
  }

  async function doChangePassword() {
    const isReset = $('pwTarget').value === 'reset';
    const currentPassword = $('pwCurrent').value;
    const newPassword = $('pwNew').value;
    if (newPassword !== $('pwNew2').value) {
      $('pwMsg').textContent = 'Новые пароли не совпадают';
      return;
    }
    try {
      await api.post(isReset ? '/api/reset-password' : '/api/password', { currentPassword, newPassword });
      $('passwordModal').classList.remove('open');
      if (isReset) {
        toast('Пароль изменён');
        refreshDefaultPwBanner();
      } else {
        location.href = '/login.html';
      }
    } catch (err) {
      $('pwMsg').textContent = err.message;
    }
  }

  // Предупреждение, если активны пароли по умолчанию (admin/admin, очистка 2707).
  function maybeShowDefaultPwBanner(flags) {
    if (!flags || (!flags.password && !flags.resetPassword)) return;
    let bar = $('defaultPwBanner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'defaultPwBanner';
      bar.style.cssText =
        'background:#7f1d1d;color:#fff;padding:10px 16px;text-align:center;font-size:14px;' +
        'display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap';
      document.body.prepend(bar);
    }
    const parts = [];
    if (flags.password) parts.push('вход (admin/admin)');
    if (flags.resetPassword) parts.push('очистка базы');
    bar.innerHTML =
      `⚠ Используется пароль по умолчанию: ${esc(parts.join(', '))}. ` +
      '<button class="btn sm" id="bannerChangePw">Сменить пароль</button>';
    $('bannerChangePw').onclick = openPassword;
  }

  async function refreshDefaultPwBanner() {
    try {
      const info = await api.get('/api/auth/check');
      const flags = info.usingDefaults || {};
      if (!flags.password && !flags.resetPassword) {
        const bar = $('defaultPwBanner');
        if (bar) bar.remove();
      } else {
        maybeShowDefaultPwBanner(flags);
      }
    } catch {
      /* баннер не критичен */
    }
  }

  /* ----------------------- Настройка семестра ----------------------- */
  // Идентификатор семестра — как на сервере (semId): «название|начало|конец».
  function semIdOf(s) {
    return s ? `${s.name || ''}|${s.start || ''}|${s.end || ''}` : null;
  }

  async function openSemester() {
    $('semName').value = 'осень';
    $('semStart').value = '';
    $('semEnd').value = '';
    $('semMsg').textContent = '';
    await loadSemesters();
    updateWeekCount();
    $('semesterModal').classList.add('open');
  }

  // Список сохранённых семестров + подстановка активного в форму.
  async function loadSemesters() {
    let data = { semesters: [], current: null };
    try {
      data = await api.get('/api/semesters');
    } catch {
      /* пусто */
    }
    const current = data.current || null;
    if (current) {
      $('semName').value = current.name || 'осень';
      $('semStart').value = current.start || '';
      $('semEnd').value = current.end || '';
    }
    renderSemesters(data.semesters || [], semIdOf(current));
  }

  // Подпись числа недель семестра по датам (как updateWeekCount, но для строки списка).
  function weeksOf(start, end) {
    if (!start || !end || start > end) return '?';
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const e = new Date(end + 'T00:00:00Z');
    return Math.floor((e - d) / (7 * 86400000)) + 1;
  }

  function renderSemesters(list, currentId) {
    const box = $('semSaved');
    if (!list.length) {
      box.innerHTML = '<div class="file-status">Пока нет сохранённых семестров.</div>';
      return;
    }
    box.innerHTML = list
      .map((s) => {
        const active = s.id === currentId;
        const dates = `${fmtDate(s.start)} – ${fmtDate(s.end)}`;
        return (
          `<div class="sem-row ${active ? 'active' : ''}">` +
          `<div class="sem-info"><b>${esc(s.name || '—')}</b> <span class="muted">${esc(dates)} · ${weeksOf(s.start, s.end)} нед.</span></div>` +
          `<div class="sem-acts">` +
          (active
            ? '<span class="sem-badge">текущий</span>'
            : `<button class="btn secondary sm" data-sem-select="${esc(s.id)}">Выбрать</button>`) +
          `<button class="btn danger sm" data-sem-del="${esc(s.id)}" aria-label="Удалить">✕</button>` +
          `</div></div>`
        );
      })
      .join('');
    box.querySelectorAll('[data-sem-select]').forEach((b) => {
      b.onclick = () => selectSemesterById(b.dataset.semSelect);
    });
    box.querySelectorAll('[data-sem-del]').forEach((b) => {
      b.onclick = () => deleteSemesterById(b.dataset.semDel);
    });
  }

  // ISO «YYYY-MM-DD» → «дд.мм.гггг» для подписи.
  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  async function selectSemesterById(id) {
    try {
      const { semester } = await api.put('/api/semesters/select', { id });
      state.semester = semester || null;
      fillWeeks();
      toast('Семестр выбран, даты пересчитаны');
      await loadSemesters();
      render();
    } catch (err) {
      $('semMsg').textContent = err.message;
    }
  }

  async function deleteSemesterById(id) {
    if (!confirm('Удалить этот семестр из памяти? Само расписание не затрагивается.')) return;
    try {
      await api.del(`/api/semesters/${encodeURIComponent(id)}`);
      toast('Семестр удалён');
      // Если удалили активный — обновим текущее состояние.
      const { semester } = await api.get('/api/semester');
      state.semester = semester || null;
      fillWeeks();
      await loadSemesters();
      render();
    } catch (err) {
      $('semMsg').textContent = err.message;
    }
  }

  function updateWeekCount() {
    const s = $('semStart').value;
    const e = $('semEnd').value;
    if (!s || !e || s > e) return ($('semWeeks').value = '');
    // Неделя 1 — понедельник недели даты начала.
    const d = new Date(s + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    const end = new Date(e + 'T00:00:00Z');
    $('semWeeks').value = Math.floor((end - d) / (7 * 86400000)) + 1;
  }

  async function saveSemester() {
    const body = { name: $('semName').value, start: $('semStart').value, end: $('semEnd').value };
    try {
      const { semester } = await api.put('/api/semester', body);
      state.semester = semester || body;
      fillWeeks();
      toast('Семестр сохранён и сделан активным');
      await loadSemesters(); // показать его в списке, окно не закрываем
      render();
    } catch (err) {
      $('semMsg').textContent = err.message;
    }
  }

  /* ----------------------- Справочники ----------------------- */
  function openRefs() {
    $('refModal').classList.add('open');
    if ($('refSearch')) $('refSearch').value = '';
    loadRefList('rooms');
  }

  if ($('refSearch')) {
    $('refSearch').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $('refList').querySelectorAll('.ref-row').forEach((row) => {
        const nameSpan = row.querySelector('span');
        const text = nameSpan ? nameSpan.textContent.toLowerCase() : row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
      });
    };
  }

  function openEvents() {
    document.querySelectorAll('[data-ref-tab]').forEach((x) => x.classList.remove('active'));
    document.querySelector('[data-ref-tab="events"]').classList.add('active');
    $('refModal').classList.add('open');
    loadTypesTab('events');
  }

  // Активная вкладка справочника (rooms | groups | hidden).
  function activeRefTab() {
    const t = document.querySelector('[data-ref-tab].active');
    return t ? t.dataset.refTab : 'rooms';
  }

  // Каталог кодов: виды мероприятий и виды учебных занятий. Перечень типов, а не
  // экземпляры из расписания — правка кода здесь занятия в сетке не трогает.
  const TYPE_CATALOGS = {
    events: { url: '/api/event-types', saved: 'Перечень мероприятий сохранён', ph: 'Код (напр. ОП)' },
    'lesson-types': { url: '/api/lesson-types', saved: 'Перечень видов занятий сохранён', ph: 'Код (напр. ГЗ)' },
  };

  async function loadTypesTab(kind) {
    const cat = TYPE_CATALOGS[kind];
    let types = [];
    try {
      ({ types } = await api.get(cat.url));
    } catch (err) {
      $('refList').innerHTML = `<div class="file-status">${esc(err.message)}</div>`;
      return;
    }

    const addForm =
      `<div class="ref-add">` +
      `<input type="text" id="evNewCode" placeholder="${esc(cat.ph)}" autocomplete="off" style="max-width:100px">` +
      `<input type="text" id="evNewName" placeholder="Расшифровка" autocomplete="off">` +
      `<button class="btn sm" id="evAdd" type="button">Добавить</button>` +
      `</div>`;
    const hint = `<div class="file-status">Код — обозначение в сетке. Расшифровка — пояснение (Enter — сохранить).</div>`;
    const rows = types.map(({ code, name }) =>
      `<div class="ref-row">` +
      `<span style="min-width:70px;font-weight:600;flex-shrink:0">${esc(code)}</span>` +
      `<input type="text" class="ev-name-inp" value="${esc(name)}" data-code="${esc(code)}" placeholder="Расшифровка">` +
      `<button class="btn danger sm ev-del-type" data-code="${esc(code)}" title="Удалить из перечня">🗑</button>` +
      `</div>`
    ).join('');

    $('refList').innerHTML = addForm + hint + (rows || '<div class="file-status">Перечень пуст.</div>');

    async function saveTypes(updated) {
      try {
        await api.put(cat.url, { types: updated });
        if (kind === 'lesson-types') lessonTypes = null; // кеш выпадающих списков устарел
        toast(cat.saved);
      } catch (err) {
        toast(err.message, true);
      }
    }

    $('evAdd').onclick = async () => {
      const code = $('evNewCode').value.trim();
      const name = $('evNewName').value.trim();
      if (!code) return;
      if (types.some((t) => t.code === code)) { toast(`Код «${code}» уже есть в перечне`, true); return; }
      await saveTypes([...types, { code, name }]);
      await loadTypesTab(kind);
    };
    $('evNewCode').onkeydown = $('evNewName').onkeydown = (e) => {
      if (e.key === 'Enter') $('evAdd').click();
    };

    $('refList').querySelectorAll('.ev-name-inp').forEach((inp) => {
      const save = () => {
        const updated = types.map((t) => t.code === inp.dataset.code ? { code: t.code, name: inp.value.trim() } : t);
        saveTypes(updated);
      };
      inp.onblur = save;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
    });

    $('refList').querySelectorAll('.ev-del-type').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Удалить «${b.dataset.code}» из перечня?
(Занятия с этим кодом в расписании не затрагиваются.)`)) return;
        await saveTypes(types.filter((t) => t.code !== b.dataset.code));
        await loadTypesTab(kind);
      };
    });
  }

  async function loadRefList(which) {
    if ($('btnToggleAll')) $('btnToggleAll').style.display = 'none';
    if (TYPE_CATALOGS[which]) { await loadTypesTab(which); return; }
    // «Скрытые аудитории»/«Скрытые группы» — отдельные вкладки: только скрытые записи
    // (восстановление), без формы добавления. Видимые — на вкладках «Аудитории»/«Группы».
    const hiddenTab = which === 'hidden' || which === 'hidden-groups';
    const entity = which === 'hidden' ? 'rooms' : which === 'hidden-groups' ? 'groups' : which;
    
    if ($('btnToggleAll')) {
      $('btnToggleAll').style.display = '';
      $('btnToggleAll').textContent = hiddenTab ? 'Показать все' : 'Скрыть все';
      $('btnToggleAll').onclick = async () => {
        if (!confirm(`Вы уверены, что хотите ${hiddenTab ? 'показать' : 'скрыть'} все записи на этой вкладке?`)) return;
        try {
          await api.put('/api/entity-visibility/bulk', { kind: entity, hidden: !hiddenTab });
          toast(hiddenTab ? 'Все записи показаны' : 'Все записи скрыты');
          await refreshEntities();
          await loadRefList(which);
        } catch (err) {
          toast(err.message, true);
        }
      };
    }

    let list = await api.get('/api/' + entity);
    // Скрытые записи живут только в своей вкладке, видимые — в основной.
    list = list.filter((r) => (hiddenTab ? r.hidden : !r.hidden));

    const isRooms = entity === 'rooms';
    const valKey = isRooms ? 'capacity' : 'headcount';
    const labelKey = isRooms ? 'Вместимость' : 'Численность';
    const nameLabel = isRooms ? 'Новая аудитория' : 'Новая группа';
    const noun = isRooms ? 'аудиторию' : 'группу';
    const nounPl = isRooms ? 'аудиторий' : 'групп';

    const courseAdd = isRooms
      ? `<input type="number" min="1" max="5" id="refNewCourse" placeholder="курс" title="Только для курса (1–5), пусто — без ограничения">`
      : '';
    const addForm = hiddenTab
      ? ''
      : `<div class="ref-add${isRooms ? ' with-course' : ''}">` +
        `<input type="text" id="refNewName" placeholder="${nameLabel}" autocomplete="off">` +
        `<input type="text" id="refNewDept" placeholder="Кафедра" autocomplete="off">` +
        courseAdd +
        `<input type="number" min="0" id="refNewVal" placeholder="${labelKey}">` +
        `<button class="btn sm" id="refAdd" type="button">Добавить</button></div>`;
    const hint = hiddenTab
      ? `<div class="file-status">Скрыты из списков просмотра. 🙈 — вернуть ${noun} в список.</div>`
      : `<div class="file-status">${labelKey} (Enter — сохранить) · 👁 — показ в списке просмотра</div>`;
    const empty = hiddenTab && !list.length ? `<div class="file-status">Скрытых ${nounPl} нет.</div>` : '';

    // Строка справочника: имя + поля правки. Вынесена, чтобы группы можно было
    // разложить по курсам, а аудитории оставить сплошным списком.
    const rowHtml = (r) => {
      const hid = r.hidden ? 1 : 0;
      const courseInp = isRooms
        ? `<input type="number" min="1" max="5" class="ref-course" placeholder="курс" title="Только для курса (1–5), пусто — без ограничения" value="${r.courseOnly ?? ''}" data-name="${esc(r.name)}" data-which="${entity}">`
        : '';
      // Примечание об оснащении показывается везде, где выбирают аудиторию.
      const noteInp = isRooms
        ? `<input type="text" class="ref-note" placeholder="Примечание (компьютерный класс, лаборатория…)" title="Показывается при выборе аудитории" value="${esc(r.note ?? '')}" data-name="${esc(r.name)}" data-which="${entity}">`
        : '';
      return (
        `<div class="ref-row${hid ? ' hidden-ent' : ''}${isRooms ? ' with-course with-note' : ''}"><span>${esc(r.name)}</span>` +
        `<input type="text" class="ref-dept" placeholder="Кафедра" value="${esc(r.dept ?? '')}" data-name="${esc(r.name)}" data-which="${entity}">` +
        noteInp +
        courseInp +
        `<input type="number" min="0" value="${r[valKey] ?? ''}" data-name="${esc(r.name)}" data-which="${entity}">` +
        `<button type="button" class="vis-toggle${hid ? ' is-hidden' : ''}" data-name="${esc(r.name)}" data-hidden="${hid}" ` +
        `title="${hid ? 'Показать в списке просмотра' : 'Скрыть из списка просмотра'}">${hid ? '🙈' : '👁'}</button></div>`
      );
    };
    // Группы показываем блоками по курсам (заголовок — просто подпись: здесь
    // ничего не выбирают, а правят численность и кафедру).
    const byName = new Map(list.map((r) => [r.name, r]));
    const rowsHtml = isRooms
      ? list.map(rowHtml).join('')
      : SC.groupsByCourse(list.map((r) => r.name), state.courses)
          .map((c) => `<div class="ref-course-head">${c.label}</div>` + c.groups.map((g) => rowHtml(byName.get(g))).join(''))
          .join('');
    $('refList').innerHTML = addForm + hint + empty + rowsHtml;
    $('refList')
      .querySelectorAll('.ref-row input')
      .forEach((inp) => {
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') saveRef(inp);
        };
        inp.onblur = () => saveRef(inp);
      });
    $('refList')
      .querySelectorAll('.vis-toggle')
      .forEach((b) => {
        b.onclick = () => toggleVisibility(entity, b.dataset.name, b.dataset.hidden !== '1');
      });
    if (!hiddenTab) {
      $('refAdd').onclick = () => addRef(entity);
      const addOnEnter = (e) => {
        if (e.key === 'Enter') addRef(entity);
      };
      $('refNewName').onkeydown = addOnEnter;
      $('refNewDept').onkeydown = addOnEnter;
      $('refNewVal').onkeydown = addOnEnter;
      if ($('refNewCourse')) $('refNewCourse').onkeydown = addOnEnter;
    }
    if ($('refSearch') && $('refSearch').value) {
      $('refSearch').dispatchEvent(new Event('input'));
    }
  }

  // Перечитать списки сущностей для селекторов, по возможности сохранив текущий
  // выбор. Если выбранная сущность пропала (например, её только что скрыли) —
  // перерисовываем сетку под новый выбор.
  async function refreshEntities() {
    const prev = state.entityId;
    state.entities = await api.get('/api/entities');
    fillEntities();
    const cur = state.entities[state.kind + 's'] || [];
    if (prev && cur.includes(prev)) {
      state.entityId = prev;
      $('entitySelect').value = prev;
    } else {
      render();
    }
  }

  // Добавление новой аудитории/группы вручную. PUT с новым именем создаёт
  // запись (getOrCreate на сервере), значение ёмкости/численности необязательно.
  async function addRef(which) {
    const name = $('refNewName').value.trim();
    if (!name) return toast('Введите название', true);
    const raw = $('refNewVal').value;
    const val = raw === '' ? null : Number(raw);
    if (val != null && (!Number.isInteger(val) || val < 0))
      return toast('Число должно быть неотрицательным целым', true);
    const dept = ($('refNewDept').value || '').trim() || null;
    try {
      if (which === 'rooms') {
        const cv = $('refNewCourse') ? $('refNewCourse').value : '';
        await api.put('/api/rooms', { name, capacity: val, dept, courseOnly: cv === '' ? null : Number(cv) });
      } else await api.put('/api/groups', { name, headcount: val, dept });
      toast(which === 'rooms' ? 'Аудитория добавлена' : 'Группа добавлена');
      await refreshEntities();
      await loadRefList(activeRefTab());
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Скрыть/показать аудиторию или группу в селекторе просмотра. Занятия не
  // трогаются — скрытая сущность по-прежнему видна в расписаниях других.
  async function toggleVisibility(which, name, hidden) {
    try {
      await api.put('/api/entity-visibility', { kind: which, name, hidden });
      toast(hidden ? 'Скрыто из списка просмотра' : 'Показано в списке просмотра');
      await refreshEntities();
      await loadRefList(activeRefTab());
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function saveRef(inp) {
    // Берём оба поля строки (число + кафедра), чтобы правка одного не стирала другое.
    const row = inp.closest('.ref-row');
    // Вместимость/численность — числовое поле без класса ref-course (у аудиторий
    // есть отдельное поле «курс» того же типа number).
    const numInp = row.querySelector('input[type="number"]:not(.ref-course)');
    const deptInp = row.querySelector('.ref-dept');
    const courseInp = row.querySelector('.ref-course');
    const noteInp = row.querySelector('.ref-note');
    const name = inp.dataset.name;
    const val = !numInp || numInp.value === '' ? null : Number(numInp.value);
    const dept = deptInp ? deptInp.value.trim() : null;
    try {
      if (inp.dataset.which === 'rooms') {
        const courseOnly = courseInp && courseInp.value !== '' ? Number(courseInp.value) : null;
        const note = noteInp ? noteInp.value.trim() : '';
        await api.put('/api/rooms', { name, capacity: val, dept, courseOnly, note });
      } else await api.put('/api/groups', { name, headcount: val, dept });
      inp.style.borderColor = 'var(--primary)';
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ----------------------- Утилиты ----------------------- */
  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), HINT_MS);
  }

  // Значения занятия по выбранному параметру выделения. Их может быть несколько:
  // две аудитории, поток из нескольких групп, два преподавателя.
  function hlValuesOf(lesson, kind) {
    if (kind === 'room') return roomsOf(lesson);
    if (kind === 'group') return lesson.groups || [];
    if (kind === 'teacher') return teachersOf(lesson);
    if (kind === 'type') return lesson.type ? [String(lesson.type).trim()] : [];
    if (kind === 'pair') return lesson.pairNo ? [String(lesson.pairNo)] : [];
    return lesson.subject ? [lesson.subject] : [];
  }

  // Список значений одного параметра — из того, что реально есть в отрисованной
  // сетке. Параметр не выбран → список пуст и выключен.
  function fillHlSelect(kindSel, valueSel, hl) {
    const sel = $(valueSel);
    $(kindSel).value = hl.kind || '';
    sel.disabled = !hl.kind;
    if (!hl.kind) {
      sel.innerHTML = '<option value="">—</option>';
      hl.value = '';
      return;
    }
    const set = new Set();
    document.querySelectorAll('#gridWrap .lesson[data-lesson]').forEach((c) => {
      try {
        for (const v of hlValuesOf(JSON.parse(c.dataset.lesson), hl.kind)) if (v) set.add(v);
      } catch { /* ignore */ }
    });
    const values = [...set].sort((a, b) => a.localeCompare(b, 'ru'));
    // Выбранное значение остаётся в списке, даже если в текущем виде его нет:
    // иначе пролистывание недель/групп сбрасывало бы выделение.
    const missing = hl.value && !values.includes(hl.value);
    const option = (v) => `<option value="${esc(v)}">${esc(v)}</option>`;
    sel.innerHTML = '<option value="">—</option>'
      + (missing ? `<option value="${esc(hl.value)}">${esc(hl.value)} (нет здесь)</option>` : '')
      + (hl.kind === 'group' ? SC.courseOptionsHtml(values, state.courses, option) : values.map(option).join(''));
    sel.value = hl.value || '';
  }

  function fillHlValues() {
    fillHlSelect('hlKind', 'hlValue', state.hl);
    fillHlSelect('hlKind2', 'hlValue2', state.hl2);
  }

  // Снять выделение по обоим параметрам: кнопка «Сбросить» и смена типа
  // представления (группа/преподаватель/аудитория/дисциплина).
  function resetHighlights() {
    for (const hl of [state.hl, state.hl2]) { hl.kind = ''; hl.value = ''; }
    fillHlValues();
    applyHighlights();
  }

  function applyHighlights() {
    // Активных параметров может быть от нуля до двух. Два сочетаются «И», а с
    // галочкой «Любое из двух» — «ИЛИ».
    const active = [state.hl, state.hl2].filter((h) => h.kind && h.value);
    const cards = document.querySelectorAll('#gridWrap .lesson[data-lesson]');
    const statsTableWrap = document.getElementById('disciplineStatsWrap');
    if (statsTableWrap) {
      statsTableWrap.style.display = 'none';
      statsTableWrap.innerHTML = '';
    }
    // Метка для печати: с выделением заливки нужны (в них весь смысл), без него
    // печатаем без цвета — см. css/print.css.
    document.body.classList.toggle('has-hl', active.length > 0);
    saveView(); // выделение меняют без перерисовки сетки — запоминаем здесь

    if (!active.length) {
      cards.forEach((c) => c.classList.remove('hl', 'hl-dim', 'hl-b', 'hl-ab'));
      return;
    }

    const matchingLessons = [];
    // Статистику по темам показываем, если дисциплину выделили любым из двух.
    const subjectHl = active.find((h) => h.kind === 'subject');

    cards.forEach((c) => {
      try {
        const l = JSON.parse(c.dataset.lesson);
        const hits = active.map((h) => hlValuesOf(l, h.kind).includes(h.value));
        const matches = state.hlAny ? hits.some(Boolean) : hits.every(Boolean);
        c.classList.toggle('hl', matches);
        c.classList.toggle('hl-dim', !matches);
        // «Любое из двух»: первый параметр — цветом по умолчанию, второй и
        // пересечение — своими, иначе в режиме «ИЛИ» не видно, что чем нашлось.
        const two = state.hlAny && active.length === 2 && matches;
        c.classList.toggle('hl-ab', two && hits[0] && hits[1]);
        c.classList.toggle('hl-b', two && !hits[0] && hits[1]);
        if (matches && subjectHl) {
          matchingLessons.push(l);
        }
      } catch { /* ignore */ }
    });

    if (subjectHl && statsTableWrap) {
      renderDisciplineStats(matchingLessons, statsTableWrap);
      
      const semSummary = document.querySelector('.sem-summary');
      if (semSummary) {
        semSummary.parentNode.insertBefore(statsTableWrap, semSummary);
      } else {
        const gridWrap = document.getElementById('gridWrap');
        gridWrap.parentNode.insertBefore(statsTableWrap, gridWrap.nextSibling);
      }
    }
  }

  function renderDisciplineStats(lessons, container) {
    if (lessons.length === 0) return;
    
    const stats = {}; // topic -> { type -> count }
    const typesSet = new Set();

    lessons.forEach(l => {
      const topic = l.topic || 'Без темы';
      const type = l.type || 'Без типа';
      if (!stats[topic]) stats[topic] = {};
      stats[topic][type] = (stats[topic][type] || 0) + 1;
      typesSet.add(type);
    });

    const topics = Object.keys(stats).sort((a,b) => a.localeCompare(b, 'ru', { numeric: true }));
    const types = Array.from(typesSet).sort(compareTypes);

    let html = '<table class="stats-table" style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; margin-bottom: 1.5rem;">';
    html += '<thead><tr><th style="text-align:left;">Тема / Вид</th>';
    types.forEach(type => {
      html += `<th>${esc(type)}</th>`;
    });
    html += '<th>Итого</th></tr></thead><tbody>';

    topics.forEach(topic => {
      html += `<tr><td style="text-align:left; font-weight:bold;">${esc(topic)}</td>`;
      let rowTotal = 0;
      types.forEach(type => {
        const count = stats[topic][type] || 0;
        rowTotal += count;
        html += `<td>${count > 0 ? count : ''}</td>`;
      });
      html += `<td><strong>${rowTotal}</strong></td></tr>`;
    });

    html += '<tr><td style="text-align:left; font-weight:bold;">Итого</td>';
    let grandTotal = 0;
    types.forEach(type => {
      let colTotal = 0;
      topics.forEach(topic => {
        colTotal += (stats[topic][type] || 0);
      });
      grandTotal += colTotal;
      html += `<td><strong>${colTotal}</strong></td>`;
    });
    html += `<td><strong>${grandTotal}</strong></td></tr>`;

    html += '</tbody></table>';
    // Дисциплина могла быть выбрана как первым, так и вторым параметром.
    const subjHl = [state.hl, state.hl2].find((h) => h.kind === 'subject' && h.value);
    container.innerHTML = '<h3 style="margin-top:0; margin-bottom:10px; font-size:16px;">Статистика по темам: ' + esc(subjHl ? subjHl.value : '') + '</h3>' + html;
    container.style.display = 'block';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
