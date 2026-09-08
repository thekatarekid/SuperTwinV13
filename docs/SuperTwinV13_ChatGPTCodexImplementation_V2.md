# SuperTwinV13 ChatGPT OAuth Direct Implementation V2

## 0. Coding Goal

Implement this document end to end. Complete the phases in order, meet every exit criterion, and stop only when the Definition of Done is satisfied or a named gate blocks rollout.

This document supersedes `SuperTwinV13_ChatGPTCodexImplementation_V1.md`. Section 0.1 records what changed and why; Section 0.2 names the rails in this tree that the implementation must not break. Read both before Section 1.

### Implementation Status (2026-09-08)

- **Overall:** In progress; Phase 0a is accepted and durably seeded. Phase 0b's auth-only subgate passed on 2026-09-08; the billable live contract matrix is implemented and remains unexecuted pending explicit account-risk and call-count authorization.
- **Baseline:** implementation commits are recorded in the progress log; application version `13.12.2` (no new app build yet).
- **Tracking:** See `progressV13_V6_ChatGPTProvider.md` for the concise running log.
- **Acceptance method:** The packaged `.app`/`.dmg` is verified with macOS Computer Use. Browser automation is reserved for browser-specific connector flows.

#### Phase and Task Checklist

- [x] **Phase 0a — Decision Gate:** accepted by Aditya Katare; use the Hermes-compatible OAuth pattern and explicitly accept the documented private-backend/account risk; consent copy approved. The three complete records are idempotently seeded into the canonical `decisions` ledger on fresh and upgraded installs without overwriting local amendments.
- [ ] **Phase 0b — Direct Backend Contract:** offline probe scaffold accepted and the auth-only subgate passed. `--live-auth` completed with 9 OAuth requests and 0 model/catalogue, quota, inference, or other requests. The full matrix contains exactly 70 cases, of which 15 invalid shapes reject before fetch, so its ceiling is 55 inference POSTs with no retries. Dedicated-account, ephemeral refresh/rotation/logout, capability, per-case output, cancellation, exact HTTP-accounting, cache, quota and concurrency/resource evidence are implemented offline. The live-contract CLI is runnable only behind dual opt-ins, scratch-home, safe explicit-model, and exact account-fingerprint gates; it remains unexecuted pending explicit account-risk and call-count authorization. Do not use the main account without it.
- [ ] **P1-A — Provider-neutral contract types:** pending Phase 0b exit evidence.
- [ ] **P1-B–P1-E — G1 foundations:** pending P1-A.
- [ ] **P1-F — Provider/model resolver:** pending G1.
- [ ] **P1-G/P1-H — Call-site migration, registry and shutdown:** pending P1-F.
- [ ] **P2-A–P2-E — G4 ChatGPT OAuth modules:** pending Phase 0b fixtures and Phase 1 seams.
- [ ] **P2-F — ChatGPT provider integration:** pending G4.
- [ ] **P3-A–P3-C — Settings API, routes and UI:** pending Phase 2.
- [ ] **P4-A–P4-E — Request/context control:** pending provider integration.
- [ ] **P4b-A–P4b-C — Media enrichment:** pending Phase 0b and provider integration.
- [ ] **Phase 5 — Parallelism, quota and reliability:** pending Phases 4/4b.
- [ ] **P6-A–P6-E — Offline test/security/release gates:** pending feature implementation.
- [ ] **P6-F — Golden runs:** pending offline gates and owner-approved live-call count.
- [ ] **Self-contained macOS release:** version bump, DMG build, Computer Use acceptance, commit and push pending all gates.

#### Baseline Evidence

- [x] Documentation/task-graph audit: all seven requested implementation, product, build, prompt and eval documents read end to end.
- [x] Current implementation audit: code is Claude-only; no V2 ChatGPT provider or provider-aware settings path exists.
- [x] Safe baseline: UI 319/319, build scripts 126/126, worker offline 4,034/4,034 with 2 skipped, worker typecheck and frontend build pass.
- [x] Test-harness correction: ordinary worker/CI/release tests exclude billable Claude suites even when the CLI is installed; a dedicated command requires a second spend opt-in. The mixed server suite retains its 3 offline route tests. Verified by 4,037 worker passes/7 intentional skips, 138 script passes and worker typecheck, with zero live model calls.
- [x] Pre-release artifact verifier: source and lock versions, DMG identity/hash, mounted bundle/runtime/model layout, plist, architecture, deep signature and Gatekeeper posture are checked without launching the app. The existing 13.12.2 artifact passes structural verification and is truthfully classified local-only because it is ad-hoc signed.
- [x] Bundled-executable verifier: every required program must be executable and match the DMG architecture. Focused 12/12 and full 147/147 script checks pass; the existing 13.12.2 artifact is arm64-compatible throughout (with universal `yt-dlp`) and remains local-only.
- [x] Release identity hardening: version bumps now prevalidate and update the application stanza in `Cargo.lock`; release CI checks both lockfiles; duplicate detection covers canonical Tauri and historical phase-prefixed DMG names.
- [x] Phase 0a durable decision seed: exact OAuth identity/endpoints/headers/mechanics, terms risk posture, and approved consumer-data consent are stored as three additive governance rows. Fresh/upgrade/idempotence/amendment-preservation tests pass.
- [x] Latest complete offline worker gate: 335 files passed, 4,064 tests passed, 7 intentionally skipped, zero live-model calls; the 60-second scratch-home boot test closed its port and removed its home.
- [x] Phase 0b probe scaffold: pinned Hermes device endpoints/client ID, honest SuperTwin identity, bounded polling/timeouts, redacted dry-run fixtures, temp-home opt-in, exact endpoint accounting and hard HTTP ceilings. The 70-case/55-POST matrix, bounded SSE parser, dedicated-account rail, model/capability selection, quota health, ephemeral refresh, strict output/tool/usage predicates, and cancellation proof have offline coverage. Live-contract remains fail-closed.
- [x] Phase 0b dedicated-account rail: a separate contract opt-in and predeclared 12-hex account fingerprint are both required; the decoded OAuth account is compared timing-safely before model, quota, or inference traffic. Live-auth reports only the safe fingerprint for a later run.
- [x] Phase 0b ephemeral session proof: one shared refresh, 120-second skew, rotation-before-exposure, one previous recovery pair, one 401 refresh/retry, no-refresh-token fallback, typed stop errors, and logout-to-`AUTH_REQUIRED` are covered without persistence or live calls.
- [x] Phase 0b catalogue/quota rails: only an explicitly selected visible account model is used; absent capabilities stay absent and unsupported probes do not fetch. Start/end quota evidence requires a plan and reset windows and fails on exhaustion, account warnings, CAPTCHA, or restriction signals.
- [x] Phase 0b measurement rails: exact warm-and-measured repeats cover none/implicit/explicit cache modes; absent cache counters never become zero; the 1/4/8/16 ladder records timing, overlap, burst rate, cache counters and periodically sampled RSS/heap/socket peaks. The live numbers remain unclaimed until the guarded run occurs.
- [x] Phase 0b lifecycle rails: the runner reports counts from its single hard-ceiling HTTP wrapper, refuses redirects and unknown endpoints, redacts continuation identifiers, aborts cancellation at the first substantive delta, aborts concurrent peers on failure, and clears the ephemeral session on every post-login exit.
- [x] Phase 0b offline acceptance: 67/67 focused probe tests, worker typecheck, and the full offline worker gate (4,107 passed, 7 intentionally skipped) pass with zero live calls. Independent adversarial review found no remaining commit blocker.
- [ ] Phase 0b live evidence: first device-code attempt reached the owner account-selection screen and was cancelled when unattended; 0 inference calls were made. Exact per-endpoint HTTP accounting is now implemented for the retry.
- [ ] Phase 0b owner login retry (2026-09-08): the 15-minute device window expired without owner approval. Exact actuals were 1 device-code request + 169 pending polls = 170 OAuth HTTP requests; token/model/catalogue/quota/inference requests were all 0. No credentials were persisted and both empty scratch homes were removed. Generate a fresh code only when the owner is ready to complete the page.
- [ ] Phase 0b owner login retry 2 (2026-09-08): a fresh 15-minute window also expired unapproved with the same exact 170 OAuth requests (1 device + 169 pending polls), 0 token/model/catalogue/quota/inference requests, no credentials, and scratch-home cleanup. Phase 1 remains blocked by the live exit gate.
- [x] Phase 0b auth-only subgate (2026-09-08): after discovering and enabling the required account security setting, authentication completed for safe account fingerprint `7d41db9e5a28`. Exact HTTP actuals: 1 device-code request + 7 polls + 1 token exchange = 9 total; model/catalogue, quota, inference, and other requests were all 0. Ephemeral tokens were redacted, never persisted, and cleared after the run.
- [ ] Phase 0b live contract: still pending. The auth-only pass does not authorize model traffic or prove the 70-case backend contract. Do not run it against the main account without explicit acceptance of the account risk and authorization of the exact live-call budget.
- [x] Phase 1 preparation audit: P1-A's exact type/compatibility seam and G1's gate/classification ownership/tests are mapped. The shared gate requires a split budget precheck/admission seam, per-physical-attempt accounting, provider-tagged call buckets, unknown-cost preservation, and exhaustive typed failure normalization; no Phase 1 source was changed before Phase 0b exit.
- [x] Release-workflow artifact gate: macOS CI mounts and verifies the just-built DMG before any upload. Pending manifest rows require the independently computed build SHA; completed manifest rows cannot be overridden.

### 0.1 What Changed From V1, and Why

V1's outbound wire contract (its §4) was sound and is carried forward almost unchanged. Everything describing how the provider joins **this** codebase was rewritten, because V1 modelled SuperTwin as a provider registry plus a list of call sites, and this tree has four load-bearing mechanisms V1 never names.

