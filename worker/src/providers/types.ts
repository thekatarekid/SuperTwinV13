// Provider interface (Cabinet-style, thin transport contract).
//
// These types are the integration surface between the Claude adapter, the
// server/adapter layer, and any future provider (Codex/Gemini/local). They are
// COMPLETE and load-bearing — other agents import them directly. Keep them in
// sync with docs/PHASE0_ARCHITECTURE.md §5. The registry and the concrete
// providers are separate files; this module is types-only.

/**
 * Token/cost accounting reported by a provider run. Claude reports its cache
 * reads separately, so `inputTokens` is only its uncached delta; ChatGPT's
 * optional `cachedInputTokens` is instead a subset of `inputTokens`. Bill via
 * `billableTokens` in ./usage.js, never by blindly summing every field.
 */
export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /**
   * Provider-neutral cache-read count used by providers whose cache accounting
   * is not priced like Claude's `cacheReadInputTokens`. It stays absent when
   * the provider did not report it; absent must never be normalized to zero.
   */
  cachedInputTokens?: number;
  /**
   * The cache-write half broken down by TTL, when the wire carried the
   * breakdown (`usage.cache_creation.ephemeral_5m_input_tokens` and
   * `…_1h_input_tokens`). A 5-minute write bills at 1.25x a fresh input token,
   * a 1-HOUR write at 2.0x, and this build's CLI writes 1-hour entries — so
   * pricing the undivided `cacheCreationInputTokens` at 1.25 under-counts real
   * spend by ~31%. Both are ABSENT, not 0, when the line carried no breakdown:
   * `billableTokens` then prices the unattributed remainder at the 1-hour rate
   * the stored runs actually measure.
   */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  costUsd?: number;
}

/** Closed JSON value accepted at the provider boundary. */
export type ProviderJson =
  | null
  | boolean
  | number
  | string
  | ProviderJson[]
  | { [key: string]: ProviderJson };

export type ProviderJsonObject = { [key: string]: ProviderJson };

export interface ProviderInputText {
  type: "input_text";
  text: string;
}

export interface ProviderInputImage {
  type: "input_image";
  /** A data URL or provider-approved remote URL; never a local file path. */
  image_url: string;
  detail?: "auto" | "low" | "high";
}

export interface ProviderInputMessage {
  type: "message";
  role: "user" | "assistant";
  content: Array<ProviderInputText | ProviderInputImage>;
}

export interface ProviderFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ProviderInputItem =
  | ProviderInputMessage
  | ProviderFunctionCallOutput;

export interface ProviderTool {
  type: "function";
  name: string;
  description: string;
  parameters: ProviderJsonObject;
  strict: true;
}

export type ProviderTextOutput =
  | {
      format: { type: "text" };
      verbosity?: "low" | "medium" | "high";
    }
  | {
      format: {
        type: "json_schema";
        name: string;
        strict: true;
        schema: ProviderJsonObject;
      };
      verbosity?: "low" | "medium" | "high";
    };

/**
 * A single normalized event emitted while a provider streams a response.
 * The adapter parses provider-native output (e.g. Claude CLI stream-json
 * NDJSON) into this shape.
 */
export interface ProviderToolUseEvent {
  type: "tool_use";
  callId: string;
  name: string;
  input: ProviderJson;
}

/** @deprecated Claude compatibility; remove after callers supply callId. */
export interface LegacyProviderToolUseEvent {
  type: "tool_use";
  name: string;
  input: unknown;
  callId?: never;
}

export interface ProviderContinuationEvent {
  type: "continuation";
  token: string;
}

/** @deprecated Use ProviderContinuationEvent. Kept for one migration release. */
export interface LegacyProviderSessionEvent {
  type: "session";
  sessionId: string;
}

export interface ProviderDoneEvent {
  type: "done";
  continuation: string | null;
  usage: Usage;
  stopReason?: string;
  /** @deprecated Read continuation instead. */
  sessionId?: string;
}

/** @deprecated Use ProviderDoneEvent. Kept for one migration release. */
export interface LegacyProviderDoneEvent {
  type: "done";
  sessionId: string;
  usage: Usage;
  stopReason?: string;
  continuation?: never;
}

export type ProviderStreamEvent =
  | ProviderContinuationEvent
  | LegacyProviderSessionEvent
  | { type: "delta"; text: string }
  | ProviderToolUseEvent
  | LegacyProviderToolUseEvent
  | { type: "usage"; usage: Usage }
  | ProviderDoneEvent
  | LegacyProviderDoneEvent
  | {
      type: "error";
      code: ProviderErrorCode;
      message: string;
      continuation?: string;
      /** @deprecated Read continuation instead. */
      sessionId?: string;
    };

