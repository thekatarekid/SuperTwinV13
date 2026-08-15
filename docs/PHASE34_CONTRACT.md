# Phase 3 + Phase 4 Contract — Task Engine (propose + schedule) & Task Execution

**Status:** authoritative. Every Phase 3/4 build agent codes against THIS document. If reality forces a change, update this file and note it. Source of behavior: `supertwin-whatsapp_build_simplebrain.md` (Phase 3 + Phase 4). This doc turns that spec into exact signatures, SQL, route tables, JSON shapes, and a per-file checklist that fits the existing codebase.

Phase 3 goal: proposed tasks get intent/urgency/schedule/approval and a status lifecycle; proactive triage auto-queues safe tasks and gates outward/ambiguous ones; done-detection marks tasks complete from incoming events; the queue UI (grouped by space) supports approve/reject/edit/snooze/schedule; chat gains write-access (create/edit tasks, goals, spaces) with confirm-diffs.

Phase 4 goal: an executor pipeline gathers context → plans → executes via the Claude CLI with a per-task-type tool allowlist, streams a live transcript, writes a results card into the space, and supports cancel/retry; chat can trigger runs.

Non-negotiables carried from earlier phases: **`worker/src/extraction/store.ts` is the SOLE SQLite writer** for spaces/tasks/etc. — all new task/task_run mutations live there. Every Claude call is logged to `extraction_runs`. The kill-switch (`extraction.enabled`) and global ingestion pause gate the scheduler and executor. Nothing outward-facing is ever sent automatically (drafts only). All model selection is per-role and data-driven.

---

## 0. Architecture delta

```
                              ┌────────────────────────────────────────────┐
ingest nudge ─► ExtractionEngine (assign/extract)                          │
                              │      │ (after extract, per touched space)   │
                              │      ├─► TaskTriageLLM.triage  → setTaskTriage / queueTasks
                              │      └─► DoneDetectionLLM.detect → markTaskDone
                              │                                              │
Scheduler (20s poll) ─► store.dueTasks(now) ─► Executor.enqueue(task) ──────┤
                                                     │                       │
                                                     ├─ gatherContext        │
                                                     ├─ plan  (getSelectedModel('planning'))
                                                     ├─ execute (getSelectedModel('execution'), cwd=brainRoot())
                                                     ├─ transcript → SSE + logs/runs/<id>.log
                                                     └─ results card → appendSpaceLog + setLatestUpdate
Chat  ─► ChatActionLLM.parse ─► confirm-diff ─► applyChatAction ─► store / Executor
```

New long-lived singletons are constructed in `worker/src/index.ts` and passed into `startServer(...)` alongside the existing `extraction` engine:

- `Scheduler` (interval poller) — reads `dueTasks`, hands each to the executor.
- `Executor` (concurrency 2, SSE fan-out) — the Phase 4 pipeline.
- `TaskTriageLLM`, `DoneDetectionLLM`, `ChatActionLLM` seams — wired into the extraction engine's post-extract hook (triage + done-detection) and the chat-action routes.

The engine, scheduler, and executor all consult `store.getExtractionEnabled()` and `isGloballyPaused()` (from `ingestion.isPaused()`) at run time.

---

## 1. DB migration `0006_phase34`

Append ONE migration to the `MIGRATIONS` array in `worker/src/db/schema.ts` (after `0005_grounded_chat`). Follow the existing pattern exactly: `ALTER TABLE ... ADD COLUMN` is **not** guarded by `IF NOT EXISTS` (SQLite has no such clause); the runner records applied ids and `runMigrationsOn()` already tolerates a `duplicate column name` error on a hand-mangled dev DB. New columns are all **nullable / defaulted** so existing rows keep working (no `NOT NULL` without a default). Never rename/reorder existing migrations.

```sql
-- 0006_phase34 — Task engine (Phase 3) + execution history (Phase 4).

-- ---- tasks: triage / scheduling / done-detection / execution fields ---------
-- (execute_at, recurrence, approved, source_event_ids, title, origin, status,
--  goal_id, created_at ALREADY EXIST — do NOT re-add them.)
ALTER TABLE tasks ADD COLUMN task_type            TEXT;   -- research|summarize|draft|plan|reminder|outward|other
ALTER TABLE tasks ADD COLUMN urgency              TEXT;   -- low|normal|high
ALTER TABLE tasks ADD COLUMN intent               TEXT;   -- one-line what-to-do for execution
ALTER TABLE tasks ADD COLUMN triage               TEXT;   -- auto|approval  (null until triaged)
ALTER TABLE tasks ADD COLUMN snoozed_until        TEXT;   -- ISO
ALTER TABLE tasks ADD COLUMN done_evidence_event_id TEXT;
ALTER TABLE tasks ADD COLUMN done_confidence      TEXT;   -- confirmed|possible
ALTER TABLE tasks ADD COLUMN plan                 TEXT;
ALTER TABLE tasks ADD COLUMN result               TEXT;
ALTER TABLE tasks ADD COLUMN error                TEXT;
ALTER TABLE tasks ADD COLUMN updated_at           TEXT;

-- ---- extraction_runs: which model + which process produced the run ----------
ALTER TABLE extraction_runs ADD COLUMN model TEXT;  -- selected model id, "" = default
ALTER TABLE extraction_runs ADD COLUMN role  TEXT;  -- chat|extraction|triage|done_detection|planning|execution

-- ---- task_runs: one row per execution attempt (Phase 4 + runs viewer) --------
CREATE TABLE IF NOT EXISTS task_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  space_id        TEXT,
  status          TEXT,          -- running|done|failed|cancelled
  plan            TEXT,
  transcript_path TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task    ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_started ON task_runs(started_at);
```

Existing `extraction_runs` / `tasks` rows get `NULL` for the new columns — fine. `role`/`model` are read as `COALESCE(role, kind)` / `COALESCE(model,'')` by the runs viewer.

---

## 2. Task status lifecycle

Canonical `tasks.status` values become:

```
open | queued | running | done | failed | dismissed | possibly_done
```

`open` is the **initial** value written by extraction (`store.insertTask` writes `'open'`) and means "proposed / active" — **keep it; do not rename** (Phase 2 tests assert `'open'`). Transitions:

