// ===========================================================================
// /api/ops exposes the pool's queue and its breakers (V6 P1 S0.7):
//   BND-12 — `waiting` readable per class and per lane;
//   SPD-07 — a tripped breaker is on the response as the banner's payload.
// Real server on an ephemeral port, real temp DB, closed in afterAll.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-ops-pool-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { resourcePool, BREAKER_FAILURES, BREAKER_PAUSE_MS } = await import("../providers/pool.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };
type LaneView = {
  lane: string;
  paused: boolean;
  pausedForMs: number;
  inFlight: number;
  waiting: number;
  waiterCap: number;
  breaker: { lane: string; failures: number; lastCode: string | null } | null;
};
type OpsBody = {
  lanes: LaneView[];
  waiting: Record<string, number>;
  breakers: { lane: string; failures: number }[];
};

let server: ServerHandle;
let base: string;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  resourcePool.resumeLane("llm:understanding");
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("BND-12 — `waiting` on /api/ops", () => {
  it("reports the queue per class and per LLM lane, and the cap it is bounded by", async () => {
    // Hold every embed slot plus part of its queue, then read.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cap = resourcePool.limitOf("embed");
    const held = Array.from({ length: cap + 2 }, () => resourcePool.run("embed", () => gate));
    await new Promise((r) => setTimeout(r, 0));

    const body = (await (await fetch(`${base}/api/ops/lanes`)).json()) as OpsBody;
    expect(body.waiting.embed).toBe(2);
    expect(body.waiting.llm).toBe(0);
    const embed = body.lanes.find((l) => l.lane === "embed")!;
    expect(embed.inFlight).toBe(cap);
    expect(embed.waiting).toBe(2);
    expect(embed.waiterCap).toBe(4 * cap);
    const understanding = body.lanes.find((l) => l.lane === "llm:understanding")!;
    expect(understanding.waiting).toBe(0);
    expect(understanding.waiterCap).toBe(4 * resourcePool.effectiveLlmLimit());
    expect(body.breakers).toEqual([]);

    release();
    await Promise.all(held);
    const after = (await (await fetch(`${base}/api/ops/import`)).json()) as OpsBody;
    expect(after.waiting.embed).toBe(0);
    expect(after.lanes.find((l) => l.lane === "embed")!.inFlight).toBe(0);
  });
});

describe("SPD-07 — the breaker banner on /api/ops", () => {
  it("a tripped lane shows paused with its breaker, and the banner is in `breakers`", async () => {
    for (let i = 0; i < BREAKER_FAILURES; i++) {
      resourcePool.noteFailure("llm:understanding", { code: "CLI_ERROR", message: "exit 1" }, 3);
    }
    const body = (await (await fetch(`${base}/api/ops/import`)).json()) as OpsBody;
    const lane = body.lanes.find((l) => l.lane === "llm:understanding")!;
    expect(lane.paused).toBe(true);
    expect(lane.pausedForMs).toBeGreaterThan(BREAKER_PAUSE_MS - 60_000);
    expect(lane.pausedForMs).toBeLessThanOrEqual(BREAKER_PAUSE_MS);
    expect(lane.breaker).toMatchObject({ lane: "llm:understanding", failures: BREAKER_FAILURES, lastCode: "CLI_ERROR" });
    expect(body.breakers.map((b) => b.lane)).toEqual(["llm:understanding"]);
    // The sibling lane is untouched.
    expect(body.lanes.find((l) => l.lane === "llm:enrichment")!.breaker).toBeNull();

    // The operator's resume clears the banner.
    const resume = await fetch(`${base}/api/ops/lanes/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "llm:understanding" }),
    });
    expect(resume.status).toBe(200);
    const cleared = (await (await fetch(`${base}/api/ops/lanes`)).json()) as OpsBody;
    expect(cleared.breakers).toEqual([]);
    expect(cleared.lanes.find((l) => l.lane === "llm:understanding")!.paused).toBe(false);
  });
});
