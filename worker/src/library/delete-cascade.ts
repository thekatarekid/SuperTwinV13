// ===========================================================================
// [CODE] Honest cascading delete (build P2.4, spec §14.3.2, §14.9.8).
//
// "Delete a span" in the Library means the events AND everything derived from
// them are gone — not hidden, not soft-flagged. This is the single-writer
// hard-delete path; the hard gate is: after it runs, NO derived row anywhere
// references a deleted event id.
//
// Reversible-aware, explicitly: every other write in this codebase is
// reversible via its decision row's old_json. A privacy delete is the ONE
// deliberate exception — keeping the deleted content inside a decision row
// would be a lie. So the path writes exactly one tombstone decision whose
// old_json holds COUNTS, never content, and whose action name
// ("privacy_delete") marks it non-undoable to the corrections pipeline.
//
// What cascades, and how:
//   FK ON DELETE CASCADE (fires on the events DELETE itself):
//     episode_events · evidence · mentions · event_bridge_keys ·
//     event_embeddings · events_fts (delete triggers)
//   Cleaned here, because the link is JSON or has no FK:
//     episodes left with zero remaining ranges (unsorted/second_look/
//       decide_queue/t2_review_queue rows follow them) ·
//     claim_versions evidence (strip refs; delete when empty; claims header
//       recomputed, header deleted at zero versions) ·
//     tasks evidence (strip; delete when fully derived from deleted events) ·
//     enrichment_bundles member lists · content_digests whose hash no longer
//       has a surviving event · context_escalations · assist_topics
//       accumulator tails · decisions targeting the deleted objects.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";

export interface CascadeReport {
  events_deleted: number;
  episodes_deleted: number;
  claim_versions_deleted: number;
  claim_versions_stripped: number;
  claims_deleted: number;
  tasks_deleted: number;
  tasks_stripped: number;
  bundles_deleted: number;
  bundles_stripped: number;
  digests_deleted: number;
  escalations_deleted: number;
  decisions_deleted: number;
  /** The tombstone decision recording the delete (counts only, no content). */
  decision_id: string | null;
}

interface EvidenceEntry {
  event_ids?: unknown;
  [k: string]: unknown;
}

/**
 * Strip doomed event ids from one evidence_json / event_ids_json-style value.
 * Returns the surviving JSON, or null when nothing survives (delete the row).
 * Unparseable JSON is treated as fully doomed only if it mentions a doomed id.
 */
function stripEvidence(json: string, doomed: Set<string>): { kept: string | null; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kept: null, changed: true };
  }
  if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
    // Plain id array (enrichment_bundles.event_ids_json, assist tails).
    const kept = (parsed as string[]).filter((id) => !doomed.has(id));
    if (kept.length === parsed.length) return { kept: json, changed: false };
    return { kept: kept.length > 0 ? JSON.stringify(kept) : null, changed: true };
  }
  if (Array.isArray(parsed)) {
    // [{event_ids[], quote}] evidence shape.
    let changed = false;
    const entries: EvidenceEntry[] = [];
    for (const entry of parsed as EvidenceEntry[]) {
      const ids = Array.isArray(entry?.event_ids)
        ? (entry.event_ids as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const keptIds = ids.filter((id) => !doomed.has(id));
      if (keptIds.length !== ids.length) {
        changed = true;
        if (keptIds.length === 0) continue; // entry existed only through deleted events
        entries.push({ ...entry, event_ids: keptIds });
      } else {
        entries.push(entry);
      }
    }
    if (!changed) return { kept: json, changed: false };
    return { kept: entries.length > 0 ? JSON.stringify(entries) : null, changed: true };
  }
  return { kept: json, changed: false };
}

/** Does this JSON blob mention any doomed id? Cheap pre-filter before parsing. */
function mentionsAny(json: string, ids: string[]): boolean {
  for (const id of ids) if (json.includes(id)) return true;
  return false;
}

/**
 * Hard-delete a set of events and every derived row referencing them, in one
 * transaction, and write the single counts-only tombstone decision.
 */
