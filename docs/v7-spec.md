# Session 7 — grounding by name, video posters, link video, scroll

Frozen contract. Every number was measured against the live DB or by running the
real binaries. Do not re-derive.

**The user will wipe `~/SuperTwinV8` and re-sync from scratch**, so migrations
may be destructive where that is genuinely cleaner. They still must not corrupt
a database that is not wiped.

## 1. Remove albums entirely

Chosen: full removal, **including the columns**.

Delete the Go heuristic (`album.go` and its call sites), the worker backfill
(`db/albums.ts`), the `album` re-scan type, the UI grouping, and the client
types. Add a migration that rebuilds `events` without `album_id` /
`album_count`. Leave the earlier migrations untouched — they are already applied
in the wild; the rebuild is what removes the columns.

Photos become ordinary messages again.

## 2. Collapsed description boxes

`AI DESCRIPTION`, `FROM THE LINKED PAGE` and `MACHINE TRANSCRIPT` currently
render fully expanded and dominate the thread — one description ran ten lines.

Clamp to **2 lines** with a **Show more** control that expands in place.
Collapsed height must be fixed and reserved, because this list has a scroll
bug caused partly by content changing height after paint (§5).

## 3. Videos must look like videos

**Not a rendering bug.** `PosterMedia` (`src/tabs/InboxTab.tsx:1012`) already
draws poster + play badge and is correct. The data is missing.

Measured, all 18 videos:

| thumb | desc status | frames | renders as |
|---|---|---|---|
| 5 have | done | yes | frame strip ✓ |
| 3 have | pending | no | poster ✓ |
| **10 have none** | **unsupported** | no | **file chip ✗** |

The reported row `3A17B6D20C20A970AD3F` (32.4 MB, 2:42) has `media_thumb_path`
NULL and no `.thumb.jpg` on disk. A thumbnail is only ever written from the
protobuf's `JPEGThumbnail` (`events.go:2878`), and history-synced videos often
carry none. **Nothing ever generates a poster from the downloaded mp4**, though
ffmpeg is bundled and already sampling frames.

Worse: `mediaDescStatusFor` (`worker/src/db/ingest.ts:1543`) stamps
`video → thumb ? "pending" : "unsupported"`, so a video without a
WhatsApp-supplied thumbnail is **permanently locked out** of every visual path.

Fix:
- Generate a poster with ffmpeg for `kind='video' AND media_path IS NOT NULL AND
  media_thumb_path IS NULL`.
- Stop stamping such videos `unsupported` — the file is on disk and readable.
- Render poster + play badge + **duration overlay**. `mediaSeconds` is already
  client-side (`whatsapp-routes.ts:239`), already formatted by `formatDuration`.
  Keep the existing `still` guard that suppresses duration on thumbnail-only
  fallback rows.
- Decide whether a poster should outrank the frame strip in-thread; the strip
  currently reads as a photo album rather than a video.

## 4. Link video: frames and transcripts

Verified by running the bundled binaries:

- **Instagram needs no cookies.** A public reel downloaded in 0.3s / 2.5 MB, and
  ffmpeg produced both a frame and 16 kHz mono audio. My earlier claim that
  Instagram required cookies was **wrong**.
- **YouTube auto-captions are available** via yt-dlp with no download at all.
- **yt-dlp does not extract frames.** It fetches captions and video files;
  frames come from ffmpeg.

Chosen: download at a **capped resolution** for both YouTube and Instagram,
sample frames, transcribe, then **delete the video file**.

Transcript source, in order: **creator-uploaded captions** when they exist (a
person wrote them, they beat any ASR) → otherwise **local whisper**, which is
stronger on Hindi and Hinglish than YouTube's auto-captions and is free once the
file is already downloaded. Auto-captions are a last resort, not a first choice.

Settings: max resolution, frame interval, frame cap — mirroring the existing
video-frame controls rather than inventing a second set. Behind the existing
link-scrape switch; still off by default, because it is an outbound request to
a URL someone else chose.

Constraints: bound total download size and time; delete the video even on
failure; never keep a partial file that looks complete.

## 5. Scroll jank

Ranked, all measured:

