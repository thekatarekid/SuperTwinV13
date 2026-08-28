// ===========================================================================
// SourceAdapter interface (docs/PHASE1_CONTRACT §7) + the pure range→cutoff
// function (§4) mirrored from the Go daemon.
//
// A SourceAdapter owns a source's connection lifecycle and emits source-neutral
// events/channels/actors/status through callbacks. The ingestion writer + API
// layer consume it. Adding a future source = a new adapter, zero DB changes.
// ===========================================================================

import type {
  Actor,
  AdapterStatus,
  Range,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "./types.js";

export interface SourceAdapter {
  /** The manifest's `source_id` — the prefix on every row and key it owns. */
  readonly sourceId: string; // "whatsapp"
  readonly sourceType: string; // "whatsapp"

  /** Spawn+supervise the daemon, restore session. */
  connect(): Promise<void>;
  /** Begin QR pairing (no-op + online if already paired). */
  startPairing(): Promise<void>;
  /** Run a range-limited backfill, then continue live streaming. */
  backfill(range: Range): Promise<void>;
  /** Widen coverage backwards to `range` (older history). */
  extend(range: Range): Promise<void>;
  /**
   * Install the import range WITHOUT starting a backfill run, so the daemon
   * filters WhatsApp's automatic post-pairing history by it (and re-installs it
   * on every daemon (re)start). Optional: only sources that receive an automatic
   * pre-import history push need it. Fresh pairs with no chosen range yet skip
   * this — their pushed history is buffered daemon-side until the user picks.
   */
  setRange?(range: Range): Promise<void>;
  /**
   * Send ONE message through the source (P0.6). Optional: only sources with a
   * send path implement it. `approvalToken` is a minted, still-unused
   * single-use token — the adapter MUST refuse (throw) without one, and the
   * daemon behind it refuses again on its own. The result arrives as a
   * `send_result` status frame, never as a return value.
   */
  sendMessage?(to: string, text: string, approvalToken: string): Promise<void>;
  /** Kill-switch: pause (true) / resume (false) event emission. */
  pause(paused: boolean): Promise<void>;
  /** Clear the session (unpair). */
  logout(): Promise<void>;
  /** Graceful shutdown (shutdown cmd + SIGTERM backstop). */
  disconnect(): Promise<void>;

  onEvent(cb: (e: SourceEvent) => void): void;
  onStream(cb: (s: Stream) => void): void;
  onActor(cb: (a: Actor) => void): void;
  onStatus(cb: (s: StatusUpdate) => void): void;

  getStatus(): AdapterStatus;
}

// ---------------------------------------------------------------------------
// Range → cutoff (contract §4). Pure + unit-tested; MUST match the Go daemon's
// `rangeCutoff(range, now) time.Time`. `all` = epoch 0 (no cutoff). The chat and
// message filters both use `ts >= cutoff`.
// ---------------------------------------------------------------------------

const MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
} as const;

const RANGE_MS: Record<Exclude<Range, "all">, number> = {
  "24h": 24 * MS.hour,
  "3d": 3 * MS.day,
  "7d": 7 * MS.day,
  "30d": 30 * MS.day,
  "90d": 90 * MS.day,
  "180d": 180 * MS.day,
  "1y": 365 * MS.day,
  "2y": 2 * 365 * MS.day,
  "3y": 3 * 365 * MS.day,
  "4y": 4 * 365 * MS.day,
  "5y": 5 * 365 * MS.day,
};

/**
 * Cutoff instant (ms since epoch) for a range relative to `now` (ms since
 * epoch). Everything with `ts >= cutoff` is in-range. `all` returns 0.
 */
export function rangeCutoffMs(range: Range, nowMs: number): number {
  if (range === "all") return 0;
  return nowMs - RANGE_MS[range];
}

/** Cutoff as an ISO-8601 UTC string (matches how event `ts` is stored). */
export function rangeCutoffIso(range: Range, nowMs: number): string {
  return new Date(rangeCutoffMs(range, nowMs)).toISOString();
}

/** True if an event/chat timestamp (ms) is within the range relative to now. */
export function inRange(tsMs: number, range: Range, nowMs: number): boolean {
  return tsMs >= rangeCutoffMs(range, nowMs);
}
