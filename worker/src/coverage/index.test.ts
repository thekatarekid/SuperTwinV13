// ===========================================================================
// Coverage index (build S2.7): rows maintained by the adapters' sinks, the
// import-range floor, promotions that never regress, and the caveat that
// makes "I only have WhatsApp back to Jan 2024" truthful.
//
// Zero model calls. Scratch DB; the consent gate is enforced only in the
// cases that test the consent floor.
// ===========================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-coverage-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { setConsentGateMode } = await import("../db/consent-gate.js");
const { coverageFor, coverageFloor, grantConsent } = await import("../db/v6core.js");
const { ScreenEventlogSink } = await import("../adapters/screen/sink.js");
const { EventlogSink } = await import("../adapters/browser/sink.js");
const {
  EPOCH_DAY,
  coverageCaveat,
  coverageCaveats,
  coverageSnapshotFor,
  coveredSources,
  dayOf,
  flushCoverage,
  markMissing,
  monthYear,
  noteCaptured,
  noteCapturedDeferred,
  promoteDay,
  resetCoverageBufferForTests,
  setHistoryFloor,
  setHistoryFloorForRange,
} = await import("./index.js");

type EventEnvelope = import("../db/eventlog.js").EventEnvelope;
type V13Event = import("../adapters/browser/envelope.js").V13Event;

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    ts: daysAgo(0),
    source: "screen",
    kind: "screen.snapshot",
    origin: "live",
    streamKey: "Safari",
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: `snapshot ${Math.random()}` },
    ...overrides,
  };
}

function reset(): void {
  closeDb();
  rmSync(process.env.SUPERTWIN_DB_PATH!, { force: true });
  rmSync(`${process.env.SUPERTWIN_DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.SUPERTWIN_DB_PATH}-shm`, { force: true });
  runMigrations();
  resetCoverageBufferForTests();
}

beforeEach(() => {
  reset();
  setConsentGateMode("open");
});

