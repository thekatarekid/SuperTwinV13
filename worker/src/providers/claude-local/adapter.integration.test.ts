// Integration tests for the claude-local adapter — these spawn the REAL
// `claude` CLI (installed + authed on this machine). Kept short but exercise
// the load-bearing guarantees: streaming, resume-context, cwd-change-fresh,
// poison fallback, cancel, and 0 orphaned processes.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { claudeLocalProvider } from "./index.js";
import { billableTokens } from "../usage.js";
import type { ProviderStreamEvent } from "../types.js";

// Real-CLI turns are slow; give them room.
const TURN_TIMEOUT = 90_000;

/** Poll until `cond` holds; throws rather than hanging to the suite timeout. */
async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Count live `claude` processes (excludes this test's grep/node itself). */
function countClaudeProcs(): number {
  try {
    const out = execFileSync(
      "bash",
      ["-c", "pgrep -f '(^|/)claude( |$)' | wc -l"],
      { encoding: "utf8" },
    );
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Collect events + resolve with the final assistant text. */
function drain(events: ProviderStreamEvent[]): {
  types: string[];
  text: string;
  sessionIds: string[];
} {
  const text = events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text)
    .join("");
  const sessionIds = events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "session" }> => e.type === "session")
    .map((e) => e.sessionId);
  return { types: events.map((e) => e.type), text, sessionIds };
}

