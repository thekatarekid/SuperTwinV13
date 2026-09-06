// ===========================================================================
// Tick commit (build P1.3, rewritten V6 P1 S3.1) — the ONE writer for the
// graded understanding output.
//
// Everything the tick changes lands in a single transaction through this
// module: episodes (join/new + EXPLICIT membership rows + chain links), space
// proposals, unsorted, second_look, the T2 review queue, and a decisions row
// for every derived-object change (build convention 1.4 — reversible, with
// old/new payloads).
//
// Commit rules (Product_V6_Phase1 §9, build §6.1):
//
//   1. Membership is explicit rows. `episode_events` gets one row per cited
//      event (`event_id` set, range of one) — never a rowid range. The rows
//      equal the item's resolved aliases exactly (CMT-01).
//   2. One stream per episode. `episodes.stream_id` is DERIVED from the
//      resolved events, never copied from the bundle. The model tags the
//      section ("stream":"S1"); code enforces: events spanning two streams,
//      or a tag that names another section, reject the item (CMT-02).
//   3. Per-item salvage. Valid items commit; an invalid item rejects alone
//      and its events are HELD (not stamped) for the next tick. The cursor
//      advances on event ids, past committed items only (CMT-03).
//   4. Evidence must resolve to real ids with verbatim quotes. A quote that is
//      not in the cited event's text rejects the item — never a downgrade
//      (CMT-04).
//   5. Coverage. Every alias lands in exactly one of episodes/unsorted; a miss
//      or a double placement is flagged mechanically (CMT-05). An uncovered
//      event is stamped anyway — the model saw it and said nothing; re-asking
//      is the infinite-retry shape T2-7 kills.
//
// PROPOSE-ONLY IS ENFORCED IN CODE HERE: a space born from a pass is written
// with the status `proposedStatus()` returns, unconditionally — no model
// output can make this module write an 'active' space under propose-only.
//
// Confidence policy (spec §8 conventions, §9.5):
//   attach conf < 0.60  → the attach is dropped (the episode still commits,
//                         spaceless, and is recorded unsorted)
//   0.60 ≤ conf < 0.75  → attach + a second_look row (T2 re-verifies)
//   flag_overlap        → commits AND queues a Tier-2 review immediately
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { addEpisodeEvents } from "../db/v6core.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { spaceCreationStatus } from "../consolidation/graduation.js";
import { verdictFor, type CriticOutput } from "./critic.js";
import { findBirthDuplicate, resolveCriticOverlap } from "./space-birth.js";
import { resolveEventAliases, type OrientEvidence, type OrientOutput } from "./orient.js";
import type { CommittedEpisode } from "./reduce.js";

export const SECOND_LOOK_MIN = 0.6;
export const SECOND_LOOK_MAX = 0.75;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

/**
 * The one status a pass-created space may have. Exported so tests can assert
 * the guard exists; commit uses it for EVERY space insert, so the born-status
 * is a property of the code path, never of prompt behaviour.
 *
 * It answers "active" by default — spaces auto-create, and a wrong one is a
 * reversible decision — and "proposed" (straight to the review queue) only
 * while the user has propose-only turned on in Settings › General. The mode
 * lives in `consolidation/graduation.ts`; no model sees or sets it.
 */
export function proposedStatus(): "proposed" | "active" {
  return spaceCreationStatus();
}

export interface CommitInput {
  bundle: DeltaBundle;
  orient: OrientOutput;
  critic: CriticOutput;
  /** Alias table from the pack (e1.. → event ids). */
  aliases: ReadonlyMap<string, string>;
  /**
   * Section tags from the pack (`S1` → streams.id). When present, an item's
   * `"stream"` tag must name the section its events came from. Absent until
   * the packer renders `[STREAM S<k>]` sections (S3.2) — the events alone
   * decide then.
   */
  streamAliases?: ReadonlyMap<string, string>;
  /** runs.id of the Orient call, for decision attribution. */
  runId?: string | null;
}

