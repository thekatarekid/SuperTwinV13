# SuperTwin-WhatsApp — Build Spec

Mac desktop app: proactive personal AI assistant fed by WhatsApp. Local-first, private, agentic.

## Critical Assessment (read first)

- **WhatsApp ban risk**: whatsmeow is unofficial. Use a secondary number or accept risk. Never auto-send messages in v1 — read-only ingestion + drafts only.
- **Spaces are the core organizing unit** (not chats, not loose tasks): spaces = the threads running in a person's life — recurring (weekly grocery) to one-time (dinner with a friend) to long-running (job search, health). Chat↔space is many-to-many: one chat holds many spaces; one space draws from many 1:1 chats and groups.
- **Structure is adaptive, with two invariants**: every space has (a) **at least one goal** (even trivial — grocery space goal = "groceries stocked weekly") and (b) a **latest update** — one-line "what you should know now" (can be an active task, a closed task, or a state change). Milestones only when warranted (trip/job-search yes, grocery no); whether tasks exist depends on what's live in the space. Extractor decides structure intelligently — no empty scaffolding.
- **Spaces are living**: they update as new data arrives and as older history syncs in; state, structure, and membership evolve continuously.
- **Source-agnostic from day 1**: WhatsApp is source #1, not the architecture. Brain must ingest future sources (multiple emails, Slack, ambient voice, screen recording) without schema rewrites.
- **Explicit vs implicit tasks are different products**: explicit = user/contact stated it. Implicit = assistant inferred intent from space context. Show separately; implicit ones are suggestions and always need approval. Getting implicit inference wrong erodes trust fast — tune for precision over recall.
- **Ontology discipline**: schema-complete ≠ hallucinate-complete. A Workflow/Habit node requires ≥2–3 observed repetitions or explicit user statement; everything carries confidence + provenance.
- **Proactive auto-execution is dangerous**: default = propose task → user approves → execute. Auto-execute only whitelisted task types (research, summaries). Anything outward-facing (messages, emails, purchases) always needs approval.
- **Brain = full ontology + knowledge graph in v1** (decided): schema-complete from day 1 so future sources plug in without migrations. Mitigation for extraction-quality risk: all node/edge types exist in v1, but population is incremental — Spaces/People/Tasks extracted at full strength; Workflows/Habits populated conservatively (lower confidence, shown as candidates until confirmed by repetition or user).
- **Graph store**: embedded, not a server. SQLite property-graph (`nodes` + `edges` tables) + sqlite-vec embeddings — one file, queryable, zero ops. Swap to Kuzu later only if traversal perf demands it. Markdown wiki stays as the narrative layer Claude reads/writes natively.
- **Cost/latency**: don't run extraction per message. Batch per chat every N minutes / on conversation lull.
- **Feedback loop (step 5) is not a phase** — it's a thin feature. Folded into Phase 5.

## Architecture

