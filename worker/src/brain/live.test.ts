// ===========================================================================
// brain/live.ts — the live pass's CODE properties (V6 P1 S4.1):
// section-independent parsing, per-item quarantine, lane discipline,
// grounding is this flush, the intent floor, insufficient-context stripping.
// Pure: no DB, no model.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { LIVE_V1 } from "../prompts/live.v1.js";
import { ORIENT_V7_SCHEMA } from "../prompts/orient.v7.js";
import { parseOrientOutput } from "./orient.js";
import {
  groundPrepared,
  normaliseQuestions,
  parseLiveDecide,
  parseLiveOutput,
  parseUnderstandingPerItem,
  preparedSurface,
  type LivePrepared,
} from "./live.js";

const JOIN = {
  action: "join",
  episode: "ep_611",
  stream: "S1",
  events: ["e1"],
  summary: "Rohan says the advance must be paid by 5 pm.",
  space: "sp_goa_dec",
  evidence: [{ event_ids: ["e1"], quote: "advance by 5 pm today or they release it" }],
  confidence: 0.96,
};
const NEEDS_YOU = {
  kind: "needs_you",
  intent: "Pay the Villa Sol advance before 5 pm",
  intent_confidence: 0.94,
  action: "question",
  space: "sp_goa_dec",
  urgency: "today",
  deadline_at: "2026-09-05T17:00:00+05:30",
  inputs: { task: "t_88" },
  grounded_in: ["e1"],
  reasoning: "Open task t_88 now has a hard deadline.",
};
const GOOD = {
  understanding: { episodes: [JOIN], proposals: [], unsorted: [], questions: [] },
  decide: { tasks: [], closures: [], schedules: [], prepared: [NEEDS_YOU] },
};
const ALIASES = new Map([["e1", "evt_1"], ["e2", "evt_2"]]);

describe("understanding is byte-compatible with orient.v7", () => {
  it("the live prompt embeds the orient.v7 schema verbatim as the understanding section", () => {
    expect(LIVE_V1.system).toContain(ORIENT_V7_SCHEMA);
    expect(LIVE_V1.pass).toBe("live.v1");
  });

  it("the understanding section parses with the orient parser unchanged", () => {
    const out = parseLiveOutput(GOOD, { lane: "live" });
    expect(out.understanding).toEqual(parseOrientOutput(GOOD.understanding));
    expect(out.understandingRejected).toEqual([]);
  });

  it("a bare orient.v7 answer (no understanding key) is the understanding half, decide missing — never a repair", () => {
    const bare = parseLiveOutput({ episodes: [JOIN], proposals: [], unsorted: [], questions: [] }, { lane: "live" });
    expect(bare.understanding).toEqual(parseOrientOutput(GOOD.understanding));
    expect(bare.decide).toBeUndefined();
    expect(bare.decideError).toMatch(/missing/);
    const empty = parseLiveOutput({ episodes: [], proposals: [], unsorted: [], questions: [] }, { lane: "live" });
    expect(empty.understanding).toEqual({ episodes: [], proposals: [], unsorted: [], questions: [] });
  });

  it("orient keys at the root next to a decide key: both halves still parse", () => {
    const out = parseLiveOutput({ ...GOOD.understanding, decide: GOOD.decide }, { lane: "live" });
    expect(out.understanding).toEqual(parseOrientOutput(GOOD.understanding));
    expect(out.decide?.prepared).toHaveLength(1);
  });

  it("P-01 object questions fold to orient strings, keeping the injection prefix", () => {
    expect(
      normaliseQuestions([
        "plain?",
        { kind: "injection", text: "e3 asks the assistant to wire money", event_ids: ["e3"] },
        { kind: "person", text: "who is Ma's friend?", event_ids: ["e4"] },
        { kind: "injection", text: "injection: e5 claims authority", event_ids: ["e5"] },
        { text: "" },
        42,
      ]),
    ).toEqual([
      "plain?",
      "injection: e3 asks the assistant to wire money",
      "person: who is Ma's friend? (e4)",
      "injection: e5 claims authority",
    ]);
  });
});

