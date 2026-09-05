// ===========================================================================
// Digest pass runner — unit tests (P1.6). NO live model calls: the provider
// is a stub, and the test asserts the call went through a trace scope (the
// TRC-01 ghost-call rule) and committed propose-only.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { hasTraceContext } from "../traces/context.js";
import type { Provider, ProviderResult, SendOptions } from "../providers/types.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { runDigestPass } from "./digest-pass.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-digest-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const ZERO_USAGE = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

function stubProvider(answer: string, seen: { traced?: boolean; model?: string }): Provider {
  return {
    id: "stub",
    async send(opts: SendOptions): Promise<ProviderResult> {
      seen.traced = hasTraceContext();
      seen.model = opts.model;
      opts.onEvent({ type: "delta", text: answer });
      return { sessionId: "s", usage: ZERO_USAGE, freshFallback: false, status: "ok" };
    },
    cancel: () => false,
  };
}

function cat2Bundle(): DeltaBundle {
  return {
    streamId: "wa:st:batch2014@g.us",
    streamKey: "batch2014@g.us",
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
        text: "guys big news, joined flipkart today!",
        actor: "contact:dev",
        origin: "backfill",
        ageBand: "C",
        rolesJson: null,
        payloadJson: null,
      },
    ],
  };
}

const ANSWER = JSON.stringify({
  summary: "A quiet month for the batch group. Dev announced a job change. Reunion talk continued. Nothing else moved.",
  claims: [
    { subject: "Dev", text: "Dev joined Flipkart", evidence: [{ quote: "guys big news, joined flipkart today!" }] },
  ],
  recurrences: [{ label: "annual reunion", cadence: "yearly", evidence: [] }],
  tasks: [{ title: "should not exist" }],
});

describe("runDigestPass", () => {
  it("runs traced, on Haiku by default, and commits propose-only decisions", async () => {
    const seen: { traced?: boolean; model?: string } = {};
    const report = await runDigestPass(cat2Bundle(), { provider: stubProvider(ANSWER, seen) });

    expect(seen.traced).toBe(true); // the call happened INSIDE a trace scope
    expect(seen.model).toBe("haiku"); // build convention 1.7
    expect(report.status).toBe("ok");
    expect(report.violations).toContain("digest-inflation:tasks");
    expect(report.proposals).toBe(3); // summary + 1 claim + 1 recurrence

    const db = getDb();
    const decisions = db
      .prepare(`SELECT pass, target_kind, action FROM decisions ORDER BY id`)
      .all() as { pass: string; target_kind: string; action: string }[];
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.pass === "digest")).toBe(true);
    expect(decisions.map((d) => d.action).sort()).toEqual([
      "digest_summary",
      "propose",
      "propose_recurrence",
    ]);

    // Propose-only: NOTHING activated. No spaces, tasks or episodes exist.
    for (const table of ["spaces", "tasks", "episodes"]) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
  });

  it("a failed provider run reports failed and commits nothing", async () => {
    const provider: Provider = {
      id: "stub",
      async send(): Promise<ProviderResult> {
        return {
          sessionId: "s",
          usage: ZERO_USAGE,
          freshFallback: false,
          status: "error",
          errorCode: "TIMEOUT",
        };
      },
      cancel: () => false,
    };
    const report = await runDigestPass(cat2Bundle(), { provider });
    expect(report.status).toBe("failed");
    expect(report.error).toBe("TIMEOUT");
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("unparseable output fails closed", async () => {
    const seen = {};
    const report = await runDigestPass(cat2Bundle(), {
      provider: stubProvider("sorry, I cannot digest this", seen),
    });
    expect(report.status).toBe("failed");
    expect(report.violations).toEqual(["unparseable"]);
    expect(report.proposals).toBe(0);
  });
});
