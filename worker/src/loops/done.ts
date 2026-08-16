// ===========================================================================
// [CODE] Done-detection — the pre-check, and what a P-DD1 answer is allowed to
// do to a loop. Arch §11.4.3, §11.4.5, §12.9. Build item 3.8.
//
// THE ONE SENTENCE
//
//   A loop is DONE or it is NOT. `possibly_done` does not exist (§11.4.3), and
//   this file is where the temptation to reintroduce it is refused: the model
//   may answer `ps`, and `ps` produces an OPEN loop plus a one-tap question
//   (evals Q-028, Q-029). Never a third bucket, never a parking lot.
//
// TWO GATES, IN ORDER
//
//   1. [CODE] PRE-CHECK (§11.4.5). Because newest data is processed first, the
//      resolving evidence for a historical loop is usually ALREADY in the DB.
//      `dd1Precheck()` runs the state function; a loop that already reads
//      done / dropped / lapsed is settled with no model call at all, and only
//      what is left is worth a P-DD1 call. Item 3.8: "most historical loops
//      resolve with no model call."
//
//   2. [CODE] EVIDENCE CHECK on the answer. §12.9: "Count only evidence
//      occurring AFTER the loop was stated." The transcript deliberately holds
//      episodes on both sides of the loop, so a `dn` citing an event that
//      predates the loop is not evidence — the loop stays open and the reason
//      says so. Likewise a `dn` that cites no event at all: §12.9's "Never
//      mark done on a guess" is enforced, not merely requested.
//
// WHAT THIS FILE NEVER DOES (build rule 9)
//
//   It never edits, paraphrases, truncates or drops a model line. Every
//   outcome carries the model's `S` line byte-for-byte in `raw`, including the
//   outcomes where the code declined to act on it. A declined finding is
//   VISIBLE, which is the difference between ordering model output and
//   censoring it.
// ===========================================================================

import type { Dd1Answer, Dd1Finding, Dd1Loop } from "../prompts/p-dd1.js";
import {
  ABOLISHED_STATES,
  deriveLoopState,
  isLoopState,
  type LoopState,
  type LoopStateInput,
  type LoopStateReason,
  type NowLike,
} from "./state.js";

// ---------------------------------------------------------------------------
// The state that does not exist
// ---------------------------------------------------------------------------

/**
 * The terminal states done-detection can produce. `possibly_done` is absent by
 * construction, and `DONE_STATES` is a subset of `LOOP_STATES` — the check
 * below is the ban made testable rather than merely intended (§11.4.3).
 */
export const DONE_OUTCOME_STATES: readonly LoopState[] = ["done", "dropped", "open"];

/**
 * True only if every state this module can emit is a real loop state and none
 * of them is an abolished one. Called by the tests; cheap enough to call from
 * a boot assertion too.
 */
export function doneStatesAreLegal(): boolean {
  return (
    DONE_OUTCOME_STATES.every((s) => isLoopState(s)) &&
    !DONE_OUTCOME_STATES.some((s) => (ABOLISHED_STATES as readonly string[]).includes(s))
  );
}

// ---------------------------------------------------------------------------
// Gate 1 — the [CODE] pre-check
// ---------------------------------------------------------------------------

/** A loop as the pre-check reads it: its state inputs plus its id. */
export interface DonePrecheckLoop extends LoopStateInput {
  id: string;
  intent?: string | null;
}

/** Why a loop did not need a model call. */
export type DoneSettledReason =
  | "resolution_evidence"
  | "user_gesture"
  | "already_terminal"
  | "lapsed";

export interface DoneSettled {
  loopId: string;
  /** The state the state function already reads. No model call was made. */
  state: LoopState;
  stateReason: LoopStateReason;
  reason: DoneSettledReason;
}

export interface DonePrecheck {
  /** Loops that resolved with zero model calls (§11.4.5). */
  settled: DoneSettled[];
  /** The loops a P-DD1 call is actually worth making for. */
  candidates: DonePrecheckLoop[];
  /** `settled / (settled + candidates)` — the saving, measured. */
  savedFraction: number;
}

