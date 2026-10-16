@echo off
rem Transfer Learning-лабораторія — запуск. Інтернет не потрібен.
rem Сервер працює у фоні без чорного вікна. Вимкнути: кнопка «Вимкнути програму» в «Налаштуваннях»,
rem файл TL-Lab-Stop.bat, або просто закрийте вікно програми — сервер сам вимкнеться через 15 хв.
chcp 65001 >nul
title Transfer Learning-лабораторія — запуск
set "HERE=%~dp0"
set "PY=%HERE%runtime\python\python.exe"
set PYTHONUTF8=1
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
set TL_AUTOSTOP=15
set PORT=8501

if not exist "%PY%" (
  echo [!] Програму ще не встановлено. Запустіть INSTALL.bat у цій папці.
  pause & exit /b 1
)

rem ярлик з новою назвою на робочому столі (старий «TL-Лабораторія» прибирається)
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%installer\shortcut.ps1" -Root "%HERE:~0,-1%" >nul 2>&1

rem Якщо програма вже працює — просто відкриваємо вікно
powershell -NoProfile -Command "try { if((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/health -TimeoutSec 2).Content -match 'tl-lab-3'){ exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto open
rem на порту може «висіти» старий сервер (попередня версія) — зупиняємо його
taskkill /FI "WINDOWTITLE eq TL-LAB server*" /T /F >nul 2>&1
if exist "%HERE%app\logs\server.pid" (
  for /f "usebackq" %%p in ("%HERE%app\logs\server.pid") do taskkill /PID %%p /T /F >nul 2>&1
  del "%HERE%app\logs\server.pid" >nul 2>&1
)

echo.
echo   TRANSFER LEARNING-ЛАБОРАТОРІЯ
echo   [*] запуск сервера на http://localhost:%PORT% ... (вікно закриється саме)
if not exist "%HERE%app\logs" mkdir "%HERE%app\logs"
if exist "%HERE%app\logs\server.log" move /y "%HERE%app\logs\server.log" "%HERE%app\logs\server.prev.log" >nul
if exist "%HERE%app\logs\server.err.log" move /y "%HERE%app\logs\server.err.log" "%HERE%app\logs\server.prev.err.log" >nul
rem прихований запуск; журнал — у app\logs\server.log і server.err.log (там видно причину, якщо щось зламалося)
powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList '-m','server','--port','%PORT%' -WorkingDirectory '%HERE%app' -WindowStyle Hidden -RedirectStandardOutput '%HERE%app\logs\server.log' -RedirectStandardError '%HERE%app\logs\server.err.log'"

powershell -NoProfile -Command "$i=0; while($i -lt 120){ try { if((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/health -TimeoutSec 2).Content -match 'tl-lab-3'){ exit 0 } } catch {}; Start-Sleep 1; $i++ }; exit 1"
if errorlevel 1 (
  echo [!] Сервер не відповів за 2 хв. Подивіться файли app\logs\server.err.log і server.log
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
exit /b 0
