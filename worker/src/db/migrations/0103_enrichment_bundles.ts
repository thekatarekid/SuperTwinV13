// ===========================================================================
// Enrichment bundle countdowns (build P1.8, spec §4.4 rule 2).
//
// One row per DISPATCHED bundle that still had unread attachments at the
// moment it was handed to understanding. `pending_count` is the countdown the
// media lane decrements as captions/transcripts/scrapes resolve; at zero,
// exactly one scoped re-understand job runs — or, when a placeholder forced an
// episode into `unsorted`, the whole bundle re-dispatches instead.
//
// A bundle whose attachments were all readable at dispatch time never gets a
// row here: pass 1 already saw the full text, and there is nothing to wait on.
// ===========================================================================

export const ENRICHMENT_BUNDLES = `
CREATE TABLE IF NOT EXISTS enrichment_bundles (
  id             TEXT PRIMARY KEY,           -- 'eb:<stream_id>:<min_rowid>-<max_rowid>' (deterministic)
  stream_id      TEXT,                       -- streams.id the bundle was cut from
  event_ids_json TEXT NOT NULL,              -- JSON array of member event ids
  min_rowid      INTEGER NOT NULL,           -- events.rowid range the bundle spans
  max_rowid      INTEGER NOT NULL,
  pending_count  INTEGER NOT NULL,           -- attachments still unresolved (spec §4.4 rule 2)
  status         TEXT NOT NULL DEFAULT 'waiting',  -- waiting|understood|redispatched
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrichment_bundles_waiting
  ON enrichment_bundles(status) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_enrichment_bundles_stream
  ON enrichment_bundles(stream_id);
`;
