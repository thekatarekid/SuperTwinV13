// ===========================================================================
// purge-eval-data, against a FIXTURE database that mixes the leaked eval rows
// with real-looking captured rows (defect fix, shipped 13.4.1).
//
// The two things that must hold, forever:
//   1. every fixture-origin row the harness actually produced is found — the
//      exact shapes seen in the user's DB (villas.example, ast-04-…-chat,
//      sunrise-402-eval-…@g.us, an AX capture whose URL is on .example);
//   2. NOTHING else is. A real netflix.com visit, a real WhatsApp thread, and
//      a page that merely says the word "example" all survive.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import { hasExampleTldUrl, purgeEvalData, renderPurge, renderSurvey, surveyEvalData } from "./purge.js";
import { main as purgeMain, parsePurgeArgs } from "./purge-cli.js";

const NOW = Date.parse("2026-08-29T04:00:00.000Z");

let tmpDir: string;

function ev(over: Partial<EventEnvelope> & { source: string; streamKey: string }): EventEnvelope {
  return {
    ts: "2026-08-29T03:00:00.000Z",
    capturedAt: "2026-08-29T03:00:00.000Z",
    kind: `${over.source}.message`,
    origin: "live",
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: [], mentions: [] },
    payload: {},
    ...over,
  } as EventEnvelope;
}

/** The rows the 13.4.1 harness actually wrote into the user's home. */
function seedLeak(): string[] {
  const ids: string[] = [];
  // executors/assist.ts — browser fixture seeds on the reserved .example TLD.
  ids.push(
    appendEvent(
      ev({
        source: "browser",
        kind: "browser.visit",
        streamKey: "villas.example",
        payload: {
          text: "Anjuna villa: 3BHK pool villa, ₹5.8k/night — https://villas.example/ast-08-x/anjuna-6",
          url: "https://villas.example/ast-08-x/anjuna-6",
        },
      }),
      NOW,
    ).id,
  );
  // …and its screen twin: a real-looking stream key, given away by the URL.
  ids.push(
    appendEvent(
      ev({
        source: "screen",
        kind: "ax.capture",
        streamKey: "safari",
        payload: {
          text: "AX capture: Anjuna villa listing, 3BHK pool — https://anjuna.example/ast-09c-y/listing-3",
          url: "https://anjuna.example/ast-09c-y/listing-3",
        },
      }),
      NOW,
    ).id,
  );
  // executors/assist.ts — the AST nonce chat keys.
  ids.push(
    appendEvent(
      ev({
        source: "wa",
        kind: "wa.message",
        streamKey: "ast-04-mtdcsww3-chat",
        actor: "contact:rohan",
        payload: { text: "Rohan: villa advance by 5pm TODAY" },
      }),
      NOW,
    ).id,
  );
  // executors/passes.ts — the eval-marked WhatsApp group.
  ids.push(
    appendEvent(
      ev({
        source: "wa",
        kind: "wa.message",
        streamKey: "sunrise-402-eval-1787959999717@g.us",
        actor: "contact:neighbour",
        origin: "backfill",
        ts: "2026-07-19T23:33:19.717Z",
        capturedAt: "2026-08-28T23:33:19.717Z",
        payload: { text: "plumber contact: 98200-11111" },
      }),
      NOW,
    ).id,
  );
  // executors/p4.ts — the bar/thread seeds.
  ids.push(
    appendEvent(
      ev({
        source: "twin",
        kind: "artifact.note",
        streamKey: "bar:eval-usr05",
        payload: { text: "eval artifact" },
      }),
      NOW,
    ).id,
  );
  // V6 S3.9 — a row on a real-looking key, given away only by origin = 'eval'.
  ids.push(
    appendEvent(
      ev({
        source: "wa",
        kind: "wa.message",
        streamKey: "919876543210-1700@g.us",
        actor: "contact:rohan",
        origin: "eval",
        payload: { text: "guys lets lock goa 18-21 dec" },
      }),
      NOW,
    ).id,
  );
  return ids;
}

