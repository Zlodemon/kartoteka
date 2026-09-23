# СМЕНА МАСТЕРОВ — запускается двойным кликом по 3_SMENIT_MASTEROV.cmd
. (Join-Path $PSScriptRoot 'common.ps1')
Clear-Host
Say '=== Картотека DnD — кто мастер ===' Magenta
$cfg = Load-Settings
if (-not $cfg -or -not $cfg.firebase) { Bad 'Сайт ещё не установлен. Сначала запустите 1_USTANOVKA.cmd.'; Pause-Enter 'Enter — закрыть'; exit 1 }
Say ('  Сейчас мастер: ' + (@($cfg.dmEmails) -join ', '))
Say '  Эти почты при входе на сайт всегда становятся мастерами. Остальным роли выдаются на сайте в разделе «Участники».'
$m = Ask 'Новый список почт мастеров через запятую (Enter — оставить как есть)' ''
if ($m) {
  $cfg.dmEmails = @($m -split '[,; ]+' | Where-Object { $_ -match '@' } | ForEach-Object { $_.Trim().ToLower() })
  if (-not @($cfg.dmEmails).Count) { Bad 'Не нашёл ни одной почты — ничего не меняю.'; Pause-Enter 'Enter — закрыть'; exit 1 }
  Save-Settings $cfg; Ok ('Мастер: ' + (@($cfg.dmEmails) -join ', '))
  Build-Site $cfg
  if (Deploy-Site $cfg) { Ok 'Сайт обновлён.' } else { Bad 'Выложить не получилось — попробуйте 2_OBNOVIT_SAIT.cmd.' }
}
Pause-Enter 'Enter — закрыть окно'
