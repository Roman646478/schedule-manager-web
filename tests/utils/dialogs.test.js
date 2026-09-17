'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPowerShell } = require('../../src/utils/dialogs');

// Окна выбора файла/папки строятся PowerShell-скриптом. Скрипт многострочный, и
// раньше строки склеивались пробелом без разделителей — PowerShell читал их как
// одну команду, переменные не создавались, диалог не открывался, а вызывающий код
// принимал пустой вывод за «пользователь отменил» и отдавал 500.
// GUI здесь не поднимаем: проверяем сам транспорт до PowerShell.

test('многострочный скрипт выполняется целиком (переменные доходят до следующих строк)', async () => {
  const out = await runPowerShell(`
$a = 2
$b = 3
Write-Output ($a * $b)
`);
  assert.equal(out, '6');
});

test('объекты WinForms создаются, строки с кавычками и «|» не ломают команду', async () => {
  const out = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = 'Сохранить расписание группы'
$d.Filter = 'Excel Files (*.xlsx)|*.xlsx'
Write-Output ($d.GetType().Name + ';' + $d.Title + ';' + $d.Filter + ';' + $form.TopMost)
`);
  assert.equal(out, "SaveFileDialog;Сохранить расписание группы;Excel Files (*.xlsx)|*.xlsx;True");
});

test('кириллица в пути возвращается без искажений', async () => {
  const out = await runPowerShell("Write-Output 'D:\\Рабочий стол\\расписание\\821-11.xlsx'");
  assert.equal(out, 'D:\\Рабочий стол\\расписание\\821-11.xlsx');
});

test('пустой вывод = отмена (null), а не ошибка', async () => {
  assert.equal(await runPowerShell('if ($false) { Write-Output 1 }'), null);
});

test('падение скрипта превращается в исключение, а не в «отменено»', async () => {
  await assert.rejects(
    () => runPowerShell('$нет = $null; $нет.Метод()'),
    (err) => /Не удалось открыть окно выбора/.test(err.message)
  );
});

test('служебный прогресс PowerShell в stderr не считается ошибкой', async () => {
  // Add-Type при первом вызове печатает в stderr CLIXML-прогресс «Подготовка
  // модулей…» — раньше он принимался за сбой.
  const out = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
Write-Output 'ok'
`);
  assert.equal(out, 'ok');
});