describe("claude-local adapter (real CLI)", () => {
  beforeAll(() => {
    // Sanity: the CLI must be present, else these tests are meaningless.
    execFileSync("claude", ["--version"], { encoding: "utf8" });
  });

  it(
    "streams delta events and finishes with done + a session id",
    async () => {
      const events: ProviderStreamEvent[] = [];
      const res = await claudeLocalProvider.send({
        runId: "it-stream",
        message: "Reply with exactly: PONG",
        allowedTools: [],
        onEvent: (e) => events.push(e),
      });
      const { types, sessionIds } = drain(events);
      expect(types).toContain("session");
      expect(types).toContain("delta");
      expect(types).toContain("done");
      expect(types).toContain("usage");
      expect(res.status).toBe("ok");
      expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sessionIds[0]).toBe(res.sessionId);
      expect(res.usage.outputTokens).toBeGreaterThan(0);
      // The system prompt and tool schemas are cached, so the real cost of any
      // run lives in the cache fields — inputTokens alone is a rounding error.
      expect(
        res.usage.cacheCreationInputTokens + res.usage.cacheReadInputTokens,
      ).toBeGreaterThan(res.usage.inputTokens);
    },
    TURN_TIMEOUT,
  );

  it(
    "resume preserves context (name recall)",
    async () => {
      const e1: ProviderStreamEvent[] = [];
      const r1 = await claudeLocalProvider.send({
        runId: "it-resume-1",
        message: "My name is Zaphod. Just acknowledge.",
        onEvent: (e) => e1.push(e),
      });
      expect(r1.status).toBe("ok");

      const e2: ProviderStreamEvent[] = [];
      const r2 = await claudeLocalProvider.send({
        runId: "it-resume-2",
        sessionId: r1.sessionId,
        message: "What is my name? Reply with just the name.",
        onEvent: (e) => e2.push(e),
      });
      expect(r2.status).toBe("ok");
      expect(r2.freshFallback).toBe(false);
      // Same conversation => same session id preserved.
      expect(r2.sessionId).toBe(r1.sessionId);
      expect(drain(e2).text.toLowerCase()).toContain("zaphod");
    },
    TURN_TIMEOUT * 2,
  );

  it(
    "resume with a DIFFERENT cwd starts fresh (guard) — the adapter honours the caller",
    async () => {
      // NOTE: the cwd/bundle guard lives in the SERVER (it omits sessionId on
      // mismatch). At the adapter level we verify that a fresh run in a
      // different cwd simply works and yields a NEW session id (i.e. resuming
      // is a caller decision, and fresh is clean). We emulate the server's
      // decision: on cwd change, the server would pass sessionId:null.
      const altCwd = mkdtempSync(join(tmpdir(), "st-cwd-"));
      const e: ProviderStreamEvent[] = [];
      const r = await claudeLocalProvider.send({
        runId: "it-cwd-fresh",
        sessionId: null, // server would null this out on cwd mismatch
        cwd: altCwd,
        message: "Say READY.",
        onEvent: (e2) => e.push(e2),
      });
      expect(r.status).toBe("ok");
      expect(r.freshFallback).toBe(false);
      expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    },
    TURN_TIMEOUT,
  );

  it(
    "invalid/garbage sessionId falls back to fresh (no throw, freshFallback true)",
    async () => {
      const events: ProviderStreamEvent[] = [];
      // Well-formed but nonexistent UUID => CLI resume-miss => poison => fresh.
      const res = await claudeLocalProvider.send({
        runId: "it-poison",
        sessionId: "00000000-0000-4000-8000-000000000000",
        message: "Reply with exactly: RECOVERED",
        onEvent: (e) => events.push(e),
      });
      const { types, sessionIds } = drain(events);
      expect(res.status).toBe("ok");
      expect(res.freshFallback).toBe(true);
      // A NEW, real session id was produced (not the garbage one).
      expect(res.sessionId).not.toBe("00000000-0000-4000-8000-000000000000");
      expect(sessionIds.at(-1)).toBe(res.sessionId);
      expect(types).toContain("delta");
      expect(types).toContain("done");
    },
    TURN_TIMEOUT,
  );

  it(
    "a malformed (non-UUID) sessionId is treated as fresh (never resumed)",
    async () => {
      const res = await claudeLocalProvider.send({
        runId: "it-badformat",
        sessionId: "not-a-uuid",
        message: "Say OK.",
        onEvent: () => {},
      });
      expect(res.status).toBe("ok");
      // Non-UUID never even attempts resume, so this is NOT a fallback.
      expect(res.freshFallback).toBe(false);
    },
    TURN_TIMEOUT,
  );

  it(
    "cancel() kills a run mid-flight and reports CANCELLED",
    async () => {
      const events: ProviderStreamEvent[] = [];
      const runId = "it-cancel";
      const p = claudeLocalProvider.send({
        runId,
        message:
          "Write a long, slow 500-word essay about the history of tea. Take your time.",
        onEvent: (e) => events.push(e),
      });
      // Cancel once the turn is genuinely under way (first token out).
      await waitFor(() => events.some((e) => e.type === "delta"));
      const killed = claudeLocalProvider.cancel(runId);
      expect(killed).toBe(true);
      const res = await p;
      expect(res.status).toBe("error");
      expect(res.errorCode).toBe("CANCELLED");
      expect(events.some((e) => e.type === "error" && e.code === "CANCELLED")).toBe(
        true,
      );
      // A killed run never reaches the result line; it must still report the
      // turn it was in rather than a free 0.
      expect(res.usage.cacheReadInputTokens).toBeGreaterThan(0);
      expect(billableTokens(res.usage)).toBeGreaterThan(0);
    },
    TURN_TIMEOUT,
  );

  it(
    "leaves 0 orphaned claude processes after a batch of runs",
    async () => {
      const before = countClaudeProcs();
      for (let i = 0; i < 4; i++) {
        await claudeLocalProvider.send({
          runId: `it-batch-${i}`,
          message: `Reply with the number ${i}.`,
          onEvent: () => {},
        });
      }
      // Give SIGTERM/close handlers a beat to reap.
      await new Promise((r) => setTimeout(r, 500));
      const after = countClaudeProcs();
      // Compare deltas: the parent Claude Code process (running this test) is
      // counted in both, so the batch must not INCREASE the count.
      expect(after).toBeLessThanOrEqual(before);
    },
    TURN_TIMEOUT * 4,
  );
});
