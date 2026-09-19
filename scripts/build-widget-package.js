'use strict';

// Полный комплект для переноса в локальную сеть без доступа к интернету.
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { buildWidgetPackage } = require('../src/services/widgetPackageService');

async function main() {
  const address = new URL(process.argv[2] || 'http://127.0.0.1:443');
  const result = await buildWidgetPackage({ host: address.host, protocol: address.protocol.slice(0, -1) });
  const zip = await JSZip.loadAsync(result.buffer);
  if (!zip.file('виджет.exe')) throw new Error('EXE не собран: полный комплект не создан');
  for (const arch of ['X64', 'X86']) {
    const name = `MicrosoftEdgeWebView2RuntimeInstaller${arch}.exe`;
    const file = path.join(__dirname, '../vendor/webview2-runtime', name);
    if (!fs.existsSync(file)) throw new Error(`Не найден офлайн-установщик ${name}`);
    zip.file(`runtime/${name}`, fs.readFileSync(file));
  }
  const output = path.join(__dirname, '../dist/Виджет-Windows10-полный.zip');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(output);
    writer.on('finish', resolve).on('error', reject);
    zip.generateNodeStream({ streamFiles: true }).on('error', reject).pipe(writer);
  });
  console.log(`Комплект готов: ${output}`);
  console.log(`Сервер: ${result.target.scheme}://${result.target.srv}:${result.target.port}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
