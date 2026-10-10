// Isolated-world side of X capture:
//  - relays bookmarks parsed by x-main.js to the extension
//  - on x.com/i/bookmarks, automatically scrolls the timeline so older
//    bookmarks load too, with a progress card. The first run goes to the very
//    end; later runs stop once they reach bookmarks Stash already has.
(() => {
  const P = () => window.__stashProgress;
  const log = (...a) => console.debug('[Stash]', ...a);
  const onBookmarksPage = () => /^\/i\/bookmarks/.test(location.pathname);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const run = { active: false, mode: 'new', seen: new Set(), added: 0, knownStreak: 0, lastBatch: 0 };
  // Bookmarks X loaded before a run started still count toward it.
  let passiveAdded = 0;
  const passiveSeen = new Set();

  // UI must never break syncing, so every card update is best-effort.
  function ui(o) {
    try {
      P()?.update(o);
    } catch (e) {
      log('progress card failed', e);
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__stash !== 'x-bookmarks') return;
    const items = (e.data.tweets || []).filter((t) => typeof t?.id === 'string' && t.id.startsWith('x:'));
    if (!items.length) return;
    const res = await chrome.runtime.sendMessage({ type: 'ingest', items });
    const added = res?.ok ? res.result.added : 0;
    log(`batch of ${items.length}, ${added} new`);
    if (run.active) {
      items.forEach((t) => run.seen.add(t.id));
      run.added += added;
      run.knownStreak = added ? 0 : run.knownStreak + 1;
      run.lastBatch = Date.now();
      progress();
    } else {
      items.forEach((t) => passiveSeen.add(t.id));
      passiveAdded += added;
    }
  });

  function progress(extra = 'scrolling…') {
    ui({
      title: run.mode === 'all' ? 'Syncing all X bookmarks' : 'Syncing new X bookmarks',
      detail: `${run.added} new saved · ${run.seen.size} checked · ${extra}`,
      value: null,
      actions: [{ label: 'Stop', onClick: () => finish('Stopped') }],
    });
  }

  function scrollDown() {
    // X renders each post in a "cellInnerDiv"; bringing the last one into view
    // is what triggers X's loader. Also push the window to the bottom.
    const cells = document.querySelectorAll('[data-testid="cellInnerDiv"], article');
    cells[cells.length - 1]?.scrollIntoView({ block: 'end' });
    const se = document.scrollingElement || document.documentElement;
    window.scrollTo(0, se.scrollHeight);
    se.scrollTop = se.scrollHeight;
  }

  async function start(mode) {
    if (run.active) return;
    Object.assign(run, { active: true, mode, seen: new Set(passiveSeen), added: passiveAdded, knownStreak: 0, lastBatch: Date.now() });
    passiveSeen.clear();
    passiveAdded = 0;
    log('sync started', mode);
    progress('starting…');
    let stalls = 0;
    let lastHeight = 0;
    let lastCount = 0;
    while (run.active && onBookmarksPage()) {
      // Hidden tabs don't render, so X never loads more. Wait until visible.
      if (document.hidden) {
        progress('paused — switch to this tab to continue');
        await sleep(1000);
        run.lastBatch = Date.now();
        continue;
      }
      scrollDown();
      await sleep(1500 + Math.random() * 700);
      const retry = [...document.querySelectorAll('[role="button"],button')].find((b) => /^\s*retry\s*$/i.test(b.textContent));
      if (retry) {
        progress('X asked to retry, retrying…');
        retry.click();
        await sleep(5000);
        stalls = 0;
        continue;
      }
      const h = (document.scrollingElement || document.documentElement).scrollHeight;
      const grew = h !== lastHeight || run.seen.size !== lastCount;
      const quiet = Date.now() - run.lastBatch > 3000;
      stalls = !grew && quiet ? stalls + 1 : 0;
      lastHeight = h;
      lastCount = run.seen.size;
      if (stalls >= 3) progress(`waiting for X to load more (${stalls}/8)…`);
      if (run.mode === 'new' && run.knownStreak >= 3) return finish('Up to date');
      if (stalls >= 8) return finish('Reached the end');
    }
    if (run.active) finish('Stopped');
  }

  async function finish(why) {
    if (!run.active) return;
    run.active = false;
    log('sync finished', why, run.added, run.seen.size);
    if (why === 'Reached the end') await chrome.storage.local.set({ xFullSyncDone: true });
    ui({
      title: `X sync: ${why.toLowerCase()}`,
      detail: `${run.added} new bookmark${run.added === 1 ? '' : 's'} saved · ${run.seen.size} checked`,
      value: 1,
      actions: [
        { label: 'Full rescan', onClick: () => start('all') },
        { label: 'Done', primary: true, onClick: () => P().hide() },
      ],
    });
  }

  async function onEnter() {
    const { settings = {}, xFullSyncDone } = await chrome.storage.local.get(['settings', 'xFullSyncDone']);
    if (settings.captureX === false) return;
    const mode = xFullSyncDone ? 'new' : 'all';
    if (settings.xAutoSync === false) {
      ui({
        title: 'Sync your X bookmarks?',
        detail: 'Stash scrolls this page so older bookmarks load too.',
        value: 0,
        actions: [
          { label: 'Sync everything', onClick: () => start('all') },
          { label: 'Sync new', primary: true, onClick: () => start('new') },
        ],
      });
      return;
    }
    start(mode);
  }

  // X is a single-page app, so watch for navigation to and from the bookmarks page.
  let wasOn = false;
  setInterval(() => {
    const on = onBookmarksPage();
    if (on && !wasOn) setTimeout(() => onBookmarksPage() && !run.active && onEnter(), 2000);
    if (!on && wasOn && run.active) finish('Stopped');
    wasOn = on;
  }, 1000);
})();
