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
// THE BARE-CALL CONTRACT (arch §4.1). Every extraction call is a bare
// instrument, isolated by STARVING the default context rather than by any
// replace flag — there is no `--system-prompt`, only `--append-system-prompt`:
//   --setting-sources ""   no CLAUDE.md, skills, hooks, MCP, plugins
//   --disallowedTools …    all 13 built-ins
//   --allowedTools ""      nothing granted, whatever the caller passed
//   --max-turns 1          one turn
//   MAX_THINKING_TOKENS=0  no extended thinking (§4.3 ladder, default `off`)
//   cwd = tmpdir()         never a TCC-protected directory (§4.1.4)
// and the instruction block goes in TWICE — as --append-system-prompt (dropped
// by the CLI on --resume) and as the head of stdin. All levers are required
// together: with only --allowedTools "" a ~35 KB prompt produced 62 runaway
// thinking blocks, no text and no result, killed at the timeout.
//
// POISON detection: a resume of a nonexistent/expired session exits 0 but emits
// a result with is_error:true, num_turns:0, errors:["No conversation found..."]
// (see parser.isPoisonResult). On poison we mark freshFallback and transparently
// re-run the SAME message as a fresh session — the caller sees a normal stream.
// ===========================================================================

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  SendOptions,
  ThinkingBudget,
  Usage,
} from "../types.js";
import { emptyUsage, hasSpend, sumUsage } from "../usage.js";
import {
  StreamJsonParser,
  isPoisonResult,
  type ParsedResult,
} from "./parser.js";

import {
  buildChildEnv,
  buildCliArgs,
  composeStdinMessage,
  isValidSessionId,
  resolveClaudeBin,
  safeCwd,
} from "./cli.js";
import {
  assertTraceContext,
  recordProviderInvocation,
} from "../../traces/context.js";

// The shaping half of the adapter lives in ./cli.ts; re-exported here so the
// adapter stays one import for callers and tests.
export {
  buildChildEnv,
  buildCliArgs,
  composeStdinMessage,
  isValidSessionId,
  resolveClaudeBin,
  safeCwd,
  THINKING_BUDGET_TOKENS,
} from "./cli.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
/** Bound on retained stderr — enough to explain a failure, not enough to grow. */
const STDERR_TAIL_CHARS = 8192;

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
      thinkingBudget,
      effort,
      duplicateInstructions,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      model,
      onEvent,
      signal,
    } = opts;

    // TRC-01 (build P0.7): this is the SINGLE spawn site — a call reaching it
    // without a trace context is a ghost call. Throws in dev, before anything
    // spawns; production falls through to the ghost-write in
    // recordProviderInvocation instead of crashing.
    assertTraceContext(`claude-local run ${runId}`);

    // Never ~/Documents, ~/Desktop or ~/Downloads (§4.1.4).
    const runCwd = safeCwd(cwd);

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

    // The instruction block goes in twice on a fresh bare call — once as
    // --append-system-prompt, once as the head of stdin (§4.1.1). A resume
    // already carries it, and chat keeps the single copy it always had.
    const twice = duplicateInstructions ?? plainCompletion;
    const freshMessage = twice
      ? composeStdinMessage(systemPrompt, message)
      : message;

    // Every CLI invocation records a trace (build P0.7): tap the delta stream
    // for the raw output, time the invocation, and hand the whole thing to the
    // active trace scope (or the ghost fallback) when it settles.
    const modelId =
      typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
    let attemptNo = 0;
    const tracedRunOnce = async (
      args: Parameters<ClaudeLocalProvider["runOnce"]>[0],
    ): Promise<RunAttempt> => {
      attemptNo += 1;
      const thisAttempt = attemptNo;
      const startedMs = Date.now();
      const ts = new Date().toISOString();
      let raw = "";
      const attempt = await this.runOnce({
        ...args,
        onEvent: (ev) => {
          if (ev.type === "delta") raw += ev.text;
          args.onEvent(ev);
        },
      });
      recordProviderInvocation({
        runId,
        attempt: thisAttempt,
        model: modelId,
        systemPrompt: systemPrompt ?? null,
        packedContext: args.message,
        rawOutput: raw,
        usage: attempt.usage,
        latencyMs: Date.now() - startedMs,
        status: attempt.failure ? attempt.failure.code : "ok",
        ts,
      });
      return attempt;
    };

    // ---- Attempt 1: resume (if requested) or fresh.
    let attempt = await tracedRunOnce({
      runId,
      message: wantResume ? message : freshMessage,
      resumeId: wantResume ? (sessionId as string) : null,
      cwd: runCwd,
      allowedTools,
      // system prompt ONLY on a fresh (non-resume) run.
      appendSystemPrompt: wantResume ? undefined : systemPrompt,
      maxTurns,
      plainCompletion,
      skipUserSettings,
      thinkingBudget,
      effort,
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
      attempt = await tracedRunOnce({
        runId,
        message: freshMessage,
        resumeId: null,
        cwd: runCwd,
        allowedTools,
        appendSystemPrompt: systemPrompt, // fresh => system prompt allowed
        maxTurns,
        plainCompletion,
        skipUserSettings,
        thinkingBudget,
        effort,
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
    thinkingBudget?: ThinkingBudget;
    effort?: Exclude<ThinkingBudget, "off">;
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
      thinkingBudget,
      effort,
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
        effort,
      });

      let child: ChildProcessWithoutNullStreams;
      try {
        const claudeBin = resolveClaudeBin();
        child = spawn(claudeBin, cliArgs, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          // cwd is passed twice on purpose: to spawn (the real working
          // directory) and to buildChildEnv (so PWD names that same directory).
          env: buildChildEnv(claudeBin, plainCompletion, cwd, thinkingBudget),
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
          if (this.isDuplicateText(ev, parsed, emittedAnyDelta)) continue;
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
          if (this.isDuplicateText(ev, tail, emittedAnyDelta)) continue;
          if (emitEvents) onEvent(ev);
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

  /**
   * With `--include-partial-messages` (always on) the terminal `assistant`
   * line restates text the caller has already been streamed token by token, so
   * that copy is dropped. The test is PER EVENT — "did the parser decode this
   * one from an assistant line?" — not per chunk.
   *
   * It used to be per chunk (`!parsed.emittedDelta`), and `parser.push()`
   * decodes every NDJSON line of a chunk into a single ParseOutput. Whenever
   * the CLI's last `content_block_delta` lines and its terminal `assistant`
   * line landed in ONE stdout chunk, the chunk-wide flag was true and the
   * duplicate escaped — the whole answer emitted twice, glued together. On a
   * marker-delimited media answer the seam ate the copy's opening `@@ID:`,
   * leaving one stray marker: 3 ids read where 2 were sent, a correct answer
   * rejected, split and re-run at real token cost.
   *
   * tool_use from an assistant line is never a duplicate (partials carry it as
   * content_block_start only when streaming), so only text is dropped.
   */
  private isDuplicateText(
    ev: ProviderStreamEvent,
    parsed: { fromAssistantLine?: Set<ProviderStreamEvent> },
    emittedAnyDelta: boolean,
  ): boolean {
    return (
      ev.type === "delta" &&
      emittedAnyDelta &&
      parsed.fromAssistantLine?.has(ev) === true
    );
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