| From | Event | To | Writer |
|------|-------|----|--------|
| (insert) | extraction proposes | `open` | `addTask` |
| `open` | triage `auto` + eligible | `queued` | `queueTasks()` / `setTaskTriage`+`queueTasks` |
| `open` | triage `approval` | stays `open` (awaits Approve) | `setTaskTriage` |
| `open`/`open`(approved) | user Approve or auto-eligible | `queued` | `approveTask`→`queueTasks`, or `setTaskState(id,'queued')` |
| `queued` | scheduler picks due task | `running` | `setTaskState(id,'running')` (executor) |
| `running` | pipeline success | `done` (+`result`) | `setTaskState` / `markTaskDoneByExecutor` |
| `running` | pipeline failure | `failed` (+`error`) | `setTaskState` |
| `running` | user cancel | `queued` (re-runnable) or `failed` | executor `cancel` |
| `open` | done-detection, confirmed evidence | `done` | `markTaskDone(id,{confidence:'confirmed'})` |
| `open` | done-detection, ambiguous | `possibly_done` | `markTaskDone(id,{confidence:'possible'})` |
| `possibly_done` | user one-tap confirm | `done` | `setTaskState(id,'done')` |
| `possibly_done` | user "not done" | `open` | `setTaskState(id,'open')` |
| any open-ish | user snooze | stays/returns `open`, sets `snoozed_until` | `snoozeTask` |
| `open`/`possibly_done` | user reject | `dismissed` (+ teach extractor) | `rejectTask` |
| `failed`/`done` | user retry | `queued` | `retryTask`→`setTaskState(id,'queued')` |

Snoozed tasks (`snoozed_until` in the future) are excluded from the queue and from done-detection nagging until the snooze elapses. Every state write stamps `updated_at`.

The existing `POST /api/tasks/:id/status` route (phase2) keeps its `open|done|dismissed` validation for back-compat; the fuller lifecycle is driven by the new phase-3 routes / `setTaskState`.

---

## 3. Store additions — `worker/src/extraction/store.ts` (single writer)

Add these to the prepared-statement cache (`Stmts`) and export the functions. All follow existing conventions (parameterized statements, typed rows, `INSERT OR IGNORE` where idempotency matters). Timestamps stored as ISO via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; `execute_at`/`snoozed_until` serialized to epoch-ms in `taskOut`.

### 3.1 Extended `TaskRow`

```ts
export interface TaskRow {
  id: string;
  space_id: string;
  goal_id: string | null;
  origin: string | null;
  status: string | null;
  execute_at: string | null;
  recurrence: string | null;          // NEW (column already existed; add to row select)
  title: string | null;
  approved: number;
  source_event_ids: string | null;
  created_at: string;
  // ---- 0006 additions ----
  task_type: string | null;
  urgency: string | null;
  intent: string | null;
  triage: string | null;              // auto|approval|null
  snoozed_until: string | null;
  done_evidence_event_id: string | null;
  done_confidence: string | null;     // confirmed|possible|null
  plan: string | null;
  result: string | null;
  error: string | null;
  updated_at: string | null;
}
```

Update the `spaceTasks` / `getTask` SELECTs to include the new columns.

### 3.2 Task write functions

```ts
export function setTaskTriage(id: string, p: {
  task_type: string; urgency: string; intent: string;
  triage: "auto" | "approval";
  execute_at?: string | null;         // ISO
  recurrence?: string | null;
}): boolean;
// Writes task_type/urgency/intent/triage (+ execute_at/recurrence when given),
// stamps updated_at. Does NOT change status.

export function scheduleTask(id: string, executeAt: string, recurrence?: string | null): boolean;
// Sets execute_at (ISO) + recurrence, stamps updated_at.

export function snoozeTask(id: string, until: string): boolean;
// Sets snoozed_until = until (ISO). If status was possibly_done, returns to open.
// Otherwise leaves status = open. Stamps updated_at.

export function editTask(id: string, p: {
  title?: string; intent?: string; execute_at?: string | null; task_type?: string;
}): boolean;
// Patches only provided fields; stamps updated_at.

export function setTaskState(id: string, status: TaskStatus, extra?: {
  plan?: string | null; result?: string | null; error?: string | null;
  execute_at?: string | null; snoozed_until?: string | null;
  done_evidence_event_id?: string | null; done_confidence?: string | null;
  recurrence?: string | null;
}): boolean;
// Generic status setter. Always stamps updated_at. Applies any provided extra
// fields in the same UPDATE. This is the workhorse for the executor
// (running/done/failed) and one-tap confirm.

export function markTaskDone(id: string, p: {
  evidence_event_id?: string | null; confidence: "confirmed" | "possible";
}): boolean;
// confidence 'confirmed' -> status='done'; 'possible' -> status='possibly_done'.
// Sets done_evidence_event_id + done_confidence, stamps updated_at.
// No-op (returns false) if the task is already done/dismissed.

export function rejectTask(id: string): boolean;
// status='dismissed', stamps updated_at. (The teach-the-extractor lesson is
// written by the route via appendCorrection — see §11.)

export function queueTasks(): string[];
// Bulk transition: every task with triage='auto' AND status='open' (and not
// snoozed in the future) -> status='queued'. Stamps updated_at. Returns the
// affected task ids. (Individual queueing uses setTaskState(id,'queued').)
```

### 3.3 Task read functions

```ts
export interface TaskFilter {
  status?: string; space_id?: string; origin?: string; triage?: string;
}
export function listTasks(filter?: TaskFilter): TaskRow[];
// Dynamic WHERE over the provided keys; ORDER BY created_at ASC, id ASC.

export function dueTasks(nowIso: string): TaskRow[];
// status='queued'
//   AND (snoozed_until IS NULL OR snoozed_until <= nowIso)
//   AND ( execute_at IS NULL            -- immediate queued
//         OR execute_at <= nowIso )     -- scheduled + now due
// ORDER BY (execute_at IS NULL) DESC, execute_at ASC.  Immediate first.

// getTaskRow(id) already exists — reused unchanged.
```

### 3.4 `task_runs` functions

```ts
export interface TaskRunRow {
  id: string; task_id: string; space_id: string | null; status: string | null;
  plan: string | null; transcript_path: string | null; model: string | null;
  input_tokens: number; output_tokens: number; duration_ms: number;
  error: string | null; started_at: string | null; finished_at: string | null;
}

export function createTaskRun(p: {
  id: string; task_id: string; space_id: string | null;
  model: string; plan?: string | null;
}): void;
// INSERT with status='running', started_at=now.

export function finishTaskRun(id: string, p: {
  status: "done" | "failed" | "cancelled";
  input_tokens: number; output_tokens: number; duration_ms: number;
  transcript_path?: string | null; error?: string | null;
}): void;
// UPDATE status/tokens/duration/(transcript_path/error), finished_at=now.

export function listTaskRuns(limit: number): TaskRunRow[];   // ORDER BY started_at DESC
export function taskRunsForTask(taskId: string): TaskRunRow[]; // ORDER BY started_at DESC
```

### 3.5 Runs viewer — `listRuns`

```ts
export interface RunListRow {
  id: string;            // extraction_runs.id as string
  process: string;       // COALESCE(role, kind)
  model: string;         // COALESCE(model, '')
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  status: string;        // ok|error
  created_at: string;
}
export function listRuns(limit: number): RunListRow[];
// Reads extraction_runs ONLY:
//   SELECT id, COALESCE(role,kind) AS process, COALESCE(model,'') AS model,
//          input_tokens, output_tokens, duration_ms, status, created_at
//   FROM extraction_runs ORDER BY created_at DESC, id DESC LIMIT ?
```

