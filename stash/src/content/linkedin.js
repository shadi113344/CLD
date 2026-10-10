// LinkedIn saved posts. LinkedIn has no usable API for this, so Stash reads
// the "Saved posts" page as you scroll it. Selectors are deliberately loose
// (anchored on post permalinks) so small layout changes don't break capture.
(() => {
  const seen = new Set();
  let total = 0;
  let timer;

  const onSavedPage = () => /\/my-items\/saved-posts/.test(location.pathname);

  function clean(s) {
    return (s || '').replace(/(…|\.\.\.)\s*(see more|more)\s*$/i, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function scan() {
    if (!onSavedPage()) return;
    const items = [];
    for (const a of document.querySelectorAll('a[href*="/feed/update/urn:li:"]')) {
      const urn = a.href.match(/urn:li:(?:activity|share|ugcPost):\d+/)?.[0];
      if (!urn || seen.has(urn)) continue;
      const card = a.closest('li') || a.closest('[data-chameleon-result-urn]') || a.closest('div');
      if (!card) continue;
      const authorEl = card.querySelector('a[href*="/in/"] span[aria-hidden="true"], a[href*="/company/"] span[aria-hidden="true"]') || card.querySelector('a[href*="/in/"], a[href*="/company/"]');
      const author = clean(authorEl?.textContent).split('\n')[0];
      const summary = card.querySelector('.entity-result__content-summary, [class*="summary"], p');
      const text = clean(summary?.innerText || card.innerText).slice(0, 5000);
      if (!text) continue;
      seen.add(urn);
      items.push({
        id: 'linkedin:' + urn,
        source: 'linkedin',
        url: `https://www.linkedin.com/feed/update/${urn}/`,
        title: author ? `${author} on LinkedIn` : 'LinkedIn post',
        text,
        author,
        image: card.querySelector('img[src*="media"]')?.src || '',
      });
    }
    if (!items.length) return;
    chrome.runtime.sendMessage({ type: 'ingest', items }).then((res) => {
      if (res?.ok && res.result.added) {
        total += res.result.added;
        window.__stashToast?.(`Stash: ${total} new LinkedIn post${total > 1 ? 's' : ''} saved`);
      }
    });
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 800);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(scan, 1500);
})();
