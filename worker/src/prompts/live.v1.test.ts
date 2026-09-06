// ===========================================================================
// live.v1 (V6 P1 S4.1, P-01): the prompt's load-bearing text and the version
// registry around it. Pure — no DB, no model.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_V1, LIVE_V1_ID, liveModeLine } from "./live.v1.js";
import { ORIENT_V1_CORE } from "./orient.v1.js";
import { ORIENT_V7_PACK, ORIENT_V7_SCHEMA } from "./orient.v7.js";
import { activeLivePrompt, DEFAULT_LIVE_VERSION, LIVE_PROMPT_ENV, LIVE_VERSIONS, modelForVersionedPass } from "./versions.js";

afterEach(() => {
  delete process.env[LIVE_PROMPT_ENV];
});

describe("live.v1 system prompt", () => {
  it("is one static string with the P-01 rules, the pack description and both schemas", () => {
    expect(LIVE_V1.pass).toBe(LIVE_V1_ID);
    expect(LIVE_V1.version).toBe(1);
    const s = LIVE_V1.system;
    expect(s).toContain('You return TWO\nindependent sections: "understanding" and "decide"');
    expect(s).toContain("<untrusted>");
    expect(s).toContain("MODE: insufficient-context");
    expect(s).toContain("Prepared actions are only for things worth doing NOW");
    expect(s).toContain("grounded_in");
    expect(s).toContain("you never mark a send or a payment as done");
    expect(s).toContain(ORIENT_V7_PACK);
    // understanding is byte-compatible with orient.v7: the very same schema
    // block AND the very same filing rules, so the live and history lanes
    // cannot file the same events differently.
    expect(s).toContain(ORIENT_V7_SCHEMA);
    expect(s).toContain(ORIENT_V1_CORE);
    for (const key of ['"prepared"', '"intent_confidence"', '"urgency"', '"deadline_at"', '"help_now"', '"needs_you"', '"something_moved"']) {
      expect(s).toContain(key);
    }
    expect(s).not.toMatch(/\bsend_whatsapp\b/);
  });

  it("the merged prompt stays well inside the system-block budget (T3-3: 28,000 chars)", () => {
    expect(LIVE_V1.system.length).toBeLessThan(14_000);
  });

  it("names the six actions and no send/pay action", () => {
    expect(LIVE_V1.system).toContain('"action":"compare"|"research"|"draft_reply"|"draft_message"|"brief"|"question"');
  });

  it("the MODE line is the first thing the model reads", () => {
    expect(liveModeLine(false)).toBe("MODE: live");
    expect(liveModeLine(true)).toBe("MODE: insufficient-context");
  });
});

describe("prompt version registry", () => {
  it("runs v1 by default and can be switched off by env", () => {
    expect(DEFAULT_LIVE_VERSION).toBe("v1");
    expect(activeLivePrompt()?.pass).toBe("live.v1");
    process.env[LIVE_PROMPT_ENV] = "off";
    expect(activeLivePrompt()).toBeNull();
    process.env[LIVE_PROMPT_ENV] = "1";
    expect(activeLivePrompt()?.pass).toBe("live.v1");
    process.env[LIVE_PROMPT_ENV] = "v9";
    expect(activeLivePrompt()?.pass).toBe("live.v1"); // unknown tag → default
  });

  it("the model picker falls back to the orient family's Settings row", () => {
    expect(LIVE_VERSIONS.v1.settingsKey).toBe("orient.v6");
    expect(typeof modelForVersionedPass(LIVE_VERSIONS.v1)).toBe("string");
  });
});
