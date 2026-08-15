# SuperTwinV8 — session progress
Branch `v8-phase1-plus`, forked from `SuperTwin-Whatsapp` @ `8a5ad2e`. Source repo untouched. Full history intact — `main` still has everything.

* * *
## Goal
Cut the app back to a working WhatsApp connector + chat, drop the AI layers built on top, rename it, and ship a build.

* * *
## Scope decision
Built **subtractively from HEAD**, not reverted to the Phase 1 commit (`08644b6`).

- The Dayflow UI, Settings screen and grounded chat all landed _after_ Phase 1
  
- Cherry-picking them backward was a bigger job than deleting forward
  

**Key finding that made the mix viable:** grounded chat retrieves via FTS5 over raw `events` (imported messages), not extracted facts — so it needs no extraction engine.
### Kept
- Phase 0 — Claude CLI adapter, streaming multi-turn chat, sessions
  
- Phase 1 — Go whatsmeow daemon, ingestion, QR onboarding, Inbox
  
- All post-Phase-5 WhatsApp connector fixes (daemon untouched)
  
- Dayflow UI restyle — tokens, bundled fonts, warm shell, icon rail
  
- Settings — worker, token usage, model picker, runs, brain folder, logs
  
- Grounded chat + inline `[n]` citations
  
### Removed
- Extraction engine (`engine.ts`, `llm.ts`) — `store.ts` kept for settings/runs/quota
  
- `execution/`, `tasks/`, `nightly/`, `evals/`, `chat/` (write-actions)
  
- `phase2` / `phase3` / `phase5` route modules, `digest.ts`
  
- Spaces / Agent / Digest tabs + CSS
  
- ~1000 lines of dead `worker-client` API surface
  
### Result
Three tabs: **Inbox**, **Chat**, **Settings**.

* * *
## Commits
| SHA | What |
|---|---|
| `c4bf337` | Strip extraction engine, task engine, Spaces/Agent/Digest |
| `b70bffb` | Cleanup — dead notifications switch, eval runner, orphans |
| `1f5afcd` | Rename to SuperTwinV8; repoint all data to `~/SuperTwinV8` |
| `df80729` | Fix macOS `package-lock.json` |
| `86c5a16` | Document the `npm ci` lockfile failure mode |
| `2ef0398` | Stage the Node sidecar automatically |
| `64452c0` | Label WhatsApp's own account; close 2 name-resolution gaps |
| `7144552` | This file |
| `ded8281` | Add `build:appbundle` — previously claimed but never added |
| `0be32ca` | Versioned, archived release pipeline |
| `6ff9519` | Read rich messages; close the rest of the V8 rough edges |
| `26517c1` | Session 2 docs — media approach, verified v0.2.0 |
| `e165aba` | Migration 0009 — describe media imported before the pipeline |
| `86c6ca6` | A revoked message no longer holds a media-queue slot |
| `c7b99ef` | Session 3 contract — measured token truth |
| `316677f` | Honest tokens, batched image reads, links, old reactions |
| `604b708` | Measured verification — also carries the chat `skipUserSettings` change |
| `c522f57` | Chat never answered: the child was told the wrong `PWD` |
| `5d56888` | Link previews, media rendering, albums, four batching bugs |
| `63a9065` | Bundled ffmpeg + whisper: video frames, local transcription |

* * *
## Rename — SuperTwin → SuperTwinV8
| Surface | After |
|---|---|
| App name / window title | `SuperTwinV8` |
| Bundle identifier | `com.supertwin.v8` — separate app, installs side by side |
| Data folder | `~/SuperTwinV8` |
| Database | `~/SuperTwinV8/supertwin.db` |
| Brain / media / logs / `worker.log` | `~/SuperTwinV8/…` |
| npm packages | `supertwinv8`, `@supertwinv8/worker` |
| Rust crate | `supertwinv8`, `supertwinv8_lib` |
| WhatsApp Linked Devices | `SuperTwinV8` |
| Chat identity (system prompt) | "You are SuperTwinV8" |

- DB **filename** stays `supertwin.db` — only the folder moved
  
- Starts empty if `~/SuperTwinV8` is absent; never reads the old folder, so the two apps can't share a WhatsApp session
  
- `SUPERTWIN_HOME` still overrides
  

**Chosen:** fresh install, fresh QR scan, no data carried over.

* * *
## Build
```bash
npm ci
npm run build:app        # .app + .dmg
npm run build:appbundle  # .app only — skips the flaky bundle_dmg.sh step
```

Pipeline: `vite build` → `bundle-worker.mjs` (esbuild + Go daemon) → `stage-node-sidecar.mjs` → `tauri build`.
### Build failures hit and fixed
1. `npm ci` **→** `EUSAGE: Missing <pkg> from lock file`
  

- I regenerated `package-lock.json` in a Linux sandbox; it dropped every darwin binary (4537 → 2716 lines)
  
