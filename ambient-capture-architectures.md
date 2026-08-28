# Ambient Capture Architectures

**Six systems, traced from source: capture → ingestion → storage → processing → organisation → output.**

| # | System | Repo | Stack | Thesis |
|---|---|---|---|---|
| 1 | screenpipe | `screenpipe/screenpipe` | Rust | Record everything, reason never |
| 2 | omi | `BasedHardware/omi` | C + Dart + Python | Wearable ear, cloud brain |
| 3 | dayflow | `JerryZLiu/dayflow` | Swift | Your day as a picture book |
| 4 | vellum-assistant | `vellum-ai/vellum-assistant` | TypeScript/Bun | Memory as a hand-edited wiki |
| 5 | commit | `mitensampat/commit` | Go | One source, one atom: the promise |
| 6 | localbird | `littlebirdai/localbird` | Swift + TS + C# | Counterexample — capture without gates |

---

## 1. The universal shape

All six collapse to the same six-stage spine. What differs is **where the expensive step sits** and **what the atomic unit of memory is**.

```
  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐
  │ CAPTURE │─▶│ INGEST  │─▶│  STORE  │─▶│ PROCESS │─▶│ ORGANISE │─▶│ OUTPUT  │
  ├─────────┤  ├─────────┤  ├─────────┤  ├─────────┤  ├──────────┤  ├─────────┤
  │ mic     │  │ dedup   │  │ SQLite  │  │ STT     │  │ cards    │  │ timeline│
  │ screen  │  │ VAD     │  │ blobs   │  │ OCR     │  │ memories │  │ RAG chat│
  │ a11y    │  │ chunk   │  │ vectors │  │ VLM     │  │ entities │  │ nudges  │
  │ text    │  │ queue   │  │ FTS     │  │ LLM     │  │ index    │  │ API     │
  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └──────────┘  └─────────┘
       │            │                                       │
       └────────────┴───────── the two axes ────────────────┘
```

**Axis 1 — where cost is gated**

1. **At ingest** — screenpipe (a11y-first + 3 suppression layers), dayflow (idle short-circuit + 15-min batching), omi (hardware AAD + server VAD gate), commit (sweep watermark + LOW-drop)
2. **At organise** — vellum (prompt-cache-shaped context, frozen memory cards)
3. **Nowhere** — localbird: ~1 VLM call per second, no dedup anywhere in the repo

**Axis 2 — the atom of memory**

| Atom | Systems | Consequence |
|---|---|---|
| frame | screenpipe, localbird | Flat vectors, weak ranking, query-time reconstruction |
| timeline card | dayflow | Merge/title/dedup come free via regeneration; non-determinism |
| conversation + memory node | omi | Rich graph, needs an LLM judge to dedup meaning |
| concept page | vellum | Wiki semantics; consolidation is an expensive background agent |
| commitment | commit | Content-addressed, hash-dedupable, trivially rankable |

---

## 2. screenpipe

> Rust workspace v0.4.37 · 109 migrations · local-first · **no longer OCR-first, no longer continuous video**

```
 EVENT TRIGGER          GATES (3 layers)         SQLITE                 SERVE
 ─────────────          ────────────────         ──────                 ─────
 AppSwitch ┐            ① FrameComparer          frames ──┐             REST :3030
 Click     │            (Hellinger hist)         elements │             SSE /stream
 TypingPause├─▶ JPEG ─▶ ② OcrGate         ─────▶ audio_*  ├─▶ FTS5 ────▶ MCP  :3031
 ScrollStop │  q80      ③ WindowOcrCache          speakers │  (chrono)   pipes (.md)
 Idle 30s   │           + content_hash/simhash    memories ┘             Tauri app
 VisualChg ─┘                                        │
                                                     ▼
                          a11y tree ──▶ merge ──▶ frames.full_text
                          OCR (fallback)           text_source =
                                                   {a11y | ocr | hybrid}
                                        ┌──────────────────────┐
                          JPEG dir ─────▶ compaction ≥10min old │──▶ MP4 (HEVC hw)
                                        │ 100 frames/chunk      │    -bf 0 always
                                        └──────────────────────┘
```

