// ===========================================================================
// CNS-05..08 — the verbs (V6 P1 S1.7, Build §4.2 [D]; GoldenEvals_V6_Phase1
// §5.2) as deterministic vitest cases, the way S1.2 shipped CNS-01..04:
// fixture id in the describe title, the doc's Expected and Wrong lines
// asserted by code, ZERO model calls (SQLite on a temp file, spy drivers).
//
//   CNS-05  pause stops capture, not nudges — pause the browser source:
//           0 new browser rows at the funnel; WhatsApp continues; the tray
//           state reads paused for browser. Wrong: `pauses-nudges-only`.
//   CNS-06  consent flips before teardown — the adapter's stop() throws;
//           capture is still blocked at the funnel.
//   CNS-07  delete previews, then cascades — delete WhatsApp: the preview
//           shows N events / M episodes / K spaces; after confirm no episode,
//           claim, task or edge cites a deleted event. Wrong:
//           `raw-delete-strands-episodes`. Gate: orphan_rows_after_delete.
//   CNS-08  shortening keeps understanding — Understand 90 d → 30 d: episodes
//           from days 31–90 remain, labelled; review-and-delete removes
//           exactly those.
//
// Plus forget-last-N (preview → confirm through the cascade) and the
// one-click stop the tray calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  armScreenRecording,
  screenRecordFrom,
  setSourceSupervisor,
  SourceSupervisor,
  type SourceDriver,
  type SupervisedSource,
} from "../adapters/supervisor.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { setConsentGateMode, setUnderstandWindow, type ConsentGateMode } from "../db/consent-gate.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { appStateGet, appStateSet, importDoneKey, insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { captureAllowed, getConsent, grantConsent, listConsents } from "../db/v6core.js";
import { captureState } from "../server/capture-routes.js";
import {
  deleteOutsideWindow,
  deleteSource,
  deleteSourceData,
  disconnectSource,
  forgetLastMinutes,
  outsideWindowEpisodes,
  pauseSource,
  previewCascade,
  previewForget,
  previewSourceDelete,
  resumeSource,
  sourceCaptureStates,
  stopAllCapture,
} from "./source-verbs.js";

// ---- harness ---------------------------------------------------------------

const DAY = 86_400_000;
/** The clock every case runs on: 2026-09-01 12:00 UTC. */
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

let tmpDir: string;
let prevMode: ConsentGateMode;

interface Spy extends SourceDriver {
  starts: number;
  stops: number;
  throwOnStop: boolean;
}

function spy(): Spy {
  const s: Spy = {
    starts: 0,
    stops: 0,
    throwOnStop: false,
    start() {
      s.starts++;
    },
    stop() {
      s.stops++;
      if (s.throwOnStop) throw new Error("sidecar refused to die");
    },
  };
  return s;
}

let drivers: Record<SupervisedSource, Spy>;
let supervisor: SourceSupervisor;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cns-verbs-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
  drivers = { whatsapp: spy(), browser: spy(), screen: spy() };
  supervisor = new SourceSupervisor({ drivers });
  setSourceSupervisor(supervisor);
});

afterEach(() => {
  setSourceSupervisor(null);
  setConsentGateMode(prevMode);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Consent for a source, Understand from `understandDays` ago (default 90). */
async function connect(source: SupervisedSource, understandDays = 90): Promise<void> {
  grantConsent({ source, indexAll: true, understandFrom: daysAgo(understandDays) });
  if (source === "screen") armScreenRecording(NOW_ISO);
  await supervisor.start(source);
}

const SELF = { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] };

function browserEnv(ts: string, url: string): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: `${new URL(url).hostname}:${ts.slice(0, 10)}`,
    actor: "self",
    roles: SELF,
    payload: { text: `page ${url}`, url, domain: new URL(url).hostname },
  };
}

function waEnv(ts: string, text: string, streamKey = "goa@g.us", actor = "contact:rohan"): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source: "whatsapp",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  };
}

