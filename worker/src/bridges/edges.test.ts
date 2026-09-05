// ===========================================================================
// Bridges as graph edges (V6 P1 S2.6; Build §5.2).
//
//   RET-10  bridge join. An Airbnb URL in a WhatsApp message and in a browser
//           visit → edge `bridge:url` at confidence 1.0, written at ingest;
//           the packer's `[BRIDGED]` block lists both.
//
// Runs through the real single-writer path (db/eventlog.ts appendEvents),
// which calls bridges/ingest.ts on every admitted event. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { graphWalk } from "../retrieval/graph.js";
import { bridgedBlock, bridgedLines, BRIDGED_HEADER, renderBridgedBlock } from "../packer/bridged.js";
import { BRIDGE_EDGE_KIND, bridgeEdgeLabel, bridgeEdgesOf, bridgesAmong, GRAPH_BRIDGE_KINDS } from "./edges.js";

const AIRBNB = "https://www.airbnb.com/rooms/48213977";
const T_WA = "2026-08-14T15:40:00.000Z";
const T_BROWSER = "2026-08-14T15:44:00.000Z";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-bridge-edges-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function waMessage(text: string, ts = T_WA, overrides: Partial<EventEnvelope> = {}): string {
  return appendEvent({
    ts,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["*audience"], mentions: [] },
    payload: { text },
    ...overrides,
  }).id;
}

function browserVisit(url: string, title: string, ts = T_BROWSER): string {
  return appendEvent({
    ts,
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: "www.airbnb.com",
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { url, title, text: `${title} ${url}`, domain: "www.airbnb.com", browser: "chrome" },
  }).id;
}

describe("RET-10 — bridge join", () => {
  it("the same Airbnb URL in a WhatsApp message and a browser visit is a bridge:url edge at 1.0, written at ingest", () => {
    // Different tracking params on each side: the normal form is the join key.
    const wa = waMessage(`Rohan: this one? ${AIRBNB}?utm_source=share — 6 beds, pool`);
    const br = browserVisit(`${AIRBNB}?utm_medium=chrome_share`, "Villa Serena · Airbnb");

    // No extra call: ingest wrote the pair. The read side presents it as an edge.
    const fromWa = bridgeEdgesOf(wa);
    expect(fromWa).toHaveLength(1);
    expect(fromWa[0]).toMatchObject({
      kind: BRIDGE_EDGE_KIND,
      subtype: "url",
      label: "bridge:url",
      srcEventId: wa,
      dstEventId: br,
      confidence: 1,
    });
    expect(fromWa[0]!.valueNorm).toContain("airbnb.com/rooms/48213977");
    expect(fromWa[0]!.valueNorm).not.toContain("utm_");

    // Bidirectional: the browser visit sees the message.
    const fromBrowser = bridgeEdgesOf(br);
    expect(fromBrowser.map((e) => e.dstEventId)).toEqual([wa]);
    expect(bridgeEdgeLabel("phone")).toBe("bridge:phone");
  });

  it("the packer's [BRIDGED] block lists both ends", () => {
    const wa = waMessage(`Rohan: this one? ${AIRBNB} — 6 beds, pool`);
    const br = browserVisit(AIRBNB, "Villa Serena · Airbnb");
    // Only the message is in the bundle; the block still shows the visit.
    const lines = bridgedLines([wa]);
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l!.edge.label).toBe("bridge:url");
    expect([l!.left.eventId, l!.right.eventId].sort()).toEqual([wa, br].sort());
    const waEnd = l!.left.eventId === wa ? l!.left : l!.right;
    const brEnd = l!.left.eventId === br ? l!.left : l!.right;
    expect(waEnd).toMatchObject({ source: "wa", ts: T_WA, inBundle: true });
    expect(brEnd).toMatchObject({ source: "browser", ts: T_BROWSER, inBundle: false });
    expect(brEnd.head).toContain("Villa Serena");

    const block = bridgedBlock([wa]);
    expect(block.startsWith(BRIDGED_HEADER)).toBe(true);
    expect(block).toContain("bridge:url 1.00");
    expect(block).toContain(wa);
    expect(block).toContain(br);
    expect(block).toContain("wa 2026-08-14 15:40");
    expect(block).toContain("browser 2026-08-14 15:44");
    expect(block.split("\n")).toHaveLength(2);
  });

  it("the graph walk crosses the bridge and reaches the visit's episode at hop 2", () => {
    const wa = waMessage(`Rohan: this one? ${AIRBNB}`);
    const br = browserVisit(AIRBNB, "Villa Serena · Airbnb");
    getDb().prepare(`INSERT INTO episodes (id, state, summary, first_ts, last_ts) VALUES ('ep_villa', 'open', 'Villa hunt', ?, ?)`).run(T_BROWSER, T_BROWSER);
    addEpisodeEvents("ep_villa", [br], "test");

    const r = graphWalk([{ kind: "event", id: wa }], { now: "2026-08-15T00:00:00.000Z" });
    const keys = new Map(r.hits.map((h) => [h.key, h]));
    const visit = keys.get(`event:${br}`);
    expect(visit).toBeDefined();
    expect(visit!.hop).toBe(1);
    expect(visit!.path.map((s) => s.edge)).toEqual(["bridge:url"]);
    expect(visit!.path[0]!.confidence).toBe(1);
    const ep = keys.get("episode:ep_villa");
    expect(ep).toBeDefined();
    expect(ep!.hop).toBe(2);
    expect(ep!.path.map((s) => s.edge)).toEqual(["bridge:url", "member_of"]);
  });
});

