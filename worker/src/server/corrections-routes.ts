// ===========================================================================
// [CODE] Corrections routes — the feedback pipeline (build P1.7, spec §14.4).
//
//   POST /api/corrections            apply one correction (drag / chip / bar)
//   POST /api/corrections/:id/undo   restore from the decision's old_json
//   GET  /api/corrections            recent corrections, newest first
//
// EVERY path — drag-move, ··· chip, "Tell the twin" utterance — lands here
// and runs the SAME pipeline (FIX-05): resolve target → (parse utterance via
// the traced correction-parse.v1 prompt when no structured correction came
// with the request) → apply the mutation → corrections row → decisions row
// (old_json = undo payload) → auto-drafted golden eval case.
//
// A structured correction that cannot be applied (unresolvable space hint,
// unsupported kind) is recorded as status='pending', never dropped — FIX-01's
// "parse-to-nothing" failure mode is visible, not silent.
// ===========================================================================

import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { activeClaim, claimsAbout, closeClaimVersion, writeClaimVersion } from "../claims/store.js";
import { getDb } from "../db/connection.js";
import { markReversed, writeDecision } from "../db/decisions.js";
import { isCircle } from "../entities/registry.js";
import { getSelectedModel } from "../db/settings.js";
import { type ParsedCorrection } from "../prompts/correction-parse.v1.js";
import {
  CORRECTION_PARSE_V2_INSTRUCTIONS,
  CORRECTION_PARSE_V2_VERSION,
  packCorrectionInput,
  parseCorrectionOutputV2,
} from "../prompts/correction-parse.v2.js";
import { runPrompt } from "../prompts/runner.js";
import { writeEvalDraft } from "./eval-drafts.js";

export interface CorrectionTarget {
  kind: "task" | "space" | "episode" | "claim" | "stream" | "person";
  id: string;
}

/**
 * The structured corrections the pipeline applies. Direct-manipulation paths
 * (People-view drag = set_circle, chips) send this shape; the utterance path
 * parses into it via correction-parse.v2, which added the two person-target
 * types (set_relationship / set_circle) for FIX-03/CIR-04.
 */
export type StructuredCorrection = Omit<ParsedCorrection, "type"> & {
  type: ParsedCorrection["type"] | "set_circle" | "set_relationship";
  to_space_id?: string;
  into_id?: string;
  /** set_circle / set_relationship: one of the nine spec §7.3.2 circles. */
  circle?: string;
  /** set_relationship: the corrected relation as said ("cousin"). */
  relation?: string;
};

export interface CorrectionRequest {
  target: CorrectionTarget;
  /** Direct-manipulation paths (drag, chips) send the structured form. */
  structured?: StructuredCorrection;
  /** "Tell the twin" sends the raw utterance instead. */
  utterance?: string;
  scope?: "once" | "stream" | "space" | "global";
}

/** Utterance → structured correction. Injectable so unit tests stay offline. */
export type CorrectionParser = (
  target: CorrectionTarget,
  state: unknown,
  utterance: string,
) => Promise<StructuredCorrection | null>;

/**
 * The production parser: one Haiku call through the prompt runner — traced
 * (TRC-01), accounted, repair-bounded like every other LLM step.
 */
