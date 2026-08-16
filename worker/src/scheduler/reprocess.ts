// ===========================================================================
// [CODE] Two-pass enrichment completion — arch §8.4 "Text-first, enrich-later
// — exactly two passes" and §9.6 "Media never blocks text"; build item 3.5.
//
// This is the other half of `media/enrich-pass.ts` (item 1.4). That module owns
// the countdown going DOWN — one enrichment resolves, one decrement, and at
// zero one `work_queue` row. This module owns everything around it:
//
//   arm      — count what an episode is actually waiting on, from the events
//              themselves, and stamp each attachment's `enrichment_state`
//   plan     — may the completion pass run, and WHICH pass is it
//   record   — a pass finished: the counter moves, the ◍ marker clears
//   re-arm   — media that arrived later still, bounded at `reprocess_max`
//   context  — what pass 2 carries so it re-reads without re-emitting
//
// EXACTLY TWO PASSES, NEVER THREE (§8.4 rule 1). Pass 1 is text-only and
// immediate, with every attachment standing in as an explicit placeholder.
// Pass 2 fires ONCE, when `pending_enrichment_count` reaches zero. There is no
// debounce, no barrier, no threshold. An episode with no media has exactly one
// pass. A third pass exists only for media that arrives LATER STILL — a delayed
// sync, an extended history range, a re-downloaded attachment (§8.4 rule 2) —
// and the ceiling is `reprocess_max`, default 3.
//
// THE COUNTER IS THE GUARD. `sessions.reprocess_count` is the number of passes
// COMPLETED on this episode: 1 after the text-first pass, 2 after completion.
// `planCompletionPass` refuses at 2 unless new enrichment is outstanding, which
// is what makes "landing on zero twice" impossible to turn into a third read —
// and a pass that never runs is a pass that cannot duplicate a claim.
//
// FAILED AND SKIPPED ARE RESOLVED (§8.4 rule 3). A voice note whose whisper run
// died is not pending; its placeholder becomes "[voice note, unreadable]" and
// pass 2 proceeds. One bad file may never strand an episode at ◍ forever.
//
// MEDIA NEVER BLOCKS TEXT. Nothing here is on the text path. Every function
// below runs after pass 1 has already emitted its claims and loops.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { getDb } from "../db/connection.js";
import { pendingEnrichmentCount } from "../media/enrich-pass.js";
import { getDeltaContextMode, type Cl1dExtractedItem, type DeltaContextMode } from "../prompts/p-cl1d.js";
import type { PackEvent } from "../wire/pack.js";
import { ATTACHMENT_COLUMNS, stateOf, toPackEvent, type AttachmentRow } from "./enrichment-state.js";
import { REPROCESS_MAX } from "./lanes.js";

export { placeholderFor, type EnrichmentState } from "./enrichment-state.js";

// ---------------------------------------------------------------------------
// The ceiling — §8.4 table, §9.6 rule 6
// ---------------------------------------------------------------------------

export const REPROCESS_MAX_KEY = "enrichment.reprocess_max";

/** `enrichment.reprocess_max` default 3, shared with `lanes.episodePassPlan`. */
export const DEFAULT_REPROCESS_MAX = REPROCESS_MAX;

/** Below 2 the completion pass could never run at all; above 8 is not a bound. */
export const MIN_REPROCESS_MAX = 2;
export const MAX_REPROCESS_MAX = 8;

export function clampReprocessMax(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_REPROCESS_MAX;
  return Math.max(MIN_REPROCESS_MAX, Math.min(MAX_REPROCESS_MAX, Math.floor(n)));
}

/** Read fresh every time, so a Settings change lands on the next episode. */
export function getReprocessMax(): number {
  const raw = appStateGet(REPROCESS_MAX_KEY);
  if (raw === null) return DEFAULT_REPROCESS_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REPROCESS_MAX;
  return clampReprocessMax(n);
}

export function setReprocessMax(n: number): void {
  appStateSet(REPROCESS_MAX_KEY, String(clampReprocessMax(n)));
}

// ---------------------------------------------------------------------------
// The episode's pass state
// ---------------------------------------------------------------------------

