// ===========================================================================
// GATE-01..05 · the state gate (GoldenEvals V6 P1 §5.6). Deterministic, zero
// model calls. GATE-01 and GATE-02 are the thesis: identical bytes ("ok"),
// opposite decisions, decided by state and never by the text.
// ===========================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../db/connection.js";
import { ACTIVE_EPISODE_WINDOW_MS, addressedToTwin, gateEvent } from "./gate.js";
import {
  append,
  MIN,
  msgAt,
  openScratchDb,
  seedEpisode,
  seedOpenTask,
  seedPerson,
  seedSpace,
  seedSpaceBridge,
  streamIdOf,
  T0,
  visitAt,
  type ScratchDb,
} from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-gate-");
});
afterEach(() => db.close());

const GOA = "goa-gang@g.us";
const OTHER = "college-friends@g.us";

describe("GATE-01 / GATE-02 · same bytes, opposite decisions", () => {
  it("GATE-01 · an open task in the stream makes 'ok' hot", () => {
    // Setup: an episode of the space on wa:goa-gang, an open task in that space.
    const [seed] = append([msgAt(GOA, T0 - 30 * MIN, "collect advance from karan by friday", { actor: "self" })]);
    seedSpace("sp_goa", "Goa trip");
    seedEpisode("ep_goa", streamIdOf("wa", GOA), T0 - 30 * MIN, { spaceId: "sp_goa", state: "closed", eventIds: [seed] });
    seedOpenTask("tsk_adv", "collect advance from Karan", "sp_goa");

    const [id] = append([msgAt(GOA, T0, "ok")]);
    const d = gateEvent({ id, streamId: streamIdOf("wa", GOA), source: "wa", kind: "wa.message", actor: "contact:karan" }, { nowMs: T0 });
    expect(d.decision).toBe("hot");
    expect(d.reason).toBe("open_task_in_stream");
    expect(d.tookMs).toBeLessThan(100);
  });

  it("GATE-01 · evidence-only tie (no space) also counts as 'in this stream'", () => {
    const [seed] = append([msgAt(GOA, T0 - 30 * MIN, "collect advance from karan", { actor: "self" })]);
    seedOpenTask("tsk_adv", "collect advance from Karan", null, [seed]);
    const [id] = append([msgAt(GOA, T0, "ok")]);
    expect(gateEvent({ id, streamId: streamIdOf("wa", GOA), source: "wa", actor: "contact:karan" }, { nowMs: T0 }).reason).toBe(
      "open_task_in_stream",
    );
    // The inline `{event_ids[], quote}` shape the passes write resolves too.
    getDb().prepare(`UPDATE tasks SET evidence_json = ? WHERE id = 'tsk_adv'`).run(JSON.stringify([{ event_ids: [seed], quote: "collect advance" }]));
    expect(gateEvent({ id, streamId: streamIdOf("wa", GOA), source: "wa", actor: "contact:karan" }, { nowMs: T0 }).decision).toBe("hot");
  });

  it("GATE-02 · the same 'ok' with no open task anywhere is cold", () => {
    const [id] = append([msgAt(OTHER, T0, "ok")]);
    const d = gateEvent({ id, streamId: streamIdOf("wa", OTHER), source: "wa", kind: "wa.message", actor: "contact:karan" }, { nowMs: T0 });
    expect(d.decision).toBe("cold");
    expect(d.reason).toBeNull();
  });

  it("GATE-02 · an open task in ANOTHER stream does not leak", () => {
    const [seed] = append([msgAt(GOA, T0 - 30 * MIN, "collect advance", { actor: "self" })]);
    seedSpace("sp_goa", "Goa trip");
    seedEpisode("ep_goa", streamIdOf("wa", GOA), T0 - 30 * MIN, { spaceId: "sp_goa", eventIds: [seed], state: "closed" });
    seedOpenTask("tsk_adv", "collect advance from Karan", "sp_goa");
    const [id] = append([msgAt(OTHER, T0, "ok")]);
    expect(gateEvent({ id, streamId: streamIdOf("wa", OTHER), source: "wa", actor: "contact:karan" }, { nowMs: T0 }).decision).toBe("cold");
  });

  it("a done task is not an open task", () => {
    seedSpace("sp_goa", "Goa trip");
    seedEpisode("ep_goa", streamIdOf("wa", GOA), T0 - 30 * MIN, { spaceId: "sp_goa", state: "closed" });
    seedOpenTask("tsk_adv", "collect advance", "sp_goa");
    getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = 'tsk_adv'`).run();
    const [id] = append([msgAt(GOA, T0, "ok")]);
    expect(gateEvent({ id, streamId: streamIdOf("wa", GOA), source: "wa", actor: "contact:karan" }, { nowMs: T0 }).decision).toBe("cold");
  });
});

describe("GATE-03 · an active episode makes it hot", () => {
  it("an episode open 4 minutes ago on wa:rohan", () => {
    const ROHAN = "919800000001@s.whatsapp.net";
    seedEpisode("ep_villa", streamIdOf("wa", ROHAN), T0 - 4 * MIN, { state: "open" });
    const [id] = append([msgAt(ROHAN, T0, "and the villa?", { actor: "contact:rohan" })]);
    const d = gateEvent({ id, streamId: streamIdOf("wa", ROHAN), source: "wa", actor: "contact:rohan" }, { nowMs: T0 });
    expect(d).toMatchObject({ decision: "hot", reason: "active_episode" });
  });

  it("a stale open episode (past the window) or a closed one is not active", () => {
    const ROHAN = "919800000001@s.whatsapp.net";
    seedEpisode("ep_old", streamIdOf("wa", ROHAN), T0 - ACTIVE_EPISODE_WINDOW_MS - MIN, { state: "open" });
    seedEpisode("ep_closed", streamIdOf("wa", ROHAN), T0 - MIN, { state: "closed" });
    const [id] = append([msgAt(ROHAN, T0, "and the villa?", { actor: "contact:rohan" })]);
    expect(gateEvent({ id, streamId: streamIdOf("wa", ROHAN), source: "wa", actor: "contact:rohan" }, { nowMs: T0 }).decision).toBe("cold");
  });
});

describe("GATE-04 · a bridge to an active space", () => {
  it("a browser visit to a listing the active space already bridges", () => {
    const url = "https://www.airbnb.com/rooms/812345";
    const [id] = append([visitAt("airbnb.com", T0, url, "Villa Anjuna · Airbnb")]);
    // The key the ingest extractor wrote for that visit, bridged into the space.
    const key = getDb().prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE event_id = ? AND kind = 'url'`).get(id) as
      | { kind: string; value_norm: string }
      | undefined;
    expect(key).toBeDefined();
    seedSpace("sp_goa_dec", "Goa trip with Rohan in December");
    seedSpaceBridge("sp_goa_dec", key!.kind, key!.value_norm);

    const d = gateEvent({ id, streamId: `browser:st:browser:chrome:default:airbnb.com:2026-08-28`, source: "browser", actor: "self" }, { nowMs: T0 });
    expect(d).toMatchObject({ decision: "hot", reason: "bridge_to_active_space" });
  });

  it("the same bridge into a DORMANT space stays cold", () => {
    const url = "https://www.airbnb.com/rooms/812345";
    const [id] = append([visitAt("airbnb.com", T0, url, "Villa Anjuna · Airbnb")]);
    const key = getDb().prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE event_id = ? AND kind = 'url'`).get(id) as { kind: string; value_norm: string };
    seedSpace("sp_old", "Goa 2024", "dormant");
    seedSpaceBridge("sp_old", key.kind, key.value_norm);
    expect(gateEvent({ id, streamId: "browser:st:x", source: "browser", actor: "self" }, { nowMs: T0 }).decision).toBe("cold");
  });

  it("an entity of an active space (the sender) makes it hot", () => {
    seedSpace("sp_goa_dec", "Goa trip");
    seedPerson("ent_rohan", "Rohan Mehta", "contact:rohan", "sp_goa_dec");
    const [id] = append([msgAt(OTHER, T0, "lunch?", { actor: "contact:rohan" })]);
    const d = gateEvent({ id, streamId: streamIdOf("wa", OTHER), source: "wa", actor: "contact:rohan" }, { nowMs: T0 });
    expect(d).toMatchObject({ decision: "hot", reason: "entity_in_active_space" });
  });
});

describe("GATE-05 · addressed to the twin", () => {
  it("a bar utterance is always hot", () => {
    const d = gateEvent({ id: null, streamId: "twin:st:bar:thread-1", source: "twin", kind: "bar.message", actor: "self", streamKey: "bar:thread-1" }, { nowMs: T0 });
    expect(d).toMatchObject({ decision: "hot", reason: "addressed_to_twin" });
    expect(addressedToTwin({ streamId: "x", source: "wa", roles: { sender: "self", receiver: ["self"] } })).toBe(true); // self-chat
    expect(addressedToTwin({ streamId: "x", source: "wa", roles: { sender: "self", receiver: ["contact:karan"] } })).toBe(false);
  });
});

describe("content_gated_call = 0 · the gate never reads content", () => {
  it("gate.ts contains no regex, no keyword list and no character count", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "gate.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/\.text\b/);
    expect(code).not.toMatch(/\.length\s*[<>]/);
    expect(code).not.toMatch(/new RegExp|\.test\(|\.match\(/);
    expect(code).not.toMatch(/\bINTENT\b|keyword/i);
  });

  it("the gate's inputs carry no text field at all", () => {
    const [id] = append([msgAt(GOA, T0, "PAY NOW book urgent villa advance ₹50,000")]);
    // Loud words, no state → cold. Identical decision to "ok" with no state.
    expect(gateEvent({ id, streamId: streamIdOf("wa", GOA), source: "wa", actor: "contact:karan" }, { nowMs: T0 }).decision).toBe("cold");
  });
});
