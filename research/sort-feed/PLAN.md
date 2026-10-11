# Plan: what Stash takes from the Sort Feed analysis

Stash v1.6.0 already syncs Instagram saved posts (branch `claude/zealous-shannon-vzvr8m`). This plan compares that code with Sort Feed 17.0, which was published on 2026-10-10 and has been running against the real Instagram. It lists what to change in Stash, in order. The findings themselves are in [`REPORT.md`](REPORT.md).

**The first item matters most.** Sort Feed's own notes say Instagram retired the REST endpoint that Stash uses to page each collection. If that's right, collection sync in v1.6.0 will fail on the real site, even though all 61 checks pass against the fake.

---

## 1. Fix: Instagram collections moved to GraphQL (do first)

### What Sort Feed found

From `Instagram/saved_sort_instagram.js` and `Instagram/agent/agent_runner_instagram.js` in Sort Feed:

- **Still REST:** Saved › All posts is `GET /api/v1/feed/saved/posts/` with `max_id` paging, the same as Stash uses. No change needed.
- **Retired:** a collection used to be `GET /api/v1/feed/collection/<id>/posts/`. Their note, dated 2026-09-28, says the REST path "is never requested any more".
- **What a collection page uses now:** `POST /api/graphql` (sometimes `/graphql/query`), sent as a form body:
  - `fb_api_req_friendly_name`: `PolarisSavedCollectionPageWWWQuery`
  - `doc_id`: changes over time, so it has to be learnt from the page's own request
  - `variables`: `{"collection_id": "<id>", "first": 12, "after": <cursor or null>}`
  - the body also carries the page tokens `fb_dtsg`, `lsd`, `jazoest`, `av` and `__spin_*`
  - headers: `x-csrftoken`, `x-fb-lsd`, `x-ig-app-id: 936619743392459`, `x-asbd-id`, `x-fb-friendly-name`, `x-root-field-name`
- **The answer** is at `data.fetch__MediaCollection.media.edges[].node`, sometimes wrapped as `node.media`, with `page_info.has_next_page` and `page_info.end_cursor`. The media objects have the same shape as the saved feed's `items[].media`.
- **A text prefix:** some GraphQL responses start with `for (;;);`, and Sort Feed strips it before parsing.
- **Collections list:** Sort Feed doesn't rely on `/api/v1/collections/list/`. It collects every `{collection_id, collection_name}` object from any response on the Saved page.

### How that breaks Stash v1.6.0

| Where | Problem |
|---|---|
| `src/content/ig-bridge.js` `collectionFeed()` | Pages each collection through the retired REST path. |
| `src/content/ig-main.js` `verdict()` | If Instagram answers a retired path with an HTML page, this treats it as **logged out** and stops the whole sync with the wrong message. That's unconfirmed, but possible. |
| `src/content/ig-main.js` `savedPart()` | Only recognises GraphQL fields whose names contain "saved". `fetch__MediaCollection` doesn't, so passive capture of a collection page sees nothing. |
| `src/content/ig-main.js` fetch hook | `res.clone().json()` throws on a `for (;;);` prefix, so that response is silently dropped. |
| `dev/fake-instagram/server.mjs` | Still serves the REST collection path, which is why the tests pass. |

Stash's mitigation already in place: a **full** sync skips step 3 when Saved posts carry `saved_collection_ids`. Whether real Instagram includes that field is unknown, and a **new**-only sync always runs step 3.

### Changes

1. **`ig-main.js`: recognise the new response.**
   - Add `collectionPart(json)`, which returns `data.fetch__MediaCollection.media` when present.
   - In `parse()` for `graphql`, check it before `savedPart()`. Turn the edges into items with `findMedia()`, add `igCollectionsAdd: [collectionId]`, and page with `page_info`.
   - The collection id comes from the page address `/<user>/saved/<slug>/<id>/`, or from the request's `variables.collection_id`.
   - Strip a leading `for (;;);` before parsing any GraphQL text: read `text()` then `JSON.parse`, rather than `.json()`.
2. **`ig-main.js`: learn the request.**
   - For a GraphQL POST whose answer has `fetch__MediaCollection`, keep `doc_id`, `fb_api_req_friendly_name`, the variables, and which variable holds the id and which holds the cursor.
   - Keep these in the page's `sessionStorage`, or hand them to the bridge for `chrome.storage.local`. Never keep the tokens.
   - That means also wrapping `XMLHttpRequest.send` / the fetch body, so the form body can be read; today only headers are recorded.
3. **`ig-main.js`: a second request type, `ig-graphql`.**
   - Rebuild the form body from the learnt template, swapping in `collection_id` and `after`.
   - Read `fb_dtsg`, `lsd` and `csrftoken` fresh from the page every time (`"DTSGInitialData"`, `"LSD"`, and the cookie), and compute `jazoest` from `fb_dtsg`.
   - Run the answer through the same `verdict()`. Add one GraphQL case: an `errors[]` array with a rate-limit or login message.
4. **`ig-bridge.js`: three ways to page a collection, in order.**
   1. GraphQL with a learnt template.
   2. REST (kept for accounts still on the old web app).
   3. If neither works, say so on the card: "Open one collection on Instagram once, then sync again". That's the same "teach me once" step Sort Feed uses.
   - Treat a 404 or an HTML answer **on the collection step only** as "this path is gone". It should not mean "logged out", and it should not stop the Saved sync that already worked.
