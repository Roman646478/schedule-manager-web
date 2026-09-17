'use strict';

const { execFile } = require('child_process');

// Нативные окна выбора файла/папки (WinForms через PowerShell).
//
// Скрипт передаётся через -EncodedCommand (base64 UTF-16LE): так он уезжает в
// PowerShell одним аргументом, минуя разбор командной строки cmd.exe. Иначе
// приходится экранировать кавычки, «|» в фильтре («*.xlsx|*.xlsx») и кириллицу
// в заголовках — а многострочный скрипт ещё и склеивался в одну строку без
// разделителей, из-за чего присваивания не выполнялись и диалог не открывался.
//
// Возвращает: путь — выбран; null — пользователь нажал «Отмена». Если сам
// PowerShell упал, бросает ошибку с текстом: молчаливый null здесь неотличим от
// отмены, и вызывающий код показывал бы «отменено» на реальной поломке.
function runPowerShell(script) {
  // Судим об успехе ТОЛЬКО по коду возврата: в stderr PowerShell пишет ещё и
  // служебный прогресс («Подготовка модулей…») в виде CLIXML, и принимать его за
  // ошибку нельзя. Поэтому скрипт оборачивается в try/catch с явным `exit 2`, а
  // ErrorActionPreference делает любую ошибку прерывающей.
  // Вывод читаем как UTF-8 — в пути бывает кириллица («D:\Рабочий стол\…»).
  const full = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    script,
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }',
  ].join('\n');
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-EncodedCommand', encoded], // -STA: окнам нужен однопоточный апартамент
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`Не удалось открыть окно выбора: ${cleanStderr(stderr) || error.message}`));
        const out = String(stdout || '').trim();
        resolve(out || null); // пусто = «Отмена» в диалоге
      }
    );
  });
}

// Убирает из stderr CLIXML-обёртку прогресса, оставляя человеческий текст ошибки.
function cleanStderr(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('#< CLIXML') && !line.trim().startsWith('<Objs'))
    .join(' ')
    .trim();
}

// Одинарные кавычки в PowerShell-строке экранируются удвоением.
const q = (s) => `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;

async function showOpenFileDialog(title, filter) {
  return runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = ${q(title)}
$d.Filter = ${q(filter)}
if ($d.ShowDialog($form) -eq 'OK') { Write-Output $d.FileName }
`);
}

async function showSaveFileDialog(title, filter, defaultName) {
  return runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = ${q(title)}
$d.Filter = ${q(filter)}
$d.FileName = ${q(defaultName)}
$d.OverwritePrompt = $true
if ($d.ShowDialog($form) -eq 'OK') { Write-Output $d.FileName }
`);
}

async function showFolderBrowserDialog(title) {
  return runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = ${q(title)}
if ($d.ShowDialog($form) -eq 'OK') { Write-Output $d.SelectedPath }
`);
}

module.exports = { runPowerShell, showOpenFileDialog, showSaveFileDialog, showFolderBrowserDialog };
