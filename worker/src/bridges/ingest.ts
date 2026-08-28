// ===========================================================================
// [CODE] Bridge extraction AT INGEST — build P1.1 ("built, never wired —
// wire it", spec §19). The V11 extractor (./extract.ts) ran as a batch pass
// over items handed to it; V13 runs it on every event as it lands, through
// both single-writer paths (db/ingest.ts insertEvent via ingest/index.ts, and
// db/eventlog.ts appendEvents).
//
// Two writes per event:
//   1. `event_bridge_keys` — every normalised literal (url / phone / email /
//      order-id / file-id) the event carries, one row per (event, kind, value).
//   2. `bridges` — a pair row against every PAST event already holding the
//      same (kind, value_norm), found by the event_bridge_keys index instead
//      of a rescan. Rows are content-addressed and bidirectional (extract.ts
//      persistBridges), so replays re-write the same rows.
//
// Zero model calls; regexes and set maths only. Failures never block ingest —
// the caller wraps this in a try/catch and an event without bridge keys is an
// event, not an error.
// ===========================================================================

import { getDb } from "../db/connection.js";
import {
  bridgeId,
  extractCandidates,
  liveBridgeKeys,
  persistBridges,
  MAX_PAIRS_PER_VALUE,
  CONFIDENCE_EXACT,
  type BridgeEdge,
  type BridgeItem,
} from "./extract.js";

export interface BridgeIngestResult {
  /** event_bridge_keys rows inserted (0 on replays). */
  keysWritten: number;
  /** bridges rows inserted (bidirectional count, 0 on replays). */
  bridgesWritten: number;
}

interface EventRow {
  id: string;
  source_id: string | null;
  source_type: string | null;
  ts: string | null;
  text: string | null;
  link_url: string | null;
}

/**
 * Extract + persist bridge keys for freshly-ingested events, and bridge each
 * against past holders of the same literal. Idempotent: replaying the same
 * event ids writes nothing new.
 */
export function bridgeIngestedEvents(eventIds: readonly string[]): BridgeIngestResult {
  const result: BridgeIngestResult = { keysWritten: 0, bridgesWritten: 0 };
  if (eventIds.length === 0) return result;

  const db = getDb();
  const readEvent = db.prepare(
    `SELECT id, source_id, source_type, ts, text, link_url FROM events WHERE id = ?`,
  );
  const insertKey = db.prepare(
    `INSERT OR IGNORE INTO event_bridge_keys (event_id, kind, value_norm) VALUES (?, ?, ?)`,
  );
  const partners = db.prepare(
    `SELECT event_id FROM event_bridge_keys
      WHERE kind = ? AND value_norm = ? AND event_id <> ?
      ORDER BY event_id LIMIT ?`,
  );

  const edges: BridgeEdge[] = [];

  for (const id of eventIds) {
    const row = readEvent.get(id) as EventRow | undefined;
    if (!row) continue;

    const sourceId = row.source_id ?? row.source_type ?? "";
    const item: BridgeItem = {
      id: row.id,
      source_id: sourceId,
      object_kind: "event",
      ts: row.ts,
      text: row.text,
      urls: row.link_url ? [row.link_url] : undefined,
    };
    // A source with no manifest contributes all kinds (extract.ts rule); the
    // measured kinds (attendee_set, geo_time) never fire off a single event.
    const keys = liveBridgeKeys([item]);

    for (const cand of extractCandidates(item, keys)) {
      if (cand.kind === "attendee_set" || cand.kind === "geo_time") continue;
      const info = insertKey.run(row.id, cand.kind, cand.value_norm);
      result.keysWritten += info.changes;

      const others = partners.all(cand.kind, cand.value_norm, row.id, MAX_PAIRS_PER_VALUE) as {
        event_id: string;
      }[];
      for (const other of others) {
        const [left, right] = row.id <= other.event_id ? [row.id, other.event_id] : [other.event_id, row.id];
        edges.push({
          id: bridgeId(cand.kind, cand.value_norm, left, right),
          kind: cand.kind,
          value_norm: cand.value_norm,
          left_kind: "event",
          left_id: left,
          right_kind: "event",
          right_id: right,
          confidence: CONFIDENCE_EXACT,
          decided_by: `code:bridge/${cand.kind}`,
        });
      }
    }
  }

  result.bridgesWritten = persistBridges(edges);
  return result;
}
