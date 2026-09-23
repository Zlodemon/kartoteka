# ОБНОВЛЕНИЕ САЙТА — запускается двойным кликом по 2_OBNOVIT_SAIT.cmd
# 1) скачивает последнюю версию с GitHub (ваши настройки moi-nastroyki.json не трогаются),
# 2) делает полный бэкап данных в папку backups,
# 3) собирает сайт с вашими настройками и выкладывает его. Данные в базе при обновлении не меняются.
param([switch]$Updated)
. (Join-Path $PSScriptRoot 'common.ps1')
Clear-Host
Say '=== Картотека DnD — обновление сайта ===' Magenta
$cfg = Load-Settings
if (-not $cfg -or -not $cfg.firebase -or -not $cfg.projectId) {
  Bad 'Сайт ещё не установлен (нет файла moi-nastroyki.json). Сначала запустите 1_USTANOVKA.cmd.'
  Pause-Enter 'Enter — закрыть'; exit 1
}
if (-not (Has-Node)) { Bad 'Не найден Node.js. Запустите 1_USTANOVKA.cmd — он его поставит.'; Pause-Enter 'Enter — закрыть'; exit 1 }

if (-not $Updated) {
  Step 1 'Проверяю, есть ли новая версия'
  $r = Update-FromGitHub
  if ($r -eq 'updated') {
    Ok 'Новая версия скачана. Продолжаю уже с ней…'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'deploy.ps1') -Updated
    exit $LASTEXITCODE
  }
  elseif ($r -eq 'same') {
    Ok 'У вас уже последняя версия.'
    if (-not (YesNo 'Всё равно перевыложить сайт?' 'нет')) { Pause-Enter 'Enter — закрыть окно'; exit 0 }
  }
  elseif ($r -eq 'skip') { Warn 'Адрес GitHub не задан — выложу то, что лежит в папке app.' }
  else { Warn 'Не удалось скачать обновление (нет интернета или GitHub недоступен) — выложу то, что лежит в папке app.' }
}
$ver = Join-Path $AppDir 'VERSION.txt'; if (Test-Path $ver) { Say ('  ' + (Get-Content $ver -Raw -Encoding UTF8).Trim()) }
Say "  Проект: $($cfg.projectId)   Мастер: $(@($cfg.dmEmails) -join ', ')"

$who = FBJson login:list
if (-not ($who -and $who.result -and @($who.result).Count)) {
  Warn 'Нужно снова войти в Google — откроется браузер.'
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; & npx.cmd --yes $FbVer login; $ErrorActionPreference = $old
}

Step 2 'Бэкап данных (на случай, если что-то пойдёт не так)'
if (Backup-Data $cfg) { Ok "Бэкап лежит в папке backups. Вернуть его: Настройки → «⬆ Восстановить из бэкапа…»" }
else {
  Bad 'Бэкап сделать не удалось (сообщение выше).'
  if (-not (YesNo 'Продолжить обновление БЕЗ бэкапа?' 'нет')) { Pause-Enter 'Enter — закрыть окно'; exit 1 }
}

Step 3 'Выкладываю сайт'
Build-Site $cfg; Ok 'Сайт собран'
if (Deploy-Site $cfg) { Ok "Готово! Сайт обновлён: https://$($cfg.projectId).web.app"; Say '  Игрокам достаточно обновить страницу (F5).' }
else { Bad 'Выложить не получилось — посмотрите сообщение выше и попробуйте ещё раз. Данные не тронуты.' }
Pause-Enter 'Enter — закрыть окно'
