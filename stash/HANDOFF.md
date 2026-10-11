# Stash: handoff notes (milestone v1.6.0)

Give this file to a new chat to continue. The code lives in the GitHub repo `shadi113344/CLD`, under the `stash/` folder, on branch `claude/zealous-shannon-vzvr8m`. The repo root is an ideas space: never build there. The full history from v1.0 is preserved.

## Where things stand

Stash is a local-first Chrome bookmark manager (Manifest V3, plain JavaScript, no build step), built as a private alternative to ContextBolt.

| Area | Status |
|---|---|
| Web page save (click, `Alt+Shift+S`, right-click menu, quick-save card) | Done |
| X bookmarks: starts automatically on the bookmarks page, pages through X's own request, scrolls as a fallback | Done; confirmed against fakes, needs confirming on real X |
| X Following / Followers lists, "not following back" views | Done (fake-tested) |
| Reddit saved posts and comments (JSON API, auto-sync every 6 hours) | Done |
| LinkedIn saved posts (read from the page) | Done (selectors may need updating) |
| **Instagram saved posts: live sync, collections mirrored, local thumbnails, import of Instagram's export** | **Done in v1.6.0; passes all 61 end-to-end checks against a fake Instagram; needs confirming on real Instagram** |
| Library, side panel, command palette, keyboard shortcuts, collections, tags, notes | Done |
| On-device AI (MiniLM through transformers.js in an offscreen document); optional API key for Anthropic or OpenAI-compatible providers | Done (the model download couldn't be tested here because Hugging Face is blocked) |
| Ask-your-bookmarks chat, resurfacing on a schedule | Done |
| Export: JSON backup and restore, Obsidian zip, per-view export to MD, CSV, JSON, HTML, browser bookmarks, PDF, TXT | Done; backup and Obsidian zip now include thumbnails |

## Instagram (v1.6.0): decisions and how it works

The user's choices: **both** live sync and export import; **thumbnails plus links and captions**; **mirror Instagram collections as Stash collections automatically**.

- `src/content/ig-main.js` runs in Instagram's page world. It sees the app's own requests (`/api/v1/feed/saved/…`, `/api/v1/feed/collection/<id>/…`, `/api/v1/collections/list/`, and GraphQL responses with a "saved" field), parses posts, and remembers the app's request headers. On request it makes one `/api/v1` GET with those headers and classifies the reply. The pushback cases are 429, rate-limit messages, checkpoint/challenge, feedback_required/spam, login_required/401, 403, and an HTML page instead of JSON.
- `src/content/ig-bridge.js` is the controller. It starts when Instagram loads Saved or collections data, never from the URL alone (the URL is only a backup trigger). It then does three steps:
  1. Collections list, then mirror the collections.
  2. Saved, newest first, at 2.5–4.5 s per request.
  3. Each collection. This step is skipped in a full sync if posts carry `saved_collection_ids`.

  A "new" sync stops at the first page with nothing new. Automatic syncs run at most hourly. After pushback it stops immediately and sets `igCooldownUntil`: 6 h for rate limits, 24 h after a checkpoint or block, and nothing after a logout. The card offers **Sync anyway**. If direct requests fail but the tab is on Saved, it scrolls the grid instead.
- `src/lib/thumbs.js` and the `scheduleThumbs` loop in the background fetch each post's 320 px image (the service worker has host permission for `*.cdninstagram.com` and `*.fbcdn.net`), shrink it to WebP, and store it in a **separate IndexedDB `stash-media`**. That way the `stash` database never needed an upgrade. The library shows Instagram images only from these local copies: Instagram's links expire, and its CDN refuses other sites.
- **Collections:** a Stash collection gets `igId`/`igName`. Posts carry `igCollections: [igId]`, so one post can sit in several collections. `db.inCollection()` and `collectionsOf()` combine that with the user's own `collectionId`. Export-only collections use `igId: "name:<name>"` and are upgraded to the real id on the next live sync. User renames are kept, and deleted mirrored collections are remembered in kv `igIgnoredCollections`.
- **Import:** `src/lib/instagram-import.js` and `src/lib/unzip.js` handle the import. The reader takes the whole export `.zip` and reads only `saved_posts` / `saved_collections` (JSON or HTML) via `DecompressionStream`, including ZIP64. It handles the old `string_map_data` layout, the newer `label_values` layout, and Meta's garbled-UTF-8 text. Imported items are `fillOnly`: they never overwrite what a live sync found. They do supply the exact "saved on" time (`savedAtExact`).
- Saved order: live sync gives each post `savedAt = page-load time − position in Saved`, so "Newest saved" matches Instagram.

## Key files

- `src/content/x-main.js`, `x-bridge.js`, `x-people.js`: X capture (see the code comments).
- `src/content/ig-main.js`, `ig-bridge.js`: Instagram capture.
- `src/content/toast.js`: progress card. Built in an open shadow root without innerHTML, and re-attaches itself if the page removes it.
- `src/lib/db.js`: IndexedDB. `stash` (v1: bookmarks, collections, kv), `stash-people` (v1), `stash-media` (v1: thumbs). Each separate database avoided upgrading `stash`.
- `src/lib/export.js`: every export format; backups carry thumbnails as base64.
- `src/ui/library.*`: library page and side panel (`panel.html` is a copy of `library.html`).
- `dev/fake-instagram/server.mjs` and `dev/test-instagram.mjs`: the fake Instagram and the end-to-end tests (`node dev/test-instagram.mjs`).

## Lessons learned

- The sandbox can't reach x.com, instagram.com or huggingface.co, so features are built against faithful fakes of each site's API and tested with Playwright. For Instagram the fake runs over HTTPS, and Chromium reaches it as the real hostnames through `--host-resolver-rules` and `--ignore-certificate-errors`. That way the content scripts, the cookies, and the service worker's CDN fetches all behave as on the real site.
- Start syncs from the **network request** the site makes, never from URL or page-layout checks.
- Every step logs `[Stash]` / `[Stash ig]` lines to the console (info level), so a real-world failure can be diagnosed from the user's logs.

## What to confirm on the real Instagram

1. Open Saved → All posts. The card should appear within seconds, and the console should show `[Stash ig] Instagram loaded N saved posts (saved)`. If instead you see only `auto-sync triggered: Saved page URL` and `direct paging failed`, Instagram's web app has moved Saved to GraphQL or new endpoints. The `[Stash ig]` lines show what it requested.
2. Check that thumbnails appear in Stash a minute after the sync (Instagram view).
3. Import your real export zip and check the counts in the toast.

## Ideas not started

- People lists for Instagram (followers/following), like X.
- Re-fetching captions for export-only posts without a live sync. That would mean one request per post, which is risky on Instagram, so it was deliberately left out.
