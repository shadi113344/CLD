# Sort Feed: reverse-engineering report

Sort Feed — Sort, Download & Transcribe (Chrome Web Store ID `lhiilgfanjkbombmnlfelondlfohfpfg`), version **17.0**, published 2026-10-10.

- **Package:** 1,540,623 bytes, sha256 `d40a5d34…7c15fbb27`. That matches the hash Google's update service published. Downloaded 2026-10-11.
- **Sources:** the extension's code, sortfeed.com (home, pricing, privacy, MCP page, docs) and the Chrome Web Store listing.
- **Method:** read only. Nothing was installed, run against a real account, or sent to Sort Feed's servers.
- **Tags:** **[code]** means confirmed in the extension's code. **[site]** means what the website or listing says. **[inferred]** means a conclusion about server-side behaviour that can't be checked from the client.

---

## Summary

- **The sort runs locally, on the platform's own data.** Clicking Sort saves the settings in `sessionStorage` and reloads the page. A script inside the page then reads Instagram's, TikTok's or Facebook's own feed responses, scrolls the page to load more, and redraws the grid in sorted order. YouTube is different: the extension calls YouTube's internal API itself. **[code]**
- **The outlier score is simple.** It is a post's views (Reels) or likes (Posts) divided by the median of the creator's 25 most recent unpinned posts that are at least 72 hours old. Fewer than 20 qualifying posts means no score. Badges appear at 2×, 5× and 10×. **[code]**
- **Downloads go straight from the platform's servers to your disk.** Instagram uses its own media-info endpoint. TikTok uses the in-player stream, which has no watermark. Bulk downloads are packed into a zip by code the developer wrote, not a library. **[code]**
- **Transcription happens on the server.** The extension sends the platform's media URL to `api.sortfeed.com`, and Whisper runs on Cloudflare. If that server can't fetch the file, the browser downloads it and uploads it. **[code + site]**
- **Pro's sort limits are enforced only in the browser.** The background worker reads a plan flag that the popup stores locally. Transcription, Google Sheets, Similar accounts and MCP are checked on the server. **[code]**
- **Sort Feed MCP lets their server run sorts in your browser.** Once linked, the extension keeps a WebSocket open to `mcp.sortfeed.com`. The server sends a job (a profile, a search, your saved posts or a collection). The extension runs it in a hidden Instagram tab using your session and sends the posts back. **[code]**
- **The privacy disclosures don't match the code.** The Web Store listing says the developer "will not collect or use your data". Their own privacy policy lists email, user ID, transcription jobs, a Google token and MCP results. Some data the code sends isn't in the policy at all (see "Claims checked against the code").

---

## 1. The product

| | |
|---|---|
| **Platforms** | Instagram (profile Posts and Reels, Explore search, Saved, collections, stories), TikTok (profile, search, Favorites, Liked, collections), Facebook (profile reels, your reels, saved reels), YouTube (Videos, Shorts) |
| **Sort by** | Views, likes, outlier score and oldest everywhere. Comments on Instagram, TikTok and Facebook. Shares on TikTok and Facebook. Saves on TikTok. |
| **Scope** | Latest N posts (25, 50, 100, 200, 1,000, a custom number, or all) or a date range |
| **Export** | CSV, JSON and Excel built in the browser. Google Sheets through their server. Copy to clipboard. |
| **Download** | Instagram, TikTok and Facebook, one post or the whole sorted grid as a zip. Not YouTube. |
| **Transcribe** | Instagram, TikTok and Facebook, one video or a selection. Pro gets 500 minutes a month. |
| **Other** | A player overlay with arrow-key navigation, Similar accounts (Instagram, Pro), and Sort Feed MCP (Claude and ChatGPT, Instagram only, Pro) |
| **Plans** | **Free:** latest 25 posts or the last week, every sort and export, unlimited downloads. **Pro:** $10 a month billed yearly or $15 month to month (the terms page said $9 and $14), unlimited sorting, transcription, MCP. Sold through Lemon Squeezy. |
| **Scale** | About 90,000 users, rated 3.4 from 298 reviews, Featured badge. Developer: Taher El Sheikh, San Francisco. Registered as an EU non-trader. |
| **Backend** | Cloudflare Workers plus D1 (API and database), Supabase (sign-in), Lemon Squeezy (billing), Whisper on Cloudflare Workers AI (transcription) **[site]** |

