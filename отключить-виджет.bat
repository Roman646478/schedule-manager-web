@echo off
chcp 866 >nul
cd /d "%~dp0"
rem Отключение автозапуска виджета. Снимает оба способа сразу: ярлык из папки
rem автозагрузки (его ставит установить-виджет.bat) и запись самой программы,
rem которую делает флажок "Автозапуск" в панели виджета.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\widget-shortcuts.ps1" -Mode remove
echo.
pause
