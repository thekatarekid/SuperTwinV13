# SuperTwinV11 — Phase 1 Build Plan
**Entities, Relations, Sessions · WhatsApp only · fresh install, no data migration**

Implements `SuperTwinV11_ProductandArchitecture_Chunking_V1_Phase1.md` on top of the V11 repo.
Evals come from `SuperTwinV11_GoldenEvals_V1.md` (categories A–I, L).

---

## 0. How to run this document

1. Read this whole file first. Then read the Phase 1 architecture doc.
2. Work **wave by wave**. A wave starts only when the previous wave is green.
3. Inside a wave, **tracks run in parallel**. One subagent per track.
4. Each track owns its files (§3). Never edit a file another track owns.
5. Every task ends with its tests passing and `npm test` green.
6. Commit per task. Message: `<TASK-ID> <short what>`.

### 0.1 Ground rules

1. **WhatsApp is the only wired source.** Other stream kinds get code + unit tests, no adapter.
2. **Fresh install only.** No data migration. No backfill of old rows. A dev deletes `~/SuperTwinV11/supertwinv11.db` before running.
3. **No encryption.** Plain SQLite, WAL. Encryption is a later phase.
4. **No graph DB.** Edges live in a SQL table. Recursive CTEs for walks.
5. **Do not touch** `worker/src/retrieval/*` behaviour, `worker/src/media/*` logic, or the Go daemon. They work.
6. **No claims, no spaces, no tasks, no episodes, no arcs.** Out of scope.

### 0.2 Two facts verified in the codebase — act on these

1. **The CLI may not support replacing the system prompt.** `worker/src/providers/claude-local/index.ts` documents `--append-system-prompt` and says no `*-file` variant exists. It does **not** confirm `--system-prompt`. Task `A1` must **probe** the installed CLI and implement replace-if-available, with a documented fallback. Do not assume.
2. **Migrations 0004 and 0006 create the dead tables.** Because installs are fresh, we do **not** write drop migrations. We **gut** those two migration bodies to empty strings. The ids stay recorded. Nothing is created. This is simpler and safer than dropping.

---

## 1. Wave map

```
WAVE 0  FOUNDATION                                    1 agent, sequential
        cleanup · schema · API contract · eval harness skeleton
             │
             ▼
WAVE 1  PLATFORM                                      3 agents in parallel
        A: CLI bare-call      B: adapter registry     C: embedder calibration
             │                     │                      │
             └──────────┬──────────┴──────────────────────┘
                        ▼
WAVE 2  PIPELINE                                      3 agents in parallel
        D: entity graph core  E: sessions engine    F: salience + enrich audit
             │                     │                      │
             └──────────┬──────────┘                      │
                        ▼                                 │
WAVE 3  INTELLIGENCE                                  2 agents in parallel
        G: entity pass (LLM)  H: resolution ladder + agent
             │                     │                      │
             └──────────┬──────────┴──────────────────────┘
                        ▼
WAVE 4  SURFACES                                      3 agents in parallel
        I: API routes         J: Entities UI          K: Sessions UI
             │                     │                      │
             └──────────┬──────────┴──────────────────────┘
                        ▼
WAVE 5  GATE                                          1 agent, sequential
        full eval run · determinism proof · fresh-install smoke
```

### 1.1 Parallel rules

1. **Waves are barriers.** Do not start Wave N+1 until every Wave N track is green.
2. **Tracks inside a wave never share a file.** See the ownership table in §3.
3. **UI tracks (J, K) build against the frozen API contract from Wave 0.** They use fixtures. They do not wait for track I.
4. If a track needs a file it does not own, it **stops and reports**. It does not edit.

---

## 2. Item index

| Wave | Track | Item | Title | Depends on |
|---|---|---|---|---|
| 0 | — | W0 | Foundation | — |
| 1 | A | A1–A4 | CLI bare-call contract | W0 |
| 1 | B | B1–B4 | Adapter registry + WhatsApp manifest | W0 |
| 1 | C | C1–C3 | Embedder calibration | W0 |
| 2 | D | D1–D6 | Entity graph core | W0, B |
| 2 | E | E1–E6 | Sessions engine | W0, B |
| 2 | F | F1–F3 | Salience scaffold + enrichment audit | W0 |
| 3 | G | G1–G4 | Entity pass (P-EP1) | A, D, E |
| 3 | H | H1–H4 | Resolution ladder + P-AG1 | C, D |
| 4 | I | I1–I3 | API routes | D, E, G, H |
| 4 | J | J1–J3 | Entities surface | W0 contract |
| 4 | K | K1–K3 | Sessions surface | W0 contract |
| 5 | — | Z1–Z4 | Gate | all |

---

## 3. File ownership (prevents parallel conflicts)

| Track | Owns (create/edit) |
|---|---|
| W0 | `worker/src/db/schema.ts`, `docs/PHASE1_API_CONTRACT.md`, `evals/**`, deletions |
| A | `worker/src/providers/**` |
| B | `worker/src/adapters/**`, `worker/src/ingest/**`, `worker/src/db/ingest.ts` |
| C | `worker/src/retrieval/embedder.ts`, `worker/src/retrieval/calibration.ts`, `worker/src/db/embeddings.ts` |
| D | `worker/src/entities/**` |
| E | `worker/src/sessions/**` |
| F | `worker/src/salience/**`, `worker/src/media/routing.md` (doc only) |
| G | `worker/src/entities/pass/**`, `worker/src/prompts/entity-pass.ts` |
| H | `worker/src/entities/resolve/**`, `worker/src/prompts/resolver.ts`, `worker/src/tools/**` |
| I | `worker/src/server/entity-routes.ts`, `worker/src/server/session-routes.ts`, `worker/src/server/index.ts` |
| J | `src/tabs/EntitiesTab.tsx` + its test |
| K | `src/tabs/SessionsTab.tsx` + its test |
| J+K shared | `src/App.tsx` — **J edits it, K reviews.** Only J may write. |

---

# WAVE 0 — Foundation

**Agent: 1. Sequential. Blocks everything.**

## W0.1 — Delete dead code

**Description.** Remove the old ontology surface so nothing wrong is reachable.

**Changes.**

