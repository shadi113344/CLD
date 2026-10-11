// Pure ranking helpers, shared by the background and the UI.

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalised
}

const STOP = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was were what when where which who why will with you your how do does did can'.split(' '));

export function tokenize(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}#@ ]+/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}

export function bookmarkHaystack(b) {
  return [b.title, b.text, b.author, b.authorHandle, b.mediaType, b.note, b.url, ...(b.tags || []), ...(b.autoTags || [])].join(' ').toLowerCase();
}

export function keywordScore(b, terms) {
  if (!terms.length) return 0;
  const hay = bookmarkHaystack(b);
  const title = (b.title || '').toLowerCase();
  let hits = 0;
  let score = 0;
  for (const t of terms) {
    if (!hay.includes(t)) continue;
    hits++;
    score += 1 + (title.includes(t) ? 0.5 : 0) + ((b.tags || []).includes(t) ? 0.5 : 0);
  }
  return hits === terms.length ? score / terms.length : (score / terms.length) * 0.4;
}

// Hybrid rank: keyword match plus semantic similarity when a query vector exists.
export function rank(bookmarks, query, queryVec) {
  const terms = tokenize(query);
  const scored = [];
  for (const b of bookmarks) {
    const k = keywordScore(b, terms);
    const s = queryVec && b.embedding ? cosine(queryVec, b.embedding) : 0;
    const score = k * 0.6 + Math.max(0, s - 0.15) * 2;
    if (k > 0 || s > 0.3) scored.push({ b, score });
  }
  return scored.sort((x, y) => y.score - x.score).map((x) => x.b);
}

export function embedText(b) {
  return [b.title, b.author && `by ${b.author}`, (b.text || '').slice(0, 1200)].filter(Boolean).join('\n');
}
