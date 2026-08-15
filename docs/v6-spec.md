# Session 6 — grounding, albums, reactions, links, parallelism

Frozen contract. Every claim was verified against the live DB and by fetching
real pages. Do not re-derive; do not rename a field.

## 1. Grounded chat — the big one

Reproduced exactly. "Do i have anything planned on sunday" retrieved
`sunday lunch chalna hai kahin?` and `Can do. Place?` and **structurally
excluded their answer**, so the model reported an open question as unresolved
while a confirmed booking sat 8 messages later in the same chat.

Measured causes:

- **Lexical only.** `let's give kalpaney another try?`, `Let's go to New place!`
  and `booked oye kake` match **zero** query tokens. The Swiggy booking matched
  only via the stopwords `have`/`on` and landed at **rank 25**, behind `LIMIT 8`.
- **Stopword noise.** Of 90 candidate rows, **88 match only stopwords**. bm25
  then spends 5 of 8 slots on them. `"sunday" OR "planned"` alone returns 2 rows
  — precision is fine, **recall is the problem**.
- **No expansion of any kind.** One flat `SELECT … LIMIT 8`. `channel_id` is
  read only to print the chat name. `idx_events_channel_ts` exists for exactly
  the window query nobody wrote.
- **Reply edges unused.** 96 populated `reply_to_external_id` rows, a dedicated
  index, zero traversal. `reply_to_text` is not even in `events_fts`.
- **Snippet/match column mismatch.** `MATCH` searches all 6 FTS columns;
  `snippet(events_fts, 0, …)` extracts from column 0 only. A row matching only
  in `transcript` is injected as a **blank line**. That really happened — one of
  the 8 slots was a content-free line from a toddler's video transcript.
- **No recency, no date grounding.** `ORDER BY rank` is time-blind, and
  "sunday" is never resolved to a date, so the booking's `02 Aug 2026` — the
  Sunday being asked about — is invisible.

Scale check: the **entire** "Weekend lunches" chat is 18 events / 864 chars.
It is five times smaller than the existing context budget. It could have been
included wholesale and the answer would have been right.

### Chosen: all three tiers

**Tier 1 — deterministic retrieval (do this first, it fixes the repro alone):**

- Stopword filter in `toRetrievalMatchQuery`, and prefer content words.
- **Window expansion**: after ranking, pull neighbours from each hit's
  `channel_id` around its `ts` using `idx_events_channel_ts`. Verified: ±8
  recovers 100% of the missing evidence.
- **Whole-chat inclusion** when a channel is small enough to fit the budget.
- **Reply-chain traversal** both directions; add `reply_to_text` to `events_fts`.
- **Recency as a ranking term** alongside bm25, and `bm25()` column weights so a
  long scraped page cannot outrank a short message.
- **Fix the snippet column** — snippet whichever column matched; never emit a
  blank hit.
- Raise `k`.

**Tier 2 — let the model search.** Materialise the corpus as text the grounded
run can `Grep`/`Read` from its cwd, so an open question can be chased rather
than answered from one fixed block. Must be incremental, not a full rewrite per
turn.

**Tier 3 — semantic.** A local embedding model over messages so "sunday plans"
can reach "booked oye kake" by meaning. Index incrementally. If the model
cannot be bundled within a sane size, download on demand and keep semantic
search off until it is present — but say so, do not fake it.

### Date and day resolution (explicitly requested)

The current date must be in the grounded prompt, and weekday/relative
expressions in the question ("sunday", "tomorrow", "next week", "this weekend")
must be resolved to actual dates and used in retrieval. The booking says
`02 Aug 2026` — a date the question never contains, and today's date is the only
thing that connects them.

## 2. Albums — the count is always absent

Verified on all 4 real headers: `album_count IS NULL`, meaning `want == 0` on
the wire. `ExpectedImageCount`/`ExpectedVideoCount` are optional `*uint32` and
WhatsApp does not send them. `album.go:53` bails on `want <= 0`, so the group is
**never armed** — every other check passes and is never reached.

The Go test at `album_test.go:169-173` — *"a header expecting nothing groups
nothing"* — **asserts the production bug as correct**. Every passing grouping
test uses counts WhatsApp never sends. Fix the test with the code.