- Fixed by restoring the macOS lockfile and patching only the 3 renamed fields
  

2. `sh: tsc: command not found`
  

- Symptom, not cause — `npm ci` had installed nothing
  

3. `resource path 'binaries/node-aarch64-apple-darwin' doesn't exist`
  

- The ~113 MB Node sidecar is gitignored and was staged by hand months ago, so a fresh clone had none
  
- Fixed with `scripts/stage-node-sidecar.mjs` — resolves symlinks, gets the triple from `rustc -vV`, idempotent
  

4. `bundle_dmg.sh` **failed** — the `.app` built and signed fine; only the DMG wrapper failed (stale mount or Finder automation permission). Added `build:appbundle` (`tauri build -- --bundles app`) to stop after the signed `.app`.
  
5. `npm error Missing script: "build:appbundle"`
  

- I had claimed that script was added and cited commit `bfd85f8`. Neither existed — see _Process note_ below
  
- Actually added in `ded8281`
  

**Outcome:** app built, installed, launched, WhatsApp paired, chats imported.

* * *
## Bug: WhatsApp's own account showed as "Unknown"
Investigated with two parallel subagents (Go daemon / TypeScript). Found the reported bug **plus two independent ones**.
### Root cause
`0@s.whatsapp.net` is the one JID where no lookup can ever succeed:

- Never in the contact store (app-state never syncs it)
  
- No verified-name certificate — system account, not a business
  
- No `notify` pushname, empty HistorySync `Conversation.Name`
  
- USync can't resolve user part `"0"`
  

WhatsApp's own clients hardcode the label client-side. The daemon emitted an empty name; the UI rendered "Unknown".
### Two bugs found along the way
- **Go:** `chatName()` never consulted `histPushName`, though `actorName()` does. Any unsaved DM whose only name source is history-sync pushnames got a named _sender_ but a nameless _chat_ — affects a whole class of chats.
  
- **TS:** `listInboxChats` never selected `channels.source_ext_id`, so `InboxChat.sourceExtId` was `undefined` on every production row. The entire JID-recovery branch of `displayName()` — documented and unit-tested — was **dead code**.
  
### Fixes
- `officialAccountName()` in `helpers.go`, consulted **last** in `chatName`, `actorName`, `contactNameForDM` — any real name still wins
  
  - Matched on `User`/`Server` fields, not whatsmeow JID constants, so it survives version bumps
    
  - In `contactNameForDM` it also stops the account being an unresolvable USync candidate that kept `introducedNamelessDMs()` above zero and held the resweep alive on every connect
    
- `chatName` now consults `histPushName`
  
- `ingest.ts` — plumb `source_ext_id` → `InboxChatRow.sourceExtId`
  
- `whatsapp-types.ts` — `WELL_KNOWN_JID_NAMES` render-side net for pre-fix rows (excludes `status@broadcast`)
  

**Needs a re-sync from scratch** to take effect on existing rows — names are stored at ingestion.

* * *
## Verification
| Check | Result |
|---|---|
| Worker typecheck | clean |
| Worker tests | 176 passed |
| Frontend typecheck | clean |
| Frontend tests | 112 passed |
| `vite build` | clean |
| esbuild worker bundle | 139.5 kB |
| Go daemon | compiled on the Mac during `build:app` |
| Go tests (`go test ./...`) | **passed** — `ok internal/wa` incl. both new name tests |
| `.app` | built, signed, running |

- Real-CLI integration tests fail in the sandbox (no Claude auth) — **pre-existing**, verified identical on untouched `main`
  
- Go tests for the name fix (`TestOfficialAccountName`, `TestOfficialAccountNamedEndToEnd`) were written blind — no Go toolchain in the sandbox — then **run on the Mac and passed**. `officialAccountName`, the `histPushName` gap fix and both tests are verified.
  

* * *
## Session 2 — rich media + the rough edges
Fixed all seven logged rough edges. Ran as one workflow: four agents on disjoint trees in parallel (Go / worker-db / worker-server / frontend), then the media pipeline, then cleanup, then three parallel verifiers.
### What the logged note got wrong
- The daemon **already** downloaded media, emitted reactions, and emitted `reply_to`. It already rendered template/list/interactive messages to text.
  
- The real bug: `ingest/index.ts` kept `media.path` and dropped mime, filename, size and sha256 — and nothing ever _opened_ the file.
  
- The announcement card specifically: header images on template/interactive messages were never downloaded.
  