function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

function eventsOf(source: string): number {
  return count(`SELECT COUNT(*) AS n FROM events WHERE source_id = ?`, source);
}

/**
 * Hang a derivation off a set of event ids: one episode (range + explicit
 * members) in a space, a claim version and a task citing them, a bundle.
 */
function derive(tag: string, ids: string[], spaceId: string, opts: { streamId?: string } = {}): string {
  const db = getDb();
  const epId = `ep_${tag}`;
  db.prepare(`INSERT OR IGNORE INTO spaces (id, label, status) VALUES (?, ?, 'active')`).run(spaceId, spaceId);
  const first = db.prepare(`SELECT ts FROM events WHERE id = ?`).get(ids[0]) as { ts: string };
  const last = db.prepare(`SELECT ts FROM events WHERE id = ?`).get(ids[ids.length - 1]) as { ts: string };
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary, first_ts, last_ts)
     VALUES (?, ?, ?, 'open', ?, ?, ?)`,
  ).run(epId, opts.streamId ?? null, spaceId, `episode ${tag}`, first.ts, last.ts);
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id) VALUES (?, ?, ?, ?)`,
  ).run(`epe_${tag}`, epId, ids[0], ids[ids.length - 1]);
  for (const [i, id] of ids.entries()) {
    // A one-event episode's range row already IS (id, id): keep the range,
    // skip the duplicate member (UNIQUE on episode_id, start, end).
    db.prepare(
      `INSERT OR IGNORE INTO episode_events (id, episode_id, start_event_id, end_event_id, event_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(`epm_${tag}_${i}`, epId, id, id, id);
  }
  db.prepare(
    `INSERT INTO claims (claim_key, kind, version_count, active_version_id) VALUES (?, 'fact', 1, ?)`,
  ).run(`ck_${tag}`, `cv_${tag}`);
  db.prepare(
    `INSERT INTO claim_versions (id, claim_key, text, stated_at, evidence_json) VALUES (?, ?, ?, ?, ?)`,
  ).run(`cv_${tag}`, `ck_${tag}`, `claim ${tag}`, last.ts, JSON.stringify([{ event_ids: ids.slice(0, 2), quote: tag }]));
  db.prepare(`INSERT INTO tasks (id, title, evidence_json) VALUES (?, ?, ?)`).run(
    `tk_${tag}`,
    `task ${tag}`,
    JSON.stringify([{ event_ids: [ids[0]], quote: tag }]),
  );
  db.prepare(
    `INSERT INTO enrichment_bundles (id, event_ids_json, min_rowid, max_rowid, pending_count) VALUES (?, ?, 1, 2, 0)`,
  ).run(`bun_${tag}`, JSON.stringify(ids));
  return epId;
}

/** Every derived row that cites an event id no longer in `events`. */
function orphanRowsAfterDelete(): Record<string, number> {
  const db = getDb();
  const existing = new Set(
    (db.prepare(`SELECT id FROM events`).all() as { id: string }[]).map((r) => r.id),
  );
  const jsonOrphans = (table: string, col: string): number => {
    let n = 0;
    const rows = db.prepare(`SELECT ${col} AS j FROM ${table} WHERE ${col} IS NOT NULL`).all() as { j: string }[];
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.j);
      } catch {
        continue;
      }
      const ids: string[] = [];
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (typeof e === "string") ids.push(e);
          else if (e && Array.isArray((e as { event_ids?: unknown }).event_ids)) {
            ids.push(...((e as { event_ids: unknown[] }).event_ids.filter((x): x is string => typeof x === "string")));
          }
        }
      }
      if (ids.some((id) => !existing.has(id))) n++;
    }
    return n;
  };
  return {
    episode_events: count(
      `SELECT COUNT(*) AS n FROM episode_events
        WHERE start_event_id NOT IN (SELECT id FROM events)
           OR end_event_id NOT IN (SELECT id FROM events)
           OR (event_id IS NOT NULL AND event_id NOT IN (SELECT id FROM events))`,
    ),
    empty_episodes: count(
      `SELECT COUNT(*) AS n FROM episodes e WHERE NOT EXISTS (SELECT 1 FROM episode_events m WHERE m.episode_id = e.id)`,
    ),
    claim_versions: jsonOrphans("claim_versions", "evidence_json"),
    tasks: jsonOrphans("tasks", "evidence_json"),
    bundles: jsonOrphans("enrichment_bundles", "event_ids_json"),
    archive: count(`SELECT COUNT(*) AS n FROM archive WHERE event_id NOT IN (SELECT id FROM events)`),
    edges: (() => {
      try {
        return count(`SELECT COUNT(*) AS n FROM edge_evidence WHERE event_id NOT IN (SELECT id FROM events)`);
      } catch {
        return 0;
      }
    })(),
  };
}

// ---- CNS-05 -----------------------------------------------------------------

describe("CNS-05 — pause stops capture, not nudges", () => {
  it("pausing the browser source: 0 new browser rows, WhatsApp continues, tray shows paused", async () => {
    await connect("browser");
    await connect("whatsapp");
    expect(supervisor.running()).toEqual(["whatsapp", "browser"]);
    appendEvents([browserEnv(NOW_ISO, "https://a.example.com/"), waEnv(NOW_ISO, "before")], NOW);
    expect(eventsOf("browser")).toBe(1);
    expect(eventsOf("whatsapp")).toBe(1);

    const out = await pauseSource("browser");
    expect(out.consent?.state).toBe("paused");
    expect(out.captureAllowed).toBe(false);
    expect(out.stopped).toBe(true);
    expect(drivers.browser.stops).toBe(1);
    expect(drivers.whatsapp.stops).toBe(0);

    // The funnel is where the pause lives — not a nudge filter downstream.
    const r = appendEvents(
      [
        browserEnv(new Date(NOW + 1000).toISOString(), "https://b.example.com/"),
        browserEnv(new Date(NOW + 2000).toISOString(), "https://c.example.com/"),
        waEnv(new Date(NOW + 3000).toISOString(), "during"),
      ],
      NOW + 5000,
    );
    expect(r.ids.map((id) => id !== "")).toEqual([false, false, true]);
    expect(eventsOf("browser")).toBe(1); // 0 new browser rows
    expect(eventsOf("whatsapp")).toBe(2); // WhatsApp continues

    // Wrong: `pauses-nudges-only` — the row is what changed, not an assist flag.
    expect(captureAllowed("browser")).toBe(false);
    expect(captureAllowed("whatsapp")).toBe(true);

    // The tray reads the real state.
    const state = captureState(NOW) as { sources: { source: string; consent: string | null; running: boolean; capturing: boolean }[]; recording: string[]; capturing: boolean };
    const browser = state.sources.find((s) => s.source === "browser")!;
    expect(browser).toMatchObject({ consent: "paused", running: false, capturing: false });
    expect(state.recording).toEqual(["whatsapp"]);
    expect(state.capturing).toBe(true);

    // Resume: row first, then the adapter starts again.
    const back = await resumeSource("browser");
    expect(back.consent?.state).toBe("connected");
    expect(drivers.browser.starts).toBe(2);
    expect(appendEvents([browserEnv(new Date(NOW + 9000).toISOString(), "https://d.example.com/")], NOW + 9000).inserted).toBe(1);
  });

  it("one-click stop pauses every admitted source; the tray then reads nothing capturing", async () => {
    await connect("browser");
    await connect("whatsapp");
    await connect("screen");
    const outcomes = await stopAllCapture();
    expect(outcomes.map((o) => o.source).sort()).toEqual(["browser", "screen", "whatsapp"]);
    expect(sourceCaptureStates().every((s) => !s.capturing && !s.running && s.consent === "paused")).toBe(true);
    const state = captureState(NOW) as { capturing: boolean; recording: string[] };
    expect(state.capturing).toBe(false);
    expect(state.recording).toEqual([]);
    expect(appendEvents([waEnv(NOW_ISO, "x"), browserEnv(NOW_ISO, "https://x.com/")], NOW).inserted).toBe(0);
  });
});

// ---- CNS-06 -----------------------------------------------------------------

describe("CNS-06 — consent flips before teardown", () => {
  it("a throwing teardown still leaves capture blocked at the funnel", async () => {
    await connect("screen");
    drivers.screen.throwOnStop = true;
    expect(captureAllowed("screen")).toBe(true);

    const out = await pauseSource("screen");
    expect(drivers.screen.stops).toBe(1);
    expect(out.teardownError).toMatch(/refused to die/);
    // The row flipped BEFORE stop() ran and stays flipped.
    expect(getConsent("screen")?.state).toBe("paused");
    expect(out.captureAllowed).toBe(false);
    expect(captureAllowed("screen")).toBe(false);
    // The supervisor no longer counts it as running either.
    expect(supervisor.isRunning("screen")).toBe(false);

    const r = appendEvents(
      [
        {
          ts: NOW_ISO,
          capturedAt: NOW_ISO,
          source: "screen",
          kind: "screen.snapshot",
          origin: "live",
          streamKey: "screen:com.apple.notes",
          actor: "self",
          roles: SELF,
          payload: { text: "typed after pause", bundle_id: "com.apple.notes" },
        },
      ],
      NOW,
    );
    expect(r.inserted).toBe(0);
    expect(eventsOf("screen")).toBe(0);
  });

  it("disconnect and delete flip first too; disconnect forgets 'Record from now on'", async () => {
    await connect("screen");
    drivers.screen.throwOnStop = true;
    expect(screenRecordFrom()).toBe(NOW_ISO);
    const out = await disconnectSource("screen");
    expect(out.consent?.state).toBe("disconnected");
    expect(out.teardownError).not.toBeNull();
    expect(captureAllowed("screen")).toBe(false);
    expect(screenRecordFrom()).toBeNull();

    await connect("whatsapp");
    drivers.whatsapp.throwOnStop = true;
    appendEvents([waEnv(NOW_ISO, "x")], NOW);
    const del = await deleteSource("whatsapp");
    expect(del.teardownError).not.toBeNull();
    expect(getConsent("whatsapp")).toBeNull(); // revoked
    expect(listConsents({ includeRevoked: true }).find((c) => c.source === "whatsapp")?.state).toBe("revoked");
    expect(captureAllowed("whatsapp")).toBe(false);
    expect(eventsOf("whatsapp")).toBe(0);
  });
});

// ---- CNS-07 -----------------------------------------------------------------

describe("CNS-07 — delete previews, then cascades", () => {
  it("delete WhatsApp: preview shows N events / M episodes / K spaces; confirm strands nothing", async () => {
    await connect("whatsapp");
    await connect("browser");
    const wa = appendEvents(
      [
        waEnv(daysAgo(3), "villa advance by 5pm"),
        waEnv(daysAgo(2), "paid"),
        waEnv(daysAgo(1), "receipt attached"),
        waEnv(daysAgo(1), "dinner?", "family@g.us", "contact:mum"),
        waEnv(daysAgo(0), "8pm", "family@g.us", "contact:mum"),
      ],
      NOW,
    ).ids;
    const br = appendEvents([browserEnv(daysAgo(1), "https://villas.example/x"), browserEnv(daysAgo(0), "https://news.example/")], NOW).ids;
    derive("goa", wa.slice(0, 3), "sp_goa");
    derive("family", wa.slice(3), "sp_family");
    derive("browsing", br, "sp_goa");
    // Legacy-funnel shells for the source (streams/actors), as WhatsApp really has.
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    upsertStream({ sourceId: "whatsapp", sourceExtId: "goa@g.us", name: "Goa", kind: "group" });
    upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
    appStateSet(importDoneKey("whatsapp"), "true");

    const before = {
      events: count(`SELECT COUNT(*) AS n FROM events`),
      episodes: count(`SELECT COUNT(*) AS n FROM episodes`),
      decisions: count(`SELECT COUNT(*) AS n FROM decisions`),
      // appendEvents upserts a stream per stream key (goa, family) beside the
      // legacy shell upserted above.
      streams: count(`SELECT COUNT(*) AS n FROM streams WHERE source_id = 'whatsapp'`),
    };
    expect(before.streams).toBeGreaterThan(0);

    // 1. Preview: a dry run of the real cascade — nothing written.
    const preview = previewSourceDelete("whatsapp");
    expect(preview).toMatchObject({
      events_deleted: 5,
      episodes_deleted: 2,
      spaces_touched: 2,
      tasks_deleted: 2,
      claims_deleted: 2,
      streams: before.streams,
      actors: 1,
      decision_id: null,
    });
    expect(preview.first_ts).toBe(daysAgo(3));
    expect(preview.last_ts).toBe(daysAgo(0));
    expect(count(`SELECT COUNT(*) AS n FROM events`)).toBe(before.events);
    expect(count(`SELECT COUNT(*) AS n FROM episodes`)).toBe(before.episodes);
    expect(count(`SELECT COUNT(*) AS n FROM decisions`)).toBe(before.decisions); // no tombstone from a preview
    expect(captureAllowed("whatsapp")).toBe(true); // a preview changes nothing

    // 2. Confirm: revoke → stop → cascade. The numbers match the preview.
    const out = await deleteSource("whatsapp");
    expect(out.deleted.cascade.events_deleted).toBe(preview.events_deleted);
    expect(out.deleted.cascade.episodes_deleted).toBe(preview.episodes_deleted);
    expect(out.deleted).toMatchObject({ events: 5, streams: before.streams, actors: 1 });
    expect(drivers.whatsapp.stops).toBe(1);
    expect(captureAllowed("whatsapp")).toBe(false);
    expect(appStateGet(importDoneKey("whatsapp"))).toBeNull();

    // Gate: orphan_rows_after_delete — nothing cites a deleted event.
    expect(orphanRowsAfterDelete()).toEqual({
      episode_events: 0,
      empty_episodes: 0,
      claim_versions: 0,
      tasks: 0,
      bundles: 0,
      archive: 0,
      edges: 0,
    });
    // The browser's derivation survives untouched.
    expect(eventsOf("browser")).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep_browsing'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM claim_versions WHERE id = 'cv_browsing'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM tasks WHERE id = 'tk_browsing'`)).toBe(1);
    // Shells and the FTS projection are gone with the source.
    expect(count(`SELECT COUNT(*) AS n FROM streams WHERE source_id = 'whatsapp'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM actors WHERE source_id = 'whatsapp'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'advance'`)).toBe(0); // the WA text is gone from FTS
    expect(count(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'villas'`)).toBe(1); // the browser visit only
    // One counts-only tombstone, plus the verb's decision.
    expect(count(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'privacy_delete'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'source_delete'`)).toBe(1);
  });

  it("Wrong: raw-delete-strands-episodes — the old reset path would have; deleteSourceData does not", async () => {
    await connect("whatsapp");
    const ids = appendEvents([waEnv(daysAgo(2), "a"), waEnv(daysAgo(1), "b")], NOW).ids;
    derive("x", ids, "sp_x");
    // Simulate what resetSourceData did to prove the gate is meaningful…
    getDb().exec("PRAGMA foreign_keys = OFF");
    getDb().prepare(`DELETE FROM events WHERE source_id = 'whatsapp'`).run();
    getDb().exec("PRAGMA foreign_keys = ON");
    const stranded = orphanRowsAfterDelete();
    expect(stranded.episode_events).toBeGreaterThan(0);
    expect(stranded.claim_versions).toBeGreaterThan(0);
    // …then re-seed and run the real path.
    getDb().exec(`DELETE FROM episode_events; DELETE FROM episodes; DELETE FROM claim_versions; DELETE FROM claims; DELETE FROM tasks; DELETE FROM enrichment_bundles; DELETE FROM archive`);
    const ids2 = appendEvents([waEnv(daysAgo(2), "c"), waEnv(daysAgo(1), "d")], NOW).ids;
    derive("y", ids2, "sp_y");
    const res = deleteSourceData("whatsapp");
    expect(res.events).toBe(2);
    expect(res.cascade.episodes_deleted).toBe(1);
    expect(orphanRowsAfterDelete()).toMatchObject({ episode_events: 0, empty_episodes: 0, claim_versions: 0, tasks: 0, bundles: 0 });
  });

  it("previewCascade is idempotent and writes nothing, even when run twice", async () => {
    await connect("browser");
    const ids = appendEvents([browserEnv(daysAgo(1), "https://a.example/"), browserEnv(daysAgo(0), "https://b.example/")], NOW).ids;
    derive("p", ids, "sp_p");
    const a = previewCascade(ids);
    const b = previewCascade(ids);
    expect(a).toEqual(b);
    expect(a.events_deleted).toBe(2);
    expect(a.spaces_touched).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM events`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'privacy_delete'`)).toBe(0);
    expect(previewCascade([])).toMatchObject({ events_deleted: 0, spaces_touched: 0, first_ts: null });
  });
});

