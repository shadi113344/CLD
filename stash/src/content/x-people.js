// X Following / Followers lists. On x.com/<handle>/following (or /followers,
// /verified_followers) Stash offers to save the whole list, then pages through
// it with the same request X's app uses, falling back to scrolling.
(() => {
  const P = () => window.__stashProgress;
  const log = (...a) => console.info('[Stash people]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RELATIONS = { following: 'following', followers: 'followers', verified_followers: 'verified_followers' };
  const LABEL = { following: 'following', followers: 'followers', verified_followers: 'verified followers' };

  function listFromPath() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(following|followers|verified_followers)\/?$/);
    return m ? { owner: m[1].toLowerCase(), ownerHandle: m[1], relation: RELATIONS[m[2]] } : null;
  }

  let list = null; // current page's list
  let buffer = new Map(); // people X already loaded before the user said "save"
  const run = { active: false, saved: 0, seen: new Set(), lastBatch: 0 };
  let statusListener = null;

  function ui(o) {
    try {
      P()?.update(o);
    } catch (e) {
      log('card failed', e);
    }
  }

  async function save(people) {
    if (!people.length || !list) return;
    const res = await chrome.runtime.sendMessage({ type: 'ingestPeople', owner: list.owner, relation: list.relation, people });
    if (res?.ok) run.saved += res.result.added;
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d?.__stash === 'x-template' && d.kind === 'people') onListPage();
    if (d?.__stash === 'x-paginate-status' && d.kind === 'people') statusListener?.(d);
    if (d?.__stash === 'x-people') {
      const people = (d.people || []).filter((p) => typeof p?.id === 'string' && p.id.startsWith('x:'));
      if (run.active) {
        people.forEach((p) => run.seen.add(p.id));
        run.lastBatch = Date.now();
        await save(people);
        progress();
      } else {
        people.forEach((p) => buffer.set(p.id, p));
      }
    }
  });

  function title() {
    return `@${list.ownerHandle} · ${LABEL[list.relation]}`;
  }

  function progress(extra = 'loading…') {
    ui({ title: `Saving ${title()}`, detail: `${run.seen.size} people · ${extra}`, value: null, actions: [{ label: 'Stop', onClick: stop }] });
  }

  let offeredFor = null;
  function onListPage() {
    const l = listFromPath();
    if (!l || run.active) return;
    const key = `${l.owner}/${l.relation}`;
    if (offeredFor === key) return;
    offeredFor = key;
    list = l;
    log('list detected', key);
    ui({
      title: `Save ${title()}?`,
      detail: 'Stash will go through the whole list and keep it in your library, where you can export it.',
      value: 0,
      actions: [
        { label: 'Not now', onClick: () => P().hide() },
        { label: 'Save this list', primary: true, onClick: start },
      ],
    });
  }

  async function start() {
    if (run.active || !list) return;
    Object.assign(run, { active: true, saved: 0, seen: new Set(buffer.keys()), lastBatch: Date.now() });
    const pre = [...buffer.values()];
    buffer = new Map();
    log('saving list', list.owner, list.relation);
    progress('starting…');
    await save(pre);
    let result = await viaApi();
    if (!result && run.active) {
      progress('switching to scrolling…');
      result = await viaScrolling();
    }
    finish(result || 'Stopped');
  }

  function viaApi() {
    return new Promise((resolve) => {
      statusListener = (m) => {
        if (!run.active) return resolve('Stopped');
        if (m.state === 'page') progress(`page ${m.page}`);
        if (m.state === 'waiting') progress(`X is rate-limiting, waiting ${m.seconds}s…`);
        if (m.state === 'done') resolve('Complete');
        if (m.state === 'stopped') resolve('Stopped');
        if (m.state === 'error') {
          log('direct paging failed:', m.error);
          resolve(null);
        }
      };
      window.postMessage({ __stash: 'x-paginate', kind: 'people' }, location.origin);
    }).finally(() => (statusListener = null));
  }

  async function viaScrolling() {
    const path = location.pathname;
    let stalls = 0;
    let last = 0;
    while (run.active && location.pathname === path) {
      if (document.hidden) {
        progress('paused — switch to this tab to continue');
        await sleep(1000);
        run.lastBatch = Date.now();
        continue;
      }
      const cells = document.querySelectorAll('[data-testid="cellInnerDiv"], [data-testid="UserCell"]');
      cells[cells.length - 1]?.scrollIntoView({ block: 'end' });
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1600 + Math.random() * 600);
      const grew = run.seen.size !== last;
      last = run.seen.size;
      stalls = !grew && Date.now() - run.lastBatch > 3000 ? stalls + 1 : 0;
      if (stalls >= 3) progress(`waiting for X to load more (${stalls}/8)…`);
      if (stalls >= 8) return 'Complete';
    }
    return 'Stopped';
  }

  function stop() {
    window.postMessage({ __stash: 'x-paginate-stop', kind: 'people' }, location.origin);
    finish('Stopped');
  }

  async function finish(why) {
    if (!run.active) return;
    run.active = false;
    log('finished', why, run.seen.size);
    // A complete pass is a fresh snapshot: drop people no longer on the list.
    let removed = 0;
    if (why === 'Complete') {
      const res = await chrome.runtime.sendMessage({ type: 'peopleFinalize', owner: list.owner, relation: list.relation, keepIds: [...run.seen] });
      removed = res?.ok ? res.result.removed : 0;
    }
    const hash = `#p/${list.owner}/${list.relation}`;
    ui({
      title: why === 'Complete' ? `Saved ${title()}` : `${title()}: ${why.toLowerCase()}`,
      detail: `${run.seen.size} people saved${removed ? ` · ${removed} no longer on the list` : ''}`,
      value: 1,
      actions: [
        { label: 'Open in Stash', primary: true, onClick: () => chrome.runtime.sendMessage({ type: 'openLibrary', hash }) },
        { label: 'Close', onClick: () => P().hide() },
      ],
    });
  }

  // New page in X's single-page app: reset, and offer again if it's a list page.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (run.active) stop();
    buffer = new Map();
    offeredFor = null;
    if (listFromPath()) window.postMessage({ __stash: 'x-template-query', kind: 'people' }, location.origin);
  }, 1000);
})();
