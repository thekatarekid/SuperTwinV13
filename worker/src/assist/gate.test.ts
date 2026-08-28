// ===========================================================================
// Trigger-gate math (build P2.2, spec §10.1) — pure code, clock-mocked, no
// model calls. Covers the novelty accumulator (cross-source double-weight,
// re-observation increments nothing, >=2 new-content), per-category
// thresholds, cooldowns, dismissal suppression and quiet hours.
//
// AST-09 lives here as a code assertion: the cross-source count arithmetic
// is asserted exactly, not judged.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import {
  gateVerdict,
  noteDismissed,
  noteNudged,
  noteReopened,
  readTopic,
  readyTopics,
  recordEvent,
  topicKeyFor,
} from "./gate.js";
import { setAssistQuietHours, setAssistThreshold } from "./settings.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-assist-gate-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  // Tests run at a mocked 14:00 local; park quiet hours far away by default.
  setAssistQuietHours("03:00", "04:00");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Mocked "now": today 14:00 LOCAL time (quiet-hours math is local-clock). */
const NOW = new Date(2026, 7, 28, 14, 0, 0).getTime();
const MIN = 60_000;

let seq = 0;

function makeEvent(over: Partial<EventEnvelope> & { text?: string; url?: string }): EventEnvelope {
  seq += 1;
  const payload: Record<string, unknown> = {};
  if (over.text !== undefined) payload.text = over.text;
  if (over.url !== undefined) payload.url = over.url;
  const env: EventEnvelope = {
    ts: new Date(NOW - 5 * MIN + seq * 1000).toISOString(),
    source: over.source ?? "wa",
    kind: over.kind ?? "wa.message",
    origin: "live",
    streamKey: over.streamKey ?? "chat-1",
    actor: over.actor ?? "self",
    roles: { sender: "self", audience: [], receiver: [], mentions: [] },
    payload: { ...payload, ...(over.payload ?? {}) },
  };
  const { id } = appendEvent(env, NOW);
  return { ...env, id };
}

function record(over: Partial<EventEnvelope> & { text?: string; url?: string }) {
  return recordEvent(makeEvent(over), { nowMs: NOW });
}

describe("topic joining (the same machinery understanding uses)", () => {
  it("joins events from different sources by a shared bridge literal", () => {
    // Bridge extraction runs at ingest: both carry the same URL.
    const a = makeEvent({ source: "wa", text: "check https://villas.example/anjuna-6" });
    const b = makeEvent({
      source: "browser",
      kind: "browser.visit",
      streamKey: "villas.example",
      url: "https://villas.example/anjuna-6",
      text: "Anjuna villa listing https://villas.example/anjuna-6",
    });
    expect(topicKeyFor(a)).toBe(topicKeyFor(b));
  });

  it("falls back to the stream when no bridge or episode joins", () => {
    const e = makeEvent({ text: "no links here", streamKey: "chat-9" });
    expect(topicKeyFor(e)).toBe("stream:chat-9");
  });
});

describe("novelty accumulator (spec §10.1)", () => {
  it("counts distinct events and requires >=2 new-content", () => {
    setAssistThreshold("default", 3);
    const r1 = record({ text: "one", streamKey: "s" });
    const r2 = record({ text: "two", streamKey: "s" });
    const r3 = record({ text: "three", streamKey: "s" });
    expect(r3.state.weightedCount).toBe(3);
    expect(r3.state.newContentCount).toBe(3);
    expect(gateVerdict(r3.state, { nowMs: NOW }).ready).toBe(true);
    expect(r1.topicKey).toBe(r2.topicKey);
  });

  it("increments NOTHING for identical re-captured content (same hash)", () => {
    const env = makeEvent({ text: "same page", streamKey: "s" });
    const first = recordEvent(env, { nowMs: NOW });
    expect(first.counted).toBe(true);
    // The same envelope observed again — same content hash.
    const again = recordEvent(env, { nowMs: NOW });
    expect(again.counted).toBe(false);
    expect(again.weight).toBe(0);
    expect(again.state.weightedCount).toBe(first.state.weightedCount);
    expect(again.state.newContentCount).toBe(first.state.newContentCount);
  });

  it("AST-09: cross-source events count double — exact arithmetic", () => {
    // A WhatsApp message and a browser visit about the same URL: 1 + 2 = 3.
    const url = "https://shop.example/order/AB123";
    const r1 = record({ source: "wa", text: `where is my order? ${url}` });
    expect(r1.weight).toBe(1);
    const r2 = record({
      source: "browser",
      kind: "browser.visit",
      streamKey: "shop.example",
      url,
      text: `order status page ${url}`,
    });
    expect(r2.topicKey).toBe(r1.topicKey); // joined by the bridge
    expect(r2.weight).toBe(2); // cross-source double-weight
    expect(r2.state.weightedCount).toBe(3);

    // Two same-source events about the same thing would have been 2, not 3.
    const s1 = record({ source: "wa", streamKey: "solo", text: "aaa" });
    const s2 = record({ source: "wa", streamKey: "solo", text: "bbb" });
    expect(s2.state.weightedCount).toBe(2);
    expect(s1.weight + s2.weight).toBe(2);
  });

  it("a re-visit of a known url is a distinct event but NOT new content", () => {
    const url = "https://docs.example/page";
    record({ source: "browser", kind: "browser.visit", streamKey: "d", url, text: `v1 ${url}` });
    // New capture (different hash — different text), same ref.
    const r2 = record({ source: "browser", kind: "browser.visit", streamKey: "d", url, text: `v2 ${url}` });
    expect(r2.counted).toBe(true);
    expect(r2.newContent).toBe(false);
    expect(r2.state.weightedCount).toBe(2);
    expect(r2.state.newContentCount).toBe(1);
  });

  it("blocks a topic with enough events but <2 new-content", () => {
    setAssistThreshold("default", 2);
    const url = "https://site.example/one";
    record({ source: "browser", kind: "browser.visit", streamKey: "d", url, text: `a ${url}` });
    const r = record({ source: "browser", kind: "browser.visit", streamKey: "d", url, text: `b ${url}` });
    expect(r.state.weightedCount).toBe(2);
    expect(r.state.newContentCount).toBe(1);
    expect(gateVerdict(r.state, { nowMs: NOW })).toEqual({
      ready: false,
      reason: "insufficient_new_content",
    });
  });
});