/** Why an item did not commit. `critic` is the model's verdict; the rest are code. */
export type RejectReason =
  | "critic"
  | "no_events"
  | "already_placed"
  | "multi_stream"
  | "stream_tag_mismatch"
  | "join_stream_mismatch"
  | "no_evidence"
  | "evidence_unresolved"
  | "evidence_not_verbatim";

export interface CommitRejection {
  /** Critic item number (episodes then proposals); null for unsorted entries. */
  item: number | null;
  kind: "episode" | "proposal" | "unsorted";
  reason: RejectReason;
  detail: string;
  /** Resolved event ids the item named (held for the next tick unless committed elsewhere). */
  eventIds: string[];
}

export interface CommitCoverage {
  /** Bundle aliases no item placed. Flagged, still stamped. */
  uncovered: string[];
  /** Aliases named by more than one item — the first placement won. */
  duplicated: string[];
}

export interface CommitReport {
  committedEpisodes: CommittedEpisode[];
  createdSpaces: string[];
  secondLooks: number;
  unsorted: number;
  rejected: number;
  downgraded: number;
  flagged: number;
  /** Proposals filed into an existing space instead of being born (S3.7 dedupe). */
  dedupedBirths: number;
  questions: string[];
  decisions: string[];
  rejections: CommitRejection[];
  coverage: CommitCoverage;
  /**
   * Bundle events the tick handled — members of committed items plus the
   * uncovered ones. Safe to stamp dispatched.
   */
  handledEventIds: string[];
  /**
   * Bundle events of rejected items that landed nowhere. NOT stamped: the
   * next tick re-collects them (per-item salvage, T2-7).
   */
  heldEventIds: string[];
}

// ---------------------------------------------------------------------------
// Event rows
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  rowid: number;
  ts: string | null;
  stream_id: string | null;
  text: string | null;
}

/** Whitespace-collapsed, NFC, outer quotation marks off — still verbatim. */
function normalizeQuote(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim();
}

function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ");
}

/** Seed the space_index lanes from the founding events (bridge keys). */
function seedSpaceIndex(spaceId: string, eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const db = getDb();
  const ph = eventIds.map(() => "?").join(",");
  db.prepare(
    `INSERT OR IGNORE INTO space_bridge_keys (space_id, kind, value_norm)
     SELECT ?, kind, value_norm FROM event_bridge_keys WHERE event_id IN (${ph})`,
  ).run(spaceId, ...eventIds);
}

/**
 * Apply the graded tick — one transaction, decisions rows throughout.
 * Returns what committed so the Reduce step can enqueue per-space work, and
 * which bundle events were handled vs held so the consumer can advance the
 * cursor on event ids.
 */
