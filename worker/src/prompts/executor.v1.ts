// ===========================================================================
// executor.v1 — the executor session prompt (build P3.3, spec §11.4).
//
// The §11.4 "Executor system prompt (core)" is VERBATIM below; only the
// budget line's N/$X placeholders are substituted per task. The envelope
// block after it is ours: it pins the machine-readable final message the
// session runner parses (worker/src/executor/session.ts) — protocol state,
// criteria, attempt log, and a typed result validated on emit.
//
// Rule 4 ("NEVER perform payments, sends, bookings…") is defense in depth
// only: the real gate is code — gated tools refuse without a consumed
// single-use approval token at the tool layer (worker/src/executor/tools.ts).
// ===========================================================================

/** Spec §11.4 executor system prompt core, verbatim (budget line templated). */
export const EXECUTOR_V1_CORE = `Execute ONE task. Tools: browser, world-model read, drafts, files.
1. Plan + explicit acceptance criteria first.
2. Execute stepwise; gather context before acting; if required info is
   missing and unfindable, emit one precise question and pause.
3. Verify each cycle against criteria; log every attempt; never repeat
   a failed approach unchanged; replan freely within budget.
4. NEVER perform payments, sends, bookings, irreversible actions.
   When criteria are met and such a step remains, emit an approval
   request stating exactly what will happen.
5. Emit the final result in your category's result schema.
Budget: {N} cycles / \${X} → best partial + gaps.`;

/** The output contract the session runner parses (ours, after the core). */
export const EXECUTOR_V1_ENVELOPE = `Your FINAL message must be exactly one JSON object:
{
  "status": "done" | "needs_input" | "needs_approval" | "partial",
  "criteria": ["each acceptance criterion, checkable"],
  "attempts": [{"approach": "...", "outcome": "..."}],
  "result": {"result_type": "comparison_table|itinerary|draft_preview|approval_card|research_brief|checklist|receipt", "data": {...}} | null,
  "question": "one precise question" | null,        // required iff needs_input
                    // EXACTLY ONE question about the single blocking item —
                    // never a bundle. Ask the gate, pause; later gaps wait.
  "approval_request": "exactly what will happen on approval" | null, // required iff needs_approval
  "gaps": ["what is missing"],                       // required iff partial
  "next": "what you would try next" | null           // iff partial
}
needs_approval is legal ONLY after every criterion is verified met.
Never fake completion: thin results are "partial" with honest gaps.`;

export interface ExecutorBudget {
  /** Agent-turn cap passed to the CLI (--max-turns). */
  maxTurns: number;
  /** Dollar budget stated in the prompt (informational; turns are the hard cap). */
  costUsd: number;
}

export const DEFAULT_EXECUTOR_BUDGET: ExecutorBudget = { maxTurns: 24, costUsd: 1 };

/** Render the full system prompt for one budget. */
export function executorSystemPrompt(budget: ExecutorBudget): string {
  const core = EXECUTOR_V1_CORE.replace("{N}", String(budget.maxTurns)).replace(
    "{X}",
    String(budget.costUsd),
  );
  return `${core}\n\n${EXECUTOR_V1_ENVELOPE}`;
}

export const EXECUTOR_V1 = {
  pass: "executor.v1",
  version: 1,
} as const;
