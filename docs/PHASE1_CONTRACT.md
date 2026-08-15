# Phase 1 Contract — WhatsApp Ingestion

**Status:** authoritative. Every Phase 1 build agent codes against THIS document. If reality forces a change, update this file and note it.

Phase 1 goal: pair WhatsApp via QR in-app, pick an import range, backfill (range-limited, with progress), stream live messages into a read-only Inbox with FTS search + media viewing, survive restart with zero duplicates, and extend the range later to fill older history.

---

## 0. Process architecture (decided)

```
Tauri (Rust)  ──spawns──►  Node worker (owns SQLite, :8787)  ──spawns──►  Go whatsmeow daemon
   sidecar: binaries/node        │  parses NDJSON, dedupes, writes DB          (child process, NDJSON stdio)
                                 └─ HTTP+SSE API ──► React UI (Inbox/onboarding)
```

- The **Node worker is the single DB writer.** The Go daemon NEVER touches `supertwin.db`. It has its OWN whatsmeow session store (`whatsmeow.db`) and writes media files, nothing else.
- The **worker supervises the Go daemon** as a child process: spawn, restart on crash (backoff), send control commands on the daemon's **stdin**, read events/status on the daemon's **stdout** (line-delimited JSON). Daemon logs go to **stderr** (mirrored to worker log, never parsed as protocol).
- The Go binary is **bundled inside the worker bundle** at `worker/bundle/bin/whatsapp-go` (self-contained, ad-hoc signed). No new Tauri `externalBin`. This keeps the working Phase 0 Tauri shell untouched.

### Filesystem layout (all under `~/SuperTwin/`, override root via `SUPERTWIN_HOME`)
```
~/SuperTwin/supertwin.db            # worker-owned (existing)
~/SuperTwin/whatsapp/whatsmeow.db   # daemon-owned whatsmeow sqlstore session
~/SuperTwin/media/whatsapp/<chatJID>/<messageID>.<ext>   # daemon-written media
~/SuperTwin/logs/whatsapp-go.log    # daemon stderr tee (optional)
```
- Worker resolves DB via existing `resolveDbPath()` (`~/SuperTwin/supertwin.db`, `SUPERTWIN_DB_PATH` override). Keep that.
- Add `SUPERTWIN_HOME` (default `~/SuperTwin`) as the base for whatsapp/media/logs. Worker passes concrete paths to the daemon via flags/env so the daemon needs no path logic of its own.

### Binary resolution (worker → daemon path)
Order: `SUPERTWIN_WHATSAPP_BIN` env → `path.join(__dirname, 'bin/whatsapp-go')` (bundled/prod, relative to the running `worker.cjs`) → repo dev path `sources/whatsapp-go/whatsapp-go` (prebuilt) → `go run ./sources/whatsapp-go` fallback in dev. First existing/executable wins.

---

## 1. Daemon → worker messages (daemon stdout, one JSON object per line)

Every line is a JSON object with a discriminator field `t`. Unknown `t` values must be ignored by the worker (forward-compat). All timestamps are **ISO-8601 UTC with milliseconds** (`2026-07-02T12:34:56.789Z`).

| `t` | Payload | Meaning |
|-----|---------|---------|
| `ready` | `{}` | Daemon booted, session store opened, ready to accept stdin commands. |
| `status` | `{ "state": <State>, "detail"?: string, "jid"?: string, "push_name"?: string }` | Connection/lifecycle state change. |
| `qr` | `{ "code": string, "timeout_s": number }` | A QR pairing code to render. Emitted repeatedly while pairing until paired/timeout. `code` is the RAW whatsmeow QR string (UI encodes it to a QR image). |
| `paired` | `{ "jid": string, "push_name": string }` | Pairing succeeded; session persisted. |
| `channel` | `{ "channel": <Channel> }` | Upsert chat metadata (see §3). Emit before/with the first event of a chat. |
| `actor` | `{ "actor": <Actor> }` | Upsert a sender's metadata (see §3). |
| `event` | `{ "event": <Event> }` | A message/media/system event (see §3). The core payload. |
| `progress` | `{ "phase": "backfill"\|"live", "chats_done": number, "chats_total": number, "messages": number, "done": boolean, "range"?: <Range> }` | Backfill progress. `chats_total` may be an estimate that grows; `done:true` marks the end of a backfill run. |
| `backfill_complete` | `{ "range": <Range>, "chats": number, "messages": number }` | A backfill/import (or extend) run finished. |
| `error` | `{ "code": string, "message": string, "fatal": boolean }` | Recoverable (`fatal:false`) or fatal (`fatal:true`) error. |

**State enum** (`status.state`): `starting` · `need_pairing` · `pairing` · `connected` · `syncing` · `online` · `reconnecting` · `logged_out` · `error`.