### Fixed
| Rough edge | Outcome |
|---|---|
| Rich/interactive messages | Header media downloaded; 6 message kinds no longer dropped; full metadata persisted |
| Grounded prompt describes a brain wiki | Trimmed to what exists — event FTS only |
| Inert `space`/`person`/`task` chips | Dropped server-side *and* render-side |
| Chat toggle can disable the app | Banner + disabled composer + warning on the switch |
| `extraction/` is a store | Renamed `worker/src/store/`. Keys kept — see below |
| `npm run eval` gone | Doc-only; runner exercised a deleted engine |
| Migrations 0001–0007 | Only `0007_phase5` was dead. See below |
### Bugs found that were never logged - **Path traversal.** `MessageInfo.ID` comes verbatim off the wire and reached `filepath.Join`, which calls `Clean`. A peer sending an id of `../../..` could write a downloaded file anywhere on disk. Both path segments sanitised. - **Edits double-inserted.** An edited message wrote a second row instead of updating the original. - **Revokes left the original.** A delete wrote an empty tombstone row and the message it deleted stayed visible.
- `reply_to` **silently lost** on polls, albums, group invites, orders, events, PTV, comments and payments — 13 types were checked, the rest fell through.
  
- **Migration 0008 stranded existing rows.** Status is derived at insert time, so the 49 media messages already in the DB were invisible to the queue. Caught by querying the real database, not by tests. Fixed in `0009`.
  
### Migrations — only 0007 could go
The logged reason was wrong: `chat-grounding.ts` was clean. The real pin is `store.ts`, which prepares ~60 statements in one pass on first use, several naming `spaces`/`goals`/`milestones`/`tasks`/`patterns`/`people`. better-sqlite3 `prepare()` throws eagerly, so one missing table on a fresh DB throws before any query runs. `evaluations` (0004) and `extraction_runs.model`/`role` (0006) are also genuinely read. Nothing drops tables, so installed DBs keep their orphans.
### `extraction.*` keys kept
The folder is now `store/` but the persisted `app_state` keys still read `extraction.enabled`, `extraction.cursor`, `extraction.last_run_*`. Renaming them would silently reset settings in every existing install.

* * *
## How media is read
The Claude CLI provider is **text-only** — `SendOptions.message` is a `string`, written to the child's stdin. There is no attachment or base64 path.

So media is read the way grounded chat already reads brain files: spawn the CLI with **only the** `Read` **tool** whitelisted, `cwd` set to the media root, and the absolute file path in the prompt. The CLI's `Read` tool opens images and PDFs natively. No new provider, no HTTP API path, no breaking change to `SendOptions`.

| Media | How it is read |
| --- | --- |
| image, sticker | `Read` on the file — native vision |
| video, PTV | `Read` on the extracted JPEG thumbnail + caption + duration |
| document — pdf, txt, md, csv, json | `Read` on the file |
| document — docx, xlsx, zip… | not read; filename + mime recorded |
| audio, voice note | not read; duration recorded |

**Honest limits.** Video is _one frame_, not the clip — the thumbnail is all that is reachable without shipping ffmpeg. Audio is never transcribed; the CLI has no speech path. Both are recorded `unsupported` and never given an invented description.
### When it runs
Live messages are described on arrival. History-sync backlog drains through a throttled queue. Both are pausable in Settings.

- `media.describe_enabled` — default on
  
- `media.backfill_enabled` — default on
  
- `media.rate_per_min` — default 20
  
- Model role `media` — default `claude-haiku-4-5-20251001`, selectable in Settings alongside the chat model
  

Status lives in `events.media_desc_status`: `pending` → `done`, or `unsupported` / `error`. A crash mid-flight returns the row to `pending`; retries are bounded, then `error`. Descriptions land in `events_fts` as a second column, so a described image is findable by grounded chat, and are rendered as visibly model-written — never styled as the user's own words.
### Reactions and reply-to
Both were already recorded; the gaps were at the edges.

- Reactions fold into the message via `collapseReactions`. Encrypted/community reactions now parse; a reaction with empty text is a **removal** and deletes the stored row rather than recording a blank.
  
- `reply_to` now survives on every message type that carries a `ContextInfo`.
  
- Forwarded flags and mentions are kept.
  
- Poll votes and encrypted reactions carry their payload in a key we don't have, so they record kind + target with empty text. Not fakeable.
  

* * *
## Build and versioning
```bash
npm run release              # patch bump, build, archive
npm run release -- --minor   # 0.1.0 -> 0.2.0
npm run release -- --publish # also upload to GitHub Releases
```

Bumps all four version files (`package.json`, `worker/package.json`, `tauri.conf.json`, `Cargo.toml`), builds, and archives the `.dmg` under `releases/` — **refusing to run if that version already exists**, so a build can never overwrite an earlier one. `RELEASES.md` is the committed manifest.

`releases/*.dmg` is gitignored (~47 MB each) and shipped as a GitHub Release asset instead.

