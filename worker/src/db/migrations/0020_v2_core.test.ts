// ===========================================================================
// 0020_v2_core tests (vitest) — the V2 ontology migration (arch §6).
//
// What these prove, in the order the build doc asks for them:
//   1. the migration applies clean on an EMPTY db, and re-applying is a no-op;
//   2. every table §6 names exists and is queryable (SELECT, then a real INSERT
//      through each foreign key, because "the table exists" and "a row can be
//      written to it" are different claims);
//   3. `claims_active` is a VIEW that returns exactly ONE row per claim_key —
//      the newest by stated_at — and that a claim arriving LATE but said EARLY
//      lands as a predecessor instead of dislodging the current truth;
//   4. there is no `spaces` table, in any shape, anywhere;
//   5. the indices the doc names exist on the columns it names;
//   6. the events rebuild kept the rowids, the FTS index and the child rows.
//
// The migration body is inlined into 0020_v2_core.ts for bundling; the first
// test here is the guard that the inlined copy still equals the .sql file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrationsOn } from "../connection.js";
import { MIGRATIONS } from "../schema.js";
import { V2_CORE } from "./0020_v2_core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(HERE, "0020_v2_core.sql");

let dir: string;
let dbPath: string;
let db: Database.Database;

/** A fresh, EMPTY file db with the whole migration set applied. */
function openMigrated(): Database.Database {
  const handle = new Database(dbPath);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  runMigrationsOn(handle);
  return handle;
}

