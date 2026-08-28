// ===========================================================================
// Bridge extraction AT INGEST (build P1.1): every appended event's literals
// land in event_bridge_keys, pairs fire against PAST holders of the same
// normal form, rows replay idempotently, and a failure never blocks ingest.
// Runs through the real single-writer path (db/eventlog.ts appendEvents).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import { bridgeIngestedEvents } from "./ingest.js";
import { bridgePartnersOf } from "./extract.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bridge-ingest-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function envelope(text: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  seq += 1;
  return {
    ts: `2026-08-25T19:${String(10 + seq).padStart(2, "0")}:00+05:30`,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["*audience"], mentions: [] },
    payload: { text },
    ...overrides,
  };
}

function keysOf(eventId: string): { kind: string; value_norm: string }[] {
  return getDb()
    .prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE event_id = ? ORDER BY kind, value_norm`)
    .all(eventId) as { kind: string; value_norm: string }[];
}

describe("keys at append", () => {
  it("extracts url / phone / email / order-id literals into event_bridge_keys", () => {
    const { id } = appendEvent(
      envelope(
        "book at https://www.goibibo.com/goa?utm_source=x — call +91 98765 43210 " +
          "or mail rohan@example.com, amazon order 403-1234567-1234567",
      ),
    );
    const keys = keysOf(id);
    const kinds = keys.map((k) => k.kind);
    expect(kinds).toContain("url");
    expect(kinds).toContain("phone");
    expect(kinds).toContain("email");
    expect(kinds).toContain("order_id");
    // Normal forms, not raw strings: tracking params gone, phone digits only.
    expect(keys.find((k) => k.kind === "url")!.value_norm).not.toContain("utm_source");
    expect(keys.find((k) => k.kind === "email")!.value_norm).toBe("rohan@example.com");
  });

  it("an event with no literals writes no keys and no bridges", () => {
    const { id } = appendEvent(envelope("chalo done, see you at 7"));
    expect(keysOf(id)).toHaveLength(0);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get()).toEqual({ n: 0 });
  });
});

describe("pairing against past holders", () => {
  it("bridges a new event to every earlier event sharing the literal, both ways", () => {
    const a = appendEvent(envelope("check https://goibibo.com/goa/villa-x")).id;
    const b = appendEvent(envelope("this one? https://goibibo.com/goa/villa-x?utm_medium=share")).id;

    const partnersOfA = bridgePartnersOf(a);
    expect(partnersOfA).toHaveLength(1);
    expect(partnersOfA[0]!.right_id).toBe(b);
    expect(partnersOfA[0]!.kind).toBe("url");
    expect(partnersOfA[0]!.confidence).toBe(1);
    // Mirrored row: readable from the other end too.
    expect(bridgePartnersOf(b).map((r) => r.right_id)).toEqual([a]);
  });

  it("a third holder bridges to BOTH earlier ones", () => {
    const a = appendEvent(envelope("order 403-1234567-1234567 from amazon")).id;
    const b = appendEvent(envelope("amazon says 403-1234567-1234567 shipped")).id;
    const c = appendEvent(envelope("403-1234567-1234567 delivered, amazon rocks")).id;
    expect(bridgePartnersOf(c).map((r) => r.right_id).sort()).toEqual([a, b].sort());
  });

  it("replays are idempotent: re-running writes nothing new", () => {
    const a = appendEvent(envelope("see https://example.com/x")).id;
    const b = appendEvent(envelope("again https://example.com/x")).id;
    const db = getDb();
    const count = () =>
      db.prepare(`SELECT (SELECT COUNT(*) FROM bridges) AS b, (SELECT COUNT(*) FROM event_bridge_keys) AS k`).get();
    const before = count();
    const res = bridgeIngestedEvents([a, b]);
    expect(res.keysWritten).toBe(0);
    expect(res.bridgesWritten).toBe(0);
    expect(count()).toEqual(before);
  });

  it("appendEvents dedupe (same content_hash) does not double-bridge", () => {
    const env = envelope("link https://example.com/y", { ts: "2026-08-25T19:42:10+05:30" });
    appendEvent(env);
    appendEvent(env); // skipped by content_hash
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM event_bridge_keys`).get()).toEqual({ n: 1 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get()).toEqual({ n: 0 });
  });

  it("unknown event ids are skipped, not thrown", () => {
    expect(bridgeIngestedEvents(["nope"])).toEqual({ keysWritten: 0, bridgesWritten: 0 });
  });
});
