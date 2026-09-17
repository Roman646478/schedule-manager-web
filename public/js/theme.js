// Тема оформления: переключение класса .dark на <html> (см. .claude-rules.md §3).
(function () {
  'use strict';

  const STORAGE_KEY = 'theme';

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolveInitial() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function apply(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const btn = document.querySelector('[data-theme-toggle]');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function toggle() {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  // Применяем тему как можно раньше, чтобы не было «вспышки».
  apply(resolveInitial());

  // Тёмная тема на бумаге — залитый чёрным лист (в печати заливки включены
  // намеренно: цвет ячеек несёт смысл). На время печати возвращаем светлую
  // палитру. Через события печати, а не через кнопку, — чтобы работал и Ctrl+P.
  let wasDark = false;
  window.addEventListener('beforeprint', function () {
    wasDark = document.documentElement.classList.contains('dark');
    if (wasDark) document.documentElement.classList.remove('dark');
  });
  window.addEventListener('afterprint', function () {
    if (wasDark) document.documentElement.classList.add('dark');
  });

  document.addEventListener('DOMContentLoaded', function () {
    apply(resolveInitial());
    const btn = document.querySelector('[data-theme-toggle]');
    if (btn) btn.addEventListener('click', toggle);
  });

  window.__theme = { toggle: toggle, apply: apply };
})();
