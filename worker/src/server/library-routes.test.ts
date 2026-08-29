// ===========================================================================
// Freshness + Library routes (build P2.4, spec §5.4 / §14.3.2): the chip
// payload, the three per-source views, the per-stream capture pause (with its
// decision row AND the ingest funnels actually dropping paused streams), and
// the honest cascading screen delete over HTTP.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { handleLibraryRoute, screenSessions } from "./library-routes.js";

// Midday UTC of the REAL current day: the route computes "today" with
// SQLite's 'now' (the actual system clock), so a hard-pinned date makes the
// suite fail the moment the clock crosses UTC midnight past the pin. Events
// seeded at NOW-<minutes> stay inside today for any run time of day.
const NOW = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);

let tmpDir: string;
let server: Server;
let base: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-library-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  server = createServer((req, res) => {
    void handleLibraryRoute(req, res).then((handled) => {
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
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function env(
  source: string,
  key: string,
  ts: string,
  text: string,
  kind = `${source}.message`,
  payloadExtra: Record<string, unknown> = {},
): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source,
    kind,
    origin: "live",
    streamKey: key,
    actor: "contact:x",
    roles: { sender: "contact:x", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, ...payloadExtra },
  };
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/freshness", () => {
  it("returns per-source freshness and the header chip label", async () => {
    const r = appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:58:00.000Z", "hi")], NOW);
    getDb().prepare(`UPDATE events SET dispatched_at = ts WHERE id = ?`).run(r.ids[0]);
    const { status, body } = await get("/api/freshness");
    expect(status).toBe(200);
    const o = body as { sources: { source_id: string }[]; label: string | null };
    expect(o.sources.map((s) => s.source_id)).toEqual(["whatsapp"]);
    expect(o.label).toContain("Knows you: Aug 2026 →");
  });
});

describe("GET /api/library/chats", () => {
  it("lists streams with tier badge, category, knows-from and today count", async () => {
    const r = appendEvents(
      [
        env("whatsapp", "goa@g.us", "2024-01-05T00:00:00.000Z", "old"),
        env("whatsapp", "goa@g.us", new Date(NOW - 60_000).toISOString(), "today msg"),
      ],
      NOW,
    );
    const db = getDb();
    db.prepare(`UPDATE events SET dispatched_at = ts WHERE id = ?`).run(r.ids[0]);
    db.prepare(
      `UPDATE streams SET label = 'Goa gang', tier = 'T1', category = 'cat1' WHERE id = 'whatsapp:st:goa@g.us'`,
    ).run();
    const { status, body } = await get("/api/library/chats");
    expect(status).toBe(200);
    const rows = (body as { streams: Record<string, unknown>[] }).streams;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "whatsapp:st:goa@g.us",
      label: "Goa gang",
      tier: "T1",
      category: "cat1",
      capture_paused: 0,
      knows_from: "2024-01-05T00:00:00.000Z",
      today_count: 1,
      event_count: 2,
    });
  });

  it("carries the last-message preview the chat-inbox list renders", async () => {
    appendEvents(
      [
        env("whatsapp", "goa@g.us", "2026-08-28T10:00:00.000Z", "older"),
        env("whatsapp", "goa@g.us", "2026-08-28T11:00:00.000Z", "pool villa?"),
      ],
      NOW,
    );
    const { body } = await get("/api/library/chats");
    const b = body as {
      source_id: string;
      event_count: number;
      streams: { last_text: string | null; last_kind: string | null }[];
    };
    expect(b.source_id).toBe("whatsapp");
    expect(b.event_count).toBe(2);
    expect(b.streams[0].last_text).toBe("pool villa?");
    expect(b.streams[0].last_kind).toBe("whatsapp.message");
  });
});

