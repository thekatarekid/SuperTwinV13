// ===========================================================================
// [CODE] The one repair round — arch §5.8.1–§5.8.4.
//
// A model that fumbles two lines out of forty has not failed; it has fumbled
// two lines. This module builds the re-ask for exactly those lines and merges
// what comes back with what was already accepted.
//
// The rules, all of them load-bearing:
//
//  1. ONE ROUND. `MAX_REPAIR_ROUNDS = 1`. A second failure leaves the
//     violations in the result and the unit is quarantined; it never loops.
//  2. ONLY THE FAILING LINES. The ask lists `line N — rule: detail` and quotes
//     the model's ORIGINAL text (§5.8.1), then instructs: re-emit only the
//     corrected lines, do not repeat accepted lines, do not re-answer events
//     those lines already covered.
//  3. ACCEPTED LINES ARE KEPT. Round-1 records survive into the merge
//     untouched. The repair adds; it never replaces.
//  4. `no_wire_lines` IS ONE ASK. When the whole answer was prose there is
//     exactly one violation for the response (§5.8.3), so the repair asks for
//     the whole answer again rather than emitting one ask per line.
//
// This code never edits, censors or filters model output. Violations carry the
// model's bytes verbatim; skipped lines from BOTH rounds are carried through;
// both raw responses are handed back to the caller intact. What the model said
// is preserved even when it is wrong — especially when it is wrong.
// ===========================================================================

import { lineViolations, type WireParseResult } from "../wire/index.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireSkip, WireViolation } from "../wire/tolerance.js";

/** §5.8.2. One. There is no third round anywhere in this system. */
export const MAX_REPAIR_ROUNDS = 1;

// ---------------------------------------------------------------------------
// Building the ask
// ---------------------------------------------------------------------------

export interface RepairAsk {
  /** true when there is something to re-ask at all. */
  needed: boolean;
  /** The violations this round covers, line-ascending and deduped by line. */
  violations: WireViolation[];
  /** §5.8.3 — the whole answer was prose, so this is one ask, not N. */
  wholeAnswer: boolean;
  /** The block appended to the user turn. `""` when nothing is being asked. */
  message: string;
}

const HEADER = [
  "REPAIR — some lines were rejected by the parser.",
  "Re-emit ONLY the corrected lines, one wire record per line.",
  "Do not repeat the lines that were accepted.",
  "Do not re-answer the events those accepted lines already covered.",
  "Do not apologise or explain: wire lines only.",
].join("\n");

const WHOLE_ANSWER = [
  "REPAIR — none of your answer was in the wire format: no line began with a",
  "tag from the vocabulary above, so nothing could be read.",
  "Re-emit the WHOLE answer as wire lines, one record per line, no prose.",
].join("\n");

/** `line N — rule: detail`, then the model's own line under it (§5.8.2). */
export function formatViolation(v: WireViolation): string {
  return `line ${v.line} — ${v.rule}: ${v.detail}\n    ${v.raw}`;
}

/**
 * Sort by line, keep one ask per line. Two violations on the same line would
 * otherwise ask the model twice for one correction, and it would answer twice.
 */
export function askableViolations(first: WireParseResult): WireViolation[] {
  const byLine = new Map<number, WireViolation>();
  for (const v of lineViolations(first)) if (!byLine.has(v.line)) byLine.set(v.line, v);
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Build the repair ask for a round-1 parse. Never throws. */
export function buildRepairAsk(first: WireParseResult): RepairAsk {
  const response = first.violations.find((v) => v.scope === "response");
  if (response && first.records.length === 0) {
    return {
      needed: true,
      violations: [response],
      wholeAnswer: true,
      message: `${WHOLE_ANSWER}\n\nYOUR ANSWER WAS:\n${response.raw}`,
    };
  }
  const violations = askableViolations(first);
  if (violations.length === 0) {
    return { needed: false, violations: [], wholeAnswer: false, message: "" };
  }
  const listed = violations.map(formatViolation).join("\n");
  const n = violations.length;
  return {
    needed: true,
    violations,
    wholeAnswer: false,
    message: `${HEADER}\n\n${n === 1 ? "1 line was" : `${n} lines were`} rejected:\n\n${listed}`,
  };
}

// ---------------------------------------------------------------------------
// Merging the round
// ---------------------------------------------------------------------------

/**
 * How much of the ask came back. The model was told NOT to echo line numbers,
 * so a re-emitted record cannot be paired to the violation it answers. Coverage
 * is therefore counted, not matched, and `pairingCertain` says so out loud: on
 * a short answer we know HOW MANY asks went unanswered but not WHICH, and we
 * carry the originals rather than guess which two of three were fixed.
 */
export interface RepairCoverage {
  asked: number;
  /** Records plus violations the repair round produced — lines that came back. */
  answered: number;
  unanswered: number;
  pairingCertain: boolean;
}

export interface RepairOutcome {
  /** Round-1 accepted records first, then the repair's. Nothing is dropped. */
  records: WireRecord[];
  /** What is still wrong after the bounded round. Empty means clean. */
  violations: WireViolation[];
  /** Content-skipped lines from both rounds, original text intact (§5.7). */
  skipped: WireSkip[];
  /** 1 when no repair was needed, 2 when one ran. Never more. */
  rounds: number;
  coverage: RepairCoverage;
  /** §5.8.2 — a second failure is quarantined, not retried. */
  quarantine: boolean;
}

/** The no-repair-needed outcome for a clean round 1. */
export function singleRound(first: WireParseResult): RepairOutcome {
  const violations = [...first.violations];
  return {
    records: [...first.records],
    violations,
    skipped: [...first.skipped],
    rounds: 1,
    coverage: { asked: 0, answered: 0, unanswered: 0, pairingCertain: true },
    quarantine: violations.length > 0,
  };
}

/**
 * Merge the repair round into round 1 (§5.8.2). Accepted round-1 records are
 * preserved; the repair's records are appended; whatever is still broken stays
 * in `violations` and the caller quarantines rather than asking a third time.
 */
export function mergeRepairRound(
  first: WireParseResult,
  second: WireParseResult,
  ask: RepairAsk,
): RepairOutcome {
  const records = [...first.records, ...second.records];
  const secondLine = lineViolations(second);
  const answered = second.records.length + secondLine.length;
  const asked = ask.violations.length;
  const unanswered = Math.max(0, asked - answered);

  // Still-broken: the re-emitted lines that failed again, plus — when the model
  // answered fewer lines than we asked about — the originals it left alone.
  const violations: WireViolation[] = [...secondLine];
  if (unanswered > 0) {
    if (ask.wholeAnswer) violations.push(...ask.violations);
    else violations.push(...ask.violations.slice(Math.min(asked, answered)));
  }
  // The whole repair came back as prose: keep the response-scoped verdict so
  // the caller can see that the second answer was unreadable too, not empty.
  if (second.records.length === 0 && secondLine.length === 0) {
    const response = second.violations.find((v) => v.scope === "response");
    if (response) violations.push(response);
  }

  return {
    records,
    violations,
    skipped: [...first.skipped, ...second.skipped],
    rounds: 1 + MAX_REPAIR_ROUNDS,
    coverage: {
      asked,
      answered,
      unanswered,
      pairingCertain: unanswered === 0,
    },
    quarantine: violations.length > 0,
  };
}

/** One line per surviving violation — what the quarantine row records. */
export function violationSummary(violations: readonly WireViolation[]): string {
  return violations.map((v) => `line ${v.line} — ${v.rule}: ${v.detail}`).join("\n");
}