Because task executions (`plan`/`execute`) and triage/done-detection/chat-action ALL log to `extraction_runs` via `db.logRun` with a `role`, a single `listRuns` over `extraction_runs` covers every LLM process in the system (chat, extraction, triage, done_detection, planning, execution). `task_runs` is the per-execution history detail (transcript path, task linkage); `extraction_runs` is the flat per-LLM-call log. Both exist; they answer different questions.

### 3.6 Notifications flag (app_state)

```ts
export const NOTIFICATIONS_ENABLED_KEY = "notifications.enabled";
export function getNotificationsEnabled(): boolean;  // default TRUE (value !== "0")
export function setNotificationsEnabled(v: boolean): void;
```

### 3.7 Model-role key map — REQUIRED change

`MODEL_KEY_BY_ROLE: Record<ModelRole, string>` currently has only `chat|extraction|execution`. When `ModelRole` expands to six roles (§8) this literal becomes a **type error** unless every key is present. Add the three new keys:

```ts
export const MODEL_KEY_BY_ROLE: Record<ModelRole, string> = {
  chat: "selected_model_chat",
  extraction: "selected_model_extraction",
  triage: "selected_model_triage",
  done_detection: "selected_model_done_detection",
  planning: "selected_model_planning",
  execution: "selected_model_execution",
};
```

`getSelectedModel`/`setSelectedModel` already index by `MODEL_KEY_BY_ROLE[role]` and keep working. `getAllSelectedModels()` must stop hard-coding three roles — iterate the roles instead:

```ts
export function getAllSelectedModels(): Record<ModelRole, string> {
  const out = {} as Record<ModelRole, string>;
  for (const role of Object.keys(MODEL_KEY_BY_ROLE) as ModelRole[]) out[role] = getSelectedModel(role);
  return out;
}
```

The legacy single-key fallback in `getSelectedModel` stays: only `chat`/`extraction` inherit the pre-per-role `selected_model` value; the four new roles never inherit it.

---

## 4. `db.logRun` extension — `worker/src/db/index.ts`

Add `model` + `role` to `LogRunParams` and the insert so every process's model/role lands in `extraction_runs`:

```ts
export interface LogRunParams {
  provider: string; sessionId: string | null; runId: string; kind: RunKind;
  promptChars: number; inputTokens: number; outputTokens: number;
  costUsd: number | null; durationMs: number; status: RunStatus; errorCode: string | null;
  model?: string | null;   // NEW
  role?: string | null;    // NEW
}
```

Update `insertRun` to include `model, role` (default `NULL`). Update the existing chat call site (`server/index.ts`) to pass `role: "chat"`, `model: getSelectedModel("chat")`, and the extraction call site (`llm.ts`) to pass `role: <'extraction'|...>` (derive from kind) + `model: getSelectedModel("extraction")`. All new call sites (triage/done/plan/execute/chat-action) pass their role + model.

---

## 5. LLM seams (mirror `ExtractionLLM` in `worker/src/extraction/types.ts`)

Each seam is an interface with a real provider-backed implementation AND a deterministic rule-based fallback (for tests/evals with `--llm=fake`, no CLI). Real implementations call `provider.send({ plainCompletion: true, allowedTools: [], model: getSelectedModel(<role>), cwd: neutralCwd() })`, parse JSON with the existing `parseJsonObject`, retry once on malformed JSON, and log to `extraction_runs` via `db.logRun` (+ `db.addUsage`) exactly like `ClaudeExtractionLLM.callOnce`.

### 5.1 `TaskTriageLLM` — `worker/src/tasks/types.ts` + `worker/src/tasks/triage.ts`

```ts
export interface TriageInput {
  title: string;
  origin: "explicit" | "implicit";
  space_name: string;
  space_type: string | null;
  context?: string | null;            // latest_update / nearby text
}
export interface TriageResult {
  task_type: "research" | "summarize" | "draft" | "plan" | "reminder" | "outward" | "other";
  urgency: "low" | "normal" | "high";
  intent: string;                     // one line
  triage: "auto" | "approval";
  execute_at?: string | null;         // ISO if time-specified, else null
  recurrence?: string | null;         // daily|weekly|monthly|"every N days"|null
}
export interface TaskTriageLLM { triage(input: TriageInput): Promise<TriageResult>; }
```

Classification rules (baked into the prompt AND the deterministic fallback):

- **auto** iff: `origin === 'explicit'` AND `task_type ∈ {research, summarize, draft, reminder}` AND NOT outward-facing.
- **approval** iff: `origin === 'implicit'` (all implicit suggestions need approval — spec) OR `task_type === 'outward'` (a message/email/purchase/booking that *sends*) OR the type/intent is ambiguous.
- `execute_at`: set when the task text specifies a time ("on the 5th", "tomorrow 9am"); else null (immediate on queue). `recurrence`: set for repeating language ("every Sunday").

Provide `export class RuleTriage implements TaskTriageLLM` — pure, no LLM: keyword tables map verbs to `task_type` (find/research/compare → research; summarize/tl;dr → summarize; write/draft/compose → draft; remind/reminder → reminder; message/text/email/send/buy/book/order/pay → outward; plan/organize → plan; else other), a tiny date parser for `execute_at`/`recurrence`, urgency from words ("urgent/asap" → high). `export class ClaudeTaskTriage implements TaskTriageLLM` — LLM, logs `kind:'triage', role:'triage'`, and falls back to `RuleTriage` on error so triage never blocks the pipeline.

### 5.2 `DoneDetectionLLM` — `worker/src/tasks/types.ts` + `worker/src/tasks/done-detection.ts`

```ts
export interface DoneDetectInput {
  tasks: { task_id: string; title: string; intent: string | null }[]; // open tasks in touched space
  events: { id: string; ts: string | null; actor: string | null; text: string }[]; // recent events
}
export interface DoneResult {
  task_id: string;
  done: "yes" | "possible" | "no";
  evidence_event_id?: string | null;
}
export interface DoneDetectionLLM { detect(input: DoneDetectInput): Promise<DoneResult[]>; }
```

Maps to `markTaskDone`: `yes`→`confidence:'confirmed'` (→ status `done`); `possible`→`confidence:'possible'` (→ `possibly_done`); `no`→ no write. Real impl logs `kind:'done_detection', role:'done_detection'`. Provide `export class RuleDoneDetection implements DoneDetectionLLM` — deterministic: an event marks a task `yes` when it contains a completion keyword/emoji (`booked|done|paid|sent|ordered|confirmed|✅|✔️`) AND shares ≥1 significant token with the task title; ambiguous overlap → `possible`; else `no`. Used in tests and as the fallback.

