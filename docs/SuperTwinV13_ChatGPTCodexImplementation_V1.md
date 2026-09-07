# SuperTwinV13 ChatGPT OAuth Direct Implementation V1

## 0. Coding Goal

Implement this document end to end. Complete the phases in order, meet every exit criterion, and stop only when the Definition of Done is satisfied or a named external review blocks rollout.

## 1. Goal

1. Keep the existing `claude-local` provider as a permanent product feature for users with a Claude subscription.
2. Add one new provider, `chatgpt-oauth`, for users with a ChatGPT subscription.
3. Let the user choose between Claude CLI and ChatGPT OAuth in Settings.
4. Do not build a Codex CLI adapter.
5. Do not support, request, or fall back to an OpenAI API key.

## 2. Architecture

1. Follow Hermes's direct approach: authenticate with ChatGPT OAuth and send streamed HTTP requests to the ChatGPT Codex backend.
2. Run the HTTP client inside the existing SuperTwin worker. Do not start a CLI or agent process for each ChatGPT request.
3. Keep `claude-local` unchanged except for the shared provider-selection and request-type changes needed to support both providers.
4. Keep the ChatGPT transport small and versioned because the direct backend is not a public API contract.
5. Put ChatGPT OAuth behind a feature flag and kill switch until compatibility, security, and distribution reviews pass.

### 2.1 ChatGPT OAuth Direct System Design

```text
                         LOGIN AND TOKEN PATH

                 login/status                         browser/device
+-------------+ <-------------> +------------------+ <----------------> +---------------+
| Settings UI |                 | OAuth Controller |        flow        | ChatGPT OAuth |
+-------------+                 +---------+--------+                    +---------------+
                                          |
                                          | store and rotate tokens
                                          v
                                  +-------+--------+
                                  | macOS Keychain |
                                  +-------+--------+
                                          |
                                          | access token for headers only
                                          v

                    SETTINGS AND MODEL-CATALOGUE PATH

+-----------------------+   select provider   +----------------------------+
| Settings > Intelligence| -----------------> | Provider/model settings    |
| provider + step models | <----------------- | active + per-provider state|
+-----------------------+   models for active +-------------+--------------+
                          provider only                     |
                                                            | list models
                                      +---------------------+---------------------+
                                      |                                           |
                                      v                                           v
                         +-------------------------+                 +-------------------------+
                         | Claude CLI catalogue    |                 | ChatGPT model catalogue |
                         +-------------------------+                 +-------------------------+

                              MODEL REQUEST PATH

+--------------------+  resolve provider, model,   +-------------------+
| SuperTwin callers  | --------------------------> | Provider registry |
| chat/pipeline/media|  reasoning as one snapshot | selected per call |
+--------------------+                             +---------+---------+
                                                               |
                                       +-----------------------+----------------------+
                                       |                                              |
                                       v                                              v
                           +------------------------+                    +------------------------------+
                           | claude-local provider  |                    | chatgpt-oauth provider       |
                           | existing CLI adapter   |                    | + strict request allowlist   |
                           +------------------------+                    | + prompt/tool/cache controls |
                                                                       | + OAuth token manager        |
                                                                       | + concurrency scheduler      |
                                                                       +---------------+--------------+
                                                                                       |
                                                                                       | streamed HTTP
                                                                                       v
                                                                       +---------------+--------------+
                                                                       | Shared connection pool       |
                                                                       +---------------+--------------+
                                                                                       |
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
                                                                                       | ProviderStreamEvent
                                                                                       v
                                                            +--------------------------+----------------+
                                                            | Callers, traces, usage and cancellation  |
                                                            +-------------------------------------------+
```

1. Login and token refresh are separate from model input. Credentials appear only in HTTP headers and Keychain.
2. The request builder sends only the fields allowed by Section 4.
3. The shared connection pool supports parallel requests without starting one local process per call.
4. The SSE parser streams normalized events while keeping response and error buffers bounded.

### 2.2 Provider and Model Selection

1. Add a provider dropdown at the top of **Settings > Intelligence**.
2. Show exactly two choices:
   1. `Claude — Claude subscription`, backed by `claude-local`.
   2. `ChatGPT — ChatGPT subscription`, backed by `chatgpt-oauth`.
