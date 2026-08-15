# Phase 0 — Architecture & Integration Contract

**Single source of truth for all Phase 0 subagents.** Read this before writing any code.
Phase 0 = *Skeleton + Claude adapter*. Build ONLY Phase 0. Do not build Phases 1–5.

Reference spec: `../supertwin-whatsapp_build_simplebrain.md` (Phase 0 section + Architecture section).

---

## 1. Goal of Phase 0

1. Tauri 2 + React + TS app scaffold with **5 tabs** (Inbox, Spaces, Agent, Chat, Settings) — 4 empty placeholders + a **functional Chat tab**.
2. SQLite init (`supertwin.db`, WAL) with the full operational schema + chat/session tables + `extraction_runs` logging + FTS5 on `events.text`.
3. A **Claude adapter** (Paperclip-style): stdin prompt, stream-json parse, guarded session resume, `--allowedTools` whitelist, quota tracking, cancel/kill, typed errors.
4. A thin **provider interface + registry** (Cabinet-style) the adapter plugs into, so Codex/Gemini/local can slot in later.
5. **Chat tab v0**: streaming responses, multi-turn via resume, session list, new-chat, cancel. No data access yet.

**Acceptance:** app launches; chat → streamed response renders; multi-turn holds context; past sessions reopenable; kill works; invalid/poisoned session falls back to a fresh session (not an error).

**Eval:** 10 consecutive prompts, 0 orphaned processes; resume preserves context; resume after cwd change starts fresh cleanly; quota counter matches actual reported usage.

---

## 2. Repo layout (npm workspaces monorepo)

```
/                         root: package.json (workspaces: ["worker"]), README.md, .gitignore
/docs/PHASE0_ARCHITECTURE.md   this file
/src                      React UI (Vite + React 18 + TS)
/src-tauri                Tauri 2 Rust shell + worker sidecar lifecycle
/worker                   Node/TS worker (own package.json) — Claude adapter, provider, db, server
  /src
    /db                   SQLite schema, migrations, data-access module (index.ts)
    /providers            provider interface + registry (index.ts, types.ts, registry.ts)
      /claude-local       Claude CLI adapter (Paperclip-style)
    /server               local HTTP + SSE server exposing the provider to the UI
    /index.ts             worker entrypoint: run migrations, start server, print WORKER_READY
  package.json, tsconfig.json, vitest.config.ts
/brain-template           initial brain dir skeleton (mostly placeholders for P0)
```

Root `package.json` uses npm workspaces so `/worker` is a workspace. UI stays at root `/src` driven by Vite (root-level `package.json` holds React/Vite/Tauri-cli dev deps). Keep the worker as a separate workspace package with its own deps (better-sqlite3, etc.).

---

## 3. Toolchain (verified present)

Node v22, npm 11, pnpm 11, cargo/rustc 1.96, `claude` 2.1.197 at `/Users/adityakatare/.local/bin/claude`.
Tauri CLI is **not** global — add `@tauri-apps/cli` as a root devDependency and run via `npm run tauri`.

Worker runs TypeScript via `tsx` in dev and builds with `tsc` to `dist/`. Tests use `vitest`. SQLite via `better-sqlite3`.

---

## 4. The Claude CLI invocation (VERIFY with `claude --help` before coding)

