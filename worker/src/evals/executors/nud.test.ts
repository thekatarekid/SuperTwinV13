// ===========================================================================
// NUD executor (V6 P1 S4.3): the nine code cases run against the real
// fixtures in evals/v13 through the real surfaces/router.ts — seeded world,
// pinned clock, zero model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode } from "../../db/consent-gate.js";
import { loadFixture } from "../fixtures.js";
import { nudExecutor } from "./nud.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-nud-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  setConsentGateMode("open");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Out {
  presence: string;
  current_card: string | null;
  card: { title: string; line: string; spaceId: string | null } | null;
  order: string[];
  routed: { id: string; kind: string; surfaces: string[]; rank: number; merged_with: string[]; reason: string }[];
  away: { id: string; surfaces: string[] }[];
  unread: number;
  extra: Record<string, unknown>;
}

async function run(id: string): Promise<{ ok: boolean; out: Out; metrics: Record<string, number>; violations: unknown[] }> {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  const result = await nudExecutor({ fixture });
  return {
    ok: result.ok !== false && (result.violations ?? []).length === 0,
    out: result.output as Out,
    metrics: (result.metrics ?? {}) as Record<string, number>,
    violations: result.violations ?? [],
  };
}

describe("every NUD case is green and spends nothing", () => {
  for (const id of ["NUD-01", "NUD-02", "NUD-03", "NUD-04", "NUD-05", "NUD-06", "NUD-07", "NUD-08", "NUD-09"]) {
    it(`${id} passes with zero model calls`, async () => {
      const r = await run(id);
      expect(r.violations).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.metrics.model_calls).toBe(0);
      expect(r.metrics.router_withheld).toBe(0);
    });
  }
});

describe("what each case actually asserted", () => {
  it("NUD-01: the card is an addition, not a replacement", async () => {
    const { out } = await run("NUD-01");
    expect(out.presence).toBe("mac_active");
    expect(out.routed[0]!.surfaces).toEqual(["card", "panel", "shelf", "space", "timeline"]);
    expect(out.card?.title).toBe("Goa trip");
  });

  it("NUD-02: away is the same set minus the card", async () => {
    const { out } = await run("NUD-02");
    expect(out.presence).toBe("away");
    expect(out.card).toBeNull();
    expect(out.routed[0]!.surfaces).toEqual(["panel", "shelf", "space", "timeline"]);
  });

  it("NUD-03: 60 s, unread +1, nothing lost, no second card", async () => {
    const { out } = await run("NUD-03");
    expect(Number(out.extra.auto_close_at_ms) - Number(out.extra.shown_at_ms)).toBe(60_000);
    expect(out.extra.unread_after_close).toBe(1);
    expect(out.extra.status_after_close).toBe("new");
  });

  it("NUD-04: three helps, one glance", async () => {
    const { out, metrics } = await run("NUD-04");
    expect(metrics.cards).toBe(1);
    expect(out.card?.line).toBe("villa comparison · Karan replied · fare dropped");
    expect(out.routed[0]!.merged_with).toEqual(["art_karan", "art_fare"]);
  });

  it("NUD-05: the decay order, not the arrival order", async () => {
    const { out } = await run("NUD-05");
    expect(out.order).toEqual(["art_help", "art_needs", "art_done"]);
  });

  it("NUD-06: bookkeeping reaches Recent understanding and nothing else", async () => {
    const { out, metrics } = await run("NUD-06");
    expect(metrics.cards).toBe(0);
    for (const item of out.routed) expect(item.surfaces).toEqual(["understanding"]);
  });

  it("NUD-07: the dismissed kind sinks but never loses a surface", async () => {
    const { out } = await run("NUD-07");
    expect(out.order).toEqual(["art_cart", "art_fare_3"]);
    expect(out.routed[1]!.surfaces).toEqual(["panel", "shelf", "space", "timeline"]);
  });

  it("NUD-08: blocked is filed, listed and reversible", async () => {
    const { out } = await run("NUD-08");
    expect(out.card).toBeNull();
    expect(out.routed[0]!.surfaces).toEqual(["space", "timeline"]);
    expect(out.extra.blocked_in_settings).toEqual(["something_moved"]);
  });

  it("NUD-09: the wrong-goal card is caught", async () => {
    const { out, metrics } = await run("NUD-09");
    expect(metrics.wrong_goal_cards_caught).toBe(1);
    expect(metrics.nudge_precision_violation).toBe(0);
    expect(out.card?.spaceId).toBe("sp_goa_dec");
  });
});

describe("the cases clean up after themselves", () => {
  it("leaves no artifact, prepared action, space or screen event behind", async () => {
    await run("NUD-04");
    const db = getDb();
    for (const table of ["artifacts", "deferred_outputs", "spaces", "events"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect({ table, n: row.n }).toEqual({ table, n: 0 });
    }
  });
});
