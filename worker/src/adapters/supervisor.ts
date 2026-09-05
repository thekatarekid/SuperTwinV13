// ===========================================================================
// Source supervisor — the boot inversion (V6 P1 S1.3, Build §4.1; backlog
// T4-3, T4-4, T4-8).
//
// Before this module the worker entrypoint started every adapter as a matter
// of course: the WhatsApp daemon spawned, the browser watcher imported 90 days
// of history on its first microtask, the screen sidecar began capturing the
// instant Accessibility flipped true. Consent was a UI notion. The funnel gate
// (db/consent-gate.ts, S1.2) already drops what no consent row admits; this
// module makes sure nothing is even LOOKED AT before yes:
//
//   * an adapter starts only when its source has a live consent row in state
//     'connected' (v6core.captureAllowed) — no row, no process, no read;
//   * the browser watcher's import floor is derived from that row
//     (index_all → epoch, else index_from) and handed over as the REQUIRED
//     `sinceMs` — the 90-day default cannot return by omission (T4-4);
//   * the screen sidecar needs the consent row AND the user's explicit
//     "Record from now on" (app_state `screen.record_from`, written by
//     POST /api/screen/record after the Accessibility probe passed) — consent
//     alone spawns nothing (T4-8);
//   * WhatsApp pairing is the one legitimate pre-consent spawn: the QR flow
//     needs the daemon, and the funnel drops every frame until the user
//     confirms (S1.5). `ensureWhatsAppDaemon()` is that path, and it is the
//     ONLY one that bypasses the consent check — named so it cannot be
//     mistaken for `start()`.
//
// The connect flows (S1.4 browser, S1.5 WhatsApp, S1.6 screen) call
// `start(source)` after `grantConsent(...)`; the verbs (S1.7) call
// `stop(source)` AFTER flipping the consent row, so a throwing teardown still
// leaves capture blocked at the funnel.
//
// Zero model calls. Drivers are injected; the entrypoint wires the real ones.
// ===========================================================================

import { appStateDelete, appStateGet, appStateSet } from "../db/ingest.js";
import {
  captureAllowed as dbCaptureAllowed,
  getConsent as dbGetConsent,
  type ConsentRow,
} from "../db/v6core.js";
import { requireSinceMs } from "./browser/watcher.js";

/** Consent `source` keys are the adapters' own source ids (the funnel keys on them). */
export type SupervisedSource = "whatsapp" | "browser" | "screen";
export const SUPERVISED_SOURCES: readonly SupervisedSource[] = ["whatsapp", "browser", "screen"];

/** app_state key: ISO timestamp of the explicit "Record from now on". */
export const SCREEN_RECORD_FROM_KEY = "screen.record_from";

export interface StartContext {
  /** The admitting row. Null ONLY on the pairing exception (`ensureWhatsAppDaemon`). */
  consent: ConsentRow | null;
  /** Import floor, unix ms — epoch when the INDEX window is "everything". */
  sinceMs: number;
  /** Screen only: the recorded "Record from now on" instant. */
  recordFrom: string | null;
}

