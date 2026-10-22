# Personal-agent landscape: sources, memory, proactivity and character

**Date:** 2026-10-06 (research ran 2026-09-30 to 2026-10-06)
**Scope:** how personal-AI and agent products connect sources, ingest and store data, process historical and steady-state data, behave agentically and proactively, and present themselves (channel, persona, character, animation), compared with SuperTwin V13.
**Status:** research only. No SuperTwin code was changed.

---

## Contents

1. [Method and evidence grades](#1-method-and-evidence-grades)
2. [Executive summary](#2-executive-summary)
3. [Comparison matrices](#3-comparison-matrices)
4. [SuperTwin baseline](#4-supertwin-baseline)
5. [Instinct (closed product)](#5-instinct-closed-product)
6. [Open-source systems](#6-open-source-systems)
7. [Other closed products](#7-other-closed-products)
8. [Cross-cutting analysis](#8-cross-cutting-analysis)
9. [Implications for SuperTwin](#9-implications-for-supertwin)
10. [Appendix: sources, commits and open questions](#10-appendix-sources-commits-and-open-questions)

---

## 1. Method and evidence grades

Every claim in this document carries one of four evidence grades.

| Grade | Meaning | Applies to |
|---|---|---|
| **A** | Source code read directly (shallow clone, nothing installed or run) | SuperTwin and 11 open-source repos |
| **B** | First-party published material (company blog, site, security page, App Store listing, launch post) | Pickle, Underdog, OpenAI Dots launch, repo READMEs |
| **C** | Controlled interaction and the product's own self-report | Instinct, via the WhatsApp interview in [`InstinctResearch.md`](../InstinctResearch.md) |
| **D** | Third-party commentary | Instinct reverse-engineering posts, TechCrunch roundup |

Coverage caveats:
- **Sampled, not read end to end:** OpenClaw core (50,849 files), Lemma (8,400 files), and Paperclip's largest service files (`chat-channels.ts`, `tool-access.ts`, `heartbeat.ts`, `tool-gateway.ts`). Each section says what was sampled.
- **Not run:** no repo was installed or executed, so behaviour is inferred from code, not observed.
- **Websites:** pickle.com's homepage rendered blank in the in-app browser; its two research posts and App Store page were read. Launch videos were not watched.
- **TechCrunch products** are covered by one paragraph each and are listed for landscape only.
- **Line numbers** for open-source repos refer to the commit SHAs listed in the [appendix](#10-appendix-sources-commits-and-open-questions). SuperTwin line numbers refer to `8159e7e`; the WhatsApp adapter numbers are ±2 lines.

---

## 2. Executive summary

1. **SuperTwin is the only system studied that captures sources into its own local store, backfills history, and runs model-based understanding over that corpus.** Every open-source repo either calls sources live as tools at question time, or captures messages only from the moment of connection. Instinct is the closest: it reportedly reads the user's whole Gmail at onboarding (D) and keeps a raw event history separate from curated notes (C).

2. **The field has converged on one architecture,** and SuperTwin Phase 1 has only part of it:
   - a personable chat agent on one thread that delegates to task workers;
   - a computer per agent (sandbox plus a logged-in browser);
   - memory as Markdown files with keyword search, not a vector database;
   - a messaging thread (WhatsApp, iMessage, Slack) as the interface;
   - approvals as cards, with secrets injected by tools rather than seen by the model.

3. **Proactivity is mostly user-authored cron.** Only a handful of systems originate work themselves: Instinct (reviewer and wakes), OpenBot (opt-in read-only research with cited claims), OpenClaw (heartbeat), Pickle (roaming and introductions) and SuperTwin (every consented event). Instinct's reported split into *goal*, *wake condition* and *alert rule* is the clearest design for keeping proactivity quiet.

4. **Character is becoming a differentiator.** Pickle drives a rigged 3D creature in real time for about $0.003 a minute of GPU. OpenAI's Dots launched as a "bubbly agentic avatar" (D). Open Dot, Lemma and OpenBot all ship animated characters or orbs. Instinct has none and relies on concise text and emoji reactions.

5. **Privacy positions have split three ways:**
   - **fully on-device** (Underdog: own models, mail encrypted on the Mac, no personal-data servers);
   - **cloud with attested credential custody** (Pickle: tokens in an AWS Nitro enclave, but memories readable by authorised staff);
   - **local store, cloud understanding** (SuperTwin: consent enforced at write time, but the store is unencrypted and understanding goes through a cloud model).

6. **SuperTwin is the only system with hard, latching spend ceilings.** Instinct is free and deliberately over-provisioned; every open repo relies on step caps and timeouts at most.

7. **Highest-value moves for SuperTwin**, detailed in [section 9](#9-implications-for-supertwin):
   - add Gmail as a source;
   - split proactive decisions into goal, wake and alert;
   - make unattended runs read-only at the dispatcher with mandatory citations;
   - give the twin a state-driven character;
   - encrypt the store with a Keychain-held key;
   - journal ingress durably.

---

## 3. Comparison matrices

### 3.1 Sources and ingestion

| System | Connector model | Sources | Historical import | Steady state | Cursor / dedup |
|---|---|---|---|---|---|
| **SuperTwin** | Capture adapter + manifest (only WhatsApp uses the contract) | WhatsApp, browser history, screen | **Yes**: WhatsApp newest-first with dual watermarks; browser from consent floor | Push (WhatsApp, screen); 60 s poll (browser) | `UNIQUE(source_id, external_id)`; content hash for browser/screen; browser cursor in memory |
| **Instinct** (C/D) | Messaging channel + ~30 skills | WhatsApp, iMessage, Gmail, browser, agent's own email | **Partial**: Gmail read at onboarding (D); raw coverage started Sept 3 though chat began Aug 21 (C) | Not verified beyond timers | Unknown |
| **open-instinct** (mariagorskikh) | Composio Tool Router + Inkbox messaging | Gmail, Calendar, Contacts (live); iMessage, SMS, agent email, A2A | **None**; onboarding only sends a connect link | Inkbox webhooks for messages to the agent | Durable fsync inbox; 3 dedup layers |
| **OpenInstinct** (Merit) | Hand-wired eve tools | Gmail, Calendar, Contacts (live), iMessage via Linq | None | Chat webhook only | Deterministic ids on writes |
| **OpenClaw core** | `ChannelPlugin` adapters; Gmail/Drive/GitHub as CLI skills | ~18 chat channels, IMAP, Gmail Pub/Sub | **None**: `syncFullHistory: false`; IMAP baselines old mail; iMessage replays ≤2 h after downtime | Push (sockets, Pub/Sub, IMAP IDLE) | Durable `channel_ingress_events` queue, persisted offsets, tombstones |
| **OpenClaw Enterprise** | Infrastructure drivers | Slack only (via core) | None | None at platform level | Postgres work queue |
| **Paperclip** | JSON `AppDefinition` + MCP (79 catalog entries) | Chat (7 providers), AgentMail, GitHub relay, external-object refresh | **None**: email refuses pre-activation mail | Push receipts; 5 s–5 min adaptive GitHub poll | Unique provider-id receipt tables |
| **OpenMausBot** | Composio + MCP tools | Webhooks, routines, chat | None | Webhooks (10/min), routines (10 s tick) | Delivery-id receipts, 7 days |
| **OpenMuse** | One Google REST client | Gmail, Calendar | None (latest 30 mails, next 31 days) | Pull on demand; 15 min ideas refresh | Upsert by provider id |
| **OpenBot** | MCP catalogue + Composio | Drive, Notion, Composio apps, webhooks (GitHub, Linear, Sentry, PagerDuty, SES, Slack) | **None**; old document index deleted | 15 min polled "memory sources"; signed webhooks | `(source_id, external_id)` + digest; unique event id |
| **OpenDots** | None | Slack mentions, web search | None | Slack via CopilotKit managed channel | None |
| **Open Dot** | Composio MCP + Composio triggers | 12 trigger apps, ~1,500 tool apps | None | Composio push subscription | **None**; in-memory run queue |
| **Lemma** | 4 kinds: composio, http, sql, mcp | ~12 native + ~75 Composio; Slack/Teams/Telegram/WhatsApp/email surfaces | **None** (uploaded files only) | Webhooks + 5 s schedule poller + table triggers | Unique `(schedule_id, source_event_id)`; outbox/inbox |
| **Pickle** (B) | Credential enclave | Google; chat; other Pickles | Not described | Not described | n/a |
| **Underdog** (B) | Direct mail sync | Gmail/Outlook mail and calendar, meeting audio | Implied (mail syncs to device) | Not described | n/a |

### 3.2 Storage and memory

| System | Store | Raw data kept | Memory form | Retrieval | Consolidation |
|---|---|---|---|---|---|
| **SuperTwin** | SQLite (WAL), one file | Yes: events, archive, blobs | Typed claims, entities, episodes, spaces, tone profiles | FTS5 + local int8 embeddings | Extract, T2 hourly, T3 idle, weekly digests |
| **Instinct** (C/D) | Unknown DB; git repo bundled to S3 | Yes: raw event records | Markdown notes: timeline (raw/hourly/daily/weekly), people, places, preferences, decisions, workstreams | Keyword search, 1–50 results | Daily background curation |
| **open-instinct** | Files only (JSON, JSONL, Markdown) | Transcripts folded and overwritten | `MEMORY.md` + daily journal, append-only | None; fixed 4,000-char digest | None |
| **OpenInstinct** | Postgres, Vercel Blob | No | Profile file, structured profile row, model-written workstreams | `ILIKE` | None |
| **OpenClaw core** | SQLite per agent + Markdown | Transcripts only | `MEMORY.md`, daily notes, `DREAMS.md` | Hybrid BM25 + vector, MMR | Nightly "dreaming" with promotion gates |
| **Paperclip** | Postgres | Normalised receipts only | Delegated to third-party memory connectors | Lexical only | None |
| **OpenMausBot** | SQLite + JSON/NDJSON files | Own chat transcripts | Markdown per bot, journaled with undo | BM25 (FTS5) | Quiet-window capture, organise, nightly tidy |
| **OpenMuse** | One JSONB `records` table | Normalised cache | Flat user-written list | None (all injected) | None |
| **OpenBot** | Postgres (~83 tables) | Trigger payloads, transcripts | Flat facts with provenance and review state | Newest 40, substring | None |
| **OpenDots** | SQLite; threads in CopilotKit cloud | No | Manual preference list | None (all injected) | Outsourced "Automatic Learning" |
| **Open Dot** | SQLite | No | Flat fact list | None (all injected) | None |
| **Lemma** | Postgres + per-pod schemas + pgvector | Files only | Markdown under `/memory`, `/me` | Hybrid vector + FTS for files | Explicitly none |
| **Pickle** (B) | Server-side, AWS-managed encryption | Unknown | User-editable memories | Unknown | Unknown |
| **Underdog** (B) | On device, AES-256 | Mail on device | Inspectable saved memories | Unknown | Unknown |

### 3.3 Agentic behaviour and proactivity

| System | Agent shape | Computer | Proactive mechanism | Notify decision | Approvals |
|---|---|---|---|---|---|
| **SuperTwin** | Bundled understanding lanes + decide queue; executor-lite | None in Phase 1 | Every consented event: hot gate, burst, cold window | Decide queue, prepared actions | HMAC single-use send token |
| **Instinct** (C/D) | Main chat agent + task agents; auto-steer | E2B sandbox per user, browser use | Wakes; reviewer at 08:00/14:00/20:00; goal/wake/alert split | Main agent decides; "no noise" | Approves payments (D) |
| **open-instinct** | One Pi agent per conversation; steer; A2A to other people's agents | Firecracker microVM desktop (pixel computer use) | Cron schedules created by model or user | Model replies or stays silent | Trust tiers × 26 capabilities; exact-call YES/NO tokens |
| **OpenInstinct** | One eve agent, 3 modes; browser subagent | Kernel cloud browser | User-created schedules | Separate reporter turn may suppress | `approval: always()` on send/create |
| **OpenClaw core** | Per-session serial loop | Device nodes | Heartbeat every 30 min; cron | Agent judgement | Exec approvals, channel reactions |
| **Paperclip** | Agent runs (heartbeats) per task | Adapter-defined | Wake requests from events | n/a (work platform) | Tool policy allow/ask/block |
| **OpenMausBot** | Many CLI agents in rooms; Chief of Staff | VMs, containers, host | Routines, webhooks (explicitly no hidden heartbeat) | Blocked/finished/failed only | Approval cards, permission broker |
| **OpenMuse** | Lease-based task worker; chat agent | Docker, Playwright worker | Regex "ideas" | User accepts | Hash- and ETag-bound review |
| **OpenBot** | AG-UI agents, typed handoffs | Container per bot | Routines, responsibilities, opt-in read-only research, self wake-ups | Notify levels; caps only | CEL policy, fail-closed |
| **OpenDots** | Single loop, 5–10 iterations | Container per dot | Timer replaying a prompt | None (UI polling) | Page review only |
| **Open Dot** | 60-step loop per dot | E2B, Docker or local folder | User cron + Composio triggers | Prompt line only | LLM reviewer against NL rules, fail-closed |
| **Lemma** | pydantic-ai graph, subagents, workflows | Per-user sandbox, host execution | Schedules, webhooks, table triggers + LLM filter | `message_user`, 20/h cap | Approve once/session as approver |
| **Pickle** (B) | Agent + read-only "clone" for others | Own computer (Kernel browser) | Roams map, meets Pickles, proposes introductions | Sharing rules as upper bound | Single-use Stripe Link cards |
| **Underdog** (B) | Local models + browser agent | Local | Not described | Not described | Asks before buy/pay/send/delete |

### 3.4 Interface, character, privacy and cost

| System | Channels | Character / animation | Privacy stance | Spend controls |
|---|---|---|---|---|
| **SuperTwin** | Tauri desktop app | None in product; separate Pocket Hero MVP in `tamagotchi/` | Local SQLite, consent windows, unencrypted; cloud model | **Hard latching ceilings** ($3/h, $15/day, 400 calls/h, 3,000/day) |
| **Instinct** | WhatsApp, iMessage, voice notes, calls | None; concise text, emoji reactions | Cloud | Free, over-provisioned |
| **open-instinct** | iMessage, SMS, agent email, A2A, CLI | None; editable `PERSONA.md` | Cloud microVM; mail snippets in audit log | Purchase caps only; no model ceiling |
| **OpenInstinct** | iMessage (Linq), web | None | Vault with AAD-bound encryption; full-content logging on | None |
| **OpenClaw core** | ~18 chat channels, apps, TUI | None | Self-hosted, metadata-only audit | Soft (usage display) |
| **Paperclip** | Web UI, chat channels | None | Vaulted, brokered credentials | Rate limits on tools |
| **OpenMausBot** | Desktop, iOS, Android | None | Local, redacted logs | Monthly cap, enterprise only |
| **OpenMuse** | Expo mobile/web | None | PKCE, encrypted tokens | Step caps |
| **OpenBot** | Web, Slack/Teams, SMS, push, voice | Gradient orb (sign-in only), seeded avatars | Self-hosted, threads in CopilotKit cloud | None |
| **OpenDots** | Web, voice, Slack | 4 static plush images, CSS bob | Threads in CopilotKit cloud | None |
| **Open Dot** | Electron desktop, voice | 3D puffball driven by run state | Local; content to OpenAI/Composio | None |
| **Lemma** | Web, desktop, Slack, Teams, Telegram, WhatsApp, email, voice, MCP | ~28 layered 2D puppets with ambient motion | Self-host or cloud; RLS per pod | Per-run caps; money limits pluggable |
| **Pickle** | iPhone app, voice | Rigged 3D creature, real-time, levels and "bubbles" | Enclave for tokens; memories on servers | Single-use cards |
| **Underdog** | Mac, Windows beta | Dog persona ("Woof", "Underdog") | Fully on-device | Local inference, no token cost |

---

## 4. SuperTwin baseline

*Grade A. Paths relative to the repo root at `8159e7e`.*

### 4.1 Sources and contract
- **Only three sources exist:** `SUPERVISED_SOURCES = ["whatsapp","browser","screen"]` (`worker/src/adapters/supervisor.ts:44-45`). No email, external calendar or file connector; `worker/src/calendar/` is a derived layer and `worker/src/browser/` is a CDP harness for the executor.
- **Contract:** `SourceAdapter` (`worker/src/adapters/source-adapter.ts:20-69`) plus `SourceManifest` validated at registration (`worker/src/adapters/registry.ts:150-163`, `:207-325`). **Only WhatsApp uses it** (`worker/src/index.ts:142-148`); browser and screen are bespoke watchers (`index.ts:177-214`).
- **Consent:** adapters start only when a `consents` row is `connected` (`supervisor.ts:125-159`). The row carries an INDEX window and an UNDERSTAND window (`db/migrations/0200_v6_core.ts:62-80`).
- **Auth:** WhatsApp QR link with the whatsmeow session in `<home>/whatsapp/whatsmeow.db`; browser needs Full Disk Access for Safari; screen needs macOS Accessibility (`adapters/screen/permission.ts:1-50`). Outbound WhatsApp sends need a single-use HMAC token keyed from `<home>/trust/approval.key` (`worker/src/approvals/key.ts:12-20`).

### 4.2 Ingestion
- **WhatsApp:** Go daemon over stdio NDJSON.
  - Historical: whatsmeow `HistorySync` buffered until the user confirms a range, then on-demand pagination (50 per page, ≤20 pages per chat, 5 in flight; `sources/whatsapp-go/internal/wa/engine.go:1009-1136`). Completion is a quiet-window heuristic: 11 s with no batch, 90 s deadline (`engine.go:910-924`).
  - Re-ordered newest-first in cohorts of 500 (`worker/src/adapters/backfill-order.ts:1-25`), with dual watermarks per stream (`worker/src/db/watermarks.ts:1-18`).
  - Realtime: same `onEvent` path; edits and revokes rewrite the target row (`worker/src/ingest/index.ts:756-798`).
- **Browser:** 60 s poll of copied history DBs (`adapters/browser/watcher.ts:211-254`). The first poll is the import. **Cursors are in memory only** (`watcher.ts:201`), so each restart re-reads the consented range and relies on content-hash dedup.
- **Screen:** Swift sidecar captures the Accessibility tree on app switch, typing pause, scroll stop and a 60 s heartbeat; nothing after 120 s idle (`sources/screenwatch/Sources/screenwatch/Live.swift:7-16`). Realtime only. Password managers and private windows blocked in both the sidecar and Node.
- **Shared funnel:** a capture filter and a consent gate run before every write (`worker/src/db/capture-filter.ts`, `worker/src/db/consent-gate.ts:123-177`). Inside INDEX but outside UNDERSTAND, rows are stored as `origin='archive'` with `dispatched_at` pre-stamped, so no model path ever selects them.

### 4.3 Storage
- SQLite via better-sqlite3, WAL, one synchronous handle per process (`worker/src/db/connection.ts:34-126`).
- Layers: raw `events` with envelope columns; zlib `archive`; content-addressed `blobs`; `streams`/`watermarks`; entities and edges; world model (`spaces`, `chapters`, `episodes`, `tasks`, `claims`, `tone_profiles`); FTS5; `chunks` + int8 `chunk_embeddings` computed locally with ONNX (`worker/src/retrieval/embedder.ts:1-13`); queues and ledgers.
- Hard delete cascades to every derived row with a counts-only tombstone (`worker/src/library/delete-cascade.ts`).

### 4.4 Processing
- **Write time (no model calls):** coverage note, watermark move, bridge keys, injection scan, engagement promotion.
- **Historical:** day bundles newest-first, split at 30,000 chars or 500 events; tier-3 streams to weekly digests; tier-4 index-only (`worker/src/scheduler/v6/history.ts:1-44`). Widening UNDERSTAND replays archive rows in resumable 5,000-row chunks (`consent-gate.ts:213-234`).
- **Realtime:** hot gate, burst detector (4 events in 180 s) or cold window (balanced default 5/9 min) (`scheduler/v6/gate.ts`, `burst.ts`, `cold.ts:30-51`). The live lane makes two model calls per bundle (`worker/src/brain/live.ts:41-45`).
- **Timers:** decide queue every minute, extract drain every 5 min, hourly T2, idle T3, brief every minute, prepared actions every 2 min.
- **Cost:** $0.50/call, $3/h, $15/day, 400 calls/h, 3,000/day, checked before spawn and latched (`worker/src/providers/budget.ts:103-110`); background lanes stand down on hold without dead-lettering (`budget.ts:694-737`).

### 4.5 Known gaps
From `progressV13_V6_Phase1.md` and the code:
- Embeddings not filtered on `origin='archive'`; disk budgets stored but not enforced.
- Deleting WhatsApp leaves the daemon session store.
- `mentions` not written by the commit path; `resolveRoles` has no production caller.
- UTC day boundaries; the encoder blocks the event loop for 0.5–2 s per pass.
- Browser cursors in memory; WhatsApp completion timing heuristics; ~1,000 older messages per chat per run.
- One synchronous SQLite handle shared by ingest, HTTP and embedding has caused UI freezes.
- Two write funnels with different dedup keys kept in step by hand.
- whatsmeow session DB and captured content unencrypted on disk.
- Phase 1 has no executor beyond executor-lite and no character.

### 4.6 Character work outside the product
`tamagotchi/` (untracked, branch `tamagotchi_codex`) is a standalone "Pocket Hero" MVP: a photo becomes a stylised mascot generated locally with FLUX.2 Klein 4B via MFLUX, animated by a local 2D cutout rig (idle/blink, wave, celebrate) on Canvas, with adjustable bone markers (`tamagotchi/README.md:1-60`). It is not wired to SuperTwin, and its animation is not driven by agent state.

---

## 5. Instinct (closed product)

Instinct is the reference product: a free, invite-only personal agent on WhatsApp and iMessage, valued at $10B after a $1B round (TechCrunch, D). Three independent sources describe it; where they agree, the claim is stronger.

### 5.1 Sources used
- **C:** the user's WhatsApp interview, [`InstinctResearch.md`](../InstinctResearch.md) (2026-09-12).
- **D:** Richard (@RMladek), "this is how instinct works under the hood", X, 2026-09-30.
- **D:** Yash (@yashhsm), "Why Instinct feels Magical", X article, 2026-10-01.
- **D:** TechCrunch, "All the AI agents that can live in your text messages", 2026-10-03.

### 5.2 Architecture

| Component | What is reported | Grade | Corroboration |
|---|---|---|---|
| Agent loop location | Runs on the backend server, outside the sandbox; drives commands and files inside it | D (RMladek, Yash) | Two sources |
| Sandbox | One per user (E2B, ~$0.13/h per Yash) for command execution and files | D | Two sources |
| Agents | Main chat agent on one thread owns personality, memory and context; delegates tasks to a task agent | C (interview "coordinator and workers"), D (Yash) | Two sources |
| Steering | User can message mid-task; messages are auto-steered and replies routed to the specific message | D (Yash) | Interview found reply-routing defects |
| Worker modes | Fully specified, judgement-required, fast execution | C (self-report) | None |
| Skills | 30 listed: agent-mail, authenticator-codes, browser-management, browser-use, bug-report, company-identity, data-privacy, deep-research, document-signing, files, flight-booking, food-ordering, gamepigeon, google-docs, i2i-management, instinct-faq, instinct-guides, mac-computer-use, messaging, onboarding, place-recommendations, presentations, proactive-value-creation, restaurant-booking, restaurant-recommendations, rideshare, scheduling, shopping, speaking, wake-subscriptions | D (RMladek) | None |
| Own identity | Dedicated email addresses for assistants (Sept); outbound calls rolling out | D (TechCrunch, Yash) | Two sources |
| Payments | Spend-capped virtual cards or Stripe Link; 1Password-backed logins | D (Yash) | None |

### 5.3 Sources and ingestion
- **Gmail at onboarding:** Instinct asks for Gmail during onboarding and "can read through the entire mail and form the initial context" (Yash, D). Yash reports that friends who skipped Gmail found it unimpressive.
- **Raw event history:** structured records with timestamp, sender, service and body, queried separately from curated memory (C).
- **Coverage gap:** the agent's raw-event floor was Sept 3, 13:54 IST, while the user's first WhatsApp message was Aug 21 (C). Captured, indexed and retrievable ranges were not exposed.
- **Event triggers:** not verified. Instinct retracted its one claim that a mail manager woke on incoming email (C).

### 5.4 Memory
All three sources agree that curated memory is **git-versioned Markdown**.
- **Layout (C):** 54 files at one point: timeline "raw" (14), hourly (14), daily (8), weekly (1), people (1), places (3), chat threads (4), facts (1), preferences (5), decisions (1), active workstreams (2). Metadata blocks with `id`, `type`, `status`, `aliases`.
- **Storage (D):** "simple git-tracked markdown files (with no vector database)", keyword search; the bundled repo is stored in S3 (Yash, RMladek).
- **Four stores (D):** source history, saved knowledge, task state, working context (Yash).
- **Curation (C + D):** a background job the chat agent cannot invoke. Both observed revisions landed at about 02:47–02:48 IST (C). Yash describes it as daily: it moves temporary details into work files, generalises, adds dated corrections and scrubs one-time codes (D).
- **Retrieval (C):** natural-language note search returning 1–50 results (default 10) with no pagination or total count; literal sweeps; separate raw-event queries.
- **Defects found (C):**
  - An explicit "Reply in English only" instruction became a weaker inference ("accepted English replies without objection").
  - A price correction had one note revision, not a version trail; file versioning was mistaken for fact provenance.
  - Top-k absence was presented as exhaustive absence.

### 5.5 Processing and proactivity
- **Timers verified (C):** one-shot wakes fired on time (MAPLE, CEDAR-CHECK, HARBOR); selective cancellation held once (PINE).
- **Reviewer (C):** a platform-owned reviewer at 08:00, 14:00 and 20:00 IST reads tasks, raw events and conversation history and reports to the main agent, which decides whether to notify.
- **Automation design (D, Yash):** automations are hidden background tasks built from templates (for example, "check these websites every 12 hours"). Each is split into three LLM decisions:
  1. **goal** — finding something useful to do;
  2. **wake condition** — when to revisit;
  3. **alert rule** — whether to interrupt.
- **Independent initiative:** not demonstrated in the interview's bounded audit (C).
- **Trusted Person Network (D):** sharing context with friends' agents for joint planning.

### 5.6 Interface and personality
- **Channels:** WhatsApp and iMessage, voice notes (D). No app of its own; three states only: message, typing, reply (Yash).
- **Personality (D):** "no noise", concise, confident, emoji reactions instead of full replies, picks up the user's tone; "insanely resourceful", sometimes resetting passwords via email to finish a task.
- **No avatar or animation.**

### 5.7 Failure modes observed (C)
Calendar/task confusion, source over-interpretation, unverified success language, lossy personalisation, missing fact provenance, conflated runs, an invented execution narrative later retracted, wrong reply targets, absence overclaims, and role descriptions mistaken for receipts. Full taxonomy in [`InstinctResearch.md` §8](../InstinctResearch.md).

### 5.8 Economics (D)
Free with unlimited use, invite-only, over-provisioned models and sandboxes. The founder reportedly wants to monetise only through transaction fees (Yash).

---

## 6. Open-source systems

Each subsection follows the same order: what it is, connectors, ingestion, storage and memory, processing and proactivity, interface and character, assessment.

### 6.1 open-instinct (mariagorskikh)

*Grade A. HEAD `a4df7ee` (2026-10-05); 27 commits from 2026-10-03, starting with one large import; MIT. About 17k lines across 9 packages; roughly 833 test cases by grep (README says 837), all against a fake model and stubs.*

- **What it is:** "a from-scratch, documented clone of Instinct" (`README.md:3`). A TypeScript monorepo (Node 22.19+, pnpm):

  | Package | Role |
  |---|---|
  | `core` | Agent loop, policy, memory, scheduler, approvals, audit |
  | `inkbox` | iMessage, SMS, email and agent-to-agent (A2A) messaging |
  | `server` | The per-user agent process |
  | `gateway` | Multi-user signup and webhook relay |
  | `cli` | `instinct` command |
  | `computer` | The agent's Linux desktop |
  | `network` | Contacts, trust tiers, A2A tools |
  | `payments` | Stripe Link wallet |
  | `apps` | Composio connectors |

- **Stack:**
  - Agent loop: Pi (`@earendil-works/pi-agent-core`), default model `anthropic/claude-fable-5-1` (`packages/core/src/config.ts:12`).
  - Identity and messaging: Inkbox gives the agent a phone number, iMessage, SMS, an email address and an A2A endpoint.
  - Hosting: Maritime, one Firecracker microVM per user that sleeps when idle and wakes on a message or schedule (`docs/ARCHITECTURE.md:64-76`).
  - No database: all state is JSON, JSONL and Markdown under `/data` (`docs/ARCHITECTURE.md:166-190`).
- **Basis:** reconstructed from press coverage, not from the reverse-engineering above; its own notes say Instinct's memory architecture is "not public" (`docs/research/INSTINCT.md:346`). Its emphasis is the trusted-person network and payments.

**Fidelity to the reported Instinct architecture:**

| Reported Instinct component | open-instinct |
|---|---|
| Main chat agent delegating to task agents | **No task agents.** One Pi agent per conversation key (`packages/core/src/runtime.ts:290-356`). "Delegation" means asking *another person's* agent over A2A (`runtime.ts:535-560`). Threads are per channel and conversation, not one thread. |
| Steering mid-task | **Yes.** `/chat` waits up to 20 s, then acknowledges ("On it…") and delivers later; new messages are folded in with `steer()` (`runtime.ts:358-381`, `475-478`). |
| Sandbox with browser use | **Partly.** A Maritime microVM with XFCE, Chromium and LibreOffice, driven by pixel-level computer use through a local REST service (`packages/computer/src/desktopd.ts:1-9,34`, `schema.ts:14-38`); owner takeover for logins, 2FA and payments. |
| Git-tracked Markdown memory, keyword search, daily curation, S3 | **Markdown only.** `memory/MEMORY.md` and `memory/journal/YYYY-MM-DD.md` (`packages/core/src/memory.ts:9-10`); no git, search, curation job or S3. |
| Raw event history separate from notes | **Weakly.** Session transcripts and `audit.jsonl` sit apart from `MEMORY.md`, but transcripts are folded and overwritten on disk. |
| Gmail read at onboarding | **No.** Onboarding only sends a connect link (`skills/onboarding/SKILL.md:31-34`). |
| Goal / wake condition / alert rule | **No.** A schedule is `{cron or one-shot, prompt}` (`packages/core/src/scheduler.ts:242-267`). |
| Periodic proactive reviewer | **No.** Only user- or model-created schedules such as a daily brief. |
| Skills | **Different set:** 12 playbooks (onboarding, daily-brief, email-triage, scheduling, dining, travel, rides, purchases, research, files, trusted-network, maritime-computer) loaded via `load_skill` (`packages/server/src/skills.ts:76-122`). |

**Connectors.**
- Inkbox webhooks: eight event types (iMessage received and reactions, SMS, mail to the agent's *own* mailbox, four A2A events; `packages/inkbox/src/events.ts:266-275`). A hydrator fetches group membership, truncated bodies and attachments (≤10 files, 10 MB each; `hydration.ts:9-33`).
- Composio Tool Router over MCP, one session per user; defaults Gmail, Google Calendar and Contacts (`packages/apps/src/composio.ts:149-196`, `packages/core/src/config.ts:15`). Each tool is mapped to a capability (`packages/apps/src/capabilities.ts:36-89`); unknown tools are owner-only. **No Composio triggers.**
- Web search (Brave or DuckDuckGo) and an SSRF-guarded fetch.
- Not present: WhatsApp, voice calls, location, browser history, screen.
- Secrets: env vars read by server, gateway and CLI; tokens in `/data/secrets/` mode 0600; Composio holds OAuth tokens and Inkbox holds message content (`docs/SECURITY.md:201`).

**Ingestion.** **No historical backfill and no realtime capture of the user's data.** Gmail and calendar are read only when the model calls a tool (`skills/email-triage/SKILL.md:14-17`). The inbound webhook path is solid:
- HMAC verified before parsing (`packages/server/src/http.ts:302-315`).
- A durable inbox fsyncs each event before acknowledging, retries with backoff, and marks interrupted runs "uncertain" rather than replaying them (`packages/inkbox/src/inbox.ts:45-60,122-158`).
- Three dedup layers: 5,000 ids in memory at the gateway, `seen-ids.json` (500), and a processing marker (`packages/gateway/src/relay.ts:25-40`, `runtime.ts:92,383-407`).

**Storage and memory.**
- `memory_write` appends to `MEMORY.md` or today's journal; `memory_read` returns all of `MEMORY.md` or today's journal only; no search, no older journals (`packages/core/src/core-tools.ts:57-104`).
- **Digest per turn:** 60% from the *top* of `MEMORY.md`, 25% from the end of today's journal, 15% from yesterday's, within 4,000 characters (`memory.ts:101-111`). Because writes are append-only, once `MEMORY.md` passes ~2,400 characters new facts stop reaching the prompt, and nothing compacts it.
- Non-owners at partner level or below see only a `## Preferences` section or nothing (`memory.ts:89-95`).
- **Transcript folding:** last 60 messages or 240k characters kept; older turns become an extractive summary (200 chars per line, 6,000 total) with no model call, written back over the session file (`runtime.ts:87-89,190-195,1078-1159`). Raw history is not kept.
- `audit.jsonl` is append-only but not hash-chained and stores a 300-character preview of every tool result, so Gmail snippets land in it (`runtime.ts:686-692`).
- No retention policy; "disconnect means delete" is specified (`docs/research/REQUIREMENTS.md:460-465`) but not implemented.

**Processing and agency.**
- Pi agent, sequential tools, medium thinking; every call passes a `beforeToolCall` permission check and is audited (`runtime.ts:322-339`). The system prompt is rebuilt each turn from 13 layers (`packages/core/src/prompt.ts:61-79`), and `instinct prompt --layers` shows the owner exactly what the model sees.
- Non-owner content (messages, mail, web pages, other agents) wrapped in `<untrusted>` tags; group threads cap everyone at the lowest trust tier present (`runtime.ts:905-919`).
- **Trust tiers:** owner, partner, family, friend, contact, stranger, against 26 capabilities, with time-boxed grants and dollar caps; outcome deny, ask or allow (`packages/core/src/policy.ts:31-60,278-300`).
- **Approvals:** "Reply YES or NO. Token XXXX" over iMessage or SMS (never email); 4-character tokens expiring in 2 h; an approval covers one exact call (same argument hash) within 15 min and ≤5% amount drift (`packages/core/src/approvals.ts:1-34`, `runtime.ts:649-683,970-987`).
- **Purchase rules:** ask above $50, $100 per action, $300 per day, flights and hotels always ask; strangers get 3 conversations a day of 10 messages (`policy.ts:81-98,187-214`). Payments use Link one-time cards.
- **Proactivity:** cron schedules created by the model or user; a 30 s in-process timer that marks a job as run *before* firing it, so a crash loses that run (`scheduler.ts:333-355`); schedules are pushed to Maritime so a sleeping VM wakes. The scheduled-run prompt says to reply only "if there is something worth telling your owner", and an empty reply is not sent (`prompt.ts:227-229`, `runtime.ts:510`). The spec's 3-per-day cap and 7am/4pm inbox scans are not implemented.
- **Cost:** no model-spend ceiling, call limit or turn cap; configured `fallback` and `cheap` models are never loaded (`config.ts:13-14,30` vs `boot.ts:97`); the gateway gives one operator Anthropic key to every user's agent (`packages/gateway/src/provision.ts:113`).
- `bash` runs in the workspace with a scrubbed environment but is "not a sandbox" (`packages/server/src/file-tools.ts:1-19`).

**Interface.** iMessage (tapbacks, typing, attachments), SMS, the agent's own email, A2A, local chat and CLI. Signup page and QR connect page; the onboarding skill asks one question per message (name, city, style, apps, partner, family) and offers a daily brief. Editable `PERSONA.md` ("texts like a capable friend… Say less. Do more"). No avatar or animation.

**Assessment.** The most complete open clone of Instinct's *agency and social* layer: trust tiers enforced in code, exact-call approval tokens, A2A coordination with typed intents, one-time cards, and a crash-safe webhook inbox. It has none of Instinct's *knowledge* layer: no ingestion, no memory search or curation, and a digest that silently stops admitting new facts. It is three days old.

### 6.2 OpenInstinct (Merit-Systems)

*Grade A. HEAD `c036ce4`.*

- **What it is:** "A personal iMessage assistant that can use a browser like you" (`README.md:5`), "not software intended for production use" (`README.md:243-244`). A single Next.js 16 app on Vercel built on the `eve` agent framework (0.67.2, patched), Postgres (Neon) with Drizzle, Vercel Blob, Kernel cloud browsers and Linq for iMessage.
- **Models:** root agent per workspace setting, default `openai/gpt-5.6-sol-fast` with low reasoning and compaction at 70% (`db/services/settings.ts:6,22-24`, `agent/agent.ts:9-27`); browser subagent `meta/muse-spark-1.3` (`agent/subagents/browser-agent/agent.ts:14`).
- **Connectors:** none as a contract. Linq iMessage channel, eve web chat, live Google tools (Gmail, Calendar, Contacts) with OAuth brokered by Vercel Connect (`shared/google-workspace/connection.ts:3-15`), Kernel browser, web search.
- **Ingestion:** **no historical import and no realtime capture.** Gmail search caps at 25 results and threads at the last 20 messages truncated to 12,000 chars (`agent/lib/google-workspace/gmail.ts:31-84`); nothing is persisted.
- **Storage and memory:** three slots — a file-memory profile on Blob, a structured `user_profiles` row injected each turn, and model-written **workstreams** (JSONB with objective, status, notes, next step, up to 8 sourced observations; `shared/workstreams/schema.ts:16-31`). The 8 most recent active workstreams are injected each turn; search is `ILIKE` (`db/services/workstreams.ts:18-62`).
- **Processing:** one agent in three modes: `interactive`, `scheduled-worker`, `scheduled-report` (`agent/lib/mode.ts:13-27`).
  - User-created schedules (`once`, `interval` 1 min to 1 year, `calendar`) run on a 1-minute cron that materialises and claims runs with `FOR UPDATE SKIP LOCKED` and leases (`agent/schedules/dynamic.ts:15-137`, `db/services/scheduled-agent-jobs.ts:184-324`).
  - Failures requeue at +5 min, dead-letter after 3 (`scheduled-agent-jobs.ts:621-659`).
  - **Worker and reporter split:** a separate `scheduled-report` turn in the user's conversation decides whether the result is worth sending or emits `<eve-empty-delivery/>` (`agent/instructions/content/role/scheduled-report.md:7-12`).
- **Safety:** vault secrets AES-256-GCM with AAD bound to workspace and id, filled by Kernel autofill via opaque handles (`db/services/vault.ts:173-224`, `agent/subagents/browser-agent/tools/fill_from_vault.ts:27-85`). `gmail-send` and `calendar-create-event` require approval. Regex redaction of OTPs, keys and card numbers before the model; but full-content logging is on (`agent/hooks/evlog.ts:3-10`).
- **Cost:** no budget ceiling; a 1-minute interval job spawns a full agent run every minute.
- **Assessment:** real scheduling engineering and a clean secret boundary, but not an Instinct-style system: nothing watches sources or originates suggestions.

### 6.3 OpenClaw core

*Grade A, sampled. HEAD `5566fd0`. Read: concept and gateway docs, channel plugin contract, WhatsApp inbound path, ingress retry policy, both SQLite schemas, plugin API types, channel health constants. Other channels from docs and greps.*

- **What it is:** a self-hosted assistant. One Gateway daemon owns all messaging surfaces and exposes a typed WebSocket API on `127.0.0.1:18789` (`docs/concepts/architecture.md:10-22`). Clients (CLI, Control UI, macOS app) and device nodes connect to it. About 150 extensions cover model providers, channels, memory engines and search.
- **Connectors:** `ChannelPlugin` is a bag of optional adapters (`src/channels/plugins/types.plugin.ts:48-102`); lifecycle via `startAccount`, `stopAccount`, QR login and logout (`types.adapters.ts:235-253`). Health monitor checks every 5 min, ≤10 restarts per hour, stale after 30 min silence (`src/gateway/channel-health-monitor.ts:19-22`, `channel-health-policy.ts:73`). Gmail, Drive, GitHub and Notion are on-demand CLI skills, not ingestion.
- **Ingestion:** **no historical backfill as a product feature.**
  - WhatsApp: `syncFullHistory: false` (`extensions/whatsapp/src/session.ts:305`); appends older than 60 s before connect skipped.
  - IMAP: existing mail baselined without dispatch; mail older than 48 h rejected (`docs/automation/imap.md:11,141,160`).
  - iMessage: downtime recovery only, ≤500 rows and ~2 h.
  - **Durable ingress queue** `channel_ingress_events` with claim token, attempts and dead-letter; backoff 1 s to 3 min, 8 attempts, dead-letter after 24 h (`src/state/openclaw-state-schema.sql:1301-1332`, `src/channels/message/ingress-retry-policy.ts:16-19`).
  - Imports that do exist: memory from Codex, Claude Code and Hermes; legacy sessions; `memory rem-backfill` over old daily notes.
- **Storage and memory:** transcripts in per-agent SQLite with zstd and FTS5 (`src/state/openclaw-agent-schema.sql:566-920`). Memory is Markdown (`MEMORY.md`, `USER.md`, daily notes, `DREAMS.md`), indexed into 400-token chunks with embeddings; hybrid BM25 + vector search with recency decay and MMR (`docs/concepts/memory-search.md:74-106`). No unified cross-channel message store. Sessions pruned after 30 days by default.
- **Processing:**
  - Realtime: per-session serial lane; queue default `steer` (inject into the running turn) with 500 ms debounce (`docs/concepts/queue.md:31-44`); auto-compaction preceded by a silent memory-flush turn.
  - Heartbeat every 30 min by default, honouring active hours (`docs/gateway/heartbeat.md:96-104`).
  - **Dreaming:** nightly cron (`0 3 * * *`) with light, REM and deep phases; promotion into `MEMORY.md` only past `minScore`, `minRecallCount` and `minUniqueQueries` (`docs/concepts/dreaming.md:51-81,214`).
- **Cost:** no spend cap found; usage display and context-light heartbeats only.
- **Assessment:** best-in-class durable ingress and plugin SDK; honest maturity scorecard (Memory "partial, 3 of 23"); no history import or unified store; single trust boundary.

### 6.4 OpenClaw Enterprise

*Grade A. HEAD `726b31a`.*

- **What it is:** "Kubernetes for agents" (`README.md:3`): a control plane (OCC) that deploys and governs one OpenClaw gateway per Agent. Installation → Namespace → Agent → immutable AgentRevision. TypeScript controller, Go CLI, Postgres, Helm.
- **Connectors:** infrastructure drivers (`ComputeDriver`, `SecretDriver`, `IAMDriver`, `SandboxDriver`, …; `packages/contracts/src/index.ts`). Slack is the only channel, and messages are handled by core's plugin inside the agent pod.
- **Ingestion:** none at the platform level.
- **Storage:** control-plane state in Postgres; agent data stays in core's SQLite and Markdown on a per-agent volume. Append-only `audit_events` enforced by trigger.
- **Processing:** reconciliation via a Postgres work queue with `SKIP LOCKED`, 60 s leases, 1–300 s backoff, 10 attempts.
- **Assessment:** real tenancy, RBAC and secret delivery; adds nothing to connectors, memory or proactivity. Several safeguards are marked planned.

### 6.5 Paperclip

*Grade A, large files sampled. HEAD `a027f76`.*

- **What it is:** "Open-source orchestration for teams of AI agents" — org charts, tasks, budgets, approvals and heartbeats (`README.md:31-37`). Postgres via Drizzle (embedded by default), one Node server with a 30 s scheduler tick.
- **Connectors:** five mechanisms, none for data ingestion:
  1. agent adapters for runtimes (`claude_local`, `codex_local`, `cursor`, …);
  2. "Apps v2" connections: 79 JSON `AppDefinition`s plus any remote MCP, with credentials, capability catalog, governance and audit (`doc/connections/README.md:52-57`); new or changed tools quarantined by schema hash (`server/src/services/tool-access.ts:7411-7485`);
  3. versioned AES-256-GCM company secrets;
  4. chat and email channels (Slack, GitHub, Discord, Teams, Telegram, AgentMail, iMessage);
  5. out-of-process plugins.
- **Ingestion:** push receipt tables for chat (`chat_deliveries`) and email (`email_messages`) with unique provider ids, attempts and backoff. AgentMail catch-up rewinds 5 min from a checkpoint and **refuses mail before activation** (`server/src/services/email-channels.ts:1847-1893`). GitHub events leased from a cloud relay with adaptive 5 s–5 min polling.
- **Storage:** normalised only; GitHub raw bodies deliberately not stored. No embeddings; search is lexical by design (`doc/SEARCH.md:65-70`). Memory delegated to third-party connectors with no background sync (`doc/connections/MEMORY.md:9-12`).
- **Processing:** events become issues plus `agent_wakeup_requests`; the agent pulls data through governed tools at run time. No historical or batch processing over external data.
- **Assessment:** the receipt-table and push-plus-reconciler patterns are worth copying; there is no corpus to learn from.

### 6.6 OpenMausBot

*Grade A. HEAD `dd64ea5`, v0.1.91.*

- **What it is:** "A local-first chat app for running a team of AI agents" (`package.json:5`): a Telegram-style roster of local agent CLIs (18 drivers) with a Node harness, React UI, Electron shell, and native Android/iOS companions.
- **Connectors:** Composio via a harness-owned stdio MCP bridge with per-boot loopback tokens (`server/connector-proxy.ts:1-11`, `server/composio.ts:604-611`); user MCP servers (max 20); per-bot tool grants enforced at call time.
- **Ingestion:** **no historical backfill.** Docs state "proactivity as an explicit trigger, not as a hidden heartbeat" (`docs/notification-and-proactivity-qa.md:3-7`).
  - Webhooks on `127.0.0.1:8800` with hashed secrets, delivery-id dedup kept 7 days, 10/min per endpoint (`server/webhook-ingress.ts`, `server/webhooks.ts:83-90,466-486`).
  - Routines: once, daily, cron, interval; 10 s tick; 12 h catch-up window (`server/routines.ts:327,1428`).
- **Storage and memory:** SQLite with FTS5 over messages and memory files (`server/message-db.ts:33-163`); Markdown memory per bot (`MEMORY.md`, topic files, archive, daily log) with an audit journal and undo (`server/memory-journal.ts`).
- **Processing:**
  - Before a turn: model-free auto-recall via FTS, fenced as "reference, not instructions" (`server/recall.ts:1-27`).
  - After a turn: quiet-window fact capture (2 min quiet or 6 turns; ≤8 facts at confidence ≥0.6; `server/memory-capture.ts:41-200`), then organise, then a nightly tidy that moves expired entries, merges duplicates and resolves contradictions with at most 20% struck per pass (`server/memory-tidy.ts:1-14`).
- **Cost:** monthly workspace spend cap, enforced only with the enterprise `budgets` entitlement (`server/spend.ts:8-9,96-137`).
- **Assessment:** the best memory-upkeep pipeline among the open repos; no source ingestion.

### 6.7 OpenMuse (CopilotKit)

*Grade A. HEAD `d0b3a6b`.*

- **What it is:** a self-hosted single-owner personal agent alpha: chat, background tasks, browser, container, PDF form filling, reviewed Gmail/Calendar writes (`README.md:37-58`). Hono server, Playwright worker, Expo app, PGlite or Postgres.
- **Connectors:** one hand-written Google client with PKCE, read scopes by default, AES-256-GCM token storage and a rotating connection "generation" that fences stale callbacks (`apps/server/src/google-auth.ts:56-153`).
- **Ingestion:** **none.** Latest 30 mails and next 31 days fetched live (`packages/integrations/src/google.ts:609-654`); a write-through cache upserted by provider id.
- **Storage:** one JSONB `records(owner, kind, id, data)` table with compare-and-swap (`apps/server/src/db.ts:47-140`). Memory is a flat user-written list injected wholesale.
- **Processing:** lease-based task worker polling every 1 s, 60 s lease, 20 s heartbeat (`apps/server/src/engine/worker.ts:48-182`). "Ideas" are three regexes over mail, refreshed every 15 min (`apps/server/src/engine/service.ts:545-600`).
- **Approvals:** proposals hash-bound to input, account, connection and calendar ETag, expiring in 30 min; writes never retried and marked `outcome_unknown` on ambiguity (`apps/server/src/actions.ts:66-160`, `google.ts:576-587`).
- **Assessment:** a careful action-review model and task worker; nothing for ingestion or proactivity.

### 6.8 OpenBot (CopilotKit)

*Grade A. HEAD `cb5dc32`, v0.1.0.*

- **What it is:** "The AI assistant your company can actually own", a template (`README.md:5,32,34`). A Slack-like roster of AI coworkers, each with its own Docker computer, behind a governance gateway. Bun, Hono, Postgres (~83 tables), CopilotKit Intelligence for threads (hard dependency).
- **Connectors:** a frozen first-party MCP catalogue (Parallel, Drive, Notion, Routines) plus Composio; credentials AES-GCM in Postgres; three-step grants (admin enables, admin grants per bot, user connects own account).
- **Ingestion:** **no historical backfill**; the document index and pgvector use were deleted in favour of "asking the vendor at the moment of the question" (`server/drizzle/0010_drop_the_document_index.sql:5-7`).
  - Memory sources: one read-only tool call with fixed arguments, re-run every 15 min, capped at 50 records (`server/src/memory/ingestion.ts:17-91`).
  - Signed webhooks for GitHub, Linear, Sentry, PagerDuty, SES email and Slack, with event, run and queue committed in one transaction (`server/src/responsibilities/triggers.ts`).
- **Memory:** flat `personal_memories` with provenance, `formed_by` (person, import, bot) and `review_state` (unreviewed, confirmed, edited); bot-formed memories visible only to that bot while it holds the source app (`server/src/db/schema/memory.ts:49-108`). Retrieval is the newest 40 rows by substring.
- **Proactivity — four sources:**
  - routines (15 min floor, 20 enabled, off after 10 failures);
  - responsibilities fired by triggers;
  - **opt-in proactive research** every 1–24 h, read-only enforced at tool dispatch, each claim citing a read made in that run, ≤5 suggestions per run, and work starting only when the person presses Start (`server/src/proactive/restriction.ts:1-108`, `engine.ts:157-428`);
  - self wake-ups (1 min to 7 days, ≤5 pending, ≤20 per day).
- **Safety:** CEL policy on every browser, file, shell and MCP call, fail-closed with the audit row written first; non-configurable hand-offs for credentials, security settings and payments (`server/src/approvals/policy.ts:83-108`).
- **Interface:** web, Slack/Teams via OpenTag, Twilio SMS, Expo push, realtime voice with `ask_agent` delegation; generative UI gallery and sandboxed admin-authored components; an animated gradient `AgentOrb` with idle, listening, thinking, streaming, done and error states (`app/src/components/agents/orb/ai-core.tsx:16-22`).
- **Assessment:** the deepest governance; the most principled unattended proactivity; shallow memory.

### 6.9 OpenDots (CopilotKit)

*Grade A. HEAD `c2569bb`.*

- **What it is:** "Always-on AI coworkers that move between text, calls, and Slack", a template (`README.md:5-15`). One Node process, Vite SPA, `node:sqlite`, OpenBot containers per Dot, CopilotKit Intelligence for conversations (hard dependency).
- **Connectors / ingestion:** **none** for personal data. Parallel web search, read-only Playwright reader, Slack mentions through CopilotKit's managed channel.
- **Memory:** user-entered preference list dumped into the prompt; "Automatic Learning" outsourced to CopilotKit (unverified live, `README.md:185`).
- **Proactivity:** a recurring prompt replayed into its thread by a 1 s ticker with a 180 s lease (`server/src/runner.ts`, `store.ts:192-246`); failed recurring tasks are not rescheduled. The README calls schedules "recurring instructions, not a complete goal or event-trigger system" (`README.md:187`).
- **Voice:** "two-brain" split; the realtime model has one tool, `ask_compute`, that delegates to the same Dot in the same thread, and the transcript is posted back as a call receipt (`src/server/voice.ts:74-234`).
- **Character:** four static plush PNGs chosen by id hash; CSS-only `bob` while working, desaturate when paused, tilt on needs-input, breathe while speaking (`src/client/Mascot.tsx`, `style.css`).
- **Assessment:** good kill-switch plumbing and voice delegation; nothing on ingestion or memory.

### 6.10 Open Dot (Composio community)

*Grade A. HEAD `f838e17`, single commit, v0.1.0.*

- **What it is:** a Mac desktop app (Electron + Next.js on `127.0.0.1:3100`) where you create named "dots", each with a job, its own browser and workspace, memory, rules, routines and triggers (`README.md:3-15`). Pitched as Dots "in 1/10th of the cost" (Karan Vaidya, X, 2026-09-30).
- **Models:** OpenAI Responses API `gpt-5.5`→`gpt-5`; `gpt-5.4-mini` for review and titles; `gpt-realtime-2.1` for voice; OpenRouter optional (`src/server/agent/client.ts:9-10`).
- **Connectors:** Composio MCP for tools (OAuth PKCE) and a separate Composio project for triggers on 12 apps (`src/server/triggers.ts:19-32`). Secrets AES-256-GCM with the master key in the macOS Keychain (`src/server/vault.ts:16-55`).
- **Ingestion:** no backfill; push via `composio.triggers.subscribe()` with no public webhook; **no cursor or dedup**, in-memory run inbox, events lost while the app is closed (`README.md:69`, `src/server/agent/runtime.ts:28-38`).
- **Memory:** flat per-dot fact list injected whole; skills as Markdown loaded on demand.
- **Processing:** up to 60 steps per run, one run per dot; E2B, Docker or local folder. Proactivity is user cron and triggers only, with "only if there's something worth telling them" as the sole notify logic (`src/server/agent/prompt.ts:72-74`).
- **Approvals:** each tool declares a description and default decision; a small model matches the action against natural-language allow/ask/never rules, fail-closed to ask; pending approvals persist across restarts (`src/server/agent/review.ts:12-49`).
- **Character:** a three.js "puffball" with configurable shape, material, eyes, accessory and colour; **animation driven by run status** — idle sway with cursor tracking, working bounce, waiting hop and wave, paused nap, blinking (`src/components/Dot3D.tsx:116-163`).
- **Assessment:** charming and cheap character, good approvals; no ingestion, no dedup, no cost guardrails.

### 6.11 Lemma platform

*Grade A, sampled. HEAD `f16a6c5`, v0.9.0. Read: root README and ARCHITECTURE, 9 of 17 module docs, agent-memory, agent-host, sandbox docs; targeted code in connectors, schedule, agent, agent_surfaces, datastore, usage, events/jobs, and frontend `call/`, `characters/`, `space/`. Not read: Rust desktop, SDKs, CLI, harness, tests.*

- **What it is:** "Hire an AI teammate" for teams (`README.md:5-11`). The unit is a **pod**: tables, files, agents, workflows, functions, permissions, apps and surfaces. FastAPI backend (17 modules), Next.js frontend, Tauri desktop over a private Linux VM, Postgres + Redis + object storage. AGPLv3 core.
- **Models:** pydantic-ai with Claude Sonnet/Haiku defaults; "Agent Host" dispatches runs to the user's local Claude Code, Codex, Cursor or OpenCode via ACP (`docs/architecture/agent-host.md:9-13`).
- **Connectors:** four kinds — composio, http, sql, mcp (`app/modules/connectors/domain/connector.py:32-38`); ~12 native and ~75 Composio toolkits. Surfaces (Slack, Teams, Telegram, WhatsApp, email per agent) are separate from connectors. Fernet-encrypted credentials; per-operation circuit breaker.
- **Ingestion:** **no historical import or continuous sync**; data fetched live via `run_connector_operation`. Every trigger is normalised to `schedule.fired`: webhooks (1 MB cap), a 5 s poller claiming due rows with `SKIP LOCKED` and coalescing missed runs, table triggers, and an optional **LLM `filter_instruction`** evaluated before a run starts (`app/modules/schedule/infrastructure/adapters/system_model_filter.py:54-72`). Idempotency via unique `(schedule_id, source_event_id)` and an outbox/inbox over Redis Streams.
- **Storage and memory:** per-pod Postgres schemas with forced RLS; pgvector (768-d bge or nomic) fused with FTS by RRF for uploaded files only. Memory is Markdown under `/memory` and `/me`, with four `AGENTS.md` indexes loaded each run; the docs state memory is not consolidated, deduplicated or reconciled (`docs/architecture/agent-memory.md:116-121`).
- **Processing:** 14 toolsets, subagents, durable workflows; per-run caps of 500 requests, 2 h and 15 consecutive tool failures that pause to ask. Unattended runs are told nobody is watching (`app/modules/agent/services/brief_lines.py:188-202`). Notifications capped at 20 per recipient per hour.
- **Character:** ~28 layered 2D puppets (raster bodies, SVG eyes) with continuous breath, sway and drift plus short "beats" (`lemma-frontend/src/app/characters/life.ts:3-26`); its README says these are "simulated character studies, not live agent activity".
- **Voice:** a "Jev" classifier routes each utterance (voice, snapshot, existing work, new work, clarify) and decides whether a background event is spoken, kept silent or ignored (`lemma-frontend/src/call/jev-router.ts:3-19`).
- **Assessment:** the most production-grade trigger and permission engineering; no personal ingestion; memory explicitly unconsolidated.

---

## 7. Other closed products

### 7.1 Pickle

*Grade B: "How we make Critter act in real time" (2026-07-18), "How your Pickle protects your privacy" (2026-10-01), App Store listing v1.1.9; launch post by Daniel Park (X, 2026-10-01).*

**Concept.** "A personal AI you raise. It gets things done for you and makes friends of its own." iPhone only, San Francisco Bay Area, 18+.
- Every Pickle is born at **Lv. 1** and grows as it earns trust; time spent together becomes **bubbles** that feed its energy, and more energy means it can do more.
- It has its own computer to order, book, pay and research, "always with your yes".
- It floats above a **map of your city** with everyone else's Pickles, strikes up conversations, and brings back introductions, nearby events and marketplace items.
- Friends can talk to your Pickle directly to make plans.

**Character system (Critter).**
- Starts from Blender Studio's openly licensed Critter (CC BY 4.0).
- **Rig values, not pixels:** the server sends 257 control values per frame at 60 fps; the device renders. Form lives in the asset, so it never drifts, and resolution costs the server nothing.
- **Pipeline:** audio drives NVIDIA Audio2Face-3D (68 blendshapes at 60 fps) and a 6-channel head-pose model; a designed physics layer with zero learned weights derives the body from head pose, amplified 3.5× and propagated with delay and inertia from chest to tail.
- **Latency:** the reply and its motion are drafted while the user is still speaking and discarded if they keep talking; 500 ms budget; first visible reaction +400 ms versus +800 ms for a diffusion avatar.
- **Cost:** about a tenth of an L40S per stream, roughly **$0.003/min** of GPU, versus $0.10–0.37/min retail for avatar streams.
- **Evaluation:** blind preference over a diffusion avatar in 86.8% of 250 judgements.
- **Taste loop:** parameters tuned in an agentic loop against measurements from the film, then a person picks the better motion.
- **Next:** listening motion from the user's voice and movement; the LLM directing gestures via a tool call.
- **Design stance:** a stylised creature avoids the uncanny valley and is "honest. The being is an AI, and the form says so."

**Privacy architecture.**
- **Credential Enclave** on AWS Nitro: Google issues tokens to the enclave; the enclave adds the token to allowed requests and never returns it. Attestation plus public enclave code lets users verify what runs.
- The token's encryption key is created on the iPhone and stored in iCloud Keychain; derived keys go only to a verified enclave for a limited time.
- **Grants** of 1–30 days for background work; the enclave erases its key when a grant expires.
- **Write-once usage records:** the enclave saves a signed, encrypted record before each credential use and refuses if the save is not confirmed; kept 365 days in storage even the AWS root user cannot delete.
- **Vault tool** fills passwords and cards without passing them through the model; filled values are hidden from page text; screenshots refused if a secret is exposed. Payments can use single-use Stripe Link cards bound to merchant and amount.
- **Admitted limits:** memories and conversations are on Pickle's servers with AWS-managed keys; authorised staff can read them through logged tools; disconnecting Google does not remove what is already in memory.
- **Clones and contextual integrity:** when your Pickle talks to others it acts as a "clone" with the same memory but read-only tools; sharing settings are an upper bound (public profile, friends, "Never shared", per-person instructions); automatic sharing is off per connection; if rules change mid-reply, the reply is stopped and reconsidered. A separate sharing checker is planned.

### 7.2 Underdog

*Grade B: underdog.ai, underdog.ai/security (updated 2026-09-29), founder manifesto and Husky posts by Sigil Wen (X, 2026-09-22 and 2026-10-02).*

- **Concept:** "The most loyal AI" for email, calendar, meeting notes, dictation and errands, running **100% locally**. Mac now, Windows beta; Linux, iPhone and Android announced. Invite-only. Backed by a16z, Khosla and others.
- **Models:** its own — Woof 4B (~115 tok/s on a MacBook Air) and Underdog 27B built on Qwen 3.8 27B (28 tok/s; claims 33.7 vs 31.9 for Claude Opus 4.6 Max on the Artificial Analysis index, using the base model's scores).
- **Inference:** Husky, a model-specific inference engine claimed up to 4.5× faster than MLX (730 tok/s quoted for Woof on a MacBook).
- **Data handling:**
  - Mail and calendar sync directly between the Mac and Google or Microsoft; Underdog runs no email servers.
  - Summaries, drafts, meeting notes and dictation are produced on the Mac; audio is never uploaded.
  - Mail, calendar and saved logins encrypted with AES-256, key in Apple Keychain, this device only; each account gets its own vault.
  - Memories stored on the computer, viewable and editable in Settings.
  - Remote images, scripts and tracking pixels stripped.
  - **Naval mode:** one switch so it only talks to servers it needs.
  - What the company receives: account email, membership, optional daily usage counts, optional crash reports.
- **Assurance:** ADA CASA Level 1 passed (Leviathan, all 20 requirements); Google restricted-scope approval for Gmail and Calendar; penetration test and an independent app teardown under way.
- **Agency:** a browser agent that asks before it buys, pays, sends or deletes, and fills saved passwords without reading them.
- **Persona:** a dog — "Adopt Underdog", "Bring me home", "Good days start with a good dog".
- **Thesis (manifesto):** "The only data that can't leak from a server is data that was never sent to one"; most everyday work does not need a frontier model; "today's frontier intelligence reaches your devices in six months".

### 7.3 OpenAI Dots

*Grade D, not studied directly.* OpenAI announced "dots, powered by GPT-6 Astra… always-on agents built to handle everything" on 2026-09-29, for Pro users (per Karan Vaidya). TechCrunch's headline calls it "its bubbly agentic avatar". Open Dot, OpenDots and Lemma all position themselves against it, which is why character and per-agent computers feature so heavily in their launches.

### 7.4 Texting-agent roundup

*Grade D: TechCrunch, 2026-10-03.*

| Product | Channels | Focus | Notable |
|---|---|---|---|
| Caddy | iMessage, RCS | Turn phone info into actions | Watches calendars and conversations for things needing action |
| Fambot | App, SMS | Family chief of staff | Nightly summary of tomorrow; Gmail and Google Calendar |
| Folk | iMessage, WhatsApp, Telegram | General | Own private cloud computer; $8.33/mo Pro for background tasks |
| Instinct | WhatsApp, iMessage, voice | General | See [section 5](#5-instinct-closed-product) |
| Iris | iMessage | General | Powered by Hermes agent; proactive follow-ups |
| Martin | SMS, phone, WhatsApp, email, Slack, app | General | Calls on your behalf; daily summaries; from $21/mo |
| Miso | iMessage | Travel | AI plus a human travel team; loyalty points |
| Ohai | Text, voice, email forwarding | Family | From $9.99/mo by family size |
| Ollie | Text | Family | SOC 2; $25/mo for 150 messages |
| Orbits | App, text | Household | Contacts service providers; a16z Speedrun |
| Pally | Chat | General | Connects WhatsApp, Gmail, calendars, Drive; call-minute pricing |
| Poke | Text | General | First agent on Apple Messages for Business; acquired by Cognition |
| Rene | iMessage, Telegram, WhatsApp | "Best contact" | Browser, code, shopping, slides |
| Skye | iPhone home screen | Proactive surface | "Agentic homescreen" of contextual cards and audio briefings |
| Stanley | iMessage, Telegram, web | Content creators | Uses Instagram context to suggest posts |
| Tomo | iMessage | Groups, accountability | Joins group conversations; $19.99/mo |
| Town | Multi | Professional | $55M Series A |
| Wajo (Fo) | Calls, email, group chats | General | Own email, phone and card; human fallback |

Patterns: iMessage is the default surface and WhatsApp second; families are a crowded niche; giving the agent its own identity (email, phone, card) is spreading; only Skye and Fambot lead with proactive surfaces.

---

## 8. Cross-cutting analysis

### 8.1 How systems get context
Three models exist, in increasing order of knowledge and cost:

1. **Told only.** The agent knows what the user typed plus a manual preference list. *OpenDots, OpenMuse.*
2. **Asks at question time.** Sources are tools (Composio, MCP, native APIs) called live; nothing is stored except what the model chooses to remember. *Paperclip, OpenBot, Open Dot, Lemma, OpenMausBot, OpenInstinct, open-instinct, OpenClaw skills.* OpenBot deleted its document index on purpose to stay here.
3. **Captures and understands.** Sources are copied into a store and processed before anyone asks. *SuperTwin* (from history), *Instinct* (Gmail at onboarding plus raw events), *Underdog* (mail synced to device), *OpenClaw channels* (from connection onward).

Model 2 is cheap and always fresh but cannot answer "what has changed in my life" or notice patterns; it re-fetches on every run with no memory of what was already seen. Model 3 is what makes an agent feel like it knows you (Yash on Gmail onboarding), and is where SuperTwin is ahead.

### 8.2 Historical versus steady-state data

| Approach | Historical | Steady state |
|---|---|---|
| SuperTwin | Model reads old data: day bundles newest-first, digests, replay on window change | Every consented event, batched by window |
| Instinct | Gmail at onboarding; raw events curated nightly into notes | Timers, reviewer three times a day |
| OpenClaw | Nightly dreaming over notes the agent already wrote | Model runs only when addressed; heartbeat |
| OpenMausBot | Nightly tidy over its own memory | Fact capture after turns |
| Lemma, OpenBot, Open Dot, Paperclip | None | Triggers and schedules start runs |
| OpenDots, OpenMuse, OpenInstinct, open-instinct | None | Timers re-query from scratch |

Nobody except SuperTwin runs a model over third-party history. The consolidation jobs that do exist (OpenClaw dreaming, OpenMausBot tidy, Instinct curation) all run **nightly over Markdown**, with gates: OpenClaw requires minimum score, recall count and distinct queries; OpenMausBot caps deletions at 20% per pass; Instinct scrubs one-time codes.

### 8.3 Memory representation
- **Markdown as source of truth** is the majority choice (Instinct, OpenClaw, OpenMausBot, Lemma, open-instinct). Advantages: inspectable, diffable, editable, cheap. Weakness: provenance and supersession live in prose, which is exactly where the Instinct interview found failures (English-only rule weakened; price correction without a version trail).
- **Markdown without upkeep fails quietly.** open-instinct's append-only `MEMORY.md` is injected from the top within a fixed budget, so new facts stop reaching the prompt after ~2,400 characters. Lemma states its memory is never consolidated. Curation (Instinct), dreaming (OpenClaw) or tidy (OpenMausBot) is what keeps file memory useful.
- **Flat fact rows** (OpenBot, Open Dot, OpenMuse, OpenDots) are simplest; OpenBot adds provenance, `formed_by` and `review_state`, which is the minimum worth having.
- **Typed claims with evidence and supersession** (SuperTwin) are stronger on exactly the axes the interview found weak, but harder for users to inspect.
- **Vectors are optional.** Instinct, Paperclip and OpenBot use none; OpenClaw and SuperTwin use hybrid; Lemma uses vectors for files only.

### 8.4 Agentic architecture
- **Chat agent plus task worker** is near-universal: Instinct, OpenInstinct (browser subagent), Lemma (subagents), OpenBot (typed handoffs), Open Dot and OpenDots (voice delegation), Pickle (agent plus read-only clone).
- **Steering and reply routing:** Instinct, OpenClaw (`steer` queue mode) and open-instinct (`steer()` after a 20 s acknowledgement) inject new messages into a running turn. The interview shows routing replies to the right message is a reliability requirement, not a nicety.
- **A computer per agent** (E2B, Kernel, Docker, VM) with a persistent logged-in browser is standard across Instinct, Pickle, Folk, OpenBot, OpenDots, Open Dot, Lemma, OpenInstinct and OpenMuse.
- **Own identity:** Instinct (email, calls), Wajo (email, phone, card), Lemma (email per agent), open-instinct (Inkbox phone number, iMessage, email, A2A endpoint), Pickle (single-use cards).
- **Agent-to-agent:** open-instinct (typed A2A intents with fan-out to several contacts), Pickle (clones talking to other Pickles) and Instinct's Trusted Person Network all treat other people's agents as a channel, gated by trust tiers or sharing rules.

### 8.5 Proactivity spectrum

| Level | Mechanism | Examples |
|---|---|---|
| 0 | None | Paperclip (work platform) |
| 1 | Regex or rules over fetched data | OpenMuse "ideas" |
| 2 | User- or model-authored cron or interval prompts | OpenDots, OpenInstinct, open-instinct, OpenMausBot, Open Dot |
| 3 | Event triggers with an LLM gate before running | Lemma `filter_instruction`, OpenBot responsibilities, Open Dot triggers |
| 4 | Agent self-schedules follow-ups | OpenBot wake-ups, Instinct wakes |
| 5 | Periodic reviewer or heartbeat over everything known | Instinct reviewer (3×/day), OpenClaw heartbeat (30 min), OpenBot read-only research (1–24 h) |
| 6 | Every captured event evaluated as it arrives | SuperTwin |
| Social | Agent acts in a network | Pickle (roams, introductions), Instinct Trusted Person Network, open-instinct A2A |

Design lessons:
- **Separate the decisions.** Instinct's goal / wake condition / alert rule, OpenInstinct's worker versus reporter, and Lemma's trigger filter all keep the "should I interrupt" judgement apart from the work.
- **Enforce read-only by dispatch, not prompt,** for unattended runs, and require each claim to cite a read made in that run (OpenBot).
- **Suggestions become work only on a human tap** (OpenBot Start, OpenMuse accept).
- **Caps are the common flood control;** nobody has a real salience ranker. Instinct's "no noise" personality is a product stance, not a disclosed mechanism.

### 8.6 Interface and channel
- Messaging threads dominate: Instinct's article argues the three-state thread (message, typing, reply) plus steering is a strength, and that onboarding is easier when the first step is sending a message.
- Apps are added for things threads cannot show: a live browser view (OpenBot, OpenDots, Open Dot), generative UI (OpenBot, Lemma), characters (Pickle).
- Voice is converging on the two-brain split: a realtime model for speech with one delegation tool (OpenDots `ask_compute`, OpenBot `ask_agent`, Open Dot `send_task`), plus Lemma's Jev router for whether to speak background events.

### 8.7 Character and animation

| System | Form | What drives motion | Cost model |
|---|---|---|---|
| Pickle | Rigged 3D creature (Critter) | Its own voice → face blendshapes + head pose → physics body | ~$0.003/min GPU, rendered on device |
| Open Dot | three.js puffball | Agent run state | Client only |
| Lemma | Layered 2D puppets | Ambient loop, not agent activity | Client only |
| OpenBot | Gradient orb | Voice state and audio amplitude | Client only |
| OpenDots | Static plush PNGs | CSS bob/tilt/breathe by state | Client only |
| OpenAI Dots | "Bubbly agentic avatar" (D) | Not studied | Not studied |
| SuperTwin Pocket Hero | Local generated 2D mascot | Canned clips (idle, wave, celebrate) | Local FLUX.2 Klein |
| Instinct | None | n/a | n/a |

Observations:
- **Motion should reflect real state.** Open Dot's mapping (working bounce, waiting wave, paused nap) makes the character an honest status indicator; Lemma's is decorative by its own admission.
- **Stylised beats photoreal:** Pickle argues a creature avoids the uncanny valley and signals that the being is an AI.
- **Rig values beat video:** Pickle's two-orders-of-magnitude cost gap comes from sending numbers instead of pixels.
- **Game mechanics drive sharing:** Pickle's levels, bubbles and city map turn context-sharing into play; App Store reviews mention Tamagotchi nostalgia.

### 8.8 Privacy and security
- **Where data lives:** on device (Underdog, SuperTwin store), self-hosted (OpenClaw, OpenBot, Lemma), vendor cloud (Instinct, Pickle), or split with a third-party cloud (OpenBot and OpenDots threads in CopilotKit Intelligence; Composio-held tokens).
- **Credential custody:** brokered so the model never sees tokens (Paperclip, OpenMausBot, Pickle enclave, OpenInstinct Vercel Connect); vault fills that bypass the model (Pickle, OpenInstinct, Open Dot, OpenBot, Underdog).
- **Verifiability:** Pickle publishes enclave code and attestation; Underdog publishes audits; SuperTwin has neither yet.
- **Disconnect versus delete:** Pickle states plainly that disconnecting does not remove memories; SuperTwin's delete cascade is a genuine advantage if made visible.
- **Encryption at rest:** Underdog (AES-256, Keychain), Open Dot vault, OpenMuse tokens; SuperTwin's store and whatsmeow session are unencrypted.

### 8.9 Cost and economics
- Instinct: free, over-provisioned, monetisation via transactions (D).
- Underdog: local inference, no token cost; bets on small models catching up in six months.
- Lemma: Agent Host reuses the user's existing coding-agent subscription.
- OpenMausBot: the user's own CLI subscriptions.
- Pickle: rig animation at ~$0.003/min.
- SuperTwin: the only hard, latching spend ceiling, which is a real advantage for a product that runs a model over every event.

---

## 9. Implications for SuperTwin

Ranked by expected impact. "Fits" notes how each lines up with what SuperTwin already has.

1. **Add Gmail as a source, with onboarding import.**
   - *Evidence:* Instinct's onboarding Gmail read is credited with making it feel personal fast (D); nearly every product starts with Gmail; Underdog shows it can be done device-direct.
   - *Fits:* the `SourceAdapter` + manifest contract (only WhatsApp uses it today), consent windows and newest-first history bundles.
   - *Patterns to reuse:* Paperclip's push plus checkpointed pull reconciler that rewinds a few minutes; receipt rows with unique provider ids.

2. **Split proactive decisions into goal, wake condition and alert rule,** and keep the alert judgement separate from the work.
   - *Evidence:* Instinct (D), OpenInstinct reporter, Lemma trigger filter.
   - *Fits:* the decide queue and prepared actions; the alert step is where SuperTwin can prove "no noise".

3. **Make unattended runs read-only at dispatch and require citations.**
   - *Evidence:* OpenBot enforces this at the tool dispatcher; Instinct's self-explanations were unreliable (C).
   - *Fits:* SuperTwin's evidence-carrying claims and the HMAC send gate.

4. **Give the twin a character whose motion reflects real state.**
   - *Evidence:* Pickle, OpenAI Dots, Open Dot, Lemma.
   - *Fits:* the Pocket Hero MVP already generates a mascot locally; driving it from worker state (capturing, understanding, waiting for approval, paused, budget-held) would make it an honest status indicator. Pickle's rig-values design is the path if voice is added.

5. **Encrypt the store and the whatsmeow session with a Keychain-held key.**
   - *Evidence:* Underdog, Open Dot, Pickle.
   - *Fits:* `src-tauri/src/keychain_broker.rs` already brokers Keychain for ChatGPT OAuth.

6. **Journal ingress durably and persist cursors.**
   - *Evidence:* OpenClaw's `channel_ingress_events` (journal before advancing the cursor, tombstones, dead-letter); Paperclip receipts; Lemma's outbox/inbox.
   - *Fits:* fixes in-memory browser cursors, WhatsApp pagination anchors and in-memory scheduler state.

7. **Keep human-readable memory alongside typed claims.**
   - *Evidence:* Instinct, OpenClaw, OpenMausBot, Lemma use Markdown; the interview shows its provenance weaknesses.
   - *Fits:* render claims as inspectable notes with "you told me / I inferred / applied only to that task" labels, preserving SuperTwin's provenance advantage.

8. **Borrow memory-upkeep gates.**
   - *Evidence:* OpenMausBot quiet-window capture, organise and nightly tidy (≤20% struck per pass, journaled with undo); OpenClaw promotion gates.
   - *Fits:* T2/T3 consolidation, and a cheaper path for low-tier streams.

9. **Decide whether the WhatsApp link is also a surface.**
   - *Evidence:* every messaging-first product treats the thread as the interface; Instinct's steering and reply routing are its core UX.
   - *Fits:* SuperTwin already holds the connection and a gated send path; reply binding must carry message ids (interview finding 2.5).

10. **Treat approvals as bound objects.**
    - *Evidence:* OpenMuse hash- and ETag-bound proposals with `outcome_unknown`; open-instinct YES/NO tokens bound to one exact call (argument hash, 15 min, ≤5% amount drift, never approvable by email); Open Dot natural-language rules reviewed by a small model; Lemma approve-once runs with the approver's authority; Pickle single-use cards.
    - *Fits:* extends the single-use HMAC token beyond WhatsApp sends.

11. **Plan a contextual-integrity model before any social feature.**
    - *Evidence:* Pickle's clone with read-only tools, sharing settings as an upper bound, "Never shared", and mid-reply reconsideration; open-instinct's six trust tiers against 26 capabilities, with group threads capped at the lowest tier present; Instinct's Trusted Person Network.

12. **Publish verifiable claims.**
    - *Evidence:* Pickle's attested enclave and Underdog's audits.
    - *Fits:* SuperTwin's differentiator per the interview is "the user can inspect why the twin believes something"; a public security page and visible captured/indexed/understood ranges would make it concrete.

What SuperTwin should **not** copy:
- Tools-only context (model 2): it gives up SuperTwin's main advantage.
- Unbounded spend: every competitor without ceilings can be driven by one noisy trigger.
- Decorative animation unrelated to state.

---

## 10. Appendix: sources, commits and open questions

### 10.1 Repositories studied (read-only shallow clones)

| Repo | Commit | Date | Coverage |
|---|---|---|---|
| SuperTwinV13 (this repo) | `8159e7e` | 2026-09-30 | Source pipeline read |
| mariagorskikh/open-instinct | `a4df7ee` | 2026-10-05 | Broad |
| Merit-Systems/OpenInstinct | `c036ce4` | | Full |
| openclaw/openclaw | `5566fd0` | | Sampled |
| openclaw/openclaw-enterprise | `726b31a` | | Broad |
| paperclipai/paperclip | `a027f76` | 2026-09-29 | Large files sampled |
| milind-soni/OpenMausBot | `dd64ea5` | 2026-09-30 | Broad |
| CopilotKit/OpenMuse | `d0b3a6b` | 2026-09-29 | Full |
| CopilotKit/openbot | `cb5dc32` | 2026-10-02 | Broad |
| CopilotKit/OpenDots | `c2569bb` | 2026-10-02 | Full |
| composio-community/open-dot | `f838e17` | 2026-09-30 | Full |
| lemma-work/lemma-platform | `f16a6c5` | 2026-10-02 | Sampled |

### 10.2 Web sources

| Source | URL | Date |
|---|---|---|
| Instinct interview | [`InstinctResearch.md`](../InstinctResearch.md) | 2026-09-12 |
| Richard (@RMladek) on Instinct internals | https://x.com/RMladek/status/2105057398566367666 | 2026-09-30 |
| Yash (@yashhsm), "Why Instinct feels Magical" | https://x.com/yashhsm/status/2105380670688346335 | 2026-10-01 |
| Karan Vaidya, Open Dot launch | https://x.com/KaranVaidya6/status/2105334408932954604 | 2026-09-30 |
| Atai Barkai, OpenBot launch | https://x.com/ataiiam/status/2090125716767773120 | 2026-08-19 |
| Atai Barkai, OpenDots launch | https://x.com/ataiiam/status/2105710796198322659 | 2026-10-01 |
| Ayush Gautam, Lemma launch | https://x.com/_ayush_gautam_/status/2106075942645047499 | 2026-10-02 |
| Daniel Park, Pickle launch | https://x.com/danifesto/status/2105721921623232995 | 2026-10-01 |
| Pickle, Critter real-time animation | https://pickle.com/how-we-make-critter-act-in-real-time | 2026-07-18 |
| Pickle, privacy architecture | https://pickle.com/how-your-pickle-protects-your-privacy | 2026-10-01 |
| Pickle, App Store | https://apps.apple.com/us/app/pickle-raise-your-ai/id6795790129 | v1.1.9 |
| Underdog site and security page | https://underdog.ai/ , https://underdog.ai/security | 2026-09-29 |
| Sigil Wen, Underdog manifesto | https://x.com/0xSigil/status/2105782954094182442 | 2026-10-02 |
| Sigil Wen, Husky inference engine | https://x.com/0xSigil/status/2102165862065328538 | 2026-09-22 |
| TechCrunch texting-agent roundup | https://techcrunch.com/2026/10/03/all-the-ai-agents-that-can-live-in-your-text-messages/ | 2026-10-03 |

### 10.3 Open questions
1. How does Instinct's onboarding Gmail import scale (full mailbox or a window), and how does it reconcile with the Sept 3 raw-event floor observed in the interview?
2. Do Instinct's `wake-subscriptions` and `proactive-value-creation` skills implement event triggers, or only timers?
3. What does OpenAI Dots' avatar react to, and how is it rendered?
4. Can Underdog's local models handle SuperTwin-style continuous understanding within a laptop's power and memory budget?
5. Would SuperTwin users accept a messaging thread as the primary surface given the app already exists?
6. What is the right cost envelope for a state-driven character in the Tauri shell (Canvas 2D, three.js, or rig values)?