3. Save the active provider. New calls use it; calls already running finish with the provider/model snapshot they started with.
4. After a provider is selected, every model picker for every LLM or agent step must show only that provider's models.
5. Keep model and reasoning choices separately for each provider and step. Switching back to a provider restores that provider's earlier choices.
6. If ChatGPT is selected but not signed in, show **Sign in to ChatGPT**, disable its model pickers, and return `AUTH_REQUIRED` for model calls. Never fall back to Claude or an API key.
7. If model discovery fails, show the last successful catalogue as cached. If no cache exists, disable the model pickers, show the error, and provide **Retry**.
8. Validate the selected model on the worker against the active provider's catalogue. The UI value is never trusted by itself.
9. The reasoning picker for each step must contain only the values supported by that step's selected model. Clear an incompatible stored value when the model changes.
10. Persist the provider selection immediately and record a settings decision. If ChatGPT is not ready, keep it selected but block calls with a clear error. Mark the full golden set due when the provider first becomes runnable. Per-step model and reasoning changes keep the existing golden-gate behavior.

## 3. Context Control

### 3.1 Honest Boundary

1. SuperTwin can control the application-level instructions, input, tools, history, cache hints, and agent loop that it sends.
2. SuperTwin cannot prove or remove OpenAI's hidden platform instructions, safety rules, routing data, or internal tokens.
3. The target is therefore **zero unwanted SuperTwin, Hermes, CLI, workspace, skill, or tool context**, not zero provider-side hidden context.

### 3.2 System Instructions

1. Send SuperTwin's system prompt exactly once through `instructions`.
2. Allow `instructions: ""` when the caller wants a blank application prompt.
3. Never add an adapter identity, default assistant prompt, preamble, or duplicated instructions.
4. Do not copy Hermes's fallback from an empty prompt to `DEFAULT_AGENT_IDENTITY`.
5. Keep each pipeline prompt byte-stable and versioned for cache reuse, traces, and evaluations.

### 3.3 Tools and Agent Turns

1. Omit `tools` when a call needs no tools. No tool definitions or descriptions should then be sent by SuperTwin.
2. When tools are needed, send only the exact SuperTwin tool schemas supplied by the caller.
3. Reject tool calls that do not match the supplied name and argument schema.
4. Treat one direct model response as one model turn.
5. For tool use, SuperTwin owns the loop: validate the call, run the tool, return its result, and stop at `maxAgentTurns`.
6. Do not enable automatic sub-agents, planning turns, retries, or continuations unless SuperTwin explicitly requests them.

### 3.4 History

1. Make pipeline calls stateless by default: `store: false`, no previous response ID, and no inherited messages.
2. Enable history only for interactive chat or another caller that explicitly requests it.
3. Keep independent work units independent so they can run and retry in parallel.

## 4. Complete V1 Request Contract

This is the complete outbound body allowlist for `chatgpt-oauth`. SuperTwin must reject unknown fields instead of forwarding them. The private backend may support only a subset of the public Responses shape, so Phase 0 must verify each enabled field with live probes.

| Field | Accepted value | Default | Rule |
|---|---|---|---|
| `model` | Non-empty model ID from the authenticated account's discovered model list | Required | Reject an unknown or unavailable model |
| `instructions` | Any UTF-8 string, including `""` | `""` | Send exactly once; never add a fallback |
| `input` | Non-empty array of the V1 input items listed below | Required | Preserve order; do not add wrappers |
| `tools` | Omitted, or an array of V1 function definitions | Omitted | Omit completely when empty |
| `tool_choice` | `"none"`, `"auto"`, or `"required"` | Omitted without tools; `"auto"` with tools | `"required"` is valid only when tools exist |
| `parallel_tool_calls` | `true` or `false` | Omitted without tools; `false` with tools | Never send it when tools are omitted |
| `reasoning` | Omitted, or `{ "effort": value }` | Omitted | Allowed effort values are model-dependent; see below |
| `text` | Plain-text or strict JSON-schema configuration | Plain text | Use JSON schema for structured pipeline output |
| `max_output_tokens` | Positive integer within SuperTwin's configured ceiling | Role-specific limit | Includes visible output and reasoning tokens |
| `previous_response_id` | Omitted, or a validated opaque response ID | Omitted | Interactive history only; never use for pipeline calls |
| `prompt_cache_key` | Omitted, or a stable 1–64 character SuperTwin-generated string | See cache mode | Never include user content, email, or tokens |
| `prompt_cache_options` | Omitted, or the verified cache object below | Omitted | Send only when the selected model supports it |
| `store` | `false` only | `false` | V1 must not permit `true` |
| `stream` | `true` only | `true` | Required for incremental parsing and cancellation |