- [ ] Delete `worker/src/store/store.ts` and its tests.
- [ ] Delete `worker/src/store/` entirely if nothing else remains. Check `worker/src/store/run-prompt.ts` — if used by server, move it to `worker/src/server/`.
- [ ] Delete `worker/src/brain/writers.ts` and `brain-template/`.
- [ ] Keep `worker/src/brain/root.ts` only if `logs`/paths depend on it. Otherwise delete the folder.
- [ ] Remove the corpus writer path from retrieval. Keep retrieval working: if `corpus.ts` is required by grounded chat, leave the module but disable auto-materialisation behind `app_state` key `debug.corpus_export` (default off).
- [ ] Remove all imports that now dangle. `tsc -b` must pass.

**Technical details.**

1. Search for importers before deleting: `rg "store/store|brain/writers|brain-template"`.
2. If a server route imports a deleted symbol, delete the route too. Note it in the commit body.

**Tests.**

- [ ] `npm test` green after deletion.
- [ ] `tsc -b` clean, both worker and frontend.

**Acceptance.**

1. `rg "spaces|goals|milestones|task_runs" worker/src --type ts` returns only schema strings that are gutted in W0.2, or nothing.
2. App still boots and chat still answers.

---

## W0.2 — Schema reset

**Description.** Gut the dead migrations. Add one new migration that reshapes `events` and creates the Phase 1 tables.

**Changes to `worker/src/db/schema.ts`.**

- [ ] Set `PHASE2` (id `0004_phase2`) SQL body to `""`.
- [ ] Set `PHASE34` (id `0006_phase34`) SQL body to `""`.
- [ ] Leave migration ids in the list. Do not renumber.
- [ ] Add migration `0021_phase1`.

**`0021_phase1` must do this, in order.**

1. **Guard.** If `SELECT COUNT(*) FROM events` > 0, throw a clear error: `Phase 1 requires a fresh DB. Delete ~/SuperTwinV11/supertwinv11.db and restart.` Fresh installs are the only supported path.
2. Drop `channels`. Create `streams`:

```sql
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  label TEXT,
  stream_kind TEXT NOT NULL,           -- conversation|document|activity|ambient|bounded
  tz TEXT,
  participant_entity_ids TEXT,          -- JSON array
  segmentation_override_json TEXT,
  is_business INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, external_key)
);
```

3. **Rebuild `events`.** Drop `events`, `events_fts`, and its triggers. Recreate `events` with every existing V11 column **plus**: `stream_id`, `actor_entity_id`, `ts_end`, `tz`, `observed_at`, `salience`, `revision_of`. Drop `channel_id` and `actor_id`. Recreate `events_fts` (same 7 columns) and all sync triggers exactly as before.
4. Create the entity tables:

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, subtype TEXT,
  canonical TEXT NOT NULL, provisional INTEGER NOT NULL DEFAULT 1,
  merged_into TEXT, user_pinned INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL);

CREATE TABLE entity_identities (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL, value_norm TEXT NOT NULL,
  confidence REAL NOT NULL, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL,
  UNIQUE(source_id, kind, value_norm));

CREATE TABLE entity_edges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subtype TEXT,
  src_entity_id TEXT NOT NULL, dst_entity_id TEXT NOT NULL,
  confidence REAL NOT NULL, decided_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT, valid_to TEXT, created_at TEXT NOT NULL,
  UNIQUE(kind, subtype, src_entity_id, dst_entity_id));

CREATE TABLE edge_evidence (
  edge_id TEXT NOT NULL, event_id TEXT NOT NULL, quote TEXT,
  PRIMARY KEY(edge_id, event_id));

CREATE TABLE mentions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
  span_start INTEGER, span_end INTEGER, surface_text TEXT NOT NULL,
  entity_id TEXT, new_entity_json TEXT, entity_hint TEXT,
  confidence REAL NOT NULL, decided_by TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE resolution_decisions (
  id TEXT PRIMARY KEY, left_id TEXT NOT NULL, right_id TEXT NOT NULL,
  verdict TEXT NOT NULL, decided_by TEXT NOT NULL, reason TEXT,
  created_at TEXT NOT NULL, UNIQUE(left_id, right_id));

CREATE TABLE entity_embeddings (
  entity_id TEXT PRIMARY KEY, vec BLOB NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL);

CREATE TABLE embedder_calib (
  model TEXT NOT NULL, use_case TEXT NOT NULL, floor REAL NOT NULL,
  measured_at TEXT NOT NULL, n_pairs INTEGER NOT NULL,
  PRIMARY KEY(model, use_case));
```

5. Create sessions + ops tables:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, source_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, tz TEXT,
  event_ids TEXT NOT NULL, participant_entity_ids TEXT,
  boundary_reason_start TEXT, boundary_reason_end TEXT, boundary_params_json TEXT,
  content_hash TEXT, superseded_hash TEXT,
  status TEXT NOT NULL, sealed_at TEXT,
  late_arrival INTEGER NOT NULL DEFAULT 0, overlap_of TEXT);
CREATE INDEX idx_sessions_stream ON sessions(stream_id, started_at);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, input_tokens INTEGER, cache_create INTEGER,
  cache_read INTEGER, output_tokens INTEGER, cost_usd REAL, model TEXT,
  error_code TEXT, error_msg TEXT);

CREATE TABLE quarantine (
  id TEXT PRIMARY KEY, unit_kind TEXT NOT NULL, unit_id TEXT NOT NULL,
  run_id TEXT, error_code TEXT, last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, replayed_at TEXT);

CREATE TABLE mutations (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, run_id TEXT,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, field TEXT,
  old_json TEXT, new_json TEXT, reason TEXT);
CREATE INDEX idx_mutations_run ON mutations(run_id);

CREATE TABLE watermarks (
  stream_id TEXT PRIMARY KEY, live_high_ts TEXT, live_high_external_id TEXT,
  backfill_low_ts TEXT);
```

**Tests.**

- [ ] `worker/src/db/migrations.test.ts` — extend: fresh DB runs 0001→0021 clean.
- [ ] New test: guard throws when `events` has rows.
- [ ] New test: every Phase 1 table exists with expected columns.
- [ ] New test: `events_fts` still syncs on insert/update/delete after the rebuild.

**Acceptance.**

1. Fresh DB migrates with zero errors.
2. FTS search still returns rows after rebuild.
3. `PRAGMA integrity_check` returns `ok`.

---

## W0.3 — Freeze the API contract

**Description.** Write the route contract now so UI tracks can build in parallel.

**Changes.**

