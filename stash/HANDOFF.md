# Stash: handoff notes (milestone v1.7.0)

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
| Instagram saved posts: live sync, collections mirrored, local thumbnails, import of Instagram's export | Done in v1.6.0 |
| **Instagram collections over GraphQL (learnt from the page), sort by views / likes / comments, exact Reel dates** | **Done in v1.7.0; all end-to-end checks pass against a fake Instagram that now behaves like the September 2026 one; needs confirming on real Instagram** |
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

## Instagram (v1.7.0): what changed, from the Sort Feed plan

Items 1–3 of `research/sort-feed/PLAN.md` are done.

- **Collections moved to GraphQL.** Instagram retired `/api/v1/feed/collection/<id>/posts/` in September 2026. A collection page now sends `POST /api/graphql` (or `/graphql/query`) with `fb_api_req_friendly_name=PolarisSavedCollectionPageWWWQuery`, a `doc_id` that changes over time, and `variables {collection_id, first, after}`. The answer is `data.fetch__MediaCollection.media.edges[].node` (sometimes `node.media`), paged by `page_info`.
  - `ig-main.js` now also wraps `XMLHttpRequest.send` and reads fetch bodies, so it sees the form body. When an answer has `fetch__MediaCollection`, it posts `ig-template` with `{path, docId, friendly, rootField, variables, idPath, cursorPath}`. Tokens are never in it. It also saves that page's posts into the collection (passive capture, as for Saved).
  - Answers are read as text and a leading `for (;;);` is stripped; the old `.json()` call silently dropped those.
  - The bridge keeps the template in `chrome.storage.local.igCollectionQuery`. To page a collection it sends `ig-gql`; `ig-main.js` rebuilds the form body from the app's latest GraphQL request on this page load (same fields and headers), or, if there wasn't one, from the tokens in the page HTML (`DTSGInitialData`, `LSD`, `IG_USER_EIMU`, `__spin_*`), with `csrftoken` from the cookie and `jazoest` computed from `fb_dtsg`.
  - Order per collection: GraphQL with the learnt template, then the old REST address, then nothing. A 404 or an HTML page **on the collection step** means "gone", never "logged out", and the Saved results stand. A GraphQL `errors[]` / `errorSummary` answer marks the template `stale`, so the card asks for a fresh visit.
  - When collections can't be synced, the card says so with an **Open <collection>** button, and `igCollectionsPending` is set. When the next page load teaches the request, a sync starts at once, skipping the hourly limit.
  - `igCollectionsDone` records collections paged to the end at least once. A collection's first pass always goes to the end, even in a "new" sync; before, a "new" sync stopped after page 1 whenever the page had already captured that page itself. A full sync that skips step 3 (posts carry `saved_collection_ids`) marks every collection done.
  - If `/api/v1/collections/list/` fails, step 3 uses the mirrored collections Stash already knows (`igKnownCollections` in the background). `{collection_id, collection_name}` objects in any response are mirrored as they're seen, as Sort Feed does.
  - The console shows which path each collection used: `collection Travel: complete (via GraphQL)`.
- **Counts.** Each post gets `metrics: {likes, comments, views, likesHidden?, at}` from the data the sync already downloads (`like_count`, `comment_count`, `play_count`/`view_count`). Likes are `null` when `like_and_view_counts_disabled`, because Instagram then sends a placeholder. `upsertMany` replaces metrics on each sync (never from an import). The library offers **Most viewed / Most liked / Most commented** only when the list has those counts; cards show them, the details panel shows "as of". CSV gets `views,likes,comments` columns when any row has counts; JSON rows get `views, likes, comments, countsAsOf`; Obsidian frontmatter gets them too. Sort Feed says real Saved REST answers carry no comment counts and collections do, so "Most commented" may only appear for collection posts.
- **Dates.** A post without `taken_at` (Reels in GraphQL answers) gets `postedAt = (BigInt(pk) >> 23n) + 1314220021721` ms.

## Key files

