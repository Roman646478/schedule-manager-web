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

  function printQuality() {
    const api = window.VivliostyleCore;
    if (!api || typeof api.printHTML !== 'function') {
      notify('Модуль качественной печати не загрузился', true);
      return;
    }
    const button = $('btnQualityPrint');
    try {
      if (button) { button.disabled = true; button.textContent = 'Готовлю страницы…'; }
      api.printHTML(buildDocument(), {
        title: 'Расписание',
        hideIframe: true,
        removeIframe: true,
        printCallback: (frameWindow) => {
          if (button) { button.disabled = false; button.textContent = '🖨 Качественная печать'; }
          frameWindow.focus();
          frameWindow.print();
        },
        errorCallback: (message) => {
          if (button) { button.disabled = false; button.textContent = '🖨 Качественная печать'; }
          notify(`Не удалось подготовить печать: ${message}`, true);
        },
      });
    } catch (err) {
      if (button) { button.disabled = false; button.textContent = '🖨 Качественная печать'; }
      notify(err.message || 'Не удалось подготовить печать', true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const button = $('btnQualityPrint');
    if (button) button.addEventListener('click', printQuality);
  });

  window.QualityPrint = { buildDocument, print: printQuality };
}());