## 2. What's in the package

```
manifest.json            Manifest V3. Permissions: activeTab, tabs, declarativeNetRequest, webNavigation, storage, alarms
background.js            service worker: plan checks, transcription jobs, feedback, Similar accounts, tab helpers
background_agent.js      Sort Feed MCP: WebSocket client, job queue, rate limits, hidden-tab driver
popup.html + popup_scripts/   the popup (sort options, sign-in state, settings, legacy licence key)
Instagram/content.js     487 KB minified bundle: banners, rendering, export, download, transcription, player, reviews prompt
Instagram/script_instagram.js        MAIN world: request wrapper, sort engine, outlier score
Instagram/explore_sort_instagram.js  MAIN world: Explore search sorting
Instagram/saved_sort_instagram.js    MAIN world: Saved and collection sorting
Instagram/agent/agent_runner_instagram.js  MAIN world: MCP sorting without scrolling
Tiktok/  Facebook/  YouTube/   the same split: a minified content.js plus a page script injected with a <script> tag
lib/xlsx.full.min.js     SheetJS, for Excel export
rules.json               one declarativeNetRequest rule (see section 9)
```

- The MAIN-world scripts and the background worker aren't minified, and they carry detailed developer comments.
- The four `content.js` files are bundles (esbuild-style), not obfuscated.
- There is no remote code, no analytics SDK and no tracking pixel.

## 3. How a sort works

```
popup ──refresh: "ON" ──► background.js ── checks the plan flag in chrome.storage.local
                                 │ allowed
                                 ▼
content.js (isolated world): saves sortFeedSortBy / sortFeedNoItems / sortFeedStatus … in sessionStorage
                             then window.location.reload()
                                 │
                                 ▼  page reloads
script_*.js (MAIN world): wraps XHR / fetch before the platform's own code runs
   │  reads each feed response (GraphQL or REST JSON) the page itself requests
   │  turns each item into a record: date, code, views, likes, comments, caption, media URLs …
   │  finds the platform's own tile in the page and copies its outerHTML
   │  scrolls to the bottom to trigger the next page, until the requested number, the date boundary, or the end
   ▼
window.postMessage({ logo_animate_off, payload: sortedItems, sf_outlier }) ──► content.js redraws the grid in order
```

### Instagram **[code]**

- **Request wrapper:** `XMLHttpRequest.prototype.open` and `.send` are wrapped. Both `/graphql/query` and `/api/graphql` are watched, because Instagram is midway through moving between them.
- **Posts tab:** `data.xdt_api__v1__feed__user_timeline_graphql_connection`.
- **Reels tab:** `data.xdt_api__v1__clips__user__connection_v2`, or the newer `data.fetch__XDTUserDict.clips_connection`. Both are handled while Instagram rolls the change out.
- **Dates for Reels:** Reels responses have no `taken_at`, so the date is decoded from the media ID: `(BigInt(pk) >> 23n) + 1314220021721` gives milliseconds.
- **Views:** `play_count`, falling back to `view_count`.
- **Explore search and Saved:** handled by their own page scripts. The Saved feed is `/api/v1/feed/saved/posts/`.
- **Stories:** `/api/v1/feed/reels_media/` and `/reels_tray/` responses are cached so the story download button works.

### TikTok **[code]**

- **Request wrapper:** `window.fetch` is wrapped, watching `/api/post/item_list`. Fields read: `itemList`, `hasMore`, `stats`, `video.bitrateInfo[].PlayAddr.UrlList`, `music.playUrl`.
- **Stopping the endless spinner:** when a date sort finishes, the wrapper answers later `item_list` calls with a made-up `{"itemList":[],"hasMore":false}`, so TikTok's loading spinner stops.

