import { describe, expect, it } from "vitest";

import { goodFixture } from "./testutil.js";
import { buildJudgePrompt, haikuJudge, parseJudgeReply, stubJudge } from "./judge.js";
import type { Provider, ProviderResult, SendOptions } from "../providers/types.js";

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

function fakeProvider(replies: string[]): { provider: Provider; calls: SendOptions[] } {
  const calls: SendOptions[] = [];
  const provider: Provider = {
    id: "fake",
    send(opts): Promise<ProviderResult> {
      calls.push(opts);
      const reply = replies.shift() ?? "";
      opts.onEvent({ type: "delta", text: reply });
      return Promise.resolve({
        sessionId: "s",
        usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        freshFallback: false,
        status: "ok",
      });
    },
    cancel: () => false,
  };
  return { provider, calls };
}

describe("haikuJudge", () => {
  it("calls the provider with haiku + plainCompletion and parses the verdict", async () => {
    const { provider, calls } = fakeProvider(['{"expected":"satisfied","wrong_hits":[],"reasoning":"ok"}']);
    const judge = haikuJudge({ provider });
    const v = await judge(goodFixture(), { output: {} });
    expect(v.expected).toBe("satisfied");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("haiku");
    expect(calls[0]!.plainCompletion).toBe(true);
  });

  it("retries once on an unparseable reply", async () => {
    const { provider, calls } = fakeProvider(["garbage", '{"expected":"missed","wrong_hits":[]}']);
    const judge = haikuJudge({ provider });
    const v = await judge(goodFixture(), { output: {} });
    expect(v.expected).toBe("missed");
    expect(calls).toHaveLength(2);
  });

  it("surfaces a failed provider call", async () => {
    const provider: Provider = {
      id: "fake",
      send: () =>
        Promise.resolve({
          sessionId: "s",
          usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
          freshFallback: false,
          status: "error" as const,
          errorCode: "TIMEOUT" as const,
        }),
      cancel: () => false,
    };
    const judge = haikuJudge({ provider });
    await expect(judge(goodFixture(), { output: {} })).rejects.toThrow(/TIMEOUT/);
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