// ---- CNS-08 -----------------------------------------------------------------

describe("CNS-08 — shortening keeps understanding", () => {
  it("Understand 90 d → 30 d: episodes from days 31–90 remain, labelled; review-and-delete removes exactly those", async () => {
    await connect("whatsapp", 90);
    const old = appendEvents([waEnv(daysAgo(80), "old plan"), waEnv(daysAgo(60), "old follow-up"), waEnv(daysAgo(45), "old close")], NOW).ids;
    const recent = appendEvents([waEnv(daysAgo(20), "new plan"), waEnv(daysAgo(5), "new follow-up")], NOW).ids;
    // Everything was inside Understand at capture: dispatchable rows, not archive.
    expect(count(`SELECT COUNT(*) AS n FROM events WHERE origin = 'archive'`)).toBe(0);
    derive("old", old, "sp_trip");
    derive("recent", recent, "sp_trip");
    // Straddling episode: touches day 45 and day 20 — NOT entirely before the new floor.
    derive("straddle", [old[2]!, recent[0]!], "sp_trip");

    const change = setUnderstandWindow("whatsapp", daysAgo(30));
    expect(change.direction).toBe("shortened");
    expect(change.replay.replayed).toBe(0);
    // D4: nothing already understood is touched by the shortening itself.
    expect(count(`SELECT COUNT(*) AS n FROM episodes`)).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM events`)).toBe(5);
    expect(count(`SELECT COUNT(*) AS n FROM events WHERE origin = 'archive'`)).toBe(0);
    // New captures older than 30 d now land as archive (index, not understand).
    const late = appendEvents([waEnv(daysAgo(40), "late import")], NOW);
    expect(late.inserted).toBe(1);
    expect(getDb().prepare(`SELECT origin FROM events WHERE id = ?`).get(late.ids[0])).toEqual({ origin: "archive" });

    // Labelled: exactly the episodes that lie entirely before the floor.
    const review = outsideWindowEpisodes("whatsapp");
    expect(review.understand_from).toBe(daysAgo(30));
    expect(review.episodes.map((e) => e.id)).toEqual(["ep_old"]);
    expect(review.episodes[0]).toMatchObject({ label: "outside-understand-window", space_id: "sp_trip", events: 4 });
    expect(new Set(review.event_ids)).toEqual(new Set(old));

    // Review-and-delete removes exactly those — and nothing from days 0–30.
    const report = deleteOutsideWindow("whatsapp");
    expect(report.episodes).toBe(1);
    expect(report.events_deleted).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep_old'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep_recent'`)).toBe(1);
    // The straddling episode lost its old member but keeps its recent one.
    expect(count(`SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep_straddle'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM episode_events WHERE episode_id = 'ep_straddle'`)).toBeGreaterThan(0);
    expect(eventsOf("whatsapp")).toBe(3); // 2 recent + the late archive row
    expect(orphanRowsAfterDelete()).toMatchObject({ episode_events: 0, empty_episodes: 0, claim_versions: 0, tasks: 0 });
    // Nothing left to review.
    expect(outsideWindowEpisodes("whatsapp").episodes).toEqual([]);
  });

  it("no Understand floor → nothing to review; a source with nothing old → empty", async () => {
    grantConsent({ source: "browser", indexAll: true });
    expect(outsideWindowEpisodes("browser")).toEqual({ source: "browser", understand_from: null, episodes: [], event_ids: [] });
    await connect("whatsapp", 30);
    appendEvents([waEnv(daysAgo(1), "x")], NOW);
    expect(outsideWindowEpisodes("whatsapp").episodes).toEqual([]);
  });
});

