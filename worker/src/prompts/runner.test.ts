import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { closeDb, runMigrations } from "../db/connection.js";
import { setActiveProvider, setProviderModelSelection } from "../db/settings.js";
import { ResourcePool } from "../providers/pool.js";
import { registerV2, resetProviderRegistryForTests } from "../providers/registry.js";
import type {
  ProviderErrorCode,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderV2,
  Usage,
} from "../providers/types.js";
import type { RecordRunParams } from "../db/run-accounting.js";
import { resetLegendCache } from "./legend.js";
import {
  buildSystemPrompt,
  resetPromptFilesForTests,
  runPrompt,
  systemPromptPath,
  type PromptCallSpec,
  type QuarantineRow,
  type RunnerDeps,
} from "./runner.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Turn {
  text?: string;
  code?: ProviderErrorCode;
  message?: string;
  usage?: Partial<Usage>;
  mutateCatalogue?: boolean;
}

interface FakeProvider extends ProviderV2 {
  catalogueSource: ProviderModelCatalogue;
  messages: string[];
  instructionsSeen: string[];
  requests: ProviderRequest[];
  catalogueReads: number;
  calls: number;
}

function testCatalogue(): ProviderModelCatalogue {
  return {
    providerId: "claude-local",
    mode: "discovered",
    source: "runner-test",
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: "runner-test-v1",
    error: null,
    models: [{
      id: "sonnet-5",
      displayName: "Sonnet 5",
      isDefault: true,
      hidden: false,
      inputModalities: ["text"],
      reasoningValues: ["off", "low", "medium", "high", "xhigh", "max"],
      defaultReasoning: "off",
      supportsTools: false,
      supportsHostTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsStrictTools: false,
      supportsVerbosity: false,
      supportsPromptCacheKey: false,
      supportsPromptCacheOptions: false,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      billingLabel: null,
    }],
  };
}

function fakeProvider(turns: Turn[]): FakeProvider {
  const messages: string[] = [];
  const instructionsSeen: string[] = [];
  const requests: ProviderRequest[] = [];
  const catalogue = testCatalogue();
  let catalogueReads = 0;
  const provider: FakeProvider = {
    id: "claude-local",
    displayName: "Fake Claude",
    capabilities: {
      functionTools: false,
      hostTools: true,
      continuation: true,
      requiresAuthentication: true,
    },
    catalogueSource: catalogue,
    messages,
    instructionsSeen,
    requests,
    get calls() {
      return messages.length;
    },
    get catalogueReads() {
      return catalogueReads;
    },
    authState: () => ({ status: "ready", error: null }),
    catalogue: () => {
      catalogueReads += 1;
      return catalogue;
    },
    cancel: () => true,
    killAll: () => {},
    async send(opts) {
      requests.push(opts);
      const item = opts.input[0];
      const part = item?.type === "message" ? item.content[0] : undefined;
      messages.push(part?.type === "input_text" ? part.text : "");
      instructionsSeen.push(opts.instructions);
      const turn = turns[messages.length - 1] ?? { text: "" };
      if (turn.mutateCatalogue) {
        catalogue.revision = "mutated-after-first-send";
        catalogue.models[0]!.id = "changed-after-first-send";
        catalogue.models[0]!.maxOutputTokens = 7;
      }
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
        ...turn.usage,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: turn.message ?? "" });
        opts.onEvent({ type: "done", continuation: null, usage });
        return { continuation: null, usage, freshFallback: false, status: "error", errorCode: turn.code };
      }
      opts.onEvent({ type: "done", continuation: null, usage });
      return { continuation: null, usage, freshFallback: false, status: "ok" };
    },
  };
  return provider;
}

interface Harness {
  deps: RunnerDeps;
  runs: RecordRunParams[];
  parked: QuarantineRow[];
  provider: FakeProvider;
  clock: () => number;
}

