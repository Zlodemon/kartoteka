# УСТАНОВКА КАРТОТЕКИ — запускается двойным кликом по 1_USTANOVKA.cmd
. (Join-Path $PSScriptRoot 'common.ps1')
Clear-Host
Say '╔══════════════════════════════════════════════════════════════╗' Magenta
Say '║        Картотека DnD — установка своего сервера              ║' Magenta
Say '╚══════════════════════════════════════════════════════════════╝' Magenta
Say 'Скрипт сам создаст сервер в Firebase (бесплатно) и выложит на него сайт.'
Say 'От вас нужно: войти в Google в браузере и пару раз нажать кнопки там, где скрипт попросит.'
Say 'Окно НЕ закрывайте, пока не увидите «ГОТОВО». Можно прерваться и запустить снова — скрипт продолжит.'

$cfg = Load-Settings
if (-not $cfg) { $cfg = [pscustomobject]@{ projectId = ''; dmEmails = @(); firebase = $null; done = $false } }

# ---------- 1. Node.js ----------
Step 1 'Проверяю Node.js (нужен для работы с Firebase)'
if (Has-Node) { Ok 'Node.js уже установлен' }
else {
  Warn 'Node.js не найден — пробую установить автоматически (Windows может спросить разрешение — нажмите «Да»)'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) { & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Host }
  if (-not (Has-Node)) {
    Bad 'Автоматически установить не получилось.'
    Say '  Сейчас откроется сайт nodejs.org. Скачайте большую зелёную кнопку «LTS», установите (всё время «Next»),' Yellow
    Say '  потом ЗАКРОЙТЕ это окно и снова запустите 1_USTANOVKA.cmd.' Yellow
    Start-Process 'https://nodejs.org/'
    Pause-Enter 'Нажмите Enter, чтобы закрыть окно'; exit 1
  }
  Ok 'Node.js установлен'
}

# ---------- 2. Вход в Google ----------
Step 2 'Вход в ваш Google-аккаунт'
Say '  Сейчас откроется браузер. Выберите аккаунт Google, от которого будет сервер, и нажмите «Разрешить».'
Say '  Если в этом окне спросят «Enable Gemini…» или «Allow Firebase to collect…» — напечатайте n и нажмите Enter.'
Say '  (Первый запуск может минуту-две что-то скачивать — это нормально.)'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& npx.cmd --yes $FbVer login
$ErrorActionPreference = $old
$who = FBJson login:list
$acc = if ($who -and $who.result -and $who.result.Count) { $who.result[0].user.email } else { '' }
if (-not $acc) { Bad 'Вход не выполнен. Запустите 1_USTANOVKA.cmd ещё раз.'; Pause-Enter 'Enter — закрыть'; exit 1 }
Ok "Вы вошли как $acc"

# ---------- 3. Почта мастера ----------
Step 3 'Кто будет мастером'
if (-not $cfg.dmEmails -or -not @($cfg.dmEmails).Count) {
  Say '  Мастер — тот, кто ведёт игру и видит всё. Обычно это вы. Можно несколько почт через запятую.'
  $m = Ask 'Почта Google мастера' $acc
  $cfg.dmEmails = @($m -split '[,; ]+' | Where-Object { $_ -match '@' } | ForEach-Object { $_.Trim().ToLower() })
}
Ok ('Мастер: ' + (@($cfg.dmEmails) -join ', '))
Save-Settings $cfg

