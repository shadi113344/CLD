// AI features. Two engines:
//  - local: on-device embeddings (offscreen document) for search, related
//    items and zero-shot auto-tags. Free and private.
//  - api:   optional bring-your-own-key model (Anthropic, or any
//    OpenAI-compatible endpoint such as OpenAI, OpenRouter, Ollama) for
//    better tags and for the "ask your bookmarks" chat.

import { cosine, embedText } from './search.js';
import { kvGet, kvSet } from './db.js';

// ---------- local embeddings ----------

let creating;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url, reasons: ['WORKERS'], justification: 'Run the on-device embedding model for bookmark search and tagging.' })
    .finally(() => (creating = null));
  await creating;
}

export async function embed(texts) {
  if (!texts.length) return [];
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'embed', texts });
  if (!res?.ok) throw new Error(res?.error || 'Embedding failed');
  return res.vectors.map((v) => new Float32Array(v));
}

// Starter vocabulary for zero-shot tagging; the user's own tags are added on top.
const SEED_TAGS = [
  'ai', 'programming', 'web development', 'design', 'startups', 'marketing', 'productivity', 'finance', 'investing',
  'health', 'fitness', 'science', 'politics', 'news', 'career', 'tutorial', 'tools', 'research', 'writing', 'crypto',
  'gaming', 'music', 'movies', 'books', 'education', 'security', 'data', 'devops', 'open source', 'hardware', 'space',
  'climate', 'food', 'travel', 'sports', 'psychology', 'philosophy', 'history', 'humor', 'jobs', 'leadership', 'economics',
];

async function labelVectors(labels) {
  const cache = (await kvGet('labelVecs')) || {};
  const missing = labels.filter((l) => !cache[l]);
  if (missing.length) {
    const vecs = await embed(missing.map((l) => `This is about ${l}.`));
    missing.forEach((l, i) => (cache[l] = vecs[i]));
    await kvSet('labelVecs', cache);
  }
  return labels.map((l) => [l, cache[l]]);
}

export async function localTags(embedding, userTags) {
  const labels = [...new Set([...userTags, ...SEED_TAGS])];
  const scored = (await labelVectors(labels))
    .map(([l, v]) => [l, cosine(embedding, v) + (userTags.includes(l) ? 0.03 : 0)])
    .sort((a, b) => b[1] - a[1]);
  const best = scored[0]?.[1] ?? 0;
  return scored.filter(([, s]) => s > 0.27 && s > best - 0.08).slice(0, 3).map(([l]) => l);
}

// ---------- remote model (bring your own key) ----------

async function callModel(s, system, user, maxTokens) {
  if (s.apiProvider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: s.apiModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low' },
        // If a safety classifier declines, the API retries on a suitable model.
        fallbacks: 'default',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error ${res.status}`);
    if (data.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  const base = s.apiBaseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      model: s.apiModel,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `API error ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

export async function apiTags(s, b, userTags) {
  const system =
    'You label saved bookmarks with short topical tags. Reply with only a JSON array of 1-4 lowercase tags, ' +
    'each one to three words. Reuse a tag from the existing list whenever it fits.';
  const user = `Existing tags: ${JSON.stringify(userTags.slice(0, 150))}\n\nBookmark:\n${embedText(b)}`;
  const out = await callModel(s, system, user, 2000);
  const m = out.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter((t) => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

export async function apiAnswer(s, question, sources, history = []) {
  const system =
    "You answer questions using only the user's saved bookmarks provided below. Cite sources inline as [1], [2] " +
    'matching their numbers. If the bookmarks do not contain the answer, say so plainly and mention the closest ' +
    'matches. Keep answers concise.';
  const ctx = sources
    .map((b, i) => `[${i + 1}] ${b.title || '(untitled)'}${b.author ? ` — ${b.author}` : ''}\n${b.url}\n${(b.text || '').slice(0, 1500)}${b.note ? `\nMy note: ${b.note}` : ''}`)
    .join('\n\n');
  const convo = history.slice(-6).map((h) => `${h.role === 'user' ? 'Me' : 'You'}: ${h.text}`).join('\n');
  const user = `Bookmarks:\n\n${ctx}\n\n${convo ? `Conversation so far:\n${convo}\n\n` : ''}Question: ${question}`;
  return callModel(s, system, user, 8000);
}

export async function testApi(s) {
  return callModel(s, 'Reply with the single word: ok', 'ping', 1000);
}
