'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'schedule-manager');

if (path.dirname(OUT) !== DIST || path.basename(OUT) !== 'schedule-manager') {
  throw new Error(`Небезопасный каталог сборки: ${OUT}`);
}

const entries = [
  'src',
  'public',
  'scripts/backup.ps1',
  'scripts/build-widget-exe.ps1',
  'scripts/generate-cert.js',
  'scripts/widget-shortcuts.ps1',
  'scripts/widget-window.ps1',
  'native',
  'vendor',
  'Еженедельное расписание/Образец.xlsx',
  'Расписание группы/Образец группа.xlsx',
  'package.json',
  'package-lock.json',
  '.env.example',
  'README.md',
  'виджет.bat',
  'запустить-сайт.bat',
  'установить-виджет.bat',
  'отключить-виджет.bat',
];

function copy(relative) {
  const source = path.join(ROOT, relative);
  if (!fs.existsSync(source)) throw new Error(`Не найден обязательный файл релиза: ${relative}`);
  const target = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (item) => !/public_db\.json(?:\.gz|\..*)?$/.test(path.basename(item)),
  });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of entries) copy(entry);

const files = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(OUT);
files.sort((a, b) => a.localeCompare(b, 'ru'));

const manifest = files.map((file) => {
  const data = fs.readFileSync(file);
  return {
    path: path.relative(OUT, file).replaceAll(path.sep, '/'),
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
});
fs.writeFileSync(
  path.join(OUT, 'release-manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, files: manifest }, null, 2)}\n`,
  'utf8'
);

console.log(`Релиз собран: ${OUT}`);
console.log(`Файлов: ${manifest.length}; размер: ${manifest.reduce((sum, item) => sum + item.bytes, 0)} байт`);
