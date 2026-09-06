// ===========================================================================
// The pure, spawn-free half of the Claude CLI adapter: how one invocation is
// SHAPED — which binary, which argv, which environment, which cwd, and what
// goes on stdin. index.ts owns the process lifecycle and imports these.
//
// Split out so the bare-call contract (arch §4.1) can be asserted without
// spawning anything, and so neither file grows past what one concern needs.
// ===========================================================================

import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { ThinkingBudget } from "../types.js";

// Plain-completion mode (extraction stages): hard tool denial + neutral
// settings so the CLI cannot wander into agentic tool calls, hooks, or the
// user's CLAUDE.md and hang. See SendOptions.plainCompletion.
//
// EMPIRICALLY VERIFIED (claude 2.1.197) on the real ~35KB assign prompt:
//   - old flags (`--allowedTools ""`, no --max-turns): SessionStart hooks
//     fire, extended thinking runs away (62 thinking_tokens blocks), 0 text,
//     no result — killed at the 180s timeout with 0 tokens.
//   - these flags + MAX_THINKING_TOKENS=0: no hooks, no thinking, streams JSON
//     text from ~2s and completes with a valid parseable object.
// `--allowedTools ""` alone is proven INSUFFICIENT; all four levers are needed.
const PLAIN_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
  "BashOutput",
  "KillShell",
].join(",");

/**
 * Extended-thinking ladder (arch §4.3) → MAX_THINKING_TOKENS on the child env.
 * Every call in this build uses `off`; the rest exist so escalating one step is
 * config rather than a rewrite.
 */
export const THINKING_BUDGET_TOKENS: Record<ThinkingBudget, number> = {
  off: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
  xhigh: 49152,
  max: 65536,
};

/**
 * Prompt-cache TTL handed to every child as `CLAUDE_CODE_PROMPT_CACHE_TTL`
 * (S0.4, T1-1). The CLI's default is the 1-hour tier at 2.0x; five minutes
 * bills at 1.25x and outlives any single-turn call by a wide margin.
 */
export const PROMPT_CACHE_TTL = "5m";

/**
 * The levels `claude --effort` accepts. "off" is deliberately absent: the CLI
 * has no "no effort" level, so a step set to off simply passes no flag (and
 * plain completion still pins MAX_THINKING_TOKENS to 0).
 */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The turn cap plain completion floors itself at (FIX-C2).
 *
 * It used to be pinned to 1, and one turn was a turn too few. `--max-turns 1`
 * is not "answer once": it is "stop after the first assistant message". A
 * model that opens with a one-line preamble — "I'll process this history-mode
 * bundle of 92 events across 9 WhatsApp streams" — has spent the only turn it
 * had, and the CLI ends the run with is_error and
 * "Reached maximum number of turns (1)" BEFORE the JSON or the wire lines
 * arrive. The adapter read that as CLI_ERROR and the ladder re-issued the
 * WHOLE full-context call.
 *
 * MEASURED on the 13.11.5 install: 35 of 187 runs died exactly this way
 * (orient.v7 18, decide 9, critic.v5 8), 542K tokens and $0.43 burned on
 * preambles, and every one of them fed the S0.7 consecutive-failure counter.
 *
 * Two is a CEILING, never a target: a model that finishes in one turn still
 * uses one, and a caller cannot raise it — plain completion still owns its own
 * turn budget. The cost of the second turn (when it happens) is a cache READ of
 * the pack at 0.1x, against a full re-issue that pays cache CREATION at 1.25x
 * plus a second admitted call. Cheaper, strictly. The rest of the bare-call
 * contract — every tool denied, MAX_THINKING_TOKENS=0, neutral settings,
 * --max-budget-usd — still bounds the run.
 */
export const PLAIN_COMPLETION_MAX_TURNS = 2;

/**
 * Directories the CLI must never be pointed at (arch §4.1.4). macOS protects
 * ~/Documents, ~/Desktop and ~/Downloads with TCC; a child of the ad-hoc-signed
 * .app that starts its scan there blocks in a single openat() with NO output
 * until the run times out. Everything falls back to tmpdir().
 */
const TCC_PROTECTED_DIRS = ["Documents", "Desktop", "Downloads"];

