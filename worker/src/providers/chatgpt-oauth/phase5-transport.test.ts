import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  boundedTraceRecord,
  dayFilePath,
  MAX_TRACE_HEAVY_FIELD_BYTES,
  MAX_TRACE_LINE_BYTES,
  type CompressedField,
  type TraceRecord,
  writeTrace,
} from "../../traces/store.js";

const execFileAsync = promisify(execFile);

const traceHome = mkdtempSync(join(tmpdir(), "supertwin-phase5-traces-"));
const traceDbFile = join(traceHome, "trace-lock.db");
const traceDb = new Database(traceDbFile);
traceDb.pragma("busy_timeout = 5000");
const previousHome = process.env.SUPERTWIN_HOME;
beforeAll(() => { process.env.SUPERTWIN_HOME = traceHome; });
afterAll(() => {
  traceDb.close();
  if (previousHome === undefined) delete process.env.SUPERTWIN_HOME;
  else process.env.SUPERTWIN_HOME = previousHome;
  rmSync(traceHome, { recursive: true, force: true });
});

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    trace_id: "trace-1", ts: "2026-09-09T00:00:00.000Z", run_id: "run-1",
    attempt: 1, pass: "phase5", caller: "phase5.test", model: "gpt-test",
    prompt_version: null, system_prompt: "", packed_context: "input", raw_output: "output",
    parsed_result: null, repair_count: 0, verdicts: null,
    tokens_4way: { input: 1, cache_creation: 0, cache_read: 0, output: 1 },
    cost_usd: null, latency_ms: 1, status: "ok", ...overrides,
  };
}