1. **Capture** — macOS ScreenCaptureKit (`sck-rs`), Windows WGC/D3D11, Linux grim→portal→xcap. **No fixed FPS**: `CaptureTrigger::{AppSwitch, Click, TypingPause, ScrollStop, Clipboard, VisualChange, Idle}`, `min_capture_interval_ms: 200`, `idle: 30_000`.
2. **Ingest** — dedup is luma downscale → `DefaultHasher` early exit → **Hellinger histogram** (not SSIM, not pHash); `diff < 0.02` ⇒ skip OCR. Audio: 30 s chunks, 2 s overlap, **Silero v5 ONNX** VAD.
3. **Store** — SQLite ≥3.51.3, read pool 27 / write pool 8 + process-wide write semaphore, `wal_autocheckpoint=0`, `mmap_size=0`, `unix-excl` VFS. Single batched writer: mpsc 4096 → `recv_many` ≤500 → one `BEGIN IMMEDIATE`.
4. **Process** — OCR: Apple Vision / Windows.Media.Ocr / Tesseract, global `Semaphore(1)`. STT: **whisper.cpp `large-v3-turbo`**. Diarization: pyannote `segmentation-3.0` + wespeaker CAM++.
5. **Organise** — FTS5 `MATCH` with **strictly chronological ranking**. `bm25()` used in exactly one place. `ContentType::All` = per-leg fetch + Rust temporal merge, no score fusion.
6. **Output** — REST :3030, MCP :3031 (~30 tools), and **pipes: markdown files**, not JS — `pipe.md` body = prompt, run by `pi-coding-agent` in a bun subprocess.

**Tradeoffs**

- ✅ a11y-first is the whole product — OCR costs 400–1400 ms/frame, the a11y tree returns *structured* text with roles and focus state in ~250 ms
- ✅ Two-stage video decouples capture latency from ffmpeg entirely
- ❌ **No text vector index at all.** A query matching 10M frames returns the newest page, not the best one

---

## 3. omi

> nRF5340 pendant → Flutter app → FastAPI backend · the only hardware system · a multi-device aggregator

```
 DEVICE                 PHONE                    BACKEND
 ──────                 ─────                    ───────
 T5838 PDM mic ×2       native BLE (Kotlin/      wss /v4/listen
 16kHz stereo           Swift via Pigeon)              │
      │                       │                        ▼
 HW AAD gate ──▶ Opus    ┌────┴─────┐            ListenSessionRuntime
 (~20µA idle)   32kbps   │   WAL    │                  │
      │         no DTX   │ inProg → │            ┌─────┼──────┬─────────┐
      ▼                  │ miss →   │            ▼     ▼      ▼         ▼
 BLE GATT 19b10001  ────▶│ uploaded │──────▶   STT   VAD   diarize   translate
 MTU 517, 2M PHY         │ → synced │         nova-3 silero pyannote   NLLB
 7.5–15ms interval       └──────────┘            │
      │                                          ▼
 SD ring buffer                            Firestore ─┬─▶ Pinecone (ns1..ns4)
 (FAT rejected)                            (source of ├─▶ Typesense
 444-byte records                            record)  └─▶ Redis (3-tier cache)
                                                 │
                                                 ▼
                            structure → action items → memory extract
                            → retrieve-then-JUDGE dedup → outbox worker
```