The minimum blank-context request is:

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

### 4.1 Accepted Input Items

1. Text message:

   ```json
   {
     "type": "message",
     "role": "user",
     "content": [{ "type": "input_text", "text": "..." }]
   }
   ```

   Accepted roles are `user` and, only for explicit history replay, `assistant`.

2. Image message, only after the selected model and direct backend pass the compatibility probe:

   ```json
   {
     "type": "message",
     "role": "user",
     "content": [
       {
         "type": "input_image",
         "image_url": "data:image/...",
         "detail": "auto"
       }
     ]
   }
   ```

   Accepted `detail` values are `auto`, `low`, and `high`. Do not send local file paths.

3. Tool result, only inside an explicitly enabled SuperTwin tool loop:

   ```json
   {
     "type": "function_call_output",
     "call_id": "call_...",
     "output": "..."
   }
   ```

### 4.2 Accepted Tool Definition

```json
{
  "type": "function",
  "name": "tool_name",
  "description": "Exact SuperTwin description",
  "parameters": { "type": "object", "properties": {} },
  "strict": true
}
```

1. `type` must be `function` in V1.
2. `name` must match SuperTwin's tool-name rules and allowlist.
3. `description` may be `""`; SuperTwin must not generate one automatically.
4. `parameters` must be a valid JSON Schema object.
5. `strict` must be `true` for V1.
6. Built-in web, file, shell, computer, MCP, skill, plugin, and sub-agent tools are not allowed in V1.

### 4.3 Reasoning Values

1. Accepted outbound effort values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
2. The provider must discover the selected model's supported values and reject unsupported choices before sending.
3. SuperTwin's existing internal `off` value maps to outbound `none` only when supported; otherwise omit `reasoning` or use the model's lowest supported value according to an explicit role setting.
4. Do not send reasoning summaries, encrypted reasoning, or replayed reasoning items in V1.

### 4.4 Text Output Values

1. Plain text:

   ```json
   { "format": { "type": "text" }, "verbosity": "low" }
   ```

2. Structured output:

   ```json
   {
     "format": {
       "type": "json_schema",
       "name": "supertwin_output",
       "strict": true,
       "schema": {}
     },
     "verbosity": "low"
   }
   ```

3. Accepted `verbosity` values are `low`, `medium`, and `high`, subject to model support.
4. `name` must be a stable SuperTwin schema name and `schema` must be valid JSON Schema.

### 4.5 Prompt Cache Values

SuperTwin exposes these provider-neutral cache modes:

| SuperTwin mode | Outbound values | Meaning |
|---|---|---|
| `none` | Omit `prompt_cache_key`, `prompt_cache_options`, and all breakpoints | No SuperTwin cache hint; provider-side automatic caching may still occur |
| `implicit` | Stable `prompt_cache_key`; optional `{ "mode": "implicit", "ttl": "30m" }` when verified | Let the backend choose the eligible cache breakpoint |
| `explicit` | Stable key, `{ "mode": "explicit", "ttl": "30m" }`, and `{ "prompt_cache_breakpoint": { "mode": "explicit" } }` after the stable prefix | Cache only the prefix selected by SuperTwin |

1. Accepted `prompt_cache_options.mode` values are `implicit` and `explicit`.
2. Accepted `prompt_cache_options.ttl` is `30m` for models that support this field.
3. Do not send deprecated `prompt_cache_retention` in V1.
4. Build the key from prompt version, tool-schema hash, model, and a bounded shard. Do not use raw user or source data.
5. Keep stable instructions and tool schemas before changing input.
6. Read cache hits and writes from returned usage fields when present.
7. Keep warm-then-fan-out optional. Do not delay parallel processing unless measurements show a useful cache benefit.

### 4.6 Fields Intentionally Not Sent