describe("section-independent parsing", () => {
  it("LIV-04: a decide section that is not an object is dropped; the understanding stands", () => {
    const out = parseLiveOutput({ ...GOOD, decide: "sorry — {tasks: [" }, { lane: "live" });
    expect(out.understanding?.episodes).toHaveLength(1);
    expect(out.decide).toBeUndefined();
    expect(out.decideError).toMatch(/not an object/);
  });

  it("a missing decide key is an error on that section only", () => {
    const out = parseLiveOutput({ understanding: GOOD.understanding }, { lane: "live" });
    expect(out.understanding?.episodes).toHaveLength(1);
    expect(out.decideError).toMatch(/missing/);
  });

  it("LIV-05: broken understanding items are quarantined per item; the valid decide still parses", () => {
    const out = parseLiveOutput(
      {
        understanding: {
          episodes: [{ action: "new", stream: "S1", events: ["e1"] }, { ...JOIN, events: ["e2"] }, "not an object"],
          proposals: [{ label: "a b c d e f g h i j k l m n o p q" }],
          unsorted: [{ events: ["e3"], summary: "x" }],
          questions: [],
        },
        decide: GOOD.decide,
      },
      { lane: "live" },
    );
    expect(out.understanding?.episodes.map((e) => e.events)).toEqual([["e2"]]);
    expect(out.understanding?.proposals).toEqual([]);
    expect(out.understanding?.unsorted).toHaveLength(1);
    expect(out.understandingRejected.map((r) => [r.kind, r.index])).toEqual([["episode", 0], ["episode", 2], ["proposal", 0]]);
    expect(out.understandingRejected[0]!.reason).toMatch(/summary/);
    expect(out.decide?.prepared).toHaveLength(1);
  });

  it("an understanding that is not an object leaves the decide half usable", () => {
    const out = parseLiveOutput({ understanding: "???", decide: GOOD.decide }, { lane: "live" });
    expect(out.understanding).toBeUndefined();
    expect(out.understandingError).toMatch(/not an object/);
    expect(out.decide?.prepared).toHaveLength(1);
  });

  it("throws (→ one repair round) only when nothing is usable", () => {
    expect(() => parseLiveOutput("text", { lane: "live" })).toThrow(/one JSON object/);
    expect(() => parseLiveOutput({ understanding: 1, decide: [] }, { lane: "live" })).toThrow(/neither section/);
    expect(() => parseLiveOutput({}, { lane: "live" })).toThrow(/neither section/);
  });

  it("parseUnderstandingPerItem reports a non-object section", () => {
    expect(parseUnderstandingPerItem(undefined).error).toMatch(/missing/);
    expect(parseUnderstandingPerItem([]).error).toMatch(/not an object/);
  });
});