export interface EpisodePassState {
  sessionId: string;
  /** Passes COMPLETED. 1 after text-first, 2 after completion. */
  passesDone: number;
  /** `sessions.pending_enrichment_count` — attachments still being read. */
  pending: number;
  /** Attachments this episode holds at all. Zero means exactly one pass. */
  attachments: number;
  /** The ◍ "media still reading" marker (§8.4). */
  stillReading: boolean;
  /** At the ceiling: enrichment is still stored, the PASS is what stops. */
  flaggedForReconcile: boolean;
}

interface SessionRow {
  id: string;
  event_ids: string | null;
  stream_id: string | null;
  pending_enrichment_count: number;
  reprocess_count: number;
}

function sessionRow(sessionId: string): SessionRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, event_ids, stream_id, pending_enrichment_count, reprocess_count
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

function eventIdsOf(row: SessionRow): string[] {
  if (!row.event_ids) return [];
  try {
    const parsed: unknown = JSON.parse(row.event_ids);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** The session's events IN SESSION ORDER — the order the seal froze. */
function attachmentRows(row: SessionRow): AttachmentRow[] {
  const ids = eventIdsOf(row);
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM events WHERE id IN (${marks})`)
    .all(...ids) as AttachmentRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: AttachmentRow[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) out.push(found);
  }
  return out;
}

export function passState(sessionId: string): EpisodePassState | null {
  const row = sessionRow(sessionId);
  if (row === null) return null;
  const rows = attachmentRows(row);
  let attachments = 0;
  for (const r of rows) if (stateOf(r) !== "none_needed") attachments += 1;
  const pending = Math.max(0, row.pending_enrichment_count);
  return {
    sessionId,
    passesDone: Math.max(0, row.reprocess_count),
    pending,
    attachments,
    stillReading: pending > 0,
    flaggedForReconcile: Math.max(0, row.reprocess_count) >= getReprocessMax(),
  };
}

/** The ◍ marker, for a surface that wants to ask about one episode. */
export function mediaStillReading(sessionId: string): boolean {
  return pendingEnrichmentCount(sessionId) > 0;
}

// ---------------------------------------------------------------------------
// Arming — what the episode is actually waiting on
// ---------------------------------------------------------------------------

export interface ArmReport {
  sessionId: string;
  /** Attachments of any state. */
  attachments: number;
  /** Attachments still being read — the countdown pass 2 waits on. */
  pending: number;
}

/**
 * Count what this episode is waiting on, FROM THE EVENTS, and write it. Called
 * once as pass 1 hands off (the placeholders it just sent are exactly these
 * rows), and again whenever the membership or the enrichment verdicts change.
 *
 * Each event's `enrichment_state` is stamped at the same time, so the queue and
 * the surfaces read one derived truth instead of re-deriving it three ways.
 *
 * An episode with no attachments arms zero: it has exactly one pass, and there
 * is nothing for pass 2 to wait on or to add.
 */
export function armEnrichmentCountdown(sessionId: string): ArmReport {
  const row = sessionRow(sessionId);
  if (row === null) return { sessionId, attachments: 0, pending: 0 };

  const db = getDb();
  const rows = attachmentRows(row);
  const stamp = db.prepare(`UPDATE events SET enrichment_state = ? WHERE id = ?`);
  let attachments = 0;
  let pending = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const state = stateOf(r);
      stamp.run(state, r.id);
      if (state === "none_needed") continue;
      attachments += 1;
      if (state === "pending") pending += 1;
    }
    db.prepare(`UPDATE sessions SET pending_enrichment_count = ? WHERE id = ?`).run(pending, sessionId);
  });
  tx();
  return { sessionId, attachments, pending };
}

// ---------------------------------------------------------------------------
// Planning — may this pass run, and which pass is it
// ---------------------------------------------------------------------------

/**
 * Is a completion pass currently owed on the queue? `enrich-pass.ts` writes
 * exactly one such row when the countdown reaches zero, and `recordPassComplete`
 * marks it done — so a live row after pass 2 means new enrichment resolved.
 */
function completionRowQueued(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM work_queue
        WHERE unit_kind = 'session' AND unit_id = ? AND stage = 'extract'
          AND state IN ('ready', 'running')
        LIMIT 1`,
    )
    .get(sessionId) as { hit: number } | undefined;
  return row !== undefined;
}

export type PassKind = "text_first" | "completion" | "late_reprocess";

export type PassRefusal =
  /** No such session. */
  | "unknown_session"
  /** No attachments: one pass, and it already ran (§8.4 rule 1). */
  | "text_only"
  /** Enrichment outstanding — pass 2 waits for ALL of it (§8.4). */
  | "enrichment_pending"
  /** Two passes, not N. Nothing new is readable, so there is nothing to re-read. */
  | "already_complete"
  /** The ceiling. Enrichment is stored and attached; the episode goes to reconcile. */
  | "reprocess_max";

export interface PassDecision {
  sessionId: string;
  /** True only when a pass should actually be read now. */
  run: boolean;
  /** Which pass this would be — 2 in the normal case. */
  passNumber: number;
  kind: PassKind;
  /** Set when `run` is false. */
  refusal: PassRefusal | null;
  flaggedForReconcile: boolean;
  reason: string;
}

/**
 * The gate every completion pass goes through. Called by the pass-2 runner when
 * it picks the `extract`/`session` row off the queue, and safe to call twice —
 * it reads state, it does not move it.
 *
 * Refusing is the acceptance criterion: "exactly 2 passes per media episode; 0
 * duplicate claims from pass 2". A pass that does not run cannot duplicate.
 */
export function planCompletionPass(sessionId: string): PassDecision {
  const state = passState(sessionId);
  const max = getReprocessMax();
  if (state === null) {
    return {
      sessionId,
      run: false,
      passNumber: 0,
      kind: "completion",
      refusal: "unknown_session",
      flaggedForReconcile: false,
      reason: "no such session",
    };
  }

  // Pass 1 is implied by the episode having been extracted at all: a session
  // that reached the countdown was read as text first. Normalising here means a
  // caller that never recorded pass 1 still cannot get three reads out of us.
  const passesDone = Math.max(1, state.passesDone);
  const passNumber = passesDone + 1;
  const kind: PassKind = passNumber >= 3 ? "late_reprocess" : "completion";
  const base = { sessionId, passNumber, kind, flaggedForReconcile: false as boolean };

  if (state.attachments === 0) {
    return {
      ...base,
      run: false,
      refusal: "text_only",
      reason: "no attachments — text only, exactly one pass",
    };
  }
  if (passesDone >= max) {
    return {
      ...base,
      run: false,
      refusal: "reprocess_max",
      flaggedForReconcile: true,
      reason: `reprocess_max (${max}) reached — enrichment stored, searchable and attached; episode flagged for nightly reconcile`,
    };
  }
  if (state.pending > 0) {
    return {
      ...base,
      run: false,
      refusal: "enrichment_pending",
      reason: `${state.pending} enrichment(s) still reading — pass 2 waits for all of them`,
    };
  }
  // Two passes, not N. Past the completion pass the ONLY thing that buys
  // another read is a completion row that was written after it — which happens
  // only when `lateMediaArrived` cleared the spent one and a newly-arrived
  // attachment drove the countdown back to zero (§8.4 rule 2).
  if (passesDone >= 2 && !completionRowQueued(sessionId)) {
    return {
      ...base,
      run: false,
      refusal: "already_complete",
      reason: "two passes, not N — nothing new became readable since the completion pass",
    };
  }
  return {
    ...base,
    run: true,
    refusal: null,
    reason:
      passNumber === 2
        ? "every enrichment on this episode has resolved — the complete re-read runs once"
        : "media arrived later still — one bounded reprocess",
  };
}

// ---------------------------------------------------------------------------
// Recording — the counter moves exactly once per pass
// ---------------------------------------------------------------------------

/**
 * Pass 1 finished. Idempotent: a re-run of the text-first pass (a replay, a
 * restart) does not spend a pass, because there is only ever one first pass.
 */
export function recordTextFirstPass(sessionId: string): number {
  getDb()
    .prepare(`UPDATE sessions SET reprocess_count = MAX(reprocess_count, 1) WHERE id = ?`)
    .run(sessionId);
  return passState(sessionId)?.passesDone ?? 0;
}

/**
 * A completion (or bounded late) pass finished. The counter moves by one, the ◍
 * marker clears, and the queue row that carried the pass is marked done so the
 * scheduler does not hand it out again.
 */
export function recordPassComplete(sessionId: string): EpisodePassState | null {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sessions
          SET reprocess_count = MAX(reprocess_count, 1) + 1,
              pending_enrichment_count = 0
        WHERE id = ?`,
    ).run(sessionId);
    db.prepare(
      `UPDATE work_queue SET state = 'done'
        WHERE unit_kind = 'session' AND unit_id = ? AND stage = 'extract'`,
    ).run(sessionId);
  });
  tx();
  return passState(sessionId);
}

// ---------------------------------------------------------------------------
// Late media — §8.4 rule 2, bounded
// ---------------------------------------------------------------------------

export interface LateMediaReport {
  sessionId: string;
  /** The countdown was re-armed and one more pass is owed. */
  rearmed: boolean;
  pending: number;
  /** Which pass the re-arm buys. */
  nextPassNumber: number;
  flaggedForReconcile: boolean;
  reason: string;
}

/**
 * Media arrived after the episode was complete — a delayed sync, an extended
 * history range, a re-downloaded attachment. §8.4 rule 2: this is the SAME
 * mechanism as any other late data, bounded at `reprocess_max`.
 *
 * The re-arm counts the events again (so it cannot drift from what is really
 * pending) and clears the spent completion row, so the moment the countdown
 * reaches zero `enqueueCompletionPass` writes a fresh one at the right
 * priority. At the ceiling nothing is re-armed: the enrichment stays stored,
 * searchable and attached, and the episode is flagged for nightly reconcile.
 */
export function lateMediaArrived(sessionId: string): LateMediaReport {
  const before = passState(sessionId);
  const max = getReprocessMax();
  if (before === null) {
    return {
      sessionId,
      rearmed: false,
      pending: 0,
      nextPassNumber: 0,
      flaggedForReconcile: false,
      reason: "no such session",
    };
  }
  const passesDone = Math.max(1, before.passesDone);
  if (passesDone >= max) {
    return {
      sessionId,
      rearmed: false,
      pending: before.pending,
      nextPassNumber: passesDone,
      flaggedForReconcile: true,
      reason: `reprocess_max (${max}) reached — enrichment stored and attached, episode flagged for nightly reconcile`,
    };
  }

  const armed = armEnrichmentCountdown(sessionId);
  if (armed.pending === 0) {
    return {
      sessionId,
      rearmed: false,
      pending: 0,
      nextPassNumber: passesDone + 1,
      flaggedForReconcile: false,
      reason: "nothing is pending — the hash gate makes this update free (§9.6 rule 5)",
    };
  }
  // The spent row is what would otherwise make the next completion a no-op:
  // `enqueueCompletionPass` refuses when a row for this unit already exists.
  getDb()
    .prepare(
      `DELETE FROM work_queue
        WHERE unit_kind = 'session' AND unit_id = ? AND stage = 'extract' AND state = 'done'`,
    )
    .run(sessionId);
  return {
    sessionId,
    rearmed: true,
    pending: armed.pending,
    nextPassNumber: passesDone + 1,
    flaggedForReconcile: false,
    reason: `${armed.pending} newly-arrived attachment(s) — one bounded reprocess owed`,
  };
}

/** Episodes that spent their passes with enrichment still outstanding (§9.6 rule 6). */
export function sessionsFlaggedForReconcile(limit = 100): string[] {
  const max = getReprocessMax();
  return (
    getDb()
      .prepare(
        `SELECT id FROM sessions
          WHERE reprocess_count >= ?
          ORDER BY ended_at DESC
          LIMIT ?`,
      )
      .all(max, Math.max(1, Math.floor(limit))) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Sessions whose completion pass is owed right now, highest priority first —
 * the queue's own order, never insertion order (§9.6 rule 1). A row whose plan
 * refuses is dropped rather than handed out.
 */
export function dueCompletionPasses(limit = 20): PassDecision[] {
  const rows = getDb()
    .prepare(
      `SELECT unit_id AS id FROM work_queue
        WHERE unit_kind = 'session' AND stage = 'extract' AND state = 'ready'
        ORDER BY priority DESC, id
        LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(limit))) as { id: string }[];
  return rows.map((r) => planCompletionPass(r.id)).filter((d) => d.run);
}