function harness(turns: Turn[], extra: Partial<RunnerDeps> = {}): Harness {
  const runs: RecordRunParams[] = [];
  const parked: QuarantineRow[] = [];
  const provider = fakeProvider(turns);
  let t = 0;
  let n = 0;
  const pool = new ResourcePool({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return {
    runs,
    parked,
    provider,
    clock: () => t,
    deps: {
      provider,
      pool,
      recordRun: (p) => {
        runs.push(p);
        return p.id ?? "run";
      },
      quarantine: (row) => {
        parked.push(row);
      },
      newId: () => `id-${++n}`,
      now: () => new Date(1_760_000_000_000 + t),
      ...extra,
    },
  };
}

const CLEAN = "F | 1 | a1 | 1p | 0.9 | 2026-08-01 | likes filter coffee";

/** Two of four lines damaged: line 2 (bad enum) and line 4 (unknown tag). */
const TWO_DAMAGED = [
  CLEAN,
  "F | 2 | a1 | zz | 0.9 | 2026-08-01 | drinks it black",
  "P | 3 | a2 | 1p | 0.8 | 2026-08-02 | prefers window seats",
  "U | 4 | a2 | 1p | 0.7 | 2026-08-02 | takes the aisle",
].join("\n");

const REPAIRED = [
  "F | 2 | a1 | 1p | 0.9 | 2026-08-01 | drinks it black",
  "P | 4 | a2 | 1p | 0.7 | 2026-08-02 | takes the aisle",
].join("\n");

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
  resetProviderRegistryForTests();
  resetLegendCache();
  resetPromptFilesForTests();
});

// ---------------------------------------------------------------------------

