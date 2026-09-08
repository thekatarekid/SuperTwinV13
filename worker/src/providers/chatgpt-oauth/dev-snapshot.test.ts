import { afterEach, describe, expect, it } from "vitest";

import type { ProviderRequest } from "../types.js";
import { devRedactedRequestSnapshot } from "./dev-snapshot.js";

const priorNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;
});

describe("P4-E development request snapshots", () => {
  it("proves blank mode has no adapter prompt, tools, history, or duplicated input", () => {
    process.env.NODE_ENV = "development";
    const request: ProviderRequest = {
      runId: "snapshot", model: "gpt-test", instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      maxOutputTokens: 100, maxAgentTurns: 1, onEvent: () => undefined,
    };
    expect(devRedactedRequestSnapshot(request)).toMatchInlineSnapshot(`
      {
        "cache": null,
        "continuation": null,
        "input": [
          {
            "content": [
              {
                "bytes": 5,
                "type": "input_text",
              },
            ],
            "role": "user",
            "type": "message",
          },
        ],
        "instructions": "",
        "max_agent_turns": 1,
        "max_output_tokens": 100,
        "model": "gpt-test",
        "parallel_tool_calls": null,
        "tool_choice": null,
        "tools": null,
      }
    `);
  });

  it("redacts content, continuation, cache keys, and tool outputs", () => {
    process.env.NODE_ENV = "development";
    const request: ProviderRequest = {
      runId: "snapshot", model: "gpt-test", instructions: "secret prompt",
      input: [{ type: "function_call_output", call_id: "call-1", output: "secret output" }],
      continuation: { token: "secret-token" }, cache: { mode: "explicit", key: "secret-key", ttl: "30m" },
      maxOutputTokens: 100, maxAgentTurns: 2, onEvent: () => undefined,
    };
    const encoded = JSON.stringify(devRedactedRequestSnapshot(request));
    expect(encoded).not.toMatch(/secret/);
    expect(encoded).toContain("<present>");
  });

  it("is unavailable in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => devRedactedRequestSnapshot({} as ProviderRequest)).toThrow("disabled in production");
  });
});
