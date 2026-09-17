'use strict';

// Генерация самоподписанного TLS-сертификата для работы по HTTPS в локальной
// сети (офлайн, без внешних центров сертификации). Использует системный openssl.
// Использование:
//   npm run gen-cert            — в data/tls/{key,cert}.pem, SAN = localhost + все LAN-IP
//   node scripts/generate-cert.js --days 825
//
// После генерации перезапустите сервер — он сам поднимется по HTTPS.
// Сертификат самоподписанный: браузер один раз покажет предупреждение —
// это ожидаемо для LAN. HSTS при этом НЕ включайте.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { TLS_KEY_PATH, TLS_CERT_PATH } = require('../src/utils/constants');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Проверяем наличие openssl.
try {
  execFileSync('openssl', ['version'], { stdio: 'pipe' });
} catch {
  console.error(
    'openssl не найден в PATH. Установите OpenSSL (в Git for Windows он есть в Git Bash)\n' +
      'или сгенерируйте key.pem/cert.pem на другой машине и положите в data/tls/.'
  );
  process.exit(1);
}

// Собираем SAN: localhost, петлевые адреса и все IPv4 локальной сети.
const ips = new Set(['127.0.0.1', '::1']);
for (const ifaces of Object.values(os.networkInterfaces())) {
  for (const i of ifaces || []) if (i.family === 'IPv4') ips.add(i.address);
}
const altNames = ['DNS:localhost', `DNS:${os.hostname()}`, ...[...ips].map((ip) => `IP:${ip}`)];

const days = String(parseInt(arg('days', '825'), 10) || 825);
const dir = path.dirname(TLS_KEY_PATH);
fs.mkdirSync(dir, { recursive: true });

// Временный конфиг с SAN — переносимее, чем -addext (работает и на старых openssl).
const cnfPath = path.join(dir, 'openssl-san.cnf');
fs.writeFileSync(
  cnfPath,
  [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3',
    'prompt = no',
    '[dn]',
    'CN = schedule-manager',
    '[v3]',
    'subjectAltName = ' + altNames.join(','),
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    '',
  ].join('\n')
);

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', TLS_KEY_PATH,
      '-out', TLS_CERT_PATH,
      '-days', days,
      '-config', cnfPath,
    ],
    { stdio: 'pipe' }
  );
  // Приватный ключ — только владельцу (на Windows влияния меньше, но не мешает).
  try { fs.chmodSync(TLS_KEY_PATH, 0o600); } catch { /* нефатально */ }
  console.log('Сертификат создан:');
  console.log('  ключ:        ' + TLS_KEY_PATH);
  console.log('  сертификат:  ' + TLS_CERT_PATH);
  console.log('  действует:   ' + days + ' дней');
  console.log('  SAN:         ' + altNames.join(', '));
  console.log('\nПерезапустите сервер (npm start) — он поднимется по HTTPS.');
} catch (err) {
  console.error('Не удалось сгенерировать сертификат:\n' + (err.stderr ? err.stderr.toString() : err.message));
  process.exit(1);
} finally {
  fs.rmSync(cnfPath, { force: true });
}
