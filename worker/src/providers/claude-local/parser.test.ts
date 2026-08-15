import { describe, it, expect } from "vitest";
import {
  StreamJsonParser,
  isPoisonResult,
  extractUsage,
  type ParsedResult,
} from "./parser.js";
import type { ProviderStreamEvent } from "../types.js";

// Fixture lines captured from a real `claude ... --output-format stream-json
// --verbose --include-partial-messages` run (trimmed to the relevant fields).
const L = {
  hookStarted:
    '{"type":"system","subtype":"hook_started","session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  init:
    '{"type":"system","subtype":"init","cwd":"/x","session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","model":"claude-sonnet-5"}',
  delta1:
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}},"session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  delta2:
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}},"session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  rateLimit:
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  assistant:
    '{"type":"assistant","message":{"id":"msg_01Hello","content":[{"type":"text","text":"Hello world"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":8000,"output_tokens":10}},"session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  result:
    '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","total_cost_usd":0.05,"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":8000,"output_tokens":10}}',
  poisonResult:
    '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"00000000-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"]}',
};

// A REAL 2-turn run: `claude --print --output-format stream-json --verbose
// --include-partial-messages --allowedTools Read --max-turns 4 --model
// claude-haiku-4-5-20251001` reading a one-word file. Token counts verbatim;
// prose and ids trimmed. Note that each turn's `assistant` line is repeated
// once per content block with an IDENTICAL usage snapshot, and that the result
// line's four token fields equal the per-turn sums exactly.
const SID = "c0acd157-a1c7-40d2-a69e-71e38bc19ebe";
const R = {
  init: `{"type":"system","subtype":"init","cwd":"/x","session_id":"${SID}"}`,
  t1Start: `{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_011CdZ2EsRthFjG84AJ8Veqp","role":"assistant","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":10472,"cache_read_input_tokens":18764,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":10472},"output_tokens":4,"service_tier":"standard"}}},"session_id":"${SID}"}`,
  t1Thinking: `{"type":"assistant","message":{"id":"msg_011CdZ2EsRthFjG84AJ8Veqp","content":[{"type":"thinking","thinking":"read the file"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":10472,"cache_read_input_tokens":18764,"output_tokens":4}},"session_id":"${SID}"}`,
  t1ToolUse: `{"type":"assistant","message":{"id":"msg_011CdZ2EsRthFjG84AJ8Veqp","content":[{"type":"tool_use","id":"toolu_01JtLKka","name":"Read","input":{"file_path":"/x/note.txt"}}],"usage":{"input_tokens":10,"cache_creation_input_tokens":10472,"cache_read_input_tokens":18764,"output_tokens":4}},"session_id":"${SID}"}`,
  t1Delta: `{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"cache_creation_input_tokens":10472,"cache_read_input_tokens":18764,"output_tokens":149,"output_tokens_details":{"thinking_tokens":37},"iterations":[{"input_tokens":10,"output_tokens":149,"cache_read_input_tokens":18764,"cache_creation_input_tokens":10472,"type":"message"}]}},"session_id":"${SID}"}`,
  t1Stop: `{"type":"stream_event","event":{"type":"message_stop"},"session_id":"${SID}"}`,
  toolResult: `{"type":"user","message":{"content":[{"type":"tool_result","content":"pineapple"}]},"session_id":"${SID}"}`,
  t2Start: `{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_011CdZ2F59bHXoTQ4xchTcya","role":"assistant","content":[],"usage":{"input_tokens":8,"cache_creation_input_tokens":179,"cache_read_input_tokens":29236,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":179},"output_tokens":4,"service_tier":"standard"}}},"session_id":"${SID}"}`,
  t2Text: `{"type":"assistant","message":{"id":"msg_011CdZ2F59bHXoTQ4xchTcya","content":[{"type":"text","text":"pineapple"}],"usage":{"input_tokens":8,"cache_creation_input_tokens":179,"cache_read_input_tokens":29236,"output_tokens":4}},"session_id":"${SID}"}`,
  t2Delta: `{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":8,"cache_creation_input_tokens":179,"cache_read_input_tokens":29236,"output_tokens":57,"output_tokens_details":{"thinking_tokens":48},"iterations":[{"input_tokens":8,"output_tokens":57,"cache_read_input_tokens":29236,"cache_creation_input_tokens":179,"type":"message"}]}},"session_id":"${SID}"}`,
  t2Stop: `{"type":"stream_event","event":{"type":"message_stop"},"session_id":"${SID}"}`,
  result: `{"type":"result","subtype":"success","is_error":false,"num_turns":2,"stop_reason":"end_turn","session_id":"${SID}","total_cost_usd":0.02715,"usage":{"input_tokens":18,"cache_creation_input_tokens":10651,"cache_read_input_tokens":48000,"output_tokens":206,"service_tier":"standard","iterations":[{"input_tokens":8,"output_tokens":57,"cache_read_input_tokens":29236,"cache_creation_input_tokens":179,"type":"message"}]}}`,
};

