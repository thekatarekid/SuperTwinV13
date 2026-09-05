// ===========================================================================
// CNS-01 — nothing before yes (V6 P1 S1.3, Build §4.1; GoldenEvals_V6_Phase1
// §5.2): the boot-inversion half, deterministic, zero model calls.
//
//   Setup: fresh home, all adapters present, no consent rows.
//   Expected: 0 events; no WhatsApp daemon; no screen sidecar.
//   Wrong: `microtask-import` — the browser 90-day import fires at boot.
//
// The funnel half (both single-writer funnels write nothing without a row) is
// db/consent-gate.test.ts (S1.2). Here every driver is a spy: the supervisor
// runs against a real migrated SQLite file (the consents table + app_state),
// and the assertion is that no driver's `start` is ever called on a fresh
// home — plus the matrix of what DOES start once rows exist, and the T4-4
// rule that the browser floor comes from the row and cannot be omitted.
//
// The 60-second real-process half (worker boots on a scratch home, serves
// /api/health, spawns no child, writes no event) is
// src/cns-01-boot.integration.test.ts.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateGet } from "../db/ingest.js";
import { grantConsent, setConsentState } from "../db/v6core.js";
import { BrowserWatcher, requireSinceMs } from "./browser/watcher.js";
import { MemorySink } from "./browser/sink.js";
import {
  armScreenRecording,
  disarmScreenRecording,
  getSourceSupervisor,
  importFloorMs,
  SCREEN_RECORD_FROM_KEY,
  screenRecordFrom,
  setSourceSupervisor,
  SourceSupervisor,
  SUPERVISED_SOURCES,
  type SourceDriver,
  type StartContext,
  type SupervisedSource,
} from "./supervisor.js";

// ---- harness ---------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cns01-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  setSourceSupervisor(null);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

class SpyDriver implements SourceDriver {
  starts: StartContext[] = [];
  stops = 0;
  failWith: Error | null = null;
  start(ctx: StartContext): void {
    if (this.failWith) throw this.failWith;
    this.starts.push(ctx);
  }
  stop(): void {
    this.stops += 1;
  }
}

function spies(): Record<SupervisedSource, SpyDriver> {
  return { whatsapp: new SpyDriver(), browser: new SpyDriver(), screen: new SpyDriver() };
}

function supervisor(drivers: Record<SupervisedSource, SpyDriver>, log: string[] = []): SourceSupervisor {
  return new SourceSupervisor({ drivers, log: (l) => log.push(l) });
}

// ---------------------------------------------------------------------------
// CNS-01
// ---------------------------------------------------------------------------

