# SuperTwinV13

A local-first, private, proactive personal AI assistant — a Mac desktop app fed
by your own data (WhatsApp is source #1). All data stays on your machine: the
"brain" is a plain-markdown wiki you can inspect and edit, SQLite holds
operational truth, and Claude runs through your own subscription via the local
CLI.

> **Status: Phase 0** — skeleton + Claude adapter. This repo currently ships the
> app scaffold (5-tab shell), the SQLite/worker/provider structure, and a
> functional Chat tab. WhatsApp ingestion, spaces/extraction, and the task
> engine come in later phases. See `docs/PHASE0_ARCHITECTURE.md`.

## Requirements

- **Node** 22+ and **npm** 11+
- **Rust** / cargo 1.77+ (for the Tauri shell)
- **Claude Code** CLI on your `PATH` (`claude`)

## Getting started

```bash
npm install          # installs root (UI/Tauri) + the worker workspace
npm run dev          # Vite dev server on http://localhost:1420
npm run tauri dev    # launches the desktop app (spawns Vite for you)
```

Other useful scripts:

```bash
npm run build                        # tsc + vite build → dist/
npm run worker                       # DEV worker: scratch home under $TMPDIR, port 8113, 30-min self-kill — never your real data
npm run worker:live                  # the REAL home + port 8013 (what the app runs); only with the app closed, and it still spends money
npm test                             # UI unit tests (vitest)
npm run typecheck -w @supertwinv13/worker   # typecheck the worker
```

## Repo layout

```
/                    root package.json (npm workspaces: ["worker"]), Vite config
/docs                project docs — see docs/README.md for the index
/src                 React UI (Vite + React 18 + TS): 5-tab app shell
  /tabs              Inbox, Spaces, Agent, Chat, Settings
/src-tauri           Tauri 2 Rust shell (single window; worker sidecar wiring)
/worker              Node/TS worker workspace (@supertwinv13/worker)
  /src/db            SQLite schema, migrations, data-access
  /src/providers     provider interface + registry (Claude adapter under claude-local)
  /src/server        localhost HTTP + SSE server exposing the provider to the UI
  /src/index.ts      worker entrypoint (migrations → server → WORKER_READY)
/brain-template      initial brain-wiki skeleton copied to ~/SuperTwinV13/brain
```

## Ports

- UI dev server (Vite): **1420**
- Worker HTTP/SSE server: **8013** (override via `SUPERTWIN_WORKER_PORT`)

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use; commercial use requires a separate license from the copyright holder.