### Facebook **[code]**

- **Request wrapper:** fetch and XHR are both wrapped to catch the profile-reels GraphQL stream. The stream arrives in pieces (`@defer`), and the pieces are merged back together.
- **First page:** the first batch is embedded in the page's HTML, so that is scanned too.
- **Scrolling:** the script scrolls every 1.8 s and stops after about 11 s with no new items.
- **Media:** fetched from `/video/video_data_async/`.

### YouTube **[code]**

- **No request wrapper.** The script reads `ytInitialData` and `ytcfg`.
- **Paging:** further pages come from `POST /youtubei/v1/browse` continuation calls.
- **Exact numbers:** one `POST /youtubei/v1/player` call per video gives exact views, likes and publish date. It runs 3 calls at a time with 150 to 400 ms between calls, capped at 1,000 calls.
- **Easy-to-miss detail:** the player call needs `signatureTimestamp`, or every video comes back as unavailable.

## 4. Outlier score **[code]**

`Instagram/script_instagram.js` around line 540. The same rules are copied into the TikTok, Facebook and YouTube scripts.

- **What it measures:** views on Reels, likes on Posts.
- **Baseline:** the median of the 25 most recent posts that are unpinned and at least 72 hours old. With fewer than 20 qualifying posts the result is "insufficient", and the sort falls back to raw views or likes.
- **Score:** each post's value divided by that median.
- **Badges:** 1, 2 or 3 bolts at 2×, 5× and 10×. Nothing below 2× gets a badge.
- **Loading more for the baseline:** if the posts already loaded don't fill the baseline, the script keeps loading pages without drawing them. It gives up after 40 pages, 90 seconds, or 4 scrolls that load nothing.
- **History:** comments say a server-side cache of each creator's median was removed on 2026-08-27, so the score is always computed fresh. The cache service still runs for TikTok, Facebook and YouTube.
- **Only on profiles:** search results, Saved and collections mix creators, so they get no score.

## 5. Downloads **[code]**

- **Instagram:** `GET https://www.instagram.com/api/v1/media/{pk}/info/`, sent with your cookies and the header `x-ig-app-id: 936619743392459`. The file comes from `video_versions[0].url` or the best image candidate.
- **TikTok:** prefers `bitrateInfo[].PlayAddr`, the in-player stream, which has no watermark, over `downloadAddr`, which does. Requests go out with `referrer: https://www.tiktok.com/`.
- **Facebook:** the video URL comes from `video_data_async`.
- **Saving files:** single files are saved by creating a blob link and clicking it. Carousels and bulk downloads are packed into a zip by code the developer wrote: an uncompressed zip with a CRC-32 table, built in `content.js`. There's no `downloads` permission and no JSZip.
- **Nothing passes through Sort Feed's servers.** This matches what the site says.

## 6. Transcription **[code]**

- **Choosing the audio (Instagram):** `clips_metadata.original_sound_info.progressive_download_url` first, then the audio track in `video_dash_manifest`, then `video_versions[0]`.
- **Choosing the audio (TikTok):** the separate audio track (`music.playUrl`), which is why TikTok is the fastest.
- **The request:** `POST api.sortfeed.com/trans/v5/instagram/` (also `v4/tiktok/` and `v2/facebook/`). Body: `{ ReelType, ReelURL | ReelBase64, reelIdUi, platform, profileName, userID, clientJobId }`.
- **When their server can't reach the file:** the browser downloads it and sends it as base64.
- **Quota:** enforced on the server. Failed and cancelled jobs are refunded through `POST …/refund`, using an ID the browser generates.
- **Timeouts:** jobs are cut off after 150 s. A ping every 20 s keeps the background worker from being shut down mid-job.
- **Output:** Whisper segments (`start`, `end`, `text`) come back, which is what "Copy with timestamps" uses.

## 7. Exports **[code]**

