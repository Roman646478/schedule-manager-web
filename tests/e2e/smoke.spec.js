'use strict';
/* global window, document */

const { test, expect } = require('@playwright/test');
const path = require('node:path');
const ExcelJS = require('exceljs');

async function login(page) {
  await page.goto('/login.html');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('admin');
  await page.locator('#loginBtn').click();
  await expect(page).toHaveURL(/\/admin\.html$/);
}

test('вход открывает админку без ошибок JavaScript', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await login(page);

  await expect(page).toHaveURL(/\/admin\.html$/);
  await expect(page.locator('#btnLogout')).toBeVisible();
  await expect(page.locator('#gridTitle')).toContainText('Загрузите расписание');
  expect(errors).toEqual([]);
});

test('импорт, перенос, отмена и публикация видны гостю', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page);
  await page.getByText('Импорт расписания', { exact: true }).click();
  await page.locator('#fileInput').setInputFiles(path.join(__dirname, '..', 'fixtures', 'synthetic-group.html'));
  await page.locator('#btnImport').click();
  await expect(page.locator('#importStatus')).toContainText('Готово', { timeout: 15_000 });

  const result = await page.evaluate(async () => {
    const before = await window.api.get('/api/schedule?view=group&id=999');
    const lesson = before.lessons[0];
    const options = await window.api.get(`/api/move-options?lessonId=${lesson.id}`);
    const target = options.slots.find((slot) =>
      (slot.day !== lesson.day || slot.pairNo !== lesson.pairNo || slot.weekNo !== lesson.weekNo) &&
      (slot.free || (slot.teacherFree && slot.groupFree && slot.roomFree))
    );
    if (!target) throw new Error('Нет свободного слота для E2E-переноса');
    await window.api.post('/api/move', {
      lessonId: lesson.id,
      day: target.day,
      pairNo: target.pairNo,
      weekNo: target.weekNo,
      room: lesson.room,
    });
    const moved = await window.api.get('/api/schedule?view=group&id=999');
    const undo = await window.api.get('/api/undo');
    await window.api.post('/api/undo', { expectedId: undo.id });
    const undone = await window.api.get('/api/schedule?view=group&id=999');
    await window.api.put('/api/entity-visibility', { kind: 'groups', name: '999', hidden: false });
    await window.api.post('/api/publish');
    return {
      original: [lesson.day, lesson.pairNo, lesson.weekNo],
      moved: [moved.lessons[0].day, moved.lessons[0].pairNo, moved.lessons[0].weekNo],
      undone: [undone.lessons[0].day, undone.lessons[0].pairNo, undone.lessons[0].weekNo],
    };
  });
  expect(result.moved).not.toEqual(result.original);
  expect(result.undone).toEqual(result.original);

  const guest = await browser.newPage();
  await guest.goto('/weekly.html');
  await expect(guest.locator('#entitySelect')).toContainText('999');
  await guest.locator('#entitySelect').selectOption('999');
  await expect(guest.locator('#grid')).toContainText('ТЕСТ');
  await guest.close();
});

