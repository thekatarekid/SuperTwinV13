// ===========================================================================
// The spaces cap and the space audits (Phase 3 gate, §14.3 rows 10–11).
//
//   * `applySpacesCap` — total live spaces ≤ 45; pinned spaces are user
//     constraints and are never evicted; eviction is the same field flip as
//     any demotion.
//   * `auditSpaceJustifications` / `spaceJustificationRate` — ">90% holding a
//     live loop or a reference anchor", re-derived from the tables.
//   * `auditSpaceLabels` / `anchorlessLabelRate` — §14.2's labels row.
//
// The cap tests are pure (verdicts in, verdicts out); the audit tests run
// against the real schema, because the audits exist to distrust the verdict.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { ensureMeEntity } from "../entities/binding.js";
import {
  SPACES_LIVE_CAP,
  anchorlessLabelRate,
  applySpacesCap,
  auditSpaceJustifications,
  auditSpaceLabels,
  spaceJustificationRate,
} from "./constraints.js";
import { evaluateRoutes, type PromotionRoute, type PromotionVerdict } from "./promote.js";

const NOW = "2026-08-16T12:00:00.000Z";
const DAY = 86_400_000;

function at(daysAgo: number): string {
  return new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
}

/** A minimal but honest verdict — evidence comes from the real evaluator. */
function verdict(arcId: string, routes: PromotionRoute[], status: "active" | "archived" | null = "active"): PromotionVerdict {
  const promoted = routes.length > 0;
  return {
    arcId,
    promoted,
    promotionReason: routes[0] ?? null,
    routes,
    evidence: evaluateRoutes({ arcId }),
    status: promoted ? status : null,
    statusReason: promoted ? "open_loop" : null,
    party: { pairs: [], involvesSelf: false, blocked: false, reason: "no_loops", livesOn: "thread" },
    livesOn: promoted ? "space" : "thread",
    archetype: null,
    archetypeSource: null,
    archetypeRule: null,
    cadence: null,
    endsAt: null,
    demoted: false,
    retained: false,
  };
}

describe("applySpacesCap", () => {
  it("is 45 — the Phase 3 gate's number, not a knob that drifted", () => {
    expect(SPACES_LIVE_CAP).toBe(45);
  });

  it("leaves a population at or under the cap untouched", () => {
    const verdicts = Array.from({ length: 45 }, (_, i) => verdict(`a${i}`, ["cmt"]));
    const out = applySpacesCap(verdicts, new Map());
    expect(out.filter((v) => v.promoted)).toHaveLength(45);
    expect(out).toEqual(verdicts);
  });

  it("evicts the stalest beyond the cap, and eviction is a demotion", () => {
    const last = new Map<string, string | null>();
    const verdicts = Array.from({ length: 48 }, (_, i) => {
      last.set(`a${i}`, at(i)); // a0 freshest … a47 stalest
      return verdict(`a${i}`, ["cmt"]);
    });
    const out = applySpacesCap(verdicts, last);
    const live = out.filter((v) => v.promoted);
    expect(live).toHaveLength(45);
    const evicted = out.filter((v) => !v.promoted);
    expect(evicted.map((v) => v.arcId).sort()).toEqual(["a45", "a46", "a47"]);
    for (const v of evicted) {
      expect(v.demoted).toBe(true);
      expect(v.promotionReason).toBeNull();
      expect(v.livesOn).toBe("thread");
      expect(v.evidence.cmt.detail).toContain("beyond the 45 live spaces cap");
    }
  });

  it("evicts weaker justification before stronger, whatever the clock says", () => {
    const last = new Map<string, string | null>([
      ["rec1", at(0)], // freshest, but recurrence-only
      ["cmt1", at(30)],
      ["cmt2", at(30)],
    ]);
    const out = applySpacesCap(
      [verdict("rec1", ["rec"]), verdict("cmt1", ["cmt"]), verdict("cmt2", ["cmt"])],
      last,
      2,
    );
    expect(out.find((v) => v.arcId === "rec1")?.promoted).toBe(false);
    expect(out.find((v) => v.arcId === "cmt1")?.promoted).toBe(true);
    expect(out.find((v) => v.arcId === "cmt2")?.promoted).toBe(true);
  });

  it("never evicts a pinned space — a pin is a user constraint", () => {
    const out = applySpacesCap(
      [verdict("usr1", ["usr"]), verdict("usr2", ["usr"]), verdict("cmt1", ["cmt"]), verdict("cmt2", ["cmt"])],
      new Map(),
      2,
    );
    expect(out.find((v) => v.arcId === "usr1")?.promoted).toBe(true);
    expect(out.find((v) => v.arcId === "usr2")?.promoted).toBe(true);
    expect(out.filter((v) => v.promoted)).toHaveLength(2);
  });

  it("holds even when pins alone exceed the cap — no evidence overrules a person", () => {
    const out = applySpacesCap(
      [verdict("usr1", ["usr"]), verdict("usr2", ["usr"]), verdict("usr3", ["usr"])],
      new Map(),
      2,
    );
    expect(out.filter((v) => v.promoted)).toHaveLength(3);
  });

  it("does not count archived spaces against the cap", () => {
    const verdicts = [
      ...Array.from({ length: 45 }, (_, i) => verdict(`a${i}`, ["cmt"])),
      verdict("old1", ["cmt"], "archived"),
      verdict("old2", ["cmt"], "archived"),
    ];
    const out = applySpacesCap(verdicts, new Map());
    expect(out.filter((v) => v.promoted)).toHaveLength(47);
  });
});

