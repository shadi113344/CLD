import * as db from '../lib/db.js';
import { getSettings, saveSettings, apiConfigured, DEFAULTS } from '../lib/settings.js';
import { rank, cosine } from '../lib/search.js';
import { exportJson, importJson, exportMarkdownZip, exportList, exportPeople, LIST_FORMATS } from '../lib/export.js';
import { readInstagramExport } from '../lib/instagram-import.js';

const PANEL = location.pathname.endsWith('panel.html');
const PAGE = 150;
const SOURCES = { x: 'X', reddit: 'Reddit', linkedin: 'LinkedIn', instagram: 'Instagram', web: 'Web' };
const MEDIA = { reel: 'Reel', video: 'Video', carousel: 'Carousel' };
// Sorts by the counts Instagram reported at the last sync (bookmark.metrics).
const METRIC_SORTS = { views: 'Most viewed', likes: 'Most liked', comments: 'Most commented' };
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const state = {
  settings: DEFAULTS,
  bookmarks: [],
  byId: new Map(),
  collections: [],
  people: [],
  peopleSort: 'followers',
  route: { view: 'all', arg: '' },
  query: '',
  queryVec: null,
  sort: 'saved',
  sel: 0,
  open: new Set(),
  limit: PAGE,
  visible: [],
  chat: [],
  reviewQueue: null,
};

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '#';
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const units = [[60, 'm'], [24, 'h'], [30, 'd'], [12, 'mo']];
  let v = s / 60;
  let u = 'm';
  for (let i = 1; i < units.length && v >= units[i - 1][0]; i++) {
    v /= units[i - 1][0];
    u = units[i][1];
  }
  if (u === 'mo' && v >= 12) return `${Math.floor(v / 12)}y ago`;
  return `${Math.floor(v)}${u} ago`;
}

function host(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong');
  return res.result;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function allTags(b) {
  return [...new Set([...(b.tags || []), ...(b.autoTags || [])])];
}

// ---------- theme ----------

function applyLook() {
  const s = state.settings;
  const root = document.documentElement;
  if (s.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
  root.style.setProperty('--accent', s.accent || DEFAULTS.accent);
  $('#brandName').textContent = s.displayName || 'Stash';
  document.title = s.displayName || 'Stash';
}

// ---------- data ----------

async function load() {
  const [settings, bookmarks, collections, people, igState] = await Promise.all([
    getSettings(),
    db.allBookmarks(),
    db.allCollections(),
    db.allPeople(),
    chrome.storage.local.get(['igLastSync', 'igCooldownUntil']),
  ]);
  state.igState = igState;
  state.people = people;
  state.settings = settings;
  state.bookmarks = bookmarks;
  state.byId = new Map(bookmarks.map((b) => [b.id, b]));
  state.collections = collections;
  applyLook();
  renderNav();
  render();
}

let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    // Don't yank the UI while someone is typing in it.
    const a = document.activeElement;
    if (a && a !== $('#q') && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && view.contains(a)) return reloadSoon();
    await load();
  }, 400);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'changed') reloadSoon();
  if (msg?.type === 'progress') showIndexing(msg);
});

// Thin bar under the header while the background indexes new bookmarks.
let indexHide;
function showIndexing({ done, total, label }) {
  const el = $('#indexing');
  el.hidden = false;
  el.querySelector('span').textContent = done >= total ? `${label} — done` : `${label} ${done} / ${total}`;
  el.querySelector('i').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  clearTimeout(indexHide);
  indexHide = setTimeout(() => (el.hidden = true), done >= total ? 2000 : 30000);
}
chrome.storage.onChanged.addListener((c) => {
  if (c.settings) reloadSoon();
});

// ---------- routing ----------

function parseRoute() {
  const h = decodeURIComponent(location.hash.slice(1));
  const [view, ...rest] = h.split('/');
  state.route = { view: view || 'all', arg: rest.join('/') };
  state.sel = 0;
  state.limit = PAGE;
  state.reviewQueue = null;
}

window.addEventListener('hashchange', () => {
  parseRoute();
  renderNav();
  render();
  $('#side').classList.remove('open');
});

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- nav ----------

