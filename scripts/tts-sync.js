// Карточки → Tabletop Simulator: забирает готовые картинки карт из базы, выкладывает их на свой сайт (Firebase Hosting, папка /tts/)
// и складывает колоды в TTS: Объекты → Сохранённые объекты → Картотека → <сет>. Если игра в TTS открыта — может сразу положить колоды на стол.
// Картинки рисует браузер мастера (раздел «Карточки» на сайте) — программа их только переносит.
// Запуск:  node tts-sync.js <id проекта> --site <папка сайта с firebase.json> [--docs <папка «Документы»>] [--camp <id игры>]
//          [--no-deploy] [--table] [--watch] [--once] [--fb firebase-tools@15]
//   --table — положить колоды на стол без вопроса;  --watch — следить за правками без вопроса;  --once — не спрашивать про слежение
// Вход берётся из Firebase CLI (тот же, что для firebase deploy). FIRESTORE_EMULATOR_HOST=localhost:8080 — проверка на эмуляторе.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), readline = require('readline'), { spawnSync } = require('child_process');

const argv = process.argv.slice(2), has = f => argv.includes(f), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const project = argv[0] && !argv[0].startsWith('--') ? argv[0] : null; // id проекта — первым аргументом
if (!project || !/^[a-z0-9-]+$/.test(project)) { console.error('Укажите id проекта: node tts-sync.js <projectId> --site <папка сайта>'); process.exit(2); }
const siteDir = path.resolve(opt('--site', '.')), docsDir = opt('--docs', path.join(os.homedir(), 'Documents')), FB = opt('--fb', 'firebase-tools@15');
const fbj = (() => { try { return JSON.parse(fs.readFileSync(path.join(siteDir, 'firebase.json'), 'utf8')); } catch { return null; } })();
if (!fbj || !fbj.hosting) { console.error('В папке ' + siteDir + ' нет firebase.json с hosting — это не папка сайта'); process.exit(2); }
const pubDir = path.join(siteDir, fbj.hosting.public || 'public'), ttsDir = path.join(pubDir, 'tts');
const URL0 = opt('--url', `https://${project}.web.app`).replace(/\/$/, '') + '/tts/';
const C = { g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`, d: s => `\x1b[90m${s}\x1b[0m` };
const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const k = n % 10; return n > 10 && n < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; }, karty = n => n + ' ' + plural(n, 'карта', 'карты', 'карт');
const ok = t => console.log(C.g('  ✔ ' + t)), warn = t => console.log(C.y('  ! ' + t)), bad = t => console.log(C.r('  ✖ ' + t)), say = t => console.log(t);

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
  return null;
}
function fields(f) { const o = {}; for (const k of Object.keys(f)) o[k] = val(f[k]); return o; }

const EMU = process.env.FIRESTORE_EMULATOR_HOST;
const base = (EMU ? `http://${EMU}/v1/` : 'https://firestore.googleapis.com/v1/') + `projects/${project}/databases/(default)/documents`;
let tok = null;
const enc = p => p.split('/').map(encodeURIComponent).join('/');
async function api(url, opts = {}) { if (!tok) tok = EMU ? 'owner' : await accessToken();
  for (let i = 0; ; i++) { const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + tok } });
    if (r.ok) return r.json(); if (r.status === 404) return null; const txt = await r.text();
    if (r.status === 401 && i === 0 && !EMU) { tok = await accessToken(); continue; }
    // суточный бесплатный лимит базы (тариф Spark) кончился — повторять бессмысленно, до сброса не пройдёт
    if (r.status === 429 && /"Quota exceeded\."/.test(txt)) throw new Error('закончился суточный бесплатный лимит базы Firebase (HTTP 429 «Quota exceeded», тариф Spark). Он сбрасывается в полночь по Калифорнии — 10:00 по Москве (с 1 ноября — 11:00). Сайт можно выложить и сейчас, без бэкапа: выкладка базу не читает');
    if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`); } }
const getDoc = async p => { const d = await api(`${base}/${enc(p)}`); return d ? { ...fields(d.fields || {}), id: p.split('/').pop() } : null; };
async function list(p) { const out = []; let page = ''; do { const j = await api(`${base}/${enc(p)}?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`); if (!j) break;
  for (const d of (j.documents || [])) out.push({ ...fields(d.fields || {}), id: d.name.split('/').pop() }); page = j.nextPageToken; } while (page); return out; }
// убрать поле (сайт поймёт, что картинку надо нарисовать заново)
const dropField = (p, f) => api(`${base}/${enc(p)}?updateMask.fieldPaths=${encodeURIComponent(f)}&currentDocument.exists=true`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: {} }) });

function ask(q, def) { if (!process.stdin.isTTY) return Promise.resolve(def);
  return new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(C.c('  → ' + q + ` [${def}] `), a => { rl.close(); res((a || '').trim() || def); }); }); }
const yes = a => /^(да|д|y|yes|ok|\+)$/i.test(String(a).trim());

/* ===== TTS: сохранённые объекты и колоды ===== */
const plain = t => String(t || '').replace(/\{(#[0-9a-fA-F]{3,8}|[\wа-яё-]{1,12})\|/gi, '').replace(/[{}]/g, '').replace(/\*\*/g, '');
const guid = () => Math.random().toString(16).slice(2, 8).padEnd(6, '0');
// скейл карт — из настроек сайта (Карточки → «В TTS»: settings.cards.ttsScale {x,y,z}), по умолчанию 1.5 · 1 · 1.5
let SC = { x: 1.5, y: 1, z: 1.5 };
const T = (x = 0, y = 1, z = 0) => ({ posX: x, posY: y, posZ: z, rotX: 0, rotY: 180, rotZ: 180, scaleX: SC.x, scaleY: SC.y, scaleZ: SC.z });
const COMMON = { ColorDiffuse: { r: 0.713235259, g: 0.713235259, b: 0.713235259 }, LayoutGroupSortIndex: 0, Value: 0, Locked: false, Grid: true, Snap: true, IgnoreFoW: false, MeasureMovement: false, DragSelectable: true, Autoraise: true, Sticky: true, Tooltip: true, GridProjection: false, HideWhenFaceDown: true, Hands: true, SidewaysCard: false, LuaScript: '', LuaScriptState: '', XmlUI: '' };
const cardDesc = c => { const v = x => String(x ?? '').trim() || '—'; return [`Энергия ${v(c.en)} · Инициатива ${v(c.ini)}`, [(c.tags || []).join(', '), c.tgt].filter(Boolean).join(' · '), '', plain(c.text), c.flav ? '\n«' + String(c.flav).trim() + '»' : ''].join('\n').trim(); };
function cardObj(c, k, face, back) { const cd = { FaceURL: face, BackURL: back, NumWidth: 1, NumHeight: 1, BackIsHidden: true, UniqueBack: false, Type: 0 };
  return { GUID: guid(), Name: 'CardCustom', Transform: T(), Nickname: c.name || '', Description: cardDesc(c), GMNotes: JSON.stringify({ kartoteka: c.id, en: c.en ?? '', ini: c.ini ?? '', tags: c.tags || [], tgt: c.tgt || '' }),
    Tags: (c.tags || []).filter(Boolean).map(String), ...COMMON, CardID: k * 100, CustomDeck: { [k]: cd } }; }
function deckObj(set, cards, pos) { const objs = cards.map((c, i) => cardObj(c, i + 1, c._url, set._url)); const tr = T(...pos);
  if (objs.length === 1) return { ...objs[0], Transform: tr };
  return { GUID: guid(), Name: 'Deck', Transform: tr, Nickname: set.name || 'Сет', Description: `Картотека: ${karty(cards.length)}${set.pub ? '' : ' · скрытый сет'}`, GMNotes: JSON.stringify({ kartoteka: set.id }), Tags: [],
    ...COMMON, Hands: false, DeckIDs: objs.map((o, i) => (i + 1) * 100), CustomDeck: Object.assign({}, ...objs.map(o => o.CustomDeck)), ContainedObjects: objs }; }
const saveWrap = (name, obj) => ({ SaveName: name, Date: '', VersionNumber: '', GameMode: '', GameType: '', GameComplexity: '', Tags: [], Gravity: 0.5, PlayArea: 0.5, Table: '', Sky: '', Note: '', TabStates: {}, LuaScript: '', LuaScriptState: '', XmlUI: '', ObjectStates: [obj] });
const safeName = s => (String(s || 'Сет').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/[. ]+$/, '').trim() || 'Сет').slice(0, 80);

// External Editor API TTS: игра слушает localhost:39999, сообщение 3 — выполнить Lua
function ttsOpen() { return new Promise(res => { const s = net.connect(39999, '127.0.0.1'); const done = v => { s.destroy(); res(v); }; s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(800, () => done(false)); }); }
function ttsLua(script) { return new Promise((res, rej) => { const s = net.connect(39999, '127.0.0.1', () => { s.end(JSON.stringify({ messageID: 3, guid: '-1', script }), () => res(true)); }); s.once('error', rej); s.setTimeout(5000, () => { s.destroy(); rej(new Error('TTS не ответил')); }); }); }
const luaLong = t => { let eq = '='; while (t.includes(']' + eq + ']')) eq += '='; return '[' + eq + '[' + t + ']' + eq + ']'; };

/* ===== один проход синхронизации ===== */
async function syncOnce(cid, quiet) {
  const sets = (await list(`campaigns/${cid}/cardsets`)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const cards = (await list(`campaigns/${cid}/cards`)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!cards.length) { warn('В этой игре пока нет карт (раздел «Карточки» на сайте).'); return null; }
  const st = await getDoc(`campaigns/${cid}/meta/settings`).catch(() => null), sc = (st && st.cards && st.cards.ttsScale) || {};
  SC = { x: +sc.x > 0 ? +sc.x : 1.5, y: +sc.y > 0 ? +sc.y : 1, z: +sc.z > 0 ? +sc.z : 1.5 };
  fs.mkdirSync(ttsDir, { recursive: true });
  const fresh = [], unready = [], lost = [];
  // файл картинки: имя = подпись картинки; есть на диске — не качаем
  async function file(prefix, sig, docId, owner, label) {
    if (sig && fs.existsSync(path.join(ttsDir, `${prefix}-${sig}.jpg`))) return `${prefix}-${sig}.jpg`;
    if (!sig) { unready.push(label); return null; }
    const d = await getDoc(`campaigns/${cid}/cardfaces/${docId}`);
    if (!d || !d.data) { lost.push(label); await dropField(owner, prefix === 'f' ? 'fh' : 'bh').catch(() => {}); return null; }
    const name = `${prefix}-${d.h || sig}.jpg`; fs.writeFileSync(path.join(ttsDir, name), Buffer.from(String(d.data).split(',')[1] || '', 'base64')); fresh.push(name); return name; }
  for (const s of sets) s._file = await file('b', s.bh, 'back_' + s.id, `campaigns/${cid}/cardsets/${s.id}`, `рубашка «${s.name}»`);
  let n = 0; for (const c of cards) { if (!c.set || !sets.some(s => s.id === c.set)) continue; c._file = await file('f', c.fh, c.id, `campaigns/${cid}/cards/${c.id}`, `«${c.name}»`); if (!quiet) process.stdout.write(`\r  Картинки: ${++n}   `); }
  if (!quiet) process.stdout.write('\n');
  if (unready.length) warn(`Не нарисованы на сайте (${unready.length}): ${unready.slice(0, 6).join(', ')}${unready.length > 6 ? '…' : ''} — на сайте включи «Настройки → 🃏 Карточки → Готовить картинки для программы», открой раздел «Карточки» под мастером и дождись «✓ готово для TTS». Или выгрузи прямо с сайта кнопкой «🎲 В TTS».`);
  if (lost.length) warn(`Нет картинки в базе (${lost.length}): ${lost.slice(0, 6).join(', ')} — сайт нарисует их заново, когда мастер откроет «Карточки».`);
  // выложить новые картинки на сайт
  if (fresh.length) {
    say(`  Новых картинок: ${fresh.length}. Выкладываю на сайт…`);
    if (has('--no-deploy')) warn('--no-deploy: на сайт не выкладываю (ссылки заработают после выкладки).');
    else { const r = spawnSync(`npx --yes ${FB} deploy --only hosting --project ${project} --non-interactive`, { cwd: siteDir, stdio: quiet ? 'pipe' : 'inherit', shell: true });
      if (r.status !== 0) { bad('Не удалось выложить картинки на сайт' + (quiet ? ': ' + String(r.stderr || r.stdout || '').slice(-400) : ' (сообщение выше).') + ' Колоды в TTS не обновлены.'); for (const f of fresh) { try { fs.unlinkSync(path.join(ttsDir, f)); } catch {} } return null; }
      const u = URL0 + fresh[0]; const h = await fetch(u, { method: 'HEAD' }).catch(() => null); if (h && h.ok) ok('Картинки на сайте: ' + URL0); else warn('Картинка пока не открывается по ссылке ' + u + ' — проверь через минуту.'); }
  } else if (!quiet) ok('Новых картинок нет — всё уже на сайте.');
  // сохранённые объекты TTS
  const ttsRoot = path.join(docsDir, 'My Games', 'Tabletop Simulator');
  const objDir = fs.existsSync(ttsRoot) ? path.join(ttsRoot, 'Saves', 'Saved Objects', 'Картотека') : path.join(siteDir, 'tts-objects');
  if (!fs.existsSync(ttsRoot)) warn('Tabletop Simulator не найден в «Документах» — файлы колод положу сюда: ' + objDir + ' (их можно перенести в Saves\\Saved Objects).');
  fs.mkdirSync(objDir, { recursive: true });
  const manPath = path.join(objDir, '.kartoteka.json'); const man = (() => { try { return JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { return { files: [] }; } })();
  const written = [], decks = []; const used = new Set();
  sets.forEach(s => { const cs = cards.filter(c => c.set === s.id && c._file); if (!cs.length || !s._file) return; s._url = URL0 + s._file; cs.forEach(c => { c._url = URL0 + c._file; });
    let nm = safeName(s.name); for (let k = 2; used.has(nm.toLowerCase()); k++) nm = safeName(s.name) + ` (${k})`; used.add(nm.toLowerCase());
    const obj = deckObj(s, cs, [0, 1, 0]); fs.writeFileSync(path.join(objDir, nm + '.json'), JSON.stringify(saveWrap(nm, obj), null, 2));
    fs.copyFileSync(path.join(ttsDir, s._file), path.join(objDir, nm + '.png')); // миниатюра в меню TTS — рубашка (TTS читает JPEG и под именем .png)
    written.push(nm + '.json', nm + '.png'); decks.push({ s, cs, nm }); });
  for (const f of man.files || []) if (!written.includes(f)) { try { fs.unlinkSync(path.join(objDir, f)); } catch {} } // колоды удалённых сетов
  fs.writeFileSync(manPath, JSON.stringify({ files: written, at: Date.now() }));
  const skipped = cards.filter(c => !c.set || !sets.some(s => s.id === c.set)).length;
  ok(`Колод в TTS: ${decks.length} (${karty(decks.reduce((a, d) => a + d.cs.length, 0))}) → ${objDir}`);
  if (!quiet) { for (const d of decks) say(C.d(`     ${d.nm}: ${karty(d.cs.length)}${d.s.pub ? '' : ', скрытый сет'}`)); if (skipped) say(C.d(`     карты без сета (${skipped}) в TTS не идут`)); }
  return { decks, fresh: fresh.length };
}

async function toTable(res) { const L = res.decks; let i = 0;
  for (const d of L) { const obj = deckObj(d.s, d.cs, [-((L.length - 1) * 2.2) + i * 4.4, 2, 0]); i++;
    await ttsLua(`spawnObjectJSON({json = ${luaLong(JSON.stringify(obj))}})`); }
  ok(`Колоды на столе: ${L.length}. Старые копии со стола убери сам, если они там были.`); }

(async () => {
  say(C.c('Картотека → Tabletop Simulator') + C.d(`  (проект ${project}${EMU ? ', эмулятор' : ''})`));
  const site = await getDoc('site/main'); let cid = opt('--camp', (site && site.active) || 'main');
  const camps = await list('campaigns'); const cname = id => (camps.find(c => c.id === id) || {}).name || (id === 'main' ? 'основная' : id);
  if (!has('--camp') && camps.length > 1 && process.stdin.isTTY) { say('  Игры: ' + camps.map((c, i) => `${i + 1}) ${c.name || c.id}${c.id === cid ? ' (активная)' : ''}`).join('   '));
    const a = await ask('Номер игры', String(Math.max(1, camps.findIndex(c => c.id === cid) + 1))); const c = camps[+a - 1]; if (c) cid = c.id; }
  say('  Игра: ' + C.g(cname(cid)));
  const res = await syncOnce(cid, false);
  if (res && res.decks.length) {
    say(C.c('\n  В TTS: Объекты → Сохранённые объекты → Картотека → нужный сет (перетащи на стол).'));
    if (await ttsOpen()) { if (has('--table') || yes(await ask('TTS открыт. Положить колоды на стол прямо сейчас? (да/нет)', 'нет'))) await toTable(res).catch(e => bad('Не получилось: ' + e.message)); }
    else say(C.d('  (Если открыть игру в TTS и запустить программу снова — она предложит положить колоды прямо на стол.)'));
  }
  if (has('--once') || !(has('--watch') || yes(await ask('Следить за правками и обновлять колоды сами? Окно должно остаться открытым (да/нет)', 'нет')))) return;
  say(C.c('\n  Слежу за правками (раз в 30 с). Остановить — закрыть окно или Ctrl+C.'));
  let last = (await getDoc(`campaigns/${cid}/cardfaces/_ver`) || {}).at || 0;
  for (;;) { await new Promise(r => setTimeout(r, 30000));
    try { const v = (await getDoc(`campaigns/${cid}/cardfaces/_ver`) || {}).at || 0; if (v === last) continue; last = v;
      say(C.d(`  ${new Date().toLocaleTimeString('ru-RU')} — есть правки, обновляю…`)); const r = await syncOnce(cid, true);
      if (r && r.fresh && await ttsOpen()) say(C.y('  Колоды обновлены в «Сохранённых объектах». Чтобы обновить карты на столе — возьми колоду заново из меню.')); }
    catch (e) { warn('Не получилось проверить правки: ' + e.message + ' — попробую снова.'); } }
})().catch(e => { bad(e.message); process.exit(1); });
