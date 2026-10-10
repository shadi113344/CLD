# Stash

A private, local-first bookmark manager for Chrome. Built from scratch as a personal alternative to ContextBolt, with the privacy problems found in that extension's analysis fixed.

## What it does

| | |
|---|---|
| **Capture** | Any web page (toolbar click, `Alt+Shift+S`, or right-click for a page, link or selection) · X/Twitter bookmarks · Reddit saved posts and comments · LinkedIn saved posts |
| **Organise** | Tags, collections, notes, and tag suggestions you can keep or dismiss |
| **Find** | Instant keyword search plus on-device meaning-based search and a "Related" list |
| **Ask** | "Ask your bookmarks" chat. With on-device AI only, it returns your most relevant saves. With an API key, it writes an answer with citations. |
| **Resurface** | Spaced review: each save comes back after 3 → 7 → 21 → 60 → 180 days. Shows a badge count and an optional daily notification. |
| **Export any view** | Every list (X, Reddit, LinkedIn, Web, a collection, a tag, or search results) has an **Export** menu: Markdown, CSV, JSON, web page, browser-bookmarks file (imports into Chrome, Firefox, Safari, Raindrop…), PDF via the print dialog, or a plain list of URLs |
| **Backup** | JSON backup and restore, plus a Markdown zip (one `.md` per bookmark with YAML frontmatter) ready for an Obsidian vault |
| **Look** | Your own name, accent color and theme (system, light or dark). Works as a full-page library and in Chrome's side panel. |

## Privacy model

- **Everything is stored in IndexedDB in your browser profile.** There's no account and no server.
- **On-device AI** uses `all-MiniLM-L6-v2` through transformers.js, running in an offscreen document. The ~23 MB model is downloaded once from huggingface.co. Bookmark text never leaves the browser.
- **The API model is optional and off by default.** Bookmark text goes to the provider you choose only when you ask a question in chat, or when you set tag suggestions to use the API. Host permission for that endpoint is requested only when you configure it.
- **No telemetry**, no analytics and no remote code. Every script, including the ONNX WebAssembly runtime, ships inside the extension.

Compared with the original extension: it doesn't send bookmarks to a vendor server every 5 minutes, has no fake "encrypted" sync, and doesn't upload embeddings.

## Install

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
3. Pin the Stash icon. Change the shortcuts at `chrome://extensions/shortcuts` if you want.

## How each source syncs

- **X:** open <https://x.com/i/bookmarks> (or click **Open X bookmarks to sync** in Stash) and leave the tab in front. Stash scrolls the page automatically, and a progress card in the bottom-right shows how many bookmarks it has saved. The first sync goes all the way to your oldest bookmark; after that it stops once it reaches bookmarks it already has. **Full rescan** on the card walks everything again. Auto-scrolling can be turned off in Settings. Stash only reads the data X's own page loads; it makes no extra requests and changes nothing.
- **Reddit:** syncs quietly when you visit reddit.com (at most every 6 hours), or use **Sync Reddit now**, which shows a progress card. It uses your logged-in session through Reddit's JSON endpoints.
- **LinkedIn:** open **My items → Saved posts** and scroll. LinkedIn has no API for this, so posts are read from the page. If LinkedIn changes its markup, this is the part most likely to need a fix (`src/content/linkedin.js`).

## Keyboard

| Where | Keys |
|---|---|
| Anywhere | `Alt+Shift+S` save page · `Alt+Shift+K` side panel · `Alt+Shift+L` library |
| Quick-save card | type tags, `Enter`/`,` to add, `Tab` to accept a suggestion, `Ctrl+Enter` to save, `Esc` to close |
| Library | `/` search · `Ctrl/⌘+K` palette · `J`/`K` move · `O` open · `Space` details · `T` tag · `C` move to collection · `X` delete |
| Resurface | `O` open · `K` keep · `S` tomorrow · `D` done · `X` delete |

## API models

In Settings → API model:
- **Anthropic:** paste an API key. The default model is `claude-opus-5-5`. For cheaper bulk tagging, use `claude-haiku-5-5`.
- **OpenAI-compatible:** set a base URL and model, for example `https://api.openai.com/v1`, OpenRouter, or `http://localhost:11434/v1` for Ollama, where no key is needed.

## Layout

```
manifest.json
src/background.js        service worker: saving, enrichment queue, resurfacing, Reddit sync, messaging
src/offscreen.*          on-device embedding model host
src/lib/                 db (IndexedDB), settings, ai (local + API), search (hybrid ranking), export (JSON/Markdown/zip)
src/content/             x-main (MAIN world) + x-bridge, reddit, linkedin, quicksave overlay, toast
src/ui/                  library.html (full page) / panel.html (side panel), shared JS + CSS
vendor/                  transformers.js 3.7.5 + ONNX Runtime Web (WASM), Apache-2.0
```

No build step. Edit the files, then click reload on `chrome://extensions`.
