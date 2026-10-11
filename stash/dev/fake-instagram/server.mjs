// A fake www.instagram.com for testing Stash without touching the real site.
// It mimics the parts Stash relies on: the web app's Saved pages, the
// /api/v1 endpoints they call (saved feed, collections list, collection
// feeds) with their response shapes and paging, Instagram's CDN with links
// that expire, and the ways Instagram pushes back (429, checkpoint, login).
//
// Serves HTTPS on PORT (default 8443) for www.instagram.com and
// *.cdninstagram.com (point Chrome at it with --host-resolver-rules), and a
// plain-HTTP admin API on ADMIN_PORT (default 8081) for tests.

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_ID = '936619743392459';
export const USER = 'testuser';
const PAGE = 20;
const CDN_HOST = 'scontent-lhr8-1.cdninstagram.com';

// ---------- data ----------

const AUTHORS = [
  ['natgeo', 'National Geographic'],
  ['chef.maria', 'María José Cocina'],
  ['wanderlust_kai', 'Kai 🌍'],
  ['typeandtype', 'Type & Type Studio'],
  ['mueller.photo', 'Jürgen Müller'],
  ['minimal.rooms', ''],
];
const CAPTIONS = [
  'Golden hour over the fjords. 🌅 #norway #travel',
  'Crispy chickpea bowl — recipe in comments!\n\nIngredients:\n- chickpeas\n- tahini\n- lemon',
  'Swiss grid, 12 columns, and a lot of patience.',
  null,
  'Café au lait & croissants ☕️🥐',
  'Street photography in Tōkyō, 35mm.',
  'How we redesigned our onboarding (thread) →',
];

function makePost(n) {
  const kinds = ['photo', 'photo', 'reel', 'carousel', 'video'];
  const kind = kinds[n % kinds.length];
  const [username, full_name] = AUTHORS[n % AUTHORS.length];
  const pk = String(3100000000000000000n + BigInt(n) * 7919n);
  const code = `C${(n * 104729 + 2147483647).toString(36)}Ab_${n % 3 ? 'x' : '-'}`;
  return {
    n,
    pk,
    code,
    kind,
    username,
    full_name,
    caption: CAPTIONS[n % CAPTIONS.length],
    location: n % 4 === 0 ? 'Bergen, Norway' : null,
    taken_at: 1700000000 - n * 86400,
  };
}

export function createState() {
  const posts = Array.from({ length: 130 }, (_, i) => makePost(i)); // newest saved first
  const collections = [
    { id: '17890000000000001', name: 'Recipes 🍕', posts: [] },
    { id: '17890000000000002', name: 'Travel', posts: [] },
    { id: '17890000000000003', name: 'Empty one', posts: [] },
  ];
  // Recipes: every 5th post (26). Travel: every 11th (12), so posts 0, 55 and 110 are in both.
  posts.forEach((p, i) => {
    if (i % 5 === 0) collections[0].posts.push(p.code);
    if (i % 11 === 0) collections[1].posts.push(p.code);
  });
  return {
    posts,
    collections,
    nextN: 1000,
    scenario: { collectionIds: true, rest: true, rateLimitAfter: Infinity, checkpointAfter: Infinity, loggedIn: true, linkTtl: 3 * 86400 },
    apiCount: 0,
    log: [], // { t, src, path, status }
  };
}

let S = createState();

// ---------- API shapes ----------

const now = () => Math.floor(Date.now() / 1000);

function cdnUrl(p, w, h) {
  const oe = (now() + S.scenario.linkTtl).toString(16).toUpperCase();
  return `https://${CDN_HOST}/v/t51.29350-15/${p.pk}_${w}x${h}_n.jpg?stp=dst-jpg_e35_s${w}x${h}&_nc_ht=${CDN_HOST}&_nc_cat=1&oh=00_AYB${p.n}&oe=${oe}`;
}

function candidates(p) {
  return [1080, 750, 640, 480, 320, 240, 150].map((w) => ({ width: w, height: Math.round(w * 1.25), url: cdnUrl(p, w, Math.round(w * 1.25)) }));
}

