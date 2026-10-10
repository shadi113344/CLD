// Runs in the page's own JS world on x.com so it can see the responses X's
// web app already receives. It only reads the Bookmarks timeline; nothing
// is modified or re-requested. Parsed tweets are handed to x-bridge.js.
(() => {
  if (window.__stashXHooked) return;
  window.__stashXHooked = true;

  const BOOKMARK_OPS = /\/graphql\/[^/]+\/(Bookmarks|BookmarkSearchTimeline|BookmarkFolderTimeline)\b/;

  function tweetFrom(result) {
    let r = result;
    if (r?.__typename === 'TweetWithVisibilityResults') r = r.tweet;
    if (!r?.legacy || !r.rest_id) return null;
    const user = r.core?.user_results?.result;
    const handle = user?.core?.screen_name || user?.legacy?.screen_name || '';
    const name = user?.core?.name || user?.legacy?.name || '';
    const text = r.note_tweet?.note_tweet_results?.result?.text || r.legacy.full_text || '';
    const media = r.legacy.extended_entities?.media?.[0] || r.legacy.entities?.media?.[0];
    const quoted = r.quoted_status_result?.result;
    const q = quoted ? tweetFrom(quoted) : null;
    // Expand t.co links back to their real URLs.
    let full = text;
    for (const u of r.legacy.entities?.urls || []) full = full.replace(u.url, u.expanded_url);
    if (media?.url) full = full.replace(media.url, '').trim();
    return {
      id: 'x:' + r.rest_id,
      source: 'x',
      url: `https://x.com/${handle || 'i'}/status/${r.rest_id}`,
      title: `${name || handle} on X`,
      text: q ? `${full}\n\n> Quoting @${q.authorHandle}: ${q.text}` : full,
      author: name,
      authorHandle: handle,
      image: media?.media_url_https || '',
      postedAt: Date.parse(r.legacy.created_at) || 0,
    };
  }

  function extract(json) {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.entryId && /^tweet-/.test(node.entryId)) {
        const t = tweetFrom(node.content?.itemContent?.tweet_results?.result);
        if (t) out.push(t);
        return;
      }
      for (const k in node) walk(node[k]);
    };
    walk(json);
    return out;
  }

  function emit(json) {
    const tweets = extract(json);
    if (tweets.length) window.postMessage({ __stash: 'x-bookmarks', tweets }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && BOOKMARK_OPS.test(url)) res.clone().json().then(emit).catch(() => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && BOOKMARK_OPS.test(url)) {
      this.addEventListener('load', () => {
        try {
          emit(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
