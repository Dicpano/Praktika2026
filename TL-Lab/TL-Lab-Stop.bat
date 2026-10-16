@echo off
rem Зупиняє сервер TL-Лабораторії
taskkill /FI "WINDOWTITLE eq TL-LAB server*" /T /F >nul 2>&1 && echo [+] Сервер зупинено. || echo [i] Сервер не був запущений.
timeout /t 2 >nul
