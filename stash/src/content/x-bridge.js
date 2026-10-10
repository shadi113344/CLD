// Isolated-world relay: receives parsed bookmarks from x-main.js and passes
// them to the extension. Shows a small toast so you know the sync happened.
(() => {
  let total = 0;
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__stash !== 'x-bookmarks') return;
    const items = (e.data.tweets || []).filter((t) => typeof t?.id === 'string' && t.id.startsWith('x:'));
    if (!items.length) return;
    const res = await chrome.runtime.sendMessage({ type: 'ingest', items });
    if (res?.ok && res.result.added) {
      total += res.result.added;
      window.__stashToast?.(`Stash: ${total} new X bookmark${total > 1 ? 's' : ''} saved`);
    }
  });
})();
