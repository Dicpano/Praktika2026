<#
  TL-Лабораторія — установка однією командою (Windows 10/11 x64).
  Запускається з INSTALL.bat. Ставить усе в цю ж папку (портативно):
    runtime\python  — вбудований Python 3.11 і бібліотеки
    app\models      — готові моделі (~2 ГБ)
    app\data        — дані: фото й звуки з відкритих джерел (Wikimedia Commons, ESC-50)
  Повторний запуск продовжує з місця зупинки й докачує лише відсутнє.
#>
param(
    [switch]$SkipPhotos,
    [int]$PhotosPerClass = 30,
    [switch]$SkipSounds,
    [int]$SoundsPerClass = 25,
    [switch]$NoShortcut,
    [switch]$Repair
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root  = Split-Path -Parent $PSScriptRoot
$App   = Join-Path $Root "app"
$Rt    = Join-Path $Root "runtime"
$PyDir = Join-Path $Rt "python"
$Py    = Join-Path $PyDir "python.exe"
$Marks = Join-Path $Rt ".steps"
$PyVer = "3.11.9"
$env:PYTHONUTF8 = "1"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
New-Item -ItemType Directory -Force -Path $Rt, $Marks | Out-Null
Start-Transcript -Path (Join-Path $Root "install.log") -Append | Out-Null

function Banner {
    Write-Host ""
    Write-Host "  ████████╗██╗         ██╗      █████╗ ██████╗ " -ForegroundColor Cyan
    Write-Host "  ╚══██╔══╝██║         ██║     ██╔══██╗██╔══██╗" -ForegroundColor Cyan
    Write-Host "     ██║   ██║  █████╗ ██║     ███████║██████╔╝" -ForegroundColor Cyan
    Write-Host "     ██║   ██║  ╚════╝ ██║     ██╔══██║██╔══██╗" -ForegroundColor Cyan
    Write-Host "     ██║   ███████╗    ███████╗██║  ██║██████╔╝" -ForegroundColor Cyan
    Write-Host "     ╚═╝   ╚══════╝    ╚══════╝╚═╝  ╚═╝╚═════╝   :: INSTALL" -ForegroundColor Cyan
    Write-Host ""
}
function Step($n, $title) { Write-Host "`n[$n/8] $title" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [+] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function IsDone($name, $tag = "") { $f = Join-Path $Marks $name; (Test-Path $f) -and ((Get-Content $f -Raw).Trim() -eq $tag) -and -not $Repair }
function MarkDone($name, $tag = "") { Set-Content -Path (Join-Path $Marks $name) -Value $tag -Encoding ASCII }
function Retry([scriptblock]$Block, [string]$What, [int]$Times = 3) {
    for ($i = 1; $i -le $Times; $i++) {
        try { & $Block; return } catch {
            if ($i -eq $Times) { throw "$What : $($_.Exception.Message)" }
            Warn "$What — спроба $i не вдалася ($($_.Exception.Message)). Повтор через 10 с…"
            Start-Sleep 10
        }
    }
}
function Download($url, $out) { Retry { Invoke-WebRequest $url -OutFile $out -UseBasicParsing } "Завантаження $url" }
function RunPy([string[]]$PyArgs, [string]$What) {
    & $Py @PyArgs
    if ($LASTEXITCODE -ne 0) { throw "$What завершилось з кодом $LASTEXITCODE" }
}

Banner
try {
    # ---------------------------------------------------------------- 1. перевірки
    Step 1 "Перевірка системи"
    if (-not [Environment]::Is64BitOperatingSystem) { throw "Потрібна 64-розрядна Windows 10/11." }
    $drive = (Get-Item $Root).PSDrive
    $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
    Ok "Папка: $Root · вільно на диску $($drive.Name): $freeGb ГБ"
    if ($freeGb -lt 9 -and -not (IsDone "deps" (Get-FileHash (Join-Path $App "requirements.lock.txt")).Hash)) {
        throw "Потрібно щонайменше 9 ГБ вільного місця (бібліотеки ~4 ГБ + моделі ~2 ГБ + запас)."
    }
    if ($Root -match '[^\x00-\x7F]') { Warn "У шляху є кирилиця або інші не-ASCII символи. Якщо установка впаде — перенесіть папку, напр. у C:\TL-Lab." }
    if ($Root.Length -gt 60) { Warn "Довгий шлях до папки ($($Root.Length) символів). TensorFlow чутливий до довгих шляхів — краще C:\TL-Lab." }
    try { Invoke-WebRequest "https://pypi.org/simple/pip/" -Method Head -UseBasicParsing -TimeoutSec 15 | Out-Null; Ok "Інтернет: є" }
    catch { throw "Немає доступу до pypi.org. Потрібен Інтернет (лише на час установки)." }

    # ---------------------------------------------------------------- 2. Python
    Step 2 "Вбудований Python $PyVer"
    if ((IsDone "python" $PyVer) -and (Test-Path $Py)) { Ok "уже встановлено" } else {
        if (Test-Path $PyDir) { Remove-Item $PyDir -Recurse -Force }
        $zip = Join-Path $env:TEMP "python-$PyVer-embed-amd64.zip"
        Download "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" $zip
        Expand-Archive $zip -DestinationPath $PyDir -Force
        $tag = ($PyVer.Split(".")[0..1] -join "")
        @("python$tag.zip", ".", "..\..\app", "import site") | Set-Content -Path (Join-Path $PyDir "python$tag._pth") -Encoding ASCII
        $gp = Join-Path $env:TEMP "get-pip.py"
        Download "https://bootstrap.pypa.io/get-pip.py" $gp
        RunPy @($gp, "--no-warn-script-location", "-q") "Встановлення pip"
        MarkDone "python" $PyVer
        Ok "Python і pip готові"
    }

    # ---------------------------------------------------------------- 3. бібліотеки
    Step 3 "Бібліотеки (PyTorch, TensorFlow, Transformers, FastAPI…) — ~2 ГБ завантаження, 10–30 хв"
    $lock = Join-Path $App "requirements.lock.txt"
    $lockHash = (Get-FileHash $lock).Hash
    if (IsDone "deps" $lockHash) { Ok "уже встановлено" } else {
        Retry { RunPy @("-m", "pip", "install", "--no-warn-script-location", "-r", $lock) "pip install" } "Встановлення бібліотек"
        MarkDone "deps" $lockHash
        Ok "бібліотеки встановлено"
    }

    # ---------------------------------------------------------------- 4. моделі
    Step 4 "Готові моделі (ResNet18, MiniLM, YAMNet, Qwen3-0.6B, PPO CartPole і Acrobot) — ~2 ГБ"
    Push-Location $App
    try { Retry { RunPy @("scripts\download_models.py") "Завантаження моделей" } "Моделі" } finally { Pop-Location }

    # ---------------------------------------------------------------- 5. фото
    Step 5 "Фото з Wikimedia Commons (модуль 1: техніка, артилерія, замасковані позиції, фон)"
    if ($SkipPhotos) { Warn "пропущено (-SkipPhotos). Фото можна додати пізніше в «Центрі даних»." } else {
        Push-Location $App
        try { RunPy @("scripts\collect_images.py", "--per-class", "$PhotosPerClass", "--demo", "2") "Збір фото" }
        catch { Warn "Збір фото не вдався: $($_.Exception.Message). Додайте фото пізніше в «Центрі даних»." }
        finally { Pop-Location }
    }

    # ---------------------------------------------------------------- 6. звуки
    Step 6 "Звуки (модуль 3: Шахеди — Wikimedia Commons; вертоліт, літак, фон — ESC-50)"
    if ($SkipSounds) { Warn "пропущено (-SkipSounds). Звуки можна докачати пізніше в «Центрі даних»." } else {
        Push-Location $App
        try { RunPy @("scripts\collect_audio.py", "--per-class", "$SoundsPerClass") "Збір звуків" }
        catch { Warn "Збір звуків не вдався: $($_.Exception.Message). Докачайте пізніше в «Центрі даних → Аудіо»." }
        finally { Pop-Location }
    }

    # ---------------------------------------------------------------- 7. самоперевірка
    Step 7 "Самоперевірка"
    Push-Location $App
    try { RunPy @("scripts\selftest.py") "Самоперевірка" } catch { Warn $_.Exception.Message } finally { Pop-Location }

    # ---------------------------------------------------------------- 8. ярлик
    Step 8 "Ярлик на робочому столі"
    if ($NoShortcut) { Warn "пропущено" } else {
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "TL-Лабораторія.lnk"))
        $lnk.TargetPath = Join-Path $Root "TL-Lab.bat"
        $lnk.WorkingDirectory = $Root
        $lnk.IconLocation = Join-Path $App "assets\tl-lab.ico"
        $lnk.WindowStyle = 7
        $lnk.Save()
        Ok "ярлик «TL-Лабораторія» створено"
    }

    $size = "{0:N1}" -f ((Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB)
    Write-Host "`n  ГОТОВО. Розмір папки: $size ГБ. Інтернет більше не потрібен." -ForegroundColor Green
    Write-Host "  Запуск: ярлик «TL-Лабораторія» на робочому столі або TL-Lab.bat у цій папці." -ForegroundColor Green
    Write-Host "  Папку TL-Lab можна цілком скопіювати на флешку чи інший ПК — вона портативна.`n"
    $ans = Read-Host "  Запустити програму зараз? (Y/n)"
    if ($ans -notmatch '^[nNнН]') { Start-Process -FilePath (Join-Path $Root "TL-Lab.bat") -WorkingDirectory $Root }
}
catch {
    Write-Host "`n  [X] ПОМИЛКА: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Повний журнал: $(Join-Path $Root 'install.log')" -ForegroundColor Yellow
    Write-Host "  Запустіть INSTALL.bat ще раз — установка продовжиться з місця зупинки." -ForegroundColor Yellow
    Stop-Transcript | Out-Null
    exit 1
}
Stop-Transcript | Out-Null
