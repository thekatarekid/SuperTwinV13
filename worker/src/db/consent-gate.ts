// ===========================================================================
// The consent gate — V6 P1 S1.2 (Build §4.1, backlog T4-1/T4-2).
//
// One predicate at the two single-writer funnels (db/eventlog.appendEvents and
// db/ingest.insertEvent), so every adapter — and every adapter that has not
// been written yet — inherits it for free:
//
//   admitCapture(source, ts, capturedAt, origin)
//     1. CONSENT   no live 'connected' consent row for the source → the event is
//                  dropped at the funnel. Not stored-and-hidden: dropped. A
//                  fresh install with no consent rows writes nothing (CNS-01).
//     2. INDEX     ts before the INDEX floor (`index_from`, when `index_all` is
//                  off) → dropped. Index is "what we keep"; outside it we keep
//                  nothing.
//     3. UNDERSTAND (the tier predicate) ts before the UNDERSTAND floor
//                  (`understand_from`; NULL = nothing is understood) → the row
//                  is written with origin='archive' and dispatched_at =
//                  capture_ts. The dispatcher, the orphan scan and the bundle
//                  builders all select `dispatched_at IS NULL`, so an archive
//                  row is invisible to every model path BY CONSTRUCTION — not
//                  by a filter someone can forget (CNS-02). Bridges do not run
//                  on it either (T4-2); the funnels skip archive ids.
//
// Every admitted row also gets its layer-1 `archive` row (db/v6core.ts
// writeArchive — narrow, zlib text, raw payload) inside the same transaction:
// "everything consented to is indexed" means every event is in the archive,
// understood or not.
//
// Widening UNDERSTAND later is a REPLAY, never a re-import (CNS-04):
//
//   setUnderstandWindow(source, from)
//     validates through db/v6core.setConsentWindows (Understand can never
//     reach further back than Index — ConsentWindowError, nothing written;
//     CNS-03), records the new floor, then flips the archive rows that fell
//     inside it:  UPDATE events SET dispatched_at = NULL, origin = 'backfill'
//                 WHERE source_id = ? AND origin = 'archive' AND ts >= ?
//     in chunks (REPLAY_CHUNK rows, newest first). The consent row is written
//     FIRST and the predicate is on the row's own state, so a kill between
//     chunks loses nothing: `resumeReplay(source)` — or the next widening —
//     picks up exactly the rows still marked archive. No adapter is touched,
//     no row is inserted, content hashes do not change.
//     Shortening is the other direction and touches no row: what was already
//     understood stays (Product_V6_Phase1 D4 — CNS-08 is S1.7's).
//
// GATE MODE. The predicate is enforced in production unconditionally. The
// worker's unit suite predates consent — some thirty suites write events with
// no consent row to test things that are not consent — so vitest opens the
// gate for the whole suite in `worker/src/test-setup.ts` (vitest.config.ts
// setupFiles), and the consent suites (CNS-*) switch it back to "enforce" in
// their own beforeEach. The eval harness does the same in
// registerProductExecutors(): fixtures measure passes, not the funnel. There
// is no environment variable and no app_state key that opens the gate: the
// only way is this module's setter, from test or harness code.
//
// Zero model calls; SQLite only.
// ===========================================================================

import { getDb } from "./connection.js";
import type { EventOrigin } from "./eventlog.js";
import {
  type ConsentRow,
  getConsent,
  setConsentWindows,
} from "./v6core.js";

// ---- Gate mode (test / harness seam) --------------------------------------

export type ConsentGateMode = "enforce" | "open";

let gateMode: ConsentGateMode = "enforce";

/**
 * Switch the gate. Returns the previous mode so a test can restore it.
 * "open" admits every event exactly as the pre-consent funnels did (requested
 * origin kept, no consent_id stamped) — the legacy suites' contract.
 */
export function setConsentGateMode(mode: ConsentGateMode): ConsentGateMode {
  if (mode !== "enforce" && mode !== "open") {
    throw new Error(`unknown consent gate mode: ${String(mode)}`);
  }
  const prev = gateMode;
  gateMode = mode;
  return prev;
}

export function consentGateMode(): ConsentGateMode {
  return gateMode;
}

// ---- Admission -------------------------------------------------------------

/** Why the funnel dropped an event. */
export type CaptureRefusal =
  | "no-consent" // no live consent row for the source
  | "paused"
  | "disconnected"
  | "revoked"
  | "outside-index"; // ts before the INDEX floor

export type Admission =
  | {
      admitted: true;
      /** The origin to write: the requested one, or 'archive' outside UNDERSTAND. */
      origin: EventOrigin;
      /** capture_ts for an archive row (never dispatched); null = awaiting dispatch. */
      dispatchedAt: string | null;
      /** consents.id that admitted the row (null in "open" mode). */
      consentId: string | null;
      /** 'understand' → goes to the model; 'archive' → kept and searchable only. */
      tier: "understand" | "archive";
    }
  | { admitted: false; reason: CaptureRefusal };

