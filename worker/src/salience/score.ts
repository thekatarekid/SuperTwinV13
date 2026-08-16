// ===========================================================================
// Salience score — stage ③ of the prefilter (arch §10.2), and the stage that
// writes `events.salience`.
//
// The ambient problem is arithmetic: 10⁴–10⁶ raw captures a day have to become
// 10¹–10² enrichments. Dedupe (②) removes the repeats; this stage puts a number
// on what is left so segmentation (④) and enrichment (⑤) can spend attention in
// the right order. The five signals are the ones §10.2 names: text density, app
// category, user input present, known entity present, novelty vs the last N
// minutes.
//
// WhatsApp needs none of it. Its manifest says `salience.prefilter: "none"` and
// every WhatsApp lane is a `conversation`, so this stage is a pass-through that
// writes 1.0 and consults nothing. The stage is built now because `salience` is
// a column on `events`, and adding a column to a table with a million rows in
// it — then backfilling a score for captures whose bytes are long gone — is a
// migration nobody wants. The scaffold costs one UPDATE per event today and
// saves that migration later.
//
// TWO THINGS THIS STAGE MAY NOT DO (build rules 9 and §10.2):
//
//   - It never drops an event. Every event is written, every event keeps its
//     row, and a score of 0 is still a row you can retrieve. Salience ORDERS
//     (which events an enricher reaches first) and GATES (whether an enricher
//     spends a model call on it at all). Deleting is somebody else's verb, and
//     for ambient it happens at capture time — before a row exists — not here.
//   - It never invents a low score out of ignorance. An event with no signals
//     scores 1.0, not 0. "We know nothing about this" and "this is noise" are
//     different claims, and only the second one may cost an event its place in
//     the queue.
//
// [CODE] — the blend, the write, the ordering, the gate. [ML] — the signals
// themselves (a real novelty estimate, a real entity check) arrive as numbers
// on `SalienceSignals` from whatever ambient source computes them.
// ===========================================================================

import type Database from "better-sqlite3";

import type { SaliencePrefilter, StreamKind } from "../adapters/registry.js";
import type { DedupeVerdict } from "./dedupe.js";
import type { VadVerdict } from "./vad.js";

/** What a pass-through writes. Not a magic 1 — a documented one. */
export const PASS_THROUGH_SALIENCE = 1;

/**
 * The default gate. Zero, and the comparison is `>=`, so with the gate at its
 * default NOTHING is held back — matching `enrichment.salience_gate` defaulting
 * to off. A source that wants gating raises this itself.
 */
export const DEFAULT_SALIENCE_GATE = 0;

/**
 * What a duplicate frame's score is multiplied by. Not zero: the row exists,
 * it is retrievable, and if every other signal says the frame matters it can
 * still outrank an empty one. It just stops competing for a model call.
 */
export const DUPLICATE_PENALTY = 0.1;

/**
 * §10.2 ③, one weight per named signal. They sum to 1, but that is a
 * convenience rather than a requirement: the blend renormalises over whichever
 * signals a source actually supplies, so a screen recorder with no audio and no
 * entity resolver still gets a score on the axes it can measure.
 */
export const SIGNAL_WEIGHTS = {
  text_density: 0.25,
  app_category: 0.15,
  user_input_present: 0.2,
  known_entity_present: 0.2,
  novelty: 0.2,
} as const;

export type SignalName = keyof typeof SIGNAL_WEIGHTS;

/**
 * Everything an ambient source may know about one capture. Every field is
 * optional and every one is 0..1 (booleans read as 0 or 1) — a source supplies
 * what it can measure and stays silent about the rest.
 */
export interface SalienceSignals {
  /** Printable text per capture, normalised. A blank desktop is ~0. */
  text_density?: number;
  /** How much this app's category tends to matter. A password prompt is ~0. */
  app_category?: number;
  /** Did the user type, click or speak during this capture? */
  user_input_present?: boolean;
  /** Does a known entity (person, org, place) appear in it? */
  known_entity_present?: boolean;
  /** Novelty vs the last N minutes. 0 is "we have been staring at this". */
  novelty?: number;
  /** Verdict from stage ② — a repeat is penalised, never removed. */
  dedupe?: Pick<DedupeVerdict, "duplicate">;
  /** Verdict from stage ① — silence scores low, but silence is rarely stored. */
  vad?: Pick<VadVerdict, "speech" | "speech_ratio">;
}

export interface SalienceInput {
  event_id: string;
  /** The lane's shape (§2.1). `conversation` is always a pass-through. */
  stream_kind: StreamKind;
  /** The source manifest's `salience.prefilter`. `"none"` is a pass-through. */
  prefilter: SaliencePrefilter;
  signals?: SalienceSignals;
}