function media(p) {
  const m = {
    taken_at: p.taken_at,
    pk: p.pk,
    id: `${p.pk}_${1000 + (p.n % 7)}`,
    device_timestamp: p.taken_at * 1000,
    media_type: p.kind === 'carousel' ? 8 : p.kind === 'photo' ? 1 : 2,
    code: p.code,
    client_cache_key: 'MzE=.2',
    filter_type: 0,
    product_type: p.kind === 'reel' ? 'clips' : p.kind === 'carousel' ? 'carousel_container' : p.kind === 'video' ? 'feed' : 'feed',
    caption: p.caption ? { pk: '1' + p.pk, user_id: '1000', text: p.caption, type: 1, created_at: p.taken_at } : null,
    caption_is_edited: false,
    like_count: 100 + p.n,
    comment_count: p.n % 13,
    has_liked: false,
    has_viewer_saved: true,
    user: { pk: String(1000 + (p.n % 7)), username: p.username, full_name: p.full_name, is_private: false, is_verified: p.n % 6 === 0, profile_pic_url: `https://${CDN_HOST}/v/t51.2885-19/pp_${p.n}.jpg?oe=0` },
    image_versions2: { candidates: candidates(p) },
    original_width: 1080,
    original_height: 1350,
    location: p.location ? { pk: 1, name: p.location, city: 'Bergen' } : null,
  };
  if (p.kind === 'carousel') {
    m.carousel_media_count = 3;
    m.carousel_media = [0, 1, 2].map((k) => ({ id: `${p.pk}${k}_1`, media_type: 1, image_versions2: { candidates: candidates({ ...p, pk: p.pk + k }) } }));
  }
  if (p.kind === 'reel' || p.kind === 'video') m.video_versions = [{ type: 101, width: 720, height: 1280, url: `https://${CDN_HOST}/o1/v/t16/${p.pk}.mp4?oe=0` }];
  if (S.scenario.collectionIds) {
    const ids = S.collections.filter((c) => c.posts.includes(p.code)).map((c) => c.id);
    if (ids.length) m.saved_collection_ids = ids;
  }
  return m;
}

const cursor = (o) => Buffer.from(JSON.stringify({ o, k: 'QVFE' })).toString('base64');
const offsetOf = (c) => {
  try {
    return JSON.parse(Buffer.from(c, 'base64').toString()).o || 0;
  } catch {
    return 0;
  }
};

function feed(codes, maxId) {
  const start = maxId ? offsetOf(maxId) : 0;
  const list = codes.slice(start, start + PAGE).map((code) => S.posts.find((p) => p.code === code));
  const more = start + PAGE < codes.length;
  return { items: list.map((p) => ({ media: media(p) })), num_results: list.length, more_available: more, next_max_id: more ? cursor(start + PAGE) : null, auto_load_more_enabled: true, status: 'ok' };
}

function collectionsList() {
  const cover = (c) => (c.posts[0] ? [media(S.posts.find((p) => p.code === c.posts[0]))] : []);
  return {
    items: [
      { collection_id: 'ALL_MEDIA_AUTO_COLLECTION', collection_name: 'All posts', collection_type: 'ALL_MEDIA_AUTO_COLLECTION', collection_media_count: S.posts.length, cover_media_list: cover({ posts: S.posts.map((p) => p.code) }) },
      ...S.collections.map((c) => ({ collection_id: c.id, collection_name: c.name, collection_type: 'MEDIA', collection_media_count: c.posts.length, cover_media_list: cover(c) })),
      { collection_id: 'AUDIO_AUTO_COLLECTION', collection_name: 'Audio', collection_type: 'AUDIO_AUTO_COLLECTION', collection_media_count: 2 },
    ],
    more_available: false,
    next_max_id: null,
    status: 'ok',
  };
}

// GraphQL flavour of the saved feed (used when scenario.rest is false).
function graphqlSaved(after) {
  const start = after ? offsetOf(after) : 0;
  const list = S.posts.slice(start, start + 12);
  const more = start + 12 < S.posts.length;
  return {
    data: { xdt_api__v1__feed__saved__posts__connection: { edges: list.map((p) => ({ node: { media: media(p) }, cursor: cursor(start) })), page_info: { end_cursor: more ? cursor(start + 12) : null, has_next_page: more } } },
    extensions: { is_final: true },
    status: 'ok',
  };
}

// ---------- images ----------

