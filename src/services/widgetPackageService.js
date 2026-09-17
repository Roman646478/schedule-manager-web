'use strict';

// Архив с виджетом на рабочий стол: посетитель скачивает его с гостевой
// страницы и запускает у себя. Адрес сервера подставляется здесь — тот, по
// которому посетитель к нам и пришёл, либо заданный вручную в настройках.
// Так на чужом ПК ничего править не нужно: распаковал и запустил.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const builds = new Map();
let lastBuildAt = 0;
const JSZip = require('jszip');
const { getSetting } = require('./settingsService');
const { TLS_CERT_PATH, DB_PATH } = require('../utils/constants');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'widget-window.ps1');
// Офлайн-установщик движка WebView2. Нужен там, где его нет в системе (Windows
// 10 без обновлений Edge) и нет интернета, чтобы взять его у Microsoft: файл
// раздаёт сам сервер расписания, до которого у виджета доступ по определению
// есть. Нет файла в сборке — в архив просто не кладём .bat, который его тянет.
const WEBVIEW2_INSTALLER = path.join(
  __dirname, '..', '..', 'vendor', 'webview2-runtime', 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe',
);
const EXE_SOURCE = path.join(__dirname, '..', '..', 'native', 'WidgetHost.cs');
const EXE_BUILD = path.join(__dirname, '..', '..', 'scripts', 'build-widget-exe.ps1');
// Готовые exe кладём рядом с базой: пересобирать один и тот же файл на каждое
// скачивание незачем, а адрес и отпечаток внутри у каждого сервера свои.
const EXE_CACHE = path.join(path.dirname(DB_PATH), 'cache');

// Адрес, который попадёт в .bat. Ручная настройка (settings.widgetHost) сильнее
// автоопределения: гость мог прийти по имени, которое на другом ПК не
// разрешается, или через промежуточный сервер.
function resolveTarget({ host, protocol, manual }) {
  const source = String(manual || '').trim() || String(host || '').trim();
  if (!source) return null;

  // В настройке допускаем и полный адрес со схемой, и просто «хост:порт».
  const withScheme = /^https?:\/\//i.test(source) ? source : `${protocol}://${source}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '');
  if (!['http', 'https'].includes(scheme) || url.username || url.password || !/^[a-z0-9.:[\]-]+$/i.test(url.hostname)) return null;
  const port = url.port || (scheme === 'https' ? '443' : '80');
  return { srv: url.hostname, port, scheme };
}

// Файлы архива — UTF-8: их открывают Блокнотом (посмотреть адрес, поправить
// порт), а CP866 показывается там кракозябрами. Тонкость в BOM:
//   * .txt — с BOM, так его правильно поймёт любой редактор;
//   * .bat — БЕЗ BOM: cmd не распознаёт его и спотыкается на первой же строке
//     («"@echo" не является внутренней или внешней командой»), поэтому кириллицу
//     обеспечивает не BOM, а переключение консоли (chcp 65001).
function withBom(text) {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
}

// Отпечаток открытого ключа нашего сертификата (base64 от SHA-256 SubjectPublicKeyInfo)
// — то, что понимает ключ браузера --ignore-certificate-errors-spki-list. Нужен
// потому, что общее «не проверять сертификаты» на рабочих машинах могут запретить
// политиками, а доверие конкретному ключу продолжает работать. Нет сертификата
// (сервер по HTTP) — нет и отпечатка.
function certPin(certPath = TLS_CERT_PATH) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(spki).digest('base64');
  } catch {
    return null;
  }
}

// Ссылка, которую открывает виджет: сводное расписание на сегодня.
function widgetUrl({ srv, port, scheme }) {
  return `${scheme}://${srv}:${port}/weekly.html?widget=1&mode=day&week=cur`;
}