Fix: arm on the header's existence; use the count as a **cap when present**;
close the burst on the existing signals (window, sender change, non-media kind).

**Also required:** every group must carry a real count. Since WhatsApp's
promised count is absent, the count shown must be the **actual number of grouped
members**, not a promise. `src/tabs/InboxTab.tsx:1159` detects the header via
`albumCount != null`, which is always false — detect via `album_id === id`
instead. That is why the UI reads "Album · 0 photos".

## 3. Reactions — who reacted

The reactor is already carried at **every** layer including the HTTP response,
and is dropped only in `ReactionChips`
(`src/tabs/InboxTab.tsx:1432-1451`), which counts emoji and never reads
`r.actorName` or `r.fromMe`. Live and history-synthesised reactions both carry
it; 16 reaction rows exist, 0 with a null actor.

Fix is presentation-only: show who reacted. No schema, daemon or worker change.

Secondary: `src/tabs/InboxTab.tsx:1196-1198` flattens header + member reactions
into one list, so once albums group you lose **which photo** was reacted to.
Attribute reactions to their own message.

## 4. Links — the cap, not the stripping

The premise that scripts are not stripped is **wrong**. `link.ts:269-272` does
strip them. It fails because the regex needs a matching `</script>` and
`MAX_BYTES = 512 * 1024` (`link.ts:41`) truncates the body mid-script, so the
closing tag never arrives and `link.ts:275` turns the orphan JS into "prose".

Measured, with real fetches:

| URL | body | og:title offset | inside 512 KB cap? |
|---|---|---|---|
| YouTube `/watch` | 1,319,552 B | 690,511 | **no** |
| YouTube `/shorts` | 1,359,320 B | 685,855 | **no** |
| Instagram `/reel` | 954,398 B | 12,898 | **yes** |

So YouTube's metadata is ~688 KB in and the cap severs it; Instagram's is
already reachable and only the extraction method is wrong. All 32 link rows are
recorded `status='done'` — gibberish is being reported as success.

Fixes:

1. Anchor the script/style terminator to end-of-input so a truncated body can
   never leak its script bodies.
2. **Prefer `og:*` / `<meta name=description>` / JSON-LD `VideoObject` over body
   text.** Whole-body text on YouTube, even uncapped, yields only footer
   boilerplate — technically valid and useless.
3. Restructure the cap: scan until the head/og block is seen rather than cutting
   at a fixed byte count.
4. **Reject non-prose output** (brace/quote/backslash density, `ytcfg`,
   `{"require":[[`) and record it as an error rather than `done`.
5. Main-content extraction (`<main>`/`<article>`) rather than whole body.

### yt-dlp

Bundled (~30 MB) for **YouTube captions**, giving spoken video content. Chosen
over a hand-rolled timedtext fetcher, which would cover only YouTube and break
unannounced.

**Instagram is deliberately not routed through yt-dlp**: reels have no caption
track, `og:title`/`og:description` already carry the full caption and engagement
counts at ~13 KB, and yt-dlp against Instagram needs cookies and is blocked
without them. Extraction alone solves Instagram.

Captions are behind the existing link-scrape switch. Fetching a caption track is
still an outbound request to a URL someone else chose.

## 5. Parallelism

The media queue is strictly serial — one `ticking` guard, one item per tick.

Make concurrency configurable, **default 5**. Constraints:

- A batch and a single read both count as one slot.
- Transcription still yields to descriptions and chat.
- The five-hour subscription limit already reports `overageStatus: rejected`;
  on a rate-limit or auth failure, back off rather than hammering five at once.
- Ordering must stay stable enough that live media still preempts backlog.

## 6. Transcription on by default

`media.voice_notes_enabled` and `media.video_audio_enabled` both default **ON**.
It is local and costs no tokens. Video *frames* stay off — those do cost tokens.

## 7. Settings

- Recent runs must list **all** runs, not the newest 50 (`RUNS_LIMIT`,
  `SettingsTab.tsx:58`). Paginate or virtualise rather than fetching everything
  at once when the table is large.
- The runs table scrolls horizontally while the window has room: the shell is
  `max-width: 1120px` and sections are `max-width: 720px`
  (`src/styles/tabs/settings.css:11,86`). Widen so the table fits.
