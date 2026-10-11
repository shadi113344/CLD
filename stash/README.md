# Stash

A private, local-first bookmark manager for Chrome. Built from scratch as a personal alternative to ContextBolt, with the privacy problems found in that extension's analysis fixed.

## What it does

| | |
|---|---|
| **Capture** | Any web page (toolbar click, `Alt+Shift+S`, or right-click for a page, link or selection) · X/Twitter bookmarks · Reddit saved posts and comments · LinkedIn saved posts · Instagram saved posts and collections (live, or from Instagram's data download) |
| **Organise** | Tags, collections, notes, and tag suggestions you can keep or dismiss |
| **Find** | Instant keyword search plus on-device meaning-based search and a "Related" list |
| **Ask** | "Ask your bookmarks" chat. With on-device AI only, it returns your most relevant saves. With an API key, it writes an answer with citations. |
| **Resurface** | Spaced review: each save comes back after 3 → 7 → 21 → 60 → 180 days. Shows a badge count and an optional daily notification. |
| **Export any view** | Every list (X, Reddit, LinkedIn, Instagram, Web, a collection, a tag, or search results) has an **Export** menu: Markdown, CSV, JSON, web page, browser-bookmarks file (imports into Chrome, Firefox, Safari, Raindrop…), PDF via the print dialog, or a plain list of URLs |
| **Backup** | JSON backup and restore, plus a Markdown zip (one `.md` per bookmark with YAML frontmatter) ready for an Obsidian vault. Both include the local Instagram thumbnails. |
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
- **Instagram:** see below.

## Instagram

**Live sync.** Open your profile → **Saved** (or press **Sync Instagram now** in Stash). When Instagram loads your Saved posts or collections, Stash goes through them the same way Instagram's own page does:

- Saved first, newest first, then each of your collections. One request every 2.5–4.5 seconds, with a progress card in the corner and a **Stop** button.
- The first sync goes to your oldest saved post. Later ones stop when they reach posts Stash already has, and run automatically at most once an hour.
- For each post Stash keeps the link (`/p/…` or `/reel/…`), caption, location, author's name and @username, post date, type (photo, video, reel or carousel), your saved order, and its likes, comments and views (Reels and videos) as Instagram showed them at that sync.
- **Collections are mirrored** as Stash collections. A post in two Instagram collections shows in both. If you rename a mirrored collection in Stash, your name is kept. If you delete one, it stays deleted. A full rescan also removes posts you took out of a collection on Instagram.
- **Collections need one visit first.** Since September 2026 Instagram loads a collection through a GraphQL request whose ID changes over time, so Stash learns it from Instagram's own page: open any one collection on Instagram once. Stash keeps only the request's name, ID and the shape of its variables, never your session tokens, which it reads from the page each time. Until it has seen one, a sync still saves all of Saved and the card says which collections are waiting, with a button that opens one; Stash then syncs them straight away. If Instagram changes the request again, the card asks for one more visit. (Accounts still on Instagram's old web app keep working through the old address.)
- **If Instagram pushes back** (asks to slow down, wants to confirm it's you, limits activity, or you're logged out), Stash stops at once and says why. It then won't sync automatically for 6 hours (24 hours after a checkpoint or block). **Sync anyway** on the card overrides that.
- If Instagram stops answering Stash's requests directly, Stash falls back to scrolling the Saved grid and saving what Instagram's page loads.

**Sort by how posts did.** The Instagram view (and any collection holding Instagram posts) can be sorted by **Most viewed**, **Most liked** or **Most commented**, alongside the date sorts. Cards show the counts, the details panel says when they were taken, and the next sync refreshes them. They come with the posts Stash already downloads, so they cost no extra requests. If a creator hides like counts, Stash doesn't show Instagram's placeholder number. CSV and JSON exports get `views`, `likes` and `comments` columns, and Obsidian notes get them in the frontmatter.

**Thumbnails.** Instagram's image links stop working after a few days, and its image servers won't show them on other sites. So Stash keeps a small copy of each post's image (320 px WebP, typically 10–30 KB) in this browser, and the library only ever shows those copies. Turn this off in Settings if you prefer links and captions only. Videos and reels are saved as links with their cover image; Stash never downloads videos.

**Import Instagram's own export (no automation at all).** In Instagram go to Accounts Center → **Your information and permissions** → **Download your information**, pick **Saved** (JSON is best; HTML works too), and download it. In Stash, press **Import Instagram export…** (Instagram view, Settings, or the palette) and choose the downloaded `.zip`. Several parts at once are fine, and so is just `saved_posts.json` / `saved_collections.json`. Stash reads only those two files from the zip, even if it's gigabytes of media. The export has links, usernames and the exact date you saved each post, plus your collections. It has no captions or images; a live sync fills those in for posts still in your Saved, without overwriting anything.

## X Following / Followers lists

Open `x.com/<handle>/following` or `/followers` and click **Save this list** on the card. Stash goes through the whole list (with progress) and adds it under **People on X** in the library: name, handle, bio, website, location, follower counts. With both of your lists saved you also get **Not following back** and **You don't follow back**. Every people list has the same Export menu (CSV, JSON, Markdown, web page, PDF, links). Saving a list again updates it and removes anyone no longer on it.

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
src/lib/                 db (IndexedDB), settings, ai (local + API), search (hybrid ranking), export (JSON/Markdown/zip),
                         thumbs (local image copies), instagram-import + unzip (Instagram's data download)
src/content/             x-main (MAIN world) + x-bridge, ig-main (MAIN world) + ig-bridge, reddit, linkedin, quicksave overlay, toast
src/ui/                  library.html (full page) / panel.html (side panel), shared JS + CSS
vendor/                  transformers.js 3.7.5 + ONNX Runtime Web (WASM), Apache-2.0
dev/                     fake Instagram + end-to-end tests (not used by the extension)
```

No build step. Edit the files, then click reload on `chrome://extensions`.

## Tests

`node dev/test-instagram.mjs` runs the Instagram end-to-end tests: a real Chromium with Stash loaded, pointed at a fake `www.instagram.com` (`dev/fake-instagram/server.mjs`) that mimics Instagram's Saved pages, `/api/v1` responses, the GraphQL collection request (checked for page tokens and the current `doc_id`, optionally prefixed with `for (;;);`), expiring image links and pushback. It needs Playwright with Chromium, and `python3` for building test zips.
