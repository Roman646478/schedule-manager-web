# Автозапуск виджета: ярлык в папке автозагрузки Windows. На рабочем столе
# ярлыков не создаём - виджет и так висит на нём, а лишние значки только мешают.
# Запускается из установить-виджет.bat / отключить-виджет.bat. Отдельным файлом,
# а не строкой внутри .bat: имя ярлыка кириллическое, а через cmd оно едет в
# CP866 и ломается.
#
# Сама программа-виджет умеет то же самое флажком «Автозапуск» в своей панели
# (пишет ключ Run текущего пользователя). Отключение снимает оба способа сразу:
# человек не обязан помнить, каким из них он включал.
param(
  [string]$Target,
  [ValidateSet('install', 'remove')][string]$Mode = 'install'
)

$path = Join-Path ([Environment]::GetFolderPath('Startup')) 'Расписание — виджет.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'ScheduleWidget'

if ($Mode -eq 'remove') {
  if (Test-Path $path) {
    Remove-Item $path -Force
    Write-Host "Ярлык автозапуска удалён: $path"
  } else {
    Write-Host 'Ярлыка автозапуска не было.'
  }
  $run = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
  if ($run) {
    Remove-ItemProperty -Path $runKey -Name $runName
    Write-Host 'Запись автозапуска самой программы тоже снята.'
  }
  Write-Host 'Виджет больше не будет открываться при входе в Windows.'
  return
}

if (-not $Target) { throw 'Не задан -Target: что запускать' }
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($path)
$lnk.TargetPath = $Target
$lnk.WorkingDirectory = Split-Path $Target -Parent
$lnk.Description = 'Расписание: виджет на рабочем столе'
$lnk.WindowStyle = 7   # свёрнутое окно cmd: мелькает в панели задач, не на экране
$lnk.Save()

Write-Host "Ярлык автозапуска создан: $path"
Write-Host 'Виджет откроется сам при входе в Windows, на том же месте и того же размера.'
Write-Host 'Отключить: отключить-виджет.bat (или снять флажок «Автозапуск» в панели виджета).'