- **Source adapter layer (future-ready core)**: every source implements one interface — `connect / backfill(range) / stream → emit Event`. Canonical `events` table: `events(id, source_id, source_type, channel_id, actor_id, ts, kind, text, media_path, raw_json)`. WhatsApp messages, future emails, Slack messages, voice-transcript segments, screen-capture summaries all become Events. Brain/extraction only ever sees Events — adding a source = writing an adapter, zero brain changes.
- **Ingest daemon (source #1)**: Go binary using [whatsmeow](https://github.com/tulir/whatsmeow) (WhatsApp Web multidevice, QR pair, sqlstore for session). Runs as Tauri sidecar, emits Events.
- **DB**: single SQLite file (`supertwin.db`), WAL mode. Tables: `sources`, `events` (above), `channels` (chats/inboxes/rooms), `actors`→`people` mapping, `spaces(id, name, type: recurring|one_time|long_running, permanence: permanent|ephemeral, status, latest_update, latest_update_ts, ends_at)`, `goals(space_id, recurring?)` (≥1 per space), `milestones(goal_id)` (optional), `tasks(space_id, goal_id?, origin: explicit|implicit, status, execute_at, recurrence?)`, `space_events(space_id, event_id)` (many-to-many), `extraction_runs`. FTS5 on `events.text`.
- **Brain**: `~/SuperTwin/brain/` markdown wiki — `spaces/<slug>/space.md` (goals, milestones, state, open questions) + `spaces/<slug>/log.md`, `people/<name>.md`, `me/goals.md`, `me/preferences.md`, `me/procedures/*.md`. SQLite = structured truth; markdown = narrative context Claude reads during execution.
- **Knowledge graph (full v1 ontology)**: property graph in SQLite — `nodes(id, type, name, props_json, confidence, source_refs, created_at, updated_at)`, `edges(src, rel, dst, props_json, confidence, source_refs)`, sqlite-vec embeddings on nodes + events for semantic retrieval.
  * **Node types**: Person, Organization, Place, Space, Goal, Milestone, Task, Event, Topic, Artifact (docs/links/media), Workflow (multi-step process the user runs, e.g. "monthly invoicing"), Habit (recurring behavior + cadence, e.g. "gym Mon/Wed/Fri", "grocery every Sunday"), Preference (likes/dislikes/defaults + strength).
  * **Edge types**: participates_in, belongs_to, depends_on, mentions, about, knows/related_to (person↔person + relationship label), assigned_to, derived_from (provenance), precedes (workflow steps), evidences, prefers, located_in.
  * Everything has confidence + provenance (`derived_from` → events). Retrieval for agent context = graph traversal (structure) + vector search (similarity) + FTS (keywords), merged.
- **Memory types** (mapped onto the above): **temporal** = `events` timeline; **episodic** = `spaces/<slug>/log.md` + task transcripts; **semantic** = the knowledge graph; **procedural** = Workflow/Habit/Preference nodes + `me/procedures/*.md` (feedback-derived rules). Task executions write back into episodic + semantic + procedural.
- **Spaces are multi-source**: a space aggregates Events from any source (v1: WhatsApp; later: email + bookmarks + Slack feeding the same trip space) plus its own task-execution history.
- **Extraction engine**: Node/TS worker, two stages per Event batch: (1) **assign** — route events to existing spaces or propose a new space (cluster across chats/groups/sources); (2) **extract** — within each touched space, update state + structure (add goals/milestones only if warranted), pull explicit tasks, infer implicit intents. Handles out-of-order history backfill: older events can reshape a space retroactively. One `claude -p` call per stage, structured JSON out.
- **Task executor — Paperclip-style adapter (chosen over Cabinet's after repo review)**: uses your Claude subscription via local CLI. Implement per `paperclip/packages/adapters/claude-local`:
  * Invocation: `claude --print - --output-format stream-json --verbose` (prompt via **stdin**, not argv); `--resume <sessionId>` for follow-ups; `--max-turns`; per-run timeout with typed error codes.
  * **Session guards** (Paperclip's key lesson): validate sessionId is UUID, matches saved cwd + prompt-bundle before resuming; detect poisoned sessions (bad `previous_message_id` → 400s on every resume) and drop them; validate-before-persist.
  * **Token economy**: inject system/agent instructions via `--append-system-prompt-file` only on fresh sessions — resumed sessions already have them cached (saves 5–10K tokens/run).
  * **Permissions**: explicit `--allowedTools` whitelist per task type — NOT `--dangerously-skip-permissions` (Cabinet's approach; unacceptable for an ambient assistant).
  * **Quota awareness**: track subscription usage windows, back off near limits (port Paperclip's quota module).
  * Wrap it behind a Cabinet-style thin provider interface (their best idea — ~135-line contract + registry) so Codex/Gemini/local models can slot in later.
  * Robust stream-json parser → live UI transcript (deltas, tool calls, usage, session_id).
- **App**: Tauri 2 + React + TypeScript. Tabs: Inbox (messages), Spaces (goal trees, tasks, people), Agent (task runs), **Chat** (talk to Claude over your own data), Settings.
- **Chat with AI (permanent feature, grows each phase)**: chat UI over the adapter, session resume for multi-turn. From Phase 2 onward Claude gets brain access (graph + FTS + vector + space files) and **cites sources** — answers link to spaces, people, tasks, and original messages. Effectively natural-language search over the user's life. Phase progression: P0 plain chat → P2 chat grounded in brain w/ citations → P3 chat can create/modify tasks & spaces ("add this to my Goa trip") → P4 chat can trigger executions.
- **Scheduler**: node-cron in the TS backend; tasks have `execute_at` (null = immediate-on-approval).

## Phases

Each phase ends with a UI checkpoint you verify before continuing.

### Phase 0 — Skeleton + Claude adapter
- Tauri app scaffold, 4 empty tabs, SQLite init.
- Claude adapter (Paperclip-style, see Architecture): stdin prompt, stream-json parse, guarded session resume, allowedTools, quota tracking, cancel.
- **Chat with AI tab (v0)**: proper chat UI (not a throwaway test panel) — streaming responses, multi-turn via resume, session list, new-chat, cancel. No data access yet; this surface is upgraded every phase.
- **Tasks**: scaffold Tauri+React; create db schema/migrations; build adapter (spawn/stream/resume-with-guards/kill/quota); provider interface wrapper; Chat tab UI with session management.
- **Accept**: app launches; chat in Chat tab → streamed response renders; multi-turn conversation holds context; past sessions reopenable; kill works; invalid/poisoned session falls back to fresh session (not an error).
- **Eval**: 10 consecutive prompts, 0 orphaned processes; resume preserves context; resume after cwd change starts fresh cleanly; quota counter matches actual usage.

### Phase 1 — WhatsApp ingestion (via source adapter layer)
- Build the generic SourceAdapter interface + Events pipeline first; WhatsApp is its first implementation.
- Go daemon: QR pairing, live stream + history sync, reconnect/backoff, emits Events.
- **Onboarding import picker**: choose backfill range — 24h / 3d / 7d / 30d / 90d / 180d / 1y / entire history. Semantics: include only chats with activity inside the range, and within those chats only messages inside the range (7d = chats active in last 7 days, messages ≤7d old). Extendable later without re-pairing. Default small for testing.
- UI: QR screen, connection status, import range picker + backfill progress bar, live Inbox (read-only).
- **Tasks**: SourceAdapter interface + events schema; Go daemon w/ whatsmeow; sidecar lifecycle; range-limited backfill with progress reporting; event writer w/ dedupe; Inbox UI with FTS search.
- **Accept**: pair via QR in-app; pick "3 days" → only 3 days imported, progress shown; send yourself a message → Inbox <5s; restart → reconnects, no duplicates; extend range later → older history fills in.
- **Eval**: 24h run, 0 dropped messages vs phone; dedupe = 0 duplicates across restart + range extension; media saved and viewable.

### Phase 2 — Brain: Spaces + extraction
- Two-stage extractor (assign → extract). Spaces auto-created with type + permanence guess (recurring: "Weekly grocery"; one-time: "Dinner w/ Sam Sat"; long-running: "Job search", "Health"; ephemeral spaces auto-archive after `ends_at`).
- Adaptive structure: every space gets ≥1 goal + a maintained `latest_update` line (refreshed on every extraction + task execution); milestones/tasks only as warranted (extractor judges; user can add/remove). Space cards lead with the latest update.
- Spaces update continuously — new events and backfilled old events both reshape state, structure, membership.
- Explicit tasks and implicit intents extracted separately, tagged `origin`.
- Knowledge graph populated: full node/edge schema live; Person/Space/Goal/Task/Topic at full strength; Workflow/Habit/Preference as low-confidence candidates (promoted on ≥2–3 repetitions or user confirmation — "you order groceries every Sunday, track as habit?").
- UI: graph-backed views — person page shows relationships + shared spaces; space page shows linked entities; candidate habits/workflows in a "Patterns" panel (confirm/dismiss).
- **Chat upgrade (grounded)**: chat runs with cwd = brain + retrieval tools (graph/FTS/vector) — "what's happening with the Goa trip?", "what did Rahul say about the deck?" answered with citations linking to spaces/messages.
- UI Spaces tab (replaces flat Brain view): space cards → space detail (goal tree, tasks split into "Asked" / "Suggested by assistant", linked people, source chats). People tab secondary. Every fact links to source messages.
- User controls: merge/split/rename/archive spaces; move tasks between spaces; add goals/tasks/preferences manually.
- **Tasks**: batching worker (10min lull or 50 msgs); space-assignment prompt (existing-space routing + new-space proposal + cross-chat merge); per-space extraction prompt + JSON schema; entity resolution for people; Spaces UI with explicit/implicit separation; provenance links; space merge/split/edit tools; **synthetic eval set generation + runner**; **human-eval UI (👍/👎 + note on every extraction output)**.
- **Accept**: a chat mixing 2 topics yields 2 spaces with correctly routed messages; same trip discussed in 2 groups + 1 DM → 1 space; grocery space has a goal + tasks but no forced milestones while trip space grows milestones; "book the Goa hotel" → explicit task in Goa space; friend says "we still haven't picked dates" → implicit "propose dates" suggestion, visually distinct; importing older history updates existing spaces (not duplicates); manual merge/split sticks; Chat answers "what's pending for the trip?" correctly with clickable citations.
- **Eval**: labeled set of 100 messages across 5 spaces → space assignment accuracy >85%; structure judgment sane on 10 varied spaces (no empty goal/milestone scaffolding); explicit task precision >85% / recall >75%; implicit suggestions precision >70% (false suggestions are the trust killer); person merge errors <5%; habit/workflow candidates: 0 promoted without repetition threshold, precision >80% on synthetic recurring patterns; graph edges spot-check 20 → >90% correct with valid provenance; re-run idempotent; backfill after live-sync creates 0 duplicate spaces; user corrections never overwritten.

### Phase 3 — Task engine: propose + schedule
- Tasks get: intent, urgency, `execute_at`, required approvals, status (proposed → approved → queued → running → done/failed).
- Proactive triage: **explicit** tasks — auto-queue if safe (research/summarize/draft), approval if outward/ambiguous. **Implicit** tasks — always approval, surfaced as suggestions in their space. Time-specified scheduled; rest immediate.
- **Done-detection**: extractor continuously checks incoming events against open tasks — if data shows the user already did it ("booked the hotel ✅", payment confirmation msg), mark task done with evidence link; ambiguous → "possibly done?" state for one-tap confirm. Never nag about completed things.
- UI: queue grouped by space (never a flat cross-space dump); approve/reject/edit/snooze; rejecting an implicit suggestion teaches the extractor (logged to preferences). macOS notifications for proposals.
- **Chat upgrade (write access)**: chat can create/edit tasks, goals, spaces conversationally ("add booking flights to the Goa trip", "snooze the rent reminder a week") — with confirm-diffs before applying.
- **Accept**: "remind me to pay rent on the 5th" → task with execute_at=5th; "find flights to Goa" → auto-queued research task in Goa space; implicit suggestion requires approval before anything runs; rejected suggestion type stops recurring; snooze reschedules; "done, booked it" in chat → open booking task auto-marked done with evidence link.
- **Eval**: 20 synthetic messages → correct auto vs approval classification >90%; scheduled task fires within 1 min of target.

### Phase 4 — Task execution
- Executor pipeline per task: (1) gather context — graph traversal from task node (space, people, preferences, relevant workflows/habits) + vector/FTS retrieval + `spaces/<slug>/` files + web; (2) Claude writes plan (steps shown in UI); (3) execute via `claude -p` session w/ tools, cwd = brain; (4) results card in space + execution summary appended to `spaces/<slug>/log.md` (episodic memory) + space state updated; retry/fail states.
- **Agent tools** (via claude CLI built-ins + MCP servers configured in `.claude/settings`):
  * Web search + web fetch (research, prices, availability, news)
  * Browser automation (Playwright MCP — forms, comparisons, logged-in flows w/ user watching)
  * File read/write + brain wiki edit (documents, notes, space updates)
  * Code execution/bash (data crunching, scripts, format conversion)
  * Document generation (md/pdf/xlsx/pptx via skills)
  * Calendar + email MCP (read/draft; send = approval) — stub in v1, real in v1.1
  * WhatsApp draft composer (writes draft to UI, explicit send button — never auto-sends)
  * Maps/places, weather via web fetch
- Tool allowlist per task type (research task can't touch browser-automation, etc.); concurrency limit (2); per-task transcript log; cancel button.
- **Chat upgrade (execution)**: chat can trigger task runs ("go find flights for the trip") — task created, queued, and linked back into the conversation; results return to the chat + the space.
- **Accept**: "research best CRM for solo founder" runs end-to-end → plan visible → live transcript → results card with sources; failed task shows error + retry; cancel mid-run works.
- **Eval**: 10 varied tasks (research/summarize/draft/plan) → ≥8 produce useful results without intervention; 0 zombie processes; context includes correct brain facts (spot-check 5).

### Phase 5 — Feedback loop + polish
- On each result: 👍/👎 + free-text feedback → appended to `me/preferences.md` + task record; follow-up input resumes the Claude session (`--resume`).
- Brain self-update: completed tasks + feedback summarized nightly into brain (what worked, corrections, preference drift).
- Daily digest screen: what I learned, tasks done, proposals pending.
- **Accept**: give feedback "too verbose" → next similar task output is shorter (preference visibly in prefs file + applied); follow-up question on a result continues same session with context; daily digest renders.
- **Eval**: feedback round-trip test — 3 corrections applied, all 3 reflected in subsequent runs; nightly job runs without corrupting brain files.

## Evals & improvement loop (cross-phase)

No labeled data exists — build both eval tracks:

1. **Synthetic evals** (task in Phases 2–5): generate synthetic WhatsApp conversations via Claude — multi-space chats, cross-chat spaces, explicit/implicit tasks, done-signals, edge cases (code-switching Hindi/English, forwarded msgs, group noise). Store as versioned fixtures in `/evals/`; runner scores extraction/triage/done-detection against them in CI. Phase thresholds above apply to these sets.
2. **Human eval on real data** (task in Phase 2, persists forever): every system output (space created, task extracted, suggestion, triage decision, execution result, done-detection) gets 👍/👎 + optional one-line feedback in UI. Stored in `evaluations(output_type, output_id, verdict, note, ts)`.
3. **Improvement loop**: nightly job aggregates verdicts → (a) failure patterns appended to extraction/triage prompts as few-shot corrections in `me/procedures/system-corrections.md`; (b) recurring failures auto-converted into new synthetic eval cases (regression suite grows from real mistakes); (c) weekly quality report in UI (accuracy trend per output type).

## Non-negotiables (all phases)

- All data local; brain dir is plain markdown — user-inspectable, git-initialized for history.
- No outbound WhatsApp messages ever sent automatically (drafts only, v2 feature behind explicit send button).
- Every Claude call logged (prompt, cost proxy, duration) in `extraction_runs`.
- Kill-switch: single toggle pauses daemon + all workers.

## Suggested repo layout

```
/sources/whatsapp-go   # whatsmeow adapter daemon (future: /sources/gmail, /sources/slack, ...)
/worker/adapters       # TS SourceAdapter interface + event pipeline
/worker                # extraction, scheduler, claude adapter
/src                   # React UI
/src-tauri             # Tauri shell + sidecar mgmt
/brain-template        # initial brain structure
```
