# Session 3 — token truth, media switches, links, history reactions

Frozen contract. Agents own disjoint trees and must not rename a field here.

Measured facts (probed against the real CLI with the adapter's exact flags,
`--allowedTools Read --max-turns 4 --model claude-haiku-4-5-20251001`, on a real
image from the user's library):

| | total input | recorded today |
|---|---|---|
| media call as shipped | **59,740** | **17** |
| same + `--setting-sources ""` | 53,582 | — |

`input_tokens` is the *uncached delta only*. The bulk is
`cache_creation_input_tokens` + `cache_read_input_tokens`, which the parser
never reads. The ~53k floor is the CLI's own agent system prompt and tool
schemas — unavoidable. The ~6k difference is the user's global `CLAUDE.md`,
which has nothing to do with describing an image.

---

## 1. Usage — record all four plus cost

```ts
export interface Usage {
  inputTokens: number;              // fresh, uncached
  cacheCreationInputTokens: number; // cache write
  cacheReadInputTokens: number;     // cache read
  outputTokens: number;
  costUsd?: number;
}
```

- `extractUsage` (`worker/src/providers/claude-local/parser.ts:82-88`) must read
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, and `total_cost_usd`.
- **Accumulate, never overwrite.** Today `index.ts:480` and `:517` assign
  `usage = parsed.result.usage`, and `parser.ts:173-189` ignores
  `assistant.message.usage` entirely, so a 4-turn media run reports only the
  terminal line. Sum per-turn usage across the run.
- A run killed by timeout or cancel currently records 0. Record whatever was
  accumulated before the kill; do not silently drop real spend.
- `worker/src/providers/claude-local/index.ts:476` and `:511` suppress the
  `usage` stream event so it never leaves the adapter, making the SSE `usage`
  frame and `worker-client.ts:306-311` dead code. Either wire it through or
  delete the dead path — do not leave it half-connected.

### Billable equivalent

```ts
export function billableTokens(u: Usage): number {
  return Math.round(
    u.inputTokens + u.cacheCreationInputTokens * 1.25 + u.cacheReadInputTokens * 0.1 + u.outputTokens,
  );
}
```

The chat quota gate counts **billable equivalent**, not the raw sum — cache
reads bill at ~10%, so a raw sum would trip the 5M gate ~10× sooner than today
and lock the user out of chat for no real reason. The UI still shows all four
raw numbers.

### Media stays out of the gate

Media runs are logged to `extraction_runs` but must **not** call `addUsage`.
A background backlog must never lock the user out of chat. Settings shows
media spend as its own line so it is visible rather than hidden.

### Schema

```sql
ALTER TABLE extraction_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE extraction_runs ADD COLUMN cache_read_input_tokens    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN cache_read_input_tokens    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN billable_tokens            INTEGER NOT NULL DEFAULT 0;
```

`extraction_runs.cost_usd` already exists and is populated — it is simply never
selected in `store.ts:465-469` or shown. Show it.

---

## 2. Media reading — batching and per-type switches

### Batching

Up to **8 images per CLI call**. One call, N absolute paths, a response that
maps a description to each path. If the response cannot be mapped back to every
image in the batch, the unmapped images are **re-run individually** — never
assign a description to an image it may not belong to.

Only same-kind, readable images batch. Documents and video thumbnails stay
one-per-call.

Media calls also pass `--setting-sources ""` (a new `skipUserSettings` option on
`SendOptions`, independent of `plainCompletion`): ~6k fewer tokens per call, and
the user's global coding instructions have no business shaping an image caption.

### Switches

New `app_state` keys, with getters following the existing shape in
`worker/src/store/store.ts:650-687`:

| Key | Default | Gates |
|---|---|---|
| `media.images_enabled` | **ON** | image + sticker reads |
| `media.video_enabled` | **OFF** | video / PTV thumbnail reads |
| `media.business_enabled` | **OFF** | media on business / official-account chats |
| `media.link_scrape_enabled` | **OFF** | fetching link targets |

**Polarity trap:** every existing boolean getter is
`v ? v.value !== "0" : true` — default ON. The three default-OFF switches need
the inverse (`v ? v.value === "1" : false`) or they ship enabled.

**Gate in `claimPendingMedia`, not at insert time.** `media_desc_status` is
stamped once when the row is written (`ingest.ts:920-935`), so gating there
means flipping a switch on later cannot reach rows already stamped
`unsupported`. The kind/business filters belong in the claim query
(`ingest.ts:633-650`).

### Re-scan

`POST /api/media/rescan` with `{types: ("image"|"video"|"document"|"link"|"business")[]}`
re-queues matching rows to `pending`, clearing description, model, status and
error. Settings gets a control for it. Settings changes never silently
re-process anything — flipping a switch must not start hundreds of model calls
on its own.

---

## 3. Links

The daemon reads **none** of the link-preview fields today. Verified against
whatsmeow `v0.0.0-20260622185415`: on `ExtendedTextMessage` the fields are
`MatchedText` (this is the canonical URL — there is no `CanonicalURL` field on
this type in this version), `Title`, `Description`, `JPEGThumbnail`,
`ThumbnailDirectPath`, `PreviewType`.

### Wire

```go
type Link struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	ThumbPath   string `json:"thumb_path,omitempty"`
	PreviewType string `json:"preview_type,omitempty"`
}
```
on `Event` as `Link *Link \`json:"link"\``.

Plain `Conversation` messages carry no preview at all, so a URL in plain text is
extracted by regex in `classify` and emitted as a `Link` with only `URL` set.

### Scraping — no model needed

Fetching a page and pulling readable text is deterministic HTML→text work. An
LLM is only required if a *summary* is wanted, which is not in scope.

Behind `media.link_scrape_enabled` (default OFF): fetch the URL, extract title
and readable text, store it in the searchable description. Constraints, all
mandatory:

- http/https only; reject anything else
- **refuse private and loopback addresses** after DNS resolution (SSRF guard) —
  a URL in a message is attacker-controlled input
- cap response size and total time; follow a bounded number of redirects
- send a plain user agent, never cookies or credentials
- record failures as `error` with the reason; never invent content

Fetching a link makes an outbound request to a URL that arrived in a message.
That is observable by whoever sent it, which is exactly why the switch is off by
default and why this must be stated in the Settings copy.

---

## 4. History reactions

Old reactions never arrive because the daemon throws them away — verified.

`ParseWebMessage` returns `events.Message` with `SourceWebMsg` holding the full
`*waWeb.WebMessageInfo` (whatsmeow `client.go:991`), whose field 41 is
`Reactions []*waWeb.Reaction` (`WAWebProtobufsWeb.pb.go:1461`). At
`sources/whatsapp-go/internal/wa/events.go:722` the daemon passes only
`parsed.Info` and `parsed.Message` into `mapMessage`, so `SourceWebMsg` — and
every historical reaction on it — is dropped on that one line.

Fix: in the history loop, after the message emits, iterate
`parsed.SourceWebMsg.GetReactions()` and synthesize a reaction event per entry:

- `Kind` = reaction
- `Text` = `r.GetText()` — empty means removal, which the worker already handles
- `ReplyToExternalID` = `<canonicalChat>/<webMsg.Key.ID>` — the target is the
  **enclosing** message, not `r.Key`
- `ExternalID` = `<canonicalChat>/<r.Key.ID>`; if that id is absent, derive a
  stable one from target + reactor + emoji, or repeated imports duplicate rows
- `ActorExtID` = canonicalized `r.Key.Participant`, falling back to self when
  `FromMe`
- `TS` from `r.GetSenderTimestampMS()`
- Apply the same `rangefilter.MessageInRange` check as messages

No worker or schema change needed — reaction rows, collapse-by-actor and
removal semantics already work.

Honest caveat: the field exists and whatsmeow parses it, but whether WhatsApp
populates it for a given account is empirical. If it comes back empty, say so
rather than claiming the feature works.

---

## 5. Business / official-account media

`skipChatJID` is **not** the cause for `0@s.whatsapp.net` — it passes cleanly.
It **is** the cause for `status@broadcast` and all `@newsletter` chats, which
never reach `classify` at all.

Real remaining gaps in `businessHeaderMedia` (`events.go:2092-2139`):

- `InteractiveMessage.CarouselMessage.Cards[].Header` — never descended into;
  `GetCarouselMessage` appears nowhere in the repo
- `InteractiveMessage.Header` product-message variant
- `HighlyStructuredMessage.HydratedHsm` header media — text recurses in, media
  does not
- `ProductMessage.Catalog.CatalogImage`
- `OrderMessage.Thumbnail` — raw bytes
- `ContextInfo.ExternalAdReply.{Thumbnail,Title,Body,MediaURL}` — the most
  common business-media shape of all, and completely unread

`EventMessage` has **no** cover-image field in this whatsmeow version. Nothing
to fix there; do not invent one.

### Thumbnail-only download path

Several of the above carry only raw `JPEGThumbnail` bytes with no downloadable
full media. Today that is structurally impossible to store: `downloadMedia`
calls `client.Download` first and returns early on error (`events.go:2420-2422`),
so `writeThumbnail` is only ever reached after a successful full download.

Add a thumbnail-only path that skips `Download` and writes the bytes alone. Then
decide what `Media.Path` means with no full file — `claimPendingMedia` requires
`media_path IS NOT NULL` (`ingest.ts:646`), so either point `Path` at the
thumbnail or relax that predicate. Pick one and make both sides agree.

### Business flag

There is no way to express "this chat is a business" today: `protocol.Channel`
is `{source_ext_id, name, kind}` and `verifiedName` / `officialAccountName` are
consumed only to produce a display name. The `media.business_enabled` switch
needs a new boolean on `protocol.Channel`, set by the daemon, persisted by a
worker migration, and filtered in `claimPendingMedia`.