Base (fresh session):
```
claude --print --output-format stream-json --verbose --allowedTools <csv-or-repeated> [--append-system-prompt-file <file>] [--max-turns N]
```
- **Prompt is piped via STDIN**, not argv. Write the user message to `child.stdin`, then end it.
- `--output-format stream-json` REQUIRES `--verbose` when combined with `--print`.
- Resume: add `--resume <sessionId>` (follow-up turns). Do **not** re-send `--append-system-prompt-file` on resume (token economy — instructions are cached in the session).
- Permissions: pass an explicit `--allowedTools` whitelist. For P0 plain chat use an **empty/minimal** allowlist. NEVER use `--dangerously-skip-permissions`.
- `-p` is non-interactive; disallowed tools are denied without prompting (plain chat won't call tools anyway).

**The adapter MUST run `claude --help` and confirm exact flag spellings** (e.g. `--print` vs `-p`, `--append-system-prompt` vs `--append-system-prompt-file`, `--allowedTools` format, `--resume`, `--max-turns`) for CLI 2.1.197 and adapt. Document any deviation in a comment.

### stream-json output shape
NDJSON, one JSON object per line. Expect message types roughly:
- an init/`system` object carrying `session_id` (capture it ASAP → emit `session` event).
- `assistant` message objects with content blocks (text; possibly `tool_use`).
- a final `result` object with `session_id`, `usage` (input/output tokens), `total_cost_usd`, `num_turns`, `is_error`, `subtype`.
Write a **robust NDJSON parser** that buffers partial lines and tolerates unknown types. Do not assume field names — inspect a real run and adapt; normalize into `ProviderStreamEvent` (below).

### Session guards (Paperclip's key lesson)
- Validate `sessionId` is a well-formed UUID before attempting resume.
- Persist, per session: `cwd` and a `prompt_bundle_hash` (hash of system-prompt-file + provider config). Before resuming, verify the requested `cwd` + bundle hash match the saved ones; if they differ (e.g. cwd changed) → **start a fresh session cleanly** (do not resume).
- Detect **poisoned** sessions: a resume that fails with a 400 / bad `previous_message_id` / immediate CLI error. Mark the session `poisoned` in db, drop it, and **transparently retry the message as a fresh session**. This is success from the caller's view — emit a normal stream, not an error.
- Validate-before-persist: only save a session_id after a run actually produced one.

### Quota awareness
- Maintain a rolling usage window (default 5h) of input+output tokens and run counts, accumulated from each run's reported `usage`. Persist to db.
- Expose current counters via `/api/quota`. Set `nearLimit` when configurable thresholds are approached; when exceeded, new runs fail fast with `QUOTA_EXCEEDED` (configurable/threshold high enough not to block evals).
- "Quota counter matches actual usage" = our accumulated counter equals the sum of `usage` reported across runs.

### Process hygiene (eval: 0 orphans)
- Keep a `runId → ChildProcess` map. On done/error/timeout/cancel, ensure the child is killed (SIGTERM→SIGKILL escalation) and removed. No lingering `claude` processes after a run ends. Handle stdin EPIPE, stderr capture, and non-zero exit codes → typed errors.

---

## 5. Provider interface (Cabinet-style, thin) — `worker/src/providers`

Keep it small (~a couple hundred lines total). Types (adapt names sensibly):

```ts
export type ProviderStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "done"; sessionId: string; usage: Usage; stopReason?: string }
  | { type: "error"; code: ProviderErrorCode; message: string; sessionId?: string };

export type ProviderErrorCode =
  | "TIMEOUT" | "SPAWN_FAILED" | "CLI_ERROR" | "POISONED_SESSION"
  | "CANCELLED" | "QUOTA_EXCEEDED" | "BAD_REQUEST";

export interface SendOptions {
  runId: string;
  message: string;
  sessionId?: string | null;   // null/undefined = fresh session
  cwd?: string;                 // default: a safe sandbox dir
  allowedTools?: string[];      // default: [] (plain chat)
  systemPromptFile?: string;    // only applied on fresh sessions
  maxTurns?: number;
  timeoutMs?: number;
  onEvent: (e: ProviderStreamEvent) => void;
  signal?: AbortSignal;         // abort => cancel/kill
}

export interface ProviderResult {
  sessionId: string;
  usage: Usage;                 // { inputTokens, outputTokens, costUsd? }
  freshFallback: boolean;       // true if a poisoned/invalid resume fell back to fresh
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
}

export interface Provider {
  id: string;                                   // "claude-local"
  send(opts: SendOptions): Promise<ProviderResult>;
  cancel(runId: string): boolean;               // kill in-flight run
}

// registry.ts: register(p), get(id), list(), default id = "claude-local"
```

The db logging (`extraction_runs`) and session persistence happen in the **server/adapter layer via the db module** — the provider stays transport-only but reports `usage`/`sessionId` so callers can log. Prefer: adapter emits events; server persists messages + logs the run.

---

## 6. SQLite schema — `worker/src/db` (migration `0001_init`)

`supertwin.db`, WAL mode, foreign_keys ON. Store at `~/SuperTwin/supertwin.db` (create dir) — but allow override via `SUPERTWIN_DB_PATH` env (tests point this at a temp file). Create the FULL operational schema now (this is the spec's "SQLite init"), even though P0 only exercises the chat/session/extraction_runs parts:

Operational tables (from spec Architecture §DB): `sources`, `events(id, source_id, source_type, channel_id, actor_id, ts, kind, text, media_path, raw_json)`, `channels`, `actors`, `people`, `spaces(id, name, type, permanence, status, latest_update, latest_update_ts, ends_at)`, `goals(space_id, recurring)`, `milestones(goal_id)`, `tasks(space_id, goal_id, origin, status, execute_at, recurrence)`, `space_events(space_id, event_id)`, `extraction_runs`. FTS5 virtual table on `events.text`.

`extraction_runs` (spec non-negotiable — every Claude call logged) columns at least:
`id, provider, session_id, run_id, kind (chat|extraction|...), prompt_chars, input_tokens, output_tokens, cost_usd, duration_ms, status, error_code, created_at`.

Phase-0 chat/session tables:
- `chat_sessions(session_id PK, provider, cwd, prompt_bundle_hash, title, status ['active'|'poisoned'], created_at, updated_at)`
- `chat_messages(id PK, session_id FK, role ['user'|'assistant'|'system'], content, run_id, usage_json, ts)`
- `quota_usage(id PK, window_start, input_tokens, output_tokens, run_count, updated_at)` (or compute from extraction_runs — implementer's choice, but expose a stable API).

Expose a typed data-access API (functions, not raw SQL, to callers):
`runMigrations()`, `getDb()`, `logRun(...)`, `createSession(...)`, `markSessionPoisoned(id)`, `updateSessionTimestamp(id)`, `getSession(id)`, `listSessions()`, `appendMessage(...)`, `getMessages(sessionId)`, `getQuota(windowMs)`, `addUsage(...)`.
Migrations must be **idempotent** and re-runnable. Include a `schema_migrations` table.

---

## 7. Worker server contract — `worker/src/server` (localhost)

HTTP server (use `node:http` or a tiny framework; no heavy deps). Default port `8787`, override `SUPERTWIN_WORKER_PORT`. On listen, print exactly `WORKER_READY port=<port>` to stdout (Tauri + tests detect this).

Endpoints (all JSON unless noted):
- `GET /api/health` → `{ ok: true, version }`.
- `POST /api/chat` → **SSE** (`Content-Type: text/event-stream`). Body `{ runId, sessionId?, message }`. Streams `data: <json ProviderStreamEvent>\n\n` frames: `session`, `delta`, `usage`, `done`, or `error`. Server persists the user message + assistant reply to `chat_messages`, updates the session, logs to `extraction_runs`, and updates quota. If a fresh-fallback happened, the emitted `session` event carries the NEW sessionId.
- `POST /api/cancel` → `{ runId }` → kills that run's process; stream terminates with `error` code `CANCELLED`. Returns `{ ok: true }`.
- `GET /api/sessions` → `[{ sessionId, title, cwd, status, createdAt, updatedAt, messageCount }]`, most-recent first.
- `GET /api/sessions/:id` → `{ session, messages: [{ role, content, ts, runId }] }`.
- `GET /api/quota` → `{ windowMs, windowStart, inputTokens, outputTokens, runCount, nearLimit }`.
- `POST /api/sessions/new` (optional) → `{ sessionId: null }` marker; new chat is simply the next `/api/chat` with no `sessionId`.

CORS: allow `http://localhost:*` and the Tauri origin (`tauri://localhost`) for GET/POST.

---

## 8. Frontend — `/src` (React + TS + Vite)

- App shell with a left/top tab bar: **Inbox, Spaces, Agent, Chat, Settings**.
- Inbox / Spaces / Agent / Settings = empty placeholder panels ("Coming in Phase N" — Inbox=P1, Spaces=P2, Agent=P3/4). Settings may show a small quota/health indicator (nice-to-have, not required empty).
- **Chat tab (functional):**
  - Session list (sidebar): from `GET /api/sessions`; click to reopen (`GET /api/sessions/:id` → render transcript). "New chat" button.
  - Message thread: user + assistant bubbles; assistant streams token-by-token from the SSE `delta` events.
  - Composer: textarea + Send; Send posts to `/api/chat` with the current `sessionId` (or none for new). On first `session` event, store the sessionId for subsequent turns (multi-turn resume).
  - Cancel button visible while streaming → `POST /api/cancel` with the runId (generate a runId client-side per send).
  - Error/poison fallback is invisible to the user: a `session` event may swap in a new sessionId mid-conversation; just adopt it.
- Worker base URL: `http://localhost:8787` (configurable via a constant / env). Use `fetch` + a streaming SSE reader (parse `text/event-stream` manually from the response body reader; do not require EventSource since we POST).
- Keep UI dependencies minimal (React + a light styling approach). Provide a `vitest` + Testing Library unit test for the SSE parsing / chat store logic against a mocked stream.

---

## 9. Tauri shell — `/src-tauri`

- Tauri 2, single window loading the Vite app.
- Add `tauri-plugin-shell`. On app startup, **spawn the worker** as a child: dev = `npx tsx worker/src/index.ts` (or `node --import tsx`), prod = `node worker/dist/index.js`. Wait for `WORKER_READY` on stdout before revealing/enabling chat (or just spawn and let the UI retry `/api/health`). **Kill the worker on app exit** (window close / drop) — no orphaned worker. This is the basic sidecar lifecycle + kill-switch foundation.
- `cargo build`/`cargo check` for `src-tauri` must succeed. Full bundling of a Node sidecar binary is **deferred**; dev-mode spawn of system `node`/`tsx` is acceptable for Phase 0 (document this).

---

## 10. Testing expectations (test subagents)

Headless-testable (no GUI needed) — this is where the Eval lives:
- **Adapter/provider unit + integration** (vitest, real `claude` CLI): send a prompt, assert a streamed reply; multi-turn resume preserves context (ask name, then "what did I say?"); resume-after-cwd-change starts fresh; poisoned/invalid sessionId falls back to fresh (not an error); cancel kills the process; **10 consecutive prompts leave 0 orphaned `claude` processes** (check via `pgrep`/`ps` before/after); quota counter equals summed reported usage.
- **db**: migrations idempotent; tables present; logRun/session/message round-trips.
- **server**: boot on a temp port + temp DB, curl/fetch `/api/health`, `/api/chat` SSE happy path, `/api/sessions`, `/api/cancel`.
- **UI**: vitest component/store tests with a mocked SSE stream (stream render, multi-turn sessionId capture, cancel).
- **App launch**: `cargo check`/build of src-tauri succeeds; worker boots and prints `WORKER_READY`; a full dev smoke (worker + a scripted SSE chat) works. A visible-window launch may not be possible headlessly — if so, verify build + worker boot + document the GUI caveat.

Every test agent returns a concise PASS/FAIL per criterion with evidence (command + key output lines), not full logs.

---

## 11. Non-negotiables carried into P0

- All data local. Brain dir is plain markdown (create `brain-template/` skeleton; git-init of the runtime brain is a later phase — just scaffold the template).
- No outbound WhatsApp (N/A in P0).
- **Every Claude call logged** (prompt proxy = prompt_chars, cost proxy, duration) in `extraction_runs`.
- Kill-switch foundation: worker is killable; adapter cancel kills processes.

## 12. Conventions

- TypeScript strict mode on. ESM modules. No secrets committed. `.gitignore`: `node_modules/`, `dist/`, `target/`, `*.db`, `*.db-wal`, `*.db-shm`, `.DS_Store`, `~/SuperTwin` is outside repo anyway.
- Each execution agent: build only your assigned directories; do not edit another agent's files. Integration wiring is a separate step.
- Prefer small, well-typed modules. Comment the tricky bits (CLI flag choices, poison detection, NDJSON buffering).