1. **Capture** — TDK MMICT5838 PDM MEMS ×2, 16 kHz/16-bit stereo → SW downmix. Hardware **AAD** drops mic to ~20 µA in silence. **Opus only**: 32 kbps VBR, `RESTRICTED_LOWDELAY`, **DTX/FEC off** — drop packets rather than distort STT.
2. **Ingest** — BLE is **native Kotlin/Swift**, not Dart, bridged via Pigeon so reconnect survives Flutter suspension. Phone owns the WAL (60 s chunks, 90 s flush). Five syncer impls coexist because firmware generations aren't retired. **No on-device VAD.**
3. **Store** — Firestore is system of record (`firestore.rules` denies all client access). Pinecone one index, namespaces `ns1` conv / `ns2` mem / `ns3` screen / `ns4` actions. Typesense for facets, Redis 3-tier cache. GCS for audio blobs.
4. **Process** — STT: **self-hosted** Deepgram `nova-3` (hosted explicitly refused for streaming) + Parakeet-TDT-0.6b-v3 with VRAM-aware admission. Speaker match cosine **0.45**. LLM routing via one `MODEL_QOS_PROFILES` table.
5. **Organise** — 33 categories, 20 source types. Memory dedup is **retrieve-then-judge**, never a cosine threshold. Event-sourced: one transactional apply fn + outbox worker with retry + dead-letter.
6. **Output** — 4-tab Flutter app, SSE chat, apps marketplace with SSRF-guarded webhooks, MCP server, SDKs in 7 languages, per-user GCE agent VM.

**Tradeoffs**

- ✅ Cost pressure shaped the stack top to bottom — STT dominates per-minute cost, so they run their own GPU fleet
- ✅ Fail-closed RAG: vector hits re-validated against Firestore, tool results wrapped in untrusted-evidence boundaries
- ❌ …except the agent VM, which runs `permission_mode="bypassPermissions"` with Bash + Write

---

## 4. dayflow

> macOS Swift/GRDB · screenshots in, video out · 45-minute regeneration window

```
 every 10s              every 60s                  per batch
 ─────────              ─────────                  ─────────
 SCScreenshotManager    createScreenshotBatches    ┌── IDLE? ──┐
 (NOT SCStream —        target   15 min            │  ≥0.95    │──YES──▶ Idle card
  avoids the recording  maxGap    2 min            │  coverage │        ZERO LLM
  indicator)           trailing batch DROPPED      └─────┬─────┘
      │                                                  │ NO
      ▼                                                  ▼
  JPEG 1080p q0.85 ──▶ screenshots table          ① transcribeScreenshots
  + idle_seconds_at_capture                          JPEGs ─▶ 1fps 720p MP4
      │                                              ─▶ Files API ─▶ observations
      └──▶ recordings/yyyyMMdd_HHmmssSSS.jpg                │
           purge oldest-first @ 10GB                        ▼
                                                    ② generateActivityCards
                                              ┌─── 45-min sliding window ───┐
                                              │  new observations           │
                                              │  + EXISTING cards           │──▶ 1 LLM call
                                              │  "a draft you're revising"  │
                                              └─────────────┬───────────────┘
                                                            ▼
                                            replaceTimelineCardsInRange (atomic)
```

1. **Capture** — `SCScreenshotManager`, not `SCStream`, explicitly to avoid the macOS recording indicator. 10 s interval, 1080p, JPEG q0.85. Every frame stores `idle_seconds_at_capture` from `CGEventSource`.
2. **Ingest** — `targetDuration 15 min`, `maxGap 2 min`, `cardLookbackDuration 45 min`. Trailing incomplete batch dropped. Guards: `failed_empty`, `skipped_short` (<5 min).
3. **Store** — GRDB/SQLite `chunks.sqlite`. Retention **by bytes not days**: 10 GB screenshots, oldest-first, row marked deleted *before* unlink. Daily backups, `quick_check` at launch, 3-step corruption ladder.
4. **Process** — 6 providers. Gemini gets a re-composited 1 fps 720p MP4 via Files API (15 min → ~90 s clip); Claude gets a **5×3 contact sheet at 2560×864** + Apple Vision OCR sidecar; Ollama gets 15 base64 frames to **Qwen3-VL 4B**.
5. **Organise** — observations are durable truth, **cards are a re-derivable presentation layer**. `IdleBatchClassifier` writes Idle cards with zero LLM. Logical day starts **4:00 AM**.
6. **Output** — 5 tabs (timeline / daily / weekly / agents / journal). Card playback replays screenshots as a slideshow — no saved video needed. Chat agent handed the literal sqlite path + schema.

**Tradeoffs**