- [ ] Create `docs/PHASE1_API_CONTRACT.md`.
- [ ] Define request + response JSON for every route in §I1 below.
- [ ] Create `src/lib/api-types.ts` with the TypeScript types for those responses.
- [ ] Create `src/lib/fixtures/entities.json` and `src/lib/fixtures/sessions.json` with realistic sample payloads.

**Acceptance.**

1. Types compile.
2. Fixtures match the types exactly.
3. Tracks I, J, K can all read this file and agree.

---

## W0.4 — Eval harness skeleton

**Description.** Build the runner now. Waves add fixtures to it.

**Changes.**

- [ ] Create `evals/` at repo root.
- [ ] `evals/runner.ts` — loads `evals/fixtures/*.json`, runs the named unit, compares to expected, prints a per-category table.
- [ ] `evals/schema.ts` — fixture shape:

```ts
{ id: "A-001", category: "A", unit: "session_segmenter",
  input: { /* frozen events, stream config */ },
  expected: { /* labels */ },
  frozen_verdicts?: { /* model outputs, so LLM units run offline */ } }
```

- [ ] Add npm script `"eval": "vitest run --config evals/vitest.config.mjs"`.
- [ ] Add 3 sample fixtures (A-001, A-002, A-003) so the runner is provably working.

**Acceptance.**

1. `npm run eval` runs and reports 3/3.
2. A deliberately wrong expected value makes it fail.

---

# WAVE 1 — Platform (3 tracks in parallel)

## Track A — CLI bare-call contract

**Owns `worker/src/providers/**`.**

### A1 — Probe CLI capabilities

**Description.** Find out what the installed CLI actually supports. Do not assume.

**Changes.**

- [ ] Add `worker/src/providers/claude-local/capabilities.ts`.
- [ ] On first use, run `claude --help` once. Cache the result in `app_state` key `cli.capabilities`.
- [ ] Detect: does `--system-prompt` exist? does `--append-system-prompt` exist? `--model`? `--setting-sources`?

**Technical details.**

1. If `--system-prompt` exists → use it. This is **replace** mode. Preferred.
2. If it does not exist → fallback: `--append-system-prompt` with our prompt prefixed by a hard reset line:
   `"Ignore all prior instructions, personas and formatting rules. Follow only the instructions below."`
3. Record which mode is active in `runs.model` metadata and log it once at boot.
4. Write a short note in `docs/PHASE1_API_CONTRACT.md` stating which mode was found.

**Tests.**

- [ ] Unit test with a stubbed `--help` output for both cases.
- [ ] Test that cached capabilities are reused, not re-probed every call.

**Acceptance.**

1. Boot log states: `[cli] system prompt mode = replace|append-fallback`.
2. Neither mode crashes.

### A2 — `bareCall()` helper

**Description.** One function every LLM call goes through.

**Changes.**

- [ ] Add `worker/src/providers/bare-call.ts`.
- [ ] Signature: `bareCall({ system, user, schema, tier, maxOutputTokens, runKind })`.
- [ ] Always sets: tools denied (`--allowedTools ""` + `--disallowedTools "*"`), `--setting-sources ""`, `MAX_THINKING_TOKENS=0`, single turn.
- [ ] `tier: "small" | "medium"` maps to model ids in `providers/claude-local/models.ts`.
- [ ] Writes a `runs` row per call with 4-way token accounting and cost.

**Technical details.**

1. Reuse V11's existing `plainCompletion` levers. Do not invent new denial flags.
2. Preserve V11's failure taxonomy: `QUOTA_EXCEEDED` → pause + countdown, `AUTH_REQUIRED` → pause + re-probe ladder, `CLI_ERROR` → retry 2s/10s/30s then quarantine.
3. A quota or auth pause must **not** consume the retry budget.

**Tests.**

- [ ] Args snapshot test: exact flag list for small and medium tiers.
- [ ] Test `runs` row written with token fields populated.
- [ ] Test quota pause does not decrement attempts.

**Acceptance.**

1. Every flag in §5.1 of the Phase 1 doc is present on every call.
2. No call inherits user settings or CLAUDE.md.

### A3 — Schema validation + repair retry

**Description.** Model output must be valid JSON matching the caller's schema.

**Changes.**

- [ ] Add `worker/src/providers/schema-guard.ts`.
- [ ] Validate parsed JSON against a lightweight schema (hand-rolled or `zod` if already a dep — do not add heavy deps).
- [ ] On failure: retry **once** with the same call plus `"Return ONLY valid JSON matching the schema. No prose."`.
- [ ] On second failure: write a `quarantine` row and return an error. Never crash the pipeline.

**Tests.**

- [ ] Valid JSON passes.
- [ ] Prose-wrapped JSON triggers exactly one repair.
- [ ] Two failures → quarantine row exists, no throw.

**Acceptance.**

1. A malformed response never stops the pipeline.

### A4 — Tooled mode seam

**Description.** Agents need tools. Nothing else does.

**Changes.**

- [ ] Add `worker/src/providers/tooled-call.ts`.
- [ ] Accepts an explicit tool whitelist and `maxTurns`.
- [ ] Registers a local MCP server named `supertwin-tools` exposing only the listed tools.
- [ ] Enforces wall-clock timeout and total token cap.

**Technical details.**

1. Track H supplies the actual tools. Track A only builds the seam and a no-op test tool.
2. Default remains deny-all. Tooled mode is opt-in per call.

**Tests.**

- [ ] A tooled call with `["ping"]` can call `ping` and nothing else.
- [ ] Exceeding `maxTurns` returns a bounded result, not a hang.

**Acceptance.**

1. Bare calls still have zero tools after this lands.

---

## Track B — Adapter registry + WhatsApp manifest

**Owns `worker/src/adapters/**`, `worker/src/ingest/**`, `worker/src/db/ingest.ts`.**

### B1 — Manifest type + registry

**Changes.**

- [ ] Add `worker/src/adapters/manifest.ts` with the `SourceManifest` type from Phase 1 §2.1.
- [ ] Add `worker/src/adapters/registry.ts`: `register(manifest, adapterFactory)`, `get(source_id)`, `all()`.
- [ ] Validate at registration: unknown `stream_kind` → throw; `ambient` + `prefilter: "none"` → throw; missing `self_identity` → throw; duplicate `source_id` → throw.

**Tests.**

- [ ] Valid manifest registers.
- [ ] Each invalid case throws with a clear message.

**Acceptance.**

1. Registry is the only way a source enters the system.

### B2 — WhatsApp manifest

**Changes.**

- [ ] Add `worker/src/adapters/whatsapp/manifest.ts`.