/** Feed whole lines in order. */
function feed(p: StreamJsonParser, lines: string[]): void {
  for (const l of lines) p.push(l + "\n");
}

function typesOf(events: ProviderStreamEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("StreamJsonParser", () => {
  it("emits a single session event from the first line carrying session_id", () => {
    const p = new StreamJsonParser();
    const a = p.push(L.hookStarted + "\n");
    const b = p.push(L.init + "\n");
    expect(typesOf(a.events)).toContain("session");
    expect(a.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    // The second line must NOT re-emit session.
    expect(typesOf(b.events)).not.toContain("session");
  });

  it("normalizes content_block_delta into delta events with text", () => {
    const p = new StreamJsonParser();
    const out = p.push(L.init + "\n" + L.delta1 + "\n" + L.delta2 + "\n");
    const deltas = out.events.filter((e) => e.type === "delta") as Extract<
      ProviderStreamEvent,
      { type: "delta" }
    >[];
    expect(deltas.map((d) => d.text)).toEqual(["Hello", " world"]);
    expect(out.emittedDelta).toBe(true);
  });

  it("tolerates unknown/noise line types without throwing or emitting", () => {
    const p = new StreamJsonParser();
    const out = p.push(L.rateLimit + "\n");
    // rate_limit_event carries a session_id, so session may appear, but no
    // delta/usage/error should be produced from it.
    const nonSession = out.events.filter((e) => e.type !== "session");
    expect(nonSession).toHaveLength(0);
  });

  it("parses the terminal result into usage + cost and a usage event", () => {
    const p = new StreamJsonParser();
    const out = p.push(L.result + "\n");
    expect(out.result).toBeTruthy();
    expect(out.result?.usage).toEqual({
      inputTokens: 100,
      cacheCreationInputTokens: 900,
      cacheReadInputTokens: 8000,
      outputTokens: 10,
      costUsd: 0.05,
    });
    expect(out.result?.isError).toBe(false);
    const usageEv = out.events.find((e) => e.type === "usage") as Extract<
      ProviderStreamEvent,
      { type: "usage" }
    >;
    expect(usageEv.usage).toEqual(out.result?.usage);
  });

  it("buffers a JSON object split ACROSS chunk boundaries", () => {
    const p = new StreamJsonParser();
    const whole = L.delta1 + "\n";
    const mid = Math.floor(whole.length / 2);
    // Feed the line in two arbitrary pieces (split mid-JSON, no newline yet).
    const first = p.push(whole.slice(0, mid));
    expect(first.events.filter((e) => e.type === "delta")).toHaveLength(0);
    const second = p.push(whole.slice(mid));
    const deltas = second.events.filter((e) => e.type === "delta") as Extract<
      ProviderStreamEvent,
      { type: "delta" }
    >[];
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe("Hello");
  });

  it("handles multiple lines arriving glued in one chunk", () => {
    const p = new StreamJsonParser();
    const glued = L.init + "\n" + L.delta1 + "\n" + L.delta2 + "\n" + L.result + "\n";
    const out = p.push(glued);
    expect(typesOf(out.events)).toEqual(
      expect.arrayContaining(["session", "delta", "usage"]),
    );
    expect(out.result?.stopReason).toBe("end_turn");
  });

  it("flush() drains a trailing line with no newline", () => {
    const p = new StreamJsonParser();
    p.push(L.init + "\n");
    const pushed = p.push(L.result); // no trailing newline
    expect(pushed.result).toBeUndefined(); // still buffered
    const flushed = p.flush();
    expect(flushed.result).toBeTruthy();
    expect(flushed.result?.usage.outputTokens).toBe(10);
  });

  it("extracts tool_use blocks from an assistant message", () => {
    const p = new StreamJsonParser();
    const line =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]},"session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}';
    const out = p.push(line + "\n");
    const tool = out.events.find((e) => e.type === "tool_use") as Extract<
      ProviderStreamEvent,
      { type: "tool_use" }
    >;
    expect(tool).toBeTruthy();
    expect(tool.name).toBe("Bash");
    expect(tool.input).toEqual({ cmd: "ls" });
  });
});

