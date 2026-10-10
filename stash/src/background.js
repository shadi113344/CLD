import * as db from './lib/db.js';
import { getSettings, apiConfigured } from './lib/settings.js';
import { embed, localTags, apiTags, apiAnswer, testApi } from './lib/ai.js';
import { rank, embedText } from './lib/search.js';

// Spaced resurfacing: days until a bookmark comes back after each "keep".
const REVIEW_STEPS = [3, 7, 21, 60, 180];
const DAY = 86400000;

// ---------- setup ----------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-page', title: 'Save page to Stash', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'save-link', title: 'Save link to Stash', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'save-selection', title: 'Save selection to Stash', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'open-library', title: 'Open Stash library', contexts: ['action'] });
  });
  chrome.alarms.create('enrich', { periodInMinutes: 5 });
  chrome.alarms.create('resurface', { periodInMinutes: 60 });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
  scheduleEnrich();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'enrich') scheduleEnrich();
  if (a.name === 'resurface') resurfaceTick();
});

// ---------- entry points ----------

chrome.action.onClicked.addListener((tab) => quickSave(tab));

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'quick-save') quickSave(tab);
  if (cmd === 'open-panel') chrome.sidePanel.open({ windowId: tab.windowId });
  if (cmd === 'open-library') openLibrary();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-page') quickSave(tab);
  if (info.menuItemId === 'open-library') openLibrary();
  if (info.menuItemId === 'save-link') {
    await saveItem({ id: db.webId(info.linkUrl), source: 'web', url: info.linkUrl, title: info.linkText || info.linkUrl });
    flashBadge('✓');
  }
  if (info.menuItemId === 'save-selection') {
    const id = db.webId(tab.url) + '#sel-' + Date.now().toString(36);
    await saveItem({ id, source: 'web', url: tab.url, title: tab.title, text: info.selectionText });
    flashBadge('✓');
  }
});

function openLibrary(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/library.html') + hash });
}

// ---------- saving ----------

function extractPage() {
  const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || '';
  const main = document.querySelector('article') || document.querySelector('main') || document.body;
  const sel = String(getSelection() || '').trim();
  return {
    title: meta('og:title') || document.title,
    description: meta('og:description') || meta('description'),
    image: meta('og:image'),
    author: meta('author') || meta('article:author'),
    text: (sel || main?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 20000),
  };
}

async function captureTab(tab) {
  let page = {};
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    page = r?.result || {};
  } catch {
    // chrome:// pages, the Web Store, PDFs: fall back to what the tab tells us.
  }
  return {
    id: db.webId(tab.url),
    source: 'web',
    url: tab.url,
    title: page.title || tab.title || tab.url,
    text: [page.description, page.text].filter(Boolean).join('\n\n'),
    author: page.author || '',
    image: page.image || '',
  };
}

async function saveItem(item) {
  await db.upsertMany([item]);
  const b = await db.getBookmark(item.id);
  if (!b.reviewDue && !b.reviewStep && (await getSettings()).resurface) {
    await db.patchBookmark(b.id, { reviewDue: b.savedAt + REVIEW_STEPS[0] * DAY });
  }
  scheduleEnrich();
  return b;
}

async function quickSave(tab) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return openLibrary();
  const b = await saveItem(await captureTab(tab));
  flashBadge('✓');
  try {
    const collections = await db.allCollections();
    const allTags = await tagVocabulary();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (data) => (window.__stashQuickSave = data),
      args: [{ id: b.id, title: b.title, tags: b.tags, collectionId: b.collectionId, note: b.note, collections, allTags }],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/quicksave.js'] });
  } catch {
    // Page doesn't allow injection; the badge tick is the confirmation.
  }
}