function renderNav() {
  const { bookmarks, collections, route } = state;
  const due = dueList().length;
  const count = (f) => bookmarks.filter(f).length;
  const link = (hash, label, n, extra = '') => {
    const active = '#' + route.view + (route.arg ? '/' + route.arg : '') === hash || (hash === '#all' && route.view === 'all');
    return `<a href="${esc(hash)}" class="${active ? 'active' : ''}"><span>${label}</span>${extra || (n != null ? `<span class="n">${n}</span>` : '')}</a>`;
  };
  const tagCounts = new Map();
  for (const b of bookmarks) for (const t of allTags(b)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  $('#nav').innerHTML = [
    link('#all', 'All bookmarks', bookmarks.length),
    link('#review', 'Resurface', null, due ? `<span class="badge">${Math.min(due, state.settings.reviewPerDay)}</span>` : ''),
    link('#ask', 'Ask your bookmarks'),
    `<h4>Sources</h4>`,
    ...Object.entries(SOURCES).map(([k, v]) => link('#s/' + k, v, count((b) => b.source === k))),
    `<h4>Collections <button id="newColl" title="New collection" aria-label="New collection">+</button></h4>`,
    ...collections.map((c) => link('#c/' + c.id, esc(c.name) + (c.igId ? ' <span class="ig" title="Mirrors an Instagram collection">IG</span>' : ''), count((b) => db.inCollection(b, c)))),
    collections.length ? '' : `<a href="#" id="newColl2" class="n"><span class="n">+ New collection</span></a>`,
    ...peopleNav(link),
    topTags.length ? `<h4>Tags</h4>` : '',
    ...topTags.map(([t, n]) => link('#t/' + t, '#' + esc(t), n)),
    `<h4>&nbsp;</h4>`,
    link('#settings', 'Settings'),
  ].join('');
  for (const id of ['#newColl', '#newColl2']) {
    const el = $(id);
    if (el) el.onclick = (e) => (e.preventDefault(), newCollection());
  }
}

// ---------- people (X Following / Followers) ----------

const REL_LABEL = { following: 'Following', followers: 'Followers', verified_followers: 'Verified followers' };

function peopleLists() {
  const lists = new Map(); // 'owner/relation' -> count
  for (const p of state.people) for (const k of Object.keys(p.lists || {})) lists.set(k, (lists.get(k) || 0) + 1);
  return lists;
}

function peopleNav(link) {
  const lists = peopleLists();
  if (!lists.size) return [];
  const owners = [...new Set([...lists.keys()].map((k) => k.split('/')[0]))].sort();
  const out = [`<h4>People on X</h4>`];
  for (const o of owners) {
    for (const rel of Object.keys(REL_LABEL)) if (lists.has(`${o}/${rel}`)) out.push(link(`#p/${o}/${rel}`, `@${esc(o)} · ${REL_LABEL[rel]}`, lists.get(`${o}/${rel}`)));
    if (lists.has(`${o}/following`) && lists.has(`${o}/followers`)) {
      out.push(link(`#p/${o}/notback`, `@${esc(o)} · Not following back`, peopleFor(o, 'notback').length));
      out.push(link(`#p/${o}/fans`, `@${esc(o)} · You don't follow back`, peopleFor(o, 'fans').length));
    }
  }
  return out;
}

// notback: you follow them, they don't follow you. fans: they follow you, you don't follow them.
function peopleFor(owner, rel) {
  const on = (p, r) => Boolean(p.lists?.[`${owner}/${r}`]);
  if (rel === 'notback') return state.people.filter((p) => on(p, 'following') && !on(p, 'followers'));
  if (rel === 'fans') return state.people.filter((p) => on(p, 'followers') && !on(p, 'following'));
  return state.people.filter((p) => on(p, rel));
}

function peopleTitle() {
  const [owner, rel] = state.route.arg.split('/');
  const label = { ...REL_LABEL, notback: 'Not following back', fans: "Followers you don't follow back" }[rel] || rel;
  return `@${owner} · ${label}`;
}

function currentPeople() {
  const [owner, rel] = state.route.arg.split('/');
  let list = peopleFor(owner, rel);
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((p) => [p.name, p.handle, p.bio, p.location, p.website].join(' ').toLowerCase().includes(q));
  const by = {
    followers: (a, b) => (b.followers ?? -1) - (a.followers ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => (b.lists?.[`${owner}/${rel}`] || 0) - (a.lists?.[`${owner}/${rel}`] || 0),
  };
  return [...list].sort(by[state.peopleSort] || by.followers);
}

function fmtNum(n) {
  if (n == null) return '';
  return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n.toLocaleString('en');
}

function renderPeople() {
  const [owner, rel] = state.route.arg.split('/');
  const list = currentPeople();
  const shown = list.slice(0, state.limit);
  const real = REL_LABEL[rel];
  view.innerHTML = `<div class="toolbar">
      <strong style="color:var(--text)">${esc(peopleTitle())}</strong>
      <span>${list.length} ${list.length === 1 ? 'person' : 'people'}</span>
      <span class="grow"></span>
      ${real ? `<button class="ghost" data-pact="update">Update from X</button><button class="ghost" data-pact="delete">Delete list</button>` : ''}
      <select id="peopleSort" aria-label="Sort"><option value="followers">Most followers</option><option value="name">Name</option><option value="recent">Recently added</option></select>
      <select id="exportFmt" aria-label="Export this list"><option value="">Export ${list.length}…</option>${Object.entries(LIST_FORMATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    </div>
    ${list.length ? `<div class="people">${shown.map(personCard).join('')}</div>` : `<div class="empty"><p>${state.query ? 'No one matches.' : 'Nobody here.'}</p></div>`}
    ${list.length > state.limit ? `<button class="ghost more" data-pact="more">Show more (${list.length - state.limit} left)</button>` : ''}`;
  $('#peopleSort').value = state.peopleSort;
  $('#peopleSort').onchange = (e) => {
    state.peopleSort = e.target.value;
    renderPeople();
  };
  $('#exportFmt').onchange = (e) => {
    const fmt = e.target.value;
    e.target.value = '';
    if (!fmt) return;
    const out = exportPeople(list, fmt, peopleTitle());
    if (out.html) return printHtml(out.html);
    download(out.blob, `x-${owner}-${rel}-${new Date().toISOString().slice(0, 10)}.${out.ext}`);
    toast(`Exported ${list.length} ${list.length === 1 ? 'person' : 'people'}`);
  };
}

function personCard(p) {
  const meta = [p.followers != null && `${fmtNum(p.followers)} followers`, p.following != null && `${fmtNum(p.following)} following`, p.location].filter(Boolean);
  return `<article class="person">
    ${p.avatar ? `<img src="${esc(safeUrl(p.avatar))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ph"></span>'}
    <div class="pbody">
      <div><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener"><strong>${esc(p.name)}</strong></a>${p.verified ? ' <span class="tick" title="Verified">✓</span>' : ''} <span class="hint">@${esc(p.handle)}</span></div>
      ${p.bio ? `<div class="bio">${esc(p.bio)}</div>` : ''}
      <div class="hint">${meta.map(esc).join(' · ')}${p.website ? ` · <a href="${esc(safeUrl(p.website))}" target="_blank" rel="noopener">${esc(host(p.website))}</a>` : ''}</div>
    </div>
  </article>`;
}

view.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-pact]')?.dataset.pact;
  if (!a) return;
  const [owner, rel] = state.route.arg.split('/');
  if (a === 'more') {
    state.limit += PAGE;
    return renderPeople();
  }
  if (a === 'update') return chrome.tabs.create({ url: `https://x.com/${owner}/${rel}` });
  if (a === 'delete') {
    if (!confirm(`Delete the saved list ${peopleTitle()}?`)) return;
    await db.deletePeopleList(owner, rel);
    location.hash = '#all';
    load();
  }
});

async function newCollection(assignId) {
  const name = prompt('Collection name');
  if (!name?.trim()) return;
  const c = { id: db.uid(), name: name.trim(), createdAt: Date.now() };
  await db.putCollection(c);
  if (assignId) await db.patchBookmark(assignId, { collectionId: c.id });
  await load();
  toast(`Created “${c.name}”`);
}

// ---------- main render ----------

function render() {
  const v = state.route.view;
  if (v === 'review') return renderReview();
  if (v === 'ask') return renderChat();
  if (v === 'settings') return renderSettings();
  if (v === 'p') return renderPeople();
  renderList();
}

function baseList() {
  const { view: v, arg } = state.route;
  let list = state.bookmarks;
  if (v === 's') list = list.filter((b) => b.source === arg);
  if (v === 'c') {
    const c = state.collections.find((x) => x.id === arg);
    list = c ? list.filter((b) => db.inCollection(b, c)) : [];
  }
  if (v === 't') list = list.filter((b) => allTags(b).includes(arg));
  return list;
}

// Which count sorts make sense for this list: only counts some item has.
function metricSorts(list) {
  return Object.keys(METRIC_SORTS).filter((k) => list.some((b) => b.metrics?.[k] != null));
}

function currentList() {
  let list = baseList();
  const metric = METRIC_SORTS[state.sort] && metricSorts(list).includes(state.sort) ? state.sort : null;
  if (state.query.trim()) list = rank(list, state.query, state.queryVec);
  else if (state.sort === 'posted') list = [...list].sort((a, b) => (b.postedAt || b.savedAt) - (a.postedAt || a.savedAt));
  else if (state.sort === 'oldest') list = [...list].sort((a, b) => a.savedAt - b.savedAt);
  // Posts without the count go last, in saved order.
  else if (metric) list = [...list].sort((a, b) => (b.metrics?.[metric] ?? -1) - (a.metrics?.[metric] ?? -1) || b.savedAt - a.savedAt);
  return list;
}

function listTitle() {
  const { view: v, arg } = state.route;
  if (v === 's') return SOURCES[arg] || arg;
  if (v === 'c') return state.collections.find((c) => c.id === arg)?.name || 'Collection';
  if (v === 't') return '#' + arg;
  return 'All bookmarks';
}

function renderList() {
  const list = currentList();
  state.visible = list.slice(0, state.limit);
  if (state.sel >= state.visible.length) state.sel = Math.max(0, state.visible.length - 1);
  const { view: v, arg } = state.route;

  const syncBtn =
    v === 's' && arg === 'x'
      ? `<button class="ghost" data-act="open-url" data-url="https://x.com/i/bookmarks#stash-sync">Open X bookmarks to sync</button>`
      : v === 's' && arg === 'reddit'
        ? `<button class="ghost" data-act="reddit-sync">Sync Reddit now</button>`
        : v === 's' && arg === 'linkedin'
          ? `<button class="ghost" data-act="open-url" data-url="https://www.linkedin.com/my-items/saved-posts/">Open LinkedIn saved posts to sync</button>`
          : v === 's' && arg === 'instagram'
            ? `<button class="ghost" data-act="ig-sync">Sync Instagram now</button><button class="ghost" data-act="ig-import">Import Instagram export…</button>`
            : v === 'c'
            ? `<button class="ghost" data-act="rename-coll">Rename</button><button class="ghost" data-act="delete-coll">Delete collection</button>`
            : '';

  const toolbar = `<div class="toolbar">
      <strong style="color:var(--text)">${esc(listTitle())}</strong>
      <span>${state.query ? `${list.length} match${list.length === 1 ? '' : 'es'}` : `${list.length} item${list.length === 1 ? '' : 's'}`}</span>
      <span class="grow"></span>${syncBtn}
      <select id="exportFmt" aria-label="Export this list" title="Export the links in this view"><option value="">Export ${list.length}…</option>${Object.entries(LIST_FORMATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      ${state.query ? '' : `<select id="sort" aria-label="Sort"><option value="saved">Newest saved</option><option value="oldest">Oldest saved</option><option value="posted">Newest posted</option>${metricSorts(baseList()).map((k) => `<option value="${k}">${METRIC_SORTS[k]}</option>`).join('')}</select>`}
    </div>`;

  if (!list.length) {
    view.innerHTML = toolbar + emptyState();
    bindToolbar();
    return;
  }
  view.innerHTML =
    toolbar +
    `<div class="list">${state.visible.map((b, i) => card(b, i)).join('')}</div>` +
    (list.length > state.limit ? `<button class="ghost more" data-act="more">Show more (${list.length - state.limit} left)</button>` : '');
  bindToolbar();
  hydrateThumbs();
}

function slugName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stash';
}

