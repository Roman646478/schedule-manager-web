'use strict';
/* global window, document */
const { test, expect } = require('@playwright/test');

async function prepare(page) {
  await page.addInitScript(() => {
    window.print = () => {
      window.top.printedDocuments.push(document.body.innerText);
    };
  });
  await page.goto('/weekly.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    window.printedDocuments = [];
    document.body.innerHTML = '<h1 id="title">Проверка печати</h1><button id="btnQualityPrint">Печать</button>' +
      '<div id="grid"><table><thead><tr><th>День</th><th>Занятие</th></tr></thead>' +
      '<tbody><tr><td>Пн</td><td>Алгебра</td></tr></tbody></table></div>';
    document.getElementById('btnQualityPrint').onclick = window.QualityPrint.print;
  });
}

test('движок завершает вёрстку и дважды вызывает печать под CSP сервера', async ({ page }) => {
  const violations = [];
  page.on('console', m => { if (m.type() === 'error') violations.push(m.text()); });
  await prepare(page);
  for (let count = 1; count <= 2; count++) {
    await page.locator('#btnQualityPrint').click();
    await expect.poll(() => page.evaluate(() => window.printedDocuments.length), { timeout: 10000 }).toBe(count);
    await expect(page.locator('#btnQualityPrint')).toBeEnabled();
  }
  expect(await page.evaluate(() => window.printedDocuments)).toEqual([
    expect.stringContaining('Алгебра'), expect.stringContaining('Алгебра'),
  ]);
  expect(violations.filter(message => /Content Security Policy/.test(message))).toEqual([]);
});

for (const failure of ['missing', 'throw', 'timeout']) {
  test(`запасная печать при ${failure} не оставляет кнопку заблокированной`, async ({ page }) => {
    await prepare(page);
    await page.evaluate(mode => {
      if (mode === 'missing') window.VivliostyleCore = null;
      else window.VivliostyleCore = { printHTML() {
        if (mode === 'throw') throw new Error('Ошибка движка');
      } };
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 15000 ? 20 : delay, ...args);
    }, failure);
    await page.locator('#btnQualityPrint').click();
    await expect.poll(() => page.evaluate(() => window.printedDocuments.length)).toBe(1);
    expect(await page.evaluate(() => window.printedDocuments[0])).toContain('Алгебра');
    await expect(page.locator('#btnQualityPrint')).toBeEnabled();
  });
}
