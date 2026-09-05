# SuperTwinV13 — rules for agents working in this tree

Tauri shell (`src-tauri`) + Node worker (`worker/src`) + React UI (`src`) + Go WhatsApp daemon (`sources/whatsapp-go`) + Swift screen sidecar (`sources/screenwatch`). Build plan: `SuperTwinV13_Build_V6_Phase1.md`; progress log: `progressV13_V6_Phase1.md`.

## Running the worker (HARD rules — build plan §1.3)

These are process rules, not preferences. They exist because a hand-started worker once ran against the real home for nine hours and spent real money.

1. **Never run the worker without BOTH** `SUPERTWIN_HOME=<scratch dir>` **and** `SUPERTWIN_WORKER_PORT` ≠ 8013. `npm run worker` (`scripts/dev-worker.mjs`) does this for you: scratch home under `$TMPDIR`, port 8113, PID file, 30-minute self-kill. `npm run worker:live` is the real home and is for the app, not for you.
2. **Never detach a process.** No `&`, no `nohup`, no `disown`, no `setsid`. Use the Bash tool's `run_in_background` if a long process is unavoidable, and reap it before your turn ends.
3. **Any port you open, you close in the same turn — and you say so.** A worker you booted is killed before you report.
4. **A listener you did not start is not automatically the user's app.** If `lsof -i:8013` (or any port) shows a process you did not spawn, report it; do not assume, do not kill it silently, do not talk to it.
5. **Anything that reaches the `claude` CLI spends money.** Unit tests must make ZERO live model calls. Before running anything that could (`npm run eval`, an integration test, a manual worker boot), state the expected call count. Report the actual count.
6. **Never boot a worker against the production home (`~/SuperTwinV13`) to verify a change.** Tests are enough. The worker itself refuses such a boot (`worker/src/home-guard.ts`) unless `SUPERTWIN_LAUNCHED_BY=app` (set by the Tauri shell) or `SUPERTWIN_ALLOW_PRODUCTION_HOME=1` (an explicit operator waiver — you are not the operator).

Rails in the tree that back these rules: `worker/src/home-guard.ts` (refuses production-home boots), `worker/src/providers/budget.ts` (hard ceiling — $3/h, $15/day, 400 calls/h, 3,000 calls/day — thrown before spawn, latched in `app_state.budget_tripped_at`, no auto-resume), `worker/src/process-guard.ts` (10-minute self-shutdown after parent loss unless `SUPERTWIN_WORKER_NO_PARENT=1`, startup sweep of stale workers, `killAll()` on unhandled rejection).

## Tests and typecheck

- Worker: `cd worker && npx vitest run <path>`; typecheck `npx tsc --noEmit -p worker`.
- UI: `npx vitest run <path>` from the root (jsdom). Build scripts: `npm run test:scripts`.
- Evals (`npm run eval`) drive the REAL model and cost money — rule 5 applies. The harness sandboxes its home (`worker/src/evals/home.ts`).

## Commits

- One task per commit, message `<TASK-ID>: <summary>`; stage only your own files with explicit `git add <paths>`, never `git add -A`.
- Do not bump versions; `scripts/release.mjs` does that.
