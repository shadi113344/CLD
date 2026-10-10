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

// ---------- list export (current view: one platform, collection, tag or search) ----------

export const LIST_FORMATS = {
  md: 'Markdown (.md)',
  csv: 'Spreadsheet (.csv)',
  json: 'JSON (.json)',
  html: 'Web page (.html)',
  bookmarks: 'Browser bookmarks (.html)',
  pdf: 'PDF (print / save as PDF)',
  txt: 'Plain list of links (.txt)',
};

const SOURCE_NAMES = { x: 'X', reddit: 'Reddit', linkedin: 'LinkedIn', web: 'Web' };

// X and LinkedIn posts have generic titles ("Jane on X"); the post text says more.
export function displayTitle(b) {
  if ((b.source === 'x' || b.source === 'linkedin') && b.text) {
    const first = b.text.split('\n').find((l) => l.trim()) || '';
    return first.length > 110 ? first.slice(0, 107).trimEnd() + '…' : first;
  }
  return b.title || b.url;
}

function rows(list, collections) {
  const names = new Map((collections || []).map((c) => [c.id, c.name]));
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  return list.map((b) => ({
    title: displayTitle(b),
    url: b.url,
    source: SOURCE_NAMES[b.source] || b.source,
    author: b.author || '',
    saved: day(b.savedAt),
    posted: day(b.postedAt),
    tags: [...new Set([...(b.tags || []), ...(b.autoTags || [])])],
    collection: names.get(b.collectionId) || '',
    note: b.note || '',
    text: b.text || '',
  }));
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mdText = (s) => String(s).replace(/([\[\]])/g, '\\$1');

export function htmlPage(title, r) {
  const items = r
    .map(
      (x) => `<li><a href="${escHtml(x.url)}">${escHtml(x.title)}</a>
      <div class="m">${[x.source, x.author, x.saved && 'saved ' + x.saved, x.collection].filter(Boolean).map(escHtml).join(' · ')}</div>
      ${x.tags.length ? `<div class="t">${x.tags.map((t) => '#' + escHtml(t)).join(' ')}</div>` : ''}
      ${x.note ? `<div class="n">${escHtml(x.note)}</div>` : ''}</li>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>
body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#16161d;background:#fff}
h1{font-size:22px;margin:0 0 4px}.sub{color:#6b6b7b;margin:0 0 24px;font-size:13px}
ol{padding-left:22px}li{margin:0 0 14px;break-inside:avoid}a{color:#4b3fd6;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}
.m,.t{font-size:12px;color:#6b6b7b}.t{color:#4b3fd6}.n{font-size:13px;border-left:3px solid #e4e4ea;padding-left:8px;margin-top:4px}
@media print{body{margin:0}a{color:#000}a::after{content:" — " attr(href);font-weight:400;font-size:10px;color:#555;word-break:break-all}}
@media (prefers-color-scheme:dark){body{background:#0f0f13;color:#ececf1}a{color:#a99fff}.t{color:#a99fff}.n{border-color:#2a2a34}}
</style></head><body><h1>${escHtml(title)}</h1><p class="sub">${r.length} link${r.length === 1 ? '' : 's'} · exported from Stash on ${new Date().toLocaleDateString()}</p>
<ol>${items}</ol></body></html>`;
}

// Returns { blob, ext } for downloadable formats, or { html } for 'pdf' (caller prints it).
export function exportList(list, format, title, collections) {
  const r = rows(list, collections);
  const blob = (text, type) => new Blob([text], { type: `${type};charset=utf-8` });
  switch (format) {
    case 'md':
      return {
        ext: 'md',
        blob: blob(
          `# ${title}\n\n${r.length} links · exported ${new Date().toISOString().slice(0, 10)}\n\n` +
            r
              .map((x) => {
                const meta = [x.author, x.saved && `saved ${x.saved}`, x.tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ')].filter(Boolean).join(' · ');
                return `- [${mdText(x.title)}](<${x.url}>)${meta ? `  \n  ${meta}` : ''}${x.note ? `  \n  > ${x.note.replace(/\n/g, ' ')}` : ''}`;
              })
              .join('\n') +
            '\n',
          'text/markdown',
        ),
      };
    case 'csv': {
      const cols = ['title', 'url', 'source', 'author', 'saved', 'posted', 'tags', 'collection', 'note', 'text'];
      const text = [cols.join(','), ...r.map((x) => cols.map((c) => csvCell(x[c])).join(','))].join('\r\n');
      return { ext: 'csv', blob: blob('﻿' + text, 'text/csv') }; // BOM so Excel reads UTF-8
    }
    case 'json':
      return { ext: 'json', blob: blob(JSON.stringify(r, null, 2), 'application/json') };
    case 'html':
      return { ext: 'html', blob: blob(htmlPage(title, r), 'text/html') };
    case 'bookmarks': {
      // Netscape format: imports into Chrome, Firefox, Safari, Edge, Raindrop, Pinboard…
      const now = Math.floor(Date.now() / 1000);
      const items = list
        .map((b, i) => {
          const x = r[i];
          return `        <DT><A HREF="${escHtml(x.url)}" ADD_DATE="${Math.floor((b.savedAt || Date.now()) / 1000)}"${x.tags.length ? ` TAGS="${escHtml(x.tags.join(','))}"` : ''}>${escHtml(x.title)}</A>`;
        })
        .join('\n');
      const text = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n    <DT><H3 ADD_DATE="${now}">${escHtml(title)}</H3>\n    <DL><p>\n${items}\n    </DL><p>\n</DL><p>\n`;
      return { ext: 'html', blob: blob(text, 'text/html') };
    }
    case 'txt':
      return { ext: 'txt', blob: blob(r.map((x) => x.url).join('\n') + '\n', 'text/plain') };
    case 'pdf':
      return { html: htmlPage(title, r) };
  }
  throw new Error('Unknown format ' + format);
}
