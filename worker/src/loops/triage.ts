// ===========================================================================
// [CODE] Triage — the first-paint default, the three invariants, and what a
// P-TR1 answer is allowed to write to `loops.triage`. Arch §12.8, §11.5.2,
// §9.5.1. Build item 3.8.
//
// `../prompts/p-tr1.ts` builds the call and reads the answer. This file is the
// half that decides what a column ends up holding, and it exists separately
// for the same reason `done.ts` does: prompt construction and loop writing are
// two concerns, and only one of them is allowed near the state of a loop.
//
// THREE RULES, AND WHY CODE APPLIES THEM
//
//   §12.8 states three of its rules as ALWAYS/NEVER, and each is structural:
//
//     owner not self is ALWAYS cx          another person's loop is never in
//                                          YOUR tasks (evals Q-007…Q-012)
//     origin im is NEVER au                the system never acts on an
//                                          inference it made up (§11.5.2)
//     past due + no recurrence is cx       history, not a task — and the
//                                          discriminator is the NEXT
//                                          occurrence, never the age of the
//                                          message (§11.4, `state.ts`)
//
//   Applying them is not censorship (build rule 9): the model's `J` line is
//   carried byte-for-byte on both the assignment and the correction, so a run
//   where the model and the rules disagree is a thing you can read, count and
//   act on rather than a silent divergence. Nothing is edited or dropped.
//
// THE PAST-DUE RULE IS NOT RE-DERIVED HERE. It is read off `deriveLoopState`,
// because §12.8's "judge by the next occurrence" and §11.4's state function
// are the same discriminator and two copies of it would drift.
// ===========================================================================

import type { Tr1Answer, Tr1Loop, Triage } from "../prompts/p-tr1.js";
import { deriveLoopState, type LoopStateInput, type NowLike } from "./state.js";

// ---- the code default for first paint --------------------------------------

/** Why a loop carries the triage it carries before any model has spoken. */
export type Tr1DefaultReason = "owner_not_self" | "origin_implicit" | "safe_default";

export interface Tr1DefaultInput {
  /** `loops.owner_id`, or `self`. Anything that is not self is context. */
  ownerId?: string | null;
  /** explicit | implicit. */
  origin?: string | null;
}

function isSelf(ownerId: string | null | undefined): boolean {
  return typeof ownerId === "string" && ownerId.trim() === "self";
}

/**
 * Item 3.8: "Code default for first paint: non-self → `cx`, implicit → `ap`,
 * else `ap`." `au` is unreachable from code by construction — auto is a
 * judgement ("ONLY research, summarise, look up") that only the model makes,
 * and §9.5.1's safe default is never auto.
 */
export function tr1DefaultTriage(input: Tr1DefaultInput): { triage: Triage; reason: Tr1DefaultReason } {
  if (!isSelf(input.ownerId)) return { triage: "context", reason: "owner_not_self" };
  if (input.origin === "implicit") return { triage: "approval", reason: "origin_implicit" };
  return { triage: "approval", reason: "safe_default" };
}

// ---- the invariants --------------------------------------------------------

/**
 * The three rules §12.8 states as ALWAYS/NEVER. They are the product's shape,
 * not a preference: a non-self loop in your task list is evals Q-007…Q-012
 * failing, and an `au` on an implicit inference is the system acting on a
 * guess. Each one names the SYSTEM line it comes from.
 */
export type Tr1Rule = "owner_not_self" | "origin_implicit_never_auto" | "lapsed_is_history";

export const TR1_RULE_TEXT: Readonly<Record<Tr1Rule, string>> = {
  owner_not_self: "owner not self is ALWAYS cx",
  origin_implicit_never_auto: "origin im is ALWAYS ap or cx. Never au.",
  lapsed_is_history: "Past due AND no recurrence → cx. It is history.",
};

/**
 * What the rules say a loop's class must be, from [CODE] facts alone, or null
 * when they say nothing and the model's answer stands unchanged.
 *
 * The past-due rule is READ OFF `deriveLoopState` rather than re-derived here:
 * §12.8's "judge by the next occurrence, never by the age of the message" and
 * §11.4's state function are the same discriminator, and two copies of it
 * would drift. A recurring obligation that still projects a future occurrence
 * is `open`, so this returns null for it and the model's `ap` survives — which
 * is exactly the t5-vs-t6 distinction the doc's own NOTE calls out.
 */
export function tr1RuleFor(loop: Tr1Loop, now: NowLike = Date.now()): { triage: Triage; rule: Tr1Rule } | null {
  if (!isSelf(loop.ownerId)) return { triage: "context", rule: "owner_not_self" };
  const stateInput: LoopStateInput = {
    dueUtc: loop.dueUtc,
    recurrence: loop.recurrence,
    recurrenceEndsAt: loop.recurrenceEndsAt,
    origin: loop.origin,
    intent: loop.intent,
    statedAt: loop.statedAt,
    lastReinforcedAt: loop.lastReinforcedAt,
  };
  const facts = deriveLoopState(stateInput, now);
  if (facts.state === "lapsed") return { triage: "context", rule: "lapsed_is_history" };
  return null;
}

// ---- the field flip --------------------------------------------------------

