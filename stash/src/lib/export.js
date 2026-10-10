// JSON backup/restore and Markdown (Obsidian) export.

import * as db from './db.js';

export async function exportJson() {
  const bookmarks = (await db.allBookmarks()).map(({ embedding, ...b }) => b);
  const collections = await db.allCollections();
  return new Blob([JSON.stringify({ app: 'stash', version: 1, exportedAt: new Date().toISOString(), collections, bookmarks }, null, 2)], {
    type: 'application/json',
  });
}

export async function importJson(text) {
  const data = JSON.parse(text);
  if (data?.app !== 'stash' || !Array.isArray(data.bookmarks)) throw new Error('Not a Stash backup file.');
  for (const c of data.collections || []) await db.putCollection(c);
  let added = 0;
  for (const b of data.bookmarks) {
    if (!b?.id) continue;
    const cur = await db.getBookmark(b.id);
    if (!cur) added++;
    const merged = cur
      ? { ...cur, ...b, tags: [...new Set([...(cur.tags || []), ...(b.tags || [])])], embedding: cur.embedding, enriched: cur.enriched }
      : { ...db.newBookmark(b), ...b, embedding: null, enriched: 0 };
    await db.putBookmark(merged);
  }
  return { added, total: data.bookmarks.length };
}

// ---------- markdown ----------

function slug(s, max = 80) {
  return (s || 'untitled').replace(/[\\/:*?"<>|#^[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'untitled';
}

function yamlStr(s) {
  return JSON.stringify(String(s ?? ''));
}

function toMarkdown(b, collectionName) {
  const tags = [...new Set([...(b.tags || []), ...(b.autoTags || [])])].map((t) => t.replace(/\s+/g, '-'));
  const fm = [
    '---',
    `title: ${yamlStr(b.title)}`,
    `url: ${yamlStr(b.url)}`,
    `source: ${b.source}`,
    b.author ? `author: ${yamlStr(b.author)}` : null,
    collectionName ? `collection: ${yamlStr(collectionName)}` : null,
    `saved: ${new Date(b.savedAt).toISOString().slice(0, 10)}`,
    b.postedAt ? `posted: ${new Date(b.postedAt).toISOString().slice(0, 10)}` : null,
    `tags: [${tags.map(yamlStr).join(', ')}]`,
    '---',
  ].filter(Boolean);
  const body = [`# ${b.title || b.url}`, '', `<${b.url}>`, ''];
  if (b.image) body.push(`![](${b.image})`, '');
  if (b.note) body.push('> [!note] My note', ...b.note.split('\n').map((l) => `> ${l}`), '');
  if (b.text) body.push(b.text, '');
  return fm.join('\n') + '\n\n' + body.join('\n');
}

export async function exportMarkdownZip() {
  const [bookmarks, collections] = await Promise.all([db.allBookmarks(), db.allCollections()]);
  const names = new Map(collections.map((c) => [c.id, c.name]));
  const used = new Set();
  const files = [];
  for (const b of bookmarks) {
    const folder = names.get(b.collectionId) ? slug(names.get(b.collectionId), 60) : 'Inbox';
    let path = `Stash/${folder}/${slug(b.title || b.url)}.md`;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = `Stash/${folder}/${slug(b.title || b.url)} ${i}.md`;
    used.add(path.toLowerCase());
    files.push({ path, data: new TextEncoder().encode(toMarkdown(b, names.get(b.collectionId))) });
  }
  return zip(files);
}

// ---------- minimal store-only zip writer ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
