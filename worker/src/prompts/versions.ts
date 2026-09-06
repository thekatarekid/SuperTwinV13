// ===========================================================================
// Prompt version selection — Orient and Critic (V6 Phase 1, S3.5).
//
// Build §2.1: "orient.v6 and critic.v4 stay as the frozen baseline until the
// S4 gate". v7 / v5 ship here as SELECTABLE versions behind the per-pass
// setting; the default flips at the S4 gate by changing two constants below.
//
// Resolution order, per pass family:
//   1. env  SUPERTWIN_PROMPT_ORIENT=v7 / SUPERTWIN_PROMPT_CRITIC=v5
//           (the eval CLI and a dev worker pick a version without a DB write)
//   2. app_state `prompt_version.orient` / `prompt_version.critic`
//           (the Settings-facing knob, same store as `selected_model_<pass>`)
//   3. the frozen default.
//
// MODEL PER PASS. Settings keys the model picker by the pass id shown in
// INTELLIGENCE_STEPS (`selected_model_orient.v6`, `selected_model_critic.v4`).
// A newer version has no picker row of its own yet, so `modelForVersionedPass`
// reads the version's own key first and falls back to the family's settings
// key — switching versions never silently changes which model runs.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { DEFAULT_PASS_MODEL } from "../brain/llm.js";
import { CRITIC_V4 } from "./critic.v4.js";
import { CRITIC_V5 } from "./critic.v5.js";
import { ORIENT_V6 } from "./orient.v6.js";
import { ORIENT_V7 } from "./orient.v7.js";

export type PromptFamily = "orient" | "critic";

export interface VersionedPrompt {
  /** The live pass id (`orient.v7`) — runs/traces/prompt cache key. */
  pass: string;
  version: number;
  system: string;
  /** The Settings step key whose model picker governs this family. */
  settingsKey: string;
}

export const ORIENT_VERSIONS = {
  v6: { ...ORIENT_V6, settingsKey: ORIENT_V6.pass },
  v7: { ...ORIENT_V7, settingsKey: ORIENT_V6.pass },
} as const satisfies Record<string, VersionedPrompt>;

export const CRITIC_VERSIONS = {
  v4: { ...CRITIC_V4, settingsKey: CRITIC_V4.pass },
  v5: { ...CRITIC_V5, settingsKey: CRITIC_V4.pass },
} as const satisfies Record<string, VersionedPrompt>;

export type OrientVersion = keyof typeof ORIENT_VERSIONS;
export type CriticVersion = keyof typeof CRITIC_VERSIONS;

/** Frozen baseline (Build §2.1). The S4 gate flips these to v7 / v5. */
export const DEFAULT_ORIENT_VERSION: OrientVersion = "v6";
export const DEFAULT_CRITIC_VERSION: CriticVersion = "v4";

export const PROMPT_VERSION_ENV: Record<PromptFamily, string> = {
  orient: "SUPERTWIN_PROMPT_ORIENT",
  critic: "SUPERTWIN_PROMPT_CRITIC",
};

/** app_state key holding a family's selected version. */
export function promptVersionKey(family: PromptFamily): string {
  return `prompt_version.${family}`;
}

function stored(key: string): string | null {
  try {
    const row = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as
      | { value: string | null }
      | undefined;
    const v = row?.value?.trim();
    return v ? v : null;
  } catch {
    return null; // no DB in a pure unit test — the default answers
  }
}

function normalise(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  if (t === "") return null;
  return /^\d+$/.test(t) ? `v${t}` : t;
}

/** The selected version tag for a family: env → app_state → default. */
export function selectedPromptVersion(family: PromptFamily): string {
  const known = family === "orient" ? ORIENT_VERSIONS : CRITIC_VERSIONS;
  const dflt = family === "orient" ? DEFAULT_ORIENT_VERSION : DEFAULT_CRITIC_VERSION;
  for (const candidate of [normalise(process.env[PROMPT_VERSION_ENV[family]]), normalise(stored(promptVersionKey(family)))]) {
    if (candidate && candidate in known) return candidate;
  }
  return dflt;
}

/**
 * Persist a family's version (Settings / the S4 gate flip). Throws on an
 * unknown tag so a typo never silently falls back to the baseline.
 */
export function setPromptVersion(family: PromptFamily, version: string): void {
  const tag = normalise(version);
  const known = family === "orient" ? ORIENT_VERSIONS : CRITIC_VERSIONS;
  if (!tag || !(tag in known)) {
    throw new Error(`unknown ${family} prompt version "${version}" — known: ${Object.keys(known).join(", ")}`);
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(promptVersionKey(family), tag, now);
}

/** The Orient prompt to run now (v6 baseline unless switched). */
export function activeOrientPrompt(): VersionedPrompt {
  return ORIENT_VERSIONS[selectedPromptVersion("orient") as OrientVersion];
}

/** The Critic prompt to run now (v4 baseline unless switched). */
export function activeCriticPrompt(): VersionedPrompt {
  return CRITIC_VERSIONS[selectedPromptVersion("critic") as CriticVersion];
}

/**
 * The model for a versioned pass: its own `selected_model_<pass>` when set,
 * else the family's Settings key, else the default. Mirrors brain/llm.ts
 * modelForPass, with the family fallback the picker needs.
 */
export function modelForVersionedPass(prompt: VersionedPrompt): string {
  return (
    stored(`selected_model_${prompt.pass}`) ??
    (prompt.settingsKey !== prompt.pass ? stored(`selected_model_${prompt.settingsKey}`) : null) ??
    DEFAULT_PASS_MODEL
  );
}
