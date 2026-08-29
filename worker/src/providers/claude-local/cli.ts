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
 * The levels `claude --effort` accepts. "off" is deliberately absent: the CLI
 * has no "no effort" level, so a step set to off simply passes no flag (and
 * plain completion still pins MAX_THINKING_TOKENS to 0).
 */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

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

/**
 * The instruction block is passed TWICE (arch §4.1.1): once as
 * `--append-system-prompt` and once as the head of stdin. The CLI exposes no
 * `--system-prompt` replace flag, and `--append-system-prompt` is dropped on a
 * resume — so putting the same block at the head of stdin is what guarantees
 * the model actually sees it. The prompt itself never goes on argv.
 */
export function composeStdinMessage(
  instructions: string | undefined,
  message: string,
): string {
  const head = instructions?.trim();
  if (!head) return message;
  return `${head}\n\n${message}`;
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
  return env;
}

/**
 * Build the `claude` CLI argv for one invocation. Pure + exported so the
 * plain-completion flag combination can be asserted in unit tests without
 * spawning a process.
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
  } = opts;
  const cliArgs = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
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
  if (resumeId) cliArgs.push("--resume", resumeId);
  if (appendSystemPrompt && appendSystemPrompt.length) {
    cliArgs.push("--append-system-prompt", appendSystemPrompt);
  }
  // Plain-completion forces a single turn; otherwise honour the caller.
  const effectiveMaxTurns = plainCompletion ? 1 : maxTurns;
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
