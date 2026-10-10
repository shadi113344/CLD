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

async function store(name, mode = 'readonly') {
  const db = name === 'people' ? await openPeopleDb() : await openDb();
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
export async function upsertMany(items) {
  const db = await openDb();
  const tx = db.transaction('bookmarks', 'readwrite');
  const s = tx.objectStore('bookmarks');
  const added = [];
  for (const item of items) {
    const cur = await promisify(s.get(item.id));
    if (cur) {
      const contentChanged = (item.text && item.text !== cur.text) || (item.title && item.title !== cur.title);
      s.put({
        ...cur,
        title: item.title || cur.title,
        text: item.text || cur.text,
        author: item.author || cur.author,
        authorHandle: item.authorHandle || cur.authorHandle,
        image: item.image || cur.image,
        postedAt: item.postedAt || cur.postedAt,
        enriched: contentChanged ? 0 : cur.enriched,
        updatedAt: Date.now(),
      });
    } else {
      const b = newBookmark(item);
      s.put(b);
      added.push(b.id);
    }
  }
  await txDone(tx);
  return added;
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
  return Promise.all([txDone(tx), txDone(ptx)]);
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
  const db = await openDb();
  const tx = db.transaction(['collections', 'bookmarks'], 'readwrite');
  tx.objectStore('collections').delete(id);
  const bs = tx.objectStore('bookmarks');
  const all = await promisify(bs.getAll());
  for (const b of all) if (b.collectionId === id) bs.put({ ...b, collectionId: '' });
  return txDone(tx);
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
