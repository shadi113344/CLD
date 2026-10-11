// IndexedDB wrapper shared by the service worker and extension pages.
// Everything Stash knows lives here; nothing is sent anywhere by this module.

const DB_NAME = 'stash';
const DB_VERSION = 1;

let dbPromise;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const b = db.createObjectStore('bookmarks', { keyPath: 'id' });
      b.createIndex('savedAt', 'savedAt');
      b.createIndex('source', 'source');
      b.createIndex('enriched', 'enriched');
      b.createIndex('reviewDue', 'reviewDue');
      db.createObjectStore('collections', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer Stash version upgrade the database even while this tab is open.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// People (saved X Following/Followers lists) live in their own database, so adding
// them never required upgrading the bookmarks database.
let peopleDbPromise;
function openPeopleDb() {
  peopleDbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('stash-people', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('people', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return peopleDbPromise;
}

// Small local copies of images whose links expire (Instagram's do within days).
// Also a separate database, for the same reason as people.
let mediaDbPromise;
function openMediaDb() {
  mediaDbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('stash-media', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('thumbs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return mediaDbPromise;
}

async function store(name, mode = 'readonly') {
  const db = name === 'people' ? await openPeopleDb() : name === 'thumbs' ? await openMediaDb() : await openDb();
  return db.transaction(name, mode).objectStore(name);
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------- bookmarks ----------

export async function getBookmark(id) {
  return promisify((await store('bookmarks')).get(id));
}

export async function allBookmarks() {
  const list = await promisify((await store('bookmarks')).getAll());
  return list.sort((a, b) => b.savedAt - a.savedAt);
}

export async function putBookmark(b) {
  b.updatedAt = Date.now();
  return promisify((await store('bookmarks', 'readwrite')).put(b));
}

export async function deleteBookmark(id) {
  await deleteThumb(id);
  return promisify((await store('bookmarks', 'readwrite')).delete(id));
}

export async function patchBookmark(id, patch) {
  const db = await openDb();
  const tx = db.transaction('bookmarks', 'readwrite');
  const s = tx.objectStore('bookmarks');
  const cur = await promisify(s.get(id));
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  s.put(next);
  await txDone(tx);
  return next;
}

// Insert new items or merge into existing ones without clobbering anything
// the user edited (tags, note, collection, review state).
// Instagram items may carry igCollections (their full list of Instagram
// collections, replacing what was stored) or igCollectionsAdd (collections
// to add). stats.linked counts items whose Instagram collections changed and
// stats.updated counts existing items that changed at all.
export async function upsertMany(items, stats = {}) {
  const db = await openDb();
  const tx = db.transaction('bookmarks', 'readwrite');
  const s = tx.objectStore('bookmarks');
  const added = [];
  stats.linked = 0;
  stats.updated = 0;
  for (const { igCollectionsAdd, fillOnly, ...item } of items) {
    const cur = await promisify(s.get(item.id));
    const ig = mergeIgCollections(cur?.igCollections, item.igCollections, igCollectionsAdd);
    if (ig.changed) stats.linked++;
    if (cur) {
      // fillOnly items (from an export) only fill gaps; they never replace what a sync found.
      const pick = (k) => (fillOnly ? cur[k] || item[k] : item[k] || cur[k]) ?? cur[k];
      const next = { title: pick('title'), text: pick('text'), author: pick('author'), authorHandle: pick('authorHandle'), image: pick('image'), postedAt: pick('postedAt') };
      const contentChanged = next.text !== cur.text || next.title !== cur.title;
      // An export's real "saved on" time beats the estimate a live sync makes.
      const exact = item.savedAtExact && !cur.savedAtExact;
      // Likes, views and comments: the latest sync's numbers replace older ones.
      const metrics = item.metrics && !fillOnly ? item.metrics : null;
      const metricsChanged = metrics && ['likes', 'comments', 'views'].some((k) => metrics[k] !== cur.metrics?.[k]);
      if (contentChanged || ig.changed || exact || metricsChanged || (next.image !== cur.image && !cur.thumb)) stats.updated++;
      s.put({
        ...cur,
        ...next,
        ...(item.mediaType && !(fillOnly && cur.mediaType) ? { mediaType: item.mediaType } : {}),
        ...(ig.list ? { igCollections: ig.list } : {}),
        ...(exact ? { savedAt: item.savedAt, savedAtExact: true } : {}),
        ...(metrics ? { metrics } : {}),
        enriched: contentChanged ? 0 : cur.enriched,
        updatedAt: Date.now(),
      });
    } else {
      const b = newBookmark({ ...item, igCollections: ig.list });
      s.put(b);
      added.push(b.id);
    }
  }
  await txDone(tx);
  return added;
}

function mergeIgCollections(cur, replace, add) {
  if (!replace && !add?.length) return { list: null, changed: false };
  const before = cur || [];
  const list = [...new Set([...(replace || before), ...(add || [])])];
  const changed = list.length !== before.length || list.some((x) => !before.includes(x));
  return { list, changed };
}

export function newBookmark(item) {
  const now = Date.now();
  return {
    id: item.id,
    source: item.source || 'web',
    url: item.url || '',
    title: item.title || '',
    text: item.text || '',
    author: item.author || '',
    authorHandle: item.authorHandle || '',
    image: item.image || '',
    postedAt: item.postedAt || 0,
    savedAt: item.savedAt || now,
    updatedAt: now,
    tags: item.tags || [],
    autoTags: item.autoTags || [],
    collectionId: item.collectionId || '',
    note: item.note || '',
    embedding: null,
    enriched: 0,
    reviewDue: item.reviewDue ?? 0,
    reviewStep: item.reviewStep ?? 0,
    ...(item.mediaType ? { mediaType: item.mediaType } : {}),
    ...(item.igCollections?.length ? { igCollections: item.igCollections } : {}),
    ...(item.savedAtExact ? { savedAtExact: true } : {}),
    ...(item.metrics ? { metrics: item.metrics } : {}),
  };
}

export async function pendingEnrichment(limit = 32) {
  const s = await store('bookmarks');
  return promisify(s.index('enriched').getAll(IDBKeyRange.only(0), limit));
}

export async function dueForReview(now = Date.now()) {
  const s = await store('bookmarks');
  const list = await promisify(s.index('reviewDue').getAll(IDBKeyRange.bound(1, now)));
  return list.sort((a, b) => a.reviewDue - b.reviewDue);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(['bookmarks', 'collections', 'kv'], 'readwrite');
  for (const n of ['bookmarks', 'collections', 'kv']) tx.objectStore(n).clear();
  const ptx = (await openPeopleDb()).transaction('people', 'readwrite');
  ptx.objectStore('people').clear();
  const mtx = (await openMediaDb()).transaction('thumbs', 'readwrite');
  mtx.objectStore('thumbs').clear();
  return Promise.all([txDone(tx), txDone(ptx), txDone(mtx)]);
}

// ---------- collections ----------

export async function allCollections() {
  const list = await promisify((await store('collections')).getAll());
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export async function putCollection(c) {
  return promisify((await store('collections', 'readwrite')).put(c));
}

export async function deleteCollection(id) {
  // A deleted Instagram collection stays deleted: later syncs won't bring it back.
  const c = await promisify((await store('collections')).get(id));
  if (c?.igId) {
    const ignored = new Set((await kvGet('igIgnoredCollections')) || []);
    ignored.add(c.igId);
    if (c.igName) ignored.add('name:' + c.igName);
    await kvSet('igIgnoredCollections', [...ignored]);
  }
  const db = await openDb();
  const tx = db.transaction(['collections', 'bookmarks'], 'readwrite');
  tx.objectStore('collections').delete(id);
  const bs = tx.objectStore('bookmarks');
  const all = await promisify(bs.getAll());
  for (const b of all) if (b.collectionId === id) bs.put({ ...b, collectionId: '' });
  return txDone(tx);
}

// A bookmark is in a collection if you put it there, or if it's an Instagram
// post saved to the Instagram collection that collection mirrors.
export function inCollection(b, c) {
  return b.collectionId === c.id || Boolean(c.igId && b.igCollections?.includes(c.igId));
}

export function collectionsOf(b, collections) {
  return collections.filter((c) => inCollection(b, c));
}

// Create or update the Stash collections that mirror Instagram collections.
// list: [{ igId, name }]. igId is Instagram's collection id, or "name:<name>"
// when it came from an export (which has names but no ids). Returns
// { [igId given]: igId stored }, so an import can file posts under a
// collection that a live sync already created, and vice versa.
export async function mirrorIgCollections(list) {
  const ignored = new Set((await kvGet('igIgnoredCollections')) || []);
  const db = await openDb();
  const tx = db.transaction(['collections', 'bookmarks'], 'readwrite');
  const cs = tx.objectStore('collections');
  const all = await promisify(cs.getAll());
  const map = {};
  const renamed = new Map(); // "name:<name>" -> real Instagram id
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  for (const { igId, name } of list) {
    if (!igId || !name) continue;
    if (ignored.has(igId) || ignored.has('name:' + name)) continue;
    const fromExport = igId.startsWith('name:');
    let c = all.find((x) => x.igId === igId);
    if (!c && !fromExport) {
      c = all.find((x) => x.igId === 'name:' + name);
      if (c) renamed.set(c.igId, igId);
    }
    if (!c && fromExport) c = all.find((x) => x.igId && same(x.igName, name));
    if (!c) c = all.find((x) => !x.igId && same(x.name, name)); // adopt your own collection with the same name
    if (!c) {
      c = { id: uid(), name, createdAt: Date.now() };
      all.push(c);
    }
    if (!c.igId || renamed.has(c.igId)) c.igId = renamed.get(c.igId) || igId;
    // Follow a rename on Instagram, unless you renamed the collection in Stash.
    if (!fromExport && c.igName && c.igName !== name && c.name === c.igName) c.name = name;
    if (!fromExport || !c.igName) c.igName = name;
    cs.put(c);
    map[igId] = c.igId;
  }
  if (renamed.size) {
    const bs = tx.objectStore('bookmarks');
    for (const b of await promisify(bs.index('source').getAll(IDBKeyRange.only('instagram')))) {
      if (!b.igCollections?.some((x) => renamed.has(x))) continue;
      bs.put({ ...b, igCollections: [...new Set(b.igCollections.map((x) => renamed.get(x) || x))] });
    }
  }
  await txDone(tx);
  return map;
}

// After a complete pass of one Instagram collection, take it off posts no longer in it.
export async function finalizeIgCollection(igId, keepIds) {
  const keep = new Set(keepIds);
  const db = await openDb();
  const tx = db.transaction('bookmarks', 'readwrite');
  const s = tx.objectStore('bookmarks');
  let removed = 0;
  for (const b of await promisify(s.index('source').getAll(IDBKeyRange.only('instagram')))) {
    if (!b.igCollections?.includes(igId) || keep.has(b.id)) continue;
    s.put({ ...b, igCollections: b.igCollections.filter((x) => x !== igId) });
    removed++;
  }
  await txDone(tx);
  return removed;
}

// ---------- thumbnails ----------

export async function putThumb(id, { blob, width = 0, height = 0 }) {
  return promisify((await store('thumbs', 'readwrite')).put({ id, blob, type: blob.type, width, height, savedAt: Date.now() }));
}

export async function getThumbs(ids) {
  const s = await store('thumbs');
  const rows = await Promise.all(ids.map((id) => promisify(s.get(id))));
  return new Map(rows.filter(Boolean).map((t) => [t.id, t]));
}

export async function allThumbs() {
  return promisify((await store('thumbs')).getAll());
}

export async function deleteThumb(id) {
  return promisify((await store('thumbs', 'readwrite')).delete(id));
}

// Instagram posts with an image link but no local copy yet (or whose last
// attempt failed on a different link than the one we have now).
export async function pendingThumbs() {
  const s = await store('bookmarks');
  const list = await promisify(s.index('source').getAll(IDBKeyRange.only('instagram')));
  return list.filter((b) => b.image && !b.thumb && b.thumbFailed !== b.image);
}

// ---------- people (Following / Followers lists) ----------
// Each person records which saved lists they're on: lists['owner/relation'] = first-seen time.

export async function allPeople() {
  return promisify((await store('people')).getAll());
}

export async function upsertPeople(owner, relation, people) {
  const key = `${owner}/${relation}`;
  const db = await openPeopleDb();
  const tx = db.transaction('people', 'readwrite');
  const s = tx.objectStore('people');
  let added = 0;
  for (const p of people) {
    const cur = await promisify(s.get(p.id));
    const lists = { ...(cur?.lists || {}) };
    if (!lists[key]) {
      lists[key] = Date.now();
      added++;
    }
    s.put({ ...(cur || {}), ...p, lists, updatedAt: Date.now() });
  }
  await txDone(tx);
  return added;
}

// After a complete pass of a list, remove that list from anyone not seen in it.
export async function finalizePeopleList(owner, relation, keepIds) {
  const key = `${owner}/${relation}`;
  const keep = new Set(keepIds);
  const db = await openPeopleDb();
  const tx = db.transaction('people', 'readwrite');
  const s = tx.objectStore('people');
  let removed = 0;
  for (const p of await promisify(s.getAll())) {
    if (!p.lists?.[key] || keep.has(p.id)) continue;
    const { [key]: _, ...rest } = p.lists;
    removed++;
    if (Object.keys(rest).length) s.put({ ...p, lists: rest });
    else s.delete(p.id);
  }
  await txDone(tx);
  return removed;
}

export async function deletePeopleList(owner, relation) {
  return finalizePeopleList(owner, relation, []);
}

// ---------- key/value ----------

export async function kvGet(k) {
  const row = await promisify((await store('kv')).get(k));
  return row ? row.v : undefined;
}

export async function kvSet(k, v) {
  return promisify((await store('kv', 'readwrite')).put({ k, v }));
}

// ---------- helpers ----------

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function webId(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/.test(p)) u.searchParams.delete(p);
    return 'web:' + u.toString();
  } catch {
    return 'web:' + url;
  }
}
