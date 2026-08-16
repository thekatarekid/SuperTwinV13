// ===========================================================================
// [CODE] The entity-graph audit — arch §14.2 rows `identities silently
// guessed`, `resolution recall` and `metadata edges captured`.
//
// Everything the resolution ladder does leaves a row: an identity carries its
// decider, a merge carries a `resolution_decisions` verdict, a bind through
// rung ③ carries a `mutations` row naming the RUNG that fired. This module
// reads those rows back and answers three questions about the graph as it
// actually stands — no fixture, no expectation, no second implementation of
// the ladder.
//
// A SILENT GUESS is a resolution that COMMITTED with nothing that justifies
// it. Three shapes of it, all of them things that have shipped before:
//
//   * an [ML] match made while the embedder's floor was missing or stale —
//     the rung is supposed to be OFF then, and a score computed against an
//     unmeasured floor is a number with no meaning attached to it;
//   * a threshold invented in code — an `ml:<use_case>` bind recorded below
//     the measured bar for that use case, i.e. bound against some other
//     number than the one the architecture states;
//   * a commit nobody can attribute — a merge with no `resolution_decisions`
//     row, an identity/mention/edge with no decider or no confidence.
//
// The audit reports one record per resolution it EXAMINED, guilty or not, so
// a caller can say "n of m" rather than "none found" over a graph that
// resolved nothing at all.
//
// RECALL is measured against two facts the graph states about itself, not
// against a gold file: a normalised phone or email appearing under two
// sources is one person (rung ②, `identities.ts`), and a pair with a stored
// `same` verdict is one person (`merge.ts`). Either one still sitting on two
// live entities is a miss.
//
// METADATA EDGES are the free ones — a group's participant list and a
// calendar's attendee list, written at confidence 1.0 by `code:metadata`
// before any model runs. "Captured" means every member the source named has
// its edge, at that confidence, from that decider.
// ===========================================================================

import { isCalibUseCase } from "../db/calib.js";
import { getDb } from "../db/connection.js";
import {
  calibrationFor,
  USE_CASE_BARS,
  type CalibUseCase,
} from "../retrieval/calibration.js";
import { METADATA_DECIDER, listEdges } from "./edges.js";
import { CROSS_SOURCE_KINDS } from "./identities.js";
import { resolveEntityId } from "./registry.js";

// ---- silent guesses --------------------------------------------------------

/** What was examined. `rung` is the mutation row a rung ③/④ bind leaves. */
export type ResolutionSubject = "merge" | "rung" | "identity" | "mention" | "edge" | "decision";

export type SilentGuessKind =
  | "no_decider"
  | "no_confidence"
  | "no_decision_row"
  | "stale_calibration"
  | "invented_threshold"
  | "not_a_rung";

export interface SilentGuess {
  subject: ResolutionSubject;
  /** Row id, or `loser|winner` for a merge. */
  id: string;
  decidedBy: string | null;
  kind: SilentGuessKind;
  reason: string;
}

/** One resolution that committed, and whether anything justified it. */
export interface ResolutionAudit {
  subject: ResolutionSubject;
  id: string;
  decidedBy: string | null;
  /** Null when this resolution carried its rung. */
  guess: SilentGuess | null;
}

/**
 * The authorities that may decide an identity resolution. `user` is the human,
 * `code:*` are rungs ①/② and the structural writers, `ml:*` is rung ③ and
 * `agent:*` is rung ④. A `llm:*` decider is a model's extraction pass — it may
 * link a mention or state an edge, but it may NOT resolve two entities into
 * one: that is what the ladder is for.
 */
const RESOLUTION_AUTHORITY = /^(?:user|code:[a-z0-9_]+|ml:[a-z0-9_]+|agent:[a-z0-9._-]+)(?::[a-z0-9_]+)*$/;
const WRITER_AUTHORITY =
  /^(?:user|code:[a-z0-9_]+|ml:[a-z0-9_]+|agent:[a-z0-9._-]+|llm:[a-z0-9._-]+)(?::[a-z0-9_]+)*$/;

/** `ml:entity_name` → `entity_name`. Null when the decider is not rung ③. */
export function mlUseCaseOf(decidedBy: string | null): CalibUseCase | null {
  if (!decidedBy || !decidedBy.startsWith("ml:")) return null;
  const useCase = decidedBy.slice(3).split(":")[0];
  return isCalibUseCase(useCase) ? useCase : null;
}

export interface AuditOptions {
  /** The embedding model whose calibration governs rung ③. Defaults to active. */
  model?: string;
  now?: number;
}

function clean(subject: ResolutionSubject, id: string, decidedBy: string | null): ResolutionAudit {
  return { subject, id, decidedBy, guess: null };
}