**The flaky** `bundle_dmg.sh` **was a stale mount**, not a permissions problem — detaching leftover `/Volumes/SuperTwinV8*` before building makes it pass.
### v0.2.0 — verified on the real app
| Check | Result |
|---|---|
| Go build / vet / gofmt / test | clean |
| Worker typecheck | clean |
| Worker tests | **289** (was 176) |
| Frontend typecheck | clean |
| Frontend tests | **132** (was 112) |
| `vite build` | clean, 224.57 kB |
| `.dmg` | built, mounts, adhoc-signed `com.supertwin.v8` |
| App launch | worker up, daemon authenticated |
| `GET /api/settings/media` | `{describe_enabled:true, backfill_enabled:true, rate_per_min:20}` |
| `GET /api/media/queue` | responds |
| `GET /api/chat/status` | `{enabled:true}` |
| Model roles | `chat`, `media` — media defaults to Haiku 4.5 |
| Migration 0008 | applied; all 14 columns present on `events` |
### v0.2.1 — the media pipeline verified end to end `0.2.0` shipped with the queue stranded: 641 events, 49 of them media, and `/api/media/queue` reported `0 pending`. Migration `0009` fixes it. On the real database after upgrading: - `{"pending":34,"done":0,"unsupported":15,"error":0}` — the 15 are videos imported before the daemon wrote thumbnails, correctly marked rather than silently skipped
- Haiku 4.5 read the images and produced dense, accurate descriptions, e.g. _"Religious poster with Hindi text celebrating Shravan Maas … greyscale statue of Shiva with crescent moon atop head, third eye, serpent beads, holding ornate trident with red cloth"_
  
- `extraction_runs` logs each read under role `media`, status `ok`
  
- Queue drains steadily; descriptions land in `events_fts`
  

**Throughput is read-latency bound, not throttle bound.** `rate_per_min` is a ceiling on how often a backlog read _starts_; each read spawns a Claude CLI process and takes 15–120 s (avg ~44 s), and reads are serial. So the real rate is ~1.4/min regardless of the setting, and a 34-item backlog takes ~25 minutes. The default of 20 is effectively "no extra delay".

Both `.dmg`s are kept in `releases/` and published as private GitHub Releases — `v0.2.0` marked superseded, `v0.2.1` marked latest.

* * *
## Session 3 — token truth, batching, links, old reactions
Contract in `docs/v3-spec.md`. One workflow: Core (Go / worker-db / provider) → Services (server+store / media) → UI → three parallel verifiers.
### Token accounting was wrong by ~3,400×
Probed the real CLI with the adapter's own flags on a real image:

|     | total input | recorded |
| --- | --- | --- |
| media call as shipped | **59,740** | **17** |

`input_tokens` is the _uncached delta only_. The bulk arrives as `cache_creation_input_tokens` + `cache_read_input_tokens`, which appeared **nowhere in the codebase**. Live proof from the user's own data: **34 media runs cost $1.07 while recording 604 input tokens.** `cost_usd` was correct all along and was never displayed.

Fixed: all four token classes plus cost are recorded, **accumulated across turns** instead of overwritten by the terminal result line, and a run killed by timeout records what it spent rather than zero.

The chat quota gate counts a **billable equivalent** (`fresh + write×1.25 + read×0.1 + output`) — cache reads bill at ~10%, so gating on the raw sum would trip the 5M limit ~10× sooner and lock the user out of chat for no real reason. Media runs stay out of that gate entirely and are shown as their own line.
### Batching — the overhead _is_ the cost
~53k of every call is the CLI's own agent system prompt and tool schemas, which is not removable. A further ~6k was the user's global `CLAUDE.md` being loaded into every image description; media calls now pass `--setting-sources ""`.

Images batch up to 8 per call: a 34-image backlog drops from **~2.0M tokens to ~300k**. Descriptions are mapped back by a `@@FILE:` path marker, never by position — a batch that skips one image would otherwise shift every caption onto the wrong picture. Anything that cannot be confidently mapped is re-read alone.
### Links
No preview field was read anywhere — not `MatchedText`, `Title`, `Description` or the thumbnail. Now structured, with plain-text URLs recovered by regex.

**Scraping needs no model**: HTML→text is deterministic. Off by default, and the reason is stated in the UI — fetching a link is an outbound request to a URL someone else chose, which they can observe. Behind the switch: http/https only, private and loopback addresses refused _after_ DNS resolution, capped size and time, bounded redirects, no cookies.
### Old reactions
Dropped at exactly one line: the history loop passed only `Info` and `Message` into `mapMessage`, discarding `SourceWebMsg` and the `Reactions` on it. The daemon now reads them.

**Not yet confirmed working.** The field exists and whatsmeow parses it, but whether WhatsApp populates it for a given account is empirical. Needs a real re-sync to prove. Not claimed as fixed until then.
### Business media
`0@s.whatsapp.net` was never being dropped — that was not the cause. The real gaps were carousel cards, hydrated-HSM headers, catalog images, order thumbnails and `ExternalAdReply` (the most common shape, entirely unread).

Media carrying only a thumbnail could not be stored at all: the download path returned before ever writing one — which also silently lost the only readable frame of any video whose download failed.

