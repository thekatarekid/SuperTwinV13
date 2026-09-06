// ===========================================================================
// Per-step on/off, the candidate overrides, and the STEM fallback that makes
// one Settings key follow a step across prompt versions (V6 P1 S5.6).
//
// Zero model calls: nothing here spawns anything.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { modelForPass, DEFAULT_PASS_MODEL } from "../brain/llm.js";
import { storedThinkingForPass } from "../brain/reasoning.js";
import { readStepOverrides, stepOverride, STEP_OVERRIDES_ENV, encodeStepOverrides } from "./overrides.js";
import {
  evalCategoriesForStep,
  isStepEnabled,
  laneStepEnabled,
  LANE_STEP,
  PROCESS_ENABLED_PREFIX,
  STEP_EVAL_CATEGORIES,
} from "./steps.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-steps-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  delete process.env[STEP_OVERRIDES_ENV];
  closeDb();
  runMigrations();
});

afterEach(() => {
  delete process.env[STEP_OVERRIDES_ENV];
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("per-step on/off (SET-01)", () => {
  it("no row reads as ON — a step nobody has touched is never silently off", () => {
    expect(isStepEnabled("orient")).toBe(true);
    expect(laneStepEnabled("live")).toBe(true);
    expect(laneStepEnabled("history")).toBe(true);
    expect(laneStepEnabled("digest")).toBe(true);
  });

  it('only the literal "0" turns a step off', () => {
    appStateSet(`${PROCESS_ENABLED_PREFIX}orient`, "0");
    expect(isStepEnabled("orient")).toBe(false);
    // Both understanding lanes open at Orient, so both hold.
    expect(laneStepEnabled("live")).toBe(false);
    expect(laneStepEnabled("history")).toBe(false);
    expect(laneStepEnabled("digest")).toBe(true);
    appStateSet(`${PROCESS_ENABLED_PREFIX}orient`, "1");
    expect(isStepEnabled("orient")).toBe(true);
  });

  it("the digest lane opens at Digest, not at Orient", () => {
    expect(LANE_STEP).toEqual({ live: "orient", history: "orient", digest: "digest" });
    appStateSet(`${PROCESS_ENABLED_PREFIX}digest`, "0");
    expect(laneStepEnabled("digest")).toBe(false);
    expect(laneStepEnabled("live")).toBe(true);
  });
});

describe("which golden categories a step's change re-runs (SET-02)", () => {
  it("names the categories the step actually answers for", () => {
    expect(evalCategoriesForStep("decide")).toContain("DEC");
    expect(evalCategoriesForStep("orient")).toContain("TOP");
    expect(evalCategoriesForStep("chat")).toContain("USR");
  });

  it("an unknown step asks for the WHOLE set (null), never for nothing", () => {
    expect(evalCategoriesForStep("mystery")).toBeNull();
  });

  it("every mapped step names at least one category — an empty list would gate on nothing", () => {
    for (const [step, cats] of Object.entries(STEP_EVAL_CATEGORIES)) {
      expect(cats.length, `${step} has no categories`).toBeGreaterThan(0);
    }
  });
});

describe("candidate overrides (settings/overrides.ts)", () => {
  it("unset reads as no overrides", () => {
    expect(readStepOverrides()).toEqual({});
    expect(stepOverride("decide")).toBeNull();
  });

  it("malformed JSON reads as no overrides rather than throwing into a pass", () => {
    process.env[STEP_OVERRIDES_ENV] = "{not json";
    expect(readStepOverrides()).toEqual({});
  });

  it("a versioned pass id matches an override keyed on its stem", () => {
    process.env[STEP_OVERRIDES_ENV] = encodeStepOverrides({ critic: { model: "opus", thinking: "high" } });
    expect(stepOverride("critic.v5")).toEqual({ model: "opus", thinking: "high" });
    expect(stepOverride("critic")).toEqual({ model: "opus", thinking: "high" });
    expect(stepOverride("orient.v7")).toBeNull();
  });

  it("an exact id beats the stem", () => {
    process.env[STEP_OVERRIDES_ENV] = JSON.stringify({ orient: { model: "haiku" }, "orient.v7": { model: "opus" } });
    expect(stepOverride("orient.v7")?.model).toBe("opus");
    expect(stepOverride("orient.v6")?.model).toBe("haiku");
  });
});

describe("the stem fallback — one Settings key per step, across prompt versions", () => {
  it("a runner spending under `orient.v7` honours the choice made for `orient`", () => {
    expect(modelForPass("orient.v7")).toBe(DEFAULT_PASS_MODEL);
    appStateSet("selected_model_orient", "sonnet");
    expect(modelForPass("orient.v7")).toBe("sonnet");
    expect(modelForPass("orient")).toBe("sonnet");
    // An exact key still wins over the stem.
    appStateSet("selected_model_orient.v7", "opus");
    expect(modelForPass("orient.v7")).toBe("opus");
    expect(modelForPass("orient.v6")).toBe("sonnet");
  });

  it("reasoning follows the same rule", () => {
    expect(storedThinkingForPass("decide.v9")).toBe("off");
    appStateSet("selected_thinking_decide", "high");
    expect(storedThinkingForPass("decide.v9")).toBe("high");
  });

  it("a candidate under the golden gate wins over app_state, for both model and reasoning", () => {
    appStateSet("selected_model_decide", "haiku");
    appStateSet("selected_thinking_decide", "off");
    process.env[STEP_OVERRIDES_ENV] = encodeStepOverrides({ decide: { model: "sonnet", thinking: "high" } });
    expect(modelForPass("decide")).toBe("sonnet");
    expect(storedThinkingForPass("decide.v9")).toBe("high");
    // …and only for the step under test.
    expect(modelForPass("orient")).toBe(DEFAULT_PASS_MODEL);
  });
});
