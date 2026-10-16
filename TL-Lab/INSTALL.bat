@echo off
rem Transfer Learning-лабораторія — установка однією командою: Python, бібліотеки, моделі, фото, ярлик.
rem Повторний запуск продовжує з місця зупинки. Параметри: -SkipPhotos  -Repair
chcp 65001 >nul
title Transfer Learning-лабораторія :: встановлення
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
pause
