import { describe, expect, it } from "vitest";

import { goodFixture } from "./testutil.js";
import { providerRequestText, providerV2TestDouble } from "../providers/test-support.js";
import { buildJudgePrompt, haikuJudge, JudgeCallError, parseJudgeReply, stubJudge } from "./judge.js";
import type { ProviderModelCatalogue, ProviderRequest, ProviderV2 } from "../providers/types.js";

describe("buildJudgePrompt", () => {
  it("packs setup, events, rubric, wrong modes and the produced output", () => {
    const prompt = buildJudgePrompt(goodFixture(), { output: { tasks: [{ owner: "k1" }] } });
    expect(prompt).toContain("ROL-01");
    expect(prompt).toContain("goa-gang");
    expect(prompt).toContain("task-theft");
    expect(prompt).toContain('"owner": "k1"');
    expect(prompt).toContain('"expected": "satisfied" | "partial" | "missed"');
  });
});

describe("parseJudgeReply", () => {
  const labels = new Set(["task-theft", "receiver-blur"]);

  it("parses a plain JSON verdict", () => {
    const v = parseJudgeReply('{"expected":"satisfied","wrong_hits":[],"reasoning":"clean"}', labels);
    expect(v).toEqual({ expected: "satisfied", wrongHits: [], reasoning: "clean" });
  });

  it("tolerates fences and surrounding prose", () => {
    const v = parseJudgeReply(
      'Sure!\n```json\n{"expected":"partial","wrong_hits":["task-theft"],"reasoning":"half"}\n```',
      labels,
    );
    expect(v.expected).toBe("partial");
    expect(v.wrongHits).toEqual(["task-theft"]);
  });

  it("drops wrong_hits labels the fixture never declared", () => {
    const v = parseJudgeReply('{"expected":"missed","wrong_hits":["invented-mode","receiver-blur"]}', labels);
    expect(v.wrongHits).toEqual(["receiver-blur"]);
  });

  it("throws on an invalid verdict word and on no JSON at all", () => {
    expect(() => parseJudgeReply('{"expected":"great"}', labels)).toThrow(/satisfied\|partial\|missed/);
    expect(() => parseJudgeReply("no json here", labels)).toThrow(/no JSON object/);
  });
});

const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

function fakeProvider(replies: string[]): { provider: ProviderV2; calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const provider = providerV2TestDouble(
    (opts) => {
      calls.push(opts);
      const reply = replies.shift() ?? "";
      opts.onEvent({ type: "delta", text: reply });
      return Promise.resolve({
        continuation: null,
        usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        freshFallback: false,
        status: "ok",
      });
    },
    { model: { id: CLASSIFY_MODEL, displayName: "Haiku 4.5" } },
  );
  return { provider, calls };
}

