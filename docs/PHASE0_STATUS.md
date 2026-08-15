# Phase 0 — Status: ✅ COMPLETE & INDEPENDENTLY VERIFIED

*Skeleton + Claude adapter.* Built via parallel execution subagents (disjoint dirs) against
`docs/PHASE0_ARCHITECTURE.md`, then re-verified by independent test subagents that did not reuse
the builders' own tests.

## What shipped

- **Monorepo** (npm workspaces): Vite 6 + React 18 + TS (strict) UI in `/src`, Tauri 2 shell in
  `/src-tauri`, Node/TS worker `@supertwin/worker` in `/worker`, `brain-template/` skeleton.
- **5-tab app shell**: Inbox / Spaces / Agent / Settings are placeholders; **Chat** is functional.
  Settings shows a live worker health + quota indicator.
- **SQLite init** (`~/SuperTwin/supertwin.db`, WAL, FK on; `SUPERTWIN_DB_PATH` override): full
  operational schema (sources, events, channels, actors, people, spaces, goals, milestones, tasks,
  space_events, extraction_runs) + FTS5 on `events.text` + chat/session/quota tables. Idempotent
  transactional migrations.
- **Claude adapter** (`worker/src/providers/claude-local`, Paperclip-style): prompt via **stdin**;
  `claude --print --output-format stream-json --verbose --include-partial-messages --allowedTools ""`;
  robust NDJSON parser (token-by-token deltas); UUID + cwd + prompt-bundle **session guards**;
  **poisoned-session detection → transparent fresh-session fallback** (never an error);
  `--append-system-prompt` on fresh sessions only (token economy); per-run timeout + typed error
  codes; `runId→child` map with guaranteed reaping (**0 orphaned processes**).
- **Provider interface + registry** (Cabinet-style thin contract) — `claude-local` is the default;
  Codex/Gemini/local can slot in later.
- **Worker HTTP+SSE server**: `/api/chat` (SSE), `/api/cancel`, `/api/sessions[/:id]`, `/api/quota`,
  `/api/health`; server-side quota enforcement + cwd/bundle resume guard; persists every message and
  **logs every Claude call to `extraction_runs`** (prompt_chars, tokens, cost, duration) — a spec
  non-negotiable.
- **Chat UI (v0)**: streaming responses, multi-turn via session resume, session list + reopen,
  new-chat, cancel. Manual `text/event-stream` parser; client-generated `runId`.
- **Tauri sidecar**: spawns the worker via `tauri-plugin-shell`, emits `worker-ready` on
  `WORKER_READY`, and **kills the child on exit** (`WindowEvent::Destroyed` + `RunEvent::Exit`) —
  the kill-switch foundation. Verified: launching the built binary auto-boots the worker.

## Acceptance + Eval — verified (independent agents, real `claude` 2.1.197)

| Criterion | Result |
|---|---|
| App launches (runnable binary boots full stack) | ✅ |
| Chat → streamed response renders (live browser e2e) | ✅ |
| Multi-turn holds context (resume) | ✅ |
| Past sessions reopenable | ✅ |
| Kill / cancel works (no orphan) | ✅ |
| Invalid/poisoned session → fresh fallback (not an error) | ✅ |
| **Eval:** 10 consecutive prompts, 0 orphaned processes | ✅ (before=0, after=0) |
| **Eval:** resume preserves context | ✅ |
| **Eval:** resume after cwd change starts fresh cleanly | ✅ |
| **Eval:** quota counter matches actual usage | ✅ (extraction_runs = quota_usage = summed usage) |

Test coverage: worker 52 tests (db 14 + adapter/server 38), UI 25, plus two independent
end-to-end eval passes (headless 14/14 + browser e2e).

## How to run

```bash
npm install
npm run dev          # Vite UI on http://localhost:1420 (talks to worker on :8787)
npm run worker       # start the worker standalone (tsx worker/src/index.ts)
npm run tauri dev    # full desktop app (Tauri spawns the worker sidecar automatically)
npm test             # UI tests;   npm run test -w @supertwin/worker  # worker tests
```

Env: `SUPERTWIN_DB_PATH`, `SUPERTWIN_WORKER_PORT` (default 8787), `SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS`.

## Handoff to Phase 1 (WhatsApp ingestion)

The `events`/`sources`/`channels`/`actors` tables + FTS5 already exist (schema front-loaded). Phase 1
adds the generic `SourceAdapter` interface + Events pipeline and the Go/whatsmeow daemon as a real
Tauri sidecar (the shell-plugin spawn/kill pattern is already in `src-tauri/src/lib.rs`), plus the
Inbox UI. No schema rewrite required to add a source.
