// Полный бэкап данных картотеки из Firestore в JSON — тот же формат, что кнопка «⬇ Полный бэкап» в Настройках,
// поэтому файл можно вернуть кнопкой «⬆ Восстановить из бэкапа…».
// Запуск:  node backup-data.js <id проекта Firebase> [папка для бэкапов] [--keep N]
//   --daily  — имя файла kartoteka-daily-… (ежедневный бэкап из Планировщика, tools/backup-task.ps1); обычные бэкапы — kartoteka-full-…
//   --keep N — оставить только N последних бэкапов с тем же началом имени (daily или full); другие файлы не трогаются
//   --sdk    — читать сразу каналом сайта (Firebase SDK). Без флага скрипт переходит на него сам, если REST закрыт суточным лимитом (429 Quota exceeded)
// Вход берётся из Firebase CLI (тот же, что для firebase deploy); только чтение, в базу ничего не пишет.
// Коллекции берутся из самой базы (listCollectionIds), так что новые коллекции попадают в бэкап без правки скрипта.
// Игры (campaigns/<id>/…): основная — в data (как раньше), остальные — в camps.<id>.data.
const fs = require('fs'), path = require('path'), os = require('os');

const argv = process.argv.slice(2), ki = argv.indexOf('--keep'), keep = ki >= 0 ? Math.max(1, parseInt(argv[ki + 1], 10) || 30) : 0, daily = argv.includes('--daily');
const pos = argv.filter((a, i) => !a.startsWith('--') && !(ki >= 0 && i === ki + 1));
const project = pos[0], outDir = path.resolve(pos[1] || 'backups');
if (!project) { console.error('Укажите id проекта: node backup-data.js <projectId> [папка]'); process.exit(2); }

// публичный OAuth-клиент Firebase CLI (firebase-tools/lib/api.js) — им CLI обновляет свой токен
const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

async function accessToken() {
  const store = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(store)) throw new Error('Нет входа в Firebase CLI — выполните: npx firebase-tools login');
  const t = (JSON.parse(fs.readFileSync(store, 'utf8')).tokens) || {};
  if (t.access_token && t.expires_at && t.expires_at > Date.now() + 120000) return t.access_token;
  if (!t.refresh_token) throw new Error('Нет входа в Firebase CLI — выполните: npx firebase-tools login');
  const r = await fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
  const j = await r.json(); if (!j.access_token) throw new Error('Не удалось обновить вход Firebase CLI: ' + JSON.stringify(j).slice(0, 200) + ' — выполните: npx firebase-tools login --reauth');
  return j.access_token;
}

// значение Firestore REST → обычный JSON (как отдаёт веб-SDK)
function val(v) {
  if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue); if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue; if ('nullValue' in v) return null; if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fields(v.mapValue.fields || {}); if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('referenceValue' in v) return v.referenceValue; if ('geoPointValue' in v) return v.geoPointValue; if ('bytesValue' in v) return v.bytesValue;
  return null;
}
function fields(f) { const o = {}; for (const k of Object.keys(f)) o[k] = val(f[k]); return o; }