const pngCache = new Map();
function png(w, h, seed) {
  const key = `${w}x${h}:${seed}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const hue = (Number(seed) * 37) % 255;
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      const d = Math.hypot(x - w * 0.6, y - h * 0.4) / w;
      const ring = Math.sin(d * 30) > 0.6 ? 60 : 0;
      raw[i] = (hue + x / 4 + ring) & 255;
      raw[i + 1] = (120 + y / 6 - ring) & 255;
      raw[i + 2] = (200 - d * 120 + ((x * 7 + y * 13) % 9)) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const out = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  pngCache.set(key, out);
  return out;
}

// ---------- web app ----------

function appHtml(route) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Instagram</title>
<style>body{font:14px system-ui;margin:0;background:#fff}header{padding:12px 20px;border-bottom:1px solid #dbdbdb;font-weight:700}
main{max-width:935px;margin:0 auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.grid img{width:100%;aspect-ratio:4/5;object-fit:cover;background:#efefef}
.tiles a{display:inline-block;margin:8px;padding:30px;border:1px solid #dbdbdb}#sentinel{height:40px}</style></head>
<body><header>Instagram (fake, for Stash tests)</header><main id="root"></main>
<script>window.__route = ${JSON.stringify(route)};</script><script src="/static/app.js"></script></body></html>`;
}

const APP_JS = `
(() => {
  const route = window.__route;
  const root = document.getElementById('root');
  sessionStorage.setItem('www-claim-v2', 'hmac.AR2fakeClaim');
  const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))?.slice(10) || '';
  const headers = () => ({ 'X-IG-App-ID': '${APP_ID}', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest', 'X-ASBD-ID': '129477', 'X-IG-WWW-Claim': sessionStorage.getItem('www-claim-v2'), 'X-Web-Session-ID': 'abc:def:ghi' });
  const xhrJson = (url) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    for (const [k, v] of Object.entries(headers())) x.setRequestHeader(k, v);
    x.responseType = 'json';
    x.onload = () => (x.status === 200 ? resolve(x.response) : reject(x.status));
    x.onerror = reject;
    x.send();
  });
  function grid() {
    const g = document.createElement('div');
    g.className = 'grid';
    const s = document.createElement('div');
    s.id = 'sentinel';
    root.append(g, s);
    return g;
  }
  function addTiles(g, medias) {
    for (const m of medias) {
      const img = document.createElement('img');
      img.src = (m.image_versions2.candidates.find((c) => c.width === 480) || m.image_versions2.candidates[0]).url;
      img.alt = m.caption?.text || '';
      g.append(img);
    }
  }
  function infinite(load) {
    let busy = false, done = false;
    const io = new IntersectionObserver(async (es) => {
      if (!es.some((e) => e.isIntersecting) || busy || done) return;
      busy = true;
      try { done = !(await load()); } finally { busy = false; }
    });
    io.observe(document.getElementById('sentinel'));
  }
  if (route.type === 'all-posts' && route.graphql) {
    const g = grid();
    let after = null;
    infinite(async () => {
      const body = new URLSearchParams({ doc_id: '7208457865888221', variables: JSON.stringify({ after, first: 12 }) });
      const r = await fetch('/graphql/query', { method: 'POST', body, headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' } });
      const j = await r.json();
      const c = j.data.xdt_api__v1__feed__saved__posts__connection;
      addTiles(g, c.edges.map((e) => e.node.media));
      after = c.page_info.end_cursor;
      return c.page_info.has_next_page;
    });
  } else if (route.type === 'all-posts' || route.type === 'collection') {
    const g = grid();
    const base = route.type === 'collection' ? '/api/v1/feed/collection/' + route.id + '/posts/' : '/api/v1/feed/saved/posts/';
    let next = null;
    infinite(async () => {
      const r = await fetch(base + '?__src=app' + (next ? '&max_id=' + encodeURIComponent(next) : ''), { headers: headers() });
      const j = await r.json();
      addTiles(g, j.items.map((i) => i.media));
      next = j.next_max_id;
      return j.more_available;
    });
  } else if (route.type === 'saved') {
    xhrJson('/api/v1/collections/list/?__src=app&collection_types=%5B%22ALL_MEDIA_AUTO_COLLECTION%22%2C%22MEDIA%22%2C%22AUDIO_AUTO_COLLECTION%22%5D&include_public_only=0&get_cover_media_lists=true&max_id=').then((j) => {
      const t = document.createElement('div');
      t.className = 'tiles';
      for (const c of j.items) {
        const a = document.createElement('a');
        a.textContent = c.collection_name + ' (' + (c.collection_media_count ?? 0) + ')';
        a.href = c.collection_type === 'ALL_MEDIA_AUTO_COLLECTION' ? '/${USER}/saved/all-posts/' : '/${USER}/saved/' + encodeURIComponent(c.collection_name) + '/' + c.collection_id + '/';
        t.append(a);
      }
      root.append(t);
    });
  } else {
    // Home: the app makes some unrelated API call, as Instagram's does.
    fetch('/api/v1/web/accounts/badge/?__src=app', { headers: headers() });
    root.textContent = 'Home feed';
  }
})();
`;

