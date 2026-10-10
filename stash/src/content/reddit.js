// Reddit "saved" sync. Uses Reddit's own JSON endpoints from the reddit.com
// page, so your logged-in session is used and no credentials touch Stash.
(() => {
  const ORIGIN = location.origin;

  function toItem(child) {
    const d = child.data;
    const isComment = child.kind === 't1';
    const permalink = 'https://www.reddit.com' + d.permalink;
    const image = d.preview?.images?.[0]?.source?.url || (/^https?:/.test(d.thumbnail || '') ? d.thumbnail : '');
    return {
      id: 'reddit:' + d.name,
      source: 'reddit',
      url: permalink,
      title: isComment ? `Comment on: ${d.link_title}` : d.title,
      text: [isComment ? d.body : d.selftext, !isComment && d.url && !d.is_self ? `Link: ${d.url}` : '', `r/${d.subreddit}`]
        .filter(Boolean)
        .join('\n\n'),
      author: d.author ? `u/${d.author}` : '',
      authorHandle: d.author || '',
      image,
      postedAt: (d.created_utc || 0) * 1000,
    };
  }

  async function getJson(path) {
    const res = await fetch(ORIGIN + path, { credentials: 'include' });
    if (!res.ok) throw new Error(`Reddit returned ${res.status}`);
    return res.json();
  }

  async function sync(full) {
    const me = await getJson('/api/me.json');
    const name = me?.data?.name;
    if (!name) throw new Error('Log in to Reddit first.');
    let after = '';
    let added = 0;
    let total = 0;
    for (let page = 0; page < 50; page++) {
      const j = await getJson(`/user/${encodeURIComponent(name)}/saved.json?limit=100&raw_json=1${after ? `&after=${after}` : ''}`);
      const items = (j?.data?.children || []).map(toItem);
      if (!items.length) break;
      const res = await chrome.runtime.sendMessage({ type: 'ingest', items });
      const n = res?.ok ? res.result.added : 0;
      added += n;
      total += items.length;
      after = j.data.after;
      // Incremental: once a whole page is already known, older pages are too.
      if (!after || (!full && n === 0)) break;
    }
    return { added, total };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== 'reddit-sync') return;
    sync(msg.full).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
    return true;
  });

  // Quiet background sync at most every 6 hours while you browse Reddit.
  (async () => {
    const { settings } = await chrome.storage.local.get('settings');
    if (settings && (settings.captureReddit === false || settings.redditAutoSync === false)) return;
    const { redditLastSync = 0 } = await chrome.storage.local.get('redditLastSync');
    if (Date.now() - redditLastSync < 6 * 3600 * 1000) return;
    await chrome.storage.local.set({ redditLastSync: Date.now() });
    try {
      const r = await sync(false);
      if (r.added) window.__stashToast?.(`Stash: ${r.added} new Reddit save${r.added > 1 ? 's' : ''}`);
    } catch {}
  })();
})();
