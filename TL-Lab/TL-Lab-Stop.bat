@echo off
rem Зупиняє сервер Transfer Learning-лабораторії (якщо кнопка «Вимкнути програму» недоступна)
chcp 65001 >nul
set "HERE=%~dp0"
set STOPPED=
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:8501/api/shutdown -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 set STOPPED=1
timeout /t 2 >nul
if exist "%HERE%app\logs\server.pid" (
  for /f "usebackq" %%p in ("%HERE%app\logs\server.pid") do taskkill /PID %%p /T /F >nul 2>&1 && set STOPPED=1
  del "%HERE%app\logs\server.pid" >nul 2>&1
)
taskkill /FI "WINDOWTITLE eq TL-LAB server*" /T /F >nul 2>&1 && set STOPPED=1
if defined STOPPED (echo [+] Програму вимкнено.) else (echo [i] Програма не була запущена.)
timeout /t 2 >nul