describe("the stable prefix", () => {
  it("prepends the legend to the prompt's own instructions", () => {
    const system = buildSystemPrompt(spec());
    expect(system.startsWith("WIRE FORMAT — STW-2")).toBe(true);
    expect(system.endsWith("Extract claims from the episode below.")).toBe(true);
  });

  it("writes it to one content-addressed file and reuses it byte-for-byte", async () => {
    const h = harness([{ text: CLEAN }, { text: CLEAN }]);
    await runPrompt(spec(), h.deps);
    await runPrompt(spec(), h.deps);
    expect(h.provider.instructionsSeen[0]).toBe(h.provider.instructionsSeen[1]);
    expect(h.provider.instructionsSeen[0]).toBe(buildSystemPrompt(spec()));
  });

  it("gives a different call type a different file", () => {
    const a = systemPromptPath("P-CL1", "alpha");
    const b = systemPromptPath("P-TR1", "alpha");
    expect(a).not.toBe(b);
    expect(systemPromptPath("P-CL1", "alpha")).toBe(a);
  });

  it("keeps the variable half on stdin, out of the cached prefix", async () => {
    const h = harness([{ text: CLEAN }]);
    await runPrompt(spec(), h.deps);
    expect(h.provider.messages[0]).toBe(spec().user);
    expect(h.provider.instructionsSeen[0]).not.toContain("coffee talk");
  });

  it("sends the strict neutral completion contract with no legacy prompt fields", async () => {
    const h = harness([{ text: CLEAN }]);
    await runPrompt(spec(), h.deps);
    const sent = h.provider.requests[0]!;
    expect(sent).toMatchObject({
      model: "sonnet-5",
      instructions: buildSystemPrompt(spec()),
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: spec().user }],
      }],
      toolChoice: "none",
      reasoning: { budget: "off" },
      text: { format: { type: "text" } },
      persistContinuation: false,
      plainCompletion: true,
      skipHostSettings: true,
      maxOutputTokens: 8_192,
      maxAgentTurns: 2,
    });
    expect(sent).not.toHaveProperty("message");
    expect(sent).not.toHaveProperty("systemPromptFile");
    expect(sent).not.toHaveProperty("allowedTools");
    expect(sent).not.toHaveProperty("maxTurns");
    expect(sent).not.toHaveProperty("cache");
  });

  it("omits reasoning when the selected model does not advertise it", async () => {
    const h = harness([{ text: CLEAN }]);
    h.provider.catalogueSource.models[0]!.reasoningValues = [];
    h.provider.catalogueSource.models[0]!.defaultReasoning = null;
    await runPrompt(spec(), h.deps);
    expect(h.provider.requests[0]).not.toHaveProperty("reasoning");
  });

  it("preserves an intentionally blank instruction prefix", async () => {
    const h = harness([{ text: CLEAN }]);
    await runPrompt(spec({ legend: "", instructions: "" }), h.deps);
    expect(h.provider.requests[0]?.instructions).toBe("");
  });

  it("fails closed before send when maxOutputTokens is unavailable", async () => {
    const h = harness([{ text: CLEAN }]);
    h.provider.catalogueSource.models[0]!.maxOutputTokens = null;
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.error?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.runs[0]).toMatchObject({
      model: "sonnet-5",
      status: "quarantined",
      errorCode: "CAPABILITY_UNSUPPORTED",
    });
    expect(h.parked[0]).toMatchObject({ errorCode: "CAPABILITY_UNSUPPORTED" });
  });

  it("reuses one immutable resolution for the repair call", async () => {
    const h = harness([
      { text: TWO_DAMAGED, mutateCatalogue: true },
      { text: REPAIRED },
    ]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(h.provider.catalogueReads).toBe(1);
    expect(h.provider.requests.map((request) => request.model)).toEqual([
      "sonnet-5",
      "sonnet-5",
    ]);
    expect(h.provider.requests.map((request) => request.maxOutputTokens)).toEqual([
      8_192,
      8_192,
    ]);
  });

  it("uses the production resolver and never falls back to spec.model", async () => {
    const stage = mkdtempSync(join(tmpdir(), "supertwin-prompt-resolver-"));
    const previousDbPath = process.env.SUPERTWIN_DB_PATH;
    process.env.SUPERTWIN_DB_PATH = join(stage, "st.db");
    closeDb();
    try {
      runMigrations();
      const h = harness([{ text: CLEAN }]);
      registerV2(h.provider);
      setActiveProvider("claude-local");
      setProviderModelSelection("claude-local", "P-CL1", "sonnet-5");
      const result = await runPrompt(spec({ model: "not-in-catalogue" }), {
        ...h.deps,
        provider: undefined,
      });
      expect(result.status).toBe("ok");
      expect(h.provider.requests[0]?.model).toBe("sonnet-5");

      setProviderModelSelection("claude-local", "P-CL1", "missing-saved-model");
      const rejected = await runPrompt(spec({ model: "sonnet-5" }), {
        ...h.deps,
        provider: undefined,
      });
      expect(rejected.error?.code).toBe("MODEL_UNAVAILABLE");
      expect(h.provider.requests).toHaveLength(1);
    } finally {
      resetProviderRegistryForTests();
      closeDb();
      if (previousDbPath === undefined) delete process.env.SUPERTWIN_DB_PATH;
      else process.env.SUPERTWIN_DB_PATH = previousDbPath;
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe("the happy path", () => {
  it("parses the answer and writes exactly one runs row", async () => {
    const h = harness([{ text: CLEAN }]);
    const result = await runPrompt(spec(), h.deps);

    expect(result.status).toBe("ok");
    expect(result.rounds).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.violations).toHaveLength(0);
    expect(h.provider.calls).toBe(1);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      role: "extract",
      model: "sonnet-5",
      cohortId: "coh-1",
      kind: "P-CL1",
      status: "ok",
    });
    expect(h.parked).toHaveLength(0);
  });

  it("sums the usage across calls and reports the run ids", async () => {
    const h = harness([{ text: CLEAN }]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(result.runIds).toEqual(h.runs.map((r) => r.id));
  });
});

describe("the repair round", () => {
  it("re-asks only the two damaged lines", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: REPAIRED }]);
    const result = await runPrompt(spec(), h.deps);

    expect(h.provider.calls).toBe(2);
    const repair = h.provider.messages[1];
    const asks = repair.match(/^line \d+ — /gm) ?? [];
    expect(asks).toHaveLength(2);
    expect(repair).toContain("line 2 — bad_enum");
    expect(repair).toContain("line 4 — unknown_tag");
    expect(repair).not.toMatch(/^line 1 — /m);
    expect(repair).not.toMatch(/^line 3 — /m);

    expect(result.status).toBe("repaired");
    expect(result.rounds).toBe(2);
    expect(result.coverage).toEqual({
      asked: 2,
      answered: 2,
      unanswered: 0,
      pairingCertain: true,
    });
  });

  it("preserves the accepted lines and merges the repaired ones", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: REPAIRED }]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.records.map((r) => r.values.text)).toEqual([
      "likes filter coffee",
      "prefers window seats",
      "drinks it black",
      "takes the aisle",
    ]);
    expect(result.violations).toHaveLength(0);
    expect(h.parked).toHaveLength(0);
  });

  it("shows the model its own answer verbatim alongside the original input", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: REPAIRED }]);
    await runPrompt(spec(), h.deps);
    const repair = h.provider.messages[1];
    expect(repair.startsWith(spec().user)).toBe(true);
    expect(repair).toContain("YOUR PREVIOUS ANSWER:");
    expect(repair).toContain(TWO_DAMAGED);
  });

  it("writes a runs row for the repair call too", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: REPAIRED }]);
    await runPrompt(spec(), h.deps);
    expect(h.runs).toHaveLength(2);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
  });

  it("is bounded at one round — a second failure never asks a third time", async () => {
    const h = harness([
      { text: TWO_DAMAGED },
      { text: "F | 2 | a1 | qq | 0.9 | 2026-08-01 | drinks it black\nU | 4 | a2 | 1p | | | nope" },
    ]);
    const result = await runPrompt(spec(), h.deps);

    expect(h.provider.calls).toBe(2);
    expect(result.rounds).toBe(2);
    expect(result.status).toBe("quarantined");
    expect(result.quarantineReason).toBe("violations");
    // Round one's good lines survive the quarantine.
    expect(result.records.map((r) => r.values.text)).toEqual([
      "likes filter coffee",
      "prefers window seats",
    ]);
    expect(result.violations.map((v) => v.rule)).toEqual(["bad_enum", "unknown_tag"]);
  });

  it("parks the unit with its violations rather than dropping it", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: "still not wire format" }]);
    const result = await runPrompt(spec(), h.deps);

    expect(h.parked).toHaveLength(1);
    expect(h.parked[0]).toMatchObject({
      unitKind: "episode",
      unitId: "epi-1",
      cohortId: "coh-1",
      errorCode: "wire_violations",
      attempts: 2,
    });
    expect(h.parked[0].lastError).toContain("line 2 — bad_enum");
    expect(result.quarantineId).toBe(h.parked[0].id);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "quarantined"]);
  });

  it("asks once for the whole answer when round one was all prose", async () => {
    const h = harness([{ text: "Sure! Here is what I found." }, { text: CLEAN }]);
    const result = await runPrompt(spec(), h.deps);
    const repair = h.provider.messages[1];
    expect(repair).toContain("Re-emit the WHOLE answer as wire lines");
    expect(repair.match(/^line \d+ — /gm)).toBeNull();
    expect(result.status).toBe("repaired");
    expect(result.records).toHaveLength(1);
  });
});