// Export whatever the current view shows (platform, collection, tag, or search results).
function exportCurrent(format) {
  const list = currentList();
  const title = state.query ? `${listTitle()} — “${state.query}”` : `${listTitle()} — ${state.settings.displayName || 'Stash'}`;
  const out = exportList(list, format, title, state.collections);
  if (out.html) return printHtml(out.html);
  download(out.blob, `${slugName(listTitle())}-${new Date().toISOString().slice(0, 10)}.${out.ext}`);
  toast(`Exported ${list.length} link${list.length === 1 ? '' : 's'}`);
}

// PDF: render into a hidden frame and open the print dialog (choose “Save as PDF”).
function printHtml(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  f.srcdoc = html;
  f.onload = () => {
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 60000);
  };
  document.body.appendChild(f);
}

function bindToolbar() {
  const ex = $('#exportFmt');
  if (ex) {
    ex.onchange = () => {
      const fmt = ex.value;
      ex.value = '';
      if (fmt) exportCurrent(fmt);
    };
  }
  const s = $('#sort');
  if (s) {
    s.value = state.sort;
    if (s.value !== state.sort) s.value = 'saved'; // a count sort this list has no counts for
    s.onchange = () => {
      state.sort = s.value;
      renderList();
    };
  }
}

function emptyState() {
  if (state.query) return `<div class="empty"><h2>No matches</h2><p>Try fewer words, or ask in natural language under “Ask your bookmarks”.</p></div>`;
  if (state.bookmarks.length) return `<div class="empty"><p>Nothing here yet.</p></div>`;
  return `<div class="empty">
    <h2>Your stash is empty</h2>
    <p>Press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on any page (or click the toolbar icon) to save it.</p>
    <p>Visit your <a href="https://x.com/i/bookmarks#stash-sync" target="_blank">X bookmarks</a>, <a href="https://www.reddit.com/" target="_blank">Reddit</a>,
    <a href="https://www.linkedin.com/my-items/saved-posts/" target="_blank">LinkedIn saved posts</a> or your Instagram Saved, and they’re captured automatically.</p>
    <p>Have Instagram’s data download? <a href="#" data-act="ig-import">Import your saved posts from it</a>.</p>
    <p>Have a backup? <a href="#" data-act="import">Import JSON</a>.</p></div>`;
}

