// ===========================================================================
// [CODE] Corrections routes — the feedback pipeline (build P1.7, spec §14.4).
//
//   POST /api/corrections                              apply one correction
//   POST /api/corrections/:id/undo                     restore from old_json
//   GET  /api/corrections                              recent, newest first
//   GET  /api/corrections/behavioral-rules             behavioral memory
//   POST /api/corrections/behavioral-rules/:key/retire drop one rule
//
// EVERY path — drag-move, ··· chip, quick chip, "Tell the twin" utterance,
// a bar follow-up on a locked object — lands here and runs the SAME pipeline
// (FIX-05): resolve target → (parse utterance via the traced
// correction-parse.v3 prompt when no structured correction came with the
// request) → apply the mutation → any durable rule the correction implied
// into behavioral memory (FIX-08) → corrections row → decisions row (old_json
// = undo payload) → auto-drafted golden eval case (FIX-09).
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
  CORRECTION_PARSE_V3_INSTRUCTIONS,
  CORRECTION_PARSE_V3_VERSION,
  packCorrectionInputV3,
  parseCorrectionOutputV3,
  toStructuredCorrection,
  type BehavioralRule,
} from "../prompts/correction-parse.v3.js";
import { runJsonPass } from "../brain/llm.js";
import { listBehavioralRules, retireBehavioralRule, writeBehavioralRule } from "../grounded/behavioral.js";
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
  type: ParsedCorrection["type"] | "set_circle" | "set_relationship" | "dont_do_this" | "tone" | "split" | "other";
  to_space_id?: string;
  into_id?: string;
  /** set_circle / set_relationship: one of the nine spec §7.3.2 circles. */
  circle?: string;
  /** set_relationship: the corrected relation as said ("cousin"). */
  relation?: string;
  /** dont_do_this (V6 P1 P-12): the kind of thing to stop and where it applied ("app:YouTube"). */
  kind?: string;
  context?: string;
  /** tone(person, note). */
  person?: string;
  note?: string;
  /** split / other: the free text. */
  text?: string;
  /** The durable rule the correction implies — written to behavioral memory (FIX-08). */
  behavioral?: BehavioralRule | null;
  confidence?: number;
  /** Which prompt version produced this (diagnostics). */
  parsed_by?: string;
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
 * The production parser: one Haiku JSON call through the traced JSON runner
 * (TRC-01) — the correction contract is one JSON object on one line, so
 * runJsonPass validates + repair-bounds it like every other V13 JSON pass.
 * V6 P1 S5.5: correction-parse.v3 (P-12) — the v3 type list is mapped onto
 * the structured shape the appliers below understand; any durable rule the
 * model emitted rides along as `behavioral`.
 */
export const parseViaModel: CorrectionParser = async (target, state, utterance) => {
  const label = labelOf(state);
  const result = await runJsonPass<StructuredCorrection>({
    pass: CORRECTION_PARSE_V3_VERSION,
    system: CORRECTION_PARSE_V3_INSTRUCTIONS,
    user: packCorrectionInputV3({ ...target, label, state }, utterance),
    role: "classify",
    cohortId: null,
    // The classify role's picker (defaults to Haiku — build convention).
    model: getSelectedModel("classify") || undefined,
    unit: { kind: `correction-${target.kind}`, id: target.id },
    validate: (parsed) => {
      const v3 = parseCorrectionOutputV3(JSON.stringify(parsed));
      if (!v3) throw new Error("expected one JSON object with a known correction type from the TYPES list");
      return toStructuredCorrection(v3, target.kind) as StructuredCorrection;
    },
  });
  return result.output ?? null;
};