// ---- forget last N minutes ------------------------------------------------------

describe("forget last N minutes — preview, confirm, cascade", () => {
  it("previews the last 10 minutes across sources, then hard-deletes exactly them", async () => {
    await connect("whatsapp");
    await connect("browser");
    const t = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
    const ids = appendEvents(
      [
        waEnv(t(30), "half an hour ago"),
        waEnv(t(8), "eight minutes ago"),
        browserEnv(t(3), "https://embarrassing.example/"),
        { ...browserEnv(t(2), "https://imported.example/"), origin: "backfill" }, // an import that landed just now
      ],
      NOW,
    ).ids;
    derive("recent", [ids[1]!, ids[2]!], "sp_r");
    derive("older", [ids[0]!], "sp_o");

    const preview = previewForget(10, NOW);
    expect(preview.minutes).toBe(10);
    expect(preview.events_deleted).toBe(2); // the backfill row is not "what just happened"
    expect(preview.episodes_deleted).toBe(1);
    expect(preview.spaces_touched).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM events`)).toBe(4);

    const report = forgetLastMinutes(10, { nowMs: NOW });
    expect(report.events_deleted).toBe(2);
    expect(report.episodes_deleted).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM events`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep_older'`)).toBe(1);
    expect(orphanRowsAfterDelete()).toMatchObject({ episode_events: 0, empty_episodes: 0, claim_versions: 0, tasks: 0 });
    expect(count(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'privacy_delete' AND target_id = 'forget'`)).toBe(1);
  });
});

// ---- the legacy funnel is covered by the same verbs -------------------------------

describe("verbs cover the WhatsApp legacy funnel too", () => {
  it("after pause, insertEvent writes nothing; after resume it does", async () => {
    await connect("whatsapp");
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const st = upsertStream({ sourceId: "whatsapp", sourceExtId: "goa@g.us", name: "Goa", kind: "group" });
    const row = (ext: string) => ({
      externalId: ext,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: st,
      actorId: null,
      ts: NOW_ISO,
      kind: "message",
      text: ext,
      mediaPath: null,
      rawJson: null,
    });
    expect(insertEvent(row("m1")).inserted).toBe(true);
    await pauseSource("whatsapp");
    expect(insertEvent(row("m2")).inserted).toBe(false);
    await resumeSource("whatsapp");
    expect(insertEvent(row("m3")).inserted).toBe(true);
    expect(eventsOf("whatsapp")).toBe(2);
  });
});