// Instagram images are shown only from local copies: Instagram's own links
// expire, and its image servers refuse to show them on other sites anyway.
function thumbImg(b, cls) {
  if (b.source === 'instagram') return b.thumb ? `<img class="${cls}" data-thumb="${esc(b.id)}" alt="" hidden>` : '';
  return b.image ? `<img class="${cls}" src="${esc(safeUrl(b.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
}

const thumbUrls = new Map(); // bookmark id -> object URL of its local thumbnail
async function hydrateThumbs() {
  const imgs = [...view.querySelectorAll('img[data-thumb]')];
  const missing = [...new Set(imgs.map((i) => i.dataset.thumb).filter((id) => !thumbUrls.has(id)))];
  if (missing.length) {
    const got = await db.getThumbs(missing);
    for (const id of missing) thumbUrls.set(id, got.has(id) ? URL.createObjectURL(got.get(id).blob) : null);
  }
  for (const img of imgs) {
    const u = thumbUrls.get(img.dataset.thumb);
    if (u && img.isConnected) {
      img.src = u;
      img.hidden = false;
    }
  }
}

function card(b, i) {
  const colls = db.collectionsOf(b, state.collections);
  const open = state.open.has(b.id);
  const snippet = open ? b.text : (b.text || '').slice(0, 600);
  const tags = (b.tags || []).map((t) => `<span class="chip" data-act="tag" data-tag="${esc(t)}">#${esc(t)}<span class="x" data-act="rm-tag" data-tag="${esc(t)}" title="Remove">×</span></span>`);
  const auto = (b.autoTags || [])
    .filter((t) => !(b.tags || []).includes(t))
    .map((t) => `<span class="chip auto" data-act="accept-tag" data-tag="${esc(t)}" title="Suggested — click to keep">+${esc(t)}<span class="x" data-act="rm-auto" data-tag="${esc(t)}" title="Dismiss">×</span></span>`);
  return `<article class="card ${i === state.sel ? 'sel' : ''} ${open ? 'open' : ''}" data-id="${esc(b.id)}" data-i="${i}" tabindex="-1">
    <div class="meta"><span class="src ${esc(b.source)}">${esc(SOURCES[b.source] || b.source)}</span>
      ${MEDIA[b.mediaType] ? `<span class="kind">${MEDIA[b.mediaType]}</span>` : ''}
      ${b.author ? `<span>${esc(b.author)}</span>` : `<span>${esc(host(b.url))}</span>`}
      <span title="${esc(new Date(b.savedAt).toLocaleString())}">saved ${ago(b.savedAt)}</span>
      ${metricsLine(b)}
      ${colls.map((c) => `<span class="chip coll" data-act="goto-coll" data-cid="${esc(c.id)}">${esc(c.name)}</span>`).join('')}
    </div>
    <h3><a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener">${esc(b.title || b.url)}</a></h3>
    ${snippet ? `<div class="snip" data-act="toggle">${esc(snippet)}</div>` : ''}
    ${open ? '' : thumbImg(b, 'thumb')}
    <div class="foot">${tags.join('')}${auto.join('')}
      <input class="tagin" data-act="tagin" placeholder="+ tag" aria-label="Add tag">
      <span class="spacer"></span>
      <button class="icon" data-act="toggle" title="Details (space)">${open ? '▴' : '▾'}</button>
    </div>
    ${open ? extra(b) : ''}
  </article>`;
}

// "12K views · 1.4K likes · 120 comments", as of the last sync.
function metricsLine(b) {
  const m = b.metrics;
  if (!m) return '';
  const parts = [
    m.views != null && `${compact.format(m.views)} views`,
    m.likes != null && `${compact.format(m.likes)} like${m.likes === 1 ? '' : 's'}`,
    m.comments != null && `${compact.format(m.comments)} comment${m.comments === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  return `<span class="metrics" title="${esc(`Instagram’s counts as of ${new Date(m.at).toLocaleString()}`)}">${esc(parts.join(' · '))}</span>`;
}

function extra(b) {
  const related = relatedTo(b, 5);
  return `<div class="extra">
    ${thumbImg(b, 'big')}
    ${b.metrics?.at ? `<div class="hint">Counts as of ${esc(new Date(b.metrics.at).toLocaleString())}, from your last Instagram sync${b.metrics.likesHidden ? '. The creator hides like counts' : ''}.</div>` : ''}
    <label class="hint">Note<textarea data-act="note" placeholder="Why did you save this?">${esc(b.note)}</textarea></label>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select data-act="set-coll" aria-label="Collection"><option value="">${b.igCollections?.length ? 'No other collection' : 'No collection'}</option>
        ${state.collections.map((c) => `<option value="${esc(c.id)}" ${c.id === b.collectionId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        <option value="__new">+ New collection…</option></select>
      <button class="ghost" data-act="retag">Re-suggest tags</button>
      <button class="ghost" data-act="resurface">${b.reviewDue ? `Resurfaces ${new Date(b.reviewDue).toLocaleDateString()}` : 'Add to resurface'}</button>
      <span class="spacer" style="flex:1"></span>
      <button class="danger" data-act="delete">Delete</button>
    </div>
    ${related.length ? `<div class="related"><div class="hint">Related</div>${related.map((r) => `<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a>`).join('')}</div>` : ''}
  </div>`;
}

function relatedTo(b, n) {
  if (!b.embedding) return [];
  return state.bookmarks
    .filter((o) => o.id !== b.id && o.embedding)
    .map((o) => [o, cosine(b.embedding, o.embedding)])
    .filter(([, s]) => s > 0.45)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([o]) => o);
}

// ---------- list interactions ----------

async function update(id, patch, rerender = true) {
  const next = await db.patchBookmark(id, patch);
  if (next) {
    const i = state.bookmarks.findIndex((b) => b.id === id);
    state.bookmarks[i] = next;
    state.byId.set(id, next);
  }
  if (rerender) {
    renderNav();
    render();
  }
}

view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const cardEl = el.closest('.card');
  const id = cardEl?.dataset.id;
  const b = id && state.byId.get(id);
  if (cardEl) state.sel = Number(cardEl.dataset.i) || 0;
  const tag = el.dataset.tag;
  switch (el.dataset.act) {
    case 'toggle':
      if (getSelection().toString()) return;
      state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      return render();
    case 'tag':
      return go('#t/' + encodeURIComponent(tag));
    case 'rm-tag':
      e.stopPropagation();
      return update(id, { tags: b.tags.filter((t) => t !== tag) });
    case 'accept-tag':
      return update(id, { tags: [...(b.tags || []), tag], autoTags: b.autoTags.filter((t) => t !== tag) });
    case 'rm-auto':
      e.stopPropagation();
      return update(id, { autoTags: b.autoTags.filter((t) => t !== tag) });
    case 'goto-coll':
      return go('#c/' + el.dataset.cid);
    case 'retag':
      await send('retag', { ids: [id] });
      return toast('Re-tagging…');
    case 'resurface':
      await send('review', { id, action: b.reviewDue ? 'done' : 'requeue' });
      return toast(b.reviewDue ? 'Removed from resurfacing' : 'Will resurface today');
    case 'delete':
      return deleteBookmark(id);
    case 'more':
      state.limit += PAGE;
      return render();
    case 'open-url':
      return chrome.tabs.create({ url: el.dataset.url });
    case 'reddit-sync':
      return redditSync();
    case 'ig-sync':
      return instagramSync();
    case 'ig-import':
      e.preventDefault();
      return importInstagram();
    case 'rename-coll':
      return renameCollection(state.route.arg);
    case 'delete-coll':
      return deleteCollection(state.route.arg);
    case 'import':
      e.preventDefault();
      return importFile();
  }
});