### 5.3 `ChatActionLLM` — `worker/src/chat/types.ts` + `worker/src/chat/actions.ts`

Natural-language → structured action for chat write-access.

```ts
export type ProposedAction =
  | { type: "add_task"; space_id?: string; space_name?: string; title: string; origin: "explicit" }
  | { type: "edit_task"; task_id: string; title?: string; intent?: string; execute_at?: string | null; task_type?: string }
  | { type: "snooze_task"; task_id: string; until: string }          // ISO
  | { type: "add_goal"; space_id: string; title: string }
  | { type: "create_space"; name: string; type: "recurring" | "one_time" | "long_running" }
  | { type: "run_task"; title: string; space_id?: string; space_name?: string }; // Phase 4 trigger

export interface ChatActionResult { action: ProposedAction | null; diff: string; }
// diff = human-readable summary rendered in the confirm card, e.g.
//   "Add task “book Goa hotel” to Goa Trip"
//   "Snooze “pay rent” until 2026-07-17"

export interface SpacesContextEntry { id: string; name: string; slug: string | null; type: string | null; }
export interface ChatActionLLM {
  parse(message: string, spaces: SpacesContextEntry[]): Promise<ChatActionResult>;
}
```

- `parse` returns `{ action: null, diff: "" }` when the message is not an actionable command (a normal question). Space references resolve by name against the passed `spaces` directory (reuse `store.activeSpaceDirectory()`); when no space matches, `space_name` is carried through and resolved/created at apply time.
- Real impl (`ClaudeChatAction`) logs `kind:'chat_action', role:'chat'` and reuses the chat model (`getSelectedModel('chat')`). A deterministic fallback is optional (keyword prefix detection like "add … to …", "snooze …", "remind me to …") — provide a minimal `RuleChatAction` for tests.

**Apply** (`applyChatAction(action)` in `worker/src/chat/actions.ts`, returns `{ ok, result }`) is single-writer via `store`:

| action | store calls |
|--------|-------------|
| `add_task` | resolve/`ensureSpace`, `store.addTask({origin:'explicit'})`, refresh space file |
| `edit_task` | `store.editTask` |
| `snooze_task` | `store.snoozeTask` |
| `add_goal` | `store.addGoal` |
| `create_space` | `store.ensureSpace` |
| `run_task` | resolve/create space, `store.addTask`, `store.setTaskTriage` (auto), `store.setTaskState(id,'queued')`, `executor.enqueue(id)` → returns `{ run_id }` linking back to the chat |

---

## 6. Scheduler — `worker/src/tasks/scheduler.ts`

```ts
export interface SchedulerOptions {
  intervalMs?: number;                 // default 20_000 (env SUPERTWIN_SCHEDULER_INTERVAL_MS)
  isGloballyPaused?: () => boolean;
  onDue: (task: TaskRow) => void;      // hand to executor.enqueue
}
export class Scheduler {
  constructor(opts: SchedulerOptions);
  start(): void;                       // begins the interval; disabled in test unless started
  stop(): void;                        // clears the timer (unref'd; never blocks shutdown)
  tickNow(): void;                     // test hook — one synchronous poll
}
```