1. Do not send `background`, `conversation`, `metadata`, hosted `prompt`, `service_tier`, `temperature`, `top_p`, `truncation`, `user`, `safety_identifier`, `include`, `context_management`, or provider-built-in tools in V1.
2. Add any of these later only through a reviewed contract change, compatibility probe, and evaluation.

### 4.7 HTTP Headers

1. Allow only the OAuth bearer token, ChatGPT account ID, content type, accepted stream type, user agent, and required request/session identifier headers.
2. Use a new request/session identifier for stateless calls. Reuse one only for explicit interactive continuity.
3. Record a redacted outbound-body and header snapshot in development tests. Never record access tokens, refresh tokens, or raw account IDs.

## 5. OAuth and Transport Implementation

1. Create `worker/src/providers/chatgpt-oauth/` with modules for login, Keychain storage, refresh, model discovery, request building, SSE parsing, usage, and the provider interface.
2. Offer browser and device-code login. Show login progress, plan type, quota state, expiry, and sign-out.
3. Store access and refresh tokens in macOS Keychain, not SQLite, settings, logs, or traces.
4. Give SuperTwin its own OAuth session. Do not share or continuously copy `~/.codex/auth.json`; refresh-token rotation can break another client.
5. Use one process-wide refresh lock. On `401`, refresh once, atomically store rotated tokens, and retry the original request once.
6. Never accept an API key. OAuth failure must return `AUTH_REQUIRED`; it must not fall back to another OpenAI authentication method.
7. Reuse HTTP connections and parse SSE incrementally. Bound request, response, line, error, and trace buffers.
8. Map streamed messages, tool calls, usage, completion, refusal, cancellation, and errors into `ProviderStreamEvent`.
9. Add a versioned compatibility check and a clear `BACKEND_UNSUPPORTED` error for backend changes.

## 6. Difference from Claude CLI

| Area | Existing Claude provider | New ChatGPT provider |
|---|---|---|
| Product status | Permanent provider | Additional permanent provider |
| Authentication | Claude CLI owns Claude subscription login | SuperTwin owns ChatGPT OAuth login and refresh |
| Execution | One `claude` child process per call | Concurrent HTTP streams in one worker |
| Local memory | About 250–350 MB per child | Mainly request, stream, and parser buffers |
| System prompt | Appended to Claude's built-in prompt | Exact application `instructions` field |
| Ambient context | Disabled with Claude CLI flags | None unless SuperTwin puts it in the request |
| Tools | Denied or allowed through CLI flags | Omitted or supplied as exact schemas |
| Turns | Claude CLI controls agent turns | SuperTwin controls the tool loop and turn cap |
| Cache | Claude cache TTL environment setting | SuperTwin cache mode and content-based key |
| Session | Claude session file and resume ID | Stateless by default; explicit response history only |
| Concurrency limit | Process and RAM sensitive | Mainly subscription, network, and payload sensitive |

## 7. Settings and Data Contract

### 7.1 Provider Model Catalogue

Each provider must return the same internal shape:

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
  supportsParallelToolCalls: boolean;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheOptions: boolean;
  contextWindow: number | null;
  billingLabel: string | null;
}