| # | V1 said | Reality in this tree | V2 does |
|---|---|---|---|
| 1 | New provider module under `providers/chatgpt-oauth/` | `admitCall` / `recordCallCost` are imported in exactly one file — `providers/claude-local/index.ts:99`. `providers/budget.ts:8` states the invariant: "there is no path to a `claude` child that does not pass through it." A second provider bypasses the hard spend/call ceiling, the `model_activity_paused` kill switch, and `assertTraceContext` | §8: extract the gate into `providers/gate.ts`, make it the only send path, and prove it with a fake-provider test |
| 2 | "Kill switch" (4 uses, all meaning the feature flag) | The real kill switch is `app_state.model_activity_paused` (budget.ts:57, SPD-03). V1 never mentions it | §8.4 treats them as two separate switches with separate semantics |
| 3 | New error codes `AUTH_REQUIRED`, `AUTH_EXPIRED`, `BACKEND_UNSUPPORTED`, `RATE_LIMITED`, `TRANSPORT_ERROR` | `ProviderErrorCode` (types.ts:54) has nine members and none of these. `pool.ts:258` says so explicitly: "there is NO AUTH_REQUIRED code." `isRefusal` (pool.ts:346) matches `QUOTA_EXCEEDED` or `REFUSAL_RE` against the message — an `AUTH_REQUIRED` carrying "Sign in to ChatGPT" matches neither, so it reads as an ordinary failure: retry ladder, quarantine, and at ten in a row the S0.7 breaker. That is the 13.11.5 spin defect reproduced in a new provider | §7: every new code gets an explicit hold / refusal / retry / quarantine disposition and a test |
| 4 | `<step>` "covers every row in `INTELLIGENCE_STEPS`" — 11 keys | There is a **second** model-selection namespace sharing the same `selected_model_*` app_state prefix: `MODEL_KEY_BY_ROLE` (db/settings.ts:31) with ten roles, overlapping the step list only on `chat` and `extract`. `MODEL_DEFAULT_BY_ROLE` (db/settings.ts:50) hardcodes `claude-sonnet-5` and `claude-haiku-4-5-20251001` for eight of them. `getSelectedModel("classify")` runs from four production sites and has no `INTELLIGENCE_STEPS` row at all | §9.2 enumerates all 21 keys and decides roles-vs-steps explicitly |
| 5 | `media/describe.ts` is a call site to route through the resolver | It is not a routing change. `describe.ts:5`: "The way to make the model look at a file is to spawn the CLI with the Read tool whitelisted and put the absolute path in the prompt." `MEDIA_ALLOWED_TOOLS = ["Read"]`, up to 32 images per call, `#01…#32` marker protocol. The ChatGPT provider forbids built-in tools and local paths | §11.7: media enrichment is its own phase with its own design, not a migration |
| 6 | `ProviderRequest` replaces `SendOptions` | Seven load-bearing fields have no equivalent (`maxBudgetUsd`, `plainCompletion`, `skipUserSettings`, `cwd`, `sessionId`/`persistSession`, typed `thinkingBudget`), and `ProviderResult` is never defined. Meanwhile `store: false` — an OpenAI-only constant — sits inside the neutral type | §6 is rewritten field-by-field from `SendOptions`, with a disposition for each |
| 7 | Predecessor doc assumed Codex App Server's managed login, "not a custom OAuth client and not an undocumented ChatGPT API" | V1 does exactly both, with no recorded rationale | §2 makes it an explicit, written decision gate that blocks Phase 0b |
| 8 | Start at 16 concurrent, experimental ceiling 64 | `RESOURCE_LIMITS.llm = { default: 8, max: 16 }` (pool.ts:87). `LIVE_RESERVED_SLOTS = 1` and `ENRICHMENT_SHARE = 0.4` are tuned against a pool of 8–16; at 64 the live reservation is 1.5% of capacity | §10: same pool, same limits, and a re-derivation of the lane math is a precondition for raising them |
| 9 | Keychain storage, tokens never in SQLite | Correct, and insufficient. Keychain is not home-scoped, but CLAUDE.md rule 1 and `evals/home.ts:129` (`establishEvalHome`) isolate every dev and eval run by `SUPERTWIN_HOME`. A scratch-home worker would share one rotating refresh token with the user's real session — the hazard V1 §5.4 correctly identifies for `~/.codex/auth.json` and then rebuilds internally | §5.3: Keychain account namespaced by home |
| 10 | Data retention not discussed | §3 "Context Control" is 25 lines about hidden *instructions* and silent on retention. The payload here is WhatsApp messages, browser text and screen capture | §2.3 makes the data posture a written decision with user-facing consent copy |

### 0.2 Rails This Must Not Break

Every one of these is load-bearing today. A change that silently steps around one is a defect even if every test passes.

| Rail | File | What it guarantees | Required change |
|---|---|---|---|
| Hard spend/call ceiling | `worker/src/providers/budget.ts` | $3/h, $15/day, 400 calls/h, 3,000 calls/day; throws before spawn; latches `app_state.budget_tripped_at`; never auto-resumes | Move the gate above the provider (§8) |
| Kill switch | `budget.ts` `model_activity_paused` | A human's "stop all model activity". Nothing is exempt | Checked at the shared gate, first (§8.4) |
| Background hold | `budget.ts` `backgroundModelHold()` | Lanes stand down instead of dead-lettering work | Provider-unavailable states join it (§7) |
| Failure classification | `pool.ts` `classifyFailure` / `isHardStop` / `isRefusal` | A refusal is an outage, not the unit's fault; a hard stop is neither | Extend for the new codes (§7) |
| Ghost-call guard | `traces/context.ts` `assertTraceContext` | No provider call without a trace context | Moves to the shared gate (§8.1) |
| Crash kill | `worker/src/index.ts:92` `installCrashKill(() => claudeLocalProvider.killAll())` | Unhandled rejection kills in-flight model work | `killAll()` joins the `Provider` interface; fan out over `registry.list()` (§6.3) |
| Home isolation | `home-guard.ts`, `evals/home.ts`, CLAUDE.md §1.3 | A dev or eval worker never touches the real home | Extended to Keychain (§5.3) |
| Golden gate | `settings/golden-gate.ts`, `settings/overrides.ts` | A model/reasoning change runs the golden set first | `StepOverrides` gains a provider dimension (§9.5) |
| Prompt stability | `brain/llm.ts` `stableSystemPrompt` | A prefix that changes byte-for-byte between calls is a cache miss plus a write premium | `instructions` must be byte-stable per pass (§4.2) |

## 1. Goals and Non-Goals

### 1.1 Goals

1. Keep `claude-local` as a permanent product feature for users with a Claude subscription.
2. Add one new provider, `chatgpt-oauth`, for users with a ChatGPT subscription.
3. Let the user choose between them in Settings, per install, with per-provider model and reasoning memory.
4. Every existing safety rail applies to the new provider without exception.

### 1.2 Non-Goals

1. No Codex CLI adapter.
2. No OpenAI API key: no input, no storage, no fallback.
3. No remote workers, no shared credential homes, no multi-account support in V2.
4. No change to Claude's behaviour beyond the shared contract and gate refactors named here.

## 2. Decision Gate (Phase 0a — blocks all implementation)

V1 began with a live probe. V2 begins with three written decisions, because two of them can make the probe itself the wrong act. Each produces a decision row (`db/decisions.ts`) and a section in this document's appendix. **No code in Phase 0b or later starts until all three are recorded.**

### 2.1 Client Identity

The direct backend is not a public API. Reaching it requires an OAuth client and request headers. The implementation must name its exact identity pattern. Known choices include:

1. **Present SuperTwin's own client identity.** Honest, and likely rejected by the backend.
2. **Present Codex's client_id and user agent.** Works, and is a misrepresentation of the client to the service.
3. **Use the Hermes pattern:** reuse the Codex OAuth client ID while truthfully identifying the third-party client through its own user agent and `originator` header. This remains an undocumented/private integration and requires explicit risk acceptance.

V1 §4.7 allowed "user agent" in the header allowlist and never named a value, which left this decision implicit in the code. Record the choice, the header values, and who accepted the risk. If the answer is (2) or (3), record explicitly that every user's ChatGPT account is the collateral and that the feature ships flagged off by default.

### 2.2 Terms of Service

Record a written position on whether driving a ChatGPT subscription from a non-Codex client, at 8+ concurrent streams, for continuous background processing, is permitted. Name the clause relied on or the risk accepted. A "distribution review" deferred to Phase 6 (V1 §9.7.6) arrives after the code is written, which is when a review can no longer say no.

### 2.3 Data Posture

SuperTwin's payload is the user's WhatsApp messages, browser text and screen capture. Consumer ChatGPT subscription traffic is governed by consumer data terms, not API terms. `store: false` on a private backend is a request, not a guarantee, and V2 does not claim otherwise.

Record: what the retention posture actually is, whether it differs from the Claude subscription path, and the exact user-facing consent copy shown at sign-in. This copy is a Phase 3 deliverable, not a Phase 6 one.

### 2.4 Exit Criterion

Three decision rows exist, each naming the decision, the rationale, the residual risk, and the accepting owner. If any is "unresolved", the build stops here and `claude-local` continues to ship alone.

## 3. Architecture

1. Authenticate with ChatGPT OAuth and send streamed HTTP requests to the ChatGPT Codex backend.
2. Run the HTTP client inside the existing SuperTwin worker. No CLI or agent process per request.
3. Both providers send through **one** gate (§8) that carries the trace assertion, the kill switch, the budget ceiling and the cost record.
4. Keep the ChatGPT transport small and versioned; the backend is not a public API contract.
5. Ship behind `ai.chatgpt.enabled`, default `0`, until §2, security, and concurrency gates pass.

