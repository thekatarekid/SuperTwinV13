// ===========================================================================
// surface-router.v1 (V6 P1 S4.3). The pure decision is asserted directly; the
// world-reading half runs against a sandboxed database. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifact } from "./artifacts.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { BLOCKED_KINDS_KEY, CARD_DURATION_S_KEY, MERGE_WINDOW_S_KEY } from "../settings/p1-settings.js";
import {
  autoCloseCard,
  cardLine,
  DECAY_ORDER,
  decayIndex,
  DURABLE_SURFACES,
  kindDismissals,
  macActive,
  MAC_ACTIVE_WINDOW_MS,
  markCardShown,
  mergeGroups,
  noteNotNow,
  notNowCard,
  nudgeView,
  openCard,
  routeNow,
  routeSurfaces,
  unreadCount,
  withheldCount,
  wrongGoalCards,
  type RoutableItem,
  type RouterContext,
} from "./router.js";

const NOW = Date.parse("2026-09-05T10:40:00.000Z");

function ctx(over: Partial<RouterContext> = {}): RouterContext {
  return {
    nowMs: NOW,
    macActive: true,
    intentFloor: 0.6,
    mergeWindowMs: 120_000,
    cardDurationMs: 60_000,
    blockedKinds: [],
    dismissals: {},
    spaceLabels: {},
    ...over,
  };
}

function item(over: Partial<RoutableItem> & { id: string }): RoutableItem {
  return {
    kind: "help_now",
    spaceId: null,
    intent: "intent",
    intentConfidence: 0.9,
    line: "did a thing",
    peek: null,
    readyAtMs: NOW,
    ...over,
  };
}

describe("the decay order is the doc's order", () => {
  it("lists the six kinds in the order their value dies", () => {
    expect(DECAY_ORDER).toEqual([
      "help_now",
      "needs_you",
      "something_moved",
      "done_for_you",
      "done_in_advance",
      "understanding",
    ]);
    expect(decayIndex("help_now")).toBe(0);
    expect(decayIndex("claims_extracted")).toBe(DECAY_ORDER.length);
  });
});

describe("presence decides the card and nothing else", () => {
  it("mac active: card on top of every durable surface", () => {
    const plan = routeSurfaces([item({ id: "a1", spaceId: "sp_goa" })], ctx());
    expect(plan.presence).toBe("mac_active");
    expect(plan.items[0]!.surfaces).toEqual(["card", ...DURABLE_SURFACES]);
    expect(plan.current?.id).toBe("a1");
    expect(plan.withheld).toBe(0);
  });

  it("away: the same durable surfaces, minus the card — nothing withheld", () => {
    const items = [item({ id: "a1", spaceId: "sp_goa" })];
    const active = routeSurfaces(items, ctx({ macActive: true }));
    const away = routeSurfaces(items, ctx({ macActive: false }));
    expect(away.presence).toBe("away");
    expect(away.items[0]!.surfaces).toEqual([...DURABLE_SURFACES]);
    expect(away.current).toBeNull();
    expect(withheldCount(active, away)).toBe(0);
  });
});

describe("merge per space", () => {
  it("chains items inside the merge window into one card, one line each", () => {
    const groups = mergeGroups(
      [
        item({ id: "a1", spaceId: "sp_goa_dec", line: "villa comparison", readyAtMs: NOW }),
        item({ id: "a2", spaceId: "sp_goa_dec", line: "Karan replied", readyAtMs: NOW + 120_000, kind: "something_moved" }),
        item({ id: "a3", spaceId: "sp_goa_dec", line: "fare dropped", readyAtMs: NOW + 240_000, kind: "something_moved" }),
      ],
      120_000,
    );
    expect(groups).toHaveLength(1);
    expect(cardLine(groups[0]!.members)).toBe("villa comparison · Karan replied · fare dropped");
    // The lead is the most urgent kind in the group.
    expect(groups[0]!.lead.id).toBe("a1");
  });

  it("never merges across spaces, and never merges the spaceless", () => {
    const groups = mergeGroups(
      [
        item({ id: "a1", spaceId: "sp_goa" }),
        item({ id: "a2", spaceId: "sp_falcon" }),
        item({ id: "a3", spaceId: null }),
        item({ id: "a4", spaceId: null }),
      ],
      600_000,
    );
    expect(groups).toHaveLength(4);
  });

  it("breaks the chain on a gap larger than the window", () => {
    const groups = mergeGroups(
      [
        item({ id: "a1", spaceId: "sp_goa", readyAtMs: NOW }),
        item({ id: "a2", spaceId: "sp_goa", readyAtMs: NOW + 400_000 }),
      ],
      120_000,
    );
    expect(groups).toHaveLength(2);
  });

  it("titles the merged card with the space label", () => {
    const plan = routeSurfaces(
      [
        item({ id: "a1", spaceId: "sp_goa_dec", line: "villa comparison" }),
        item({ id: "a2", spaceId: "sp_goa_dec", line: "Karan replied", readyAtMs: NOW + 60_000, kind: "something_moved" }),
      ],
      ctx({ spaceLabels: { sp_goa_dec: "Goa trip" } }),
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.current?.card?.title).toBe("Goa trip");
    expect(plan.current?.card?.line).toBe("villa comparison · Karan replied");
    expect(plan.current?.mergedWith).toEqual(["a2"]);
  });
});