interface ProviderModelCatalogue {
  providerId: "claude-local" | "chatgpt-oauth";
  mode: "discovered" | "cached" | "fallback";
  source: string;
  discoveredAt: string;
  error: string | null;
  models: ProviderModel[];
}
```

1. The Claude implementation maps the existing CLI discovery result into this shape.
2. The ChatGPT implementation discovers models available to the signed-in account. It must not use the public API model list as its authority.
3. Hide models with `hidden: true`. Choose `isDefault: true` only when no model has been saved for that provider and step.
4. Do not show public API token prices for ChatGPT subscription models. Use a simple label such as `ChatGPT subscription` when no subscription-specific cost data exists.
5. A provider's capabilities decide which reasoning, image, tool, and cache controls are enabled. Do not guess capability from a model name.

### 7.2 Persisted Settings

Use these `app_state` keys:

| Key | Accepted value | Default |
|---|---|---|
| `ai.provider.active` | `claude-local` or `chatgpt-oauth` | `claude-local` |
| `ai.model.<provider>.<step>` | A model ID in that provider's current or cached catalogue | Provider default model |
| `ai.reasoning.<provider>.<step>` | A value in the selected model's `reasoningValues` | Provider/model default, otherwise off/omitted |
| `ai.model_catalog.<provider>` | Last successful `ProviderModelCatalogue` JSON | None |
| `ai.chatgpt.enabled` | `0` or `1` feature flag | `0` until rollout approval |

1. `<step>` covers every row in `INTELLIGENCE_STEPS`: `orient`, `critic`, `extract`, `decide`, `digest`, `consolidate`, `assist`, `executor`, `chat`, `tier`, and `brief`.
2. Existing `selected_model_<step>` and `selected_thinking_<step>` values belong to `claude-local`. Copy them once to the new Claude keys and keep a legacy read fallback for one release.
3. Do not place access tokens, refresh tokens, authorization codes, or account IDs in `app_state`.
4. Store an explicit model choice. Do not silently replace it when discovery briefly fails.
5. If a saved model is no longer available, mark the row unavailable and require a new choice. Do not silently run another model.

### 7.3 Settings API

`GET /api/settings/intelligence` must return this provider-aware shape:

```json
{
  "provider": {
    "selected": "chatgpt-oauth",
    "options": [
      { "id": "claude-local", "label": "Claude", "auth_state": "ready" },
      { "id": "chatgpt-oauth", "label": "ChatGPT", "auth_state": "signed_out" }
    ]
  },
  "catalogue": {
    "provider_id": "chatgpt-oauth",
    "mode": "discovered",
    "source": "chatgpt-account",
    "discovered_at": "<ISO-8601>",
    "error": null,
    "models": []
  },
  "steps": [
    {
      "key": "orient",
      "selected_model": "<provider-model-id>",
      "recommended_model": "<provider-model-id-or-null>",
      "reasoning": "medium",
      "reasoning_values": ["low", "medium", "high"]
    }
  ]
}
```

1. `POST /api/settings/provider` accepts only `{ "provider": "claude-local" }` or `{ "provider": "chatgpt-oauth" }`.
2. `POST /api/settings/intelligence` keeps `{ step, model?, thinking?, enabled? }`, but validates `model` and `thinking` against the active provider.
3. Add `GET /api/providers/chatgpt-oauth/status` for signed-in state, plan/quota summary, token expiry, and backend compatibility. Never return tokens.
4. Add `POST /api/providers/chatgpt-oauth/login/start`, `GET /api/providers/chatgpt-oauth/login/status`, `POST /api/providers/chatgpt-oauth/login/cancel`, and `POST /api/providers/chatgpt-oauth/logout`.
5. Return stable errors: `AUTH_REQUIRED`, `AUTH_EXPIRED`, `MODEL_UNAVAILABLE`, `BACKEND_UNSUPPORTED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `BAD_REQUEST`, `CANCELLED`, and `TRANSPORT_ERROR`.
6. Keep `GET /api/settings/models` working during one release by deriving its response from the new settings service. Remove its Claude-only source of truth.

### 7.4 Runtime Resolution

Before each model call, resolve one immutable snapshot:

```ts
interface ResolvedModelCall {
  providerId: "claude-local" | "chatgpt-oauth";
  provider: Provider;
  step: string;
  model: string;
  reasoning: string | null;
  catalogueRevision: string;
}
```

1. Read provider, model, and reasoning together before entering the resource pool.
2. Pass the snapshot through retries and one repair turn. Never re-resolve midway through a logical call.
3. New work sees a provider change immediately. Existing work completes on its original snapshot.
4. Test dependency injection may still supply a provider directly; production paths must use the resolver.
5. Remove production callers that import `claudeLocalProvider` or rely on `DEFAULT_PROVIDER_ID` after boot.

## 8. Provider-Neutral SuperTwin Changes

### 8.1 Provider Contract

Replace Claude-specific `SendOptions` fields with a provider-neutral request. Keep a temporary compatibility type only while callers are migrated.

```ts
interface ProviderRequest {
  runId: string;
  model: string;
  instructions: string;
  input: ProviderInputItem[];
  tools?: ProviderTool[];
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;
  reasoning?: { effort: string };
  text?: ProviderTextOutput;
  cache?: { mode: "none" | "implicit" | "explicit"; key?: string; ttl?: "30m" };
  history?: { previousResponseId: string };
  store: false;
  maxOutputTokens: number;
  maxAgentTurns: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ProviderStreamEvent) => void;
}
```

