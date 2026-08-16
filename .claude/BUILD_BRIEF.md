# Agent brief — SuperTwinV11 V2 build

You are implementing one numbered item from `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`
(repo root, "the build doc"). Read **only** your item's section plus the architecture sections it cites.

## Reference documents (repo root)

- `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md` — the build doc. Your item's
  section lists Files / Description / Technical / UI / Tests / Acceptance. Follow it literally.
- `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2.md` — "the arch doc". Cited as §N.
  Find a section with `grep -n '^### §\?N' <file>` or `grep -n '^#\{2,3\} N\.' <file>`.
- `SuperTwinV11_GoldenEvals_V2.md` — "the evals doc". Categories A–V, `## 5. Cases` at line 82.

**Do not read whole documents into context.** Use `grep -n` to find your sections and `sed -n 'X,Yp'`
to read only those line ranges. These files are 100–200 KB each.

## Repo layout

- `worker/` — TypeScript worker (node, better-sqlite3-style `worker/src/db/`), express-ish server in `worker/src/server/`.
- `src/` — React 18 + Vite frontend, tabs in `src/tabs/`.
- `src-tauri/` — Tauri 2 shell (Rust).
- `sources/whatsapp-go/` — Go WhatsApp daemon (do not change unless your item says so).
- `evals/` — eval fixtures (created by item 0.6).

## Rules

1. **TypeScript strict.** `npx tsc -b` must be clean for anything you touch.
2. **Tests are mandatory and ship in the same change.** Framework is `vitest`. Put tests next to the
   source as `<name>.test.ts`. There are **three separate suites** — know which one covers your files:
   - `worker/` → `npm test -w worker` (~950 tests, its own vitest config). **The root `npx vitest run`
     does NOT run these.** If you touched `worker/src`, this is the suite you must run.
   - `src/` (React) → `npx vitest run` from the repo root.
   - `scripts/` → `npx vitest run --config scripts/vitest.config.mjs`.
   Run the targeted files first (`npx vitest run <path>`), then the whole suite that owns them.
   Note: `worker/src/server/media-tools.test.ts` has one pre-existing flaky download assertion that
   also fails on `main` — it is not yours, leave it be and say so if you see it.
3. **No file over ~600 lines.** Split by concern.
4. Executor tags in code comments where the doc names one: `[CODE] [ML] [LLM-S] [LLM-M] [AGENT]`.
5. **No data migration.** Fresh install only. Never edit an already-applied migration.
6. **No `spaces` table** — promotion is a field set on `arcs`.
7. **No JSON for model I/O** — STW-2 wire format both directions (see arch §5).
8. Never use `ingested_at` for precedence. `events.ts` / `claim_versions.stated_at` only.
9. Code must never drop, edit, censor or filter model output. Order it, never censor it.
10. Do **not** run `git commit`, `git push`, `npm install`, or the full test suite. The orchestrator does that.
11. Do not edit files outside your item's declared file list. If you must touch a shared file,
    make the minimal additive change and say so in your report.

## Your report (the text you return)

Return **only** compact structured text, no preamble:

```
ITEM: <id>
FILES: <comma-separated paths created/modified>
TESTS: <command you ran> -> <N passed / N failed>
TYPECHECK: clean | <first error>
ACCEPTANCE: <one line per acceptance checkbox: MET / NOT MET + why>
NOTES: <shared-file edits, deviations, follow-ups needed by other items — max 5 lines>
```