function route(pathname) {
  const m = pathname.match(/^\/([^/]+)\/saved\/(?:(all-posts)|([^/]+)\/(\d+))?\/?$/);
  if (!m) return { type: 'home' };
  if (m[2]) return { type: 'all-posts', graphql: !S.scenario.rest };
  if (m[4]) return { type: 'collection', id: m[4] };
  return { type: 'saved' };
}

// ---------- server ----------

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isBuf ? 'image/png' : typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isBuf || typeof body === 'string' ? body : JSON.stringify(body));
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split('; ').filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));

function api(req, res, url) {
  const src = url.searchParams.get('__src') === 'app' ? 'app' : 'ext';
  const entry = { t: Date.now(), src, path: url.pathname, query: url.search, status: 0 };
  S.log.push(entry);
  const reply = (status, body) => {
    entry.status = status;
    send(res, status, body);
  };
  if (!S.scenario.loggedIn || !cookies(req).sessionid) return reply(401, { message: 'login_required', status: 'fail', require_login: true });
  if (req.headers['x-ig-app-id'] !== APP_ID) return reply(400, { message: 'useragent mismatch', status: 'fail' });
  S.apiCount++;
  if (S.apiCount > S.scenario.rateLimitAfter) return reply(429, { message: 'Please wait a few minutes before you try again.', require_login: false, status: 'fail' });
  if (S.apiCount > S.scenario.checkpointAfter) return reply(400, { message: 'checkpoint_required', checkpoint_url: 'https://www.instagram.com/challenge/?next=/api/v1/feed/saved/posts/', lock: true, status: 'fail' });
  const p = url.pathname;
  const maxId = url.searchParams.get('max_id');
  if (p === '/api/v1/feed/saved/posts/') {
    if (!S.scenario.rest) return reply(404, { message: '', status: 'fail' });
    return reply(200, feed(S.posts.map((x) => x.code), maxId));
  }
  let m = p.match(/^\/api\/v1\/feed\/collection\/(\d+)\/posts\/$/);
  if (m) {
    const c = S.collections.find((x) => x.id === m[1]);
    if (!c) return reply(404, { message: 'collection not found', status: 'fail' });
    if (!S.scenario.rest) return reply(404, { message: '', status: 'fail' });
    return reply(200, feed(c.posts, maxId));
  }
  if (p === '/api/v1/collections/list/') {
    if (!S.scenario.rest) return reply(404, { message: '', status: 'fail' });
    return reply(200, collectionsList());
  }
  if (p === '/api/v1/web/accounts/badge/') return reply(200, { status: 'ok' });
  return reply(404, { message: 'not found', status: 'fail' });
}

