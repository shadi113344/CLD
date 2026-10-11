// Isolated-world side of Instagram capture:
//  - saves the posts ig-main.js sees Instagram load (Saved, and each collection)
//  - when Instagram loads your Saved posts or collections, or you press Sync in
//    Stash, pages through Saved and then each collection: one request every
//    few seconds, stopping at the first sign Instagram is unhappy.
// The first sync goes to your oldest saved post; later ones stop once they
// reach posts Stash already has. Automatic syncs run at most once an hour.
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

  const run = { active: false, mode: 'new', added: 0, checked: new Set(), newIds: new Set(), collections: 0, requests: 0, lastBatch: 0, label: '' };
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
    if (d?.__stash === 'ig-seen') return trigger(`Instagram loaded ${d.kind === 'collections' ? 'your collections' : 'saved posts'}`);
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

  let reqId = 0;
  function igFetch(path) {
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
      window.postMessage({ __stash: 'ig-fetch', id, path }, location.origin);
    });
  }

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
  // "new" sync, until a page brings nothing Stash didn't already have.
  async function pageFeed(path, { igId = null, label }) {
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
      const r = await igFetch(path + (cursor ? `?max_id=${encodeURIComponent(cursor)}` : ''));
      if (!run.active) break;
      if (r.pushback) return r;
      if (r.error) {
        if (r.retry && !retried) {
          retried = true;
          progress(`${label}: Instagram hiccuped, trying once more in 10s…`);
          await sleep(10000);
          continue;
        }
        return r;
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
      if (run.mode === 'new') {
        const fresh = r.items.some((t) => run.newIds.has(t.id)) || (igId && res.linked > 0);
        if (!fresh) return { complete: false, ids, sawCollectionIds };
      }
      cursors.add(r.next);
      cursor = r.next;
    }
    return { stopped: true };
  }

  async function syncAll() {
    // 1. Your collections, so they exist in Stash before posts are filed into them.
    const cols = await fetchCollections();
    if (cols.pushback || !run.active) return cols.pushback ? cols : { stopped: true };
    if (cols.list) {
      run.collections = cols.list.length;
      await mirror(cols.list);
    }
    // 2. Everything you saved, newest first.
    const main = await pageFeed(SAVED, { label: 'Saved' });
    if (main.pushback || main.stopped) return main;
    if (main.error) {
      log('direct paging failed:', main.error);
      if (savedPage()) return viaScrolling();
      return { error: `${main.error}. Open your profile → Saved and Stash will save posts as you scroll.` };
    }
    if (main.complete) await chrome.storage.local.set({ igFullSyncDone: true });
    // 3. Each collection. A full sync can skip this when Saved already said
    //    which collections each post is in.
    if (cols.list?.length && !(run.mode === 'all' && main.sawCollectionIds)) {
      for (const c of cols.list) {
        const r = await pageFeed(collectionFeed(c.igId), { igId: c.igId, label: c.name });
        if (r.pushback || r.stopped) return r;
        if (r.error) log(`collection ${c.name} failed:`, r.error);
        else if (r.complete && run.mode === 'all') await send({ type: 'igCollectionFinalize', igId: c.igId, keepIds: r.ids });
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
    const st = await chrome.storage.local.get(['settings', 'igFullSyncDone', 'igLastSync', 'igCooldownUntil']);
    return { s: st.settings || {}, mode: st.igFullSyncDone ? 'new' : 'all', last: st.igLastSync || 0, cooldown: st.igCooldownUntil || 0 };
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
  async function trigger(why) {
    rememberUser();
    if (run.active || triggeredFor === location.pathname) return;
    triggeredFor = location.pathname;
    const { s, mode, last, cooldown } = await state();
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
    if (mode === 'new' && Date.now() - last < AUTO_EVERY) {
      return log(`auto-sync skipped: last sync ${Math.round((Date.now() - last) / 60000)} min ago (saving what Instagram loads)`);
    }
    log('auto-sync triggered:', why);
    start(mode, why);
  }

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