describe("GET /api/library/browser", () => {
  it("returns today's domains, chains with dwell, and the bookmark shelf", async () => {
    const today = new Date(NOW - 3600_000).toISOString();
    appendEvents(
      [
        env("browser", "chain-1", today, "Anjuna villas airbnb.com", "browser.visit", {
          url: "https://airbnb.com/s/anjuna",
          title: "Anjuna villas",
          domain: "airbnb.com",
          dwell_ms: 240_000,
        }),
        env("browser", "browser:chrome:bookmarks", today, "Villa Sol", "browser.bookmark", {
          url: "https://airbnb.com/rooms/1",
          title: "Villa Sol",
          folder: "Goa",
        }),
      ],
      NOW,
    );
    const { status, body } = await get("/api/library/browser");
    expect(status).toBe(200);
    const b = body as {
      domains_today: { domain: string; visits: number }[];
      chains: { stream_key: string; visits: { dwell_ms: number }[]; space_label: string | null }[];
      bookmarks: { title: string | null; folder: string | null }[];
    };
    expect(b.domains_today).toEqual([{ domain: "airbnb.com", visits: 1 }]);
    const chain = b.chains.find((c) => c.stream_key === "chain-1")!;
    expect(chain.visits[0].dwell_ms).toBe(240_000);
    expect(b.bookmarks[0]).toMatchObject({ title: "Villa Sol", folder: "Goa" });
  });
});

describe("GET /api/library/screen", () => {
  it("buckets the day into hours and groups events into session cards", async () => {
    appendEvents(
      [
        env("screen", "screen:app:Airbnb", "2026-08-28T14:02:00.000Z", "villas", "screen.capture", { app: "Airbnb" }),
        env("screen", "screen:app:Airbnb", "2026-08-28T14:06:00.000Z", "villa sol", "screen.capture", { app: "Airbnb" }),
        env("screen", "screen:app:Figma", "2026-08-28T13:20:00.000Z", "mocks", "screen.capture", { app: "Figma" }),
      ],
      NOW,
    );
    const { status, body } = await get("/api/library/screen?day=2026-08-28");
    expect(status).toBe(200);
    const s = body as { hours: number[]; sessions: { app: string; minutes: number; event_count: number }[] };
    expect(s.hours[14]).toBe(2);
    expect(s.hours[13]).toBe(1);
    expect(s.sessions).toHaveLength(2);
    const airbnb = s.sessions.find((x) => x.app === "Airbnb")!;
    expect(airbnb.event_count).toBe(2);
    expect(airbnb.minutes).toBe(4);
  });

  it("rejects a malformed day", async () => {
    const { status } = await get("/api/library/screen?day=nope");
    expect(status).toBe(400);
  });

  it("names apps from the sidecar's own payload and groups sessions BY APP", async () => {
    // The real screenwatch payload (adapters/screen/envelope.ts) spells these
    // `app_name`/`bundle_id`/`window_title`, and its stream key is
    // `bundleId¦docKey` — before this the view showed raw stream keys.
    appendEvents(
      [
        env("screen", "com.figma.Desktop¦mocks", "2026-08-28T13:20:00.000Z", "mocks", "screen.snapshot", {
          bundle_id: "com.figma.Desktop",
          app_name: "Figma",
          window_title: "v13 mocks",
          doc_key: "mocks",
        }),
        env("screen", "com.figma.Desktop¦mocks", "2026-08-28T13:40:00.000Z", "more", "screen.snapshot", {
          bundle_id: "com.figma.Desktop",
          app_name: "Figma",
          window_title: "v13 mocks",
          doc_key: "mocks",
        }),
        env("screen", "com.figma.Desktop¦specs", "2026-08-28T14:10:00.000Z", "specs", "screen.snapshot", {
          bundle_id: "com.figma.Desktop",
          app_name: "Figma",
          window_title: "specs",
          doc_key: "specs",
        }),
      ],
      NOW,
    );
    const { body } = await get("/api/library/screen?day=2026-08-28");
    const s = body as {
      sessions: { app: string; bundle_id: string; doc: string | null }[];
      apps: {
        bundle_id: string;
        app: string;
        minutes: number;
        session_count: number;
        docs: { doc: string | null; sessions: unknown[] }[];
      }[];
      event_count: number;
    };
    expect(s.sessions[0].app).toBe("Figma");
    expect(s.sessions[0].bundle_id).toBe("com.figma.Desktop");
    expect(s.apps).toHaveLength(1);
    // 3 sessions: the two "v13 mocks" captures sit 20 min apart, past the gap.
    expect(s.apps[0]).toMatchObject({ bundle_id: "com.figma.Desktop", app: "Figma", session_count: 3 });
    expect(s.apps[0].docs.map((d) => d.doc)).toEqual(["v13 mocks", "specs"]);
    expect(s.event_count).toBe(3);
  });

  it("splits sessions on a 15-minute gap in the same app", () => {
    const rows = [
      { id: "a", ts: "2026-08-28T10:00:00.000Z", stream_key: "screen:app:Figma", payload_json: JSON.stringify({ app: "Figma" }) },
      { id: "b", ts: "2026-08-28T10:05:00.000Z", stream_key: "screen:app:Figma", payload_json: JSON.stringify({ app: "Figma" }) },
      { id: "c", ts: "2026-08-28T11:00:00.000Z", stream_key: "screen:app:Figma", payload_json: JSON.stringify({ app: "Figma" }) },
    ];
    const sessions = screenSessions(rows);
    expect(sessions).toHaveLength(2);
  });
});

