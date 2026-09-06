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
import { LIVE_V1 } from "./live.v1.js";
import { LIVE_DECIDE_V1 } from "./live-decide.v1.js";

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

/**
 * FLIPPED AT THE S6 GRADUATION GATE (Build §9 items 1 and 2).
 *
 * Build §2.1 froze v6 / v4 "until the S4 gate". The S4 gate measured §7.3
 * item 1 green under v7 / v5 (TOP 10/10) but did not land the flip, so the
 * shipped default stayed on the frozen pair. The S6 full sweep measured what
 * actually ships and found it below the frozen baseline, twice over:
 *
 *   TOP (the ORIENT golden) under v6 / v4 ....... 80% vs a frozen 100%
 *   TOP under v7 / v5, re-measured here ......... 100%, COMPARE green
 *
 * and, on the same 26-event fresh install run twice (scripts/fresh-install.mjs):
 *
 *                              v6 / v4      v7 / v5
 *     episodes committed          9           19
 *     orient repair rounds       12            1
 *     orient QUARANTINED          5            0
 *     model calls               39+           14
 *     cost vs the confirm card  BREACHED     HOLDS (-38.6% of ±40%)
 *
 * Half the understanding was being thrown away and paid for twice. v7 / v5 is
 * the pair the golden set measures and the pair that ships.
 */
export const DEFAULT_ORIENT_VERSION: OrientVersion = "v7";
export const DEFAULT_CRITIC_VERSION: CriticVersion = "v5";

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

// ---------------------------------------------------------------------------
// The LIVE pass (V6 P1 S4.1, P-01) and how many calls it costs (S4.4).
//
// Three shapes, selected by `SUPERTWIN_PROMPT_LIVE` (env) → app_state
// `prompt_version.live` → the default below:
//
//   "v1" | "merged"   ONE call: live.v1 understands AND decides (S4.1).
//   "two-call"        The Build §7.3 FALLBACK: the same merged pack, two
//                     calls — the frozen orient prompt for understanding,
//                     then live-decide.v1 for the decide half.
//   "off"             Understanding only. No decide half at all, so no
//                     prepared actions, no cards. The kill switch, not the
//                     fallback.
//
// THE DEFAULT IS THE FALLBACK. §7.3 gates the merged one-call pass on four
// items; item 1 (ORIENT golden set ≥ baseline) measured 9/10 then 8/10 against
// a frozen 100% at the S4 gate, so the merged call is NOT what production
// runs. Flipping back is one constant here plus the checklist in
// evals/ship-gate.test.ts.
// ---------------------------------------------------------------------------

export const LIVE_VERSIONS = {
  v1: { pass: LIVE_V1.pass, version: LIVE_V1.version, system: LIVE_V1.system, settingsKey: LIVE_V1.settingsKey },
} as const satisfies Record<string, VersionedPrompt>;

/** The decide-only prompt of the §7.3 two-call fallback (P-01's decide half). */
export const LIVE_DECIDE_VERSIONS = {
  v1: {
    pass: LIVE_DECIDE_V1.pass,
    version: LIVE_DECIDE_V1.version,
    system: LIVE_DECIDE_V1.system,
    settingsKey: LIVE_DECIDE_V1.settingsKey,
  },
} as const satisfies Record<string, VersionedPrompt>;

export type LiveVersion = keyof typeof LIVE_VERSIONS;
export type LiveDecideVersion = keyof typeof LIVE_DECIDE_VERSIONS;
export const DEFAULT_LIVE_VERSION: LiveVersion = "v1";
export const DEFAULT_LIVE_DECIDE_VERSION: LiveDecideVersion = "v1";
export const LIVE_PROMPT_ENV = "SUPERTWIN_PROMPT_LIVE";
export const LIVE_PROMPT_OFF = "off";
export const LIVE_PROMPT_TWO_CALL = "two-call";

/** How many model calls the live lane spends on one bundle, and on what. */
export type LiveCallMode = "merged" | "two-call" | "off";

/**
 * ONE CALL. The live lane spends a single merged `live.v1` on a bundle: the
 * understanding half (byte-compatible with orient.v7) and the decide half in
 * the same answer, over the S3.2 pack.
 *
 * This was "two-call" — the Build §7.3 fallback — from S4.4 until R1. The
 * fallback existed because item 1 of the S4 ship gate (ORIENT golden ≥
 * baseline) was red when S4.4 ran: rather than ship an understanding pass no
 * golden run had cleared, the lane spent the FROZEN orient prompt on
 * understanding and `live-decide.v1` on the decide half. The gate went green
 * at the S4 release (TOP 10/10 under orient.v7 + critic.v5) and again at the
 * S6 graduation sweep, and S6 made v7/v5 the defaults — so the merged pass
 * now embeds the very text the golden set scores, and the second call buys
 * nothing but spend.
 *
 * THE CAPABILITY STAYS. "two-call" is still a mode, still selectable by
 * `SUPERTWIN_PROMPT_LIVE=two-call` or the app_state row, and still covered by
 * brain/live-two-call.test.ts. What was removed is the DEFAULT, not the
 * fallback: if a future ORIENT re-measure regresses, §7.3's answer is one env
 * var away.
 */
export const DEFAULT_LIVE_MODE: LiveCallMode = "merged";

/** app_state key holding the live pass selection ("v1" | "two-call" | "off"). */
export function livePromptVersionKey(): string {
  return "prompt_version.live";
}

/**
 * The shape of the live call: env → app_state → `DEFAULT_LIVE_MODE`. An
 * unknown tag is the default, never an error — a typo in Settings must not
 * take the live lane down.
 */
export function activeLiveMode(): LiveCallMode {
  for (const candidate of [normalise(process.env[LIVE_PROMPT_ENV]), normalise(stored(livePromptVersionKey()))]) {
    if (!candidate) continue;
    if (candidate === LIVE_PROMPT_OFF) return "off";
    if (candidate === LIVE_PROMPT_TWO_CALL || candidate === "two" || candidate === "fallback") return "two-call";
    if (candidate === "merged" || candidate in LIVE_VERSIONS) return "merged";
  }
  return DEFAULT_LIVE_MODE;
}

/**
 * The MERGED live prompt (live.v1) — what runs when `activeLiveMode()` is
 * "merged", and null when the live lane is switched off entirely. It is not
 * the mode: under the §7.3 two-call fallback this still names live.v1 (the
 * prompt the gate is about) while the lane makes two calls instead. Ask
 * `activeLiveMode` for what actually runs.
 */
export function activeLivePrompt(): VersionedPrompt | null {
  for (const candidate of [normalise(process.env[LIVE_PROMPT_ENV]), normalise(stored(livePromptVersionKey()))]) {
    if (candidate === LIVE_PROMPT_OFF) return null;
    if (candidate && candidate in LIVE_VERSIONS) return LIVE_VERSIONS[candidate as LiveVersion];
  }
  return LIVE_VERSIONS[DEFAULT_LIVE_VERSION];
}

/** The decide-only prompt for the two-call fallback's second call. */
export function activeLiveDecidePrompt(): VersionedPrompt {
  return LIVE_DECIDE_VERSIONS[DEFAULT_LIVE_DECIDE_VERSION];
}
