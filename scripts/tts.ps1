# КАРТОЧКИ → TABLETOP SIMULATOR — запускается двойным кликом по 4_KARTY_V_TTS.cmd
# 1) забирает из базы картинки карт (их рисует сайт, когда мастер открывает раздел «Карточки»),
# 2) выкладывает новые картинки на ваш сайт (папка /tts/) — только картинки, сам сайт не меняется,
# 3) кладёт колоды в TTS: Объекты → Сохранённые объекты → Картотека; если игра открыта — может положить их прямо на стол.
. (Join-Path $PSScriptRoot 'common.ps1')
Clear-Host
Say '=== Картотека DnD — карточки в Tabletop Simulator ===' Magenta
$cfg = Load-Settings
if (-not $cfg -or -not $cfg.projectId) { Bad 'Сайт ещё не установлен (нет файла moi-nastroyki.json). Сначала запустите 1_USTANOVKA.cmd.'; Pause-Enter 'Enter — закрыть'; exit 1 }
if (-not (Has-Node)) { Bad 'Не найден Node.js. Запустите 1_USTANOVKA.cmd — он его поставит.'; Pause-Enter 'Enter — закрыть'; exit 1 }
$who = FBJson login:list
if (-not ($who -and $who.result -and @($who.result).Count)) {
  Warn 'Нужно снова войти в Google — откроется браузер.'
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; & npx.cmd --yes $FbVer login; $ErrorActionPreference = $old
}
# картинки выкладываются вместе с уже собранным сайтом из папки site (её собирает 2_OBNOVIT_SAIT.cmd); если её нет — соберём
if (-not (Test-Path (Join-Path (Join-Path $SiteDir 'public') 'index.html'))) { Build-Site $cfg; Ok 'Сайт собран из папки app' }
$docs = [Environment]::GetFolderPath('MyDocuments')
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { & node.exe (Join-Path $PSScriptRoot 'tts-sync.js') $cfg.projectId --site $SiteDir --docs $docs --fb $FbVer | Out-Host } finally { $ErrorActionPreference = $old }
Pause-Enter 'Enter — закрыть окно'
