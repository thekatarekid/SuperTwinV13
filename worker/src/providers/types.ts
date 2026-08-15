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
  | "BAD_REQUEST";

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
