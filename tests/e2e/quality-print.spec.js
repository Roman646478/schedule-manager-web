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

for (const orientation of ['portrait', 'landscape']) {
  for (const mode of ['one', 'grid']) {
    test(`настройки ${orientation}/${mode}: все занятия помещаются в выбранное число листов`, async ({ page, browser }) => {
      await prepare(page);
      await page.evaluate(() => {
        const toggle = document.createElement('input');
        toggle.id = 'sumTeacherToggle'; toggle.type = 'checkbox'; toggle.checked = true;
        document.body.appendChild(toggle);
        const grid = document.getElementById('grid');
        grid.innerHTML = '<table class="grid semester summary gsum"><thead><tr><th class="day-col">День</th><th class="pair-col">Пара</th>' +
          Array.from({ length: 4 }, (_, x) => `<th>Неделя ${x + 1}</th>`).join('') + '</tr></thead><tbody>' +
          Array.from({ length: 8 }, (_, y) => `<tr>${y === 0 ? '<td rowspan="8">Понедельник</td>' : ''}<td>${y + 1}</td>` +
            Array.from({ length: 4 }, (_, x) => `<td><div class="lesson"><div class="subj">Длинное название дисциплины ${y}-${x}</div><div class="l4">Иванов Иван Иванович; Петров Пётр Петрович</div></div></td>`).join('') + '</tr>').join('') + '</tbody></table>';
        grid.querySelectorAll('.lesson').forEach(card => {
          card.dataset.lesson = JSON.stringify({ teacher: 'Иванов Иван Иванович', teachers: ['Иванов Иван Иванович', 'Петров Пётр Петрович'] });
        });
        document.getElementById('btnQualityPrint').onclick = window.QualityPrint.showSettings;
      });
      await page.locator('#btnQualityPrint').click();
      await page.locator('dialog [name=orientation]').selectOption(orientation);
      await page.locator('dialog [name=mode]').selectOption(mode);
      if (mode === 'grid') {
        await page.locator('dialog [name=columns]').fill('2');
        await page.locator('dialog [name=rows]').fill('2');
      }
      await page.locator('dialog button[type=submit]').click();
      await expect.poll(() => page.evaluate(() => window.printedDocuments.length)).toBe(1);
      const result = await page.evaluate(() => {
        const doc = document.querySelector('iframe').contentDocument;
        const sheets = [...doc.querySelectorAll('.print-sheet')];
        return {
          html: doc.documentElement.outerHTML,
          count: sheets.length,
          lessons: [...doc.querySelectorAll('.subj')].map(el => el.textContent),
          fits: sheets.every(sheet => {
            const content = sheet.querySelector('.sheet-content').getBoundingClientRect();
            const viewport = sheet.querySelector('.sheet-viewport').getBoundingClientRect();
            return content.right <= viewport.right && content.bottom <= viewport.bottom;
          }),
          fillsHeight: sheets.every(sheet => {
            const content = sheet.querySelector('.sheet-content').getBoundingClientRect();
            const viewport = sheet.querySelector('.sheet-viewport').getBoundingClientRect();
            return Math.abs(content.height - viewport.height) <= 4;
          }),
          labels: sheets.every(sheet => sheet.textContent.includes('Понедельник')),
          nowrap: doc.defaultView.getComputedStyle(doc.querySelector('.subj')).whiteSpace,
          teacherWrap: doc.defaultView.getComputedStyle(doc.querySelector('.print-teacher')).whiteSpace,
          scales: sheets.map(sheet => Number(sheet.dataset.scale)),
        };
      });
      expect(result.count).toBe(mode === 'one' ? 1 : 4);
      expect(new Set(result.lessons).size).toBe(32);
      expect(result.lessons.length).toBe(32);
      expect(result.fits).toBe(true);
      expect(result.fillsHeight).toBe(true);
      expect(result.labels).toBe(true);
      expect(result.nowrap).toBe('normal');
      expect(result.teacherWrap).toBe('normal');
      expect(result.scales.every(scale => scale > 0)).toBe(true);
      // Проверяем число настоящих PDF-страниц, а не только HTML-секций.
      const pdfPage = await browser.newPage();
      await pdfPage.setContent(result.html);
      const pdf = await pdfPage.pdf({ preferCSSPageSize: true });
      expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length).toBe(result.count);
      await pdfPage.close();
      await page.evaluate(() => { document.getElementById('sumTeacherToggle').checked = false; });
      const hidden = await page.evaluate(() => window.QualityPrint.buildSheets({ mode: 'one' }));
      expect(hidden).not.toContain('Иванов');
      expect(hidden).not.toContain('Петров');
      expect(hidden).toContain('Длинное название дисциплины');
    });
  }
}

test('семестровая сетка и таблица дисциплин печатаются одной ширины', async ({ page }) => {
  await prepare(page);
  const equal = await page.evaluate(async () => {
    const grid = document.getElementById('grid');
    grid.innerHTML = '<table class="grid semester"><tbody><tr><td>Пара</td><td>Неделя 1</td><td>Неделя 2</td><td>Неделя 3</td></tr></tbody></table>' +
      '<table class="grid subjects-table"><tbody><tr><td>Дисциплина</td><td>Преподаватель</td></tr></tbody></table>';
    const html = window.QualityPrint.buildSheets({ mode: 'one' });
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write(html); doc.close();
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    window.QualityPrint.fitSheets(doc);
    const tables = [...doc.querySelectorAll('.sheet-content > table')];
    const widths = tables.map(table => table.getBoundingClientRect().width);
    frame.remove();
    return Math.abs(widths[0] - widths[1]) < 1;
  });
  expect(equal).toBe(true);
});