1. `instructions: ""`, no `tools`, `cache.mode: "none"`, no `history`, and `maxAgentTurns: 1` are valid and must remain blank/minimal through the ChatGPT adapter.
2. The Claude compatibility mapper converts this request to existing stdin, system-prompt file, CLI flags, tool allow/deny list, session, and thinking settings.
3. The ChatGPT mapper creates only the allowlisted body in Section 4.
4. SuperTwin owns any tool loop. The provider performs one response at a time and never invents extra agent turns.

### 8.2 Provider Registry and Call Sites

1. Register both providers in `worker/src/index.ts`; shutdown must cancel both providers without assuming both use child processes.
2. Extend `worker/src/providers/types.ts`, `registry.ts`, and `index.ts` with display information, capabilities, model discovery, auth state, and lookup by the active setting.
3. Refactor the boot-time provider captured in `worker/src/server/index.ts`. Resolve the provider when `/api/chat` or another model route starts.
4. Route these current production paths through the shared resolver:
   1. `worker/src/brain/llm.ts`
   2. `worker/src/prompts/runner.ts` and `worker/src/prompts/versions.ts`
   3. `worker/src/grounded/handlers.ts`
   4. `worker/src/media/describe.ts` and `worker/src/media/queue.ts`
   5. `worker/src/tiers/tiering.ts`
   6. `worker/src/executor/session.ts`
   7. Chat, brief, consolidation, assist, and evaluation entry points that reach these runners
5. Keep provider ID, model ID, reasoning, request mode, and cache usage in traces and run accounting.

### 8.3 Provider-Specific Concurrency

1. Key the LLM semaphore by provider ID while keeping the current `live`, `understanding`, and `enrichment` lanes.
2. Keep the existing Claude default and maximum because each Claude call starts a memory-heavy CLI process.
3. Start ChatGPT at 16 concurrent HTTP requests and permit an experimental ceiling of 64.
4. Preserve bounded waiters, live-slot reservation, refusal backoff, cancellation, breaker behavior, and first-paint priority for each provider.
5. Reduce ChatGPT concurrency on `429`, quota responses, repeated transport errors, or measured memory pressure; ramp it back slowly after recovery.
6. Do not let optional prompt-cache warming serialize the whole backfill. Warm only one stable prefix per cache key, then fan out its batch.

## 9. Build Plan

### 9.1 Phase 0 — Confirm the Direct Backend Contract

1. Add an opt-in probe under `worker/src/providers/chatgpt-oauth/probe/`; do not connect it to normal application traffic.
2. Verify browser/device login, token refresh, account selection, model listing, quota listing, request URL, required headers, SSE event types, cancellation, and logout.
3. Probe every field and accepted value in Section 4 separately. Record a redacted fixture for accepted and rejected shapes.
4. Probe blank instructions, omitted tools, cache modes, strict JSON output, images, tool calls, usage, and parallel requests at 1, 8, 16, 32, and 64.
5. Write `DIRECT_BACKEND_VERSION` and a compatibility result. If the endpoint or a field is unsupported, disable only that capability and return a clear error.
6. Exit criterion: repeatable login, model list, blank-context response, stream completion, refresh, and cancellation with no secret in logs or SQLite.

### 9.2 Phase 1 — Add Provider-Neutral Foundations

1. Add `worker/src/providers/catalogue.ts`, `selection.ts`, and `request.ts` for the shared types and resolver in Sections 7 and 8.
2. Extend `Provider`, `ProviderStreamEvent`, `ProviderErrorCode`, and usage fields without deleting Claude behavior.
3. Implement provider-namespaced settings and the idempotent legacy-Claude migration.
4. Make the Claude catalogue implement `ProviderModelCatalogue`.
5. Add the Claude request compatibility mapper and migrate one caller first.
6. Migrate every call site in Section 8.2, then use `rg` to prove no production caller selects Claude directly.
7. Exit criterion: all existing tests and golden fixtures pass with `claude-local` selected, and fresh installs still default to Claude.

### 9.3 Phase 2 — Build ChatGPT OAuth