async function tagVocabulary() {
  const all = await db.allBookmarks();
  const counts = new Map();
  for (const b of all) for (const t of b.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// ---------- enrichment (embeddings + auto-tags) ----------

let enriching = null;
function scheduleEnrich() {
  enriching ??= enrichLoop().finally(() => (enriching = null));
  return enriching;
}

async function enrichLoop() {
  const s = await getSettings();
  if (!s.localAi && !(s.autoTag && s.taggingEngine === 'api' && apiConfigured(s))) return;
  const vocab = await tagVocabulary();
  const label = s.localAi ? 'Indexing with on-device AI' : 'Tagging';
  let done = 0;
  let total = (await db.pendingEnrichment(100000)).length;
  for (;;) {
    const batch = await db.pendingEnrichment(16);
    if (!batch.length) return;
    total = Math.max(total, done + batch.length);
    broadcast({ type: 'progress', done, total, label });
    let vecs = [];
    if (s.localAi) {
      try {
        vecs = await embed(batch.map(embedText));
      } catch (e) {
        console.warn('Stash: local model unavailable', e);
        return; // retry on next alarm (e.g. offline during first model download)
      }
    }
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      const patch = { enriched: 1 };
      if (vecs[i]) patch.embedding = vecs[i];
      if (s.autoTag) {
        try {
          if (s.taggingEngine === 'api' && apiConfigured(s)) patch.autoTags = await apiTags(s, b, vocab);
          else if (vecs[i]) patch.autoTags = await localTags(vecs[i], vocab);
          patch.autoTags = (patch.autoTags || []).filter((t) => !(b.tags || []).includes(t));
        } catch (e) {
          console.warn('Stash: tagging failed', e);
        }
      }
      await db.patchBookmark(b.id, patch);
      done++;
    }
    broadcast({ type: 'progress', done, total, label });
    broadcast({ type: 'changed' });
  }
}

// ---------- resurfacing ----------

async function refreshBadge() {
  const s = await getSettings();
  const due = s.resurface ? (await db.dueForReview()).length : 0;
  chrome.action.setBadgeBackgroundColor({ color: s.accent || '#6d5efc' });
  chrome.action.setBadgeText({ text: due ? String(Math.min(due, s.reviewPerDay)) : '' });
}

function flashBadge(text) {
  chrome.action.setBadgeText({ text });
  setTimeout(refreshBadge, 1500);
}

async function resurfaceTick() {
  await refreshBadge();
  const s = await getSettings();
  if (!s.resurface || !s.resurfaceNotify) return;
  const today = new Date().toDateString();
  if ((await db.kvGet('lastNotified')) === today) return;
  const due = await db.dueForReview();
  if (!due.length || new Date().getHours() < 9) return;
  await db.kvSet('lastNotified', today);
  const n = Math.min(due.length, s.reviewPerDay);
  chrome.notifications.create('resurface', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${s.displayName}: ${n} bookmark${n > 1 ? 's' : ''} to revisit`,
    message: due[0].title || due[0].url,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'resurface') openLibrary('#review');
});

async function reviewAction(id, action) {
  const b = await db.getBookmark(id);
  if (!b) return;
  if (action === 'keep') {
    const step = Math.min(b.reviewStep + 1, REVIEW_STEPS.length - 1);
    await db.patchBookmark(id, { reviewStep: step, reviewDue: Date.now() + REVIEW_STEPS[step] * DAY });
  } else if (action === 'snooze') {
    await db.patchBookmark(id, { reviewDue: Date.now() + DAY });
  } else if (action === 'done') {
    await db.patchBookmark(id, { reviewDue: 0, reviewStep: REVIEW_STEPS.length });
  } else if (action === 'requeue') {
    await db.patchBookmark(id, { reviewDue: Date.now(), reviewStep: 0 });
  }
  refreshBadge();
}

// ---------- reddit ----------

async function redditSync() {
  let tab = (await chrome.tabs.query({ url: ['https://www.reddit.com/*', 'https://old.reddit.com/*'] }))[0];
  let opened = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://www.reddit.com/', active: false });
    opened = true;
    await new Promise((resolve) => {
      const l = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(l);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(l);
    });
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'reddit-sync', full: true });
  } finally {
    if (opened) chrome.tabs.remove(tab.id);
  }
}

// ---------- messaging ----------

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const handlers = {
  async ingest({ items }, sender) {
    const s = await getSettings();
    const allowed = { x: s.captureX, reddit: s.captureReddit, linkedin: s.captureLinkedIn };
    items = items.filter((i) => allowed[i.source] !== false);
    if (!items.length) return { added: 0 };
    const added = await db.upsertMany(items);
    if (s.resurface) {
      for (const id of added) {
        const b = await db.getBookmark(id);
        await db.patchBookmark(id, { reviewDue: b.savedAt + REVIEW_STEPS[0] * DAY });
      }
    }
    if (added.length) broadcast({ type: 'changed' });
    scheduleEnrich();
    return { added: added.length, total: items.length };
  },
  async ingestPeople({ owner, relation, people }) {
    const added = await db.upsertPeople(owner, relation, people);
    broadcast({ type: 'changed' });
    return { added };
  },
  async peopleFinalize({ owner, relation, keepIds }) {
    const removed = await db.finalizePeopleList(owner, relation, keepIds);
    broadcast({ type: 'changed' });
    return { removed };
  },
  async openLibrary({ hash }) {
    openLibrary(hash || '');
  },
  async quickSaveApply({ id, tags, collectionId, note }) {
    await db.patchBookmark(id, { tags, collectionId, note });
    broadcast({ type: 'changed' });
  },
  async saveCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('This page can’t be saved.');
    const b = await saveItem(await captureTab(tab));
    broadcast({ type: 'changed' });
    return b.id;
  },
  async embed({ texts }) {
    return (await embed(texts)).map((v) => Array.from(v));
  },
  async chat({ question, history }) {
    const s = await getSettings();
    const all = await db.allBookmarks();
    let qv = null;
    if (s.localAi) {
      try {
        [qv] = await embed([question]);
      } catch {}
    }
    const sources = rank(all, question, qv).slice(0, 8);
    if (!apiConfigured(s)) return { answer: null, sourceIds: sources.map((b) => b.id) };
    const answer = await apiAnswer(s, question, sources, history);
    return { answer, sourceIds: sources.map((b) => b.id) };
  },
  async retag({ ids }) {
    for (const id of ids) await db.patchBookmark(id, { enriched: 0 });
    scheduleEnrich();
  },
  async reenrichAll() {
    for (const b of await db.allBookmarks()) await db.patchBookmark(b.id, { enriched: 0 });
    await db.kvSet('labelVecs', {});
    scheduleEnrich();
  },
  async enrichNow() {
    await scheduleEnrich();
  },
  async review({ id, action }) {
    await reviewAction(id, action);
    broadcast({ type: 'changed' });
  },
  async refreshBadge() {
    await refreshBadge();
  },
  async redditSync() {
    return redditSync();
  },
  async testApi() {
    return testApi(await getSettings());
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return;
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve(h(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
