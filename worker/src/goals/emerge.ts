// ===========================================================================
// [CODE] Goal emergence — build item 3.9, arch §11.6 ⑧.
//
//   "when 2–3 loops across ≥2 spaces share ≥2 anchor entities and a horizon,
//    propose a life project linking those spaces. Goals live ABOVE spaces,
//    many-to-one."
//
// Two rules govern this file and they pull in the same direction:
//
//   NEVER SCAFFOLDED   No goal is ever created by extraction. No prompt writes
//                      this table, no model field lands in it. A goal exists
//                      because the graph already contained the shape of one —
//                      loops the user actually ran, in spaces that were already
//                      promoted, sharing people and a deadline.
//
//   NO EVIDENCE, NO GOAL   Every loop in a proposal must carry at least one
//                      `evidence` row with a verbatim quote. A candidate whose
//                      loops cannot be pointed at is not a weak proposal, it is
//                      not a proposal: `emergeGoals` drops it, and `confirm`
//                      throws rather than write a row that nothing supports.
//
// The split mirrors `arcs/promote.ts` / `arcs/promote-store.ts`: `emergeGoals`
// is a pure function over plain values (every threshold testable without a
// database), `readEmergenceInput` / `proposeGoals` / `confirmGoalProposal` are
// the SQL half. Proposing writes nothing — the migration says goals "emerged
// and were confirmed", so confirmation is a separate, deliberate call.
// ===========================================================================

import { createHash } from "node:crypto";

import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";

/** Every emergence write carries this actor, so a sweep is one undoable unit. */
export const EMERGENCE_ACTOR = "code:goal-emerge";

/** §6 `goals.kind` for an emerged goal. A life project links spaces, nothing else. */
export const LIFE_PROJECT_KIND = "life_project";

/** §11.6 ⑧ — "2–3 loops". Not one, and not a whole space's worth. */
export const MIN_LOOPS = 2;
export const MAX_LOOPS = 3;

/** §11.6 ⑧ — "across ≥2 spaces". A space is a promoted arc; there is no `spaces` table. */
export const MIN_SPACES = 2;

/** §11.6 ⑧ — "share ≥2 anchor entities". One shared person is a coincidence. */
export const MIN_SHARED_ANCHORS = 2;

/**
 * A horizon of `none` is the ABSENCE of a horizon — §11.4 computes it when a
 * loop has no due date at all. "Share a horizon" cannot be satisfied by two
 * loops that both share having no deadline, so `none` never groups.
 */
export const NON_HORIZON = "none";

// ---- inputs ----------------------------------------------------------------

/** One candidate loop, flattened out of `loops` + its arc + its evidence. */
export interface EmergenceLoop {
  loopId: string;
  /** The promoted arc this loop belongs to — the space id in `goal_spaces`. */
  spaceId: string | null;
  /** False for an unpromoted arc or no arc at all. Only spaces count. */
  spacePromoted: boolean;
  /** §11.4 computed horizon: today|week|month|quarter|year|none. */
  horizon: string | null;
  /** Loop parties plus the arc's anchors — who and what this loop is about. */
  anchorEntityIds: readonly string[];
  /** `events.id` rows behind this loop. Empty ⇒ the loop cannot be evidence. */
  evidenceEventIds: readonly string[];
  intent?: string | null;
}

export interface EmergenceInput {
  loops: readonly EmergenceLoop[];
  /** entity id → display name, for naming the proposal. Optional. */
  entityNames?: Readonly<Record<string, string>>;
}

// ---- output ----------------------------------------------------------------

export interface GoalProposal {
  /** Stable across re-derivation: sha1(horizon │ anchors │ spaces). */
  proposalKey: string;
  /** The suggested `goals.name`. A user rename replaces it; nothing regenerates it. */
  name: string;
  kind: typeof LIFE_PROJECT_KIND;
  horizon: string;
  /** The promoted arc ids this goal links. Length ≥ MIN_SPACES, sorted. */
  spaceIds: string[];
  /** The 2–3 loops that produced it, sorted. */
  loopIds: string[];
  /** The entities every one of those loops shares. Length ≥ MIN_SHARED_ANCHORS, sorted. */
  sharedAnchorIds: string[];
  /** Union of the loops' evidence events. NEVER empty — that is the whole rule. */
  evidenceEventIds: string[];
}

