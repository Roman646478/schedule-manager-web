@echo off
chcp 866 >nul
cd /d "%~dp0"
rem Окно-виджет расписания на рабочем столе.
rem Это гостевая страница сайта, открытая отдельным окном браузера (без вкладок
rem и адресной строки) и прибитая в самый низ: поверх виджета ложится любое
rem окно, сам он не всплывает и фокус не забирает. Данные - опубликованный
rem снимок, как видят гости. Вид переключается вкладками в самом окне.

if not defined PORT set PORT=443
rem Схема - по наличию сертификата: с ним сервер поднимается по HTTPS.
if not defined SCHEME (
  set SCHEME=http
  if exist "%~dp0data\tls\cert.pem" set SCHEME=https
)
set "URL=%SCHEME%://localhost:%PORT%/weekly.html?widget=1&mode=day&week=cur"

rem Снимок отдаёт сервер. Не запущен - поднимаем свёрнутым окном.
netstat -ano | findstr /c:":%PORT% " | findstr LISTENING >nul
if errorlevel 1 start "schedule-manager (widget)" /min cmd /c "node src\server.js"

rem Холодный старт с миграциями базы занимает ~20 с - 15 секунд не хватало.
set /a tries=0
:wait
netstat -ano | findstr /c:":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 goto open
timeout /t 1 /nobreak >nul
set /a tries+=1
if %tries% lss 60 goto wait
echo Сервер не поднялся за 60 секунд - виджету нечего показать.
pause
exit /b 1

:open
rem Виджет - отдельная программа на WebView2 (native/WidgetHost.cs): один и тот
rem же движок на любом ПК, настоящая попиксельная прозрачность. Собирается
rem штатным csc.exe из Windows, первый запуск занимает пару секунд.
rem Поправили WidgetHost.cs - удалите dist\виджет.exe, он пересоберётся.
if not exist "%~dp0dist\виджет.exe" (
  echo Собираю виджет...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-widget-exe.ps1" -Url "%URL%"
)
if exist "%~dp0dist\виджет.exe" (
  start "" "%~dp0dist\виджет.exe" "%URL%"
  exit /b 0
)

rem Запасной вариант - виджет окном браузера: сторож держит окно внизу и
rem снимает шапку браузера. Закрыли виджет - сторож завершается сам.
echo Программа не собралась, открываю виджет через браузер.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\widget-window.ps1" -Url "%URL%"