test('Excel показывает подсказку распознавания до импорта', async ({ page }) => {
  await login(page);
  await page.getByText('Импорт расписания', { exact: true }).click();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Расписание');
  ws.getCell('A2').value = '2025/2026 учебный год';
  ws.getCell('A5').value = 'Учебная группа 978';
  ws.getCell('A10').value = 'День недели';
  ws.getCell('C10').value = 'Уч. недели';
  ws.getCell('D10').value = 1;
  ws.getCell('C11').value = 'Даты';
  ws.getCell('D11').value = new Date('2026-02-09T00:00:00Z');
  ws.getCell('A12').value = 'Пн';
  ws.getCell('B12').value = '1-2';
  ws.getCell('C12').value = '9.00-10.35';
  ws.getCell('D12').value = 'П/Т.2\nXLSX-E2E\n430-7';
  await page.locator('#fileInput').setInputFiles({
    name: '978.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  });
  await expect(page.locator('#importPreview')).toContainText('Excel: пара в одной ячейке');
  await expect(page.locator('#importPreview')).toContainText('группа 978');
  await expect(page.locator('#importPreview')).toContainText('XLSX-E2E');
  await page.locator('#btnImport').click();
  await expect(page.locator('#importStatus')).toContainText('Готово', { timeout: 15_000 });
  const imported = await page.evaluate(() => window.api.get('/api/schedule?view=group&id=978'));
  expect(imported.lessons.some((lesson) => lesson.subject === 'XLSX-E2E')).toBeTruthy();
});

test('неверный пароль оставляет пользователя на форме и показывает ошибку', async ({ page }) => {
  await page.goto('/login.html');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('неверный');
  await page.locator('#loginBtn').click();

  await expect(page).toHaveURL(/\/login\.html$/);
  await expect(page.locator('#msg')).toBeVisible();
  await expect(page.locator('#msg')).not.toBeEmpty();
});

test('гость повторно скачивает разные дисциплины и новые виды Excel', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page);
  await page.evaluate(async () => {
    for (const [subject, group, room, pairNo] of [
      ['ЭКСПОРТ-А', 'Э-101', 'Э-1', 1], ['ЭКСПОРТ-Б', 'Э-202', 'Э-2', 2],
    ]) {
      await window.api.post('/api/lessons', {
        day: 'Вт', pairNo, weekNo: 1, subject, type: 'ПЗ', groups: [group], room,
        teacher: 'Экспорт Т.Т.',
      });
      await window.api.put('/api/rooms', { name: room, dept: 'ЭКСПОРТ', capacity: 30 });
    }
    await window.api.put('/api/guest-export', { enabled: true });
    await window.api.post('/api/publish');
  });
  const guest = await browser.newPage({ acceptDownloads: true });
  try {
    await guest.goto('/weekly.html');
    await guest.locator('#viewKind').selectOption('subject');
    const download = async (expectedName) => {
      await expect(guest.locator('#btnGuestExport')).toBeEnabled();
      const pending = guest.waitForEvent('download');
      await guest.locator('#btnGuestExport').click();
      const file = await pending;
      expect(file.suggestedFilename()).toContain(expectedName);
      expect(await file.failure()).toBeNull();
    };
    for (const subject of ['ЭКСПОРТ-А', 'ЭКСПОРТ-Б', 'ЭКСПОРТ-А']) {
      await guest.locator('#entitySelect').selectOption(subject);
      await download(subject);
    }
    await guest.locator('#viewKind').selectOption('room');
    await guest.locator('#entitySelect').selectOption('Э-1');
    await download('Аудитория Э-1');
    await guest.locator('#viewKind').selectOption('dept');
    await guest.locator('#entitySelect').selectOption('(без кафедры)');
    await download('Кафедра');
    await guest.locator('#deptKind').selectOption('room');
    await guest.locator('#entitySelect').selectOption('ЭКСПОРТ');
    await download('Кафедра ЭКСПОРТ');
  } finally {
    await guest.close();
  }
});

test('гостевой экран и печатный режим загружаются', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/weekly.html');
  await expect(page.locator('#guestRoot')).toBeVisible();
  const pageHtml = await (await page.request.get('/weekly.html')).text();
  expect(pageHtml).toContain('id="btnQualityPrint"');
  await expect.poll(() => page.evaluate(() => typeof window.VivliostyleCore?.printHTML)).toBe('function');
  const snapshot = await (await page.request.get('/public_db.json')).json();
  const weekCount = await page.locator('#weekSelect option').count();
  const localWeek = await page.evaluate(
    ({ start, maxWeek }) => window.SCHED_CONST.weekNoOn(start, new Date(), maxWeek),
    { start: snapshot.semester?.start, maxWeek: weekCount }
  );
  expect(Number(await page.locator('#weekSelect').inputValue())).toBe(localWeek || 1);
  await page.locator('[data-mode="month"]').click();
  expect(Number(await page.locator('#weekSelect').inputValue())).toBe(localWeek || 1);
  await page.locator('[data-mode="day"]').click();
  expect(Number(await page.locator('#weekSelect').inputValue())).toBe(localWeek || 1);
  const qualityDocument = await page.evaluate(() => {
    const grid = document.getElementById('grid') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'grid' }));
    grid.innerHTML = '<table><thead><tr><th>День</th></tr></thead><tbody><tr><td>Пн</td></tr></tbody></table>';
    return window.QualityPrint.buildDocument();
  });
  expect(qualityDocument).toContain('@page { size: A4 landscape');
  expect(qualityDocument).toContain('<table');
  expect(qualityDocument).not.toContain('id="btnQualityPrint"');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#guestRoot')).toBeVisible();
  expect(errors).toEqual([]);
});