Ordering guarantees the worker relies on: for any `event`, the daemon has already emitted (this run) a `channel` for its `channel_ext_id` and an `actor` for its `actor_ext_id`. The worker still upserts defensively (lazy) if it sees an event for an unknown channel/actor.

---

## 2. Worker → daemon commands (daemon stdin, one JSON object per line)

Field `cmd`. The daemon must ignore unknown commands.

| `cmd` | Payload | Effect |
|-------|---------|--------|
| `start_pairing` | `{}` | If no valid session: begin QR pairing, emit `qr` lines. If already paired: no-op + `status online`. |
| `import` | `{ "range": <Range> }` | Run a range-limited backfill (history sync), filtered per §4, emitting `progress` then `backfill_complete`. Then continue live streaming. |
| `extend` | `{ "range": <Range> }` | Request OLDER history to widen coverage to `range` (on-demand history sync). Emits `progress`/`backfill_complete`. Must not re-emit already-sent messages (worker dedupes anyway). |
| `pause` | `{}` | Kill-switch: stop emitting events, hold connection idle (or disconnect). |
| `resume` | `{}` | Resume streaming after `pause`. |
| `logout` | `{}` | Clear the whatsmeow session (unpair); emit `status logged_out`. |
| `shutdown` | `{}` | Flush, close DB/session cleanly, exit 0. Worker also sends SIGTERM as backup; daemon must exit within ~3s. |

CLI flags the worker passes at spawn: `--session-db <path>` `--media-dir <path>` `--log-level info`. On spawn with an existing session the daemon auto-connects and goes `online` without needing `start_pairing`.

---

## 3. Canonical shapes

### Event (daemon emits `event.event`; worker maps to a row in `events`)
```jsonc
{
  "external_id": "<chatJID>/<messageID>",   // stable dedupe key WITHIN the whatsapp source
  "channel_ext_id": "<chatJID>",            // -> channels.source_ext_id
  "actor_ext_id": "<senderJID>",            // -> actors.source_ext_id; for from_me use the self JID
  "ts": "2026-07-02T12:34:56.789Z",         // message timestamp, ISO-8601 UTC ms
  "kind": "message|image|video|audio|document|sticker|location|contact|revoked|reaction|system",
  "text": "body or caption or ''",
  "media": {                                 // null when no media
    "path": "/Users/.../SuperTwin/media/whatsapp/<chatJID>/<messageID>.jpg",
    "mime": "image/jpeg",
    "filename": "IMG_0001.jpg",
    "size": 12345,
    "sha256": "..."
  },
  "from_me": false,
  "raw": { /* small subset of whatsmeow MessageInfo: id, chat, sender, type, timestamp */ }
}
```

### Channel (daemon emits `channel.channel`; worker upserts `channels`)
```jsonc
{ "source_ext_id": "<chatJID>", "name": "Mom", "kind": "dm|group" }
```

### Actor (daemon emits `actor.actor`; worker upserts `actors` + `people`)
```jsonc
{ "source_ext_id": "<senderJID>", "display_name": "Mom", "handle": "+9199...", "is_self": false }
```

### Range enum `<Range>`
`"24h" | "3d" | "7d" | "30d" | "90d" | "180d" | "1y" | "all"`.

---

## 4. Range/backfill semantics (spec §Phase 1)

For range `R` with cutoff `now - R` (`all` = no cutoff, epoch 0):
1. **Chat filter:** include only chats whose most recent activity is **≥ cutoff** (active within the range).
2. **Message filter:** within those chats, include only messages with `ts ≥ cutoff`.
3. Live messages (arriving after import) are always ingested regardless of range.
4. **Extend** widens the cutoff backwards (e.g. 3d → 30d): fetch and emit older messages for already-known chats and surface chats that become in-range. Idempotent (worker dedupes on `(source_id, external_id)`).

The range→duration mapping and the two filter predicates MUST be a pure, unit-tested function in BOTH the Go daemon (`rangeCutoff(range, now) time.Time`) and the TS worker (for validation) — identical semantics.

---

## 5. DB migration `0002_phase1` (worker/src/db/schema.ts)

Append to `MIGRATIONS` (do NOT edit `0001_init`). Idempotent DDL only.

```sql
-- Dedupe key for source-agnostic ingestion
ALTER TABLE events   ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_external ON events(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_events_channel_ts ON events(channel_id, ts);

-- Stable external identity for channels/actors (source-scoped)
ALTER TABLE channels ADD COLUMN source_ext_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_source_ext ON channels(source_id, source_ext_id);
ALTER TABLE actors   ADD COLUMN source_ext_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_source_ext   ON actors(source_id, source_ext_id);

-- Small key/value app state (kill-switch, import status, last-seen cursors)
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```
Notes:
- `ALTER TABLE ... ADD COLUMN` is safe on the existing tables (columns are new/nullable). Because the migration runner records applied ids, `0002_phase1` runs once. (If you must guard against a partially-applied ALTER during dev, wrap column adds in a `PRAGMA table_info` check in the runner — otherwise leave as-is; fresh DBs and clean Phase-0 DBs apply cleanly.)
- FTS5 `events_fts` + triggers already exist and auto-sync on `events` INSERT/UPDATE/DELETE. The event writer only inserts into `events`; do NOT touch `events_fts` directly.
- A fixed WhatsApp source row: `sources(id='whatsapp', type='whatsapp', name='WhatsApp')`, upserted on worker startup. All events use `source_id='whatsapp'`, `source_type='whatsapp'`.