```text
                         LOGIN AND TOKEN PATH

                 login/status                         browser/device
+-------------+ <-------------> +------------------+ <----------------> +---------------+
| Settings UI |                 | OAuth Controller |        flow        | ChatGPT OAuth |
+-------------+                 +---------+--------+                    +---------------+
                                          |
                                          | store and rotate tokens
                                          v
                                  +-------+---------------+
                                  | macOS Keychain        |
                                  | account namespaced by |
                                  | SUPERTWIN_HOME (§5.3) |
                                  +-----------------------+

                              MODEL REQUEST PATH

+--------------------+  resolve provider, model,   +-------------------+
| SuperTwin callers  | --------------------------> | Selection resolver |
| chat/pipeline/media|  reasoning as one snapshot  | §9.4               |
+--------------------+                             +---------+---------+
                                                              |
                                                              v
                                            +-----------------+------------------+
                                            | providers/gate.ts  (§8)            |
                                            |  1. assertTraceContext             |
                                            |  2. model_activity_paused          |
                                            |  3. admitCall / budget ceiling     |
                                            |  4. provider quota ceiling (§8.3)  |
                                            |  ... send ...                      |
                                            |  5. recordCallCost + noteSpend     |
                                            |  6. recordProviderInvocation       |
                                            +-----------------+------------------+
                                                              |
                                       +----------------------+----------------------+
                                       |                                             |
                                       v                                             v
                           +------------------------+                  +------------------------------+
                           | claude-local provider  |                  | chatgpt-oauth provider       |
                           | existing CLI adapter   |                  | + strict request allowlist   |
                           +------------------------+                  | + OAuth token manager        |
                                                                       +---------------+--------------+
                                                                                       |
                                                                                       | streamed HTTP
                                                                                       v
                                                                       +---------------+--------------+
                                                                       | ChatGPT Codex backend        |
                                                                       +---------------+--------------+
                                                                                       |
                                                                                       | SSE events
                                                                                       v
                                                                       +---------------+--------------+
                                                                       | Bounded SSE parser           |
                                                                       +---------------+--------------+
                                                                                       |
                                                                                       v
                                            +------------------------------------------+------------+
                                            | ProviderStreamEvent -> callers, pool classifier (§7)   |
                                            +--------------------------------------------------------+
```

The gate is the architectural change V1 missed. Everything else follows from it.

### 3.1 Provider and Model Selection

1. Add a provider dropdown at the top of **Settings > Intelligence**, with exactly two choices: `Claude — Claude subscription` (`claude-local`) and `ChatGPT — ChatGPT subscription` (`chatgpt-oauth`).
2. Save the active provider. New calls use it; calls already running finish on the provider/model snapshot they started with (§9.4).
3. After a provider is selected, every model picker for every LLM or agent step shows only that provider's models.
4. Keep model and reasoning choices separately per provider and per key. Switching back restores that provider's earlier choices.
5. If ChatGPT is selected but not signed in, show **Sign in to ChatGPT**, disable its model pickers, and return `AUTH_REQUIRED` for model calls. Never fall back to Claude or an API key.
6. If discovery fails, show the last successful catalogue as cached. With no cache, disable the pickers, show the error, and offer **Retry**.
7. Validate the selected model on the worker against the active provider's catalogue. The UI value is never trusted alone.
8. The reasoning picker for a key contains only the values that key's selected model supports. Clear an incompatible stored value when the model changes.
9. Persist the provider selection immediately and record a settings decision. Mark the full golden set due when the provider first becomes runnable (§9.5).

## 4. Context Control

### 4.1 Honest Boundary

1. SuperTwin controls the application-level instructions, input, tools, history, cache hints, and agent loop that it sends.
2. SuperTwin cannot prove or remove OpenAI's hidden platform instructions, safety rules, routing data, or internal tokens.
3. SuperTwin cannot enforce data retention on a private backend; §2.3 records what is actually true.
4. The target is therefore **zero unwanted SuperTwin, Hermes, CLI, workspace, skill, or tool context** — not zero provider-side hidden context, and not a retention guarantee.

### 4.2 System Instructions

1. Send SuperTwin's system prompt exactly once through `instructions`.
2. Allow `instructions: ""` when the caller wants a blank application prompt.
3. Never add an adapter identity, default assistant prompt, preamble, or duplicated instructions.
4. Do not copy Hermes's fallback from an empty prompt to `DEFAULT_AGENT_IDENTITY`.
5. Keep each pipeline prompt byte-stable per pass. `brain/llm.ts` `stableSystemPrompt` already throws when a second caller renders a different block for the same pass; the ChatGPT path must route `instructions` through the same invariant, because a prefix that changes byte-for-byte is a cache miss plus a write premium.

### 4.3 Tools and Agent Turns

1. Omit `tools` when a call needs none.
2. When tools are needed, send only the exact SuperTwin tool schemas supplied by the caller.
3. Reject tool calls that do not match the supplied name and argument schema.
4. Treat one direct model response as one model turn.
5. For tool use, SuperTwin owns the loop: validate the call, run the tool, return its result, stop at `maxAgentTurns`, and surface `MAX_TURNS` — which `pool.ts` `isSoftStop` already treats as a soft stop that must not trigger a blind full-context re-issue.
6. Do not enable automatic sub-agents, planning turns, retries, or continuations unless SuperTwin explicitly requests them.

### 4.4 History

1. Pipeline calls are stateless by default: `store: false`, no previous response ID, no inherited messages.
2. Enable history only for interactive chat or a caller that explicitly requests it.
3. Keep independent work units independent so they run and retry in parallel.

## 5. Request Contract, OAuth and Transport

### 5.1 Complete V2 Outbound Allowlist

Unchanged from V1 §4 except where marked. SuperTwin rejects unknown fields instead of forwarding them. Phase 0b verifies each enabled field with live probes.

| Field | Accepted value | Default | Rule |
|---|---|---|---|
| `model` | Non-empty model ID from the authenticated account's discovered list | Required | Reject unknown or unavailable |
| `instructions` | Any UTF-8 string, including `""` | `""` | Send exactly once; never add a fallback |
| `input` | Non-empty array of the V2 input items | Required | Preserve order; add no wrappers |
| `tools` | Omitted, or an array of V2 function definitions | Omitted | Omit completely when empty |
| `tool_choice` | `"none"`, `"auto"`, `"required"` | Omitted without tools; `"auto"` with | `"required"` valid only with tools |
| `parallel_tool_calls` | `true` or `false` | Omitted without tools; `false` with | Never send without tools |
| `reasoning` | Omitted, or `{ "effort": value }` | Omitted | Model-dependent; §5.2 |
| `text` | Plain-text or strict JSON-schema config | Plain text | `verbosity` only when the catalogue says the model supports it (**changed**, §9.1) |
| `max_output_tokens` | Positive integer ≤ the catalogue's `maxOutputTokens` for that model | Role-specific limit | Includes visible output and reasoning tokens (**changed**: bound is catalogue-derived, not a config constant) |
| `previous_response_id` | Omitted, or a validated opaque response ID | Omitted | Interactive history only; never for pipeline calls |
| `prompt_cache_key` | Omitted, or a stable 1–64 char SuperTwin string | See cache mode | Never user content, email, or tokens |
| `prompt_cache_options` | Omitted, or the verified cache object | Omitted | Only when the selected model supports it |
| `store` | `false` only | `false` | V2 must not permit `true` |
| `stream` | `true` only | `true` | Required for incremental parsing and cancellation |

Minimum blank-context request:

```json
{
  "model": "<selected-model>",
  "instructions": "",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "<SuperTwin input>" }]
    }
  ],
  "max_output_tokens": 4096,
  "store": false,
  "stream": true
}
```

Accepted input items, tool definitions and text output values are V1 §4.1, §4.2 and §4.4 verbatim, with one change: `verbosity` is sent only when `ProviderModel.supportsVerbosity` is true.

### 5.2 Reasoning Values

1. Accepted outbound effort values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
2. The provider discovers the selected model's supported values and rejects unsupported choices before sending.
3. Mapping to SuperTwin's `ThinkingBudget` union (`off | low | medium | high | xhigh | max`) is explicit and total:

| SuperTwin | ChatGPT outbound |
|---|---|
| `off` | `none` when supported, else omit `reasoning` |
| `low` / `medium` / `high` / `xhigh` | same name when the catalogue lists it, else omit |
| `max` | **no equivalent** — clamp to the model's highest supported value and record the clamp in the trace |

`brain/reasoning.ts` `reasoningForPass` currently calls `discoverClaudeModels()` directly and drops a level the model does not offer. V2 keeps that behaviour and makes the catalogue read provider-aware (§11.4, task P1-E).

### 5.3 OAuth, Keychain and Transport

1. Create `worker/src/providers/chatgpt-oauth/` with modules for login, Keychain storage, refresh, model discovery, request building, SSE parsing, usage, and the provider interface.
2. Implement the pinned Hermes device-code flow: request a user code, open or link to the browser verification page, poll the correlated device authorization, and exchange its authorization code plus returned verifier. Show progress, plan type, quota state, expiry, and sign-out. Do not add a loopback listener, a separate `/authorize` request, or an invented `scope`; none is part of the selected contract.
3. **The Keychain account name is namespaced by home.** Derive it as `supertwin.chatgpt-oauth.<sha256(resolved SUPERTWIN_HOME)[0..15]>`. Keychain is not home-scoped, but every dev worker (CLAUDE.md §1.3.1) and every eval run (`evals/home.ts` `establishEvalHome`) is. Without namespacing, a scratch-home worker or a golden eval shares one **rotating** refresh token with the user's real session, and one refresh in the scratch process signs the user out of the app. Document the chosen access method (`security` CLI shellout vs. native module) and what happens to the Keychain ACL when Tauri re-signs the binary on update.
4. Give SuperTwin its own OAuth session. Do not share or copy `~/.codex/auth.json`.
5. **Refresh-token rotation protocol.** One process-wide refresh promise is necessary and not sufficient — rotation kills the old token when the new one is issued, and a crash between "server rotated" and "we persisted" locks the user out permanently. Required: persist the new pair **before** the first request uses it; keep the previous pair for one rotation as a recovery candidate; on `401` refresh once, retry the original request once; on a refresh that fails with a rotation-shaped error, surface `AUTH_EXPIRED` (a hold, §7) and require re-login rather than retrying.
6. Never accept an API key. OAuth failure returns `AUTH_REQUIRED`; it must not fall back to another OpenAI authentication method.
7. Reuse HTTP connections and parse SSE incrementally. Bound request, response, line, error and trace buffers.
8. Map streamed messages, tool calls, usage, completion, refusal, cancellation and errors into `ProviderStreamEvent`.
9. **Backend compatibility is a canary, not a constant.** V1's `DIRECT_BACKEND_VERSION` presumes the backend advertises compatibility; it does not. The realistic failure is an opaque 400, or silently renamed SSE event names that parse to nothing. Required instead: a cheap canary request (blank instructions, 1 input item, `max_output_tokens: 16`) on worker boot when ChatGPT is active and again on the first unexplained parse failure; a named re-check cadence; and a defined degraded state that returns `BACKEND_UNSUPPORTED` — which §7 classifies as a hold, because no wait clears it.

