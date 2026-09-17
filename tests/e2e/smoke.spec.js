'use strict';
/* global window */

const { test, expect } = require('@playwright/test');
const path = require('node:path');

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

test('неверный пароль оставляет пользователя на форме и показывает ошибку', async ({ page }) => {
  await page.goto('/login.html');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('неверный');
  await page.locator('#loginBtn').click();

  await expect(page).toHaveURL(/\/login\.html$/);
  await expect(page.locator('#msg')).toBeVisible();
  await expect(page.locator('#msg')).not.toBeEmpty();
});

test('гостевой экран и печатный режим загружаются', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/weekly.html');
  await expect(page.locator('#guestRoot')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#guestRoot')).toBeVisible();
  expect(errors).toEqual([]);
});
