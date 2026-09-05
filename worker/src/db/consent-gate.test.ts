// ===========================================================================
// CNS-01..04 — the consent gate (V6 P1 S1.2, Build §4.1; GoldenEvals_V6_Phase1
// §5.2) as deterministic vitest cases, the way S0 shipped SPD-01..03 and
// BND-08..10: fixture id in the describe title, the doc's Expected and Wrong
// lines asserted by code, ZERO model calls (SQLite on a temp file).
//
//   CNS-01  nothing before yes — fresh home, no consent rows: both funnels
//           write 0 events for every source. (The 60 s / no-daemon / no-sidecar
//           half is S1.3's boot inversion; the funnel half is here.)
//   CNS-02  windows enforced at the funnel — Understand 7 d, Index all, import
//           90 days: every row in the archive; rows older than 7 d carry
//           origin='archive' and never appear in a bundle. Wrong:
//           archive-in-bundle.
//   CNS-03  Understand never exceeds Index — 90 d over a 30 d Index: rejected,
//           nothing written.
//   CNS-04  widening is a replay — 7 d → 30 d: the 23 extra days become
//           dispatchable; no adapter activity; resumable after a kill. Wrong:
//           re-import.
//
// The suite-wide setup (src/test-setup.ts) opens the gate for the legacy
// suites; these cases enforce it in beforeEach and restore it afterwards.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTick } from "../scheduler/dispatch.js";
import { closeDb, getDb, runMigrations } from "./connection.js";
import {
  admitCapture,
  consentGateMode,
  pendingReplayCount,
  replayArchive,
  resumeReplay,
  setConsentGateMode,
  setUnderstandWindow,
  type ConsentGateMode,
} from "./consent-gate.js";
import { appendEvents, contentHash, type EventEnvelope } from "./eventlog.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "./ingest.js";
import {
  archiveCount,
  ConsentWindowError,
  getConsent,
  grantConsent,
  readArchiveByEvent,
  setConsentState,
} from "./v6core.js";

// ---- fixtures ----------------------------------------------------------------

const DAY = 86_400_000;
/** The clock every case runs on: 2026-09-01 12:00 UTC. */
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    ts: daysAgo(0),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "9198xx-1602@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: "guys lets lock goa 18-21 dec" },
    ...overrides,
  };
}

/** A 90-day import through the single-writer path: one backfill row per day. */
function importDays(days: number, source = "wa", streamKey = "9198xx-1602@g.us") {
  const envs: EventEnvelope[] = [];
  for (let d = 0; d < days; d++) {
    envs.push(
      envelope({
        ts: daysAgo(d),
        source,
        streamKey,
        origin: "backfill",
        kind: source === "wa" ? "wa.message" : `${source}.visit`,
        payload: { text: `day ${d}: villa advance https://villas.example/booking/${d}` },
      }),
    );
  }
  return appendEvents(envs, NOW);
}

interface EventRow {
  id: string;
  ts: string;
  origin: string;
  dispatched_at: string | null;
  captured_at: string;
  consent_id: string | null;
  content_hash: string;
}