describe("isPoisonResult", () => {
  it("flags a resume-miss (is_error, 0 turns, 'No conversation found')", () => {
    const p = new StreamJsonParser();
    const out = p.push(L.poisonResult + "\n");
    expect(out.result).toBeTruthy();
    expect(isPoisonResult(out.result as ParsedResult)).toBe(true);
  });

  it("does NOT flag a successful result", () => {
    const p = new StreamJsonParser();
    const out = p.push(L.result + "\n");
    expect(isPoisonResult(out.result as ParsedResult)).toBe(false);
  });

  it("does NOT flag an error that produced real turns", () => {
    const r: ParsedResult = {
      sessionId: "x",
      usage: {
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
      },
      isError: true,
      numTurns: 2,
      errors: ["some mid-turn API error"],
    };
    expect(isPoisonResult(r)).toBe(false);
  });
});

describe("extractUsage", () => {
  it("reads all four token fields, not just the uncached input delta", () => {
    expect(
      extractUsage(
        {
          input_tokens: 17,
          cache_creation_input_tokens: 10472,
          cache_read_input_tokens: 49251,
          output_tokens: 206,
        },
        0.0297508,
      ),
    ).toEqual({
      inputTokens: 17,
      cacheCreationInputTokens: 10472,
      cacheReadInputTokens: 49251,
      outputTokens: 206,
      costUsd: 0.0297508,
    });
  });

  it("coerces missing/garbage fields to 0 and omits an absent cost", () => {
    expect(extractUsage(undefined)).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    });
    expect(
      extractUsage({ input_tokens: "x", output_tokens: 5 }, "free"),
    ).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 5,
    });
  });
});

describe("per-run accumulation (real 2-turn CLI output)", () => {
  const RUN_TOTAL = {
    inputTokens: 18,
    cacheCreationInputTokens: 10651,
    cacheReadInputTokens: 48000,
    outputTokens: 206,
  };

  it("sums per-turn usage to exactly the total the result line reports", () => {
    const p = new StreamJsonParser();
    feed(p, [
      R.init,
      R.t1Start,
      R.t1Thinking,
      R.t1ToolUse,
      R.t1Delta,
      R.t1Stop,
      R.toolResult,
      R.t2Start,
      R.t2Text,
      R.t2Delta,
      R.t2Stop,
    ]);
    // Accumulated BEFORE the result line arrives — proving the result is the
    // run total and that adding it to the turns would double-count.
    expect(p.usageSoFar()).toEqual(RUN_TOTAL);

    const out = p.push(R.result + "\n");
    expect(out.result?.usage).toEqual({ ...RUN_TOTAL, costUsd: 0.02715 });
  });

  it("counts a turn once even though every content block repeats it", () => {
    const p = new StreamJsonParser();
    // Two `assistant` lines share one message id and one usage snapshot.
    feed(p, [R.init, R.t1Start, R.t1Thinking, R.t1ToolUse, R.t1Delta, R.t1Stop]);
    expect(p.usageSoFar()).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 10472,
      cacheReadInputTokens: 18764,
      outputTokens: 149,
    });
  });

  it("prefers message_delta's final output over message_start's placeholder", () => {
    const p = new StreamJsonParser();
    feed(p, [R.init, R.t1Start]);
    expect(p.usageSoFar().outputTokens).toBe(4);
    feed(p, [R.t1Delta]);
    expect(p.usageSoFar().outputTokens).toBe(149);
  });

  it("keeps a turn cut short mid-flight, so a killed run records real spend", () => {
    const p = new StreamJsonParser();
    // Turn 2 opened and was never closed — what a timeout/cancel kill leaves.
    feed(p, [
      R.init,
      R.t1Start,
      R.t1Delta,
      R.t1Stop,
      R.toolResult,
      R.t2Start,
    ]);
    expect(p.usageSoFar()).toEqual({
      inputTokens: 18,
      cacheCreationInputTokens: 10651,
      cacheReadInputTokens: 48000,
      outputTokens: 153,
    });
  });

  it("falls back to assistant-message usage when partials are OFF", () => {
    const p = new StreamJsonParser();
    // No stream_event lines at all, so the assistant line is the only source.
    // A repeat of the same message id is still one turn; a new id is a new one.
    const secondTurn = L.assistant
      .replace("msg_01Hello", "msg_01Second")
      .replace('"output_tokens":10', '"output_tokens":40');
    feed(p, [L.init, L.assistant, L.assistant, secondTurn]);
    expect(p.usageSoFar()).toEqual({
      inputTokens: 200,
      cacheCreationInputTokens: 1800,
      cacheReadInputTokens: 16000,
      outputTokens: 50,
    });
  });
});
