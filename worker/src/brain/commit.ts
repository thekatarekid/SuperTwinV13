// ===========================================================================
// Tick commit (build P1.3) — the ONE writer for Orient's graded output.
//
// Everything the tick changes lands in a single transaction through this
// module: episodes (join/new + message ranges + chain links), space
// PROPOSALS, unsorted, second_look, the T2 review queue, and a decisions row
// for every derived-object change (build convention 1.4 — reversible, with
// old/new payloads).
//
// PROPOSE-ONLY IS ENFORCED IN CODE HERE: a space born from a pass is written
// with status 'proposed', unconditionally — there is no argument, flag or
// model output that can make this module write an 'active' space. Activation
// is a user approval acting on the proposal, never a pass.
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
import type { DeltaBundle } from "../scheduler/dispatch.js";
import { spaceCreationStatus } from "../consolidation/graduation.js";
import { verdictFor, type CriticOutput } from "./critic.js";
import { resolveEventAliases, type OrientOutput } from "./orient.js";
import type { CommittedEpisode } from "./reduce.js";

export const SECOND_LOOK_MIN = 0.6;
export const SECOND_LOOK_MAX = 0.75;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

/**
 * The propose-only guard: the one status a pass-created space may have.
 * Exported so tests can assert the guard exists; commit uses it for EVERY
 * space insert, making "proposals never activate without approval" a property
 * of the code path, not of prompt behaviour.
 *
 * P4.3: the GRADUATION SWITCH (spec §9.1) is the single sanctioned exception —
 * after the gates hold 14 consecutive days, `spaceCreationStatus()` starts
 * answering "active" and pass-created spaces skip the review queue. Until it
 * flips (and again if the user reverts) this returns "proposed".
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
  /** runs.id of the Orient call, for decision attribution. */
  runId?: string | null;
}

export interface CommitReport {
  committedEpisodes: CommittedEpisode[];
  createdSpaces: string[];
  secondLooks: number;
  unsorted: number;
  rejected: number;
  downgraded: number;
  flagged: number;
  questions: string[];
  decisions: string[];
}

interface EventSpan {
  ids: string[];
  startId: string;
  endId: string;
  startRowid: number | null;
  endRowid: number | null;
  firstTs: string | null;
  lastTs: string | null;
}