// ---- the audits, against the real schema -----------------------------------

let tmpDir: string;
let me: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-constraints-"));
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

function entity(id: string, canonical: string, type = "thing"): string {
  getDb()
    .prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`)
    .run(id, type, canonical);
  return id;
}

function space(
  id: string,
  opts: { label?: string; anchors?: string[]; status?: string; promoted?: boolean } = {},
): string {
  getDb()
    .prepare(
      `INSERT INTO arcs (id, arc_key, label, anchor_entity_ids, state, last_evidence_at,
                         promoted, promotion_reason, status)
       VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
    )
    .run(
      id,
      `key_${id}`,
      opts.label ?? id,
      JSON.stringify(opts.anchors ?? []),
      NOW,
      opts.promoted === false ? 0 : 1,
      opts.promoted === false ? null : "cmt",
      opts.status ?? "active",
    );
  return id;
}

function openLoop(id: string, arcId: string): void {
  getDb()
    .prepare(
      `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, state, arc_id, stated_at)
       VALUES (?, ?, 'do the thing', 'explicit', ?, ?, 'open', ?, ?)`,
    )
    .run(id, `lk_${id}`, me, me, arcId, NOW);
}

function edge(kind: string, dst: string): void {
  getDb()
    .prepare(
      `INSERT INTO entity_edges (id, kind, src_entity_id, dst_entity_id, status)
       VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(`edge_${kind}_${dst}`, kind, me, dst);
}

describe("promoteArcs enforces the cap end to end", () => {
  it("a sweep over 48 qualifying arcs surfaces exactly 45 spaces", async () => {
    const { promoteArcs, readSpaces } = await import("./promote-store.js");
    for (let i = 0; i < 48; i += 1) {
      getDb()
        .prepare(
          `INSERT INTO arcs (id, arc_key, label, anchor_entity_ids, state, last_evidence_at)
           VALUES (?, ?, ?, '[]', 'live', ?)`,
        )
        .run(`a${String(i).padStart(2, "0")}`, `key_a${i}`, `arc ${i}`, at(i));
      openLoop(`l${i}`, `a${String(i).padStart(2, "0")}`);
    }
    const sweep = promoteArcs({ now: NOW });
    expect(sweep.promoted).toBe(45);
    expect(readSpaces()).toHaveLength(45);
    // The three stalest went back to being threads — rows intact, ids unchanged.
    const total = getDb().prepare(`SELECT COUNT(*) AS n FROM arcs`).get() as { n: number };
    expect(total.n).toBe(48);
  });
});

describe("auditSpaceJustifications", () => {
  it("reads justification off loops and edges rows, not off promotion_reason", () => {
    space("s_loop");
    openLoop("l1", "s_loop");
    entity("ent_flat", "flat", "place");
    edge("located_at", "ent_flat");
    space("s_ref", { anchors: ["ent_flat"] });
    space("s_bare"); // promoted, reason stamped, but nothing justifies it

    const audits = auditSpaceJustifications();
    expect(audits.find((a) => a.arcId === "s_loop")).toMatchObject({ liveLoop: true, justified: true });
    expect(audits.find((a) => a.arcId === "s_ref")).toMatchObject({ referenceAnchor: true, justified: true });
    expect(audits.find((a) => a.arcId === "s_bare")).toMatchObject({ justified: false });
    expect(spaceJustificationRate()).toBeCloseTo(2 / 3);
  });

  it("skips archived and unpromoted arcs, and reports null on an empty world", () => {
    expect(spaceJustificationRate()).toBeNull();
    space("gone", { status: "archived" });
    space("thread", { promoted: false });
    expect(spaceJustificationRate()).toBeNull();
  });
});

describe("auditSpaceLabels", () => {
  it("flags a label that names none of its anchors", () => {
    entity("ent_flat", "flat", "place");
    entity("ent_car", "car");
    space("good", { label: "The Indiranagar flat", anchors: ["ent_flat"] });
    space("bad", { label: "Misc chat", anchors: ["ent_car"] });
    space("unanchored", { label: "Whatever" }); // no anchors → not in the denominator

    const audits = auditSpaceLabels();
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.arcId === "good")?.anchorless).toBe(false);
    expect(audits.find((a) => a.arcId === "bad")?.anchorless).toBe(true);
    expect(anchorlessLabelRate()).toBeCloseTo(0.5);
  });

  it("prefers the user's label — their word for the space wins", () => {
    entity("ent_car", "car");
    space("s1", { label: "car errands", anchors: ["ent_car"] });
    getDb().prepare(`UPDATE arcs SET user_label = 'Random stuff' WHERE id = 's1'`).run();
    expect(auditSpaceLabels()[0]?.anchorless).toBe(true);
  });

  it("reports null when no live space has a named anchor", () => {
    expect(anchorlessLabelRate()).toBeNull();
    space("s1", { label: "loose" });
    expect(anchorlessLabelRate()).toBeNull();
  });
});
