// ===========================================================================
// Bridge extraction (arch §11.2, build item 2.4): the manifest gate, the eight
// kinds, the two thresholds, and rows that a replay re-writes instead of
// duplicating.
// ===========================================================================

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearRegistry, registerSource } from "../adapters/registry.js";
import type { SourceAdapter } from "../adapters/source-adapter.js";
import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import {
  bridgeId,
  bridgeKeysFor,
  bridgePartnersOf,
  bridgesByValue,
  extractBridges,
  extractCandidates,
  liveBridgeKeys,
  persistBridges,
  runBridgePass,
  type BridgeItem,
} from "./extract.js";
import { BRIDGE_KEYS } from "../adapters/registry.js";

const ALL = new Set(BRIDGE_KEYS);

function registerWhatsApp(): void {
  registerSource({
    manifest: WHATSAPP_MANIFEST,
    adapter: { sourceId: "whatsapp", sourceType: "whatsapp" } as unknown as SourceAdapter,
  });
}

let tmpDir: string;

beforeEach(() => {
  clearRegistry();
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bridges-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  clearRegistry();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the manifest gate", () => {
  it("reads the kinds off the registered manifest, not a constant", () => {
    registerWhatsApp();
    expect(bridgeKeysFor("whatsapp")).toEqual(["url", "phone", "email", "media_work_id", "order_id"]);
    expect(bridgeKeysFor("browser")).toBeNull();
  });

  it("a WhatsApp-only run computes only WhatsApp's five kinds", () => {
    registerWhatsApp();
    const live = liveBridgeKeys([{ source_id: "whatsapp" }]);
    expect([...live].sort()).toEqual(["email", "media_work_id", "order_id", "phone", "url"]);
    expect(live.has("geo_time")).toBe(false);
    expect(live.has("attendee_set")).toBe(false);
    expect(live.has("file_id")).toBe(false);
  });

  it("a second source widens the live set to the union of the manifests", () => {
    registerWhatsApp();
    // `drive` has no manifest yet, so it narrows nothing — all eight are live.
    const live = liveBridgeKeys([{ source_id: "whatsapp" }, { source_id: "drive" }]);
    expect(live.has("file_id")).toBe(true);
  });

  it("an explicit override wins over every manifest", () => {
    registerWhatsApp();
    expect([...liveBridgeKeys([{ source_id: "whatsapp" }], ["url"])]).toEqual(["url"]);
  });

  it("gates extraction: a geohash is never computed for a WhatsApp-only pass", () => {
    registerWhatsApp();
    const item: BridgeItem = {
      id: "e1",
      source_id: "whatsapp",
      ts: "2026-08-13T13:00:00.000Z",
      text: "here",
      geo: { lat: 19.0596, lon: 72.8295 },
      attendees: ["a1", "a2"],
    };
    expect(extractCandidates(item, liveBridgeKeys([item]))).toEqual([]);
    expect(extractCandidates(item, ALL).map((c) => c.kind).sort()).toEqual(["attendee_set", "geo_time"]);
  });
});

describe("candidates out of message text", () => {
  it("finds urls, emails, phones and order ids", () => {
    const item: BridgeItem = {
      id: "e1",
      source_id: "whatsapp",
      text:
        "villa here https://www.site0.com/x?utm_source=wa — mail rohan.malhotra+trips@gmail.com " +
        "or ring +91 98765 43210, MakeMyTrip booking id NF28123456789012",
    };
    const got = extractCandidates(item, ALL).map((c) => `${c.kind}=${c.value_norm}`).sort();
    expect(got).toEqual([
      "email=rohanmalhotra@gmail.com",
      "order_id=makemytrip:NF28123456789012",
      "phone=+919876543210",
      "url=site0.com/x",
    ]);
  });

  it("reads an Amazon order id with no label, and does not mistake it for a phone", () => {
    const item: BridgeItem = { id: "e1", source_id: "gmail", text: "Your Amazon order 407-1234567-1234567 shipped" };
    const got = extractCandidates(item, ALL).map((c) => `${c.kind}=${c.value_norm}`);
    expect(got).toContain("order_id=amazon:407-1234567-1234567");
    expect(got.some((g) => g.startsWith("phone="))).toBe(false);
  });

  it("pulls a Drive file id out of a link", () => {
    const item: BridgeItem = {
      id: "e1",
      source_id: "whatsapp",
      text: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnO/view?usp=sharing",
    };
    const got = extractCandidates(item, ALL).map((c) => `${c.kind}=${c.value_norm}`);
    expect(got).toContain("file_id=gdrive:1AbCdEfGhIjKlMnO");
  });
});

