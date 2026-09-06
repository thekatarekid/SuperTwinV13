// ===========================================================================
// correction-parse.v3 — "tell the twin" (V6 P1 S5.5, Prompts P-12). Zero
// model calls: the raw strings below are the model's half. What is asserted
// is the parse (the P-12 type list, the behavioral block, confidence bounds)
// and the code map onto the ONE structured shape the corrections pipeline
// applies, so chip, drag, utterance and bar follow-up all end up in the same
// place (FIX-05).
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CORRECTION_PARSE_V3_VERSION,
  CORRECTION_TYPES_V3,
  dateFieldFor,
  packCorrectionInputV3,
  parseCorrectionOutputV3,
  toStructuredCorrection,
} from "./correction-parse.v3.js";

describe("parseCorrectionOutputV3", () => {
  it("reads the P-12 example for a misassigned task", () => {
    const p = parseCorrectionOutputV3(`{"type":"not_mine","args":{"owner":"karan"},"behavioral":null,"confidence":0.95}`);
    expect(p).toEqual({ type: "not_mine", args: { owner: "karan" }, behavioral: null, confidence: 0.95 });
  });

  it("reads the P-12 example that carries a durable rule", () => {
    const p = parseCorrectionOutputV3(
      `{"type":"dont_do_this","args":{"kind":"something_moved","context":"app:YouTube"},` +
        `"behavioral":{"rule":"no cards while YouTube is frontmost","scope":"router"},"confidence":0.9}`,
    );
    expect(p!.type).toBe("dont_do_this");
    expect(p!.args).toEqual({ kind: "something_moved", context: "app:YouTube" });
    expect(p!.behavioral).toEqual({ rule: "no cards while YouTube is frontmost", scope: "router" });
  });

  it("rejects an unknown type instead of guessing a mutation", () => {
    expect(parseCorrectionOutputV3(`{"type":"delete_everything","args":{}}`)).toBeNull();
    expect(parseCorrectionOutputV3("sorry, I'm not sure")).toBeNull();
  });

  it("clamps confidence, defaults a missing scope, and keeps numeric args as strings", () => {
    const p = parseCorrectionOutputV3(
      `{"type":"change_date","args":{"iso":"2026-11-02","days":3},"behavioral":{"rule":"trips move, dates follow"},"confidence":7}`,
    );
    expect(p!.confidence).toBe(1);
    expect(p!.args).toEqual({ iso: "2026-11-02", days: "3" });
    expect(p!.behavioral!.scope).toBe("global");
    expect(parseCorrectionOutputV3(`{"type":"not_true","args":{}}`)!.confidence).toBe(0.5);
  });

  it("ignores an empty behavioral rule", () => {
    expect(parseCorrectionOutputV3(`{"type":"outdated","args":{},"behavioral":{"rule":"   ","scope":"router"}}`)!.behavioral).toBeNull();
  });
});

describe("toStructuredCorrection — the v3 → pipeline map", () => {
  const parse = (raw: string) => parseCorrectionOutputV3(raw)!;

  it("maps not_mine onto wrong_person (the FIX-01 / FIX-07 applier)", () => {
    const s = toStructuredCorrection(parse(`{"type":"not_mine","args":{"owner":"karan"},"confidence":0.95}`), "task");
    expect(s.type).toBe("wrong_person");
    expect(s.owner).toBe("karan");
    expect(s.parsed_by).toBe(CORRECTION_PARSE_V3_VERSION);
    expect(s.confidence).toBe(0.95);
  });

  it("renames per target kind: a space gets a label, a task a title", () => {
    const raw = `{"type":"rename","args":{"text":"Hampi trek Nov"},"confidence":0.9}`;
    expect(toStructuredCorrection(parse(raw), "space")).toMatchObject({ type: "edit", field: "label", value: "Hampi trek Nov" });
    expect(toStructuredCorrection(parse(raw), "task")).toMatchObject({ type: "edit", field: "title", value: "Hampi trek Nov" });
  });

  it("change_date edits the field that means a date on that kind", () => {
    expect(dateFieldFor("task")).toBe("due");
    const s = toStructuredCorrection(parse(`{"type":"change_date","args":{"iso":"2026-11-02"},"confidence":0.9}`), "task");
    expect(s).toMatchObject({ type: "edit", field: "due", value: "2026-11-02" });
  });

  it("carries the behavioral rule through whatever the type was", () => {
    const s = toStructuredCorrection(
      parse(`{"type":"dont_do_this","args":{"kind":"something_moved","context":"app:YouTube"},"behavioral":{"rule":"no cards while YouTube is frontmost","scope":"router"},"confidence":0.9}`),
      "task",
    );
    expect(s.type).toBe("dont_do_this");
    expect(s.kind).toBe("something_moved");
    expect(s.context).toBe("app:YouTube");
    expect(s.behavioral).toEqual({ rule: "no cards while YouTube is frontmost", scope: "router" });
  });

  it("has a mapping for every declared type", () => {
    for (const type of CORRECTION_TYPES_V3) {
      const parsed = { type, args: {}, behavioral: null, confidence: 0.5 } as const;
      expect(toStructuredCorrection(parsed, "task").type).toBeTruthy();
    }
  });
});