```ts
{
  source_id: "whatsapp", display_name: "WhatsApp",
  stream_kind_of: () => "conversation",
  actor_model: "multi_actor",
  self_identity: { kind: "jid", value_getter: selfJidFromAppState },
  streams: { key: ev => ev.chatJid, label: ev => ev.chatName ?? ev.chatJid },
  identities_emitted: ["jid", "phone"],
  capabilities: { backfill: true, live: true, media: true,
                  revisions: false, edits: true, deletion: true },
  segmentation: { gap_ms: 6*3600_000, size_cap_events: 40, size_cap_chars: 24000,
                  day_boundary: true, participant_shift: true, debounce_ms: 45*60_000 },
  salience: { prefilter: "none" },
  bridge_keys: ["url", "phone"],
}
```

- [ ] Group streams override `gap_ms` to 4h. Detect group by JID suffix `@g.us`.

**Tests.**

- [ ] 1:1 stream resolves G=6h. Group stream resolves G=4h.
- [ ] `stream_kind_of` always returns `conversation`.

**Acceptance.**

1. Manifest passes registry validation.

### B3 — Rewire ingest to streams

**Changes.**

- [ ] `worker/src/db/ingest.ts`: rename `upsertChannel` → `upsertStream`, write to `streams`, set `stream_kind` from manifest.
- [ ] Replace the hardcoded `wa:` prefix (around line 1990) with `${source_id}:`.
- [ ] Rename `resetWhatsappData(sourceId = "whatsapp")` → `resetSourceData(source_id)`.
- [ ] `worker/src/ingest/index.ts`: replace `app_state` keys `whatsapp.paused` / `whatsapp.self_jid` / `whatsapp.import_done` with `source.whatsapp.*`. Use a helper `sourceKey(source_id, name)`.
- [ ] Write `events.stream_id`, `events.tz` (device tz), `events.observed_at` (ingest time).
- [ ] `worker/src/index.ts`: construct adapters from the registry, not directly.

**Technical details.**

1. `actor_entity_id` stays NULL here. Track D fills it. Keep `actor_raw` populated.
2. Do not change the Go daemon or the adapter's event shape.

**Tests.**

- [ ] Extend `worker/src/db/ingest.test.ts`: events land with `stream_id`, `tz`, `observed_at`.
- [ ] Dedupe on `(source_id, external_id)` still works.
- [ ] Edits, revokes, reactions still apply.
- [ ] No `whatsapp.` app_state key is written.

**Acceptance.**

1. Fresh install ingests a mock WhatsApp backfill end to end.
2. `rg "\"wa:\"|whatsapp\.paused|whatsapp\.self_jid" worker/src` returns nothing.

### B4 — Route rename

**Changes.**

- [ ] `worker/src/server/whatsapp-routes.ts` → `source-routes.ts`.
- [ ] Mount at `/api/sources/:source_id/*`.
- [ ] Keep `/api/whatsapp/*` as a thin alias that forwards to `source_id = "whatsapp"`.
- [ ] Update `src/tabs/WhatsappOnboarding.tsx` and `InboxTab.tsx` to the new paths.

**Tests.**

- [ ] Existing `whatsapp-routes.test.ts` renamed and passing on new paths.
- [ ] Alias path returns identical payload.

**Acceptance.**

1. Onboarding + QR pairing still work in the app.

---

## Track C — Embedder calibration

**Owns `worker/src/retrieval/embedder.ts`, `worker/src/retrieval/calibration.ts`, `worker/src/db/embeddings.ts`.**

### C1 — Measure the floor

**Changes.**

- [ ] Add `worker/src/retrieval/calibration.ts`.
- [ ] `measureFloor(model, useCase, sampleSize = 1000)`: sample random **unrelated** vector pairs from stored embeddings, compute mean cosine, store as `floor`.
- [ ] Persist to `embedder_calib` keyed `(model, use_case)`.
- [ ] Run at boot if a row is missing or the model changed.

**Technical details.**

1. If fewer than 200 vectors exist, skip and mark calibration `pending`. Do not guess a floor.
2. Use cases to register: `entity_name`, `entity_rich_text`.

**Tests.**

- [ ] Synthetic vectors with a known floor produce that floor ±0.02.
- [ ] Fewer than 200 vectors → `pending`, no row written.

**Acceptance.**

1. Measured floor for `multilingual-e5-small` lands in 0.70–0.90.

### C2 — Normalised scoring

**Changes.**

- [ ] Add `calibratedScore(cos, model, useCase)` returning `(cos − floor) / (1 − floor)`, clamped to `[0,1]`.
- [ ] Export per-use-case thresholds from one config object. No module constants scattered in code.
- [ ] **Hard error** if any similarity comparison runs while calibration is `pending`.

**Tests.**

- [ ] Eval fixtures L-006..L-010 (raw cosine → normalised) pass.
- [ ] Calling `calibratedScore` with pending calibration throws.

**Acceptance.**

1. No absolute cosine bar exists anywhere in the codebase. Verify with `rg "0\.8[0-9]" worker/src --type ts`.

### C3 — Rich-text embedding helper

**Changes.**

- [ ] Add `entityRichText(entity)` → `name + aliases + top co-occurring entity names + one representative quote`.
- [ ] Use this for `entity_embeddings`, never the bare name.

**Tests.**

- [ ] Two different people named "Amit" produce clearly different rich texts.
- [ ] Eval L-019 (bare-name comparison forbidden) passes.

**Acceptance.**

1. Bare-name comparison is impossible through the public API.

---

# WAVE 2 — Pipeline (3 tracks in parallel)

## Track D — Entity graph core

**Owns `worker/src/entities/**`.**

### D1 — Entity store

**Changes.**

- [ ] `worker/src/entities/store.ts`: CRUD for `entities`, `entity_identities`, `entity_edges`, `edge_evidence`, `mentions`, `resolution_decisions`.
- [ ] `mintEntityId()` → `ent_` + 12 random hex chars. Never derived from any source value.
- [ ] All writes go through `withMutation(actor, reason, fn)` which appends a `mutations` row.

**Technical details.**

1. Idempotent upserts. Use the `UNIQUE` constraints from W0.2.
2. Reads must follow `merged_into` redirects. Add `resolveEntity(id)` that walks the chain with a depth cap of 10.

**Tests.**

- [ ] Upsert twice → one row.
- [ ] Every write produces a `mutations` row.
- [ ] Redirect chain of length 3 resolves to the final entity.

