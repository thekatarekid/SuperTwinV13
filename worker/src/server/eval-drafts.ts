// ===========================================================================
// [CODE] Auto-drafted golden eval cases — build P1.7 (spec §14.4.5, §18.3).
//
// Every correction — typed, dragged, or chip-tapped — drafts a golden eval
// case with the original context. Drafts are FILES, not suite members: the
// promotion loop is correction → auto-drafted fixture → human confirm →
// suite (spec §18.3). They land in $SUPERTWIN_HOME/eval-drafts/ (overridable
// for tests via SUPERTWIN_EVAL_DRAFTS_DIR) in the evals/v13 fixture shape,
// plus a `status: "draft"` marker so nothing mistakes them for the suite.
// ===========================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EvalDraftInput {
  correctionId: string;
  target: { kind: string; id: string };
  /** What the user said or did (the utterance, or a description of the drag/chip). */
  instruction: string;
  /** The structured correction that was applied (or null when parse failed). */
  structured: unknown;
  /** Object state before the correction — the original context. */
  before: unknown;
  /** Object state after. */
  after: unknown;
}

/** Where drafts go. Env override first so tests never touch the real home. */
export function evalDraftsDir(): string {
  const override = process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  if (override && override.trim().length > 0) return override;
  const home = process.env.SUPERTWIN_HOME?.trim() || join(homedir(), "SuperTwinV13");
  return join(home, "eval-drafts");
}

/**
 * Write one draft fixture. Returns its absolute path. Best-effort caller-side:
 * this throws on IO failure so the route can report it — a correction whose
 * draft was lost silently would break promotion_loop_integrity unseen.
 */
export function writeEvalDraft(input: EvalDraftInput): string {
  const dir = evalDraftsDir();
  mkdirSync(dir, { recursive: true });
  const id = `DRAFT-${input.correctionId}`;
  const fixture = {
    id,
    category: "FIX",
    status: "draft", // human confirm promotes it into the suite (§18.3)
    title: `correction on ${input.target.kind} ${input.target.id}`,
    pass: "feedback",
    mode: "live",
    setup: { target: input.target, before: input.before },
    input_events: [input.instruction],
    expected: { structured: input.structured, after: input.after },
    drafted_at: new Date().toISOString(),
    source: { doc: "auto", section: "spec §14.4.5 corrections pipeline" },
  };
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return path;
}