function rows(where = "1=1"): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, ts, origin, dispatched_at, captured_at, consent_id, content_hash
         FROM events WHERE ${where} ORDER BY ts DESC`,
    )
    .all() as EventRow[];
}

function count(table: string, where = "1=1"): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function bundledEventIds(): Set<string> {
  const plan = collectTick(NOW);
  const ids = new Set<string>();
  for (const b of plan.bundles) for (const e of b.events) ids.add(e.id);
  return ids;
}

// ---- harness ---------------------------------------------------------------

let tmpDir: string;
let prevMode: ConsentGateMode;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cns-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
});

afterEach(() => {
  setConsentGateMode(prevMode);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CNS-01
// ---------------------------------------------------------------------------

describe("CNS-01 — nothing before yes", () => {
  it("fresh home, no consent rows: appendEvents writes 0 events for every source", () => {
    expect(count("consents")).toBe(0);
    const res = appendEvents(
      [
        envelope({ source: "wa" }),
        envelope({ source: "browser", kind: "browser.visit", streamKey: "goibibo.com", actor: "self", payload: { text: "https://goibibo.com/hotels" } }),
        envelope({ source: "screen", kind: "screen.snapshot", streamKey: "Chrome¦goibibo", actor: "self", payload: { text: "Goibibo — villas in Goa" } }),
        envelope({ source: "self", kind: "self.bar", streamKey: "bar", actor: "self", payload: { text: "book the villa" } }),
      ],
      NOW,
    );
    expect(res.inserted).toBe(0);
    expect(res.skipped).toBe(4);
    expect(res.ids).toEqual(["", "", "", ""]);
    expect(count("events")).toBe(0);
    expect(archiveCount()).toBe(0);
    // Nothing leaks around the gate either: no source or stream row appears.
    expect(count("sources")).toBe(0);
    expect(count("streams")).toBe(0);
    expect(count("event_bridge_keys")).toBe(0);
  });

  it("the WhatsApp legacy funnel (insertEvent) is gated the same way", () => {
    upsertSource({ id: "wa", type: "whatsapp", name: "WhatsApp" });
    const streamId = upsertStream({ sourceId: "wa", sourceExtId: "9198xx-1602@g.us", name: "Goa gang", kind: "group" });
    const actorId = upsertActor({ sourceId: "wa", sourceExtId: "rohan@x", displayName: "Rohan" });
    const r = insertEvent({
      externalId: "m1",
      sourceId: "wa",
      sourceType: "whatsapp",
      streamId,
      actorId,
      ts: NOW_ISO,
      kind: "message",
      text: "lock goa",
      mediaPath: null,
      rawJson: null,
    });
    expect(r.inserted).toBe(false);
    expect(count("events")).toBe(0);
    expect(archiveCount()).toBe(0);
  });

  it("a consent that is paused, disconnected or revoked is not a yes", () => {
    grantConsent({ source: "wa", understandFrom: daysAgo(30) });
    for (const state of ["paused", "disconnected"] as const) {
      setConsentState("wa", state);
      expect(admitCapture("wa", NOW_ISO, NOW_ISO, "live")).toEqual({ admitted: false, reason: state });
      expect(appendEvents([envelope({ payload: { text: `while ${state}` } })], NOW).inserted).toBe(0);
    }
    setConsentState("wa", "revoked");
    expect(admitCapture("wa", NOW_ISO, NOW_ISO, "live")).toEqual({ admitted: false, reason: "no-consent" });
    expect(count("events")).toBe(0);
    // And a yes is a yes: reconnecting admits the next event.
    grantConsent({ source: "wa", understandFrom: daysAgo(30) });
    expect(appendEvents([envelope()], NOW).inserted).toBe(1);
  });

  it("the gate is enforced by default; only the explicit setter opens it (the legacy-suite seam)", () => {
    expect(consentGateMode()).toBe("enforce");
    expect(process.env.SUPERTWIN_CONSENT_GATE).toBeUndefined();
    setConsentGateMode("open");
    expect(appendEvents([envelope()], NOW).inserted).toBe(1);
    expect(rows()[0].consent_id).toBeNull();
    setConsentGateMode("enforce");
    expect(appendEvents([envelope({ payload: { text: "again" } })], NOW).inserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CNS-02
// ---------------------------------------------------------------------------

describe("CNS-02 — windows enforced at the funnel", () => {
  it("Understand 7 d, Index all, import 90 days: all rows archived; >7 d rows are origin='archive' and never bundled", () => {
    const cns = grantConsent({ source: "wa", indexAll: true, understandFrom: daysAgo(7) });
    const res = importDays(90);
    expect(res.inserted).toBe(90);

    // Every consented row is in the archive (layer 1), understood or not.
    expect(count("events")).toBe(90);
    expect(archiveCount("wa")).toBe(90);
    for (const r of rows()) {
      expect(r.consent_id).toBe(cns.id);
      expect(readArchiveByEvent(r.id)).not.toBeNull();
    }

    // The tier predicate: ts >= understand_from → dispatchable backfill;
    // older → origin='archive', dispatched_at = capture_ts.
    const understood = rows(`ts >= '${daysAgo(7)}'`);
    const archived = rows(`ts < '${daysAgo(7)}'`);
    expect(understood).toHaveLength(8); // days 0..7 inclusive (the floor itself is inside)
    expect(archived).toHaveLength(82);
    for (const r of understood) {
      expect(r.origin).toBe("backfill");
      expect(r.dispatched_at).toBeNull();
    }
    for (const r of archived) {
      expect(r.origin).toBe("archive");
      expect(r.dispatched_at).toBe(r.captured_at);
    }
    expect(count("events", "dispatched_at IS NULL")).toBe(8);

    // Wrong: archive-in-bundle. The real dispatcher plans a tick over the
    // same database; no archive row may be in any bundle.
    const bundled = bundledEventIds();
    expect(bundled.size).toBe(8);
    const archiveInBundle = archived.filter((r) => bundled.has(r.id));
    expect(archiveInBundle).toEqual([]);
    for (const r of understood) expect(bundled.has(r.id)).toBe(true);

    // Bridges do not run on tier (b): the URL literal in every row yields
    // bridge keys for the understood rows only.
    const understoodIds = understood.map((r) => `'${r.id}'`).join(",");
    const archivedIds = archived.map((r) => `'${r.id}'`).join(",");
    expect(count("event_bridge_keys", `event_id IN (${understoodIds})`)).toBeGreaterThan(0);
    expect(count("event_bridge_keys", `event_id IN (${archivedIds})`)).toBe(0);
  });

  it("the Index floor drops what falls outside it; the Understand floor archives what falls between", () => {
    grantConsent({ source: "wa", indexFrom: daysAgo(30), understandFrom: daysAgo(7) });
    const res = importDays(90);
    // days 0..30 inside Index (31 rows); 31..89 outside → dropped, not stored-and-hidden.
    expect(res.inserted).toBe(31);
    expect(res.skipped).toBe(59);
    expect(count("events")).toBe(31);
    expect(archiveCount("wa")).toBe(31);
    expect(count("events", "origin = 'archive'")).toBe(23); // days 8..30
    expect(count("events", "origin = 'backfill' AND dispatched_at IS NULL")).toBe(8);
    expect(admitCapture("wa", daysAgo(31), NOW_ISO, "backfill")).toEqual({ admitted: false, reason: "outside-index" });
  });

  it("Understand unset (the default grant) means nothing is understood: everything is archive, and the legacy funnel agrees", () => {
    const cns = grantConsent({ source: "wa" });
    expect(cns.understandFrom).toBeNull();
    expect(importDays(3).inserted).toBe(3);
    expect(count("events", "origin = 'archive'")).toBe(3);
    expect(count("events", "dispatched_at IS NULL")).toBe(0);

    upsertSource({ id: "wa", type: "whatsapp", name: "WhatsApp" });
    const streamId = upsertStream({ sourceId: "wa", sourceExtId: "ma@x", name: "Ma", kind: "dm" });
    const actorId = upsertActor({ sourceId: "wa", sourceExtId: "ma@x", displayName: "Ma" });
    const r = insertEvent({
      externalId: "m-legacy",
      sourceId: "wa",
      sourceType: "whatsapp",
      streamId,
      actorId,
      ts: NOW_ISO,
      kind: "message",
      text: "beta khana kha liya?",
      mediaPath: null,
      rawJson: null,
    });
    expect(r.inserted).toBe(true);
    const row = rows(`id = '${r.id}'`)[0];
    expect(row.origin).toBe("archive");
    expect(row.dispatched_at).toBe(row.captured_at);
    expect(row.consent_id).toBe(cns.id);
    expect(readArchiveByEvent(r.id)?.text).toBe("beta khana kha liya?");
    expect(bundledEventIds().size).toBe(0);

    // Widen to 30 d: the legacy row becomes dispatchable like any other.
    setUnderstandWindow("wa", daysAgo(30));
    expect(rows(`id = '${r.id}'`)[0].dispatched_at).toBeNull();
    expect(bundledEventIds().has(r.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CNS-03
// ---------------------------------------------------------------------------

describe("CNS-03 — Understand never exceeds Index", () => {
  it("Understand 90 d over Index 30 d is rejected and nothing is written", () => {
    grantConsent({ source: "wa", indexFrom: daysAgo(30), understandFrom: daysAgo(7) });
    importDays(30);
    const before = rows();
    expect(() => setUnderstandWindow("wa", daysAgo(90))).toThrow(ConsentWindowError);
    // The consent row is untouched…
    const c = getConsent("wa")!;
    expect(c.understandFrom).toBe(daysAgo(7));
    expect(c.indexFrom).toBe(daysAgo(30));
    // …and so is every event row: no replay happened.
    expect(rows()).toEqual(before);
    expect(count("events", "origin = 'archive'")).toBe(22);
  });

  it("the same rule holds at grant time", () => {
    expect(() => grantConsent({ source: "browser", indexFrom: daysAgo(30), understandFrom: daysAgo(90) })).toThrow(
      ConsentWindowError,
    );
    expect(count("consents")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CNS-04
// ---------------------------------------------------------------------------

describe("CNS-04 — widening is a replay", () => {
  function seed() {
    grantConsent({ source: "wa", indexAll: true, understandFrom: daysAgo(7) });
    importDays(90);
    expect(count("events", "dispatched_at IS NULL")).toBe(8);
    return { events: count("events"), archive: archiveCount(), hashes: rows().map((r) => r.content_hash).sort() };
  }

  it("7 d → 30 d: the 23 extra days become dispatchable; no adapter activity; never a re-import", () => {
    const before = seed();
    const change = setUnderstandWindow("wa", daysAgo(30));
    expect(change.direction).toBe("widened");
    expect(change.replay.replayed).toBe(23);
    expect(change.replay.pending).toBe(0);
    expect(getConsent("wa")!.understandFrom).toBe(daysAgo(30));

    // Dispatchable now: days 0..30.
    expect(count("events", "dispatched_at IS NULL")).toBe(31);
    for (const r of rows(`ts >= '${daysAgo(30)}'`)) {
      expect(r.origin).toBe("backfill");
      expect(r.dispatched_at).toBeNull();
    }
    // Still archive beyond the new floor.
    expect(count("events", "origin = 'archive'")).toBe(59);
    expect(bundledEventIds().size).toBe(31);

    // Wrong: re-import. No row was inserted, no adapter ran: same count, same
    // hashes, same archive, no new source/stream.
    expect(count("events")).toBe(before.events);
    expect(archiveCount()).toBe(before.archive);
    expect(rows().map((r) => r.content_hash).sort()).toEqual(before.hashes);
    expect(count("sources")).toBe(1);
    expect(count("streams")).toBe(1);

    // Idempotent: widening to the same floor replays nothing.
    const again = setUnderstandWindow("wa", daysAgo(30));
    expect(again.direction).toBe("unchanged");
    expect(again.replay.replayed).toBe(0);
    expect(count("events")).toBe(before.events);
  });

  it("is resumable after a kill: a replay stopped mid-way continues from where it committed", () => {
    seed();
    // Record the new floor, then flip only the first chunk — the process dies here.
    const c = getConsent("wa")!;
    getDb()
      .prepare(`UPDATE consents SET understand_from = ? WHERE id = ?`)
      .run(daysAgo(30), c.id);
    const partial = replayArchive("wa", { chunk: 5, maxChunks: 1 });
    expect(partial.replayed).toBe(5);
    expect(partial.chunks).toBe(1);
    expect(partial.pending).toBe(18);
    expect(pendingReplayCount("wa")).toBe(18);
    expect(count("events", "dispatched_at IS NULL")).toBe(13);

    // "Restart": resume picks up exactly the 18 rows still marked archive.
    const resumed = resumeReplay("wa");
    expect(resumed.replayed).toBe(18);
    expect(resumed.pending).toBe(0);
    expect(count("events", "dispatched_at IS NULL")).toBe(31);
    expect(count("events", "origin = 'archive'")).toBe(59);
    expect(count("events")).toBe(90);
    // A second resume is a no-op.
    expect(resumeReplay("wa").replayed).toBe(0);
  });

  it("the replay only touches the widened source", () => {
    seed();
    grantConsent({ source: "browser", indexAll: true, understandFrom: daysAgo(7) });
    importDays(90, "browser", "goibibo.com");
    expect(count("events", "origin = 'archive'")).toBe(164);
    const change = setUnderstandWindow("wa", daysAgo(30));
    expect(change.replay.replayed).toBe(23);
    expect(count("events", "source_id = 'browser' AND origin = 'archive'")).toBe(82);
    expect(count("events", "source_id = 'wa' AND origin = 'archive'")).toBe(59);
  });

  it("shortening touches no row: what was understood stays (D4)", () => {
    seed();
    setUnderstandWindow("wa", daysAgo(30));
    const before = rows();
    const change = setUnderstandWindow("wa", daysAgo(3));
    expect(change.direction).toBe("shortened");
    expect(change.replay.replayed).toBe(0);
    expect(rows()).toEqual(before);
    // New captures honour the shorter window at once.
    expect(admitCapture("wa", daysAgo(5), NOW_ISO, "live").admitted && admitCapture("wa", daysAgo(5), NOW_ISO, "live")).toMatchObject({ origin: "archive", tier: "archive" });
    expect(admitCapture("wa", daysAgo(1), NOW_ISO, "live")).toMatchObject({ origin: "live", tier: "understand", dispatchedAt: null });
  });
});

// ---------------------------------------------------------------------------
// The predicate itself, over the envelope's ts (said) not captured_at (seen)
// ---------------------------------------------------------------------------

describe("admitCapture — the tier predicate is over ts, and the hash is what the adapter sent", () => {
  it("compares ts, not captured_at; an explicit origin='archive' request stays archive", () => {
    grantConsent({ source: "wa", indexAll: true, understandFrom: daysAgo(7) });
    // Said 10 days ago, captured now → archive.
    expect(admitCapture("wa", daysAgo(10), NOW_ISO, "backfill")).toMatchObject({ origin: "archive", dispatchedAt: NOW_ISO });
    // Said yesterday → understood, awaiting dispatch.
    expect(admitCapture("wa", daysAgo(1), NOW_ISO, "live")).toMatchObject({ origin: "live", dispatchedAt: null });
    // The adapter can ask for archive explicitly (S1.6 screen keeps what it captured).
    expect(admitCapture("wa", daysAgo(1), NOW_ISO, "archive")).toMatchObject({ origin: "archive", dispatchedAt: NOW_ISO });
  });

  it("the content hash is unchanged by the gate, so a replayed wave still dedupes", () => {
    grantConsent({ source: "wa", indexAll: true, understandFrom: daysAgo(7) });
    const env = envelope({ ts: daysAgo(20), origin: "backfill" });
    const first = appendEvents([env], NOW);
    const second = appendEvents([env], NOW);
    expect(first.inserted).toBe(1);
    expect(second).toEqual({ inserted: 0, skipped: 1, ids: first.ids });
    expect(rows()[0].content_hash).toBe(contentHash(env));
  });
});
