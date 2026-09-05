// ===========================================================================
// CNS-09 — the card is honest (V6 P1 S1.8; GoldenEvals_V6_Phase1 §5.2) as a
// deterministic vitest case, the way S1.2 shipped CNS-01..04: fixture id in
// the describe title, the doc's Expected and Wrong lines asserted by code,
// ZERO model calls (SQLite on a temp file, a pinned clock).
//
//   Input.     A fixture import — 40 daily WhatsApp messages, Understand 30 d,
//              Index everything.
//   Expected.  Events exact; cost within ±40%; time within ±30%; card text
//              stored verbatim in `decisions`.
//   Wrong.     concurrency-8-time — quoting a parallel time for a serial run.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { setConsentGateMode, type ConsentGateMode } from "../db/consent-gate.js";
import { decisionsFor } from "../db/decisions.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { ConsentWindowError, getConsent } from "../db/v6core.js";
import { DEFAULT_CEILINGS } from "../providers/budget.js";
import {
  BYTES_PER_INDEXED_EVENT,
  BYTES_PER_UNDERSTOOD_EVENT,
  COST_PER_DAY_USD,
  SECONDS_PER_DAY_SERIAL,
  buildConfirmCard,
  confirmConsent,
  confirmedCardText,
  countEventsInWindows,
  formatDuration,
  renderCardText,
  windowDays,
} from "./confirm-card.js";

const DAY = 86_400_000;
/** The clock every case runs on: 2026-09-01 12:00 UTC. */
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

/** Message i is i½ days old: 0..29 sit inside a 30-day window, 30..39 outside it. */
function message(i: number): EventEnvelope {
  const ts = daysAgo(i + 0.5);
  return {
    ts,
    capturedAt: new Date(NOW).toISOString(),
    source: "whatsapp",
    kind: "whatsapp.message",
    origin: "backfill",
    streamKey: "goa@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: `message ${i} about the villa` },
  };
}

let tmpDir: string;
let prevMode: ConsentGateMode;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-confirm-card-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
});