describe("packCorrectionInputV3", () => {
  it("names the locked object, its state and the utterance", () => {
    const packed = packCorrectionInputV3(
      { kind: "task", id: "t_1", label: "collect ₹5k from Karan", state: { status: "open", owner: "self" } },
      "this is karan's, not mine",
    );
    expect(packed).toContain('LOCKED kind=task id=t_1 label="collect ₹5k from Karan"');
    expect(packed).toContain('STATE {"status":"open","owner":"self"}');
    expect(packed).toContain("UTTERANCE this is karan's, not mine");
  });

  it("tells a person-card correction the circle vocabulary and to keep the relation word", () => {
    const packed = packCorrectionInputV3(
      { kind: "person", id: "en_1", label: "Riya", state: { circle: "coworkers" } },
      "she's my cousin, not a coworker",
    );
    expect(packed).toContain("On a person");
    expect(packed).toContain('"relation"');
    expect(packed).toContain("family");
  });

  it("keeps the circle vocabulary out of a task's block", () => {
    const packed = packCorrectionInputV3({ kind: "task", id: "t_1", state: {} }, "already did it");
    expect(packed).not.toContain("On a person");
  });

  it("says a cancellation is `outdated`, and that TYPE is the bare verb", () => {
    const packed = packCorrectionInputV3({ kind: "space", id: "sp_1", state: {} }, "we cancelled goa");
    expect(packed).toContain("bare verb");
    expect(packed).toContain('"outdated"');
  });
});

// ---------------------------------------------------------------------------
// Stage 5 gate — the three pipeline verbs the v3 map had made unreachable.
//
// corrections-routes.ts still implements `cancel`, `set_relationship` and
// `stop_tracking`, but no v3 type reached them, so FIX-02/03/04 went red the
// moment v3 replaced v2: the parse was right and nothing was applied.
// ---------------------------------------------------------------------------

describe("toStructuredCorrection — the verbs that only a target kind can name", () => {
  const parse = (raw: string) => parseCorrectionOutputV3(raw)!;

  it("reads a type that echoed its argument signature (`change_date(iso)`)", () => {
    // The TYPES line lists verbs as `change_date(iso)`, so the model echoes it.
    const parsed = parseCorrectionOutputV3(`{"type":"change_date(iso)","args":{"iso":"2026-01-04"},"confidence":0.9}`);
    expect(parsed?.type).toBe("change_date");
  });

  it("still refuses a genuinely unknown verb", () => {
    expect(parseCorrectionOutputV3(`{"type":"delete_everything","args":{},"confidence":1}`)).toBeNull();
  });

  it("outdated on a space or a task is the pipeline's cancel (FIX-02)", () => {
    const raw = `{"type":"outdated","args":{},"confidence":0.9}`;
    expect(toStructuredCorrection(parse(raw), "space")).toMatchObject({ type: "cancel" });
    expect(toStructuredCorrection(parse(raw), "task")).toMatchObject({ type: "cancel" });
  });

  it("outdated on a claim still end-dates the claim, not a cancellation", () => {
    const s = toStructuredCorrection(parse(`{"type":"outdated","args":{},"confidence":0.9}`), "claim");
    expect(s.type).toBe("outdated");
  });

  it("move_to_space on a person is a relationship correction, circle and all (FIX-03)", () => {
    const raw = `{"type":"move_to_space","args":{"target":"family","relation":"cousin"},"confidence":0.95}`;
    expect(toStructuredCorrection(parse(raw), "person")).toMatchObject({
      type: "set_relationship",
      relation: "cousin",
      circle: "family",
    });
  });

  it("falls back to the circle word when the model gave no relation", () => {
    const s = toStructuredCorrection(parse(`{"type":"move_to_space","args":{"target":"family"},"confidence":0.9}`), "person");
    expect(s).toMatchObject({ type: "set_relationship", relation: "family", circle: "family" });
  });

  it("move_to_space on an episode is still a plain move", () => {
    const s = toStructuredCorrection(parse(`{"type":"move_to_space","args":{"target":"Side project"},"confidence":0.9}`), "episode");
    expect(s).toMatchObject({ type: "move", to_space_hint: "Side project" });
  });

  it("dont_do_this locked to a stream is stop_tracking (FIX-04)", () => {
    const raw = `{"type":"dont_do_this","args":{"kind":"stream_tracking","context":"College Memes"},"behavioral":{"rule":"do not track College Memes","scope":"capture"},"confidence":0.85}`;
    const s = toStructuredCorrection(parse(raw), "stream");
    expect(s.type).toBe("stop_tracking");
    // The durable rule still rides along — FIX-08 is unaffected by the split.
    expect(s.behavioral).toMatchObject({ rule: "do not track College Memes" });
  });

  it("dont_do_this anywhere else is still the router rule", () => {
    const raw = `{"type":"dont_do_this","args":{"kind":"something_moved","context":"app:YouTube"},"confidence":0.9}`;
    expect(toStructuredCorrection(parse(raw), "nudge")).toMatchObject({ type: "dont_do_this", context: "app:YouTube" });
  });
});
