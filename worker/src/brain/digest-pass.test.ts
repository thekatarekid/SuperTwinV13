// ===========================================================================
// Digest pass runner — unit tests (digest.v2, V6 P1 S3.8; DIG-02's code
// half). NO live model calls: the provider is a stub, and the test asserts
// the call went through a trace scope (the TRC-01 ghost-call rule), that the
// P-06 contract is enforced by code, and that the commit is propose-only.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { DIGEST_V2_ID } from "../prompts/digest.v2.js";
import { hasTraceContext } from "../traces/context.js";
import type { Provider, ProviderResult, SendOptions } from "../providers/types.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { bundleWeek, runDigestPass } from "./digest-pass.js";

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

function stubProvider(answer: string, seen: { traced?: boolean; model?: string; message?: string; system?: string }): Provider {
  return {
    id: "stub",
    async send(opts: SendOptions): Promise<ProviderResult> {
      seen.traced = hasTraceContext();
      seen.model = opts.model;
      seen.message = opts.message;
      seen.system = opts.systemPromptFile;
      opts.onEvent({ type: "delta", text: answer });
      return { sessionId: "s", usage: ZERO_USAGE, freshFallback: false, status: "ok" };
    },
    cancel: () => false,
  };
}

/** One tier-3 society group, one week (Mon 2026-08-24 … Sun 2026-08-30). */
function weekBundle(): DeltaBundle {
  const ev = (rowid: number, id: string, ts: string, text: string) => ({
    rowid,
    id,
    ts,
    kind: "wa.message",
    text,
    actor: "contact:secretary",
    origin: "backfill" as const,
    ageBand: "B" as const,
    rolesJson: null,
    payloadJson: null,
  });
  return {
    streamId: "wa:st:sunrise-402@g.us",
    streamKey: "sunrise-402@g.us",
    lane: "digest",
    ageBand: "B",
    day: "2026-08-27",
    part: 1,
    partCount: 1,
    events: [
      ev(11, "ev_water", "2026-08-25T09:00:00Z", "Water tank cleaning on Thursday 10am-1pm, please store water"),
      ev(12, "ev_maint", "2026-08-27T08:30:00Z", "Reminder: maintenance for Sept due by 5th. UPI to society@okaxis"),
    ],
  };
}

const ANSWER = JSON.stringify({
  summary: "Society notices: water tank cleaning Thursday; maintenance due by the 5th.\nNothing needed a reply.",
  claims: [
    {
      subject: "Sunrise Apartments 402",
      kind: "fact",
      text: "Society maintenance is paid by UPI to society@okaxis",
      provenance: "observed",
      fields: { merchant: "Sunrise society" },
      evidence: [{ event_ids: ["e2"], quote: "UPI to society@okaxis" }],
      confidence: 0.8,
    },
    // No resolvable evidence → dropped, named.
    { subject: "Secretary", text: "The secretary is strict", evidence: [{ event_ids: ["e9"], quote: "strict" }], confidence: 0.4 },
  ],
  recurrences: [
    {
      text: "Society maintenance due monthly by the 5th",
      rule: "monthly on the 5th",
      evidence: [{ event_ids: ["e2"], quote: "maintenance for Sept due by 5th" }],
      confidence: 0.7,
    },
  ],
  // Inflation the parser must strip and name.
  tasks: [{ title: "pay maintenance", status: "open" }],
  schedules: [{ task: "pay maintenance", fire_at: "2026-09-04T09:00:00+05:30" }],
});

describe("runDigestPass (digest.v2)", () => {
  it("runs traced, on Haiku by default, packs the week inside <untrusted>, and commits propose-only", async () => {
    const seen: { traced?: boolean; model?: string; message?: string; system?: string } = {};
    const report = await runDigestPass(weekBundle(), { provider: stubProvider(ANSWER, seen) });

    expect(seen.traced).toBe(true); // the call happened INSIDE a trace scope
    expect(seen.model).toBe("haiku"); // build convention 1.7
    expect(seen.system).toContain(DIGEST_V2_ID);
    expect(seen.message).toContain("week of 2026-08-24");
    expect(seen.message).toContain("<untrusted>");
    expect(seen.message).toContain("e1 2026-08-25T09:00:00Z contact:secretary:");

    expect(report.status).toBe("ok");
    expect(report.bundle.week).toBe("2026-08-24");
    // DIG-02: tasks / schedules never reach the result; the breach is named.
    expect(report.violations).toContain("digest-inflation:tasks");
    expect(report.violations).toContain("digest-inflation:schedules");
    expect(report.violations).toContain("unresolved-evidence:claims[1]");
    expect(report.result?.claims).toHaveLength(1);
    expect(report.result?.claims[0]?.evidence).toEqual([{ event_ids: ["ev_maint"], quote: "UPI to society@okaxis" }]);
    expect(report.result?.recurrences[0]?.evidence[0]?.event_ids).toEqual(["ev_maint"]);
    expect(report.proposals).toBe(3); // summary + 1 claim + 1 recurrence

    const db = getDb();
    const decisions = db
      .prepare(`SELECT pass, target_kind, action, new_json FROM decisions ORDER BY id`)
      .all() as { pass: string; target_kind: string; action: string; new_json: string }[];
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.pass === "digest")).toBe(true);
    expect(decisions.map((d) => d.action).sort()).toEqual(["digest_summary", "propose", "propose_recurrence"]);
    expect(decisions.every((d) => JSON.parse(d.new_json).week === "2026-08-24")).toBe(true);

    // Propose-only: NOTHING activated. No spaces, tasks or episodes exist.
    for (const table of ["spaces", "tasks", "episodes"]) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
    // The ledger row names the version.
    const run = db.prepare(`SELECT pass, role, status FROM runs`).get() as { pass: string; role: string; status: string };
    expect(run).toEqual({ pass: DIGEST_V2_ID, role: "digest", status: "ok" });
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
    const report = await runDigestPass(weekBundle(), { provider });
    expect(report.status).toBe("failed");
    expect(report.error).toBe("TIMEOUT");
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("unparseable output fails closed", async () => {
    const seen = {};
    const report = await runDigestPass(weekBundle(), {
      provider: stubProvider("sorry, I cannot digest this", seen),
    });
    expect(report.status).toBe("failed");
    expect(report.violations).toEqual(["unparseable"]);
    expect(report.proposals).toBe(0);
  });

  it("bundleWeek is the Monday of the first event's week", () => {
    expect(bundleWeek(weekBundle())).toBe("2026-08-24");
    expect(bundleWeek({ ...weekBundle(), events: [], day: "2026-08-30" })).toBe("2026-08-24");
  });
});