- **CSV, JSON and Excel** are built entirely in the browser; Excel uses SheetJS. Columns depend on the platform, for example Profile, Post/Reel URL, Create Date, Views, Likes, Comments, Caption, Outlier Score, Transcript.
- **Google Sheets** goes through the server:
  1. `POST api.sortfeed.com/check-google-sheets-token { userID }`.
  2. If there's no token, it opens `connect.sortfeed.com/google-sheets?userID=…` for Google consent.
  3. Then `POST api.sortfeed.com/export/{ig/v5|tiktok/v3|facebook/v3|youtube/v2}/create-google-sheet-* { userID, name, sorted_data, … }`, and the sheet URL that comes back is opened.
  4. Their server keeps the Google token.

## 8. Accounts and Pro

- **Sign-in happens on the website.** `account.sortfeed.com` (Supabase) hands the extension `SF_SET_USER_ID { userID, name, email }`. This works because of `externally_connectable` for `*.sortfeed.com`. **[code]**
- **Plan check:** each time the popup opens, it sends `POST api.sortfeed.com/get-user-state-based-on-userid/ { userID }`, which returns `free`, `pro` or `legacy`. The answer is stored as `sort_feed_state_type_flag`. **[code]**
- **Sort limits are only checked in the browser:** `background.js` around line 973 (`isUserSortFeedPro`) and the content script both read that local flag. Server-side features (transcription, Sheets, Similar, MCP) check the plan with `userID`. **[code]**
- **The user ID is the only credential.** Every call to `api.sortfeed.com` carries just `{ userID }`, with no token or cookie. The Sheets connect link also puts it in the URL. Whether the server checks anything more can't be seen from here. **[code / inferred]**
- **The old licence-key path is still shipped, but broken.** It posts to `sortfeedtest.taher-el-sheikh.workers.dev`, then needs the Chrome profile email through `chrome.identity`. That permission was removed, so it can only fail with "Unable to fetch your Chrome email". `handleUserIDChecks` and `createUserIdInstallOrUpdate` are other leftovers from when it used `identity.email`. **[code]**

## 9. Sort Feed MCP (agent mode) **[code]**

1. Claude or ChatGPT calls `https://mcp.sortfeed.com/mcp`. The server relays the job over a WebSocket (`wss://mcp.sortfeed.com/ext`, protocol `sortfeed.v1`) to the extension.
2. **Linking:** `account.sortfeed.com` gives the extension a token, `SF_SET_AGENT_TOKEN`. The token must look like `sfx_<64 hex characters>`, and the sender's origin is checked again in the worker. Once it has a token, the extension reconnects on every browser start, with backoff from 5 s up to 5 min plus random jitter. Unpacked developer builds connect to `mcp-staging.sortfeed.com` instead.
3. **Job types:** a profile (`username`, Reels or Posts), a search (`query`), your saved posts, one collection (matched by name or ID), or a list of your collections. Jobs carry parameters only, never code.
4. **How a job runs:** the worker opens or reuses one background tab that never gets focus, and navigates it to the right Instagram page. `agent_runner_instagram.js` then **sends Instagram's next-page GraphQL request itself**, using the page's own `csrftoken`, `fb_dtsg` and `lsd` tokens. The comment says there's "no scrolling, no drawing".
   - **Pacing:** gaps of 0.7 to 1.5 s with random variation, and a 2.5 to 4 s pause about one page in eight.
   - **Stopping:** it stops on the first 429 status, security challenge or login page.
5. **Built-in limits:**
   - The server sets the hourly and daily caps. The browser accepts at most 400 page requests an hour, 2,000 a day, and 1,000 posts per job.
   - After a 429 or a security check it pauses for at least 30 minutes; the default is 2 hours.
   - It refuses to run if nobody has switched tabs or focused the window in the last 60 minutes. This "presence" check is server-tunable.
6. **What goes back:** progress messages and the sorted posts (links, numbers, captions, thumbnails). Every switch of tab or window focus sends a `presence` message, at most one a minute.
7. **What the privacy policy adds [site]:** the results of your last 50 sorts are kept on the server, and public sorts are cached for an hour **and reused for other accounts**.