### Worker → row mapping (event writer, `INSERT ... ON CONFLICT(source_id,external_id) DO NOTHING`)
| events column | value |
|---|---|
| `id` | `"wa:" + external_id` (deterministic) |
| `source_id` | `"whatsapp"` |
| `source_type` | `"whatsapp"` |
| `channel_id` | resolved `channels.id` for `channel_ext_id` (upsert first) |
| `actor_id` | resolved `actors.id` for `actor_ext_id` (upsert first) |
| `ts` | event `ts` |
| `kind` | event `kind` |
| `text` | event `text` |
| `media_path` | `media.path` or null |
| `raw_json` | `JSON.stringify(event.raw)` |
| `external_id` | event `external_id` |

Dedupe MUST be verified by test: inserting the same event twice ⇒ 1 row; restart + re-emit ⇒ 0 new rows; extend overlap ⇒ 0 duplicates.

---

## 6. Worker HTTP API (new endpoints; base `http://localhost:8787`)

Follow existing conventions in `worker/src/server/index.ts` (Node `http`, JSON, `sseSend` for SSE). Add:

| Method + path | Body / query | Response |
|---|---|---|
| `GET /api/whatsapp/status` | — | `{ state, paired: boolean, paused: boolean, jid?, pushName?, progress?: Progress, lastError?: {code,message} }` |
| `GET /api/whatsapp/stream` | — (SSE) | pushes `{type:"status"\|"qr"\|"progress"\|"paired", ...}` frames as they arrive from the daemon, so the UI shows the QR + live progress without polling. |
| `POST /api/whatsapp/pair` | `{}` | `{ ok:true }` — triggers `start_pairing`; QR arrives on the stream. |
| `POST /api/whatsapp/import` | `{ range: Range }` | `{ ok:true }` — triggers backfill. |
| `POST /api/whatsapp/extend` | `{ range: Range }` | `{ ok:true }` |
| `POST /api/whatsapp/pause` | `{ paused: boolean }` | `{ ok:true, paused }` — kill-switch; persisted to `app_state`. |
| `POST /api/whatsapp/logout` | `{}` | `{ ok:true }` |
| `GET /api/inbox/chats` | `?limit&offset` | `[{ id, name, kind, lastText, lastTs, messageCount }]` sorted by `lastTs` desc. Derived by query over `events`+`channels`. |
| `GET /api/inbox/chats/:id/messages` | `?before(ts)&limit` | `[{ id, ts, kind, text, fromMe, actorName, mediaUrl? }]` ascending by ts. `mediaUrl = /api/media/:eventId` when media exists. |
| `GET /api/inbox/search` | `?q&limit` | `[{ eventId, channelId, channelName, ts, snippet, text }]` via FTS5 (`events_fts MATCH`), `snippet()` for highlight. |
| `GET /api/media/:eventId` | — | streams the file at `events.media_path` with correct `Content-Type`; 404 if missing. Guard against path traversal (must resolve under `SUPERTWIN_HOME/media`). |
| `GET /api/health` | — | extend existing to also include `{ whatsapp: { state, paired } }` (optional, additive). |

`Progress = { phase, chatsDone, chatsTotal, messages, done, range? }`.

All new types must be exported from a shared worker types module and MIRRORED into `src/lib/worker-client.ts` for the UI (same pattern as Phase 0 provider types).

---

## 7. SourceAdapter interface (worker/adapters — future-ready core)

```ts
export interface SourceEvent { /* the Event shape from §3, source-neutral */ }
export interface SourceAdapter {
  readonly sourceId: string;          // "whatsapp"
  readonly sourceType: string;        // "whatsapp"
  connect(): Promise<void>;           // spawn+supervise daemon, restore session
  startPairing(): Promise<void>;
  backfill(range: Range): Promise<void>;
  extend(range: Range): Promise<void>;
  pause(paused: boolean): Promise<void>;
  logout(): Promise<void>;
  disconnect(): Promise<void>;         // graceful shutdown
  onEvent(cb: (e: SourceEvent) => void): void;
  onChannel(cb: (c: Channel) => void): void;
  onActor(cb: (a: Actor) => void): void;
  onStatus(cb: (s: StatusUpdate) => void): void;   // status|qr|progress|paired|error
  getStatus(): AdapterStatus;
}
```
`WhatsAppAdapter implements SourceAdapter` and owns the Go child process + NDJSON framing. The event writer + API layer consume the adapter's callbacks. Adding a future source = new adapter, zero DB/brain changes.

