# Stash: handoff notes (milestone v1.5.0)

Give this file and the zip to a new chat to continue.

## Where things stand

Stash is a local-first Chrome bookmark manager (Manifest V3, plain JavaScript, no build step), built as a private alternative to ContextBolt.

| Area | Status |
|---|---|
| Web page save (click, `Alt+Shift+S`, right-click menu, quick-save card) | Done |
| X bookmarks: starts automatically on the bookmarks page, pages through X's own request, scrolls as a fallback | Done; confirmed against fakes, needs confirming on real X |
| X Following / Followers lists, "not following back" views | Done (fake-tested) |
| Reddit saved posts and comments (JSON API, auto-sync every 6 hours) | Done |
| LinkedIn saved posts (read from the page) | Done (selectors may need updating) |
| Library, side panel, command palette, keyboard shortcuts, collections, tags, notes | Done |
| On-device AI (MiniLM through transformers.js in an offscreen document); optional API key for Anthropic or OpenAI-compatible providers | Done (the model download couldn't be tested here because Hugging Face is blocked) |
| Ask-your-bookmarks chat, resurfacing on a schedule | Done |
| Export: JSON backup and restore, Obsidian zip, per-view export to MD, CSV, JSON, HTML, browser bookmarks, PDF, TXT | Done |

## Key files

- `src/content/x-main.js`: runs inside X's page. Captures bookmark and people requests, remembers X's own request ("template"), and pages through with the bottom cursor.
- `src/content/x-bridge.js`: bookmark sync controller. Triggered by the timeline request, not the URL.
- `src/content/x-people.js`: Following / Followers controller.
- `src/content/toast.js`: progress card. Built in an open shadow root without innerHTML, and re-attaches itself if the page removes it.
- `src/lib/db.js`: IndexedDB. `stash` (version 1) holds bookmarks, collections and kv; `stash-people` (version 1) is a separate database, so adding it never required upgrading the bookmarks database.
- `src/lib/export.js`: every export format.
- `src/ui/library.*`: library page and side panel (`panel.html` is a copy of `library.html`).

## Lessons learned

- The sandbox can't reach x.com, instagram.com or huggingface.co, so features are built against faithful fakes of each site's API and tested with Playwright.
- Start syncs from the **network request** the site makes, never from URL or page-layout checks. That mistake cost several rounds on X.
- Every step logs `[Stash]` lines to the console (info level), so a real-world failure can be diagnosed from the user's logs.

## Next: Instagram saved posts (not started)

Plan:
- **Live sync:** capture Instagram's request for the Saved feed (`/api/v1/feed/saved/posts/`, paginated with `next_max_id` / `more_available`) and page through it slowly, a couple of seconds per page, stopping if Instagram pushes back. Save link (`/p/` or `/reel/`), caption, @username, date, media type and thumbnail.
- **Collections:** Instagram's Saved collections could map to Stash collections.
- **Fallback:** import `saved_posts.json` from Instagram's *Download your information* export.

Open decisions for the user:
1. Live sync, import the official export, or both? (Recommended: both.)
2. Thumbnails: store small local copies (Instagram's image links expire), or links and captions only?
3. Mirror Instagram collections as Stash collections automatically?
