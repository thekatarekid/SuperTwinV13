// ===========================================================================
// 0201_v6_graph — V6 P1 S2.1 (Build §5.1, Product_V6 §23.4/§23.5, backlog
// T5-2/T5-3, retrieval decision record items 2, 5, 6).
//
// The index-and-graph substrate every Stage-2 lane reads. Fresh installs only
// (Build §1.1), so nothing is rewritten in place and every new table starts
// empty — except `hub_nodes`, which is seeded with `self`.
//
//   entity_edges     ALREADY carries kind · subtype · src · dst · confidence ·
//   edge_evidence    status · valid_from · valid_to (0022_v2_core), and the
//                    evidence table already holds event ids plus the verbatim
//                    quote. Nothing is re-created; the walk gains the two
//                    covering indexes it needs (per-node neighbours ordered by
//                    confidence, filtered by status) and evidence gains an
//                    index by event so "what did this event prove" and the
//                    cascade are both a seek. Bridges written as edges (S2.6)
//                    land in this same table.
//
//   claims           typed-field COLUMNS (Product_V6 §11.14, decision item 2):
//                    amount · currency · date · typed_status · merchant ·
//                    order_id · location · duration_s. Structured retrieval
//                    (S2.5) queries these — "how much on cabs last month" is a
//                    SUM over `amount` filtered by `merchant`/`date`, never a
//                    ranking of chunks. The spec's `status` field is stored as
//                    `typed_status`: `claims.status` already means the claim's
//                    own lifecycle (active|closed) and cannot be overloaded.
//                    NULL means extraction found nothing — never a midpoint,
//                    never a guess (TYP-03).
//
//   chunks           the unit that is embedded (T5-3). One row per chat window
//                    (rolling ~2k chars per stream), screen-document chunk
//                    (recomputed on re-anchor), browser visit (one per visit,
//                    deduped by content hash), plus episode summaries, space
//                    cards, claims and people cards. INTEGER PRIMARY KEY so
//                    the rowid IS the key: FTS and the vector table both cite
//                    it as a 64-bit int, not a 26-char uuid.
//
//   chunk_embeddings int8, rowid-keyed (T5-3: 782 B/vector at 768-d against
//                    3,280 fp32). `chunk_id` is the chunks rowid; `scale` is
//                    the per-vector symmetric quantiser (x ≈ q × scale). One
//                    vector per chunk, tagged with the model that produced it.
//                    A re-embed (S2.2) builds a sibling table with the same
//                    body (`chunkEmbeddingsDdl(name)` in db/v6graph.ts) and
//                    flips DROP + RENAME in one transaction — never a
//                    half-built index.
//
//   hub_nodes        entities the graph walk must not pass through (§23.5
//                    rule 2). `self` connects to everything: a walk through it
//                    reaches the whole graph in two hops and returns noise.
//                    Seeded here with the self entity so the exclusion exists
//                    before a single edge is written.
//
//   entities         `self` gains a fixed, pinned, non-provisional row
//                    (SELF_ENTITY_ID in db/v6graph.ts) so edges and hubs have
//                    something to point at from the first import.
//                    The `people` view (0101) is redefined without it: People
//                    lists others, and "You" is not a contact.
//
// Page size: 16 KB pages are a connection-level pragma, not DDL, and must be
// set before the first table is created — db/connection.ts does that ahead of
// `journal_mode = WAL` on every open (a no-op on a file that already has pages).
// ===========================================================================

/** Fixed id of the self entity (24 zero hex digits — passes `isEntityId`). */
export const SELF_ENTITY_ID = "ent_000000000000000000000000";

/**
 * Body of the int8 embedding table, parameterised by table name so a re-embed
 * can build an identical sibling and flip it in one transaction (S2.2).
 */
export function chunkEmbeddingsDdl(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`chunkEmbeddingsDdl: bad table name ${table}`);
  return /* sql */ `
CREATE TABLE IF NOT EXISTS ${table} (
  chunk_id    INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE, -- rowid key
  model       TEXT    NOT NULL,                  -- embedder id that produced the vector
  dim         INTEGER NOT NULL,                  -- vector length (768 for EmbeddingGemma)
  scale       REAL    NOT NULL,                  -- symmetric int8 quantiser: x ≈ q * scale
  vec         BLOB    NOT NULL,                  -- dim signed int8s
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_${table}_model ON ${table}(model, dim);
`;
}