function spanOf(ids: string[]): EventSpan | null {
  if (ids.length === 0) return null;
  const db = getDb();
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, rowid, ts FROM events WHERE id IN (${ph}) ORDER BY rowid`)
    .all(...ids) as { id: string; rowid: number; ts: string | null }[];
  if (rows.length === 0) return null;
  return {
    ids: rows.map((r) => r.id),
    startId: rows[0].id,
    endId: rows[rows.length - 1].id,
    startRowid: rows[0].rowid,
    endRowid: rows[rows.length - 1].rowid,
    firstTs: rows[0].ts,
    lastTs: rows[rows.length - 1].ts,
  };
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
 * Returns what committed so the Reduce step can enqueue per-space work.
 */
export function commitTick(input: CommitInput): CommitReport {
  const db = getDb();
  const { bundle, orient, critic, aliases } = input;
  const runId = input.runId ?? null;
  const report: CommitReport = {
    committedEpisodes: [],
    createdSpaces: [],
    secondLooks: 0,
    unsorted: 0,
    rejected: 0,
    downgraded: 0,
    flagged: 0,
    questions: orient.questions,
    decisions: [],
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
  ): void => {
    const exists = db.prepare(`SELECT 1 FROM spaces WHERE id = ?`).get(spaceId);
    if (!exists) return; // a hallucinated space id never becomes a row
    const old = db
      .prepare(`SELECT space_id FROM episodes WHERE id = ?`)
      .get(episodeId) as { space_id: string | null } | undefined;
    db.prepare(`UPDATE episodes SET space_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
      spaceId,
      episodeId,
    );
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
  };

  const flagOverlap = (episodeId: string | null, spaceId: string | null, overlapSpaceId: string | null, reason: string | null): void => {
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
      const verdict = verdictFor(critic, item);
      if (verdict.verdict === "reject") {
        report.rejected++;
        decide("episode", e.episode ?? "(uncommitted)", "reject", {
          new: { action: e.action, summary: e.summary },
          reason: verdict.reason ?? "critic reject",
          confidence: e.confidence,
        });
        continue;
      }
      const span = spanOf(resolveEventAliases(e.events, aliases));
      if (!span) continue; // aliases that resolve to nothing commit nothing

      let episodeId: string;
      if (e.action === "join" && e.episode) {
        const existing = db
          .prepare(`SELECT id, summary, space_id, last_ts FROM episodes WHERE id = ?`)
          .get(e.episode) as
          | { id: string; summary: string | null; space_id: string | null; last_ts: string | null }
          | undefined;
        if (existing) {
          episodeId = existing.id;
          db.prepare(
            `UPDATE episodes SET summary = ?, state = 'open',
                    last_ts = MAX(COALESCE(last_ts, ''), COALESCE(?, '')),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ?`,
          ).run(e.summary, span.lastTs, episodeId);
          decide("episode", episodeId, "join", {
            old: { summary: existing.summary, lastTs: existing.last_ts },
            new: { summary: e.summary, events: span.ids },
            confidence: e.confidence,
          });
        } else {
          // The named episode does not exist — commit the burst as a NEW one
          // rather than losing it (unknown beats wrong, never data loss).
          episodeId = mintId("ep");
          db.prepare(
            `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts, confidence, created_by)
             VALUES (?, ?, 'open', ?, ?, ?, ?, 'orient')`,
          ).run(episodeId, bundle.streamId, e.summary, span.firstTs, span.lastTs, e.confidence);
          decide("episode", episodeId, "create", {
            new: { summary: e.summary, events: span.ids },
            reason: `join target ${e.episode} not found`,
            confidence: e.confidence,
          });
        }
      } else {
        episodeId = mintId("ep");
        const chainPrev =
          e.chain_prev && db.prepare(`SELECT 1 FROM episodes WHERE id = ?`).get(e.chain_prev)
            ? e.chain_prev
            : null;
        db.prepare(
          `INSERT INTO episodes (id, stream_id, state, summary, chain_prev_id, first_ts, last_ts, confidence, created_by)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 'orient')`,
        ).run(episodeId, bundle.streamId, e.summary, chainPrev, span.firstTs, span.lastTs, e.confidence);
        decide("episode", episodeId, "create", {
          new: { summary: e.summary, events: span.ids, chainPrev },
          confidence: e.confidence,
        });
      }

      db.prepare(
        `INSERT OR IGNORE INTO episode_events
           (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid, added_by)
         VALUES (?, ?, ?, ?, ?, ?, 'orient')`,
      ).run(mintId("ee"), episodeId, span.startId, span.endId, span.startRowid, span.endRowid);

      if (verdict.verdict === "downgrade_to_unsorted") {
        report.downgraded++;
        insertUnsorted(episodeId, verdict.reason ?? "critic downgrade", e.confidence);
        report.committedEpisodes.push({ episodeId, spaceId: null, streamId: bundle.streamId });
        continue;
      }

      // Attach policy: <0.6 never attaches (spec §8 conventions).
      let attachedSpace: string | null = null;
      if (e.space && e.confidence >= SECOND_LOOK_MIN) {
        attachEpisode(episodeId, e.space, e.confidence, null);
        attachedSpace = e.space;
      } else if (e.space) {
        insertUnsorted(episodeId, `attach to ${e.space} below 0.6`, e.confidence);
      }
      if (verdict.verdict === "flag_overlap") {
        flagOverlap(episodeId, attachedSpace, verdict.space_id ?? null, verdict.reason ?? null);
      }
      report.committedEpisodes.push({
        episodeId,
        spaceId: attachedSpace,
        streamId: bundle.streamId,
      });
    }

    // ---- Space proposals — always born 'proposed' (propose-only) ---------
    for (const p of orient.proposals) {
      item++;
      const verdict = verdictFor(critic, item);
      if (verdict.verdict === "reject") {
        report.rejected++;
        decide("space", "(unproposed)", "reject", {
          new: { label: p.label },
          reason: verdict.reason ?? "critic reject",
          confidence: p.confidence,
        });
        continue;
      }
      const span = spanOf(resolveEventAliases(p.episode_events, aliases));

      if (verdict.verdict === "downgrade_to_unsorted") {
        report.downgraded++;
        if (span) {
          const episodeId = mintId("ep");
          db.prepare(
            `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts, confidence, created_by)
             VALUES (?, ?, 'open', ?, ?, ?, ?, 'orient')`,
          ).run(episodeId, bundle.streamId, p.summary, span.firstTs, span.lastTs, p.confidence);
          db.prepare(
            `INSERT OR IGNORE INTO episode_events
               (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid, added_by)
             VALUES (?, ?, ?, ?, ?, ?, 'orient')`,
          ).run(mintId("ee"), episodeId, span.startId, span.endId, span.startRowid, span.endRowid);
          decide("episode", episodeId, "create", { new: { summary: p.summary }, confidence: p.confidence });
          insertUnsorted(episodeId, verdict.reason ?? "critic downgrade", p.confidence);
          report.committedEpisodes.push({ episodeId, spaceId: null, streamId: bundle.streamId });
        }
        continue;
      }

      const spaceId = mintId("sp");
      // Propose-only until the graduation switch flips (spec §9.1): the
      // status a pass may write comes from ONE guard, never from the model.
      const bornStatus = proposedStatus();
      db.prepare(
        `INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, created_by, confidence,
                             updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'orient', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).run(
        spaceId,
        p.label,
        p.life_area ?? null,
        p.goal ?? null,
        bornStatus,
        JSON.stringify([p.summary]),
        p.confidence,
      );
      report.createdSpaces.push(spaceId);
      decide("space", spaceId, bornStatus === "active" ? "create" : "propose", {
        new: { label: p.label, goal: p.goal ?? null, lifeArea: p.life_area ?? null },
        confidence: p.confidence,
      });

      if (span) {
        const episodeId = mintId("ep");
        db.prepare(
          `INSERT INTO episodes (id, stream_id, space_id, state, summary, first_ts, last_ts, confidence, created_by)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 'orient')`,
        ).run(episodeId, bundle.streamId, spaceId, p.summary, span.firstTs, span.lastTs, p.confidence);
        db.prepare(
          `INSERT OR IGNORE INTO episode_events
             (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid, added_by)
           VALUES (?, ?, ?, ?, ?, ?, 'orient')`,
        ).run(mintId("ee"), episodeId, span.startId, span.endId, span.startRowid, span.endRowid);
        decide("episode", episodeId, "create", {
          new: { summary: p.summary, spaceId },
          confidence: p.confidence,
        });
        seedSpaceIndex(spaceId, span.ids);
        report.committedEpisodes.push({ episodeId, spaceId, streamId: bundle.streamId });
      }
      if (verdict.verdict === "flag_overlap") {
        flagOverlap(null, spaceId, verdict.space_id ?? null, verdict.reason ?? null);
      }
    }

    // ---- Unsorted, straight from Orient (a good answer) ------------------
    for (const u of orient.unsorted) {
      const span = spanOf(resolveEventAliases(u.events, aliases));
      if (!span) continue;
      const episodeId = mintId("ep");
      db.prepare(
        `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts, confidence, created_by)
         VALUES (?, ?, 'open', ?, ?, ?, ?, 'orient')`,
      ).run(episodeId, bundle.streamId, u.summary || "(unsorted)", span.firstTs, span.lastTs, u.confidence);
      db.prepare(
        `INSERT OR IGNORE INTO episode_events
           (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid, added_by)
         VALUES (?, ?, ?, ?, ?, ?, 'orient')`,
      ).run(mintId("ee"), episodeId, span.startId, span.endId, span.startRowid, span.endRowid);
      decide("episode", episodeId, "create", { new: { summary: u.summary }, confidence: u.confidence });
      insertUnsorted(episodeId, u.reason ?? "no space matched", u.confidence);
      report.committedEpisodes.push({ episodeId, spaceId: null, streamId: bundle.streamId });
    }
  });
  run();
  return report;
}