describe("haikuJudge", () => {
  it("calls the resolved classify model with the strict blank-instruction completion contract", async () => {
    const { provider, calls } = fakeProvider(['{"expected":"satisfied","wrong_hits":[],"reasoning":"ok"}']);
    const judge = haikuJudge({ provider });
    const v = await judge(goodFixture(), { output: {} });
    expect(v.expected).toBe("satisfied");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: CLASSIFY_MODEL,
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text" }] }],
      toolChoice: "none",
      text: { format: { type: "text" } },
      plainCompletion: true,
      skipHostSettings: true,
      persistContinuation: false,
      maxOutputTokens: 8_192,
      maxAgentTurns: 2,
      reasoning: { budget: "off" },
    });
    expect(providerRequestText(calls[0]!)).toBe(buildJudgePrompt(goodFixture(), { output: {} }));
    expect(calls[0]).not.toHaveProperty("message");
    expect(calls[0]).not.toHaveProperty("systemPromptFile");
    expect(calls[0]).not.toHaveProperty("cache");
  });

  it("retries once on an unparseable reply", async () => {
    const { provider, calls } = fakeProvider(["garbage", '{"expected":"missed","wrong_hits":[]}']);
    const judge = haikuJudge({ provider });
    const v = await judge(goodFixture(), { output: {} });
    expect(v.expected).toBe("missed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.model).toBe(calls[0]!.model);
    expect(calls[1]!.maxOutputTokens).toBe(calls[0]!.maxOutputTokens);
  });

  it("surfaces a failed provider call", async () => {
    const provider = providerV2TestDouble(
      () =>
        Promise.resolve({
          continuation: null,
          usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
          freshFallback: false,
          status: "error" as const,
          errorCode: "TIMEOUT" as const,
        }),
      { model: { id: CLASSIFY_MODEL } },
    );
    const judge = haikuJudge({ provider });
    const rejection = expect(judge(goodFixture(), { output: {} })).rejects;
    await rejection.toBeInstanceOf(JudgeCallError);
    await rejection.toMatchObject({ code: "TIMEOUT" });
  });

  it("normalizes a thrown transport failure to a typed public error", async () => {
    const provider = providerV2TestDouble(
      async () => { throw Object.assign(new Error("provider-native detail"), { code: "RATE_LIMITED" }); },
      { model: { id: CLASSIFY_MODEL } },
    );
    const rejection = expect(haikuJudge({ provider })(goodFixture(), { output: {} })).rejects;
    await rejection.toBeInstanceOf(JudgeCallError);
    await rejection.toMatchObject({ code: "RATE_LIMITED", message: "judge call failed: RATE_LIMITED" });
  });

  it("omits reasoning when the selected classify model does not advertise it", async () => {
    const calls: ProviderRequest[] = [];
    const provider = providerV2TestDouble(async (request) => {
      calls.push(request);
      request.onEvent({ type: "delta", text: '{"expected":"satisfied","wrong_hits":[]}' });
      return {
        continuation: null,
        usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        freshFallback: false,
        status: "ok",
      };
    }, {
      model: { id: CLASSIFY_MODEL, reasoningValues: [], defaultReasoning: null },
    });
    await haikuJudge({ provider })(goodFixture(), { output: {} });
    expect(calls[0]).not.toHaveProperty("reasoning");
  });

  it("reuses one frozen catalogue snapshot across the parse retry", async () => {
    const { provider: base, calls } = fakeProvider(["garbage", '{"expected":"satisfied","wrong_hits":[]}']);
    let catalogue: ProviderModelCatalogue = base.catalogue();
    let reads = 0;
    const originalSend = base.send.bind(base);
    const provider: ProviderV2 = {
      ...base,
      catalogue: () => {
        reads += 1;
        return catalogue;
      },
      send: async (request) => {
        if (calls.length === 0) {
          catalogue.models[0]!.id = "changed-after-admission";
          catalogue.models[0]!.maxOutputTokens = 7;
        }
        return originalSend(request);
      },
    };
    const verdict = await haikuJudge({ provider })(goodFixture(), { output: {} });
    expect(verdict.expected).toBe("satisfied");
    expect(reads).toBe(1);
    expect(calls.map((call) => call.model)).toEqual([CLASSIFY_MODEL, CLASSIFY_MODEL]);
    expect(calls.map((call) => call.maxOutputTokens)).toEqual([8_192, 8_192]);
  });

  it("fails closed without send for a missing configured role model or output cap", async () => {
    let calls = 0;
    const missing = providerV2TestDouble(async () => {
      calls += 1;
      throw new Error("not called");
    }, { model: { id: "some-other-default" } });
    await expect(haikuJudge({ provider: missing })(goodFixture(), { output: {} }))
      .rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });

    const uncapped = providerV2TestDouble(async () => {
      calls += 1;
      throw new Error("not called");
    }, { model: { id: CLASSIFY_MODEL, maxOutputTokens: null } });
    await expect(haikuJudge({ provider: uncapped })(goodFixture(), { output: {} }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(calls).toBe(0);
  });
});

describe("stubJudge", () => {
  it("reads verdict and hits markers off the output, filtering unknown labels", async () => {
    const v = await stubJudge(goodFixture(), {
      output: { marker: "verdict:satisfied hits:task-theft,unknown-label" },
    });
    expect(v.expected).toBe("satisfied");
    expect(v.wrongHits).toEqual(["task-theft"]);
  });

  it("grades missed when no marker is planted", async () => {
    const v = await stubJudge(goodFixture(), { output: {} });
    expect(v.expected).toBe("missed");
  });
});