export interface SalienceVerdict {
  event_id: string;
  /** 0..1, always finite, never null. */
  salience: number;
  /** True when the stage skipped scoring entirely. */
  pass_through: boolean;
  /** Why the score is what it is — for the debug pane, never for the model. */
  reasons: readonly string[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Read one weighted signal, or null when the source did not supply it. */
function readSignal(signals: SalienceSignals, name: SignalName): number | null {
  const raw = signals[name];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return clamp01(raw);
}

/**
 * Whether this lane skips scoring. A `conversation` is a pass-through whatever
 * the manifest says — a human wrote every event in it, which is the strongest
 * salience signal there is — and `prefilter: "none"` is a pass-through whatever
 * the lane's shape is, because the source has declared it has no noise problem.
 */
export function isPassThrough(stream_kind: StreamKind, prefilter: SaliencePrefilter): boolean {
  return stream_kind === "conversation" || prefilter === "none";
}

/**
 * Score one event. Pure — no DB, no clock, no I/O — so an ambient source can
 * call it at capture time before anything has been written.
 */
export function scoreEvent(input: SalienceInput): SalienceVerdict {
  if (isPassThrough(input.stream_kind, input.prefilter)) {
    const why =
      input.stream_kind === "conversation"
        ? "pass-through: conversation stream"
        : `pass-through: prefilter "${input.prefilter}"`;
    return {
      event_id: input.event_id,
      salience: PASS_THROUGH_SALIENCE,
      pass_through: true,
      reasons: [why],
    };
  }

  const signals = input.signals ?? {};
  const reasons: string[] = [];

  let weighted = 0;
  let weight = 0;
  for (const name of Object.keys(SIGNAL_WEIGHTS) as SignalName[]) {
    const value = readSignal(signals, name);
    if (value === null) continue;
    const w = SIGNAL_WEIGHTS[name];
    weighted += value * w;
    weight += w;
    reasons.push(`${name}=${value.toFixed(2)}`);
  }

  // No measurable signal is not evidence of noise. Score it high and let the
  // enricher decide; the alternative silently buries events we never looked at.
  let salience = weight > 0 ? weighted / weight : PASS_THROUGH_SALIENCE;
  if (weight === 0) reasons.push("no signals supplied");

  if (signals.vad && !signals.vad.speech) {
    salience = 0;
    reasons.push("vad=silent");
  } else if (signals.vad) {
    const ratio = clamp01(signals.vad.speech_ratio);
    salience *= ratio;
    reasons.push(`vad_speech_ratio=${ratio.toFixed(2)}`);
  }

  if (signals.dedupe?.duplicate) {
    salience *= DUPLICATE_PENALTY;
    reasons.push("duplicate");
  }

  return {
    event_id: input.event_id,
    salience: clamp01(salience),
    pass_through: false,
    reasons,
  };
}

export function scoreEvents(inputs: readonly SalienceInput[]): SalienceVerdict[] {
  return inputs.map(scoreEvent);
}

// ---- Persistence ----------------------------------------------------------

/**
 * Write `events.salience`. One statement, one transaction, no other column
 * touched — the stage's entire footprint on the row.
 *
 * Returns how many rows actually changed, which is how a caller notices it was
 * handed an id that no longer exists (a revoked event, a reset stream) without
 * that being an error.
 */
export function writeSalience(
  db: Database.Database,
  verdicts: readonly SalienceVerdict[],
): number {
  if (verdicts.length === 0) return 0;
  const update = db.prepare(`UPDATE events SET salience = @salience WHERE id = @id`);
  const run = db.transaction((rows: readonly SalienceVerdict[]) => {
    let changed = 0;
    for (const v of rows) {
      changed += update.run({ id: v.event_id, salience: clamp01(v.salience) }).changes;
    }
    return changed;
  });
  return run(verdicts);
}

export interface SalienceStageResult {
  verdicts: readonly SalienceVerdict[];
  /** Rows whose `salience` column changed. */
  written: number;
}

/**
 * The stage itself: score, then persist. Every event that goes in comes out —
 * `verdicts.length === inputs.length` is an invariant, not a coincidence.
 */
export function runSalienceStage(
  db: Database.Database,
  inputs: readonly SalienceInput[],
): SalienceStageResult {
  const verdicts = scoreEvents(inputs);
  return { verdicts, written: writeSalience(db, verdicts) };
}

// ---- Ordering and gating --------------------------------------------------

/**
 * Highest salience first, stable on ties. Stability is what keeps a
 * pass-through source in chronological order: every WhatsApp event scores 1.0,
 * so ties are the normal case and reordering them would silently shuffle a
 * conversation.
 */
export function orderBySalience<T extends { salience: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.salience - a.item.salience || a.index - b.index)
    .map((entry) => entry.item);
}

/** `>=`, so a gate of 0 admits a score of 0 and "off" really means off. */
export function passesGate(salience: number, threshold: number = DEFAULT_SALIENCE_GATE): boolean {
  return clamp01(salience) >= threshold;
}

export interface SalienceGateResult<T> {
  /** Above the gate, already in the order an enricher should work them. */
  admitted: T[];
  /**
   * Below the gate. NOT discarded — these rows exist and are retrievable; they
   * are only denied an enrichment call for now. Raising or lowering the gate
   * later re-partitions the same set.
   */
  deferred: T[];
}

/**
 * Partition by the gate. `admitted.length + deferred.length` always equals the
 * input length: this function loses nothing, it only decides what gets looked
 * at first and what waits.
 */
export function gateForEnrichment<T extends { salience: number }>(
  items: readonly T[],
  threshold: number = DEFAULT_SALIENCE_GATE,
): SalienceGateResult<T> {
  const admitted: T[] = [];
  const deferred: T[] = [];
  for (const item of orderBySalience(items)) {
    if (passesGate(item.salience, threshold)) admitted.push(item);
    else deferred.push(item);
  }
  return { admitted, deferred };
}