/** The human label of a target row — what the locked line shows. */
function labelOf(state: unknown): string | null {
  const s = (state ?? {}) as Record<string, unknown>;
  for (const k of ["title", "label", "canonical", "summary", "text"]) {
    if (typeof s[k] === "string" && (s[k] as string).trim() !== "") return s[k] as string;
  }
  return null;
}

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
      // FIX-07: the task is now THEIRS — our side of it is a monitoring
      // follow-up ("did Karan do it?"), not a silent hand-off. Undo dismisses
      // it again (see the undo route).
      const title = (before as { title?: string } | null)?.title ?? id;
      const followupId = `t_${randomBytes(9).toString("hex")}`;
      db.prepare(
        `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, created_by, status, evidence_json)
         SELECT ?, space_id, ?, 'implicit', 'monitoring', 'advise-only', 'self', ?, 'open', ?
           FROM tasks WHERE id = ?`,
      ).run(
        followupId,
        `follow up with ${structured.owner}: ${title}`,
        followupCreatedBy(id),
        JSON.stringify({ correction_of: id, owner: structured.owner }),
        id,
      );
      writeDecision({
        pass: "user",
        targetKind: "task",
        targetId: followupId,
        action: "create",
        new: { title: `follow up with ${structured.owner}: ${title}`, correction_of: id },
        reason: `monitoring follow-up for a task reassigned to ${structured.owner}`,
      });
      return {
        applied: true,
        summary: `owner → ${structured.owner} · follow-up created`,
        decisionId,
        after: loadTargetState(target),
      };
    }
    case "dont_do_this": {
      // FIX-08: "Don't do this again" — the correction on THIS thing is a
      // behavioral rule for the NEXT one, written to behavioral memory
      // (claims kind `behavioral`, subject self) so the router consults it.
      const kind = structured.kind ?? (target.kind === "task" ? "task" : target.kind);
      const context = structured.context ?? null;
      const rule =
        structured.behavioral?.rule ??
        `don't ${kind === "task" ? "create tasks like" : `do ${kind.replace(/_/g, " ")} for`} ${labelOf(before) ?? target.id}${context ? ` (${context})` : ""}`;
      const scope = structured.behavioral?.scope ?? (context?.startsWith("app:") ? "router" : "global");
      const row = writeBehavioralRule({ rule, scope, kind, context, evidence: `don't do this again: ${labelOf(before) ?? target.id}` });
      const decisionId = decide("dont_do_this", `user: don't do this again → rule ${row.claim_key}`);
      return { applied: true, summary: `rule saved: ${row.rule} (${row.scope})`, decisionId, after: loadTargetState(target) };
    }
    case "tone":
    case "split":
    case "other":
      return { applied: false, summary: `recorded, not auto-applied (${structured.type}${structured.text ? `: ${structured.text}` : ""})` };
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

/**
 * The `created_by` stamp the FIX-07 monitoring follow-up carries. Keyed on the
 * reassigned task so the undo route can find it without a second table.
 */
export function followupCreatedBy(taskId: string): string {
  return `correction:wrong_person:${taskId}`;
}

function mintCorrectionId(): string {
  return `cor_${randomBytes(9).toString("hex")}`;
}

/** What one correction produced — the POST body, reusable off the wire. */
export interface CorrectionApplyResult {
  status: 200 | 400 | 404;
  body: Record<string, unknown>;
}

/**
 * ONE correction, applied. The HTTP route is a thin wrapper over this, and so
 * is the grounded bar's correction class (grounded/bar.ts) — a bar follow-up
 * on a locked object is the same pipeline as a chip or a drag (FIX-05), which
 * is why it lives here and not behind the wire.
 *
 * V6 P1 S5.5 additions: a `behavioral` rule that rode in with the parse is
 * written to behavioral memory whatever the correction type was (FIX-08), and
 * every correction — applied or pending — drafts a golden case (FIX-09).
 */