- ✅ Idle short-circuit is the biggest cost saver — most hours of a 24/7 tracker are idle, and they cost nothing
- ✅ Failures are never silent: a failed batch produces a visible `System/Error` card occupying its range
- ❌ ~3× redundant card-generation calls per active hour; a 2:30 PM card can silently retitle itself at 3:15

---

## 5. vellum-assistant

> TypeScript/Bun · **no ambient recorder** · the pipeline is a *context* pipeline

```
 SYSTEM PROMPT (static, ordered, id-sorted)        USER MESSAGE TAIL (all dynamic)
 ─────────────────────────────────────────        ──────────────────────────────
 00-prefix                                          5  disk-pressure
 01-delegate-subagents                             10  workspace-context
 …                                                 20  unified-turn-context
 09-soul          (SOUL.md)                        30  pkb-context
 10-user-persona                                   38  memory-v2-static
 11-channel-persona ◀── ONLY CACHE BREAKPOINT      40  now-md
 12-voice                                          50  subagent-status
 14-connected-services (dynamic)                 1000  memory-v3 (FROZEN cards)
                                                 1001  memory-v3-spotlight (ephemeral)

 RETRIEVAL (v3)
 ──────────────
 finder lanes (additive, recall-safe)      pool in CACHE ORDER
 ┌ section-needle (BM25)          ┐        ┌──────────────────┐
 ├ dense (memory_v3_sections)     │        │ core  (file ord) │  byte-identical
 ├ reply-query pass               ├──────▶ │ hot   (score)    │  prefix across
 ├ span-query pass                │        │ fresh (freshAt)  │  turns ⇒ KV cache
 ├ edge (authored links)          │        └────────┬─────────┘
 └ learned-edges (co-select NPMI) ┘                 ▼
                                        1 forced-tool call: select_pages
                                                    ▼
                                        render NET-NEW only (diff vs ever_injected)
```

1. **Capture** — screen only *inside a computer-use step*: 960×540 JPEG q0.6. Primary channel is the **a11y tree + diff** (10k elements, depth 25). Audio is **microphone only** — no loopback anywhere. Plus watchers (gmail/gcal/github/linear @60 s) and channel webhooks.
2. **Ingest** — turn detection `manual` or `server_vad`, silence 800 ms, barge-in 250 ms. VAD is mean-abs energy on PCM16, threshold **800**. Job queue is a SQLite table `memory_jobs`, deferral 30 s → 5 min.
3. **Store** — **four separate SQLite files** (main / memory / logs / telemetry) to isolate write contention; no cross-file FKs; **never VACUUMs**. Qdrant: 4 collections, `messages_lexical` (sparse-only) **replaced FTS5**. Workspace on disk: `SOUL.md`, `memory/concepts/{arcs,people,procs,objects}/*.md`.
4. **Process** — 16 providers, **intents not tiers** (`balanced|cost|latency|quality|vision`), ~45 named call sites. Embeddings default **local `bge-small-en-v1.5` 384-d ONNX** in a subprocess. Fusion is **weighted sum 0.85/0.15, not RRF** — activation math needs score magnitudes.
5. **Organise** — 8 memory types (episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared) with fidelity, stability, Ebbinghaus decay. **Nothing dynamic in the system prompt.** Injected bytes persisted to message metadata and rehydrated byte-for-byte.
6. **Output** — hourly heartbeat agent (quiet hours 08–22, max 3 consecutive / 10 daily), notification engine that fails closed, clients on 5 platforms, workflows in **QuickJS-WASM** where `Date.now()` throws.

**Tradeoffs**

- ✅ Prompt cache is a first-class architectural constraint — every subsystem bends to it
- ✅ Recall-biased retrieval, deliberately: *"missing a relevant page is a worse error than surfacing a few unused ones"*
- ❌ Chattiest of the six by a wide margin; even consolidation is a background *agent conversation*

---

## 6. commit

> Go · single binary · zero backend · one source · **zero agents**