// ---------------------------------------------------------------------------
// What pass 2 carries — §8.4 "delta context mode", §12.5's P-CL1D
// ---------------------------------------------------------------------------

export interface CompletionPassContext {
  sessionId: string;
  mode: DeltaContextMode;
  /** Events pass 1 already read. Printed only in `raw_events` mode. */
  priorEvents: PackEvent[];
  /** The ► lines: newly-readable attachments, in their true position. */
  newEvents: PackEvent[];
  /** "Never re-emit an item already listed" — the anti-duplication contract. */
  extracted: Cl1dExtractedItem[];
  /** Real ids behind the aliases, for resolving Z lines. */
  itemIds: Record<string, string>;
}

interface ExtractedRow {
  id: string;
  text: string | null;
  kind: string | null;
}

/**
 * Everything pass 1 already extracted from this episode, as P-CL1D's EXTRACTED
 * block. Claims and loops both, keyed off the evidence rows that point at this
 * session's events — evidence is the only honest link, because a claim can be
 * reinforced from elsewhere and still belong here.
 *
 * Exported for `./cl1-delta.ts`: the live delta pass carries the SAME block
 * (§12.5 "already-extracted ids"), keyed off the same evidence rows, and a
 * second copy of this query is how the two passes would drift on what
 * "already listed" means.
 */
