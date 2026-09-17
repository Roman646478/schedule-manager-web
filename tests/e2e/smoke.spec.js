'use strict';

const { test, expect } = require('@playwright/test');

test('вход открывает админку без ошибок JavaScript', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/login.html');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('admin');
  await page.locator('#loginBtn').click();

  await expect(page).toHaveURL(/\/admin\.html$/);
  await expect(page.locator('#btnLogout')).toBeVisible();
  await expect(page.locator('#gridTitle')).toContainText('Загрузите расписание');
  expect(errors).toEqual([]);
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

test('гостевой экран и печатный режим загружаются без публикации', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/weekly.html');
  await expect(page.locator('#guestRoot')).toContainText('Расписание ещё не опубликовано');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#guestRoot')).toBeVisible();
  expect(errors).toEqual([]);
});