describe("Phase 5 bounded direct transport evidence", () => {
  it("bounds provider-controlled trace fields and the complete JSONL record", () => {
    const hostile = "x".repeat(MAX_TRACE_HEAVY_FIELD_BYTES + 1);
    const bounded = boundedTraceRecord(trace({
      system_prompt: hostile,
      packed_context: hostile,
      raw_output: hostile,
      parsed_result: { hostile },
      verdicts: { hostile },
    }));
    expect((bounded.system_prompt as CompressedField).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((bounded.packed_context as CompressedField).chars).toBe(hostile.length);
    expect((bounded.raw_output as CompressedField).chars).toBe(hostile.length);
    expect(bounded.parsed_result).toMatchObject({ omitted: "size-limit" });
    expect(bounded.verdicts).toMatchObject({ omitted: "size-limit" });
    expect(bounded.compressed).toBe(true);
    const persisted = `${JSON.stringify(bounded)}\n`;
    expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(MAX_TRACE_LINE_BYTES);
    expect(persisted).not.toContain(hostile);
  });

  it("safely replaces non-JSON values instead of passing undefined to byte accounting", () => {
    const bounded = boundedTraceRecord(trace({
      parsed_result: () => undefined,
      verdicts: Symbol("not-json"),
    }));
    expect(bounded.parsed_result).toEqual({ omitted: "unserializable" });
    expect(bounded.verdicts).toEqual({ omitted: "unserializable" });
  });

  it("does not index when append fails", () => {
    let indexes = 0;
    expect(() => writeTrace(trace({ trace_id: "append-failure" }), {
      db: traceDb,
      append: () => { throw new Error("disk full"); },
      index: () => { indexes += 1; },
    })).toThrow("disk full");
    expect(indexes).toBe(0);
  });

  it("rolls a partial append back to the prior complete-line boundary", () => {
    const record = trace({ trace_id: "partial-append" });
    expect(() => writeTrace(record, {
      db: traceDb,
      append: (file, line) => {
        appendFileSync(file, line.slice(0, 73), "utf8");
        throw new Error("short write");
      },
      index: () => undefined,
    })).toThrow("short write");
    writeTrace(record, { db: traceDb, index: () => undefined });
    const lines = readFileSync(dayFilePath("2026-09-09"), "utf8").trim().split("\n");
    expect(lines.filter((line) => (JSON.parse(line) as TraceRecord).trace_id === record.trace_id)).toHaveLength(1);
  });

  it("repairs an index failure on retry without duplicating its JSONL line", () => {
    let attempts = 0;
    const record = trace({ trace_id: "index-recovery" });
    const deps = {
      db: traceDb,
      append: (file: string, line: string) => appendFileSync(file, line, "utf8"),
      index: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("index unavailable");
      },
    };
    expect(() => writeTrace(record, deps)).toThrow("index unavailable");
    writeTrace(record, deps);
    const matches = readFileSync(dayFilePath("2026-09-09"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as TraceRecord)
      .filter((saved) => saved.trace_id === record.trace_id);
    expect(matches).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("serializes same-day writers into intact, independently parseable lines", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `concurrent-${i}`);
    await Promise.all(ids.map(async (traceId) => writeTrace(trace({ trace_id: traceId }), {
      db: traceDb,
      index: () => undefined,
    })));
    const savedIds = readFileSync(dayFilePath("2026-09-09"), "utf8")
      .trim().split("\n").map((line) => (JSON.parse(line) as TraceRecord).trace_id);
    expect(new Set(savedIds).size).toBe(savedIds.length);
    expect(ids.every((id) => savedIds.includes(id))).toBe(true);
  });

  it("serializes actual competing processes without interleaved records", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, "../../traces/store-lock.fixture.ts");
    const file = join(traceHome, "traces", "process-contention.jsonl");
    const tsx = join(here, "../../../../node_modules/.bin/tsx");
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      execFileAsync(tsx, [fixture, traceDbFile, file, `process-${i}`, "5"]),
    ));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(new Set(lines).size).toBe(12);
  });

  it("a live old writer remains serialized beyond the former stale threshold", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, "../../traces/store-lock.fixture.ts");
    const file = join(traceHome, "traces", "stale-overlap.jsonl");
    const ready = join(traceHome, "long-writer-ready");
    const tsx = join(here, "../../../../node_modules/.bin/tsx");
    const oldOwner = execFileAsync(tsx, [fixture, traceDbFile, file, "old", "120", ready]);
    for (let i = 0; i < 100; i += 1) {
      try { readFileSync(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 3)); }
    }
    const successor = execFileAsync(tsx, [fixture, traceDbFile, file, "successor", "0"]);
    await Promise.all([oldOwner, successor]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toEqual(["old", "successor"]);
  });

  it("recovers the SQLite lease immediately after a writer process is killed", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, "../../traces/store-lock.fixture.ts");
    const file = join(traceHome, "traces", "killed-owner.jsonl");
    const ready = join(traceHome, "killed-ready");
    const tsx = join(here, "../../../../node_modules/.bin/tsx");
    // Invoke Node directly so SIGKILL targets the process that owns SQLite's
    // file descriptor, rather than a package-manager wrapper process.
    const child = spawn(process.execPath, ["--import", "tsx", fixture, traceDbFile, file, "killed", "10000", ready]);
    for (let i = 0; i < 200; i += 1) {
      try { readFileSync(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 3)); }
    }
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await execFileAsync(tsx, [fixture, traceDbFile, file, "recovered", "0"]);
    expect(readFileSync(file, "utf8").trim()).toBe("recovered");
  });

  it("rejects a trace whose fixed metadata alone cannot fit the line cap", () => {
    expect(() => boundedTraceRecord(trace({
      caller: "x".repeat(MAX_TRACE_LINE_BYTES + 1),
    }))).toThrow("trace metadata exceeds the storage limit");
  });

  it("keeps the ChatGPT inference transport free of child-process APIs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["index.ts", "request.ts", "sse.ts", "usage.ts"]) {
      const source = readFileSync(join(here, name), "utf8");
      expect(source).not.toMatch(/(?:node:)?child_process|\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/);
    }
  });
});