# ---------- 4. Проект Firebase ----------
Step 4 'Сервер (проект Firebase)'
# список проектов аккаунта (ID и отображаемые имена); $null — если получить не удалось
$plist = FBJson projects:list
$projects = if ($plist -and $plist.result) { @($plist.result) } else { $null }
function Find-Project($name) {
  if ($null -eq $projects) { return $name }   # список недоступен — верим на слово
  $p = $projects | Where-Object { $_.projectId -eq $name } | Select-Object -First 1
  if (-not $p) { $p = $projects | Where-Object { $_.displayName -eq $name } | Select-Object -First 1 }
  if ($p) { return $p.projectId } return $null
}
if ($cfg.projectId -and $null -ne $projects -and -not (Find-Project $cfg.projectId)) {
  Warn "Проект $($cfg.projectId) из прошлого запуска не найден в аккаунте $acc — выберем заново."
  $cfg.projectId = ''
}
if (-not $cfg.projectId) {
  Say '  Имя проекта станет адресом сайта: <имя>.web.app. Только латиница в нижнем регистре, цифры и дефис, 6–30 символов.'
  Say '  Например: dnd-dragon-table. Если такое имя занято — скрипт попросит другое.'
  $rnd = -join ((48..57) + (97..122) | Get-Random -Count 5 | ForEach-Object { [char]$_ })
  while (-not $cfg.projectId) {
    $id = (Ask 'Имя проекта' ("dnd-kartoteka-" + $rnd)).Trim()
    $existing = if ($projects) { Find-Project $id } else { $null }
    if ($existing) {
      if (YesNo "В вашем аккаунте уже есть проект $existing — использовать его?" 'да') { $cfg.projectId = $existing; break }
      continue
    }
    $id = $id.ToLower()
    if ($id -notmatch '^[a-z][a-z0-9-]{5,29}$') { Bad 'Имя не подходит: начните с буквы, 6–30 символов, только a-z, 0-9 и «-».'; continue }
    if (YesNo "У вас УЖЕ есть проект Firebase с именем $id и вы хотите использовать его?" 'нет') {
      if ($null -eq $projects) { $cfg.projectId = $id; break }
      Bad "В аккаунте $acc нет проекта с ID или названием «$id»."
      if ($projects.Count) {
        Say '  Ваши проекты (вводите ID — левую колонку):' Yellow
        foreach ($p in $projects) { Say ("   • " + $p.projectId + "   (" + $p.displayName + ")") Yellow }
      } else { Say '  В этом аккаунте вообще нет проектов Firebase — возможно, вы вошли не тем Google-аккаунтом.' Yellow }
      continue
    }
    Say '  Создаю проект… (до пары минут)'
    if (FB projects:create $id -n 'DnD Kartoteka') { $cfg.projectId = $id; Ok "Проект $id создан" }
    else {
      Bad 'Создать проект не получилось. Частые причины:'
      Say '   • имя занято — попробуйте другое;' Yellow
      Say '   • вы ещё ни разу не заходили в консоль Firebase — нужно один раз принять условия.' Yellow
      Say '     Откроется https://console.firebase.google.com — войдите тем же аккаунтом, если попросят — примите условия, потом вернитесь сюда.' Yellow
      Start-Process 'https://console.firebase.google.com/'
      Say '   • или создайте проект там вручную («Создать проект», Google Analytics можно выключить) и введите здесь его ID (он под названием проекта).' Yellow
    }
  }
  Save-Settings $cfg
}
Ok "Проект: $($cfg.projectId)"
$P = $cfg.projectId

# ---------- 5. Веб-приложение и ключи ----------
Step 5 'Регистрирую сайт в проекте и получаю ключи'
$apps = FBJson apps:list WEB --project $P
$appId = if ($apps -and $apps.result -and @($apps.result).Count) { @($apps.result)[0].appId } else { $null }
if (-not $appId) { $r = FBJson apps:create WEB 'Kartoteka' --project $P; if ($r -and $r.result) { $appId = $r.result.appId } }
if (-not $appId) {
  Bad "Не удалось зарегистрировать сайт в проекте $P."
  $err = if ($r -and $r.error) { $r.error } elseif ($apps -and $apps.error) { $apps.error } else { '' }
  if ($err) { Say "  Ответ Firebase: $err" Yellow }
  Say "  Частые причины: проект $P принадлежит другому Google-аккаунту (вы вошли как $acc)," Yellow
  Say '  или введено название проекта, а не его ID (ID виден в консоли Firebase под названием проекта).' Yellow
  $cfg.projectId = ''; Save-Settings $cfg
  Say '  Запустите 1_USTANOVKA.cmd ещё раз — скрипт снова спросит проект.' Yellow
  Pause-Enter 'Enter — закрыть'; exit 1
}
Ok 'Сайт зарегистрирован'

# ---------- 6. База данных Firestore ----------
Step 6 'Создаю основную базу данных (Firestore)'
$ok = FB firestore:databases:create '(default)' --location eur3 --project $P
if ($ok) { Ok 'База создана (Европа)' }
else {
  Warn 'Скрипт не смог создать базу сам — возможно, она уже есть (тогда всё в порядке).'
  if (-not (YesNo 'База Firestore в проекте уже есть? (если не знаете — ответьте «нет»)' 'нет')) {
    Say '  Откроется консоль Firebase → Firestore Database. Нажмите «Создать базу данных» (Create database):' Yellow
    Say '   1) выпуск Standard → Далее;  2) расположение eur3 (Europe) → Далее;  3) «Начать в рабочем режиме» (production) → Создать.' Yellow
    Start-Process "https://console.firebase.google.com/project/$P/firestore"
    Pause-Enter
  }
}

