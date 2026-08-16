// ===========================================================================
// CalendarAdapter + generic Ingestion integration (build item 5.1).
//
// The thesis test: a second source's fixture flows through the UNMODIFIED
// generic layer — Ingestion, the descending-cohort buffer, db/ingest's
// (source_id, external_id) dedupe, db/watermarks — and lands as ordinary
// generic events. Nothing here stubs or bypasses core code.
//
// Asserts:
//   - events land as generic rows namespaced by source_id "calendar";
//   - stream binding: every event row points at the calendar stream row;
//   - actor binding: organizer emails resolve to actor rows (+ self identity
//     persisted so the manifest's lazy value_getter reads it back);
//   - dedupe on (source_id, external_id): a re-run inserts zero new rows;
//   - watermarks: backfill_low_ts = oldest record, backfill_complete set;
//   - a FUTURE DTSTART is stored verbatim (a schedule is not clock skew);
//   - the core is served newest-first by the generic re-order buffer;
//   - range cutoff + kill-switch behave like any other source's.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { selfIdentityValue } from "../../db/ingest.js";
import { readWatermark } from "../../db/watermarks.js";
import { Ingestion } from "../../ingest/index.js";
import type { StatusUpdate } from "../types.js";
import { CalendarAdapter, calendarExternalId } from "./adapter.js";
import { CALENDAR_MANIFEST, selfEmail } from "./manifest.js";

const SELF = "me@example.com";
const DAY = 24 * 60 * 60 * 1000;

/** ms since epoch (floored to whole seconds) → ICS UTC stamp. */
function icsStamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 15) + "Z";
}