export function extractedItemsFor(eventIds: readonly string[]): { items: Cl1dExtractedItem[]; ids: Record<string, string> } {
  if (eventIds.length === 0) return { items: [], ids: {} };
  const marks = eventIds.map(() => "?").join(",");
  const db = getDb();
  const claims = db
    .prepare(
      `SELECT DISTINCT cv.id AS id, cv.text AS text, cv.kind AS kind
         FROM claim_versions cv
         JOIN evidence ev ON ev.subject_kind = 'claim' AND ev.subject_id = cv.id
        WHERE ev.event_id IN (${marks}) AND cv.closed_by IS NULL
        ORDER BY cv.id`,
    )
    .all(...eventIds) as ExtractedRow[];
  const loops = db
    .prepare(
      `SELECT DISTINCT l.id AS id, l.intent AS text, l.state AS kind
         FROM loops l
         JOIN evidence ev ON ev.subject_kind = 'loop' AND ev.subject_id = l.id
        WHERE ev.event_id IN (${marks})
        ORDER BY l.id`,
    )
    .all(...eventIds) as ExtractedRow[];

  const items: Cl1dExtractedItem[] = [];
  const ids: Record<string, string> = {};
  claims.forEach((row, i) => {
    const alias = `H${i + 1}`;
    ids[alias] = row.id;
    items.push({ alias, id: row.id, text: row.text ?? "" });
  });
  loops.forEach((row, i) => {
    const alias = `T${i + 1}`;
    ids[alias] = row.id;
    items.push({
      alias,
      id: row.id,
      text: row.text ?? "",
      ...(row.kind ? { note: row.kind } : {}),
    });
  });
  return { items, ids };
}

