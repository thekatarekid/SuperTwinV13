// ===========================================================================
// RET-04 (the Library half) + Library storage routes — V6 P1 S1.8.
//
//   RET-04  archive-only rows are searchable.
//           Input.    An event outside the Understand window.
//           Expected. Appears in search, cited by archive id, labelled
//                     searchable-only, carries no episode.
//           This suite asserts the storage/labelling half: the row is in the
//           searchable bar and NOT the understood bar, it has an archive id to
//           be cited by, the label is "searchable-only" with the plain-words
//           note, and no episode membership names it. The search half (the
//           row appearing in results) lands with S2.7's coverage index.
//
//   Storage: free disk FIRST, two bars per source with bytes per tier, two
//   disk budgets each with its own rails. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { setConsentGateMode, type ConsentGateMode } from "../db/consent-gate.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { grantConsent, readArchiveByEvent } from "../db/v6core.js";
import {
  DEFAULT_EVENTS_BUDGET_BYTES_PER_YEAR,
  DEFAULT_MEDIA_BUDGET_BYTES,
  DEFAULT_MEDIA_RETENTION_DAYS,
  SEARCHABLE_ONLY_NOTE,
  STORAGE_COPY_LEAD,
  tierLabel,
} from "../library/storage.js";
import { handleLibraryStorageRoute } from "./library-storage-routes.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

