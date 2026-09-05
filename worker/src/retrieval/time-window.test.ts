// ===========================================================================
// Time-window retrieval (V6 P1 S2.5) — RET-08 as vitest.
//
//   RET-08  "what happened Tuesday afternoon" → a range scan 12:00–18:00 local
//           on the most recent Tuesday, UNSCORED, ordered by timestamp. Rows
//           carry no score; a reaction and a deleted-for-everyone tombstone
//           are out; a cap makes the scan say it is partial.
//
// Zero model calls: pure SQLite on a temp file. TZ pinned to the user's zone —
// the window is local hours and the log stores UTC instants.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Kolkata";
const tmpRoot = mkdtempSync(join(tmpdir(), "st-time-window-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { appendEvent } = await import("../db/eventlog.js");
const { DAY_PARTS, DEFAULT_TIME_WINDOW_LIMIT, resolveTimeWindow, timeWindowForQuery, timeWindowScan, windowFor } = await import(
  "./time-window.js"
);

// Golden-evals clock: Sat 2026-09-05 10:00 IST. The most recent Tuesday is 2026-09-01.
const NOW = new Date("2026-09-05T04:30:00.000Z");

/** IST wall-clock → the UTC instant the log stores. */
function ist(day: string, hhmm: string): string {
  return new Date(`${day}T${hhmm}:00+05:30`).toISOString();
}

function chat(ts: string, text: string, opts: { stream?: string; actor?: string; kind?: string; source?: string } = {}): string {
  const actor = opts.actor ?? "contact:rohan";
  return appendEvent({
    ts,
    source: opts.source ?? "wa",
    kind: opts.kind ?? "wa.message",
    origin: "live",
    streamKey: opts.stream ?? "wa:goa-gang@g.us",
    actor,
    roles: { sender: actor, audience: ["self", actor], receiver: ["self"], mentions: [] },
    payload: { text },
  }).id;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec(`DELETE FROM events; DELETE FROM archive;`);
});

// ---------------------------------------------------------------------------

describe("RET-08 — time window", () => {
  it("resolves 'what happened tuesday afternoon' to 12:00–18:00 local on the most recent Tuesday", () => {
    const w = resolveTimeWindow("what happened Tuesday afternoon", NOW);
    expect(w).not.toBeNull();
    expect(w!.localDate).toBe("2026-09-01");
    expect(w!.dayPart).toBe("afternoon");
    expect(w!.hours).toEqual([12, 18]);
    expect(w!.fromIso).toBe(ist("2026-09-01", "12:00"));
    expect(w!.toIso).toBe(ist("2026-09-01", "18:00"));
    expect(w!.expression).toBe("tuesday afternoon");
  });

  it("scans the range unscored, ordered by timestamp, and cites by event id", () => {
    // Tuesday 2026-09-01, inserted OUT of order so the ORDER BY has to earn it.
    const late = chat(ist("2026-09-01", "17:59"), "leaving now, see you at the villa");
    const noon = chat(ist("2026-09-01", "12:00"), "lunch at 12, then the villa call");
    const mid = chat(ist("2026-09-01", "14:30"), "advance paid to the host", { stream: "wa:rohan", actor: "self" });
    const browse = chat(ist("2026-09-01", "15:10"), "Airbnb · Villa with pool", { source: "browser", kind: "browser.visit", stream: "browser:chrome:default:airbnb.co.in" });
    // Boundary and noise: 11:59 and 18:00 are outside; Monday afternoon is another day;
    // a reaction in the window is not an event anyone means by "what happened".
    chat(ist("2026-09-01", "11:59"), "morning still");
    chat(ist("2026-09-01", "18:00"), "evening now");
    chat(ist("2026-08-31", "14:00"), "monday afternoon");
    chat(ist("2026-09-01", "13:00"), "👍", { kind: "reaction" });

    const r = timeWindowForQuery("what happened Tuesday afternoon", NOW);
    expect(r).not.toBeNull();
    expect(r!.method).toBe("time_window");
    expect(r!.scored).toBe(false);
    expect(r!.complete).toBe(true);
    expect(r!.count).toBe(4);
    expect(r!.events.map((e) => e.id)).toEqual([noon, mid, browse, late]);
    // Timestamps ascend; no row carries a score of any kind.
    const tss = r!.events.map((e) => e.ts!);
    expect([...tss].sort()).toEqual(tss);
    for (const e of r!.events) {
      expect(e).not.toHaveProperty("score");
      expect(e).not.toHaveProperty("similarity");
    }
    // Stream and source ride along so the packer can group by them.
    expect(r!.events[1].streamKey).toBe("wa:rohan");
    expect(r!.events[2].source).toBe("browser");
    expect(r!.events[2].text).toBe("Airbnb · Villa with pool");
  });

  it("a cap makes the scan say it is partial; the order is still time", () => {
    for (let m = 0; m < 30; m++) chat(ist("2026-09-01", `12:${String(m).padStart(2, "0")}`), `msg ${m}`);
    const w = resolveTimeWindow("tuesday afternoon", NOW)!;
    const r = timeWindowScan({ window: w, limit: 10 });
    expect(r.count).toBe(30);
    expect(r.events).toHaveLength(10);
    expect(r.complete).toBe(false);
    expect(r.events.map((e) => e.text)).toEqual(Array.from({ length: 10 }, (_, i) => `msg ${i}`));
    // Default cap holds when none is given.
    expect(timeWindowScan({ window: w }).events).toHaveLength(30);
    expect(DEFAULT_TIME_WINDOW_LIMIT).toBeGreaterThanOrEqual(500);
  });

  it("narrows by stream, source and kind when a plan says so", () => {
    chat(ist("2026-09-01", "13:00"), "group chatter");
    const dm = chat(ist("2026-09-01", "13:30"), "dm line", { stream: "wa:rohan" });
    const visit = chat(ist("2026-09-01", "14:00"), "a page", { source: "browser", kind: "browser.visit", stream: "browser:x" });
    const w = resolveTimeWindow("tuesday afternoon", NOW)!;
    expect(timeWindowScan({ window: w, streamKeys: ["wa:rohan"] }).events.map((e) => e.id)).toEqual([dm]);
    expect(timeWindowScan({ window: w, sources: ["browser"] }).events.map((e) => e.id)).toEqual([visit]);
    expect(timeWindowScan({ window: w, kinds: ["browser.visit"] }).count).toBe(1);
    expect(timeWindowScan({ window: w, sources: ["wa"] }).count).toBe(2);
  });

  it("deleted-for-everyone tombstones are out", () => {
    const keep = chat(ist("2026-09-01", "13:00"), "kept");
    const gone = chat(ist("2026-09-01", "13:05"), "deleted");
    getDb().prepare(`UPDATE events SET revoked_at = ? WHERE id = ?`).run(ist("2026-09-01", "13:06"), gone);
    const r = timeWindowForQuery("what happened tuesday afternoon", NOW)!;
    expect(r.events.map((e) => e.id)).toEqual([keep]);
  });
});

describe("window resolution", () => {
  it("day parts and whole days", () => {
    expect(DAY_PARTS.morning).toEqual([6, 12]);
    expect(DAY_PARTS.evening).toEqual([18, 22]);
    const morning = resolveTimeWindow("what did we do tuesday morning", NOW)!;
    expect([morning.fromIso, morning.toIso]).toEqual([ist("2026-09-01", "06:00"), ist("2026-09-01", "12:00")]);
    const night = resolveTimeWindow("what happened monday night", NOW)!;
    expect(night.localDate).toBe("2026-08-31");
    expect([night.fromIso, night.toIso]).toEqual([ist("2026-08-31", "22:00"), ist("2026-09-01", "06:00")]);
    const day = resolveTimeWindow("what happened on tuesday", NOW)!;
    expect(day.dayPart).toBeNull();
    expect([day.fromIso, day.toIso]).toEqual([ist("2026-09-01", "00:00"), ist("2026-09-02", "00:00")]);
  });

  it("past by default, future on a future marker, today for 'this afternoon' / 'tonight'", () => {
    // Sat 2026-09-05: bare "saturday" is today (offset 0), not last week.
    expect(resolveTimeWindow("what happened saturday morning", NOW)!.localDate).toBe("2026-09-05");
    expect(resolveTimeWindow("what happened yesterday evening", NOW)!.localDate).toBe("2026-09-04");
    expect(resolveTimeWindow("what's planned for tuesday afternoon", NOW)!.localDate).toBe("2026-09-08");
    // dates.ts rule: "next <weekday>" is the coming one plus a week — the same reading every method gets.
    expect(resolveTimeWindow("next tuesday afternoon", NOW)!.localDate).toBe("2026-09-15");
    expect(resolveTimeWindow("last tuesday afternoon", NOW)!.localDate).toBe("2026-09-01");
    expect(resolveTimeWindow("this afternoon", NOW)).toMatchObject({ localDate: "2026-09-05", dayPart: "afternoon" });
    expect(resolveTimeWindow("what did I do tonight", NOW)).toMatchObject({ localDate: "2026-09-05", dayPart: "evening" });
  });

  it("no day named → null; the method stays out", () => {
    expect(resolveTimeWindow("how much on cabs last month", NOW)).toBeNull();
    expect(resolveTimeWindow("did I confirm the villa", NOW)).toBeNull();
    expect(timeWindowForQuery("did I confirm the villa", NOW)).toBeNull();
  });

  it("rejects an empty or malformed window", () => {
    expect(() => windowFor({ year: 2026, month: 9, day: 1 }, [18, 12], "x")).toThrow(/bad hour span/);
    expect(() => timeWindowScan({ window: { fromIso: "2026-09-01T12:00:00Z", toIso: "2026-09-01T12:00:00Z" } })).toThrow(/empty window/);
    expect(() => timeWindowScan({ window: { fromIso: "tuesday", toIso: "2026-09-01T12:00:00Z" } })).toThrow(/bad instants/);
  });
});