/**
 * The delta call pass 2 makes: the same session, the same neighbours, the same
 * roster (§8.4), with the newly-readable attachments as ► events and everything
 * pass 1 emitted listed so the model never re-emits it.
 *
 * This is where "0 duplicate claims from pass 2" is actually won. The write
 * path absorbs an exact key as a REINFORCE (§11.6) and would catch a repeat
 * anyway — but a repeat that is never emitted costs nothing to absorb.
 *
 * The `episode_summary` pass 1 emitted is NOT stored on `episodes`, so the
 * caller supplies it to `buildCl1dPrompt`; everything else is here.
 */
export function completionPassContext(sessionId: string): CompletionPassContext | null {
  const row = sessionRow(sessionId);
  if (row === null) return null;
  const mode = getDeltaContextMode();
  const rows = attachmentRows(row);
  const fallbackStream = row.stream_id ?? "";

  const priorEvents: PackEvent[] = [];
  const newEvents: PackEvent[] = [];
  for (const r of rows) {
    const state = stateOf(r);
    const packed = toPackEvent(r, state, fallbackStream);
    // A newly-readable attachment is a ► event — read "as if it had always been
    // there, in its true position" (§12.5). An attachment still pending is not
    // new: it is the same placeholder pass 1 already saw.
    if (state === "ready" || state === "failed" || state === "skipped") newEvents.push(packed);
    else priorEvents.push(packed);
  }

  const { items, ids } = extractedItemsFor(rows.map((r) => r.id));
  return { sessionId, mode, priorEvents, newEvents, extracted: items, itemIds: ids };
}