export async function applyCorrectionRequest(
  request: CorrectionRequest | undefined,
  parser: CorrectionParser = parseViaModel,
): Promise<CorrectionApplyResult> {
  const db = getDb();
  if (!request || !request.target || typeof request.target.id !== "string" || typeof request.target.kind !== "string") {
    return { status: 400, body: { error: "target {kind, id} required" } };
  }
  if (!request.structured && (typeof request.utterance !== "string" || request.utterance.trim() === "")) {
    return { status: 400, body: { error: "structured correction or utterance required" } };
  }

  const before = loadTargetState(request.target);
  if (before === null) {
    return { status: 404, body: { error: `no ${request.target.kind} ${request.target.id}` } };
  }

  let structured = request.structured ?? null;
  if (!structured && request.utterance) {
    structured = await parser(request.target, before, request.utterance);
  }

  const outcome: ApplyOutcome = structured
    ? applyCorrection(request.target, structured, before)
    : { applied: false, summary: "couldn't parse that into a correction" };

  const correctionId = mintCorrectionId();
  const instruction = request.utterance ?? JSON.stringify(request.structured);

  // FIX-08: the durable rule the correction implied outlives the object it was
  // said about. `dont_do_this` writes its own (with the target's label); any
  // other type that came back with a `behavioral` block writes it here, once.
  let behavioralRule: string | null = null;
  if (structured?.behavioral?.rule && structured.type !== "dont_do_this") {
    try {
      behavioralRule = writeBehavioralRule({
        rule: structured.behavioral.rule,
        scope: structured.behavioral.scope,
        kind: structured.kind ?? null,
        context: structured.context ?? null,
        correctionId,
        evidence: instruction,
      }).claim_key;
    } catch {
      behavioralRule = null;
    }
  }

  db.prepare(
    `INSERT INTO corrections (id, decision_id, target_kind, target_id, instruction, scope, status, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN ${NOW} ELSE NULL END)`,
  ).run(
    correctionId,
    outcome.decisionId ?? null,
    request.target.kind,
    request.target.id,
    instruction,
    request.scope ?? "once",
    outcome.applied ? "applied" : "pending",
    outcome.applied ? 1 : 0,
  );

  // The promotion loop (spec §14.4.5, FIX-09): every correction drafts an eval
  // case with the original context — including pending ones, which are exactly
  // the parses a human most wants to inspect.
  const draftPath = writeEvalDraft({
    correctionId,
    target: request.target,
    instruction,
    structured,
    before,
    after: outcome.after ?? loadTargetState(request.target),
  });

  return {
    status: 200,
    body: {
      correction_id: correctionId,
      status: outcome.applied ? "applied" : "pending",
      summary: outcome.summary,
      structured,
      decision_id: outcome.decisionId ?? null,
      behavioral_rule: behavioralRule,
      eval_draft: draftPath,
    },
  };
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

  // Behavioral memory (FIX-08) — the durable rules corrections implied.
  // Settings › Assist reads this list; the surface router consults the same
  // rows through grounded/behavioral.ts before it shows anything.
  if (req.method === "GET" && path === "/api/corrections/behavioral-rules") {
    sendJson(res, 200, { rules: listBehavioralRules() });
    return true;
  }
  const retire = path.match(/^\/api\/corrections\/behavioral-rules\/([^/]+)\/retire$/);
  if (req.method === "POST" && retire) {
    const key = decodeURIComponent(retire[1]!);
    const done = retireBehavioralRule(key);
    sendJson(res, done ? 200 : 404, done ? { retired: key } : { error: `no active rule ${key}` });
    return true;
  }

  if (req.method === "GET" && path === "/api/corrections") {
    const rows = db.prepare(`SELECT * FROM corrections ORDER BY created_at DESC LIMIT 50`).all();
    sendJson(res, 200, { corrections: rows });
    return true;
  }

  if (req.method === "POST" && path === "/api/corrections") {
    const body = (await readBody(req)) as CorrectionRequest | undefined;
    const outcome = await applyCorrectionRequest(body, parser);
    sendJson(res, outcome.status, outcome.body);
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
    // FIX-07: undoing a reassignment also takes back what the reassignment
    // ADDED — the monitoring follow-up. Dismissed, never deleted: the row and
    // its decision stay readable, the open list goes back to what it was.
    const followups = db
      .prepare(`SELECT id FROM tasks WHERE created_by = ? AND status = 'open'`)
      .all(followupCreatedBy(decision.target_id)) as { id: string }[];
    for (const f of followups) {
      const fBefore = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(f.id);
      db.prepare(`UPDATE tasks SET status = 'dismissed', closed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(f.id);
      writeDecision({
        pass: "user",
        targetKind: "task",
        targetId: f.id,
        action: "dismiss",
        old: fBefore,
        new: db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(f.id),
        reason: `undo of correction ${correction.id}`,
      });
    }
    markReversed(decision.id, correction.id);
    db.prepare(`UPDATE corrections SET status = 'rejected' WHERE id = ?`).run(id);
    sendJson(res, 200, { undone: true, restored: old, follow_ups_dismissed: followups.length });
    return true;
  }

  return false;
}
