// Перенос данных картотеки в папку игры: корневые коллекции (characters, meta, maps, …) копируются в campaigns/main/<коллекция>.
// Нужен один раз при переходе на версию с несколькими играми (2026-10-21). Корень НЕ удаляется — остаётся архивом.
// Запуск:  node migrate-camps.js <id проекта Firebase> [папка для отчёта] [--delta] [--dry]
//   без флагов — перенос; если есть отчёт migrate-<проект>.json или в campaigns/main уже есть данные, ничего не делает (можно запускать при каждом обновлении).
//                При отчёте база вовсе не читается; --again — всё равно проверить по базе
//   --delta    — после выкладки новой версии: докопировать то, что старые вкладки успели поменять в корне после переноса
//                (берёт отчёт migrate-<проект>.json; если документ уже правили в новой папке — не трогает и сообщает).
//                Делается один раз: после выкладки правила не пускают писать в корень, он больше не меняется, а перечитывать
//                его при каждом обновлении — лишние чтения из суточного лимита. Повторить вручную — --delta --again
//   --dry      — только показать, что будет сделано
// Вход берётся из Firebase CLI (тот же, что для firebase deploy). Документы копируются байт в байт (поля в формате Firestore REST).
const fs = require('fs'), path = require('path'), os = require('os');

const argv = process.argv.slice(2), delta = argv.includes('--delta'), dry = argv.includes('--dry'), again = argv.includes('--again');
const pos = argv.filter(a => !a.startsWith('--'));
const project = pos[0], outDir = path.resolve(pos[1] || 'backups');
if (!project) { console.error('Укажите id проекта: node migrate-camps.js <projectId> [папка]'); process.exit(2); }
const GLOBAL = new Set(['users', 'campaigns', 'site']), DEST = 'campaigns/main';
const manifestFile = path.join(outDir, `migrate-${project}.json`);

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

