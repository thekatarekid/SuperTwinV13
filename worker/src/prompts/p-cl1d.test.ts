// P-CL1Δ — arch §12.5. The delta half of evals M and N: the same claim and
// loop rules, read over ► events only, plus the `Z` update line.
//
// The two things that can only go wrong here are context mode (what the model
// is allowed to see) and ► numbering (whether a newly-readable attachment
// lands in its true position). Both are asserted against §12.5's own example.

import { beforeEach, describe, expect, it } from "vitest";

import { parseCl1DeltaResponse, parseCl1Response, extractionAccounts } from "../claims/extract.js";
import { resetLegendCache } from "./legend.js";
import { P_CL1_SYSTEM } from "./p-cl1.js";
import {
  buildCl1dPrompt,
  buildCl1dSystem,
  cl1dLegend,
  cl1dSendOptions,
  DEFAULT_DELTA_CONTEXT_MODE,
  DELTA_CONTEXT_MODE_KEY,
  DELTA_CONTEXT_MODES,
  getDeltaContextMode,
  isDeltaContextMode,
  P_CL1D,
  P_CL1D_DELTA_BLOCK,
  P_CL1D_SYSTEM,
  P_CL1D_TAGS,
  renderExtracted,
  setDeltaContextMode,
  type Cl1dInput,
} from "./p-cl1d.js";

beforeEach(() => {
  resetLegendCache();
});

// §12.5's worked example, transcribed.
const BASE: Cl1dInput = {
  tz: "Asia/Kolkata",
  entities: [
    { id: "ent_pranjali", name: "Pranjali Sachdeva" },
    { id: "ent_indiranagar", name: "Indiranagar", type: "place" },
  ],
  streams: [
    { id: "str_pranjali", name: "Pranjali", kind: "dm", participantIds: ["self", "ent_pranjali"] },
  ],
  episode: {
    id: "epi_1",
    summary:
      "Pranjali started Saturday bhangra classes and prefers them to the gym. Aditya offered to send a Goa villa link tonight.",
  },
  extracted: [
    { alias: "H1", id: "clm_h1", text: "Attends bhangra classes on Saturdays" },
    { alias: "P1", id: "clm_p1", text: "Prefers bhangra over gym" },
    { alias: "T1", id: "loop_t1", text: "Send Pranjali the Goa villa link", note: "op" },
  ],
  priorEvents: Array.from({ length: 6 }, (_, i) => ({
    id: `ev${i + 1}`,
    streamId: "str_pranjali",
    at: `2026-08-12T1${i}:00:00Z`,
    speakerId: i % 2 === 0 ? "ent_pranjali" : "self",
    text: `prior ${i + 1} — the original wording of this event, which summary mode replaces with the Y line`,
  })),
  newEvents: [
    { id: "ev7", streamId: "str_pranjali", at: "2026-08-12T16:45:00Z", speakerId: "ent_pranjali", text: "actually the saturday batch is full, moving to sunday" },
    { id: "ev8", streamId: "str_pranjali", at: "2026-08-12T16:46:00Z", speakerId: "self", text: "[voice note, transcription pending]" },
  ],
};

// ---- settings --------------------------------------------------------------

describe("P-CL1Δ settings", () => {
  it("transcribes §12.5 exactly", () => {
    expect(P_CL1D.model).toBe("sonnet-5");
    expect(P_CL1D.turns).toBe(1);
    expect(P_CL1D.tools).toBe("none");
    expect(P_CL1D.thinking).toBe("off");
    expect(P_CL1D.timeoutSeconds).toBe(90);
    expect(P_CL1D.maxEpisodesPerCall).toBe(1);
    expect(P_CL1D.maxOutputTokens).toBe(2_500);
  });

  it("fixes the provider knobs", () => {
    expect(cl1dSendOptions()).toEqual({
      model: "sonnet-5",
      maxTurns: 1,
      timeoutMs: 90_000,
      maxOutputTokens: 2_500,
      thinkingBudget: "off",
      plainCompletion: true,
    });
  });
});

// ---- the SYSTEM half -------------------------------------------------------