function tableNames(handle: Database.Database): Set<string> {
  return new Set(
    (
      handle
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
}

function objectType(handle: Database.Database, name: string): string | null {
  const row = handle
    .prepare(`SELECT type FROM sqlite_master WHERE name = ?`)
    .get(name) as { type: string } | undefined;
  return row?.type ?? null;
}

function columns(handle: Database.Database, table: string): string[] {
  return (
    handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

/** The SQL of the index on `table` whose name is `index`, as sqlite stored it. */
function indexSql(handle: Database.Database, name: string): string {
  const row = handle
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "st-0020-"));
  dbPath = join(dir, "supertwinv13.db");
  db = openMigrated();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. It applies, it is registered, and the two copies of the body agree.
// ---------------------------------------------------------------------------
describe("0020_v2_core applies", () => {
  it("is registered in MIGRATIONS and recorded once on a fresh db", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toContain("0022_v2_core");
    // Last of the REBUILDING migrations: the body ALTERs events and drops what
    // earlier ids created, so nothing that reshapes a table may precede it.
    // What follows it only ADDS to the schema it leaves behind — today that is
    // 0023_stream_tiers (build item 1.2), whose columns hang off `streams`,
    // which this migration is what creates, 0024_latency_marks (item 4.2), a
    // standalone table touching nothing the rebuild reshaped,
    // 0025_cache_write_split, four ADD COLUMNs, and 0026_runs_backfill, which
    // only copies rows between tables the ids above already created.
    expect(ids.slice(ids.indexOf("0022_v2_core") + 1)).toEqual([
      "0023_stream_tiers",
      "0024_latency_marks",
      "0025_cache_write_split",
      "0026_runs_backfill",
      // P0.4: the V13 substrate — ADD COLUMNs on events/streams/runs plus new
      // decisions/corrections/traces tables; reshapes nothing the ids above
      // created.
      "0100_v13_core",
      // P1.1: the V13 world model — drops the dead V11 episode/arc/loop
      // family (module code pruned in P0.3), recreates `episodes` with the
      // stream-scoped V13 shape, and adds spaces/chapters/tasks/claims-header/
      // tone_profiles/unsorted/second_look/space_index.
      "0101_world_model",
      // P1.2: the packer's content economy — digest cache, escalation log,
      // T2 review queue; new tables only.
      "0102_content_economy",
      // P1.8: enrichment bundle countdowns — one new table, reshapes nothing.
      "0103_enrichment_bundles",
      // P1.4: the Decide pass's per-space merge-in queue — new tables only.
      "0104_decide_consolidation",
      // P2.2: the assist lane's durable state — new tables only.
      "0105_assist",
      // P2.4: per-stream capture pause — one ADD COLUMN on streams.
      "0106_library_freshness",
      // P4.3: graduation metric ledger + T3 space links — new tables only.
      "0107_t3_graduation",
      // V6 P1 S0.5: drops sources.connected_at / sources.enabled (T4-13).
      "0108_prune_sources",
      // V6 S1.1: consents / archive / bundle_attempts / blobs, explicit
      // episode membership, `coverage` renamed to `coverage_progress` and
      // recreated as source × date range × status, ADD COLUMNs on events.
      "0200_v6_core",
      // V6 S2.1: walk indexes on entity_edges / edge_evidence, typed-field
      // ADD COLUMNs on claims, chunks + chunk_embeddings + hub_nodes (new
      // tables), the seeded self entity, and `people` redefined without self.
      "0201_v6_graph",
      // V6 S2.3: events.app/window_title/doc_key, events_fts over ten columns, chunks_fts.
      "0202_v6_fts_projection",
      // V6 P1 S3.7: the per-space card — ADD COLUMNs on spaces only.
      "0203_v6_space_card",
      // V6 P1 S5.3: the derived calendar — new tables only.
      "0204_v6_calendar",
      // V6 P1 S5.1: how a space was born + the enrichment ledger — ADD COLUMNs
      // on spaces and one new table.
      "0205_v6_spaces",
      // V6 P1 S5.4: role_resolutions + person_prefs — new tables only.
      "0206_v6_people",
    ]);

    expect(
      (
        db
          .prepare(`SELECT id FROM schema_migrations ORDER BY rowid`)
          .all() as { id: string }[]
      ).map((r) => r.id),
    ).toEqual(ids);
  });

  it("leaves the db structurally sound with every foreign key satisfied", () => {
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is a no-op the second time it runs", () => {
    const before = db
      .prepare(`SELECT count(*) AS n FROM schema_migrations`)
      .get() as { n: number };
    expect(() => runMigrationsOn(db)).not.toThrow();
    expect(
      (db.prepare(`SELECT count(*) AS n FROM schema_migrations`).get() as { n: number }).n,
    ).toBe(before.n);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("keeps the inlined body byte-identical to 0020_v2_core.sql", () => {
    // The .sql file is the one the build doc names and the one to edit; the TS
    // copy is what the esbuild bundle ships. If they drift, the app and the
    // repo run different schemas — which is the kind of bug that only shows up
    // in the packaged build.
    expect(V2_CORE.trim()).toBe(readFileSync(SQL_PATH, "utf8").trim());
  });

  it("says in the SQL that precedence never uses ingested_at", () => {
    const sql = readFileSync(SQL_PATH, "utf8");
    expect(sql).toMatch(/PRECEDENCE NEVER USES ingested_at/);
    // And the claims view must not be ordering by it behind the comment's back.
    const view = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'claims_active'`)
      .get() as { sql: string };
    expect(view.sql).not.toMatch(/ingested_at/);
    expect(view.sql).toMatch(/stated_at DESC/);
  });
});

// ---------------------------------------------------------------------------
// 2. Every table §6 / build-doc item 0.2 names.
// ---------------------------------------------------------------------------
const REQUIRED_TABLES = [
  "sources",
  "streams",
  "watermarks",
  "events",
  "events_fts",
  "event_embeddings",
  "cohorts",
  "work_queue",
  // `coverage` was renamed to `coverage_progress` by 0200_v6_core, which
  // reuses the name for the source × date-range index.
  "coverage_progress",
  "entities",
  "entity_identities",
  "entity_edges",
  "edge_evidence",
  "mentions",
  "resolution_decisions",
  "entity_embeddings",
  "embedder_calib",
  "sessions",
  // 0101_world_model recreated `episodes` with the V13 stream-scoped shape
  // and dropped the rest of the V11 derivation family (episode_sessions,
  // episode_verdicts, episode_embeddings, arcs, arc_episodes, arc_verdicts,
  // provisional_arcs, loops, loop_embeddings, goal_spaces).
  "episodes",
  "bridges",
  "claim_versions",
  "claim_embeddings",
  "goals",
  "evidence",
  "questions",
  "mutations",
  "runs",
  "quarantine",
] as const;

describe("0020_v2_core tables", () => {
  it("creates every table item 0.2 lists, and each one is queryable", () => {
    const names = tableNames(db);
    for (const t of REQUIRED_TABLES) {
      expect(names.has(t), `missing table: ${t}`).toBe(true);
      expect(() => db.prepare(`SELECT * FROM ${t} LIMIT 1`).all()).not.toThrow();
    }
  });

  it("carries the V13 spaces table, not the legacy ontology or arcs", () => {
    const names = tableNames(db);
    // 0101_world_model: spaces is back — as the V13 world model (spec §9),
    // not the pre-0022 legacy ontology, whose satellites stay gone.
    expect(names.has("spaces")).toBe(true);
    expect(columns(db, "spaces")).toEqual(
      expect.arrayContaining(["label", "life_area", "goal", "status", "exemplars_json"]),
    );
    for (const t of ["space_events", "milestones", "space_people", "arcs", "arc_episodes"]) {
      expect(names.has(t), `legacy table still present: ${t}`).toBe(false);
    }
  });

  it("rebuilds goals with its §6 shape, not the old space-scoped one", () => {
    const cols = columns(db, "goals");
    expect(cols).toEqual(
      expect.arrayContaining(["id", "name", "kind", "owner_id", "emerged_from_json"]),
    );
    expect(cols).not.toContain("space_id");
    expect(cols).not.toContain("recurring");
  });

  it("renames events.channel_id to stream_id and adds every V2 column", () => {
    const cols = columns(db, "events");
    for (const c of [
      "stream_id",
      "tz",
      "ingested_at",
      "salience",
      "enrichment_state",
      "enriched_at",
      "actor_entity_id",
      "is_self",
      "is_business",
    ]) {
      expect(cols, `events missing ${c}`).toContain(c);
    }
    // The V11 lifecycle columns survived the rebuild.
    for (const c of ["media_description", "link_scraped_text", "transcript", "is_historical"]) {
      expect(cols, `events lost ${c}`).toContain(c);
    }
    // stream_id must not have inherited the old FK to channels: the id space it
    // holds is `streams`, and item 1.1 is what makes the two one. A rename
    // alone would have kept it, and every V2 write would fail on it.
    const fks = db.prepare(`PRAGMA foreign_key_list(events)`).all() as {
      table: string;
      from: string;
    }[];
    expect(fks.map((f) => f.from)).not.toContain("stream_id");
    expect(fks.map((f) => f.table)).not.toContain("channels");
    // The ones §6 does want are still enforced.
    expect(fks.find((f) => f.from === "actor_entity_id")?.table).toBe("entities");
  });

  it("accepts a row in every table, through the real foreign keys", () => {
    seedGraph(db);
    for (const t of REQUIRED_TABLES) {
      if (t === "events_fts") continue; // virtual table, exercised separately
      const n = db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number };
      expect(n.n, `no row could be written to ${t}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. claims_active — the view that makes "which version is true" derived.
// ---------------------------------------------------------------------------
describe("claims_active", () => {
  const insertClaim = (
    handle: Database.Database,
    row: {
      id: string;
      key: string;
      text: string;
      statedAt: string;
      ingestedAt?: string;
      closedBy?: string | null;
      validTo?: string | null;
    },
  ): void => {
    handle
      .prepare(
        `INSERT INTO claim_versions (id, claim_key, kind, predicate, text, stated_at, ingested_at, closed_by, valid_to)
         VALUES (@id, @key, 'state', 'is', @text, @statedAt, @ingestedAt, @closedBy, @validTo)`,
      )
      .run({
        ingestedAt: "2026-01-01T00:00:00.000Z",
        closedBy: null,
        validTo: null,
        ...row,
      });
  };

  it("is a VIEW, not a table", () => {
    expect(objectType(db, "claims_active")).toBe("view");
    expect(tableNames(db).has("claims_active")).toBe(false);
  });

  it("returns exactly one row per claim_key: the latest stated_at", () => {
    insertClaim(db, { id: "c1", key: "diet", text: "eats meat", statedAt: "2026-01-01T00:00:00Z" });
    insertClaim(db, { id: "c2", key: "diet", text: "vegetarian", statedAt: "2026-03-01T00:00:00Z" });
    insertClaim(db, { id: "c3", key: "diet", text: "was vegan", statedAt: "2026-02-01T00:00:00Z" });
    insertClaim(db, { id: "c4", key: "city", text: "in Pune", statedAt: "2026-02-10T00:00:00Z" });

    const rows = db
      .prepare(`SELECT claim_key, id, text FROM claims_active ORDER BY claim_key`)
      .all() as { claim_key: string; id: string; text: string }[];

    expect(rows).toEqual([
      { claim_key: "city", id: "c4", text: "in Pune" },
      { claim_key: "diet", id: "c2", text: "vegetarian" },
    ]);
    // All four versions are still there. Nothing is deleted, ever.
    expect(
      (db.prepare(`SELECT count(*) AS n FROM claim_versions`).get() as { n: number }).n,
    ).toBe(4);
  });

  it("lets an older claim arrive LATE without dislodging the newer truth", () => {
    // Said in March, ingested first.
    insertClaim(db, {
      id: "new",
      key: "diet",
      text: "vegetarian",
      statedAt: "2026-03-01T00:00:00Z",
      ingestedAt: "2026-03-01T09:00:00Z",
    });
    // Said in January, ingested MONTHS later — a backfill catching up.
    insertClaim(db, {
      id: "old",
      key: "diet",
      text: "eats meat",
      statedAt: "2026-01-01T00:00:00Z",
      ingestedAt: "2026-06-01T09:00:00Z",
    });

    const rows = db.prepare(`SELECT id FROM claims_active`).all() as { id: string }[];
    // Ordering by ingested_at would have returned "old" here. It never does.
    expect(rows).toEqual([{ id: "new" }]);
  });

  it("skips closed versions and falls back to the newest one still open", () => {
    insertClaim(db, { id: "c1", key: "diet", text: "eats meat", statedAt: "2026-01-01T00:00:00Z" });
    insertClaim(db, {
      id: "c2",
      key: "diet",
      text: "vegetarian",
      statedAt: "2026-03-01T00:00:00Z",
      closedBy: "run_9",
    });

    expect(db.prepare(`SELECT id FROM claims_active`).all()).toEqual([{ id: "c1" }]);
  });

  it("drops a version whose validity window has closed", () => {
    insertClaim(db, {
      id: "expired",
      key: "job",
      text: "at Acme",
      statedAt: "2026-03-01T00:00:00Z",
      validTo: "2026-04-01T00:00:00Z", // in the past
    });
    insertClaim(db, {
      id: "standing",
      key: "job",
      text: "at Zeta",
      statedAt: "2026-02-01T00:00:00Z",
      validTo: "2099-01-01T00:00:00Z",
    });

    expect(db.prepare(`SELECT id FROM claims_active`).all()).toEqual([{ id: "standing" }]);
  });

  it("still returns one row when two versions were said at the same instant", () => {
    insertClaim(db, { id: "a", key: "diet", text: "one", statedAt: "2026-03-01T00:00:00Z" });
    insertClaim(db, { id: "b", key: "diet", text: "two", statedAt: "2026-03-01T00:00:00Z" });

    const rows = db.prepare(`SELECT id FROM claims_active`).all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("b"); // deterministic id tiebreak
  });

  it("returns one row per key across many keys and versions", () => {
    for (const key of ["k1", "k2", "k3"]) {
      for (let v = 0; v < 5; v += 1) {
        insertClaim(db, {
          id: `${key}-${v}`,
          key,
          text: `v${v}`,
          statedAt: `2026-0${v + 1}-01T00:00:00Z`,
        });
      }
    }
    const rows = db
      .prepare(`SELECT claim_key, id FROM claims_active ORDER BY claim_key`)
      .all() as { claim_key: string; id: string }[];
    expect(rows).toEqual([
      { claim_key: "k1", id: "k1-4" },
      { claim_key: "k2", id: "k2-4" },
      { claim_key: "k3", id: "k3-4" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The indices item 0.2 names, on the columns it names.
// ---------------------------------------------------------------------------
describe("0020_v2_core indices", () => {
  it("indexes work_queue by priority DESC, state", () => {
    expect(indexSql(db, "idx_work_queue_priority")).toMatch(
      /work_queue\(priority DESC, state\)/,
    );
  });

  it("indexes events by stream_id, ts", () => {
    expect(indexSql(db, "idx_events_stream_ts")).toMatch(/events\(stream_id, ts\)/);
  });

  it("indexes claim_versions by claim_key, stated_at DESC", () => {
    expect(indexSql(db, "idx_claim_versions_key")).toMatch(
      /claim_versions\(claim_key, stated_at DESC\)/,
    );
  });

  it("indexes spaces by status (0101 replaced the arcs index)", () => {
    expect(indexSql(db, "idx_spaces_status")).toMatch(/spaces\(status, updated_at\)/);
  });

  it("indexes bridges by kind, value_norm", () => {
    expect(indexSql(db, "idx_bridges_value")).toMatch(/bridges\(kind, value_norm\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. The events rebuild: what it must not have broken.
// ---------------------------------------------------------------------------
describe("the events rebuild", () => {
  it("keeps events_fts searchable through the re-created triggers", () => {
    db.prepare(`INSERT INTO events (id, ts, kind, text) VALUES ('e1', '2026-01-01T00:00:00Z', 'message', 'sunday brunch in bandra')`).run();
    const hit = db
      .prepare(
        `SELECT e.id AS id FROM events_fts f JOIN events e ON e.rowid = f.rowid
          WHERE events_fts MATCH 'brunch'`,
      )
      .all() as { id: string }[];
    expect(hit).toEqual([{ id: "e1" }]);

    // An update to an indexed column re-indexes...
    db.prepare(`UPDATE events SET text = 'sunday lunch in dadar' WHERE id = 'e1'`).run();
    expect(
      db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'brunch'`).all(),
    ).toEqual([]);
    expect(
      db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'dadar'`).all(),
    ).toHaveLength(1);

    // ...and a delete removes it.
    db.prepare(`DELETE FROM events WHERE id = 'e1'`).run();
    expect(
      db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'dadar'`).all(),
    ).toEqual([]);
  });

  it("mirrors the V11 channel_id bridge onto stream_id in both directions", () => {
    db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
    db.prepare(`INSERT INTO channels (id, source_id, name) VALUES ('c1', 'whatsapp', 'Fam')`).run();
    db.prepare(
      `INSERT INTO streams (id, source_id, external_key, label) VALUES ('st1', 'whatsapp', 'k1', 'Fam')`,
    ).run();

    // A V11 writer files channel_id only.
    db.prepare(
      `INSERT INTO events (id, source_id, channel_id, ts, kind, text)
       VALUES ('e-v11', 'whatsapp', 'c1', '2026-01-01T00:00:00Z', 'message', 'hi')`,
    ).run();
    expect(db.prepare(`SELECT stream_id FROM events WHERE id = 'e-v11'`).get()).toEqual({
      stream_id: "c1",
    });

    // A V2 writer files stream_id only, against a real streams row.
    db.prepare(
      `INSERT INTO events (id, source_id, stream_id, ts, kind, text)
       VALUES ('e-v2', 'whatsapp', 'st1', '2026-01-02T00:00:00Z', 'message', 'yo')`,
    ).run();
    expect(db.prepare(`SELECT channel_id FROM events WHERE id = 'e-v2'`).get()).toEqual({
      channel_id: "st1",
    });
  });

  it("keeps event_embeddings rows across the rebuild", () => {
    // Re-run the whole set against a db that already holds an event + its
    // vector: the rebuild drops `events` for a moment, and the implicit delete
    // cascades unless the rows are staged out and put back.
    db.prepare(`INSERT INTO events (id, ts, kind, text) VALUES ('e1','2026-01-01T00:00:00Z','message','x')`).run();
    db.prepare(
      `INSERT INTO event_embeddings (event_id, model, dim, vector)
       VALUES ('e1', 'multilingual-e5-small', 2, x'0000803f0000003f')`,
    ).run();

    // Forget 0020 was applied, then apply it again over the populated db.
    db.prepare(`DELETE FROM schema_migrations WHERE id = '0022_v2_core'`).run();
    runMigrationsOn(db);

    expect(db.prepare(`SELECT event_id FROM event_embeddings`).all()).toEqual([
      { event_id: "e1" },
    ]);
    expect(db.prepare(`SELECT id FROM events`).all()).toEqual([{ id: "e1" }]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

/**
 * One row in every V2 table, written in dependency order through the real
 * foreign keys. If a FK is pointed at the wrong parent, or a NOT NULL column
 * has no writer, this is where it shows.
 */
function seedGraph(handle: Database.Database): void {
  const run = (sql: string): void => {
    handle.prepare(sql).run();
  };

  run(`INSERT INTO sources (id, type, display_name, mode) VALUES ('whatsapp','whatsapp','WhatsApp','bootstrap')`);
  run(`INSERT INTO streams (id, source_id, external_key, label, stream_kind, tz)
       VALUES ('st1','whatsapp','918888@s.whatsapp.net','Family','group','Asia/Kolkata')`);
  run(`INSERT INTO watermarks (stream_id, live_high_ts, backfill_complete)
       VALUES ('st1','2026-01-01T00:00:00Z',0)`);

  run(`INSERT INTO entities (id, type, canonical) VALUES ('en-self','person','Me')`);
  run(`INSERT INTO entities (id, type, canonical) VALUES ('en-ma','person','Ma')`);
  run(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm, confidence, decided_by)
       VALUES ('ei1','en-ma','whatsapp','jid','919999@s.whatsapp.net',0.98,'code')`);
  run(`INSERT INTO entity_edges (id, kind, src_entity_id, dst_entity_id, confidence, decided_by, status)
       VALUES ('ed1','family_of','en-self','en-ma',0.95,'model','active')`);

  run(`INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state, actor_entity_id, ingested_at)
       VALUES ('ev1','whatsapp','st1','2026-01-01T09:00:00Z','Asia/Kolkata','message','call the plumber',0,'none_needed','en-ma','2026-01-01T09:00:01Z')`);
  run(`INSERT INTO event_embeddings (event_id, model, dim, vector)
       VALUES ('ev1','multilingual-e5-small',2,x'0000803f0000003f')`);
  run(`INSERT INTO edge_evidence (edge_id, event_id, quote) VALUES ('ed1','ev1','call the plumber')`);
  run(`INSERT INTO mentions (id, event_id, span_start, span_end, surface_text, entity_id, confidence, decided_by)
       VALUES ('mn1','ev1',0,4,'call','en-ma',0.7,'model')`);
  run(`INSERT INTO resolution_decisions (id, left_id, right_id, verdict, decided_by)
       VALUES ('rd1','en-ma','en-self','different','model')`);
  run(`INSERT INTO entity_embeddings (entity_id, vec, model, dim)
       VALUES ('en-ma', x'0000803f', 'multilingual-e5-small', 1)`);
  run(`INSERT INTO embedder_calib (model, use_case, floor, n_pairs)
       VALUES ('multilingual-e5-small','entity',0.82,240)`);

  run(`INSERT INTO cohorts (id, source_id, mode, horizon, seq, priority, state)
       VALUES ('co1','whatsapp','bootstrap','h24',1,90,'planned')`);
  run(`INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
       VALUES ('wq1','event','ev1','co1','enrich',90,'ready')`);
  run(`INSERT INTO coverage_progress (scope_kind, scope_id, horizon, total_units, done_units)
       VALUES ('stream','st1','h24',10,3)`);

  run(`INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, tz, status, seal_mode,
                             boundary_reason_start, boundary_reason_end, hash_version, content_hash)
       VALUES ('se1','st1','whatsapp','2026-01-01T09:00:00Z','2026-01-01T09:40:00Z','Asia/Kolkata',
               'sealed','debounce','stream_start','gap','v1','h1')`);
  // 0101_world_model: episodes carry the V13 stream-scoped shape; the V11
  // episode/arc satellite tables are gone.
  run(`INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts, created_by)
       VALUES ('ep1','st1','open','plumber to be called','2026-01-01T09:00:00Z','2026-01-01T09:40:00Z','orient')`);
  run(`INSERT INTO bridges (id, kind, value_norm, left_kind, left_id, right_kind, right_id, confidence, decided_by)
       VALUES ('br1','order_id','AZ-1','event','ev1','episode','ep1',1.0,'code')`);

  run(`INSERT INTO claim_versions (id, claim_key, kind, subject_id, predicate, object, text,
                                   speaker_id, attribution, party_pair, confidence, stated_at, ingested_at, decided_by)
       VALUES ('cv1','ma:diet','state','en-ma','diet','vegetarian','ma is vegetarian',
               'en-ma','self','ss',0.9,'2026-01-01T09:00:00Z','2026-01-01T09:00:01Z','model')`);
  run(`INSERT INTO claim_embeddings (claim_id, vec, model, dim)
       VALUES ('cv1', x'0000803f', 'multilingual-e5-small', 1)`);

  run(`INSERT INTO goals (id, name, kind, owner_id, emerged_from_json)
       VALUES ('go1','Keep the house standing','standing','en-self','["ar1"]')`);

  run(`INSERT INTO evidence (subject_kind, subject_id, event_id, episode_id, quote)
       VALUES ('claim','cv1','ev1','ep1','call the plumber')`);
  run(`INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES ('qu1','disambiguate','entity','en-ma','Is Ma the same person as Amma?','["yes","no"]','open')`);
  run(`INSERT INTO mutations (id, actor, run_id, target_kind, target_id, field, old_json, new_json, reason)
       VALUES ('mu1','code','run1','arc','ar1','promoted','false','true','commitment density')`);
  run(`INSERT INTO runs (id, kind, role, model, cohort_id, started_at, status, input_tokens, output_tokens, billable_tokens, cost_usd)
       VALUES ('run1','understand','P-EP','haiku','co1','2026-01-01T09:05:00Z','ok',1200,300,1500,0.0021)`);
  run(`INSERT INTO quarantine (id, unit_kind, unit_id, cohort_id, run_id, error_code, last_error, attempts)
       VALUES ('qa1','session','se1','co1','run1','wire_violation','tag T missing',2)`);
}