/**
 * §11.4.5 — "because newer data is processed first, most historical loops
 * resolve against evidence already in the DB with no model call at all."
 *
 * A loop is settled when the state function ALREADY gives it a terminal state:
 * stored resolution evidence, a user gesture, or a past due with no live
 * recurrence. Everything else is a candidate. Nothing here asks a model
 * anything, and nothing here writes a row.
 */
export function dd1Precheck(
  loops: readonly DonePrecheckLoop[],
  now: NowLike = Date.now(),
): DonePrecheck {
  const settled: DoneSettled[] = [];
  const candidates: DonePrecheckLoop[] = [];

  for (const loop of loops) {
    const facts = deriveLoopState(loop, now);
    if (facts.state === "done" || facts.state === "dropped" || facts.state === "lapsed") {
      const reason: DoneSettledReason =
        facts.stateReason === "resolution_evidence"
          ? "resolution_evidence"
          : facts.stateReason === "user_gesture_done" || facts.stateReason === "user_gesture_dropped"
            ? "user_gesture"
            : facts.state === "lapsed"
              ? "lapsed"
              : "already_terminal";
      settled.push({
        loopId: loop.id,
        state: facts.state,
        stateReason: facts.stateReason,
        reason,
      });
      continue;
    }
    candidates.push(loop);
  }

  const total = settled.length + candidates.length;
  return { settled, candidates, savedFraction: total === 0 ? 0 : settled.length / total };
}

/** The candidate ids only — the roster a P-DD1 call is built from. */
export function dd1CandidateIds(precheck: DonePrecheck): string[] {
  return precheck.candidates.map((l) => l.id);
}

// ---------------------------------------------------------------------------
// Gate 2 — reading the answer
// ---------------------------------------------------------------------------

/** What the loop writer does with one `S` line. */
export type DoneAction =
  /** Close it: `state = done`, `resolution_evidence_event_id = <ev>`. */
  | "close_done"
  /** Close it: `state = dropped`, with the evidence that says it is moot. */
  | "close_dropped"
  /** Leave it exactly as it is. */
  | "keep_open"
  /** Leave it open AND raise a one-tap question (evals Q-029). */
  | "keep_open_ask";

/** Why the action is what it is. Every declining reason is a named one. */
export type DoneActionReason =
  | "evidence"
  | "moot"
  | "still_open"
  | "possibly_needs_confirmation"
  | "evidence_missing"
  | "evidence_unresolved"
  | "evidence_before_stated"
  | "loop_unknown";

export interface DoneOutcome {
  loopId: string;
  action: DoneAction;
  reason: DoneActionReason;
  /**
   * The state to write, or null for "do not touch the state". NEVER
   * `possibly_done`: `ps` yields `null` here and a question beside it.
   */
  state: LoopState | null;
  /** `loops.resolution_evidence_event_id`, when the action closes the loop. */
  evidenceEventId: string | null;
  /** The model's answer code — `dn` | `ps` | `dr` | `op`. */
  modelState: string;
  confidence: number | null;
  /** The model's quote, byte-for-byte. The proof a person sees. */
  quote: string;
  /** The model's `S` line, byte-for-byte (build rule 9). */
  raw: string;
}

/** A one-tap question, shaped for the `questions` table (migration 0020). */
export interface DoneQuestion {
  kind: "done_check";
  targetKind: "loop";
  targetId: string;
  /** The question text, built from the loop's own intent — never invented. */
  question: string;
  /** Two taps. A question with more than two answers is not one-tap. */
  options: readonly string[];
  /** The event the model cited, when it cited one. */
  evidenceEventId: string | null;
  /** The model's quote, verbatim — the thing the person is being asked about. */
  quote: string;
}