```
 WhatsApp (whatsmeow companion)          SQLite ~/.commit/commit.db
        │  text only — media NEVER       ┌──────────────────────────────┐
        │  persisted ("the messages      │ messages.processed = 0  ◀────┼── THE QUEUE
        ▼   table must stay honest")     │ sweep_state.swept_through ◀──┼── COST WATERMARK
   SaveMessage ─────────────────────────▶│ pending_closures         ◀───┼── REVIEW QUEUE
   INSERT OR IGNORE (idempotent)         │ sessions                 ◀───┼── AUTH
                                         └───────────┬──────────────────┘
                                                     │ every 10s, batch 100
                                                     ▼ grouped BY CHAT
                                          ┌──────────────────────┐
                                          │ 1 Claude call / chat │
                                          │ extraction + closure │
                                          └──────────┬───────────┘
                                                     ▼
              ┌────────────── deterministic gates ──────────────┐
              │ SHA-256(chat:title:direction)[:16] ⇒ hash dedup │
              │ Jaccard title sim: 0.5 save / 0.4 display       │
              │ conf ≥0.85 AND recipient_ack ⇒ AUTO-CLOSE       │
              │ conf 0.60–0.84            ⇒ SUGGEST, don't act  │
              │ RankToday: floor 40, max 1/chat, cap 5          │
              └────────────────────────┬────────────────────────┘
                                       ▼
                    embedded SPA :9384  +  WhatsApp self-chat as UI #2
```

1. **Capture** — **no sensors.** WhatsApp via `whatsmeow` multi-device companion (QR pairing). History sync capped at 7 days. **Text only** — media deliberately never persisted. Optional Google Calendar.
2. **Ingest** — the queue **is** a column: `messages.processed` with a partial index. 10 s poll, batch of 100 oldest-first, **grouped by chat** so each chat is one Claude call. `INSERT OR IGNORE` on message ID gives idempotency free.
3. **Store** — two SQLite files, 13 tables. Pure-Go driver ⇒ CGO-free Windows builds. **Nothing is ever deleted** — `closure_rejections` retained explicitly as future training data. No FTS5, no vectors — search is `LIKE`.
4. **Process** — 100% Anthropic API. `claude-sonnet-5` for extraction, **`claude-haiku-4-5` hardcoded** for the sweep. Extraction prompt enforces a two-part CONSEQUENCE TEST and a PROTECTED CLASS override; shared `closureRubric` **caps one-sided claims at 0.84**.
5. **Organise** — atom is the **commitment**, ID content-addressed so re-extraction collides and no-ops. `RankToday` is one scoring fn shared by UI and digest so they can't diverge.
6. **Output** — 216 KB embedded SPA at `:9384`, menu-bar tray, and **WhatsApp self-chat as a second UI** (`@find`, `@commit`, `@schedule`). The only RAG is lexical: keyword extract → 3-tier `LIKE` → ±5-message threading → one call.

**Tradeoffs**

- ✅ The safety asymmetry *is* the product — auto-close requires a two-sided handoff; ambiguity always asks
- ✅ SQLite as queue, index and state machine — no Redis, no cron, ships as one binary
- ❌ Encryption is decorative by default (random machine key when no passcode set); binds `0.0.0.0`

---

## 7. localbird

> Swift + Electron + C# · single squashed commit · **the counterexample**

```
 macOS (Swift)                          Windows (C#)
 ─────────────                          ────────────
 window capture @ 5s  ┐                 GDI BitBlt
 FULL SCREEN  @ 1s    ├── JPEG 1440px   250ms fg poll
 app-switch trigger   ┘   q0.7             │
        │                                  ▼
        │                          _latestFrame (ONE slot,
        │                           last-write-wins, drops)
        ▼                                  │
   ✗ NO DEDUP        ◀── grep dedup|phash  │  ✗ GET /frame/latest
   ✗ NO DIFFING          = ZERO HITS       │     404s on macOS ⇒
   ✗ NO IDLE CHECK                         │     the two pipelines
        │                                  ▼     NEVER CONNECT
        ▼
   1 VLM call  ─┐
   1 embed call ─┴─▶ ~2 cloud calls/sec ─▶ Qdrant localbird_frames
                     ~3,600 screenshots/hr    768-d cosine, ONE point
                     leave the machine         per frame, no chunking
```

