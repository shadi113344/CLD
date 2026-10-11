// Isolated-world side of Instagram capture:
//  - saves the posts ig-main.js sees Instagram load (Saved, and each collection)
//  - when Instagram loads your Saved posts or collections, or you press Sync in
//    Stash, pages through Saved and then each collection: one request every
//    few seconds, stopping at the first sign Instagram is unhappy.
// The first sync goes to your oldest saved post; later ones stop once they
// reach posts Stash already has. Automatic syncs run at most once an hour.
//
// Each collection is paged through Instagram's GraphQL request when Stash has
// learnt it (from the page, the first time you open a collection), else the
// old /api/v1 address. When neither works the card asks you to open one
// collection once; Stash then learns the request and syncs them.
(() => {
  const P = () => window.__stashProgress;
  const log = (...a) => console.info('[Stash]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const PACE = [2500, 4500]; // ms between requests to Instagram
  const AUTO_EVERY = 3600 * 1000;
  const COOLDOWN = { rate: 6 * 3600 * 1000, blocked: 24 * 3600 * 1000, checkpoint: 24 * 3600 * 1000 };
  const SAVED = '/api/v1/feed/saved/posts/';
  const COLLECTIONS =
    '/api/v1/collections/list/?collection_types=%5B%22ALL_MEDIA_AUTO_COLLECTION%22%2C%22MEDIA%22%2C%22AUDIO_AUTO_COLLECTION%22%5D&include_public_only=0&get_cover_media_lists=false';
  const collectionFeed = (igId) => `/api/v1/feed/collection/${igId}/posts/`;
  const savedPage = () => /^\/[A-Za-z0-9._]{1,30}\/saved(\/|$)/.test(location.pathname);
  const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';

  const run = { active: false, mode: 'new', added: 0, checked: new Set(), newIds: new Set(), collections: 0, requests: 0, lastBatch: 0, label: '', unsynced: [] };
  // Instagram's collection request, learnt on this page load (also kept in chrome.storage.local).
  let learnt = null;
  // What Instagram loaded before a sync started still counts toward it.
  const passive = { added: 0, seen: new Set(), newIds: new Set() };

  // UI must never break syncing, so every card update is best-effort.
  function ui(o) {
    try {
      P()?.update(o);
    } catch (e) {
      log('progress card failed', e);
    }
  }

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error || 'Stash did not answer');
    return res.result;
  }

  async function ingest(items) {
    items = (items || []).filter((t) => typeof t?.id === 'string' && t.id.startsWith('instagram:') && String(t.url).startsWith('https://www.instagram.com/'));
    if (!items.length) return { added: 0, addedIds: [], linked: 0 };
    return send({ type: 'ingest', items });
  }

  async function mirror(list) {
    if (!list?.length) return;
    await send({ type: 'igCollections', list });
  }

  // ---- what ig-main.js reports ----

  const waiting = new Map(); // request id -> resolve
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d?.__stash === 'ig-fetch-result') return waiting.get(d.id)?.(d.result);
    if (d?.__stash === 'ig-template') return learnTemplate(d.template).catch((err) => log('could not keep the collection request:', err.message));
    if (d?.__stash === 'ig-seen') return trigger(`Instagram loaded ${d.kind === 'collections' ? 'your collections' : d.kind === 'collection' ? 'a collection' : 'saved posts'}`);
    if (d?.__stash === 'ig-collections' && d.passive) return mirror(d.list).catch((err) => log('could not mirror collections:', err.message));
    if (d?.__stash !== 'ig-items' || !d.passive) return;
    try {
      const r = await ingest(d.items);
      log(`saved ${d.items.length} posts Instagram loaded, ${r.added} new`);
      const target = run.active ? run : passive;
      d.items.forEach((t) => (run.active ? run.checked.add(t.id) : passive.seen.add(t.id)));
      r.addedIds.forEach((id) => target.newIds.add(id));
      target.added += r.added;
      run.lastBatch = Date.now();
      if (run.active) progress();
    } catch (err) {
      log('could not save posts:', err.message);
    }
  });

  // The collection request ig-main.js learnt from the page: keep it (never
  // any tokens; ig-main.js leaves those out). If collections were waiting for
  // it and an automatic sync was skipped on this page, start one now.
  async function learnTemplate(t) {
    if (!t || typeof t !== 'object' || typeof t.docId !== 'string') return;
    learnt = { ...t, stale: false };
    const { igCollectionQuery: old } = await chrome.storage.local.get('igCollectionQuery');
    const same = old && !old.stale && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...learnt, at: 0 });
    if (!same) {
      await chrome.storage.local.set({ igCollectionQuery: learnt });
      log(old ? 'Instagram’s collection request changed; Stash will use the new one' : 'learnt Instagram’s collection request', `(${t.friendly || 'doc ' + t.docId})`);
    }
    if (skippedFor === location.pathname && !run.active) {
      triggeredFor = null;
      skippedFor = null;
      trigger('you opened a collection');
    }
  }

  let reqId = 0;
  function ask(msg) {
    const id = ++reqId + ':' + Math.random().toString(36).slice(2);
    run.requests++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done({ error: 'Instagram did not answer in time' }), 60000);
      const done = (r) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(r || { error: 'no answer' });
      };
      waiting.set(id, done);
      window.postMessage({ ...msg, id }, location.origin);
    });
  }
  const igFetch = (path) => ask({ __stash: 'ig-fetch', path });
  const igGql = (template, igId, cursor) => ask({ __stash: 'ig-gql', template, igId, cursor });
  const withMaxId = (path, cursor) => path + (cursor ? `?max_id=${encodeURIComponent(cursor)}` : '');

  // Wait between requests, in short steps so Stop is instant.
  async function pace() {
    const until = Date.now() + PACE[0] + Math.random() * (PACE[1] - PACE[0]);
    while (run.active && Date.now() < until) await sleep(200);
  }

  // ---- progress card ----

  function progress(extra) {
    if (extra) run.label = extra;
    ui({
      title: run.mode === 'all' ? 'Syncing all Instagram saved posts' : 'Syncing new Instagram saved posts',
      detail: `${run.added} new saved · ${run.checked.size} checked · ${run.label}`,
      value: null,
      actions: [{ label: 'Stop', onClick: stop }],
    });
  }

  const openStash = () => chrome.runtime.sendMessage({ type: 'openLibrary', hash: '#s/instagram' });
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---- the sync ----

  async function fetchCollections() {
    const list = [];
    let cursor = '';
    for (let page = 0; page < 20 && run.active; page++) {
      if (run.requests) await pace();
      if (!run.active) break;
      const r = await igFetch(COLLECTIONS + '&max_id=' + encodeURIComponent(cursor));
      if (r.pushback) return r;
      if (r.error) {
        log('could not list collections:', r.error);
        return { list: null };
      }
      list.push(...r.collections);
      if (!r.more || !r.next) break;
      cursor = r.next;
    }
    return { list };
  }

  // Page through one feed (Saved, or one collection) until the end, or, for a
  // "new" sync, until a page brings nothing Stash didn't already have. A
  // collection's first pass always goes to the end. fetchPage(cursor) asks
  // Instagram for one page.
  async function pageFeed(fetchPage, { igId = null, label, firstPass = false }) {
    let cursor = null;
    let page = 0;
    let retried = false;
    let sawCollectionIds = false;
    const ids = [];
    const cursors = new Set();
    while (run.active) {
      if (run.requests) await pace();
      if (!run.active) break;
      progress(`${label}: page ${page + 1}…`);
      const r = await fetchPage(cursor);
      if (!run.active) break;
      if (r.pushback) return r;
      if (r.error) {
        if (r.retry && !retried) {
          retried = true;
          progress(`${label}: Instagram hiccuped, trying once more in 10s…`);
          await sleep(10000);
          continue;
        }
        return { ...r, pages: page };
      }
      retried = false;
      page++;
      if (r.sawCollectionIds) sawCollectionIds = true;
      r.items.forEach((t) => ids.push(t.id));
      const res = await ingest(r.items);
      r.items.forEach((t) => run.checked.add(t.id));
      res.addedIds.forEach((id) => run.newIds.add(id));
      run.added += res.added;
      log(`${label} page ${page}: ${r.items.length} posts, ${res.added} new${igId ? `, ${res.linked} newly in this collection` : ''}`);
      progress(`${label}: page ${page}`);
      if (!r.more || !r.next || cursors.has(r.next)) return { complete: true, ids, sawCollectionIds };
      if (run.mode === 'new' && !firstPass) {
        const fresh = r.items.some((t) => run.newIds.has(t.id)) || (igId && res.linked > 0);
        if (!fresh) return { complete: false, ids, sawCollectionIds };
      }
      cursors.add(r.next);
      cursor = r.next;
    }
    return { stopped: true };
  }

  // Page one collection: through the learnt GraphQL request, else the old
  // REST address. Returns null when neither works. A 404 or a web page here
  // means "this address is gone", never "logged out", and doesn't stop the sync.
  async function syncCollection(c, paths, firstPass) {
    const opts = { igId: c.igId, label: c.name, firstPass };
    if (paths.query) {
      const r = await pageFeed((cursor) => igGql(paths.query, c.igId, cursor), opts);
      if (r.pushback || r.stopped) return r;
      if (!r.stale && !r.gone) return { ...r, via: 'GraphQL' };
      log(`collection ${c.name}: Instagram’s collection request stopped working (${r.error})`);
      paths.query = null;
      learnt = null;
      const { igCollectionQuery: q } = await chrome.storage.local.get('igCollectionQuery');
      if (q) await chrome.storage.local.set({ igCollectionQuery: { ...q, stale: true } });
    }
    if (!paths.restGone) {
      const r = await pageFeed((cursor) => igFetch(withMaxId(collectionFeed(c.igId), cursor)), opts);
      if (r.pushback || r.stopped) return r;
      if (!r.gone) return { ...r, via: 'REST' };
      log(`collection ${c.name}: the old collection address is gone (${r.error})`);
      paths.restGone = true;
    }
    return null;
  }

  async function syncCollections(list) {
    const st = await chrome.storage.local.get(['igCollectionQuery', 'igCollectionsDone']);
    const done = st.igCollectionsDone || {};
    const stored = st.igCollectionQuery && !st.igCollectionQuery.stale ? st.igCollectionQuery : null;
    const paths = { query: learnt || stored, restGone: false };
    const unsynced = [];
    for (const c of list) {
      const r = await syncCollection(c, paths, !done[c.igId]);
      if (r?.pushback || r?.stopped) return r;
      if (!r) {
        log(`collection ${c.name}: not synced; Stash needs to see Instagram load one collection first`);
        unsynced.push(c);
      } else if (r.error) log(`collection ${c.name} failed (via ${r.via}):`, r.error);
      else {
        log(`collection ${c.name}: ${r.complete ? 'complete' : 'up to date'} (via ${r.via})`);
        if (r.complete) {
          done[c.igId] = Date.now();
          if (run.mode === 'all') await send({ type: 'igCollectionFinalize', igId: c.igId, keepIds: r.ids });
        }
      }
    }
    await chrome.storage.local.set({ igCollectionsDone: done, igCollectionsPending: unsynced.length > 0 });
    return { unsynced };
  }

  async function syncAll() {
    // 1. Your collections, so they exist in Stash before posts are filed into them.
    const cols = await fetchCollections();
    if (cols.pushback || !run.active) return cols.pushback ? cols : { stopped: true };
    let list = cols.list;
    if (list) {
      run.collections = list.length;
      await mirror(list);
    } else {
      // The list request failed: use the collections Stash already knows
      // (listed before, or named in Instagram's data on this or another visit).
      list = await send({ type: 'igKnownCollections' }).catch(() => null);
      if (list?.length) log(`using the ${list.length} collections Stash already knows`);
      run.collections = list?.length || 0;
    }
    // 2. Everything you saved, newest first.
    const main = await pageFeed((cursor) => igFetch(withMaxId(SAVED, cursor)), { label: 'Saved' });
    if (main.pushback || main.stopped) return main;
    if (main.error) {
      log('direct paging failed:', main.error);
      if (savedPage()) return viaScrolling();
      return { error: `${main.error}. Open your profile → Saved and Stash will save posts as you scroll.` };
    }
    if (main.complete) await chrome.storage.local.set({ igFullSyncDone: true });
    // 3. Each collection. A full sync can skip this when Saved already said
    //    which collections each post is in.
    if (list?.length) {
      if (run.mode === 'all' && main.sawCollectionIds) {
        const st = await chrome.storage.local.get('igCollectionsDone');
        const done = st.igCollectionsDone || {};
        list.forEach((c) => (done[c.igId] = Date.now()));
        await chrome.storage.local.set({ igCollectionsDone: done, igCollectionsPending: false });
      } else {
        const r = await syncCollections(list);
        if (r.pushback || r.stopped) return r;
        run.unsynced = r.unsynced;
      }
    }
    return { done: main.complete ? 'Reached the end' : 'Up to date' };
  }

  // Fallback when Instagram won't answer Stash's own requests: scroll the
  // Saved grid so Instagram's app loads more, and save what it loads.
  async function viaScrolling() {
    progress('switching to scrolling…');
    let stalls = 0;
    let quietPages = 0;
    let last = run.checked.size;
    let lastNew = run.added;
    while (run.active && savedPage()) {
      if (document.hidden) {
        progress('paused — switch to this tab to continue');
        await sleep(1000);
        run.lastBatch = Date.now();
        continue;
      }
      window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
      await pace();
      const grew = run.checked.size !== last;
      if (grew) quietPages = run.added === lastNew ? quietPages + 1 : 0;
      last = run.checked.size;
      lastNew = run.added;
      stalls = !grew && Date.now() - run.lastBatch > 4000 ? stalls + 1 : 0;
      progress(stalls >= 2 ? `waiting for Instagram to load more (${stalls}/6)…` : 'scrolling…');
      if (run.mode === 'new' && quietPages >= 2) return { done: 'Up to date' };
      if (stalls >= 6) return { done: 'Reached the end' };
    }
    return { stopped: true };
  }

  async function start(mode, why) {
    if (run.active) return { running: true };
    Object.assign(run, {
      active: true,
      mode,
      added: passive.added,
      checked: new Set(passive.seen),
      newIds: new Set(passive.newIds),
      collections: 0,
      requests: 0,
      lastBatch: Date.now(),
      label: 'starting…',
      unsynced: [],
    });
    Object.assign(passive, { added: 0, seen: new Set(), newIds: new Set() });
    finished = false;
    log('Instagram sync started:', mode, '—', why);
    progress('starting, one request every few seconds…');
    await chrome.storage.local.set({ igLastSync: Date.now() });
    let outcome;
    try {
      outcome = await syncAll();
    } catch (e) {
      outcome = { error: String(e?.message || e) };
    }
    finish(outcome);
    return { started: true };
  }

  function stop() {
    run.active = false;
    finish({ stopped: true });
  }

  let finished = true;
  async function finish(o) {
    if (finished) return;
    finished = true;
    run.active = false;
    const counts = `${run.added} new saved post${run.added === 1 ? '' : 's'} · ${run.checked.size} checked${run.collections ? ` · ${run.collections} collection${run.collections === 1 ? '' : 's'}` : ''}`;
    log('Instagram sync finished:', JSON.stringify(o), '—', counts, `· ${run.requests} requests`);
    if (o.pushback) {
      const wait = COOLDOWN[o.pushback];
      const until = wait ? Date.now() + wait : 0;
      if (until) await chrome.storage.local.set({ igCooldownUntil: until, igLastPushback: { kind: o.pushback, message: o.message, at: Date.now() } });
      const next =
        o.pushback === 'login'
          ? ' Log in to Instagram, then open your Saved posts again.'
          : o.pushback === 'checkpoint'
            ? ` Open instagram.com and follow its prompt. Stash won’t sync automatically until ${time(until)} tomorrow.`
            : ` Stash stopped to protect your account and won’t sync automatically until ${time(until)}${wait > 12 * 3600 * 1000 ? ' tomorrow' : ''}.`;
      return ui({
        title: o.pushback === 'login' ? 'Instagram sync stopped' : 'Instagram sync paused',
        detail: `${o.message}${next} ${counts}.`,
        value: 0,
        actions: [
          { label: 'Open in Stash', onClick: openStash },
          { label: 'Close', primary: true, onClick: () => P().hide() },
        ],
      });
    }
    if (o.error) {
      return ui({
        title: 'Instagram sync stopped',
        detail: `${o.error} · ${counts}`,
        value: 0,
        actions: [
          { label: 'Try again', onClick: () => start(run.mode, 'retry') },
          { label: 'Close', primary: true, onClick: () => P().hide() },
        ],
      });
    }
    const why = o.stopped ? 'Stopped' : o.done;
    const waitingCols = o.stopped ? [] : run.unsynced;
    if (waitingCols.length) {
      // Instagram's collection request hasn't been seen yet: one visit teaches it.
      const n = waitingCols.length;
      const first = waitingCols[0];
      const user = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/saved(\/|$)/)?.[1] || (await chrome.storage.local.get('igUsername')).igUsername;
      return ui({
        title: `Instagram sync: ${why.toLowerCase()}`,
        detail: `${counts}. ${n} collection${n === 1 ? ' wasn’t' : 's weren’t'} synced: Instagram changed how collections load. Open one collection on Instagram once, and Stash will sync ${n === 1 ? 'it' : 'them'}.`,
        value: 1,
        actions: [
          ...(user ? [{ label: `Open ${first.name}`, primary: true, onClick: () => location.assign(`/${user}/saved/${slug(first.name)}/${first.igId}/`) }] : []),
          { label: 'Open in Stash', onClick: openStash },
          { label: 'Done', primary: !user, onClick: () => P().hide() },
        ],
      });
    }
    ui({
      title: `Instagram sync: ${why.toLowerCase()}`,
      detail: counts,
      value: 1,
      actions: [
        { label: 'Full rescan', onClick: () => start('all', 'full rescan') },
        { label: 'Open in Stash', onClick: openStash },
        { label: 'Done', primary: true, onClick: () => P().hide() },
      ],
    });
  }

  // ---- when to sync ----

  async function state() {
    const st = await chrome.storage.local.get(['settings', 'igFullSyncDone', 'igLastSync', 'igCooldownUntil', 'igCollectionsPending']);
    return { s: st.settings || {}, mode: st.igFullSyncDone ? 'new' : 'all', last: st.igLastSync || 0, cooldown: st.igCooldownUntil || 0, pending: Boolean(st.igCollectionsPending) };
  }

  function offerAfterCooldown(cooldown, mode) {
    ui({
      title: 'Instagram sync is paused',
      detail: `Instagram pushed back last time, so Stash is waiting until ${time(cooldown)} before syncing again. Posts Instagram shows you are still saved.`,
      value: 0,
      actions: [
        { label: 'Sync anyway', onClick: () => start(mode, 'sync anyway') },
        { label: 'OK', primary: true, onClick: () => P().hide() },
      ],
    });
  }

  function rememberUser() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/saved(\/|$)/);
    if (m) chrome.storage.local.set({ igUsername: m[1] });
  }

  // Start at most once per page view, as soon as Instagram loads something from Saved.
  let triggeredFor = null;
  let skippedFor = null; // page where an automatic sync was skipped because the last one was recent
  async function trigger(why) {
    rememberUser();
    if (run.active || triggeredFor === location.pathname) return;
    triggeredFor = location.pathname;
    const { s, mode, last, cooldown, pending } = await state();
    if (s.captureInstagram === false) return log('Instagram capture is off in settings');
    if (cooldown > Date.now()) return offerAfterCooldown(cooldown, mode);
    if (s.igAutoSync === false) {
      return ui({
        title: 'Sync your Instagram saved posts?',
        detail: 'Stash goes through Saved and your collections slowly, one request every few seconds.',
        value: 0,
        actions: [
          { label: 'Sync everything', onClick: () => start('all', 'asked: everything') },
          { label: 'Sync new', primary: true, onClick: () => start(mode, 'asked: new') },
        ],
      });
    }
    // Collections waiting for the request Instagram just showed: don't make you wait an hour.
    const teaching = pending && Boolean(learnt);
    if (mode === 'new' && Date.now() - last < AUTO_EVERY && !teaching) {
      skippedFor = location.pathname;
      return log(`auto-sync skipped: last sync ${Math.round((Date.now() - last) / 60000)} min ago (saving what Instagram loads)`);
    }
    const reason = teaching ? `${why}; learnt Instagram’s collection request` : why;
    log('auto-sync triggered:', reason);
    start(mode, reason);
  }

  // "Download media" in Stash: the library asks this tab for a post's files,
  // one post at a time, so the request carries this page's session and headers.
  const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function pkOf(code) {
    let n = 0n;
    for (const ch of String(code).slice(0, 11)) {
      const i = SHORTCODE.indexOf(ch);
      if (i < 0) return null;
      n = n * 64n + BigInt(i);
    }
    return n ? n.toString() : null;
  }
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== 'ig-media') return;
    const pk = pkOf(msg.code);
    if (!pk) return sendResponse({ error: 'not an Instagram post' });
    ask({ __stash: 'ig-media', pk }).then(sendResponse);
    return true;
  });

  // "Sync Instagram now" in Stash.
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== 'ig-sync') return;
    (async () => {
      const { s, mode, cooldown } = await state();
      if (s.captureInstagram === false) return { off: true };
      if (run.active) return { running: true };
      const m = msg.full ? 'all' : mode;
      if (cooldown > Date.now()) {
        offerAfterCooldown(cooldown, m);
        return { cooldownUntil: cooldown };
      }
      triggeredFor = location.pathname;
      start(m, 'asked from Stash');
      return { started: true };
    })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });

  log('Instagram capture loaded on', location.pathname);
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      triggeredFor = null;
    }
    // Backup trigger in case Instagram's request was missed: the URL is a Saved page.
    if (savedPage() && !run.active && triggeredFor !== location.pathname) setTimeout(() => savedPage() && trigger('Saved page URL'), 4000);
  }, 1000);
})();