function parseTs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The gate predicate. Pure over (consent row, ts): no writes, one indexed read.
 * `ts` is when it was said (the envelope's ts); `capturedAt` when we saw it.
 */
export function admitCapture(
  source: string,
  ts: string,
  capturedAt: string,
  requestedOrigin: EventOrigin,
): Admission {
  if (gateMode === "open") {
    return {
      admitted: true,
      origin: requestedOrigin,
      dispatchedAt: requestedOrigin === "archive" ? capturedAt : null,
      consentId: null,
      tier: requestedOrigin === "archive" ? "archive" : "understand",
    };
  }
  const consent = getConsent(source);
  if (!consent) return { admitted: false, reason: "no-consent" };
  if (consent.state !== "connected") {
    return { admitted: false, reason: consent.state as CaptureRefusal };
  }
  return admitUnder(consent, ts, capturedAt, requestedOrigin);
}

/** The window half of the predicate, over a consent row already in hand. */
export function admitUnder(
  consent: ConsentRow,
  ts: string,
  capturedAt: string,
  requestedOrigin: EventOrigin,
): Admission {
  const tsMs = parseTs(ts);
  if (!consent.indexAll && consent.indexFrom !== null && tsMs < parseTs(consent.indexFrom)) {
    return { admitted: false, reason: "outside-index" };
  }
  const understood =
    requestedOrigin !== "archive" &&
    consent.understandFrom !== null &&
    tsMs >= parseTs(consent.understandFrom);
  if (understood) {
    return {
      admitted: true,
      origin: requestedOrigin,
      dispatchedAt: null,
      consentId: consent.id,
      tier: "understand",
    };
  }
  return {
    admitted: true,
    origin: "archive",
    dispatchedAt: capturedAt,
    consentId: consent.id,
    tier: "archive",
  };
}

// ---- Widening = replay ------------------------------------------------------

/** Rows flipped per UPDATE. Small enough that a kill mid-replay loses seconds. */
export const REPLAY_CHUNK = 5_000;

export interface ReplayResult {
  /** Rows flipped archive → backfill (dispatched_at cleared) by this call. */
  replayed: number;
  /** Rows still marked archive inside the UNDERSTAND window after this call. */
  pending: number;
  chunks: number;
}

/** Archive rows of the source that now fall inside its UNDERSTAND window. */
export function pendingReplayCount(source: string): number {
  const consent = getConsent(source);
  if (!consent || consent.understandFrom === null) return 0;
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE source_id = ? AND origin = 'archive' AND ts >= ?`,
    )
    .get(source, consent.understandFrom) as { n: number };
  return r.n;
}

/**
 * Flip archive rows inside the source's UNDERSTAND window back onto the
 * dispatch path, `chunk` rows per statement, newest first. Idempotent and
 * resumable: the predicate is the row's own origin, so rows already flipped
 * are never touched again and a call after a kill continues where the last
 * chunk committed. `maxChunks` exists so a test can stop mid-replay and
 * prove the resume; production callers leave it unset.
 */
export function replayArchive(
  source: string,
  opts: { chunk?: number; maxChunks?: number } = {},
): ReplayResult {
  const chunk = Math.max(1, Math.floor(opts.chunk ?? REPLAY_CHUNK));
  const maxChunks = opts.maxChunks ?? Number.POSITIVE_INFINITY;
  const consent = getConsent(source);
  if (!consent || consent.understandFrom === null) {
    return { replayed: 0, pending: 0, chunks: 0 };
  }
  const flip = getDb().prepare(
    `UPDATE events
        SET dispatched_at = NULL, origin = 'backfill', is_historical = 1
      WHERE rowid IN (
        SELECT rowid FROM events
         WHERE source_id = ? AND origin = 'archive' AND ts >= ?
         ORDER BY ts DESC
         LIMIT ?)`,
  );
  let replayed = 0;
  let chunks = 0;
  while (chunks < maxChunks) {
    const n = flip.run(source, consent.understandFrom, chunk).changes;
    if (n === 0) break;
    replayed += n;
    chunks++;
    if (n < chunk) break;
  }
  return { replayed, pending: pendingReplayCount(source), chunks };
}

/** Continue a replay a kill interrupted. Same as replayArchive(source). */
export function resumeReplay(source: string): ReplayResult {
  return replayArchive(source);
}

export interface WindowChange {
  consent: ConsentRow;
  /** 'widened' replays; 'shortened' and 'unchanged' touch no row. */
  direction: "widened" | "shortened" | "unchanged";
  replay: ReplayResult;
}

/**
 * Set the source's UNDERSTAND floor. Validation (Understand ≤ Index, CNS-03)
 * happens in setConsentWindows and throws ConsentWindowError before anything
 * is written. Widening replays the archive rows that fell inside the window
 * (CNS-04); shortening leaves every row as it is (D4). `from = null` means
 * nothing is understood from now on — also a shortening.
 */
export function setUnderstandWindow(source: string, from: string | null): WindowChange {
  const before = getConsent(source);
  if (!before) throw new Error(`no live consent for source ${source}`);
  const consent = setConsentWindows(source, { understandFrom: from })!;
  let direction: WindowChange["direction"];
  if (from === null) {
    direction = before.understandFrom === null ? "unchanged" : "shortened";
  } else if (before.understandFrom === null || parseTs(from) < parseTs(before.understandFrom)) {
    direction = "widened";
  } else if (parseTs(from) > parseTs(before.understandFrom)) {
    direction = "shortened";
  } else {
    direction = "unchanged";
  }
  const replay =
    direction === "widened" ? replayArchive(source) : { replayed: 0, pending: 0, chunks: 0 };
  return { consent, direction, replay };
}
