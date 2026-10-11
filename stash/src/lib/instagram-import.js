// Instagram's own export (Accounts Center → Download your information).
// Reads saved_posts and saved_collections from the export .zip, or from those
// files taken out of it (JSON or HTML), and returns Stash items and the
// collections they belong to. The export has each post's link, its author's
// username and when you saved it, but no captions or images: a live sync
// fills those in later for posts that are still in your Saved.

import { readZip } from './unzip.js';

const POST = /https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,64})/;
const WANTED = /(^|\/)saved_(posts|collections)[^/]*\.(json|html?)$/i;

// Meta's exports write UTF-8 bytes as if they were Latin-1 ("CafÃ©"); undo that.
export function fixText(s) {
  if (typeof s !== 'string' || !/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

export async function readInstagramExport(files) {
  const docs = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) docs.push(...(await readZip(f, (n) => WANTED.test(n))));
    else docs.push({ name: f.name, text: await f.text() });
  }
  // Saved posts first, so their exact "saved on" times win over collection "added" times.
  const isCollections = (d) => /saved_collections/i.test(d.name) || (!/saved_posts/i.test(d.name) && /"saved_saved_collections"|>\s*Collection\s*</i.test(d.text.slice(0, 200000)));
  docs.sort((a, b) => isCollections(a) - isCollections(b));

  const posts = new Map();
  const collections = new Map(); // igId -> { igId, name }
  const add = (item, igId) => {
    const cur = posts.get(item.id);
    const next = cur ? { ...item, ...cur } : item;
    if (!next.savedAtExact && item.savedAtExact) Object.assign(next, { savedAt: item.savedAt, savedAtExact: true });
    if (igId) next.igCollectionsAdd = [...new Set([...(next.igCollectionsAdd || []), igId])];
    posts.set(item.id, next);
  };

  for (const d of docs) {
    const inCollections = isCollections(d);
    const records = /\.html?$/i.test(d.name) ? fromHtml(d.text) : fromJson(d.text);
    let current = null;
    for (const r of records) {
      if (!r.code) {
        // In saved_collections, a record without a post starts the next collection.
        if (inCollections && r.name) {
          current = { igId: 'name:' + r.name, name: r.name };
          collections.set(current.igId, current);
        }
        continue;
      }
      add(toItem(r, !inCollections), inCollections ? current?.igId : null);
    }
  }
  return { items: [...posts.values()], collections: [...collections.values()], read: docs.map((d) => d.name) };
}

function toItem(r, exactTime) {
  const reel = /^reels?$/.test(r.kind);
  const handle = (r.user || '').replace(/^@/, '');
  const t = r.time > 1e12 ? r.time : r.time * 1000;
  return {
    id: 'instagram:' + r.code,
    source: 'instagram',
    url: `https://www.instagram.com/${reel ? 'reel' : 'p'}/${r.code}/`,
    title: handle ? `@${handle} on Instagram` : 'Instagram post',
    author: handle,
    authorHandle: handle,
    ...(reel ? { mediaType: 'reel' } : {}),
    ...(t ? { savedAt: t, ...(exactTime ? { savedAtExact: true } : {}) } : {}),
    // Never overwrite what a live sync already knows (full name, caption, image).
    fillOnly: true,
  };
}

// ---------- JSON ----------
// Known layouts: { saved_saved_media: [{ title, string_map_data: { "Saved on": { href, timestamp } } }] },
// saved_saved_collections with a { title: "Collection", string_map_data: { Name: { value } } } record
// before each collection's posts, and the newer [{ timestamp, label_values: [{ label, value, href }] }].

function fromJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That file isn’t valid JSON. Choose the export .zip, or saved_posts.json from inside it.');
  }
  const list = Array.isArray(json) ? json : Object.values(json || {}).filter(Array.isArray).flat();
  return list.map(scan);
}

function scan(entry) {
  const r = { code: null, kind: null, time: 0, user: '', name: '' };
  const values = []; // { label, text }
  const visit = (n, label, depth) => {
    if (!n || typeof n !== 'object' || depth > 8) return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, label, depth + 1));
    const here = typeof n.label === 'string' ? n.label : label;
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === 'string') {
        const m = v.match(POST);
        if (m) {
          if (!r.code) [, r.kind, r.code] = m;
        } else if ((k === 'value' || k === 'name') && v.trim() && !/^https?:\/\//.test(v)) {
          values.push({ label: here || '', text: fixText(v.trim()) });
        }
      } else if (typeof v === 'number') {
        if (/timestamp/i.test(k) && !r.time) r.time = v;
      } else {
        visit(v, ['string_map_data', 'label_values', 'dict', 'media'].includes(k) ? here : k, depth + 1);
      }
    }
  };
  visit(entry, '', 0);
  const title = typeof entry?.title === 'string' ? fixText(entry.title.trim()) : '';
  const labelled = (re) => values.find((v) => re.test(v.label))?.text;
  r.user = labelled(/user|owner|author|account/i) || title || labelled(/name/i) || values[0]?.text || '';
  r.name = labelled(/name/i) || values[0]?.text || (title && !/^collection$/i.test(title) ? title : '');
  return r;
}

// ---------- HTML (best effort; the JSON export is more reliable) ----------

function fromHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const isPost = (a) => POST.test(a.getAttribute('href') || '');
  const links = [...doc.querySelectorAll('a[href]')].filter(isPost);
  if (!links.length) return [];
  // Each record is the largest element around a link that holds no other post link.
  const count = new Map();
  for (const a of links) for (let el = a.parentElement; el; el = el.parentElement) count.set(el, (count.get(el) || 0) + 1);
  const recordOf = (a) => {
    let el = a;
    while (el.parentElement && el.parentElement !== doc.body && count.get(el.parentElement) === 1) el = el.parentElement;
    return el;
  };
  const first = recordOf(links[0]);
  const parent = first.parentElement;
  const sameParent = links.every((a) => recordOf(a).parentElement === parent);
  const records = sameParent ? [...parent.children] : links.map(recordOf);
  return records.map((el) => {
    const leaves = [el, ...el.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim()).filter(Boolean);
    const link = [...el.querySelectorAll('a[href]')].find(isPost);
    const m = link?.getAttribute('href').match(POST);
    const date = leaves.find(isDate);
    const words = leaves.filter((t) => !isDate(t) && !/^https?:\/\//.test(t));
    return {
      code: m?.[2] || null,
      kind: m?.[1] || null,
      time: date ? Date.parse(date) : 0,
      user: fixText(words[0] || ''),
      name: fixText(words[1] || words[0] || ''), // a collection record: its heading, then its name
    };
  });
}

function isDate(t) {
  return /\d/.test(t) && /[A-Za-z]|[-/:]/.test(t) && !/^[A-Za-z0-9._]{1,30}$/.test(t) && !Number.isNaN(Date.parse(t));
}
