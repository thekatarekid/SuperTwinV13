// ===========================================================================
// [CODE] STW-2 — public entry point. Arch §5.8 (failure handling), §5.9.
//
// Two invariants define this module and both are tested to death:
//
//   TOTALITY     the parser never throws — on random bytes, truncated lines,
//                `null`, `""` or `"||||||"`. A malformed line can never take
//                down a batch.
//   ACCOUNTING   accepted + violations + skipped == non-blank lines.
//                Nothing is ever silently dropped.
//
// Code must never drop, edit, censor or filter model output. Skipped lines
// keep their original text; violations quote the model verbatim so a repair
// round can re-ask exactly the failing lines and nothing else.
// ===========================================================================

import { looksLikeWireLine, parseRecordLine, serialize, type WireRecord } from "./codec.js";
import {
  classifyLine,
  createToleranceState,
  type WireSkip,
  type WireViolation,
} from "./tolerance.js";

export * from "./aliases.js";
export * from "./codec.js";
export * from "./pack.js";
export * from "./tolerance.js";

export interface WireParseCounts {
  lines: number;
  blank: number;
  nonBlankLines: number;
  /** Records that parsed. */
  accepted: number;
  /** LINE-scoped violations only — the accounting invariant's third term. */
  violations: number;
  skipped: number;
  /** The single `no_wire_lines` verdict, when the whole answer was prose. */
  responseViolations: number;
  emphasisStripped: number;
  bulletsStripped: number;
  fences: number;
  headings: number;
  markers: number;
  bullets: number;
  prose: number;
}

export interface WireParseResult {
  records: WireRecord[];
  /** Line-scoped violations first, then the response-scoped one if any. */
  violations: WireViolation[];
  skipped: WireSkip[];
  counts: WireParseCounts;
}

/**
 * §5.8.3 — when the entire answer was prose, EXACTLY ONE violation is emitted
 * for the whole response, not one per line. (A per-line rule once turned a
 * chatty model into hundreds of identical rejections.)
 */
export function noWireLinesViolation(raw: string): WireViolation {
  return {
    line: 1,
    tag: null,
    rule: "no_wire_lines",
    detail: "the whole answer was prose — no line carried a tag from the closed vocabulary",
    raw: typeof raw === "string" ? raw : "",
    scope: "response",
  };
}

/**
 * Parse a model response. Accepts anything at all: non-strings become `""`.
 */
export function parseWire(input: unknown): WireParseResult {
  const text = typeof input === "string" ? input : "";
  const state = createToleranceState();
  const records: WireRecord[] = [];
  const violations: WireViolation[] = [];
  const skipped: WireSkip[] = [];

  const lines = text.split("\n");
  let blank = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const classified = classifyLine(lines[i], i + 1, state, looksLikeWireLine);
    if (classified.kind === "blank") {
      blank += 1;
      continue;
    }
    if (classified.kind === "skip") {
      skipped.push(classified.skip);
      continue;
    }
    const outcome = parseRecordLine(classified.text, classified.line, classified.raw);
    if ("record" in outcome) records.push(outcome.record);
    else violations.push(outcome.violation);
  }

  const nonBlankLines = lines.length - blank;
  const counts: WireParseCounts = {
    lines: lines.length,
    blank,
    nonBlankLines,
    accepted: records.length,
    violations: violations.length,
    skipped: skipped.length,
    responseViolations: 0,
    emphasisStripped: state.emphasisStripped,
    bulletsStripped: state.bulletsStripped,
    fences: state.fences,
    headings: state.headings,
    markers: state.markers,
    bullets: state.bullets,
    prose: state.prose,
  };

  // Exactly one, for the whole response, and only when no line was judged.
  if (records.length === 0 && violations.length === 0) {
    violations.push(noWireLinesViolation(text));
    counts.responseViolations = 1;
  }

  return { records, violations, skipped, counts };
}

/**
 * §5.8.4 — `accepted + violations + content_skipped == non_blank_lines`, over
 * line-scoped classifications. The response-scoped `no_wire_lines` verdict is
 * a judgment on the answer, not a fourth class of line, and is counted apart.
 */
export function accountingHolds(result: WireParseResult): boolean {
  const c = result.counts;
  return c.accepted + c.violations + c.skipped === c.nonBlankLines;
}

/** Line-scoped violations — the ones a repair round can actually re-ask. */
export function lineViolations(result: WireParseResult): WireViolation[] {
  return result.violations.filter((v) => v.scope === "line");
}

/**
 * §5.8.2 — the repair prompt lists `line N — rule: detail` per rejection and
 * asks for the corrected lines ONLY. It never repeats accepted lines, so the
 * model cannot re-answer events those lines already covered.
 */
export function repairRequest(violations: readonly WireViolation[]): string {
  const lines = violations.map((v) => `line ${v.line} — ${v.rule}: ${v.detail}\n  ${v.raw}`);
  return [
    "These lines were rejected. Re-emit ONLY the corrected lines.",
    "Do not repeat accepted lines. Do not re-answer events those lines already covered.",
    "",
    ...lines,
  ].join("\n");
}

export interface RepairMerge {
  records: WireRecord[];
  violations: WireViolation[];
  rounds: number;
}

/**
 * One repair round, bounded (§5.8.2). Accepted lines from round 1 are kept and
 * merged; a second failure leaves the violations in the result rather than
 * looping. There is no third round anywhere in this system.
 */
export function mergeRepair(first: WireParseResult, second: WireParseResult): RepairMerge {
  const records = [...first.records, ...second.records];
  const repaired = second.records.length > 0;
  const carried = repaired ? [] : lineViolations(first);
  const violations = [...carried, ...lineViolations(second)];
  if (records.length === 0) {
    const response = second.violations.find((v) => v.scope === "response");
    if (response) violations.push(response);
  }
  return { records, violations, rounds: 2 };
}

/** `serialize(parse(serialize(x))) == serialize(x)` — the §5.9.1 CI gate. */
export function roundTrip(text: string): string {
  return serialize(parseWire(text).records);
}
