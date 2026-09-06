// ===========================================================================
// Eval isolation (V6 P1 S3.9, backlog T6-5): a row with origin = 'eval' — the
// origin only the golden harness writes — is invisible to every dispatch lane
// BY DEFAULT: the live dispatcher never gates or stamps it, the history
// planner never bundles it, the digest planner skips it. The harness's own
// path (collectTick → commit) still sees it, so fixtures keep working in the
// sandboxed home while a fixture row that ever leaks into a running worker's
// database costs nothing.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../db/connection.js";
import { collectTick } from "./bundle.js";
import { planDigest } from "./digest.js";
import { DEFAULT_IGNORED_ORIGINS, Dispatcher } from "./dispatch.js";
import { planHistory } from "./history.js";
import { append, msgAt, openScratchDb, SEC, seedSpace, setStreamTier, streamIdOf, T0, undispatchedCount, type ScratchDb } from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-eval-iso-");
});
afterEach(() => db.close());

function matureWorld(): void {
  for (let i = 0; i < 20; i++) seedSpace(`sp_${i}`, `space ${i}`);
  getDb()
    .prepare(`INSERT INTO consents (id, source, state, granted_at) VALUES ('c1', 'wa', 'connected', ?)`)
    .run(new Date(T0 - 30 * 86_400_000).toISOString());
}

describe("origin = 'eval' is ignored by every lane by default", () => {
  it("DEFAULT_IGNORED_ORIGINS names eval and nothing else", () => {
    expect([...DEFAULT_IGNORED_ORIGINS]).toEqual(["eval"]);
  });

  it("the live dispatcher (no ignoreOrigins passed) never gates, bundles or stamps an eval row", async () => {
    matureWorld();
    append([
      msgAt("goa-gang@g.us", T0, "guys lets lock goa 18-21 dec", { origin: "eval" }),
      msgAt("goa-gang@g.us", T0 + 5 * SEC, "villa sol wale bol rahe advance aaj chahiye", { origin: "eval" }),
      msgAt("goa-gang@g.us", T0 + 10 * SEC, "kitna?", { origin: "eval" }),
      msgAt("goa-gang@g.us", T0 + 15 * SEC, "15k total, 5k each", { origin: "eval" }),
    ]);
    let calls = 0;
    const d = new Dispatcher({ sink: () => (calls++, { status: "empty" }), preset: () => "balanced" });
    const first = d.tick(T0);
    expect(first.gated).toEqual({ hot: 0, cold: 0, burst: 0, repeats: 0 });
    d.tick(T0 + 600 * SEC);
    d.tick(T0 + 1_200 * SEC);
    await d.drain();
    expect(calls).toBe(0);
    expect(undispatchedCount()).toBe(4);
  });

  it("a live row beside an eval row is still dispatched — only the eval row is skipped", async () => {
    matureWorld();
    append([
      msgAt("goa-gang@g.us", T0, "fixture line", { origin: "eval" }),
      msgAt("college@g.us", T0, "real line"),
    ]);
    const seen: string[] = [];
    const d = new Dispatcher({
      sink: (b) => {
        seen.push(...b.events.map((e) => e.text ?? ""));
        return { status: "empty" };
      },
      preset: () => "balanced",
    });
    d.tick(T0);
    d.tick(T0 + 600 * SEC);
    await d.drain();
    expect(seen).toEqual(["real line"]);
    const evalRow = getDb().prepare(`SELECT dispatched_at FROM events WHERE origin = 'eval'`).get() as { dispatched_at: string | null };
    expect(evalRow.dispatched_at).toBeNull();
  });

  it("the history planner bundles backfill only — an eval row on an old day is not a history day", () => {
    const old = Date.parse("2024-03-01T09:00:00Z");
    append([
      msgAt("h@g.us", old, "eval history", { origin: "eval" }),
      msgAt("h@g.us", old + 60 * SEC, "eval history 2", { origin: "eval" }),
    ]);
    expect(planHistory()).toHaveLength(0);
    append([msgAt("k@g.us", old, "real history", { origin: "backfill" })]);
    const plan = planHistory();
    expect(plan).toHaveLength(1);
    expect(plan[0]!.events.map((e) => e.text)).toEqual(["real history"]);
  });

  it("the digest planner skips eval rows on a tier-3 stream", () => {
    const at = (iso: string) => Date.parse(iso);
    append([
      msgAt("promo@g.us", at("2026-08-04T10:00:00Z"), "offer 1", { origin: "eval" }),
      msgAt("promo@g.us", at("2026-08-05T10:00:00Z"), "offer 2", { origin: "eval" }),
    ]);
    setStreamTier(streamIdOf("wa", "promo@g.us"), "T3");
    expect(planDigest({ nowMs: at("2026-08-26T12:00:00Z") })).toHaveLength(0);
    append([msgAt("promo@g.us", at("2026-08-06T10:00:00Z"), "offer 3", { origin: "backfill" })]);
    const plan = planDigest({ nowMs: at("2026-08-26T12:00:00Z") });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.events.map((e) => e.text)).toEqual(["offer 3"]);
  });

  it("the harness path (collectTick) still sees eval rows, on the history lane", () => {
    append([msgAt("fix@g.us", T0, "fixture", { origin: "eval" })]);
    const plan = collectTick(T0 + 60 * SEC);
    const mine = plan.bundles.filter((b) => b.streamKey === "fix@g.us");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.lane).toBe("history");
    expect(mine[0]!.events[0]!.origin).toBe("eval");
  });
});