export interface SourceDriver {
  start(ctx: StartContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export type SkipReason =
  | "no-consent" // no live 'connected' consent row
  | "not-armed" // screen: consent present, "Record from now on" not given
  | "no-driver"
  | "already-running";

export type Decision =
  | { start: true; ctx: StartContext }
  | { start: false; reason: SkipReason };

export type StartOutcome =
  | { started: true; source: SupervisedSource; sinceMs: number }
  | { started: false; source: SupervisedSource; reason: SkipReason | "start-failed"; detail?: string };

export interface BootReport {
  started: SupervisedSource[];
  skipped: Array<{ source: SupervisedSource; reason: SkipReason | "start-failed"; detail?: string }>;
}

export interface SupervisorOptions {
  drivers: Partial<Record<SupervisedSource, SourceDriver>>;
  log?: (line: string) => void;
  /** Test seams — default to the consents table and app_state. */
  captureAllowed?: (source: string) => boolean;
  getConsent?: (source: string) => ConsentRow | null;
  recordFrom?: () => string | null;
}

/** The browser import floor from a consent row (T4-4): everything → epoch. */
export function importFloorMs(consent: ConsentRow): number {
  if (consent.indexAll || consent.indexFrom === null) return 0;
  return requireSinceMs(Date.parse(consent.indexFrom));
}

export class SourceSupervisor {
  private readonly drivers: Partial<Record<SupervisedSource, SourceDriver>>;
  private readonly log: (line: string) => void;
  private readonly captureAllowed: (source: string) => boolean;
  private readonly getConsent: (source: string) => ConsentRow | null;
  private readonly readRecordFrom: () => string | null;
  private readonly runningSet = new Set<SupervisedSource>();
  /** The last stop() failure per source (S1.7 verbs surface it; the row flipped first). */
  private readonly stopErrors = new Map<SupervisedSource, string>();

  constructor(opts: SupervisorOptions) {
    this.drivers = opts.drivers;
    this.log = opts.log ?? (() => {});
    this.captureAllowed = opts.captureAllowed ?? dbCaptureAllowed;
    this.getConsent = opts.getConsent ?? dbGetConsent;
    this.readRecordFrom = opts.recordFrom ?? (() => appStateGet(SCREEN_RECORD_FROM_KEY));
  }

  isRunning(source: SupervisedSource): boolean {
    return this.runningSet.has(source);
  }

  running(): SupervisedSource[] {
    return SUPERVISED_SOURCES.filter((s) => this.runningSet.has(s));
  }

  /** The predicate, pure over (consent row, app_state): what boot would do. */
  decide(source: SupervisedSource): Decision {
    if (!this.drivers[source]) return { start: false, reason: "no-driver" };
    if (this.runningSet.has(source)) return { start: false, reason: "already-running" };
    if (!this.captureAllowed(source)) return { start: false, reason: "no-consent" };
    const consent = this.getConsent(source);
    if (!consent || consent.state !== "connected") return { start: false, reason: "no-consent" };
    const recordFrom = source === "screen" ? this.readRecordFrom() : null;
    if (source === "screen" && !recordFrom) return { start: false, reason: "not-armed" };
    return { start: true, ctx: { consent, sinceMs: importFloorMs(consent), recordFrom } };
  }

  /** Start one source if — and only if — its consent admits it. */
  async start(source: SupervisedSource): Promise<StartOutcome> {
    const d = this.decide(source);
    if (!d.start) {
      this.log(`[sources] ${source}: not started (${d.reason})`);
      return { started: false, source, reason: d.reason };
    }
    return this.run(source, d.ctx);
  }

  /**
   * Boot: start every source whose consent row admits it, nothing else. A
   * fresh home (no rows) starts nothing — CNS-01's "no daemon, no sidecar".
   */
  async startConsented(): Promise<BootReport> {
    const report: BootReport = { started: [], skipped: [] };
    for (const source of SUPERVISED_SOURCES) {
      if (!this.drivers[source]) continue;
      const outcome = await this.start(source);
      if (outcome.started) report.started.push(source);
      else report.skipped.push({ source, reason: outcome.reason, detail: outcome.detail });
    }
    return report;
  }

  /**
   * The pairing exception: spawn the WhatsApp daemon BEFORE a consent row
   * exists so the QR flow can run. Nothing it emits reaches the event log —
   * the funnel has no row to admit it (S1.2) — until confirm grants consent.
   * Idempotent. Returns whether the daemon is (now) running.
   */
  async ensureWhatsAppDaemon(): Promise<boolean> {
    if (this.runningSet.has("whatsapp")) return true;
    const driver = this.drivers.whatsapp;
    if (!driver) return false;
    try {
      await driver.start({ consent: null, sinceMs: 0, recordFrom: null });
      this.runningSet.add("whatsapp");
      this.log("[sources] whatsapp: daemon started for pairing (no consent yet — funnel drops everything until confirm)");
      return true;
    } catch (err) {
      this.log(`[sources] whatsapp: pairing spawn failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Stop one source. Callers flip the consent row FIRST (T4-11). */
  async stop(source: SupervisedSource): Promise<boolean> {
    if (!this.runningSet.has(source)) return false;
    this.runningSet.delete(source);
    this.stopErrors.delete(source);
    try {
      await this.drivers[source]?.stop();
    } catch (err) {
      this.stopErrors.set(source, (err as Error).message);
      this.log(`[sources] ${source}: stop failed: ${(err as Error).message}`);
    }
    return true;
  }

  /** The message of the most recent stop() failure for the source, if any. */
  lastStopError(source: SupervisedSource): string | null {
    return this.stopErrors.get(source) ?? null;
  }

  async stopAll(): Promise<void> {
    for (const source of [...this.runningSet]) await this.stop(source);
  }

  private async run(source: SupervisedSource, ctx: StartContext): Promise<StartOutcome> {
    const driver = this.drivers[source]!;
    try {
      await driver.start(ctx);
    } catch (err) {
      const detail = (err as Error).message;
      this.log(`[sources] ${source}: start failed (continuing): ${detail}`);
      return { started: false, source, reason: "start-failed", detail };
    }
    this.runningSet.add(source);
    const c = ctx.consent;
    this.log(
      `[sources] ${source}: started under consent ${c?.id ?? "?"} ` +
        `(index ${c?.indexAll ? "everything" : `from ${c?.indexFrom}`}` +
        `${ctx.recordFrom ? `, recording from ${ctx.recordFrom}` : ""})`,
    );
    return { started: true, source, sinceMs: ctx.sinceMs };
  }
}

// ---- "Record from now on" (screen, T4-8) ------------------------------------

/** Persist the explicit start instant. Returns it. */
export function armScreenRecording(fromIso: string = new Date().toISOString()): string {
  appStateSet(SCREEN_RECORD_FROM_KEY, fromIso);
  return fromIso;
}

export function screenRecordFrom(): string | null {
  return appStateGet(SCREEN_RECORD_FROM_KEY);
}

/** Forget the explicit start (disconnect / delete verbs, S1.7). */
export function disarmScreenRecording(): void {
  appStateDelete(SCREEN_RECORD_FROM_KEY);
}

// ---- Module-level handle (routes reach it without boot-order plumbing) -----

let current: SourceSupervisor | null = null;

export function setSourceSupervisor(s: SourceSupervisor | null): void {
  current = s;
}

export function getSourceSupervisor(): SourceSupervisor | null {
  return current;
}