export const parseViaModel: CorrectionParser = async (target, state, utterance) => {
  const result = await runPrompt({
    callType: CORRECTION_PARSE_V2_VERSION,
    legend: CORRECTION_PARSE_V2_INSTRUCTIONS,
    instructions: "",
    user: packCorrectionInput({ ...target, state }, utterance),
    role: "classify",
    cohortId: null,
    // The classify role's picker (defaults to Haiku — build convention).
    model: getSelectedModel("classify"),
    unit: { kind: `correction-${target.kind}`, id: target.id },
  });
  const raw = result.responses.join("\n");
  return parseCorrectionOutputV2(raw);
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const TARGET_TABLES: Record<CorrectionTarget["kind"], string | null> = {
  task: "tasks",
  space: "spaces",
  episode: "episodes",
  claim: null, // claims go through the claims store, not raw rows
  stream: "streams",
  person: "entities", // People-view ids ARE entity ids (people is a view)
};

function loadTargetState(target: CorrectionTarget): unknown {
  const db = getDb();
  if (target.kind === "claim") return activeClaim(target.id);
  const table = TARGET_TABLES[target.kind];
  if (!table) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(target.id) ?? null;
}

/** Resolve a spoken space hint ("the side project one") to a space id. */
function resolveSpaceHint(hint: string): string | null {
  const row = getDb()
    .prepare(`SELECT id FROM spaces WHERE label LIKE ? AND status != 'rejected' ORDER BY updated_at DESC LIMIT 1`)
    .get(`%${hint}%`) as { id: string } | undefined;
  return row?.id ?? null;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

interface ApplyOutcome {
  applied: boolean;
  /** Human line for the "what I did" strip. */
  summary: string;
  decisionId?: string;
  after?: unknown;
}

/**
 * Apply one structured correction to the world model. Every applied change
 * writes a decisions row with old_json (the undo payload). Unsupported
 * combinations return applied=false so the route records them as pending.
 */
function applyCorrection(
  target: CorrectionTarget,
  structured: StructuredCorrection,
  before: unknown,
): ApplyOutcome {
  const db = getDb();
  const { kind, id } = target;

  const decide = (action: string, reason: string): string =>
    writeDecision({
      pass: "user",
      targetKind: kind,
      targetId: id,
      action,
      old: before,
      new: loadTargetState(target),
      reason,
    });

  switch (structured.type) {
    case "move": {
      const spaceId =
        structured.to_space_id ??
        (structured.to_space_hint ? resolveSpaceHint(structured.to_space_hint) : null);
      if (!spaceId || (kind !== "task" && kind !== "episode")) {
        return { applied: false, summary: "couldn't resolve where to move it" };
      }
      db.prepare(`UPDATE ${TARGET_TABLES[kind]} SET space_id = ?, updated_at = ${NOW} WHERE id = ?`).run(spaceId, id);
      const decisionId = decide("move", `user filed ${kind} under space ${spaceId}`);
      return { applied: true, summary: `moved to ${spaceId}`, decisionId, after: loadTargetState(target) };
    }
    case "wrong_person": {
      if (kind !== "task" || !structured.owner) {
        return { applied: false, summary: "wrong_person needs a task and an owner" };
      }
      db.prepare(`UPDATE tasks SET owner = ?, owner_entity_id = NULL, updated_at = ${NOW} WHERE id = ?`).run(
        structured.owner,
        id,
      );
      const decisionId = decide("reassign", `user: this is ${structured.owner}'s, not mine`);
      return { applied: true, summary: `owner → ${structured.owner}`, decisionId, after: loadTargetState(target) };
    }
    case "already_done": {
      if (kind !== "task") return { applied: false, summary: "already_done applies to tasks" };
      db.prepare(`UPDATE tasks SET status = 'done', closed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
      const decisionId = decide("close", "user: already done");
      return { applied: true, summary: "marked done", decisionId, after: loadTargetState(target) };
    }
    case "not_task": {
      if (kind !== "task") return { applied: false, summary: "not_task applies to tasks" };
      db.prepare(`UPDATE tasks SET status = 'dismissed', closed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
      const decisionId = decide("dismiss", "user: not a task");
      return { applied: true, summary: "dismissed", decisionId, after: loadTargetState(target) };
    }
    case "cancel": {
      // FIX-02: cancelled is NOT done, and nothing is deleted. On a space the
      // open tasks close as cancelled and the space itself goes dormant.
      if (kind === "task") {
        db.prepare(`UPDATE tasks SET status = 'cancelled', closed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
        const decisionId = decide("cancel", "user: cancelled");
        return { applied: true, summary: "cancelled", decisionId, after: loadTargetState(target) };
      }
      if (kind === "space") {
        const openTasks = db
          .prepare(`SELECT * FROM tasks WHERE space_id = ? AND status IN ('open','scheduled','executing','needs_input','needs_approval')`)
          .all(id) as Array<{ id: string }>;
        for (const t of openTasks) {
          const tBefore = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(t.id);
          db.prepare(`UPDATE tasks SET status = 'cancelled', closed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(t.id);
          writeDecision({
            pass: "user",
            targetKind: "task",
            targetId: t.id,
            action: "cancel",
            old: tBefore,
            new: getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(t.id),
            reason: `space ${id} cancelled by user`,
          });
        }
        db.prepare(`UPDATE spaces SET status = 'dormant', updated_at = ${NOW} WHERE id = ?`).run(id);
        const decisionId = decide("cancel", "user: we cancelled this");
        return {
          applied: true,
          summary: `cancelled — ${openTasks.length} open task(s) closed as cancelled, space dormant`,
          decisionId,
          after: loadTargetState(target),
        };
      }
      return { applied: false, summary: "cancel applies to tasks and spaces" };
    }
    case "not_true":
    case "outdated": {
      if (kind !== "claim") return { applied: false, summary: `${structured.type} applies to claims` };
      const active = activeClaim(id);
      if (!active) return { applied: false, summary: `no active claim ${id}` };
      // closeClaimVersion writes its own decision row (the claims store is the
      // one writer for claim mutations); old versions get validity ends, never
      // deletion (FIX-03's silent-overwrite is impossible on this path).
      closeClaimVersion(active.id, {
        closedBy: "user",
        reason: structured.type,
        validTo: structured.type === "outdated" ? new Date().toISOString() : null,
      });
      return { applied: true, summary: `claim ${structured.type === "not_true" ? "retracted" : "ended"}`, after: activeClaim(id) };
    }
    case "merge_into": {
      if (kind !== "space") return { applied: false, summary: "merge_into applies to spaces" };
      const intoId = structured.into_id ?? (structured.into_hint ? resolveSpaceHint(structured.into_hint) : null);
      if (!intoId) return { applied: false, summary: "couldn't resolve the merge target" };
      db.prepare(`UPDATE spaces SET status = 'archived', archived_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
      const decisionId = decide("merge", `user merged into space ${intoId}`);
      return { applied: true, summary: `merged into ${intoId}`, decisionId, after: loadTargetState(target) };
    }
    case "edit": {
      // Field-level edits: only the safe, known columns per kind.
      const editable: Record<string, string[]> = { task: ["title", "due"], space: ["label", "goal"] };
      const cols = editable[kind] ?? [];
      if (!structured.field || !cols.includes(structured.field) || structured.value === undefined) {
        return { applied: false, summary: "edit needs a known field and a value" };
      }
      db.prepare(`UPDATE ${TARGET_TABLES[kind]} SET ${structured.field} = ?, updated_at = ${NOW} WHERE id = ?`).run(
        structured.value,
        id,
      );
      const decisionId = decide("update", `user edited ${structured.field}`);
      return { applied: true, summary: `${structured.field} updated`, decisionId, after: loadTargetState(target) };
    }
    case "set_circle": {
      // CIR-04: a People-view drag between circles. The change lands
      // immediately (nudge thresholds, brief inclusion and applicability all
      // read the stored circle), writes a decisions row (undo restores the
      // old entity row), and — like every correction — drafts an eval case.
      if (kind !== "person" || !isCircle(structured.circle ?? null)) {
        return { applied: false, summary: "set_circle needs a person and one of the nine circles" };
      }
      db.prepare(`UPDATE entities SET circle = ? WHERE id = ?`).run(structured.circle, id);
      const decisionId = decide("set_circle", `user moved person to circle ${structured.circle}`);
      return { applied: true, summary: `circle → ${structured.circle}`, decisionId, after: loadTargetState(target) };
    }
    case "set_relationship": {
      // FIX-03: "she's my cousin, not a coworker" on a person card. The old
      // relationship claim is SUPERSEDED — validity end, never deletion (the
      // silent-overwrite failure mode is structurally impossible: history
      // keeps every version) — a new relationship claim lands with the
      // correction as evidence, and the circle moves when one was given so
      // downstream judgments (tone, applicability, nudges) shift at once.
      if (kind !== "person" || !structured.relation) {
        return { applied: false, summary: "set_relationship needs a person and a relation" };
      }
      if (structured.circle !== undefined && !isCircle(structured.circle)) {
        return { applied: false, summary: `${JSON.stringify(structured.circle)} is not one of the nine circles` };
      }
      const now = new Date().toISOString();
      const open = claimsAbout(id, "relationship");
      for (const old of open) {
        closeClaimVersion(old.id, { closedBy: "user", reason: "corrected", validTo: now });
      }
      const claimKey = open[0]?.claimKey ?? `person.${id}.relationship`;
      writeClaimVersion({
        claimKey,
        kind: "relationship",
        subjectId: id,
        text: structured.relation,
        confidence: 1,
        statedAt: now,
        validFrom: now,
        evidence: [{ quote: `user correction: ${structured.relation}`, event_ids: [] }],
        decidedBy: "user",
        relation: open.length > 0 ? "contradicts" : "new",
        relatedVersionId: open[0]?.id ?? null,
      });
      if (structured.circle) {
        db.prepare(`UPDATE entities SET circle = ? WHERE id = ?`).run(structured.circle, id);
      }
      const decisionId = decide(
        "set_relationship",
        `user corrected relationship to ${structured.relation}${structured.circle ? ` (circle → ${structured.circle})` : ""}`,
      );
      return {
        applied: true,
        summary: `relationship → ${structured.relation}${structured.circle ? ` · circle → ${structured.circle}` : ""}${open.length > 0 ? " (old claim kept in history with a validity end)" : ""}`,
        decisionId,
        after: loadTargetState(target),
      };
    }
    case "stop_tracking":
    case "none":
    default:
      return { applied: false, summary: `recorded, not auto-applied (${structured.type})` };
  }
}

function mintCorrectionId(): string {
  return `cor_${randomBytes(9).toString("hex")}`;
}

/**
 * Handle one corrections route. `parser` is injectable for tests; production
 * (the server's registration in index.ts) uses the traced model parser.
 */
export async function handleCorrectionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parser: CorrectionParser = parseViaModel,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const db = getDb();

  if (req.method === "GET" && path === "/api/corrections") {
    const rows = db.prepare(`SELECT * FROM corrections ORDER BY created_at DESC LIMIT 50`).all();
    sendJson(res, 200, { corrections: rows });
    return true;
  }

  if (req.method === "POST" && path === "/api/corrections") {
    const body = (await readBody(req)) as CorrectionRequest | undefined;
    if (!body || !body.target || typeof body.target.id !== "string" || typeof body.target.kind !== "string") {
      sendJson(res, 400, { error: "target {kind, id} required" });
      return true;
    }
    if (!body.structured && (typeof body.utterance !== "string" || body.utterance.trim() === "")) {
      sendJson(res, 400, { error: "structured correction or utterance required" });
      return true;
    }

    const before = loadTargetState(body.target);
    if (before === null) {
      sendJson(res, 404, { error: `no ${body.target.kind} ${body.target.id}` });
      return true;
    }

    let structured = body.structured ?? null;
    if (!structured && body.utterance) {
      structured = await parser(body.target, before, body.utterance);
    }

    const outcome: ApplyOutcome = structured
      ? applyCorrection(body.target, structured, before)
      : { applied: false, summary: "couldn't parse that into a correction" };

    const correctionId = mintCorrectionId();
    const instruction = body.utterance ?? JSON.stringify(body.structured);
    db.prepare(
      `INSERT INTO corrections (id, decision_id, target_kind, target_id, instruction, scope, status, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN ${NOW} ELSE NULL END)`,
    ).run(
      correctionId,
      outcome.decisionId ?? null,
      body.target.kind,
      body.target.id,
      instruction,
      body.scope ?? "once",
      outcome.applied ? "applied" : "pending",
      outcome.applied ? 1 : 0,
    );

    // The promotion loop (spec §14.4.5): every correction drafts an eval case
    // with the original context — including pending ones, which are exactly
    // the parses a human most wants to inspect.
    const draftPath = writeEvalDraft({
      correctionId,
      target: body.target,
      instruction,
      structured,
      before,
      after: outcome.after ?? loadTargetState(body.target),
    });

    sendJson(res, 200, {
      correction_id: correctionId,
      status: outcome.applied ? "applied" : "pending",
      summary: outcome.summary,
      structured,
      decision_id: outcome.decisionId ?? null,
      eval_draft: draftPath,
    });
    return true;
  }

  const undo = path.match(/^\/api\/corrections\/([^/]+)\/undo$/);
  if (undo && req.method === "POST") {
    const id = decodeURIComponent(undo[1]!);
    const correction = db.prepare(`SELECT * FROM corrections WHERE id = ?`).get(id) as
      | { id: string; decision_id: string | null; target_kind: string; target_id: string }
      | undefined;
    if (!correction) {
      sendJson(res, 404, { error: `no correction ${id}` });
      return true;
    }
    if (!correction.decision_id) {
      sendJson(res, 409, { error: "correction has no decision to reverse" });
      return true;
    }
    const decision = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(correction.decision_id) as
      | { id: string; target_kind: string; target_id: string; old_json: string | null; reversed_at: string | null }
      | undefined;
    if (!decision || decision.reversed_at) {
      sendJson(res, 409, { error: "decision missing or already reversed" });
      return true;
    }
    const table = TARGET_TABLES[decision.target_kind as CorrectionTarget["kind"]];
    if (!table || !decision.old_json) {
      sendJson(res, 409, { error: `cannot restore a ${decision.target_kind}` });
      return true;
    }
    const old = JSON.parse(decision.old_json) as Record<string, unknown>;
    const cols = Object.keys(old).filter((c) => c !== "id");
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
      ...cols.map((c) => old[c] as never),
      decision.target_id,
    );
    markReversed(decision.id, correction.id);
    db.prepare(`UPDATE corrections SET status = 'rejected' WHERE id = ?`).run(id);
    sendJson(res, 200, { undone: true, restored: old });
    return true;
  }

  return false;
}