describe("POST /api/library/streams/:id/pause", () => {
  it("flips the pause, writes a decision, and the funnels drop new events", async () => {
    appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:00:00.000Z", "before")], NOW);
    const streamId = "whatsapp:st:goa@g.us";
    const { status, body } = await post(`/api/library/streams/${encodeURIComponent(streamId)}/pause`, {
      paused: true,
    });
    expect(status).toBe(200);
    const resBody = body as { paused: boolean; decision_id: string | null };
    expect(resBody.paused).toBe(true);
    expect(resBody.decision_id).toBeTruthy();
    const db = getDb();
    expect(
      db.prepare(`SELECT capture_paused FROM streams WHERE id = ?`).get(streamId),
    ).toMatchObject({ capture_paused: 1 });
    expect(
      db
        .prepare(`SELECT action FROM decisions WHERE target_kind='stream' AND target_id=?`)
        .get(streamId),
    ).toMatchObject({ action: "capture_pause" });

    // The single-writer funnel drops events for the paused stream.
    const dropped = appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:59:00.000Z", "while paused")], NOW);
    expect(dropped.inserted).toBe(0);
    expect(dropped.ids).toEqual([""]);

    // Resume: idempotent decision-per-flip, capture flows again.
    await post(`/api/library/streams/${encodeURIComponent(streamId)}/pause`, { paused: false });
    const after = appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:59:30.000Z", "resumed")], NOW);
    expect(after.inserted).toBe(1);
  });

  it("404s an unknown stream and 400s a missing flag", async () => {
    expect((await post("/api/library/streams/nope/pause", { paused: true })).status).toBe(404);
    appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:00:00.000Z", "x")], NOW);
    expect(
      (await post("/api/library/streams/whatsapp%3Ast%3Agoa%40g.us/pause", {})).status,
    ).toBe(400);
  });
});

describe("POST /api/library/screen/delete", () => {
  it("hard-deletes the span and reports the cascade", async () => {
    appendEvents(
      [
        env("screen", "screen:app:Figma", "2026-08-28T13:20:00.000Z", "mocks", "screen.capture", { app: "Figma" }),
        env("whatsapp", "goa@g.us", "2026-08-28T13:25:00.000Z", "survivor"),
      ],
      NOW,
    );
    const { status, body } = await post("/api/library/screen/delete", {
      start_ts: "2026-08-28T00:00:00.000Z",
      end_ts: "2026-08-28T23:59:59.999Z",
    });
    expect(status).toBe(200);
    const report = (body as { report: { events_deleted: number; decision_id: string } }).report;
    expect(report.events_deleted).toBe(1);
    expect(report.decision_id).toBeTruthy();
    const db = getDb();
    expect(db.prepare(`SELECT COUNT(*) n FROM events WHERE source_type='screen'`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM events WHERE source_type='whatsapp'`).get()).toMatchObject({ n: 1 });
  });

  it("400s without a span", async () => {
    expect((await post("/api/library/screen/delete", {})).status).toBe(400);
  });
});
