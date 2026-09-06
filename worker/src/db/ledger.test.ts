// ===========================================================================
// S0.9 — Ledger hygiene (T8-1, T8-2, T8-3). No live model calls: every
// provider is a stub, every trace is recorded by hand or synthesized.
//
//   T8-1  `runs.pass` and `runs.origin` are populated AT INSERT — never NULL,
//         whichever path wrote the row (recordRun, logRun, the runners).
//   T8-2  The trace index row lands in the SAME transaction as `runs` +
//         `extraction_runs`: runs count == traces count, `runs.trace_id`
//         points at the row, and a failed half rolls the whole write back.
//   T8-3  digest-pass, the bar answer and the media reads take a pool slot.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import { logRun, runMigrations, writeRunLedger } from "./index.js";
import { recordRun } from "./run-accounting.js";
import type { PendingMediaRow } from "./ingest.js";
import {
  annotateTrace,
  hasTraceContext,
  recordProviderInvocation,
  withTraceContext,
} from "../traces/context.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, ProviderResult, SendOptions } from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import { runJsonPass, resetStableSystemPromptsForTests } from "../brain/llm.js";
import { runDigestPass } from "../brain/digest-pass.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { describeMedia, describeMediaBatch } from "../media/describe.js";

let tmpDir: string;
const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ledger-"));
  setEnv("SUPERTWIN_DB_PATH", join(tmpDir, "test.db"));
  setEnv("SUPERTWIN_HOME", tmpDir);
  // This suite asserts on the trace index; the flush must really write.
  setEnv("SUPERTWIN_TRACE_TEST_WRITES", "1");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
});

afterEach(() => {
  closeDb();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };

function counts(): { runs: number; traces: number; nullPass: number; nullOrigin: number; unlinked: number } {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    runs: one(`SELECT COUNT(*) AS n FROM runs`),
    traces: one(`SELECT COUNT(*) AS n FROM traces`),
    nullPass: one(`SELECT COUNT(*) AS n FROM runs WHERE pass IS NULL OR pass = ''`),
    nullOrigin: one(`SELECT COUNT(*) AS n FROM runs WHERE origin IS NULL OR origin = ''`),
    unlinked: one(
      `SELECT COUNT(*) AS n FROM runs r WHERE trace_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM traces t WHERE t.id = r.trace_id)`,
    ),
  };
}

function runRow(id: string): Record<string, unknown> {
  return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown>;
}

function logParams(runId: string, kind = "chat") {
  return {
    provider: "claude-local",
    sessionId: null,
    runId,
    kind,
    promptChars: 10,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: null,
    durationMs: 100,
    status: "ok" as const,
    errorCode: null,
    role: kind,
    model: "haiku",
  };
}

function invocation(runId: string, attempt = 1) {
  return {
    runId,
    attempt,
    model: "haiku",
    systemPrompt: "SYS",
    packedContext: "E|1|hi",
    rawOutput: "PONG",
    usage: { ...USAGE, costUsd: 0.01 },
    latencyMs: 12,
    status: "ok",
    ts: new Date().toISOString(),
  };
}