/** The same instant as the ISO string the parser (and thus events.ts) stores. */
function isoOf(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

const NOW = Date.now();
const T_OLD = NOW - 10 * DAY; // outside a 7d range
const T_RECENT = NOW - 2 * DAY;
const T_FUTURE = NOW + 5 * DAY; // a scheduled record, NOT clock skew

function fixtureText(): string {
  return [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Team Calendar",
    "BEGIN:VEVENT",
    "UID:evt-old",
    `DTSTART:${icsStamp(T_OLD)}`,
    `DTEND:${icsStamp(T_OLD + DAY / 24)}`,
    "SUMMARY:Gargi's 40th planning",
    "URL:https://meet.example.com/gargi-40",
    `ORGANIZER;CN=Me:mailto:${SELF}`,
    "ATTENDEE;CN=Gargi:mailto:gargi@x.com",
    "ATTENDEE;CN=Mansi:mailto:mansi@x.com",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-recent",
    `DTSTART:${icsStamp(T_RECENT)}`,
    "SUMMARY:Dinner",
    "ORGANIZER;CN=Gargi:mailto:gargi@x.com",
    `ATTENDEE:mailto:${SELF}`,
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-future",
    `DTSTART:${icsStamp(T_FUTURE)}`,
    "SUMMARY:Flight to Goa",
    "ORGANIZER;CN=Gargi:mailto:gargi@x.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

let tmpDir: string;
let fixturePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cal-adapter-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
  fixturePath = join(tmpDir, "calendar.ics");
  writeFileSync(fixturePath, fixtureText());
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeIngestion(): { adapter: CalendarAdapter; ingestion: Ingestion } {
  const adapter = new CalendarAdapter({ fixturePath, selfEmail: SELF, home: tmpDir });
  const ingestion = new Ingestion(adapter, { manifest: CALENDAR_MANIFEST });
  ingestion.start();
  return { adapter, ingestion };
}

interface EventRow {
  id: string;
  source_id: string;
  external_id: string;
  stream_id: string | null;
  actor_id: string | null;
  ts: string | null;
  kind: string | null;
  text: string | null;
  link_url: string | null;
  raw_json: string | null;
  is_historical: number;
}

function eventRows(): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, source_id, external_id, stream_id, actor_id, ts, kind, text,
              link_url, raw_json, is_historical
         FROM events WHERE source_id = 'calendar' ORDER BY rowid`,
    )
    .all() as EventRow[];
}

describe("CalendarAdapter + Ingestion (fixture-driven, real generic layer)", () => {
  it("ingests the fixture as generic events with correct stream/actor binding", async () => {
    const { adapter, ingestion } = makeIngestion();
    await adapter.connect();
    expect(adapter.getStatus().state).toBe("online");
    expect(adapter.getStatus().paired).toBe(true);

    await adapter.backfill("all");

    const rows = eventRows();
    expect(rows).toHaveLength(3);
    expect(ingestion.stats.eventsInserted).toBe(3);

    // ---- Namespacing + dedupe key material.
    const extIds = rows.map((r) => r.external_id).sort();
    expect(extIds).toEqual(
      ["evt-future", "evt-old", "evt-recent"].map((u) => calendarExternalId("Team Calendar", u)),
    );
    for (const r of rows) {
      expect(r.source_id).toBe("calendar");
      expect(r.is_historical).toBe(1);
      expect(r.kind).toBe("message");
    }

    // ---- Stream binding: one calendar lane, every event on it.
    const stream = getDb()
      .prepare(`SELECT id, external_key, stream_kind FROM streams WHERE source_id = 'calendar'`)
      .get() as { id: string; external_key: string; stream_kind: string | null };
    expect(stream.external_key).toBe("Team Calendar");
    expect(stream.stream_kind).toBe("calendar"); // the source's own lane word (§2.2)
    for (const r of rows) expect(r.stream_id).toBe(stream.id);
    // ... and the manifest maps that lane word to the §2.1 kind.
    expect(
      CALENDAR_MANIFEST.stream_kind_of({ external_key: stream.external_key, kind: stream.stream_kind ?? undefined }),
    ).toBe("bounded");

    // ---- Actor binding: organizer emails resolve to actor rows.
    const byExt = new Map(rows.map((r) => [r.external_id, r] as const));
    const recent = byExt.get(calendarExternalId("Team Calendar", "evt-recent"))!;
    const actor = getDb()
      .prepare(`SELECT id, source_ext_id, display_name FROM actors WHERE id = ?`)
      .get(recent.actor_id) as { id: string; source_ext_id: string; display_name: string | null };
    expect(actor.source_ext_id).toBe("gargi@x.com");
    expect(actor.display_name).toBe("Gargi"); // CN, not the address
    const old = byExt.get(calendarExternalId("Team Calendar", "evt-old"))!;
    const selfActor = getDb()
      .prepare(`SELECT source_ext_id FROM actors WHERE id = ?`)
      .get(old.actor_id) as { source_ext_id: string };
    expect(selfActor.source_ext_id).toBe(SELF);

    // ---- Self identity persisted; the manifest's LAZY getter reads it back.
    expect(selfIdentityValue("calendar")).toBe(SELF);
    expect(selfEmail()).toBe(SELF);
    expect(CALENDAR_MANIFEST.self_identity.value_getter()).toBe(SELF);

    // ---- The url bridge material landed on the generic column.
    expect(old.link_url).toBe("https://meet.example.com/gargi-40");
    // ---- The attendee_set bridge material travels whole in raw_json.
    const raw = JSON.parse(old.raw_json ?? "{}") as {
      attendees?: { email: string }[];
      dtend?: string;
    };
    expect(raw.attendees?.map((a) => a.email).sort()).toEqual(["gargi@x.com", "mansi@x.com"]);
    expect(raw.dtend).toBe(isoOf(T_OLD + DAY / 24));

    // ---- A FUTURE start is the record, stored verbatim — never clamped.
    const future = byExt.get(calendarExternalId("Team Calendar", "evt-future"))!;
    expect(future.ts).toBe(isoOf(T_FUTURE));
    expect(Date.parse(future.ts!)).toBeGreaterThan(Date.now());

    // ---- The generic re-order buffer served the core newest-first
    //      (manifest says "unordered"; rows landed in descending ts order).
    const tsSeq = rows.map((r) => Date.parse(r.ts!));
    expect(tsSeq).toEqual([...tsSeq].sort((a, b) => b - a));

    // ---- Watermarks: floor = oldest record, and the run closed the stream.
    const wm = readWatermark(stream.id);
    expect(wm).not.toBeNull();
    expect(wm!.backfill_low_ts).toBe(isoOf(T_OLD));
    expect(wm!.backfill_complete).toBe(true);
    expect(wm!.live_high_ts).toBeNull(); // no live tail on a snapshot source
  });

  it("dedupes on (source_id, external_id): a re-run inserts zero new rows", async () => {
    const { adapter, ingestion } = makeIngestion();
    await adapter.connect();
    await adapter.backfill("all");
    expect(eventRows()).toHaveLength(3);

    await adapter.backfill("all"); // same snapshot again
    expect(eventRows()).toHaveLength(3);
    expect(ingestion.stats.eventsInserted).toBe(3);
    expect(ingestion.stats.eventsDeduped).toBe(3);

    await adapter.extend("all"); // widening re-reads the file; still no dupes
    expect(eventRows()).toHaveLength(3);
    expect(ingestion.stats.eventsDeduped).toBe(6);
  });

  it("honours the range cutoff like any other source", async () => {
    const { adapter } = makeIngestion();
    await adapter.connect();
    await adapter.backfill("7d");
    const rows = eventRows();
    // evt-old (10 days back) is outside; the recent and the future one are in.
    expect(rows.map((r) => r.external_id).sort()).toEqual([
      calendarExternalId("Team Calendar", "evt-future"),
      calendarExternalId("Team Calendar", "evt-recent"),
    ]);
  });

  it("closes the run with backfill_complete so /status and import flags settle", async () => {
    const { adapter, ingestion } = makeIngestion();
    const frames: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => frames.push(s));
    await adapter.connect();
    await adapter.backfill("all");

    const done = frames.find((f) => f.type === "backfill_complete");
    expect(done).toBeDefined();
    if (done?.type === "backfill_complete") {
      expect(done.messages).toBe(3);
      expect(done.range).toBe("all");
    }
    const status = ingestion.getStatus();
    expect(status.importDone).toBe(true);
    expect(status.progress?.done).toBe(true);
  });

  it("kill-switch: while paused, nothing is ingested", async () => {
    const { adapter, ingestion } = makeIngestion();
    await adapter.connect();
    await ingestion.setPaused(true);
    await adapter.backfill("all");
    expect(eventRows()).toHaveLength(0);
    await ingestion.setPaused(false);
    await adapter.backfill("all");
    expect(eventRows()).toHaveLength(3);
  });

  it("a missing fixture is an error status, never a boot-killing throw", async () => {
    const adapter = new CalendarAdapter({
      fixturePath: join(tmpDir, "does-not-exist.ics"),
      selfEmail: SELF,
      home: tmpDir,
    });
    const ingestion = new Ingestion(adapter, { manifest: CALENDAR_MANIFEST });
    ingestion.start();
    const frames: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => frames.push(s));

    await adapter.connect(); // must not throw
    expect(adapter.getStatus().state).toBe("error");
    expect(frames.some((f) => f.type === "error" && f.code === "FIXTURE_MISSING")).toBe(true);
    expect(eventRows()).toHaveLength(0);
  });
});