// ---- the rule --------------------------------------------------------------

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v !== ""))].sort();
}

function intersect(sets: readonly (readonly string[])[]): string[] {
  if (sets.length === 0) return [];
  let acc = new Set(sets[0]);
  for (const next of sets.slice(1)) {
    const other = new Set(next);
    acc = new Set([...acc].filter((v) => other.has(v)));
    if (acc.size === 0) break;
  }
  return [...acc].sort();
}

/** Combinations of exactly `size` — the candidate sets are tiny by construction. */
function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0 || size > items.length) return [];
  if (size === items.length) return [[...items]];
  const out: T[][] = [];
  const walk = (start: number, picked: T[]): void => {
    if (picked.length === size) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      picked.push(items[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

export function proposalKeyFor(
  horizon: string,
  sharedAnchorIds: readonly string[],
  spaceIds: readonly string[],
): string {
  return createHash("sha1")
    .update(`${horizon}|${uniqueSorted(sharedAnchorIds).join(",")}|${uniqueSorted(spaceIds).join(",")}`)
    .digest("hex");
}

export function goalIdForKey(proposalKey: string): string {
  return `goal_${String(proposalKey).slice(0, 16)}`;
}

const HORIZON_PHRASE: Readonly<Record<string, string>> = {
  today: "today",
  week: "this week",
  month: "this month",
  quarter: "this quarter",
  year: "this year",
};

function proposalName(
  horizon: string,
  sharedAnchorIds: readonly string[],
  names: Readonly<Record<string, string>>,
): string {
  const labelled = sharedAnchorIds.map((id) => names[id] ?? id);
  const who =
    labelled.length <= 2
      ? labelled.join(" and ")
      : `${labelled.slice(0, 2).join(", ")} and ${labelled.length - 2} more`;
  const when = HORIZON_PHRASE[horizon] ?? horizon;
  return `${who} — ${when}`;
}

/**
 * A loop only counts when it is in a PROMOTED arc, carries a real horizon and
 * has evidence. Everything discarded here is discarded for a stated reason, so
 * "why is there no goal?" is answerable.
 */
function isCandidate(loop: EmergenceLoop): boolean {
  if (!loop.spacePromoted) return false;
  if (loop.spaceId === null || loop.spaceId === "") return false;
  if (loop.horizon === null || loop.horizon === "" || loop.horizon === NON_HORIZON) return false;
  if (uniqueSorted(loop.evidenceEventIds).length === 0) return false;
  return uniqueSorted(loop.anchorEntityIds).length > 0;
}

/**
 * §11.6 ⑧, in full. Pure: no clock, no database, no model. Groups of 2 then 3
 * within a single horizon; a group that already qualifies at 2 is not re-emitted
 * as its own 3-loop superset unless the third loop brings a NEW space or shifts
 * the shared anchors, which would make it a different proposal anyway.
 */
export function emergeGoals(input: EmergenceInput): GoalProposal[] {
  const names = input.entityNames ?? {};
  const byHorizon = new Map<string, EmergenceLoop[]>();
  for (const loop of input.loops) {
    if (!isCandidate(loop)) continue;
    const horizon = String(loop.horizon);
    const bucket = byHorizon.get(horizon);
    if (bucket) bucket.push(loop);
    else byHorizon.set(horizon, [loop]);
  }

  const seen = new Set<string>();
  const proposals: GoalProposal[] = [];

  for (const horizon of [...byHorizon.keys()].sort()) {
    const loops = [...(byHorizon.get(horizon) ?? [])].sort((a, b) => (a.loopId < b.loopId ? -1 : 1));
    for (let size = MIN_LOOPS; size <= MAX_LOOPS; size += 1) {
      for (const group of combinations(loops, size)) {
        const spaceIds = uniqueSorted(group.map((l) => String(l.spaceId)));
        if (spaceIds.length < MIN_SPACES) continue;

        const shared = intersect(group.map((l) => uniqueSorted(l.anchorEntityIds)));
        if (shared.length < MIN_SHARED_ANCHORS) continue;

        const evidenceEventIds = uniqueSorted(group.flatMap((l) => l.evidenceEventIds));
        if (evidenceEventIds.length === 0) continue; // unreachable via isCandidate; the rule is stated anyway

        const proposalKey = proposalKeyFor(horizon, shared, spaceIds);
        if (seen.has(proposalKey)) continue;
        seen.add(proposalKey);

        proposals.push({
          proposalKey,
          name: proposalName(horizon, shared, names),
          kind: LIFE_PROJECT_KIND,
          horizon,
          spaceIds,
          loopIds: uniqueSorted(group.map((l) => l.loopId)),
          sharedAnchorIds: shared,
          evidenceEventIds,
        });
      }
    }
  }

  return proposals;
}

// ---- reads -----------------------------------------------------------------

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Every loop that sits in a promoted arc, with its arc anchors, its parties and
 * its evidence. `promoted = 1` is the whole space filter — there is no `spaces`
 * table and `goal_spaces.space_id` references `arcs(id)`.
 */
export function readEmergenceInput(): EmergenceInput {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.id                AS loop_id,
              l.intent            AS intent,
              l.horizon           AS horizon,
              l.owner_id          AS owner_id,
              l.counterparty_id   AS counterparty_id,
              a.id                AS space_id,
              a.promoted          AS promoted,
              a.anchor_entity_ids AS anchor_entity_ids
         FROM loops l
         JOIN arcs  a ON a.id = l.arc_id
        WHERE a.promoted = 1
        ORDER BY l.id`,
    )
    .all() as Record<string, unknown>[];

  const evidenceRows = db
    .prepare(
      `SELECT subject_id AS subject_id, event_id AS event_id
         FROM evidence WHERE subject_kind = 'loop' ORDER BY subject_id, event_id`,
    )
    .all() as Record<string, unknown>[];
  const evidence = new Map<string, string[]>();
  for (const row of evidenceRows) {
    const key = String(row.subject_id);
    const bucket = evidence.get(key);
    if (bucket) bucket.push(String(row.event_id));
    else evidence.set(key, [String(row.event_id)]);
  }

  const loops: EmergenceLoop[] = rows.map((r) => {
    const anchors = [
      ...jsonArray(r.anchor_entity_ids),
      ...[text(r.owner_id), text(r.counterparty_id)].filter((v): v is string => v !== null),
    ];
    return {
      loopId: String(r.loop_id),
      spaceId: text(r.space_id),
      spacePromoted: Number(r.promoted ?? 0) === 1,
      horizon: text(r.horizon),
      anchorEntityIds: uniqueSorted(anchors),
      evidenceEventIds: evidence.get(String(r.loop_id)) ?? [],
      intent: text(r.intent),
    };
  });

  const wanted = uniqueSorted(loops.flatMap((l) => [...l.anchorEntityIds]));
  const entityNames: Record<string, string> = {};
  if (wanted.length > 0) {
    const marks = wanted.map(() => "?").join(", ");
    for (const row of db
      .prepare(`SELECT id, canonical FROM entities WHERE id IN (${marks})`)
      .all(...wanted) as Record<string, unknown>[]) {
      const canonical = text(row.canonical);
      if (canonical !== null && canonical !== "") entityNames[String(row.id)] = canonical;
    }
  }

  return { loops, entityNames };
}

/** Read the graph, apply §11.6 ⑧, write nothing. What the Spaces tab asks for. */
export function proposeGoals(): GoalProposal[] {
  return emergeGoals(readEmergenceInput());
}

// ---- writes ----------------------------------------------------------------

export interface ConfirmOptions {
  actor?: string;
  runId?: string | null;
  /** The user's own name for it. Replaces the derived one; never regenerated. */
  name?: string;
  /** `goals.owner_id`. Defaults to null — an emerged goal has no asserted owner. */
  ownerId?: string | null;
}

export interface ConfirmResult {
  goalId: string;
  created: boolean;
  spaceIds: string[];
}

function readGoalByKey(proposalKey: string): { id: string } | null {
  const row = getDb()
    .prepare(`SELECT id, emerged_from_json FROM goals WHERE id = ?`)
    .get(goalIdForKey(proposalKey)) as Record<string, unknown> | undefined;
  return row ? { id: String(row.id) } : null;
}

/**
 * The only path by which a row reaches `goals`. It refuses a proposal that
 * cannot be pointed at: no evidence events, too few spaces, too few shared
 * anchors — all throw. Item 3.9's acceptance is "zero goals created without
 * evidence", and it is enforced here rather than trusted upstream.
 *
 * Idempotent: the id is derived from the proposal key, so re-running emergence
 * over a grown graph rebinds to the same goal instead of minting a twin.
 */
export function confirmGoalProposal(proposal: GoalProposal, opts: ConfirmOptions = {}): ConfirmResult {
  const evidenceEventIds = uniqueSorted(proposal.evidenceEventIds);
  if (evidenceEventIds.length === 0) {
    throw new Error("goal emergence: refusing to create a goal with no evidence");
  }
  const spaceIds = uniqueSorted(proposal.spaceIds);
  if (spaceIds.length < MIN_SPACES) {
    throw new Error(`goal emergence: a life project links ≥${MIN_SPACES} spaces, got ${spaceIds.length}`);
  }
  if (uniqueSorted(proposal.sharedAnchorIds).length < MIN_SHARED_ANCHORS) {
    throw new Error(`goal emergence: ≥${MIN_SHARED_ANCHORS} shared anchors required`);
  }
  const loopIds = uniqueSorted(proposal.loopIds);
  if (loopIds.length < MIN_LOOPS || loopIds.length > MAX_LOOPS) {
    throw new Error(`goal emergence: ${MIN_LOOPS}–${MAX_LOOPS} loops required, got ${loopIds.length}`);
  }

  const db = getDb();
  const goalId = goalIdForKey(proposal.proposalKey);
  const existing = readGoalByKey(proposal.proposalKey);
  const actor = opts.actor ?? EMERGENCE_ACTOR;
  const name = opts.name ?? proposal.name;

  const emergedFrom = {
    proposalKey: proposal.proposalKey,
    horizon: proposal.horizon,
    loopIds,
    spaceIds,
    sharedAnchorIds: uniqueSorted(proposal.sharedAnchorIds),
    evidenceEventIds,
  };

  if (existing === null) {
    db.prepare(
      `INSERT INTO goals (id, name, kind, owner_id, emerged_from_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(goalId, name, proposal.kind, opts.ownerId ?? null, JSON.stringify(emergedFrom));
    logMutation({
      actor,
      runId: opts.runId ?? null,
      targetKind: "goal",
      targetId: goalId,
      field: "emerged_from_json",
      oldValue: null,
      newValue: emergedFrom,
      reason: `emerged from ${loopIds.length} loops across ${spaceIds.length} spaces (${proposal.horizon})`,
    });
  }

  const link = db.prepare(`INSERT OR IGNORE INTO goal_spaces (goal_id, space_id) VALUES (?, ?)`);
  for (const spaceId of spaceIds) {
    const result = link.run(goalId, spaceId);
    if (Number(result.changes ?? 0) === 0) continue;
    logMutation({
      actor,
      runId: opts.runId ?? null,
      targetKind: "goal",
      targetId: goalId,
      field: "goal_spaces",
      oldValue: null,
      newValue: spaceId,
      reason: "space linked by emergence",
    });
  }

  return { goalId, created: existing === null, spaceIds };
}

export interface EmergenceSweep {
  proposals: GoalProposal[];
  confirmed: ConfirmResult[];
}

/**
 * Propose, and optionally confirm. `confirm` defaults to FALSE: §11.6 ⑧ says
 * *propose*, and the migration says goals "emerged and were confirmed". Passing
 * `confirm: true` is the caller asserting the confirmation already happened.
 */
export function sweepGoalEmergence(opts: ConfirmOptions & { confirm?: boolean } = {}): EmergenceSweep {
  const proposals = proposeGoals();
  if (opts.confirm !== true) return { proposals, confirmed: [] };
  return { proposals, confirmed: proposals.map((p) => confirmGoalProposal(p, opts)) };
}

/** Read back what emerged, for the Spaces surface. */
export function readGoals(): { id: string; name: string; kind: string | null; spaceIds: string[] }[] {
  const db = getDb();
  const rows = db.prepare(`SELECT id, name, kind FROM goals ORDER BY created_at, id`).all() as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: text(r.kind),
    spaceIds: (
      db.prepare(`SELECT space_id FROM goal_spaces WHERE goal_id = ? ORDER BY space_id`).all(r.id) as Record<
        string,
        unknown
      >[]
    ).map((s) => String(s.space_id)),
  }));
}