function guilty(
  subject: ResolutionSubject,
  id: string,
  decidedBy: string | null,
  kind: SilentGuessKind,
  reason: string,
): ResolutionAudit {
  return { subject, id, decidedBy, guess: { subject, id, decidedBy, kind, reason } };
}

/**
 * Rung ③ may only have decided something if its floor was measured and fresh.
 * Anything else is the exact failure §10.3 was written to stop, so a decider
 * that says `ml:` is checked against the calibration table every time.
 */
function mlProblem(decidedBy: string, opts: AuditOptions): { kind: SilentGuessKind; reason: string } | null {
  if (!decidedBy.startsWith("ml:")) return null;
  const useCase = mlUseCaseOf(decidedBy);
  if (useCase === null) {
    return {
      kind: "not_a_rung",
      reason: `${decidedBy} names no calibrated use case — the [ML] rung it claims does not exist`,
    };
  }
  const calibration = calibrationFor(useCase, { model: opts.model, now: opts.now });
  if (calibration.state !== "ready" || calibration.floor === null) {
    return {
      kind: "stale_calibration",
      reason: `[ML] committed on ${calibration.state} calibration: ${calibration.reason}`,
    };
  }
  return null;
}

/** Decider present, recognised, and — when it is rung ③ — actually calibrated. */
function checkDecider(
  subject: ResolutionSubject,
  id: string,
  decidedBy: string | null,
  authority: RegExp,
  opts: AuditOptions,
): ResolutionAudit | null {
  const text = (decidedBy ?? "").trim();
  if (text === "") {
    return guilty(subject, id, decidedBy, "no_decider", `${subject} committed with no decided_by`);
  }
  if (!authority.test(text)) {
    return guilty(
      subject,
      id,
      decidedBy,
      "not_a_rung",
      `${subject} committed by ${JSON.stringify(decidedBy)}, which is not a rung of the ladder`,
    );
  }
  const ml = mlProblem(text, opts);
  if (ml) return guilty(subject, id, decidedBy, ml.kind, ml.reason);
  return null;
}

interface DecisionRecord {
  id: string;
  left: string;
  right: string;
  verdict: string;
  decidedBy: string | null;
}

function allDecisions(): DecisionRecord[] {
  return (
    getDb()
      .prepare(`SELECT id, left_id, right_id, verdict, decided_by FROM resolution_decisions ORDER BY id`)
      .all() as { id: string; left_id: string; right_id: string; verdict: string; decided_by: string | null }[]
  ).map((r) => ({ id: r.id, left: r.left_id, right: r.right_id, verdict: r.verdict, decidedBy: r.decided_by }));
}

/** Pairs are stored sorted, so a lookup has to sort too. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The `mutations` row rungs ③/④ write beside a bind: `field = 'resolution'`,
 * `new_json = { rung, decidedBy, confidence, score }`. It is the row an
 * "explain this merge" surface reads, and the only place the SCORE a bind was
 * made on survives.
 */
interface ResolutionMutation {
  targetId: string;
  actor: string | null;
  rung: string | null;
  confidence: number | null;
  score: number | null;
}

function resolutionMutations(): ResolutionMutation[] {
  return (
    getDb()
      .prepare(
        `SELECT target_id, actor, new_json FROM mutations
          WHERE target_kind = 'entity_pair' AND field = 'resolution' ORDER BY ts, rowid`,
      )
      .all() as { target_id: string; actor: string | null; new_json: string | null }[]
  ).map((r) => {
    let parsed: { rung?: unknown; confidence?: unknown; score?: unknown } = {};
    try {
      parsed = r.new_json === null ? {} : (JSON.parse(r.new_json) as typeof parsed);
    } catch {
      parsed = {};
    }
    return {
      targetId: r.target_id,
      actor: r.actor,
      rung: typeof parsed.rung === "string" ? parsed.rung : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      score: typeof parsed.score === "number" ? parsed.score : null,
    };
  });
}

/**
 * Every resolution that committed, examined against the rung that is supposed
 * to have fired. `auditSilentGuesses` is the guilty subset, and its length is
 * the §14.2 `identities silently guessed` row — which must be zero.
 */