function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const host = (req.headers.host || '').split(':')[0];
  if (host.endsWith('cdninstagram.com')) {
    S.log.push({ t: Date.now(), src: 'cdn', path: url.pathname, status: 0 });
    const oe = parseInt(url.searchParams.get('oe') || '0', 16);
    if (!oe || oe < now()) return send(res, 403, 'URL signature expired', { 'content-type': 'text/plain' });
    const m = url.pathname.match(/\/(\d+)_(\d+)x(\d+)_n\.jpg$/);
    if (!m) return send(res, 404, 'not found', { 'content-type': 'text/plain' });
    S.log[S.log.length - 1].status = 200;
    // Like Instagram's CDN: instagram.com can show these images, other sites (and Stash's pages) can't embed them.
    const fromInstagram = /^https:\/\/www\.instagram\.com\//.test(req.headers.referer || '');
    const corp = fromInstagram ? 'cross-origin' : 'same-origin';
    return send(res, 200, png(Math.min(+m[2], 640), Math.min(+m[3], 800), m[1].slice(-4)), { 'cross-origin-resource-policy': corp, 'cache-control': 'max-age=1209600' });
  }
  if (url.pathname.startsWith('/api/v1/')) return api(req, res, url);
  if (url.pathname === '/graphql/query' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      S.log.push({ t: Date.now(), src: 'app', path: '/graphql/query', status: 200 });
      const vars = JSON.parse(new URLSearchParams(body).get('variables') || '{}');
      send(res, 200, graphqlSaved(vars.after));
    });
    return;
  }
  if (url.pathname === '/static/app.js') return send(res, 200, APP_JS, { 'content-type': 'text/javascript' });
  if (url.pathname === '/favicon.ico') return send(res, 404, '', { 'content-type': 'text/plain' });
  const set = [`csrftoken=Fak3CsrfT0ken; Path=/; Secure; SameSite=Lax`, `ds_user_id=1234; Path=/; Secure`];
  if (S.scenario.loggedIn) set.push(`sessionid=1234%3Afake%3A1; Path=/; Secure; HttpOnly`);
  return send(res, 200, appHtml(route(url.pathname)), { 'set-cookie': set });
}

// ---------- admin (tests drive the fake through this) ----------

function admin(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const data = body ? JSON.parse(body) : {};
    const ok = (x = { ok: true }) => send(res, 200, x);
    switch (url.pathname) {
      case '/reset':
        S = createState();
        return ok();
      case '/scenario':
        // JSON has no Infinity: a null limit means "no limit".
        for (const k of ['rateLimitAfter', 'checkpointAfter']) if (k in data && data[k] == null) data[k] = Infinity;
        Object.assign(S.scenario, data);
        if ('apiCount' in data) S.apiCount = data.apiCount;
        return ok(S.scenario);
      case '/log':
        return ok({ log: S.log, apiCount: S.apiCount });
      case '/clear-log':
        S.log = [];
        return ok();
      case '/state':
        return ok({ posts: S.posts.map(({ n, code, kind, username, full_name, caption }) => ({ n, code, kind, username, full_name, caption })), collections: S.collections });
      case '/save': {
        // Save new posts (they go to the top of Saved), optionally into a collection.
        const added = [];
        for (let i = 0; i < (data.count || 1); i++) {
          const p = makePost(S.nextN++);
          S.posts.unshift(p);
          if (data.collection) S.collections.find((c) => c.id === data.collection).posts.unshift(p.code);
          added.push(p.code);
        }
        return ok({ added });
      }
      case '/file': {
        // Add an already-saved post to a collection (it goes to the top of that collection).
        const c = S.collections.find((x) => x.id === data.collection);
        c.posts = [data.code, ...c.posts.filter((x) => x !== data.code)];
        return ok();
      }
      case '/unfile': {
        const c = S.collections.find((x) => x.id === data.collection);
        c.posts = c.posts.filter((x) => x !== data.code);
        return ok();
      }
    }
    send(res, 404, { error: 'unknown admin path' });
  });
}

export function certFiles() {
  const dir = path.join(os.tmpdir(), 'stash-fake-instagram-cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=www.instagram.com',
      '-addext', 'subjectAltName=DNS:www.instagram.com,DNS:instagram.com,DNS:*.cdninstagram.com,DNS:*.fbcdn.net'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

export function start({ port = 8443, adminPort = 8081 } = {}) {
  const main = https.createServer(certFiles(), handler);
  const adm = http.createServer(admin);
  return Promise.all([new Promise((r) => main.listen(port, '127.0.0.1', r)), new Promise((r) => adm.listen(adminPort, '127.0.0.1', r))]).then(() => ({
    close: () => Promise.all([new Promise((r) => main.close(r)), new Promise((r) => adm.close(r))]),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start({ port: Number(process.env.PORT || 8443), adminPort: Number(process.env.ADMIN_PORT || 8081) });
  console.log('fake instagram on https://127.0.0.1:8443 (admin http://127.0.0.1:8081)');
}