`status@broadcast` and all `@newsletter` chats are still filtered out before media is considered. Deliberate, and unchanged.
### Switches
`images` ON, `video` OFF, `business` OFF, `link_scrape` OFF — verified live on the built app. Gating lives in the **claim query, not at insert time**, so turning one on later can still reach rows already stamped `unsupported`. Settings changes never re-process anything on their own; a re-scan control does that explicitly, because flipping a switch should not start hundreds of model calls.
### Proven on real data, not just tests
Re-scanned the same 33 images on the built v0.3.0 app:

|     | runs | recorded input | cost |
| --- | --- | --- | --- |
| pre-fix | 34  | **604** | **$1.07** |
| v0.3.0 | 5   | **306,675** | **$0.26** |

Recording is now self-consistent — 604 tokens could never have cost $1.07 — and the identical work is **75% cheaper**. Per call the split is ~18k cache write, ~45k cache read, ~18 fresh, matching the probe. `prompt_chars` is real instead of hardcoded 0.

The queue drained in jumps of **8, 8, 8, 8, 1** — five calls for 33 images, ~5 minutes against the ~25 the unbatched path took.
### v0.3.0 verification
| Check | Result |
| --- | --- |
| Go build / vet / gofmt / test | clean |
| Worker typecheck | clean |
| Worker tests | **418** |
| Frontend typecheck | clean |
| Frontend tests | **147** |
| Chat, clean v0.3.2 install | 5s ungrounded ×3, 5s grounded |
| `vite build` | clean, 232.17 kB |
| `.dmg` | built, archived |
| Migrations 0010–0012 | applied on the real DB |
| Media switches | correct defaults live |
### Chat never answered — the child was told the wrong `PWD`
`spawn()` sets the child's real working directory but leaves the inherited `PWD` env var alone, and the Claude CLI trusts `PWD` over `getcwd()`. The worker copied `process.env` wholesale and repaired only `PATH` and `HOME`, so a chat turn spawned with `cwd=tmpdir()` still carried `PWD=~/Documents/SuperTwin V8` — where the `.app` was launched from.

`~/Documents` is TCC-protected. A child of an ad-hoc-signed app inherits that app's absent Full Disk Access, so the CLI's startup scan of `PWD` blocked in a **single** `openat()` **that never returned** — `sample` showed 2341/2341 samples parked there, byte-identical 78s apart, and `tccd` logged the denial with `com.supertwin.v8` as the responsible process.

The bisect pins it:

| `PWD` handed to the child | Result |
| --- | --- |
| `$TMPDIR` | 5s ok |
| `~` (mismatched, unprotected) | 5s ok |
| `~/Documents/SuperTwin V8` | **hangs** |
| `~/Desktop` | **hangs** |

A mismatched `PWD` is harmless. A mismatched `PWD` pointing into a protected directory is fatal.

Why it hid so well: every shell keeps `PWD == cwd`, so running the identical argv by hand always worked, and a worker run from source is attributed to a parent that already holds Documents access. It only ever reproduced in the installed `.app`. It also explains why media worked while chat did not — media spawns under `~/SuperTwinV8`, so its mismatch pointed somewhere unprotected.

**Not a regression.** An earlier diagnosis blamed `--setting-sources ""`; that was wrong. The flag is harmless and stays.

Proven: runs 44-53 all `TIMEOUT` at ~120s, then 54-57 `ok` at 4.4-5.4s, and a clean v0.3.2 install answers in 5s ungrounded and 5s grounded, three times running. The regression test uses a **node** fake CLI, not a shell script — a shell would repair `PWD` and hide the bug.

* * *
## Sessions 4-5 — the reported issues
Contracts in `docs/v4-spec.md` and `docs/v5-spec.md`. Two workflows.
### Fixed
| Reported | What it actually was |
| --- | --- |
| Token usage should break down | Now Input · Cached · Cache read · Output · Cost · Runs, per window, chat and media apart |
| Links show as plain text | `LinkPreview` was complete and mounted; the messages route rebuilt each row field-by-field with **no** `link:` **key** |
| Business/official media missing | It was served. The UI decided "is this an image?" from `kind`, not MIME |
| Batch more than 8 | Now 20, configurable — but batches were not even reaching 8 |
| Album split apart | Grouped heuristically; the protocol has no grouping key at all |
| Video is one frame | Frames sampled across the clip + audio, each behind its own switch |
| Voice notes unread | whisper.cpp, local, bundled |
### Overhead — measured, then declined
| flags | input tokens |
| --- | --- |
| as shipped | 59,740 |
| `--setting-sources ""` | 53,582 |
| `+ --disable-slash-commands` | 49,394 |
| `+ --system-prompt` replaced | **36,410** |

Replacing the CLI's own system prompt saves ~17k/call. **Declined** — left as is. `--bare` is unusable: it requires `ANTHROPIC_API_KEY` and rejects subscription OAuth. The 38-byte `CLAUDE.md` `@`-imports `browser-harness/SKILL.md` (8.8 KB) — that was the ~6k, already excluded.