### 5.4 HTTP Headers

1. Allow only the OAuth bearer token, ChatGPT account ID, content type, accepted stream type, user agent, and required request/session identifier headers. **The user-agent and client-id values are fixed by the §2.1 decision and are not an implementation choice.**
2. Use a new request/session identifier for stateless calls. Reuse one only for explicit interactive continuity.
3. Record a redacted outbound-body and header snapshot in development tests. Never record access tokens, refresh tokens, or raw account IDs.

## 6. The Provider-Neutral Contract

### 6.1 ProviderRequest

Derived field-by-field from the existing `SendOptions` (`providers/types.ts:86`). Every dropped field has a disposition; nothing is lost by omission.

```ts
interface ProviderRequest {
  runId: string;
  model: string;
  /** The application system prompt. "" is valid and stays "". */
  instructions: string;
  input: ProviderInputItem[];

  /** Function-tool schemas the caller supplies. */
  tools?: ProviderTool[];
  /**
   * Built-in host tools by NAME (Claude CLI --allowedTools). Distinct from
   * `tools`: `["Read"]` is not a JSON-Schema function. A provider that cannot
   * offer a named host tool rejects the request with CAPABILITY_UNSUPPORTED
   * rather than silently dropping it — this is what media enrichment needs
   * (§11.7), and V1 had no way to express it.
   */
  hostTools?: string[];
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;

  /** Closed union, not a free string. Maps per §5.2. */
  reasoning?: { budget: ThinkingBudget; effort?: Exclude<ThinkingBudget, "off"> };
  text?: ProviderTextOutput;
  cache?: { mode: "none" | "implicit" | "explicit"; key?: string; ttl?: "30m" };

  /** Provider-neutral continuation. Claude maps to a session id + resume;
   *  ChatGPT maps to previous_response_id. Opaque to callers. */
  continuation?: { token: string };
  /** Claude: --no-session-persistence when false. ChatGPT: ignored. */
  persistContinuation?: boolean;

  /**
   * Bounded, tool-free, short-turn completion (the extraction stages).
   * Claude: --max-turns 2, hard tool denial, --setting-sources "",
   * MAX_THINKING_TOKENS=0. ChatGPT: no tools, maxAgentTurns 1, reasoning off.
   * NOT droppable — losing it re-loads the user's CLAUDE.md on every call,
   * a regression this build already paid for once (~6,158 tokens/call).
   */
  plainCompletion?: boolean;
  /** Claude: --setting-sources "" without the rest of plainCompletion.
   *  ChatGPT: no-op (there is no ambient settings source). */
  skipHostSettings?: boolean;
  /** Working directory for host-tool access. Claude: safeCwd. ChatGPT: unused. */
  cwd?: string;

  maxOutputTokens: number;
  maxAgentTurns: number;
  /** Per-call spend ceiling. Claude: --max-budget-usd. ChatGPT: informational,
   *  but still recorded so the gate's ledger is provider-uniform (§8). */
  maxBudgetUsd?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ProviderStreamEvent) => void;
}
```

1. `store` is **not** on this type. It is an OpenAI wire constant pinned by §5.1 and belongs in the ChatGPT request builder, not in a neutral contract.
2. `instructions: ""`, no `tools`, `cache.mode: "none"`, no `continuation`, and `maxAgentTurns: 1` are valid and must remain blank and minimal through the ChatGPT adapter.
3. The Claude mapper converts this request to existing stdin, system-prompt file, CLI flags, tool allow/deny list, session and thinking settings.
4. The ChatGPT mapper produces only the §5.1 allowlist.
5. SuperTwin owns any tool loop. A provider performs one response at a time and never invents extra agent turns.

### 6.2 ProviderResult and Stream Events

V1 defined a request and never a result. Both halves change together.

```ts
interface ProviderResult {
  /** Opaque continuation token, or null when the provider has none.
   *  Replaces the mandatory `sessionId: string` — a stateless ChatGPT call
   *  must not have to synthesize a fake one. */
  continuation: string | null;
  usage: Usage;
  /** Claude: a poisoned resume transparently fell back to fresh. */
  freshFallback: boolean;
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
}
```

1. `ProviderStreamEvent`'s `{ type: "session"; sessionId }` becomes `{ type: "continuation"; token }`, and `done` carries `continuation: string | null`. Keep a deprecated alias for one release so existing consumers compile.
2. `Usage`'s Claude-specific TTL split (`cacheCreation5mInputTokens` / `cacheCreation1hInputTokens`) stays optional and absent for ChatGPT. Absent is not zero — `usage.ts` `sumUsage` already enforces that, and §8.3 depends on it.
3. Add `Usage.cachedInputTokens?: number` for the ChatGPT cache-read field. Do not overload `cacheReadInputTokens`, which `billableTokens` prices at Claude's 10% ratio.

### 6.3 Provider Interface and Registry

```ts
interface Provider {
  id: "claude-local" | "chatgpt-oauth";
  displayName: string;
  capabilities: ProviderCapabilities;
  authState(): ProviderAuthState;
  catalogue(): ProviderModelCatalogue;
  send(req: ProviderRequest): Promise<ProviderResult>;
  cancel(runId: string): boolean;
  /** Cancel everything in flight. Required, not optional: worker/src/index.ts:92
   *  currently hardcodes claudeLocalProvider.killAll() into installCrashKill. */
  killAll(): void;
}
```

1. `worker/src/index.ts:92` and `:347` fan out over `registry.list()` instead of naming `claudeLocalProvider`.
2. `worker/src/server/index.ts:387` resolves the provider per request (§9.4) instead of capturing `DEFAULT_PROVIDER_ID` at boot.
3. `registry.get(id)` returning `undefined` is a **defined state**, not an assertion failure — see §7's `PROVIDER_UNAVAILABLE`.

## 7. Failure Classification

The single most dangerous omission in V1. Every code below gets a row; a code without a row is a build error in `classifyFailure`'s exhaustive switch.

### 7.1 Extended Error Codes

Added to `ProviderErrorCode` (`providers/types.ts:54`) in Phase 1, before any ChatGPT code exists:

`AUTH_REQUIRED`, `AUTH_EXPIRED`, `PROVIDER_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `BACKEND_UNSUPPORTED`, `RATE_LIMITED`, `TRANSPORT_ERROR`.

### 7.2 Disposition Table

| Code | Meaning | `classifyFailure` action | Rationale |
|---|---|---|---|
| `AUTH_REQUIRED` | Not signed in | **hold** | Only a human clears it. A retry ladder here quarantines good units and trips the S0.7 breaker |
| `AUTH_EXPIRED` | Refresh failed or rotation lost | **hold** | Same; re-login required |
| `PROVIDER_UNAVAILABLE` | Selected provider not registered (flag off) | **hold** | The state V1 created in §9.3.5 and never defined |
| `BACKEND_UNSUPPORTED` | Canary says the backend changed | **hold** | No wait clears it |
| `MODEL_UNAVAILABLE` | Saved model not in the live catalogue | **quarantine**, no retry budget | The unit is fine; the setting is stale. Settings must show it (§9.2.5) |
| `CAPABILITY_UNSUPPORTED` | e.g. `hostTools` on ChatGPT | **quarantine**, no retry budget | A programming error, surfaced not retried |
| `RATE_LIMITED` | 429 / retry-after | **refusal** (backoff ladder) | Outage-shaped, exactly like `QUOTA_EXCEEDED` |
| `QUOTA_EXCEEDED` | Plan quota exhausted | **refusal** (unchanged) | — |
| `TRANSPORT_ERROR` | Socket, DNS, TLS, truncated stream | **retry** (2s/10s/30s ladder) | Genuinely transient |
| `BUDGET_EXCEEDED`, `MODEL_ACTIVITY_PAUSED` | Unchanged | **hold** (unchanged) | — |
| `MAX_TURNS` | Unchanged | **soft stop** (unchanged) | — |
| `CANCELLED` | Unchanged | **cancelled** (unchanged) | — |

### 7.3 Required Edits

1. `pool.ts` `isHardStop` gains `AUTH_REQUIRED`, `AUTH_EXPIRED`, `PROVIDER_UNAVAILABLE`, `BACKEND_UNSUPPORTED`.
2. `pool.ts` `isRefusal` gains `RATE_LIMITED` **by code**. Do not rely on `REFUSAL_RE` matching a message — the regex exists because the CLI gives no codes, and a new provider that does must not be classified by string.
3. Update the comment at `pool.ts:257` ("there is NO AUTH_REQUIRED code"), which becomes false.
4. `classifyFailure` gets an exhaustive switch on the code, with the message regex as a fallback for `CLI_ERROR` only.
5. The lane entry gates (`scheduler/v6/dispatch.ts`, `media/queue.ts`, `executor/queue-job.ts`) already ask `backgroundModelHold()` before building work. Extend that hold to include "the active provider is not runnable", so a signed-out ChatGPT stands lanes down the way a switched-off step does (`settings/steps.ts`) rather than letting them discover it one dead-lettered unit at a time.
6. One test per row in §7.2, asserting the action.

## 8. The Shared Gate: Trace, Kill Switch, Budget and Quota

### 8.1 Extraction

Today `claude-local/index.ts:181-260` performs, inside `tracedRunOnce`: `assertTraceContext` → `admitCall()` (kill switch first, then ceilings) → `noteRefusal` on throw → run → `recordCallCost` → `noteSpend` → `recordProviderInvocation`. `budget.ts:8` states plainly that this is the only path to a child process.

Move that whole sequence into `worker/src/providers/gate.ts`, exposing one function that wraps any provider's `send`. `claude-local` keeps its per-attempt semantics (the poison-fallback second spawn pays a second admit); the gate takes an "attempts" callback rather than assuming one attempt per send.

**Exit criterion, Phase 1:** a test registers a fake provider that records whether it was called, sets `model_activity_paused`, calls through the registry, and asserts the fake never ran and the error code is `MODEL_ACTIVITY_PAUSED`. The same test with a tripped budget latch asserts `BUDGET_EXCEEDED`. Without this test the extraction is not done.

### 8.2 Kill Switch and Feature Flag Are Different Things

| Switch | Key | Scope | Clears |
|---|---|---|---|
| Kill switch | `app_state.model_activity_paused` | **All** model activity, both providers, nothing exempt | Only the same switch |
| Budget latch | `app_state.budget_tripped_at` | All model activity except chat and the grounded bar | Operator reset, with hour-window forgiveness |
| Feature flag | `app_state.ai.chatgpt.enabled` | Whether `chatgpt-oauth` is registered at all | Settings / rollout |

V1 used "kill switch" for the third only. All three exist and must be tested independently (§13.10).

### 8.3 Spend Accounting When There Is No Spend

A ChatGPT subscription reports no per-call dollar cost. `Usage.costUsd` is therefore **absent** — and `usage.ts` deliberately keeps absent distinct from zero, so a run that never reported a cost must not look like it cost $0.

The consequence V1 missed: `budget.ts`'s primary ceilings (`usdPerHour: 3`, `usdPerDay: 15`) become inert for ChatGPT, and only `callsPerHour: 400` / `callsPerDay: 3000` remain. Those call ceilings were sized against CLI-latency Claude calls; HTTP streams complete faster, so the same concurrency produces materially more calls per hour. Half the ceiling disappears and the rate against the other half rises.

Required:

1. **A provider-scoped call ceiling.** `BudgetCeilings` gains a per-provider override. ChatGPT's `callsPerHour` / `callsPerDay` defaults are set from Phase 0b's measured call rate at the shipped concurrency, and are a **precondition for flag-on**, not a Phase 5 tuning exercise.
2. **A quota ceiling in the same shape.** Where the backend reports plan quota windows, express a SuperTwin ceiling as a share of the user's plan quota (default: a stated fraction, not "all of it") with the same latch-and-human-reset semantics as the dollar ceiling. The user also uses this subscription for their own work; a background pipeline must not be able to consume all of it silently.
3. **Honest UI.** The 7-day usage panel and run accounting show calls and quota consumption for ChatGPT, with cost shown as unknown — never as `$0.00`. A $0 readout is the invisibility that let 13.4.x run for nine hours.
4. `ProviderModel.billingLabel` is `"ChatGPT subscription"` and is never rendered next to a dollar figure.

### 8.4 Ordering

The gate checks in this order, and the order is load-bearing: kill switch, budget latch, provider quota ceiling, provider auth state, then send. A signed-out provider must not consume a budget admission.

## 9. Settings and Data Contract

### 9.1 Provider Model Catalogue

```ts
interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
  inputModalities: Array<"text" | "image">;
  reasoningValues: string[];
  defaultReasoning: string | null;
  supportsTools: boolean;
  supportsHostTools: boolean;          // added: media enrichment needs it (§6.1)
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;   // added
  supportsStrictTools: boolean;        // added
  supportsVerbosity: boolean;          // added: §5.1 gates `text.verbosity` on it
  supportsPromptCacheKey: boolean;
  supportsPromptCacheOptions: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;      // added: §5.1's bound, not a config constant
  billingLabel: string | null;
}