1. **Capture** — SCK stream started but its callback is a **no-op**; capture is timer-driven. Full-screen @ **1 s** on by default. Sandbox disabled. Audio is mic-only, so a "meeting" records only your own voice.
2. **Ingest** — **no frame diffing, no hashing, no dedup, no idle detection.** Grep returns zero hits repo-wide. No batching: one vision request + one embedding request **per frame**.
3. **Store** — Qdrant is the only database. No retention, no pruning, no encryption. API keys plaintext in `config.json`, UserDefaults and `.env`.
4. **Process** — **no OCR engine**; "visible text" is whatever the VLM chooses to transcribe. **WhisperKit is the only local model** (two-tier: `small` live, `large-v3` final).
5. **Organise** — **no session, activity or entity model.** The whole frame is one vector, no chunking. `getStats` estimates minutes as `frames × 5 s ÷ 60` — a hardcoded assumption that ignores the 1 s stream.
6. **Output** — Express :3001, agent loop on `claude-opus-4-5` with 7 tools. `searchMeetings` computes an embedding then **ignores it** and falls back to substring matching.

**Tradeoffs**

- ✅ Window-scoped capture preserves the app/window provenance that makes `app_search` possible at all
- ❌ "Local-first" is storage-only — at defaults, ~3,600 screenshots/hour leave the machine with no blocklist, no incognito filter, no password-field redaction
- ❌ Embedding-dimension trap: collection is 768-d for Gemini, but the OpenAI provider returns 1536-d

---

## 8. Compute classification

Four lanes, not three — lumping Whisper and pyannote in with "LLM" hides the most important fact about several of these systems.

```
 ◆ DETERMINISTIC   rules, state machines, hashes, SQL, thresholds     free, instant
 ◆ CLASSICAL ML    STT, OCR, VAD, diarization, embeddings             cheap, fixed-fn
 ◆ LLM CALL        one prompt in, structured output out, no loop      bounded cost
 ◆ AGENT           multi-turn, model-chosen tools, iteration cap      unbounded-ish
```

| System | Agents | LLM call sites | Note |
|---|---|---|---|
| screenpipe | pipes only | **0 in core** | `screenpipe-core` has **no LLM abstraction at all** |
| commit | **0** | 9 prompts | No tool loop anywhere in the codebase |
| dayflow | 1 (chat) | 2 per batch | Pipeline is deliberately agent-free |
| omi | 2 | ~10 | Chat loop + per-user GCE agent VM |
| vellum | 6+ | ~45 | Agents are the substrate, not the edge |
| localbird | 1 (chat) | ~2/second | No gate in front of the calls |

**Composition by pipeline surface area** (`▓` deterministic · `▒` classical ML · `░` LLM · `█` agent)

```
 screenpipe  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒█            engine never thinks
 commit      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░            0 agents, 0 ML models
 dayflow     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒░░░░░░██            tightest cost envelope
 omi         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒░░░░░░███
 vellum      ▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒░░░░░████████            agent-native
 localbird   ▓▓▓▓▓▓▓▓▓▓▒▒░░░░░░░░░░░░░░░░░█            ungated
```

**Naming traps worth catching**

1. omi's `invoke_consolidation_agent` is **not an agent** — it's one batched forced-tool call with a validated schema
2. omi's "3-stage notification cascade" is three independent single-shots, not a loop
3. commit's `@schedule` negotiation *looks* agentic but `engine.go` is a **pure state machine** importing only stdlib — the model interprets one message at a time, it never decides what to do next
4. dayflow's Claude correction turns are a bounded retry loop, not an agent

**The consistent pattern in the five mature systems**

> Deterministic code decides **whether to spend a call**. A single-shot LLM turns unstructured input into **a schema**. An agent runs only where **a human is waiting** or on an explicit schedule.

---

## 9. Side by side