export function hardDeleteEvents(
  eventIds: string[],
  opts: { reason: string; by?: string; targetKind?: string; targetId?: string },
): CascadeReport {
  const report: CascadeReport = {
    events_deleted: 0,
    episodes_deleted: 0,
    claim_versions_deleted: 0,
    claim_versions_stripped: 0,
    claims_deleted: 0,
    tasks_deleted: 0,
    tasks_stripped: 0,
    bundles_deleted: 0,
    bundles_stripped: 0,
    digests_deleted: 0,
    escalations_deleted: 0,
    decisions_deleted: 0,
    decision_id: null,
  };
  const ids = [...new Set(eventIds)].filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return report;
  const doomed = new Set(ids);
  const db = getDb();

  const run = db.transaction(() => {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _doomed_events (id TEXT PRIMARY KEY)`);
    db.exec(`DELETE FROM _doomed_events`);
    const ins = db.prepare(`INSERT OR IGNORE INTO _doomed_events (id) VALUES (?)`);
    for (const id of ids) ins.run(id);

    // Only ids that actually exist count — callers may pass a span twice.
    const existing = (
      db
        .prepare(`SELECT id FROM events WHERE id IN (SELECT id FROM _doomed_events)`)
        .all() as { id: string }[]
    ).map((r) => r.id);
    if (existing.length === 0) {
      db.exec(`DELETE FROM _doomed_events`);
      return;
    }

    // Content hashes the doomed events carry — digest cleanup happens after
    // the event delete, keeping any hash a SURVIVING event still shares.
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _doomed_hashes (h TEXT PRIMARY KEY)`);
    db.exec(`DELETE FROM _doomed_hashes`);
    db.exec(
      `INSERT OR IGNORE INTO _doomed_hashes
        SELECT content_hash FROM events
         WHERE content_hash IS NOT NULL AND id IN (SELECT id FROM _doomed_events)`,
    );

    // Episodes whose ranges touch a doomed event (FK cascade will remove the
    // range rows; the episode shells are judged after the event delete).
    const affectedEpisodes = (
      db
        .prepare(
          `SELECT DISTINCT episode_id AS id FROM episode_events
            WHERE start_event_id IN (SELECT id FROM _doomed_events)
               OR end_event_id   IN (SELECT id FROM _doomed_events)`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);

    // ---- JSON evidence scrub: claim_versions ------------------------------
    const deletedClaimVersionIds: string[] = [];
    const touchedClaimKeys = new Set<string>();
    const cvRows = db
      .prepare(`SELECT id, claim_key, evidence_json FROM claim_versions WHERE evidence_json IS NOT NULL`)
      .all() as { id: string; claim_key: string; evidence_json: string }[];
    for (const row of cvRows) {
      if (!mentionsAny(row.evidence_json, existing)) continue;
      const { kept, changed } = stripEvidence(row.evidence_json, doomed);
      if (!changed) continue;
      touchedClaimKeys.add(row.claim_key);
      if (kept === null) {
        db.prepare(`DELETE FROM claim_versions WHERE id = ?`).run(row.id);
        deletedClaimVersionIds.push(row.id);
        report.claim_versions_deleted++;
      } else {
        db.prepare(`UPDATE claim_versions SET evidence_json = ? WHERE id = ?`).run(kept, row.id);
        report.claim_versions_stripped++;
      }
    }

    // Recompute the touched claims headers; a claim with no versions left is
    // gone (space_claims follows by FK).
    const deletedClaimKeys: string[] = [];
    for (const key of touchedClaimKeys) {
      const versions = db
        .prepare(`SELECT id, stated_at FROM claim_versions WHERE claim_key = ? ORDER BY stated_at DESC`)
        .all(key) as { id: string; stated_at: string }[];
      if (versions.length === 0) {
        const r = db.prepare(`DELETE FROM claims WHERE claim_key = ?`).run(key);
        if (r.changes > 0) {
          report.claims_deleted++;
          deletedClaimKeys.push(key);
        }
        continue;
      }
      const header = db
        .prepare(`SELECT active_version_id FROM claims WHERE claim_key = ?`)
        .get(key) as { active_version_id: string | null } | undefined;
      const surviving = new Set(versions.map((v) => v.id));
      const active =
        header?.active_version_id && surviving.has(header.active_version_id)
          ? header.active_version_id
          : versions[0].id;
      db.prepare(
        `UPDATE claims SET version_count = ?, active_version_id = ?,
                first_stated_at = ?, last_stated_at = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE claim_key = ?`,
      ).run(versions.length, active, versions[versions.length - 1].stated_at, versions[0].stated_at, key);
    }

    // ---- JSON evidence scrub: tasks ---------------------------------------
    const deletedTaskIds: string[] = [];
    const taskRows = db
      .prepare(`SELECT id, evidence_json FROM tasks WHERE evidence_json IS NOT NULL`)
      .all() as { id: string; evidence_json: string }[];
    for (const row of taskRows) {
      if (!mentionsAny(row.evidence_json, existing)) continue;
      const { kept, changed } = stripEvidence(row.evidence_json, doomed);
      if (!changed) continue;
      if (kept === null) {
        // The task's entire evidence base was deleted: an honest delete takes
        // the derived task with it rather than leaving an unexplainable row.
        db.prepare(`DELETE FROM tasks WHERE id = ?`).run(row.id);
        deletedTaskIds.push(row.id);
        report.tasks_deleted++;
      } else {
        db.prepare(`UPDATE tasks SET evidence_json = ? WHERE id = ?`).run(kept, row.id);
        report.tasks_stripped++;
      }
    }

    // ---- enrichment_bundles member lists ----------------------------------
    const bundleRows = db
      .prepare(`SELECT id, event_ids_json FROM enrichment_bundles`)
      .all() as { id: string; event_ids_json: string }[];
    for (const row of bundleRows) {
      if (!mentionsAny(row.event_ids_json, existing)) continue;
      const { kept, changed } = stripEvidence(row.event_ids_json, doomed);
      if (!changed) continue;
      if (kept === null) {
        db.prepare(`DELETE FROM enrichment_bundles WHERE id = ?`).run(row.id);
        report.bundles_deleted++;
      } else {
        db.prepare(`UPDATE enrichment_bundles SET event_ids_json = ? WHERE id = ?`).run(kept, row.id);
        report.bundles_stripped++;
      }
    }

    // ---- assist accumulator tails (0105_assist, tolerated if absent) ------
    try {
      const topicRows = db
        .prepare(`SELECT id, event_ids_json FROM assist_topics`)
        .all() as { id: string; event_ids_json: string }[];
      for (const row of topicRows) {
        if (!mentionsAny(row.event_ids_json, existing)) continue;
        const { kept, changed } = stripEvidence(row.event_ids_json, doomed);
        if (!changed) continue;
        db.prepare(`UPDATE assist_topics SET event_ids_json = ? WHERE id = ?`).run(kept ?? "[]", row.id);
      }
    } catch {
      // Table not migrated yet (older DB) — nothing referencing events there.
    }

    // ---- plain no-FK reference tables -------------------------------------
    report.escalations_deleted = db
      .prepare(`DELETE FROM context_escalations WHERE event_id IN (SELECT id FROM _doomed_events)`)
      .run().changes;

    // ---- the events themselves (FK cascades + FTS triggers fire here) -----
    report.events_deleted = db
      .prepare(`DELETE FROM events WHERE id IN (SELECT id FROM _doomed_events)`)
      .run().changes;

    // ---- episode shells with no surviving ranges --------------------------
    const deletedEpisodeIds: string[] = [];
    for (const epId of affectedEpisodes) {
      const left = db
        .prepare(`SELECT 1 FROM episode_events WHERE episode_id = ? LIMIT 1`)
        .get(epId);
      if (!left) {
        const r = db.prepare(`DELETE FROM episodes WHERE id = ?`).run(epId);
        if (r.changes > 0) {
          report.episodes_deleted++;
          deletedEpisodeIds.push(epId);
        }
      }
    }
    if (deletedEpisodeIds.length > 0) {
      const epSet = deletedEpisodeIds;
      // t2_review_queue.episode_id has no FK; decide_queue holds JSON lists.
      const qMarks = epSet.map(() => "?").join(",");
      db.prepare(`DELETE FROM t2_review_queue WHERE episode_id IN (${qMarks})`).run(...epSet);
      const dqRows = db
        .prepare(`SELECT space_id, pending_episode_ids FROM decide_queue`)
        .all() as { space_id: string; pending_episode_ids: string }[];
      const epDoomed = new Set(epSet);
      for (const row of dqRows) {
        if (!mentionsAny(row.pending_episode_ids, epSet)) continue;
        const { kept, changed } = stripEvidence(row.pending_episode_ids, epDoomed);
        if (!changed) continue;
        if (kept === null) {
          db.prepare(`DELETE FROM decide_queue WHERE space_id = ?`).run(row.space_id);
        } else {
          db.prepare(`UPDATE decide_queue SET pending_episode_ids = ? WHERE space_id = ?`).run(
            kept,
            row.space_id,
          );
        }
      }
    }

    // ---- digests whose content hash has no surviving event ----------------
    report.digests_deleted = db
      .prepare(
        `DELETE FROM content_digests
          WHERE content_hash IN (SELECT h FROM _doomed_hashes)
            AND content_hash NOT IN (SELECT content_hash FROM events WHERE content_hash IS NOT NULL)`,
      )
      .run().changes;

    // ---- decisions about the deleted objects (their old/new payloads hold
    // the deleted content — an honest delete cannot keep them) --------------
    const decisionTargets: [string, string[]][] = [
      ["event", existing],
      ["episode", deletedEpisodeIds],
      ["task", deletedTaskIds],
      ["claim", deletedClaimKeys],
      ["claim_version", deletedClaimVersionIds],
    ];
    for (const [kind, targetIds] of decisionTargets) {
      if (targetIds.length === 0) continue;
      const marks = targetIds.map(() => "?").join(",");
      report.decisions_deleted += db
        .prepare(`DELETE FROM decisions WHERE target_kind = ? AND target_id IN (${marks})`)
        .run(kind, ...targetIds).changes;
    }

    db.exec(`DELETE FROM _doomed_events`);
    db.exec(`DELETE FROM _doomed_hashes`);

    // ---- the tombstone: counts only, never content ------------------------
    report.decision_id = writeDecision({
      pass: opts.by ?? "user",
      targetKind: opts.targetKind ?? "source",
      targetId: opts.targetId ?? "privacy_delete",
      action: "privacy_delete",
      old: {
        events_deleted: report.events_deleted,
        episodes_deleted: report.episodes_deleted,
        claim_versions_deleted: report.claim_versions_deleted,
        claims_deleted: report.claims_deleted,
        tasks_deleted: report.tasks_deleted,
      },
      new: null,
      reason: `${opts.reason} — hard delete, not reversible (content is gone by design)`,
    });
  });
  run();
  return report;
}

/**
 * The Library's "delete a span" for Screen (spec §14.3.2): every screen event
 * in [startTs, endTs] — optionally one app/stream — and its whole derivation.
 */
export function deleteScreenSpan(opts: {
  startTs: string;
  endTs: string;
  streamKey?: string | null;
  source?: string;
  by?: string;
}): CascadeReport {
  const db = getDb();
  const source = opts.source ?? "screen";
  const rows = opts.streamKey
    ? (db
        .prepare(
          `SELECT id FROM events WHERE source_type = ? AND stream_key = ? AND ts >= ? AND ts <= ?`,
        )
        .all(source, opts.streamKey, opts.startTs, opts.endTs) as { id: string }[])
    : (db
        .prepare(`SELECT id FROM events WHERE source_type = ? AND ts >= ? AND ts <= ?`)
        .all(source, opts.startTs, opts.endTs) as { id: string }[]);
  return hardDeleteEvents(
    rows.map((r) => r.id),
    {
      reason: `user deleted a ${source} span ${opts.startTs} → ${opts.endTs}${opts.streamKey ? ` (${opts.streamKey})` : ""}`,
      by: opts.by ?? "user",
      targetKind: "source",
      targetId: source,
    },
  );
}