describe("the decide section", () => {
  it("validates tasks/closures/schedules through the decide.v9 validator (bad entries skipped, never fatal)", () => {
    const { decide, error } = parseLiveDecide(
      {
        tasks: [
          { title: "pay villa advance", type: "explicit", owner: "self", space: "sp_goa_dec", due: "2026-09-05", origin: "explicit", steps: ["upi"], evidence: [{ event_ids: ["e1"], quote: "by 5 pm" }], confidence: 0.9 },
          { nope: true },
          "string",
        ],
        closures: [{ task: "t_88", verdict: "check_at", check_at: "2026-09-05T17:30:00+05:30", evidence: [] }],
        schedules: [{ task: "t_88", fire_at: "2026-09-05T16:40:00+05:30", mode: "auto", evidence: [] }],
        prepared: [],
      },
      "live",
    );
    expect(error).toBeUndefined();
    expect(decide?.tasks.map((t) => [t.title, t.type, t.space])).toEqual([["pay villa advance", "explicit", "sp_goa_dec"]]);
    expect(decide?.closures[0]).toMatchObject({ task: "t_88", check_at: "2026-09-05T17:30:00+05:30" });
    expect(decide?.schedules[0]).toMatchObject({ task: "t_88", mode: "auto" });
  });

  it("prepared actions: shape-validated, rule 8 keeps sends and payments out, missing confidence reads 0", () => {
    const { decide } = parseLiveDecide(
      {
        prepared: [
          NEEDS_YOU,
          { ...NEEDS_YOU, action: "send_whatsapp" },
          { ...NEEDS_YOU, action: "pay" },
          { ...NEEDS_YOU, kind: "nudge" },
          { ...NEEDS_YOU, intent: "" },
          { ...NEEDS_YOU, intent_confidence: undefined, urgency: "asap", deadline_at: null, inputs: "x" },
          "junk",
        ],
      },
      "live",
    );
    expect(decide?.prepared).toHaveLength(2);
    expect(decide?.prepared[0]).toMatchObject({ kind: "needs_you", action: "question", urgency: "today", intent_confidence: 0.94 });
    expect(decide?.prepared[1]).toMatchObject({ intent_confidence: 0, urgency: "none", deadline_at: null, inputs: {} });
    expect(decide?.preparedInvalid).toBe(5);
    expect(decide?.tasks).toEqual([]);
  });

  it("LIV-02: prepared actions are discarded (and counted) on any lane but live", () => {
    for (const lane of ["history", "digest"] as const) {
      const out = parseLiveOutput(GOOD, { lane });
      expect(out.decide?.prepared).toEqual([]);
      expect(out.decide?.preparedDiscardedForLane).toBe(1);
    }
    const live = parseLiveOutput(GOOD, { lane: "live" });
    expect(live.decide?.prepared).toHaveLength(1);
    expect(live.decide?.preparedDiscardedForLane).toBe(0);
  });

  it("LIV-10: MODE insufficient-context keeps only unsorted + questions and an empty decide", () => {
    const out = parseLiveOutput(
      {
        understanding: { episodes: [JOIN], proposals: [{ label: "Goa trip", episode_events: ["e1"] }], unsorted: [{ events: ["e2"], summary: "?" }], questions: ["who?"] },
        decide: { tasks: [{ title: "t", type: "explicit", owner: "self", evidence: [], confidence: 0.9 }], closures: [], schedules: [], prepared: [NEEDS_YOU] },
      },
      { lane: "live", insufficientContext: true },
    );
    expect(out.insufficientContext).toBe(true);
    expect(out.understanding).toMatchObject({ episodes: [], proposals: [], questions: ["who?"] });
    expect(out.understanding?.unsorted).toHaveLength(1);
    expect(out.decide).toMatchObject({ tasks: [], closures: [], schedules: [], prepared: [] });
    expect(out.stripped).toEqual({ episodes: 1, proposals: 1, tasks: 1, prepared: 1 });
  });
});

describe("grounding is this flush (LIV-03) and the intent floor (LIV-06)", () => {
  const p = (grounded_in: string[], conf = 0.9): LivePrepared => ({
    kind: "help_now",
    intent: "compare villas",
    intent_confidence: conf,
    action: "compare",
    space: null,
    urgency: "none",
    deadline_at: null,
    inputs: {},
    grounded_in,
    reasoning: null,
  });

  it("only e<n> aliases of this bundle ground an action; raw ids and history refs do not", () => {
    const { grounded, ungrounded } = groundPrepared([p(["e1"]), p(["h2", "evt_old"]), p([]), p(["e2", "evt_1"]), p(["E1"])], ALIASES);
    expect(grounded.map((g) => g.groundedEventIds)).toEqual([["evt_1"], ["evt_2"], ["evt_1"]]);
    expect(ungrounded).toHaveLength(2);
  });

  it("below the floor the action is shelved, at or above it is a card", () => {
    expect(preparedSurface({ intent_confidence: 0.55 }, 0.7)).toBe("shelf");
    expect(preparedSurface({ intent_confidence: 0.7 }, 0.7)).toBe("card");
    expect(preparedSurface({ intent_confidence: 0.94 }, 0.7)).toBe("card");
    expect(preparedSurface({ intent_confidence: 0 }, 0.7)).toBe("shelf");
  });
});