1. Create these focused modules under `worker/src/providers/chatgpt-oauth/`:
   1. `auth.ts` — start, poll/callback, refresh lock, expiry, and logout.
   2. `keychain.ts` — read, write, rotate, and delete credentials in macOS Keychain.
   3. `models.ts` — live discovery, normalization, cache, and capability flags.
   4. `request.ts` — strict outbound allowlist and request validation.
   5. `sse.ts` — bounded incremental parser.
   6. `usage.ts` — tokens, prompt-cache fields, quota windows, and retry timing.
   7. `index.ts` — `Provider` implementation, in-flight map, send, and cancel.
2. Use the worker's HTTP client/`fetch`; do not add one process per request.
3. Add one process-wide token-refresh promise. A `401` may refresh and retry once only.
4. Redact secrets and account identifiers before logs, errors, traces, and test snapshots.
5. Register `chatgpt-oauth` only when the feature flag is enabled, while still exposing sign-in status in Settings.
6. Exit criterion: the provider passes offline fixtures and the opt-in live OAuth smoke suite.

### 9.4 Phase 3 — Build Settings and Model Pickers

1. Refactor `worker/src/server/settings-routes.ts` so `modelCatalog()` is provider-aware and the Intelligence response matches Section 7.3.
2. Add the provider and OAuth routes in Section 7.3.
3. Update `src/lib/api.ts` with provider, auth, generic model, catalogue, and step types.
4. Update `src/screens/settings/IntelligencePanel.tsx`:
   1. Put the provider dropdown above the step groups.
   2. Show provider auth state and ChatGPT sign-in/sign-out actions.
   3. Reload the Intelligence response after a provider change.
   4. Rebuild every step's model options from the active catalogue only.
   5. Rebuild each reasoning dropdown from the selected model only.
   6. Show loading, signed-out, cached, unavailable-model, empty, and retry states.
   7. Replace Claude-only catalogue and pricing copy with provider-aware text.
5. Preserve the existing step enabled toggles, seven-day usage, pending golden status, and embedding-model section.
6. Exit criterion: switching Claude → ChatGPT → Claude changes every model dropdown and restores each provider's saved values without a page restart.

### 9.5 Phase 4 — Enforce Request and Context Control

1. Move all prompts from caller-created Claude files to the exact `instructions` string in `ProviderRequest`; the Claude adapter may create its own temporary file internally.
2. Add builders for text, image, tool result, tool schema, reasoning, strict JSON output, history, output limit, and cache settings.
3. Reject unknown fields, unsupported capabilities, invalid schemas, invalid cache keys, and values outside the selected model's catalogue.
4. Add a maximum-agent-turn loop owned by SuperTwin. Stop cleanly at the cap and surface `MAX_TURNS`.
5. Add development-only redacted request snapshots proving that blank mode has no adapter prompt, tool definitions, history, or duplicated input.
6. Exit criterion: every Section 4 value has an offline contract test and blank mode matches its approved snapshot byte-for-byte.

### 9.6 Phase 5 — Parallelism, Quota, and Reliability

1. Update `worker/src/providers/pool.ts` to accept `providerId` for LLM runs and apply provider-specific limits.
2. Add ChatGPT quota-window polling when supported and combine it with `429`, retry headers, latency, queue depth, and memory measurements.
3. Add bounded request, SSE line, accumulated output, tool argument, error body, and trace sizes.
4. Verify abort closes the HTTP stream and releases its semaphore slot.
5. Preserve work on auth, quota, rate-limit, network, and backend-change failures. Do not spend a unit's retry budget on provider refusal.
6. Exit criterion: a realistic backfill at the selected concurrency remains bounded, live work retains its reserved slot, and no child process is created for ChatGPT calls.

### 9.7 Phase 6 — Test, Evaluate, and Release

1. Add unit tests beside each new provider, selection, settings, request, SSE, auth, and pool module.
2. Add server tests for provider selection, authentication states, model validation, legacy route compatibility, logout, and no-fallback behavior.
3. Add React tests for provider changes and model/reasoning dropdown contents across all step groups.
4. Run the existing golden evaluations once with Claude and once with ChatGPT. Record provider and model in each result.
5. Run security review for OAuth redirect/device flow, Keychain access, token rotation, log redaction, localhost routes, and CSRF/state validation.
6. Keep ChatGPT behind `ai.chatgpt.enabled` until compatibility, security, terms, and distribution reviews pass. Claude remains available throughout.
7. Update user-facing setup and troubleshooting documentation.
8. Exit criterion: all Definition of Done items pass and the kill switch can disable ChatGPT without affecting Claude.