describe("nothing the model said is discarded", () => {
  it("keeps every response verbatim, both rounds", async () => {
    const h = harness([{ text: TWO_DAMAGED }, { text: REPAIRED }]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.responses).toEqual([TWO_DAMAGED, REPAIRED]);
  });

  it("keeps skipped lines with their original text", async () => {
    const h = harness([{ text: `\`\`\`\n${CLEAN}\n\`\`\`` }]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.skipped.map((s) => s.raw)).toEqual(["```", "```"]);
  });

  it("keeps whatever streamed before a transport failure", async () => {
    const h = harness(
      [{ text: "F | 1 | a1 | 1p |", code: "TIMEOUT", message: "timed out" }],
      { maxPauses: 0 },
    );
    const result = await runPrompt(spec(), h.deps);
    expect(result.responses[0]).toBe("F | 1 | a1 | 1p |");
  });
});

describe("provider failures (§4.6)", () => {
  it("retries a TIMEOUT and logs a row for every attempt", async () => {
    const h = harness([{ code: "TIMEOUT", message: "timed out" }, { text: CLEAN }]);
    const result = await runPrompt(spec(), h.deps);
    expect(h.provider.calls).toBe(2);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(h.runs[0].errorCode).toBe("TIMEOUT");
    expect(result.status).toBe("ok");
  });

  it("walks the ladder then quarantines, one row per attempt", async () => {
    const h = harness(Array.from({ length: 6 }, () => ({ code: "CLI_ERROR" as const, message: "boom" })));
    const result = await runPrompt(spec(), h.deps);
    // 2 s / 10 s / 30 s then quarantine: four attempts, four rows.
    expect(h.provider.calls).toBe(4);
    expect(h.runs).toHaveLength(4);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "retried", "retried", "quarantined"]);
    expect(result.status).toBe("quarantined");
    expect(result.quarantineReason).toBe("transport");
    expect(h.parked[0].errorCode).toBe("CLI_ERROR");
  });

  it("pauses the lane on a refusal without spending the retry budget", async () => {
    const h = harness([
      { code: "CLI_ERROR", message: "rate limit exceeded, please retry" },
      { text: CLEAN },
    ]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(h.provider.calls).toBe(2);
    // The lane was paused for the 60 s backoff and the pool slept it out.
    expect(h.clock()).toBeGreaterThanOrEqual(60_000);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
  });

  it("reports a cancelled call without parking the unit", async () => {
    const h = harness([{ code: "CANCELLED", message: "aborted" }]);
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("failed");
    expect(result.quarantineReason).toBe("cancelled");
    expect(h.parked).toHaveLength(0);
    expect(h.runs).toHaveLength(1);
  });

  it("keeps round one's records when the repair call itself fails", async () => {
    const h = harness(
      [{ text: TWO_DAMAGED }, ...Array.from({ length: 5 }, () => ({ code: "TIMEOUT" as const }))],
    );
    const result = await runPrompt(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.quarantineReason).toBe("transport");
    expect(result.records).toHaveLength(2);
    expect(result.violations).toHaveLength(2);
  });

  it("fails loudly when no provider is registered", async () => {
    const h = harness([]);
    const result = await runPrompt(spec(), { ...h.deps, provider: undefined, maxPauses: 0 });
    expect(result.status).toBe("quarantined");
    expect(result.error?.message).toContain("is not registered");
    expect(h.runs.length).toBeGreaterThan(0);
  });
});

describe("latency instrumentation (item 4.2, §9.5.3 rule 4)", () => {
  it("stamps TTFT on every runs write when a token streamed", async () => {
    const h = harness([{ text: CLEAN }]);
    await runPrompt(spec(), h.deps);
    expect(h.runs).toHaveLength(1);
    // The fake provider streams its delta on the same fake-clock instant the
    // call started, so the honest TTFT is 0 ms — a number, never null.
    expect(h.runs[0]!.ttftMs).toBe(0);
  });

  it("records null TTFT — not zero — for a call that never streamed a token", async () => {
    const h = harness([{ code: "TIMEOUT", message: "timed out" }, { text: CLEAN }]);
    await runPrompt(spec(), h.deps);
    // Attempt 1 timed out before any delta: no first token exists, and 0 would
    // claim it arrived instantly. Attempt 2 streamed and has one.
    expect(h.runs[0]!.ttftMs).toBeNull();
    expect(h.runs[1]!.ttftMs).toBe(0);
  });
});
