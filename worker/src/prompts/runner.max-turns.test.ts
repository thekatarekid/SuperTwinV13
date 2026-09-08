// ===========================================================================
// FIX-C2 — the wire-format runner on a turn-cap stop.
//
// Same defect as brain/llm.ts, same shape on the other pass family (decide,
// tier.v1, live.v1 all come through here): the CLI ended the run on
// `--max-turns`, the adapter said CLI_ERROR, and `dispatch` re-issued the whole
// packed call up the 2s/10s/30s ladder before quarantining the unit.
//
// The repair machinery for a prose answer already existed — `no_wire_lines` is
// exactly the "you wrote prose, re-emit as wire lines" ask (§5.8.3). All the
// turn cap needed was to reach it instead of being mistaken for a broken CLI.
//
// Zero live model calls: the provider is a scripted stub.
// ===========================================================================

import { beforeEach, describe, expect, it } from "vitest";

import { ResourcePool, RETRY_DELAYS_MS } from "../providers/pool.js";
import type {
  ProviderErrorCode,
  ProviderModelCatalogue,
  ProviderV2,
  Usage,
} from "../providers/types.js";
import type { RecordRunParams } from "../db/run-accounting.js";
import { resetLegendCache } from "./legend.js";
import {
  runPrompt,
  type PromptCallSpec,
  type QuarantineRow,
  type RunnerDeps,
} from "./runner.js";

const MAX_TURNS_MSG = "Reached maximum number of turns (1)";
const CLEAN = "F | 1 | a1 | 1p | 0.9 | 2026-08-01 | likes filter coffee";
const PREAMBLE = "I'll parse this space and output the state.";

interface Turn {
  text?: string;
  code?: ProviderErrorCode;
  message?: string;
}

function harness(turns: Turn[]) {
  const runs: RecordRunParams[] = [];
  const parked: QuarantineRow[] = [];
  const messages: string[] = [];
  let t = 0;
  let n = 0;
  const usage: Usage = {
    inputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 5,
  };
  const catalogue: ProviderModelCatalogue = {
    providerId: "claude-local",
    mode: "discovered",
    source: "runner-max-turns-test",
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: "runner-max-turns-test-v1",
    error: null,
    models: [{
      id: "sonnet-5", displayName: "Sonnet 5", isDefault: true, hidden: false,
      inputModalities: ["text"], reasoningValues: ["off"], defaultReasoning: "off",
      supportsTools: false, supportsHostTools: true, supportsParallelToolCalls: false,
      supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
      supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
      contextWindow: 200_000, maxOutputTokens: 8_192, billingLabel: null,
    }],
  };
  const provider: ProviderV2 = {
    id: "claude-local",
    displayName: "Fake Claude",
    capabilities: {
      functionTools: false, hostTools: true, continuation: true, requiresAuthentication: true,
    },
    authState: () => ({ status: "ready", error: null }),
    catalogue: () => catalogue,
    cancel: () => true,
    killAll: () => {},
    async send(opts) {
      const item = opts.input[0];
      const part = item?.type === "message" ? item.content[0] : undefined;
      messages.push(part?.type === "input_text" ? part.text : "");
      const turn = turns[messages.length - 1] ?? { text: "" };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: turn.message ?? "" });
        opts.onEvent({ type: "done", continuation: null, usage });
        return { continuation: null, usage, freshFallback: false, status: "error" as const, errorCode: turn.code };
      }
      opts.onEvent({ type: "done", continuation: null, usage });
      return { continuation: null, usage, freshFallback: false, status: "ok" as const };
    },
  };
  const pool = new ResourcePool({ now: () => t, sleep: async (ms) => { t += ms; } });
  const deps: RunnerDeps = {
    provider,
    pool,
    recordRun: (p) => { runs.push(p); return p.id ?? "run"; },
    quarantine: (row) => { parked.push(row); },
    newId: () => `id-${++n}`,
    now: () => new Date(1_760_000_000_000 + t),
  };
  return { deps, runs, parked, messages, pool };
}

function spec(over: Partial<PromptCallSpec> = {}): PromptCallSpec {
  return {
    callType: "P-CL1",
    legend: { callType: "P-CL1", tags: ["F", "P"] },
    instructions: "Extract claims from the episode below.",
    user: "#E e1 coffee talk\n  1 09:12 a1 | I only drink filter",
    role: "extract",
    cohortId: "coh-1",
    model: "sonnet-5",
    unit: { kind: "episode", id: "epi-1" },
    ...over,
  };
}

beforeEach(() => {
  resetLegendCache();
});

describe("runPrompt on a turn-cap stop", () => {
  it("a preamble is re-asked once, narrowly — not re-issued four times", async () => {
    const h = harness([
      { text: PREAMBLE, code: "MAX_TURNS", message: MAX_TURNS_MSG },
      { text: CLEAN },
    ]);
    const r = await runPrompt(spec(), h.deps);

    expect(r.status).toBe("repaired");
    expect(r.records).toHaveLength(1);
    expect(h.messages).toHaveLength(2);
    expect(h.parked).toEqual([]);
    // The prose answer landed on the whole-answer repair ask (§5.8.3), which
    // is the narrow question the old path never got round to asking.
    expect(h.messages[1]).toContain("none of your answer was in the wire format");
    expect(h.messages[1]).toContain(PREAMBLE);
    expect(h.runs.map((x) => x.status)).toEqual(["retried", "ok"]);
    expect(h.runs[0].errorCode).toBe("MAX_TURNS");
  });

  it("a turn cap whose lines all parsed is SALVAGED — one call, no repair", async () => {
    const h = harness([{ text: CLEAN, code: "MAX_TURNS", message: MAX_TURNS_MSG }]);
    const r = await runPrompt(spec(), h.deps);
    expect(r.status).toBe("ok");
    expect(r.records).toHaveLength(1);
    expect(h.messages).toHaveLength(1);
    expect(h.runs.map((x) => x.status)).toEqual(["ok"]);
  });

  it("a turn cap that produced nothing still ends in quarantine — two calls, never four", async () => {
    const h = harness([
      { text: "", code: "MAX_TURNS", message: MAX_TURNS_MSG },
      { text: "" },
    ]);
    const r = await runPrompt(spec(), h.deps);
    expect(r.status).toBe("quarantined");
    expect(h.parked).toHaveLength(1);
    // The fix buys one NARROW re-ask, not an open-ended retry budget.
    expect(h.messages).toHaveLength(2);
  });

  it("a genuine transport failure still walks the ladder — nothing else was softened", async () => {
    const h = harness(Array.from({ length: 4 }, () => ({ text: "", code: "TIMEOUT" as const })));
    const r = await runPrompt(spec(), h.deps);
    expect(r.status).toBe("quarantined");
    // first call + the 2s/10s/30s ladder
    expect(h.messages).toHaveLength(1 + RETRY_DELAYS_MS.length);
    expect(h.parked.map((p) => p.errorCode)).toEqual(["TIMEOUT"]);
  });
});