export function auditResolutions(opts: AuditOptions = {}): ResolutionAudit[] {
  const db = getDb();
  const audits: ResolutionAudit[] = [];
  const decisions = allDecisions();
  const byPair = new Map(decisions.map((d) => [pairKey(d.left, d.right), d]));

  // 1. Merges. A tombstone is a resolution that committed, so it needs a
  //    `same` verdict naming who decided it — and that decider has to be a
  //    rung of the ladder, not a model that wandered in.
  const tombstones = db
    .prepare(`SELECT id, merged_into FROM entities WHERE merged_into IS NOT NULL`)
    .all() as { id: string; merged_into: string }[];
  for (const t of tombstones) {
    const key = pairKey(t.id, t.merged_into);
    const decision = byPair.get(key);
    if (!decision) {
      audits.push(
        guilty(
          "merge",
          key,
          null,
          "no_decision_row",
          "merged with no resolution_decisions row — nothing records which rung fired",
        ),
      );
      continue;
    }
    audits.push(
      checkDecider("merge", key, decision.decidedBy, RESOLUTION_AUTHORITY, opts) ??
        clean("merge", key, decision.decidedBy),
    );
  }

  // 2. The rung ③/④ mutation rows: the score a bind was made on, against the
  //    measured bar for its use case. A bind below that bar was made against
  //    some other number, and that number was invented in code.
  for (const m of resolutionMutations()) {
    const bad = checkDecider("rung", m.targetId, m.actor, RESOLUTION_AUTHORITY, opts);
    if (bad) {
      audits.push(bad);
      continue;
    }
    const useCase = mlUseCaseOf(m.actor);
    if (m.rung !== "ml" || useCase === null) {
      audits.push(clean("rung", m.targetId, m.actor));
      continue;
    }
    const bar = USE_CASE_BARS[useCase].bind;
    const scored = m.confidence ?? m.score;
    if (scored === null) {
      audits.push(
        guilty("rung", m.targetId, m.actor, "no_confidence", "[ML] bound a pair with no recorded score"),
      );
    } else if (scored < bar) {
      audits.push(
        guilty(
          "rung",
          m.targetId,
          m.actor,
          "invented_threshold",
          `[ML] bound at ${scored.toFixed(3)}, below the measured ${useCase} bar of ${bar}`,
        ),
      );
    } else {
      audits.push(clean("rung", m.targetId, m.actor));
    }
  }

  // 3. Identity rows. Rungs ① and ② are exact, but they still have to say so:
  //    `assertProvenance`'s rule, checked against what actually landed.
  const identities = db
    .prepare(`SELECT id, decided_by, confidence FROM entity_identities ORDER BY id`)
    .all() as { id: string; decided_by: string | null; confidence: number | null }[];
  for (const row of identities) {
    const bad = checkDecider("identity", row.id, row.decided_by, WRITER_AUTHORITY, opts);
    if (bad) {
      audits.push(bad);
    } else if (row.confidence === null) {
      audits.push(
        guilty("identity", row.id, row.decided_by, "no_confidence", "identity filed with no confidence"),
      );
    } else {
      audits.push(clean("identity", row.id, row.decided_by));
    }
  }

  // 4. Mentions that LANDED on an entity. An unlinked mention is the honest
  //    outcome and is not audited here — unknown beats wrong.
  const mentions = db
    .prepare(`SELECT id, decided_by, confidence FROM mentions WHERE entity_id IS NOT NULL ORDER BY id`)
    .all() as { id: string; decided_by: string | null; confidence: number | null }[];
  for (const row of mentions) {
    const bad = checkDecider("mention", row.id, row.decided_by, WRITER_AUTHORITY, opts);
    if (bad) {
      audits.push(bad);
    } else if (row.confidence === null) {
      audits.push(
        guilty("mention", row.id, row.decided_by, "no_confidence", "mention linked with no confidence"),
      );
    } else {
      audits.push(clean("mention", row.id, row.decided_by));
    }
  }

  // 5. Edges. An edge names two entities, so an unattributable edge is a
  //    resolution nobody can explain either.
  for (const edge of listEdges()) {
    audits.push(
      checkDecider("edge", edge.id, edge.decidedBy, WRITER_AUTHORITY, opts) ??
        clean("edge", edge.id, edge.decidedBy),
    );
  }

  // 6. Verdicts themselves. A `same` verdict is a commit even before the
  //    tombstone lands, so its decider is held to the same rule.
  for (const d of decisions) {
    if (d.verdict !== "same") continue;
    audits.push(
      checkDecider("decision", d.id, d.decidedBy, RESOLUTION_AUTHORITY, opts) ??
        clean("decision", d.id, d.decidedBy),
    );
  }

  return audits;
}

/** The guilty subset. Its length is the number §14.2 gates at zero. */
export function auditSilentGuesses(opts: AuditOptions = {}): SilentGuess[] {
  return auditResolutions(opts)
    .map((a) => a.guess)
    .filter((g): g is SilentGuess => g !== null);
}

// ---- recall ----------------------------------------------------------------

export type RecallKind = "cross_source" | "decided_same";