/** Real captured rows that must survive untouched. */
function seedReal(): string[] {
  const ids: string[] = [];
  ids.push(
    appendEvent(
      ev({
        source: "browser",
        kind: "browser.visit",
        streamKey: "browser:chrome:chain:8436547a70709131",
        payload: { text: "Netflix — Home https://www.netflix.com/browse", url: "https://www.netflix.com/browse" },
      }),
      NOW,
    ).id,
  );
  // The nastiest false-positive shape: a real page that TALKS about examples.
  ids.push(
    appendEvent(
      ev({
        source: "browser",
        kind: "browser.visit",
        streamKey: "browser:chrome:chain:aa11bb22cc33dd44",
        payload: {
          text: "MDN — URL.hostname, see the example section https://developer.mozilla.org/en-US/docs/Web/API/URL/example",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/URL/example",
        },
      }),
      NOW,
    ).id,
  );
  ids.push(
    appendEvent(
      ev({
        source: "wa",
        kind: "wa.message",
        streamKey: "919876543210-1602@g.us",
        actor: "contact:amma",
        payload: { text: "call me when you land" },
      }),
      NOW,
    ).id,
  );
  return ids;
}

function idsInDb(): Set<string> {
  return new Set(
    (getDb().prepare(`SELECT id FROM events`).all() as { id: string }[]).map((r) => r.id),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-purge-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("hasExampleTldUrl — host-scoped, not substring", () => {
  it("matches only when the URL HOST is under .example", () => {
    expect(hasExampleTldUrl("go to https://villas.example/x")).toBe(true);
    expect(hasExampleTldUrl("http://news.example-ast-02-q/a")).toBe(false); // host is news.example-ast-02-q
    expect(hasExampleTldUrl("https://www.goibibo.example/villas/goa")).toBe(true);
    expect(hasExampleTldUrl("https://developer.mozilla.org/docs/example")).toBe(false);
    expect(hasExampleTldUrl("an example of a villa")).toBe(false);
    expect(hasExampleTldUrl("https://example.com/pricing")).toBe(false);
    expect(hasExampleTldUrl(null)).toBe(false);
  });
});

describe("surveyEvalData", () => {
  it("finds every leaked fixture row and nothing real", () => {
    const leaked = seedLeak();
    const real = seedReal();
    const survey = surveyEvalData();

    const found = new Set(survey.matches.map((m) => m.id));
    expect([...leaked].every((id) => found.has(id))).toBe(true);
    expect([...real].some((id) => found.has(id))).toBe(false);
    expect(survey.matches.length).toBe(leaked.length);
    expect(survey.total_events).toBe(leaked.length + real.length);
  });

  it("names WHY each row matched, so the dry run is checkable", () => {
    seedLeak();
    const survey = surveyEvalData();
    const ids = survey.by_signature.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["assist-fixture-key", "eval-marked-key", "eval-origin", "example-tld-stream", "example-tld-url"].sort(),
    );
    for (const m of survey.matches) expect(m.signatures.length).toBeGreaterThan(0);
  });

  it("reports a clean database as clean", () => {
    seedReal();
    const survey = surveyEvalData();
    expect(survey.matches).toEqual([]);
    expect(renderSurvey(survey)).toContain("This database is clean");
  });

  it("counts the stream shells the seeds left behind", () => {
    seedLeak();
    expect(surveyEvalData().derived_preview.stream_shells).toBeGreaterThan(0);
  });
});

describe("purgeEvalData", () => {
  it("removes the leaked rows and leaves the real ones alone", () => {
    const leaked = seedLeak();
    const real = seedReal();

    const result = purgeEvalData();
    expect(result.cascade.events_deleted).toBe(leaked.length);

    const remaining = idsInDb();
    for (const id of leaked) expect(remaining.has(id)).toBe(false);
    for (const id of real) expect(remaining.has(id)).toBe(true);
  });

  it("cascades: derived episodes/tasks/decisions and FTS rows go too", () => {
    const leaked = seedLeak();
    seedReal();
    const db = getDb();

    // A derived episode over two leaked events, a task whose only evidence is
    // a leaked event, and a decision about one — the shapes an eval run left.
    db.prepare(
      `INSERT INTO episodes (id, summary, first_ts, last_ts, created_by)
       VALUES ('ep_eval', 'villa advance', ?, ?, 'orient')`,
    ).run("2026-08-29T03:00:00.000Z", "2026-08-29T03:10:00.000Z");
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id)
       VALUES ('ee_eval', 'ep_eval', ?, ?)`,
    ).run(leaked[0], leaked[2]);
    db.prepare(
      `INSERT INTO tasks (id, title, status, evidence_json) VALUES ('t_eval', 'pay villa advance', 'open', ?)`,
    ).run(JSON.stringify([{ event_ids: [leaked[2]], quote: "villa advance by 5pm" }]));
    db.prepare(
      `INSERT INTO decisions (id, pass, target_kind, target_id, action, reason)
       VALUES ('d_eval', 'orient', 'event', ?, 'create', 'eval')`,
    ).run(leaked[2]);

    const ftsBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'villa'`).get() as {
        n: number;
      }
    ).n;
    expect(ftsBefore).toBeGreaterThan(0);

    const result = purgeEvalData();

    expect(result.cascade.episodes_deleted).toBe(1);
    expect(result.cascade.tasks_deleted).toBe(1);
    expect(result.cascade.decisions_deleted).toBeGreaterThanOrEqual(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM episode_events`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });
    // No orphan can point at a deleted event id.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind='event' AND target_id = ?`).get(
        leaked[2],
      ),
    ).toEqual({ n: 0 });
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'villa'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    // …and the honest-delete tombstone was written, counts only.
    expect(result.cascade.decision_id).toBeTruthy();
  });

  it("removes empty fixture stream shells but keeps real ones", () => {
    seedLeak();
    seedReal();
    const db = getDb();
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM streams`).get() as { n: number }).n;
    const result = purgeEvalData();
    expect(result.stream_shells_deleted).toBeGreaterThan(0);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM streams`).get() as { n: number }).n;
    expect(after).toBe(before - result.stream_shells_deleted);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM streams WHERE external_key = '919876543210-1602@g.us'`).get(),
    ).toEqual({ n: 1 });
  });

  it("is a no-op on a clean database", () => {
    const real = seedReal();
    const result = purgeEvalData();
    expect(result.cascade.events_deleted).toBe(0);
    expect(result.cascade.decision_id).toBeNull();
    expect(idsInDb().size).toBe(real.length);
    expect(renderPurge(result)).toContain("events               0");
  });
});

describe("the purge CLI", () => {
  it("--dry-run is the default and deletes NOTHING", async () => {
    const leaked = seedLeak();
    seedReal();
    const lines: string[] = [];
    const code = await purgeMain([], (l) => lines.push(l));
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("DRY RUN (nothing has been deleted)");
    expect(text).toContain("Re-run with --confirm");
    expect(text).toContain("matched by signature");
    // Still all there.
    const remaining = idsInDb();
    for (const id of leaked) expect(remaining.has(id)).toBe(true);
  });

  it("--confirm deletes, and says what went", async () => {
    const leaked = seedLeak();
    const real = seedReal();
    const lines: string[] = [];
    const code = await purgeMain(["--confirm"], (l) => lines.push(l));
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("what was removed");
    expect(text).not.toContain("Re-run with --confirm");
    expect(text).toContain(`events               ${leaked.length}`);

    const remaining = idsInDb();
    for (const id of leaked) expect(remaining.has(id)).toBe(false);
    for (const id of real) expect(remaining.has(id)).toBe(true);
  });

  it("rejects an unknown flag", async () => {
    const lines: string[] = [];
    expect(await purgeMain(["--nuke"], (l) => lines.push(l))).toBe(3);
    expect(lines[0]).toContain("unknown flag");
    expect(() => parsePurgeArgs(["--sample", "x"])).toThrow(/non-negative/);
    expect(parsePurgeArgs(["--confirm"]).confirm).toBe(true);
    expect(parsePurgeArgs(["--confirm", "--dry-run"]).confirm).toBe(false);
  });
});
