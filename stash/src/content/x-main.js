// Runs in the page's own JS world on x.com so it can see the responses X's
// web app already receives: the Bookmarks timeline, and Following/Followers
// lists. Parsed items are handed to x-bridge.js. When asked, it requests the
// following pages the same way X's app does when you scroll.
(() => {
  if (window.__stashXHooked) return;
  window.__stashXHooked = true;

  const BOOKMARK_OPS = /\/graphql\/[^/]+\/(Bookmarks|BookmarkSearchTimeline|BookmarkFolderTimeline)\b/;
  const PEOPLE_OPS = /\/graphql\/[^/]+\/(Following|Followers|BlueVerifiedFollowers)\b/;
  const kindOf = (url) => (BOOKMARK_OPS.test(url) ? 'bookmarks' : PEOPLE_OPS.test(url) ? 'people' : null);

  function userFrom(r) {
    if (r?.__typename === 'UserUnavailable' || !r?.rest_id) return null;
    const handle = r.core?.screen_name || r.legacy?.screen_name;
    if (!handle) return null;
    const leg = r.legacy || {};
    let site = leg.entities?.url?.urls?.[0]?.expanded_url || '';
    let bio = leg.description || r.profile_bio?.description || '';
    for (const u of leg.entities?.description?.urls || []) bio = bio.replace(u.url, u.expanded_url);
    return {
      id: 'x:' + r.rest_id,
      platform: 'x',
      handle,
      name: r.core?.name || leg.name || handle,
      bio,
      url: `https://x.com/${handle}`,
      website: site,
      location: r.location?.location || leg.location || '',
      avatar: r.avatar?.image_url || leg.profile_image_url_https || '',
      followers: leg.followers_count ?? null,
      following: leg.friends_count ?? null,
      verified: Boolean(r.is_blue_verified || leg.verified),
      joinedAt: Date.parse(r.core?.created_at || leg.created_at) || 0,
    };
  }

  function extractPeople(json) {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.entryId && /^user-/.test(node.entryId)) {
        const u = userFrom(node.content?.itemContent?.user_results?.result);
        if (u) out.push(u);
        return;
      }
      for (const k in node) walk(node[k]);
    };
    walk(json);
    return out;
  }

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

  function emit(json, kind = 'bookmarks') {
    if (kind === 'people') {
      const people = extractPeople(json);
      if (people.length) window.postMessage({ __stash: 'x-people', people }, location.origin);
      return people.length;
    }
    const tweets = extract(json);
    if (tweets.length) window.postMessage({ __stash: 'x-bookmarks', tweets }, location.origin);
    return tweets.length;
  }

  // ---- request template: the exact request X's own app made for page 1 ----
  // Remembered so Stash can ask for the following pages the same way X does
  // when you scroll, without depending on scrolling or the page layout.
  const templates = {}; // kind -> { url, headers }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
    else Object.assign(out, h);
    return out;
  }

  function remember(kind, url, headers) {
    if (kind === 'bookmarks' && !/\/Bookmarks\b/.test(url) && templates.bookmarks) return; // prefer the main timeline
    templates[kind] = { url: new URL(url, location.origin).toString(), headers };
    window.postMessage({ __stash: 'x-template', kind }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req?.url || String(req);
      const kind = url && kindOf(url);
      if (kind) {
        const headers = { ...headersToObject(req instanceof Request ? req.headers : null), ...headersToObject(args[1]?.headers) };
        if (res.ok) remember(kind, url, headers);
        res.clone().json().then((j) => emit(j, kind)).catch(() => {});
      }
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__stashHeaders) this.__stashHeaders[k] = v;
    return origSetHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const kind = typeof url === 'string' && kindOf(url);
    if (kind) {
      this.__stashHeaders = {};
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) remember(kind, url, this.__stashHeaders);
          emit(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), kind);
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // ---- pagination driven by the extension ----

  function bottomCursor(json) {
    let cursor = null;
    const walk = (n) => {
      if (!n || typeof n !== 'object' || cursor) return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n.entryId === 'string' && /^cursor-bottom/.test(n.entryId)) {
        cursor = n.content?.value ?? n.content?.itemContent?.value ?? null;
        return;
      }
      for (const k in n) walk(n[k]);
    };
    walk(json);
    return cursor;
  }

  function pageUrl(template, cursor, count) {
    const u = new URL(template.url);
    const vars = JSON.parse(u.searchParams.get('variables') || '{}');
    if (cursor) vars.cursor = cursor;
    else delete vars.cursor;
    if (count) vars.count = count;
    u.searchParams.set('variables', JSON.stringify(vars));
    return u.toString();
  }

  let post = () => {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopRequested = false;

  async function paginate(kind) {
    stopRequested = false;
    post = (m) => window.postMessage({ __stash: 'x-paginate-status', kind, ...m }, location.origin);
    const template = templates[kind];
    if (!template) return post({ state: 'error', error: 'no-template' });
    let cursor = null;
    let count = 100; // fewer, larger pages; falls back to X's own size if refused
    let page = 0;
    let failures = 0;
    const seenCursors = new Set();
    while (!stopRequested) {
      let res;
      try {
        res = await origFetch(pageUrl(template, cursor, count), { headers: template.headers, credentials: 'include' });
      } catch (e) {
        res = { ok: false, status: 0 };
      }
      if (res.status === 429) {
        post({ state: 'waiting', page, seconds: 60 });
        await sleep(60000);
        continue;
      }
      if (!res.ok) {
        if (count && failures === 0) {
          count = null; // retry with X's original page size
          failures++;
          continue;
        }
        return post({ state: 'error', error: `X returned ${res.status}`, page });
      }
      let json;
      try {
        json = await res.json();
      } catch {
        return post({ state: 'error', error: 'bad response', page });
      }
      if (json?.errors && !json?.data) return post({ state: 'error', error: json.errors[0]?.message || 'X error', page });
      const got = emit(json, kind);
      page++;
      const next = bottomCursor(json);
      post({ state: 'page', page, got });
      // X always sends a bottom cursor; items without one means we misread the response.
      if (got && !next) return post({ state: 'error', error: 'no next-page cursor', page });
      if (!got || seenCursors.has(next)) return post({ state: 'done', page });
      seenCursors.add(next);
      cursor = next;
      await sleep(900 + Math.random() * 900);
    }
    post({ state: 'stopped', page });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const kind = e.data?.kind || 'bookmarks';
    if (e.data?.__stash === 'x-paginate') paginate(kind);
    if (e.data?.__stash === 'x-paginate-stop') stopRequested = true;
    if (e.data?.__stash === 'x-template-query') templates[kind] && window.postMessage({ __stash: 'x-template', kind }, location.origin);
  });
})();
