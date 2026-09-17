@echo off
cd /d "%~dp0"
set PORT=443
rem Схема - по наличию сертификата: с ним сервер поднимается по HTTPS.
set SCHEME=http
if exist "%~dp0data\tls\cert.pem" set SCHEME=https

rem Перезапуск: закрыть прежнее окно сервера и процесс, занявший порт.
taskkill /f /t /fi "WINDOWTITLE eq schedule-manager (dev)*" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>&1

rem Сервер в отдельном окне (закрыть окно = остановить сервер).
start "schedule-manager (dev)" cmd /k "node src\server.js"

rem Ждём, пока порт откроется (до ~15 с), и открываем страницу.
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -ano | findstr /c:":%PORT% " | findstr LISTENING >nul && goto open
if %tries% lss 15 goto wait
echo Сервер не поднялся за 15 секунд - смотрите окно "schedule-manager (dev)".
pause
exit /b 1
:open
start %SCHEME%://localhost:%PORT%/
