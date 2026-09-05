// ===========================================================================
// [CODE] The state gate (Product_V6 §11.3, P1 §6; GoldenEvals V6 P1 §5.6).
//
// One event arrives; the world model is asked FOUR questions, all lookups,
// all code, all under 100 ms:
//
//   1. is there an open task in this stream?
//   2. is there an active episode on this stream?
//   3. does the event bridge to — or mention an entity of — an active space?
//   4. is it addressed to the twin (bar · self-chat · voice)?
//
// Any yes is HOT: flush now, with whatever accumulated. Every no is COLD: the
// event accumulates and waits for the cold window (cold.ts) or a burst
// (burst.ts). Nothing here reads the text. There is no regex, no keyword, no
// character count anywhere in this file — "ok" closing a ₹50k payment and
// "ok" acknowledging a joke are identical bytes, and only state tells them
// apart (GATE-01 vs GATE-02). `content_gated_call = 0` is asserted by a test
// that reads this source.
// ===========================================================================

import { getDb } from "../../db/connection.js";

/** How long an open episode counts as "active" after its last member event. */
export const ACTIVE_EPISODE_WINDOW_MS = 24 * 3_600_000;

/** Task statuses that keep a task "open" for the gate. */
export const OPEN_TASK_STATUSES = ["open", "scheduled", "executing", "needs_input", "needs_approval"] as const;

/** Sources whose every event is addressed to the twin. */
export const TWIN_SOURCES = ["twin", "self", "bar", "voice"] as const;

export type GateReason =
  | "open_task_in_stream"
  | "active_episode"
  | "bridge_to_active_space"
  | "entity_in_active_space"
  | "addressed_to_twin";

export interface GateDecision {
  decision: "hot" | "cold";
  reason: GateReason | null;
  /** Wall time the lookup took — the < 100 ms budget. */
  tookMs: number;
}

/** What the gate looks at. Deliberately NOT the text. */
export interface GateEvent {
  /** events.id — absent for a not-yet-written envelope (bridge / mention lookups then skip). */
  id?: string | null;
  streamId: string;
  source: string;
  kind?: string | null;
  /** Actor ref, e.g. "contact:rohan" | "self". */
  actor?: string | null;
  /** Roles envelope: sender / receiver, for the self-chat rule. */
  roles?: { sender?: string; receiver?: readonly string[]; audience?: readonly string[] } | null;
  /** Stream key, so `bar:` threads read as the twin's without a source lookup. */
  streamKey?: string | null;
}

export interface GateOptions {
  nowMs?: number;
}

function stmts() {
  const db = getDb();
  return {
    openTaskInStream: db.prepare(
      `SELECT 1 AS hit FROM tasks t
        WHERE t.status IN (${OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",")})
          AND (
            EXISTS (SELECT 1 FROM episodes ep WHERE ep.space_id = t.space_id AND ep.stream_id = ?)
            OR EXISTS (
              SELECT 1 FROM json_each(COALESCE(t.evidence_json, '[]')) j
                JOIN events ev ON ev.id = CASE j.type
                    WHEN 'text' THEN j.value
                    WHEN 'object' THEN json_extract(j.value, '$.event_id')
                    ELSE NULL END
               WHERE ev.stream_id = ?
            )
            OR EXISTS (
              SELECT 1 FROM json_each(COALESCE(t.evidence_json, '[]')) j,
                   json_each(CASE j.type WHEN 'object' THEN COALESCE(json_extract(j.value, '$.event_ids'), '[]') ELSE '[]' END) k
                JOIN events ev ON ev.id = k.value
               WHERE ev.stream_id = ?
            )
          )
        LIMIT 1`,
    ),
    activeEpisode: db.prepare(
      `SELECT 1 AS hit FROM episodes
        WHERE stream_id = ? AND state = 'open'
          AND COALESCE(last_ts, updated_at, created_at) >= ?
        LIMIT 1`,
    ),
    bridgeToActiveSpace: db.prepare(
      `SELECT 1 AS hit
         FROM event_bridge_keys k
         JOIN space_bridge_keys sk ON sk.kind = k.kind AND sk.value_norm = k.value_norm
         JOIN spaces sp ON sp.id = sk.space_id AND sp.status = 'active'
        WHERE k.event_id = ?
        LIMIT 1`,
    ),
    bridgeViaEventsToActiveSpace: db.prepare(
      `SELECT 1 AS hit
         FROM bridges b
         JOIN episode_events ee ON ee.event_id = b.right_id OR ee.start_event_id = b.right_id OR ee.end_event_id = b.right_id
         JOIN episodes ep ON ep.id = ee.episode_id
         JOIN spaces sp ON sp.id = ep.space_id AND sp.status = 'active'
        WHERE b.left_id = ?
        LIMIT 1`,
    ),
    actorEntityInActiveSpace: db.prepare(
      `SELECT 1 AS hit
         FROM entity_identities ei
         JOIN space_entities se ON se.entity_id = ei.entity_id
         JOIN spaces sp ON sp.id = se.space_id AND sp.status = 'active'
        WHERE ei.value_norm = ?
        LIMIT 1`,
    ),
    mentionEntityInActiveSpace: db.prepare(
      `SELECT 1 AS hit
         FROM mentions m
         JOIN space_entities se ON se.entity_id = m.entity_id
         JOIN spaces sp ON sp.id = se.space_id AND sp.status = 'active'
        WHERE m.event_id = ?
        LIMIT 1`,
    ),
  };
}

/** Rule 4 — addressed to the twin. Pure; no DB. */
export function addressedToTwin(e: GateEvent): boolean {
  if ((TWIN_SOURCES as readonly string[]).includes(e.source)) return true;
  if (e.kind?.startsWith("bar.")) return true;
  if (e.streamKey?.startsWith("bar:")) return true;
  // Self-chat: the user writing to themself (sender self, receiver only self).
  const r = e.roles;
  if (r && r.sender === "self") {
    const receivers = r.receiver ?? [];
    if (receivers.some((x) => x === "self") && receivers.every((x) => x === "self")) return true;
  }
  return false;
}

/**
 * The gate. Order is fixed and cheap-first: the twin rule needs no DB, then
 * one indexed probe per remaining question. Returns the first hit's reason.
 */
export function gateEvent(e: GateEvent, opts: GateOptions = {}): GateDecision {
  const started = performance.now();
  const done = (decision: "hot" | "cold", reason: GateReason | null): GateDecision => ({
    decision,
    reason,
    tookMs: performance.now() - started,
  });

  if (addressedToTwin(e)) return done("hot", "addressed_to_twin");

  const s = stmts();
  if (s.openTaskInStream.get(e.streamId, e.streamId, e.streamId)) return done("hot", "open_task_in_stream");

  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - ACTIVE_EPISODE_WINDOW_MS).toISOString();
  if (s.activeEpisode.get(e.streamId, since)) return done("hot", "active_episode");

  if (e.id) {
    if (s.bridgeToActiveSpace.get(e.id) || s.bridgeViaEventsToActiveSpace.get(e.id)) {
      return done("hot", "bridge_to_active_space");
    }
    if (s.mentionEntityInActiveSpace.get(e.id)) return done("hot", "entity_in_active_space");
  }
  if (e.actor && e.actor !== "self" && s.actorEntityInActiveSpace.get(e.actor)) {
    return done("hot", "entity_in_active_space");
  }

  return done("cold", null);
}
