// ===========================================================================
// /api/capture/* — V6 P1 S1.7. Round-trips over the real server on an
// ephemeral port (closed in afterAll): lists, private moment, forget preview
// → confirm, the per-source verbs with previews, the outside-window review,
// and the tray's state read. Zero model calls.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-capture-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { runMigrations } = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { appendEvents } = await import("../db/eventlog.js");
const { grantConsent, getConsent } = await import("../db/v6core.js");
const { setConsentGateMode } = await import("../db/consent-gate.js");
const { SourceSupervisor, setSourceSupervisor } = await import("../adapters/supervisor.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
const starts: string[] = [];
const stops: string[] = [];

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const NOW = Date.now();
const SELF = { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] };

function browserEnv(msAgo: number, url: string) {
  const ts = new Date(NOW - msAgo).toISOString();
  return {
    ts,
    capturedAt: ts,
    source: "browser",
    kind: "browser.visit",
    origin: "live" as const,
    streamKey: `${new URL(url).hostname}:${ts.slice(0, 10)}`,
    actor: "self",
    roles: SELF,
    payload: { text: `page ${url}`, url, domain: new URL(url).hostname },
  };
}

beforeAll(async () => {
  runMigrations();
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      freshFallback: false,
      status: "ok" as const,
    }),
    cancel: () => false,
  });
  setConsentGateMode("enforce");
  const driver = (name: string) => ({
    start: () => {
      starts.push(name);
    },
    stop: () => {
      stops.push(name);
    },
  });
  const sup = new SourceSupervisor({
    drivers: { whatsapp: driver("whatsapp"), browser: driver("browser"), screen: driver("screen") },
  });
  setSourceSupervisor(sup);
  grantConsent({ source: "browser", indexAll: true, understandFrom: "2020-01-01T00:00:00.000Z" });
  grantConsent({ source: "whatsapp", indexAll: true, understandFrom: "2020-01-01T00:00:00.000Z" });
  await sup.startConsented();
  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  setSourceSupervisor(null);
  setConsentGateMode("open");
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/api/capture — lists, private moment, forget", () => {
  it("lists round-trip and the funnel enforces them immediately", async () => {
    expect((await get("/api/capture/lists")).body).toEqual({ apps: [], sites: [], chats: [], senders: [] });
    const saved = await post("/api/capture/lists", { sites: ["blocked.example"], senders: ["rohan"] });
    expect(saved.status).toBe(200);
    expect(saved.body.sites).toEqual(["blocked.example"]);
    const r = appendEvents([browserEnv(1000, "https://blocked.example/x"), browserEnv(900, "https://ok.example/")]);
    expect(r.ids.map((id) => id !== "")).toEqual([false, true]);
    expect((await post("/api/capture/lists", { apps: "nope" })).status).toBe(400);
    // Settings › Capture reads the same lists.
    const settings = await get("/api/settings/capture");
    expect(settings.body.domain_blocklist).toEqual(["blocked.example"]);
    expect(settings.body.sender_blocklist).toEqual(["rohan"]);
    await post("/api/capture/lists", { sites: [], senders: [] });
  });

  it("private moment: 15 minutes by default, ends on request, shows on state", async () => {
    const before = await get("/api/capture/state");
    expect(before.body.paused).toBe(false);
    expect(before.body.recording.sort()).toEqual(["browser", "whatsapp"]);
    const pm = await post("/api/capture/private-moment");
    expect(pm.status).toBe(200);
    const until = Date.parse(pm.body.private_until);
    expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const state = await get("/api/capture/state");
    expect(state.body).toMatchObject({ paused: true, capturing: false, recording: [], private_until: pm.body.private_until });
    expect(appendEvents([browserEnv(500, "https://during.example/")]).inserted).toBe(0);
    const end = await post("/api/capture/private-moment", { end: true });
    expect(end.body.private_until).toBeNull();
    expect((await get("/api/capture/state")).body.paused).toBe(false);
    expect(appendEvents([browserEnv(400, "https://after.example/")]).inserted).toBe(1);
  });

  it("forget: preview shows the cascade, confirm runs it", async () => {
    appendEvents([browserEnv(2 * 60_000, "https://recent.example/"), browserEnv(3 * 3_600_000, "https://old.example/")]);
    const preview = await post("/api/capture/forget/preview", { minutes: 10 });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.minutes).toBe(10);
    const expected = preview.body.preview.events_deleted;
    expect(expected).toBeGreaterThanOrEqual(1);
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    const done = await post("/api/capture/forget", { minutes: 10 });
    expect(done.body.report.events_deleted).toBe(expected);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(total - expected);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE text LIKE '%old.example%'`).get() as { n: number }).n).toBe(1);
  });
});

describe("/api/capture/sources/:s — the verbs", () => {
  it("pause → resume, consent first, adapter second", async () => {
    const paused = await post("/api/capture/sources/browser/pause");
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ verb: "pause", captureAllowed: false, stopped: true });
    expect(getConsent("browser")?.state).toBe("paused");
    expect(stops).toContain("browser");
    expect((await get("/api/capture/state")).body.sources.find((s: any) => s.source === "browser")).toMatchObject({
      consent: "paused",
      running: false,
      capturing: false,
    });
    const resumed = await post("/api/capture/sources/browser/resume");
    expect(resumed.body).toMatchObject({ verb: "resume", captureAllowed: true });
    expect(starts.filter((s) => s === "browser").length).toBe(2);
  });

  it("delete: preview then confirm; unknown source is 404; wrong method is 405", async () => {
    appendEvents([browserEnv(60_000, "https://gone.example/")]);
    const preview = await post("/api/capture/sources/browser/delete/preview");
    expect(preview.status).toBe(200);
    expect(preview.body.preview.events_deleted).toBeGreaterThanOrEqual(1);
    expect(preview.body.preview.decision_id).toBeNull();
    expect(getConsent("browser")?.state).toBe("connected"); // a preview changes nothing
    const del = await post("/api/capture/sources/browser/delete");
    expect(del.status).toBe(200);
    expect(del.body.deleted.cascade.events_deleted).toBe(preview.body.preview.events_deleted);
    expect(del.body.captureAllowed).toBe(false);
    expect(getConsent("browser")).toBeNull();
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id = 'browser'`).get() as { n: number }).n).toBe(0);
    expect((await post("/api/capture/sources/nope/pause")).status).toBe(404);
    expect((await get("/api/capture/sources/whatsapp/pause")).status).toBe(405);
  });

  it("outside-window review answers (empty here) and one-click stop pauses what is admitted", async () => {
    const review = await get("/api/capture/sources/whatsapp/outside-window");
    expect(review.body).toMatchObject({ source: "whatsapp", episodes: [] });
    const stop = await post("/api/capture/stop");
    expect(stop.body.paused).toEqual(["whatsapp"]);
    expect(stop.body.state.capturing).toBe(false);
    expect(getConsent("whatsapp")?.state).toBe("paused");
  });
});