**Acceptance.**

1. No write path bypasses `mutations`.

### D2 — Type + edge vocabulary

**Changes.**

- [ ] `worker/src/entities/vocab.ts`: the 16 entity types with their subtypes, and the 16 edge kinds with subtypes and direction rules. Export as frozen const objects.
- [ ] Validation helpers: `isValidType`, `isValidEdge(kind, subtype)`.

**Tests.**

- [ ] All 16 types and 16 edge kinds present, matching the Phase 1 doc tables exactly.
- [ ] Unknown type or subtype rejected.

**Acceptance.**

1. Nothing can create an entity outside the closed set.

### D3 — Structural binding

**Changes.**

- [ ] `worker/src/entities/bind.ts`.
- [ ] On each ingested event: normalise the actor identity, look up `entity_identities`, bind `events.actor_entity_id`.
- [ ] No match → mint a `provisional` person entity + its identity, `decided_by: "code"`, confidence 1.0.
- [ ] Normalise: phones to E.164, emails lowercased, JIDs as-is.

**Technical details.**

1. Bind runs **after** ingest writes the event, in the same transaction where possible.
2. Group chats: mint a `group` entity per stream on first sight.

**Tests.**

- [ ] Known JID rebinds, no new entity. (Eval F-001..F-012)
- [ ] New JID mints exactly one provisional entity.
- [ ] Phone from two sources binds to one entity. (Eval F-013..F-028)

**Acceptance.**

1. Every event has `actor_entity_id` or a populated `actor_raw`.

### D4 — The "me" entity

**Changes.**

- [ ] Create the canonical `me` entity at first boot. Store its id in `app_state` key `entity.me`.
- [ ] Bind WhatsApp self-JID to it via the manifest `self_identity`.
- [ ] Compute `events.is_self` from the binding, in code.

**Tests.**

- [ ] Self-JID binds to `me`. (Eval F-093..F-100)
- [ ] `is_self` is never asked of a model.

**Acceptance.**

1. Exactly one `me` entity exists after a fresh install.

### D5 — Metadata edges

**Changes.**

- [ ] `worker/src/entities/metadata-edges.ts`.
- [ ] From WhatsApp group participant lists: create `member_of` edges, `decided_by: "code"`, confidence 1.0.
- [ ] Re-run on participant change. Removed member → set `valid_to`, status `superseded`.

**Tests.**

- [ ] Group with 5 participants creates 5 `member_of` edges. (Eval H-017..H-026)
- [ ] Zero model calls in this path.

**Acceptance.**

1. Metadata edges exist before any LLM has run.

### D6 — Merge, split, tombstones, negative pairs

**Changes.**

- [ ] `mergeEntities(a, b, actor, reason)` → set `merged_into`, log mutation, keep both rows.
- [ ] `splitEntity(id, actor)` → restore two entities, re-point identities by their `source_id`.
- [ ] `recordDecision(left, right, verdict)` → write `resolution_decisions`. A `different` verdict from `user` is permanent.
- [ ] Nightly compaction job that re-points references off tombstones.

**Tests.**

- [ ] Merge then read old id → resolves to survivor. (Eval F-121..F-130)
- [ ] Split restores both. (Eval F-131..F-136)
- [ ] User `different` blocks a later 0.93 auto-merge. (Eval F-111..F-120)

**Acceptance.**

1. `actor: user` decisions are never overridden by automation.

---

## Track E — Sessions engine

**Owns `worker/src/sessions/**`.**

### E1 — Segmenter interface + 5 policies

**Changes.**

- [ ] `worker/src/sessions/types.ts`: `Segmenter` interface, `BoundaryReason` union.
- [ ] `worker/src/sessions/conversation.ts` — **wired for WhatsApp.**
- [ ] `worker/src/sessions/document.ts`, `activity.ts`, `ambient.ts`, `bounded.ts` — implemented, unit-tested with synthetic events, **not wired to any adapter**.
- [ ] `worker/src/sessions/index.ts` — picks the segmenter from `stream_kind`.

**Technical details for `conversation.ts`.**

1. Cut when **any** fires: gap > G, participant shift, reply-chain break, size cap (40 events or 6,000 tokens), local midnight in the **stream's** tz.
2. Participant shift is a **conjunction**: gap ≥ shift-min-gap (1h) **AND** the initiator was silent in the prior burst. Below the min-gap, no cut. (Eval A-081..A-092)
3. Reply-chain break: a reply targeting an event older than G starts a new session. The old session stays sealed.
4. Record `boundary_reason_start`, `boundary_reason_end`, and the measured params in `boundary_params_json`.

**Tests.**

- [ ] Eval fixtures A-001..A-180 all pass.
- [ ] Fixtures B, C, D, E pass against their segmenters using synthetic events.
- [ ] Same input twice → byte-identical session rows.

**Acceptance.**

1. Boundary F1 vs gold ≥ 0.90 for every stream kind.
2. Every sealed session has both boundary reasons populated.

### E2 — Open session + debounce + seal

**Changes.**

- [ ] `worker/src/sessions/engine.ts`.
- [ ] Open a session per stream on first event. Append after.
- [ ] Reset the debounce timer on each **content** event.
- [ ] Seal on: debounce expiry, any §E1 trigger, or the 24h ceiling.
- [ ] On seal: compute `content_hash = sha256(sorted external_ids + text hashes)`, set `status: "sealed"`, make it immutable.

**Technical details.**

1. Open sessions live in the DB with `status: "open"`. No in-memory-only state.
2. On boot, recompute timers from each open session's last event `ts`. Anything past its window seals immediately.
3. Order events by `ts`, never by rowid. Maintain `watermarks` per stream.

**Tests.**

- [ ] Debounce fires at 45m, not at 44m. (Eval A-105..A-111)
- [ ] 24h ceiling seals a trickle chat. (Eval A-112..A-115)
- [ ] Kill the worker mid-session, restart → session seals correctly.

**Acceptance.**

1. No session stays open past 24h.
2. Restart never loses or duplicates a session.

### E3 — Reactions, edits, revokes

**Changes.**

- [ ] Reactions attach to the parent event's session even if sealed. They never open a session and never reset the debounce.
- [ ] Edits inside an open session mutate in place. Edits after seal are stored, attach to the parent session, and set `sessions.superseded_hash`.
- [ ] Revokes mark the event revoked and set `superseded_hash` if the session is sealed. Membership never changes.

