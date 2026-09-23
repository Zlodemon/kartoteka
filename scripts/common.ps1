# Общие функции для установки и обновления картотеки. Запускать не нужно — их подключают setup.ps1 и deploy.ps1.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Root     = Split-Path -Parent $PSScriptRoot          # папка kartoteka
$AppDir   = Join-Path $Root 'app'                     # шаблон сайта (заменяется при обновлении)
$SiteDir  = Join-Path $Root 'site'                    # собранный сайт с вашими настройками
$Settings = Join-Path $Root 'moi-nastroyki.json'      # ваши настройки: проект, почта мастера, ключи
$FbVer    = 'firebase-tools@15'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step($n, $t) { Write-Host ''; Write-Host ("=== Шаг $n. $t ===") -ForegroundColor Cyan }
function Ok($t)   { Write-Host ("  ✔ " + $t) -ForegroundColor Green }
function Warn($t) { Write-Host ("  ! " + $t) -ForegroundColor Yellow }
function Bad($t)  { Write-Host ("  ✖ " + $t) -ForegroundColor Red }
function Pause-Enter($t = 'Когда сделаете — нажмите Enter, чтобы продолжить') { Write-Host ''; Read-Host ("  → " + $t) | Out-Null }
function Ask($q, $def = '') { $a = Read-Host ("  → " + $q + $(if ($def) { " [$def]" } else { '' })); if ([string]::IsNullOrWhiteSpace($a)) { return $def } return $a.Trim() }
function YesNo($q, $def = 'да') { $a = (Ask ($q + ' (да/нет)') $def).ToLower(); return ($a -in @('да','д','y','yes','ok','+')) }

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
function Has-Node { Refresh-Path; return [bool](Get-Command npx.cmd -ErrorAction SilentlyContinue) }

# вызвать Firebase CLI (через npx — ставить ничего вручную не нужно); вывод — прямо в окно; возвращает $true при успехе
function FB {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & npx.cmd --yes $FbVer @args | Out-Host; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
}
# вызвать Firebase CLI и получить JSON-ответ (или $null при ошибке)
function FBJson {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = (& npx.cmd --yes $FbVer @args --json 2>$null | Out-String) } finally { $ErrorActionPreference = $old }
  $i = $raw.IndexOf('{'); if ($i -lt 0) { return $null }
  try { return ($raw.Substring($i) | ConvertFrom-Json) } catch { return $null }
}

function Load-Settings { if (Test-Path $Settings) { return (Get-Content $Settings -Raw -Encoding UTF8 | ConvertFrom-Json) } return $null }
function Save-Settings($o) { $o | ConvertTo-Json -Depth 6 | Set-Content -Path $Settings -Encoding UTF8 }

# собрать сайт: шаблон из app + ваши настройки → папка site
function Build-Site($cfg) {
  if (-not (Test-Path (Join-Path $AppDir 'index.html'))) { throw "Не найдена папка app с файлами сайта ($AppDir)" }
  New-Item -ItemType Directory -Force -Path (Join-Path $SiteDir 'public') | Out-Null
  $fb = [ordered]@{ apiKey = $cfg.firebase.apiKey; authDomain = $cfg.firebase.authDomain; projectId = $cfg.firebase.projectId; databaseURL = $cfg.firebase.databaseURL; storageBucket = $cfg.firebase.storageBucket; messagingSenderId = $cfg.firebase.messagingSenderId; appId = $cfg.firebase.appId }
  $fbJson = ($fb | ConvertTo-Json -Compress)
  $emails = @($cfg.dmEmails | ForEach-Object { $_.ToString().Trim().ToLower() } | Where-Object { $_ })
  $jsEmails = ($emails | ForEach-Object { '"' + $_ + '"' }) -join ', '
  $rulesEmails = ($emails | ForEach-Object { "'" + $_ + "'" }) -join ', '
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $html = [IO.File]::ReadAllText((Join-Path $AppDir 'index.html'), $utf8)
  if (-not $html.Contains('{"__FIREBASE__":1}')) { throw 'В app\index.html нет метки настроек Firebase — возможно, файл повреждён' }
  $html = $html.Replace('{"__FIREBASE__":1}', $fbJson).Replace('["__DM_EMAILS__"]', '[' + $jsEmails + ']')
  [IO.File]::WriteAllText((Join-Path $SiteDir 'public\index.html'), $html, $utf8)
  Copy-Item (Join-Path $AppDir 'techniques-base.js') (Join-Path $SiteDir 'public\techniques-base.js') -Force
  $rules = [IO.File]::ReadAllText((Join-Path $AppDir 'firestore.rules'), $utf8).Replace("['__DM_EMAILS__']", '[' + $rulesEmails + ']')
  [IO.File]::WriteAllText((Join-Path $SiteDir 'firestore.rules'), $rules, $utf8)
  foreach ($f in 'database.rules.json','firestore.indexes.json','firebase.json') { Copy-Item (Join-Path $AppDir $f) (Join-Path $SiteDir $f) -Force }
  [IO.File]::WriteAllText((Join-Path $SiteDir '.firebaserc'), ('{ "projects": { "default": "' + $cfg.projectId + '" } }'), $utf8)
}

