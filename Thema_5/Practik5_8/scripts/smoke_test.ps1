# Мінімальна перевірка працездатності API (API має бути запущено)
param([string]$BaseUrl = "http://localhost:8000")
Set-Location (Join-Path $PSScriptRoot "..")
python scripts/smoke_test.py $BaseUrl
exit $LASTEXITCODE