afterEach(() => {
  setConsentGateMode("open");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("dayOf", () => {
  it("accepts ISO timestamps and bare days; rejects garbage", () => {
    expect(dayOf("2026-01-03T23:59:59.999Z")).toBe("2026-01-03");
    expect(dayOf("2026-01-03")).toBe("2026-01-03");
    expect(dayOf("nope")).toBeNull();
    expect(dayOf(null)).toBeNull();
  });
});

describe("noteCaptured — one day row per calendar day", () => {
  it("groups timestamps by day and bumps `events` on repeat", () => {
    expect(noteCaptured("wa", [daysAgo(0), daysAgo(0), daysAgo(1)])).toBe(2);
    let rows = coverageFor("wa");
    expect(rows.map((r) => [r.rangeStart, r.status, r.events])).toEqual([
      [dayOf(daysAgo(1)), "captured", 1],
      [dayOf(daysAgo(0)), "captured", 2],
    ]);
    noteCaptured("wa", [daysAgo(0)]);
    rows = coverageFor("wa");
    expect(rows.find((r) => r.rangeStart === dayOf(daysAgo(0)))!.events).toBe(3);
    expect(coverageFloor("wa")).toBe(dayOf(daysAgo(1)));
  });

  it("ignores unparsable timestamps and empty batches", () => {
    expect(noteCaptured("wa", [])).toBe(0);
    expect(noteCaptured("wa", ["garbage", null, undefined])).toBe(0);
    expect(coverageFor("wa")).toEqual([]);
  });

  it("the deferred writer buffers per (source, day) and flushes once", () => {
    for (let i = 0; i < 50; i++) noteCapturedDeferred("whatsapp", daysAgo(i % 3));
    expect(coverageFor("whatsapp")).toEqual([]); // nothing written yet
    expect(flushCoverage()).toBe(3);
    const rows = coverageFor("whatsapp");
    expect(rows).toHaveLength(3);
    expect(rows.reduce((n, r) => n + r.events, 0)).toBe(50);
    expect(flushCoverage()).toBe(0);
  });
});

describe("promotions never regress", () => {
  it("captured → indexed → understood; more captures keep the promotion", () => {
    const day = dayOf(daysAgo(2))!;
    noteCaptured("wa", [daysAgo(2)]);
    promoteDay("wa", day, "indexed");
    expect(coverageFor("wa")[0]!.status).toBe("indexed");
    promoteDay("wa", day, "understood");
    expect(coverageFor("wa")[0]!.status).toBe("understood");
    promoteDay("wa", day, "indexed"); // a re-run of the indexer
    expect(coverageFor("wa")[0]!.status).toBe("understood");
    noteCaptured("wa", [daysAgo(2)]);
    const row = coverageFor("wa")[0]!;
    expect(row.status).toBe("understood");
    expect(row.events).toBe(2);
  });

  it("promoting a day nobody captured creates the row with zero events", () => {
    promoteDay("browser", "2026-08-01", "indexed");
    expect(coverageFor("browser")).toMatchObject([{ rangeStart: "2026-08-01", status: "indexed", events: 0 }]);
  });
});

describe("history floor — the adapter's import range", () => {
  it("writes one open-start missing row and replaces it on change", () => {
    setHistoryFloorForRange("whatsapp", "90d", NOW);
    let holes = coverageFor("whatsapp").filter((r) => r.status === "missing");
    expect(holes).toHaveLength(1);
    expect(holes[0]!.rangeStart).toBe(EPOCH_DAY);
    expect(holes[0]!.rangeEnd).toBe(dayOf(daysAgo(91)));
    expect(holes[0]!.note).toBe("import range 90d");

    setHistoryFloorForRange("whatsapp", "1y", NOW);
    holes = coverageFor("whatsapp").filter((r) => r.status === "missing");
    expect(holes).toHaveLength(1);
    expect(holes[0]!.note).toBe("import range 1y");

    setHistoryFloorForRange("whatsapp", "all", NOW);
    expect(coverageFor("whatsapp").filter((r) => r.status === "missing")).toEqual([]);
  });

  it("a floor does not disturb captured days or explicit inner holes", () => {
    noteCaptured("whatsapp", [daysAgo(10)]);
    markMissing("whatsapp", dayOf(daysAgo(20))!, dayOf(daysAgo(18))!, "daemon offline");
    setHistoryFloor("whatsapp", dayOf(daysAgo(90)), "import range 90d");
    const rows = coverageFor("whatsapp");
    expect(rows.map((r) => r.status)).toEqual(["missing", "missing", "captured"]);
    setHistoryFloor("whatsapp", null, null);
    expect(coverageFor("whatsapp").map((r) => r.status)).toEqual(["missing", "captured"]);
  });
});

describe("coverageCaveat(source, range)", () => {
  const range = (fromDays: number, toDays: number) => ({ from: daysAgo(fromDays), to: daysAgo(toDays) });

  it("none: a source that has nothing at all", () => {
    const c = coverageCaveat("whatsapp", range(30, 0));
    expect(c).toMatchObject({ kind: "none", floor: null });
    expect(c!.text).toBe("I don't have any WhatsApp yet");
  });

  it("floor: the asked range reaches before the earliest captured day", () => {
    for (let d = 0; d < 60; d++) noteCaptured("whatsapp", [daysAgo(d)]);
    const floor = dayOf(daysAgo(59))!;
    const c = coverageCaveat("whatsapp", range(400, 0));
    expect(c).toMatchObject({ kind: "floor", floor });
    expect(c!.text).toBe(`I only have WhatsApp back to ${monthYear(floor)}`);
    // Fully inside the captured span: no caveat at all.
    expect(coverageCaveat("whatsapp", range(30, 0))).toBeNull();
  });

  it("gap: a recorded hole inside the asked range with nothing captured in it", () => {
    for (let d = 0; d < 60; d++) if (d < 20 || d > 25) noteCaptured("whatsapp", [daysAgo(d)]);
    markMissing("whatsapp", dayOf(daysAgo(25))!, dayOf(daysAgo(20))!, "daemon offline");
    const c = coverageCaveat("whatsapp", range(30, 0));
    expect(c).toMatchObject({
      kind: "gap",
      gap: { from: dayOf(daysAgo(25)), to: dayOf(daysAgo(20)), note: "daemon offline" },
    });
    expect(c!.text).toMatch(/^nothing from WhatsApp between .* and .* \(daemon offline\)$/);
    // The hole is clipped to the asked range.
    expect(coverageCaveat("whatsapp", range(22, 0))!.gap).toMatchObject({ from: dayOf(daysAgo(22)) });
    // A range that does not touch the hole has no caveat.
    expect(coverageCaveat("whatsapp", range(10, 0))).toBeNull();
  });

  it("a hole with captured days inside it is NOT claimed as a gap", () => {
    for (let d = 0; d < 30; d++) noteCaptured("whatsapp", [daysAgo(d)]);
    markMissing("whatsapp", dayOf(daysAgo(12))!, dayOf(daysAgo(8))!, "stale note");
    expect(coverageCaveat("whatsapp", range(20, 0))).toBeNull();
  });

  it("excluded: a range reaching past the consent INDEX floor names the consent", () => {
    setConsentGateMode("enforce");
    grantConsent({ source: "wa", indexAll: false, indexFrom: daysAgo(40), understandFrom: daysAgo(10) });
    for (let d = 0; d < 30; d++) noteCaptured("wa", [daysAgo(d)]);
    const c = coverageCaveat("wa", range(100, 0));
    expect(c).toMatchObject({ kind: "excluded", floor: dayOf(daysAgo(29)) });
    // indexFrom (Jul) and the capture floor (Aug) fall in different months, so both are said.
    expect(c!.text).toBe(
      `I only index WhatsApp from ${monthYear(dayOf(daysAgo(40))!)} and have it back to ${monthYear(dayOf(daysAgo(29))!)}`,
    );
    // Inside the index window but before the first captured day → floor.
    expect(coverageCaveat("wa", range(35, 0))!.kind).toBe("floor");
    // Same month for both → said once.
    grantConsent({ source: "browser", indexAll: false, indexFrom: daysAgo(31), understandFrom: daysAgo(10) });
    for (let d = 0; d < 30; d++) noteCaptured("browser", [daysAgo(d)]);
    expect(coverageCaveat("browser", range(100, 0))!.text).toBe(
      `I only index browser history from ${monthYear(dayOf(daysAgo(31))!)}`,
    );
  });

  it("the import-range floor reads as a plain capture floor, not a gap", () => {
    setHistoryFloorForRange("whatsapp", "90d", NOW);
    for (let d = 0; d < 90; d++) noteCaptured("whatsapp", [daysAgo(d)]);
    const c = coverageCaveat("whatsapp", range(365, 0));
    expect(c!.kind).toBe("floor");
    expect(c!.text).toBe(`I only have WhatsApp back to ${monthYear(dayOf(daysAgo(89))!)}`);
  });

  it("rejects an inverted or unparsable range", () => {
    expect(() => coverageCaveat("wa", { from: daysAgo(0), to: daysAgo(3) })).toThrow(/precedes/);
    expect(() => coverageCaveat("wa", { from: "soon", to: daysAgo(0) })).toThrow(/ISO/);
  });

  it("coverageCaveats covers every source with a row, or the named ones", () => {
    noteCaptured("whatsapp", [daysAgo(3)]);
    noteCaptured("browser", [daysAgo(1)]);
    expect(coveredSources()).toEqual(["browser", "whatsapp"]);
    const all = coverageCaveats(range(30, 0));
    expect(all.map((c) => [c.source, c.kind])).toEqual([
      ["browser", "floor"],
      ["whatsapp", "floor"],
    ]);
    expect(coverageCaveats(range(30, 0), ["screen"]).map((c) => c.kind)).toEqual(["none"]);
    expect(coverageCaveats(range(1, 0), ["browser"])).toEqual([]);
  });

  it("snapshot: floor, days, events, holes for the Library strip", () => {
    noteCaptured("screen", [daysAgo(2), daysAgo(2), daysAgo(1)]);
    setHistoryFloor("screen", dayOf(daysAgo(2)), "capture began");
    expect(coverageSnapshotFor("screen")).toEqual({
      source: "screen",
      label: "your screen",
      floor: dayOf(daysAgo(2)),
      days: 2,
      events: 3,
      holes: [{ from: EPOCH_DAY, to: dayOf(daysAgo(3)), status: "missing", note: "capture began" }],
    });
  });
});

describe("adapters maintain the rows through their sinks", () => {
  it("screen sink: every appended batch lands as day rows", () => {
    const sink = new ScreenEventlogSink();
    const n = sink.append([
      envelope({ ts: daysAgo(0), payload: { text: "tab about villas" } }),
      envelope({ ts: daysAgo(0), payload: { text: "another tab" } }),
      envelope({ ts: daysAgo(3), payload: { text: "old tab" } }),
    ]);
    expect(n).toBe(3);
    const rows = coverageFor("screen");
    expect(rows.map((r) => [r.rangeStart, r.events])).toEqual([
      [dayOf(daysAgo(3)), 1],
      [dayOf(daysAgo(0)), 2],
    ]);
  });

  it("screen sink: a duplicate (same content_hash) does not inflate the count", () => {
    const sink = new ScreenEventlogSink();
    const env = envelope({ ts: daysAgo(0), payload: { text: "same tab twice" } });
    sink.append([env]);
    sink.append([env]);
    expect(coverageFor("screen")).toMatchObject([{ events: 1 }]);
  });

  it("browser sink: the same contract over V13Event", () => {
    const sink = new EventlogSink();
    const visit = (ts: string, url: string): V13Event =>
      ({
        id: undefined,
        ts,
        captured_at: ts,
        source: "browser",
        kind: "browser.visit",
        origin: "backfill",
        age_band: "A",
        stream_key: "villas.example",
        actor: "self",
        roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
        payload: { url },
        text: `Villas in Goa · ${url}`,
        content_hash: `h:${url}`,
        blob_refs: [],
      }) as unknown as V13Event;
    expect(sink.append([visit(daysAgo(1), "https://villas.example/1"), visit(daysAgo(1), "https://villas.example/2")])).toBe(2);
    expect(coverageFor("browser")).toMatchObject([{ rangeStart: dayOf(daysAgo(1)), events: 2, status: "captured" }]);
  });

  it("RET-04 (coverage half): an archive-only row still counts as captured", () => {
    setConsentGateMode("enforce");
    grantConsent({ source: "screen", indexAll: true, understandFrom: daysAgo(30) });
    const sink = new ScreenEventlogSink();
    sink.append([envelope({ ts: daysAgo(120), origin: "backfill", payload: { text: "ancient tab" } })]);
    const row = getDb().prepare(`SELECT origin FROM events`).get() as { origin: string };
    expect(row.origin).toBe("archive");
    expect(coverageFor("screen")).toMatchObject([{ rangeStart: dayOf(daysAgo(120)), events: 1 }]);
    expect(coverageCaveat("screen", { from: daysAgo(365), to: daysAgo(0) })!.kind).toBe("floor");
  });
});