export interface RecallOpportunity {
  kind: RecallKind;
  /** `phone:+919800000001`, or the decision's pair key. */
  key: string;
  /** The live entities the joinable references currently sit on. */
  entities: string[];
  recovered: boolean;
  reason: string;
}

/**
 * The joins the graph itself says are owed, and whether they happened.
 *
 * Two sources of truth, both structural:
 *
 *   ② a normalised phone or email under two different sources is ONE person.
 *     That is rung ②'s rule, and `identities.ts` states it as the only join
 *     code may make across a source boundary.
 *   ✓ a stored `same` verdict — from the user, the agent or rung ③ — is a
 *     resolution that was decided. If the two ids still resolve apart, the
 *     verdict was recorded and then not applied.
 *
 * Recall is `recovered / total` over these. Nothing here reads an expectation
 * file: an opportunity is a fact about the rows, not about a fixture.
 */
export function auditResolutionRecall(): RecallOpportunity[] {
  const db = getDb();
  const out: RecallOpportunity[] = [];

  const marks = CROSS_SOURCE_KINDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT kind, value_norm, source_id, entity_id FROM entity_identities
        WHERE kind IN (${marks}) ORDER BY kind, value_norm, id`,
    )
    .all(...CROSS_SOURCE_KINDS) as {
    kind: string;
    value_norm: string;
    source_id: string | null;
    entity_id: string;
  }[];

  const groups = new Map<string, { sources: Set<string>; entities: Set<string> }>();
  for (const row of rows) {
    const key = `${row.kind}:${row.value_norm}`;
    const g = groups.get(key) ?? { sources: new Set<string>(), entities: new Set<string>() };
    g.sources.add(row.source_id ?? "-");
    const live = resolveEntityId(row.entity_id);
    if (live) g.entities.add(live);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    // One source only: nothing was ever owed a join here.
    if (g.sources.size < 2) continue;
    const recovered = g.entities.size === 1;
    out.push({
      kind: "cross_source",
      key,
      entities: [...g.entities],
      recovered,
      reason: recovered
        ? `${key} joins ${g.sources.size} sources on one entity`
        : `${key} appears in ${g.sources.size} sources but sits on ${g.entities.size} entities`,
    });
  }

  for (const d of allDecisions()) {
    if (d.verdict !== "same") continue;
    const left = resolveEntityId(d.left);
    const right = resolveEntityId(d.right);
    const entities = [...new Set([left, right].filter((v): v is string => v !== null))];
    const recovered = entities.length === 1;
    out.push({
      kind: "decided_same",
      key: pairKey(d.left, d.right),
      entities,
      recovered,
      reason: recovered
        ? `a 'same' verdict by ${d.decidedBy ?? "?"} resolves to one entity`
        : `a 'same' verdict by ${d.decidedBy ?? "?"} still resolves to ${entities.length} entities`,
    });
  }

  return out;
}

// ---- metadata edges --------------------------------------------------------

/** One member of a source's participant / attendee list, as the binder bound it. */
export interface MetadataMembership {
  memberEntityId: string;
  containerEntityId: string;
  kind: "affiliated_with" | "participates_in";
}

export interface MetadataEdgeCheck extends MetadataMembership {
  captured: boolean;
  reason: string;
}

/**
 * "Metadata edges captured", §14.2, at 100% or the build fails. The source
 * named these members; every one of them owes an ACTIVE edge from
 * `code:metadata` at confidence 1.0, with no model call behind it.
 */
export function auditMetadataEdges(
  memberships: readonly MetadataMembership[],
): MetadataEdgeCheck[] {
  const edges = listEdges({ status: "active" });
  return memberships.map((m) => {
    const src = resolveEntityId(m.memberEntityId);
    const dst = resolveEntityId(m.containerEntityId);
    const hit = edges.find(
      (e) =>
        e.kind === m.kind &&
        resolveEntityId(e.srcEntityId) === src &&
        resolveEntityId(e.dstEntityId) === dst,
    );
    if (!hit) {
      return { ...m, captured: false, reason: `no active ${m.kind} edge for a member the source named` };
    }
    if (hit.decidedBy !== METADATA_DECIDER) {
      return {
        ...m,
        captured: false,
        reason: `${m.kind} edge decided by ${String(hit.decidedBy)}, not ${METADATA_DECIDER}`,
      };
    }
    if (hit.confidence !== 1) {
      return {
        ...m,
        captured: false,
        reason: `${m.kind} metadata edge written at confidence ${String(hit.confidence)}, not 1.0`,
      };
    }
    return { ...m, captured: true, reason: `${m.kind} edge from ${METADATA_DECIDER} at 1.0` };
  });
}