/** Typed, exhaustive error codes surfaced by a provider. */
export type ProviderErrorCode =
  | "TIMEOUT"
  | "SPAWN_FAILED"
  | "CLI_ERROR"
  | "POISONED_SESSION"
  | "CANCELLED"
  | "QUOTA_EXCEEDED"
  /** providers/budget.ts: the hard spend/call ceiling, thrown BEFORE spawn. */
  | "BUDGET_EXCEEDED"
  /** providers/budget.ts: "Stop all model activity" is on, thrown BEFORE spawn. */
  | "MODEL_ACTIVITY_PAUSED"
  /**
   * The CLI stopped because it hit `--max-turns`, not because anything broke
   * (FIX-C2). It is a SOFT stop: whatever the model streamed before the cap is
   * still the model's own words, so the caller salvages or re-asks NARROWLY —
   * it must never trigger a blind re-issue of the same full-context call, and
   * it must not feed the S0.7 consecutive-failure breaker.
   */
  | "MAX_TURNS"
  | "BAD_REQUEST"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED"
  | "BACKEND_UNSUPPORTED"
  | "RATE_LIMITED"
  | "TRANSPORT_ERROR";

/**
 * Extended-thinking ladder (arch §4.3). The provider maps these to
 * MAX_THINKING_TOKENS on the child env: off=0 low=2048 medium=8192 high=24576
 * xhigh=49152 max=65536. **Every call in this build uses `off`** — extraction
 * with a fixed output schema gains nothing from reasoning tokens and loses
 * determinism and money. The ladder exists so escalation is config, not a
 * rewrite.
 */
export type ThinkingBudget = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderId = "claude-local" | "chatgpt-oauth";

export interface ProviderRequest {
  runId: string;
  model: string;
  /** The application system prompt. An empty string is valid and stays empty. */
  instructions: string;
  input: ProviderInputItem[];
  tools?: ProviderTool[];
  /** Named host tools, intentionally distinct from function-tool schemas. */
  hostTools?: string[];
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;
  reasoning?: {
    budget: ThinkingBudget;
    effort?: Exclude<ThinkingBudget, "off">;
  };
  text?: ProviderTextOutput;
  cache?: { mode: "none" | "implicit" | "explicit"; key?: string; ttl?: "30m" };
  continuation?: { token: string };
  persistContinuation?: boolean;
  plainCompletion?: boolean;
  skipHostSettings?: boolean;
  cwd?: string;
  maxOutputTokens: number;
  maxAgentTurns: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ProviderStreamEvent) => void;
}

export interface ProviderCapabilities {
  functionTools: boolean;
  hostTools: boolean;
  continuation: boolean;
  requiresAuthentication: boolean;
}

export type ProviderAuthStatus =
  | "ready"
  | "signed_out"
  | "expired"
  | "unavailable"
  | "degraded";

export interface ProviderAuthState {
  status: ProviderAuthStatus;
  accountLabel?: string;
  error: string | null;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
  inputModalities: Array<"text" | "image">;
  reasoningValues: string[];
  defaultReasoning: string | null;
  supportsTools: boolean;
  supportsHostTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
  supportsStrictTools: boolean;
  supportsVerbosity: boolean;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheOptions: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  billingLabel: string | null;
}

export interface ProviderModelCatalogue {
  providerId: ProviderId;
  mode: "discovered" | "cached" | "fallback";
  source: string;
  discoveredAt: string;
  revision: string;
  error: string | null;
  models: ProviderModel[];
}

/**
 * @deprecated Claude-only request contract. New providers use ProviderRequest.
 */