export interface DoneApplication {
  outcomes: DoneOutcome[];
  /** One per `ps`, and per `dn` the evidence check declined. */
  questions: DoneQuestion[];
  /** Findings whose loop was not on the roster. Reported, never applied. */
  unresolved: Dd1Finding[];
}

export interface DoneApplyOptions {
  /**
   * `events.id` → `events.ts`. The clock the "after the loop was stated" rule
   * is read against. NEVER `ingested_at` (build rule 8). An event that is not
   * in this map is simply unknown-timed, and an unknown time is not proof.
   */
  eventTimes?: ReadonlyMap<string, string>;
  /**
   * When true, a cited event with no known timestamp is treated as untimed and
   * the finding is declined. Default true — §12.9's "never mark done on a
   * guess" outranks closing one more loop.
   */
  requireTimedEvidence?: boolean;
}

function ms(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * §12.9 — "Count only evidence occurring AFTER the loop was stated."
 * Equal timestamps count as after: an episode and the loop extracted from it
 * share an instant, and a same-instant confirmation is still a confirmation.
 */
export function evidenceIsAfterStated(
  evidenceTs: string | null | undefined,
  statedAt: string | null | undefined,
): boolean {
  const ev = ms(evidenceTs);
  const said = ms(statedAt);
  if (ev === null) return false;
  if (said === null) return true;
  return ev >= said;
}

/** "Did you send Pranjali the Goa villa link?" — the loop's own words, quoted. */
export function doneQuestionText(intent: string | null | undefined): string {
  const text = typeof intent === "string" ? intent.trim() : "";
  return text === "" ? "Is this loop done?" : `Did you: ${text}?`;
}

const QUESTION_OPTIONS = ["Yes, done", "Not yet"] as const;

function question(loop: Dd1Loop, finding: Dd1Finding): DoneQuestion {
  return {
    kind: "done_check",
    targetKind: "loop",
    targetId: loop.loopId,
    question: doneQuestionText(loop.intent),
    options: QUESTION_OPTIONS,
    evidenceEventId: finding.eventId,
    quote: finding.quote,
  };
}

/**
 * Turn a P-DD1 answer into loop writes and questions.
 *
 * The four answers map like this, and the mapping is the whole point of the
 * file:
 *
 *   dn  + a resolvable event, timed AFTER the loop  → close_done
 *   dn  + anything less                             → keep_open_ask
 *   dr  + a resolvable event, timed AFTER the loop  → close_dropped
 *   dr  + anything less                             → keep_open_ask
 *   ps  (always)                                    → keep_open_ask
 *   op                                              → keep_open
 *
 * `ps` NEVER produces a state. There is no `possibly_done` to produce, and the
 * loop that a `ps` describes is an open loop with an unanswered question
 * attached — which is what a person can actually resolve in one tap.
 */
export function applyDd1Answer(
  answer: Dd1Answer,
  loops: readonly Dd1Loop[],
  options: DoneApplyOptions = {},
): DoneApplication {
  const byId = new Map(loops.map((l) => [l.loopId, l]));
  const times = options.eventTimes ?? new Map<string, string>();
  const requireTimed = options.requireTimedEvidence ?? true;
  const outcomes: DoneOutcome[] = [];
  const questions: DoneQuestion[] = [];

  const base = (finding: Dd1Finding, loopId: string) => ({
    loopId,
    modelState: finding.code,
    confidence: finding.confidence,
    quote: finding.quote,
    raw: finding.raw,
  });

  for (const finding of answer.findings) {
    if (finding.loopId === null) continue;
    const loop = byId.get(finding.loopId);
    if (!loop) {
      outcomes.push({
        ...base(finding, finding.loopId),
        action: "keep_open",
        reason: "loop_unknown",
        state: null,
        evidenceEventId: null,
      });
      continue;
    }

    if (finding.state === "still_open") {
      outcomes.push({
        ...base(finding, loop.loopId),
        action: "keep_open",
        reason: "still_open",
        state: null,
        evidenceEventId: null,
      });
      continue;
    }

    if (finding.state === "possibly") {
      // Evals Q-029. The loop stays open; the question is the product.
      outcomes.push({
        ...base(finding, loop.loopId),
        action: "keep_open_ask",
        reason: "possibly_needs_confirmation",
        state: null,
        evidenceEventId: finding.eventId,
      });
      questions.push(question(loop, finding));
      continue;
    }

    // dn or dr — both close a loop, and both need evidence that survives the
    // [CODE] check. A close that cannot be justified becomes a question.
    const decline = (reason: DoneActionReason) => {
      outcomes.push({
        ...base(finding, loop.loopId),
        action: "keep_open_ask",
        reason,
        state: null,
        evidenceEventId: finding.eventId,
      });
      questions.push(question(loop, finding));
    };

    if (finding.eventAlias.trim() === "") {
      decline("evidence_missing");
      continue;
    }
    if (finding.eventId === null) {
      decline("evidence_unresolved");
      continue;
    }
    const ts = times.get(finding.eventId) ?? null;
    if (ts === null && requireTimed) {
      decline("evidence_before_stated");
      continue;
    }
    if (ts !== null && !evidenceIsAfterStated(ts, loop.statedAt)) {
      decline("evidence_before_stated");
      continue;
    }

    outcomes.push({
      ...base(finding, loop.loopId),
      action: finding.state === "done" ? "close_done" : "close_dropped",
      reason: finding.state === "done" ? "evidence" : "moot",
      state: finding.state === "done" ? "done" : "dropped",
      evidenceEventId: finding.eventId,
    });
  }

  return { outcomes, questions, unresolved: answer.unresolved };
}

// ---------------------------------------------------------------------------
// The acceptance checks, as code
// ---------------------------------------------------------------------------

export interface DoneStateViolation {
  loopId: string;
  state: string;
  rule: "possibly_done_does_not_exist" | "not_a_loop_state";
}

/**
 * Evals Q-028 — "any loop in state possibly_done → FAIL — the state does not
 * exist". Run over the outcomes of a done-detection pass; anything that is not
 * null and not a real loop state is returned, and `possibly_done` is called
 * out by name because it is the specific failure this system was built to
 * refuse.
 */
export function doneStateViolations(
  outcomes: readonly Pick<DoneOutcome, "loopId" | "state">[],
): DoneStateViolation[] {
  const out: DoneStateViolation[] = [];
  for (const o of outcomes) {
    if (o.state === null) continue;
    const state: string = o.state;
    if ((ABOLISHED_STATES as readonly string[]).includes(state)) {
      out.push({ loopId: o.loopId, state, rule: "possibly_done_does_not_exist" });
      continue;
    }
    if (!isLoopState(state)) out.push({ loopId: o.loopId, state, rule: "not_a_loop_state" });
  }
  return out;
}

/**
 * Evals Q-029 — every `ps` leaves the loop open AND raises exactly one
 * question. Returns the loop ids where that did not happen.
 */
export function possiblyWithoutQuestion(application: DoneApplication): string[] {
  const asked = new Set(application.questions.map((q) => q.targetId));
  return application.outcomes
    .filter((o) => o.modelState === "ps")
    .filter((o) => o.state !== null || !asked.has(o.loopId))
    .map((o) => o.loopId);
}

/**
 * Done PRECISION against a labelled fixture — item 3.8 asks for ≥ 0.95. Of the
 * loops this pass CLOSED as done, how many were really done. Precision, not
 * recall: closing a live loop is the expensive error, and leaving one open is
 * the cheap one.
 */
export function donePrecision(
  application: DoneApplication,
  trulyDone: ReadonlySet<string>,
): { closed: number; correct: number; precision: number } {
  const closed = application.outcomes.filter((o) => o.action === "close_done");
  const correct = closed.filter((o) => trulyDone.has(o.loopId)).length;
  return {
    closed: closed.length,
    correct,
    precision: closed.length === 0 ? 1 : correct / closed.length,
  };
}