| | screenpipe | omi | dayflow | vellum | commit | localbird |
|---|---|---|---|---|---|---|
| Primary signal | a11y tree | Opus audio | screenshots | a11y, on demand | WhatsApp text | screenshots |
| Cadence | **event-driven** | continuous, HW-gated | fixed 10 s | on demand | 10 s DB poll | fixed 1 s + 5 s |
| Dedup | Hellinger + gate + simhash | VAD + WAL | idle + batch drop | AX diff | SHA-256 + Jaccard | **none** |
| Store of record | SQLite | Firestore | SQLite/GRDB | 4× SQLite + Qdrant | SQLite ×2 | Qdrant only |
| Text vectors | **none** | Pinecone 3072-d | **none** | Qdrant 384-d | **none** | Qdrant 768-d |
| Ranking | **chronological** | BM25+vector RRF | n/a | weighted sum | keyword overlap | pure cosine |
| STT | whisper.cpp | Deepgram/Parakeet | — | 5 providers | — | WhisperKit |
| OCR | Vision/WinOCR/Tesseract | — | Vision (Claude path) | **none by design** | — | **none** |
| Local inference | Whisper, Silero, pyannote, RF-DETR | optional on phone | Qwen3-VL 4B | bge-small | **none** | WhisperKit |
| Retention | tiered evict → strip → delete | soft-invalidate | by bytes (10 GB) | logs 1 h | **never deletes** | **none** |
| Extension | pipes + MCP + REST | apps + webhooks + MCP | provider plugins | skills + MCP + A2A | **none** | **none** |

---

## 10. What all six teach

1. **The atom of memory decides everything downstream.** Pick "frame" and you get flat vectors, weak ranking and query-time reconstruction. Pick "card"/"commitment"/"concept page" and organisation becomes an LLM writing task with dedup and merging built in — at the price of non-determinism and regeneration cost.
2. **The cheapest inference is the one you skip.** Every mature system has a *rule-based gate in front of the model*: dayflow's idle classifier, screenpipe's three suppression layers, omi's hardware AAD, commit's sweep watermark. localbird has none and pays linearly.
3. **Structured text beats pixels wherever it exists.** screenpipe and vellum both make the a11y tree primary and demote OCR to fallback — an order of magnitude cheaper, carries roles and focus state, already segmented. OCR survives only where a11y is absent: terminals, canvases, remote desktops.
4. **Separate durable truth from the presentation layer.** dayflow's observations vs cards; omi's conversations vs memories; vellum's messages vs concept pages. The raw layer is append-only and provider-tagged; the derived layer is disposable. This is what makes model swaps and prompt iteration survivable.
5. **Dedup of *meaning* is not a cosine threshold.** omi uses retrieve-then-judge with a batched LLM verdict. commit uses content-addressed hashing plus Jaccard with *two different thresholds* for save vs display. vellum uses a 978-line consolidation prompt with hard char and edge caps.
6. **Privacy is enforced at capture or not at all.** dayflow excludes password managers from the `SCContentFilter` and writes a placeholder if one is frontmost. commit refuses to persist media. screenpipe redacts destructively rather than keeping a plaintext sibling column. Post-hoc redaction of data you already wrote is theatre.
7. **Cost and cache shape the architecture, not the other way round.** vellum's entire context system exists to keep a prefix cache anchored at message zero. omi built a GPU fleet because STT dominates per-minute cost. commit hardcodes Haiku for sweeps after a 131M-token month. These are load-bearing, not bolted on.

**The honest scoreboard**

| System | Best at | Worst at |
|---|---|---|
| screenpipe | capture engineering, reliability | ranking — chronological only |
| omi | memory model, cost engineering | total cloud dependency |
| dayflow | cost envelope, failure visibility | narrowest data (screen only) |
| vellum | context engineering, prompt-cache discipline | no ambient capture at all |
| commit | product thesis, safety asymmetry | one source |
| localbird | (window provenance, local STT) | no gating layer anywhere |

Nobody has all of it. That's the point — you pick what matters and accept being worse at the rest.
