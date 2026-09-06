// ===========================================================================
// [CODE] Review-queue + drill-down routes — build P1.7 (spec §14.2, §14.6).
//
//   GET  /api/home                     one fetch for the Home screen: today
//                                      (open tasks), spaces, review queue,
//                                      recent understanding (claim versions)
//   GET  /api/review                   review queue (proposed spaces)
//   POST /api/proposals/:id/approve    proposed space -> active (+ decision)
//   POST /api/proposals/:id/reject     proposed space -> rejected (+ decision)
//   GET  /api/decisions/:kind/:id      "why?" — every decision on one object
//   GET  /api/trace/:id                trace drill-down (index row)
//   POST /api/dev/seed-review          dev-only: seed a proposed space with
//                                      evidence + decision + trace so the
//                                      acceptance path is walkable end-to-end
//
// Writes here are USER actions (approve/reject): they go through the same
// conventions as pass writes — a decisions row per derived-object change,
// old_json as the restore payload, nothing deleted (reject keeps the row).
// ===========================================================================

import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { decisionsFor, writeDecision } from "../db/decisions.js";
import { sweepPreview, type SweepPreview } from "../spaces/birth.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Dev seeding is available everywhere except a production build. */
function devRoutesEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SUPERTWIN_DEV === "1";
}

interface SpaceRow {
  id: string;
  label: string;
  status: string;
  [k: string]: unknown;
}

function getSpace(id: string): SpaceRow | undefined {
  return getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(id) as SpaceRow | undefined;
}

/**
 * The review queue: every proposed space, newest first, with its evidence
 * and the sweep PREVIEW — what approving it would pull in (S5.1, SPC-01:
 * "will pull in 3 related items"). Retrieval only; zero model calls.
 */
function reviewQueue(): (SpaceRow & { sweep_preview: SweepPreview })[] {
  const rows = getDb()
    .prepare(`SELECT * FROM spaces WHERE status = 'proposed' ORDER BY created_at DESC`)
    .all() as SpaceRow[];
  return rows.map((r) => ({ ...r, sweep_preview: sweepPreview(r.id) }));
}

/**
 * Flip one proposed space to `active` (approve) or `rejected` (reject),
 * writing the decision row that makes the change reversible. Returns null
 * when the space is missing or not proposed (propose-only: approve is only
 * meaningful on a proposal).
 */
