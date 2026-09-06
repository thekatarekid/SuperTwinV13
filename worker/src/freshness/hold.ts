// ===========================================================================
// [CODE] Is understanding actually running? — V6 P1 FIX-C5.
//
// THE DEFECT. freshnessDetail() printed "understanding: caught up" for every
// state that was not a breached live promise. On the reporting user's machine
// it printed exactly that at a moment when the $3/hour ceiling had latched
// (app_state.budget_tripped_at, 15:12:59Z — "$3.05 spent in the last hour"),
// every model call had been refused before spawn for the following hour, the
// S0.7 breaker had llm:understanding and llm:live paused, and 10,985 in-window
// events were sitting undispatched. The one surface that could have said "the
// twin has stopped" said the opposite, in the confident voice.
//
// A stopped pipeline is not a slow one, and it is never "caught up". This
// module is the single answer to "is anything being understood right now?",
// read from the same state the ops surfaces read:
//
//   stopped  `model_activity_paused` — the human's kill switch (S0.8). Nothing
//            is exempt, so nothing is being understood. Only the same switch
//            lifts it.
//   budget   `budget_tripped_at` — the spend latch (S0.2). It NEVER clears on
//            its own, not on the hour and not on restart; an operator resets
//            it in Settings › General. Until then every background call throws
//            BUDGET_EXCEEDED before spawn.
//   breaker  an understanding lane held by the S0.7 breaker after ten
//            consecutive failures. This one lifts itself, so the phrase says
//            when.
//
// Precedence is the order above: the human's switch outranks a ceiling, and a
// ceiling outranks a breaker (a breaker that keeps re-tripping on a latched
// budget is a symptom of the latch, which is exactly what happened live).
//
// The verdict is a pure function of (latch, switch, breakers, now) so it is
// testable against fixed clocks; `understandingHold()` is the thin reader that
// fetches those three from the budget module and the pool.
//
// Zero model calls. Two app_state reads and one in-memory map.
// ===========================================================================

import { budgetStatus } from "../providers/budget.js";
import { resourcePool, type BreakerTrip, type LaneKey } from "../providers/pool.js";

/** Why understanding is stopped. */
export type UnderstandingHoldKind = "stopped" | "budget" | "breaker";

export interface UnderstandingHold {
  kind: UnderstandingHoldKind;
  /**
   * The chip's phrase, in the same voice as the other verdicts —
   * "understanding paused — spend ceiling reached".
   */
  label: string;
  /** One line of why, ending in what lifts it. Shown in the detail row. */
  detail: string;
  /** ISO time the hold started, when we know it. */
  since: string | null;
  /**
   * Epoch ms the hold lifts on its own; null when only a human lifts it —
   * which is true of both the kill switch and the budget latch.
   */
  until_ms: number | null;
}

/**
 * The lanes that carry understanding. `llm:enrichment` is media captioning: a
 * breaker there does not stop the twin reading your events, so it must not
 * make the chip claim that it has.
 */
export const UNDERSTANDING_LANES: readonly LaneKey[] = ["llm:understanding", "llm:live"];

export interface HoldInput {
  /** ISO time the kill switch was thrown; null while model activity runs. */
  modelActivityPausedAt: string | null;
  /** ISO time the spend latch tripped; null while it has not. */
  budgetTrippedAt: string | null;
  /** The latch's own words — "$3.05 spent in the last hour (ceiling $3)". */
  budgetTrippedReason: string | null;
  /** Every breaker currently holding a lane (pool.breakers()). */
  breakers: readonly BreakerTrip[];
}

/** "12 min", "under a minute" — how long until a self-lifting hold lifts. */
export function formatUntil(ms: number): string {
  if (ms <= 0) return "any moment";
  if (ms < 60_000) return "under a minute";
  const min = Math.round(ms / 60_000);
  if (min === 1) return "a minute";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h === 1 ? "an hour" : `${h} hours`;
}

/**
 * The verdict, from the state alone. Null means understanding is running —
 * which is the ONLY case in which a surface may say "caught up".
 */
export function holdFrom(input: HoldInput, now: number = Date.now()): UnderstandingHold | null {
  if (input.modelActivityPausedAt) {
    return {
      kind: "stopped",
      label: "understanding paused — you stopped model activity",
      detail:
        `"Stop all model activity" has been on since ${input.modelActivityPausedAt}. ` +
        "Nothing is sent to a model until you turn it back on in Settings › General.",
      since: input.modelActivityPausedAt,
      until_ms: null,
    };
  }
  if (input.budgetTrippedAt) {
    const why = input.budgetTrippedReason ?? "a spend ceiling was reached";
    return {
      kind: "budget",
      label: "understanding paused — spend ceiling reached",
      detail:
        `${why}. The latch tripped at ${input.budgetTrippedAt} and does not clear on its own — ` +
        "nothing new is being understood until it is reset in Settings › General.",
      since: input.budgetTrippedAt,
      until_ms: null,
    };
  }
  const held = input.breakers
    .filter((b) => UNDERSTANDING_LANES.includes(b.lane))
    .sort((a, b) => b.untilMs - a.untilMs)[0];
  if (held) {
    const why = held.lastCode ?? held.lastError ?? "repeated failures";
    return {
      kind: "breaker",
      label: `understanding paused — provider errors, retrying in ${formatUntil(held.untilMs - now)}`,
      detail:
        `${held.lane} stopped after ${held.failures} failures in a row (${why}). ` +
        "It retries on its own; nothing is being understood in the meantime.",
      since: held.trippedAt,
      until_ms: held.untilMs,
    };
  }
  return null;
}

/** The live verdict: the budget latch, the kill switch and the pool's breakers. */
export function understandingHold(now: number = Date.now()): UnderstandingHold | null {
  const b = budgetStatus(now);
  return holdFrom(
    {
      modelActivityPausedAt: b.modelActivityPausedAt,
      budgetTrippedAt: b.trippedAt,
      budgetTrippedReason: b.trippedReason,
      breakers: resourcePool.breakers(),
    },
    now,
  );
}