/** The cwd a run may actually use: the caller's, unless it is TCC-protected. */
export function safeCwd(cwd?: string | null): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return tmpdir();
  const wanted = resolvePath(cwd);
  const home = process.env.HOME ?? homedir();
  for (const dir of TCC_PROTECTED_DIRS) {
    const protectedRoot = join(home, dir);
    if (wanted === protectedRoot || wanted.startsWith(protectedRoot + sep)) {
      return tmpdir();
    }
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Resolve the `claude` executable ROBUSTLY.
//
// A Tauri app launched from Finder inherits a MINIMAL PATH (roughly
// /usr/bin:/bin:/usr/sbin:/sbin) that EXCLUDES ~/.local/bin — where the claude
// standalone binary lives. So we cannot rely on PATH to find `claude`; we probe
// the well-known install locations ourselves, in priority order:
//
//   1. $CLAUDE_BIN / $SUPERTWIN_CLAUDE_BIN  (explicit override — tests, ops)
//   2. ~/.local/bin/claude                  (standalone installer default)
//   3. ~/.claude/local/claude               (legacy/local install)
//   4. /opt/homebrew/bin/claude             (Homebrew, Apple Silicon)
//   5. /usr/local/bin/claude                (Homebrew, Intel / manual)
//   6. "claude"                             (last resort: whatever PATH has)
//
// The chosen path is cached (resolution is stable for the process lifetime).
// We also hand the child an augmented PATH (dir-of-claude prepended) + HOME so
// the CLI can locate its own auth (~/.claude) and any sibling helpers even under
// the minimal Finder PATH.
// ---------------------------------------------------------------------------
let cachedClaudeBin: string | null = null;

export function resolveClaudeBin(): string {
  if (cachedClaudeBin) return cachedClaudeBin;

  const home = process.env.HOME ?? homedir();
  const explicit = process.env.CLAUDE_BIN ?? process.env.SUPERTWIN_CLAUDE_BIN;
  const candidates = [
    explicit,
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  for (const c of candidates) {
    if (c && existsSync(c)) {
      cachedClaudeBin = c;
      return c;
    }
  }

  // Nothing on disk matched — fall back to bare "claude" and let PATH resolve it
  // (works in dev shells; may fail under a minimal Finder PATH).
  cachedClaudeBin = "claude";
  return cachedClaudeBin;
}

/**
 * Build the child env: pass through the parent env, but PREPEND the directory
 * that holds the resolved `claude` to PATH (so the binary — and any helpers it
 * shells out to — are reachable), ensure HOME is set (so `claude` finds
 * ~/.claude auth), and make PWD agree with the directory we actually spawn in.
 * Only touches PATH/HOME/PWD/OLDPWD; everything else is inherited.
 *
 * WHY PWD MATTERS (this cost a whole debugging session — do not drop it).
 * `spawn` sets the child's real cwd but does NOT touch the inherited `PWD`
 * env var, and the CLI trusts `PWD` over `getcwd()`. The worker inherits the
 * .app's environment, whose PWD is wherever the app was launched from — for a
 * dev launch that is the repo, i.e. ~/Documents/…. So a chat turn ran with
 * cwd=tmpdir() but told the CLI its project directory was ~/Documents/…
 *
 * On macOS ~/Documents, ~/Desktop and ~/Downloads are TCC-protected, and a
 * child of the .app is attributed to the .app (ad-hoc signed, no Full Disk
 * Access). The CLI's startup scan of `PWD` then blocked in a single openat()
 * FOREVER — no stdout, no stderr, no network socket — until the provider's
 * 120s/180s timeout killed it. Measured against the running .app: PWD =
 * ~/Documents/… or ~/Desktop → hangs to the timeout every time; PWD = the real
 * cwd, or any non-protected path → completes in ~5s.
 *
 * Setting PWD = the spawn cwd is exactly what a shell does before exec, and is
 * the reason a hand-run of the identical argv from a terminal never reproduced.
 */
export function buildChildEnv(
  resolvedClaude: string,
  plainCompletion = false,
  cwd?: string,
  thinkingBudget?: ThinkingBudget,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const home = env.HOME ?? homedir();
  env.HOME = home;
  // If we resolved an absolute path, prepend its dir so PATH-based lookups work.
  if (resolvedClaude !== "claude") {
    const binDir = dirname(resolvedClaude);
    env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
  }
  // The child's PWD must name the directory it is actually spawned in. An
  // inherited PWD pointing somewhere else is worse than absent: see above.
  if (typeof cwd === "string" && cwd.length > 0) {
    env.PWD = cwd;
    // OLDPWD describes a shell's previous directory. We are not a shell, and a
    // stale value is another protected path the CLI could be pointed at.
    delete env.OLDPWD;
  }
  // Extended thinking. An explicit budget always wins (§4.3 ladder); otherwise
  // plain completion pins it to 0, because a large extraction prompt triggers
  // unbounded thinking that never yields an answer (verified). An inherited
  // MAX_THINKING_TOKENS is never allowed to leak into an extraction call.
  if (thinkingBudget) {
    env.MAX_THINKING_TOKENS = String(THINKING_BUDGET_TOKENS[thinkingBudget]);
  } else if (plainCompletion) {
    env.MAX_THINKING_TOKENS = "0";
  }
  // Transport stage 1 (S0.4, T1-1, SPD-05): the CLI writes its prompt cache
  // at the 1-HOUR TTL by default, billed at 2.0x a fresh input token — and
  // every call here is a fresh single-turn session, so those entries were
  // written on every call and read back never. The 5-minute TTL bills at
  // 1.25x. Always set, never inherited: a stray "1h" in the parent env would
  // silently restore the 60% surcharge.
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = PROMPT_CACHE_TTL;
  return env;
}

/**
 * Build the `claude` CLI argv for one invocation. Pure + exported so the
 * plain-completion flag combination can be asserted in unit tests without
 * spawning a process.
 *
 * TRANSPORT STAGE 1+2 (S0.4; backlog T1-1/T1-2; Product_V6_Phase1 §23.1),
 * verified against `claude --help` 2.1.251 — every flag below exists:
 *   --safe-mode              all customisations off: CLAUDE.md, skills,
 *                            plugins, hooks, MCP servers, commands, agents.
 *                            Built-in tools, auth, model selection unaffected.
 *   --strict-mcp-config      only MCP servers from --mcp-config — and we pass
 *                            none, so ZERO servers: the user's connector names
 *                            stop shipping to the model on every call.
 *   --max-budget-usd <n>     the per-call ceiling (Product §23.3 "per call").
 *   --no-session-persistence nothing written to ~/.claude/projects for a call
 *                            nobody will ever resume (every pipeline pass).
 *                            Only on --print; incompatible with a later
 *                            --resume, so chat opts out via persistSession.
 * On every invocation, plain or not: the door is one door.
 */
export function buildCliArgs(opts: {
  allowedTools: string[];
  resumeId?: string | null;
  appendSystemPrompt?: string;
  maxTurns?: number;
  plainCompletion?: boolean;
  skipUserSettings?: boolean;
  model?: string;
  effort?: string;
  /**
   * Keep the session on disk so a later call can `--resume` it. Default: the
   * inverse of plainCompletion — a bare pass never resumes; anything else
   * (chat) keeps the behaviour it always had unless it says otherwise.
   */
  persistSession?: boolean;
  /** Per-call spend ceiling → `--max-budget-usd`. Omitted/non-finite: no flag. */
  maxBudgetUsd?: number;
}): string[] {
  const {
    allowedTools,
    resumeId,
    appendSystemPrompt,
    maxTurns,
    plainCompletion,
    skipUserSettings,
    model,
    effort,
    persistSession,
    maxBudgetUsd,
  } = opts;
  const cliArgs = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Stage 2: no customisations, no MCP servers — see the doc comment.
    "--safe-mode",
    "--strict-mcp-config",
    // allowedTools takes one arg; empty string = no tools allowed. A bare
    // extraction call grants NOTHING regardless of what the caller passed —
    // agent calls (the one exception, §4.1.5) are not plainCompletion.
    "--allowedTools",
    plainCompletion ? "" : allowedTools.join(","),
  ];
  if (plainCompletion) {
    // Hard tool denial (--allowedTools "" alone is NOT enough) + a single turn.
    // Combined with MAX_THINKING_TOKENS=0 in the child env and the neutral
    // settings below, this keeps the call a bounded JSON completion that
    // cannot wander.
    cliArgs.push("--disallowedTools", PLAIN_DISALLOWED_TOOLS);
  }
  // Neutral settings: do not load the user's/project's CLAUDE.md, hooks or
  // settings. Implied by plain completion, and worth ~6k input tokens on its
  // own for a tool-using call that has nothing to do with the user's code.
  if (plainCompletion || skipUserSettings) {
    cliArgs.push("--setting-sources", "");
  }
  // Model selection: only when a non-empty trimmed id is present. Empty/
  // undefined pushes NOTHING → the CLI uses the subscription default, keeping
  // behavior byte-identical to before the picker (eval-safe).
  if (typeof model === "string" && model.trim().length > 0) {
    cliArgs.push("--model", model.trim());
  }
  // Reasoning level, for the models that take one. Only ever pushed when the
  // caller resolved it against the model's own capabilities (settings-routes
  // reads them out of the CLI's catalogue), so a model with no `--effort`
  // never sees the flag; omitted, the argv is what it always was.
  if (typeof effort === "string" && EFFORT_LEVELS.includes(effort)) {
    cliArgs.push("--effort", effort);
  }
  // Stage 1: the per-call ceiling. Only a finite positive amount is a ceiling;
  // anything else means the caller declined to set one.
  if (typeof maxBudgetUsd === "number" && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    cliArgs.push("--max-budget-usd", String(maxBudgetUsd));
  }
  // Stage 1: do not persist a session nobody will resume. A resume names an
  // existing on-disk session and must keep writing to it, so the flag is
  // never combined with --resume.
  const keepSession = persistSession ?? !plainCompletion;
  if (!keepSession && !resumeId) cliArgs.push("--no-session-persistence");
  if (resumeId) cliArgs.push("--resume", resumeId);
  // The instruction block goes on argv ONCE (T1-1). It used to be repeated at
  // the head of stdin as well — the cache-miss half of the bill.
  if (appendSystemPrompt && appendSystemPrompt.length) {
    cliArgs.push("--append-system-prompt", appendSystemPrompt);
  }
  // Plain completion sets its OWN turn budget and a caller cannot raise it —
  // that part of the bare-call contract is unchanged. Only the number moved,
  // from 1 to PLAIN_COMPLETION_MAX_TURNS (FIX-C2): see the constant for what
  // one turn cost.
  const effectiveMaxTurns = plainCompletion ? PLAIN_COMPLETION_MAX_TURNS : maxTurns;
  if (typeof effectiveMaxTurns === "number") {
    cliArgs.push("--max-turns", String(effectiveMaxTurns));
  }
  return cliArgs;
}

/** RFC-4122-ish UUID (any version). Guards resume against garbage ids. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}
