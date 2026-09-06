// ===========================================================================
// [TEST] The operator's half of existing-home recovery (V6 P1 S6e · E2).
//
// GET /api/ops/repair previews; POST applies. Over the real server on an
// ephemeral port against a real temp DB, because the contract being asserted
// is that a human with a damaged home can SEE what would change before
// anything does, and that pressing the button twice is safe.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-repair-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const { writeDecision } = await import("../db/decisions.js");
const { UNPROPOSED } = await import("../recovery/space-repair.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let deadId: string;
let refusedId: string;

interface Plan {
  census: { episodes: number; unspaced: number; replayable: number; refusedOnMerits: number };
  items: { decisionId: string; label: string; action: string; bornStatus: string; relatedOrphans: number }[];
  modelCalls: number;
  sweep: { maxCalls: number; when: string };
  line: string;
}

interface Report {
  scanned: number;
  revived: number;
  filedInto: number;
  skipped: number;
  spaceIds: string[];
  modelCalls: number;
  line: string;
}

beforeAll(async () => {
  db.runMigrations();
  // The server refuses to start without its default provider registered. It is
  // never CALLED here: the repair is a ledger replay and every case asserts
  // `modelCalls === 0`.
  register(claudeLocalProvider);
  const d = getDb();
  d.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa', 'whatsapp', 'wa')`).run();
  d.prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key, label) VALUES ('st', 'wa', 'st', 'st')`).run();
  for (const [id, text] of [
    ["ep_orphan_a", "Suggested creating a free Instinct app account; invite link shared."],
    ["ep_orphan_b", "Rahul Arora asked for an Instinct app invite."],
  ] as const) {
    d.prepare(
      `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts)
       VALUES (?, 'st', 'open', ?, '2026-09-06T14:48:00.000Z', '2026-09-06T14:48:00.000Z')`,
    ).run(id, text);
    d.prepare(`INSERT INTO unsorted (id, episode_id, reason, status) VALUES (?, ?, 'no goal evidence', 'open')`).run(
      `un_${id}`,
      id,
    );
  }
  deadId = writeDecision({
    runId: "run_a",
    pass: "orient",
    targetKind: "space",
    targetId: UNPROPOSED,
    action: "reject",
    new: { label: "Instinct app account & invite management", summary: "Create a free Instinct account.", events: ["e45"] },
    reason: "already_placed: every founding event was committed by an earlier item",
    confidence: 0.82,
  });
  refusedId = writeDecision({
    runId: "run_b",
    pass: "orient",
    targetKind: "space",
    targetId: UNPROPOSED,
    action: "reject",
    new: { label: "Something with no proof", summary: "x", events: ["e1"] },
    reason: 'evidence_not_verbatim: "x" is not in e1',
  });

  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/ops/repair", () => {
  it("prices the repair and writes nothing", async () => {
    const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n;
    const res = await fetch(`${base}/api/ops/repair`);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as Plan;

    expect(plan.modelCalls).toBe(0);
    expect(plan.census.replayable).toBe(1);
    expect(plan.census.refusedOnMerits).toBe(1);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      decisionId: deadId,
      label: "Instinct app account & invite management",
      action: "revive",
      bornStatus: "proposed",
    });
    expect(plan.items[0]!.relatedOrphans).toBeGreaterThan(0);
    expect(plan.line).toMatch(/0 model calls/);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(before);
  });
});

describe("POST /api/ops/repair", () => {
  it("restores the discarded birth, and a second press changes nothing", async () => {
    const first = (await (await fetch(`${base}/api/ops/repair`, { method: "POST" })).json()) as Report;
    expect(first.revived).toBe(1);
    expect(first.modelCalls).toBe(0);
    expect(first.spaceIds).toHaveLength(1);

    const row = getDb()
      .prepare(`SELECT label, status, created_by FROM spaces WHERE id = ?`)
      .get(first.spaceIds[0]) as { label: string; status: string; created_by: string };
    expect(row).toMatchObject({
      label: "Instinct app account & invite management",
      status: "proposed",
      created_by: "repair",
    });

    const spacesAfter = (getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n;
    const second = (await (await fetch(`${base}/api/ops/repair`, { method: "POST" })).json()) as Report;
    expect(second.scanned).toBe(0);
    expect(second.revived).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(spacesAfter);

    // The refusal that stands on its merits is untouched by either press.
    const refused = getDb().prepare(`SELECT reversed_at FROM decisions WHERE id = ?`).get(refusedId) as {
      reversed_at: string | null;
    };
    expect(refused.reversed_at).toBeNull();

    // And the preview now agrees there is nothing left to do.
    const plan = (await (await fetch(`${base}/api/ops/repair`)).json()) as Plan;
    expect(plan.items).toEqual([]);
    expect(plan.census.replayable).toBe(0);
  });
});