describe("P-CL1Δ SYSTEM — the P-CL1 prompt plus Z", () => {
  it("is P-CL1 verbatim, then the DELTA MODE block", () => {
    expect(P_CL1D_SYSTEM.startsWith(P_CL1_SYSTEM)).toBe(true);
    expect(P_CL1D_SYSTEM.endsWith(P_CL1D_DELTA_BLOCK)).toBe(true);
  });

  it("adds Z and keeps every P-CL1 tag", () => {
    expect([...P_CL1D_TAGS]).toContain("Z");
    for (const tag of ["Y", "F", "P", "B", "O", "I", "R", "H", "W", "T", "Q"]) {
      expect([...P_CL1D_TAGS]).toContain(tag);
    }
  });

  it("states the five delta rules", () => {
    expect(P_CL1D_DELTA_BLOCK).toContain("Extract ONLY from ► events. Never re-emit an item already listed.");
    expect(P_CL1D_DELTA_BLOCK).toContain('Prior context is for resolving references ("she", "that place") only.');
    expect(P_CL1D_DELTA_BLOCK).toContain("emit a Z line instead of a corrected copy");
    expect(P_CL1D_DELTA_BLOCK).toContain("A newly-readable attachment is a ► event");
    expect(P_CL1D_DELTA_BLOCK).toContain("do not\n  anticipate where it is going");
  });

  it("prints the Z template and its five change codes", () => {
    expect(P_CL1D_DELTA_BLOCK).toContain("Z | <claim|loop alias> | <ctr|dat|cmp|cnl|rfn> | <events> | <note>");
    const legend = cl1dLegend();
    for (const pair of ["ctr=contradicted", "dat=dated", "cmp=completed", "cnl=cancelled", "rfn=refined"]) {
      expect(legend).toContain(pair);
    }
  });

  it("is byte-stable and legend-first", () => {
    expect(buildCl1dSystem()).toBe(buildCl1dSystem());
    expect(buildCl1dSystem().startsWith(cl1dLegend())).toBe(true);
  });
});

// ---- context mode ----------------------------------------------------------

describe("enrichment.delta_context_mode", () => {
  it("has exactly two modes and defaults to summary", () => {
    expect([...DELTA_CONTEXT_MODES]).toEqual(["summary", "raw_events"]);
    expect(DEFAULT_DELTA_CONTEXT_MODE).toBe("summary");
    expect(DELTA_CONTEXT_MODE_KEY).toBe("enrichment.delta_context_mode");
  });

  it("reads the setting, and falls back on an unset or bad row", () => {
    expect(getDeltaContextMode(() => "raw_events")).toBe("raw_events");
    expect(getDeltaContextMode(() => "summary")).toBe("summary");
    expect(getDeltaContextMode(() => null)).toBe("summary");
    expect(getDeltaContextMode(() => "verbose")).toBe("summary");
  });

  it("writes only a known mode", () => {
    const written: string[] = [];
    setDeltaContextMode("raw_events", (_k, v) => written.push(v));
    expect(written).toEqual(["raw_events"]);
    expect(() => setDeltaContextMode("loud" as never, () => undefined)).toThrow();
    expect(isDeltaContextMode("summary")).toBe(true);
    expect(isDeltaContextMode(7)).toBe(false);
  });
});

// ---- summary mode ----------------------------------------------------------

describe("summary mode — the default", () => {
  it("sends the Y line, the extracted ids and ONLY the ► events", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" });
    expect(prompt).not.toBeNull();
    const user = (prompt as NonNullable<typeof prompt>).user;

    expect(user).toContain("Y|e1|Pranjali started Saturday bhangra classes");
    expect(user).toContain("EXTRACTED  H1 Attends bhangra classes on Saturdays | P1 Prefers bhangra over gym");
    expect(user).toContain("T1 Send Pranjali the Goa villa link (op)");
    expect(user).toContain("► 7 ");
    expect(user).toContain("► 8 ");
    // The prior events themselves are absent — that is the ~80 % saving.
    expect(user).not.toContain("prior 1");
    expect(user).not.toContain("prior 6");
  });

  it("► numbering CONTINUES from pass 1, so position is preserved", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(prompt.newEventTokens).toEqual(["7", "8"]);
    expect(prompt.table.eventId("7")).toBe("ev7");
    expect(prompt.table.eventId("8")).toBe("ev8");
  });

  it("is materially smaller than raw_events on the same input", () => {
    const summary = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    const raw = buildCl1dPrompt({ ...BASE, mode: "raw_events" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(summary.user.length).toBeLessThan(raw.user.length);
    expect(summary.stats.events).toBe(2);
    expect(raw.stats.events).toBe(8);
  });

  it("still carries the roster and the stream header", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(prompt.user).toContain("#R a1=Pranjali Sachdeva | a2=Indiranagar [plc]");
    expect(prompt.user).toContain("#C c1 Pranjali | dm | self,a1");
    expect(prompt.user).toContain("#D 2026-08-12");
  });
});

// ---- raw_events mode -------------------------------------------------------