export function commitTick(input: CommitInput): CommitReport {
  const db = getDb();
  const { bundle, orient, critic, aliases } = input;
  const streamAliases = input.streamAliases;
  const runId = input.runId ?? null;
  const report: CommitReport = {
    committedEpisodes: [],
    createdSpaces: [],
    secondLooks: 0,
    unsorted: 0,
    rejected: 0,
    downgraded: 0,
    flagged: 0,
    dedupedBirths: 0,
    questions: orient.questions,
    decisions: [],
    rejections: [],
    coverage: { uncovered: [], duplicated: [] },
    handledEventIds: [],
    heldEventIds: [],
  };

  // ---- Event lookups (by id, cached for the tick) --------------------------
  const rowStmt = db.prepare(
    `SELECT id, rowid, ts, stream_id, text FROM events WHERE id = ?`,
  );
  const rowCache = new Map<string, EventRow | null>();
  const eventRow = (id: string): EventRow | null => {
    let r = rowCache.get(id);
    if (r === undefined) {
      r = (rowStmt.get(id) as EventRow | undefined) ?? null;
      rowCache.set(id, r);
    }
    return r;
  };
  /** Alias tokens → real event rows, log order. Unknown tokens drop. */
  const resolveRows = (tokens: readonly string[]): EventRow[] => {
    const rows: EventRow[] = [];
    for (const id of resolveEventAliases(tokens, aliases)) {
      const r = eventRow(id);
      if (r) rows.push(r);
    }
    return rows.sort((a, b) => a.rowid - b.rowid);
  };
  /** Evidence ids: an alias, else a raw event id that exists. */
  const resolveEvidenceIds = (tokens: readonly string[]): string[] => {
    const out: string[] = [];
    for (const t of tokens) {
      const [viaAlias] = resolveEventAliases([t], aliases);
      const id = viaAlias ?? (eventRow(t.trim()) ? t.trim() : null);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const streamOfRow = (r: EventRow): string => r.stream_id ?? bundle.streamId;

  // ---- Placement bookkeeping (coverage, dedupe, held/handled) --------------
  const placed = new Set<string>(); // committed members this tick
  const mentioned = new Set<string>(); // every event any item named
  const duplicated = new Set<string>();
  const heldCandidates = new Set<string>();
  const aliasOf = new Map<string, string>();
  for (const [a, id] of aliases) if (!aliasOf.has(id)) aliasOf.set(id, a);
  const aliasesFor = (ids: readonly string[]): string[] => ids.map((id) => aliasOf.get(id) ?? id);

  /** Drop events an earlier item already committed; remember the overlap. */
  const fresh = (rows: EventRow[]): EventRow[] => {
    const out: EventRow[] = [];
    for (const r of rows) {
      mentioned.add(r.id);
      if (placed.has(r.id)) duplicated.add(r.id);
      else out.push(r);
    }
    return out;
  };

  const decide = (
    targetKind: string,
    targetId: string,
    action: string,
    fields: { old?: unknown; new?: unknown; reason?: string | null; confidence?: number | null },
  ): void => {
    report.decisions.push(
      writeDecision({
        runId,
        pass: "orient",
        targetKind,
        targetId,
        action,
        ...fields,
      }),
    );
  };

  const reject = (
    rej: Omit<CommitRejection, "eventIds"> & { eventIds: readonly string[] },
    decision: { targetKind: string; targetId: string; payload: unknown; confidence?: number },
  ): void => {
    report.rejected++;
    report.rejections.push({ ...rej, eventIds: [...rej.eventIds] });
    for (const id of rej.eventIds) heldCandidates.add(id);
    decide(decision.targetKind, decision.targetId, "reject", {
      new: decision.payload,
      reason: `${rej.reason}: ${rej.detail}`,
      confidence: decision.confidence ?? null,
    });
  };

  // ---- Code validation shared by episodes and proposals --------------------

  /** Rule 2: one stream, matching the tag when the pack rendered sections. */
  const singleStream = (
    rows: EventRow[],
    tag: string | undefined,
  ): { ok: true; streamId: string } | { ok: false; reason: RejectReason; detail: string } => {
    const streams = [...new Set(rows.map(streamOfRow))];
    if (streams.length > 1) {
      return {
        ok: false,
        reason: "multi_stream",
        detail: `events span ${streams.length} streams (${streams.join(", ")})`,
      };
    }
    const streamId = streams[0];
    if (tag && streamAliases) {
      const tagged = streamAliases.get(tag.trim().toUpperCase());
      if (!tagged) {
        return { ok: false, reason: "stream_tag_mismatch", detail: `tag ${tag} names no section` };
      }
      if (tagged !== streamId) {
        return {
          ok: false,
          reason: "stream_tag_mismatch",
          detail: `tag ${tag} is ${tagged}, events are ${streamId}`,
        };
      }
    }
    return { ok: true, streamId };
  };

  /** Rule 4: every evidence entry resolves and quotes verbatim. */
  const evidenceOk = (
    evidence: readonly OrientEvidence[],
  ): { ok: true } | { ok: false; reason: RejectReason; detail: string } => {
    if (evidence.length === 0) {
      return { ok: false, reason: "no_evidence", detail: "no evidence entries" };
    }
    for (const ev of evidence) {
      const ids = resolveEvidenceIds(ev.event_ids);
      if (ids.length === 0) {
        return {
          ok: false,
          reason: "evidence_unresolved",
          detail: `event_ids ${JSON.stringify(ev.event_ids)} resolve to nothing`,
        };
      }
      const q = normalizeQuote(ev.quote);
      if (!q) {
        return { ok: false, reason: "evidence_not_verbatim", detail: "empty quote" };
      }
      const hit = ids.some((id) => normalizeText(eventRow(id)?.text ?? "").includes(q));
      if (!hit) {
        return {
          ok: false,
          reason: "evidence_not_verbatim",
          detail: `"${ev.quote}" is not in ${aliasesFor(ids).join(",")}`,
        };
      }
    }
    return { ok: true };
  };

  // ---- Writers --------------------------------------------------------------

  const spanTs = (rows: EventRow[]): { first: string | null; last: string | null } => {
    const ts = rows.map((r) => r.ts).filter((t): t is string => typeof t === "string").sort();
    return { first: ts[0] ?? null, last: ts[ts.length - 1] ?? null };
  };

  const insertEpisode = (p: {
    summary: string;
    streamId: string;
    rows: EventRow[];
    confidence: number;
    spaceId?: string | null;
    chainPrev?: string | null;
  }): string => {
    const episodeId = mintId("ep");
    const { first, last } = spanTs(p.rows);
    db.prepare(
      `INSERT INTO episodes (id, stream_id, space_id, state, summary, chain_prev_id, first_ts, last_ts, confidence, created_by)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, 'orient')`,
    ).run(
      episodeId,
      p.streamId,
      p.spaceId ?? null,
      p.summary,
      p.chainPrev ?? null,
      first,
      last,
      p.confidence,
    );
    addMembers(episodeId, p.rows);
    return episodeId;
  };

  const addMembers = (episodeId: string, rows: EventRow[]): void => {
    addEpisodeEvents(
      episodeId,
      rows.map((r) => r.id),
      "orient",
    );
    for (const r of rows) placed.add(r.id);
  };

  const insertUnsorted = (episodeId: string, reason: string, confidence: number): void => {
    const id = mintId("uns");
    db.prepare(
      `INSERT OR IGNORE INTO unsorted (id, episode_id, reason, confidence) VALUES (?, ?, ?, ?)`,
    ).run(id, episodeId, reason, confidence);
    report.unsorted++;
    decide("unsorted", id, "create", { new: { episodeId, reason }, confidence });
  };

  const attachEpisode = (
    episodeId: string,
    spaceId: string,
    confidence: number,
    reason: string | null,
  ): boolean => {
    const exists = db.prepare(`SELECT 1 FROM spaces WHERE id = ?`).get(spaceId);
    if (!exists) return false; // a hallucinated space id never becomes a row
    const old = db
      .prepare(`SELECT space_id FROM episodes WHERE id = ?`)
      .get(episodeId) as { space_id: string | null } | undefined;
    db.prepare(
      `UPDATE episodes SET space_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(spaceId, episodeId);
    db.prepare(
      `UPDATE spaces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(spaceId);
    decide("episode", episodeId, "attach", {
      old: { spaceId: old?.space_id ?? null },
      new: { spaceId },
      reason,
      confidence,
    });
    if (confidence >= SECOND_LOOK_MIN && confidence < SECOND_LOOK_MAX) {
      db.prepare(
        `INSERT OR IGNORE INTO second_look (id, episode_id, space_id, attach_confidence)
         VALUES (?, ?, ?, ?)`,
      ).run(mintId("sl"), episodeId, spaceId, confidence);
      report.secondLooks++;
    }
    return true;
  };

  const flagOverlap = (
    episodeId: string | null,
    spaceId: string | null,
    overlapSpaceId: string | null,
    reason: string | null,
  ): void => {
    db.prepare(
      `INSERT INTO t2_review_queue (id, kind, episode_id, space_id, overlap_space_id, reason)
       VALUES (?, 'flag_overlap', ?, ?, ?, ?)`,
    ).run(mintId("t2"), episodeId, spaceId, overlapSpaceId, reason);
    report.flagged++;
  };

  const run = db.transaction(() => {
    let item = 0;

    // ---- Episodes (join/new), in Orient's order --------------------------
    for (const e of orient.episodes) {
      item++;
      const named = resolveRows(e.events);
      const rows = fresh(named);
      const payload = { action: e.action, summary: e.summary, events: e.events };
      const target = e.episode ?? "(uncommitted)";
      const fail = (reason: RejectReason, detail: string): void =>
        reject(
          { item, kind: "episode", reason, detail, eventIds: rows.map((r) => r.id) },
          { targetKind: "episode", targetId: target, payload, confidence: e.confidence },
        );

      if (named.length === 0) {
        fail("no_events", `events ${JSON.stringify(e.events)} resolve to nothing`);
        continue;
      }
      if (rows.length === 0) {
        fail("already_placed", "every event was committed by an earlier item");
        continue;
      }
      const stream = singleStream(rows, e.stream);
      if (!stream.ok) {
        fail(stream.reason, stream.detail);
        continue;
      }
      const ev = evidenceOk(e.evidence);
      if (!ev.ok) {
        fail(ev.reason, ev.detail);
        continue;
      }
      const verdict = verdictFor(critic, item);
      if (verdict.verdict === "reject") {
        fail("critic", verdict.reason ?? "critic reject");
        continue;
      }

      let episodeId: string;
      if (e.action === "join" && e.episode) {
        const existing = db
          .prepare(`SELECT id, summary, space_id, stream_id, last_ts FROM episodes WHERE id = ?`)
          .get(e.episode) as
          | {
              id: string;
              summary: string | null;
              space_id: string | null;
              stream_id: string | null;
              last_ts: string | null;
            }
          | undefined;
        if (existing) {
          if (existing.stream_id && existing.stream_id !== stream.streamId) {
            fail(
              "join_stream_mismatch",
              `episode ${existing.id} is on ${existing.stream_id}, events are on ${stream.streamId}`,
            );
            continue;
          }
          episodeId = existing.id;
          const { last } = spanTs(rows);
          db.prepare(
            `UPDATE episodes SET summary = ?, state = 'open',
                    stream_id = COALESCE(stream_id, ?),
                    last_ts = MAX(COALESCE(last_ts, ''), COALESCE(?, '')),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ?`,
          ).run(e.summary, stream.streamId, last, episodeId);
          addMembers(episodeId, rows);
          decide("episode", episodeId, "join", {
            old: { summary: existing.summary, lastTs: existing.last_ts },
            new: { summary: e.summary, events: rows.map((r) => r.id) },
            confidence: e.confidence,
          });
        } else {
          // The named episode does not exist — commit the burst as a NEW one
          // rather than losing it (unknown beats wrong, never data loss).
          episodeId = insertEpisode({
            summary: e.summary,
            streamId: stream.streamId,
            rows,
            confidence: e.confidence,
          });
          decide("episode", episodeId, "create", {
            new: { summary: e.summary, events: rows.map((r) => r.id) },
            reason: `join target ${e.episode} not found`,
            confidence: e.confidence,
          });
        }
      } else {
        const chainPrev =
          e.chain_prev && db.prepare(`SELECT 1 FROM episodes WHERE id = ?`).get(e.chain_prev)
            ? e.chain_prev
            : null;
        episodeId = insertEpisode({
          summary: e.summary,
          streamId: stream.streamId,
          rows,
          confidence: e.confidence,
          chainPrev,
        });
        decide("episode", episodeId, "create", {
          new: { summary: e.summary, events: rows.map((r) => r.id), chainPrev },
          confidence: e.confidence,
        });
      }

      if (verdict.verdict === "downgrade_to_unsorted") {
        report.downgraded++;
        insertUnsorted(episodeId, verdict.reason ?? "critic downgrade", e.confidence);
        report.committedEpisodes.push({ episodeId, spaceId: null, streamId: stream.streamId });
        continue;
      }

      // Attach policy: <0.6 never attaches (spec §8 conventions).
      let attachedSpace: string | null = null;
      if (e.space && e.confidence >= SECOND_LOOK_MIN) {
        if (attachEpisode(episodeId, e.space, e.confidence, null)) attachedSpace = e.space;
        else insertUnsorted(episodeId, `space ${e.space} does not exist`, e.confidence);
      } else if (e.space) {
        insertUnsorted(episodeId, `attach to ${e.space} below 0.6`, e.confidence);
      }
      if (verdict.verdict === "flag_overlap") {
        flagOverlap(episodeId, attachedSpace, verdict.space_id ?? null, verdict.reason ?? null);
      }
      report.committedEpisodes.push({
        episodeId,
        spaceId: attachedSpace,
        streamId: stream.streamId,
      });
    }

    // ---- New spaces — born active, or 'proposed' under propose-only ------
    for (const p of orient.proposals) {
      item++;
      const named = resolveRows(p.episode_events);
      const rows = fresh(named);
      const payload = { label: p.label, summary: p.summary, events: p.episode_events };
      const fail = (reason: RejectReason, detail: string): void =>
        reject(
          { item, kind: "proposal", reason, detail, eventIds: rows.map((r) => r.id) },
          { targetKind: "space", targetId: "(unproposed)", payload, confidence: p.confidence },
        );

      // A proposal is a write about the founding events: it needs them, on
      // one stream, with evidence — the same bar as an episode.
      if (named.length === 0) {
        fail("no_events", `episode_events ${JSON.stringify(p.episode_events)} resolve to nothing`);
        continue;
      }
      if (rows.length === 0) {
        fail("already_placed", "every founding event was committed by an earlier item");
        continue;
      }
      const stream = singleStream(rows, p.stream);
      if (!stream.ok) {
        fail(stream.reason, stream.detail);
        continue;
      }
      const ev = evidenceOk(p.evidence);
      if (!ev.ok) {
        fail(ev.reason, ev.detail);
        continue;
      }
      const verdict = verdictFor(critic, item);
      if (verdict.verdict === "reject") {
        fail("critic", verdict.reason ?? "critic reject");
        continue;
      }

      if (verdict.verdict === "downgrade_to_unsorted") {
        report.downgraded++;
        const episodeId = insertEpisode({
          summary: p.summary,
          streamId: stream.streamId,
          rows,
          confidence: p.confidence,
        });
        decide("episode", episodeId, "create", {
          new: { summary: p.summary, events: rows.map((r) => r.id) },
          confidence: p.confidence,
        });
        insertUnsorted(episodeId, verdict.reason ?? "critic downgrade", p.confidence);
        report.committedEpisodes.push({ episodeId, spaceId: null, streamId: stream.streamId });
        continue;
      }

      // ---- Space-birth dedupe (S3.7, Product §13.3): via the critic's
      // flag_overlap (it names the space this proposal duplicates), backed by
      // the code-side label match. A duplicate files INTO the existing space;
      // no second space is born. Applies to every birth path.
      const dup =
        (verdict.verdict === "flag_overlap" ? resolveCriticOverlap(verdict.space_id) : null) ??
        findBirthDuplicate(p.label, p.goal ?? null);
      if (dup) {
        const episodeId = insertEpisode({
          summary: p.summary,
          streamId: stream.streamId,
          rows,
          confidence: p.confidence,
        });
        decide("episode", episodeId, "create", {
          new: { summary: p.summary, events: rows.map((r) => r.id) },
          confidence: p.confidence,
        });
        attachEpisode(episodeId, dup.spaceId, p.confidence, `space birth deduped into ${dup.spaceId} (${dup.via})`);
        decide("space", dup.spaceId, "dedupe_birth", {
          new: { proposedLabel: p.label, goal: p.goal ?? null, via: dup.via, score: dup.score },
          reason: verdict.reason ?? `duplicate of "${dup.label}"`,
          confidence: p.confidence,
        });
        report.dedupedBirths++;
        report.committedEpisodes.push({ episodeId, spaceId: dup.spaceId, streamId: stream.streamId });
        continue;
      }

      const spaceId = mintId("sp");
      // The status a pass may write comes from ONE guard, never from the
      // model: "active" by default, "proposed" under propose-only.
      const bornStatus = proposedStatus();
      // S5.1: an inferred birth remembers how it was born and the evidence
      // that justified it (the founding quotes) — the proposal card and the
      // space view's "why?" read them back.
      db.prepare(
        `INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, created_by, confidence,
                             born_via, birth_evidence_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'orient', ?, 'inferred', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).run(
        spaceId,
        p.label,
        p.life_area ?? null,
        p.goal ?? null,
        bornStatus,
        JSON.stringify([p.summary]),
        p.confidence,
        JSON.stringify(
          p.evidence.map((e) => ({ quote: e.quote, event_ids: e.event_ids.map((a) => resolveRows([a])[0]?.id ?? a) })),
        ),
      );
      report.createdSpaces.push(spaceId);
      decide("space", spaceId, bornStatus === "active" ? "create" : "propose", {
        new: { label: p.label, goal: p.goal ?? null, lifeArea: p.life_area ?? null },
        confidence: p.confidence,
      });

      const episodeId = insertEpisode({
        summary: p.summary,
        streamId: stream.streamId,
        rows,
        confidence: p.confidence,
        spaceId,
      });
      decide("episode", episodeId, "create", {
        new: { summary: p.summary, events: rows.map((r) => r.id), spaceId },
        confidence: p.confidence,
      });
      seedSpaceIndex(
        spaceId,
        rows.map((r) => r.id),
      );
      report.committedEpisodes.push({ episodeId, spaceId, streamId: stream.streamId });
      if (verdict.verdict === "flag_overlap") {
        flagOverlap(null, spaceId, verdict.space_id ?? null, verdict.reason ?? null);
      }
    }

    // ---- Unsorted, straight from Orient (a good answer) ------------------
    // No evidence bar (nothing is claimed) and a mechanical repair for the
    // one malformation that has an obvious fix: events from two streams
    // become one unsorted episode per stream.
    orient.unsorted.forEach((u, i) => {
      const named = resolveRows(u.events);
      const rows = fresh(named);
      if (named.length === 0) {
        reject(
          {
            item: null,
            kind: "unsorted",
            reason: "no_events",
            detail: `events ${JSON.stringify(u.events)} resolve to nothing`,
            eventIds: [],
          },
          { targetKind: "unsorted", targetId: `(unsorted ${i + 1})`, payload: { summary: u.summary } },
        );
        return;
      }
      if (rows.length === 0) return; // fully covered by earlier items — coverage records the overlap
      const byStream = new Map<string, EventRow[]>();
      for (const r of rows) {
        const k = streamOfRow(r);
        const list = byStream.get(k);
        if (list) list.push(r);
        else byStream.set(k, [r]);
      }
      for (const [streamId, group] of byStream) {
        const episodeId = insertEpisode({
          summary: u.summary || "(unsorted)",
          streamId,
          rows: group,
          confidence: u.confidence,
        });
        decide("episode", episodeId, "create", {
          new: { summary: u.summary, events: group.map((r) => r.id) },
          confidence: u.confidence,
        });
        insertUnsorted(episodeId, u.reason ?? "no space matched", u.confidence);
        report.committedEpisodes.push({ episodeId, spaceId: null, streamId });
      }
    });

    // ---- Coverage (rule 5) + the held/handled split ------------------------
    const bundleIds = bundle.events.map((e) => e.id);
    const uncovered = bundleIds.filter((id) => !mentioned.has(id));
    report.coverage = {
      uncovered: aliasesFor(uncovered),
      duplicated: aliasesFor([...duplicated]),
    };
    const held = [...heldCandidates].filter((id) => !placed.has(id));
    const heldSet = new Set(held);
    report.heldEventIds = bundleIds.filter((id) => heldSet.has(id));
    report.handledEventIds = bundleIds.filter((id) => !heldSet.has(id));
    if (uncovered.length > 0 || duplicated.size > 0) {
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (const e of bundle.events) {
        if (e.rowid < min) min = e.rowid;
        if (e.rowid > max) max = e.rowid;
      }
      decide("bundle", `${bundle.streamId}:${Number.isFinite(min) ? min : 0}-${max}`, "coverage_flag", {
        new: report.coverage,
        reason:
          `${uncovered.length} alias(es) placed nowhere, ` +
          `${duplicated.size} placed twice — flagged mechanically (Product P1 §9.3)`,
      });
    }
  });
  run();
  return report;
}