describe("bridge edge reads", () => {
  it("phone and order-id literals bridge too; kinds filter and fan-out cap apply", () => {
    const a = waMessage("Rohan: call the villa guy +91 98765 43210, amazon order 403-1234567-1234567");
    const b = waMessage("Tanvi: +91 98765 43210 is the caretaker", "2026-08-14T16:00:00.000Z");
    const c = waMessage("self: amazon says order 403-1234567-1234567 shipped", "2026-08-14T16:10:00.000Z");

    const all = bridgeEdgesOf(a);
    expect(all.map((e) => `${e.label}→${e.dstEventId}`).sort()).toEqual([`bridge:order_id→${c}`, `bridge:phone→${b}`].sort());
    expect(bridgeEdgesOf(a, { kinds: ["phone"] }).map((e) => e.dstEventId)).toEqual([b]);
    expect(bridgeEdgesOf(a, { fanOut: 1 })).toHaveLength(1);
    expect(bridgeEdgesOf(a, { fanOut: 0 })).toEqual([]);
    expect(GRAPH_BRIDGE_KINDS).toContain("url");
    expect(GRAPH_BRIDGE_KINDS).toContain("phone");
    expect(GRAPH_BRIDGE_KINDS).toContain("order_id");
  });

  it("bridgesAmong folds the mirror rows into one edge per pair and literal", () => {
    const a = waMessage(`A ${AIRBNB}`);
    const b = waMessage(`B ${AIRBNB}`, "2026-08-14T16:00:00.000Z");
    const c = waMessage(`C ${AIRBNB}`, "2026-08-14T16:10:00.000Z");
    // Three events, one literal → three unordered pairs, each once.
    const among = bridgesAmong([a, b, c]);
    expect(among).toHaveLength(3);
    for (const e of among) expect(e.srcEventId <= e.dstEventId).toBe(true);
    expect(bridgesAmong([a, b, c], { fanOut: 2 })).toHaveLength(2);
    expect(bridgesAmong([])).toEqual([]);
    expect(bridgesAmong(["ev_nobody"])).toEqual([]);
  });

  it("an event with no shared literal has no edges and an empty block", () => {
    const a = waMessage("chalo done, see you at 7");
    expect(bridgeEdgesOf(a)).toEqual([]);
    expect(bridgedBlock([a])).toBe("");
    expect(renderBridgedBlock([])).toBe("");
  });
});
