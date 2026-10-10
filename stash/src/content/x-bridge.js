// Isolated-world side of X capture:
//  - relays bookmarks parsed by x-main.js to the extension
//  - on x.com/i/bookmarks, offers (or, when opened from Stash, starts) an
//    auto-scroll that walks the whole timeline so older bookmarks load too,
//    with a progress card showing what's happening.
(() => {
  const P = () => window.__stashProgress;
  const onBookmarksPage = () => /^\/i\/bookmarks/.test(location.pathname);

  const run = {
    active: false,
    mode: 'new', // 'new' stops once it reaches bookmarks Stash already has; 'all' goes to the end
    seen: new Set(),
    added: 0,
    knownStreak: 0,
    lastBatch: 0,
  };
  // Bookmarks X loaded before a sync run started still count toward that run.
  let passiveAdded = 0;
  const passiveSeen = new Set();

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__stash !== 'x-bookmarks') return;
    const items = (e.data.tweets || []).filter((t) => typeof t?.id === 'string' && t.id.startsWith('x:'));
    if (!items.length) return;
    const res = await chrome.runtime.sendMessage({ type: 'ingest', items });
    const added = res?.ok ? res.result.added : 0;
    if (run.active) {
      items.forEach((t) => run.seen.add(t.id));
      run.added += added;
      run.knownStreak = added ? 0 : run.knownStreak + 1;
      run.lastBatch = Date.now();
      progress();
    } else {
      items.forEach((t) => passiveSeen.add(t.id));
      if (!added) return;
      passiveAdded += added;
      window.__stashToast?.(`Stash: ${passiveAdded} new X bookmark${passiveAdded > 1 ? 's' : ''} saved`);
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function progress() {
    P()?.update({
      title: run.mode === 'all' ? 'Syncing all X bookmarks' : 'Syncing new X bookmarks',
      detail: `${run.added} new saved · ${run.seen.size} checked · scrolling…`,
      value: null,
      actions: [{ label: 'Stop', onClick: () => finish('Stopped') }],
    });
  }

  async function start(mode) {
    if (run.active) return;
    Object.assign(run, { active: true, mode, seen: new Set(passiveSeen), added: passiveAdded, knownStreak: 0, lastBatch: Date.now() });
    passiveSeen.clear();
    passiveAdded = 0;
    progress();
    window.scrollTo(0, 0);
    await sleep(800);
    let stalls = 0;
    let lastHeight = 0;
    while (run.active && onBookmarksPage()) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1300 + Math.random() * 700);
      // X shows a "Retry" button when it rate-limits; press it and give it time.
      const retry = [...document.querySelectorAll('[role="button"],button')].find((b) => /^\s*retry\s*$/i.test(b.textContent));
      if (retry) {
        retry.click();
        await sleep(4000);
      }
      const h = document.documentElement.scrollHeight;
      const quiet = Date.now() - run.lastBatch > 2500;
      stalls = h === lastHeight && quiet ? stalls + 1 : 0;
      lastHeight = h;
      if (run.mode === 'new' && run.knownStreak >= 3) return finish('Up to date');
      if (stalls >= 6) return finish('Reached the end');
    }
    if (run.active) finish('Stopped');
  }

  function finish(why) {
    if (!run.active) return;
    run.active = false;
    P()?.update({
      title: `X sync: ${why.toLowerCase()}`,
      detail: `${run.added} new bookmark${run.added === 1 ? '' : 's'} saved · ${run.seen.size} checked`,
      value: 1,
      actions: [
        { label: 'Full rescan', onClick: () => start('all') },
        { label: 'Done', primary: true, onClick: () => P().hide() },
      ],
    });
  }

  function offer() {
    P()?.update({
      title: 'Stash can sync your X bookmarks',
      detail: 'It scrolls this page for you so older bookmarks load too. Keep this tab open.',
      value: 0,
      actions: [
        { label: 'Sync everything', onClick: () => start('all') },
        { label: 'Sync new', primary: true, onClick: () => start('new') },
      ],
    });
  }

  // X is a single-page app, so watch for navigation to and from the bookmarks page.
  let wasOn = false;
  const autoStart = /stash-sync/.test(location.hash);
  setInterval(() => {
    const on = onBookmarksPage();
    if (on && !wasOn) setTimeout(() => (autoStart && !run.seen.size ? start('new') : offer()), 1500);
    if (!on && wasOn) {
      run.active = false;
      P()?.hide();
    }
    wasOn = on;
  }, 1000);
})();