// Собирает виджет-программу штатным csc.exe из Windows, вшивая внутрь адрес
// сервера и отпечаток сертификата. Файл кэшируется: ключ — адрес, отпечаток и
// время правки исходника, поэтому после обновления кода соберётся заново.
// Не Windows, нет исходника, не собралось — возвращаем null: архив тогда
// уедет с браузерным виджетом, он остаётся запасным вариантом.
async function buildWidgetExe(target, pin) {
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(EXE_SOURCE) || !fs.existsSync(EXE_BUILD)) return null;
  const url = widgetUrl(target);
  const stamp = `${fs.statSync(EXE_SOURCE).mtimeMs}:${fs.statSync(EXE_BUILD).mtimeMs}`;
  const key = crypto.createHash('sha1').update([url, pin || '', stamp].join('|')).digest('hex').slice(0, 12);
  const out = path.join(EXE_CACHE, `widget-${key}.exe`);
  if (fs.existsSync(out)) return out;
  if (builds.has(key)) return builds.get(key);
  // Unknown Host values cannot create unlimited simultaneous compiler jobs.
  if (builds.size || Date.now() - lastBuildAt < 30000) return null;
  lastBuildAt = Date.now();
  const job = (async () => {
  try {
    fs.mkdirSync(EXE_CACHE, { recursive: true });
    await execFileAsync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXE_BUILD,
      '-Url', url, '-SpkiHash', pin || '', '-Out', out,
    ], { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const old = fs.readdirSync(EXE_CACHE).filter(name => /^widget-[a-f0-9]{12}\.exe$/.test(name))
      .map(name => ({ name, time: fs.statSync(path.join(EXE_CACHE, name)).mtimeMs })).sort((a, b) => b.time - a.time);
    for (const item of old.slice(16)) fs.rmSync(path.join(EXE_CACHE, item.name), { force: true });
    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
  })();
  builds.set(key, job);
  try { return await job; } finally { builds.delete(key); }
}

function batText({ srv, port, scheme }, pin = null) {
  // HTTPS у сервера обычно с самоподписанным сертификатом: без -Insecure
  // браузер показал бы виджету страницу-заглушку вместо расписания.
  const insecure = scheme === 'https' ? ' -Insecure' : '';
  const spki = scheme === 'https' && pin ? ` -SpkiHash "${pin}"` : '';
  return [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'rem Окно-виджет расписания на рабочем столе.',
    'rem',
    'rem Адрес сервера уже прописан — тот, с которого скачан этот архив.',
    'rem Если сервер переедет, поправьте строки SRV и PORT ниже.',
    '',
    `if not defined SRV set SRV=${srv}`,
    `if not defined PORT set PORT=${port}`,
    `set "URL=${scheme}://%SRV%:%PORT%/weekly.html?widget=1&mode=day&week=cur"`,
    '',
    'rem Сервер виджет не запускает — только ждёт, пока тот ответит.',
    'set /a tries=0',
    ':wait',
    'powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect(\'%SRV%\', %PORT%); exit 0 } catch { exit 1 }" >nul 2>&1',
    'if not errorlevel 1 goto open',
    'timeout /t 2 /nobreak >nul',
    'set /a tries+=1',
    'if %tries% lss 15 goto wait',
    'echo Сервер %SRV%:%PORT% не отвечает. Проверьте, что он включён и виден по сети.',
    'pause',
    'exit /b 1',
    '',
    ':open',
    `start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\\widget-window.ps1" -Url "%URL%"${insecure}${spki}`,
    '',
  ].join('\r\n');
}

// Установка движка WebView2 с сервера расписания. curl.exe входит в Windows 10
// (с 1803) и 11, качать нечем больше и не нужно; -k — потому что сертификат
// сервера самоподписанный. Ставится в профиль пользователя, админ не нужен.
function engineBatText({ srv, port, scheme }) {
  const insecure = scheme === 'https' ? '-k ' : '';
  return [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'rem Движок WebView2 для виджет.exe — с сервера расписания, интернет не нужен.',
    'rem Нужен один раз на компьютер. Права администратора не требуются.',
    '',
    `if not defined SRV set SRV=${srv}`,
    `if not defined PORT set PORT=${port}`,
    `set "URL=${scheme}://%SRV%:%PORT%/api/webview2-installer"`,
    'set "SETUP=%TEMP%\\MicrosoftEdgeWebView2RuntimeInstaller.exe"',
    '',
    'echo Скачивание движка с %SRV%:%PORT% (около 200 МБ, может занять пару минут)...',
    `curl.exe ${insecure}-L --fail -o "%SETUP%" "%URL%"`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo Не удалось скачать движок с %SRV%:%PORT%.',
    '  echo Проверьте, что сервер расписания включён и виден по сети.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo Установка движка...',
    '"%SETUP%" /silent /install',
    'if errorlevel 1 (',
    '  echo.',
    '  echo Установка не удалась. Запустите файл вручную: %SETUP%',
    '  pause',
    '  exit /b 1',
    ')',
    'del "%SETUP%" >nul 2>&1',
    'echo.',
    'echo Готово. Запустите виджет.exe.',
    'pause',
    '',
  ].join('\r\n');
}

