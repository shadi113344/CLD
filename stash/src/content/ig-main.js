// Runs in the page's own JS world on instagram.com so it can see the responses
// Instagram's web app already receives: your Saved posts, your collections
// list, and each collection's posts. Parsed posts go to ig-bridge.js. When
// asked, it requests a page the same way Instagram's app does, with the same
// headers, and says whether Instagram pushed back.
//
// Collections: since September 2026 a collection page loads over GraphQL
// (PolarisSavedCollectionPageWWWQuery, answer under data.fetch__MediaCollection)
// instead of /api/v1/feed/collection/<id>/posts/. That request can't be written
// by hand (its doc_id changes), so it's learnt from the page's own request the
// first time you open a collection, and replayed with the page's current tokens.
//
// Unsaving: on request, it unsaves one post the way Instagram's web app does
// (POST /api/v1/web/save/<id>/unsave/). If Instagram has moved that, the
// request is learnt the same way, from the first post you unsave by hand.
(() => {
  if (window.__stashIgHooked) return;
  window.__stashIgHooked = true;

  const WEB_APP_ID = '936619743392459'; // Instagram's web app id; only used before the app has made a request
  const ASBD_ID = '359341'; // likewise, for X-ASBD-ID
  const BASE = Date.now(); // a post at position p in Saved gets savedAt BASE - p, so Stash keeps Instagram's order
  const ID_EPOCH = 1314220021721n; // Instagram media ids start with ms since this moment
  const COLLECTION_ROOT = 'fetch__MediaCollection';
  const GQL_PATHS = ['/api/graphql', '/graphql/query'];
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
    if (/\/\d{5,25}(_\d+)?\/unsave\/?$/.test(p)) return { kind: 'unsave' };
    if (/^\/api\/v1\//.test(p)) return { kind: 'api' };
    return null;
  }

  // Some GraphQL answers start with "for (;;);", and a streamed one is several JSON lines.
  function parseText(text) {
    if (typeof text !== 'string') return null;
    const t = text.replace(/^\s*for\s*\(;;\);/, '');
    try {
      return JSON.parse(t);
    } catch {}
    try {
      return JSON.parse(t.split(/\r?\n/)[0]);
    } catch {}
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

  // When the post was published. Reels in GraphQL answers can come without
  // taken_at; the media id itself starts with the time, exact to the second.
  function postedAtOf(m) {
    const sec = m.taken_at || m.taken_at_timestamp;
    if (sec > 0) return sec * 1000;
    try {
      const pk = String(m.pk ?? m.id ?? '').split('_')[0];
      if (/^\d{15,}$/.test(pk)) {
        const ms = Number((BigInt(pk) >> 23n) + ID_EPOCH);
        if (ms > 1.3e12 && ms < Date.now() + 86400000) return ms;
      }
    } catch {}
    return 0;
  }

  // Likes, comments and views as Instagram reports them today. When a creator
  // hides like counts Instagram still sends a small placeholder, so that's no count.
  function metricsOf(m) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const hidden = m.like_and_view_counts_disabled === true;
    const likes = hidden ? null : num(m.like_count ?? m.edge_liked_by?.count ?? m.edge_media_preview_like?.count);
    const comments = num(m.comment_count ?? m.edge_media_to_comment?.count);
    const views = num(m.play_count ?? m.view_count ?? m.ig_play_count ?? m.video_view_count);
    if (likes == null && comments == null && views == null && !hidden) return null;
    return { likes, comments, views, ...(hidden ? { likesHidden: true } : {}), at: Date.now() };
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
      postedAt: postedAtOf(m),
      mediaType: type,
    };
    const metrics = metricsOf(m);
    if (metrics) item.metrics = metrics;
    // Instagram's ids for the post and its author, for unsaving it later.
    const pk = [m.pk, String(m.id ?? '').split('_')[0]].map((x) => String(x ?? '')).find((x) => /^\d{5,25}$/.test(x));
    if (pk) item.igPk = pk;
    const owner = String(user.pk ?? user.id ?? '');
    if (/^\d{1,25}$/.test(owner)) item.igOwner = owner;
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

  // {collection_id, collection_name} pairs anywhere in a response. Instagram
  // names your collections in more places than the list endpoint, so Stash's
  // list still fills if that endpoint moves.
  function collectionsIn(json) {
    const out = new Map();
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 12) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
      const id = n.collection_id != null ? String(n.collection_id) : '';
      if (/^\d{5,}$/.test(id) && typeof n.collection_name === 'string' && (n.collection_type || 'MEDIA') === 'MEDIA') {
        out.set(id, { igId: id, name: n.collection_name || 'Untitled', count: n.collection_media_count ?? null });
      }
      for (const k in n) walk(n[k], depth + 1);
    };
    walk(json, 0);
    return [...out.values()];
  }

  // A GraphQL response is about Saved if one of its top-level fields says so.
  function savedPart(json) {
    const d = json?.data;
    if (!d || typeof d !== 'object') return null;
    for (const k of Object.keys(d)) if (/saved/i.test(k)) return d[k];
    if (d.user && typeof d.user === 'object') for (const k of Object.keys(d.user)) if (/saved/i.test(k)) return d.user[k];
    return null;
  }

  // A page of one collection, the way Instagram now loads it.
  function collectionPart(json) {
    const media = json?.data?.[COLLECTION_ROOT]?.media;
    return media && Array.isArray(media.edges) ? media : null;
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

  // info.igId and info.cursor of a GraphQL collection page come from its request.
  function parse(info, json) {
    if (info.kind === 'collections') {
      const { more, next } = nextPage(json);
      return { collections: collectionsFrom(json), more, next };
    }
    if (info.kind === 'graphql') {
      const media = collectionPart(json);
      if (media) {
        if (!info.igId) return null;
        const { more, next } = nextPage(media);
        const feed = { kind: 'collection', feed: 'gql:' + info.igId, cursor: info.cursor || null };
        const items = place(feed, findMedia(media.edges), next).map((it) => ({ ...it, igCollectionsAdd: [info.igId] }));
        return { items, more, next, collection: info.igId };
      }
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
  const lowerKeys = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

  function remember(info, method, headers) {
    const lower = lowerKeys(headers);
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

  // ---- learning the collection request ----

  // The app's latest GraphQL POST on this page load: replaying its form fields
  // and headers makes Stash's request look like the app's own. Memory only.
  let lastGql = null; // { params: URLSearchParams, headers }
  const learntSent = new Set(); // template signatures already handed to the bridge this page load
  const CURSOR_KEYS = ['after', 'cursor', 'end_cursor', 'max_id', 'next_max_id'];

  // The first path [key, …] in obj whose (key, value) passes test, depth first.
  function findPath(obj, test, path = []) {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (test(k, v)) return [...path, k];
      if (v && typeof v === 'object') {
        const p = findPath(v, test, [...path, k]);
        if (p) return p;
      }
    }
    return null;
  }
  const getAt = (o, p) => (p || []).reduce((a, k) => (a == null ? undefined : a[k]), o);
  function setAt(o, p, v) {
    let a = o;
    for (let i = 0; i < p.length - 1; i++) {
      if (a[p[i]] == null || typeof a[p[i]] !== 'object') a[p[i]] = {};
      a = a[p[i]];
    }
    a[p[p.length - 1]] = v;
  }

  function formParams(body) {
    try {
      if (typeof body === 'string') return new URLSearchParams(body);
      if (body instanceof URLSearchParams) return new URLSearchParams(body);
      if (body instanceof FormData) {
        const p = new URLSearchParams();
        body.forEach((v, k) => typeof v === 'string' && p.set(k, v));
        return p;
      }
    } catch {}
    return null;
  }

  // A request body as text, without consuming it.
  async function bodyText(req, init) {
    const b = init?.body;
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof FormData) return formParams(b).toString();
    if (b == null && req instanceof Request && req.method === 'POST') return req.clone().text();
    return null;
  }

  const pageCollectionId = () => location.pathname.match(/^\/[^/]+\/saved\/[^/]+\/(\d+)\/?/)?.[1] || '';

  // What a GraphQL collection request says: which collection and page, and
  // (when it can be reused) the request itself, minus anything secret.
  function readCollectionRequest(url, headers, params) {
    const vars = (() => {
      try {
        return JSON.parse(params?.get('variables') || 'null');
      } catch {
        return null;
      }
    })();
    const urlId = pageCollectionId();
    if (!vars || typeof vars !== 'object') return { igId: urlId, cursor: null, tpl: null };
    const scalar = (v) => typeof v === 'string' || typeof v === 'number';
    const idPath = findPath(vars, (k, v) => /^collection_?id$/i.test(k) && scalar(v)) || (urlId ? findPath(vars, (k, v) => scalar(v) && String(v) === urlId) : null);
    const cursorPath = findPath(vars, (k, v) => CURSOR_KEYS.includes(k) && (v === null || typeof v === 'string')) || ['after'];
    const igId = idPath ? String(getAt(vars, idPath)) : urlId;
    const cursor = getAt(vars, cursorPath) || null;
    const docId = params.get('doc_id') || '';
    const lower = lowerKeys(headers);
    const friendly = params.get('fb_api_req_friendly_name') || lower['x-fb-friendly-name'] || '';
    let path = '';
    try {
      path = new URL(url, location.origin).pathname.replace(/\/$/, '');
    } catch {}
    if (!/^\d{5,30}$/.test(docId) || !idPath || !GQL_PATHS.includes(path)) return { igId, cursor, tpl: null };
    const variables = JSON.parse(JSON.stringify(vars));
    setAt(variables, cursorPath, null);
    for (const k of ['fb_dtsg', 'lsd', 'jazoest']) delete variables[k];
    const tpl = { path, docId, friendly, rootField: lower['x-root-field-name'] || COLLECTION_ROOT, variables, idPath, cursorPath, at: Date.now() };
    return { igId, cursor, tpl };
  }

  function rememberGql(params, headers) {
    if (params?.get('doc_id')) lastGql = { params: new URLSearchParams(params), headers: lowerKeys(headers) };
  }

  // ---- watching the app's own requests ----

  const namedSeen = new Set(); // collections named in this page load's responses
  function gatherCollections(json) {
    const fresh = collectionsIn(json).filter((c) => !namedSeen.has(c.igId));
    if (!fresh.length) return;
    fresh.forEach((c) => namedSeen.add(c.igId));
    log(`saw ${fresh.length} of your collections named in Instagram’s data`);
    post('ig-collections', { list: fresh, passive: true, partial: true });
  }

  // ---- learning the unsave request, from a post you unsave by hand ----

  const unsaveSent = new Set();
  function offerUnsaveTemplate(tpl) {
    const sig = JSON.stringify(tpl, (k, v) => (k === 'at' ? undefined : v));
    if (unsaveSent.has(sig)) return;
    unsaveSent.add(sig);
    log(`learnt how Instagram unsaves a post (${tpl.kind === 'graphql' ? tpl.friendly || 'doc ' + tpl.docId : tpl.path})`);
    post('ig-unsave-template', { template: tpl });
  }

  function learnUnsaveRest(url, json) {
    if (json?.status !== 'ok') return;
    let p = '';
    try {
      p = new URL(url, location.origin).pathname;
    } catch {}
    const m = p.match(/^(\/[\w./-]*?\/)\d{5,25}(?:_\d+)?(\/[\w./-]*)$/);
    if (m) offerUnsaveTemplate({ kind: 'rest', path: m[1] + '{pk}' + m[2], at: Date.now() });
  }

  function learnUnsaveGql(url, headers, params, json) {
    if (!json || json.errors || json.status === 'fail') return;
    let vars = null;
    try {
      vars = JSON.parse(params.get('variables') || 'null');
    } catch {}
    if (!vars || typeof vars !== 'object') return;
    const idPath = findPath(vars, (k, v) => (typeof v === 'string' || typeof v === 'number') && /^\d{10,25}(_\d{1,25})?$/.test(String(v)));
    let path = '';
    try {
      path = new URL(url, location.origin).pathname.replace(/\/$/, '');
    } catch {}
    const docId = params.get('doc_id') || '';
    if (!idPath || !GQL_PATHS.includes(path) || !/^\d{5,30}$/.test(docId)) return log('saw Instagram unsave a post but couldn’t learn the request');
    const lower = lowerKeys(headers);
    offerUnsaveTemplate({
      kind: 'graphql',
      path,
      docId,
      friendly: params.get('fb_api_req_friendly_name') || lower['x-fb-friendly-name'] || '',
      rootField: lower['x-root-field-name'] || '',
      variables: vars,
      idPath,
      idFormat: String(getAt(vars, idPath)).includes('_') ? 'pk_owner' : 'pk',
      at: Date.now(),
    });
  }

  // req: { headers, body } of the request, for GraphQL.
  function onResponse(info, url, json, req) {
    if (!info || info.kind === 'api' || !json) return;
    if (info.kind === 'unsave') return learnUnsaveRest(url, json);
    if (info.kind !== 'collections') gatherCollections(json);
    let via = '';
    if (info.kind === 'graphql') {
      const params = formParams(req?.body);
      rememberGql(params, req?.headers);
      if (params && /unsave/i.test(params.get('fb_api_req_friendly_name') || lowerKeys(req?.headers)['x-fb-friendly-name'] || '')) return learnUnsaveGql(url, req?.headers, params, json);
      if (collectionPart(json)) {
        const { igId, cursor, tpl } = readCollectionRequest(url, req?.headers, params);
        info = { ...info, igId, cursor };
        via = ' via GraphQL';
        if (tpl) {
          const sig = JSON.stringify([tpl.path, tpl.docId, tpl.friendly, tpl.idPath, tpl.cursorPath, Object.keys(tpl.variables).sort()]);
          if (!learntSent.has(sig)) {
            learntSent.add(sig);
            log(`learnt Instagram’s collection request (${tpl.friendly || 'doc ' + tpl.docId}, id at ${tpl.idPath.join('.')}, cursor at ${tpl.cursorPath.join('.')})`);
            post('ig-template', { template: tpl });
          }
        } else log('saw a collection page but couldn’t learn its request', params ? '' : '(no form body)');
      }
    }
    const r = parse(info, json);
    if (!r) return;
    const igId = info.igId || null;
    const kind = info.kind === 'graphql' && r.collection ? 'collection' : info.kind;
    const where = kind === 'collection' ? `collection ${igId}${via}` : info.kind;
    if (r.collections) {
      log(`Instagram loaded your collections list (${r.collections.length})`);
      post('ig-collections', { list: r.collections, passive: true });
    } else {
      log(`Instagram loaded ${r.items.length} saved posts (${where})`);
      if (r.items.length) post('ig-items', { items: r.items, kind, igId, passive: true });
    }
    post('ig-seen', { kind, path: location.pathname });
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    let info = null;
    let body = null;
    try {
      info = classifyUrl(typeof req === 'string' ? req : req?.url || String(req));
      if (info?.kind === 'graphql') body = bodyText(req, args[1]).catch(() => null);
    } catch {}
    const res = await origFetch.apply(this, args);
    try {
      if (info) {
        const url = typeof req === 'string' ? req : req?.url || String(req);
        const headers = { ...headersToObject(req instanceof Request ? req.headers : null), ...headersToObject(args[1]?.headers) };
        const method = args[1]?.method || (req instanceof Request ? req.method : 'GET');
        if (res.ok) remember(info, method, headers);
        if (res.ok && info.kind !== 'api') {
          res
            .clone()
            .text()
            .then(async (t) => onResponse(info, url, parseText(t), { headers, body: await body }))
            .catch(() => {});
        }
      }
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__stashHeaders) this.__stashHeaders[k] = v;
    return origSetHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__stashInfo?.kind === 'graphql') this.__stashBody = typeof body === 'string' ? body : formParams(body)?.toString() || null;
    } catch {}
    return origSend.call(this, body);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const info = typeof url === 'string' || url instanceof URL ? classifyUrl(String(url)) : null;
    this.__stashInfo = info;
    if (info) {
      this.__stashHeaders = {};
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          remember(info, method, this.__stashHeaders);
          if (info.kind === 'api') return;
          const json = this.responseType === 'json' ? this.response : this.responseType === '' || this.responseType === 'text' ? parseText(this.responseText) : null;
          onResponse(info, String(url), json, { headers: this.__stashHeaders, body: this.__stashBody });
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // ---- one request on behalf of the extension ----

  // Anything that means "Instagram doesn't want this right now". The bridge stops on these.
  // opts.collection: this is the collection step, where a 404 or a web page
  // means the address is gone, not that you're logged out.
  // opts.write: an unsave, where a 404 about the post means the post is gone,
  // and "not saved" means it's already done.
  function verdict(status, json, text, opts = {}) {
    const errs = Array.isArray(json?.errors) ? json.errors : [];
    const msg = [json?.message, json?.errorSummary, json?.errorDescription, ...errs.map((e) => [e?.message, e?.summary, e?.description].filter(Boolean).join(' '))]
      .filter((x) => typeof x === 'string')
      .join(' ')
      .toLowerCase();
    if (status === 429 || /wait a few minutes|too many requests|rate.?limit|try again later/.test(msg)) return { pushback: 'rate', message: 'Instagram asked Stash to slow down.' };
    if (/checkpoint|challenge/.test(msg) || json?.checkpoint_url || json?.challenge) return { pushback: 'checkpoint', message: 'Instagram wants to confirm it’s you.' };
    if (json?.spam || /feedback_required|action.?block/.test(msg) || json?.feedback_title) return { pushback: 'blocked', message: 'Instagram limited activity on your account.' };
    if (status === 401 || json?.require_login || /login_required|not.?logged|please log ?in/.test(msg)) return { pushback: 'login', message: 'You’re not logged in to Instagram in this tab.' };
    if (status === 403) return { pushback: 'blocked', message: 'Instagram refused the request (403).' };
    if (status === 0 || status >= 500) return { error: status ? `Instagram returned ${status}` : 'network error', retry: true };
    if (!json) {
      if (/<html|<!doctype/i.test(text || '')) {
        if (opts.collection || opts.write) return { gone: true, error: 'Instagram sent a web page instead of data' };
        return { pushback: 'login', message: 'Instagram sent a web page instead of data. You may be logged out.' };
      }
      return { error: 'unreadable response' };
    }
    if (status === 404 && opts.write && /media|post|deleted|unavailable/.test(msg)) return { mediaGone: true, error: 'the post no longer exists' };
    if (status === 404 && (opts.collection || opts.write)) return { gone: true, error: 'Instagram no longer answers this address (404)' };
    if (opts.write && /not saved|isn.?t saved|already/.test(msg)) return null;
    if (status >= 400 || json.status === 'fail') return { error: json.message || `Instagram returned ${status}`, ...(opts.graphql ? { stale: true } : {}) };
    if (errs.length || json.error || json.errorSummary) return { error: errs[0]?.message || json.errorSummary || 'Instagram returned an error', stale: true };
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
    const info = classifyUrl(path);
    const bad = verdict(status, json, text, { collection: info?.kind === 'collection' });
    if (bad) return { status, ...bad };
    const r = info && parse(info, json);
    if (!r) return { status, error: 'unexpected response' };
    return { ok: true, status, ...r };
  }

  // The page's session tokens, read when needed. The app's latest GraphQL
  // request has the newest ones (Instagram refreshes fb_dtsg); the page's
  // own script data has the ones it loaded with.
  function pageTokens() {
    const t = { csrftoken: decodeURIComponent(cookie('csrftoken')) };
    if (lastGql) for (const k of ['fb_dtsg', 'lsd', 'av']) t[k] = lastGql.params.get(k) || undefined;
    const grab = (re) => {
      for (const s of document.scripts) {
        const m = s.textContent && s.textContent.match(re);
        if (m) return m[1];
      }
      return undefined;
    };
    t.fb_dtsg ||= grab(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
    t.lsd ||= grab(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
    if (!lastGql) {
      t.av = grab(/"IG_USER_EIMU"\s*:\s*"(\d+)"/) || cookie('ds_user_id') || undefined;
      t.hs = grab(/"haste_session"\s*:\s*"([^"]+)"/);
      t.rev = grab(/"server_revision"\s*:\s*(\d+)/);
      t.hsi = grab(/"hsi"\s*:\s*"(\d+)"/);
      t.spin_r = grab(/"__spin_r"\s*:\s*(\d+)/);
      t.spin_b = grab(/"__spin_b"\s*:\s*"([^"]+)"/);
      t.spin_t = grab(/"__spin_t"\s*:\s*(\d+)/);
    }
    if (t.fb_dtsg) t.jazoest = '2' + [...t.fb_dtsg].reduce((s, c) => s + c.charCodeAt(0), 0);
    return t;
  }

  // A learnt GraphQL request. A collection page also needs to know where its cursor goes.
  function validTemplate(t, { paged = true } = {}) {
    return Boolean(
      t &&
        GQL_PATHS.includes(t.path) &&
        /^\d{5,30}$/.test(t.docId || '') &&
        /^[A-Za-z0-9_]{0,120}$/.test(t.friendly || '') &&
        /^[A-Za-z0-9_]{0,120}$/.test(t.rootField || '') &&
        (!paged || t.rootField) &&
        t.variables &&
        typeof t.variables === 'object' &&
        JSON.stringify(t.variables).length < 8000 &&
        Array.isArray(t.idPath) &&
        t.idPath.length &&
        (!paged || (Array.isArray(t.cursorPath) && t.cursorPath.length)),
    );
  }

  let reqNo = 0;
  // Send a learnt GraphQL request with these variables, the way the app would.
  // Returns { res, text }, or { error, stale } when the page has no session tokens.
  async function postGql(t, variables) {
    const tok = pageTokens();
    if (!tok.fb_dtsg || !tok.lsd || !tok.csrftoken) return { error: 'couldn’t find Instagram’s session tokens on this page', stale: true };
    let body;
    let headers;
    if (lastGql) {
      // Same form fields and headers as the app's own latest request.
      body = new URLSearchParams(lastGql.params);
      const last = parseInt(body.get('__req') || '0', 36);
      body.set('__req', ((Number.isFinite(last) ? last : 0) + 1 + reqNo++).toString(36));
      headers = {};
      for (const [k, v] of Object.entries(lastGql.headers)) {
        if (!/^(content-length|content-type|cookie|host|origin|referer|user-agent|accept-encoding|connection|x-csrftoken|x-fb-lsd|x-fb-friendly-name|x-root-field-name)$/.test(k)) headers[k] = v;
      }
    } else {
      // No GraphQL request seen on this page load yet: the fields Instagram's web app sends.
      body = new URLSearchParams();
      if (tok.av) body.set('av', tok.av);
      body.set('__d', 'www');
      body.set('__user', '0');
      body.set('__a', '1');
      body.set('__req', (++reqNo).toString(36));
      if (tok.hs) body.set('__hs', tok.hs);
      body.set('dpr', String(Math.round(window.devicePixelRatio || 1)));
      body.set('__ccg', 'EXCELLENT');
      if (tok.rev) body.set('__rev', tok.rev);
      if (tok.hsi) body.set('__hsi', tok.hsi);
      body.set('__comet_req', '7');
      if (tok.spin_r) body.set('__spin_r', tok.spin_r);
      if (tok.spin_b) body.set('__spin_b', tok.spin_b);
      if (tok.spin_t) body.set('__spin_t', tok.spin_t);
      body.set('fb_api_caller_class', 'RelayModern');
      body.set('server_timestamps', 'true');
      headers = {};
    }
    body.set('fb_dtsg', tok.fb_dtsg);
    body.set('jazoest', tok.jazoest);
    body.set('lsd', tok.lsd);
    if (t.friendly) body.set('fb_api_req_friendly_name', t.friendly);
    else body.delete('fb_api_req_friendly_name'); // the copied one names another query
    body.set('variables', JSON.stringify(variables));
    body.set('doc_id', t.docId);
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['x-csrftoken'] = tok.csrftoken;
    headers['x-fb-lsd'] = tok.lsd;
    if (t.friendly) headers['x-fb-friendly-name'] = t.friendly;
    if (t.rootField) headers['x-root-field-name'] = t.rootField;
    if (!Object.keys(headers).includes('x-ig-app-id')) headers['x-ig-app-id'] = hints.appId || WEB_APP_ID;
    if (!Object.keys(headers).includes('x-asbd-id')) headers['x-asbd-id'] = hints.asbd || ASBD_ID;
    let res;
    let text = '';
    try {
      res = await origFetch(t.path, { method: 'POST', headers, body: body.toString(), credentials: 'include' });
      text = await res.text();
    } catch {}
    return { res, text };
  }

  // One page of a collection, through the learnt GraphQL request.
  async function gqlRequest(t, igId, cursor) {
    if (!validTemplate(t) || !/^\d{5,30}$/.test(String(igId))) return { error: 'no usable collection request', stale: true };
    const variables = JSON.parse(JSON.stringify(t.variables));
    setAt(variables, t.idPath, typeof getAt(variables, t.idPath) === 'number' ? Number(igId) : String(igId));
    setAt(variables, t.cursorPath, cursor || null);
    const sent = await postGql(t, variables);
    if (sent.error) return sent;
    const { res, text } = sent;
    const json = parseText(text);
    const status = res?.status ?? 0;
    const bad = verdict(status, json, text, { collection: true, graphql: true });
    if (bad) return { status, ...bad };
    if (json?.data && COLLECTION_ROOT in json.data && !json.data[COLLECTION_ROOT]) return { status, error: 'collection not found' };
    const r = collectionPart(json) && parse({ kind: 'graphql', igId: String(igId), cursor: cursor || null }, json);
    if (!r) return { status, error: 'unexpected response', stale: true };
    return { ok: true, status, ...r };
  }

  const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // A post's media id from its link: the shortcode is the id written in base 64.
  function codeToPk(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{6,}$/.test(code)) return '';
    let n = 0n;
    for (const c of code.slice(0, 11)) n = n * 64n + BigInt(SHORTCODE.indexOf(c));
    return n > 0n ? n.toString() : '';
  }

  // Unsave one post: through a learnt request if there is one, else the web app's usual address.
  async function unsaveRequest(item, t) {
    const pk = /^\d{5,25}$/.test(String(item?.pk || '')) ? String(item.pk) : codeToPk(item?.code);
    if (!pk) return { error: 'couldn’t work out this post’s id', skip: true };
    let res;
    let text = '';
    if (t?.kind === 'graphql') {
      if (!validTemplate(t, { paged: false })) return { error: 'no usable unsave request', stale: true };
      const value = t.idFormat === 'pk_owner' ? (/^\d{1,25}$/.test(String(item.owner || '')) ? `${pk}_${item.owner}` : '') : pk;
      if (!value) return { error: 'this post has no author id', skip: true };
      const variables = JSON.parse(JSON.stringify(t.variables));
      setAt(variables, t.idPath, typeof getAt(variables, t.idPath) === 'number' ? Number(value) : value);
      const sent = await postGql(t, variables);
      if (sent.error) return sent;
      ({ res, text } = sent);
    } else {
      const path = t?.kind === 'rest' && /^\/[\w./-]*\{pk\}[\w./-]*$/.test(t.path || '') ? t.path.replace('{pk}', pk) : `/api/v1/web/save/${pk}/unsave/`;
      try {
        res = await origFetch(path, { method: 'POST', headers: { ...requestHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', credentials: 'include' });
        text = await res.text();
      } catch {}
    }
    const status = res?.status ?? 0;
    const bad = verdict(status, parseText(text), text, { write: true, graphql: t?.kind === 'graphql' });
    if (bad) return { status, ...bad };
    return { ok: true, status };
  }

  const describe = (r) => `${r.status}${r.items ? `, ${r.items.length} posts` : ''}${r.pushback ? ` (${r.pushback})` : ''}${r.error ? ` (${r.error})` : ''}`;
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d?.__stash === 'ig-fetch') {
      const r = await request(d.path);
      log(`GET ${String(d.path).split('?')[0]} → ${describe(r)}`);
      post('ig-fetch-result', { id: d.id, result: r });
    } else if (d?.__stash === 'ig-gql') {
      const r = await gqlRequest(d.template, d.igId, d.cursor);
      log(`POST ${d.template?.path || 'graphql'} (${d.template?.friendly || 'collection'}, collection ${d.igId}) → ${describe(r)}`);
      post('ig-fetch-result', { id: d.id, result: r });
    } else if (d?.__stash === 'ig-unsave') {
      const r = await unsaveRequest(d.item, d.template);
      const how = d.template?.kind === 'graphql' ? d.template.friendly || 'GraphQL' : d.template?.kind === 'rest' ? d.template.path : 'web/save';
      log(`unsave ${d.item?.code} (${how}) → ${r.ok ? 'done' : describe(r)}`);
      post('ig-fetch-result', { id: d.id, result: r });
    }
  });
})();