**Tests.**

- [ ] Eval A-093..A-104 pass exactly.
- [ ] A sealed session's `event_ids` never changes. Assert with a DB-level check.

**Acceptance.**

1. Sealed session membership is immutable. There is no code path that updates it.

### E4 — Late arrivals and clock skew

**Changes.**

- [ ] An event whose `ts` falls inside a sealed session's range creates a **new** session with `late_arrival = 1` and `overlap_of` set.
- [ ] `ts` more than 5 minutes in the future → clamp to now, record the original in `structured_json`.

**Tests.**

- [ ] Eval A-116..A-123 (late arrival) and A-179..A-180 (skew) pass.

**Acceptance.**

1. Sealed sessions are never reopened.

### E5 — Timezones

**Changes.**

- [ ] Store `tz` per stream. Default to device tz at ingest.
- [ ] Compute the midnight cut in the stream's tz.
- [ ] Allow a per-stream tz override.

**Tests.**

- [ ] Eval A-174..A-178 (tz cases) pass, including the travel case.

**Acceptance.**

1. A 23:50 → 00:10 pair always cuts, in every tz tested.

### E6 — Replay + per-stream overrides

**Changes.**

- [ ] `replayStream(stream_id, params)` → re-segments with candidate params, returns a **diff** (old sessions vs new). Does not write unless `apply: true`.
- [ ] `segmentation_override_json` on `streams` takes precedence over the manifest.

**Tests.**

- [ ] Replaying with G=4h on a fixture produces the expected larger session count.
- [ ] `apply: false` writes nothing.

**Acceptance.**

1. Replay is the only way segmentation params change.

---

## Track F — Salience scaffold + enrichment audit

**Owns `worker/src/salience/**` and a doc file.**

### F1 — Salience schema + stage

**Changes.**

- [ ] `worker/src/salience/index.ts`: `scoreEvent(event, manifest)` → writes `events.salience`.
- [ ] For `prefilter: "none"` (WhatsApp) → salience = 1.0, no work.
- [ ] Implement the stubs for `dedupe` (phash), `vad`, `diff`, `threshold`. Unit-test them with synthetic inputs. **Do not wire any ambient source.**

**Tests.**

- [ ] WhatsApp events get salience 1.0 with zero cost.
- [ ] Eval D-051..D-055 (manifest validation for ambient) pass.

**Acceptance.**

1. The pipeline stage exists and is a no-op for WhatsApp.

### F2 — Enrichment routing audit

**Description.** Prove each enrichment step runs on the right executor. Fix any that is wrong.

**Changes.**

- [ ] Create `docs/ENRICHMENT_ROUTING.md` mapping each step to `CODE | ML | LLM-S`.
- [ ] Verify in code: image/sticker/video-frames → **LLM-S via CLI** (V11 `media/describe.ts`), audio → **ML whisper**, link/yt → **CODE**, embeddings → **ML e5**.
- [ ] If any step calls the wrong executor, fix it.
- [ ] Route `media/describe.ts` through Track A's `bareCall()` with `tier: "small"`.

**Tests.**

- [ ] Eval I-001..I-030 pass — each asserts the executor used.
- [ ] A quiet day with 4 text messages triggers **zero** LLM enrichment calls.

**Acceptance.**

1. No on-device model is asked to caption an image.
2. No LLM is asked to transcribe audio.

### F3 — Enrichment gating

**Changes.**

- [ ] Skip enrichment for events with `salience` below the manifest threshold.
- [ ] For WhatsApp this never triggers. The seam must still exist and be tested.

**Tests.**

- [ ] Synthetic low-salience event is skipped.

**Acceptance.**

1. Gate is present and provably inert for WhatsApp.

---

# WAVE 3 — Intelligence (2 tracks in parallel)

## Track G — Entity pass (P-EP1)

**Owns `worker/src/entities/pass/**`, `worker/src/prompts/entity-pass.ts`.**

### G1 — Prompt module

**Changes.**

- [ ] `worker/src/prompts/entity-pass.ts` — the exact SYSTEM prompt from Phase 1 §10.1. Copy it verbatim. Do not paraphrase.
- [ ] `buildUser({ roster, sessions })` — builds the USER block from the template.
- [ ] Include the one worked example from the doc, inline in the system prompt.
- [ ] Export the output JSON schema for `schema-guard`.

**Tests.**

- [ ] Snapshot test of the rendered system prompt.
- [ ] User block renders roster and numbered events correctly.

**Acceptance.**

1. Prompt text matches the architecture doc exactly.

### G2 — Roster builder

**Changes.**

- [ ] `worker/src/entities/pass/roster.ts`.
- [ ] Roster = session participants **first**, then top-K candidates by embedding similarity to the session text. `K ≤ 40`.
- [ ] Each line: `id · type · canonical · aliases · one-line context`.

**Technical details.**

1. Uses Track C's `calibratedScore`. If calibration is pending, fall back to participants only. Log it.

**Tests.**

- [ ] Participants always appear, even at low similarity.
- [ ] Roster never exceeds 40 entries.

**Acceptance.**

1. The model can only reference ids that are on the roster.

### G3 — Pass runner

**Changes.**

- [ ] `worker/src/entities/pass/run.ts`.
- [ ] Trigger: on session seal. Batch up to 6 sessions or 8k input tokens per call.
- [ ] Each session is a **separate item** in the prompt. Never blend text across sessions.
- [ ] Calls `bareCall({ tier: "small", ... })`.
- [ ] Writes mentions, proposed entities, and proposed edges through Track D's store.
- [ ] Hash gate: skip a session whose `content_hash` already has a completed pass.

**Technical details.**

1. Every edge write requires a verbatim quote and an `event_id`. Reject edges without one — do not "fix" them.
2. Mentions with `entity_id: null` and a hint are written as-is. This is correct behaviour, not an error.

**Tests.**

- [ ] Eval G-001..G-090 (mentions) pass against frozen verdicts.
- [ ] Eval H-001..H-016 and H-027..H-070 (text edges) pass.
- [ ] Batching keeps sessions separate: a fixture with 2 sessions never cross-contaminates.
- [ ] Re-running over the same sealed sessions makes **zero** new calls.

**Acceptance.**

1. Mention linking accuracy ≥ 0.92 on roster cases.
2. Edge precision ≥ 0.90.
3. No edge exists without a quote.

### G4 — Entity creation discipline

**Changes.**

