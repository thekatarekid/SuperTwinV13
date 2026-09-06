// ===========================================================================
// FIX-C2 — what runJsonPass does with a turn-cap stop.
//
// BEFORE: MAX_TURNS arrived as CLI_ERROR, so `dispatch` walked the 2s/10s/30s
// ladder — four full-context calls for one answer — and then quarantined the
// unit. On the user's install that shape accounted for orient.v7 (18 runs),
// decide (9) and critic.v5 (8): a ~1.5x multiplier on an hour that was already
// going to trip the $3 ceiling.
//
// AFTER: the stop is handed back at once. If the streamed bytes parse, they
// ARE the answer — one call, no retry. If they do not, the existing single
// repair round runs, and its ask now names the real cause ("stopped at the
// turn limit") and forbids the preamble that caused it.
//
// Zero live model calls: the provider is a scripted stub.
// ===========================================================================

import { beforeEach, describe, expect, it } from "vitest";

import { BREAKER_FAILURES, ResourcePool, RETRY_DELAYS_MS } from "../providers/pool.js";
import type { Provider, ProviderErrorCode, Usage } from "../providers/types.js";
import type { RecordRunParams } from "../db/run-accounting.js";
import { resetStableSystemPromptsForTests, runJsonPass, type JsonPassDeps } from "./llm.js";

interface Turn {
  text?: string;
  code?: ProviderErrorCode;
  message?: string;
}

const MAX_TURNS_MSG = "Reached maximum number of turns (1)";

function harness(turns: Turn[]) {
  const runs: RecordRunParams[] = [];
  const parked: { errorCode: string; unitId: string }[] = [];
  const messages: string[] = [];
  const slept: number[] = [];
  const usage: Usage = {
    inputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 5,
  };
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      messages.push(opts.message);
      const turn = turns[messages.length - 1] ?? { text: "" };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: turn.message ?? "boom" });
        return { sessionId: "s", usage, freshFallback: false, status: "error" as const, errorCode: turn.code };
      }
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  let t = 0;
  const pool = new ResourcePool({ now: () => t, sleep: async (ms) => { t += ms; } });
  const deps: JsonPassDeps = {
    provider,
    pool,
    recordRun: (p) => { runs.push(p); return p.id ?? "r"; },
    quarantine: (row) => parked.push({ errorCode: row.errorCode, unitId: row.unitId }),
    sleep: async (ms) => { slept.push(ms); },
  };
  return { deps, pool, runs, parked, messages, slept };
}

function spec(over: Record<string, unknown> = {}) {
  return {
    pass: "orient.v7",
    system: "You answer JSON.",
    user: "[PACK] 92 events",
    role: "extract" as const,
    unit: { kind: "bundle", id: "b1" },
    validate: (parsed: unknown) => {
      if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) throw new Error("expected {ok}");
      return parsed as { ok: boolean };
    },
    ...over,
  };
}

beforeEach(() => resetStableSystemPromptsForTests());

describe("runJsonPass on a turn-cap stop", () => {
  it("a preamble costs ONE extra call, not four — and the re-ask names the turn limit", async () => {
    const h = harness([
      { text: "I'm filing 24 events from 7 WhatsApp streams.", code: "MAX_TURNS", message: MAX_TURNS_MSG },
      { text: '{"ok":true}' },
    ]);
    const result = await runJsonPass(spec(), h.deps);

    expect(result.status).toBe("repaired");
    expect(result.output).toEqual({ ok: true });
    // Two calls total. The old path made four (first + the 2s/10s/30s ladder)
    // and then quarantined without ever asking a narrower question.
    expect(h.messages).toHaveLength(2);
    expect(h.slept).toEqual([]);
    expect(h.parked).toEqual([]);
    // The re-ask is NARROW, and it names what actually went wrong.
    expect(h.messages[1]).toContain("stopped at the turn limit");
    expect(h.messages[1]).toContain("Do not announce what you are about to do");
    // The model is still shown its own words, verbatim.
    expect(h.messages[1]).toContain("I'm filing 24 events from 7 WhatsApp streams.");
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(h.runs[0].errorCode).toBe("MAX_TURNS");
  });

  it("a turn cap that still produced the whole answer is SALVAGED — zero extra calls", async () => {
    const h = harness([{ text: '{"ok":true}', code: "MAX_TURNS", message: MAX_TURNS_MSG }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ ok: true });
    expect(h.messages).toHaveLength(1);
    expect(h.runs.map((r) => r.status)).toEqual(["ok"]);
  });

  it("a turn cap on the repair round is salvaged too, not parked", async () => {
    const h = harness([
      { text: "preamble", code: "MAX_TURNS", message: MAX_TURNS_MSG },
      { text: '{"ok":false}', code: "MAX_TURNS", message: MAX_TURNS_MSG },
    ]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(result.output).toEqual({ ok: false });
    expect(h.parked).toEqual([]);
  });

  it("two empty turn caps in a row still quarantine — the fix is not a way to lose work quietly", async () => {
    const h = harness([
      { text: "", code: "MAX_TURNS", message: MAX_TURNS_MSG },
      { text: "", code: "MAX_TURNS", message: MAX_TURNS_MSG },
    ]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(h.parked).toEqual([{ errorCode: "MAX_TURNS", unitId: "b1" }]);
  });

  it("a genuine CLI_ERROR still walks the ladder — nothing else was softened", async () => {
    const h = harness(Array.from({ length: 4 }, () => ({ text: "", code: "CLI_ERROR" as const })));
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(h.messages).toHaveLength(4);
    expect(h.slept).toEqual([...RETRY_DELAYS_MS]);
  });

  it("a lane of nothing but turn caps stays open — the breaker is for lanes that cannot work", async () => {
    // ONE pool across every unit, exactly as the real lane has: the S0.7
    // breaker counts consecutive failures per lane, and ten preambles in a row
    // used to be ten failures. Twelve here, so the old code would have tripped.
    const lane = new ResourcePool();
    for (let i = 0; i < BREAKER_FAILURES + 2; i++) {
      const h = harness([
        { text: "preamble", code: "MAX_TURNS", message: MAX_TURNS_MSG },
        { text: '{"ok":true}' },
      ]);
      const r = await runJsonPass(spec({ unit: { kind: "bundle", id: `b${i}` } }), {
        ...h.deps,
        pool: lane,
      });
      expect(r.status).toBe("repaired");
    }
    expect(lane.consecutiveFailures("llm:understanding")).toBe(0);
    expect(lane.breakerFor("llm:understanding")).toBeNull();
    expect(lane.isPaused("llm:understanding")).toBe(false);
  });
});
