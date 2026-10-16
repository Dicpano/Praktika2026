# Ярлик «Transfer Learning-лабораторія» на робочому столі (і прибирання старого «TL-Лабораторія»).
# Викликається з TL-Lab.bat при кожному запуску; якщо ярлик уже є — нічого не робить.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "SilentlyContinue"
$desk = [Environment]::GetFolderPath("Desktop")
$new = Join-Path $desk "Transfer Learning-лабораторія.lnk"
$old = Join-Path $desk "TL-Лабораторія.lnk"
if (-not (Test-Path $new)) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($new)
    $lnk.TargetPath = Join-Path $Root "TL-Lab.bat"
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = Join-Path $Root "app\assets\tl-lab.ico"
    $lnk.WindowStyle = 7
    $lnk.Description = "Transfer Learning-лабораторія"
    $lnk.Save()
}
if ((Test-Path $new) -and (Test-Path $old)) { Remove-Item $old -Force }