On each tick: if `!store.getExtractionEnabled()` or `isGloballyPaused()` → skip (kill-switch guards the scheduler too). Else `store.dueTasks(new Date().toISOString())` → for each, call `onDue(task)` (executor enqueues; the executor de-dupes so the same task isn't enqueued twice while running). The timer must be `.unref()`'d and default OFF in the test env (`process.env.NODE_ENV === 'test'` / vitest) unless `start()` is explicitly called.

**Recurrence** (on a run reaching `done`, in the executor completion path): if `task.recurrence` is set, compute `nextExecuteAt` and re-queue by `scheduleTask(id, nextExecuteAt, recurrence)` + `setTaskState(id, 'queued')`. Supported recurrences: `daily`, `weekly`, `monthly`, and `every N days` (parse the integer). Acceptance: a scheduled task must fire **within 1 minute** of its target (20s poll comfortably satisfies this).

---

## 7. Executor pipeline — `worker/src/execution/` (Phase 4)

### 7.1 `Executor` — `worker/src/execution/executor.ts`

```ts
export interface ExecutorOptions {
  provider: Provider;
  concurrency?: number;                // default 2 (env SUPERTWIN_EXEC_CONCURRENCY)
  isGloballyPaused?: () => boolean;
}
export class Executor {
  constructor(opts: ExecutorOptions);
  enqueue(taskId: string): string;     // returns run_id; no-op if already running/queued in-executor
  cancel(taskId: string): boolean;     // provider.cancel(runId); marks task_run 'cancelled'
  subscribe(cb: (f: ExecStreamFrame) => void): () => void; // SSE fan-out (engine pattern)
  status(): { running: string[]; queued: string[] };
  stop(): void;                        // graceful: stop accepting; let in-flight finish
}
```

Concurrency-2 in-memory queue; a task already running/queued in the executor is not enqueued again. SSE fan-out mirrors `ExtractionEngine.subscribe/emit` (a `Set<cb>` that never throws into the engine).

### 7.2 Pipeline per task

1. **gatherContext(task)** — `worker/src/execution/context.ts`. Build a context bundle string from: `spaces/<slug>/space.md`; wikilinked `people/*.md`, `workflows/*.md`, `habits/*.md` (parse `[[...]]` links out of space.md); `me/preferences.md`; and FTS over events (reuse `searchEventHits`/`buildContextBlock` from `server/chat-grounding.ts`, keyed on `task.title + ' ' + intent`). Returns `{ bundle: string, spaceSlug: string, spaceId: string }`.
2. **plan** — `provider.send({ plainCompletion:true, allowedTools:[], model:getSelectedModel('planning'), cwd:neutralCwd() })` with a prompt asking for an ordered list of steps as JSON `{ "steps": ["..."] }`. Persist steps to `tasks.plan` (`setTaskState(id,'running',{plan})`) and `task_runs.plan` (`createTaskRun`). Emit `plan` SSE frame. Log run: `kind:'planning', role:'planning', model`.
3. **execute** — `provider.send({ message: <bundle + plan + intent>, sessionId:null, cwd:brainRoot(), model:getSelectedModel('execution'), allowedTools:<allowlist for task_type>, maxTurns:<n>, timeoutMs, onEvent, signal })` — NON-plain (real agentic tools). Stream `onEvent` frames (`delta`/`tool_use`/`usage`) as `transcript` SSE frames AND append each line to the transcript log file `~/SuperTwin/logs/runs/<taskId>-<ts>.log` (via `logs.ts`). Log run: `kind:'execution', role:'execution', model`.
4. **complete** —
   - success: write a results card — `appendSpaceLog(slug, <result summary + evt/source links>)` and refresh the space's latest update (`store.setLatestUpdate(spaceId, <one-line result>, nowIso)`), then `setTaskState(id,'done',{result})`; if `recurrence` set, re-queue (see §6). `commitBrain(...)`.
   - failure: `setTaskState(id,'failed',{error})`; emit `run_failed`.
   - `finishTaskRun(runId, { status, input_tokens, output_tokens, duration_ms, transcript_path, error })`.

**Cancel** (`executor.cancel(taskId)`) calls `provider.cancel(runId)` (kills the child), marks the `task_run` `cancelled` via `finishTaskRun`, sets the task back to `queued` (retryable) or `failed` per policy (default: `queued`), and emits `run_cancelled`. **Retry** re-enqueues a fresh run for a `failed`/`done` task.

Every plan/execute call also logs to `extraction_runs` (role `planning`/`execution`) and `db.addUsage(...)` so the runs viewer + quota window include executions.

### 7.3 Tool allowlist map — `worker/src/execution/tools.ts`

```ts
export const TOOLS_BY_TASK_TYPE: Record<string, string[]> = {
  research:   ["WebSearch", "WebFetch", "Read", "Grep", "Glob"],
  summarize:  ["Read", "Grep", "Glob", "WebFetch"],
  draft:      ["Read", "Grep", "Glob", "Write", "Edit", "WebFetch"],
  plan:       ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
  reminder:   [],   // no execution needed — just fires a notification
  outward:    [],   // approval-gated, drafts only — NEVER sends
  other:      ["Read", "Grep", "Glob", "WebFetch"],
};
export function toolsForTaskType(t: string | null): string[]; // defaults to `other`
```

`reminder` tasks skip the plan/execute LLM calls entirely and just fire a macOS notification (see §12), then go `done`. `outward` tasks produce a DRAFT only (never send). `Bash` is added only for explicit data/code task types if introduced later. Browser automation (Playwright MCP), calendar/email MCP, and the WhatsApp draft composer are documented **STUBS for v1** — real MCP wiring slots in at the `allowedTools` list + `.claude/settings` MCP config later (spec Phase 4 "real in v1.1"); v1 ships with the CLI built-ins above.

---

## 8. Model roles expansion — `worker/src/providers/claude-local/models.ts`

Keep `MODEL_CATALOG` and `DEFAULT_MODEL_ID` unchanged. Expand the role type + list + validator to six roles:

```ts
export type ModelRole = "chat" | "extraction" | "triage" | "done_detection" | "planning" | "execution";

export const MODEL_ROLES: RoleOption[] = [
  { key: "chat",           label: "Chat",            description: "Interactive chat and agent replies",         future: false },
  { key: "extraction",     label: "Extraction",      description: "Brain extraction from your messages",        future: false },
  { key: "triage",         label: "Triage",          description: "Classifies proposed tasks (auto vs approval)", future: false },
  { key: "done_detection", label: "Done detection",  description: "Detects tasks you already completed",        future: false },
  { key: "planning",       label: "Planning",        description: "Writes the plan before a task runs",         future: false },
  { key: "execution",      label: "Task execution",  description: "Runs tasks with tools",                      future: false },
];
// isValidRole unchanged (checks MODEL_ROLES membership).
```

All six are `future: false` now (execution ships in Phase 4). The Settings model picker is **data-driven** — it renders `res.roles` — so it auto-shows all six with zero UI change (see §13). `getSelectedModel/getAllSelectedModels` already generalize via `selected_model_<role>` keys (§3.7).

---

## 9. Logs — `worker/src/logs.ts` + `~/SuperTwin/logs/`

New tiny util (no framework):

```ts
export function logsDir(): string;          // $SUPERTWIN_HOME/logs or ~/SuperTwin/logs (mirrors brainRoot's home resolution)
export function ensureLogsDir(): string;    // mkdir -p logsDir() and logsDir()/runs; returns logsDir()
export function runTranscriptPath(taskId: string): string; // logsDir()/runs/<taskId>-<epochms>.log
export function appendLine(absPath: string, line: string): void; // best-effort append, never throws
```

`ensureLogsDir()` is called on worker boot (`worker/src/index.ts`). Layout:

```
~/SuperTwin/logs/
  worker.log        # Rust already writes this (~/SuperTwin/worker.log) — reveal opens the logs dir
  worker-node.log   # the worker tees its own console (best-effort) here
  runs/<taskId>-<ts>.log   # per-execution transcript
```

Decision: `worker.log` currently lives at `~/SuperTwin/worker.log` (Rust `open_worker_log`). For the logs card, **reveal opens `~/SuperTwin/logs`** (the new subdir), and the worker ALSO tees its console to `logs/worker-node.log` so a durable node-side log sits next to the run transcripts. (Rust's `worker.log` stays where it is; it is one level up and still reachable.)

---

## 10. Notifications — `worker/src/notify.ts`

```ts
export function notify(title: string, body: string): void;
// If store.getNotificationsEnabled() is false -> no-op.
// Else spawn `osascript -e 'display notification "<body>" with title "<title>"'`
// (macOS). Fully best-effort: wrapped in try/catch, NEVER throws, escapes quotes.
```

Fires on: a new proposal that needs approval (from the extraction post-hook) and a finished run (`run_done`/`run_failed`). Gated by the `notifications.enabled` app_state flag.

---

## 11. API routes — `worker/src/server/phase3-routes.ts` (additive, handled-boolean)

New route module, same shape as `phase2-routes.ts`: `export async function handlePhase3Route(req, res, deps): Promise<boolean>` returning `true` when it handled the request. `deps` carries `{ executor, scheduler, chatAction }` (nullable — routes needing an uninitialized dep answer `503`).

**Dispatch wiring** in `worker/src/server/index.ts` `handle(...)`: add a phase-3 block that runs **before** the existing phase-2 `/api/tasks/` block. It claims the new paths and returns `false` for `:id/(status|move|approve)` so those fall through to phase-2 (unchanged). Condition:

```ts
if (path === "/api/tasks" || path.startsWith("/api/tasks/") ||
    path === "/api/runs" || path.startsWith("/api/logs/") ||
    path.startsWith("/api/chat/action") ||
    path === "/api/settings/notifications") {
  const handled = await handlePhase3Route(req, res, { executor, scheduler, chatAction });
  if (handled) return;
}
// ... existing phase-2 dispatch follows (handles status|move|approve) ...
```

Serialization uses `taskOut` — **export `taskOut` from `phase2-routes.ts`** and extend it (§11.1) so both modules share one serializer.

### 11.1 Extended `taskOut`

```ts
export function taskOut(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id, title: t.title, origin: t.origin, status: t.status,
    goal_id: t.goal_id,
    execute_at: store.isoToMs(t.execute_at),
    approved: t.approved === 1,
    source_event_ids: <parsed array>,
    created_at: t.created_at,
    // ---- 0006 additions ----
    task_type: t.task_type, urgency: t.urgency, intent: t.intent,
    triage: t.triage,
    snoozed_until: store.isoToMs(t.snoozed_until),
    done_evidence_event_id: t.done_evidence_event_id,
    done_confidence: t.done_confidence,
    plan: t.plan, result: t.result, error: t.error,
    recurrence: t.recurrence,
    updated_at: t.updated_at,
  };
}
```

`taskRunOut(r: TaskRunRow)` serializes `started_at`/`finished_at` as-is (ISO strings) plus numeric token/duration fields.

### 11.2 Route table

| Method | Path | Request body | Response (200) |
|--------|------|--------------|----------------|
| GET | `/api/tasks?status=&space_id=&origin=` | — | `{ tasks: [taskOut...] }` (via `listTasks(filter)`) |
| GET | `/api/tasks/queue` | — | `{ spaces: [{ space_id, space_name, tasks: [taskOut...] }] }` — grouped by space, **never flat**. Group `listTasks({status})` for the actionable statuses (`open`, `queued`, `running`, `possibly_done`) by `space_id`; join `space_name` from `getSpaceRow`. |
| GET | `/api/tasks/:id` | — | `{ task: taskOut, runs: [taskRunOut...] }` (via `getTaskRow` + `taskRunsForTask`) |
| POST | `/api/tasks/:id/snooze` | `{ until }` (ISO) | `{ ok, task: taskOut }` |
| POST | `/api/tasks/:id/edit` | `{ title?, intent?, execute_at?, task_type? }` | `{ ok, task: taskOut }` |
| POST | `/api/tasks/:id/schedule` | `{ execute_at, recurrence? }` | `{ ok, task: taskOut }` |
| POST | `/api/tasks/:id/reject` | — | `{ ok }` — `rejectTask(id)` + append lesson to `me/procedures/system-corrections.md` |
| POST | `/api/tasks/:id/run` | — | `{ ok, run_id }` — enqueue execution now (`executor.enqueue`) |
| POST | `/api/tasks/:id/cancel` | — | `{ ok }` — `executor.cancel(id)` |
| POST | `/api/tasks/:id/retry` | — | `{ ok, run_id }` — re-enqueue a `failed`/`done` task |
| GET | `/api/tasks/stream` | — (SSE) | task lifecycle frames (§12); `: connected\n\n` + 25s `: ping` heartbeat, `executor`/engine `subscribe` fan-out |
| POST | `/api/tasks/:id/status` `/move` `/approve` | (unchanged — phase-2) | `{ ok }` |
| GET | `/api/runs?limit=` | — | `{ runs: [{ id, process, model, input_tokens, output_tokens, duration_ms, status, created_at }...] }` (via `listRuns`) |
| GET | `/api/logs/info` | — | `{ dir, files: [{ name, size, modified }...] }` (stat `logsDir()`) |
| POST | `/api/logs/reveal` | — | `{ ok }` — best-effort `open <logsDir()>` on macOS (never throws) |
| GET | `/api/settings/notifications` | — | `{ enabled }` |
| POST | `/api/settings/notifications` | `{ enabled }` (boolean) | `{ ok, enabled }` |
| POST | `/api/chat/action` | `{ message, session_id? }` | `{ action: ProposedAction \| null, diff }` (via `chatAction.parse`) |
| POST | `/api/chat/action/apply` | `{ action }` | `{ ok, result }` — `applyChatAction(action)`; `run_task` returns `{ ok, result: { run_id } }` |

Existing `GET/POST /api/settings/models` stay in `server/index.ts` and now serve all six roles unchanged (the response already includes `roles` + `selections`).

Validation: unknown status/role/model → `400`; missing task/space → `404`; missing executor/scheduler for a route that needs it → `503` (mirror the phase-2 extraction `503`).

---

## 12. SSE frame types (task stream + execution transcript)

All frames use the worker's `SseParser`-compatible framing: `data: <JSON>\n\n`. The client parses them with the existing `SseParser` (cast to the union). `GET /api/tasks/stream` multiplexes engine post-hook frames (proposed/triaged/done-detected) and executor frames (run lifecycle/transcript).

```ts
type TaskStreamFrame =
  | { type: "task_proposed";  task_id: string; space_id: string }
  | { type: "task_triaged";   task_id: string; triage: "auto" | "approval"; task_type: string }
  | { type: "task_queued";    task_id: string }
  | { type: "run_started";    task_id: string; run_id: string }
  | { type: "plan";           run_id: string; steps: string[] }
  | { type: "transcript";     run_id: string; delta?: string; tool?: { name: string; input: unknown }; usage?: { input_tokens: number; output_tokens: number } }
  | { type: "run_done";       task_id: string; run_id: string; result: string }
  | { type: "run_failed";     task_id: string; run_id: string; error: string }
  | { type: "run_cancelled";  task_id: string; run_id: string }
  | { type: "task_done_detected"; task_id: string; confidence: "confirmed" | "possible"; evidence_event_id: string | null };
```

A `transcript` frame carries exactly one of `delta` / `tool` / `usage` per emission (mirrors `ProviderStreamEvent`).

---

## 13. UI contract — `src/`

### 13.1 `src/lib/worker-client.ts` — additions

Types (extend / add):

```ts
export type TaskType = "research"|"summarize"|"draft"|"plan"|"reminder"|"outward"|"other";
export type TaskUrgency = "low"|"normal"|"high";
// Extend existing TaskStatus:
export type TaskStatus = "open"|"queued"|"running"|"done"|"failed"|"dismissed"|"possibly_done";

// Extend SpaceTask (and add a richer TaskOut) with:
//   task_type, urgency, intent, triage ("auto"|"approval"|null),
//   snoozed_until (number|null), done_evidence_event_id, done_confidence,
//   plan, result, error, recurrence, updated_at.

export interface TaskRunOut { id: string; task_id: string; space_id: string|null; status: string|null; plan: string|null; transcript_path: string|null; model: string|null; input_tokens: number; output_tokens: number; duration_ms: number; error: string|null; started_at: string|null; finished_at: string|null; }
export interface TaskQueueGroup { space_id: string; space_name: string; tasks: SpaceTask[]; }
export interface TaskDetail { task: SpaceTask; runs: TaskRunOut[]; }
export interface RunListItem { id: string; process: string; model: string; input_tokens: number; output_tokens: number; duration_ms: number; status: string; created_at: string; }
export interface LogsInfo { dir: string; files: { name: string; size: number; modified: string }[]; }
export type TaskStreamEvent = /* the §12 union */;
export type ProposedAction = /* the §5.3 union */;
```

Functions (all mirror the existing `getJson`/`postJson` + `streamExtraction` patterns; add to the `workerClient` object):

```ts
listTasks(filter?: {status?;space_id?;origin?}): Promise<SpaceTask[]>
getTaskQueue(): Promise<TaskQueueGroup[]>
getTask(id): Promise<TaskDetail>
snoozeTask(id, until: string): Promise<{ok;task}>
editTask(id, patch): Promise<{ok;task}>
scheduleTask(id, execute_at: string, recurrence?): Promise<{ok;task}>
rejectTask(id): Promise<{ok}>
runTask(id): Promise<{ok;run_id}>
cancelTask(id): Promise<{ok}>
retryTask(id): Promise<{ok;run_id}>
streamTasks(onFrame, onError?): () => void          // GET SSE, like streamExtraction
listRuns(limit?): Promise<RunListItem[]>
getLogsInfo(): Promise<LogsInfo>
revealLogs(): Promise<{ok}>
parseChatAction(message, session_id?): Promise<{action: ProposedAction|null; diff: string}>
applyChatAction(action): Promise<{ok; result: unknown}>
getNotifications(): Promise<{enabled: boolean}>
setNotifications(enabled): Promise<{ok; enabled}>
```

### 13.2 `src/tabs/AgentTab.tsx` — full build (replaces the Placeholder)

Two views (same `View` union pattern as `SpacesTab`):

- **Queue view** — grouped by space (sections per space, from `getTaskQueue`; never a flat dump). Each section renders task cards with a status badge (`open|queued|running|done|failed|possibly_done`) and an origin marker (💡 for implicit/"suggested"; explicit are "asked" — reuse the `SpacesTab` implicit/explicit visual distinction). Card actions by state:
  - `open` needing approval → **Approve** (`approveTask`→queued path) / **Reject** (`rejectTask`) / **Edit** / **Snooze** / **Schedule**.
  - `queued`/`open` eligible → **Run** (`runTask`).
  - `possibly_done` → **Confirm done** / **Not done** (one-tap).
  - Suggested (implicit) vs proposed (explicit) are visually distinct.
- **Run detail view** — plan steps (from `plan` frame / `task.plan`), a live transcript pane (subscribe via `streamTasks`, append `transcript.delta`, show `tool` chips), a results card on completion, a **Cancel** button while `running` (`cancelTask`), and a **Retry** button on `failed` (`retryTask`). Opening a run: cross-tab `supertwin:open-run` event (see §13.4).

Live refresh rides `streamTasks` (bump a `refreshKey` on `task_proposed`/`task_triaged`/`task_queued`/`run_done`/`run_failed`/`task_done_detected`; feed `plan`/`transcript` straight into the open run view). Reuse `.wa-btn`/`.wa-modal`/`.wa-spinner` and the `.spaces__drain-bar` progress pattern.

### 13.3 `src/tabs/SettingsTab.tsx` — additions

- **Runs card** — a scrollable table listing recent runs (`listRuns`): columns Process, Model, Input, Output, Duration, Status, Time. A refresh button. `.settings__runs*` classes.
- **Logs card** — show `LogsInfo.dir` + an "Open logs folder" button calling `revealLogs()`; list `files` (name/size/modified). Include the **notifications toggle** (`getNotifications`/`setNotifications`). `.settings__logs*` classes.
- **Models card** — already data-driven (`roles.map(...)`). It renders all six roles automatically once the backend returns them; **no UI change needed** beyond the backend role expansion.

### 13.4 `src/tabs/ChatTab.tsx` — confirm-diff card

After a chat send (or via a detect step), call `parseChatAction(message)`. When it returns a non-null `action`, render a **diff card** (the `diff` string) with **Confirm** / **Cancel**. Confirm calls `applyChatAction(action)`. For a `run_task` action, the returned `run_id` links to the AgentTab run view: dispatch a new cross-tab event `supertwin:open-run` (mirror `OPEN_SPACE_EVENT`). `.chat__action*` classes.

In `src/App.tsx`, add an `OPEN_RUN_EVENT = "supertwin:open-run"` listener that switches `active` to `"agent"` (and forwards the `run_id` so AgentTab opens the run detail) — mirror the existing `supertwin:open-space` → Spaces wiring.

### 13.5 `src/styles.css` — new classes (BEM-per-surface)

- `.agent__*` — queue sections, task cards, status badges, run-detail plan/transcript/results panes.
- `.settings__runs*`, `.settings__logs*` — the two new Settings cards + notifications toggle.
- `.chat__action*` — the confirm-diff card.

Follow the existing BEM-per-surface convention; reuse `wa-btn`, `wa-modal`, `wa-spinner`, and `spaces__badge` tones where possible.

---

## 14. Files to create / modify

### Backend (worker)

Create:
- `worker/src/tasks/types.ts` — `TaskTriageLLM`/`DoneDetectionLLM` seams + result types.
- `worker/src/tasks/triage.ts` — `ClaudeTaskTriage` + `RuleTriage`.
- `worker/src/tasks/done-detection.ts` — `ClaudeDoneDetection` + `RuleDoneDetection`.
- `worker/src/tasks/scheduler.ts` — `Scheduler`.
- `worker/src/chat/types.ts` — `ProposedAction`, `ChatActionLLM`, `ChatActionResult`.
- `worker/src/chat/actions.ts` — `ClaudeChatAction`/`RuleChatAction` + `applyChatAction`.
- `worker/src/execution/types.ts` — executor types, `ExecStreamFrame`, `TaskStreamFrame`, context bundle.
- `worker/src/execution/executor.ts` — `Executor`.
- `worker/src/execution/context.ts` — `gatherContext`.
- `worker/src/execution/tools.ts` — `TOOLS_BY_TASK_TYPE` + `toolsForTaskType`.
- `worker/src/execution/index.ts` — re-exports.
- `worker/src/server/phase3-routes.ts` — `handlePhase3Route`.
- `worker/src/logs.ts` — logs util.
- `worker/src/notify.ts` — `notify`.

Modify:
- `worker/src/db/schema.ts` — append `0006_phase34` (§1).
- `worker/src/db/index.ts` — extend `LogRunParams` + `insertRun` with `model`/`role` (§4).
- `worker/src/extraction/store.ts` — extend `TaskRow`, add all task/task_run/runs functions, notifications flag, expand `MODEL_KEY_BY_ROLE` + generalize `getAllSelectedModels` (§3).
- `worker/src/providers/claude-local/models.ts` — expand `ModelRole`/`MODEL_ROLES` (§8).
- `worker/src/extraction/engine.ts` — add a post-extract hook that, for each touched space, runs triage on newly-inserted `open` tasks (`setTaskTriage`→`queueTasks`) and done-detection over the space's open tasks vs the batch events (`markTaskDone`), emitting `task_proposed`/`task_triaged`/`task_queued`/`task_done_detected` on the task stream + firing `notify` for approval-needed proposals. Accept the seams + a task-stream emitter via `EngineOptions`.
- `worker/src/server/phase2-routes.ts` — `export` + extend `taskOut` (§11.1); add `taskRunOut`.
- `worker/src/server/index.ts` — dispatch `handlePhase3Route` (§11); pass `role`/`model` into the chat `logRun`; thread `executor`/`scheduler`/`chatAction` through `StartServerOptions`.
- `worker/src/index.ts` — construct `Scheduler`, `Executor`, the three seams; `ensureLogsDir()`; wire scheduler `onDue → executor.enqueue`; start scheduler; stop them on shutdown; pass into `startServer`.
- `worker/src/extraction/llm.ts` — pass `role`/`model` to `db.logRun`.
- `worker/src/brain/writers.ts` — add `appendCorrection(text, eventId?)` writing to `me/procedures/system-corrections.md` (managed `corrections` section, mirroring `appendPreference`); export from `worker/src/brain/index.ts`.

### UI (src)

Modify:
- `src/lib/worker-client.ts` — new types + functions (§13.1).
- `src/tabs/AgentTab.tsx` — full Queue + Run-detail build (§13.2).
- `src/tabs/SettingsTab.tsx` — Runs card, Logs card, notifications toggle (§13.3).
- `src/tabs/ChatTab.tsx` — confirm-diff card + `supertwin:open-run` (§13.4).
- `src/App.tsx` — `OPEN_RUN_EVENT` listener → Agent tab (§13.4).
- `src/styles.css` — `.agent__*`, `.settings__runs*`, `.settings__logs*`, `.chat__action*` (§13.5).

---

## 15. Test plan

### Vitest files to add (worker)

- `worker/src/db/migration-0006.test.ts` — migration idempotent; re-run is a no-op; new columns/table exist; `duplicate column name` tolerated on a hand-mangled DB.
- `worker/src/extraction/store-tasks.test.ts` — `setTaskTriage`/`scheduleTask`/`snoozeTask`/`editTask`/`setTaskState`/`markTaskDone`/`rejectTask`/`queueTasks`; `listTasks` filters; `dueTasks` (immediate + scheduled + snoozed exclusion + boundary `execute_at == now`); `TaskRow`/`taskOut` include all new fields; `createTaskRun`/`finishTaskRun`/`listTaskRuns`/`taskRunsForTask`; `listRuns` shape + `COALESCE(role,kind)`.
- `worker/src/tasks/triage.test.ts` — `RuleTriage` classification matrix (explicit research → auto; implicit → approval; outward → approval; time text → `execute_at`; recurrence parse); `ClaudeTaskTriage` falls back to `RuleTriage` on provider error; logs `role:'triage'`.
- `worker/src/tasks/done-detection.test.ts` — `RuleDoneDetection` yes/possible/no on keyword+overlap; maps to `markTaskDone`.
- `worker/src/tasks/scheduler.test.ts` — tick picks only due tasks; kill-switch / global-pause skip; fires within 1 min; recurrence re-queue (daily/weekly/monthly/"every N days").
- `worker/src/execution/executor.test.ts` (fake provider) — concurrency ≤ 2; plan→execute→done writes result + task_run + space log; failure → `failed` + error; cancel kills run + marks `cancelled` + emits `run_cancelled`; retry re-enqueues; no zombie processes (provider `cancel`/`killAll` called).
- `worker/src/execution/tools.test.ts` — `toolsForTaskType` map (research has no browser; outward/reminder empty; default `other`).
- `worker/src/execution/context.test.ts` — bundle includes space.md + wikilinked files + FTS hits (spot-check the right brain facts land).
- `worker/src/chat/actions.test.ts` — `parse` → each `ProposedAction` + diff string; `applyChatAction` routes to the right `store` call; `run_task` enqueues + returns `run_id`.
- `worker/src/server/phase3-routes.test.ts` — every route: status codes, request/response JSON shapes, queue grouped-by-space (never flat), `503` when a dep is null, `/status|/move|/approve` still handled by phase-2, SSE stream emits frames.
- `worker/src/server/settings-notifications.test.ts` — GET/POST notifications flag; default true.
- `worker/src/providers/claude-local/models.test.ts` (extend existing) — six roles; `isValidRole` for the four new keys; catalog unchanged.

### UI tests

- `src/tabs/AgentTab.test.tsx` — queue renders grouped by space; approve/reject/edit/snooze/schedule/run call the right client fn; run-detail shows plan + streamed transcript; cancel while running; retry on failed.
- `src/tabs/SettingsTab.test.tsx` (extend) — Runs table rows; Logs card path + reveal button; notifications toggle; Models card renders all six roles.
- `src/tabs/ChatTab.test.tsx` (extend) — a message yielding a `ProposedAction` renders the confirm card; Confirm calls `applyChatAction`; `run_task` fires `supertwin:open-run`.
- `src/lib/worker-client.test.ts` (extend) — new endpoint URL/shape round-trips; `streamTasks` parses `TaskStreamFrame`s.

### Eval additions (`/evals` + `worker/src/evals`)

- Triage eval set: ≥20 synthetic proposed tasks with gold `auto|approval` labels → classification accuracy **>90%** (spec Phase 3 eval). Run under `--llm=fake`/oracle in CI (extend `scripts/eval-run.mjs` + `evals/fixtures/v1/set.json` or a new `evals/fixtures/triage/`).
- Scheduler eval: a time-specified task fires **within 1 min** of target.
- Execution eval: 10 varied tasks (research/summarize/draft/plan) → **≥8** produce useful results without intervention; **0 zombie processes**; context includes the correct brain facts (spot-check 5).
- Done-detection eval: completion signals in follow-up events mark the matching task `done`/`possibly_done` with the right evidence id; no false "done" on unrelated events.

### Acceptance criteria (from the spec)

**Phase 3**
- "remind me to pay rent on the 5th" → task with `execute_at` = the 5th (`task_type:'reminder'`, triage may be auto but reminder just notifies).
- "find flights to Goa" → auto-queued `research` task in the Goa space (triage `auto`, status `queued`).
- An implicit suggestion requires approval before anything runs.
- Rejecting a suggestion type stops it recurring (lesson written to `me/procedures/system-corrections.md`; extractor prompt few-shot picks it up).
- Snooze reschedules (sets `snoozed_until`, drops out of the queue until elapsed).
- "done, booked it" in chat → the open booking task auto-marks `done` with an evidence link (done-detection).
- Auto-vs-approval classification **>90%** on 20 synthetic messages; scheduled task fires within 1 min.

**Phase 4**
- "research best CRM for solo founder" runs end-to-end → plan visible → live transcript → results card with sources.
- A failed task shows the error + a Retry that works.
- Cancel mid-run works (process killed, `task_run` `cancelled`, no zombie).
- 10 varied tasks → ≥8 useful without intervention; 0 zombie processes; context includes correct brain facts.
- Chat can trigger a run ("go find flights for the trip") — task created, queued, run, and the `run_id` linked back into the conversation (opens AgentTab run view); results return to the chat + the space.
```