/** The 0201_v6_graph migration body. */
export const V6_GRAPH = /* sql */ `
-- ---- self: one fixed entity row, pinned, never provisional -----------------

INSERT OR IGNORE INTO entities (id, type, subtype, canonical, provisional, user_pinned)
VALUES ('${SELF_ENTITY_ID}', 'person', NULL, 'You', 0, 1);

-- people (0101) is the People surface's list of OTHERS; the self row is a
-- person entity but is not a contact. Same view, minus self.
DROP VIEW IF EXISTS people;
CREATE VIEW people AS
SELECT e.id,
       e.canonical      AS name,
       e.subtype,
       e.circle,
       e.provisional,
       e.user_pinned,
       e.first_seen_at,
       e.last_seen_at,
       e.created_at
  FROM entities e
 WHERE e.type = 'person'
   AND e.merged_into IS NULL
   AND e.id <> '${SELF_ENTITY_ID}';

-- ---- entity_edges / edge_evidence: walk indexes (§23.5) -------------------
-- The table and its columns exist since 0022_v2_core; the BFS (S2.6) reads
-- "active edges of this node, best confidence first" from both ends.

CREATE INDEX IF NOT EXISTS idx_entity_edges_walk_src
  ON entity_edges(src_entity_id, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_entity_edges_walk_dst
  ON entity_edges(dst_entity_id, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_edge_evidence_event ON edge_evidence(event_id);

-- ---- claims: typed-field columns (§11.14, decision item 2) -----------------

ALTER TABLE claims ADD COLUMN amount       REAL;     -- numeric amount as stated (340, 4200.50)
ALTER TABLE claims ADD COLUMN currency     TEXT;     -- ISO 4217 ('INR', 'USD')
ALTER TABLE claims ADD COLUMN date         TEXT;     -- YYYY-MM-DD the fact is about (not stated_at)
ALTER TABLE claims ADD COLUMN typed_status TEXT;     -- the fact's status: confirmed|pending|delivered|cancelled|…
ALTER TABLE claims ADD COLUMN merchant     TEXT;     -- 'Uber', 'Goibibo', 'Airbnb'
ALTER TABLE claims ADD COLUMN order_id     TEXT;     -- order / PNR / booking reference, verbatim
ALTER TABLE claims ADD COLUMN location     TEXT;     -- free-text place as stated
ALTER TABLE claims ADD COLUMN duration_s   INTEGER;  -- seconds

CREATE INDEX IF NOT EXISTS idx_claims_typed_merchant ON claims(merchant, date) WHERE merchant IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_typed_date     ON claims(date)           WHERE date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_typed_order    ON claims(order_id)       WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_typed_status   ON claims(typed_status)   WHERE typed_status IS NOT NULL;

-- ---- chunks: the embedded unit (T5-3) ---------------------------------------

CREATE TABLE IF NOT EXISTS chunks (
  id             INTEGER PRIMARY KEY,             -- rowid; cited by FTS + vectors
  kind           TEXT    NOT NULL,                -- chat|screen|browser|episode|space|claim|person|artifact
  source         TEXT,                            -- 'wa' | 'browser' | 'screen' | 'self' | NULL for cards
  stream_key     TEXT,                            -- chat: the stream; screen: the doc_key; browser: the host
  ref_id         TEXT,                            -- episode id / space id / claim_key / entity id / visit event id
  seq            INTEGER NOT NULL DEFAULT 0,      -- window ordinal within (kind, stream_key)
  text           TEXT    NOT NULL,
  text_len       INTEGER NOT NULL,
  content_hash   TEXT    NOT NULL,                -- sha256 hex of text; dedupe key
  ts_start       TEXT,                            -- earliest event ts covered
  ts_end         TEXT,                            -- latest event ts covered
  event_ids_json TEXT,                            -- JSON array of events.id the chunk covers
  tier           INTEGER,                         -- stream tier at capture (envelope)
  consent_id     TEXT,                            -- consents.id that admitted the rows
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Same text in the same stream is one chunk (browser: one per visit, deduped
-- by content hash; chat: a window re-cut over the same messages is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS ux_chunks_dedupe
  ON chunks(kind, COALESCE(stream_key, ''), content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_stream ON chunks(kind, stream_key, seq);
CREATE INDEX IF NOT EXISTS idx_chunks_ref    ON chunks(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_chunks_ts     ON chunks(ts_start, ts_end);

-- ---- chunk_embeddings: int8, rowid key ---------------------------------------
${chunkEmbeddingsDdl("chunk_embeddings")}

-- ---- hub_nodes: excluded from the walk (§23.5 rule 2) ------------------------

CREATE TABLE IF NOT EXISTS hub_nodes (
  entity_id  TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,                       -- 'self' | 'degree' | 'user'
  degree     INTEGER,                             -- edge count when added (NULL for self/user)
  added_by   TEXT,                                -- 'migration:0201' | 'code:degree' | 'user'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO hub_nodes (entity_id, reason, added_by)
VALUES ('${SELF_ENTITY_ID}', 'self', 'migration:0201');
`;