describe("decay order ranks the pending set", () => {
  it("shows help-with-now, then needs-you, then done-for-you", () => {
    const plan = routeSurfaces(
      [
        item({ id: "done", kind: "done_for_you", readyAtMs: Date.parse("2026-09-05T10:00:00.000Z") }),
        item({ id: "help", kind: "help_now", readyAtMs: Date.parse("2026-09-05T10:02:00.000Z") }),
        item({ id: "needs", kind: "needs_you", readyAtMs: Date.parse("2026-09-05T09:58:00.000Z") }),
      ],
      ctx(),
    );
    expect(plan.items.map((p) => p.id)).toEqual(["help", "needs", "done"]);
    expect(plan.current?.id).toBe("help");
    // One card at a time: the other two are on their durable surfaces already.
    expect(plan.items[1]!.surfaces).toEqual([...DURABLE_SURFACES]);
    expect(plan.items[1]!.reason).toBe("queued_behind");
  });

  it("orders newest first inside one kind", () => {
    const plan = routeSurfaces(
      [
        item({ id: "old", kind: "needs_you", readyAtMs: NOW - 60_000 }),
        item({ id: "new", kind: "needs_you", readyAtMs: NOW }),
      ],
      ctx(),
    );
    expect(plan.items.map((p) => p.id)).toEqual(["new", "old"]);
  });
});

describe("housekeeping stays inside", () => {
  it("routes a non-kind to Recent understanding and nowhere else", () => {
    const plan = routeSurfaces(
      [item({ id: "hk", kind: "claims_extracted" }), item({ id: "a1", kind: "help_now" })],
      ctx(),
    );
    const hk = plan.items.find((p) => p.id === "hk")!;
    expect(hk.surfaces).toEqual(["understanding"]);
    expect(hk.card).toBeNull();
    expect(hk.housekeeping).toBe(true);
    expect(plan.current?.id).toBe("a1");
  });
});

describe("dismissals rank, they do not mute", () => {
  it("sinks a dismissed kind below the kinds still read, keeping every surface", () => {
    const items = [
      item({ id: "fare", kind: "something_moved" }),
      item({ id: "done", kind: "done_for_you" }),
    ];
    const fresh = routeSurfaces(items, ctx());
    expect(fresh.current?.id).toBe("fare");

    const dismissed = routeSurfaces(items, ctx({ dismissals: { something_moved: 2 } }));
    expect(dismissed.items.map((p) => p.id)).toEqual(["done", "fare"]);
    expect(dismissed.current?.id).toBe("done");
    // Still on the panel the moment it exists.
    expect(dismissed.items[1]!.surfaces).toEqual([...DURABLE_SURFACES]);
    expect(dismissed.withheld).toBe(0);
  });
});

describe("'don't do this' blocks, reversibly", () => {
  it("never shows a blocked kind, then restores it when unblocked", () => {
    const items = [item({ id: "fare", kind: "something_moved", spaceId: "sp_goa" })];
    const blocked = routeSurfaces(items, ctx({ blockedKinds: ["something_moved"] }));
    expect(blocked.items[0]!.surfaces).toEqual(["space", "timeline"]);
    expect(blocked.items[0]!.blocked).toBe(true);
    expect(blocked.current).toBeNull();

    const restored = routeSurfaces(items, ctx({ blockedKinds: [] }));
    expect(restored.current?.id).toBe("fare");
  });
});