export interface LegacySendOptions {
  /** Caller-generated id used to correlate cancel/logging with this run. */
  runId: string;
  /** The user message. For the Claude CLI this is piped via stdin. */
  message: string;
  /** null/undefined = start a fresh session; otherwise attempt resume. */
  sessionId?: string | null;
  /** Working directory for the run. Default: a safe sandbox dir. */
  cwd?: string;
  /** Explicit tool whitelist. Default: [] (plain chat, no tools). */
  allowedTools?: string[];
  /** System-prompt file — only applied on FRESH sessions (token economy). */
  systemPromptFile?: string;
  /** Cap the number of agent turns. */
  maxTurns?: number;
  /**
   * Bounded, tool-free, short-turn JSON completion mode (extraction stages).
   * When true the adapter forces: --max-turns PLAIN_COMPLETION_MAX_TURNS (2 —
   * one answer plus one preamble allowance, see cli.ts), hard tool denial via
   * --disallowedTools (every built-in agentic tool), --setting-sources "" (so
   * the user's/project's CLAUDE.md, hooks and settings are NOT loaded), and
   * MAX_THINKING_TOKENS=0 (extended thinking disabled). Together these stop the
   * CLI from wandering into agentic tool calls / extended thinking and hanging
   * to the timeout. Ignored on resume (extraction always runs fresh).
   */
  plainCompletion?: boolean;
  /**
   * Pass `--setting-sources ""` so the user's/project's CLAUDE.md, hooks and
   * settings are NOT loaded, WITHOUT the rest of plainCompletion's single-turn
   * tool denial. A media read pays ~6,158 input tokens for a global CLAUDE.md
   * that cannot help it describe an image, but still needs Read and its turns.
   */
  skipUserSettings?: boolean;
  /**
   * Extended-thinking budget (§4.3). Omitted, plain completion still pins the
   * budget to 0; set it explicitly to escalate a single call.
   */
  thinkingBudget?: ThinkingBudget;
  /**
   * Reasoning level for the models that have one (`--effort`). Separate from
   * `thinkingBudget` on purpose: the newer models take a named effort level and
   * ignore MAX_THINKING_TOKENS, the older ones are the other way round, and the
   * catalogue read out of the CLI (claude-local/discovery.ts) is what says
   * which a given model is. Omitted passes NO flag — byte-identical to the
   * behaviour before the per-step reasoning picker existed.
   */
  effort?: Exclude<ThinkingBudget, "off">;
  /**
   * Keep the CLI session on disk so a later call can resume it (`sessionId`).
   * Default: `!plainCompletion` — a pipeline pass is a fresh single turn that
   * nobody resumes, so it runs with `--no-session-persistence` (S0.4, T1-1);
   * chat keeps its sessions. Ignored on a resume, which always writes to the
   * session it names.
   */
  persistSession?: boolean;
  /**
   * Per-call spend ceiling, passed as `--max-budget-usd`. Default: the
   * `usdPerCall` ceiling in providers/budget.ts (Product §23.3 "per call").
   */
  maxBudgetUsd?: number;
  /** Per-run timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Optional Claude model id (e.g. "opus", "claude-opus-4-8"). When a non-empty
   * trimmed value is given the adapter passes `--model <id>`; empty/undefined
   * passes NO flag (subscription default — byte-identical to pre-picker behavior).
   */
  model?: string;
  /** Streaming callback invoked for every normalized event. */
  onEvent: (e: ProviderStreamEvent) => void;
  /** Abort signal — aborting cancels/kills the underlying process. */
  signal?: AbortSignal;
}

/** @deprecated Use ProviderRequest after migrating the caller. */
export type SendOptions = LegacySendOptions;

interface ProviderResultBase {
  usage: Usage;
  /** true if a poisoned/invalid resume transparently fell back to fresh. */
  freshFallback: boolean;
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
  /** Bounded backend refusal hint; absent when no trustworthy hint exists. */
  retryAfterMs?: number;
}

/** Provider-neutral result. Stateless calls represent continuation as null. */
export interface NeutralProviderResult extends ProviderResultBase {
  continuation: string | null;
  /** @deprecated Temporary read alias for callers migrating from Claude. */
  sessionId?: string;
}

/** @deprecated Claude-only result contract. */
export interface LegacyProviderResult extends ProviderResultBase {
  sessionId: string;
  /** @deprecated Claude callers should migrate to the neutral result. */
  continuation?: string | null;
}

export type ProviderContractMode = "legacy" | "neutral";

/**
 * Completed send result. Bare usage remains legacy-compatible for one
 * migration release; new code must request ProviderResult<"neutral">.
 */
export type ProviderResult<
  M extends ProviderContractMode = "legacy",
> = M extends "neutral" ? NeutralProviderResult : LegacyProviderResult;

/** @deprecated Claude-only provider seam. */
export interface LegacyProvider {
  /** Stable id, e.g. "claude-local". */
  id: string;
  /** Send a message and stream normalized events; resolves when done. */
  send(opts: LegacySendOptions): Promise<LegacyProviderResult>;
  /** Kill an in-flight run by id. Returns true if a run was found+killed. */
  cancel(runId: string): boolean;
}

/** Strict provider-neutral backend contract. */
export interface NeutralProvider {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
  authState(): ProviderAuthState;
  catalogue(): ProviderModelCatalogue;
  send(req: ProviderRequest): Promise<NeutralProviderResult>;
  cancel(runId: string): boolean;
  killAll(): void;
}

/** Alias for code that prefers a non-generic modern contract name. */
export type ModernProvider = NeutralProvider;

/** Explicit additive V2 seam while bare Provider remains legacy-compatible. */
export type ProviderV2 = NeutralProvider;

/**
 * Provider transition seam. Bare Provider is the deprecated Claude contract
 * so existing callers compile; all new providers use Provider<"neutral">.
 */
export type Provider<
  M extends ProviderContractMode = "legacy",
> = M extends "neutral" ? NeutralProvider : LegacyProvider;
