// ===========================================================================
// End-to-end token accounting: one chat run whose Usage is mostly cache, from
// the provider's reported numbers through to what each table actually stores.
//
// The unit tests either side of this cover the arithmetic (providers/usage) and
// the reads (store/runs-store, server/quota). What none of them cover is that
// the SAME Usage reaches both writers intact — extraction_runs keeps the four
// raw counts plus cost, quota_usage keeps the four raw counts plus the billable
// equivalent — which is the only reason the quota gate and the runs viewer can
// disagree about a run without one of them being wrong.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-token-accounting-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
// The home too (rule §1.3.1): the chat route's grounded turns call ensureBrain()
// and the trace store writes <home>/traces — both fell back to ~/SuperTwinV13
// when only the DB path was sandboxed, recreating the production home from
// inside vitest (S0-gate).
process.env.SUPERTWIN_HOME = tmpDir;

const db = await import("../db/index.js");
const { registerV2 } = await import("../providers/index.js");
const { providerV2TestDouble } = await import("../providers/test-support.js");
const { billableTokens } = await import("../providers/usage.js");
const { startServer } = await import("./index.js");

import type { NeutralProviderResult, Usage } from "../providers/types.js";

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

/** What the next provider run reports. `status` drives the kill-path case. */
let reported: { usage: Usage; status: NeutralProviderResult["status"] };

/** The measured shape of a real run: fresh input is ~0.03% of what was spent. */
const CACHE_HEAVY: Usage = {
  inputTokens: 18,
  cacheCreationInputTokens: 10_651,
  cacheReadInputTokens: 48_000,
  outputTokens: 206,
  costUsd: 0.02715,
};

/** 18 + 10651*2.0 + 48000*0.1 + 206 — unattributed writes bill at the 1h rate. */
const CACHE_HEAVY_BILLABLE = 26_326;

interface RunRow {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  status: string;
}

interface UsageRow {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  billable_tokens: number;
  run_count: number;
}

function latestRun(): RunRow {
  return db
    .getDb()
    .prepare(
      `SELECT input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
              output_tokens, cost_usd, status
         FROM extraction_runs ORDER BY id DESC LIMIT 1`,
    )
    .get() as RunRow;
}

function usageRows(): UsageRow[] {
  return db
    .getDb()
    .prepare(
      `SELECT input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
              output_tokens, billable_tokens, run_count
         FROM quota_usage ORDER BY id ASC`,
    )
    .all() as UsageRow[];
}

/** Run one chat turn and return the raw SSE body. */
async function chat(message: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, grounded: false }),
  });
  return await res.text();
}

beforeAll(async () => {
  db.runMigrations();
  registerV2(providerV2TestDouble(async (opts) => {
    opts.onEvent({ type: "delta", text: "pong" });
    opts.onEvent({ type: "usage", usage: reported.usage });
    return {
      continuation: reported.status === "ok" ? "accounting-test-continuation" : null,
      usage: reported.usage,
      freshFallback: false,
      status: reported.status,
      ...(reported.status === "error" ? { errorCode: "CANCELLED" as const } : {}),
    };
  }));
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("a cache-heavy run, provider to storage", () => {
  it("stores the four raw counts and the cost on the run log", async () => {
    reported = { usage: CACHE_HEAVY, status: "ok" };
    await chat("ping");

    expect(latestRun()).toEqual({
      input_tokens: 18,
      cache_creation_input_tokens: 10_651,
      cache_read_input_tokens: 48_000,
      output_tokens: 206,
      cost_usd: 0.02715,
      status: "ok",
    });
  });

  it("stores the same raw counts plus the billable equivalent on the quota window", async () => {
    expect(usageRows()).toEqual([
      {
        input_tokens: 18,
        cache_creation_input_tokens: 10_651,
        cache_read_input_tokens: 48_000,
        output_tokens: 206,
        billable_tokens: CACHE_HEAVY_BILLABLE,
        run_count: 1,
      },
    ]);
    expect(CACHE_HEAVY_BILLABLE).toBe(billableTokens(CACHE_HEAVY));
  });

  it("serves the stored billable, which is a third of the raw sum", async () => {
    const quota = (await (await fetch(`${base}/api/quota`)).json()) as {
      inputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
      billableTokens: number;
    };

    expect(quota).toMatchObject({
      inputTokens: 18,
      cacheCreationInputTokens: 10_651,
      cacheReadInputTokens: 48_000,
      outputTokens: 206,
      billableTokens: CACHE_HEAVY_BILLABLE,
    });
    // Billing on the raw sum is what would trip the gate ~10x early.
    expect(quota.billableTokens).toBeLessThan(58_875 / 2);
  });

  it("streams the usage frame the UI reads, with cache included", async () => {
    reported = { usage: CACHE_HEAVY, status: "ok" };
    const body = await chat("ping again");

    const frame = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; usage?: Usage })
      .find((e) => e.type === "usage");
    expect(frame?.usage).toEqual(CACHE_HEAVY);
  });
});

describe("a run the user cancelled", () => {
  it("records the cache it already spent instead of zero", async () => {
    const spentBeforeKill: Usage = {
      inputTokens: 4,
      cacheCreationInputTokens: 9_000,
      cacheReadInputTokens: 20_000,
      outputTokens: 11,
    };
    reported = { usage: spentBeforeKill, status: "error" };
    await chat("cancel me");

    expect(latestRun()).toEqual({
      input_tokens: 4,
      cache_creation_input_tokens: 9_000,
      cache_read_input_tokens: 20_000,
      output_tokens: 11,
      // Nothing reported a cost, so none is invented.
      cost_usd: null,
      status: "error",
    });
    // 4 + 9000*2.0 + 20000*0.1 + 11
    expect(usageRows().at(-1)).toMatchObject({
      cache_creation_input_tokens: 9_000,
      cache_read_input_tokens: 20_000,
      billable_tokens: 20_015,
    });
  });
});
