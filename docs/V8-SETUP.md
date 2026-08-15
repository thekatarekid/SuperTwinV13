# SuperTwin V8 — setup

Scope: Phase 0 (Claude adapter + chat) + Phase 1 (WhatsApp connector), plus the
Dayflow UI, the Settings screen, and grounded chat with citations.

App name: **SuperTwinV8**. Data folder: **`~/SuperTwinV8`**. See BUILD.md to build.

Branch: `v8-phase1-plus`. Full history is intact — `main` still has everything.

---

## 1. Point V8 at its own data folder

This is the database decision. **Copy, don't move, and don't start fresh.**

The app now defaults to `~/SuperTwinV8` on its own — no env var needed. To
carry your existing data over, copy it **before** first launch:

```bash
cp -R ~/SuperTwin ~/SuperTwinV8
```

What this gets you:

- Imported WhatsApp messages carry over — no re-import
- WhatsApp session carries over — **no QR re-scan**
- Chat history and sessions carry over
- Your original `~/SuperTwin` is untouched, so the old build still works

No migration ever drops anything, so the copied DB keeps every table and row it
had — V8 simply never reads or writes most of them. `0007_phase5` is the one id
`worker/src/db/schema.ts` no longer defines: an install that already ran it keeps
`nightly_runs` and `quality_snapshots` as untouched orphans, and a fresh DB never
creates them. The rest stay because live code still reads them — `evaluations`
from `0004`, `extraction_runs.model`/`role` from `0006`, grounded chat and media
from `0005`/`0008`.

If you'd rather start clean, skip the copy — the app creates an empty
`~/SuperTwinV8` and asks you to scan a QR. `SUPERTWIN_HOME` still overrides the
folder if you want a build to point elsewhere.

---

## 2. Build and run

```bash
npm ci
npm run tauri dev      # dev
npm run build:app      # release .dmg — see BUILD.md
```

`bundle-worker.mjs` needs the Go toolchain — it compiles the daemon into the
worker bundle. Everything else runs without it.

---

## 3. What's in the app

Three tabs: **Inbox**, **Chat**, **Settings**.

**Inbox** — WhatsApp chats, messages, search, media previews, reactions and
replies. Onboarding: QR pair, pick an import range, extend to older history,
pause, re-link, reset.

**Chat** — streaming multi-turn chat on the Claude CLI. Grounded by default: a
`<supertwin-context>` block of FTS5 hits over your imported messages is injected
before each turn, and the model returns inline `[1]` `[2]` citations. Clicking
an event citation opens a provenance popover with the source message. 👍/👎 on
an answer is recorded.

**Settings** — worker status, token usage against the rolling quota, the chat
model picker with an on/off toggle, recent LLM runs, the brain wiki folder, and
the log files.

---

## 4. Known rough edges

**Grounded chat's system prompt still describes the brain wiki** (`spaces/`,
`people/`, `workflows/`) and the retrieval block still has an "Active spaces"
section. Nothing writes those files any more, so the folder stays at whatever
`brain-template` seeds and the spaces list comes back empty. Chat degrades
cleanly — event FTS is the part that does the work — but if it starts
hallucinating about spaces, trim `GROUNDED_SYSTEM_PROMPT` in
`worker/src/server/chat-grounding.ts`.

**Citation chips of kind `space` / `person` / `task` are inert.** The model can
still emit them; they render but don't navigate, because those surfaces are
gone. Event citations work fully.

**The `extraction.*` app_state keys outlive the extraction engine.** The store
now lives in `worker/src/store/`, but `extraction.enabled`, `extraction.cursor`
and the three `extraction.last_*` keys keep their old prefix — they sit in every
existing install's database and renaming them would reset those settings.

**Real-CLI integration tests fail in a sandbox without Claude auth.** This is
pre-existing and unrelated — verified identical on untouched `main`. On your
machine with an authed CLI they should pass.

**The chat on/off toggle in Settings can disable the whole app.** It's enforced
server-side: flip it off and every chat turn replies with the literal string
"Chat is turned off in Settings." The Chat tab gives no hint why. It's the only
role left, so the switch is now much more consequential than it was when it sat
in a list of seven.

**`npm run eval` is gone.** The eval runner lived in `worker/src/evals/` and
only exercised the extraction engine, so it went with it, along with
`scripts/eval-*.mjs` and the fixtures.

---

## 5. Verification status

| Check | Result |
|---|---|
| `worker` typecheck | clean |
| `worker` tests (non-integration) | 176 passed |
| frontend typecheck | clean |
| frontend tests | 111 passed |
| `vite build` | clean |
| `esbuild` worker bundle | 139.5 kB, clean |
| Go daemon | one-line device-name change; not compiled (no Go toolchain) |
| Tauri shell | crate renamed; not compiled (no Rust toolchain) |
