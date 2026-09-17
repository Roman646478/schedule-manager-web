@echo off
chcp 866 >nul
cd /d "%~dp0"
rem Автозапуск виджета при входе в Windows. Ярлыков на рабочем столе не создаём.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\widget-shortcuts.ps1" -Target "%~dp0виджет.bat"
echo Отключить автозапуск: отключить-виджет.bat (или снять флажок
echo "Автозапуск" прямо в панели виджета).
echo.
pause