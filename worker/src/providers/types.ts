// Provider interface (Cabinet-style, thin transport contract).
//
// These types are the integration surface between the Claude adapter, the
// server/adapter layer, and any future provider (Codex/Gemini/local). They are
// COMPLETE and load-bearing — other agents import them directly. Keep them in
// sync with docs/PHASE0_ARCHITECTURE.md §5. The registry and the concrete
// providers are separate files; this module is types-only.

/**
 * Token/cost accounting reported by a provider run. All four token counts are
 * recorded because `inputTokens` is only the uncached delta — on a real media
 * call it is ~17 of ~59,700 actual input tokens, the rest being cache. Bill via
 * `billableTokens` in ./usage.js, never a raw sum.
 */
export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
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

/**
 * A single normalized event emitted while a provider streams a response.
 * The adapter parses provider-native output (e.g. Claude CLI stream-json
 * NDJSON) into this shape.
 */
export type ProviderStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "done"; sessionId: string; usage: Usage; stopReason?: string }
  | {
      type: "error";
      code: ProviderErrorCode;
      message: string;
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
  | "BAD_REQUEST";

/**
 * Extended-thinking ladder (arch §4.3). The provider maps these to
 * MAX_THINKING_TOKENS on the child env: off=0 low=2048 medium=8192 high=24576
 * xhigh=49152 max=65536. **Every call in this build uses `off`** — extraction
 * with a fixed output schema gains nothing from reasoning tokens and loses
 * determinism and money. The ladder exists so escalation is config, not a
 * rewrite.
 */
export type ThinkingBudget = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** Options for a single `Provider.send` call. */
export interface SendOptions {
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
   * Bounded, tool-free, single-turn JSON completion mode (extraction stages).
   * When true the adapter forces: --max-turns 1, hard tool denial via
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
   * Pass the instruction block TWICE — once via `--append-system-prompt` and
   * once as the head of stdin (§4.1.1). Defaults to `plainCompletion`, and is
   * skipped on a resume (where the CLI drops --append-system-prompt anyway, so
   * the session already carries the instructions).
   */
  duplicateInstructions?: boolean;
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

/** Result of a completed `Provider.send` call. */
export interface ProviderResult {
  sessionId: string;
  usage: Usage;
  /** true if a poisoned/invalid resume transparently fell back to fresh. */
  freshFallback: boolean;
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
}

/** The thin provider contract every backend implements. */
export interface Provider {
  /** Stable id, e.g. "claude-local". */
  id: string;
  /** Send a message and stream normalized events; resolves when done. */
  send(opts: SendOptions): Promise<ProviderResult>;
  /** Kill an in-flight run by id. Returns true if a run was found+killed. */
  cancel(runId: string): boolean;
}