function readmeText({ srv, port, scheme }, hasExe = true, hasEngine = false) {
  const engineLines = hasEngine ? [
    '',
    'Пишет «Движок WebView2 не установлен»?',
    '  Запустите установить-движок.bat (лежит рядом): он возьмёт движок с',
    '  сервера расписания, интернет для этого не нужен. Ставится один раз на',
    '  компьютер, права администратора не требуются. Windows 11 и свежая',
    '  Windows 10 движок уже содержат — тогда этот файл не нужен вовсе.',
  ] : [];
  const exeLines = hasExe ? [
    '  Двойной клик по виджет.exe. Больше ничего не нужно: адрес сервера уже',
    '  внутри, устанавливать тоже нечего.',
    '  Windows может спросить про неизвестного издателя — «Подробнее», затем',
    '  «Выполнить в любом случае»: программа не подписана сертификатом.',
    '',
    'Запасной вариант — «виджет (через браузер).bat»: тот же виджет, но окном',
    'Chrome или Edge. Он выручает, если программу не пускает политика или',
    'антивирус; папку scripts из архива держите рядом с ним.',
    ...engineLines,
  ] : [
    '  Двойной клик по «виджет (через браузер).bat» (папка scripts должна',
    '  лежать рядом — иначе виджет не найдёт свой скрипт).',
  ];
  return [
    'Виджет расписания на рабочий стол',
    '=================================',
    '',
    'Что это. Окно с расписанием прямо на рабочем столе: фон сквозной или',
    'полупрозрачный, окно всегда под остальными, нет в панели задач и Alt+Tab.',
    'Показывает сводное расписание на сегодня.',
    '',
    'Как запустить.',
    ...exeLines,
    '',
    'Что нужно. Windows 10 или 11 и доступ к серверу расписания:',
    `  ${scheme}://${srv}:${port}`,
    'Сервер виджет не запускает — он должен уже работать.',
    '',
    'Кнопки в правом верхнем углу виджета:',
    '  ✎  показать или спрятать панель управления (вид, неделя, масштаб, фон,',
    '      оформление)',
    '  👻  сквозной режим: клики проходят виджет насквозь, рабочий стол и окна',
    '      под ним реагируют как обычно. Обратно — Ctrl+Alt+W',
    '  ✕  закрыть',
    '',
    'Окно перетаскивается за ручку ✥ рядом с этими кнопками, размер меняется',
    'за уголок ◢ в правом нижнем углу.',
    '',
    'Чтобы виджет открывался сам при входе в Windows — поставьте флажок',
    '«Автозапуск» в его панели (кнопка ✎). Снять — тем же флажком. Права',
    'администратора не нужны: запись делается только для вашего пользователя.',
    '',
    'Не получается закрыть мышью? Нажмите Ctrl+Alt+Shift+W — комбинация',
    'работает из любого окна и закрывает виджет, даже если он в сквозном',
    'режиме, оказался под чужим окном или страница перестала отвечать.',
    '',
    'Ругается «подключение не защищено»?',
    '  Сертификат сервера самоподписанный — для локальной сети это нормально,',
    '  но браузер о нём не знает. Запустите один раз доверять-сертификату.bat',
    '  (лежит рядом): он добавит сертификат в доверенные ЭТОГО пользователя.',
    '  Windows спросит подтверждение, это ожидаемо. После установки закройте и',
    '  откройте браузер заново — предупреждение уйдёт и на сайте расписания,',
    '  и в виджете. Прав администратора не нужно. Самой программе-виджету это',
    '  не требуется: отпечаток сертификата у неё уже внутри.',
    '',
    'Если сервер переехал — скачайте виджет заново со страницы расписания',
    '(в .bat-варианте можно поправить строки SRV и PORT блокнотом).',
    '',
  ].join('\r\n');
}