// Hide thumbnails that fail to load (CSP forbids inline onerror handlers).
view.addEventListener('error', (e) => e.target.tagName === 'IMG' && (e.target.hidden = true), true);

view.addEventListener('change', async (e) => {
  const el = e.target;
  const id = el.closest('.card')?.dataset.id;
  if (!id) return;
  if (el.dataset.act === 'set-coll') {
    if (el.value === '__new') return newCollection(id);
    await update(id, { collectionId: el.value });
    toast(el.value ? 'Moved to collection' : 'Removed from collection');
  }
  if (el.dataset.act === 'note') {
    await update(id, { note: el.value.trim() }, false);
    toast('Note saved');
  }
});

view.addEventListener('keydown', async (e) => {
  const el = e.target;
  if (el.dataset?.act !== 'tagin') return;
  const id = el.closest('.card').dataset.id;
  if (e.key === 'Enter' && el.value.trim()) {
    const b = state.byId.get(id);
    const add = el.value.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    await update(id, { tags: [...new Set([...(b.tags || []), ...add])], autoTags: (b.autoTags || []).filter((t) => !add.includes(t)) });
    $(`.card[data-id="${CSS.escape(id)}"] .tagin`)?.focus();
  }
  if (e.key === 'Escape') el.blur();
});

async function deleteBookmark(id) {
  const b = state.byId.get(id);
  if (!b || !confirm(`Delete “${(b.title || b.url).slice(0, 80)}”?`)) return;
  await db.deleteBookmark(id);
  await load();
  send('refreshBadge').catch(() => {});
  toast('Deleted');
}

async function renameCollection(id) {
  const c = state.collections.find((x) => x.id === id);
  const name = c && prompt('Rename collection', c.name);
  if (!name?.trim()) return;
  await db.putCollection({ ...c, name: name.trim() });
  load();
}

async function deleteCollection(id) {
  const c = state.collections.find((x) => x.id === id);
  const note = c?.igId ? ' Instagram syncs won’t bring it back.' : '';
  if (!c || !confirm(`Delete collection “${c.name}”? Its bookmarks are kept.${note}`)) return;
  await db.deleteCollection(id);
  location.hash = '#all';
  load();
}

async function instagramSync(full = false) {
  try {
    const r = await send('instagramSync', { full });
    if (r?.error) throw new Error(r.error);
    if (r?.off) return toast('Instagram capture is off in Settings');
    if (r?.running) return toast('Instagram is already syncing in its tab');
    if (r?.cooldownUntil) return toast(`Instagram pushed back recently; see the card in the Instagram tab`);
    toast('Instagram sync started; progress is in the Instagram tab');
  } catch (e) {
    toast('Instagram sync failed: ' + e.message);
  }
}

// Instagram's own export: the .zip (any part of it), or saved_posts / saved_collections files from it.
function importInstagram() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.zip,.json,.html,application/zip,application/json,text/html';
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    toast('Reading Instagram export…');
    try {
      const { items, collections, read } = await readInstagramExport(files);
      if (!items.length) {
        throw new Error(
          read.length
            ? 'no saved posts found in it'
            : 'no saved posts found. Choose the export .zip, or saved_posts.json from inside it',
        );
      }
      // File posts under the Stash collections that mirror their Instagram collections.
      const map = collections.length ? await send('igCollections', { list: collections }) : {};
      for (const it of items) if (it.igCollectionsAdd) it.igCollectionsAdd = it.igCollectionsAdd.map((id) => map[id] || id);
      let added = 0;
      for (let i = 0; i < items.length; i += 300) {
        added += (await send('ingest', { items: items.slice(i, i + 300) })).added;
        toast(`Importing Instagram saves… ${Math.min(i + 300, items.length)} / ${items.length}`);
      }
      await load();
      const n = Object.keys(map).length;
      toast(`Imported ${items.length} Instagram saves (${added} new)${n ? ` and ${n} collection${n === 1 ? '' : 's'}` : ''}`);
    } catch (e) {
      toast('Instagram import failed: ' + e.message);
    }
  };
  input.click();
}

async function redditSync() {
  toast('Syncing Reddit…');
  try {
    const r = await send('redditSync');
    if (r?.error) throw new Error(r.error);
    toast(`Reddit: ${r.added} new of ${r.total} saved`);
  } catch (e) {
    toast('Reddit sync failed: ' + e.message);
  }
}

// ---------- search ----------

let qTimer;
$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  state.queryVec = null;
  state.sel = 0;
  state.limit = PAGE;
  if (state.route.view === 'p') return renderPeople();
  if (!['all', 's', 'c', 't'].includes(state.route.view)) location.hash = '#all';
  renderList();
  clearTimeout(qTimer);
  if (state.settings.localAi && state.query.trim().length > 2) {
    qTimer = setTimeout(async () => {
      const q = state.query;
      try {
        const [vec] = await send('embed', { texts: [q] });
        if (q === state.query) {
          state.queryVec = vec;
          renderList();
        }
      } catch {
        // model still downloading or unavailable: keyword results stand
      }
    }, 350);
  }
});

// ---------- review (spaced resurfacing) ----------

function dueList() {
  const now = Date.now();
  return state.bookmarks.filter((b) => b.reviewDue && b.reviewDue <= now).sort((a, b) => a.reviewDue - b.reviewDue);
}