describe("CNS-01 — nothing before yes (boot inversion)", () => {
  it("fresh home, no consent rows: boot starts NO adapter — no daemon, no sidecar, no history read", async () => {
    expect(count("consents")).toBe(0);
    const d = spies();
    const log: string[] = [];
    const report = await supervisor(d, log).startConsented();

    expect(report.started).toEqual([]);
    expect(report.skipped.map((s) => `${s.source}:${s.reason}`)).toEqual([
      "whatsapp:no-consent",
      "browser:no-consent",
      "screen:no-consent",
    ]);
    // Wrong: microtask-import — the browser watcher was never even constructed.
    expect(d.browser.starts).toHaveLength(0);
    expect(d.whatsapp.starts).toHaveLength(0);
    expect(d.screen.starts).toHaveLength(0);
    expect(count("events")).toBe(0);
    expect(count("archive")).toBe(0);
    expect(log.some((l) => l.includes("browser: not started (no-consent)"))).toBe(true);
  });

  it("a paused / disconnected / revoked row is not consent: still nothing starts", async () => {
    grantConsent({ source: "whatsapp", state: "paused" });
    grantConsent({ source: "browser", state: "disconnected" });
    grantConsent({ source: "screen" });
    setConsentState("screen", "revoked");
    const d = spies();
    const report = await supervisor(d).startConsented();
    expect(report.started).toEqual([]);
    for (const s of SUPERVISED_SOURCES) expect(d[s].starts).toHaveLength(0);
  });

  it("a connected row starts exactly that source, with the row on the context", async () => {
    const row = grantConsent({ source: "whatsapp" });
    const d = spies();
    const report = await supervisor(d).startConsented();
    expect(report.started).toEqual(["whatsapp"]);
    expect(d.whatsapp.starts).toHaveLength(1);
    expect(d.whatsapp.starts[0]!.consent?.id).toBe(row.id);
    expect(d.browser.starts).toHaveLength(0);
    expect(d.screen.starts).toHaveLength(0);
    expect(report.skipped.map((s) => s.source)).toEqual(["browser", "screen"]);
  });

  it("the browser floor is the consent row's INDEX window (T4-4): everything → epoch, a date → that date", async () => {
    grantConsent({ source: "browser" }); // index_all
    let d = spies();
    await supervisor(d).startConsented();
    expect(d.browser.starts[0]!.sinceMs).toBe(0);

    grantConsent({ source: "browser", indexAll: false, indexFrom: "2026-08-01T00:00:00.000Z" });
    d = spies();
    await supervisor(d).startConsented();
    expect(d.browser.starts[0]!.sinceMs).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("a start that throws is a logged skip, never a boot failure; the others still start", async () => {
    grantConsent({ source: "whatsapp" });
    grantConsent({ source: "browser" });
    const d = spies();
    d.whatsapp.failWith = new Error("daemon binary missing");
    const log: string[] = [];
    const report = await supervisor(d, log).startConsented();
    expect(report.started).toEqual(["browser"]);
    expect(report.skipped).toContainEqual({ source: "whatsapp", reason: "start-failed", detail: "daemon binary missing" });
    expect(report.skipped.find((s) => s.source === "screen")).toEqual({ source: "screen", reason: "no-consent", detail: undefined });
  });
});

// ---------------------------------------------------------------------------
// Screen: consent → Accessibility → explicit "Record from now on" (T4-8)
// ---------------------------------------------------------------------------

describe("screen sidecar spawns only after the explicit 'Record from now on'", () => {
  it("consent alone does NOT spawn the sidecar (not-armed)", async () => {
    grantConsent({ source: "screen" });
    const d = spies();
    const sup = supervisor(d);
    expect(sup.decide("screen")).toEqual({ start: false, reason: "not-armed" });
    const report = await sup.startConsented();
    expect(report.started).toEqual([]);
    expect(d.screen.starts).toHaveLength(0);
  });

  it("'Record from now on' without consent does not spawn either — both are needed", async () => {
    armScreenRecording("2026-09-01T12:00:00.000Z");
    const d = spies();
    expect(supervisor(d).decide("screen")).toEqual({ start: false, reason: "no-consent" });
    await supervisor(d).startConsented();
    expect(d.screen.starts).toHaveLength(0);
  });

  it("consent + record_from spawns, carrying the recorded instant; disarm stops it on the next boot", async () => {
    grantConsent({ source: "screen" });
    const from = armScreenRecording("2026-09-01T12:00:00.000Z");
    expect(appStateGet(SCREEN_RECORD_FROM_KEY)).toBe(from);
    expect(screenRecordFrom()).toBe(from);

    let d = spies();
    const report = await supervisor(d).startConsented();
    expect(report.started).toEqual(["screen"]);
    expect(d.screen.starts[0]!.recordFrom).toBe(from);

    disarmScreenRecording();
    d = spies();
    expect((await supervisor(d).startConsented()).started).toEqual([]);
  });

  it("armScreenRecording defaults to now (ISO)", () => {
    const before = Date.now();
    const from = armScreenRecording();
    expect(Date.parse(from)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(from)).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// start / stop / pairing exception / module handle
// ---------------------------------------------------------------------------

describe("SourceSupervisor lifecycle", () => {
  it("start(source) after grantConsent is the connect-flow path; idempotent; stop tears down", async () => {
    const d = spies();
    const sup = supervisor(d);
    expect(await sup.start("browser")).toEqual({ started: false, source: "browser", reason: "no-consent" });

    grantConsent({ source: "browser" });
    expect(await sup.start("browser")).toEqual({ started: true, source: "browser", sinceMs: 0 });
    expect(sup.isRunning("browser")).toBe(true);
    expect(sup.running()).toEqual(["browser"]);
    expect(await sup.start("browser")).toEqual({ started: false, source: "browser", reason: "already-running" });
    expect(d.browser.starts).toHaveLength(1);

    expect(await sup.stop("browser")).toBe(true);
    expect(d.browser.stops).toBe(1);
    expect(sup.isRunning("browser")).toBe(false);
    expect(await sup.stop("browser")).toBe(false);
  });

  it("ensureWhatsAppDaemon is the ONLY pre-consent spawn: WhatsApp only, idempotent, null consent on the context", async () => {
    const d = spies();
    const sup = supervisor(d);
    expect(await sup.ensureWhatsAppDaemon()).toBe(true);
    expect(await sup.ensureWhatsAppDaemon()).toBe(true);
    expect(d.whatsapp.starts).toHaveLength(1);
    expect(d.whatsapp.starts[0]!.consent).toBeNull();
    expect(sup.isRunning("whatsapp")).toBe(true);
    // Nothing else moved.
    expect(d.browser.starts).toHaveLength(0);
    expect(d.screen.starts).toHaveLength(0);
    // And no event exists — the funnel has no row to admit anything (S1.2).
    expect(count("events")).toBe(0);
  });

  it("a source without a driver is skipped (no-driver) and never appears in the report", async () => {
    grantConsent({ source: "screen" });
    armScreenRecording();
    const sup = new SourceSupervisor({ drivers: { browser: new SpyDriver() } });
    expect(sup.decide("screen")).toEqual({ start: false, reason: "no-driver" });
    const report = await sup.startConsented();
    expect(report.started).toEqual([]);
    expect(report.skipped).toEqual([{ source: "browser", reason: "no-consent", detail: undefined }]);
  });

  it("stopAll tears down everything running; the module handle is set/cleared by the entrypoint", async () => {
    grantConsent({ source: "whatsapp" });
    grantConsent({ source: "browser" });
    const d = spies();
    const sup = supervisor(d);
    setSourceSupervisor(sup);
    expect(getSourceSupervisor()).toBe(sup);
    await sup.startConsented();
    expect(sup.running()).toEqual(["whatsapp", "browser"]);
    await sup.stopAll();
    expect(sup.running()).toEqual([]);
    expect(d.whatsapp.stops + d.browser.stops).toBe(2);
    setSourceSupervisor(null);
    expect(getSourceSupervisor()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T4-4: sinceMs is required — no 90-day floor by omission
// ---------------------------------------------------------------------------

describe("BrowserWatcher sinceMs is required (T4-4)", () => {
  it("omitting sinceMs throws at construction — before any history file is opened", () => {
    const sink = new MemorySink();
    // A JS caller (or a spread Partial) can still omit it; the runtime rule catches that.
    const opts = { sink, profiles: [] } as unknown as ConstructorParameters<typeof BrowserWatcher>[0];
    expect(() => new BrowserWatcher(opts)).toThrow(/sinceMs .*required/);
    expect(() => requireSinceMs(undefined)).toThrow(TypeError);
    expect(() => requireSinceMs(Number.NaN)).toThrow(/sinceMs/);
    expect(() => requireSinceMs("0")).toThrow(/sinceMs/);
    expect(requireSinceMs(0)).toBe(0);
    expect(requireSinceMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("importFloorMs refuses an unparseable index_from instead of inventing a floor", () => {
    const row = grantConsent({ source: "browser" });
    expect(importFloorMs(row)).toBe(0);
    expect(() => importFloorMs({ ...row, indexAll: false, indexFrom: "not-a-date" })).toThrow(/sinceMs/);
  });
});