- [ ] Proposed entities pass through a near-duplicate check before commit.
- [ ] Topics need the surface form to appear twice in the session, or to match an existing topic.
- [ ] New entities are `provisional` until a second evidence event or a user touch.
- [ ] Nightly job: archive provisional entities older than 30 days with one evidence event.

**Tests.**

- [ ] One-off noun does not become a topic.
- [ ] A near-duplicate proposal binds to the existing entity, not a new one.

**Acceptance.**

1. Entity count grows sub-linearly with event count on the real corpus.

---

## Track H — Resolution ladder + P-AG1

**Owns `worker/src/entities/resolve/**`, `worker/src/prompts/resolver.ts`, `worker/src/tools/**`.**

### H1 — Candidate generation

**Changes.**

- [ ] `worker/src/entities/resolve/candidates.ts`.
- [ ] Score candidates by: calibrated embedding similarity on rich text, alias overlap, string distance.
- [ ] Return top 5 with scores.

**Tests.**

- [ ] Same-first-name different-people pairs score below the bind bar. (Eval F-045..F-060)

**Acceptance.**

1. Name similarity alone never reaches the bind bar.

### H2 — The ladder

**Changes.**

- [ ] `worker/src/entities/resolve/ladder.ts`.
- [ ] Rungs in order: exact `(source, kind, value)` → cross-source exact phone/email → calibrated ML score ≥ high bar → agent → resolution queue.
- [ ] Every bind records `decided_by` and `confidence`.
- [ ] Check `resolution_decisions` first. A stored `different` blocks the pair forever.

**Tests.**

- [ ] Each rung fires for its fixture and no other.
- [ ] Eval F-101..F-110 (ambiguous → ask) produce a queue row and **no** bind.

**Acceptance.**

1. Zero silent guesses. Assert: every `entity_identities` row has a non-null `decided_by`.

### H3 — P-AG1 resolver agent

**Changes.**

- [ ] `worker/src/prompts/resolver.ts` — the exact SYSTEM prompt from Phase 1 §10.2.
- [ ] `worker/src/tools/entity-tools.ts` — three read-only tools: `search_entities(query, type?)`, `read_entity(id)`, `read_events(event_ids ≤10)`.
- [ ] Call via Track A's `tooled-call.ts`. **Max 3 turns. 60s wall clock. 8k total tokens. No write scope.**
- [ ] Verdict applied by **code**, not by the agent.
- [ ] `unsure` → resolution queue. Never auto-retried.

**Tests.**

- [ ] Agent with a shared-phone fixture returns `same`. (Eval F-085..F-092)
- [ ] Turn cap enforced: a looping stub stops at 3.
- [ ] Tools cannot write. Attempting a write is not possible — assert the tool list.

**Acceptance.**

1. The agent never mutates the DB directly.
2. `unsure` always produces a user question.

### H4 — Resolution queue

**Changes.**

- [ ] `worker/src/entities/resolve/queue.ts`: list open questions, answer, apply.
- [ ] Answering writes `resolution_decisions` with `decided_by: "user"` and applies the merge or the negative pair.

**Tests.**

- [ ] Answering `same` merges and logs a mutation.
- [ ] Answering `different` blocks future auto-merge at 0.93.

**Acceptance.**

1. A user answer is permanent.

---

# WAVE 4 — Surfaces (3 tracks in parallel)

## Track I — API routes

**Owns `worker/src/server/entity-routes.ts`, `session-routes.ts`, and `server/index.ts` mounting.**

### I1 — Routes

Implement exactly what `docs/PHASE1_API_CONTRACT.md` froze in W0.3.

- [ ] `GET  /api/entities?type=&q=&unresolved=`
- [ ] `GET  /api/entities/:id`
- [ ] `GET  /api/entities/:id/edges`
- [ ] `GET  /api/entities/:id/mentions`
- [ ] `POST /api/entities/:id/merge` · `/split` · `/pin` · `/rename`
- [ ] `POST /api/entities/:id/edges/:edgeId/reject`
- [ ] `GET  /api/resolution-queue` · `POST /api/resolution-queue/:id/answer`
- [ ] `GET  /api/sessions?stream=&date=&source=`
- [ ] `GET  /api/sessions/:id`
- [ ] `POST /api/sessions/replay?stream=` (body: params, `apply` flag)
- [ ] `GET  /api/streams/:id/segmentation` · `PUT` same
- [ ] `GET  /api/runs` · `GET /api/quarantine` · `POST /api/quarantine/:id/replay`
- [ ] `POST /api/runs/:id/undo`

**Technical details.**

1. Every mutating route writes a `mutations` row with `actor: "user"`.
2. `/api/runs/:id/undo` reverse-replays that run's mutations in reverse order.

**Tests.**

- [ ] One integration test per route, in `worker/src/server/entity-routes.test.ts` and `session-routes.test.ts`.
- [ ] Responses match `src/lib/api-types.ts` exactly.

**Acceptance.**

1. Every route returns the frozen contract shape.

### I2 — Undo

**Changes.**

- [ ] Implement reverse replay. Skip mutations whose `actor` is `user`.

**Tests.**

- [ ] Undo an entity-pass run → entities and edges from that run are reverted, user merges survive.

**Acceptance.**

1. Undo never reverts a user decision.

### I3 — SSE progress

**Changes.**

- [ ] Extend the existing status SSE with counts: open sessions, sealed today, entities, unresolved queue depth.

**Acceptance.**

1. The UI can show live progress without polling.

---

## Track J — Entities surface

**Owns `src/tabs/EntitiesTab.tsx` + test. Also owns `src/App.tsx`.**

### J1 — Tab shell

**Changes.**

- [ ] Add `"entities"` and `"sessions"` to `TabId` in `src/App.tsx`. Add both icons and both tab entries. **Track K does not edit this file.**
- [ ] Create `src/tabs/EntitiesTab.tsx`.

### J2 — Entity list + detail

**UI/UX.**

```
┌────────────────────────────────────────────────────────────────┐
│ ENTITIES  [person][group][org][place][service][topic] …        │
│ 🔍 search                              ⚠ 12 need resolution    │
├────────────────────────────────────────────────────────────────┤
│ Pranjali Sachdeva                      person · 4 identities   │
│  IDENTITIES                                                    │
│   whatsapp:jid 9177…03   ✓code 1.0                             │
│   phone +9177…03         ✓code 1.0                             │
│  RELATIONS                                                     │
│   [me] ──social_of:friend──▶ Pranjali            0.8 llm       │
│   Pranjali ──member_of──▶ "Ghar+"                ✓code 1.0     │
│  41 sessions · first seen 12 Mar · last seen today             │
│  [ merge ][ split ][ rename ][ pin ][ add relation ]           │
└────────────────────────────────────────────────────────────────┘
```