function renderReview() {
  state.reviewQueue ??= dueList().slice(0, state.settings.reviewPerDay).map((b) => b.id);
  const q = state.reviewQueue;
  const b = q.length && state.byId.get(q[0]);
  if (!state.settings.resurface) {
    view.innerHTML = `<div class="empty"><h2>Resurfacing is off</h2><p>Turn it on in <a href="#settings">Settings</a> to get a few old bookmarks back each day.</p></div>`;
    return;
  }
  if (!b) {
    const next = state.bookmarks.filter((x) => x.reviewDue).sort((x, y) => x.reviewDue - y.reviewDue)[0];
    view.innerHTML = `<div class="empty"><h2>All caught up</h2><p>${
      next ? `Next bookmark resurfaces ${new Date(next.reviewDue).toLocaleDateString()}.` : 'New saves come back after 3 days, then 7, 21, 60 and 180.'
    }</p></div>`;
    return;
  }
  const total = q.length;
  view.innerHTML = `<div class="review">
    <div class="progress">${total} to revisit · <kbd>O</kbd> open · <kbd>K</kbd> keep · <kbd>S</kbd> snooze · <kbd>D</kbd> done · <kbd>X</kbd> delete</div>
    <article class="card open" data-id="${esc(b.id)}">
      <div class="meta"><span class="src ${esc(b.source)}">${esc(SOURCES[b.source])}</span><span>${esc(b.author || host(b.url))}</span><span>saved ${ago(b.savedAt)}</span></div>
      <h3><a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener">${esc(b.title || b.url)}</a></h3>
      <div class="snip">${esc((b.text || '').slice(0, 1500))}</div>
      ${b.note ? `<div class="hint" style="grid-column:1/-1;margin-top:8px">Your note: ${esc(b.note)}</div>` : ''}
    </article>
    <div class="actions">
      <button class="primary" data-review="open">Open</button>
      <button class="ghost" data-review="keep" title="Bring it back later, with a longer gap">Keep</button>
      <button class="ghost" data-review="snooze">Tomorrow</button>
      <button class="ghost" data-review="done" title="Stop resurfacing this one">Done with it</button>
      <button class="danger" data-review="delete">Delete</button>
    </div></div>`;
}

async function reviewAct(action) {
  const id = state.reviewQueue?.[0];
  if (!id) return;
  const b = state.byId.get(id);
  if (action === 'open') {
    chrome.tabs.create({ url: b.url, active: false });
    action = 'keep';
  }
  if (action === 'delete') {
    if (!confirm('Delete this bookmark?')) return;
    await db.deleteBookmark(id);
  } else {
    await send('review', { id, action });
  }
  state.reviewQueue.shift();
  const keepQueue = state.reviewQueue;
  await load();
  state.reviewQueue = keepQueue;
  renderReview();
  renderNav();
}

view.addEventListener('click', (e) => {
  const a = e.target.closest('[data-review]')?.dataset.review;
  if (a) reviewAct(a);
});

// ---------- ask your bookmarks ----------

function renderChat() {
  const s = state.settings;
  const api = apiConfigured(s);
  const msgs = state.chat
    .map((m) => {
      if (m.role === 'user') return `<div class="msg me">${esc(m.text)}</div>`;
      const srcs = (m.sourceIds || []).map((id, i) => {
        const b = state.byId.get(id);
        return b ? `<a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener">[${i + 1}] ${esc(b.title || b.url)} <span class="hint">· ${esc(SOURCES[b.source])}</span></a>` : '';
      });
      return `<div class="msg">${m.text ? esc(m.text) : ''}${srcs.length ? `<div class="srcs">${srcs.join('')}</div>` : ''}</div>`;
    })
    .join('');
  view.innerHTML = `<div class="chat">
    ${
      state.chat.length
        ? ''
        : `<div class="empty" style="padding:30px 0"><h2>Ask your bookmarks</h2><p>${
            api
              ? `Answers come from ${esc(s.apiModel)}, using only your most relevant saved items as context.`
              : 'With on-device AI only, you get the most relevant saved items for your question. Add an API key in <a href="#settings">Settings</a> to get written answers with citations.'
          }</p></div>`
    }
    ${msgs}
    <div class="ask"><textarea id="askIn" placeholder="e.g. What did I save about pricing pages?" aria-label="Question"></textarea>
    <button class="primary" id="askBtn">Ask</button></div></div>`;
  const input = $('#askIn');
  const ask = async () => {
    const question = input.value.trim();
    if (!question) return;
    state.chat.push({ role: 'user', text: question });
    state.chat.push({ role: 'assistant', text: 'Thinking…' });
    renderChat();
    const pending = state.chat[state.chat.length - 1];
    try {
      const history = state.chat.slice(0, -2).filter((m) => m.text);
      const r = await send('chat', { question, history });
      pending.text = r.answer ?? (r.sourceIds.length ? 'Most relevant bookmarks:' : 'Nothing in your stash matches that yet.');
      pending.sourceIds = r.sourceIds;
    } catch (e) {
      pending.text = 'Error: ' + e.message;
    }
    renderChat();
    view.scrollTop = view.scrollHeight;
  };
  $('#askBtn').onclick = ask;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };
  input.focus();
}

// ---------- settings ----------

