@echo off
rem TL-Лабораторія — запуск. Інтернет не потрібен.
chcp 65001 >nul
title TL-LAB :: CYBER-OPS
set "HERE=%~dp0"
set "PY=%HERE%runtime\python\python.exe"
set PYTHONUTF8=1
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
set PORT=8501

if not exist "%PY%" (
  echo [!] Програму ще не встановлено. Запустіть INSTALL.bat у цій папці.
  pause & exit /b 1
)

rem Якщо програма вже працює — просто відкриваємо вікно
powershell -NoProfile -Command "try { if((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/health -TimeoutSec 2).Content -match 'tl-lab-3'){ exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto open
rem на порту може «висіти» старий сервер (попередня версія) — зупиняємо його
taskkill /FI "WINDOWTITLE eq TL-LAB server*" /T /F >nul 2>&1

echo.
echo   ████████╗██╗         ██╗      █████╗ ██████╗
echo   ╚══██╔══╝██║         ██║     ██╔══██╗██╔══██╗
echo      ██║   ██║  █████╗ ██║     ███████║██████╔╝
echo      ██║   ██║  ╚════╝ ██║     ██╔══██║██╔══██╗
echo      ██║   ███████╗    ███████╗██║  ██║██████╔╝
echo      ╚═╝   ╚══════╝    ╚══════╝╚═╝  ╚═╝╚═════╝   :: CYBER-OPS
echo.
echo   [*] запуск сервера на http://localhost:%PORT% ...
if not exist "%HERE%app\logs" mkdir "%HERE%app\logs"
if exist "%HERE%app\logs\server.log" move /y "%HERE%app\logs\server.log" "%HERE%app\logs\server.prev.log" >nul
rem журнал сервера зберігається у файл — якщо програма аварійно закриється, причину видно в app\logs\server.log
start "TL-LAB server" /min /D "%HERE%app" cmd /c ""%PY%" -m server --port %PORT% > "logs\server.log" 2>&1"

powershell -NoProfile -Command "$i=0; while($i -lt 120){ try { if((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/health -TimeoutSec 2).Content -match 'tl-lab-3'){ exit 0 } } catch {}; Start-Sleep 1; $i++ }; exit 1"
if errorlevel 1 (
  echo [!] Сервер не відповів за 2 хв. Подивіться файл app\logs\server.log
  pause & exit /b 1
)

:open
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:%PORT% --window-size=1440,900
) else (
  start "" http://127.0.0.1:%PORT%
)
timeout /t 3 >nul
