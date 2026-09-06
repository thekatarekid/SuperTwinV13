// ===========================================================================
// nudgeVerdict — the output-side verdict (V6 P1 S4.4). Zero model calls.
//
// The point of this module is that there is only ONE of it: the writer
// (brain/live.ts) stamps a prepared row with the same verdict the router
// (surfaces/router.ts) reads back. These tests hold that, and hold the
// thresholds to Settings › Assist rather than to a literal in either caller.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { applyAssistP1Patch, assistP1Settings, DEFAULT_INTENT_FLOOR, INTENT_FLOOR_KEY } from "../settings/p1-settings.js";
import { DEFAULT_NUDGE_INTENT_FLOOR, nudgeThresholds, nudgeVerdict } from "./nudge-verdict.js";

const T = { intentFloor: 0.7, blockedKinds: [] as string[] };

describe("the verdict itself", () => {
  it("above the floor earns the card; below it is shelved, never dropped", () => {
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.94 }, T)).toMatchObject({ verdict: "card", surface: "card" });
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.55 }, T)).toMatchObject({ verdict: "shelf", surface: "shelf" });
    // The floor is inclusive — exactly at it is a card (LIV-06 sits below).
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.7 }, T).verdict).toBe("card");
  });

  it("a blocked kind is blocked however confident it is, and says so", () => {
    const t = { intentFloor: 0.7, blockedKinds: ["something_moved"] };
    const v = nudgeVerdict({ kind: "something_moved", intentConfidence: 1 }, t);
    expect(v.verdict).toBe("blocked");
    expect(v.surface).toBe("shelf"); // never a card, still written down
    expect(v.reason).toContain("blocked kinds");
    expect(v.reason).toContain("reversible");
  });

  it("every verdict carries the line that goes in the decisions row", () => {
    expect(nudgeVerdict({ kind: "help_now", intentConfidence: 0.4 }, T).reason).toContain("below the floor 0.7");
    expect(nudgeVerdict({ kind: "help_now", intentConfidence: 0.9 }, T).reason).toContain("at or above the floor 0.7");
  });

  it("a missing or nonsense confidence shelves rather than cards", () => {
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0 }, T).verdict).toBe("shelf");
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: Number.NaN }, T).verdict).toBe("shelf");
  });
});

describe("the thresholds come from Settings › Assist", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-nudge-verdict-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
  });
  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ONE default for the one app_state row — the writer and the router agree", () => {
    // The S4.4 fix: settings/p1-settings.ts said 0.6 and brain/live.ts said
    // 0.7 for `assist.intent_confidence_min`, so 0.65 was shelved by the
    // writer and carded by the router.
    expect(DEFAULT_INTENT_FLOOR).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
    expect(nudgeThresholds().intentFloor).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
    expect(assistP1Settings().intent_floor).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.65 }).verdict).toBe("shelf");
  });

  it("the user's own number wins, and so does their blocked list", () => {
    applyAssistP1Patch({ intent_floor: 0.5, blocked_kinds: ["done_in_advance"] });
    expect(nudgeThresholds()).toEqual({ intentFloor: 0.5, blockedKinds: ["done_in_advance"] });
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.55 }).verdict).toBe("card");
    expect(nudgeVerdict({ kind: "done_in_advance", intentConfidence: 0.99 }).verdict).toBe("blocked");
  });

  it("a corrupt row never disables the gate — it clamps to the default", () => {
    appStateSet(INTENT_FLOOR_KEY, "not a number");
    expect(nudgeThresholds().intentFloor).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
  });
});