describe("raw_events mode", () => {
  it("sends the full prior event list AND the ► events", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "raw_events" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(prompt.user).toContain("prior 1");
    expect(prompt.user).toContain("prior 6");
    expect(prompt.user).toContain("► 7 ");
    // A prior event is never marked ►.
    expect(prompt.user).not.toMatch(/► \d+ .*prior/);
  });

  it("drops the Y line — the events themselves are the context", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "raw_events" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(prompt.user).not.toContain("Y|e1|");
    // The extracted ids are still sent: "never re-emit an item already listed".
    expect(prompt.user).toContain("EXTRACTED  H1");
  });

  it("numbers the same events the same way in both modes", () => {
    const a = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<ReturnType<typeof buildCl1dPrompt>>;
    const b = buildCl1dPrompt({ ...BASE, mode: "raw_events" }) as NonNullable<ReturnType<typeof buildCl1dPrompt>>;
    expect(a.newEventTokens).toEqual(b.newEventTokens);
  });
});

// ---- edges -----------------------------------------------------------------

describe("delta prompt edges", () => {
  it("renders an empty extracted list as no line at all", () => {
    expect(renderExtracted([])).toEqual([]);
    expect(renderExtracted([{ alias: "", text: "" }])).toEqual([]);
  });

  it("wraps a long extracted list two per line", () => {
    const lines = renderExtracted([
      { alias: "H1", text: "a" },
      { alias: "P1", text: "b" },
      { alias: "T1", text: "c" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("           ")).toBe(true);
  });

  it("neutralises a pipe inside an extracted item's text", () => {
    expect(renderExtracted([{ alias: "H1", text: "a | b" }])[0]).toBe("EXTRACTED  H1 a / b");
  });

  it("works with no prior events at all", () => {
    const prompt = buildCl1dPrompt({ ...BASE, priorEvents: [], mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    expect(prompt.newEventTokens).toEqual(["1", "2"]);
  });

  it("refuses a roster over the cap rather than truncating it", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `ent_${i}`, name: `P${i}` }));
    expect(buildCl1dPrompt({ ...BASE, mode: "summary", entities: many, maxRoster: 10 })).toBeNull();
  });

  it("never marks a marker line with ►", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    for (const line of prompt.user.split("\n")) {
      if (line.startsWith("►")) expect(line.slice(2).startsWith("#")).toBe(false);
    }
  });
});

// ---- §12.5's worked example, end to end ------------------------------------

describe("§12.5's worked example round trips", () => {
  it("reads the EXPECTED block back, H plus Z", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    const expected = [
      "H|7|a1|1p|0.9|2026-08-12|Attends bhangra classes on Sundays",
      "Z|H1|ctr|7|batch moved from Saturday to Sunday",
    ].join("\n");

    const answer = parseCl1DeltaResponse(expected, prompt.table, prompt.itemIds);

    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0].kind).toBe("habit");
    expect(answer.claims[0].eventIds).toEqual(["ev7"]);
    // "the new H carries valid_from; the write path closes H1's window using
    //  stated_at ordering, never arrival order."
    expect(answer.claims[0].validFrom).toBe("2026-08-12");

    expect(answer.updates).toHaveLength(1);
    expect(answer.updates[0].change).toBe("contradicted");
    expect(answer.updates[0].refAlias).toBe("H1");
    expect(answer.updates[0].refId).toBe("clm_h1");
    expect(answer.updates[0].eventIds).toEqual(["ev7"]);

    // "P1 untouched and correctly not re-emitted."
    expect(answer.claims.some((c) => /Prefers/.test(c.text))).toBe(false);
    // "event 8 is a pending placeholder → nothing extracted."
    expect(answer.claims.some((c) => c.eventIds.includes("ev8"))).toBe(false);
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("a Z naming an item this call did not send keeps refId null, never guesses", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    const answer = parseCl1DeltaResponse("Z|W9|rfn|7|note", prompt.table, prompt.itemIds);
    expect(answer.updates[0].refId).toBeNull();
    expect(answer.updates[0].refAlias).toBe("W9");
  });

  it("the same answer read WITHOUT delta mode counts Z rather than applying it", () => {
    const prompt = buildCl1dPrompt({ ...BASE, mode: "summary" }) as NonNullable<
      ReturnType<typeof buildCl1dPrompt>
    >;
    const answer = parseCl1Response("Z|H1|ctr|7|note", prompt.table);
    expect(answer.updates).toHaveLength(0);
    expect(answer.otherRecords).toHaveLength(1);
  });
});