afterEach(() => {
  setConsentGateMode(prevMode);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CNS-09 — the card is honest", () => {
  it("events exact · cost ±40% · time ±30% serial · card text verbatim in decisions", () => {
    // The source flow counted before consent (S1.5 messagesInRange): 40 in
    // the Index window, 30 inside the 30-day Understand window.
    const result = confirmConsent({
      source: "whatsapp",
      indexAll: true,
      understandFrom: daysAgo(30),
      counts: { index: 40, understand: 30, exact: true },
      nowMs: NOW,
    });
    const { card, consent } = result;
    expect(result.change).toBe("granted");

    // Now the import runs under that consent: 40 daily messages, 30 within
    // the window (days 0..29), 10 outside it (days 30..39 → archive tier).
    const appended = appendEvents(Array.from({ length: 40 }, (_, i) => message(i)), NOW);
    expect(appended.inserted).toBe(40);
    const understoodInLog = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source_type='whatsapp' AND origin <> 'archive'`)
        .get() as { n: number }
    ).n;

    // Events: exact, and equal to what the log actually holds in the tier.
    expect(card.events.accuracy).toBe("exact");
    expect(card.events.value).toBe(30);
    expect(card.events.value).toBe(understoodInLog);
    expect(card.events.display).toBe("30");
    expect(card.events.note).toBe("40 kept searchable");

    // Cost: days × $0.0104, labelled as the ±40% estimate it is, and the line
    // names the enforced daily ceiling (providers/budget.ts).
    expect(card.understandDays).toBe(30);
    const expectedCost = 30 * COST_PER_DAY_USD;
    expect(card.cost.value).toBeCloseTo(expectedCost, 10);
    expect(Math.abs(card.cost.value! - expectedCost)).toBeLessThanOrEqual(0.4 * expectedCost);
    expect(card.cost.accuracy).toBe("estimate ±40%");
    expect(card.cost.display).toBe("about $0.31");
    expect(card.stopAskUsd).toBe(DEFAULT_CEILINGS.usdPerDay);
    expect(card.cost.note).toBe(`we'll stop and ask if it passes $${DEFAULT_CEILINGS.usdPerDay.toFixed(2)} in a day`);

    // Time: days × 8.2 s, SERIAL, ±30%.
    const serial = 30 * SECONDS_PER_DAY_SERIAL;
    expect(card.time.value).toBeCloseTo(serial, 10);
    expect(Math.abs(card.time.value! - serial)).toBeLessThanOrEqual(0.3 * serial);
    expect(card.time.accuracy).toBe("estimate ±30%");
    expect(card.time.display).toBe("about 4 min 6 s");
    expect(card.time.note).toBe("one call after another, newest day first");

    // Disk: the narrow-archive model over the counts we have — "about".
    expect(card.disk.value).toBe(40 * BYTES_PER_INDEXED_EVENT + 30 * BYTES_PER_UNDERSTOOD_EVENT);
    expect(card.disk.accuracy).toBe("about");

    // Verbatim in decisions, referenced from consents.decision_id.
    expect(consent.decisionId).toBe(result.decisionId);
    const live = getConsent("whatsapp")!;
    expect(live.decisionId).toBe(result.decisionId);
    const decisions = decisionsFor("consent", live.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe(result.decisionId);
    expect(decisions[0].action).toBe("confirm");
    expect(decisions[0].pass).toBe("user");
    expect(decisions[0].reason).toBe(card.text);
    expect(JSON.parse(decisions[0].newJson!).text).toBe(card.text);
    expect(confirmedCardText(live)).toBe(card.text);

    // Every accuracy label is on its own line, in the stored text itself.
    expect(card.text.split("\n")).toEqual([
      "WhatsApp · understand from 2 Aug 2026 (30 days) · keep everything searchable",
      "Events: 30 (exact) — 40 kept searchable",
      `Cost: about $0.31 (estimate ±40%) — we'll stop and ask if it passes $${DEFAULT_CEILINGS.usdPerDay.toFixed(2)} in a day`,
      "Time: about 4 min 6 s (estimate ±30%) — one call after another, newest day first",
      "Disk: about 596 KB (about) — keeping history costs disk; understanding it costs money",
    ]);
  });

  it("wrong: concurrency-8-time — the quoted time is never the parallel figure", () => {
    const card = buildConfirmCard({
      source: "whatsapp",
      indexAll: true,
      understandFrom: daysAgo(30),
      counts: { index: 40, understand: 30, exact: true },
      nowMs: NOW,
    });
    const serial = 30 * SECONDS_PER_DAY_SERIAL;
    const concurrency8 = serial / 8;
    expect(card.time.value).toBeCloseTo(serial, 10);
    expect(Math.abs(card.time.value! - concurrency8)).toBeGreaterThan(0.3 * serial);
    expect(card.time.display).not.toBe(`about ${formatDuration(concurrency8)}`);
    expect(card.text).toContain("one call after another");
  });

  it("no number the code cannot compute: unknown counts render a dash, cost/time still real", () => {
    const card = buildConfirmCard({
      source: "browser",
      indexAll: true,
      understandFrom: daysAgo(7),
      counts: null,
      nowMs: NOW,
    });
    expect(card.events.value).toBeNull();
    expect(card.events.display).toBe("—");
    expect(card.events.note).toMatch(/not counted yet/);
    expect(card.disk.value).toBeNull();
    expect(card.disk.display).toBe("—");
    expect(card.cost.value).toBeCloseTo(7 * COST_PER_DAY_USD, 10);
    expect(card.time.value).toBeCloseTo(7 * SECONDS_PER_DAY_SERIAL, 10);
    expect(card.text).toContain("Events: — (exact) — not counted yet");
  });

  it("estimated counts are labelled 'about', never 'exact'", () => {
    const card = buildConfirmCard({
      source: "browser",
      indexAll: true,
      understandFrom: daysAgo(30),
      counts: { index: 1200, understand: 900, exact: false },
      nowMs: NOW,
    });
    expect(card.events.accuracy).toBe("about");
    expect(card.events.display).toBe("about 900");
  });

  it("understand nothing → $0, 0 s, nothing sent", () => {
    const card = buildConfirmCard({
      source: "whatsapp",
      indexAll: true,
      understandFrom: null,
      counts: { index: 40, understand: 40, exact: true },
      nowMs: NOW,
    });
    expect(card.understandDays).toBe(0);
    expect(card.events.value).toBe(0);
    expect(card.cost.value).toBe(0);
    expect(card.cost.display).toBe("$0");
    expect(card.cost.note).toBe("nothing is sent to a model");
    expect(card.time.display).toBe("0 s");
    expect(card.text).toContain("understand nothing");
  });

  it("CNS-03 still holds at the card: Understand past Index throws before any write", () => {
    expect(() =>
      buildConfirmCard({
        source: "whatsapp",
        indexAll: false,
        indexFrom: daysAgo(30),
        understandFrom: daysAgo(90),
        nowMs: NOW,
      }),
    ).toThrow(ConsentWindowError);
    expect(() =>
      confirmConsent({
        source: "whatsapp",
        indexAll: false,
        indexFrom: daysAgo(30),
        understandFrom: daysAgo(90),
        nowMs: NOW,
      }),
    ).toThrow(ConsentWindowError);
    expect(getConsent("whatsapp")).toBeNull();
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number }).n).toBe(0);
  });

  it("re-confirm counts the log exactly, widens as a replay, and stores a second card verbatim", () => {
    const first = confirmConsent({
      source: "whatsapp",
      indexAll: true,
      understandFrom: daysAgo(30),
      counts: { index: 40, understand: 30, exact: true },
      nowMs: NOW,
    });
    appendEvents(Array.from({ length: 40 }, (_, i) => message(i)), NOW);

    // No counts handed in: the worker counts the log (re-confirm case).
    const counted = countEventsInWindows("whatsapp", {
      indexAll: true,
      indexFrom: null,
      understandFrom: daysAgo(40),
    });
    expect(counted).toEqual({ index: 40, understand: 40, exact: true });

    const second = confirmConsent({ source: "whatsapp", indexAll: true, understandFrom: daysAgo(40), nowMs: NOW });
    expect(second.change).toBe("widened");
    expect(second.replayed).toBe(10);
    expect(second.card.events.value).toBe(40);
    expect(second.card.events.accuracy).toBe("exact");
    expect(second.consent.id).toBe(first.consent.id);
    expect(second.decisionId).not.toBe(first.decisionId);

    const live = getConsent("whatsapp")!;
    expect(live.understandFrom).toBe(daysAgo(40));
    expect(live.decisionId).toBe(second.decisionId);
    const decisions = decisionsFor("consent", live.id);
    expect(decisions.map((d) => d.action)).toEqual(["reconfirm", "confirm"]);
    expect(decisions[0].reason).toBe(second.card.text);
    expect(JSON.parse(decisions[0].oldJson!)).toEqual({
      indexAll: true,
      indexFrom: null,
      understandFrom: daysAgo(30),
    });
    // Every row is now in the Understand tier — the replay did its job.
    const archived = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE origin = 'archive'`).get() as { n: number }
    ).n;
    expect(archived).toBe(0);
  });
});

describe("card helpers", () => {
  it("windowDays rounds up and never goes negative", () => {
    expect(windowDays(null, NOW)).toBe(0);
    expect(windowDays(daysAgo(30), NOW)).toBe(30);
    expect(windowDays(new Date(NOW - 1000).toISOString(), NOW)).toBe(1);
    expect(windowDays(new Date(NOW + DAY).toISOString(), NOW)).toBe(0);
  });

  it("formatDuration never prints a fraction", () => {
    expect(formatDuration(8.2)).toBe("8 s");
    expect(formatDuration(246)).toBe("4 min 6 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(4320)).toBe("1 h 12 min");
    expect(formatDuration(7200)).toBe("2 h");
  });

  it("renderCardText is deterministic over the same card", () => {
    const a = buildConfirmCard({ source: "screen", indexAll: true, understandFrom: daysAgo(3), counts: { index: 9, understand: 9, exact: true }, nowMs: NOW });
    const b = buildConfirmCard({ source: "screen", indexAll: true, understandFrom: daysAgo(3), counts: { index: 9, understand: 9, exact: true }, nowMs: NOW });
    expect(a.text).toBe(b.text);
    expect(renderCardText(a)).toBe(a.text);
    expect(a.text.startsWith("Screen · understand from 29 Aug 2026 (3 days) · keep everything searchable")).toBe(true);
  });

  it("a bounded Index window is named with its floor and day count", () => {
    const card = buildConfirmCard({
      source: "browser",
      indexAll: false,
      indexFrom: daysAgo(90),
      understandFrom: daysAgo(30),
      counts: { index: 300, understand: 100, exact: true },
      nowMs: NOW,
    });
    expect(card.indexDays).toBe(90);
    expect(card.text.split("\n")[0]).toBe(
      "Browser · understand from 2 Aug 2026 (30 days) · keep searchable from 3 Jun 2026 (90 days)",
    );
  });
});