function renderSettings() {
  const s = state.settings;
  const enrichedCount = state.bookmarks.filter((b) => b.embedding).length;
  view.innerHTML = `<form class="settings" id="settingsForm">
    <section><h3>Look</h3>
      <label>Name<input type="text" name="displayName" value="${esc(s.displayName)}" maxlength="30"></label>
      <div class="row">
        <label>Theme<select name="theme"><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Accent<input type="color" name="accent" value="${esc(s.accent)}"></label>
      </div>
    </section>

    <section><h3>Capture</h3>
      <label class="check"><input type="checkbox" name="captureX"> X / Twitter bookmarks (captured while you view x.com/i/bookmarks)</label>
      <label class="check"><input type="checkbox" name="xAutoSync"> Scroll the X bookmarks page automatically so older bookmarks load too</label>
      <label class="check"><input type="checkbox" name="captureReddit"> Reddit saved posts and comments</label>
      <label class="check"><input type="checkbox" name="redditAutoSync"> Sync Reddit quietly while browsing reddit.com (every 6 hours at most)</label>
      <label class="check"><input type="checkbox" name="captureLinkedIn"> LinkedIn saved posts (captured while you view the Saved posts page)</label>
      <label class="check"><input type="checkbox" name="captureInstagram"> Instagram saved posts and collections</label>
      <label class="check"><input type="checkbox" name="igAutoSync"> Sync Instagram when you open your Saved posts (at most once an hour, one request every few seconds)</label>
      <label class="check"><input type="checkbox" name="igThumbs"> Keep small copies of Instagram images in this browser (Instagram’s image links expire after a few days)</label>
      <div class="row"><button class="ghost" type="button" data-s="reddit">Sync Reddit now</button>
      <button class="ghost" type="button" data-s="x">Open X bookmarks</button>
      <button class="ghost" type="button" data-s="li">Open LinkedIn saved</button>
      <button class="ghost" type="button" data-s="ig">Sync Instagram now</button>
      <button class="ghost" type="button" data-s="ig-import">Import Instagram export…</button></div>
      ${igStatus()}
    </section>

    <section><h3>On-device AI</h3>
      <label class="check"><input type="checkbox" name="localAi"> Use the on-device model for meaning-based search, related items and tag suggestions</label>
      <p>Downloads a ~23 MB model once (all-MiniLM-L6-v2) from Hugging Face. After that, everything runs locally. ${enrichedCount}/${state.bookmarks.length} bookmarks indexed.</p>
      <label class="check"><input type="checkbox" name="autoTag"> Suggest tags automatically</label>
      <label>Tag suggestions come from<select name="taggingEngine"><option value="local">On-device model</option><option value="api">API model (below)</option></select></label>
      <div class="row"><button class="ghost" type="button" data-s="reindex">Re-index everything</button></div>
    </section>

    <section><h3>API model (optional)</h3>
      <p>Bring your own key for written answers in “Ask your bookmarks” and higher-quality tags. Your key is stored only in this browser. Bookmark text is sent to the provider only when you ask a question, or for tagging when the setting above is “API model”.</p>
      <label>Provider<select name="apiProvider"><option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio…)</option></select></label>
      <label data-openai>Base URL<input type="text" name="apiBaseUrl" value="${esc(s.apiBaseUrl)}" placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"></label>
      <label>Model<input type="text" name="apiModel" value="${esc(s.apiModel)}"></label>
      <label>API key<input type="password" name="apiKey" value="${esc(s.apiKey)}" autocomplete="off" placeholder="Leave empty for local servers like Ollama"></label>
      <div class="row"><button class="ghost" type="button" data-s="test">Test connection</button><span class="hint" id="testOut"></span></div>
    </section>

    <section><h3>Resurface</h3>
      <label class="check"><input type="checkbox" name="resurface"> Bring old bookmarks back on a spaced schedule (3 → 7 → 21 → 60 → 180 days)</label>
      <label class="check"><input type="checkbox" name="resurfaceNotify"> Daily notification when items are due</label>
      <label>Items per day<input type="number" name="reviewPerDay" min="1" max="50" value="${Number(s.reviewPerDay)}"></label>
    </section>

    <section><h3>Data</h3>
      <p>Everything is stored locally in this browser profile. Back it up regularly.</p>
      <div class="row">
        <button class="ghost" type="button" data-s="export-json">Export JSON backup</button>
        <button class="ghost" type="button" data-s="export-md">Export Markdown (Obsidian)</button>
        <button class="ghost" type="button" data-s="import">Import JSON</button>
        <button class="danger" type="button" data-s="wipe">Delete everything</button>
      </div>
    </section>

    <section><h3>Keyboard</h3>
      <p><kbd>Alt+Shift+S</kbd> save page · <kbd>Alt+Shift+K</kbd> side panel · <kbd>Alt+Shift+L</kbd> library · change these at chrome://extensions/shortcuts</p>
      <p><kbd>/</kbd> search · <kbd>Ctrl/⌘+K</kbd> palette · <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>O</kbd> open · <kbd>Space</kbd> details · <kbd>T</kbd> tag · <kbd>C</kbd> collection · <kbd>X</kbd> delete</p>
    </section>
  </form>`;

  const form = $('#settingsForm');
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else if (el.tagName === 'SELECT') el.value = s[el.name];
  }
  const syncOpenAi = () => form.querySelector('[data-openai]').toggleAttribute('hidden', form.apiProvider.value !== 'openai');
  syncOpenAi();

  form.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.name) return;
    let value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(1, Number(el.value) || 1) : el.value.trim();
    if (el.name === 'displayName') value = value || 'Stash';
    if (el.name === 'apiProvider') {
      const model = value === 'anthropic' ? 'claude-opus-5-5' : form.apiModel.value.startsWith('claude-') ? 'gpt-4o-mini' : form.apiModel.value;
      form.apiModel.value = model;
      await saveSettings({ apiModel: model });
    }
    if (['apiProvider', 'apiBaseUrl'].includes(el.name)) await ensureApiPermission(form);
    state.settings = await saveSettings({ [el.name]: value });
    applyLook();
    syncOpenAi();
    if (['resurface', 'reviewPerDay', 'accent'].includes(el.name)) send('refreshBadge').catch(() => {});
    if (el.name === 'localAi' && value) send('enrichNow').catch(() => {});
    if (el.name === 'igThumbs' && value) send('thumbsNow').catch(() => {});
    toast('Saved');
  });

  form.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (!a) return;
    if (a === 'reddit') return redditSync();
    if (a === 'x') return chrome.tabs.create({ url: 'https://x.com/i/bookmarks#stash-sync' });
    if (a === 'li') return chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-posts/' });
    if (a === 'ig') return instagramSync();
    if (a === 'ig-import') return importInstagram();
    if (a === 'reindex') {
      await send('reenrichAll');
      return toast('Re-indexing in the background…');
    }
    if (a === 'test') {
      const out = $('#testOut');
      out.textContent = 'Testing…';
      try {
        if (!(await ensureApiPermission(form))) throw new Error('Permission to reach the API was not granted.');
        await send('testApi');
        out.textContent = '✓ Connected';
      } catch (err) {
        out.textContent = '✗ ' + err.message;
      }
      return;
    }
    if (a === 'export-json') return download(await exportJson(), `stash-backup-${new Date().toISOString().slice(0, 10)}.json`);
    if (a === 'export-md') return download(await exportMarkdownZip(), `stash-markdown-${new Date().toISOString().slice(0, 10)}.zip`);
    if (a === 'import') return importFile();
    if (a === 'wipe') {
      if (prompt('Type DELETE to permanently remove all bookmarks and collections.') !== 'DELETE') return;
      await db.clearAll();
      await load();
      send('refreshBadge').catch(() => {});
      toast('Everything deleted');
    }
  });
}

function igStatus() {
  const ig = state.igState || {};
  const bits = [];
  if (ig.igLastSync) bits.push(`Instagram last synced ${ago(ig.igLastSync)}`);
  if (ig.igCooldownUntil > Date.now()) bits.push(`paused after Instagram pushed back, until ${new Date(ig.igCooldownUntil).toLocaleString()}`);
  return bits.length ? `<p>${esc(bits.join(' · '))}.</p>` : '';
}