(async () => {
  // дельта уже была — корень с тех пор не меняется, базу не читаем вовсе
  if (delta && !again && fs.existsSync(manifestFile)) { const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (m.deltaAt) { console.log(`Дельта переноса уже сделана ${new Date(m.deltaAt).toLocaleString('ru-RU')} — старый корень больше не меняется, перечитывать не нужно.`); return; } }
  // перенос уже сделан и проверен (есть отчёт) — базу не трогаем, обновление от неё не зависит. Перепроверить по базе — --again
  if (!delta && !again && fs.existsSync(manifestFile)) { const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (m.end) { console.log(`Перенос уже сделан ${new Date(m.end).toLocaleString('ru-RU')} (отчёт ${manifestFile}) — базу не читаю.`); return; } }
  if (delta && !fs.existsSync(manifestFile)) { console.log('Нет отчёта переноса (' + manifestFile + ') — докопировать нечего.'); return; }
  // FIRESTORE_EMULATOR_HOST=localhost:8080 — проверка на эмуляторе (вход не нужен)
  const EMU = process.env.FIRESTORE_EMULATOR_HOST;
  const root = `projects/${project}/databases/(default)/documents`, base = (EMU ? `http://${EMU}/v1/` : 'https://firestore.googleapis.com/v1/') + root;
  let tok = EMU ? 'owner' : await accessToken();
  const api = async (url, opts = {}, allow404) => { for (let i = 0; ; i++) { const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + tok } });
      if (r.ok) return r.json(); if (r.status === 404 && allow404) return null; const txt = await r.text(); if (r.status === 401 && i === 0 && !EMU) { tok = await accessToken(); continue; }
      // суточный бесплатный лимит базы (тариф Spark) кончился — повторять бессмысленно, до сброса не пройдёт
      if (r.status === 429 && /"Quota exceeded\."/.test(txt)) throw new Error('закончился суточный бесплатный лимит базы Firebase (HTTP 429 «Quota exceeded», тариф Spark). Он сбрасывается в полночь по Калифорнии — 10:00 по Москве (с 1 ноября — 11:00). Сайт можно выложить и сейчас, без бэкапа: выкладка базу не читает');
      if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`); } };
  const post = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const collIds = async parent => { const out = []; let pt = ''; do { const j = await post(base + (parent ? '/' + enc(parent) : '') + ':listCollectionIds', { pageSize: 100, pageToken: pt || undefined }); out.push(...(j.collectionIds || [])); pt = j.nextPageToken; } while (pt); return out.sort(); };
  async function* docsOf(coll) { let page = ''; const size = /(^|\/)images$/.test(coll) ? 20 : 300;
    do { const j = await api(`${base}/${enc(coll)}?pageSize=${size}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`); for (const d of (j.documents || [])) yield d; page = j.nextPageToken; } while (page); }
  const idOf = d => d.name.split('/').pop();
  // запись пачками: не больше 400 документов и ~8 МБ за раз (картинки бывают по мегабайту)
  async function commit(writes) { const res = []; let cur = [], size = 0;
    const send = async () => { if (!cur.length) return; if (dry) { res.push(...cur.map(() => ({}))); } else { const j = await post(base + ':commit', { writes: cur }); res.push(...(j.writeResults || [])); } cur = []; size = 0; };
    for (const w of writes) { const s = JSON.stringify(w).length; if (cur.length && (cur.length >= 400 || size + s > 8e6)) await send(); cur.push(w); size += s; }
    await send(); return res; }

  const srcColls = (await collIds('')).filter(c => !GLOBAL.has(c));
  if (!delta) {
    const have = await collIds(DEST);
    if (have.length) { console.log(`Уже перенесено: в ${DEST} есть ${have.join(', ')}. Ничего не делаю.`); return; }
    if (!srcColls.length) { console.log('В корне нет данных игры — переносить нечего.'); return; }
    const at = Date.now(), man = { project, at, docs: {} }, counts = {}; let total = 0;
    for (const c of srcColls) { const writes = [], keys = [];
      for await (const d of docsOf(c)) { const id = idOf(d); writes.push({ update: { name: `${root}/${DEST}/${c}/${id}`, fields: d.fields || {} } }); keys.push([c + '/' + id, d.updateTime]); }
      const res = await commit(writes); keys.forEach(([k, src], i) => { man.docs[k] = { src, dst: res[i] && res[i].updateTime }; });
      counts[c] = writes.length; total += writes.length; console.log(`  ${c}: ${writes.length}`); }
    // карточка основной игры (название — из настроек сайта), если её ещё нет
    let name = 'Основная игра'; try { const s = await api(`${base}/meta/settings`, {}, true); const v = s && s.fields && s.fields.siteName && s.fields.siteName.stringValue; if (v && v.trim()) name = v.trim(); } catch {}
    if (!await api(`${base}/campaigns/main`, {}, true)) await commit([{ update: { name: `${root}/campaigns/main`, fields: { name: { stringValue: name }, createdAt: { integerValue: String(at) }, createdBy: { stringValue: 'migrate' } } }, currentDocument: { exists: false } }]);
    if (dry) { console.log(`[dry] перенёс бы ${total} документов в ${DEST} (игра «${name}»)`); return; }
    // проверка: в новой папке столько же документов
    for (const c of srcColls) { let n = 0; for await (const _ of docsOf(`${DEST}/${c}`)) n++; if (n !== counts[c]) throw new Error(`проверка не сошлась: ${c} — в корне ${counts[c]}, в ${DEST} ${n}`); }
    man.end = Date.now(); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(man));
    console.log(`OK перенесено ${total} документов в ${DEST} (игра «${name}»), проверено. Отчёт: ${manifestFile}`);
    return;
  }
  // --delta: что поменялось в корне после переноса
  if (!fs.existsSync(manifestFile)) { console.log('Нет отчёта переноса (' + manifestFile + ') — докопировать нечего.'); return; }
  const man = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); const seen = new Set(), writes = [], keys = [], conflicts = []; let same = 0;
  const dstTime = async k => { const d = await api(`${base}/${enc(DEST + '/' + k)}`, {}, true); return d ? d.updateTime : null; };
  for (const c of srcColls) for await (const d of docsOf(c)) { const k = c + '/' + idOf(d); seen.add(k); const m = man.docs[k];
    if (m && m.src === d.updateTime) { same++; continue; }
    const dt = await dstTime(k); if (m ? dt !== m.dst : dt) { conflicts.push(k); continue; } // в новой папке его уже правили (или создали заново) — не перетираем
    writes.push({ update: { name: `${root}/${DEST}/${k}`, fields: d.fields || {} } }); keys.push([k, d.updateTime]); }
  for (const [k, m] of Object.entries(man.docs)) if (!seen.has(k)) { const dt = await dstTime(k); if (dt === null) { delete man.docs[k]; continue; } if (dt !== m.dst) { conflicts.push(k + ' (удалён в корне)'); continue; } writes.push({ delete: `${root}/${DEST}/${k}` }); keys.push([k, null]); }
  const res = await commit(writes); keys.forEach(([k, src], i) => { if (src === null) delete man.docs[k]; else man.docs[k] = { src, dst: res[i] && res[i].updateTime }; });
  if (!dry) { man.deltaAt = Date.now(); fs.writeFileSync(manifestFile, JSON.stringify(man)); }
  console.log(`${dry ? '[dry] ' : ''}OK дельта: без изменений ${same}, докопировано/удалено ${writes.length}${conflicts.length ? `, НЕ тронуто (уже правили в новой версии) ${conflicts.length}: ${conflicts.slice(0, 10).join(', ')}` : ''}`);
})().catch(e => { console.error('ОШИБКА переноса: ' + e.message); process.exit(1); });
