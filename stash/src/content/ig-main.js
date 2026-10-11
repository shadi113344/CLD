// Runs in the page's own JS world on instagram.com so it can see the responses
// Instagram's web app already receives: your Saved posts, your collections
// list, and each collection's posts. Parsed posts go to ig-bridge.js. When
// asked, it requests a page the same way Instagram's app does, with the same
// headers, and says whether Instagram pushed back.
(() => {
  if (window.__stashIgHooked) return;
  window.__stashIgHooked = true;

  const WEB_APP_ID = '936619743392459'; // Instagram's web app id; only used before the app has made a request
  const BASE = Date.now(); // a post at position p in Saved gets savedAt BASE - p, so Stash keeps Instagram's order
  const log = (...a) => console.info('[Stash ig]', ...a);
  const post = (type, data) => window.postMessage({ __stash: type, ...data }, location.origin);

  // ---- what a request is ----

  function classifyUrl(url) {
    let u;
    try {
      u = new URL(url, location.origin);
    } catch {
      return null;
    }
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    const p = u.pathname;
    const cursor = u.searchParams.get('max_id') || null;
    if (/^\/api\/v1\/feed\/saved\//.test(p)) return { kind: 'saved', feed: p, cursor };
    const m = p.match(/^\/api\/v1\/feed\/collection\/(\d+)\//);
    if (m) return { kind: 'collection', igId: m[1], feed: p, cursor };
    if (/^\/api\/v1\/collections\/list\//.test(p)) return { kind: 'collections', cursor };
    if (/^\/(api\/)?graphql/.test(p)) return { kind: 'graphql' };
    if (/^\/api\/v1\//.test(p)) return { kind: 'api' };
    return null;
  }

  // ---- parsing ----

  const CODE = /^[A-Za-z0-9_-]{5,64}$/;

  function pickImage(m) {
    const cands = (m.image_versions2?.candidates || m.carousel_media?.[0]?.image_versions2?.candidates || []).filter((c) => c?.url);
    if (cands.length) {
      // The smallest copy that's still at least 320px wide: enough for a thumbnail, light to download.
      const big = cands.filter((c) => (c.width || 0) >= 320).sort((a, b) => a.width - b.width);
      return (big[0] || [...cands].sort((a, b) => (b.width || 0) - (a.width || 0))[0]).url;
    }
    return m.display_url || m.thumbnail_src || m.carousel_media?.[0]?.display_url || '';
  }

  function typeOf(m) {
    if (m.product_type === 'clips') return 'reel';
    if (m.media_type === 8 || m.carousel_media_count || m.__typename === 'GraphSidecar') return 'carousel';
    if (m.media_type === 2 || m.is_video || m.__typename === 'GraphVideo') return 'video';
    return 'photo';
  }

  function mediaToItem(m) {
    const code = m.code || m.shortcode;
    if (typeof code !== 'string' || !CODE.test(code)) return null;
    const user = m.user || m.owner || {};
    const handle = user.username || '';
    const name = user.full_name || handle;
    const type = typeOf(m);
    const caption = (typeof m.caption === 'string' ? m.caption : m.caption?.text) || m.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const place = m.location?.name;
    const item = {
      id: 'instagram:' + code,
      source: 'instagram',
      url: `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${code}/`,
      title: name ? `${name} on Instagram` : 'Instagram post',
      text: [caption, place && `📍 ${place}`].filter(Boolean).join('\n\n'),
      author: name,
      authorHandle: handle,
      image: pickImage(m),
      postedAt: (m.taken_at || m.taken_at_timestamp || 0) * 1000,
      mediaType: type,
    };
    // The full list of your collections this post is in, when Instagram includes it.
    if (Array.isArray(m.saved_collection_ids)) item.igCollections = m.saved_collection_ids.map(String);
    return item;
  }

  // Every post object in a response, in order, without descending into one once found.
  function findMedia(json) {
    const out = [];
    const ids = new Set();
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 14) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
      const code = n.code || n.shortcode;
      if (typeof code === 'string' && (n.image_versions2 || n.display_url || n.media_type != null || n.taken_at || n.taken_at_timestamp)) {
        const it = mediaToItem(n);
        if (it && !ids.has(it.id)) {
          ids.add(it.id);
          out.push(it);
        }
        return;
      }
      for (const k in n) walk(n[k], depth + 1);
    };
    walk(json, 0);
    return out;
  }

  function nextPage(json) {
    if (json && 'more_available' in json) return { more: Boolean(json.more_available), next: json.next_max_id ? String(json.next_max_id) : null };
    let info = null;
    const walk = (n, depth) => {
      if (info || !n || typeof n !== 'object' || depth > 10) return;
      if (n.page_info && typeof n.page_info === 'object') return void (info = n.page_info);
      for (const k in n) walk(n[k], depth + 1);
    };
    walk(json, 0);
    return info ? { more: Boolean(info.has_next_page), next: info.end_cursor || null } : { more: false, next: null };
  }

  function collectionsFrom(json) {
    return (json?.items || [])
      .filter((c) => c?.collection_id && (c.collection_type || 'MEDIA') === 'MEDIA')
      .map((c) => ({ igId: String(c.collection_id), name: String(c.collection_name || 'Untitled'), count: c.collection_media_count ?? null }));
  }

  // A GraphQL response is about Saved if one of its top-level fields says so.
  function savedPart(json) {
    const d = json?.data;
    if (!d || typeof d !== 'object') return null;
    for (const k of Object.keys(d)) if (/saved/i.test(k)) return d[k];
    if (d.user && typeof d.user === 'object') for (const k of Object.keys(d.user)) if (/saved/i.test(k)) return d.user[k];
    return null;
  }

  // Position of each page in a feed, so items keep Instagram's order: feed|cursor -> first position.
  const offsets = new Map();
  function place(info, items, next) {
    let start = offsets.get(`${info.feed}|${info.cursor || ''}`);
    if (start == null && !info.cursor) start = 0;
    if (start != null && next) offsets.set(`${info.feed}|${next}`, start + items.length);
    if (start == null) return items;
    // Posts found only through a collection are older saves; keep them below this visit's Saved posts.
    const shift = info.kind === 'saved' ? 0 : 10_000_000;
    return items.map((it, i) => ({ ...it, savedAt: BASE - shift - start - i }));
  }

  function parse(info, json) {
    if (info.kind === 'collections') {
      const { more, next } = nextPage(json);
      return { collections: collectionsFrom(json), more, next };
    }
    if (info.kind === 'graphql') {
      const part = savedPart(json);
      return part ? { items: findMedia(part), ...nextPage(part) } : null;
    }
    const { more, next } = nextPage(json);
    let items = place(info, findMedia(json), next);
    if (info.kind === 'collection') items = items.map((it) => ({ ...it, igCollectionsAdd: [info.igId] }));
    const sawCollectionIds = (json?.items || []).some((x) => Array.isArray((x?.media || x)?.saved_collection_ids));
    return { items, more, next, sawCollectionIds };
  }

  // ---- headers: the ones Instagram's own app sends ----

  let template = null; // headers from the app's latest successful /api/v1/ GET
  const hints = {}; // app id etc. seen on any request, for when no /api/v1/ request was seen yet

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
    else Object.assign(out, h);
    return out;
  }

  function remember(info, method, headers) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (lower['x-ig-app-id']) hints.appId = lower['x-ig-app-id'];
    if (lower['x-asbd-id']) hints.asbd = lower['x-asbd-id'];
    if (info.kind !== 'graphql' && String(method || 'GET').toUpperCase() === 'GET' && lower['x-ig-app-id']) {
      if (!template) log('saw Instagram’s request headers');
      template = headers;
    }
  }

  function cookie(name) {
    return document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.slice(name.length + 1) || '';
  }

  function requestHeaders() {
    const h = {};
    for (const [k, v] of Object.entries(template || {})) {
      if (!/^(content-length|content-type|cookie|host|origin|referer|user-agent|accept-encoding|connection|x-csrftoken)$/i.test(k)) h[k] = v;
    }
    const has = (k) => Object.keys(h).some((x) => x.toLowerCase() === k.toLowerCase());
    let claim = '0';
    try {
      claim = sessionStorage.getItem('www-claim-v2') || '0';
    } catch {}
    if (!has('X-IG-App-ID')) h['X-IG-App-ID'] = hints.appId || WEB_APP_ID;
    if (!has('X-Requested-With')) h['X-Requested-With'] = 'XMLHttpRequest';
    if (!has('X-IG-WWW-Claim')) h['X-IG-WWW-Claim'] = claim;
    if (!has('X-ASBD-ID') && hints.asbd) h['X-ASBD-ID'] = hints.asbd;
    const csrf = cookie('csrftoken'); // read fresh every time; Instagram rotates it
    if (csrf) h['X-CSRFToken'] = csrf;
    return h;
  }

  // ---- watching the app's own requests ----

  function onResponse(info, url, json) {
    if (!info || info.kind === 'api' || !json) return;
    const r = parse(info, json);
    if (!r) return;
    const where = info.kind === 'collection' ? `collection ${info.igId}` : info.kind;
    if (r.collections) {
      log(`Instagram loaded your collections list (${r.collections.length})`);
      post('ig-collections', { list: r.collections, passive: true });
    } else {
      log(`Instagram loaded ${r.items.length} saved posts (${where})`);
      if (r.items.length) post('ig-items', { items: r.items, kind: info.kind, igId: info.igId || null, passive: true });
    }
    post('ig-seen', { kind: info.kind, path: location.pathname });
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req?.url || String(req);
      const info = classifyUrl(url);
      if (info) {
        const headers = { ...headersToObject(req instanceof Request ? req.headers : null), ...headersToObject(args[1]?.headers) };
        const method = args[1]?.method || (req instanceof Request ? req.method : 'GET');
        if (res.ok) remember(info, method, headers);
        if (res.ok && info.kind !== 'api') res.clone().json().then((j) => onResponse(info, url, j)).catch(() => {});
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
    const info = typeof url === 'string' || url instanceof URL ? classifyUrl(String(url)) : null;
    if (info) {
      this.__stashHeaders = {};
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          remember(info, method, this.__stashHeaders);
          if (info.kind === 'api') return;
          const json = this.responseType === 'json' ? this.response : this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : null;
          onResponse(info, String(url), json);
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // ---- one request on behalf of the extension ----

  // Anything that means "Instagram doesn't want this right now". The bridge stops on these.
  function verdict(status, json, text) {
    const msg = String(json?.message || '').toLowerCase();
    if (status === 429 || /wait a few minutes|too many requests|rate.?limit|try again later/.test(msg)) return { pushback: 'rate', message: 'Instagram asked Stash to slow down.' };
    if (/checkpoint|challenge/.test(msg) || json?.checkpoint_url || json?.challenge) return { pushback: 'checkpoint', message: 'Instagram wants to confirm it’s you.' };
    if (json?.spam || /feedback_required|action.?block/.test(msg) || json?.feedback_title) return { pushback: 'blocked', message: 'Instagram limited activity on your account.' };
    if (status === 401 || json?.require_login || /login_required|not.?logged/.test(msg)) return { pushback: 'login', message: 'You’re not logged in to Instagram in this tab.' };
    if (status === 403) return { pushback: 'blocked', message: 'Instagram refused the request (403).' };
    if (status === 0 || status >= 500) return { error: status ? `Instagram returned ${status}` : 'network error', retry: true };
    if (!json) {
      if (/<html|<!doctype/i.test(text || '')) return { pushback: 'login', message: 'Instagram sent a web page instead of data. You may be logged out.' };
      return { error: 'unreadable response' };
    }
    if (status >= 400 || json.status === 'fail') return { error: json.message || `Instagram returned ${status}` };
    return null;
  }

  async function request(path) {
    if (typeof path !== 'string' || !path.startsWith('/api/v1/')) return { error: 'bad path' };
    let res;
    let text = '';
    let json = null;
    try {
      res = await origFetch(path, { headers: requestHeaders(), credentials: 'include' });
      text = await res.text();
      json = JSON.parse(text);
    } catch {}
    const status = res?.status ?? 0;
    const bad = verdict(status, json, text);
    if (bad) return { status, ...bad };
    const info = classifyUrl(path);
    const r = info && parse(info, json);
    if (!r) return { status, error: 'unexpected response' };
    return { ok: true, status, ...r };
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__stash !== 'ig-fetch') return;
    const { id, path } = e.data;
    const r = await request(path);
    log(`GET ${path.split('?')[0]} → ${r.status}${r.items ? `, ${r.items.length} posts` : ''}${r.pushback ? ` (${r.pushback})` : ''}${r.error ? ` (${r.error})` : ''}`);
    post('ig-fetch-result', { id, result: r });
  });
})();
