// ===========================================================================
// Trace retention (build P0.7, spec §17.4): after 30 days a day file is
// compressed — heavy fields hashed to {sha256, chars}, every Nth record kept
// whole as a sample — atomically, idempotently, and mirrored to the index.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { compressOldTraces } from "./retention.js";
import {
  dayFilePath,
  ensureTracesSchema,
  tracesRoot,
  type CompressedField,
  type TraceRecord,
} from "./store.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const OLD_DAY = "2026-07-14"; // 45 days old — must compress
const CUTOFF_DAY = "2026-07-29"; // exactly 30 days old — still within retention
const RECORDS = 45;

const stage = mkdtempSync(join(tmpdir(), "st-trc-retention-"));
const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function fakeRecord(day: string, i: number): TraceRecord {
  return {
    trace_id: `${day}-trace-${i}`,
    ts: `${day}T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
    run_id: `${day}-run-${i}`,
    attempt: 1,
    pass: "P-TEST",
    caller: "retention.test",
    model: "haiku",
    prompt_version: "v1",
    system_prompt: `SYSTEM PROMPT ${i} — long instructions the model saw`,
    packed_context: `PACKED CONTEXT ${i} — the whole delta bundle body`,
    raw_output: `RAW OUTPUT ${i}`,
    parsed_result: { records: [{ id: i }] },
    repair_count: 0,
    verdicts: null,
    tokens_4way: { input: 10, cache_creation: 20, cache_read: 30, output: 5 },
    cost_usd: 0.01,
    latency_ms: 1200,
    status: "ok",
  };
}

function writeDayFile(day: string, count: number): void {
  mkdirSync(tracesRoot(), { recursive: true });
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify(fakeRecord(day, i)),
  );
  writeFileSync(dayFilePath(day), `${lines.join("\n")}\n`, "utf8");
}

function readDayFile(day: string): TraceRecord[] {
  return readFileSync(dayFilePath(day), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TraceRecord);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeAll(() => {
  setEnv("SUPERTWIN_HOME", stage);
  setEnv("SUPERTWIN_DB_PATH", join(stage, "retention.db"));
  writeDayFile(OLD_DAY, RECORDS);
  writeDayFile(CUTOFF_DAY, 3);

  // Index rows for the old day, so the compressed flag flip is observable.
  const db = getDb();
  ensureTracesSchema(db);
  const insert = db.prepare(
    `INSERT INTO traces (id, run_id, pass, caller, day, file, compressed)
     VALUES (?, ?, 'P-TEST', 'retention.test', ?, ?, 0)`,
  );
  for (let i = 0; i < 3; i++) {
    insert.run(`${OLD_DAY}-trace-${i}`, `${OLD_DAY}-run-${i}`, OLD_DAY, dayFilePath(OLD_DAY));
  }
});

afterAll(() => {
  closeDb();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("30-day trace compression", () => {
  it("hashes heavy fields, keeps every Nth record whole, flips the index flag", () => {
    const stats = compressOldTraces({ now: NOW });
    expect(stats.scanned).toBe(1); // only the 45-day-old file qualifies
    expect(stats.rewrittenFiles).toBe(1);
    expect(stats.sampledKeeps).toBe(3); // 45 records / keepEvery 20 -> 0, 20, 40
    expect(stats.compressedRecords).toBe(RECORDS - 3);

    const records = readDayFile(OLD_DAY);
    expect(records).toHaveLength(RECORDS);

    for (let i = 0; i < RECORDS; i++) {
      const rec = records[i];
      const original = fakeRecord(OLD_DAY, i);
      if (i % 20 === 0) {
        // Sample keeps stay whole, byte-for-byte on the heavy fields.
        expect(rec.sampled_keep).toBe(true);
        expect(rec.compressed).toBeFalsy();
        expect(rec.packed_context).toBe(original.packed_context);
        expect(rec.system_prompt).toBe(original.system_prompt);
        expect(rec.raw_output).toBe(original.raw_output);
        expect(rec.parsed_result).toEqual(original.parsed_result);
      } else {
        expect(rec.compressed).toBe(true);
        const packed = rec.packed_context as CompressedField;
        expect(packed.sha256).toBe(sha256(original.packed_context as string));
        expect(packed.chars).toBe((original.packed_context as string).length);
        const sys = rec.system_prompt as CompressedField;
        expect(sys.sha256).toBe(sha256(original.system_prompt as string));
        expect((rec.raw_output as CompressedField).sha256).toBe(
          sha256(original.raw_output as string),
        );
        // null verdicts stay null — nothing to hash.
        expect(rec.verdicts).toBeNull();
      }
      // Light fields survive on every record — the index stays queryable.
      expect(rec.run_id).toBe(original.run_id);
      expect(rec.tokens_4way).toEqual(original.tokens_4way);
      expect(rec.cost_usd).toBe(original.cost_usd);
      expect(rec.latency_ms).toBe(original.latency_ms);
    }

    // Index rows flipped.
    const flags = getDb()
      .prepare("SELECT compressed FROM traces WHERE day = ?")
      .all(OLD_DAY) as { compressed: number }[];
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((r) => r.compressed === 1)).toBe(true);
  });

  it("leaves the cutoff day (exactly 30 days old) untouched", () => {
    const records = readDayFile(CUTOFF_DAY);
    expect(records.every((r) => !r.compressed && !r.sampled_keep)).toBe(true);
    expect(typeof records[0].packed_context).toBe("string");
  });

  it("is idempotent — a second sweep rewrites nothing", () => {
    const before = readFileSync(dayFilePath(OLD_DAY), "utf8");
    const stats = compressOldTraces({ now: NOW });
    expect(stats.rewrittenFiles).toBe(0);
    expect(readFileSync(dayFilePath(OLD_DAY), "utf8")).toBe(before);
  });
});