---

## 8. Non-negotiables carried into Phase 1
- **Read-only ingestion.** The daemon NEVER sends WhatsApp messages. No send code paths at all in v1.
- All data local; media on disk; DB local. Kill-switch (`pause`) halts the daemon + ingestion.
- Every message deduped; restart and range-extend produce zero duplicates.
- Go daemon must build for `aarch64-apple-darwin`, run inside the ad-hoc-signed `.app`, and shut down with no orphaned processes.

## 9. Testability without a live phone
The daemon must support a **`--mock` mode**: instead of connecting to WhatsApp, it replays a scripted fixture (a JSON file of channels/actors/events, or a built-in synthetic set) through the exact same NDJSON protocol — including a fake QR, fake pairing, and range-filtered backfill with progress. This lets the worker↔daemon pipeline, dedupe, restart, range-extend, Inbox, and FTS all be tested end-to-end in CI with `SUPERTWIN_WHATSAPP_MOCK=1`. Live-device acceptance items (real QR pair, phone parity) are verified manually by the user.

---

## Revision 2 — Real-device bug fixes (authoritative additions)

Live testing surfaced 7 bugs. These additions are binding for the fix round. Keep all Rev-1 shapes; these are additive.

### R2.1 Persisted import state (bug 6 — stop re-asking the range on relaunch)
- New `app_state` keys: `whatsapp.import_done` = `"true"` after the FIRST backfill completes; `whatsapp.import_range` = the chosen `<Range>`.
- Worker sets both when it receives the initial `backfill_complete` (and on any successful `import`). `reset` clears them.
- `GET /api/whatsapp/status` response gains: `importDone: boolean`, `importRange?: Range`.
- UI rule: show the import-range picker ONLY when `paired && !importDone`. When `paired && importDone` → go straight to the Inbox. "Extend history" remains the way to widen coverage later.

### R2.2 Live ingest nudge (bugs 2 & 3 — list + open chat must refresh within seconds)
- `GET /api/whatsapp/stream` emits an additional debounced frame whenever new events are persisted:
  `{ "type": "ingest", "ts": "<iso>", "channels": ["<channelId>", ...] }` (debounce ~750ms; `channels` = distinct channel ids touched since the last nudge, may be capped/omitted — presence of the frame is the signal).
- UI: on an `ingest` frame, refetch `GET /api/inbox/chats` AND (if a chat is open) its messages. Also keep a fallback poll of `/api/inbox/chats` every ≤20s in case the stream drops. This is what makes self-sent and incoming messages appear ≤ a few seconds (spec's <5s) and fixes the stale left-list (bug 3).
- The nudge must fire for ALL persisted events including `from_me`/self-chat (bug 2).

### R2.3 Reset endpoint (bug 7 — clean up already-duplicated data)
- `POST /api/whatsapp/reset` → deletes all `source_id='whatsapp'` rows from `events` (FTS auto-syncs via triggers), `channels`, `actors` (and any `people` rows orphaned by that), and clears `whatsapp.import_done`/`whatsapp.import_range`. KEEPS the whatsmeow session (no re-pair). Returns `{ ok:true, cleared:{ events, channels, actors } }`. After reset, status reports `importDone:false` so the UI returns to the range picker.
- UI: expose a "Re-sync from scratch" action (Inbox header overflow or a control near status) that calls `/reset` then re-runs the import flow. Confirm before wiping.

### R2.4 Daemon identity resolution (bugs 4 & 7) — NO protocol shape change, better values
- **Canonical JIDs (bug 7):** every emitted `channel_ext_id`, `actor_ext_id`, and the chat part of `external_id` MUST be canonicalized so the SAME conversation/person yields the SAME key across live vs history-sync vs reruns:
  * strip the device/agent part (`JID.ToNonAD()`), and
  * normalize LID (`@lid`) ↔ phone-number (`@s.whatsapp.net`) to a single canonical form. Pick the **phone-number JID as canonical**; when only a LID is available, resolve it to the PN via whatsmeow's LID store (research the installed version's API — e.g. `client.Store.LIDs` / `Store.ContactStore` / `GetPNForLID`-style lookup). If a PN truly can't be resolved, use the normalized LID consistently (still ToNonAD) so at least it's stable.
  * The **self chat** (messaging yourself) canonicalizes to your own PN; ensure it's one stable channel.
- **Names (bug 4):** resolve human names so the UI stops showing raw numbers/group ids:
  * DMs: contact FullName/FirstName/PushName from the contact store (`client.Store.Contacts` / `GetContact`), else the live `PushName` from `MessageInfo`.
  * Groups: the group subject via `client.GetGroupInfo(jid).Name` (cache it; refresh on group-info events).
  * Emit the resolved `name`/`display_name`; only fall back to the number when genuinely unknown (and the UI may pretty-print `+<cc>...`). Also emit an `actor`/`channel` update if a name is learned later.
