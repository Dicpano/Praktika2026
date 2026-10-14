# Застосувати db/schema.sql до бази з DATABASE_URL (.env або змінна середовища)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (Test-Path .env) {
    Get-Content .env | Where-Object { $_ -match '^\s*([^#=]+)=(.*)$' } | ForEach-Object {
        [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
    }
}
if (-not $env:DATABASE_URL) { throw "DATABASE_URL не задано (див. .env.example)" }
psql -v ON_ERROR_STOP=1 -d $env:DATABASE_URL -f db/schema.sql
if ($LASTEXITCODE -ne 0) { throw "psql завершився з помилкою" }
Write-Host "Схему застосовано"
