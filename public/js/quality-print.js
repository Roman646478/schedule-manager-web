(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function printableContent() {
    const grid = $('gridWrap') || $('grid');
    if (!grid || !grid.querySelector('table')) throw new Error('Сначала откройте расписание');
    const clone = grid.cloneNode(true);
    clone.removeAttribute('id');
    const showTeachers = !$('sumTeacherToggle') || $('sumTeacherToggle').checked;
    clone.querySelectorAll('.lesson[data-lesson]').forEach(card => {
      try {
        const lesson = JSON.parse(card.dataset.lesson);
        const names = [...new Set((lesson.teachers?.length ? lesson.teachers : [lesson.teacher]).filter(Boolean))];
        const teacherTexts = new Set([...names, names.join(', '), names.join('; ')]);
        card.querySelectorAll('div').forEach(line => {
          if (!line.querySelector('div') && names.length && teacherTexts.has(line.textContent.trim())) {
            if (!showTeachers) line.remove();
            else line.classList.add('print-teacher');
          }
        });
      } catch { /* карточка без данных */ }
    });
    clone.querySelectorAll('button, input, select, textarea, [hidden], .print-hide').forEach((el) => el.remove());
    clone.querySelectorAll('[contenteditable], [draggable], [data-lesson]').forEach((el) => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('draggable');
      el.removeAttribute('data-lesson');
    });
    return clone.innerHTML;
  }

  function buildDocument(options = {}) {
    const titleEl = $('gridTitle') || $('title');
    const title = (titleEl && titleEl.textContent.trim()) || 'Расписание';
    const base = `${location.origin}/`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
      <base href="${escapeHtml(base)}"><title>${escapeHtml(title)}</title>
      <link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/styles.css">
      <style>
        @page { size: A4 ${options.orientation === 'portrait' ? 'portrait' : 'landscape'}; margin: 2mm; @bottom-center { content: counter(page) " / " counter(pages); font: 8pt Arial, sans-serif; color: #64748b; } }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff !important; color: #111827 !important; font-family: Arial, sans-serif; }
        h1 { margin: 0 0 5mm; text-align: center; font-size: 15pt; line-height: 1.2; }
        .quality-print { width: 100%; }
        .table-wrap, .semester-wrap, #gridWrap, #grid { overflow: visible !important; max-height: none !important; }
        table { width: 100% !important; border-collapse: collapse !important; table-layout: fixed; break-inside: auto; }
        thead { display: table-header-group; }
        tfoot { display: table-footer-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        th, td { border: .25mm solid #64748b !important; padding: 1.2mm !important; min-width: 0 !important; height: auto !important; font-size: 7.5pt !important; line-height: 1.18 !important; color: #111827 !important; }
        th { background: #e8eef6 !important; font-weight: 700; }
        .lesson { min-height: 0 !important; padding: 1mm !important; border-radius: 1mm !important; font-size: 7.5pt !important; break-inside: avoid; }
        .lesson, .lesson * { color: #111827 !important; }
        th, td, .lesson, .lesson * { white-space: nowrap; overflow-wrap: normal; word-break: normal; }
        .print-teacher { white-space: normal !important; }
        .muted-hint, .meta { color: #334155 !important; }
        .errors-panel, .orphan-panel, .drag-handle, .cell-actions { display: none !important; }
      </style></head><body><main class="quality-print"><h1>${escapeHtml(title)}</h1>${printableContent()}</main></body></html>`;
  }

  function notify(message, isError) {
    const toast = $('toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.toggle('error', Boolean(isError));
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3500);
    } else if (isError) alert(message);
  }

  function resetButton(button) {
    if (!button) return;
    button.disabled = false;
    button.textContent = '🖨 Печать';
  }

  // Запасная печать остаётся настоящей HTML-печатью: текст и границы идут в
  // PDF/принтер вектором. Отдельный iframe нужен, чтобы не печатать панели
  // страницы и не ужимать всю сетку старым режимом «в один лист».
  function printWithBrowser(html, button, prepare) {
    const frame = document.createElement('iframe');
    frame.title = 'Подготовка печати расписания';
    frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1122px;height:794px;border:0';
    frame.onload = async () => {
      frame.onload = null;
      try {
        if (frame.contentDocument && frame.contentDocument.fonts) await Promise.race([
          frame.contentDocument.fonts.ready,
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]);
        if (prepare) prepare(frame.contentDocument);
        resetButton(button);
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (err) {
        resetButton(button);
        notify(`Не удалось открыть печать: ${err.message}`, true);
      }
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  }

  function printQuality(options) {
    const api = window.VivliostyleCore;
    const button = $('btnQualityPrint');
    if (button && button.disabled) return;
    try {
      if (button) { button.disabled = true; button.textContent = 'Готовлю страницы…'; }
      if (options && (options.mode === 'one' || options.mode === 'grid')) {
        const config = normalizeOptions(options);
        printWithBrowser(buildSheets(config), button, doc => fitSheets(doc, config));
        return;
      }
      const html = buildDocument(options || {});
      if (!api || typeof api.printHTML !== 'function') {
        printWithBrowser(html, button);
        return;
      }
      const oldFrames = new Set(document.querySelectorAll('iframe'));
      let finished = false;
      let engineFrame;
      const fallback = (message) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (engineFrame) engineFrame.remove();
        notify(message, false);
        printWithBrowser(html, button);
      };
      const watchdog = setTimeout(
        () => fallback('Подготовка заняла слишком много времени — открываю печать браузера'),
        15000
      );
      try { api.printHTML(html, {
        title: 'Расписание',
        hideIframe: true,
        removeIframe: false,
        printCallback: (frameWindow) => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          resetButton(button);
          try {
            frameWindow.focus();
            frameWindow.print();
          } catch (err) {
            notify(`Не удалось открыть печать: ${err.message}`, true);
          } finally {
            // Фрейм сохраняется после вызова print: некоторые браузеры
            // открывают системный диалог асинхронно.
            setTimeout(() => { if (engineFrame) engineFrame.remove(); }, 60000);
          }
        },
        errorCallback: (message) => {
          clearTimeout(watchdog);
          console.warn('Ошибка подготовки печати:', message);
          fallback('Открываю печать браузера');
        },
      });
      engineFrame = [...document.querySelectorAll('iframe')].find(frame => !oldFrames.has(frame));
      } catch (err) {
        engineFrame = [...document.querySelectorAll('iframe')].find(frame => !oldFrames.has(frame));
        console.warn('Ошибка подготовки печати:', err);
        fallback('Открываю печать браузера');
      }
    } catch (err) {
      resetButton(button);
      notify(err.message || 'Не удалось подготовить печать', true);
    }
  }

  function normalizeOptions(options) {
    options ||= {};
    const count = n => Math.min(10, Math.max(1, Math.floor(Number(n) || 1)));
    return {
      orientation: options.orientation === 'portrait' ? 'portrait' : 'landscape',
      mode: options.mode === 'grid' ? 'grid' : 'one',
      columns: options.mode === 'grid' ? count(options.columns) : 1,
      rows: options.mode === 'grid' ? count(options.rows) : 1,
    };
  }

  // Координаты объединённых ячеек: при разбиении повторяем пересекающую
  // границу ячейку, а не режем её текст или содержимое занятия.
  function tableModel(table) {
    const rows = [...table.rows];
    const matrix = [];
    const cells = [];
    rows.forEach((row, y) => {
      matrix[y] ||= [];
      let x = 0;
      for (const cell of row.cells) {
        while (matrix[y][x]) x++;
        const height = cell.rowSpan || rows.length - y;
        const info = { cell, x, y, right: x + cell.colSpan, bottom: Math.min(rows.length, y + height) };
        cells.push(info);
        for (let yy = y; yy < info.bottom; yy++) {
          matrix[yy] ||= [];
          for (let xx = x; xx < info.right; xx++) matrix[yy][xx] = info;
        }
        x = info.right;
      }
    });
    const width = Math.max(1, ...matrix.map(row => row.length));
    const headers = table.tHead ? table.tHead.rows.length : 0;
    const first = rows[0] ? [...rows[0].cells] : [];
    const repeat = Math.min(width - 1, first[0]?.classList.contains('day-col') && first[1]?.classList.contains('pair-col') ? 2 : 1);
    return { cells, width, height: rows.length, headers, repeat, className: table.className };
  }

  function tablePart(model, rowStart, rowEnd, colStart, colEnd) {
    const table = document.createElement('table');
    table.className = model.className || '';
    const rowGroups = [];
    if (model.headers) rowGroups.push([0, model.headers, 'thead']);
    if (rowEnd > rowStart) rowGroups.push([rowStart, rowEnd, 'tbody']);
    for (const [start, end, tag] of rowGroups) {
      const group = document.createElement(tag);
      for (let y = start; y < end; y++) {
        const row = document.createElement('tr');
        // Служебные столбцы повторяются на каждом горизонтальном листе.
        for (const [left, right] of [[0, model.repeat], [colStart, colEnd]]) {
          for (const item of model.cells) {
            if (item.bottom <= start || item.y >= end || Math.max(item.y, start) !== y || item.right <= left || item.x >= right) continue;
            const cell = item.cell.cloneNode(true);
            cell.rowSpan = Math.min(item.bottom, end) - Math.max(item.y, start);
            cell.colSpan = Math.min(item.right, right) - Math.max(item.x, left);
            row.appendChild(cell);
          }
        }
        group.appendChild(row);
      }
      table.appendChild(group);
    }
    return table;
  }

  function buildSheets(options) {
    const config = normalizeOptions(options);
    const source = document.createElement('div');
    source.innerHTML = printableContent();
    // Размеры экранной сетки и обрезание текста не должны попадать на бумагу.
    source.querySelectorAll('*').forEach(el => {
      el.removeAttribute('style');
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.removeAttribute('id');
    });
    const models = [...source.querySelectorAll('table')].filter(table => !table.parentElement.closest('table')).map(tableModel);
    const totalRows = models.reduce((n, m) => n + m.height - m.headers, 0);
    if (!totalRows) throw new Error('В расписании нет строк для печати');
    const pageRows = Math.ceil(totalRows / config.rows);
    const title = ($('gridTitle') || $('title'))?.textContent.trim() || 'Расписание';
    const sheets = [];
    for (let y = 0; y < config.rows; y++) {
      for (let x = 0; x < config.columns; x++) {
        const content = document.createElement('div');
        content.className = 'sheet-content';
        let offset = 0;
        for (const model of models) {
          const rowStart = Math.max(0, y * pageRows - offset);
          const rowEnd = Math.min(model.height - model.headers, (y + 1) * pageRows - offset);
          const columns = Math.ceil((model.width - model.repeat) / config.columns);
          const colStart = model.repeat + x * columns;
          const colEnd = Math.min(model.width, colStart + columns);
          if (rowEnd > rowStart && colEnd > colStart) content.appendChild(tablePart(model, rowStart + model.headers, rowEnd + model.headers, colStart, colEnd));
          offset += model.height - model.headers;
        }
        if (content.childElementCount) sheets.push(`<section class="print-sheet"><h1>${escapeHtml(title)}</h1><div class="sheet-viewport">${content.outerHTML}</div><footer>Ряд ${y + 1}, столбец ${x + 1}</footer></section>`);
      }
    }
    const width = config.orientation === 'portrait' ? 206 : 293;
    const height = config.orientation === 'portrait' ? 293 : 206;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page { size: A4 ${config.orientation}; margin: 2mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: white; color: black; font: 10pt Arial, sans-serif; }
      .print-sheet { width: ${width}mm; height: ${height}mm; overflow: hidden; break-after: page; page-break-after: always; display: flex; flex-direction: column; }
      .print-sheet:last-child { break-after: auto; page-break-after: auto; }
      h1 { flex: none; margin: 0 0 1mm; font-size: 12pt; line-height: 1.1; white-space: nowrap; }
      .sheet-viewport { flex: 1; min-height: 0; overflow: hidden; position: relative; }
      .sheet-content { position: absolute; left: 0; top: 0; width: max-content; transform-origin: top left; }
      table { border-collapse: collapse; margin: 0 0 1mm; width: max-content; }
      th, td { border: 0.2mm solid #555; padding: 0.5mm; text-align: center; vertical-align: middle; white-space: normal; overflow-wrap: anywhere; word-break: normal; }
      th { background: #e8eef6; }
      td *, th * { white-space: normal; overflow-wrap: anywhere; word-break: normal; }
      .day-col, .pair-col { white-space: nowrap; overflow-wrap: normal; }
      .lesson { padding: 0.3mm; font-size: 10pt; line-height: 1.15; text-align: center; align-items: center; justify-content: center; }
      table.gsum { table-layout: fixed; }
      table.gsum .grp-head, table.gsum td.slot { width: 23mm; min-width: 23mm; max-width: 23mm; }
      table.gsum .grp-head { font-size: 10pt; }
      table.gsum .lesson { font-size: 10pt; }
      .lesson + .lesson { border-top: 0.2mm dotted #aaa; margin-top: 0.5mm; }
      .subj, .l2 { font-weight: bold; }
      .print-teacher, .print-teacher * { white-space: normal; max-width: 160px; overflow-wrap: anywhere; }
      footer { flex: none; margin-top: 0.5mm; font-size: 7pt; line-height: 1; text-align: right; }
      [hidden], button, input { display: none !important; }
    </style></head><body>${sheets.join('')}</body></html>`;
  }

  function fitSheets(doc) {
    const sheets = [...doc.querySelectorAll('.print-sheet')];
    for (const sheet of sheets) {
      const title = sheet.querySelector('h1');
      if (title.scrollWidth > title.clientWidth) title.style.fontSize = `${12 * title.clientWidth / title.scrollWidth}pt`;
      const viewport = sheet.querySelector('.sheet-viewport');
      const content = sheet.querySelector('.sheet-content');
      const tables = [...content.querySelectorAll(':scope > table')];
      const subjects = tables.find(table => table.classList.contains('subjects-table'));
      const schedule = tables.find(table => table !== subjects && !table.classList.contains('summary-table'));
      if (schedule && subjects) {
        const commonWidth = Math.max(schedule.scrollWidth, subjects.scrollWidth);
        schedule.style.width = `${commonWidth}px`;
        subjects.style.width = `${commonWidth}px`;
      }
      const scale = Math.min(
        (viewport.clientWidth - 2) / content.scrollWidth,
        (viewport.clientHeight - 2) / content.scrollHeight
      );
      // Если ширина ограничивает масштаб, свободную высоту отдаём строкам
      // таблиц. Текст сохраняет пропорции, а сетка занимает лист донизу.
      const targetHeight = (viewport.clientHeight - 2) / scale;
      const extraHeight = targetHeight - content.scrollHeight;
      if (extraHeight > 1 && tables.length) {
        const total = tables.reduce((sum, table) => sum + table.offsetHeight, 0) || 1;
        for (const table of tables) {
          table.style.height = `${table.offsetHeight + extraHeight * table.offsetHeight / total}px`;
        }
      }
      content.style.transform = `scale(${scale})`;
      sheet.dataset.scale = String(scale);
    }
  }

  function showSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('schedulePrintSettings') || '{}'); } catch { /* настройки по умолчанию */ }
    const config = normalizeOptions(saved);
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:460px;max-width:95vw;padding:24px;border:1px solid #94a3b8;border-radius:12px';
    dialog.innerHTML = `<form method="dialog"><h2>Настройки печати</h2>
      <label>Ориентация листа<select name="orientation"><option value="landscape">Альбомная</option><option value="portrait">Книжная</option></select></label>
      <label>Размещение<select name="mode"><option value="one">Всё расписание на одном листе</option><option value="grid">Задать число листов</option></select></label>
      <div class="sheet-counts" style="display:flex;gap:12px;margin:12px 0">
        <label>По ширине<input name="columns" type="number" min="1" max="10" step="1" required></label>
        <label>По высоте<input name="rows" type="number" min="1" max="10" step="1" required></label>
      </div>
      <p class="print-teacher-hint"></p>
      <p>Перенос строк разрешён только для ФИО преподавателя. Шрифт автоматически уменьшается до размещения на выбранных листах. Заголовки таблицы повторяются.</p>
      <p>В окне принтера оставьте масштаб 100% и отключите колонтитулы браузера. При большом расписании на одном листе текст может стать очень мелким.</p>
      <div style="display:flex;gap:12px;justify-content:flex-end"><button type="button" class="btn secondary" data-cancel>Отмена</button><button class="btn" type="submit">Печать / PDF</button></div></form>`;
    const form = dialog.querySelector('form');
    for (const key of ['orientation', 'mode', 'columns', 'rows']) form.elements.namedItem(key).value = config[key];
    const sync = () => {
      const one = form.elements.namedItem('mode').value === 'one';
      for (const key of ['columns', 'rows']) form.elements.namedItem(key).disabled = one;
    };
    form.elements.namedItem('mode').onchange = sync;
    sync();
    dialog.querySelector('.print-teacher-hint').textContent = `Преподаватели: ${!$('sumTeacherToggle') || $('sumTeacherToggle').checked ? 'показывать' : 'скрывать'} (как задано тумблером в сетке).`;
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    form.onsubmit = event => {
      event.preventDefault();
      const options = normalizeOptions(Object.fromEntries(new FormData(form)));
      try { localStorage.setItem('schedulePrintSettings', JSON.stringify(options)); } catch { /* хранилище недоступно */ }
      dialog.close();
      printQuality(options);
    };
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const button = $('btnQualityPrint');
    if (button) button.addEventListener('click', showSettings);
  });

  window.QualityPrint = { buildDocument, print: printQuality, showSettings, buildSheets, fitSheets };
}());
