'use strict';

// SessionStart-хук: печатает все правила и уроки из rules/ в stdout. Харнесс
// добавляет вывод в контекст модели в начале каждой сессии.
// Подключён в .claude/settings.json (hooks.SessionStart).
//
// ponytail: печатаем файлы целиком. Если уроков станет много и контекст начнёт
// раздуваться — перейти на дайджест (печатать только заголовки lessons/).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'rules');

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

if (!fs.existsSync(root)) process.exit(0);
const files = walk(root).sort();
if (!files.length) process.exit(0);

let buf = '# Правила проекта (rules/) — учитывай при работе в этом репозитории\n';
for (const f of files) {
  buf += `\n===== ${path.relative(root, f).replace(/\\/g, '/')} =====\n`;
  buf += fs.readFileSync(f, 'utf8').trim() + '\n';
}
process.stdout.write(buf);
