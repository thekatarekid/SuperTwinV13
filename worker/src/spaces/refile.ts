// ===========================================================================
// Re-filing — the drag (V6 P1 S5.1; Product_V6_Phase1 §13.5 "drag to re-file").
//
// Two drags, one meaning: the user is telling the twin where a thing belongs.
//
//   refileSpace(id, area)    a space card dragged between life-area groups in
//                            the Spaces list. Direct manipulation IS the
//                            correction — applied at once, one decisions row,
//                            reversible like every other change. The area is
//                            normalized against the fourteen defaults so a
//                            typo can never invent a fifteenth group.
//   refileEpisode(ep, sp)    an episode dragged out of one space's evidence
//                            timeline into another (or out to unsorted). The
//                            episode's old home is recorded in the decision,
//                            and an episode dropped OUT of every space goes
//                            back to `unsorted` open — it is not lost, and the
//                            next birth's sweep can still claim it.
//
// Neither path calls a model. Both write exactly one decisions row so the
// why-panel on the moved element explains itself, and undo restores the old
// value (the decisions ledger carries `old`).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { LIFE_AREAS, normalizeLifeArea, OTHER_AREA } from "./life-areas.js";

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export interface RefileOutcome {
  moved: boolean;
  decisionId: string | null;
  from: string | null;
  to: string | null;
  reason?: string;
}

/** True for one of the fourteen life areas or the "Other" bucket. */
export function isLifeArea(area: string): boolean {
  return area === OTHER_AREA || (LIFE_AREAS as readonly string[]).includes(normalizeLifeArea(area));
}

/**
 * A space dragged into a life area. Dropping into "Other" clears the field
 * (the list renders a null area under "Other", so the two agree).
 */
export function refileSpace(spaceId: string, area: string, by: "user" | "code" = "user"): RefileOutcome {
  const db = getDb();
  const row = db.prepare(`SELECT life_area FROM spaces WHERE id = ?`).get(spaceId) as
    | { life_area: string | null }
    | undefined;
  if (!row) return { moved: false, decisionId: null, from: null, to: null, reason: "no such space" };
  const target = normalizeLifeArea(area);
  const stored = target === OTHER_AREA ? null : target;
  const before = normalizeLifeArea(row.life_area);
  if (before === target) {
    return { moved: false, decisionId: null, from: before, to: target, reason: "already filed there" };
  }
  db.prepare(`UPDATE spaces SET life_area = ?, updated_at = ${NOW} WHERE id = ?`).run(stored, spaceId);
  const decisionId = writeDecision({
    pass: by === "user" ? "user" : "code:refile",
    targetKind: "space",
    targetId: spaceId,
    action: "refile",
    old: { life_area: row.life_area },
    new: { life_area: stored },
    reason: `${by === "user" ? "user" : "code"} re-filed the space from ${before} to ${target}`,
  });
  return { moved: true, decisionId, from: before, to: target };
}

/**
 * An episode dragged into another space, or out of every space. `toSpaceId`
 * null means unsorted: the row goes back to `unsorted` open so the next
 * birth's sweep sees it again.
 */
export function refileEpisode(
  episodeId: string,
  toSpaceId: string | null,
  by: "user" | "code" = "user",
): RefileOutcome {
  const db = getDb();
  const ep = db.prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(episodeId) as
    | { space_id: string | null }
    | undefined;
  if (!ep) return { moved: false, decisionId: null, from: null, to: null, reason: "no such episode" };
  if (toSpaceId !== null) {
    const target = db.prepare(`SELECT id FROM spaces WHERE id = ?`).get(toSpaceId) as { id: string } | undefined;
    if (!target) return { moved: false, decisionId: null, from: ep.space_id, to: null, reason: "no such space" };
  }
  if (ep.space_id === toSpaceId) {
    return { moved: false, decisionId: null, from: ep.space_id, to: toSpaceId, reason: "already filed there" };
  }
  db.prepare(`UPDATE episodes SET space_id = ?, updated_at = ${NOW} WHERE id = ?`).run(toSpaceId, episodeId);
  if (toSpaceId === null) {
    // Out of every space: back to unsorted, open, still sweepable.
    db.prepare(
      `INSERT INTO unsorted (id, episode_id, reason, status)
       VALUES (?, ?, 'user dragged it out of its space', 'open')
       ON CONFLICT (episode_id) DO UPDATE
          SET status = 'open', claimed_by_space_id = NULL, resolved_at = NULL`,
    ).run(`un_${randomBytes(9).toString("hex")}`, episodeId);
  } else {
    db.prepare(
      `UPDATE unsorted SET status = 'claimed', claimed_by_space_id = ?, resolved_at = ${NOW}
        WHERE episode_id = ? AND status IN ('open','archived')`,
    ).run(toSpaceId, episodeId);
  }
  const decisionId = writeDecision({
    pass: by === "user" ? "user" : "code:refile",
    targetKind: "episode",
    targetId: episodeId,
    action: "refile",
    old: { space_id: ep.space_id },
    new: { space_id: toSpaceId },
    reason:
      toSpaceId === null
        ? `${by} moved the episode out of ${ep.space_id ?? "no space"} — back to unsorted`
        : `${by} filed the episode under ${toSpaceId}`,
  });
  return { moved: true, decisionId, from: ep.space_id, to: toSpaceId };
}