/** What the loop writer applies to `loops.triage`. */
export interface Tr1Assignment {
  loopId: string;
  triage: Triage;
  /** `model` when the model's class stood; `rule` when an invariant set it. */
  source: "model" | "rule";
  /** The class the model asked for, always — even when a rule overrode it. */
  modelTriage: Triage;
  /** The invariant that produced the class, when one did. */
  rule: Tr1Rule | null;
  urgency: string | null;
  /** The model's reason and its whole line, byte-for-byte. */
  reason: string;
  raw: string;
}

/**
 * A rule that fired. The model's whole line rides along: nothing here edits or
 * discards it (build rule 9), and a run whose corrections are all one rule is
 * a prompt regression you can see rather than a silent divergence.
 */
export interface Tr1Correction {
  loopId: string;
  from: Triage;
  to: Triage;
  rule: Tr1Rule;
  /** The rule's own SYSTEM sentence. */
  ruleText: string;
  /** The model's `J` line, verbatim. */
  raw: string;
}

export interface Tr1Flip {
  assignments: Tr1Assignment[];
  /** Every rule application, in answer order. */
  corrections: Tr1Correction[];
}

/**
 * Turn an answer into `loops.triage` flips, with the three invariants applied.
 *
 * `loops` is the roster this call sent — the rule check needs the loop's own
 * owner, due and recurrence, and a verdict for a loop that is not on the
 * roster keeps the model's class untouched rather than being invented against.
 */
export function tr1Assignments(
  answer: Tr1Answer,
  loops: readonly Tr1Loop[] = [],
  now: NowLike = Date.now(),
): Tr1Flip {
  const byId = new Map(loops.map((l) => [l.loopId, l]));
  const assignments: Tr1Assignment[] = [];
  const corrections: Tr1Correction[] = [];

  for (const verdict of answer.verdicts) {
    if (verdict.loopId === null) continue;
    const loop = byId.get(verdict.loopId);
    const ruled = loop ? tr1RuleFor(loop, now) : null;
    // "origin im is ALWAYS ap or cx. Never au." — the one rule that raises
    // rather than replaces: an implicit `au` becomes `ap`, and an implicit
    // `cx` is left exactly where the model put it.
    const implicitAuto =
      ruled === null && loop?.origin === "implicit" && verdict.triage === "auto"
        ? ({ triage: "approval", rule: "origin_implicit_never_auto" } as const)
        : null;
    const applied = ruled ?? implicitAuto;

    if (applied === null || applied.triage === verdict.triage) {
      assignments.push({
        loopId: verdict.loopId,
        triage: verdict.triage,
        source: "model",
        modelTriage: verdict.triage,
        rule: null,
        urgency: verdict.urgency,
        raw: verdict.raw,
        reason: verdict.reason,
      });
      continue;
    }

    assignments.push({
      loopId: verdict.loopId,
      triage: applied.triage,
      source: "rule",
      modelTriage: verdict.triage,
      rule: applied.rule,
      urgency: verdict.urgency,
      raw: verdict.raw,
      reason: verdict.reason,
    });
    corrections.push({
      loopId: verdict.loopId,
      from: verdict.triage,
      to: applied.triage,
      rule: applied.rule,
      ruleText: TR1_RULE_TEXT[applied.rule],
      raw: verdict.raw,
    });
  }

  return { assignments, corrections };
}

// ---- the acceptance check, as code -----------------------------------------

export interface Tr1Violation {
  loopId: string;
  triage: Triage;
  rule: Tr1Rule;
}

/**
 * Item 3.8 acceptance, as a function: after `tr1Assignments`, no loop owned by
 * anyone but self may be anything other than `context`, and no implicit loop
 * may be `auto`. Returns the offenders rather than asserting, so a caller can
 * log exactly which loop broke the rule.
 */
export function tr1Violations(
  assignments: readonly Tr1Assignment[],
  loops: readonly Tr1Loop[],
  now: NowLike = Date.now(),
): Tr1Violation[] {
  const byId = new Map(loops.map((l) => [l.loopId, l]));
  const out: Tr1Violation[] = [];
  for (const a of assignments) {
    const loop = byId.get(a.loopId);
    if (!loop) continue;
    if (!isSelf(loop.ownerId) && a.triage !== "context") {
      out.push({ loopId: a.loopId, triage: a.triage, rule: "owner_not_self" });
      continue;
    }
    if (loop.origin === "implicit" && a.triage === "auto") {
      out.push({ loopId: a.loopId, triage: a.triage, rule: "origin_implicit_never_auto" });
      continue;
    }
    const ruled = tr1RuleFor(loop, now);
    if (ruled !== null && ruled.rule === "lapsed_is_history" && a.triage !== "context") {
      out.push({ loopId: a.loopId, triage: a.triage, rule: "lapsed_is_history" });
    }
  }
  return out;
}

/** Triage accuracy against a labelled fixture. Item 3.8 asks for ≥ 0.90. */
export function tr1Accuracy(
  assignments: readonly Tr1Assignment[],
  expected: ReadonlyMap<string, Triage>,
): { total: number; correct: number; accuracy: number } {
  let total = 0;
  let correct = 0;
  for (const a of assignments) {
    const want = expected.get(a.loopId);
    if (want === undefined) continue;
    total += 1;
    if (a.triage === want) correct += 1;
  }
  return { total, correct, accuracy: total === 0 ? 0 : correct / total };
}