- `src/content/x-main.js`, `x-bridge.js`, `x-people.js`: X capture (see the code comments).
- `src/content/ig-main.js`, `ig-bridge.js`: Instagram capture.
- `src/content/toast.js`: progress card. Built in an open shadow root without innerHTML, and re-attaches itself if the page removes it.
- `src/lib/db.js`: IndexedDB. `stash` (v1: bookmarks, collections, kv), `stash-people` (v1), `stash-media` (v1: thumbs). Each separate database avoided upgrading `stash`.
- `src/lib/export.js`: every export format; backups carry thumbnails as base64.
- `src/ui/library.*`: library page and side panel (`panel.html` is a copy of `library.html`).
- `dev/fake-instagram/server.mjs` and `dev/test-instagram.mjs`: the fake Instagram and the end-to-end tests (`node dev/test-instagram.mjs`, or `ONLY=D` for one profile). By default the fake behaves like the September 2026 Instagram: collections only over GraphQL, the old address a 404 page, GraphQL calls checked for `fb_dtsg`/`lsd`/`jazoest`/CSRF and the current `doc_id`. Switches: `restCollections` (old web app), `restCollectionsList`, `collectionDocId`, `collectionVia` (xhr/fetch), `gqlPrefix`, `gqlWrap`, `gqlTakenAt`. Profiles: A (fresh live sync, counts, learning), B (import first, old web app), C (GraphQL-only Saved, scrolling), D (new Instagram end to end: learn, 429, doc_id rotation, list address gone).

## Lessons learned

- The sandbox can't reach x.com, instagram.com or huggingface.co, so features are built against faithful fakes of each site's API and tested with Playwright. For Instagram the fake runs over HTTPS, and Chromium reaches it as the real hostnames through `--host-resolver-rules` and `--ignore-certificate-errors`. That way the content scripts, the cookies, and the service worker's CDN fetches all behave as on the real site.
- Start syncs from the **network request** the site makes, never from URL or page-layout checks.
- Every step logs `[Stash]` / `[Stash ig]` lines to the console (info level), so a real-world failure can be diagnosed from the user's logs.

## What to confirm on the real Instagram

1. Open Saved → All posts. The card should appear within seconds, and the console should show `[Stash ig] Instagram loaded N saved posts (saved)`. If instead you see only `auto-sync triggered: Saved page URL` and `direct paging failed`, Instagram's web app has moved Saved to GraphQL or new endpoints. The `[Stash ig]` lines show what it requested.
2. Check that thumbnails appear in Stash a minute after the sync (Instagram view).
3. Import your real export zip and check the counts in the toast.
4. Open one collection. The console should show `[Stash ig] learnt Instagram’s collection request (PolarisSavedCollectionPageWWWQuery, id at collection_id, cursor at after)`. If it says `couldn’t learn its request (no form body)`, the body capture missed how the app sends it. If nothing appears, look at what the collection page requests; the root field or query name may have changed again.
5. Run **Sync Instagram now**. Each collection should log `(via GraphQL)`. If the card asks to open a collection again straight after learning, the replayed request was refused: the `POST /api/graphql … →` line shows Instagram's answer.
6. Sort the Instagram view by **Most viewed**: Reels should come first with plausible numbers. If Saved posts show no comment counts, that matches Sort Feed's notes.

## Next: the rest of the Sort Feed plan

`research/sort-feed/` at the repo root has a reverse-engineering report on Sort Feed 17.0 (`REPORT.md`) and a plan for Stash (`PLAN.md`). Items 1–3 are done (see above). Still open:

- **Item 4: on-device transcripts of saved Reels** with Whisper (about 40–75 MB downloaded on first use, one media-info request per Reel, only when asked). Waiting on the user's go-ahead.
- **Item 5, later:** downloading a saved post's media on request; Instagram people lists.

## Ideas not started

- People lists for Instagram (followers/following), like X.
- From the Sort Feed plan: on-device transcripts of saved Reels with Whisper (item 4).
- Re-fetching captions for export-only posts without a live sync. That would mean one request per post, which is risky on Instagram, so it was deliberately left out.