describe("exact-literal bridges", () => {
  it("joins a link shared in chat to the same canonical url visited in the browser", () => {
    const edges = extractBridges([
      { id: "e1", source_id: "whatsapp", text: "look https://site0.com/x?utm_source=wa&fbclid=z" },
      { id: "b1", source_id: "browser", urls: ["https://www.site0.com/x/"] },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      kind: "url",
      value_norm: "site0.com/x",
      left_id: "b1",
      right_id: "e1",
      confidence: 1,
      decided_by: "code:bridge/url",
    });
  });

  it("does not bridge an object to itself", () => {
    expect(
      extractBridges([{ id: "e1", source_id: "whatsapp", text: "https://site0.com/x https://site0.com/x/" }]),
    ).toEqual([]);
  });

  it("emits every pair in a group, canonically ordered", () => {
    const edges = extractBridges([
      { id: "e3", source_id: "whatsapp", text: "https://site0.com/x" },
      { id: "e1", source_id: "whatsapp", text: "https://site0.com/x" },
      { id: "e2", source_id: "whatsapp", text: "https://site0.com/x" },
    ]);
    expect(edges.map((e) => `${e.left_id}-${e.right_id}`)).toEqual(["e1-e2", "e1-e3", "e2-e3"]);
  });

  it("honours the pair cap rather than going quadratic on a viral link", () => {
    const items: BridgeItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      source_id: "whatsapp",
      text: "https://site0.com/x",
    }));
    expect(extractBridges(items, { maxPairsPerValue: 4 })).toHaveLength(4);
  });
});

describe("measured bridges", () => {
  const roomA = ["p1", "p2", "p3", "p4"];

  it("attendee_set fires at Jaccard >= 0.6 and not below", () => {
    const fire = (b: string[]) =>
      extractBridges([
        { id: "c1", source_id: "calendar", attendees: roomA },
        { id: "g1", source_id: "whatsapp", attendees: b },
      ]);
    // 3 shared of 5 union = 0.6
    expect(fire(["p1", "p2", "p3", "p9"])).toHaveLength(1);
    // 2 shared of 6 union = 0.33
    expect(fire(["p1", "p2", "p8", "p9"])).toEqual([]);
    const [edge] = fire(["p1", "p2", "p3", "p4"]);
    expect(edge).toMatchObject({ kind: "attendee_set", value_norm: "p1+p2+p3+p4", confidence: 1 });
  });

  it("geo_time needs 200 m AND 45 min", () => {
    const t0 = "2026-08-13T13:00:00.000Z";
    const at = (lat: number, minutes: number): BridgeItem => ({
      id: "z1",
      source_id: "zomato",
      ts: new Date(Date.parse(t0) + minutes * 60_000).toISOString(),
      geo: { lat, lon: 72.8295 },
    });
    const drop: BridgeItem = { id: "u1", source_id: "uber", ts: t0, geo: { lat: 19.0596, lon: 72.8295 } };
    expect(extractBridges([drop, at(19.06095, 30)])).toHaveLength(1); // 150 m / 30 min
    expect(extractBridges([drop, at(19.06185, 30)])).toEqual([]); // 250 m / 30 min
    expect(extractBridges([drop, at(19.06095, 60)])).toEqual([]); // 150 m / 60 min
  });
});

describe("persistence", () => {
  const items: BridgeItem[] = [
    { id: "e1", source_id: "whatsapp", object_kind: "event", text: "https://site0.com/x?utm_source=wa" },
    { id: "b1", source_id: "browser", object_kind: "event", urls: ["https://site0.com/x"] },
  ];

  it("stores the bridge in both directions", () => {
    runBridgePass(items);
    const rows = getDb().prepare(`SELECT left_id, right_id FROM bridges ORDER BY left_id`).all();
    expect(rows).toEqual([
      { left_id: "b1", right_id: "e1" },
      { left_id: "e1", right_id: "b1" },
    ]);
    expect(bridgePartnersOf("e1").map((r) => r.right_id)).toEqual(["b1"]);
    expect(bridgePartnersOf("b1").map((r) => r.right_id)).toEqual(["e1"]);
  });

  it("is idempotent under replay — same ids, no twins", () => {
    expect(persistBridges(extractBridges(items))).toBe(2);
    expect(persistBridges(extractBridges(items))).toBe(0);
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get() as { n: number };
    expect(n.n).toBe(2);
    expect(bridgeId("url", "site0.com/x", "b1", "e1")).toBe(bridgeId("url", "site0.com/x", "b1", "e1"));
    expect(bridgeId("url", "site0.com/x", "b1", "e1")).not.toBe(bridgeId("url", "site0.com/x", "e1", "b1"));
  });

  it("reads back through the (kind, value_norm) index", () => {
    runBridgePass(items);
    expect(bridgesByValue("url", "site0.com/x")).toHaveLength(2);
    expect(bridgesByValue("url", "nowhere.com")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The invariant the §14.2 arcs rows rest on: rung ① is [CODE].
// ---------------------------------------------------------------------------

describe("bridges are deterministic [CODE] with zero model calls", () => {
  it("imports no provider, no prompt and no embedder — structurally, not by promise", () => {
    // The eval executor reports `model_calls: 0` for K. That is a DECLARATION.
    // This is the proof: a module that cannot reach a model cannot spend one,
    // and the day somebody adds `import { runPrompt }` here, this fails.
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of ["extract.ts", "normalise.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/providers\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/prompts\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/retrieval\/(embed|calibration)/);
      }
    }
  });

  it("produces byte-identical output for the same input, run after run", () => {
    const same: BridgeItem[] = [
      { id: "e1", source_id: "whatsapp", object_kind: "event", text: "https://site0.com/x?utm_source=wa" },
      { id: "b1", source_id: "browser", object_kind: "event", urls: ["https://site0.com/x"] },
    ];
    const once = extractBridges(same);
    const twice = extractBridges(same);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // Ids are content hashes, so determinism survives a process boundary too.
    expect(once.map((b) => b.id)).toEqual(twice.map((b) => b.id));
  });
});
