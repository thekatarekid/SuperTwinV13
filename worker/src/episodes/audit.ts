// ===========================================================================
// [CODE] The episode-graph audit — arch §14.2 row `wrong-attach rate`.
//
// Same shape as `entities/audit.ts`, for the same reason: the gate has to be
// measured against the ROWS THAT LANDED, not against the in-memory list the
// decision was made from.
//
// The check this replaces asked "is the attach target in `result.candidates`?"
// — and `engine.ts` builds its `allowed` set from exactly that list, so the
// answer was yes by construction and the gate could never read anything but 0.
// A gate that cannot be non-zero is not a gate.
//
// What IS independently checkable, after the fact, from the tables:
//
//   STREAM SCOPE.  An episode belongs to one stream forever — `writeEpisode`
//        never rewrites `stream_id` — so an attach whose target sits in a
//        different stream from its session is a wrong attach, whatever the
//        candidate list said. This is the one the architecture cares about
//        most: the same topic in two chats is TWO episodes (evals J-039..043).
//
//   THE CONFIDENCE FLOOR.  §12.3: "confidence < 0.6 on an attach → prefer
//        new". The verdict keeps the confidence the segment was acted on at,
//        so an attach that committed below the floor is readable back.
//
//   ATTRIBUTION.  An `episode_sessions` row with `added_by = 'attach'` and no
//        verdict behind it is an attach nobody can explain — the episode
//        equivalent of `entities/audit.ts`'s `no_decision_row`.
//
// All three read persisted rows and none of them consults the candidate list,
// so each one can actually fire. `audit.test.ts` fires all three.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { ATTACH_CONFIDENCE_FLOOR } from "./engine.js";

export type WrongAttachKind = "cross_stream" | "below_floor" | "no_verdict" | "no_episode";

/** One attach that COMMITTED, and whether anything justifies it. */
export interface AttachAudit {
  episodeId: string;
  sessionId: string;
  verdictId: string | null;
  ok: boolean;
  kind: WrongAttachKind | null;
  reason: string;
}

interface AttachRow {
  episode_id: string;
  session_id: string;
  verdict_id: string | null;
  episode_stream: string | null;
  session_stream: string | null;
}

interface SegmentShape {
  episodeId?: unknown;
  decision?: unknown;
  confidence?: unknown;
}

/**
 * The confidence a verdict recorded for the segment that landed on `episodeId`.
 * Null when the verdict does not speak about that episode at all — which is
 * itself reported, rather than being read as "fine".
 */
function confidenceFor(verdictId: string | null, episodeId: string): number | null {
  if (verdictId === null) return null;
  const row = getDb()
    .prepare(`SELECT output_json FROM episode_verdicts WHERE id = ?`)
    .get(verdictId) as { output_json: string | null } | undefined;
  if (row === undefined || row.output_json === null) return null;
  let parsed: { segments?: unknown };
  try {
    parsed = JSON.parse(row.output_json) as { segments?: unknown };
  } catch {
    return null;
  }
  const list = Array.isArray(parsed.segments) ? parsed.segments : [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as SegmentShape;
    if (s.episodeId !== episodeId || s.decision !== "attach") continue;
    return typeof s.confidence === "number" ? s.confidence : null;
  }
  return null;
}

/**
 * Every attach that committed, examined. `ok === false` is the numerator of
 * §14.2's `wrong-attach rate`; the length of the list is its denominator, so a
 * run with no attaches at all measures nothing and leaves the gate at `no
 * data` rather than reporting a flattering zero.
 */
export function auditAttaches(): AttachAudit[] {
  const rows = getDb()
    .prepare(
      `SELECT es.episode_id, es.session_id, es.verdict_id,
              e.stream_id AS episode_stream, s.stream_id AS session_stream
         FROM episode_sessions es
         LEFT JOIN episodes e ON e.id = es.episode_id
         LEFT JOIN sessions s ON s.id = es.session_id
        WHERE es.added_by = 'attach'
        ORDER BY es.episode_id, es.session_id`,
    )
    .all() as AttachRow[];

  return rows.map((row) => {
    const base = { episodeId: row.episode_id, sessionId: row.session_id, verdictId: row.verdict_id };
    if (row.episode_stream === null) {
      return {
        ...base,
        ok: false,
        kind: "no_episode" as const,
        reason: `attached to ${row.episode_id}, which is not an episode row`,
      };
    }
    if (row.session_stream !== null && row.episode_stream !== row.session_stream) {
      return {
        ...base,
        ok: false,
        kind: "cross_stream" as const,
        reason: `session ${row.session_id} (stream ${row.session_stream}) attached to an episode of stream ${row.episode_stream} — episodes are stream-scoped`,
      };
    }
    if (row.verdict_id === null) {
      return {
        ...base,
        ok: false,
        kind: "no_verdict" as const,
        reason: `attach committed with no verdict_id — nothing records why`,
      };
    }
    const confidence = confidenceFor(row.verdict_id, row.episode_id);
    if (confidence === null) {
      return {
        ...base,
        ok: false,
        kind: "no_verdict" as const,
        reason: `verdict ${row.verdict_id} records no attach segment for ${row.episode_id}`,
      };
    }
    if (confidence < ATTACH_CONFIDENCE_FLOOR) {
      return {
        ...base,
        ok: false,
        kind: "below_floor" as const,
        reason: `attached at confidence ${confidence} < ${ATTACH_CONFIDENCE_FLOOR} — §12.3 says prefer new`,
      };
    }
    return {
      ...base,
      ok: true,
      kind: null,
      reason: `same-stream attach at confidence ${confidence}, verdict ${row.verdict_id}`,
    };
  });
}

/** The guilty subset — §14.2's numerator. */
export function wrongAttaches(): AttachAudit[] {
  return auditAttaches().filter((a) => !a.ok);
}

/**
 * `wrong / total`, or null when nothing attached. Null is the honest answer to
 * a run that made no attaches: `gates.ts` turns it into `no data`, never a pass.
 */
export function wrongAttachRate(): number | null {
  const all = auditAttaches();
  if (all.length === 0) return null;
  return all.filter((a) => !a.ok).length / all.length;
}