describe("the intent floor and the wrong-goal check", () => {
  it("shelves below the floor, never cards it", () => {
    const plan = routeSurfaces([item({ id: "a1", intentConfidence: 0.4 })], ctx({ intentFloor: 0.6 }));
    expect(plan.items[0]!.surfaces).toEqual([...DURABLE_SURFACES]);
    expect(plan.items[0]!.reason).toBe("below_intent_floor");
    expect(plan.current).toBeNull();
  });

  it("a below-floor item does not starve the card", () => {
    const plan = routeSurfaces(
      [
        item({ id: "low", kind: "help_now", intentConfidence: 0.2 }),
        item({ id: "ok", kind: "needs_you", intentConfidence: 0.95 }),
      ],
      ctx({ intentFloor: 0.6 }),
    );
    expect(plan.items.map((p) => p.id)).toEqual(["low", "ok"]);
    expect(plan.current?.id).toBe("ok");
  });

  it("counts a card that names a space the item is not about", () => {
    const plan = routeSurfaces([item({ id: "a1", spaceId: "sp_goa_dec" })], ctx());
    expect(wrongGoalCards(plan)).toHaveLength(0);
    const wrong = {
      ...plan,
      items: plan.items.map((p) => ({ ...p, card: p.card ? { ...p.card, spaceId: "sp_falcon" } : null })),
    };
    wrong.current = wrong.items[0]!;
    expect(wrongGoalCards(wrong)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The world-reading half
// ---------------------------------------------------------------------------

describe("against the database", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-router-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    process.env.SUPERTWIN_HOME = join(tmpDir, "home");
    closeDb();
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    delete process.env.SUPERTWIN_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function screenEventAt(iso: string): void {
    getDb()
      .prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('screen', 'screen', 'Screen')`)
      .run();
    getDb()
      .prepare(`INSERT INTO events (id, source_id, source_type, ts, kind, text) VALUES (?, 'screen', 'screen', ?, 'ax', 'window')`)
      .run(`ev_${iso}`, iso);
  }

  it("reads presence off the last screen event", () => {
    expect(macActive(NOW)).toBe(false);
    screenEventAt(new Date(NOW - 90_000).toISOString());
    expect(macActive(NOW)).toBe(true);
    expect(macActive(NOW + MAC_ACTIVE_WINDOW_MS)).toBe(false);
  });

  it("counts cards shown but not opened, and loses nothing on auto-close", () => {
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_goa', 'Goa trip', 'active', 'test')`)
      .run();
    screenEventAt(new Date(NOW - 60_000).toISOString());
    const { artifact } = createArtifact({
      kind: "comparison",
      title: "villa comparison",
      intent: "comparing villas in Anjuna",
      spaceId: "sp_goa",
      producer: "executor",
      nowMs: NOW,
    });
    const plan = routeNow(NOW);
    expect(plan.current?.id).toBe(artifact.id);
    expect(plan.current?.card?.autoCloseAtMs).toBe(NOW + 60_000);

    expect(unreadCount()).toBe(0);
    markCardShown(plan.current!, NOW);
    expect(unreadCount()).toBe(1);
    // Auto-close keeps it: still 'new', still in the pending store, unread.
    autoCloseCard(artifact.id, NOW + 60_000);
    expect(unreadCount()).toBe(1);
    const row = getDb().prepare(`SELECT status FROM artifacts WHERE id = ?`).get(artifact.id) as { status: string };
    expect(row.status).toBe("new");
    // A card is shown once — it never pops again.
    expect(routeNow(NOW + 61_000).current).toBeNull();
    // Opening clears the counter.
    openCard(artifact.id, NOW + 90_000);
    expect(unreadCount()).toBe(0);
  });

  it("'Not now' ranks the kind down and keeps the work", () => {
    const { artifact } = createArtifact({
      kind: "comparison",
      title: "fare alert",
      intent: "fare on the Goa route",
      producer: "executor",
      nowMs: NOW,
    });
    const before = kindDismissals().done_for_you ?? 0;
    const out = notNowCard(artifact.id, NOW);
    expect(out.dismissals).toBe(before + 1);
    const row = getDb().prepare(`SELECT status FROM artifacts WHERE id = ?`).get(artifact.id) as { status: string };
    expect(row.status).toBe("seen");
  });

  it("reads the merge window, card duration and blocked kinds from Settings › Assist", () => {
    appStateSet(MERGE_WINDOW_S_KEY, "240");
    appStateSet(CARD_DURATION_S_KEY, "60");
    appStateSet(BLOCKED_KINDS_KEY, JSON.stringify(["done_for_you"]));
    screenEventAt(new Date(NOW - 30_000).toISOString());
    createArtifact({ kind: "comparison", title: "cart built", producer: "executor", nowMs: NOW });
    const view = nudgeView(NOW);
    expect(view.presence).toBe("mac_active");
    expect(view.cardDurationMs).toBe(60_000);
    // done_for_you is blocked, so nothing is on the card.
    expect(view.card).toBeNull();
    expect(view.routed[0]!.surfaces).toEqual(["space", "timeline"]);
  });

  it("takes the nudge kind off the prepared action behind the artifact", () => {
    noteNotNow("help_now");
    expect(kindDismissals().help_now).toBe(1);
    getDb()
      .prepare(
        `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
         VALUES ('prep_1', NULL, NULL, 'prepared_action', ?, 'deferred', 'live', ?)`,
      )
      .run(JSON.stringify({ kind: "help_now", intent_confidence: 0.91 }), new Date(NOW).toISOString());
    const { artifact } = createArtifact({
      kind: "comparison",
      title: "villa comparison",
      topicKey: "prepared:prep_1",
      producer: "executor",
      nowMs: NOW,
    });
    screenEventAt(new Date(NOW - 10_000).toISOString());
    const plan = routeNow(NOW);
    expect(plan.items[0]!.id).toBe(artifact.id);
    expect(plan.items[0]!.kind).toBe("help_now");
  });
});
