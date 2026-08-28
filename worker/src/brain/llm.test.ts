// ===========================================================================
// JSON pass runner tests (build P1.2/P1.3): trace scope around every call,
// runs rows for every attempt, one repair round, quarantine on the far side,
// and the byte-identical system-prompt invariant.
// ===========================================================================

import { beforeEach, describe, expect, it } from "vitest";

import { ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
import type { RecordRunParams } from "../db/run-accounting.js";
import { hasTraceContext } from "../traces/context.js";
import {
  extractJson,
  resetStableSystemPromptsForTests,
  runJsonPass,
  stableSystemPrompt,
  type JsonPassDeps,
} from "./llm.js";

interface Turn {
  text?: string;
  code?: "TIMEOUT" | "CLI_ERROR" | "CANCELLED";
}

function harness(turns: Turn[]) {
  const runs: RecordRunParams[] = [];
  const parked: { errorCode: string; unitId: string }[] = [];
  const messages: string[] = [];
  let sawTrace = true;
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      messages.push(opts.message);
      sawTrace = sawTrace && hasTraceContext();
      const turn = turns[messages.length - 1] ?? { text: "" };
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: "boom" });
        return {
          sessionId: "s",
          usage,
          freshFallback: false,
          status: "error" as const,
          errorCode: turn.code,
        };
      }
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  const deps: JsonPassDeps = {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: (p) => {
      runs.push(p);
      return p.id ?? "r";
    },
    quarantine: (row) => parked.push({ errorCode: row.errorCode, unitId: row.unitId }),
  };
  return { deps, runs, parked, messages, sawTrace: () => sawTrace };
}

function spec(overrides: Partial<Parameters<typeof runJsonPass>[0]> = {}) {
  return {
    pass: "test.v1",
    system: "You answer JSON.",
    user: "input",
    role: "classify" as const,
    unit: { kind: "bundle", id: "b1" },
    validate: (parsed: unknown) => {
      if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
        throw new Error("expected {ok}");
      }
      return parsed as { ok: boolean };
    },
    ...overrides,
  };
}

beforeEach(() => resetStableSystemPromptsForTests());

describe("runJsonPass", () => {
  it("parses a clean JSON answer inside a trace scope, one runs row", async () => {
    const h = harness([{ text: '{"ok":true}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ ok: true });
    expect(h.sawTrace()).toBe(true);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].kind).toBe("test.v1");
    expect(h.runs[0].role).toBe("classify");
    expect(h.runs[0].status).toBe("ok");
    expect(h.runs[0].cohortId).toBeNull();
  });

  it("repairs once — the model is shown its own previous answer verbatim", async () => {
    const h = harness([{ text: "sure! here you go: nonsense" }, { text: '{"ok":false}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(result.output).toEqual({ ok: false });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toContain("YOUR PREVIOUS ANSWER:");
    expect(h.messages[1]).toContain("sure! here you go: nonsense");
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(result.responses).toEqual(["sure! here you go: nonsense", '{"ok":false}']);
  });

  it("quarantines after the second parse failure, keeping every response", async () => {
    const h = harness([{ text: "junk" }, { text: "more junk" }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.output).toBeUndefined();
    expect(h.parked).toEqual([{ errorCode: "json_invalid", unitId: "b1" }]);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "quarantined"]);
    expect(result.responses).toEqual(["junk", "more junk"]);
  });

  it("quarantines a transport failure with its code", async () => {
    const h = harness([{ text: "", code: "TIMEOUT" }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(h.parked).toEqual([{ errorCode: "TIMEOUT", unitId: "b1" }]);
  });

  it("a validator rejection triggers the repair round with the reason", async () => {
    const h = harness([{ text: '{"nope":1}' }, { text: '{"ok":true}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(h.messages[1]).toContain("expected {ok}");
  });
});

describe("stableSystemPrompt", () => {
  it("throws when a pass renders two different system prompts", () => {
    stableSystemPrompt("p", "one");
    expect(stableSystemPrompt("p", "one")).toBe("one");
    expect(() => stableSystemPrompt("p", "two")).toThrow(/not stable/);
  });
});

describe("extractJson", () => {
  it("accepts bare JSON, fenced JSON, and JSON inside prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here it is: {"a":1} — done')).toEqual({ a: 1 });
    expect(extractJson("no json at all")).toBeUndefined();
  });
});