describe("per-category thresholds (Settings › Assist)", () => {
  it("transaction topics fire at 3, research at 7, default at 5", () => {
    const mk = (n: number, category: string | null) => ({
      topicKey: "t",
      category,
      weightedCount: n,
      newContentCount: n,
      sources: ["wa"],
      seenHashes: [],
      seenRefs: [],
      // The firing count is DISTINCT events (AST-09) — one id per event.
      eventIds: Array.from({ length: n }, (_, i) => `e${i + 1}`),
      lastEventTs: null,
      cooldownUntil: null,
      dismissCount: 0,
      suppressedUntil: null,
    });
    expect(gateVerdict(mk(3, "transaction"), { nowMs: NOW }).ready).toBe(true);
    expect(gateVerdict(mk(2, "transaction"), { nowMs: NOW }).ready).toBe(false);
    expect(gateVerdict(mk(6, "research"), { nowMs: NOW }).ready).toBe(false);
    expect(gateVerdict(mk(7, "research"), { nowMs: NOW }).ready).toBe(true);
    expect(gateVerdict(mk(4, "default"), { nowMs: NOW }).ready).toBe(false);
    expect(gateVerdict(mk(5, "default"), { nowMs: NOW }).ready).toBe(true);
  });

  it("user-edited thresholds override the defaults", () => {
    setAssistThreshold("default", 2);
    const r1 = record({ text: "x", streamKey: "s" });
    const r2 = record({ text: "y", streamKey: "s" });
    expect(gateVerdict(r1.state, { nowMs: NOW }).ready).toBe(false);
    expect(gateVerdict(r2.state, { nowMs: NOW }).ready).toBe(true);
  });

  it("transaction category is derived from content", () => {
    const r = record({ text: "your order 4411 checkout is ready", streamKey: "s" });
    expect(r.state.category).toBe("transaction");
  });
});

describe("hygiene: cooldowns, suppression, quiet hours (clock-mocked)", () => {
  function readyState(topicKey = "stream:s") {
    setAssistThreshold("default", 2);
    record({ text: "one", streamKey: "s" });
    const r = record({ text: "two", streamKey: "s" });
    expect(r.topicKey).toBe(topicKey);
    expect(gateVerdict(r.state, { nowMs: NOW }).ready).toBe(true);
    return r.topicKey;
  }

  it("a nudge starts the per-context cooldown and spends the accumulator", () => {
    const key = readyState();
    noteNudged(key, { nowMs: NOW });
    const after = readTopic(key)!;
    expect(after.weightedCount).toBe(0);
    expect(gateVerdict(after, { nowMs: NOW }).reason).toBe("cooldown");
    // Past the cooldown the reason falls back to the (now-spent) threshold.
    expect(gateVerdict(after, { nowMs: NOW + 46 * MIN }).reason).toBe("below_threshold");
  });

  it("suppresses a context after 2 dismissals, and reopening lifts it", () => {
    const key = readyState();
    noteDismissed(key, { nowMs: NOW });
    expect(gateVerdict(readTopic(key)!, { nowMs: NOW }).ready).toBe(true); // 1 strike: still allowed
    noteDismissed(key, { nowMs: NOW });
    expect(gateVerdict(readTopic(key)!, { nowMs: NOW }).reason).toBe("suppressed");
    // Suppression outlasts the cooldown horizon (7 days by default).
    expect(gateVerdict(readTopic(key)!, { nowMs: NOW + 6 * 24 * 60 * MIN }).reason).toBe(
      "suppressed",
    );
    noteReopened(key, { nowMs: NOW });
    expect(gateVerdict(readTopic(key)!, { nowMs: NOW }).ready).toBe(true);
  });

  it("quiet hours block the gate, across midnight, on the mocked clock", () => {
    const key = readyState();
    setAssistQuietHours("22:00", "08:00");
    const at = (h: number, m = 0) => new Date(2026, 7, 28, h, m).getTime();
    expect(gateVerdict(readTopic(key)!, { nowMs: at(23) }).reason).toBe("quiet_hours");
    expect(gateVerdict(readTopic(key)!, { nowMs: at(7, 59) }).reason).toBe("quiet_hours");
    expect(gateVerdict(readTopic(key)!, { nowMs: at(8, 0) }).ready).toBe(true);
    expect(gateVerdict(readTopic(key)!, { nowMs: at(14) }).ready).toBe(true);
  });

  it("readyTopics lists exactly the topics clearing the gate", () => {
    const key = readyState();
    record({ text: "lonely", streamKey: "other" }); // below threshold
    const ready = readyTopics({ nowMs: NOW });
    expect(ready.map((t) => t.topicKey)).toEqual([key]);
  });
});