# выложить сайт и правила баз в интернет
function Deploy-Site($cfg) {
  Push-Location $SiteDir
  try { $ok = FB deploy --only 'hosting,firestore:rules,database' --project $cfg.projectId --non-interactive } finally { Pop-Location }
  return $ok
}

# ===== обновление с GitHub и бэкап данных =====
$Repo      = 'Zlodemon/kartoteka'                               # владелец/репозиторий на GitHub, откуда берутся обновления
$BackupDir = Join-Path $Root 'backups'                # сюда кладутся бэкапы данных перед каждым обновлением
$KeepBackups = 20

# скачать последнюю версию пакета; ваши moi-nastroyki.json, site и backups не трогаются.
# Возвращает 'updated' | 'same' | 'skip' (адрес не задан) | 'failed'
function Update-FromGitHub {
  if (-not $Repo -or $Repo.StartsWith('__')) { return 'skip' }
  $tmp = Join-Path $env:TEMP ('kartoteka-upd-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile "$tmp.zip" -UseBasicParsing } finally { $ProgressPreference = $old }
    Expand-Archive -Path "$tmp.zip" -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'app\index.html'))) { Warn 'В скачанном архиве нет app\index.html'; return 'failed' }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    if (-not [IO.File]::ReadAllText((Join-Path $src.FullName 'app\index.html'), $utf8).Contains('{"__FIREBASE__":1}')) { Warn 'Скачанный app\index.html не похож на шаблон'; return 'failed' }
    $newVer = (Get-Content (Join-Path $src.FullName 'app\VERSION.txt') -Raw -Encoding UTF8).Trim()
    $curFile = Join-Path $AppDir 'VERSION.txt'; $curVer = if (Test-Path $curFile) { (Get-Content $curFile -Raw -Encoding UTF8).Trim() } else { '' }
    Say "  Сейчас:   $(if ($curVer) { $curVer } else { 'неизвестно' })"
    Say "  На GitHub: $newVer"
    if ($newVer -eq $curVer) { return 'same' }
    # папку app меняем целиком, но через подмену: старая удаляется только после того, как новая на месте
    $newApp = Join-Path $Root 'app.new'; $oldApp = Join-Path $Root 'app.old'
    foreach ($d in $newApp, $oldApp) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
    Copy-Item (Join-Path $src.FullName 'app') $newApp -Recurse -Force
    if (Test-Path $AppDir) { Rename-Item $AppDir 'app.old' }
    Rename-Item $newApp 'app'
    if (Test-Path $oldApp) { Remove-Item $oldApp -Recurse -Force }
    foreach ($d in 'scripts', 'docs') { $s = Join-Path $src.FullName $d; if (Test-Path $s) { Copy-Item (Join-Path $s '*') (Join-Path $Root $d) -Recurse -Force } }
    Get-ChildItem $src.FullName -File | Where-Object { $_.Extension -in '.cmd', '.html', '.txt' } | ForEach-Object { Copy-Item $_.FullName (Join-Path $Root $_.Name) -Force }
    return 'updated'
  } catch { Warn ('Ошибка обновления: ' + $_.Exception.Message); return 'failed' }
  finally { Remove-Item "$tmp.zip" -Force -ErrorAction SilentlyContinue; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# полный бэкап базы в backups\ (тот же формат, что кнопка «Полный бэкап» в Настройках); старые сверх $KeepBackups удаляются
function Backup-Data($cfg) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & node.exe (Join-Path $PSScriptRoot 'backup-data.js') $cfg.projectId $BackupDir | Out-Host; $ok = ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
  if ($ok) { Get-ChildItem $BackupDir -Filter 'kartoteka-full-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups | Remove-Item -Force -ErrorAction SilentlyContinue }
  return $ok
}