interface ProviderModelCatalogue {
  providerId: "claude-local" | "chatgpt-oauth";
  mode: "discovered" | "cached" | "fallback";
  source: string;
  discoveredAt: string;
  revision: string;
  error: string | null;
  models: ProviderModel[];
}
```

1. The Claude implementation maps `claude-local/discovery.ts` into this shape; `settings-routes.ts` `modelCatalog()` and its `MODEL_CATALOG_CACHE_KEY` become provider-keyed.
2. The ChatGPT implementation discovers what the signed-in account can reach. It must not treat the public API model list as authoritative.
3. Hide `hidden: true`. Use `isDefault: true` only when nothing is saved for that provider and key.
4. Never show public API token prices for ChatGPT subscription models.
5. Capabilities decide which controls are enabled. Never guess capability from a model name.

### 9.2 Persisted Settings — All 21 Source Entries / 19 Distinct Logical Keys

V1 enumerated the 11 `INTELLIGENCE_STEPS` rows and called it "every step". There are two namespaces sharing the `selected_model_*` prefix:

| Namespace | Source | Keys |
|---|---|---|
| Steps (Settings pickers) | `settings-routes.ts:144` | `orient`, `critic`, `extract`, `decide`, `digest`, `consolidate`, `assist`, `executor`, `chat`, `tier`, `brief` |
| Roles (internal, no picker) | `db/settings.ts:31` `MODEL_KEY_BY_ROLE` | `chat`, `media`, `entity`, `episode`, `arc`, `extract`, `triage`, `done_detect`, `classify`, `adjudicate` |

`chat` and `extract` are **shared**; the other 8 roles and 9 steps are disjoint — 19 distinct keys, plus the legacy `selected_model` and the per-role thinking keys.

Three facts make this a P0, not bookkeeping:

1. `getSelectedModel("classify")` runs from `grounded/bar.ts:185`, `grounded/router.ts:40`, `grounded/handlers.ts:302` and `corrections-routes.ts:111`. `classify` has **no** `INTELLIGENCE_STEPS` row, so under V1's migration it never gets a ChatGPT key and never passes catalogue validation.
2. `MODEL_DEFAULT_BY_ROLE` (`db/settings.ts:50`) hardcodes `claude-sonnet-5` and `claude-haiku-4-5-20251001`. With ChatGPT active those Claude IDs go on the wire and every affected call returns `MODEL_UNAVAILABLE`.
3. A migration that copies 11 keys and leaves 10 behind silently **forks** `chat` and `extract` — the picker writes one key, the role reader reads another.

**Decision required in Phase 1, recorded in a decision row:** unify roles into the step namespace, or keep both and make both provider-aware. V2 recommends keeping both (the roles have no picker and different defaults) and making the *resolver* the single reader.

Keys:

| Key | Accepted value | Default |
|---|---|---|
| `ai.provider.active` | `claude-local` or `chatgpt-oauth` | `claude-local` |
| `ai.model.<provider>.<key>` | A model ID in that provider's current or cached catalogue | Provider default for that key |
| `ai.reasoning.<provider>.<key>` | A value in the selected model's `reasoningValues` | Provider/model default, else omitted |
| `ai.model_catalog.<provider>` | Last successful `ProviderModelCatalogue` JSON | None |
| `ai.chatgpt.enabled` | `0` or `1` | `0` |
| `ai.chatgpt.quota_ceiling` | §8.3.2 share-of-plan ceiling | Stated default |

1. `<key>` is any of the 19 distinct step-or-role keys above.
2. **Versioned-pass fallback is preserved.** `brain/llm.ts:93` falls back `orient.v7` → `orient`; `prompts/versions.ts:156` adds a third variant via `prompt.settingsKey`. The new resolver must reproduce both fallbacks or the 13.9 defect returns (a setting nothing reads).
3. Migration is idempotent: copy each existing `selected_model_<key>` / `selected_thinking_<key>` into the `claude-local` namespace once, keep a legacy read fallback for one release, delete nothing.
4. `evals/executors/set.ts:158` writes `selected_model_${step}` directly and must be migrated with the rest.
5. No access tokens, refresh tokens, authorization codes or account IDs in `app_state`.
6. Store an explicit model choice; never silently replace it when discovery briefly fails.
7. If a saved model is no longer available, mark the row unavailable and require a new choice (`MODEL_UNAVAILABLE`, §7.2). Do not silently run another model.

### 9.3 Settings API

1. `GET /api/settings/intelligence` returns `{ provider: { selected, options: [{ id, label, auth_state }] }, catalogue: ProviderModelCatalogue, steps: [{ key, selected_model, recommended_model, reasoning, reasoning_values, available }] }`.
2. `POST /api/settings/provider` accepts only `{ "provider": "claude-local" | "chatgpt-oauth" }`.
3. `POST /api/settings/intelligence` keeps `{ step, model?, thinking?, enabled? }` and validates against the active provider's catalogue.
4. `GET /api/providers/chatgpt-oauth/status` returns signed-in state, plan/quota summary, token expiry, canary result. Never tokens.
5. `POST .../login/start`, `GET .../login/status`, `POST .../login/cancel`, `POST .../logout`.
6. Errors use the §7.1 code set verbatim.
7. `GET /api/settings/models` keeps working for one release, derived from the new service.

### 9.4 Runtime Resolution

```ts
interface ResolvedModelCall {
  providerId: "claude-local" | "chatgpt-oauth";
  provider: Provider;
  key: string;                 // step or role key
  model: string;
  reasoning: ThinkingBudget | null;
  catalogueRevision: string;
}
```

1. Resolve provider, model and reasoning together, once, before entering the resource pool.
2. Pass the snapshot through retries and one repair turn. Never re-resolve mid-call.
3. New work sees a provider change immediately; existing work finishes on its original snapshot.
4. Test dependency injection may still supply a provider; production paths use the resolver.
5. After Phase 1, `rg` must show no production caller importing `claudeLocalProvider` or reading `DEFAULT_PROVIDER_ID` after boot. **The proof is only as good as the call-site list — see §11.4 task P1-G for the complete one, which V1's was not.**

### 9.5 Golden Gate

`StepOverrides` (`settings/overrides.ts:23`) is `Record<key, { model?, thinking? }>` shipped to the eval child through `SUPERTWIN_STEP_OVERRIDES`. It has no provider dimension, so V1's "mark the full golden set due when the provider first becomes runnable" has no mechanism.

1. `StepOverride` gains `provider?: "claude-local" | "chatgpt-oauth"`.
2. `golden-gate.ts` passes the candidate provider to the eval child alongside the model and thinking level.
3. A provider change proposes a **full-set** run; a per-key model or reasoning change keeps the existing category-scoped behaviour.
4. **`establishEvalHome()` isolates the home, not the Keychain.** A golden run against ChatGPT uses the user's real credentials and rotates their real refresh token unless §5.3's namespacing is in place first. Phase 6 must not run a ChatGPT golden set before Phase 2 task P2-A ships.
5. **Cost.** CLAUDE.md rule 5 requires a stated expected call count before anything that reaches a real model. Record the golden set's call count per provider in this document's appendix before Phase 6 starts, and report the actual count after.

## 10. Concurrency

1. Key the LLM semaphore by provider ID, keeping the `live`, `understanding` and `enrichment` lanes.
2. Keep Claude's existing default and maximum (each call is a ~250–350 MB CLI child).
3. **ChatGPT ships at the same `RESOURCE_LIMITS.llm` values: default 8, max 16.** V1's 16/64 is not a bigger number, it is different arithmetic: `LIVE_RESERVED_SLOTS = 1` and `ENRICHMENT_SHARE = 0.4` (`pool.ts:107-110`) are tuned against a pool of 8–16, and at 64 the live reservation is 1.5% of capacity while enrichment gets 25 concurrent media calls. Raising the ceiling requires a re-derivation of the lane math and a measured call-rate ceiling (§8.3.1) — it is a separate, evidenced change, not a Phase 5 constant.
4. Preserve bounded waiters, live-slot reservation, refusal backoff, cancellation, breaker behaviour and first-paint priority per provider.
5. Reduce ChatGPT concurrency on `RATE_LIMITED`, quota responses, repeated `TRANSPORT_ERROR`, or measured memory pressure; ramp back slowly.
6. **Warm-then-fan-out stays ON.** V1 proposed making it optional and not delaying parallel processing. `pool.ts:22` records why it exists: 8 parallel calls sharing a prefix are 8 misses **plus** 8 write premiums — 25% worse than not caching. Reversing a measured default needs the counter-measurement. Phase 0b measures ChatGPT's cache behaviour; if the measurement supports a change, propose it then with the numbers.
7. Verify abort closes the HTTP stream and releases its semaphore slot.

## 11. Build Plan

Phases run in order. **Within** a phase, tasks marked with the same parallel group run concurrently; §11.9 gives the rules for doing that with subagents.

### 11.1 Phase 0a — Decision Gate (serial, human, blocking)

§2. Three decision rows: client identity, terms, data posture. No implementation task starts until all three exist. Not parallelisable and not delegable to a subagent.

### 11.2 Phase 0b — Confirm the Direct Backend Contract (mostly serial, live account)

1. Add an opt-in probe under `worker/src/providers/chatgpt-oauth/probe/`, not connected to application traffic.
2. Verify the browser-completed device-code login, refresh, account selection, model listing, quota listing, request URL, required headers, SSE event types, cancellation, and logout. Confirm no loopback port is opened.
3. **Probe every §5.1 field serially at concurrency 1 first.** Record a redacted fixture for each accepted and rejected shape.
4. Probe blank instructions, omitted tools, cache modes, strict JSON output, images, tool calls and usage — still at concurrency 1.
5. **Only then** run the concurrency ladder, and stop it at the shipped ceiling: 1, 4, 8, 16. V1's 32 and 64 against an undocumented backend on a real subscription is the abuse-detection signature, and it buys a number §10.3 will not ship anyway.
6. Measure the call rate at concurrency 8 and the observed prompt-cache behaviour. These two numbers set §8.3.1's ceiling and settle §10.6.
7. Write the canary request and its degraded-state handling (§5.3.9).
8. **Exit criteria:** repeatable login, model list, blank-context response, stream completion, refresh and cancellation; no secret in logs or SQLite; a measured call rate; **and the test account is not rate-limited, flagged, or CAPTCHA-walled at the end of the run.** State the expected probe call count before starting and report the actual count (CLAUDE.md rule 5).

Parallel: none against the live backend. Fixture write-up and parser scaffolding (P2-D below) may proceed concurrently from the fixtures already captured.

### 11.3 Phase 1 — Provider-Neutral Foundations (high parallelism)

The critical path. One serial task, then a wide fan-out, then a wider one.

| Task | Owns | Depends on | Group |
|---|---|---|---|
| **P1-A** Contract types: `ProviderRequest`, `ProviderResult`, `Provider`, extended `ProviderErrorCode`, `Usage.cachedInputTokens`, `ProviderStreamEvent` continuation rename + alias | `providers/types.ts` | Phase 0a | **serial — blocks everything** |
| **P1-B** Extract the gate: `providers/gate.ts`, refactor `claude-local/index.ts` to call through it, fake-provider tests | `providers/gate.ts`, `providers/claude-local/index.ts` | P1-A | **G1** |
| **P1-C** Failure classification: `isHardStop`, `isRefusal`, exhaustive `classifyFailure`, comment at `pool.ts:257`, one test per §7.2 row | `providers/pool.ts` | P1-A | **G1** |
| **P1-D** Settings namespace + migration: all 21 keys, idempotent copy, legacy fallback, versioned-pass fallback preserved | `db/settings.ts`, `settings/overrides.ts` | P1-A | **G1** |
| **P1-E** Catalogue abstraction: `providers/catalogue.ts`, Claude discovery mapped into `ProviderModelCatalogue`, provider-keyed cache | `providers/catalogue.ts`, `claude-local/discovery.ts`, `brain/reasoning.ts` | P1-A | **G1** |
| **P1-F** Resolver: `providers/selection.ts`, `ResolvedModelCall`, both fallback chains | `providers/selection.ts` | P1-A, P1-D, P1-E | **G2** |
| **P1-G** Call-site migration — see the split below | per-agent file list | P1-F | **G3** |
| **P1-H** Registry + shutdown: `killAll()` on the interface, fan out `installCrashKill` and shutdown over `registry.list()`, per-request resolution at `server/index.ts:387` | `providers/registry.ts`, `worker/src/index.ts`, `server/index.ts` | P1-F | **G3** |

**P1-G splits into eight concurrent agents by disjoint file ownership.** V1's call-site list (its §8.2.4) was incomplete, which would have made its own `rg` exit criterion a false green. The complete list:

| Agent | Files |
|---|---|
| G-brain | `brain/llm.ts`, `brain/digest-pass.ts`, `brain/extract-drain.ts`, `brain/reasoning.ts` |
| G-prompts | `prompts/runner.ts`, `prompts/versions.ts` |
| G-grounded | `grounded/handlers.ts`, `grounded/bar.ts`, `grounded/router.ts` |
| G-media | `media/describe.ts`, `media/queue.ts` (routing only — the modality work is Phase 4b) |
| G-exec | `executor/session.ts`, `executor/lite.ts`, `executor/queue-job.ts` |
| G-tiers | `tiers/tiering.ts` |
| G-server | `server/index.ts` (chat routes), `server/corrections-routes.ts` |
| G-evals | `evals/judge.ts`, `evals/executors/set.ts` |

**Exit criteria:** all existing tests and golden fixtures pass with `claude-local` selected; fresh installs still default to Claude; the §8.1 fake-provider gate test passes; `rg` finds no production import of `claudeLocalProvider` outside the registry; every §7.2 row has a passing test.

### 11.4 Phase 2 — Build ChatGPT OAuth (high parallelism)

| Task | Owns | Depends on | Group |
|---|---|---|---|
| **P2-A** `auth.ts` + `keychain.ts`: Hermes-compatible device-code start/poll/exchange, poll correlation + returned verifier validation, home-namespaced Keychain account, refresh lock, rotation protocol (§5.3.5), logout | `chatgpt-oauth/auth.ts`, `chatgpt-oauth/keychain.ts` | P1-A, 0b | **G4** |
| **P2-B** `models.ts`: discovery, normalization, cache, capability flags | `chatgpt-oauth/models.ts` | P1-A, P1-E, 0b fixtures | **G4** |
| **P2-C** `request.ts`: strict §5.1 allowlist, unknown-field rejection, per-field validation | `chatgpt-oauth/request.ts` | P1-A, 0b fixtures | **G4** |
| **P2-D** `sse.ts`: bounded incremental parser, fragmented chunks, Unicode boundaries, malformed events | `chatgpt-oauth/sse.ts` | 0b fixtures | **G4** |
| **P2-E** `usage.ts`: tokens, cache fields, quota windows, retry timing | `chatgpt-oauth/usage.ts` | P1-A, 0b fixtures | **G4** |
| **P2-F** `index.ts`: `Provider` implementation, in-flight map, send, cancel, `killAll`, canary | `chatgpt-oauth/index.ts` | **all of G4** | **serial** |

A/B/C/D/E have no shared files and can run as five concurrent agents against the Phase 0b fixtures. F is the integration and is serial by construction.

1. Use the worker's HTTP client/`fetch`; no process per request.
2. Redact secrets and account identifiers before logs, errors, traces and snapshots.
3. Register `chatgpt-oauth` only when `ai.chatgpt.enabled = 1`, while still exposing sign-in status in Settings — and return `PROVIDER_UNAVAILABLE` (a hold) when it is selected but unregistered.
4. **Exit criterion:** offline fixtures pass; the opt-in live OAuth smoke suite passes; a dev worker under a scratch `SUPERTWIN_HOME` cannot read or rotate the production Keychain entry (§5.3.3), proven by test.

### 11.5 Phase 3 — Settings and Model Pickers (parallel after the type seam)

| Task | Owns | Depends on | Group |
|---|---|---|---|
| **P3-A** Shared API types in `src/lib/api.ts` | `src/lib/api.ts` | P1-A | **serial — blocks B and C** |
| **P3-B** Worker routes: provider-aware `modelCatalog()`, §9.3 endpoints, OAuth routes | `server/settings-routes.ts`, new provider routes | P3-A, P2-F | **G5** |
| **P3-C** UI: provider dropdown, auth state, sign-in/out, per-provider dropdown rebuild, loading/signed-out/cached/unavailable/empty/retry states, provider-aware pricing copy, §2.3 consent copy | `src/screens/settings/IntelligencePanel.tsx`, `ModelList.tsx` | P3-A | **G5** |

Preserve the existing step enabled toggles, seven-day usage, pending golden status and embedding-model section.

**Exit criterion:** switching Claude → ChatGPT → Claude changes every model dropdown and restores each provider's saved values without a restart; the §2.3 consent copy is shown before the first sign-in.

### 11.6 Phase 4 — Enforce Request and Context Control (moderate parallelism)

| Task | Owns | Depends on | Group |
|---|---|---|---|
| **P4-A** Move prompts from caller-created Claude files to `instructions`; the Claude adapter creates its own temp file internally | `prompts/`, `claude-local/` mapper | P1-G | **G6** |
| **P4-B** Builders: text, image, tool result, tool schema, reasoning, strict JSON, continuation, output limit, cache | `chatgpt-oauth/request.ts` | P2-F | **G6** |
| **P4-C** SuperTwin-owned agent-turn loop, clean stop at the cap, `MAX_TURNS` | `providers/gate.ts` or a loop module | P1-B | **G6** |
| **P4-D** Contract tests, one group per §5.1 field block — five concurrent agents (core, tools, reasoning, text/schema, cache) | `chatgpt-oauth/*.test.ts` | P4-B | **G7** |
| **P4-E** Dev-only redacted request snapshots proving blank mode has no adapter prompt, tool definitions, history or duplicated input | snapshot tests | P4-B | **G7** |

**Exit criterion:** every §5.1 value has an offline contract test and blank mode matches its approved snapshot byte-for-byte.

### 11.7 Phase 4b — Media Enrichment (its own phase, parallel with 4)

V1 treated this as a routing change. It is a second implementation.

`media/describe.ts:5` makes the model look at a file by whitelisting the CLI's `Read` tool and putting an absolute path in the prompt — `MEDIA_ALLOWED_TOOLS = ["Read"]`, cwd pinned to the media root, up to 32 images per call carrying a `#01…#32` marker protocol whose premise is that the model opens files one at a time. The ChatGPT provider forbids built-in tools (§5.1) and local file paths, and requires base64 `data:` URLs.

| Task | Owns | Depends on | Group |
|---|---|---|---|
| **P4b-A** Design + decision row: batch size under a real body limit (32 images as data URLs is easily 30–80 MB), downscale policy, whether the marker protocol survives or is replaced by one image per input item | design doc | 0b | **serial** |
| **P4b-B** ChatGPT image path: read, downscale, encode, chunk, re-associate answers to files | `media/describe-chatgpt.ts` | P4b-A, P2-F | **G8** |
| **P4b-C** `hostTools` capability rejection so a Claude-shaped media call against ChatGPT fails loudly with `CAPABILITY_UNSUPPORTED` rather than silently dropping `Read` | `providers/gate.ts`, `chatgpt-oauth/request.ts` | P1-B | **G8** |

**File-ownership barrier:** P4b-C is logically parallel with Phase 4 but may not run concurrently with P4-B (`chatgpt-oauth/request.ts`) or P4-C (`providers/gate.ts`). Schedule it after those two integrate, or split it into disjoint serial edits.

**Exit criterion:** a multi-image enrichment call produces correctly attributed descriptions on both providers, and the ChatGPT request body stays under the measured limit.

### 11.8 Phase 5 and 6

**Phase 5 — Parallelism, Quota, Reliability** (low parallelism; mostly one owner on `pool.ts`):

1. `providers/pool.ts` accepts `providerId` and applies provider-specific limits (§10).
2. Provider quota ceiling and latch (§8.3.1, §8.3.2), fed by quota polling, `RATE_LIMITED`, retry headers, latency, queue depth and memory.
3. Bounded request, SSE line, accumulated output, tool argument, error body and trace sizes.
4. Abort closes the HTTP stream and releases its slot.
5. Work is preserved on auth, quota, rate-limit, network and backend-change failures; no unit spends retry budget on a refusal.
6. **Exit criterion:** a realistic backfill at concurrency 8 stays bounded, live work keeps its reserved slot, no child process is created for ChatGPT calls, and the measured call rate is under the §8.3.1 ceiling.

**Phase 6 — Test, Evaluate, Release** (high parallelism for authoring, serial for the runs):

| Task | Depends on | Group |
|---|---|---|
| **P6-A** Unit tests beside each new module | Phase 2 | **G9** |
| **P6-B** Server tests: provider selection, auth states, model validation, legacy route compatibility, logout, no-fallback | Phase 3 | **G9** |
| **P6-C** React tests: provider changes and dropdown contents across all step groups | Phase 3 | **G9** |
| **P6-D** Security review: device-code flow, poll correlation and returned verifier validation, confirmation that no loopback listener exists, Keychain access and ACL, token rotation, log redaction, CSRF | Phase 2 | **G9** |
| **P6-E** Secret-absence scanner over the trace/log/snapshot corpus (§13.8 is otherwise unfalsifiable) | Phase 2 | **G9** |
| **P6-F** Golden runs: once with Claude, once with ChatGPT, provider and model recorded per result; the ChatGPT run uses a separately authenticated eval home and never bypasses home-namespaced Keychain isolation | **all of G9**, and §9.5.4 | **serial, live, costed** |

Keep ChatGPT behind `ai.chatgpt.enabled` until §2, security, concurrency and distribution gates pass. Claude remains available throughout. Update setup and troubleshooting docs.

**Exit criterion:** every Definition of Done item passes; all three switches in §8.2 are independently tested.

### 11.9 Running the Parallel Groups with Subagents

The groups above are only safe if agents cannot collide. These are rules, not suggestions.

1. **One agent owns a file.** Every task's "Owns" column is exclusive for the duration of the group. Two agents editing `pool.ts` in the same group is a merge conflict by construction — which is why P1-B and P1-C are separate tasks with separate files, and why P4b-C (which touches `gate.ts`) is scheduled after P1-B rather than beside it.
2. **A shared-file change is its own serial task.** `providers/types.ts` (P1-A) is edited by exactly one agent, before the fan-out, and never again inside a group.
3. **Use worktree isolation** (`isolation: "worktree"`) for each agent in a group of three or more, then integrate serially on the main tree. The integration commit is the parent's job, not the agent's.
4. **Every agent inherits CLAUDE.md's hard rules.** State them in the agent's prompt, because a subagent that has not read them will happily boot a worker: never run the worker without both `SUPERTWIN_HOME=<scratch>` and `SUPERTWIN_WORKER_PORT` ≠ 8013; never detach a process; close any port you open in the same turn and say so; a listener you did not start is not the user's app; anything reaching the `claude` CLI spends money and unit tests must make zero live model calls; never boot against `~/SuperTwinV13`.
5. **No agent runs a live model call.** Phases 0b and 6-F are the only live-call tasks in this plan, both serial, both with a stated expected call count. An agent in G1–G9 that believes it needs a live call has misread its task.
6. **Each agent reports:** files changed, tests added, tests run and their result, and anything it could not finish. A green report with no test names is not a report.
7. **Group barriers are real.** G2 does not start until every G1 agent has integrated and `npm --workspace worker run typecheck` is clean on the merged tree. Same for G3 after G2, and P2-F after all of G4.
8. **Maximum useful width.** G1 is 4 agents, P1-G is 8, G4 is 5, P4-D is 5. Beyond that the integration cost exceeds the parallel saving on a tree this size.

The critical path is therefore: `0a → 0b → P1-A → G1 → P1-F → P1-G/P1-H → P2 G4 → P2-F → P3-A → P3-B/C → P4 → P5 → P6 G9 → P6-F`. Phase 4b runs alongside Phase 4 and rejoins before Phase 5.

### 11.10 Build and Test Commands

From the repository root:

```bash
npm run test
npm run build
npm run bundle:worker
npm --workspace worker run typecheck
npm --workspace worker run test
```

The worker command above is offline even if a runner has an authenticated Claude CLI or a leaked opt-in variable. The three cost-bearing Claude suites require both the dedicated command and explicit spend consent:

```bash
SUPERTWIN_RUN_LIVE_CLAUDE_TESTS=1 npm run test:worker:live:claude
```

It prints the maximum expected turn count before invoking Vitest. Live OAuth, backend, cache, image and concurrency tests likewise run only with a dedicated command, an explicit environment flag and a test account. Normal CI stays offline and deterministic.

After a version-bumped DMG is built and its completed SHA-256 row is recorded in `RELEASES.md`, verify it before native Computer Use acceptance:

```bash
# Developer ID signed + notarized distribution gate (strict default)
npm run verify:release

# Explicit waiver for local-only, ad-hoc builds
npm run verify:release -- --allow-adhoc
```

The waiver never reports the artifact as distribution-ready. Native install, launch, permission, quit and process-lifecycle checks still require macOS Computer Use against the new build.

## 12. Verification Matrix

1. **Settings:** both providers appear; ChatGPT sign-in state is accurate; every dropdown changes with the provider; per-provider choices restore.
2. **No fallback:** ChatGPT signed out, expired or throttled returns its own error and never invokes Claude or asks for an API key.
3. **Blank context:** `instructions: ""`, no tools, no history, no cache hint, one user input, one turn, `store: false` reach the request builder unchanged.
4. **Custom context:** exact instructions, tools, JSON schema, continuation, reasoning, cache and turn cap are sent only when requested.
5. **OAuth:** device-code poll correlation, returned verifier validation, no loopback listener, refresh rotation, concurrent refresh, crash-between-rotate-and-persist recovery, expiry, cancel, logout, Keychain failure, **and home-namespacing** (a scratch-home worker cannot touch the production entry).
6. **Streaming:** fragmented SSE, multiple events per chunk, Unicode boundaries, usage, tool calls, refusal, cancellation, malformed events, bounded buffers.
7. **Catalogue:** live, cached, fallback, hidden, empty, unavailable saved model, per-model reasoning and capability flags.
8. **Gate:** the fake-provider test (§8.1); kill switch, budget latch and feature flag tested independently; a signed-out provider consumes no budget admission.
9. **Classification:** one test per §7.2 row asserting the action; an `AUTH_REQUIRED` never reaches the retry ladder; ten consecutive holds do not trip the S0.7 breaker.
10. **Keys:** all 21 source entries and all 19 distinct logical keys; `getSelectedModel("classify")` resolves through the provider-aware resolver on all four call sites; `orient.v7` → `orient` and `settingsKey` fallbacks preserved; migration is idempotent.
11. **Media:** multi-image enrichment attributes descriptions correctly on both providers; a `hostTools` request to ChatGPT fails with `CAPABILITY_UNSUPPORTED`.
12. **Concurrency:** benchmark 1, 4, 8, 16; record throughput, first-result time, RSS, heap, sockets, `429` rate, queue depth, recovery, and calls/hour against the §8.3.1 ceiling.
13. **No process:** a test asserts zero child processes spawned across a ChatGPT backfill.
14. **Secrets:** the §11.8 P6-E scanner finds nothing across traces, logs, API responses and snapshots.
15. **Regression:** existing Claude CLI arguments, sessions, tools, prompt handling, accounting, pool limits, UI and golden tests remain green.

## 13. Definition of Done

1. The three §2 decision rows exist and are accepted.
2. A user can choose Claude or ChatGPT in **Settings > Intelligence**, and the active provider controls the model options for every LLM and agent key.
3. Model and reasoning choices are isolated by provider across all 21 keys and restored on switching.
4. ChatGPT login, refresh, status, quota display and logout work without an API key, and a scratch-home worker cannot touch the production credential.
5. ChatGPT requests use direct concurrent HTTP streams and never start Codex CLI or another agent process — asserted by test, not by review.
6. Every provider call passes the shared gate: trace context, kill switch, budget latch, quota ceiling, cost record — proven by the fake-provider test.
7. SuperTwin can send a blank application system prompt, no tools, no history, no cache hint and one turn.
8. SuperTwin can explicitly supply its own instructions, inputs, tools, output schema, continuation, reasoning, cache mode and agent-turn cap.
9. Every §7.1 code has a §7.2 disposition and a passing test; no provider-unavailable state reaches the retry ladder.
10. The three switches in §8.2 are independently tested, and the feature flag disables ChatGPT without affecting Claude.
11. Media enrichment works on both providers.
12. No secret or raw account identifier appears in SQLite, logs, traces, API responses or snapshots — proven by the scanner, not by inspection.
13. The 7-day usage panel shows ChatGPT cost as unknown, never `$0.00`.
14. The §11.10 command set passes and both provider golden runs are reviewed, with expected and actual call counts recorded.

## 14. Rules for the Coding Goal

1. Implement the phases in order and keep the application buildable after each phase and after each parallel group's integration.
2. Do not remove, replace or weaken the Claude CLI adapter.
3. Do not build or invoke a Codex CLI adapter.
4. Do not add OpenAI API-key input, storage or fallback.
5. Do not use `~/.codex/auth.json` as SuperTwin's steady-state authentication.
6. Do not call the direct ChatGPT backend outside `worker/src/providers/chatgpt-oauth/`.
7. Do not hardcode ChatGPT models in the UI; the worker catalogue is the source of truth.
8. Do not silently change provider or model after an error.
9. Do not add a provider send path that bypasses `providers/gate.ts`.
10. Do not classify a new error code by message regex when it has a code.
11. Keep normal tests offline. Keep live tests opt-in, redacted and safe for a test account, with a stated expected call count.
12. Stop rollout — but never Claude operation — if any §2, security or concurrency gate fails.

## 15. References

1. OpenAI: [Responses request fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
2. OpenAI: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
3. OpenAI: [Codex App Server authentication and quota behavior](https://learn.chatgpt.com/es-419/docs/app-server)
4. Hermes: [Direct ChatGPT Codex transport](https://github.com/NousResearch/hermes-agent/blob/main/agent/transports/codex.py)
5. Hermes: [Separate OAuth token storage and refresh](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_codex.py)
6. SuperTwin: [Claude CLI adapter](../worker/src/providers/claude-local/index.ts)
7. SuperTwin: [Budget, kill switch and background hold](../worker/src/providers/budget.ts)
8. SuperTwin: [Resource pool and failure classification](../worker/src/providers/pool.ts)
9. SuperTwin: [Per-role model selection](../worker/src/db/settings.ts)
10. SuperTwin: [Intelligence steps and catalogue](../worker/src/server/settings-routes.ts)
11. SuperTwin: [Media enrichment via the Read tool](../worker/src/media/describe.ts)
12. SuperTwin: [Golden gate and step overrides](../worker/src/settings/golden-gate.ts)
13. SuperTwin: [Eval home isolation](../worker/src/evals/home.ts)
14. Predecessor: [V1 implementation doc](./SuperTwinV13_ChatGPTCodexImplementation_V1.md)

## Appendix A — Phase 0a Decision Record

Status: **accepted by Aditya Katare on 2026-09-07; Phase 0b may proceed.** The durable, owner-approved entries below are the source for idempotent per-install decision rows. Never write these manually into the user's production database.

### A.1 Client Identity — Accepted: Hermes-Compatible Pattern

- Decision: **follow the ChatGPT OAuth integration pattern implemented by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) at pinned commit `e9bccc90a5e314ddf6dd4bd3772d50cb40027275`.** Reuse its Codex OAuth public-client identity and private Codex backend contract, but identify SuperTwin honestly instead of copying Hermes's or Codex's user agent.
- Exact OAuth client ID: `app_EMoamEEZ73f0CkXaXp7hrann`.
- Exact endpoints: issuer `https://auth.openai.com`; device authorization page `https://auth.openai.com/codex/device`; device-code request `/api/accounts/deviceauth/usercode`; device poll `/api/accounts/deviceauth/token`; token endpoint `https://auth.openai.com/oauth/token`; token-exchange redirect URI `https://auth.openai.com/deviceauth/callback`; inference base `https://chatgpt.com/backend-api/codex`.
- Exact identity headers: refresh requests use `User-Agent: SuperTwinV13/<app-version>` and `Accept: application/json`; Codex backend requests use `User-Agent: SuperTwinV13/<app-version>` and `originator: supertwinv13`; `ChatGPT-Account-ID` is derived from `chatgpt_account_id` inside the OAuth JWT's `https://api.openai.com/auth` claim. Device-code and token-exchange requests use the required JSON/form content type. Per-call `session_id` and `x-client-request-id` are permitted only as bounded request identifiers, not as client-identity impersonation.
- Auth mechanics to mirror: device-code flow with no loopback listener or requested scope, exchange of the server-returned authorization code and verifier, refresh 120 seconds before expiry, refresh-token rotation persisted before use, one refresh retry after a 401, process-level refresh locking, and credentials stored only in SuperTwin's Keychain namespace—never in or imported from Hermes/Codex stores.
- Rationale: this follows the owner's requested, working open-source precedent while keeping SuperTwin's product identity explicit on the wire. OpenAI's official documentation supports ChatGPT sign-in for Codex clients and documents SDK/App Server integrations, but does not document this direct private-backend contract for general third-party personal-assistant traffic.
- Residual risk: the reused client ID and private endpoints can change or be rejected without notice; OpenAI may rate-limit, revoke tokens, suspend accounts, or treat the traffic as outside the intended Codex-client scope. Every signed-in user's ChatGPT account is collateral. The feature therefore remains flagged off by default and guarded by canary, quota, logout, and kill-switch controls.
- Accepting owner: **Aditya Katare (repository owner; explicit task decision on 2026-09-07).**

### A.2 Terms of Service — Accepted Private-Integration Risk

- Decision: **follow Hermes's direct ChatGPT OAuth/private Codex backend integration posture and explicitly accept the documented terms, account, and protocol risk.** This is risk acceptance, not a representation that Hermes authorizes SuperTwin or that OpenAI has approved this workload.
- Research finding (2026-09-07): the current consumer [Terms of Use](https://openai.com/policies/terms-of-use/) prohibit automatically or programmatically extracting data or Output and prohibit circumventing rate limits, restrictions, or protective measures. No public authorization was found for a non-Codex client to present Codex's OAuth identity to its private backend.
- Official alternatives (verified 2026-09-07): OpenAI documents the [Codex SDK/App Server](https://developers.openai.com/codex/sdk/) for programmatically integrating Codex into an application, and documents the API as the supported general-purpose programmatic interface. API usage has [separate billing from ChatGPT subscriptions](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform).
- Rationale: the owner specifically chose the Hermes implementation precedent for SuperTwin's subscription-backed provider. The rollout remains deliberately constrained and observable rather than assuming a public stability or authorization guarantee.
- Residual risk: owner acceptance cannot waive OpenAI's terms or bind OpenAI. Continuous background traffic and 8+ streams may trigger enforcement, throttling, CAPTCHA, token revocation, subscription disruption, or account suspension. The probe and release gates must stop on any such signal and must not circumvent a restriction.
- Accepting owner: **Aditya Katare (repository owner; explicit task decision on 2026-09-07).**

### A.3 Consumer Data Posture and Consent — Accepted

- Research finding (2026-09-07): OpenAI's current [consumer data-use policy](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/) says content from individual services such as ChatGPT and Codex may be used for model improvement unless the applicable control is disabled. The [Data Controls FAQ](https://help.openai.com/en/articles/7730893-data-control) describes account opt-out and Temporary Chat behavior, but this private backend does not document `store: false` as a retention or Temporary Chat guarantee.
- Actual retention/training posture for ChatGPT subscription traffic: consumer-service treatment controlled by the user's OpenAI account settings; SuperTwin does not promise API business-data treatment, Temporary Chat equivalence, no training or deletion.
- Difference from the Claude subscription path: content goes to OpenAI under the selected OpenAI account/workspace controls rather than to Anthropic through the Claude CLI and its account controls.
- Exact consent copy shown before sign-in (approved by the requester on 2026-09-07): **“SuperTwin will send selected WhatsApp messages, browser text, screen captures, and derived context to OpenAI using your personal ChatGPT/Codex subscription. This is consumer-service traffic, not API business data. OpenAI may retain or use content according to your account’s data controls. SuperTwin cannot guarantee no training, Temporary Chat treatment, or deletion. Confirm you have permission to share this data. You can sign out and stop future sends at any time.”**
- Rationale: names the data categories, destination, consumer-service posture, permission duty and stop control before authentication.
- Residual risk: account controls may change; senders and people represented in captured content may not have authorized onward disclosure. Consent must remain explicit and revocable.
- Accepting owner: **Aditya Katare (repository owner; exact copy approved in the task on 2026-09-07).**

## Appendix B — Execution Clarifications

- Phase 0b precedes Phase 1. Where a task dependency appears looser than the phase order, the stricter phase order wins.
- "All 21" means the 11 step entries plus 10 role entries; `chat` and `extract` overlap, yielding 19 distinct logical provider-aware keys. Acceptance tests cover both the source-entry count and distinct-key count.
- P4b-C observes the explicit file-ownership barrier in §11.7.
- A ChatGPT golden run authenticates its own isolated eval home. It may not reuse or rotate the production home's Keychain entry.
- Appendix A.2 records explicit risk acceptance, not a finding that the private integration is permitted. Any OpenAI enforcement, CAPTCHA, restriction, or account-warning signal stops the probe and rollout; the implementation may not work around it.