// Разовая установка сертификата сервера в доверенные у ЭТОГО пользователя.
// Лечит не только виджет: после неё браузер перестаёт ругаться и на сам сайт
// расписания. Хранилище пользовательское — прав администратора не нужно, но
// Windows спросит подтверждение, и это правильно: доверие добавляет человек.
function trustBatText({ srv }) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'rem Сертификат сервера расписания в доверенные этого пользователя.',
    'rem Нужен один раз на компьютер. Windows спросит подтверждение — это нормально.',
    '',
    `echo Сервер: ${srv}`,
    'echo Установка сертификата в доверенные (хранилище текущего пользователя)...',
    'certutil -addstore -user Root "сертификат-сервера.crt"',
    'if errorlevel 1 (',
    '  echo.',
    '  echo Не получилось. Установите вручную: двойной клик по сертификат-сервера.crt,',
    '  echo "Установить сертификат" - "Текущий пользователь" - "Поместить в хранилище"',
    '  echo - "Доверенные корневые центры сертификации".',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo Готово. Закройте и откройте браузер заново - предупреждение уйдёт.',
    'pause',
    '',
  ].join('\r\n');
}

async function buildWidgetPackage({ host, protocol }) {
  const target = resolveTarget({ host, protocol, manual: getSetting('widgetHost') });
  if (!target) {
    const err = new Error('Не удалось определить адрес сервера для виджета');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    const err = new Error('В сборке нет scripts/widget-window.ps1 — обновите её из папки разработки');
    err.status = 500;
    throw err;
  }

  const pin = certPin();
  const zip = new JSZip();
  // Главный файл — сама программа: скачал, запустил, забыл. Адрес сервера и
  // отпечаток сертификата уже внутри неё.
  const exe = await buildWidgetExe(target, pin);
  if (exe) zip.file('виджет.exe', fs.readFileSync(exe));
  // Браузерный виджет остаётся запасным: он не требует WebView2 и выручает,
  // если программу не пускает политика или антивирус.
  zip.file('виджет (через браузер).bat', Buffer.from(batText(target, pin), 'utf8'));
  // Движок ставится с сервера — сам установщик (200 МБ) в архив не кладём:
  // он нужен единицам, а качать его всем незачем.
  const hasEngine = !!exe && fs.existsSync(WEBVIEW2_INSTALLER);
  if (hasEngine) {
    zip.file('установить-движок.bat', Buffer.from(engineBatText(target), 'utf8'));
  }
  zip.file('ЧИТАЙ МЕНЯ.txt', withBom(readmeText(target, !!exe, hasEngine)));
  // Скрипт кладём как есть: он в UTF-8 с BOM, иначе PowerShell 5.1 читает его
  // как ANSI и ломает кириллические пути прямо в парсере.
  zip.file('scripts/widget-window.ps1', fs.readFileSync(SCRIPT_PATH));
  // Сертификат сервера кладём рядом: с ним предупреждение браузера снимается
  // насовсем, а не обходится ключом запуска. Только для HTTPS — по HTTP не о чем.
  if (target.scheme === 'https' && fs.existsSync(TLS_CERT_PATH)) {
    zip.file('сертификат-сервера.crt', fs.readFileSync(TLS_CERT_PATH));
    zip.file('доверять-сертификату.bat', Buffer.from(trustBatText(target), 'utf8'));
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, filename: 'Виджет расписания.zip', target };
}

module.exports = { buildWidgetPackage, resolveTarget, batText, certPin, trustBatText, widgetUrl, buildWidgetExe, engineBatText, WEBVIEW2_INSTALLER };
