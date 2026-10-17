// User settings, kept in chrome.storage.local (never synced anywhere).

export const DEFAULTS = {
  displayName: 'Stash',
  accent: '#6d5efc',
  theme: 'system', // system | light | dark

  // Capture
  captureX: true,
  xAutoSync: true, // auto-scroll x.com/i/bookmarks to load older bookmarks
  captureReddit: true,
  captureLinkedIn: true,
  redditAutoSync: true,
  captureInstagram: true,
  igAutoSync: true, // sync when Instagram loads your Saved posts (at most hourly)
  igThumbs: true, // keep small local copies of Instagram images (their links expire)
  igUnsavePerDay: 500, // most posts Stash unsaves on Instagram in 24 hours

  // AI
  localAi: true, // on-device embeddings for search, grouping and auto-tags
  autoTag: true,
  taggingEngine: 'local', // local | api
  apiProvider: 'anthropic', // anthropic | openai
  apiBaseUrl: 'https://api.openai.com/v1', // only for OpenAI-compatible
  apiModel: 'claude-opus-5-5',
  apiKey: '',

  // Resurface
  resurface: true,
  resurfaceNotify: true,
  reviewPerDay: 5,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function apiConfigured(s) {
  if (!s.apiModel) return false;
  // Local OpenAI-compatible servers (Ollama, LM Studio) don't need a key.
  return s.apiProvider === 'anthropic' ? Boolean(s.apiKey) : Boolean(s.apiBaseUrl);
}