/** Provider stub — never spawns anything; records the sends. */
function stubProvider(
  reply: string,
  opts: { status?: ProviderResult["status"]; onSend?: () => void } = {},
): Provider & { calls: SendOptions[] } {
  const calls: SendOptions[] = [];
  return {
    id: "stub",
    calls,
    cancel: () => false,
    async send(o: SendOptions): Promise<ProviderResult> {
      calls.push(o);
      opts.onSend?.();
      if (reply) o.onEvent({ type: "delta", text: reply });
      const status = opts.status ?? "ok";
      return {
        sessionId: "",
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 20 },
        freshFallback: false,
        status,
        errorCode: status === "error" ? "CLI_ERROR" : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// T8-1 — pass and origin at insert
// ---------------------------------------------------------------------------

describe("S0.9 T8-1 · runs.pass / runs.origin are populated at insert", () => {
  it("recordRun defaults pass to kind then role, and origin to live — never NULL", () => {
    recordRun({ role: "orient", model: "haiku", cohortId: null, kind: "orient.v6", usage: USAGE, id: "r1" });
    recordRun({ role: "chat", model: "haiku", cohortId: null, usage: USAGE, id: "r2" });
    recordRun({
      role: "extract",
      model: "haiku",
      cohortId: null,
      kind: "P-CL1",
      pass: "extract.v3",
      origin: "backfill",
      usage: USAGE,
      id: "r3",
    });
    expect(runRow("r1")).toMatchObject({ pass: "orient.v6", origin: "live" });
    expect(runRow("r2")).toMatchObject({ pass: "chat", origin: "live" });
    expect(runRow("r3")).toMatchObject({ pass: "extract.v3", origin: "backfill" });
    expect(counts()).toMatchObject({ nullPass: 0, nullOrigin: 0 });
  });

  it("refuses an origin outside live|backfill rather than storing a made-up lane", () => {
    expect(() =>
      recordRun({
        role: "chat",
        model: "haiku",
        cohortId: null,
        origin: "sideways" as unknown as "live",
        usage: USAGE,
      }),
    ).toThrow(/runs\.origin/);
  });

  it("logRun's mirror carries pass/origin from the caller, else the trace pass and live", async () => {
    logRun({ ...logParams("chat-1"), pass: undefined, origin: undefined });
    await withTraceContext({ pass: "media", caller: "test" }, async () => {
      logRun({ ...logParams("media-1", "media"), pass: undefined, origin: "backfill" });
    });
    const rows = getDb()
      .prepare(`SELECT kind, pass, origin FROM runs ORDER BY kind`)
      .all() as { kind: string; pass: string; origin: string }[];
    expect(rows).toEqual([
      { kind: "chat", pass: "chat", origin: "live" },
      { kind: "media", pass: "media", origin: "backfill" },
    ]);
    expect(counts()).toMatchObject({ nullPass: 0, nullOrigin: 0 });
  });
});

// ---------------------------------------------------------------------------
// T8-2 — the trace row in the same transaction
// ---------------------------------------------------------------------------

describe("S0.9 T8-2 · the trace index row lands with the runs row", () => {
  it("a recorded invocation is indexed when the ledger writes, and the flush completes the SAME row", async () => {
    await withTraceContext({ pass: "orient.v6", caller: "test", promptVersion: "v-1" }, async () => {
      recordProviderInvocation(invocation("run-a"));
      // The ledger write happens INSIDE the scope, before the flush — the
      // trace is already in the DB when this returns.
      writeRunLedger({
        run: { id: "run-a", role: "orient", model: "haiku", cohortId: null, kind: "orient.v6", usage: USAGE },
        log: logParams("run-a", "orient.v6"),
      });
      expect(counts()).toMatchObject({ runs: 1, traces: 1, unlinked: 0 });
      annotateTrace({ repairCount: 1 });
    });
    // After the flush: still one trace, now carrying the annotation.
    const c = counts();
    expect(c).toMatchObject({ runs: 1, traces: 1, unlinked: 0, nullPass: 0, nullOrigin: 0 });
    const run = runRow("run-a");
    const trace = getDb()
      .prepare(`SELECT id, run_id, pass, repair_count FROM traces WHERE id = ?`)
      .get(run.trace_id) as { id: string; run_id: string; pass: string; repair_count: number };
    expect(trace).toMatchObject({ run_id: "run-a", pass: "orient.v6", repair_count: 1 });
    expect(run.pass).toBe("orient.v6");
  });

  it("a run logged AFTER its scope flushed links to the existing trace — no second row (chat pattern)", async () => {
    await withTraceContext({ pass: "chat", caller: "server/chat" }, async () => {
      recordProviderInvocation(invocation("chat-run"));
    });
    expect(counts()).toMatchObject({ runs: 0, traces: 1 });
    logRun(logParams("chat-run"));
    const c = counts();
    expect(c).toMatchObject({ runs: 1, traces: 1, unlinked: 0 });
  });

  it("a run the provider never recorded an invocation for gets a synthesized trace — cardinality holds", () => {
    writeRunLedger({
      run: {
        id: "no-inv",
        role: "extract",
        model: "haiku",
        cohortId: null,
        kind: "P-CL1",
        status: "error",
        errorCode: "SPAWN_FAILED",
        usage: USAGE,
      },
      log: { ...logParams("no-inv", "P-CL1"), status: "error", errorCode: "SPAWN_FAILED" },
    });
    expect(counts()).toMatchObject({ runs: 1, traces: 1, unlinked: 0 });
    const trace = getDb()
      .prepare(`SELECT pass, caller, status, input_tokens FROM traces WHERE run_id = ?`)
      .get("no-inv") as Record<string, unknown>;
    expect(trace).toMatchObject({ pass: "P-CL1", caller: "ledger", status: "error", input_tokens: 10 });
  });

  it("the write is ONE transaction: a failed extraction_runs half rolls back runs and the trace", () => {
    expect(() =>
      writeRunLedger({
        run: { id: "atomic", role: "chat", model: "haiku", cohortId: null, kind: "chat", usage: USAGE },
        // provider is NOT NULL on extraction_runs — this half throws.
        log: { ...logParams("atomic"), provider: null as unknown as string },
      }),
    ).toThrow();
    expect(counts()).toEqual({ runs: 0, traces: 0, nullPass: 0, nullOrigin: 0, unlinked: 0 });
  });

  it("runJsonPass (production deps) writes runs, extraction_runs and the trace together", async () => {
    const provider = stubProvider(JSON.stringify({ ok: true }));
    const result = await runJsonPass(
      {
        pass: "ledger-test.v1",
        system: "SYSTEM",
        user: "hello",
        role: "orient",
        model: "haiku",
        origin: "backfill",
        validate: (parsed) => parsed as { ok: boolean },
      },
      { provider },
    );
    expect(result.status).toBe("ok");
    const c = counts();
    expect(c).toMatchObject({ runs: 1, traces: 1, unlinked: 0, nullPass: 0, nullOrigin: 0 });
    const run = runRow(result.runIds[0]!);
    expect(run).toMatchObject({ pass: "ledger-test.v1", origin: "backfill", role: "orient" });
    const er = getDb().prepare(`SELECT COUNT(*) AS n FROM extraction_runs`).get() as { n: number };
    expect(er.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T8-3 — the three unpooled call sites take a pool slot
// ---------------------------------------------------------------------------

function cat2Bundle(): DeltaBundle {
  return {
    streamId: "wa:st:g@g.us",
    streamKey: "g@g.us",
    lane: "history",
    ageBand: "C",
    category: "cat2",
    day: "2024-03-28",
    part: 1,
    partCount: 1,
    events: [
      {
        rowid: 1,
        id: "e1",
        ts: "2024-03-02T10:00:00Z",
        kind: "wa.message",
        text: "joined flipkart today!",
        actor: "contact:dev",
        origin: "backfill",
        ageBand: "C",
        rolesJson: null,
        payloadJson: null,
      },
    ],
  };
}

const DIGEST_ANSWER = JSON.stringify({
  summary: "A quiet month. Dev announced a job change.",
  claims: [{ subject: "Dev", text: "Dev joined Flipkart", evidence: [{ quote: "joined flipkart today!" }] }],
  recurrences: [],
  tasks: [],
});

describe("S0.9 T8-3 · digest, bar answer and media reads go through the pool", () => {
  it("runDigestPass holds an LLM understanding-lane slot and writes its ledger row (digest / backfill)", async () => {
    const pool = new ResourcePool({ limits: { llm: 2 } });
    let inFlightDuringSend = 0;
    let traced = false;
    const provider = stubProvider(DIGEST_ANSWER, {
      onSend: () => {
        inFlightDuringSend = pool.inFlight("llm");
        traced = hasTraceContext();
      },
    });
    const report = await runDigestPass(cat2Bundle(), { provider, pool });
    expect(report.status).toBe("ok");
    expect(inFlightDuringSend).toBe(1);
    expect(traced).toBe(true);
    expect(pool.lanePeakInFlight("understanding")).toBe(1);
    expect(pool.inFlight("llm")).toBe(0);

    const c = counts();
    expect(c).toMatchObject({ runs: 1, traces: 1, unlinked: 0, nullPass: 0, nullOrigin: 0 });
    const run = getDb().prepare(`SELECT role, pass, origin FROM runs`).get() as Record<string, unknown>;
    expect(run).toMatchObject({ role: "digest", pass: "digest.v2", origin: "backfill" });
  });

  it("a failed digest call still writes its ledger row and reports failed", async () => {
    const pool = new ResourcePool({ limits: { llm: 2 } });
    const provider = stubProvider("", { status: "error" });
    const report = await runDigestPass(cat2Bundle(), { provider, pool });
    expect(report.status).toBe("failed");
    expect(counts()).toMatchObject({ runs: 1, traces: 1, unlinked: 0 });
    const run = getDb().prepare(`SELECT status, role FROM runs`).get() as Record<string, unknown>;
    expect(run).toMatchObject({ status: "error", role: "digest" });
  });

  it("describeMedia and describeMediaBatch take an ENRICHMENT-lane slot", async () => {
    mkdirSync(join(tmpDir, "media"), { recursive: true });
    const path = join(tmpDir, "media", "IMG.jpg");
    writeFileSync(path, "x");
    const row: PendingMediaRow = {
      id: "wa:alice@x/IMG",
      kind: "image",
      mediaPath: path,
      thumbPath: null,
      mime: "image/jpeg",
      filename: "IMG.jpg",
      seconds: null,
      caption: null,
    };
    const pool = new ResourcePool({ limits: { llm: 4 } });
    let enrichmentDuringSend = 0;
    const provider = stubProvider("A whiteboard.", {
      onSend: () => {
        enrichmentDuringSend = pool.inFlight("llm");
      },
    });
    const solo = await describeMedia(row, { provider, pool, runId: "media-1" });
    expect(solo.status).toBe("done");
    expect(enrichmentDuringSend).toBe(1);
    expect(pool.lanePeakInFlight("enrichment")).toBe(1);
    expect(pool.lanePeakInFlight("understanding")).toBe(0);

    const batchProvider = stubProvider(`<<IMG-1>> A whiteboard.`, {
      onSend: () => {
        enrichmentDuringSend = pool.inFlight("llm");
      },
    });
    await describeMediaBatch([row], { provider: batchProvider, pool, runId: "media-batch-1" });
    expect(batchProvider.calls).toHaveLength(1);
    expect(enrichmentDuringSend).toBe(1);
    expect(pool.inFlight("llm")).toBe(0);
  });
});