5. **Collections list:** keep `/api/v1/collections/list/`. Also gather `{collection_id, collection_name}` from any response, the way Sort Feed does, so the list still fills if that endpoint moves.
6. **`dev/fake-instagram/server.mjs`: model the new behaviour.**
   - Make collections GraphQL-only by default: a `PolarisSavedCollectionPageWWWQuery` handler, the `fetch__MediaCollection` answer shape, an optional `for (;;);` prefix, and a 404 HTML page on the old REST path.
   - Keep a `scenario.restCollections` switch for the old behaviour.
7. **`dev/test-instagram.mjs`: new checks.**
   - Collections sync over GraphQL after the template is learnt.
   - The card's "open a collection once" message when it isn't learnt.
   - A 404 on the old path doesn't stop Saved and doesn't say "logged out".
   - The prefix is handled.
   - Membership still lands in the right Stash collections.

**Done when:** all existing checks pass, plus the new ones, against both fake scenarios (GraphQL collections, old REST collections). The console log shows which path each collection used, so a real-world failure can still be diagnosed from the user's logs.

## 2. Harden the other Instagram paths (small)

- **Match both GraphQL addresses:** `/graphql/query` and `/api/graphql`. Instagram is mid-move, and Sort Feed handles both. Stash's `classifyUrl` regex `/^\/(api\/)?graphql/` already does; keep it that way.
- **Exact post dates for Reels:** when a post has no `taken_at`, decode it from the media ID: `ms = (BigInt(pk) >> 23n) + 1314220021721n`. Sort Feed checked this to the second. Use it for `postedAt` only. `savedAt` stays Instagram's saved order.
- **Keep Stash's slower pace.** Stash pages at 2.5 to 4.5 s per request, against Sort Feed's 0.7 to 1.5 s. Sort Feed stops at the first 429, and so does Stash. There's no reason to speed up.

## 3. New: sort saved Instagram posts by how they performed (medium)

This is Sort Feed's core idea, applied to your own saves and done entirely locally.

- **Capture the numbers:** the saved feed already includes `like_count`, `comment_count` and `play_count` (views on Reels). Store them on the item as `metrics: { likes, comments, views, at }` during sync, with no extra requests.
- **Library:** add Sort options to the Instagram view: Most viewed, Most liked, Most commented, alongside Newest saved. Show the counts on the card.
- **Export:** add views, likes and comments columns to the per-view CSV and JSON exports.
- **No outlier score here.** It needs one creator's own history, and Saved mixes creators; Sort Feed doesn't score Saved either. An optional "×N vs this creator's other saves" only makes sense when you've saved several posts from one creator. Leave it out.
- **Freshness:** the numbers are as of the last sync, so the card says "as of <date>". Refreshing them is just the next sync.

## 4. New: on-device transcripts for saved Reels (larger, optional)

Sort Feed sends audio to its server. Stash can do this privately, because it already runs transformers.js in an offscreen document.

- **Audio source,** in Sort Feed's order: `clips_metadata.original_sound_info.progressive_download_url`, then the audio track in `video_dash_manifest`, then `video_versions[0].url`.
- **Where to get it:** these fields are in `GET /api/v1/media/<pk>/info/` (header `x-ig-app-id`), and sometimes already in the saved feed.
- **One request per Reel, so only when you ask,** for one post or a selection, never automatically. That's the same caution the v1.6.0 handoff applied to captions.
- **Model:** Whisper (`Xenova/whisper-tiny.en` or `whisper-base`, roughly 40 to 75 MB), downloaded once from Hugging Face like MiniLM. It runs in `offscreen.js`. Audio is decoded with `OfflineAudioContext` to 16 kHz mono.
- **Storage:** the transcript goes into the item's `text`, so search, Related, Ask and the Obsidian export all use it. Timestamps are kept for "Copy with timestamps".
- **Permissions:** the service worker already has access to `*.cdninstagram.com` and `*.fbcdn.net` for thumbnails, so this needs no new permission.

## 5. Later, if wanted

- **Download the media of a saved post** (video, photo, carousel as a zip), only when you ask. Sort Feed's media-info request plus a small uncompressed-zip writer is enough; there's no need for JSZip, since Stash already has `unzip.js`.
- **Instagram people lists** (already in "Ideas not started"). Sort Feed's reliability notes apply: learn the request from the page, stop on the first pushback.

## What Stash should not copy

- **No server in the loop.** Sort Feed's MCP lets its server run Instagram reads in your browser, and caches results for other accounts. Stash's "Ask" stays local or uses your own API key.
- **No user ID as a password.** If Stash ever has an account, use a real token.
- **No review gating,** and an honest privacy label. Stash's README already describes exactly what leaves the browser.
- **No traffic made to look human.** Stash requests the same pages the app does, at a slower pace, and stops when asked.

## Open decisions for you

1. Go ahead with item 1 now? (Recommended. It's a likely break on the real site.)
2. Item 3 (sort by views, likes, comments): yes or no?
3. Item 4 (on-device transcripts): worth a 40 to 75 MB model download on first use?