- **Self / fromMe (bug 2):** confirm `from_me` messages and messages in the self chat are ingested and streamed live (not filtered out).
- Still READ-ONLY: none of this adds any send capability. Keep `go test ./...` green; add tests for JID canonicalization (LID/PN/device-suffix table) and name resolution where feasible (mock/unit).

### R2.5 Not-a-bug
- **Bug 5 (Brave dock icon with phone badge):** macOS **Handoff/Continuity** advertised by the phone's WhatsApp app (last web session was Brave). Not produced by this app — whatsmeow links as a WhatsApp "linked device" and registers no Handoff activity or URL scheme. No code change; document. (User can disable System Settings → General → AirDrop & Handoff → Handoff if unwanted.)

---

## Revision 3 — Re-link fix (empty inbox after "Re-sync from scratch")

**Root cause:** WhatsApp pushes message history to a linked device only ONCE, right after linking. The Rev-2 `reset` cleared the worker DB but KEPT the whatsmeow session, so re-import had nothing to pull (WhatsApp won't re-push history to an already-linked device) → empty inbox. On-demand history sync (`extend`) only fetches OLDER-than-known messages and needs an anchor, so it can't recover the just-wiped recent history either.

**Fix:** the user-facing "clean re-sync" must be a full **re-link** (unlink → fresh QR → WhatsApp re-pushes full history, now stored with canonical JIDs).

### R3.1 Daemon — clean logout + re-pairable
- `logout` MUST fully clear the whatsmeow session (`client.Logout()` / delete the device from the store) so the next connect has NO session and starts fresh pairing. To guarantee clean state, after clearing the session the daemon SHOULD emit `status logged_out` and then **exit 0** (let the worker restart it fresh) — in-process re-pair is error-prone; a fresh process with no session reliably yields `need_pairing` → `qr` on `start_pairing`.
- After a fresh pair, the daemon captures WhatsApp's history push and applies the active import range exactly as it does on first install (that path already works).

### R3.2 Worker — relink endpoint + treat post-logout exit as intentional
- New `POST /api/whatsapp/relink`: (1) `resetWhatsappData('whatsapp')` (clear events/channels/actors), (2) clear `whatsapp.import_done`/`import_range`, (3) send `logout` to the daemon. Return `{ ok:true }`. Status then moves to `logged_out` → (daemon restarts) → `need_pairing`.
- The adapter must treat a daemon exit that follows a `logout`/relink as INTENTIONAL: restart the daemon promptly into pairing WITHOUT flapping to a scary `error`/`reconnecting` state (a brief `starting`/`need_pairing` is fine). After restart, when the UI calls `pair`, `start_pairing` flows and QR is emitted.
- `logout` (standalone) also clears the import flags so onboarding restarts cleanly.

### R3.3 UI — "Re-sync from scratch" = re-link
- The action calls `POST /api/whatsapp/relink` (not the silent reset). Confirm copy must be honest: "This clears imported messages locally AND re-links WhatsApp — you'll scan the QR code again. Your chats then re-import fresh (fixes duplicates)."
- After relink, `paired` flips false → onboarding shows the QR screen (auto-requested per R2.1/bug1) → scan → range picker → clean import.
- "Extend history" (incremental older history, no re-link) is unchanged.
- Handle the transient state gracefully (daemon restarting): show "Re-linking… scan the QR" rather than an error flash.

**User note:** because the pre-fix build kept no recoverable history, existing users must re-link ONCE (rescan QR) to repopulate; after that, "Re-sync from scratch" reliably re-links in one click.

---

## Revision 4 — More real-device bugs (extend, business, noise)

Re-pairing confirmed Rev-2/3 fixes work on real data (real names, no duplicates). Three more issues:

### R4.1 Extend history fetches nothing (bug 15)
Widening the range (e.g. 24h→3d) must actually pull OLDER messages via whatsmeow **on-demand history sync**.
- Daemon: persist, in its OWN store (whatsmeow.db or a small state table), the OLDEST known `MessageInfo` (key + timestamp) PER canonical chat as messages are seen (live + history). On `extend{range}`, for each chat whose oldest-known ts is still newer than the new cutoff, issue `client.BuildHistorySyncRequest(oldestInfo, count=~50)` and `SendPeerMessage` it; handle the async `events.HistorySync` (type ON_DEMAND) responses, emit the older events (range-filtered), advance the per-chat anchor, and paginate until the cutoff is reached or WhatsApp returns no more. Emit `progress`/`backfill_complete` for the extend run.
- Research the installed whatsmeow's on-demand history API precisely (BuildHistorySyncRequest signature, the ON_DEMAND HistorySync event, pagination). Verify it compiles.
- HONESTY: on-demand history depends on what WhatsApp still holds server-side for a linked device; some older history may be unavailable. Real-device verification is MANUAL. Do NOT claim it works beyond what the mock + code review show; implement to spec and note the limitation.

### R4.2 Business accounts: names as numbers + messages missing (bug 16)
- **Names:** business/enterprise contacts store their name as a VERIFIED business name, not personal FullName/PushName. Extend the daemon's name resolution to also use the business/verified name (research: `ContactInfo.BusinessName`, `client.GetBusinessProfile`, or the verified-name field on the contact/message). Fall back order: FullName → FirstName → PushName → verified BusinessName → pretty number.
- **Missing messages:** business messages are often NON-plain types — `TemplateMessage`, `ListMessage`, `ButtonsMessage`, `InteractiveMessage`, `ProductMessage`, `OrderMessage`, template/button REPLY variants. If the daemon's message mapper only handles Conversation/ExtendedText/media, these are dropped → "No messages". Extend the mapper to extract display text from these business message types so they ingest (kind `message`, text = the template/body/caption/title). Verify which types the installed whatsmeow exposes.

### R4.3 Filter noise: status feed, empty chats, system spam (bug 17)
- **`status@broadcast`** (the Status/Stories feed shown as a "status" group): the daemon MUST skip it — no channel, no events. Also skip `@newsletter` and `@broadcast` list JIDs (keep normal `@g.us` groups and `@s.whatsapp.net`/`@lid` DMs).
- **Contentless system/protocol events** (the self-chat "System message" spam = e2e/security/history-sync/notification protocol messages with no user text): the daemon should NOT emit these as events. Only ingest real user-visible messages (and genuinely meaningful system notes if any carry text). Drop protocol notifications with empty text.
- **Empty chats (0 synced messages):** the worker's `listInboxChats` MUST return only channels that have ≥1 event (hide the "No messages" rows). Keep channel rows in the DB (a name may resolve before messages arrive) but don't list empty ones.

All daemon work stays READ-ONLY. Keep go/worker/UI suites green; add tests where feasible (message-type mapping table, status/system filtering, empty-chat exclusion in listInboxChats).

---

## Revision 5 — Real-device round 3: import UX, business text, reactions & replies

### R5.1 Non-blocking import (bug 1: stuck at 4% / modal re-opens)
Real accounts deliver history in phases (INITIAL_BOOTSTRAP → RECENT → large FULL sync of hundreds of chats). The blocking "Importing…" modal re-opens for the FULL phase and never dismisses (data ingests fine — it shows after an app restart). Fix (UI-led):
- After the user picks a range and starts the import, go to the **Inbox immediately** and show a **non-blocking progress banner** (e.g. "Importing… N/M chats, K messages — runs in the background") that updates from `progress` frames and clears when `progress.done`/`backfill_complete`. Messages appear live via the ingest nudge.
- NEVER re-open a blocking modal once an import has started or once `importDone` is set. Subsequent history-sync phases surface only as the banner / the "Syncing…" status pill.
- `importDone` is set on the FIRST `backfill_complete` (already implemented) so relaunch goes straight to the Inbox.

### R5.2 Business identity + real text (bug 2)
- **Verified name:** businesses (esp. unsaved OTP/enterprise senders) carry their name in the message's VERIFIED-name field, not the personal contact store. Daemon must resolve it from `MessageInfo.VerifiedName` (e.g. `info.VerifiedName.Details.GetVerifiedName()`) and use it for the channel name + actor display_name. Fallback order: contact FullName→FirstName→PushName→verified BusinessName→**VerifiedName.Details.VerifiedName**→pretty number. Verify the exact field on the installed whatsmeow `types.MessageInfo`.
- **Real template text:** the business message extractor currently emits the literal placeholder "[template message]". Extract the ACTUAL content: for `TemplateMessage` use the hydrated body (`GetHydratedTemplate().GetHydratedContentText()` / title / footer), for `ListMessage` the description/title, for `ButtonsMessage` the content text, etc. Only fall back to a short placeholder when there is genuinely no text. No event should surface a bare "[template message]".

### R5.3 Reactions (bug 3a) — daemon → worker → UI
- **Daemon:** emit a reaction as an event `kind:"reaction"` with `reply_to_external_id` = the TARGET message's external_id (`<canonicalChat>/<targetMsgID>`), `text` = the emoji (empty text = reaction removed), plus `from_me`/`actor_ext_id`/`ts`. whatsmeow delivers these via `ReactionMessage` (`Key` = target message key, `Text` = emoji). Do NOT drop reactions.
- **Worker:** migration `0003_phase1_threads` adds `events.reply_to_external_id TEXT` (+ index) and `events.reply_to_text TEXT`. Store reactions as their own event rows (kind=reaction) with `reply_to_external_id`+`text`. In `getChannelMessages`, EXCLUDE reaction rows from the message stream and instead ATTACH them to their target: each message gets `reactions: [{ emoji, fromMe, actorName }]` (join events where kind='reaction' AND reply_to_external_id = message.external_id; a later empty-text reaction from the same actor removes theirs). `listInboxChats` last-message/count and `searchEvents` must EXCLUDE kind='reaction' (a reaction is not the chat's latest "message").
- **UI:** render reactions as small emoji chips on/under the target bubble (WhatsApp style). Reactions must never appear as standalone stream bubbles.

### R5.4 Quoted replies (bug 3b) — daemon → worker → UI
- **Daemon:** when a message quotes another (whatsmeow `ContextInfo` with `StanzaID`/`QuotedMessage`/`Participant`), include `reply_to` on the event: `{ external_id: "<canonicalChat>/<StanzaID>", text: <extracted quoted text>, actor_ext_id: <canonical participant> }`.
- **Worker:** persist `reply_to_external_id` + `reply_to_text` on the message row; `getChannelMessages` returns `replyTo: { externalId, text, actorName }` (resolve actorName from the quoted actor if known).
- **UI:** render the quoted snippet as a small quoted block ABOVE the reply bubble (sender + text), like WhatsApp Web. If the quoted target isn't in the imported set, show the stored `reply_to_text` snippet alone.

### Event shape additions (daemon → worker; additive to §3)
```jsonc
{
  "...": "existing fields",
  "reply_to": { "external_id": "<chat>/<id>", "text": "quoted text", "actor_ext_id": "<jid>" } | null,
  // for kind:"reaction": reply_to_external_id carries the TARGET id, text = emoji ("" = removed)
}
```
All daemon work stays READ-ONLY. Keep go/worker/UI suites green; add tests (business text/name extraction, reaction target-ref + emoji, quoted-reply extraction, worker reaction-attach + reply persistence + reactions-excluded-from-stream/inbox/search, UI reaction chips + quoted block).

---

## Revision 6 — Real-device round 4: names-from-history, business text, range progress, extend, media preview

### R6.1 Names from history-sync (bug 1 name; also improves all imported names)
Imported chats (esp. UNSAVED businesses like OTP/enterprise senders) must take their name from the history-sync payload, which is authoritative for what the phone shows:
- Daemon `onHistorySync`: use the conversation's own name — `Conversation.GetName()` / `GetDisplayName()` — as the channel name; consume `HistorySync.GetPushnames()` (JID→pushname) to name actors. Prefer these for imported chats; keep contact-store/live resolution as fallback. (Live `MessageInfo.VerifiedName` is often NOT populated on ParseWebMessage/history messages — that's why businesses stayed numbers. `Conversation.Name` fixes it.)

### R6.2 Rich/business text extraction (bug 1 text: "[business message]" placeholder)
- **Unwrap container messages RECURSIVELY before classifying**: `EphemeralMessage`, `ViewOnceMessage`/`ViewOnceMessageV2`/`V2Extension`, `DeviceSentMessage`, `DocumentWithCaptionMessage`, `EditedMessage`, `ProtocolMessage`-wrapped edits, `FutureProofMessage`. Many real messages (incl. business) arrive wrapped; the current classifier sees an empty top-level and falls to the placeholder.
- **Always extract plain text FIRST**: `Conversation` / `ExtendedTextMessage.Text` / media captions — BEFORE any business-type/placeholder path. A business that sends plain text (most OTPs) must NOT become "[business message]".
- Keep the template/list/button/interactive extractors; only fall back to a SHORT kind label when there is genuinely no extractable text — and never the bare "[business message]" if any text exists.
- **Diagnostic:** when text still can't be extracted, log to STDERR the concrete message proto field/type name (e.g. via reflection on the non-nil `waE2E.Message` field) so we can iterate precisely next round. (stderr only — never stdout/protocol.)

### R6.3 Range progress + completion (bug 2: stuck at 12/293)
- The initial history sync delivers metadata for ALL chats (e.g. 293). For a range import, `progress.chats_total` MUST be the count of chats with activity INSIDE the range (e.g. 12 for 24h), NOT the total chat count. Derive the in-range set from the `Conversation` list (each carries a last-message timestamp) using `rangefilter`.
- Fire `progress done:true` + `backfill_complete` when the in-range chats have been imported (history-sync progress ~complete or a short quiet period with no further in-range history). The banner must CLEAR — no permanent "12/293".

### R6.4 Extend: paginate + cover all in-range chats (bug 3)
Widening the range currently only tops up already-displayed chats by one batch and doesn't reach the cutoff. Fix:
- For import/extend to range R, consider EVERY chat known from history-sync whose last activity is within R (not just currently-imported ones).
- For each such chat not yet covering the cutoff, issue on-demand history requests (`BuildHistorySyncRequest` anchored at the chat's oldest-known message) and PAGINATE backward — repeat as older batches arrive — until the chat reaches the cutoff or the server returns no more. Cap pages/chat and total in-flight requests to respect WhatsApp rate limits; process chats in batches.
- Report progress over the in-range chat set; fire done when all reach the cutoff/exhaust.
- **HONEST LIMIT:** WhatsApp only re-serves history it still retains for a linked device; some chats will bottom out early (this is why different chats stopped at different dates). Document; do not claim full coverage. Real-device verification is manual.

### R6.5 Inbox preview for text-less messages (bug 4: groups show "No messages")
- Worker `listInboxChats`: compute `lastText` from the latest non-reaction message — if it has text, use it; else a kind label: `🎥 Video`, `📷 Photo`, `🎙️ Audio`, `📄 Document`, `🔗 <link>` (or "Link"), `📍 Location`, `👤 Contact`, `🚫 Deleted`. A media-only chat must show a sensible preview, not empty.
- UI: render `lastText` as-is; only show the "No messages" placeholder when `messageCount === 0` (which, per R4.3, shouldn't appear in the list at all).

All daemon work stays READ-ONLY. Keep go/worker/UI suites green; add tests (history-sync name/pushname resolution, container unwrap + plain-text-first extraction, in-range chat-count progress + done, extend pagination coverage in mock, media-label preview).

---

## Revision 7 — Real-device round 5: latest-window paging, import completion, masked numbers

### R7.1 Chat detail must show the LATEST messages + paginate older (bug: newer messages "missing")
ROOT CAUSE: `getChannelMessages` default query is `ORDER BY e.ts ASC LIMIT @limit`, returning the OLDEST `limit` messages; the UI requests `limit:200` with no cursor. On a large chat (e.g. Subhashree, 5356 msgs) the detail pane shows the FIRST 200 (2–3 June) even though the total + preview are current. Data is intact; it's a windowing bug.
- **Worker `getChannelMessages`:** with NO `before`, return the NEWEST `limit` messages — `ORDER BY e.ts DESC, e.id DESC LIMIT @limit` then REVERSE to ascending for the response. With `before` (opaque cursor `"<ts>|<id>"` = the oldest currently-loaded message), return the `limit` messages strictly OLDER than the cursor: `WHERE e.channel_id=@channelId AND e.kind IS NOT 'reaction' AND (e.ts < @beforeTs OR (e.ts = @beforeTs AND e.id < @beforeId)) ORDER BY e.ts DESC, e.id DESC LIMIT @limit`, reversed to ascending. Keep reactions/replyTo attachment. (Compound ts+id cursor avoids dropping same-timestamp messages.)
- **UI (`InboxTab`):** on opening a chat, load the latest window and scroll to the BOTTOM (newest). On scroll to the TOP, load the next older page using `before` = `"<oldest.ts>|<oldest.id>"`, PREPEND, and preserve scroll position (no jump). Track `hasMore` = last batch length === limit; stop when exhausted. On a live ingest nudge for the open chat, refresh/append the latest so new messages appear at the bottom. Default page size ~50–100.
- The API may keep returning an ascending array; the UI derives the next cursor from the first (oldest) element. Add `id` to `InboxMessage` if not already present so the cursor can be built.

### R7.2 Import completion for large/entire imports (bug: stuck at 720/897)
WhatsApp does NOT deliver history for every chat (inactive/old chats get none), so `chats_done` plateaus (e.g. 720) below `chats_total` (897) and `done` never fires → the banner never clears.
- Daemon: fire `progress done:true` + `backfill_complete` when EITHER the history-sync server progress reaches ~100 OR no new history-sync event has arrived for a quiet window (~10–12s) after at least one batch — regardless of `chats_done` vs `chats_total`. The banner must clear on a real (large) import. Late/live batches after completion just ingest (nudge refresh); the banner must not re-open (UI R5.1).

### R7.3 Masked numbers (`+91········15`) — confirm source, display gracefully
Our code does not mask numbers (prettyPhone formats plainly). These masked identifiers are almost certainly WhatsApp's own PRIVACY-MASKED number for number-hidden / LID-only contacts, passed through as the name.
- Investigate/confirm: is the daemon emitting a WhatsApp-provided masked string (history-sync name/pushname), or is a formatter producing dots? If it's our formatter, fix it.
- Display: for a contact whose only identifier is a masked/LID value with no real name, show the best available name (history-sync Conversation.Name/pushname); if none, keep the masked value as-is (it's what WhatsApp shows) — do NOT synthesize additional masking. Optionally label LID-only unknowns cleanly. This is largely a WhatsApp privacy feature, not an app bug — verify and document.

Keep go/worker/UI suites green; add tests: latest-window default + older-page cursor (incl. same-ts boundary), completion on quiet-period, and the masked/LID display path.
