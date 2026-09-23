// Полный бэкап данных картотеки из Firestore в JSON — тот же формат, что кнопка «⬇ Полный бэкап» в Настройках,
// поэтому файл можно вернуть кнопкой «⬆ Восстановить из бэкапа…».
// Запуск:  node backup-data.js <id проекта Firebase> [папка для бэкапов]
// Вход берётся из Firebase CLI (тот же, что для firebase deploy); только чтение, в базу ничего не пишет.
// Коллекции берутся из самой базы (listCollectionIds), так что новые коллекции попадают в бэкап без правки скрипта.
const fs = require('fs'), path = require('path'), os = require('os');

const project = process.argv[2], outDir = path.resolve(process.argv[3] || 'backups');
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
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  let tok = await accessToken();
  const api = async (url, opts = {}) => { for (let i = 0; ; i++) { const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + tok } });
      if (r.ok) return r.json(); const txt = await r.text(); if (r.status === 401 && i === 0) { tok = await accessToken(); continue; }
      if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`); } };

  let colls = [], pt = ''; do { const j = await api(base + ':listCollectionIds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageSize: 100, pageToken: pt || undefined }) }); colls.push(...(j.collectionIds || [])); pt = j.nextPageToken; } while (pt);
  colls.sort();
  fs.mkdirSync(outDir, { recursive: true });
  const d0 = new Date(), p2 = n => String(n).padStart(2, '0'); const stamp = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}_${p2(d0.getHours())}-${p2(d0.getMinutes())}`; // местное время
  const file = path.join(outDir, `kartoteka-full-${project}-${stamp}.json`), tmp = file + '.part';
  const out = fs.openSync(tmp, 'w'); const w = s => fs.writeSync(out, s);
  const at = Date.now(); w(`{"v":1,"at":${at},"from":"cloud","project":${JSON.stringify(project)},"data":{`);
  const counts = {}; let total = 0;
  for (let ci = 0; ci < colls.length; ci++) { const c = colls[ci]; w((ci ? ',' : '') + JSON.stringify(c) + ':['); let n = 0, page = '';
    const size = c === 'images' ? 20 : 300;
    do { const j = await api(`${base}/${encodeURIComponent(c)}?pageSize=${size}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      for (const d of (j.documents || [])) { const id = d.name.split('/').pop(); w((n ? ',' : '') + JSON.stringify({ ...fields(d.fields || {}), id })); n++; }
      page = j.nextPageToken; process.stdout.write(`\r  ${c}: ${n}        `); } while (page);
    w(']'); counts[c] = n; total += n; process.stdout.write('\n'); }
  w(`},"counts":${JSON.stringify(counts)}}`); fs.closeSync(out);
  // проверка: файл читается как JSON и числа совпадают
  const chk = JSON.parse(fs.readFileSync(tmp, 'utf8')); for (const c of colls) if ((chk.data[c] || []).length !== counts[c]) throw new Error('проверка не сошлась на ' + c);
  fs.renameSync(tmp, file);
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`OK ${total} документов, ${mb} МБ → ${file}`);
})().catch(e => { console.error('ОШИБКА бэкапа: ' + e.message); process.exit(1); });