# ---------- 7. Живая база (Realtime Database) ----------
Step 7 'Создаю «живую» базу для пингов, линейки и стрелок (Realtime Database)'
$inst = FBJson database:instances:list --project $P
$hasRtdb = $inst -and $inst.result -and @($inst.result).Count
if (-not $hasRtdb) {
  $ok = FB database:instances:create "$P-default-rtdb" --location europe-west1 --project $P
  $inst = FBJson database:instances:list --project $P
  $hasRtdb = $inst -and $inst.result -and @($inst.result).Count
}
if (-not $hasRtdb) {
  Warn 'Автоматически не получилось — нужно нажать пару кнопок.'
  Say '  Откроется консоль Firebase → Realtime Database. Нажмите «Создать базу данных» (Create Database):' Yellow
  Say '   1) расположение «Бельгия (europe-west1)» → Далее;  2) «Начать в заблокированном режиме» (locked mode) → Включить.' Yellow
  Start-Process "https://console.firebase.google.com/project/$P/database"
  Pause-Enter
  $inst = FBJson database:instances:list --project $P
}
$dbUrl = if ($inst -and $inst.result -and @($inst.result).Count) { @($inst.result)[0].databaseUrl } else { "https://$P-default-rtdb.europe-west1.firebasedatabase.app" }
Ok "Живая база: $dbUrl"

# ---------- 8. Ключи сайта ----------
$sdk = FBJson apps:sdkconfig WEB $appId --project $P
$c = if ($sdk -and $sdk.result) { $sdk.result.sdkConfig } else { $null }
if (-not $c -or -not $c.apiKey) { Bad 'Не удалось получить ключи сайта. Запустите установку ещё раз.'; Pause-Enter 'Enter — закрыть'; exit 1 }
$cfg.firebase = [pscustomobject]@{ apiKey = $c.apiKey; authDomain = $c.authDomain; projectId = $c.projectId; databaseURL = $(if ($c.databaseURL) { $c.databaseURL } else { $dbUrl }); storageBucket = $c.storageBucket; messagingSenderId = $c.messagingSenderId; appId = $c.appId }
Save-Settings $cfg
Ok 'Ключи сохранены в moi-nastroyki.json'

# ---------- 9. Вход через Google (единственное, что нельзя сделать скриптом) ----------
Step 8 'Включаем вход на сайт через Google — это нужно сделать руками (1 минута)'
Say '  Откроется консоль Firebase → Authentication → «Способ входа» (Sign-in method).' Yellow
Say '   1) Если видите кнопку «Начать» (Get started) — нажмите её.' Yellow
Say '   2) В списке поставщиков выберите «Google».' Yellow
Say '   3) Включите переключатель «Включить» (Enable).' Yellow
Say '   4) В поле «Адрес электронной почты службы поддержки» выберите свою почту.' Yellow
Say '   5) Нажмите «Сохранить» (Save). Напротив Google должно появиться «Включено».' Yellow
Start-Process "https://console.firebase.google.com/project/$P/authentication/providers"
Pause-Enter 'Когда напротив Google стоит «Включено» — нажмите Enter'

# ---------- 10. Выкладываем сайт ----------
Step 9 'Собираю и выкладываю сайт'
Build-Site $cfg
Ok 'Сайт собран'
if (Deploy-Site $cfg) {
  $cfg.done = $true; Save-Settings $cfg
  $url = "https://$P.web.app"
  Set-Content -Path (Join-Path $Root 'MOI-SAIT.txt') -Encoding UTF8 -Value @("Адрес вашей картотеки: $url", "Проект Firebase: $P", "Консоль: https://console.firebase.google.com/project/$P", "Мастер: " + (@($cfg.dmEmails) -join ', '))
  Write-Host ''
  Say '╔══════════════════════════════════════════════════════════════╗' Green
  Say '║                          ГОТОВО!                             ║' Green
  Say '╚══════════════════════════════════════════════════════════════╝' Green
  Say "  Ваш сайт: $url" Green
  Say '  Адрес сохранён в файле MOI-SAIT.txt. Откройте сайт, войдите через Google (почтой мастера) — вы мастер.'
  Say '  Игрокам просто отправьте ссылку. Когда они войдут, назначьте им роль «игрок» в разделе «Участники».'
  Start-Process $url
} else {
  Bad 'Выложить сайт не получилось — посмотрите сообщение выше.'
  Say '  Чаще всего помогает просто запустить 1_USTANOVKA.cmd ещё раз (всё уже сделанное скрипт пропустит).' Yellow
  Say '  Если ошибка про Firestore или Realtime Database — проверьте шаги 6 и 7 в инструкции.' Yellow
}
Pause-Enter 'Enter — закрыть окно'