function resolveProposal(
  id: string,
  verdict: "approve" | "reject",
): { space: SpaceRow; decisionId: string } | null {
  const db = getDb();
  const before = getSpace(id);
  if (!before || before.status !== "proposed") return null;
  const next = verdict === "approve" ? "active" : "rejected";
  db.prepare(
    `UPDATE spaces SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).run(next, id);
  const after = getSpace(id)!;
  const decisionId = writeDecision({
    pass: "user",
    targetKind: "space",
    targetId: id,
    action: verdict,
    old: before,
    new: after,
    reason: `user ${verdict}d proposal from review queue`,
  });
  return { space: after, decisionId };
}

/**
 * Handle one review/drill-down route. Returns false for any path it does not
 * claim (the server's shared handler contract).
 */
export async function handleReviewRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const db = getDb();

  if (req.method === "GET" && path === "/api/home") {
    const today = db
      .prepare(
        `SELECT * FROM tasks WHERE status IN ('open','scheduled','executing','needs_input','needs_approval')
          ORDER BY (due IS NULL), due, created_at DESC LIMIT 20`,
      )
      .all();
    const spaces = db
      .prepare(
        `SELECT * FROM spaces WHERE status IN ('active','dormant')
          ORDER BY updated_at DESC, created_at DESC LIMIT 20`,
      )
      .all();
    const recent = db
      .prepare(
        `SELECT * FROM claims_active ORDER BY created_at DESC LIMIT 10`,
      )
      .all();
    sendJson(res, 200, { today, spaces, review: reviewQueue(), recent_understanding: recent });
    return true;
  }

  if (req.method === "GET" && path === "/api/review") {
    sendJson(res, 200, { review: reviewQueue() });
    return true;
  }

  const proposal = path.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
  if (proposal && req.method === "POST") {
    const id = decodeURIComponent(proposal[1]!);
    const verdict = proposal[2] as "approve" | "reject";
    const outcome = resolveProposal(id, verdict);
    if (!outcome) {
      sendJson(res, 404, { error: `no proposed space ${id}` });
      return true;
    }
    sendJson(res, 200, { space: outcome.space, decision_id: outcome.decisionId });
    return true;
  }

  const why = path.match(/^\/api\/decisions\/([^/]+)\/([^/]+)$/);
  if (why && req.method === "GET") {
    const kind = decodeURIComponent(why[1]!);
    const id = decodeURIComponent(why[2]!);
    // Each decision carries the trace of the run that proposed it (when one
    // exists) so the UI can walk decision → trace without a second lookup.
    const traceFor = db.prepare(`SELECT id FROM traces WHERE run_id = ? LIMIT 1`);
    const decisions = decisionsFor(kind, id).map((d) => ({
      ...d,
      traceId: d.runId ? ((traceFor.get(d.runId) as { id: string } | undefined)?.id ?? null) : null,
    }));
    sendJson(res, 200, { target_kind: kind, target_id: id, decisions });
    return true;
  }

  const trace = path.match(/^\/api\/trace\/([^/]+)$/);
  if (trace && req.method === "GET") {
    const id = decodeURIComponent(trace[1]!);
    const row = db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id);
    if (!row) {
      sendJson(res, 404, { error: `no trace ${id}` });
      return true;
    }
    sendJson(res, 200, { trace: row });
    return true;
  }

  if (req.method === "POST" && path === "/api/dev/seed-review") {
    if (!devRoutesEnabled()) return false;
    const seeded = seedReviewFixture();
    sendJson(res, 200, seeded);
    return true;
  }

  return false;
}

/**
 * Insert a proposed space + the decision and trace that "proposed" it, so a
 * fresh dev install can walk the whole acceptance path: Home review queue →
 * proposal modal (evidence) → why? (decision) → trace → Approve. Idempotent:
 * re-seeding while the seed proposal is still proposed reuses it.
 */
export function seedReviewFixture(): { space_id: string; decision_id: string; trace_id: string } {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM spaces WHERE created_by = 'dev-seed' AND status = 'proposed' LIMIT 1`)
    .get() as { id: string } | undefined;
  if (existing) {
    const dec = db
      .prepare(
        // rowid, not id: same-millisecond writes need insertion order to pick
        // the ORIGINAL create decision rather than a random one of the batch.
        `SELECT id, run_id FROM decisions WHERE target_kind = 'space' AND target_id = ? ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(existing.id) as { id: string; run_id: string | null } | undefined;
    const trc = db
      .prepare(`SELECT id FROM traces WHERE run_id = ? LIMIT 1`)
      .get(dec?.run_id ?? "") as { id: string } | undefined;
    return { space_id: existing.id, decision_id: dec?.id ?? "", trace_id: trc?.id ?? "" };
  }

  const spaceId = `sp_seed_${randomBytes(4).toString("hex")}`;
  const runId = `run_seed_${randomBytes(4).toString("hex")}`;
  const traceId = `trc_seed_${randomBytes(4).toString("hex")}`;
  const exemplars = [
    { summary: "Tanvi: ❝october long weekend hampi?❞", event_ids: ["ev_seed_1"] },
    { summary: "3 browser visits: hampi stays, trains", event_ids: ["ev_seed_2"] },
  ];
  db.prepare(
    `INSERT INTO spaces (id, label, life_area, goal, status, horizon, permanence, cadence,
                         exemplars_json, created_by, confidence)
     VALUES (?, ?, 'Travel', ?, 'proposed', 'short', 'ephemeral', 'one-time', ?, 'dev-seed', 0.82)`,
  ).run(spaceId, "Hampi trek in October", "Plan the Hampi long-weekend trek", JSON.stringify(exemplars));
  db.prepare(
    `INSERT INTO traces (id, run_id, pass, model, prompt_version, caller, day,
                         system_prompt, packed_context, raw_output, parsed_result)
     VALUES (?, ?, 'decide', 'haiku', 'decide.v1', 'dev-seed', strftime('%Y-%m-%d','now'),
             '(seed) decide instructions', '(seed) 4 events about hampi',
             '(seed) propose space: Hampi trek in October', ?)`,
  ).run(traceId, runId, JSON.stringify({ propose_space: { label: "Hampi trek in October" } }));
  const decisionId = writeDecision({
    runId,
    pass: "decide",
    targetKind: "space",
    targetId: spaceId,
    action: "create",
    new: { label: "Hampi trek in October", status: "proposed" },
    reason: "2 chat mentions + 3 browser visits about the same trip within 4 days",
    confidence: 0.82,
  });
  return { space_id: spaceId, decision_id: decisionId, trace_id: traceId };
}
