'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTarget, batText, certPin, widgetUrl } = require('../../src/services/widgetPackageService.js');

// Адрес для виджета: обычно берётся тот, по которому гость открыл страницу.
test('resolveTarget: адрес и порт из запроса', () => {
  assert.deepEqual(resolveTarget({ host: '192.168.31.86:3000', protocol: 'http' }),
    { srv: '192.168.31.86', port: '3000', scheme: 'http' });
});

// Порт в адресе опущен — значит стандартный для схемы, и в .bat он нужен явно.
test('resolveTarget: порт по умолчанию берётся из схемы', () => {
  assert.deepEqual(resolveTarget({ host: '192.168.31.86', protocol: 'https' }),
    { srv: '192.168.31.86', port: '443', scheme: 'https' });
  assert.deepEqual(resolveTarget({ host: 'raspisanie', protocol: 'http' }),
    { srv: 'raspisanie', port: '80', scheme: 'http' });
});

// Настройка админки сильнее автоопределения: гость мог прийти по имени,
// которое с других компьютеров не разрешается.
test('resolveTarget: ручная настройка перебивает адрес запроса', () => {
  assert.deepEqual(resolveTarget({ host: 'localhost:3000', protocol: 'http', manual: '10.0.0.5' }),
    { srv: '10.0.0.5', port: '80', scheme: 'http' });
  assert.deepEqual(resolveTarget({ host: 'localhost:3000', protocol: 'http', manual: 'https://10.0.0.5:443' }),
    { srv: '10.0.0.5', port: '443', scheme: 'https' });
});

test('resolveTarget: пустой и битый адрес — null', () => {
  assert.equal(resolveTarget({ host: '', protocol: 'http' }), null);
  assert.equal(resolveTarget({ host: 'а б в', protocol: 'http' }), null);
});

// .bat читает cmd: только CRLF и никаких сюрпризов в подставленном адресе.
// Кодировка консоли переключается на UTF-8 — файл лежит в архиве в UTF-8,
// чтобы его можно было открыть Блокнотом и поправить адрес.
test('batText: адрес подставлен, строки CRLF, консоль в UTF-8', () => {
  const bat = batText({ srv: '192.168.31.86', port: '443', scheme: 'https' });
  assert.match(bat, /chcp 65001/);
  assert.match(bat, /if not defined SRV set SRV=192\.168\.31\.86/);
  assert.match(bat, /if not defined PORT set PORT=443/);
  assert.match(bat, /https:\/\/%SRV%:%PORT%\/weekly\.html\?widget=1/);
  assert.ok(bat.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(bat), 'встретился одинокий LF — cmd такой файл разбирает непредсказуемо');
});

// HTTPS у локального сервера самоподписанный: без ключа браузер покажет заглушку.
test('batText: -Insecure добавляется только для https', () => {
  assert.match(batText({ srv: 'x', port: '443', scheme: 'https' }), /-Insecure/);
  assert.doesNotMatch(batText({ srv: 'x', port: '80', scheme: 'http' }), /-Insecure/);
});

// Самоподписанный сертификат сервера: в .bat уезжает отпечаток его открытого
// ключа, и браузер виджета доверяет ровно этому серверу — даже там, где общее
// «не проверять сертификаты» запрещено политиками.
test('batText: отпечаток ключа только для https', () => {
  const pin = 'AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK=';
  const https = batText({ srv: 'srv', port: '443', scheme: 'https' }, pin);
  assert.match(https, /-Insecure -SpkiHash "AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK="/);
  const http = batText({ srv: 'srv', port: '80', scheme: 'http' }, pin);
  assert.equal(http.includes('SpkiHash'), false);
  // Сертификата нет (сервер по HTTP) — нет и отпечатка, ключ в .bat не попадёт.
  assert.equal(batText({ srv: 'srv', port: '443', scheme: 'https' }, null).includes('SpkiHash'), false);
});

// Отпечаток считается из настоящего сертификата; файла нет — null, а не падение.
test('certPin: нет файла сертификата — null', () => {
  assert.equal(certPin('нет-такого-файла.pem'), null);
});

// Адрес, который вшивается в виджет-программу и открывается при запуске:
// сводное расписание на сегодня. Тот же, что подставляется в .bat.
test('widgetUrl: сводное на сегодня по адресу сервера', () => {
  assert.equal(widgetUrl({ srv: '192.168.31.86', port: '443', scheme: 'https' }),
    'https://192.168.31.86:443/weekly.html?widget=1&mode=day&week=cur');
});