## 10. Every server it talks to

| Endpoint | When | What's sent |
|---|---|---|
| `api.sortfeed.com/get-user-state-based-on-userid/` | every popup open, every sign-in | userID |
| `api.sortfeed.com/trans/v5/instagram/`, `v4/tiktok/`, `v2/facebook/` (+ `refund`) | Transcribe | media URL or base64 audio, post ID, creator handle, userID, job ID |
| `api.sortfeed.com/sortfeed-check-user-quota-trans-v2/` | Transcribe (for the banner's subtitle) | userID |
| `api.sortfeed.com/check-google-sheets-token`, `/export/*/create-google-sheet-*` | Google Sheets export | userID, the rows being exported |
| `connect.sortfeed.com/google-sheets?userID=` | first Sheets export | userID in the URL |
| `api.sortfeed.com/ig-similar-accounts/v1/` | Similar button | userID, the target profile's ID and username |
| `api.sortfeed.com/reviews/v1/feedback` | "Not great" in the review prompt | feedback text, platform, page type, plan, version, userID, a random per-install ID |
| `mcp.sortfeed.com/access` | popup open | nothing (GET) |
| `wss://mcp.sortfeed.com/ext`, `/ext/check` | MCP, once linked | hello (version, browser), presence, progress, results |
| `sortfeedtest.taher-el-sheikh.workers.dev` | legacy licence key | the licence key |
| `api.sortfeed.com/sortfeed-check-if-email-found`, `-create-new-record-install-update`, `-change-statetype-existing-userid` | old account code, no longer called in practice | email, userID, licence key |

There are no calls to analytics, advertising or any other third party. Everything else goes to Instagram, TikTok, Facebook, YouTube or their media servers.

## 11. What it stores in your browser

- **`chrome.storage.local`:**
  - `sort_feed_user_id`, `sort_feed_user_profile` (name and email), `sort_feed_state_type_flag`, `sortFeedUser`
  - the MCP keys: `sortfeed_agent`, `sortfeed_agent_token`, `sortfeed_agent_token_host`, `sortfeed_agent_claude`, `sortfeed_agent_status`, `sortfeed_agent_usage`, `sortfeed_agent_cool`, `sortfeed_agent_tab`
  - review-prompt state: `sortfeed_reviews` (install time, a random install ID, sort count, cool-downs) and `sortfeed_reviews_off`
  - per-platform settings
- **`sessionStorage`** on each platform: the sort's state (`sortFeedSortBy`, `sortFeedNoItems`, `sortFeedStatus`, `sortFeedData`, …).
- **`localStorage`** on instagram.com: `sfAgentTemplates`, which holds Instagram's GraphQL request IDs that the MCP runner learns as you browse.
- **IndexedDB `SortFeedDB`:** only a legacy `userSortFeed = "Pro"` flag.

## 12. Claims checked against the code

| Claim | Verdict |
|---|---|
| "Sort Feed only reads what the page you are already signed into has loaded" (FAQ) | **True for the sort you start by clicking.** Not for MCP, which sends Instagram's requests itself in a hidden tab. Also not for YouTube, where every sort makes direct `browse` and `player` API calls. Instagram downloads and transcriptions also call `api/v1/media/{id}/info/` directly. |
| MCP "scrolls like a person… Nothing is scraped" (MCP page) | **Doesn't match the code.** The runner sends GraphQL requests directly with no scrolling, and randomises the gaps so the traffic looks human ("human-shaped pacing"). Results can be cached and served to other Sort Feed accounts. |
| "Does anything leave my computer? Two things… transcription and Google Sheets" (FAQ) | **Incomplete.** Plan checks (userID) happen on every popup open. Similar accounts sends the profile you're researching. Review feedback sends text plus userID and an install ID. MCP sends presence and results. The privacy policy does cover MCP, but not Similar accounts or feedback. |
| Web Store: "The developer has disclosed that it will not collect or use your data" | **Contradicted by their own privacy policy,** which lists email, user ID, transcription job records, a Google token, MCP results and monthly usage. |
| declarativeNetRequest "adds one header to TikTok's own post requests so the extension can recognise them" (privacy policy) | **Half true.** The rule sets a *response* header (`x-tiktok-api-call: intercepted`) on `item_list`, but no code reads it. It's left over from an older version and does nothing. |
| "Downloads go straight from the platform to your device" | **True.** |
| "Outlier scores are worked out in the browser" | **True** (the server cache was removed for Instagram). |
| "Sort Feed does not request the identity permission" | **True for the manifest.** The code still calls `chrome.identity` on the old licence-key path, which now always fails. |

### Review prompt

- After a set number of sorts, the page asks "How are you liking Sort Feed?".
- "Love it" sends you to the Chrome Web Store review page.
- "Not great" opens a private feedback box that posts to their server.
- This "review gating" steers unhappy users away from public reviews. **[code]**

## 13. Risk notes, most important first

1. **MCP gives their server remote control of your Instagram session, within limits.** A linked browser keeps a socket open and runs whatever read-only Instagram job the server sends, including your saved posts and collections. It does this with your login in a background tab. The browser-side caps (400 requests an hour, 2,000 a day) and the presence check limit how much it can do. You are still trusting `mcp.sortfeed.com`: if that server were compromised, it could read your saved items and send them out. The feature is opt-in (Pro, linked through the account site).
2. **The user ID is effectively a password that never changes.** Every API call is authenticated by `userID` alone, and the Sheets connect link puts it in a URL. If it leaked, someone could probably use your transcription quota, or write spreadsheets with your stored Google token. **[inferred]**
3. **Instagram account risk.** The MCP runner sends Instagram's private GraphQL requests on a schedule and makes its traffic look human. That may break Instagram's terms more clearly than reading a page you have open. It does stop at the first sign of pushback.
4. **The privacy disclosures don't match** (see section 12). This matters most to people who rely on the Web Store's privacy label.
5. **Leftover code:** the identity calls, a licence check against a "test" worker, the TikTok header rule that does nothing, old account code, and a TikTok page script (`Tiktok/download_function.js`) that is injected but missing from the package. None of it is dangerous now, but it's surface area.

**What it does well:**

- No analytics, no code loaded from the internet, and local exports.
- Downloads never pass through their servers.
- The MCP linking token is origin-checked and format-checked.
- Clear limits and an automatic pause after Instagram pushes back.
- Transcription charges are refunded when a job fails.

## 14. Useful for Stash

The Instagram saved-posts sync that `stash/HANDOFF.md` plans next is built here already. MCP's saved-posts job:

- learns the page's own `/api/v1/feed/saved/posts/` request (method, address and headers) on load
- treats its response as page 1
- asks again with `max_id` for each following page, with a 0.7 to 1.5 s gap
- stops on 429, a security check, or a login page

Other details worth reusing:

- the media-ID-to-date decode (`pk >> 23 + 1314220021721`)
- the Reels response key moving to `fetch__XDTUserDict.clips_connection`, and matching both `/graphql/query` and `/api/graphql`
- the "fake an empty last page" trick to stop TikTok's endless spinner
- `/api/v1/media/{pk}/info/` with `x-ig-app-id: 936619743392459` for media links
- the median-of-25 outlier score, if Stash ever ranks saved posts by performance

## How to reproduce

```sh
curl -L -o sortfeed.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3Dlhiilgfanjkbombmnlfelondlfohfpfg%26uc"
# CRX3: "Cr24", version (u32), header length (u32), header, then a zip
python3 -c "import struct;b=open('sortfeed.crx','rb').read();h=struct.unpack('<I',b[8:12])[0];open('sortfeed.zip','wb').write(b[12+h:])"
unzip sortfeed.zip -d sortfeed && npx prettier@3.3.3 --parser babel sortfeed/Instagram/content.js > ig_content.pretty.js
```

The extension's own source isn't committed here; it's the developer's copyrighted code.
