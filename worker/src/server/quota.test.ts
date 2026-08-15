// ===========================================================================
// HTTP tests for the usage surface: GET /api/quota (all four raw counts, the
// billable equivalent, and media reading's separate line) and the chat gate.
//
// The gate is the reason billable exists: cache reads are most of every run and
// bill at ~10%, so a gate that summed the raw four would lock the user out of
// chat roughly ten times sooner than real spend. Both directions are asserted.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-quota-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

interface QuotaBody {
  windowMs: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  costUsd: number | null;
  runCount: number;
  nearLimit: boolean;
  media: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
    billableTokens: number;
    costUsd: number | null;
    runCount: number;
  };
}

async function getQuota(): Promise<QuotaBody> {
  const res = await fetch(`${base}/api/quota`);
  return (await res.json()) as QuotaBody;
}

/** Run one chat turn and return the raw SSE body. */
async function chat(message: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return await res.text();
}

beforeAll(async () => {
  db.runMigrations();
  register({
    id: "claude-local",
    send: async (opts) => {
      opts.onEvent({ type: "delta", text: "pong" });
      return {
        sessionId: "",
        usage: {
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
        },
        freshFallback: false,
        status: "ok" as const,
      };
    },
    cancel: () => false,
  });
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/quota", () => {
  it("serves all four raw counts plus the billable equivalent", async () => {
    db.addUsage({
      inputTokens: 18,
      cacheCreationInputTokens: 10_651,
      cacheReadInputTokens: 48_000,
      outputTokens: 206,
      runCount: 1,
    });

    const body = await getQuota();
    expect(body).toMatchObject({
      inputTokens: 18,
      cacheCreationInputTokens: 10_651,
      cacheReadInputTokens: 48_000,
      outputTokens: 206,
      // 18 + 10651*1.25 + 48000*0.1 + 206
      billableTokens: 18_338,
      runCount: 1,
    });
  });

  it("carries media spend as its own line, never folded into the window", async () => {
    db.logRun({
      provider: "claude-local",
      sessionId: null,
      runId: "media-run",
      kind: "media",
      promptChars: 0,
      inputTokens: 12,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 5_000,
      outputTokens: 40,
      costUsd: 0.004,
      durationMs: 900,
      status: "ok",
      errorCode: null,
      role: "media",
      model: "claude-haiku-4-5-20251001",
    });

    const body = await getQuota();
    expect(body.media).toEqual({
      inputTokens: 12,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 5_000,
      outputTokens: 40,
      // 12 + 400*1.25 + 5000*0.1 + 40
      billableTokens: 1_052,
      costUsd: 0.004,
      runCount: 1,
    });
    // The media run's tokens are logged, but the quota window never saw them.
    expect(body.inputTokens).toBe(18);
  });

  it("sums chat's cost over the window, split from media's (v4 §1)", async () => {
    // Nothing chat-side has priced itself yet — which is not the same as $0.
    expect((await getQuota()).costUsd).toBeNull();

    for (const [runId, costUsd] of [
      ["chat-a", 0.012],
      ["chat-b", 0.003],
    ] as const) {
      db.logRun({
        provider: "claude-local",
        sessionId: null,
        runId,
        kind: "chat",
        promptChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd,
        durationMs: 100,
        status: "ok",
        errorCode: null,
        role: "chat",
      });
    }

    const body = await getQuota();
    expect(body.costUsd).toBeCloseTo(0.015, 10);
    // The media run above priced itself too, and stayed on its own line.
    expect(body.media.costUsd).toBeCloseTo(0.004, 10);
  });
});

describe("the chat quota gate", () => {
  it("lets chat through on cache spend a raw sum would have blocked", async () => {
    // 40M raw tokens — eight times the 5M limit — but 4M billable.
    db.addUsage({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 40_000_000,
      outputTokens: 0,
      runCount: 1,
    });

    const quota = await getQuota();
    expect(quota.cacheReadInputTokens).toBeGreaterThan(5_000_000);
    expect(quota.billableTokens).toBeLessThan(5_000_000);

    const body = await chat("ping");
    expect(body).not.toContain("QUOTA_EXCEEDED");
    expect(body).toContain("pong");
  });

  it("blocks once the billable equivalent passes the limit", async () => {
    db.addUsage({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 20_000_000,
      outputTokens: 0,
      runCount: 1,
    });

    const body = await chat("ping");
    expect(body).toContain("QUOTA_EXCEEDED");
    expect(body).toContain("billable tokens");
  });
});
