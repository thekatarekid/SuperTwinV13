// ===========================================================================
// Thin context (V6 P1 S3.2; Build §6.1 "Thin context. Flag set when the
// packer cannot assemble enough"; Product P1 §7.4; Product_V6 §11.3 rule 9;
// PCK-06).
//
// When a stream has no history, its sender resolves to nobody and retrieval
// finds no candidate space, the pack cannot anchor the bundle. The packer
// flags it; the policy then HOLDS the bundle one flush (its events stay
// unmarked, so the next tick re-collects them with whatever arrived since)
// and, on the second sight of the same bundle, sends it with an explicit
// insufficient-context instruction permitting only `unsorted` plus a
// question. It never permits a guess.
//
// The hold is remembered in app_state under the bundle key so two workers,
// or a restart, agree on "second sight".
// ===========================================================================

import { getDb } from "../db/connection.js";

export type ThinPolicy = "hold-once" | "instruct" | "off";

export interface ThinSignals {
  /** No prior event of the primary stream outside the bundle. */
  noHistory: boolean;
  /** No candidate space came back from retrieval. */
  noCandidates: boolean;
  /** No open or dormant episode on any stream in the pack. */
  noEpisodes: boolean;
  /** Actor refs in the bundle that resolve to no entity. */
  unresolvedSenders: string[];
  /** The bundle is too small to be its own context (≤ 2 events, < 400 chars). */
  smallBundle: boolean;
}

export interface ThinDecision {
  thin: boolean;
  reasons: string[];
}

/** Events at or below this, with text under THIN_BUNDLE_CHARS, make a bundle small. */
export const THIN_BUNDLE_EVENTS = 2;
export const THIN_BUNDLE_CHARS = 400;

/**
 * Thin when nothing anchors the bundle AND the bundle cannot anchor itself:
 * no history, no episode, no candidate space, an unresolved sender, and a
 * small bundle (Product_V6 §11.3 rule 9 names all three context signals; a
 * day bundle of hundreds of events carries its own context and is never thin).
 */
export function decideThin(s: ThinSignals): ThinDecision {
  const reasons: string[] = [];
  if (s.noHistory) reasons.push("no history on this stream");
  if (s.noEpisodes) reasons.push("no open or recent episode");
  if (s.noCandidates) reasons.push("no candidate space from retrieval");
  if (s.unresolvedSenders.length > 0) reasons.push(`unresolved sender${s.unresolvedSenders.length > 1 ? "s" : ""}: ${s.unresolvedSenders.join(", ")}`);
  if (s.smallBundle) reasons.push("small bundle");
  return { thin: s.noHistory && s.noEpisodes && s.noCandidates && s.unresolvedSenders.length > 0 && s.smallBundle, reasons };
}

export const THIN_CONTEXT_INSTRUCTION =
  "[THIN CONTEXT] insufficient context: this bundle has no thread history, no episode and no candidate space. " +
  "Do NOT guess a space, a person or an intent. Permitted output: `unsorted` entries for the events, plus at most one question " +
  "to the user naming what is missing. No episodes, no proposals, no tasks.";

const HOLD_PREFIX = "packer.thin_held:";

function holdKey(bundleKey: string): string {
  return `${HOLD_PREFIX}${bundleKey}`;
}

/**
 * Apply the hold-once policy for a thin bundle. Returns true when the bundle
 * is to be HELD this flush (first sight); false when it was already held once
 * and is now to be sent with the instruction (the mark is cleared).
 */
export function holdThinOnce(bundleKey: string, nowMs: number = Date.now()): boolean {
  const db = getDb();
  const key = holdKey(bundleKey);
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as { value: string } | undefined;
  if (row) {
    db.prepare(`DELETE FROM app_state WHERE key = ?`).run(key);
    return false;
  }
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  return true;
}

/** Forget a hold (the bundle stopped being thin, or was dispatched another way). */
export function clearThinHold(bundleKey: string): void {
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(holdKey(bundleKey));
}

/** True when this bundle has been held once already. */
export function isThinHeld(bundleKey: string): boolean {
  const row = getDb().prepare(`SELECT 1 AS x FROM app_state WHERE key = ?`).get(holdKey(bundleKey));
  return row !== undefined;
}