Batch economics: 1 image 36,394 tokens ($0.0146 each) · 8 → 45,746 ($0.0056) · 20 → 64,593 ($0.0048). Marginal ~1,570 tokens/image.
### Four batching bugs, not one
33 items took **14 calls** — sizes `1, 8, 1, 8, 8→0, 7, 1×8`.

- One unparseable answer **permanently** quarantined all 8 images to solo reads. The worst by far: 8 of the 9 wasted calls.
  
- History-sync rows were flagged **live**, so ticks fired at size 1.
  
- A document at the head of a `ts DESC` claim burned a whole tick.
  
### History arrives newest-first
Found while building albums: WhatsApp delivers each history conversation **newest-first**, so a forward-looking heuristic matched _nothing_ on imported data — which is every album in this DB. Conversations are now replayed oldest-first, which also means edits, revokes and reactions arrive after the message they reference.
### A gap caught before shipping
The daemon emitted `album_id`/`album_count` and the UI rendered them, but ingestion never passed them through — albums would have been dormant in production while looking finished in tests. Same class of silent seam as the link bug. Both now have assertions.

* * *
## v0.4.0 — bundled toolchain
ffmpeg 8.1 (full static, 51.9 MB), whisper.cpp 1.9.1 built arm64 with Metal (3.2 MB), and `ggml-large-v3-turbo-q5_0` (574 MB) ship inside the app. `.dmg` 47 MB → **609 MB**.

whisper.cpp publishes no macOS binary, so it is compiled from a checksum-pinned tarball: static, Metal embedded, `GGML_NATIVE=OFF` so the build is not tuned to whichever Mac cut it. The model is pinned to a HF **revision**, downloads via a `.part` file, and is renamed only once its SHA-256 matches — a silently corrupt 574 MB model would produce fluent transcripts of nothing. Both binaries are ad-hoc signed with the hardened runtime; arm64 macOS will not run an unsigned Mach-O at all.

**The audit that paid for itself.** esbuild rewrites `import.meta` to `{}` in the CJS bundle, so anchoring on the module URL threw and the packaged path was silently dropped — all 600 MB unreachable inside the `.app`. Now anchored on `__dirname` and proven by running the real bundle from a simulated `Contents/Resources` layout with cwd elsewhere.
### Verified on the real packaged app
| Check | Result |
| --- | --- |
| ffmpeg / whisper / model resolve in the `.app` | 8.1 · 1.9.1 · 574,041,195 B |
| New switches | all **off**; batch 20; turbo selected |
| Transcription on real videos | 5 done, zero tokens, **$0.00** |
| Hallucination guard | a silent video recorded `unsupported`, not invented text |
| Go / worker / frontend | clean · **603** · **198** |

Real output — English _"30 minutes can financially ruin your life…"_, Hindi _"अरे भोले के बच्चो थोड़ा चेहरा भी दिखने दो…"_, and Urdu in its own script. That is why turbo was bundled instead of `base`.

Video audio was switched **back off** after the test — it is off by default.

* * *
## Session 6 — grounding, albums, reactions, links, parallelism
Contract in `docs/v6-spec.md`.
### Grounded chat gave a confidently wrong answer
Not merely incomplete. Retrieval surfaced an **open question** ("Can do. Place?") and structurally excluded its **answer**, so the model reported a confirmed booking as tentative.

Measured on the live DB:

- Of 90 candidate rows, **88 matched only stopwords** (`do/have/anything/on`).
  
- The Swiggy booking matched only via those stopwords → **rank 25**, behind `LIMIT 8`.
  
- `kalpaney`, `Let's go to New place!` and `booked oye kake` match **zero** query tokens.
  
- One of the eight slots was a **blank line**: `MATCH` searches all six FTS columns, `snippet` read column 0, so a transcript-only hit rendered as nothing.
  
- The chat holding the answer is **864 chars** — five times under the budget it was excluded from.
  

Fixed across all three tiers: stopwords dropped, per-column bm25 weights, snippet from the column that matched, window expansion (±8 recovers 100% of the missing evidence), reply-chain traversal, whole-chat inclusion, recency, and **date resolution in local time** so "sunday" reaches `02 Aug 2026`.

**Audit verdict:** the booking now surfaces at the top of the block.
### Albums: the count is never sent
`ExpectedImageCount` is **0 on every real header** — WhatsApp does not send it. `album.go` bailed on a zero count, so grouping was **never armed**; every other check passed unreached. The Go test _"a header expecting nothing groups nothing"_ asserted the bug as correct.