// Host permission for the API endpoint is requested only when you configure one.
async function ensureApiPermission(form) {
  const origin = form.apiProvider.value === 'anthropic' ? 'https://api.anthropic.com/*' : originPattern(form.apiBaseUrl.value);
  if (!origin) return false;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

function originPattern(u) {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    try {
      const r = await importJson(await input.files[0].text());
      await load();
      send('enrichNow').catch(() => {});
      send('refreshBadge').catch(() => {});
      toast(`Imported ${r.added} new of ${r.total}`);
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
  };
  input.click();
}

// ---------- command palette ----------

const palette = { items: [], sel: 0 };

function commands() {
  const selected = state.visible[state.sel];
  const list = [
    { label: 'Go to All bookmarks', run: () => go('#all') },
    { label: 'Go to Resurface', run: () => go('#review') },
    { label: 'Ask your bookmarks', run: () => go('#ask') },
    { label: 'Settings', run: () => go('#settings') },
    ...Object.entries(SOURCES).map(([k, v]) => ({ label: `Source: ${v}`, run: () => go('#s/' + k) })),
    ...state.collections.map((c) => ({ label: `Collection: ${c.name}`, run: () => go('#c/' + c.id) })),
    { label: 'New collection…', run: () => newCollection() },
    ...[...peopleLists().keys()].map((k) => ({ label: `People: @${k.replace('/', ' · ')}`, run: () => go('#p/' + k) })),
    { label: 'Export JSON backup', run: async () => download(await exportJson(), 'stash-backup.json') },
    { label: 'Export Markdown (Obsidian)', run: async () => download(await exportMarkdownZip(), 'stash-markdown.zip') },
    { label: 'Import JSON backup', run: importFile },
    ...Object.entries(LIST_FORMATS).map(([k, v]) => ({ label: `Export this view as ${v}`, run: () => exportCurrent(k) })),
    { label: 'Sync Reddit now', run: redditSync },
    { label: 'Sync Instagram now', run: () => instagramSync() },
    { label: 'Full Instagram rescan', run: () => instagramSync(true) },
    { label: 'Import Instagram export…', run: importInstagram },
    { label: 'Open X bookmarks (sync)', run: () => chrome.tabs.create({ url: 'https://x.com/i/bookmarks#stash-sync' }) },
    { label: 'Open LinkedIn saved posts (sync)', run: () => chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-posts/' }) },
  ];
  if (PANEL) list.unshift({ label: 'Save current tab', run: saveTab });
  if (selected) {
    list.push(...state.collections.map((c) => ({ label: `Move “${(selected.title || '').slice(0, 30)}” to ${c.name}`, run: () => update(selected.id, { collectionId: c.id }) })));
    list.push({ label: `Re-suggest tags for selected`, run: () => send('retag', { ids: [selected.id] }) });
  }
  return list;
}

function openPalette(prefix = '') {
  $('#palette').hidden = false;
  const input = $('#paletteInput');
  input.value = prefix;
  renderPalette();
  input.focus();
}

function closePalette() {
  $('#palette').hidden = true;
}

function renderPalette() {
  const q = $('#paletteInput').value.toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const cmds = commands().filter((c) => terms.every((t) => c.label.toLowerCase().includes(t)));
  const bms = q.length > 1 ? rank(state.bookmarks, q, null).slice(0, 8).map((b) => ({ label: b.title || b.url, k: SOURCES[b.source], run: () => chrome.tabs.create({ url: b.url }) })) : [];
  palette.items = [...cmds.slice(0, 12), ...bms];
  palette.sel = 0;
  drawPalette();
}

function drawPalette() {
  $('#paletteList').innerHTML = palette.items
    .map((c, i) => `<li role="option" class="${i === palette.sel ? 'sel' : ''}" data-i="${i}"><span>${esc(c.label)}</span><span class="k">${esc(c.k || '')}</span></li>`)
    .join('') || '<li class="k">No results</li>';
  $('#paletteList .sel')?.scrollIntoView({ block: 'nearest' });
}

$('#paletteInput').addEventListener('input', renderPalette);
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') palette.sel = Math.min(palette.sel + 1, palette.items.length - 1), drawPalette(), e.preventDefault();
  if (e.key === 'ArrowUp') palette.sel = Math.max(palette.sel - 1, 0), drawPalette(), e.preventDefault();
  if (e.key === 'Enter') {
    const c = palette.items[palette.sel];
    closePalette();
    c?.run();
  }
  if (e.key === 'Escape') closePalette();
});
$('#paletteList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  closePalette();
  palette.items[Number(li.dataset.i)]?.run();
});
$('#palette').addEventListener('click', (e) => {
  if (e.target.id === 'palette') closePalette();
});
$('#paletteBtn').onclick = () => openPalette();
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');

// ---------- global keyboard ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return $('#palette').hidden ? openPalette() : closePalette();
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && document.activeElement === $('#q')) {
    $('#q').value = '';
    $('#q').dispatchEvent(new Event('input'));
    return $('#q').blur();
  }
  if (typing || !$('#palette').hidden || e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === '/') return e.preventDefault(), $('#q').focus();
  if (state.route.view === 'review') {
    const map = { o: 'open', k: 'keep', s: 'snooze', d: 'done', x: 'delete' };
    if (map[e.key]) return reviewAct(map[e.key]);
    return;
  }
  if (!['all', 's', 'c', 't'].includes(state.route.view)) return;
  const b = state.visible[state.sel];
  const move = (d) => {
    state.sel = Math.max(0, Math.min(state.visible.length - 1, state.sel + d));
    document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
    const el = $(`.card[data-i="${state.sel}"]`);
    el?.classList.add('sel');
    el?.scrollIntoView({ block: 'nearest' });
  };
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      return move(1);
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      return move(-1);
    case 'o':
    case 'Enter':
      if (b) chrome.tabs.create({ url: b.url, active: !e.shiftKey });
      return;
    case ' ':
      e.preventDefault();
      if (!b) return;
      state.open.has(b.id) ? state.open.delete(b.id) : state.open.add(b.id);
      return render();
    case 't':
      e.preventDefault();
      return $(`.card[data-i="${state.sel}"] .tagin`)?.focus();
    case 'c':
      if (b) openPalette('move');
      return;
    case 'x':
    case 'Delete':
      if (b) deleteBookmark(b.id);
      return;
    case '?':
      return toast('/ search · J/K move · O open · Space details · T tag · C collection · X delete · Ctrl+K palette');
  }
});

// ---------- side panel ----------

async function saveTab() {
  try {
    await send('saveCurrentTab');
    await load();
    toast('Saved');
  } catch (e) {
    toast(e.message);
  }
}

if (PANEL) {
  document.body.classList.add('panel');
  const btn = $('#saveTab');
  btn.hidden = false;
  btn.className = 'primary';
  btn.textContent = 'Save tab';
  btn.title = 'Save the current tab (Alt+Shift+S)';
  btn.onclick = saveTab;
  $('.bar').append(btn);
}

// ---------- boot ----------

parseRoute();
load();
