// ===========================================================================
// Promotion against the real schema (§11.3, item 3.6).
//
//   P-026..P-030  demotion is a FIELD FLIP: no row deleted, id unchanged
//   P-049         the archetype transition is recorded with a reason
//   P-050         promotion_reason lands on the row and is readable back
//
// The point of this file is the thing that can only be proven against SQLite:
// there is no `spaces` table, and there never was one to drop.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { ensureMeEntity } from "../entities/binding.js";
import { mutationsFor } from "../entities/merge.js";
import {
  PROMOTION_FIELDS,
  applyPromotionVerdict,
  pinArc,
  promoteArcs,
  readPromotionInput,
  readSpaces,
  setArchetype,
  setUserLabel,
  unpinArc,
} from "./promote-store.js";
import { promotionVerdict } from "./promote.js";

const NOW = "2026-08-16T12:00:00.000Z";
const DAY = 86_400_000;

let tmpDir: string;
let me: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-promote-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  me = ensureMeEntity();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function entity(id: string, type = "thing"): string {
  getDb()
    .prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`)
    .run(id, type, id);
  return id;
}

function arc(id: string, opts: { anchors?: string[]; last?: string; pinned?: boolean } = {}): string {
  getDb()
    .prepare(
      `INSERT INTO arcs (id, arc_key, label, anchor_entity_ids, state, last_evidence_at, user_pinned)
       VALUES (?, ?, ?, ?, 'live', ?, ?)`,
    )
    .run(id, `key_${id}`, id, JSON.stringify(opts.anchors ?? []), opts.last ?? NOW, opts.pinned ? 1 : 0);
  return id;
}

function loop(id: string, arcId: string, state: string, owner: string, counterparty: string): void {
  getDb()
    .prepare(
      `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, state, arc_id, stated_at)
       VALUES (?, ?, 'do the thing', 'explicit', ?, ?, ?, ?, ?)`,
    )
    .run(id, `lk_${id}`, owner, counterparty, state, arcId, NOW);
}

function episode(id: string, arcId: string, startedAt: string, entityIds: string[]): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO episodes (id, source_id, topic_label, entity_ids, started_at, ended_at)
     VALUES (?, 'whatsapp', ?, ?, ?, ?)`,
  ).run(id, id, JSON.stringify(entityIds), startedAt, startedAt);
  db.prepare(`INSERT INTO arc_episodes (arc_id, episode_id, added_by) VALUES (?, ?, 'test')`).run(arcId, id);
}

function edge(kind: string, dst: string): void {
  getDb()
    .prepare(
      `INSERT INTO entity_edges (id, kind, src_entity_id, dst_entity_id, status)
       VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(`edge_${kind}_${dst}`, kind, me, dst);
}

function row(id: string): Record<string, unknown> {
  return getDb().prepare(`SELECT * FROM arcs WHERE id = ?`).get(id) as Record<string, unknown>;
}

// ---- there is no spaces table ---------------------------------------------

describe("no `spaces` table", () => {
  it("the schema has arcs and nothing that shadows it", () => {
    const names = (
      getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("arcs");
    expect(names).not.toContain("spaces");
  });

  it("every promotion field lives on arcs", () => {
    const cols = (getDb().prepare(`PRAGMA table_info(arcs)`).all() as { name: string }[]).map((c) => c.name);
    for (const field of PROMOTION_FIELDS) expect(cols).toContain(field);
  });
});

// ---- the routes, read out of the schema ------------------------------------

describe("routes read from the real tables", () => {
  it("cmt — an open loop of mine promotes the arc", () => {
    const other = entity("ent_a1", "person");
    arc("arc_cmt");
    loop("l1", "arc_cmt", "open", me, other);
    const sweep = promoteArcs({ now: NOW });
    expect(sweep.promoted).toBe(1);
    expect(row("arc_cmt")).toMatchObject({ promoted: 1, promotion_reason: "cmt", status: "active" });
  });

  it("ref — a `located_at` edge from me to my flat, with no loops at all", () => {
    entity("ent_flat", "place");
    arc("arc_flat", { anchors: ["ent_flat"] });
    edge("located_at", "ent_flat");
    promoteArcs({ now: NOW });
    expect(row("arc_flat")).toMatchObject({ promoted: 1, promotion_reason: "ref", archetype: "hld" });
  });

  it("rec — four episodes I took part in, over a month", () => {
    arc("arc_rec");
    for (let i = 0; i < 4; i += 1) {
      episode(`ep${i}`, "arc_rec", new Date(Date.parse(NOW) - (28 - i * 7) * DAY).toISOString(), [me, "ent_a1"]);
    }
    promoteArcs({ now: NOW });
    expect(row("arc_rec")).toMatchObject({ promoted: 1, promotion_reason: "rec" });
  });

  it("usr — a pin promotes and an unpin demotes, both as field flips", () => {
    arc("arc_pin");
    const pinned = pinArc("arc_pin");
    expect(pinned.verdict.promotionReason).toBe("usr");
    expect(row("arc_pin")).toMatchObject({ promoted: 1, promotion_reason: "usr", user_pinned: 1 });

    unpinArc("arc_pin");
    expect(row("arc_pin")).toMatchObject({ promoted: 0, promotion_reason: null, user_pinned: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arcs WHERE id = 'arc_pin'`).get()).toEqual({ n: 1 });
  });
});

// ---- P-026..P-030 ----------------------------------------------------------

