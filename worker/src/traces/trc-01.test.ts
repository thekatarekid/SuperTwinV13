// ===========================================================================
// TRC-01 — Every run leaves a complete trace; zero anonymous calls (build
// P0.7, GoldenEvals V2 §TRC-01, deterministic code assertion — no model).
//
//   1. GHOST CALL: a provider send with NO trace context throws GhostCallError
//      in dev, BEFORE anything spawns. This is the assertion that makes a
//      bypass impossible: the check lives at the single spawn site.
//   2. COMPLETE TRACE: a traced call persists {run_id, pass, model,
//      prompt_version, system_prompt, packed_context, raw_output,
//      parsed_result, repair_count, verdicts, tokens_4way, cost, latency_ms,
//      caller} — the jsonl day file AND the DB index row.
//
// Uses a fake CLI (real spawn, real wire format) so the whole provider path
// runs; the trace store writes into a sandboxed SUPERTWIN_HOME.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import {
  GhostCallError,
  annotateTrace,
  withTraceContext,
} from "./context.js";
import { dayFilePath, type TraceRecord } from "./store.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RAW = "TRACED-PONG";
const INSTRUCTIONS = "TRC TEST INSTRUCTIONS: reply with the token.";
const PAYLOAD = "E|1|say the token";

const stage = mkdtempSync(join(tmpdir(), "st-trc01-"));
const fakeCli = join(stage, "fake-claude.cjs");
const promptFile = join(stage, "instructions.txt");

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  // Real wire format (claude 2.1.197), same fixtures the duplicate-text suite
  // uses: init -> delta -> result with a full 4-way usage split and a cost.
  const init = `{"type":"system","subtype":"init","cwd":"/x","session_id":"${SID}"}`;
  const delta = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(RAW)}}},"session_id":"${SID}"}`;
  const result = `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"${SID}","total_cost_usd":0.05,"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":8000,"output_tokens":10}}`;
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      `  process.stdout.write(${JSON.stringify(init + "\n" + delta + "\n" + result + "\n")});`,
      "  process.exit(0);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);
  writeFileSync(promptFile, INSTRUCTIONS, "utf8");

  setEnv("CLAUDE_BIN", fakeCli);
  setEnv("SUPERTWIN_HOME", stage);
  setEnv("SUPERTWIN_DB_PATH", join(stage, "trc01.db"));
  // This suite IS the trace store's test: opt in to real writes (the default
  // under vitest is a no-op sink so unrelated suites stay hermetic).
  setEnv("SUPERTWIN_TRACE_TEST_WRITES", "1");
  // Enforcement ON — the default this suite asserts.
  setEnv("SUPERTWIN_TRACE_ENFORCE", undefined);
});

afterAll(() => {
  closeDb();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("TRC-01 · ghost calls are impossible", () => {
  it("a send with no trace context throws GhostCallError in dev", async () => {
    const { claudeLocalProvider } = await import(
      "../providers/claude-local/index.js"
    );
    await expect(
      claudeLocalProvider.send({
        runId: "trc-ghost",
        message: PAYLOAD,
        plainCompletion: true,
        onEvent: () => {},
      }),
    ).rejects.toThrow(GhostCallError);
  });
});

describe("TRC-01 · a traced call leaves a complete trace", () => {
  it("persists every field to the day jsonl AND the DB index", async () => {
    const { claudeLocalProvider } = await import(
      "../providers/claude-local/index.js"
    );

    const res = await withTraceContext(
      { pass: "P-TEST", caller: "trc-01.test", promptVersion: "v1-abc" },
      async () => {
        const r = await claudeLocalProvider.send({
          runId: "trc-full",
          message: PAYLOAD,
          plainCompletion: true,
          systemPromptFile: promptFile,
          model: "haiku",
          onEvent: () => {},
        });
        // The parse side, as the runner would report it.
        annotateTrace({
          parsedResult: { records: [{ id: 1, ok: true }] },
          repairCount: 0,
          verdicts: [{ check: "grounded", pass: true }],
        });
        return r;
      },
    );
    expect(res.status).toBe("ok");

    // ---- jsonl day file: the full record.
    const day = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(dayFilePath(day), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TraceRecord);
    const rec = lines.find((r) => r.run_id === "trc-full");
    expect(rec).toBeDefined();
    const t = rec as TraceRecord;

    expect(t.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.attempt).toBe(1);
    expect(t.pass).toBe("P-TEST");
    expect(t.caller).toBe("trc-01.test");
    expect(t.model).toBe("haiku");
    expect(t.prompt_version).toBe("v1-abc");
    expect(t.system_prompt).toBe(INSTRUCTIONS);
    // S0.4 (T1-1): the instruction block goes in ONCE, via
    // --append-system-prompt (system_prompt above) — the packed context is
    // byte-what-the-model-saw on stdin: the payload alone.
    expect(t.packed_context).toBe(PAYLOAD);
    expect(t.raw_output).toBe(RAW);
    expect(t.parsed_result).toEqual({ records: [{ id: 1, ok: true }] });
    expect(t.repair_count).toBe(0);
    expect(t.verdicts).toEqual([{ check: "grounded", pass: true }]);
    expect(t.tokens_4way).toEqual({
      input: 100,
      cache_creation: 900,
      cache_read: 8000,
      output: 10,
    });
    expect(t.cost_usd).toBe(0.05);
    expect(t.latency_ms).toBeGreaterThanOrEqual(0);
    expect(t.status).toBe("ok");

    // ---- DB index row.
    const row = getDb()
      .prepare("SELECT * FROM traces WHERE run_id = ?")
      .get("trc-full") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.pass).toBe("P-TEST");
    expect(row.caller).toBe("trc-01.test");
    expect(row.model).toBe("haiku");
    expect(row.prompt_version).toBe("v1-abc");
    expect(row.input_tokens).toBe(100);
    expect(row.cache_creation_input_tokens).toBe(900);
    expect(row.cache_read_input_tokens).toBe(8000);
    expect(row.output_tokens).toBe(10);
    expect(row.cost_usd).toBe(0.05);
    expect(row.day).toBe(day);
    expect(row.compressed).toBe(0);
  });

  it("a custom sink replaces persistence (what test hermeticity rides on)", async () => {
    const { claudeLocalProvider } = await import(
      "../providers/claude-local/index.js"
    );
    const seen: TraceRecord[] = [];
    await withTraceContext(
      { pass: "P-SINK", caller: "trc-01.test", sink: (r) => seen.push(r) },
      () =>
        claudeLocalProvider.send({
          runId: "trc-sink",
          message: PAYLOAD,
          plainCompletion: true,
          onEvent: () => {},
        }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].run_id).toBe("trc-sink");
    expect(seen[0].pass).toBe("P-SINK");
    // And it did NOT reach the store.
    const day = new Date().toISOString().slice(0, 10);
    expect(readFileSync(dayFilePath(day), "utf8")).not.toContain("trc-sink");
  });
});
