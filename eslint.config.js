'use strict';

// Flat-конфиг ESLint 9 без внешних плагинов.
// Запуск: npm run lint

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  URL: 'readonly',
  // Веб-стандартные глобалы, доступные в Node 22 (см. engines.node в package.json).
  TextDecoder: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'writable',
  fetch: 'readonly',
  FormData: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  MutationObserver: 'readonly',
  self: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  CSS: 'readonly',
  Event: 'readonly',
};

const baseRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  eqeqeq: ['warn', 'smart'],
  'no-var': 'error',
  'prefer-const': 'warn',
  'no-console': 'off',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'claude-memory-compiler/**', 'примеры/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: baseRules,
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...browserGlobals, api: 'readonly', SCHED_CONST: 'readonly', module: 'readonly', XLSX: 'readonly', parseCurriculum: 'readonly' },
    },
    rules: baseRules,
  },
];