(async () => {
  // FIRESTORE_EMULATOR_HOST=localhost:8080 — проверка на эмуляторе (вход не нужен)
  const EMU = process.env.FIRESTORE_EMULATOR_HOST;
  const base = (EMU ? `http://${EMU}/v1/` : 'https://firestore.googleapis.com/v1/') + `projects/${project}/databases/(default)/documents`;
  let tok = EMU ? 'owner' : await accessToken();
  const api = async (url, opts = {}) => { for (let i = 0; ; i++) { const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + tok } });
      if (r.ok) return r.json(); const txt = await r.text(); if (r.status === 401 && i === 0 && !EMU) { tok = await accessToken(); continue; }
      // суточный бесплатный лимит базы (тариф Spark) кончился: REST закрыт до сброса, повторять бессмысленно — дальше читаем каналом сайта (sdkOpen)
      if (r.status === 429 && /"Quota exceeded\."/.test(txt)) throw Object.assign(new Error('закончился суточный бесплатный лимит базы Firebase (HTTP 429 «Quota exceeded», тариф Spark). Он сбрасывается в полночь по Калифорнии — 10:00 по Москве (с 1 ноября — 11:00). Сайт можно выложить и сейчас, без бэкапа: выкладка базу не читает'), { quota: true });
      if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`); } };
  const enc = p => p.split('/').map(encodeURIComponent).join('/');

  /* второй путь чтения — как у сайта: Firebase SDK, поток Listen. Когда суточный лимит Spark исчерпан, Google закрывает все REST-запросы (get/list/runQuery/batchGet —
     «429 Quota exceeded»), а поток Listen продолжает отвечать: поэтому кнопка бэкапа на сайте работает, а скрипт — нет (проверено 2026-10-25).
     Пакет firebase ставится один раз в папку sdk рядом со скриптом. Вход — тот же токен Firebase CLI: подсовываем его SDK вместо входа на сайт */
  let SDK = null;
  async function sdkOpen() {
    const dir = path.join(__dirname, 'sdk'), req = require('module').createRequire(path.join(dir, 'package.json'));
    if (!fs.existsSync(path.join(dir, 'node_modules', 'firebase', 'package.json'))) { console.log('  ставлю библиотеку Firebase (один раз, ~30 МБ)…'); fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{ "private": true }');
      require('child_process').execSync('npm install --no-audit --no-fund --silent firebase@11.10.0', { cwd: dir, stdio: 'inherit' }); }
    const A = req('@firebase/app'), { Component } = req('@firebase/component');
    // Firestore ждёт первый сигнал «токен готов» после подписки — поэтому асинхронно (синхронный вызов он пропускает и висит)
    A._registerComponent(new Component('auth-internal', () => ({ getToken: async () => ({ accessToken: await accessToken() }), getUid: () => 'firebase-cli',
      addAuthTokenListener(cb) { setTimeout(() => cb('cli'), 0); }, removeAuthTokenListener() {} }), 'PRIVATE'));
    const F = req('firebase/firestore'), app = A.initializeApp({ projectId: project, apiKey: 'none' }, 'backup');
    SDK = { F, db: F.getFirestore(app) };
  }
  // Listen не умеет перечислять коллекции — берём известный список (тот же, что BK_COLLS в index.html; make-dist сверяет)
  const KNOWN = ['users','meta','dm','characters','orgs','locations','memberships','locLinks','relations','maps','wmaps','wmarkers','wmdraw','wmpriv','docs','images','log','chat','chatdm','trash','cards','cardsets','cardfaces','battles'];
  const collIds = async parent => {
    if (SDK) return parent ? KNOWN.filter(c => c !== 'users') : (await SDK.F.getDocsFromServer(SDK.F.query(SDK.F.collection(SDK.db, 'campaigns'), SDK.F.limit(1)))).size ? ['campaigns', 'site', 'users'] : KNOWN;
    const out = []; let pt = ''; do { const j = await api(base + (parent ? '/' + enc(parent) : '') + ':listCollectionIds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageSize: 100, pageToken: pt || undefined }) }); out.push(...(j.collectionIds || [])); pt = j.nextPageToken; } while (pt); return out.sort(); };

  /* раскладка базы: с 2026-10-21 данные каждой игры лежат в campaigns/<id>/<коллекция>, в корне — только users, campaigns, site (и старый корень-архив после переноса).
     Файл: data = основная игра (main) + users/campaigns/site — его, как и раньше, возвращает кнопка «Восстановить»; остальные игры — в camps.<id>.data.
     Если переноса ещё не было (campaigns/main пуст) — бэкап корня, как раньше */
  const GLOBAL = ['users', 'campaigns', 'site'];
  fs.mkdirSync(outDir, { recursive: true });
  const d0 = new Date(), p2 = n => String(n).padStart(2, '0'); const stamp = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}_${p2(d0.getHours())}-${p2(d0.getMinutes())}`; // местное время
  const prefix = `kartoteka-${daily ? 'daily' : 'full'}-${project}-`;
  const file = path.join(outDir, `${prefix}${stamp}.json`), tmp = file + '.part';
  if (argv.includes('--sdk') && !EMU) await sdkOpen(); // сразу каналом сайта (проверка этого пути)
  let out, total, regDocs, camps, counts, campCounts; const w = s => fs.writeSync(out, s);
  // одна коллекция → JSON-массив; key — имя в файле, src — путь в базе
  async function dump(src, label) { w('['); let n = 0, page = ''; const size = /(^|\/)images$/.test(src) ? 20 : 300;
    const put = o => { if (src === 'campaigns') regDocs[o.id] = o; w((n ? ',' : '') + JSON.stringify(o)); n++; };
    if (SDK) { process.stdout.write(`\r  ${label}: …`); for (const d of (await SDK.F.getDocsFromServer(SDK.F.collection(SDK.db, src))).docs) put({ ...d.data(), id: d.id }); process.stdout.write(`\r  ${label}: ${n}        `); }
    else do { const j = await api(`${base}/${enc(src)}?pageSize=${size}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      for (const d of (j.documents || [])) put({ ...fields(d.fields || {}), id: d.name.split('/').pop() });
      page = j.nextPageToken; process.stdout.write(`\r  ${label}: ${n}        `); } while (page);
    w(']'); total += n; process.stdout.write('\n'); return n; }
  async function block(list) { const counts = {}; w('{'); for (let i = 0; i < list.length; i++) { const [key, src] = list[i]; w((i ? ',' : '') + JSON.stringify(key) + ':'); counts[key] = await dump(src, src); } w('}'); return counts; }
  async function run() { out = fs.openSync(tmp, 'w'); total = 0; regDocs = {}; campCounts = {};
    const rootColls = await collIds('');
    const mainColls = rootColls.includes('campaigns') ? await collIds('campaigns/main') : [];
    camps = mainColls.length;
    const at = Date.now(); w(`{"v":1,"at":${at},"from":"cloud","project":${JSON.stringify(project)},` + (camps ? '"camp":{"id":"main"},' : '') + '"data":');
    const mainList = camps ? [...GLOBAL.filter(c => rootColls.includes(c)).map(c => [c, c]), ...mainColls.map(c => [c, 'campaigns/main/' + c])] : rootColls.map(c => [c, c]);
    counts = await block(mainList);
    if (camps) { w(',"camps":{'); let k = 0;
      for (const id of Object.keys(regDocs).filter(x => x !== 'main').sort()) { const cc = await collIds('campaigns/' + id); if (!cc.length) continue;
        w((k++ ? ',' : '') + JSON.stringify(id) + ':{"name":' + JSON.stringify(regDocs[id].name || '') + ',"data":'); campCounts[id] = await block(cc.map(c => [c, `campaigns/${id}/${c}`])); w(',"counts":' + JSON.stringify(campCounts[id]) + '}'); }
      w('}'); }
    w(`,"counts":${JSON.stringify(counts)}}`); fs.closeSync(out); }
  try { await run(); }
  catch (e) { if (!e.quota || SDK || EMU) throw e; fs.closeSync(out);
    console.log('\n  REST-запросы к базе закрыты суточным лимитом Firebase — читаю тем же каналом, что сайт (кнопка «Полный бэкап»)…');
    await sdkOpen(); await run(); }
  // проверка: файл читается как JSON и числа совпадают
  const chk = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  for (const [c, n] of Object.entries(counts)) if ((chk.data[c] || []).length !== n) throw new Error('проверка не сошлась на ' + c);
  for (const [id, cc] of Object.entries(campCounts)) for (const [c, n] of Object.entries(cc)) if ((chk.camps[id].data[c] || []).length !== n) throw new Error(`проверка не сошлась на ${id}/${c}`);
  fs.renameSync(tmp, file);
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`OK ${total} документов${camps ? `, игр: ${1 + Object.keys(campCounts).length}` : ''}, ${mb} МБ → ${file}`);
  if (keep) { // старые бэкапы этого проекта сверх N последних — удалить (имя содержит дату, поэтому сортировка по имени = по времени)
    const mine = fs.readdirSync(outDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort().reverse();
    for (const f of mine.slice(keep)) { try { fs.unlinkSync(path.join(outDir, f)); console.log('удалён старый бэкап: ' + f); } catch (e) { console.error('не удалось удалить ' + f + ': ' + e.message); } } }
  if (SDK) { await SDK.F.terminate(SDK.db); setTimeout(() => process.exit(0), 1000).unref(); } // открытый поток gRPC не даёт процессу завершиться
})().catch(e => { console.error('ОШИБКА бэкапа: ' + e.message); process.exit(1); });