function env(source: string, ts: string, text: string): EventEnvelope {
  return {
    ts,
    capturedAt: new Date(NOW).toISOString(),
    source,
    kind: `${source}.message`,
    origin: "backfill",
    streamKey: "goa@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  };
}

let tmpDir: string;
let server: Server;
let base: string;
let prevMode: ConsentGateMode;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-library-storage-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
  server = createServer((req, res) => {
    void handleLibraryStorageRoute(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setConsentGateMode(prevMode);
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(base + path);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("RET-04 — archive-only rows are searchable (Library half)", () => {
  it("outside Understand → searchable bar only, cited by archive id, labelled, no episode", async () => {
    grantConsent({ source: "whatsapp", indexAll: true, understandFrom: daysAgo(7) });
    const appended = appendEvents(
      [env("whatsapp", daysAgo(30), "old: the villa deposit was ₹40,000"), env("whatsapp", daysAgo(1), "new: pool villa or bust")],
      NOW,
    );
    expect(appended.inserted).toBe(2);
    const [oldId, newId] = appended.ids;

    // Cited by archive id: the narrow row exists and has its own id.
    const archive = readArchiveByEvent(oldId);
    expect(archive).not.toBeNull();
    expect(archive!.id).toMatch(/^arc_/);
    expect(archive!.eventId).toBe(oldId);

    // Labelled searchable-only, from the one helper the UI and search share.
    const rows = getDb()
      .prepare(`SELECT id, origin FROM events WHERE id IN (?, ?) ORDER BY ts`)
      .all(oldId, newId) as { id: string; origin: string | null }[];
    expect(rows.map((r) => tierLabel(r))).toEqual(["searchable-only", "understood"]);

    // Carries no episode.
    const membership = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM episode_events
          WHERE event_id = ? OR start_event_id = ? OR end_event_id = ?`,
      )
      .get(oldId, oldId, oldId) as { n: number };
    expect(membership.n).toBe(0);

    // The Library sees two bars: 2 searchable, 1 understood, 1 searchable-only.
    const { status, json } = await get("/api/library/storage");
    expect(status).toBe(200);
    const wa = json.sources.find((s: any) => s.source === "whatsapp");
    expect(wa).toBeDefined();
    expect(wa.searchable.events).toBe(2);
    expect(wa.understood.events).toBe(1);
    expect(wa.searchable_only.events).toBe(1);
    expect(wa.searchable_only.label).toBe("searchable-only");
    expect(wa.searchable_only.note).toBe(SEARCHABLE_ONLY_NOTE);
    expect(wa.searchable_only.note).toMatch(/carries no episode/);
    expect(wa.searchable_only.from).toBe(daysAgo(30));
    expect(wa.understood.from).toBe(daysAgo(1));
    // Bytes per tier: what the disk holds for each, and the tiers add up.
    expect(wa.searchable.bytes).toBeGreaterThan(0);
    expect(wa.understood.bytes).toBeGreaterThan(0);
    expect(wa.searchable_only.bytes).toBeGreaterThan(0);
    expect(wa.understood.bytes + wa.searchable_only.bytes).toBe(wa.searchable.bytes);
    expect(wa.consent).toMatchObject({ state: "connected", index_all: true, understand_from: daysAgo(7) });
  });
});

describe("GET /api/library/storage", () => {
  it("leads with free disk, then the two budgets at their defaults, then the copy", async () => {
    const { json, text } = await get("/api/library/storage");
    // Free space FIRST — literally the first key of the payload (T5-6).
    expect(Object.keys(json)[0]).toBe("disk");
    expect(text.startsWith('{"disk":')).toBe(true);
    expect(json.disk.free_bytes).toBeGreaterThan(0);
    expect(json.disk.total_bytes).toBeGreaterThanOrEqual(json.disk.free_bytes);
    expect(json.used.events_derived_bytes).toBeGreaterThan(0); // the db file itself
    expect(json.used.media_bytes).toBe(0);
    expect(json.budgets).toEqual({
      events_bytes_per_year: DEFAULT_EVENTS_BUDGET_BYTES_PER_YEAR,
      media_bytes: DEFAULT_MEDIA_BUDGET_BYTES,
      media_retention_days: DEFAULT_MEDIA_RETENTION_DAYS,
    });
    expect(json.copy.lead).toBe(STORAGE_COPY_LEAD);
    expect(json.copy.lead).toBe("Keeping more history costs disk. Understanding more history costs money.");
    expect(json.sources).toEqual([]);
  });

  it("lists a consented source with no rows yet as empty bars", async () => {
    grantConsent({ source: "browser", indexAll: true, understandFrom: daysAgo(30) });
    const { json } = await get("/api/library/storage");
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0]).toMatchObject({
      source: "browser",
      label: "Browser",
      searchable: { events: 0, bytes: 0, from: null, to: null },
      understood: { events: 0, bytes: 0, from: null, to: null },
    });
  });

  it("a source whose consent is paused still reports its bars and the state", async () => {
    grantConsent({ source: "screen", indexAll: true, understandFrom: daysAgo(3) });
    appendEvents([env("screen", daysAgo(1), "some screen text")], NOW);
    getDb().prepare(`UPDATE consents SET state = 'paused' WHERE source = 'screen'`).run();
    const { json } = await get("/api/library/storage");
    const screen = json.sources.find((s: any) => s.source === "screen");
    expect(screen.consent.state).toBe("paused");
    expect(screen.searchable.events).toBe(1);
  });
});

describe("POST /api/library/budgets — two budgets, two controls", () => {
  it("sets either budget on its own and leaves the other alone", async () => {
    const a = await post("/api/library/budgets", { events_bytes_per_year: 4_000_000_000 });
    expect(a.status).toBe(200);
    expect(a.json.budgets).toEqual({
      events_bytes_per_year: 4_000_000_000,
      media_bytes: DEFAULT_MEDIA_BUDGET_BYTES,
      media_retention_days: DEFAULT_MEDIA_RETENTION_DAYS,
    });
    const b = await post("/api/library/budgets", { media_bytes: 10_000_000_000, media_retention_days: 30 });
    expect(b.json.budgets).toEqual({
      events_bytes_per_year: 4_000_000_000,
      media_bytes: 10_000_000_000,
      media_retention_days: 30,
    });
    const read = await get("/api/library/budgets");
    expect(read.json.budgets).toEqual(b.json.budgets);
    const overview = await get("/api/library/storage");
    expect(overview.json.budgets).toEqual(b.json.budgets);
  });

  it("refuses a budget outside the rails and writes nothing on a bad field", async () => {
    expect((await post("/api/library/budgets", { events_bytes_per_year: 5 })).status).toBe(400);
    expect((await post("/api/library/budgets", { media_bytes: "lots" })).status).toBe(400);
    expect((await post("/api/library/budgets", { media_retention_days: 1 })).status).toBe(400);
    // A good field beside a bad one: nothing is written.
    const mixed = await post("/api/library/budgets", { events_bytes_per_year: 3_000_000_000, media_retention_days: 0 });
    expect(mixed.status).toBe(400);
    expect((await get("/api/library/budgets")).json.budgets.events_bytes_per_year).toBe(
      DEFAULT_EVENTS_BUDGET_BYTES_PER_YEAR,
    );
    expect((await post("/api/library/budgets", {})).status).toBe(400);
  });

  it("does not claim other library paths", async () => {
    expect((await get("/api/library/chats")).status).toBe(404);
  });
});
