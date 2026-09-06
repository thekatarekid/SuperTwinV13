// ===========================================================================
// /api/sources/browser/* (V6 P1 S1.4): discover + counts (copy-then-read,
// no rows written), status, connect (consent row BEFORE the watcher starts).
// Real temp DB (0200 consents), a fixture "home" with three browsers, and a
// spy browser driver on the source supervisor. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { getConsent } from "../db/v6core.js";
import { SourceSupervisor, setSourceSupervisor, type StartContext } from "../adapters/supervisor.js";
import { discoverProfiles } from "../adapters/browser/watcher.js";
import { armBrowserImportProgress, profilesForConsent, resetBrowserImportProgress } from "../adapters/browser/index.js";
import { setHistoryScratchDir } from "../adapters/browser/history-db.js";
import { makeChromeHistory, makeSafariHistory, tmpDir } from "../adapters/browser/test-fixtures.js";
import { DEFAULT_UNDERSTAND_DAYS, handleBrowserSourceRoute, parseConnectBody } from "./browser-source-routes.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

let tmp: string;
let home: string;
let server: Server;
let base: string;
let starts: StartContext[];
let safariPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "st-browser-src-"));
  process.env.SUPERTWIN_DB_PATH = join(tmp, "st.db");
  closeDb();
  runMigrations();
  setHistoryScratchDir(tmpDir());

  home = join(tmp, "home");
  const chrome = join(home, "Library/Application Support/Google/Chrome/Default");
  const brave = join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default");
  const safari = join(home, "Library/Safari");
  for (const d of [chrome, brave, safari]) rmSync(d, { recursive: true, force: true });
  makeChromeHistory(ensure(chrome), [
    { url: "https://a.example/?utm_source=x", title: "A", tsMs: NOW - DAY },
    { url: "https://b.example/", title: "B", tsMs: NOW - 40 * DAY },
  ]);
  makeChromeHistory(ensure(brave), [{ url: "https://c.example/", title: "C", tsMs: NOW - 2 * DAY }]);
  safariPath = makeSafariHistory(ensure(safari), [{ url: "https://s.example/", tsMs: NOW - DAY }]);
  chmodSync(safariPath, 0o000); // no Full Disk Access

  starts = [];
  resetBrowserImportProgress();
  setSourceSupervisor(
    new SourceSupervisor({
      drivers: { browser: { start: (ctx) => void starts.push(ctx), stop: () => {} } },
    }),
  );

  server = createServer((req, res) => {
    void handleBrowserSourceRoute(req, res, { discover: () => discoverProfiles(home), now: () => NOW }).then((handled) => {
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
  resetBrowserImportProgress();
  setSourceSupervisor(null);
  setHistoryScratchDir(null);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  try {
    chmodSync(safariPath, 0o644);
  } catch {
    /* gone */
  }
  rmSync(tmp, { recursive: true, force: true });
});

function ensure(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/sources/browser/discover", () => {
  it("lists every profile with real per-window counts, the FDA message for Safari, and the disclosure — writing nothing", async () => {
    const { status, body } = await get("/api/sources/browser/discover");
    expect(status).toBe(200);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    expect(profiles.map((p) => `${p.browser}/${p.profile}`)).toEqual(["chrome/Default", "brave/Default", "safari/Safari"]);
    const chrome = profiles[0]!;
    expect((chrome.windows as Record<string, { visits: number }>)["7d"]!.visits).toBe(1);
    expect((chrome.windows as Record<string, { visits: number }>)["90d"]!.visits).toBe(2);
    expect(chrome.history_path).toBe(join(home, "Library/Application Support/Google/Chrome/Default/History"));
    const safari = profiles[2]!;
    expect(safari.readable).toBe(false);
    expect((safari.error as { code: string }).code).toBe("full-disk-access");
    expect(body.needs_full_disk_access).toBe(true);
    expect((body.totals as Record<string, { visits: number }>)["7d"]!.visits).toBe(2);
    expect((body.disclosure as { text: string }).text).toContain("copying each one");
    expect(body.connected).toBe(false);
    expect(body.consent).toBeNull();
    // Counting is not capturing: zero events, zero consents.
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM consents`).get() as { n: number }).n).toBe(0);
    expect(starts).toHaveLength(0);
  });
});

describe("POST /api/sources/browser/connect", () => {
  it("grants the consent row FIRST (Index everything, Understand 30 d by default), then starts the watcher with the chosen profiles", async () => {
    const chromeHistory = join(home, "Library/Application Support/Google/Chrome/Default/History");
    const { status, body } = await post("/api/sources/browser/connect", { profiles: [chromeHistory] });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.started).toBe(true);
    expect(body.running).toBe(true);
    const consent = getConsent("browser");
    expect(consent?.state).toBe("connected");
    expect(consent?.indexAll).toBe(true);
    expect(consent?.understandFrom).toBe(new Date(NOW - DEFAULT_UNDERSTAND_DAYS * DAY).toISOString());
    expect((consent?.scope as { profiles: string[] }).profiles).toEqual([chromeHistory]);
    expect((consent?.scope as { discovered: string[] }).discovered).toHaveLength(3);
    // The supervisor started the source under that row, floor = epoch (index everything).
    expect(starts).toHaveLength(1);
    expect(starts[0]!.consent?.id).toBe(consent?.id);
    expect(starts[0]!.sinceMs).toBe(0);

    const st = await get("/api/sources/browser/status");
    expect(st.body.connected).toBe(true);
    expect(st.body.running).toBe(true);
    expect((st.body.consent as { profiles: string[] }).profiles).toEqual([chromeHistory]);
  });

  it("honours explicit windows; rejects Understand reaching past Index (CNS-03) and malformed bodies", async () => {
    const indexFrom = new Date(NOW - 90 * DAY).toISOString();
    const understandFrom = new Date(NOW - 30 * DAY).toISOString();
    const ok = await post("/api/sources/browser/connect", { index_from: indexFrom, understand_from: understandFrom });
    expect(ok.status).toBe(200);
    const c = getConsent("browser")!;
    expect(c.indexAll).toBe(false);
    expect(c.indexFrom).toBe(indexFrom);
    expect(c.understandFrom).toBe(understandFrom);
    expect(starts[0]!.sinceMs).toBe(Date.parse(indexFrom));

    const bad = await post("/api/sources/browser/connect", {
      index_from: new Date(NOW - 30 * DAY).toISOString(),
      understand_from: new Date(NOW - 90 * DAY).toISOString(),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad-windows");

    const malformed = await post("/api/sources/browser/connect", { understand_from: "yesterday-ish" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe("bad-request");

    // `understand_from: null` = nothing to the model until the confirm card says so.
    const none = await post("/api/sources/browser/connect", { understand_from: null });
    expect(none.status).toBe(200);
    expect(getConsent("browser")!.understandFrom).toBeNull();
  });

  // ---- S6d L5: the scoped-import contract, end to end ----------------------

  it("scopes the import to the chosen profiles and window, and records what the card said", async () => {
    const chromeHistory = join(home, "Library/Application Support/Google/Chrome/Default/History");
    const braveHistory = join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/History");
    const indexFrom = new Date(NOW - 90 * DAY).toISOString();
    const { status, body } = await post("/api/sources/browser/connect", {
      profiles: [chromeHistory],
      index_from: indexFrom,
      understand_from: new Date(NOW - 30 * DAY).toISOString(),
      counts: { [chromeHistory]: 2, [braveHistory]: 99 },
      card_text: "Index last 90 days: 2 visits from 1 browser profile (measured).",
    });
    expect(status).toBe(200);

    const consent = getConsent("browser")!;
    const scope = consent.scope as { profiles: string[]; counts: Record<string, number>; card_text: string };
    // Only what was ticked — and the count for a profile that was NOT ticked
    // never rides along as an expectation for an import that will not happen.
    expect(scope.profiles).toEqual([chromeHistory]);
    expect(scope.counts).toEqual({ [chromeHistory]: 2 });
    expect(scope.card_text).toContain("Index last 90 days");
    expect(consent.indexAll).toBe(false);
    expect(consent.indexFrom).toBe(indexFrom);

    // The watcher is started against exactly that scope and that floor…
    expect(starts).toHaveLength(1);
    expect(starts[0]!.sinceMs).toBe(Date.parse(indexFrom));
    expect(profilesForConsent(starts[0]!.consent, () => discoverProfiles(home)).map((p) => p.historyPath)).toEqual([
      chromeHistory,
    ]);
    // …and the connect response already carries the view the panel renders.
    const view = body.consent as { profiles: string[]; counts: Record<string, number>; card_text: string };
    expect(view.profiles).toEqual([chromeHistory]);
    expect(view.counts).toEqual({ [chromeHistory]: 2 });
    expect(view.card_text).toContain("Index last 90 days");
  });

  it("refuses a pick that names no profile on this Mac instead of widening to all", async () => {
    const { status, body } = await post("/api/sources/browser/connect", { profiles: ["/nowhere/History"] });
    expect(status).toBe(400);
    expect(body.error).toBe("unknown-profiles");
    expect(getConsent("browser")).toBeNull();
    expect(starts).toHaveLength(0);
  });

  it("GET …/import answers from the watcher's ledger — never a count over the event log", async () => {
    const before = await get("/api/sources/browser/import");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ source: "browser", connected: false, running: false });
    expect((before.body.progress as { known: boolean }).known).toBe(false);

    const chromeHistory = join(home, "Library/Application Support/Google/Chrome/Default/History");
    armBrowserImportProgress(discoverProfiles(home).filter((p) => p.historyPath === chromeHistory));
    await post("/api/sources/browser/connect", { profiles: [chromeHistory], counts: { [chromeHistory]: 2 } });

    const after = await get("/api/sources/browser/import");
    const progress = after.body.progress as {
      known: boolean;
      first_pass_done: boolean;
      expected_visits: number | null;
      profiles: Array<{ history_path: string; state: string; expected_visits: number | null }>;
    };
    expect(after.body.connected).toBe(true);
    expect(progress.known).toBe(true);
    expect(progress.first_pass_done).toBe(false);
    // The expectation comes from the consent row's scope, measured by the card.
    expect(progress.expected_visits).toBe(2);
    expect(progress.profiles).toHaveLength(1);
    expect(progress.profiles[0]).toMatchObject({ history_path: chromeHistory, state: "pending", expected_visits: 2 });
  });

  it("status before connect: not connected, not running, zero events", async () => {
    const { body } = await get("/api/sources/browser/status");
    expect(body).toMatchObject({ source: "browser", connected: false, running: false, consent: null, event_count: 0 });
  });

  it("unknown browser-source paths fall through", async () => {
    const { status } = await get("/api/sources/browser/nope");
    expect(status).toBe(404);
  });
});

describe("parseConnectBody", () => {
  it("defaults: index everything, understand 30 days, no profile filter", () => {
    const b = parseConnectBody({}, NOW);
    expect(b).toEqual({
      indexAll: true,
      indexFrom: null,
      understandFrom: new Date(NOW - 30 * DAY).toISOString(),
      profiles: [],
      counts: {},
      cardText: null,
    });
  });
  it("index_from implies index_all=false unless index_all is stated", () => {
    const from = new Date(NOW - 7 * DAY).toISOString();
    expect(parseConnectBody({ index_from: from }, NOW).indexAll).toBe(false);
    expect(parseConnectBody({ index_from: from, index_all: true }, NOW)).toMatchObject({ indexAll: true, indexFrom: null });
    expect(() => parseConnectBody({ profiles: "nope" }, NOW)).toThrow(/profiles/);
  });

  // S6d L5: the card's pick, its measured counts and its own words.
  it("carries the profile pick, the per-profile counts and the card text", () => {
    const b = parseConnectBody(
      {
        profiles: ["/a/History", "/b/History", "/a/History"],
        counts: { "/a/History": 3400.7, "/b/History": 12 },
        card_text: "Index everything: 3,412 visits.",
      },
      NOW,
    );
    expect(b.profiles).toEqual(["/a/History", "/b/History"]); // de-duped, order kept
    expect(b.counts).toEqual({ "/a/History": 3400, "/b/History": 12 });
    expect(b.cardText).toBe("Index everything: 3,412 visits.");
    expect(() => parseConnectBody({ counts: [1, 2] }, NOW)).toThrow(/counts/);
    expect(() => parseConnectBody({ counts: { "/a": -1 } }, NOW)).toThrow(/counts/);
    expect(() => parseConnectBody({ card_text: 7 }, NOW)).toThrow(/card_text/);
  });
});
