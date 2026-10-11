// End-to-end tests for Instagram capture, run against the fake Instagram in
// ./fake-instagram (the real site is never contacted).
//
//   node dev/test-instagram.mjs
//
// Needs Playwright and its Chromium. Chrome is pointed at the fake with
// --host-resolver-rules, so the extension sees https://www.instagram.com
// exactly as it would on the real site. Screenshots and the [Stash] console
// log go to $OUT (default: a temp folder, printed at the end).

import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const fake = await import('./fake-instagram/server.mjs');

const ADMIN = 'http://127.0.0.1:8081';
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'stash-ig-test-'));
fs.mkdirSync(OUT, { recursive: true });
const PROFILES = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-ig-profiles-'));
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

let passes = 0;
let failures = 0;
function check(cond, msg, extra) {
  if (cond) {
    passes++;
    console.log('  ✓', msg);
  } else {
    failures++;
    console.log('  ✗', msg, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function admin(p, body) {
  const r = await fetch(ADMIN + p, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const extRequests = async () => (await admin('/log')).log.filter((l) => l.src === 'ext');

// ---------- browser ----------

const logLines = [];
let finishedCount = 0;
function watch(page) {
  page.on('console', (m) => {
    const t = m.text();
    if (!/\[Stash/.test(t)) return;
    logLines.push(`${new Date().toISOString().slice(11, 23)} ${t}`);
    if (/Instagram sync finished/.test(t)) finishedCount++;
  });
}

async function launch(name) {
  const dir = fs.mkdtempSync(path.join(PROFILES, name + '-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP www.instagram.com 127.0.0.1:8443,MAP *.cdninstagram.com 127.0.0.1:8443',
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  ctx.on('page', watch);
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  sw.on('console', (m) => /\[Stash/.test(m.text()) && logLines.push(`${new Date().toISOString().slice(11, 23)} SW ${m.text()}`));
  const id = new URL(sw.url()).host;
  const lib = await ctx.newPage();
  await lib.goto(`chrome-extension://${id}/src/ui/library.html#s/instagram`);
  const ig = await ctx.newPage();
  return { ctx, id, lib, ig };
}

async function dump(lib) {
  return lib.evaluate(async () => {
    const db = await import('/src/lib/db.js');
    const bms = (await db.allBookmarks()).filter((b) => b.source === 'instagram').map(({ embedding, ...b }) => b);
    const cols = await db.allCollections();
    const thumbs = (await db.allThumbs()).map((t) => ({ id: t.id, size: t.blob.size, type: t.type, w: t.width, h: t.height }));
    const st = await chrome.storage.local.get(null);
    return { bms, cols, thumbs, st };
  });
}

function members(d, name) {
  const c = d.cols.find((x) => x.name === name);
  return c ? d.bms.filter((b) => b.collectionId === c.id || (c.igId && b.igCollections?.includes(c.igId))) : null;
}

async function card(page) {
  return page
    .evaluate(() => {
      for (const el of document.querySelectorAll('div')) {
        const p = el.shadowRoot?.querySelector('.prog');
        if (p) return p.hidden ? null : { title: p.querySelector('.title').textContent, detail: p.querySelector('.detail').textContent, buttons: [...p.querySelectorAll('.btns button')].map((b) => b.textContent) };
      }
      return null;
    })
    .catch(() => null);
}

async function waitFinished(before, timeout = 150000) {
  const t0 = Date.now();
  while (finishedCount <= before) {
    if (Date.now() - t0 > timeout) throw new Error('sync never finished');
    await sleep(300);
  }
  await sleep(800); // let the card render
}

async function waitFor(fn, timeout = 60000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what);
    await sleep(500);
  }
}

function gaps(reqs) {
  const out = [];
  for (let i = 1; i < reqs.length; i++) out.push(reqs[i].t - reqs[i - 1].t);
  return out;
}

async function importFiles(t, files) {
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#s/instagram`);
  await t.lib.reload();
  await t.lib.waitForSelector('[data-act="ig-import"]');
  const [chooser] = await Promise.all([t.lib.waitForEvent('filechooser'), t.lib.click('[data-act="ig-import"]')]);
  await chooser.setFiles(files);
  await t.lib.waitForFunction(() => /Imported|failed/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
  return t.lib.textContent('#toast');
}

// ---------- export fixtures (shaped like Instagram's "Download your information") ----------

// Meta writes UTF-8 bytes as \u00XX escapes; reproduce that.
const mojibake = (s) => Buffer.from(s, 'utf8').toString('latin1');
const metaJson = (o) => JSON.stringify(o, null, 2).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const postUrl = (p) => `https://www.instagram.com/${p.kind === 'reel' ? 'reel' : 'p'}/${p.code}/`;

function savedPostsA(entries) {
  return metaJson({ saved_saved_media: entries.map(({ user, url, ts }) => ({ title: mojibake(user), string_map_data: { 'Saved on': { href: url, timestamp: ts } } })) });
}
function savedCollectionsA(groups) {
  const list = [];
  for (const g of groups) {
    list.push({ title: 'Collection', string_map_data: { Name: { value: mojibake(g.name) }, 'Creation Time': { timestamp: 1650000000 }, 'Update Time': { timestamp: 1690000000 } } });
    for (const m of g.members) list.push({ title: mojibake(m.user), string_map_data: { Name: { href: m.url, value: mojibake(m.user) }, 'Added Time': { timestamp: m.ts } } });
  }
  return metaJson({ saved_saved_collections: list });
}
function savedPostsB(entries) {
  return metaJson(
    entries.map(({ user, name, url, ts }) => ({
      timestamp: ts,
      media: [],
      label_values: [
        { label: 'URL', value: url, href: url },
        { label: 'Owner', dict: [{ label: 'Username', value: mojibake(user) }, { label: 'Name', value: mojibake(name || user) }] },
      ],
      fbid: '1789' + ts,
    })),
  );
}
function savedPostsHtml(entries) {
  const rec = ({ user, url, date }) =>
    `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${user}</h2><div class="_3-95 _a6-p"><table style="table-layout: fixed;"><tr><td colspan="2" class="_2pin _a6_q">Saved on<div><div><a target="_blank" href="${url}">${url}</a></div><div>${date}</div></div></td></tr></table></div><div class="_3-94 _a6-o"></div></div>`;
  return `<html><head><meta charset="utf-8"><title>Saved posts</title></head><body class="_5vb_ _2yq _a7o5"><div class="clearfix _ikh"><div class="_4bl9"><div class="_li"><div class="_a705"><div class="_3-8y _3-95 _a70a"><div class="_a70d"><div class="_a70e">Saved posts</div></div></div><main class="_a706" role="main">${entries.map(rec).join('')}</main></div></div></div></div></body></html>`;
}

// Zip with Python's zipfile, an independent implementation from Stash's reader.
function makeZip(out, files, { zip64 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(OUT, 'zip-'));
  const args = [];
  for (const [arc, text] of Object.entries(files)) {
    const p = path.join(dir, path.basename(arc));
    fs.writeFileSync(p, text);
    args.push(`${arc}=${p}`);
  }
  const py = path.join(dir, 'mkzip.py');
  fs.writeFileSync(
    py,
    `import sys, zipfile
out, zip64, pairs = sys.argv[1], sys.argv[2] == '1', sys.argv[3:]
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('your_instagram_activity/likes/liked_posts.json', '{"likes_media_likes": []}')
    if zip64:
        for i in range(35000): z.writestr('media/posts/%d.txt' % i, b'')
    for p in pairs:
        arc, src = p.split('=', 1)
        z.write(src, arc)
    if zip64:
        for i in range(35000): z.writestr('media/stories/%d.txt' % i, b'')
`,
  );
  execFileSync('python3', ['-I', py, out, zip64 ? '1' : '0', ...args]);
  return out;
}

// ---------- scenarios ----------

async function profileA() {
  console.log('\nA. Live sync on a fresh profile');
  await admin('/reset');
  const t = await launch('A');
  const fakeState = await admin('/state');

  console.log('\nA1. Opening Saved starts a full sync on its own');
  await admin('/clear-log');
  let before = finishedCount;
  await t.ig.goto('https://www.instagram.com/testuser/saved/all-posts/');
  await waitFinished(before);
  let c = await card(t.ig);
  check(/reached the end/i.test(c?.title || ''), 'card says the sync reached the end', c);
  check(/130 new saved posts · 130 checked · 3 collections/.test(c?.detail || ''), 'card counts 130 posts and 3 collections', c?.detail);
  let d = await dump(t.lib);
  check(d.bms.length === 130, '130 Instagram posts saved', d.bms.length);
  const byId = new Map(d.bms.map((b) => [b.id, b]));
  let wrong = [];
  for (const p of fakeState.posts) {
    const b = byId.get('instagram:' + p.code);
    const type = p.kind;
    const expectText = [p.caption, p.n % 4 === 0 && '📍 Bergen, Norway'].filter(Boolean).join('\n\n');
    const ok =
      b &&
      b.url === postUrl(p) &&
      b.mediaType === type &&
      b.text === expectText &&
      b.authorHandle === p.username &&
      b.author === (p.full_name || p.username) &&
      b.title === `${p.full_name || p.username} on Instagram` &&
      b.postedAt > 0;
    if (!ok) wrong.push({ p, b });
  }
  check(wrong.length === 0, 'every post has the right link, type, caption, author and date', wrong.slice(0, 2));
  const order = [...d.bms].sort((a, b) => b.savedAt - a.savedAt).map((b) => b.id.slice(10));
  check(JSON.stringify(order) === JSON.stringify(fakeState.posts.map((p) => p.code)), 'Stash keeps Instagram’s saved order (newest saved first)');
  const igCols = d.cols.filter((x) => x.igId);
  check(igCols.length === 3 && ['Recipes 🍕', 'Travel', 'Empty one'].every((n) => igCols.some((x) => x.name === n)), 'the 3 Instagram collections are mirrored, emoji intact', igCols.map((x) => x.name));
  check(members(d, 'Recipes 🍕')?.length === 26 && members(d, 'Travel')?.length === 12 && members(d, 'Empty one')?.length === 0, 'collection memberships match Instagram (26 / 12 / 0)', [members(d, 'Recipes 🍕')?.length, members(d, 'Travel')?.length]);
  const both = d.bms.filter((b) => (b.igCollections || []).length === 2).length;
  check(both === 3, 'posts in two collections are in both', both);
  let reqs = await extRequests();
  const api = reqs.filter((r) => r.path.startsWith('/api/'));
  check(api.length === 8 && api[0].path === '/api/v1/collections/list/' && api.slice(1).every((r) => r.path === '/api/v1/feed/saved/posts/'), 'Stash made 8 requests: collections list + 7 pages of Saved (no per-collection pages needed)', api.map((r) => r.path));
  const g = gaps(api);
  check(Math.min(...g) >= 2400, `requests were paced (shortest gap ${Math.min(...g)} ms, longest ${Math.max(...g)} ms)`);
  check(d.st.igFullSyncDone === true && d.st.igUsername === 'testuser', 'remembers the full sync and your username');

  console.log('\nA1b. Thumbnails are kept locally');
  d = await waitFor(async () => {
    const x = await dump(t.lib);
    return x.thumbs.length >= 130 ? x : null;
  }, 90000, 'thumbnails');
  const sizes = d.thumbs.map((x) => x.size);
  check(d.thumbs.every((x) => x.type === 'image/webp' && x.w <= 320 && x.h <= 320), 'all 130 thumbnails are WebP, at most 320px');
  check(Math.max(...sizes) < 40 * 1024, `thumbnails are small (${Math.round(Math.min(...sizes) / 1024)}–${Math.round(Math.max(...sizes) / 1024)} KB)`);
  check(d.bms.every((b) => b.thumb === 1), 'every post is marked as having a thumbnail');
  const cdn = (await admin('/log')).log.filter((l) => l.src === 'cdn' && /_320x400_/.test(l.path));
  check(cdn.length >= 130, 'thumbnails were fetched at 320px, not full size', cdn.length);

  console.log('\nA2. Opening Saved again within the hour does not sync again');
  await admin('/clear-log');
  await t.ig.goto('https://www.instagram.com/testuser/saved/');
  await sleep(9000);
  reqs = await extRequests();
  check(reqs.filter((r) => r.path.startsWith('/api/')).length === 0, 'no requests from Stash', reqs);
  check(logLines.some((l) => /auto-sync skipped: last sync/.test(l)), 'console explains why it skipped');

  console.log('\nA3. Library shows Instagram posts with local thumbnails');
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#s/instagram`);
  await t.lib.reload();
  await t.lib.waitForSelector('.card');
  await waitFor(() => t.lib.evaluate(() => [...document.querySelectorAll('img[data-thumb]')].filter((i) => i.src.startsWith('blob:') && !i.hidden && i.naturalWidth > 0).length >= 20), 20000, 'thumbnails in library');
  const ui = await t.lib.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    remote: [...document.querySelectorAll('.card img')].filter((i) => /cdninstagram/.test(i.src)).length,
    navIg: [...document.querySelectorAll('nav a')].find((a) => /Instagram/.test(a.textContent))?.textContent,
    kinds: [...document.querySelectorAll('.card .kind')].map((k) => k.textContent),
    igMarks: document.querySelectorAll('nav .ig').length,
  }));
  check(ui.cards === 130 && ui.remote === 0, 'all 130 cards render, none from Instagram’s servers', ui);
  check(/Instagram\s*130/.test(ui.navIg || ''), 'sidebar shows Instagram 130', ui.navIg);
  check(ui.kinds.includes('Reel') && ui.kinds.includes('Carousel') && ui.kinds.includes('Video'), 'cards show Reel / Carousel / Video');
  check(ui.igMarks === 3, 'mirrored collections are marked IG in the sidebar');
  await t.lib.screenshot({ path: path.join(OUT, 'library-instagram.png') });
  const recipes = d.cols.find((x) => x.name === 'Recipes 🍕');
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#c/${recipes.id}`);
  await t.lib.waitForSelector('.card');
  const n = await t.lib.evaluate(() => document.querySelectorAll('.card').length);
  check(n === 26, 'the Recipes 🍕 collection view lists its 26 posts', n);
  await t.lib.click('.card .snip');
  await sleep(500);
  await t.lib.screenshot({ path: path.join(OUT, 'library-collection.png') });
  const csv = await t.lib.evaluate(async () => {
    const db = await import('/src/lib/db.js');
    const { exportList } = await import('/src/lib/export.js');
    const all = (await db.allBookmarks()).filter((b) => (b.igCollections || []).length === 2);
    return exportList(all, 'csv', 't', await db.allCollections()).blob.text();
  });
  check(/Recipes 🍕, Travel|Travel, Recipes 🍕/.test(csv), 'CSV export lists both collections for a post in two');

  console.log('\nA4. “Sync Instagram now” picks up new saves and old posts newly filed into a collection');
  await admin('/save', { count: 2 });
  const travelNew = (await admin('/save', { count: 1, collection: '17890000000000002' })).added[0];
  const old = fakeState.posts.find((p) => p.n === 101).code;
  await admin('/file', { collection: '17890000000000001', code: old });
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#s/instagram`);
  await t.lib.click('[data-act="ig-sync"]');
  await waitFinished(before);
  c = await card(t.ig);
  check(/up to date/i.test(c?.title || ''), 'card says up to date', c);
  d = await dump(t.lib);
  check(d.bms.length === 133, '3 new posts saved (133 total)', d.bms.length);
  const top3 = [...d.bms].sort((a, b) => b.savedAt - a.savedAt).slice(0, 3).map((b) => b.id.slice(10));
  check(top3[0] === travelNew, 'the newest save sorts first', top3);
  check(members(d, 'Travel').some((b) => b.id === 'instagram:' + travelNew), 'the new post saved into Travel is in Travel');
  check(members(d, 'Recipes 🍕').some((b) => b.id === 'instagram:' + old), 'an old post (page 6 of Saved) newly filed into Recipes is now in Recipes');
  reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  check(reqs.length <= 8, `an incremental sync is cheap (${reqs.length} requests)`, reqs.map((r) => r.path + r.query));

  console.log('\nA5. Full rescan updates collection membership');
  const unfiled = fakeState.posts.find((p) => p.n === 0).code;
  await admin('/unfile', { collection: '17890000000000002', code: unfiled });
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: true }));
  await waitFinished(before);
  d = await dump(t.lib);
  check(!members(d, 'Travel').some((b) => b.id === 'instagram:' + unfiled), 'a post removed from Travel on Instagram leaves Travel in Stash');
  check(members(d, 'Travel').length === 12, 'Travel has 12 posts again', members(d, 'Travel').length);

  console.log('\nA6. Instagram says “slow down” (429): Stash stops at once and pauses');
  const { apiCount } = await admin('/log');
  await admin('/scenario', { rateLimitAfter: apiCount + 3 });
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: true }));
  await waitFinished(before);
  c = await card(t.ig);
  check(/paused/i.test(c?.title || '') && /slow down/.test(c?.detail || ''), 'card says paused because Instagram asked to slow down', c);
  reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  check(reqs.length === 4 && reqs[3].status === 429, 'no request after the 429', reqs.map((r) => r.status));
  d = await dump(t.lib);
  const hours = (d.st.igCooldownUntil - Date.now()) / 3600000;
  check(hours > 5.9 && hours <= 6, `auto-sync paused for 6 hours (${hours.toFixed(2)})`);
  await admin('/clear-log');
  await t.lib.evaluate(() => chrome.storage.local.set({ igLastSync: 0 }));
  await t.ig.goto('https://www.instagram.com/testuser/saved/all-posts/');
  await sleep(7000);
  c = await card(t.ig);
  check(/is paused/i.test(c?.title || '') && c.buttons.includes('Sync anyway'), 'opening Saved during the pause offers “Sync anyway” instead of syncing', c);
  check((await extRequests()).filter((r) => r.path.startsWith('/api/')).length === 0, 'and makes no requests');

  console.log('\nA7. Checkpoint: Stash stops and pauses for a day');
  await admin('/scenario', { rateLimitAfter: Infinity, checkpointAfter: (await admin('/log')).apiCount + 2 });
  await t.lib.evaluate(() => chrome.storage.local.remove('igCooldownUntil'));
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: true }));
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/confirm it’s you/.test(c?.detail || '') && (d.st.igCooldownUntil - Date.now()) / 3600000 > 23.9, 'card asks you to confirm it’s you; paused 24h', c?.detail);

  console.log('\nA8. Logged out: Stash stops and says so');
  await admin('/scenario', { checkpointAfter: Infinity, loggedIn: false });
  await t.lib.evaluate(() => chrome.storage.local.remove('igCooldownUntil'));
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: false }));
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/not logged in/.test(c?.detail || '') && !d.st.igCooldownUntil, 'card says you’re not logged in (no pause needed)', c?.detail);
  await admin('/scenario', { loggedIn: true });

  console.log('\nA9. Importing the export into a synced library fills gaps without overwriting');
  const live = fakeState.posts.slice(10, 15);
  const savedEntries = [
    ...live.map((p, i) => ({ user: p.username, url: postUrl(p), ts: 1680000000 + i })),
    { user: 'mueller.photo', url: 'https://www.instagram.com/p/ImportOnly1/', ts: 1600000001 },
    { user: 'chef.maria', url: 'https://www.instagram.com/reel/ImportOnly2/', ts: 1600000002 },
    { user: 'natgeo', url: 'https://www.instagram.com/natgeo/p/ImportOnly3/', ts: 1600000003 },
  ];
  const recipesLive = fakeState.posts.filter((p) => p.n % 5 === 0).slice(0, 2);
  const groups = [
    { name: 'Recipes 🍕', members: [...recipesLive.map((p) => ({ user: p.username, url: postUrl(p), ts: 1690000000 })), { user: 'chef.maria', url: 'https://www.instagram.com/reel/ImportOnly2/', ts: 1690000001 }] },
    { name: 'Old Ideas ✨', members: [{ user: 'natgeo', url: 'https://www.instagram.com/natgeo/p/ImportOnly3/', ts: 1690000002 }, { user: 'mueller.photo', url: 'https://www.instagram.com/p/ImportOnly1/', ts: 1690000003 }] },
  ];
  const zipA = makeZip(path.join(OUT, 'instagram-export-A.zip'), {
    'your_instagram_activity/saved/saved_posts.json': savedPostsA(savedEntries),
    'your_instagram_activity/saved/saved_collections.json': savedCollectionsA(groups),
  });
  const toast = await importFiles(t, [zipA]);
  check(/Imported 10 Instagram saves \(3 new\) and 2 collections/.test(toast), 'toast: 10 saves, 3 new, 2 collections', toast);
  d = await dump(t.lib);
  const kept = live.map((p) => d.bms.find((b) => b.id === 'instagram:' + p.code));
  const liveText = (p) => [p.caption, p.n % 4 === 0 && '📍 Bergen, Norway'].filter(Boolean).join('\n\n');
  check(kept.every((b, i) => b.text === liveText(live[i]) && b.title === `${live[i].full_name || live[i].username} on Instagram` && b.savedAtExact && b.savedAt === (1680000000 + i) * 1000), 'synced posts keep caption and full name, and get the real “saved on” time', kept.map((b) => [b.title, b.savedAt]));
  const io = ['ImportOnly1', 'ImportOnly2', 'ImportOnly3'].map((code) => d.bms.find((b) => b.id === 'instagram:' + code));
  check(io.every(Boolean) && io[0].title === '@mueller.photo on Instagram' && io[1].url === 'https://www.instagram.com/reel/ImportOnly2/' && io[1].mediaType === 'reel' && io[2].url === 'https://www.instagram.com/p/ImportOnly3/', 'export-only posts are added with link, username and type', io.map((b) => b && [b.title, b.url, b.mediaType]));
  check(d.cols.filter((x) => x.name === 'Recipes 🍕').length === 1 && members(d, 'Recipes 🍕').some((b) => b.id === 'instagram:ImportOnly2'), 'Recipes 🍕 from the export merges into the mirrored collection (no duplicate)');
  const oldIdeas = d.cols.find((x) => x.name === 'Old Ideas ✨');
  check(oldIdeas?.igId === 'name:Old Ideas ✨' && members(d, 'Old Ideas ✨').length === 2, 'Old Ideas ✨ (garbled in the file) is created with its 2 posts', oldIdeas);
  const due = d.bms.filter((b) => b.id.startsWith('instagram:ImportOnly')).every((b) => b.reviewDue > Date.now());
  check(due, 'old imported saves are not all due for resurfacing at once');

  console.log('\nA10. Backup and restore keep thumbnails');
  const r = await t.lib.evaluate(async () => {
    const db = await import('/src/lib/db.js');
    const ex = await import('/src/lib/export.js');
    const backup = await (await ex.exportJson()).text();
    const parsed = JSON.parse(backup);
    const mdZip = await ex.exportMarkdownZip();
    const zipText = new TextDecoder('latin1').decode(new Uint8Array(await mdZip.arrayBuffer()));
    const attachments = (zipText.match(/Stash\/attachments\/instagram-[^\s.]+\.webp/g) || []).length / 2; // name appears in local + central headers
    const linked = /!\[\]\(\.\.\/attachments\/instagram-/.test(zipText);
    await db.clearAll();
    const empty = (await db.allBookmarks()).length + (await db.allThumbs()).length;
    const res = await ex.importJson(backup);
    const ig = (await db.allBookmarks()).filter((b) => b.source === 'instagram');
    const thumbs = await db.allThumbs();
    return { thumbsInBackup: parsed.thumbs.length, attachments, linked, empty, res, ig: ig.length, withThumb: ig.filter((b) => b.thumb).length, thumbs: thumbs.length, cols: (await db.allCollections()).filter((c) => c.igId).length };
  });
  check(r.thumbsInBackup >= 133 && r.empty === 0, `JSON backup includes ${r.thumbsInBackup} thumbnails`, r);
  check(r.attachments >= 133 && r.linked, `Obsidian zip includes ${r.attachments} images, linked from the notes`, r);
  check(r.ig === 136 && r.thumbs === r.thumbsInBackup && r.withThumb === r.thumbs && r.cols === 4, 'restore brings back posts, thumbnails and mirrored collections', r);
  await t.lib.reload();
  await waitFor(() => t.lib.evaluate(() => [...document.querySelectorAll('img[data-thumb]')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length >= 20), 20000, 'restored thumbnails');
  check(true, 'restored thumbnails display');
  await t.ctx.close();
}

async function profileB() {
  console.log('\nB. Import first, then live sync (Instagram without collection ids on posts)');
  await admin('/reset');
  await admin('/scenario', { collectionIds: false });
  const fakeState = await admin('/state');
  const t = await launch('B');

  console.log('\nB1. A big (ZIP64) export with the newer JSON layout');
  const travel = fakeState.collections.find((x) => x.name === 'Travel');
  const strayCode = travel.posts[3];
  const entries = fakeState.posts.map((p, i) => ({ user: p.username, name: p.full_name, url: postUrl(p), ts: 1700000000 - i * 60 }));
  const zip64 = makeZip(
    path.join(OUT, 'instagram-export-zip64.zip'),
    {
      'your_instagram_activity/saved/saved_posts.json': savedPostsB(entries),
      'your_instagram_activity/saved/saved_collections.json': savedCollectionsA([{ name: 'Travel', members: travel.posts.map((code) => ({ user: 'x', url: postUrl(fakeState.posts.find((p) => p.code === code)), ts: 1690000000 })) }]),
    },
    { zip64: true },
  );
  const raw = fs.readFileSync(zip64);
  check(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), `fixture really is ZIP64 (${(raw.length / 1e6).toFixed(1)} MB, 70k entries)`);
  let toast = await importFiles(t, [zip64]);
  check(/Imported 130 Instagram saves \(130 new\) and 1 collection/.test(toast), 'imports 130 saves and 1 collection', toast);
  let d = await dump(t.lib);
  check(d.cols.find((x) => x.name === 'Travel')?.igId === 'name:Travel' && members(d, 'Travel').length === 12, 'Travel created from the export with 12 posts');
  check(d.bms.every((b) => b.savedAtExact && b.title.startsWith('@')), 'all have exact saved times and @username titles');

  console.log('\nB2. The HTML export works too');
  const html = path.join(OUT, 'saved_posts.html');
  fs.writeFileSync(html, savedPostsHtml([
    { user: 'natgeo', url: 'https://www.instagram.com/p/HtmlPost01/', date: 'Sep 29, 2023 3:12 pm' },
    { user: 'typeandtype', url: 'https://www.instagram.com/reel/HtmlPost02/', date: 'Jan 5, 2022 9:01 am' },
  ]));
  toast = await importFiles(t, [html]);
  d = await dump(t.lib);
  const h = d.bms.find((b) => b.id === 'instagram:HtmlPost01');
  check(/2 Instagram saves \(2 new\)/.test(toast) && h?.authorHandle === 'natgeo' && new Date(h.savedAt).getFullYear() === 2023, 'HTML: 2 posts with username and date', [toast, h]);

  console.log('\nB3. A live sync then fills captions and links Travel to Instagram’s real collection');
  await admin('/unfile', { collection: travel.id, code: strayCode });
  await admin('/clear-log');
  const before = finishedCount;
  await t.ig.goto('https://www.instagram.com/testuser/saved/');
  await waitFinished(before);
  d = await dump(t.lib);
  const travelCols = d.cols.filter((x) => x.name === 'Travel');
  check(travelCols.length === 1 && travelCols[0].igId === travel.id, 'still one Travel collection, now linked to Instagram’s id', travelCols);
  check(members(d, 'Travel').length === 11 && !members(d, 'Travel').some((b) => b.id === 'instagram:' + strayCode), 'Travel matches Instagram (11): the post removed since the export is gone');
  check(members(d, 'Recipes 🍕')?.length === 26, 'Recipes 🍕 found by going through each collection (posts had no collection ids)');
  const filled = d.bms.filter((b) => fakeState.posts.some((p) => 'instagram:' + p.code === b.id));
  check(filled.every((b) => !b.title.startsWith('@') && b.savedAtExact), 'captions and names filled in; export’s saved times kept');
  const reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  check(reqs.some((r) => r.path.startsWith('/api/v1/feed/collection/')), 'Stash paged each collection', reqs.map((r) => r.path));
  await t.ctx.close();
}

