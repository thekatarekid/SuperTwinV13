# Session 4 — the fixes

Frozen contract. Agents own disjoint trees. Everything here was verified against
the live DB and the shipped v0.3.2 bundle, not inferred.

## 1. Token usage breakdown (UI)

Both the **Chat** and **Media reading** blocks must show, instead of a single
"Billable" figure:

`Input · Cached input · Cache read · Output · Cost · Runs`

Billable stays, but as a secondary line — it is what the limit acts on and is
not a raw count. Cost must appear per window, not only per run: the
quota/usage endpoint has to sum `cost_usd` for the window. Today the chat block
says *"Cost is recorded per call, not per window — it is in Recent runs"*,
which is a workaround, not a design.

## 2. Links — the route drops them

The `LinkPreview` component is complete and correct
(`src/tabs/InboxTab.tsx:962-999`, mounted at `:914`). `getChannelMessages`
selects and maps the link correctly (`worker/src/db/ingest.ts:637-642`,
`:1347-1356`).

**`worker/src/server/whatsapp-routes.ts:206-235` rebuilds each row field by
field and has no `link:` key.** `msg.link` is therefore always `undefined`.
Confirmed absent from the shipped v0.3.2 bundle.

Also fix the latent name mismatch: the mapper emits `thumbPath`
(`ingest.ts:1352`), the UI type says `thumbUrl`
(`src/lib/whatsapp-types.ts:423-424`). An absolute path is not fetchable by a
browser — serve it through the media route and give the UI a URL.

Verified on real data: WhatsApp **does** send preview metadata for bare URLs —
23 of 29 have a title, 20 a preview type. But **0 of 32 have a thumbnail**:
history sync strips `JPEGThumbnail`. Whether live messages carry it is unknown
and must not be claimed either way.

## 3. Media rendering

`src/tabs/InboxTab.tsx:803` gates images on **kind**, not mime:

```ts
const IMAGE_KINDS = new Set(["image", "sticker"]);
```

The WhatsApp official-account row is `kind='video'` with `media_mime='image/jpeg'`
and a real readable JPEG on disk (the thumbnail-only fallback after a failed
download). It renders as a file chip. **Gate on mime instead** — if the bytes
are an image, show the image.

Two more, same row:

- `media_seconds=14` on a 16 KB JPEG. `thumbnailOnlyMedia`
  (`events.go:2808-2820`) copies `dl.meta` wholesale, keeping `Seconds` from the
  video that failed to download. Clear duration when falling back to a
  thumbnail, and do not render a duration on a still image.
- **Video thumbnails are stored but never shown.** 7 of 17 videos have
  `media_thumb_path` on disk. `whatsapp-routes.ts:217-228` deliberately omits it
  ("an absolute path no HTTP client can fetch") and offers no URL instead, and
  nothing in `src/` reads a media thumbnail at all. Serve it and render it.

## 4. Batching — four separate bugs

Measured: 33 items took **14 CLI calls**; optimal is 2 at the new batch size.
Actual sizes were `1, 8, 1, 8, 8→0, 7, 1,1,1,1,1,1,1,1`.

**(a) Permanent solo quarantine — costs 8 of the 9 wasted calls.**
`describe.ts:499-508`: when the model answers but names no requested path,
`results` is empty, so every row misses its entry and hits `queue.ts:310`
(`this.solo.add(row.id)`). `group()` then excludes them **forever**
(`queue.ts:256`, `:258`). One unparseable answer turned a single 8-batch into 8
permanent solo reads. Retry the batch once, then fall back to solo **for that
attempt only** — quarantine must not be permanent.

**(b) History rows are flagged live.** `ingest/index.ts:365` calls
`enqueueLiveMedia` on every inserted media event, and `onEvent` is the single
path for both history sync and live arrivals. So during an import everything is
"live", and `queue.ts:225-226` makes `pool` the live subset rather than the
claim — plus `wake()` fires a tick at size 1. The daemon must mark an event as
historical, and only genuinely live arrivals may jump the queue.

**(c) A non-batchable head burns the tick.** `queue.ts:227` takes `pool[0]`, and
`:256` returns `[head]` when it is not an image. A document or video at the head
of a `ts DESC` claim makes the whole tick a single read. Pick the head from the
batchable rows, or partition the claim by kind.

**(d) Batch size.** `MAX_IMAGE_BATCH` 8 → **20**, and configurable in Settings.
Measured: 1 image 36,394 tokens ($0.0146 each); 8 → 45,746 ($0.0056 each);
20 → 64,593 ($0.0048 each). Marginal cost ~1,570 tokens/image.

**Not a bug:** 17 rows sit `pending` because business (10) and video (7) are
switched off by default. That is correct behaviour.

## 5. Albums

There is **no grouping key in the protocol** — `AssociatedChildMessage` is a
`FutureProofMessage` whose entire definition is one `Message` field, and
`AlbumMessage` carries only `ExpectedImageCount` / `ExpectedVideoCount`. No
album id, no child list, no `ContextInfo` link. Children's `StanzaID` is empty.

Chosen: **heuristic grouping.** The album header is followed by its children
from the same sender, in the same chat, within a short window, and the header
says how many to expect. Emit a synthetic album id on the header and on the next
`ExpectedImageCount + ExpectedVideoCount` matching media messages.

Constraints:
- Bound the window tightly and stop at the expected count — never absorb
  unrelated media.
- This is inference. If the counts or window do not match, group nothing rather
  than group wrongly.
- The header's bare `"📷 Album"` text must stop rendering as a lone text
  message; it becomes the group container.

## 6. Overhead — decided: leave as is

Replacing the CLI's system prompt would save ~17k tokens/call (53,582 → 36,394,
measured) but was **declined**. Do not change the prompt or the flags.
`--setting-sources ""` stays on media only, as now.

For the record: `--bare` is unusable — it requires `ANTHROPIC_API_KEY` and
rejects subscription OAuth ("Not logged in"). The user's `CLAUDE.md` is 38 bytes
but `@`-imports `browser-harness/SKILL.md` (8.8 KB), which is where the ~6k
went; that is already excluded.
