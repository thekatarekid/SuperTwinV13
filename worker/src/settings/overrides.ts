// ===========================================================================
// [CODE] Step overrides for a CANDIDATE configuration (V6 P1 S5.6, SET-02).
//
// The golden gate runs the eval CLI in a child process against a throwaway
// eval home, so the candidate model / reasoning level for one step cannot
// travel through app_state — it travels through one env var:
//
//   SUPERTWIN_STEP_OVERRIDES = {"decide":{"model":"sonnet","thinking":"high"}}
//
// `modelForPass` and `storedThinkingForPass` consult this BEFORE app_state.
// Unset (every production boot, every unit test) it costs one env read and
// answers null. A pass id with a version suffix (`critic.v5`) matches an
// override keyed on its stem (`critic`), the way Settings keys its steps.
// ===========================================================================

export const STEP_OVERRIDES_ENV = "SUPERTWIN_STEP_OVERRIDES";

export interface StepOverride {
  model?: string;
  thinking?: string;
}

export type StepOverrides = Record<string, StepOverride>;

let cache: { raw: string | undefined; parsed: StepOverrides } | null = null;

/** Parse the env var once per distinct value; malformed JSON reads as no overrides. */
export function readStepOverrides(env: NodeJS.ProcessEnv = process.env): StepOverrides {
  const raw = env[STEP_OVERRIDES_ENV];
  if (cache && cache.raw === raw) return cache.parsed;
  let parsed: StepOverrides = {};
  if (raw && raw.trim() !== "") {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, o] of Object.entries(v as Record<string, unknown>)) {
          if (!o || typeof o !== "object") continue;
          const { model, thinking } = o as Record<string, unknown>;
          const entry: StepOverride = {};
          if (typeof model === "string" && model.trim() !== "") entry.model = model.trim();
          if (typeof thinking === "string" && thinking.trim() !== "") entry.thinking = thinking.trim();
          parsed[k] = entry;
        }
      }
    } catch {
      parsed = {};
    }
  }
  cache = { raw, parsed };
  return parsed;
}

/** The override for a pass — exact id first, then its stem (`orient.v7` → `orient`). */
export function stepOverride(pass: string, env: NodeJS.ProcessEnv = process.env): StepOverride | null {
  const all = readStepOverrides(env);
  if (all[pass]) return all[pass]!;
  const stem = pass.split(".")[0]!;
  return all[stem] ?? null;
}

/** Serialise a candidate for the child process. */
export function encodeStepOverrides(overrides: StepOverrides): string {
  return JSON.stringify(overrides);
}