async function profileC() {
  console.log('\nC. Instagram only answers its own GraphQL requests: Stash scrolls instead');
  await admin('/reset');
  await admin('/scenario', { rest: false });
  const t = await launch('C');
  const before = finishedCount;
  await t.ig.bringToFront();
  await t.ig.goto('https://www.instagram.com/testuser/saved/all-posts/');
  await waitFinished(before, 240000);
  const c = await card(t.ig);
  const d = await dump(t.lib);
  check(d.bms.length === 130, 'all 130 posts captured from what Instagram’s page loaded', d.bms.length);
  check(/reached the end/i.test(c?.title || ''), 'card says reached the end', c);
  check(logLines.some((l) => /switching to scrolling|direct paging failed/.test(l)), 'console shows the switch to scrolling');
  await t.ctx.close();
}

// ---------- run ----------

const srv = await fake.start();
try {
  for (const [name, fn] of [['A', profileA], ['B', profileB], ['C', profileC]]) {
    if (only && !only.has(name)) continue;
    try {
      await fn();
    } catch (e) {
      failures++;
      console.log('  ✗', name, 'crashed:', e.stack || e);
    }
  }
} finally {
  await srv.close();
  fs.writeFileSync(path.join(OUT, 'stash-console.log'), logLines.join('\n') + '\n');
}
console.log(`\n${passes} passed, ${failures} failed · screenshots and console log in ${OUT}`);
process.exit(failures ? 1 : 0);