1. Left: filter chips by type, search box, unresolved count badge.
2. Right: detail pane with Identities, Relations, activity summary.
3. Every identity and edge shows `decided_by` and confidence.
4. Hovering an edge shows its evidence quote.
5. Relations render as a 1-hop list. Clicking an entity navigates to it.

**Tests.**

- [ ] Renders from fixtures without a server.
- [ ] Filter by type works.
- [ ] Merge button calls the right endpoint with the right body.

### J3 — Resolution queue

**UI/UX.**

```
⚠ RESOLUTION QUEUE
 "Papa (new number Jio)" ↔ "Papa"          agent: unsure 0.83
  evidence: same groups (Family), same alias usage
  [ same ] [ different ] [ later ]
```

1. One card per open question. Show the agent's reason and evidence.
2. Three buttons. One tap each.
3. After answering, show what changed: "Merged — 8 items updated".

**Tests.**

- [ ] Answering posts the correct verdict.
- [ ] The card disappears and the badge count drops.

**Acceptance (J).**

1. Works fully against fixtures with the worker stopped.
2. Works against the live worker once Track I lands.

---

## Track K — Sessions surface

**Owns `src/tabs/SessionsTab.tsx` + test. Must NOT edit `src/App.tsx`.**

### K1 — Session list

**UI/UX.**

```
┌────────────────────────────────────────────────────────────────┐
│ SESSIONS  source[all▾] stream[all▾] date[14 Aug▾]  38 sealed   │
├────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Pranjali      09:12–09:41 · 14 events             │
│    START: gap 7h20m > 6h (G=6h)                                │
│    END:   debounce 45m                                         │
│    participants: me, Pranjali      hash 3f9a…                  │
│    [ view events ] [ replay stream ]                           │
├────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Ghar+   20:02–23:58 ✂ day_boundary (Asia/Kolkata) │
└────────────────────────────────────────────────────────────────┘
```

1. Every session shows **both** boundaries with the rule name and the measured value.
2. Filters: source, stream, date.
3. Badge on sessions with `superseded_hash` — "content changed after seal".
4. Badge on `late_arrival` sessions.

### K2 — Event drill-down

1. Expanding a session lists its events in order with speaker, time, text.
2. Media shows its caption. Voice notes show the transcript.
3. Reactions and edits render attached to their parent event.

### K3 — Replay and overrides

**UI/UX.**

```
REPLAY stream "Pranjali" with G=4h → diff: 3 sessions become 5
  [ apply new params ] [ discard ]
```

1. A params form: gap, size cap, debounce.
2. Replay shows a **diff** before anything is written.
3. Apply writes `segmentation_override_json` and re-segments.

**Tests.**

- [ ] Renders from fixtures.
- [ ] Replay shows the diff and does not write until Apply.

**Acceptance (K).**

1. A developer can tune a stream's gap without touching code.

---

# WAVE 5 — Gate

**Agent: 1. Sequential.**

## Z1 — Full eval run

- [ ] Wire every fixture from `SuperTwinV11_GoldenEvals_V1.md` categories **A–I and L** into `evals/fixtures/`.
- [ ] Categories J and K are Phase 2. Skip them.
- [ ] `npm run eval` runs all of them.

**Gate table — all must pass.**

| Metric | Gate |
|---|---|
| Session boundary F1 vs gold (all 5 kinds) | ≥ 0.90 |
| Segmentation determinism | exact match |
| Sessions with both boundary reasons | 100% |
| Entity resolution precision | ≥ 0.98 |
| Entity resolution recall | ≥ 0.90 |
| Identities silently guessed | 0 |
| Mention linking accuracy | ≥ 0.92 |
| Edge precision | ≥ 0.90 |
| Metadata edges captured | 100% |
| Enrichment routed to correct executor | 100% |
| User corrections surviving re-derivation | 100% |

## Z2 — Determinism proof

- [ ] Run the full pipeline twice on the same frozen corpus.
- [ ] Assert: identical session rows, identical hashes, identical entity ids.
- [ ] Assert: the second run makes **zero** LLM calls (hash gate).

## Z3 — Fresh install smoke test

- [ ] Delete the DB. Start the app.
- [ ] Pair WhatsApp using the mock daemon (`SUPERTWIN_WHATSAPP_MOCK=1`).
- [ ] Backfill runs. Sessions appear in the Sessions tab.
- [ ] Entities appear in the Entities tab with identities and `member_of` edges.
- [ ] Answer one resolution question. Confirm it sticks after a restart.

## Z4 — Cleanup

- [ ] `npm test` green: worker + frontend + scripts.
- [ ] `tsc -b` clean both sides.
- [ ] `rg "wa:|whatsapp\.paused|store/store|brain/writers"` returns nothing.
- [ ] Update `README.md` and `BUILD.md` to describe Phase 1.
- [ ] Delete `docs/PHASE34_CONTRACT.md` — it describes a build that no longer exists.

---

## 4. Definition of done

1. All gate metrics in Z1 pass.
2. Determinism proof in Z2 passes.
3. Fresh install smoke test in Z3 passes.
4. Two new tabs work: Entities and Sessions.
5. Zero silent guesses anywhere. Every automated decision has `decided_by` and confidence.
6. No claims, spaces, tasks, episodes or arcs exist in the code.

---

## 5. Out of scope — do not build

1. Episodes, arcs, bridges. These are Phase 2.
2. Calendar or Contacts adapters. The registry seam must exist; the adapters do not.
3. Encryption.
4. Any ambient source wiring.
5. Data migration of any kind.
6. Claims, spaces, tasks, loops.

---

## 6. Quick reference — what each wave unlocks

1. **Wave 0** — the DB has the right shape. Nothing wrong is reachable.
2. **Wave 1** — the model is a bare instrument. Sources are pluggable. Similarity is calibrated.
3. **Wave 2** — events become sessions. Actors become entities. Both without a single LLM call.
4. **Wave 3** — text becomes mentions and relations. Ambiguity becomes questions.
5. **Wave 4** — a human can see and correct everything.
6. **Wave 5** — the numbers prove it works.