1. **The quiet refresh throws away pagination.** `refreshLive`
   (`InboxTab.tsx:401`) calls `loadMessages` which fetches the **newest 60** and
   does `setMessages(rows)` wholesale (`:288`). It runs every 15s and on every
   SSE nudge. Page back through 180 messages and ≤15s later the list snaps to
   60 — the DOM shrinks, `scrollTop` keeps its value against a shorter document,
   and `hasMore` resets so the next wheel twitch re-fetches the same page. This
   is the reported loop.
2. **Stale stick-to-bottom.** `nearBottom` is sampled before the fetch
   (`:406-410`) and applied after (`:467-469`), so starting to scroll up during
   an in-flight request yanks the view to the bottom mid-gesture.
3. **Double compensation.** There is no `overflow-anchor` anywhere in `src/`, so
   Chromium scroll anchoring is active *and* the layout effect adds the prepend
   delta manually (`:459-465`). Anchoring is only suppressed at `scrollTop === 0`
   but `loadOlder` fires anywhere in 0..80px, so it double-compensates
   intermittently — about one page too far.
4. **Anchor captured too early** (`:327`, at request time) and **no space
   reserved for images**: `.inbox__media-img` has no `aspect-ratio` and the
   `<img>` has no intrinsic dimensions, so height goes 0 → 300px after decode,
   per image, across a whole prepended page. Album tiles and frames *do* reserve.
5. **`loadOlder` reads state through a `setMessages` updater** (`:317-320`) as a
   getter. React only runs that synchronously on the eager-state fast path, so
   with an update queued `oldest` is undefined and paging silently no-ops.

Fix all five. Merge refreshes into the current window instead of replacing it.

## 6. Grounding — all seven levers

Reproduced exactly. "how is pranjali's health" returned her diet and ragi dosa
and never mentioned the cold, meds or doctors; "how is pranjali's cold" found
them immediately.

**Root cause: retrieval has no concept of "who".** `events_fts` indexes seven
columns and **channel name and actor name are not among them**. `pranjali`
appears in exactly **one indexed row in the whole database** (an unrelated
selfie's media description). So the question degrades to a bare topic search for
`health` — **3 documents corpus-wide**.

Compounding: the Pranjali chat is **231 events / 8,992 chars**, and whole-chat
inclusion caps at **120 events / 4,000 chars** — it is the *only* human chat in
the database on the window side of that switch. A ±8-*message* window spans
about **5 minutes** there; the doctors cluster sits **46 messages / 27 minutes**
from the hit, and "exhaustion and cold" **141 messages** away.

The two queries that worked did so because their chats (55/3005 and 16/1085)
were injected **whole**. This is a hard mode switch, not luck.

Levers, all seven:

1. **Resolve names to channels.** A name in the query should *select the chat*,
   not compete as a bm25 token. Index `channel_name` / `actor_display_name`, or
   resolve against `channels.name` / `actors.display_name` and pass a channel
   boost into `searchEventsRanked`.
2. **Density-aware window.** `DEFAULT_WINDOW = 8` was tuned on a sparse chat.
   OR it with a time span; ±45 min would have swept the entire doctors cluster.
3. **Per-section budget.** `fit()` compares `distanceToHit` *across* sections, so
   a YouTube line at distance 3 beats a Pranjali line at distance 8. **53% of the
   health query's context went to YouTube shorts and a marketing broadcast.**
4. **Do not seed on scraped-page-only hits.** Several seeds were YouTube pages
   matching at lexical 0.02–0.15, kept alive purely by recency weight.
5. **Measure whole-chat cost as rendered, not retrievable.** 8,992 retrievable
   chars render to 32,666 — a 3.6× understatement, largely 51-char event ids.
   Shorten the id; that is ~7,900 chars of pure overhead in one section.
6. **Enable semantic and backfill.** `event_embeddings` is empty and the flag is
   unset, so `SEMANTIC_WEIGHT = 0.8` is dead. cold ↔ health is its canonical case.
7. **Raise `DEFAULT_CONTEXT_CHARS`** — but only after 3 and 4, or the headroom
   goes to noise.

## 7. Bundle the embedding model

Chosen: **bundle** `multilingual-e5-small` int8 (129 MB) rather than download on
first run, consistent with whisper. `.dmg` ~636 → ~765 MB. Semantic search then
works offline with nothing to fetch. Keep the on-demand path for the other
models; keep the tier's own switch.