### 9.8 Build and Test Commands

Run from the repository root:

```bash
npm run test
npm run build
npm run bundle:worker
npm --workspace worker run typecheck
npm --workspace worker run test
```

Run live OAuth, backend, cache, image, and concurrency tests only with an explicit environment flag and a test account. Normal CI must stay offline and deterministic.

## 10. Verification Matrix

1. **Settings:** both providers appear; ChatGPT sign-in state is accurate; every model dropdown changes with the provider; per-provider choices restore correctly.
2. **No fallback:** ChatGPT signed out, expired, or throttled returns its own error and never invokes Claude or asks for an API key.
3. **Blank context:** `instructions: ""`, no tools, no history, no cache hint, one user input, one turn, and `store: false` reach the ChatGPT request builder unchanged.
4. **Custom context:** exact custom instructions, tools, JSON schema, history, reasoning, cache, and turn cap are sent only when requested.
5. **OAuth:** state/PKCE checks, refresh rotation, concurrent refresh, expiry, cancel, logout, and Keychain failure are covered.
6. **Streaming:** fragmented SSE, multiple events per chunk, Unicode boundaries, usage, tool calls, refusal, cancellation, malformed events, and bounded buffers are covered.
7. **Catalogue:** live, cached, fallback, hidden, empty, unavailable saved model, and per-model reasoning states are covered.
8. **Concurrency:** benchmark 1, 8, 16, 32, and 64 calls; record throughput, first-result time, RSS, heap, sockets, `429` rate, queue depth, and recovery.
9. **Regression:** existing Claude CLI arguments, sessions, tools, prompt handling, accounting, pool limits, UI, and golden tests remain green.

## 11. Definition of Done

1. A user can choose Claude or ChatGPT in **Settings > Intelligence**.
2. The active provider controls the model options for every LLM and agent step.
3. Model and reasoning choices are isolated by provider and restored on switching.
4. ChatGPT login, refresh, status, quota display, and logout work without an API key.
5. ChatGPT requests use direct concurrent HTTP streams and never start Codex CLI or another agent process.
6. SuperTwin can send a blank application system prompt, no tools, no history, no cache hint, and one turn.
7. SuperTwin can explicitly supply its own instructions, inputs, tools, output schema, history, reasoning, cache mode, and agent-turn cap.
8. No secret or raw account identifier is stored in SQLite or appears in logs, traces, API responses, or snapshots.
9. Authentication, quota, and backend failures preserve queued work and never fall back to Claude or an API key.
10. The full command set in Section 9.8 passes, both provider golden runs are reviewed, and the feature flag and kill switch are tested.

## 12. Rules for the Coding Goal

1. Implement the phases in order and keep the application buildable after each phase.
2. Do not remove, replace, or weaken the Claude CLI adapter.
3. Do not build or invoke a Codex CLI adapter.
4. Do not add OpenAI API-key input, storage, or fallback.
5. Do not copy tokens from `~/.codex/auth.json` as SuperTwin's steady-state authentication.
6. Do not call the direct ChatGPT backend outside `worker/src/providers/chatgpt-oauth/`.
7. Do not hardcode ChatGPT models in the UI; the worker catalogue is the source of truth.
8. Do not silently change provider or model after an error.
9. Keep normal tests offline. Keep live tests opt-in, redacted, and safe for a test account.
10. Stop rollout, but not Claude operation, if compatibility or security checks fail.

## 13. References

1. OpenAI: [Responses request fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
2. OpenAI: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
3. OpenAI: [Codex App Server authentication and quota behavior](https://learn.chatgpt.com/es-419/docs/app-server)
4. Hermes: [Direct ChatGPT Codex transport](https://github.com/NousResearch/hermes-agent/blob/main/agent/transports/codex.py)
5. Hermes: [Separate OAuth token storage and refresh](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_codex.py)
6. SuperTwin: [Claude CLI adapter](../worker/src/providers/claude-local/index.ts)
7. SuperTwin: [Provider resource pool](../worker/src/providers/pool.ts)