describe("demotion is a field flip (P-026..P-030)", () => {
  it("all loops resolved → status archived, id unchanged, row retained", () => {
    const other = entity("ent_a1", "person");
    arc("arc_x");
    loop("l1", "arc_x", "open", me, other);
    promoteArcs({ now: NOW });
    const before = row("arc_x");
    expect(before.status).toBe("active");

    getDb().prepare(`UPDATE loops SET state = 'done' WHERE id = 'l1'`).run();
    promoteArcs({ now: NOW });
    const after = row("arc_x");
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("archived");
    expect(after.promoted).toBe(1);
    expect(after.promotion_reason).toBe("cmt");
    // still retrievable
    expect(readSpaces({ includeArchived: true }).map((s) => s.id)).toContain("arc_x");
    // …and not surfaced
    expect(readSpaces().map((s) => s.id)).not.toContain("arc_x");
  });

  it("no row is ever deleted by a demotion", () => {
    arc("arc_p", { pinned: true });
    promoteArcs({ now: NOW });
    const count = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM arcs`).get() as { n: number }).n;
    expect(count()).toBe(1);
    unpinArc("arc_p");
    expect(count()).toBe(1);
    expect(row("arc_p").promoted).toBe(0);
  });

  it("every flip leaves a mutations row", () => {
    arc("arc_m", { pinned: true });
    promoteArcs({ now: NOW, runId: "run1" });
    const fields = mutationsFor("arc", "arc_m").map((m) => m.field);
    expect(fields).toContain("promoted");
    expect(fields).toContain("promotion_reason");
    expect(mutationsFor("arc", "arc_m").find((m) => m.field === "promoted")?.reason).toBe("promoted via usr");
  });

  it("a second sweep over unchanged evidence writes nothing", () => {
    arc("arc_i", { pinned: true });
    promoteArcs({ now: NOW });
    const before = mutationsFor("arc", "arc_i").length;
    const again = promoteArcs({ now: NOW });
    expect(again.applied.every((a) => a.changes.length === 0)).toBe(true);
    expect(mutationsFor("arc", "arc_i")).toHaveLength(before);
  });
});

// ---- the party wall, in the database ---------------------------------------

describe("party rule against the schema", () => {
  it("an arc of somebody else's loops is never promoted, however much evidence", () => {
    const a1 = entity("ent_a1", "person");
    const a2 = entity("ent_a2", "person");
    entity("ent_theirs");
    arc("arc_theirs", { anchors: ["ent_theirs"], pinned: true });
    edge("has", "ent_theirs");
    loop("t1", "arc_theirs", "open", a1, a2);
    loop("t2", "arc_theirs", "open", a2, a1);
    for (let i = 0; i < 5; i += 1) {
      episode(`te${i}`, "arc_theirs", new Date(Date.parse(NOW) - (35 - i * 7) * DAY).toISOString(), [a1, a2]);
    }
    const sweep = promoteArcs({ now: NOW });
    expect(sweep.blockedByParty).toBe(1);
    expect(sweep.promoted).toBe(0);
    expect(row("arc_theirs").promoted).toBe(0);
    expect(readSpaces()).toHaveLength(0);
  });
});

// ---- archetype -------------------------------------------------------------

describe("archetype on the row (P-049)", () => {
  it("a revision records the transition with a reason", () => {
    arc("arc_g", { pinned: true });
    promoteArcs({ now: NOW });
    setArchetype("arc_g", "pur", "model", "self-directed recurring activity");
    const write = setArchetype("arc_g", "prj", "model", "a recital date was set");
    expect(write.changed).toBe(true);
    expect(row("arc_g")).toMatchObject({ archetype: "prj", archetype_source: "model" });
    const m = mutationsFor("arc", "arc_g").filter((x) => x.field === "archetype");
    expect(m.at(-1)).toMatchObject({ oldValue: "pur", newValue: "prj", reason: "a recital date was set" });
  });

  it("the code default never overwrites a model or user choice on a later sweep", () => {
    entity("ent_flat", "place");
    arc("arc_h", { anchors: ["ent_flat"] });
    edge("located_at", "ent_flat");
    promoteArcs({ now: NOW });
    expect(row("arc_h").archetype).toBe("hld");
    setArchetype("arc_h", "adm", "user", "it is really a bill");
    promoteArcs({ now: NOW });
    expect(row("arc_h")).toMatchObject({ archetype: "adm", archetype_source: "user" });
  });
});

// ---- reads -----------------------------------------------------------------

describe("the Spaces view is a filter over arcs (P-050)", () => {
  it("carries the recorded reason so 'why a space?' answers", () => {
    const other = entity("ent_a1", "person");
    arc("arc_v");
    loop("l1", "arc_v", "open", me, other);
    promoteArcs({ now: NOW });
    setUserLabel("arc_v", "The move");
    const spaces = readSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: "arc_v", promotionReason: "cmt", status: "active", userLabel: "The move" });
  });

  it("a dry run computes without touching the row", () => {
    arc("arc_d", { pinned: true });
    const sweep = promoteArcs({ now: NOW, dryRun: true });
    expect(sweep.promoted).toBe(1);
    expect(sweep.applied).toHaveLength(0);
    expect(row("arc_d").promoted).toBe(0);
  });

  it("readPromotionInput assembles the arc from the tables that hold it", () => {
    const other = entity("ent_a1", "person");
    entity("ent_flat", "place");
    arc("arc_r", { anchors: ["ent_flat"] });
    edge("has", "ent_flat");
    loop("l1", "arc_r", "latent", me, other);
    episode("e1", "arc_r", NOW, [me, other]);
    const input = readPromotionInput("arc_r", { now: NOW })!;
    expect(input.loops).toHaveLength(1);
    expect(input.episodes).toHaveLength(1);
    expect(input.episodes![0]!.selfParticipated).toBe(true);
    expect(input.selfEdges).toHaveLength(1);
    const v = promotionVerdict(input);
    expect(v.promoted).toBe(true);
    expect(v.status).toBe("dormant");
    applyPromotionVerdict(v);
    expect(row("arc_r").status).toBe("dormant");
  });
});
