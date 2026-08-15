// ===========================================================================
// The Claude CLI adapter (Paperclip-style). Implements the Provider contract
// on top of the local `claude` binary. See docs/PHASE0_ARCHITECTURE.md §4.
//
// VERIFIED CLI INVOCATION (claude 2.1.197):
//   fresh:  claude --print --output-format stream-json --verbose \
//               --include-partial-messages --allowedTools <csv> \
//               [--append-system-prompt-file? see below] [--max-turns N]
//           <prompt on STDIN>
//   resume: claude --print --output-format stream-json --verbose \
//               --include-partial-messages --allowedTools <csv> \
//               --resume <uuid> [--max-turns N]
//           <prompt on STDIN>
//
// Flag notes (confirmed against `claude --help`):
//   --print / -p           non-interactive; disallowed tools denied silently.
//   --output-format stream-json  REQUIRES --verbose alongside --print.
//   --include-partial-messages   streams content_block_delta events (token-by-
//                                token). Enabled so the UI streams live text.
//   --allowedTools <tools...>    space/comma-separated whitelist. We pass "" for
//                                plain chat (NO tools; NO --dangerously-skip...).
//   --resume <uuid> (-r)         resume a prior session. NOT combined with a
//                                system-prompt file (token economy; the session
//                                already carries those instructions).
//   --max-turns N                cap agent turns.
//   --setting-sources ""         neutral settings: the user's/project's
//                                CLAUDE.md, hooks and settings are not loaded.
//                                Forced by plainCompletion, and selectable on
//                                its own via skipUserSettings — a media read
//                                otherwise pays ~6,158 input tokens for a global
//                                CLAUDE.md that cannot help describe an image.
//   append-system-prompt: this CLI exposes --append-system-prompt <text> but
//     NOT a *-file variant (verified: no --append-system-prompt-file). So we
//     read systemPromptFile ourselves and pass its contents via
//     --append-system-prompt, FRESH SESSIONS ONLY.
//
// POISON detection: a resume of a nonexistent/expired session exits 0 but emits
// a result with is_error:true, num_turns:0, errors:["No conversation found..."]
// (see parser.isPoisonResult). On poison we mark freshFallback and transparently
// re-run the SAME message as a fresh session — the caller sees a normal stream.
// ===========================================================================

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  SendOptions,
  Usage,
} from "../types.js";
import { emptyUsage, hasSpend, sumUsage } from "../usage.js";
import {
  StreamJsonParser,
  isPoisonResult,
  type ParsedResult,
} from "./parser.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
/** Bound on retained stderr — enough to explain a failure, not enough to grow. */
const STDERR_TAIL_CHARS = 8192;

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
  // Plain-completion: disable extended thinking. A large extraction prompt
  // otherwise triggers unbounded thinking that never yields JSON (verified).
  if (plainCompletion) {
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
}): string[] {
  const {
    allowedTools,
    resumeId,
    appendSystemPrompt,
    maxTurns,
    plainCompletion,
    skipUserSettings,
    model,
  } = opts;
  const cliArgs = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // allowedTools takes one arg; empty string = no tools allowed.
    "--allowedTools",
    allowedTools.join(","),
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

/** Internal record of a live child so cancel()/cleanup can find it. */
interface LiveRun {
  child: ChildProcessWithoutNullStreams;
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  /** Set when we intentionally kill (cancel/timeout) to shape the error code. */
  killReason?: "CANCELLED" | "TIMEOUT";
  onAbort?: () => void;
  signal?: AbortSignal;
}

/** Outcome of a single spawn attempt (one CLI invocation). */
interface RunAttempt {
  usage: Usage;
  finalSessionId: string | null;
  result: ParsedResult | null;
  /** A hard failure to even run the process (spawn/timeout/cancel/exit). */
  failure?: { code: ProviderResultErrorCode; message: string };
}

type ProviderResultErrorCode = NonNullable<ProviderResult["errorCode"]>;

class ClaudeLocalProvider implements Provider {
  readonly id = "claude-local";

  /** runId -> live child, so cancel() can reach in-flight processes. */
  private readonly live = new Map<string, LiveRun>();

  cancel(runId: string): boolean {
    const run = this.live.get(runId);
    if (!run) return false;
    run.killReason = "CANCELLED";
    this.killChild(run);
    return true;
  }

  async send(opts: SendOptions): Promise<ProviderResult> {
    const {
      runId,
      message,
      sessionId,
      cwd,
      allowedTools = [],
      systemPromptFile,
      maxTurns,
      plainCompletion = false,
      skipUserSettings = false,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      model,
      onEvent,
      signal,
    } = opts;

    const runCwd = cwd && cwd.length ? cwd : tmpdir();

    // Read the system prompt ONCE (fresh sessions only). If unreadable, we
    // proceed without it rather than failing the whole send.
    let systemPrompt: string | undefined;
    if (systemPromptFile) {
      try {
        systemPrompt = await readFile(systemPromptFile, "utf8");
      } catch {
        systemPrompt = undefined;
      }
    }

    // Decide whether to attempt a resume. Only when the caller gave a
    // well-formed UUID. (cwd/bundle mismatch is enforced by the server BEFORE
    // calling us — it simply omits sessionId. We still hard-guard the format.)
    const wantResume = isValidSessionId(sessionId);
    let freshFallback = false;

    // ---- Attempt 1: resume (if requested) or fresh.
    let attempt = await this.runOnce({
      runId,
      message,
      resumeId: wantResume ? (sessionId as string) : null,
      cwd: runCwd,
      allowedTools,
      // system prompt ONLY on a fresh (non-resume) run.
      appendSystemPrompt: wantResume ? undefined : systemPrompt,
      maxTurns,
      plainCompletion,
      skipUserSettings,
      model,
      timeoutMs,
      onEvent,
      signal,
      emitEvents: true,
    });

    // ---- Poison handling: a resume that came back as a resume-miss. Re-run the
    // same message as a fresh session, transparently, and stream THAT to the
    // caller (a fresh `session` event with the new id).
    if (
      wantResume &&
      attempt.result &&
      isPoisonResult(attempt.result) &&
      !attempt.failure
    ) {
      freshFallback = true;
      const deadResumeSpend = attempt.usage;
      attempt = await this.runOnce({
        runId,
        message,
        resumeId: null,
        cwd: runCwd,
        allowedTools,
        appendSystemPrompt: systemPrompt, // fresh => system prompt allowed
        maxTurns,
        plainCompletion,
        skipUserSettings,
        model,
        timeoutMs,
        onEvent,
        signal,
        emitEvents: true,
      });
      // The dead resume burned whatever it burned before failing; the retry is
      // additional spend, not a replacement for it.
      attempt.usage = sumUsage(deadResumeSpend, attempt.usage);
    }

    // ---- Build ProviderResult + emit terminal events.
    return this.finalize(attempt, freshFallback, onEvent);
  }

  // -------------------------------------------------------------------------
  // One CLI invocation. Spawns, pipes the message to stdin, parses stdout,
  // guarantees the child is reaped. Never throws — failures become
  // attempt.failure so the caller can decide fallback vs. surface.
  // -------------------------------------------------------------------------
  private runOnce(args: {
    runId: string;
    message: string;
    resumeId: string | null;
    cwd: string;
    allowedTools: string[];
    appendSystemPrompt?: string;
    maxTurns?: number;
    plainCompletion?: boolean;
    skipUserSettings?: boolean;
    model?: string;
    timeoutMs: number;
    onEvent: (e: ProviderStreamEvent) => void;
    signal?: AbortSignal;
    emitEvents: boolean;
  }): Promise<RunAttempt> {
    const {
      runId,
      message,
      resumeId,
      cwd,
      allowedTools,
      appendSystemPrompt,
      maxTurns,
      plainCompletion,
      skipUserSettings,
      model,
      timeoutMs,
      onEvent,
      signal,
      emitEvents,
    } = args;

    return new Promise<RunAttempt>((resolve) => {
      // Already aborted before we started? Bail without spawning.
      if (signal?.aborted) {
        resolve({
          usage: emptyUsage(),
          finalSessionId: null,
          result: null,
          failure: { code: "CANCELLED", message: "aborted before start" },
        });
        return;
      }

      const cliArgs = buildCliArgs({
        allowedTools,
        resumeId,
        appendSystemPrompt,
        maxTurns,
        plainCompletion,
        skipUserSettings,
        model,
      });

      let child: ChildProcessWithoutNullStreams;
      try {
        const claudeBin = resolveClaudeBin();
        child = spawn(claudeBin, cliArgs, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          // cwd is passed twice on purpose: to spawn (the real working
          // directory) and to buildChildEnv (so PWD names that same directory).
          env: buildChildEnv(claudeBin, plainCompletion, cwd),
        });
      } catch (err) {
        resolve({
          usage: emptyUsage(),
          finalSessionId: null,
          result: null,
          failure: {
            code: "SPAWN_FAILED",
            message: `spawn failed: ${(err as Error).message}`,
          },
        });
        return;
      }

      const parser = new StreamJsonParser();
      const run: LiveRun = { child, signal };
      this.live.set(runId, run);

      let finalSessionId: string | null = null;
      let result: ParsedResult | null = null;
      let emittedAnyDelta = false;
      let stderrBuf = "";
      let settled = false;

      // The result line already totals the whole run, so it stands alone. When
      // the run is killed before it arrives (timeout/cancel), or comes back
      // reporting nothing despite turns having happened, fall back to what the
      // parser accumulated — real spend must never be recorded as 0.
      const runUsage = (): Usage =>
        result && hasSpend(result.usage) ? result.usage : parser.usageSoFar();

      const finish = (attempt: RunAttempt) => {
        if (settled) return;
        settled = true;
        this.reap(runId, run);
        resolve(attempt);
      };

      // ---- Abort wiring (server /api/cancel or caller AbortSignal).
      if (signal) {
        const onAbort = () => {
          run.killReason = "CANCELLED";
          this.killChild(run);
        };
        run.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // ---- Per-run timeout.
      run.timeoutTimer = setTimeout(() => {
        run.killReason = "TIMEOUT";
        this.killChild(run);
      }, timeoutMs);

      // ---- stdout -> parser -> events.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const parsed = parser.push(chunk);
        if (parsed.emittedDelta) emittedAnyDelta = true;
        for (const ev of parsed.events) {
          if (ev.type === "session") finalSessionId = ev.sessionId;
          // With partials ON, the terminal `assistant` block duplicates text
          // already streamed as deltas. Suppress that duplicate; keep tool_use.
          if (
            ev.type === "delta" &&
            emittedAnyDelta &&
            !parsed.emittedDelta
          ) {
            continue;
          }
          if (emitEvents) onEvent(ev);
        }
        if (parsed.result) {
          result = parsed.result;
          if (parsed.result.sessionId) finalSessionId = parsed.result.sessionId;
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > STDERR_TAIL_CHARS)
          stderrBuf = stderrBuf.slice(-STDERR_TAIL_CHARS);
      });

      // Ignore EPIPE if the child exits before we finish writing stdin.
      child.stdin.on("error", () => {});
      child.stdout.on("error", () => {});
      child.on("error", (err) => {
        finish({
          usage: runUsage(),
          finalSessionId,
          result,
          failure: {
            code: "SPAWN_FAILED",
            message: `child error: ${(err as Error).message}`,
          },
        });
      });

      child.on("close", (code, signal) => {
        // Drain any buffered trailing line.
        const tail = parser.flush();
        for (const ev of tail.events) {
          if (ev.type === "session") finalSessionId = ev.sessionId;
          if (emitEvents && ev.type !== "delta") onEvent(ev);
        }
        if (tail.result) {
          result = tail.result;
          if (tail.result.sessionId) finalSessionId = tail.result.sessionId;
        }

        // Intentional kills first (cancel/timeout) — these override exit code.
        if (run.killReason === "CANCELLED") {
          finish({
            usage: runUsage(),
            finalSessionId,
            result,
            failure: { code: "CANCELLED", message: "run cancelled" },
          });
          return;
        }
        if (run.killReason === "TIMEOUT") {
          // Carry the child's last words. A timeout that says only "exceeded
          // 120000ms" gives nothing to work with — the chat-hang investigation
          // cost hours precisely because this branch dropped stderr.
          const tail = stderrBuf.trim().slice(-STDERR_TAIL_CHARS);
          finish({
            usage: runUsage(),
            finalSessionId,
            result,
            failure: {
              code: "TIMEOUT",
              message: tail
                ? `run exceeded ${timeoutMs}ms: ${tail}`
                : `run exceeded ${timeoutMs}ms`,
            },
          });
          return;
        }

        // A poison result exits 0 with is_error — NOT a process failure. Let the
        // caller (send) inspect result via isPoisonResult and fall back.
        // Only treat a genuinely broken exit (non-zero without a usable result)
        // as CLI_ERROR.
        if ((code !== 0 || signal) && !result) {
          const msg =
            stderrBuf.trim() ||
            `claude exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
          finish({
            usage: runUsage(),
            finalSessionId,
            result,
            failure: { code: "CLI_ERROR", message: msg },
          });
          return;
        }

        finish({ usage: runUsage(), finalSessionId, result });
      });

      // ---- Write the user message to stdin, then close it.
      try {
        child.stdin.write(message, "utf8");
        child.stdin.end();
      } catch {
        // EPIPE etc.: the close handler will report the real failure.
      }
    });
  }

  // -------------------------------------------------------------------------
  // Turn the final attempt into a ProviderResult and emit `done` / `error`.
  // -------------------------------------------------------------------------
  private finalize(
    attempt: RunAttempt,
    freshFallback: boolean,
    onEvent: (e: ProviderStreamEvent) => void,
  ): ProviderResult {
    const sessionId = attempt.finalSessionId ?? "";

    if (attempt.failure) {
      onEvent({
        type: "error",
        code: attempt.failure.code,
        message: attempt.failure.message,
        sessionId: sessionId || undefined,
      });
      return {
        sessionId,
        usage: attempt.usage,
        freshFallback,
        status: "error",
        errorCode: attempt.failure.code,
      };
    }

    // A result with is_error that WASN'T poison-fallen-back (e.g. an API error
    // mid-turn). Surface as CLI_ERROR.
    if (attempt.result && attempt.result.isError) {
      const message =
        (attempt.result.errors ?? []).join("; ") || "claude reported an error";
      onEvent({
        type: "error",
        code: "CLI_ERROR",
        message,
        sessionId: sessionId || undefined,
      });
      return {
        sessionId,
        usage: attempt.usage,
        freshFallback,
        status: "error",
        errorCode: "CLI_ERROR",
      };
    }

    onEvent({
      type: "done",
      sessionId,
      usage: attempt.usage,
      stopReason: attempt.result?.stopReason,
    });
    return {
      sessionId,
      usage: attempt.usage,
      freshFallback,
      status: "ok",
    };
  }

  // -------------------------------------------------------------------------
  // Process hygiene. killChild: SIGTERM now, SIGKILL after a grace. reap:
  // clear timers, detach abort listener, drop from the live map. Together these
  // guarantee no orphaned `claude` processes on done/error/timeout/cancel.
  // -------------------------------------------------------------------------
  private killChild(run: LiveRun): void {
    const { child } = run;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, KILL_GRACE_MS);
      run.killTimer.unref?.();
    }
  }

  private reap(runId: string, run: LiveRun): void {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.killTimer) clearTimeout(run.killTimer);
    if (run.signal && run.onAbort) {
      run.signal.removeEventListener("abort", run.onAbort);
    }
    // Belt-and-suspenders: if somehow still alive, hard-kill on the way out.
    const c = run.child;
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.live.delete(runId);
  }

  /** Kill EVERY in-flight child (used by the worker on SIGINT/SIGTERM). */
  killAll(): void {
    for (const [, run] of this.live) {
      run.killReason = run.killReason ?? "CANCELLED";
      this.killChild(run);
    }
  }
}

export const claudeLocalProvider = new ClaudeLocalProvider();
export default claudeLocalProvider;
