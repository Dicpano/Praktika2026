# Заповнити таблицю incidents тестовими даними (500 записів)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
python db/seed.py
if ($LASTEXITCODE -ne 0) { throw "seed.py завершився з помилкою" }
