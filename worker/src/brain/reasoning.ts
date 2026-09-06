// ===========================================================================
// The per-step reasoning level (defect 6b).
//
// Settings now carries TWO dials per V13 step: which model runs it, and how
// hard that model thinks. This module is the one place that reads the second
// one and turns it into something the adapter can act on, because the two
// levers are not the same lever:
//
//   - the newer models take a NAMED effort level (`claude --effort high`);
//   - the older ones take a token budget (MAX_THINKING_TOKENS, arch §4.3);
//   - some models take neither, and offering a dial for those would be a lie.
//
// Which of the three a given model is comes from the catalogue read out of the
// CLI itself (providers/claude-local/discovery.ts) — never from a list of
// model names written down here.
//
// THE DEFAULT IS "off", AND "off" COSTS NOTHING. A step nobody has touched
// resolves before the catalogue is even consulted, and produces exactly the
// flags the build has always sent: no `--effort`, and plain completion's
// MAX_THINKING_TOKENS=0. Escalation is opt-in, per step, and reversible.
// ===========================================================================

import { getDb } from "../db/connection.js";
import {
  discoverClaudeModels,
  type ClaudeModelInfo,
} from "../providers/claude-local/discovery.js";
import type { ThinkingBudget } from "../providers/types.js";
import { stepOverride } from "../settings/overrides.js";

/** app_state key holding one step's reasoning level. */
export function thinkingKeyFor(pass: string): string {
  return `selected_thinking_${pass}`;
}

/** Every step ships with its reasoning dial off — see the header. */
export const DEFAULT_STEP_THINKING: ThinkingBudget = "off";

const LEVELS: readonly ThinkingBudget[] = ["off", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(v: unknown): v is ThinkingBudget {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** The stored level for a step, or "off". Never throws — no DB is "off". */
export function storedThinkingForPass(pass: string): ThinkingBudget {
  // A candidate under the golden gate (settings/overrides.ts, SET-02) wins.
  const override = stepOverride(pass)?.thinking;
  if (isThinkingLevel(override)) return override;
  try {
    const stmt = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`);
    // Exact pass id first, then its stem — Settings keys steps on the stem.
    for (const key of [pass, pass.split(".")[0]!]) {
      const row = stmt.get(thinkingKeyFor(key)) as { value: string } | undefined;
      const v = row?.value?.trim();
      if (isThinkingLevel(v)) return v;
    }
    return DEFAULT_STEP_THINKING;
  } catch {
    return DEFAULT_STEP_THINKING;
  }
}

/** The catalogue row for a model id (a version or an alias), or null. */
export function modelInfo(model: string): ClaudeModelInfo | null {
  if (!model) return null;
  return discoverClaudeModels().models.find((m) => m.id === model) ?? null;
}

/** What one step's reasoning setting means for `provider.send`. */
export interface ReasoningOptions {
  thinkingBudget?: ThinkingBudget;
  effort?: Exclude<ThinkingBudget, "off">;
}

/**
 * Resolve a step's reasoning level against the model that will run it.
 *
 * A level the model does not offer is DROPPED rather than passed on — a
 * setting left behind by a model swap must not turn into a flag the CLI
 * rejects. `{}` means "send what this build has always sent".
 */
export function reasoningForPass(pass: string, model: string): ReasoningOptions {
  const level = storedThinkingForPass(pass);
  // The overwhelmingly common case, and the one that must stay free: nothing
  // to resolve, nothing to look up, no catalogue read.
  if (level === "off") return {};
  const info = modelInfo(model);
  if (!info || !info.thinkingLevels.includes(level)) return {};
  // Both are set for an effort model on purpose: `--effort` names the level,
  // and the budget stops plain completion from pinning the ceiling to zero
  // underneath it.
  return info.effort
    ? { thinkingBudget: level, effort: level as Exclude<ThinkingBudget, "off"> }
    : { thinkingBudget: level };
}