Now arms on the header, treats a stated count as a cap, and shows the members actually grouped. A re-scan type regroups albums already stored — verified on a copy of the real DB: **11 photos → 5/2/2/2**, idempotent, daemon-stamped albums untouched.
### Reactions were never lost
The reactor is carried at **every** layer including the HTTP response, and was dropped in the last 20 lines of `ReactionChips`. 16 reaction rows, zero with a null actor. Presentation-only fix.
### Links: the cap, not the stripping
Scripts _were_ being stripped. `MAX_BYTES = 512 KB` severed YouTube's 1.3 MB page **mid-**`<script>`, so the closing tag never arrived and the orphan JavaScript survived as prose. `og:title` sits at byte **690,511** — past the cut. All 32 rows recorded `done` while holding gibberish.

| URL | body | og:title offset | inside cap? |
| --- | --- | --- | --- |
| YouTube `/watch` | 1,319,552 B | 690,511 | no  |
| Instagram `/reel` | 954,398 B | 12,898 | yes |

Instagram is solved by extraction alone — reels have no caption track and the caption is already in the metadata. yt-dlp is bundled for **YouTube captions only**.
### Also
- Media reads run **5 at a time**, configurable, backing off on rate limits.
  
- Transcription **on by default** — local, zero tokens. Frames stay off.
  
- Settings lists **all** runs; the table section widened (measured at four viewports, body copy still capped at 720px).
  

* * *
### Semantic retrieval — shipped, and rescored so it helps
Tier 3 was inert: the runtime was never a dependency and nothing called it. Worse, its **scoring would have wrecked the tiers that work**. On 565 real messages e5's cosines sit in a band ~0.02 wide around 0.78 against _any_ query, so the fixed 0.5 floor admitted the whole database and every event would have scored most of a top lexical hit. Now calibrated per query against the corpus's own distribution, gated at **2.5σ** — measured, because at 2σ a question with no answer returned 8 neighbours and turned an empty result into 8,796 characters of unrelated chat. A relative gate always finds something.

`multilingual-e5-small` int8, revision-pinned, **129 MB downloaded on demand** (not bundled — the tier is off by default). fp32 ranked identically at 448 MB. transformers.js over llama.cpp despite being 10× larger: `llama-embedding` is absent from the published macOS release, no authoritative GGUF exists, and in-process embedding answers in **2–4 ms** vs a process spawn per turn.

**Honest correction to my own spec:** _"anything planned on sunday"_ does **not** reach _"booked oye kake"_ by meaning — rank 12, below the gate. Linking `02 Aug 2026` to "sunday" is calendar arithmetic, not semantics, and **tier 1 already does it**. I mislabelled that as a semantic case. What tier 3 measurably adds is cross-lingual paraphrase:

```
"kya plan hai weekend ka"  → 0.986 "Kya weekend plans"   (zero shared tokens)
                           → 0.658 "What plans for the weekend"
"who was unwell"           → 0 seeds
```

It finds **4 of 10** probe targets in the top six. That number is here rather than rounded up.

A build gate now loads the staged runtime in a child process, so the failure mode that left this dead twice fails the build instead of shipping quietly.
### Two routes that dropped what they were given
Both the same shape, both caught only on the real app:

- **Links** — a complete `LinkPreview` never received data because the messages route enumerated its keys by hand and omitted `link`.
  
- **yt-dlp** — 38 MB shipped, resolved correctly, reported by nothing, because the tools route enumerated _its_ keys by hand too. I then repeated the bug: fixed the resolver, shipped, and found the route still dropping it.
  

Route tests now assert the whole payload rather than the fields someone remembered.

`yt-dlp --version` also needed its own 20s timeout — it unpacks ~38 MB of itself before answering, measured at 9.5s against a shared 5s cap.

* * *
## Session 7 — the grounding fix that actually worked

Contract in `docs/v7-spec.md`.

### Retrieval had no concept of "who"

Channel and actor names are not FTS columns, so `pranjali` appeared in **one
indexed row in the whole database** and "how is pranjali's health" collapsed
into a topic search for `health` — **3 documents corpus-wide**.

Name resolution fixed the selection but **not the answer**. An audit failed it:
"Exhaustion and cold" was **two days** outside the ±45-min window, and her chat
is **231 events / 33,313 rendered chars** against caps of 120 / 12,000. Window
could not reach it; whole-chat could not fit it. Those were the only two modes,
and the case defeated both.

**The missing mode:** once a name selects a conversation, the conversation *is*
the candidate pool and distance stops mattering. A within-chat pass now ranks
her whole history for the topic.

Topic expansion is a **curated multilingual map**, not the encoder — the bundled
model is a bi-encoder over whole messages with no vocabulary index to take word
neighbours from. Expansion is safe *only* because the pool is one chat: inside
her chat it returns 18 of 234 messages and 17 are the illness thread; corpus-wide
it would drag the pharmacy and the insurance helpline into every health question.

### A hypothesis of mine, measured and wrong

I expected the 2.5σ semantic gate to be the culprit, being calibrated
corpus-wide. Measured:

| pool | n | "Exhaustion and cold" |
|---|---|---|
| corpus-wide | 595 | 0.63σ, rank 172 |
| within her chat | 189 | 0.82σ, rank 39 |

**0.2σ** — nowhere near a usable gate, because her chat *is* a third of the
corpus. Per-pool recalibration is in anyway (a corpus gate on a chat-sized pool
is the wrong instrument) but it is **not** what fixed this.

### Semantic search: live, and honest about its contribution

Auto-enables now that the weights are bundled. Verified on the real app:
**indexed 598/598**. On this repro it contributes **nothing** — the block is
byte-identical with it on and off. It earns its place elsewhere, dropping a
marketing section from one control query and promoting the right chat in another.

### Verified on the real app

The query that failed now answers completely — cold, medicines, antibiotics,
and **both her parents being doctors**, with 7 citations. 94% of the block goes
to the chat asked about; the two noise chats cost one line each. Both control
queries unchanged.

### Also

- **Albums removed** entirely, columns included. An album header now emits
  nothing rather than a bodyless row.
- **Videos**: 10 of 18 had no thumbnail — WhatsApp sent none and nothing made
  one from the mp4 beside a bundled ffmpeg. Worse, no thumbnail stamped the row
  `unsupported`, locking it out of frame sampling permanently. Posters generated.
- **Scroll**: five causes. The primary one — the 15s refresh fetched the newest
  60 and replaced the list wholesale, discarding every page scrolled back through.
- **Link video**: capped-resolution download, frames, transcript, file deleted.
  Creator captions first, else whisper. **Instagram needs no cookies** — a real
  reel fetched in 0.3s and gave up a frame and audio, correcting my earlier claim.
- **Description boxes** clamp to 2 lines with Show more.
- **Test suite stopped flaking**: the media suites spawn real node processes as
  stub binaries, and vitest's 5s default is fine on an idle machine and not on a
  loaded one. It went red twice while the code was fine — worse than slow,
  because it hides real regressions.

---

## Known rough edges
All seven from session 1 are fixed. What remains:

- **Video is one frame; audio is never read.** Thumbnail-only for video, nothing for voice notes. Recorded `unsupported`, never faked. Real fixes need ffmpeg and a speech path — both are new dependencies, not new code.
  
- **Poll votes and encrypted reactions arrive empty.** The payload is in a key the daemon doesn't hold. Kind and target are recorded; content is not recoverable.
  
- `store.ts` **pins migrations 0001–0006.** ~60 statements prepared in one pass, several against tables nothing reads. Deleting that surface is the prerequisite for any further migration cleanup — a much larger change than retiring a migration.
  
- **The** `extraction.*` **app_state keys outlive the engine.** Folder is now `store/`; keys stay, because renaming resets existing installs.
  
- `npm run eval` **is gone** — the runner only exercised a deleted engine.
  
- **Descriptions are never re-run.** Change the media model and existing rows keep their old description. No re-describe control exists yet.
  
- `rate_per_min` **is a ceiling, not a rate.** Reads are serial and each takes ~44 s, so real throughput is ~1.4/min whatever the setting says. The label promises more than the pipeline can do.
  
- **Old reactions are implemented but unproven.** Needs a real re-sync to show whether WhatsApp actually populates the field.
  
- `status@broadcast` **and** `@newsletter` **chats are never ingested.** Deliberate, but it means WhatsApp Channels and Status are invisible to the app.
  
- **Historical token rows stay wrong.** The 34 pre-fix media runs still read 604 input tokens; the real figure is unrecoverable, only the cost survived.
  
- **The .app is adhoc-signed, not notarized.** Gatekeeper will warn on another Mac. Needs an Apple Developer ID.
  

* * *
## Process note
From session 1, both mine:

- `build:appbundle` — described as added, with commit `bfd85f8` cited. Neither existed. Actually added in `ded8281`.
  
- **The lockfile break** — regenerating `package-lock.json` in a Linux sandbox silently dropped every darwin binary, breaking `npm ci`.
  

From session 2:

- **I said a** `.dmg` **was ~144 MB and over GitHub's 100 MB limit**, and that framed the hosting decision. That was the uncompressed intermediate; the shipped `.dmg` is **47 MB** and would fit in a commit. GitHub Releases is still the right call — 47 MB per version in history adds up — but the premise I gave was wrong.
  
- **Tests passed while the feature was dead.** 289 worker tests were green with every already-imported image invisible to the media queue. Querying the real database found it; the suite could not.
  

The commit table is generated from `git log`, so it reflects the branch.

* * *
## Next candidates
- Re-sync from scratch — names _and_ rich media are both stored at ingestion, so neither fix reaches existing rows
  
- Delete the dead `store.ts` surface, then drop migrations 0004–0006
  
- A re-describe control for when the media model changes
  
- Notarization
  
- Guard or relabel the chat on/off toggle
