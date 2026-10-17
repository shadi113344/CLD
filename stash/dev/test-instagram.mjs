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
let unsaveFinishedCount = 0;
function watch(page) {
  page.on('console', (m) => {
    const t = m.text();
    if (!/\[Stash/.test(t)) return;
    logLines.push(`${new Date().toISOString().slice(11, 23)} ${t}`);
    if (/Instagram sync finished/.test(t)) finishedCount++;
    if (/unsaving finished/.test(t)) unsaveFinishedCount++;
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

async function clickCardButton(page, label) {
  const ok = await page.evaluate((label) => {
    for (const el of document.querySelectorAll('div')) {
      const b = [...(el.shadowRoot?.querySelectorAll('.prog .btns button') || [])].find((x) => x.textContent === label);
      if (b) return b.click(), true;
    }
    return false;
  }, label);
  if (!ok) throw new Error('no card button ' + label);
}

async function waitFinished(before, timeout = 150000) {
  const t0 = Date.now();
  while (finishedCount <= before) {
    if (Date.now() - t0 > timeout) throw new Error('sync never finished');
    await sleep(300);
  }
  await sleep(800); // let the card render
}

async function waitUnsaved(before, timeout = 180000) {
  const t0 = Date.now();
  while (unsaveFinishedCount <= before) {
    if (Date.now() - t0 > timeout) throw new Error('unsaving never finished');
    await sleep(300);
  }
  await sleep(800);
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
  const badCounts = [];
  for (const p of fakeState.posts) {
    const m = byId.get('instagram:' + p.code)?.metrics;
    const video = p.kind === 'reel' || p.kind === 'video';
    const hidden = fake.hidesLikes(p.n);
    if (!(m && m.likes === (hidden ? null : 100 + p.n) && Boolean(m.likesHidden) === hidden && m.comments === p.n % 13 && m.views === (video ? fake.playCount(p.n) : null) && m.at > 0)) badCounts.push({ n: p.n, m });
  }
  check(badCounts.length === 0, 'likes, comments and views are kept with each post; hidden like counts stay empty', badCounts.slice(0, 3));
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

  console.log('\nA3b. Sort saved posts by views, likes or comments');
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#s/instagram`);
  await t.lib.reload();
  await t.lib.waitForSelector('.card');
  const sorts = await t.lib.$$eval('#sort option', (os) => os.map((o) => o.value));
  check(['views', 'likes', 'comments'].every((v) => sorts.includes(v)), 'the Instagram view offers Most viewed, Most liked and Most commented', sorts);
  const topCards = () => t.lib.evaluate(() => [...document.querySelectorAll('.card')].slice(0, 3).map((c) => ({ id: c.dataset.id, counts: c.querySelector('.metrics')?.textContent || '' })));
  await t.lib.selectOption('#sort', 'views');
  let top = await topCards();
  const byViews = fakeState.posts.filter((p) => p.kind === 'reel' || p.kind === 'video').sort((a, b) => fake.playCount(b.n) - fake.playCount(a.n));
  check(JSON.stringify(top.map((x) => x.id)) === JSON.stringify(byViews.slice(0, 3).map((p) => 'instagram:' + p.code)), 'Most viewed puts the most-played Reels and videos first', top);
  check(/views · \S+ likes · \S+ comments?/.test(top[0].counts), `cards show the counts (“${top[0].counts}”)`, top[0]);
  await t.lib.screenshot({ path: path.join(OUT, 'library-most-viewed.png') });
  check(fake.hidesLikes(byViews[1].n) && /views/.test(top[1].counts) && !/likes/.test(top[1].counts), 'a creator’s hidden like count isn’t shown as a number', top[1]);
  await t.lib.selectOption('#sort', 'likes');
  top = await topCards();
  const byLikes = fakeState.posts.filter((p) => !fake.hidesLikes(p.n)).sort((a, b) => b.n - a.n);
  check(top[0].id === 'instagram:' + byLikes[0].code, 'Most liked puts the most-liked post first', top);
  await t.lib.selectOption('#sort', 'comments');
  top = await topCards();
  check(top.every((x) => /12 comments/.test(x.counts)), 'Most commented puts posts with the most comments first', top);
  await t.lib.selectOption('#sort', 'saved');
  await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html#s/x`);
  check(!(await t.lib.$$eval('#sort option', (os) => os.map((o) => o.value))).includes('views'), 'views with no counts don’t offer count sorts');
  const exported = await t.lib.evaluate(async () => {
    const db = await import('/src/lib/db.js');
    const { exportList } = await import('/src/lib/export.js');
    const all = (await db.allBookmarks()).filter((b) => b.source === 'instagram');
    return { csv: await exportList(all, 'csv', 't', []).blob.text(), json: JSON.parse(await exportList(all, 'json', 't', []).blob.text()) };
  });
  const reel = byViews[0];
  const head = exported.csv.replace(/^\ufeff/, '').split('\r\n')[0];
  const row = exported.csv.split('\r\n').find((l) => l.includes(reel.code)) || '';
  check(head.startsWith('title,url,source,author,saved,posted,views,likes,comments,') && row.includes(`,${fake.playCount(reel.n)},${100 + reel.n},${reel.n % 13},`), 'CSV export has views, likes and comments columns', [head, row.slice(0, 200)]);
  const j = exported.json.find((x) => x.url.includes(reel.code));
  check(j?.views === fake.playCount(reel.n) && j.likes === 100 + reel.n && j.comments === reel.n % 13 && /^\d{4}-\d\d-\d\d$/.test(j.countsAsOf), 'JSON export has the counts and their date', j);

  console.log('\nA4. “Sync Instagram now” picks up new saves; collections wait until Stash has seen how Instagram loads one');
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
  check(/3 collections weren’t synced/.test(c?.detail || '') && /Open one collection on Instagram once/.test(c?.detail || '') && c.buttons.includes('Open Recipes 🍕'), 'card asks you to open one collection once, with a button for it', c);
  check(!/logged/.test(c?.detail || ''), 'and doesn’t say you’re logged out', c?.detail);
  d = await dump(t.lib);
  check(d.bms.length === 133, '3 new posts saved (133 total)', d.bms.length);
  const top3 = [...d.bms].sort((a, b) => b.savedAt - a.savedAt).slice(0, 3).map((b) => b.id.slice(10));
  check(top3[0] === travelNew, 'the newest save sorts first', top3);
  check(members(d, 'Travel').some((b) => b.id === 'instagram:' + travelNew), 'the new post saved into Travel is in Travel (Saved says which collections it’s in)');
  check(!d.st.igCooldownUntil && d.st.igCollectionsPending === true, 'no pause; collections marked as waiting', [d.st.igCooldownUntil, d.st.igCollectionsPending]);
  reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  const retired = reqs.filter((r) => r.path.startsWith('/api/v1/feed/collection/'));
  check(retired.length === 1 && retired[0].status === 404, 'one request to the retired collection address (404), not one per collection', retired.map((r) => r.path + ' ' + r.status));
  check(reqs.length <= 8, `an incremental sync is cheap (${reqs.length} requests)`, reqs.map((r) => r.path + r.query));

  console.log('\nA4b. Opening a collection teaches Stash Instagram’s request, and the collections sync');
  await admin('/clear-log');
  before = finishedCount;
  await clickCardButton(t.ig, 'Open Recipes 🍕');
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/up to date/i.test(c?.title || '') && !/Open one collection/.test(c?.detail || ''), 'a sync starts right away (no hour’s wait) and finishes without asking again', c);
  check(members(d, 'Recipes 🍕').some((b) => b.id === 'instagram:' + old), 'an old post (page 6 of Saved) newly filed into Recipes is now in Recipes');
  const q = d.st.igCollectionQuery;
  check(q?.docId === fake.COLLECTION_DOC && q.friendly === 'PolarisSavedCollectionPageWWWQuery' && q.path === '/api/graphql' && q.idPath.join('.') === 'collection_id' && q.cursorPath.join('.') === 'after' && !q.stale, 'learnt the request: doc_id, query name, where the id and cursor go', q);
  check(!/NAcM|AVqFak3|Fak3Csrf/.test(JSON.stringify(d.st)), 'no session tokens kept');
  reqs = await extRequests();
  const gqlA = reqs.filter((r) => r.path === '/api/graphql');
  check(gqlA.length === 3 && gqlA.every((r) => r.status === 200 && !r.bad) && new Set(gqlA.map((r) => r.vars.collection_id)).size === 3, `each collection asked for over GraphQL with the page’s tokens (${gqlA.length} requests)`, gqlA.map((r) => [r.status, r.bad, r.vars?.collection_id]));
  check(!reqs.some((r) => r.path.startsWith('/api/v1/feed/collection/')), 'and the retired address isn’t asked again');
  check(logLines.some((l) => /collection Travel: up to date \(via GraphQL\)/.test(l)), 'console says which way each collection was synced');
  check(d.st.igCollectionsPending === false, 'collections no longer waiting');

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
  await admin('/scenario', { collectionIds: false, restCollections: true }); // an account still on the old web app
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
  check(logLines.some((l) => /collection Recipes 🍕: complete \(via REST\)/.test(l)), 'through the old address, since it still works here');
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
  const posts = (await admin('/state')).posts;
  const reels = posts.filter((p) => p.kind === 'reel').map((p) => [p, d.bms.find((b) => b.id === 'instagram:' + p.code)]);
  check(reels.length > 20 && reels.every(([p, b]) => b?.postedAt === (1700000000 - p.n * 86400) * 1000), 'Reels sent without a date get their exact date from the media id', reels.slice(0, 2).map(([p, b]) => [p.n, b?.postedAt]));
  await t.ctx.close();
}

async function profileD() {
  console.log('\nD. The new Instagram: collections only over GraphQL, no collection ids on posts, “for (;;);” answers');
  await admin('/reset');
  await admin('/scenario', { collectionIds: false, gqlPrefix: true, gqlWrap: true, collectionVia: 'fetch' });
  const fakeState = await admin('/state');
  const t = await launch('D');

  console.log('\nD1. A full sync saves all of Saved, and says the collections need one visit');
  await admin('/clear-log');
  let before = finishedCount;
  await t.ig.goto('https://www.instagram.com/testuser/saved/');
  await waitFinished(before);
  let c = await card(t.ig);
  let d = await dump(t.lib);
  check(d.bms.length === 130, 'all 130 saved posts', d.bms.length);
  check(/reached the end/i.test(c?.title || '') && /3 collections weren’t synced/.test(c?.detail || '') && c.buttons.includes('Open Recipes 🍕'), 'card: reached the end, and 3 collections need you to open one once', c);
  check(!/logged/.test(c?.detail || '') && !d.st.igCooldownUntil, 'not mistaken for a logout, no pause', [c?.detail, d.st.igCooldownUntil]);
  let reqs = await extRequests();
  const retired = reqs.filter((r) => r.path.startsWith('/api/v1/feed/collection/'));
  check(retired.length === 1 && retired[0].status === 404, 'one request to the retired collection address (a 404 page), then no more', retired.map((r) => r.path + ' ' + r.status));
  check(members(d, 'Recipes 🍕')?.length === 0 && d.st.igCollectionsPending === true, 'collections are mirrored but still empty, and marked as waiting');

  console.log('\nD2. Opening one collection teaches Stash the request; every collection syncs over GraphQL');
  await admin('/clear-log');
  before = finishedCount;
  await clickCardButton(t.ig, 'Open Recipes 🍕');
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/up to date/i.test(c?.title || '') && !/weren’t synced/.test(c?.detail || ''), 'sync starts by itself and finishes', c);
  check(members(d, 'Recipes 🍕')?.length === 26 && members(d, 'Travel')?.length === 12 && members(d, 'Empty one')?.length === 0, 'memberships match Instagram (26 / 12 / 0)', [members(d, 'Recipes 🍕')?.length, members(d, 'Travel')?.length]);
  check(d.bms.filter((b) => (b.igCollections || []).length === 2).length === 3, 'posts in two collections are in both');
  check(d.bms.length === 130, 'no stray posts', d.bms.length);
  reqs = await extRequests();
  const gql = reqs.filter((r) => r.path === '/api/graphql');
  // Recipes: 3 pages (12 + 12 + 2), Travel: 1, Empty one: 1. Each collection's first pass goes to the end.
  check(gql.length === 5 && gql.every((r) => r.status === 200 && !r.bad && r.doc === 'PolarisSavedCollectionPageWWWQuery'), `5 GraphQL pages, all accepted with the page’s tokens (${gql.length})`, gql.map((r) => [r.status, r.bad, r.vars?.collection_id]));
  check(gql.filter((r) => r.vars.collection_id === '17890000000000001').map((r) => r.vars.after === null).join() === 'true,false,false', 'paged with Instagram’s cursor', gql.map((r) => r.vars));
  const g = gaps(reqs.filter((r) => r.path.startsWith('/api/')));
  check(Math.min(...g) >= 2400, `still paced (shortest gap ${Math.min(...g)} ms)`);
  check(logLines.some((l) => /learnt Instagram’s collection request/.test(l)), 'learnt from a fetch() request whose answers start with “for (;;);”');
  check(d.st.igCollectionQuery?.docId === fake.COLLECTION_DOC, 'request kept for next time');

  console.log('\nD3. Instagram says “slow down” during collections: Stash stops at once');
  let { apiCount } = await admin('/log');
  await admin('/scenario', { rateLimitAfter: apiCount + 2 }); // the 3rd request: list, Saved page 1, then the first collection
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: false }));
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  check(/paused/i.test(c?.title || '') && /slow down/.test(c?.detail || ''), 'card says paused because Instagram asked to slow down', c);
  check(reqs.length === 3 && reqs[2].path === '/api/graphql' && reqs[2].status === 429, 'no request after the 429', reqs.map((r) => r.path + ' ' + r.status));
  const hours = (d.st.igCooldownUntil - Date.now()) / 3600000;
  check(hours > 5.9 && hours <= 6, `paused for 6 hours (${hours.toFixed(2)})`);

  console.log('\nD4. Instagram changes the request (new doc_id): Stash notices, asks for one visit, relearns');
  await admin('/scenario', { rateLimitAfter: null, collectionDocId: '9145367822199999', collectionVia: 'xhr', gqlWrap: false, gqlPrefix: false });
  await t.lib.evaluate(() => chrome.storage.local.remove('igCooldownUntil'));
  const filed = fakeState.posts.find((p) => p.n === 78).code; // not in Travel yet
  await admin('/file', { collection: '17890000000000002', code: filed });
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: false }));
  await waitFinished(before);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/Open one collection on Instagram once/.test(c?.detail || '') && !/logged/.test(c?.detail || '') && !d.st.igCooldownUntil, 'card asks for one visit again; no logout, no pause', c);
  check(d.st.igCollectionQuery?.stale === true, 'the old request is marked as no longer working');
  reqs = (await extRequests()).filter((r) => r.path.startsWith('/api/'));
  check(reqs.filter((r) => r.path === '/api/graphql').length === 1 && reqs.filter((r) => r.path.startsWith('/api/v1/feed/collection/')).length === 1, 'one GraphQL try, one try of the old address, then it stops asking', reqs.map((r) => r.path + ' ' + r.status));
  await admin('/clear-log');
  before = finishedCount;
  await clickCardButton(t.ig, 'Open Recipes 🍕');
  await waitFinished(before);
  d = await dump(t.lib);
  check(d.st.igCollectionQuery?.docId === '9145367822199999' && !d.st.igCollectionQuery.stale, 'relearnt the new doc_id from an XHR request');
  check(members(d, 'Travel').some((b) => b.id === 'instagram:' + filed) && members(d, 'Travel').length === 13, 'a post filed into Travel since then is in Travel');
  check(logLines.some((l) => /collection request changed/.test(l)), 'console notes that the request changed');

  console.log('\nD5. The collections list address moves: Stash finds collections in Instagram’s own data');
  await admin('/scenario', { restCollectionsList: false });
  const design = fakeState.posts.filter((p) => p.n % 13 === 0).map((p) => p.code);
  await admin('/collection', { name: 'Design ✏️', codes: design });
  await t.ig.goto('https://www.instagram.com/testuser/saved/');
  await waitFor(async () => (await dump(t.lib)).cols.some((x) => x.name === 'Design ✏️' && x.igId), 20000, 'Design ✏️ mirrored');
  check(true, 'a new collection named only in Instagram’s data appears in Stash');
  // Sync from All posts, where the app makes no GraphQL request: Stash reads the tokens from the page itself.
  await t.ig.goto('https://www.instagram.com/testuser/saved/all-posts/');
  await sleep(6000);
  await admin('/clear-log');
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: false }));
  await waitFinished(before);
  d = await dump(t.lib);
  check(members(d, 'Design ✏️')?.length === design.length, `and its ${design.length} posts sync, though the list address is gone`, members(d, 'Design ✏️')?.length);
  reqs = (await extRequests()).filter((r) => r.path === '/api/graphql');
  check(reqs.length >= 4 && reqs.every((r) => r.status === 200 && !r.bad), 'from a page with no GraphQL request of its own, using the tokens in the page', reqs.map((r) => [r.status, r.bad]));
  check(logLines.some((l) => /using the 4 collections Stash already knows/.test(l)), 'console says it used the collections it knows');
  await t.ctx.close();
}

