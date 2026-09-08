// ===========================================================================
// FIX-C2 — the CLI's turn cap is a SOFT stop, not a broken run.
//
// THE DEFECT, measured on the 13.11.5 install: 35 of 187 runs died with
// `CLI_ERROR / "Reached maximum number of turns (1)"` — orient.v7 18, decide 9,
// critic.v5 8 — 542K tokens and $0.43 spent on nothing but preambles. The
// traces show why: the model opened with one line ("I'll process this
// history-mode bundle of 92 events across 9 WhatsApp streams"), the CLI ended
// the run on `--max-turns 1`, and the adapter called that a CLI_ERROR. The
// ladder then re-issued the WHOLE full-context call, and the same failure fed
// the S0.7 consecutive-failure breaker.
//
// This file pins the three halves of the fix at the provider boundary:
//   1. plain completion is bounded at TWO turns, not one;
//   2. a turn-cap stop is `MAX_TURNS`, distinguishable from a real failure,
//      with the model's streamed bytes intact;
//   3. the pool treats it as a soft stop: no retry ladder, no breaker.
//
// Zero live model calls: a node script stands in for the CLI.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isMaxTurnsResult, type ParsedResult } from "./parser.js";
import {
  BREAKER_FAILURES,
  ResourcePool,
  classifyFailure,
  isSoftStop,
} from "../pool.js";
import type { ProviderStreamEvent } from "../types.js";

// ---------------------------------------------------------------------------
// 1. Recognising the stop
// ---------------------------------------------------------------------------

function result(over: Partial<ParsedResult>): ParsedResult {
  return {
    sessionId: "s",
    usage: {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    },
    isError: false,
    numTurns: 1,
    ...over,
  };
}

describe("isMaxTurnsResult", () => {
  it("recognises the subtype AND the message the user's own runs carried", () => {
    expect(isMaxTurnsResult(result({ isError: true, subtype: "error_max_turns" }))).toBe(true);
    expect(
      isMaxTurnsResult(result({ isError: true, errors: ["Reached maximum number of turns (1)"] })),
    ).toBe(true);
  });

  it("is not a poison result, not an API error, and never a clean run", () => {
    expect(
      isMaxTurnsResult(
        result({ isError: true, numTurns: 0, subtype: "error_during_execution", errors: ["No conversation found with session ID: x"] }),
      ),
    ).toBe(false);
    expect(isMaxTurnsResult(result({ isError: true, errors: ["overloaded_error"] }))).toBe(false);
    expect(isMaxTurnsResult(result({ isError: false, subtype: "success" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The adapter: a soft stop with the model's bytes intact
// ---------------------------------------------------------------------------

const stage = mkdtempSync(join(tmpdir(), "st-max-turns-"));
const fakeCli = join(stage, "fake-claude.cjs");
const saved = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

/**
 * A CLI that streams one preamble delta and then stops on its turn cap —
 * byte-for-byte the shape observed in `traces/2026-09-06.jsonl`: exit code 0,
 * a result line with is_error and the max-turns message, real spend behind it.
 */
const PREAMBLE = "I'm filing 24 events from 7 WhatsApp streams.";

beforeAll(() => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: PREAMBLE } },
    }),
    JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 1,
      session_id: "11111111-1111-4111-8111-111111111111",
      total_cost_usd: 0.0216,
      errors: ["Reached maximum number of turns (1)"],
      usage: { input_tokens: 10, output_tokens: 12 },
    }),
  ];
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      `const lines = ${JSON.stringify(lines)};`,
      'process.stdin.resume();',
      'process.stdin.on("end", () => {',
      '  for (const l of lines) process.stdout.write(l + "\\n");',
      "  process.exit(0);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);
  setEnv("CLAUDE_BIN", fakeCli);
  setEnv("HOME", stage);
  setEnv("SUPERTWIN_TRACE_ENFORCE", "0");
});

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the adapter on a turn-cap stop", () => {
  it("reports MAX_TURNS — not CLI_ERROR — and the streamed answer survives", async () => {
    const { claudeLocalProvider } = await import("./index.js");
    const events: ProviderStreamEvent[] = [];
    let text = "";
    const res = await claudeLocalProvider.send({
      runId: "mt-1",
      message: "pack",
      plainCompletion: true,
      allowedTools: [],
      onEvent: (e) => {
        events.push(e);
        if (e.type === "delta") text += e.text;
      },
    });
    expect(res.status).toBe("error");
    // The whole point: a code the caller can act on. CLI_ERROR meant "re-issue
    // the same 22K-token pack"; MAX_TURNS means "you already have the words".
    expect(res.errorCode).toBe("MAX_TURNS");
    expect(text).toBe(PREAMBLE);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ code: "MAX_TURNS" });
    expect((err as { message: string }).message).toContain("maximum number of turns");
  });
});

// ---------------------------------------------------------------------------
// 3. The pool: soft stop, no ladder, no breaker
// ---------------------------------------------------------------------------

describe("the pool on a soft stop", () => {
  it("names it a soft stop by code and by message", () => {
    expect(isSoftStop({ code: "MAX_TURNS" })).toBe(true);
    expect(isSoftStop({ code: "CLI_ERROR", message: "Reached maximum number of turns (1)" })).toBe(true);
    expect(isSoftStop({ code: "TIMEOUT", message: "run exceeded 120000ms" })).toBe(false);
  });

  it("hands it straight back: no wait, no retry budget spent", () => {
    const d = classifyFailure({ code: "MAX_TURNS", message: "Reached maximum number of turns (1)" });
    expect(d.softStop).toBe(true);
    expect(d.action).toBe("quarantine"); // i.e. never retried from inside the pool
    expect(d.waitMs).toBe(0);
    expect(d.spendsRetryBudget).toBe(false);
  });

  it("never trips the S0.7 breaker, however many arrive in a row", () => {
    const pool = new ResourcePool();
    for (let i = 0; i < BREAKER_FAILURES * 2; i++) {
      const d = pool.noteFailure("llm:understanding", {
        code: "MAX_TURNS",
        message: "Reached maximum number of turns (1)",
      });
      expect(d.breakerTripped).toBeUndefined();
    }
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    expect(pool.breakerFor("llm:understanding")).toBeNull();
    expect(pool.isPaused("llm:understanding")).toBe(false);
  });

  it("a real failure still counts — a soft stop between two does not reset it", () => {
    const pool = new ResourcePool();
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) {
      pool.noteFailure("llm:understanding", { code: "TIMEOUT", message: "boom" });
    }
    pool.noteFailure("llm:understanding", { code: "MAX_TURNS", message: "Reached maximum number of turns (1)" });
    expect(pool.consecutiveFailures("llm:understanding")).toBe(BREAKER_FAILURES - 1);
    const last = pool.noteFailure("llm:understanding", { code: "TIMEOUT", message: "boom" });
    expect(last.breakerTripped).toBe(true);
  });
});
