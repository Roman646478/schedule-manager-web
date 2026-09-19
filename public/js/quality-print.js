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
    clone.querySelectorAll('button, input, select, textarea, [hidden], .print-hide').forEach((el) => el.remove());
    clone.querySelectorAll('[contenteditable], [draggable], [data-lesson]').forEach((el) => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('draggable');
      el.removeAttribute('data-lesson');
    });
    return clone.innerHTML;
  }

  function buildDocument() {
    const titleEl = $('gridTitle') || $('title');
    const title = (titleEl && titleEl.textContent.trim()) || 'Расписание';
    const base = `${location.origin}/`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
      <base href="${escapeHtml(base)}"><title>${escapeHtml(title)}</title>
      <link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/styles.css">
      <style>
        @page { size: A4 landscape; margin: 8mm 7mm 10mm; @bottom-center { content: counter(page) " / " counter(pages); font: 8pt Arial, sans-serif; color: #64748b; } }
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
    button.textContent = '🖨 Качественная печать';
  }

  // Запасная печать остаётся настоящей HTML-печатью: текст и границы идут в
  // PDF/принтер вектором. Отдельный iframe нужен, чтобы не печатать панели
  // страницы и не ужимать всю сетку старым режимом «в один лист».
  function printWithBrowser(html, button) {
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

  function printQuality() {
    const api = window.VivliostyleCore;
    const button = $('btnQualityPrint');
    if (button && button.disabled) return;
    try {
      if (button) { button.disabled = true; button.textContent = 'Готовлю страницы…'; }
      const html = buildDocument();
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

  document.addEventListener('DOMContentLoaded', () => {
    const button = $('btnQualityPrint');
    if (button) button.addEventListener('click', printQuality);
  });

  window.QualityPrint = { buildDocument, print: printQuality };
}());