async function profileE() {
  console.log('\nE. Unsaving on Instagram: chosen posts, a whole view, pushback, continuing, learning the request');
  await admin('/reset');
  await admin('/trim', { keep: 24 });
  const t = await launch('E');
  const dialogs = [];
  t.lib.on('dialog', (dlg) => {
    dialogs.push(dlg.message());
    dlg.accept();
  });
  let before = finishedCount;
  await t.ig.goto('https://www.instagram.com/testuser/saved/all-posts/');
  await waitFinished(before);
  const fakeState = await admin('/state');
  const libView = async (hash) => {
    await t.lib.goto(`chrome-extension://${t.id}/src/ui/library.html${hash}`);
    await t.lib.reload();
    await t.lib.waitForSelector('.card');
  };
  const pickBar = () => t.lib.textContent('.pickbar strong');
  const unsaveReqs = async () => (await extRequests()).filter((r) => /\/unsave\/$/.test(r.path) || r.doc === 'usePolarisUnsaveMediaMutation');

  console.log('\nE1. Choose two posts and unsave them; they stay in Stash');
  await libView('#s/instagram');
  await t.lib.click('[data-act="ig-pick"]');
  const two = [fakeState.posts[3], fakeState.posts[7]];
  for (const p of two) await t.lib.click(`.card[data-id="instagram:${p.code}"] .pick`);
  check((await pickBar()) === '2 selected', 'ticking two posts selects two', await pickBar());
  await t.lib.screenshot({ path: path.join(OUT, 'library-unsave-picking.png') });
  await admin('/clear-log');
  let ub = unsaveFinishedCount;
  await t.lib.click('[data-act="unsave-picked"]');
  await waitUnsaved(ub);
  check(/Unsave 2 posts on Instagram\?/.test(dialogs.at(-1)) && /stay in Stash/.test(dialogs.at(-1)), 'asks first, and says they stay in Stash', dialogs.at(-1));
  let c = await card(t.ig);
  check(/Unsaved 2 posts on Instagram/.test(c?.title || ''), 'card: unsaved 2 posts', c);
  let st = await admin('/state');
  check(two.every((p) => st.unsaved.includes(p.code)) && st.posts.length === 22, 'both are unsaved on Instagram', st.unsaved);
  let d = await dump(t.lib);
  check(two.every((p) => d.bms.find((b) => b.id === 'instagram:' + p.code)?.igUnsaved > 0) && d.bms.length === 24, 'and still in Stash, marked unsaved');
  let reqs = await unsaveReqs();
  check(reqs.length === 2 && reqs.every((r, i) => r.status === 200 && r.path === `/api/v1/web/save/${two[i].pk}/unsave/`), 'one POST /api/v1/web/save/<id>/unsave/ per post, with Instagram’s id for it', reqs.map((r) => r.path + ' ' + r.status));
  check(gaps(reqs)[0] >= 4900, `unsaves are spaced out (${gaps(reqs)[0]} ms)`);
  check(!d.st.igUnsaveQueue, 'nothing left in the queue');
  await libView('#s/instagram');
  const badges = await t.lib.$$eval('.card .kind.unsaved', (els) => els.length);
  check(badges === 2, 'cards show “Unsaved on Instagram”', badges);
  await t.lib.click('[data-act="ig-pick"]');
  check(!(await t.lib.$(`.card[data-id="instagram:${two[0].code}"] .pick`)) && /Select all 22/.test(await t.lib.textContent('.pickbar')), 'unsaved posts can’t be picked again');
  await t.lib.click('[data-act="pick-cancel"]');

  console.log('\nE2. Unsave a whole collection, removing the posts from Stash too');
  const recipes = d.cols.find((x) => x.name === 'Recipes 🍕');
  const recipeCodes = fakeState.posts.filter((p) => p.n % 5 === 0).map((p) => p.code);
  await libView('#c/' + recipes.id);
  await t.lib.click('[data-act="ig-pick"]');
  await t.lib.click('[data-act="pick-all"]');
  await t.lib.check('#pickRemove');
  check((await pickBar()) === `${recipeCodes.length} selected`, `“Select all” picks the ${recipeCodes.length} posts in this view`, await pickBar());
  await admin('/clear-log');
  ub = unsaveFinishedCount;
  await t.lib.click('[data-act="unsave-picked"]');
  await waitUnsaved(ub);
  check(new RegExp(`Unsave ${recipeCodes.length} posts`).test(dialogs.at(-1)) && /removed from Stash/.test(dialogs.at(-1)), 'the question says they’ll be removed from Stash', dialogs.at(-1));
  st = await admin('/state');
  check(recipeCodes.every((code) => st.unsaved.includes(code)) && st.collections.find((x) => x.name === 'Recipes 🍕').posts.length === 0, 'all of Recipes is unsaved on Instagram');
  d = await dump(t.lib);
  check(recipeCodes.every((code) => !d.bms.some((b) => b.id === 'instagram:' + code)) && d.bms.length === 24 - recipeCodes.length, 'and removed from Stash', d.bms.length);
  check(recipeCodes.every((code) => !d.thumbs.some((x) => x.id === 'instagram:' + code)), 'with their thumbnails');
  reqs = await unsaveReqs();
  check(Math.min(...gaps(reqs)) >= 4900, `still spaced out (shortest gap ${Math.min(...gaps(reqs))} ms)`);

  console.log('\nE3. Instagram limits activity mid-way: Stash stops at once and keeps the rest');
  await admin('/scenario', { unsaveBlockAfter: 9 }); // 7 done so far: 2 more work, then a block
  const four = [fakeState.posts[1], fakeState.posts[2], fakeState.posts[4], fakeState.posts[6]];
  await libView('#s/instagram');
  await t.lib.click('[data-act="ig-pick"]');
  for (const p of four) await t.lib.click(`.card[data-id="instagram:${p.code}"] .pick`);
  await admin('/clear-log');
  ub = unsaveFinishedCount;
  await t.lib.click('[data-act="unsave-picked"]');
  await waitUnsaved(ub);
  c = await card(t.ig);
  check(/Unsaving paused/.test(c?.title || '') && /limited activity/.test(c?.detail || '') && /2 left/.test(c?.detail || ''), 'card: paused because Instagram limited activity; 2 left', c);
  reqs = await unsaveReqs();
  check(reqs.length === 3 && reqs[2].status === 400, 'no request after the block', reqs.map((r) => r.status));
  d = await dump(t.lib);
  check((d.st.igCooldownUntil - Date.now()) / 3600000 > 23.9 && d.st.igUnsaveQueue?.items.length === 2, 'Instagram left alone for 24 hours; the 2 left are kept', [d.st.igCooldownUntil, d.st.igUnsaveQueue?.items.length]);
  await libView('#s/instagram');
  check(/Unsaving on Instagram: 2 left/.test(await t.lib.textContent('.toolbar')), 'Stash’s library shows the job waiting');

  console.log('\nE4. Continuing later, with a daily limit');
  await admin('/scenario', { unsaveBlockAfter: null });
  await t.lib.evaluate(async () => {
    await chrome.storage.local.remove('igCooldownUntil');
    const { saveSettings } = await import('/src/lib/settings.js');
    await saveSettings({ igUnsavePerDay: 10 }); // 9 done in the last 24 hours, so 1 more today
  });
  await admin('/clear-log');
  await t.ig.reload();
  c = await waitFor(async () => {
    const x = await card(t.ig);
    return /waiting to be unsaved/.test(x?.title || '') ? x : null;
  }, 15000, 'reminder card');
  check(/2 Instagram posts waiting to be unsaved/.test(c.title) && c.buttons.includes('Continue'), 'reopening Instagram offers to continue', c);
  await sleep(5000);
  check(!(await extRequests()).some((r) => r.path.startsWith('/api/')), 'and doesn’t start a sync meanwhile');
  ub = unsaveFinishedCount;
  await clickCardButton(t.ig, 'Continue');
  await waitUnsaved(ub);
  c = await card(t.ig);
  check(/Daily unsave limit reached/.test(c?.title || '') && /1 left/.test(c?.detail || ''), 'stops at the daily limit from Settings', c);
  await t.lib.evaluate(async () => {
    const { saveSettings } = await import('/src/lib/settings.js');
    await saveSettings({ igUnsavePerDay: 500 });
  });
  await libView('#s/instagram');
  ub = unsaveFinishedCount;
  await t.lib.click('[data-act="unsave-resume"]');
  await waitUnsaved(ub);
  st = await admin('/state');
  d = await dump(t.lib);
  check(four.every((p) => st.unsaved.includes(p.code)) && four.every((p) => d.bms.find((b) => b.id === 'instagram:' + p.code)?.igUnsaved) && !d.st.igUnsaveQueue, '“Continue” in Stash finishes the job');

  console.log('\nE5. Instagram moved its unsave request: Stash learns it from one post you unsave by hand');
  await admin('/scenario', { unsaveRest: false });
  const two2 = [fakeState.posts[8], fakeState.posts[9]];
  await libView('#s/instagram');
  await t.lib.click('[data-act="ig-pick"]');
  for (const p of two2) await t.lib.click(`.card[data-id="instagram:${p.code}"] .pick`);
  await admin('/clear-log');
  ub = unsaveFinishedCount;
  await t.lib.click('[data-act="unsave-picked"]');
  await waitUnsaved(ub);
  c = await card(t.ig);
  d = await dump(t.lib);
  check(/didn’t accept Stash’s unsave request/.test(c?.title || '') && c.buttons.includes('Open a post') && !d.st.igCooldownUntil && d.st.igUnsaveQueue?.items.length === 2, 'card asks you to unsave one post by hand (no pause, nothing lost)', c);
  await clickCardButton(t.ig, 'Open a post');
  await t.ig.waitForURL(`**/p/${two2[0].code}/`);
  await t.ig.waitForSelector('#save-toggle');
  await t.ig.click('#save-toggle');
  c = await waitFor(async () => {
    const x = await card(t.ig);
    return /learnt how Instagram unsaves/.test(x?.title || '') ? x : null;
  }, 15000, 'learnt card');
  check(c.buttons.includes('Continue unsaving'), 'after you unsave one, Stash offers to continue', c);
  d = await dump(t.lib);
  const uq = d.st.igUnsaveQuery;
  check(uq?.kind === 'graphql' && uq.friendly === 'usePolarisUnsaveMediaMutation' && uq.idPath.join('.') === 'media_id' && !/NAcM|AVqFak3/.test(JSON.stringify(uq)), 'learnt the request (no tokens kept)', uq);
  ub = unsaveFinishedCount;
  await clickCardButton(t.ig, 'Continue unsaving');
  await waitUnsaved(ub);
  st = await admin('/state');
  reqs = (await extRequests()).filter((r) => r.doc === 'usePolarisUnsaveMediaMutation');
  check(two2.every((p) => st.unsaved.includes(p.code)) && reqs.length === 2 && reqs.every((r) => r.status === 200 && !r.bad), 'both unsaved through the learnt request, with the page’s tokens', reqs.map((r) => [r.status, r.bad]));
  check(/Unsaved 2 posts/.test((await card(t.ig))?.title || ''), 'card: unsaved 2 posts');

  console.log('\nE6. Saving a post again on Instagram clears the mark');
  await admin('/resave', { code: two[0].code });
  await t.lib.evaluate(async (id) => {
    const db = await import('/src/lib/db.js');
    await db.patchBookmark(id, { igUnsaved: Date.now() - 3600000 }); // unsaved an hour ago
  }, 'instagram:' + two[0].code);
  before = finishedCount;
  await t.lib.evaluate(() => chrome.runtime.sendMessage({ type: 'instagramSync', full: false }));
  await waitFinished(before);
  d = await dump(t.lib);
  check(!d.bms.find((b) => b.id === 'instagram:' + two[0].code)?.igUnsaved && d.bms.find((b) => b.id === 'instagram:' + two[1].code)?.igUnsaved, 'a post you saved again is no longer marked unsaved; the others still are');
  await t.ctx.close();
}

// ---------- run ----------

const srv = await fake.start();
try {
  for (const [name, fn] of [['A', profileA], ['B', profileB], ['C', profileC], ['D', profileD], ['E', profileE]]) {
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
