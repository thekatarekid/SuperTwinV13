import { describe, expect, it } from "vitest";

import { parseWire } from "../wire/index.js";
import {
  askableViolations,
  buildRepairAsk,
  formatViolation,
  MAX_REPAIR_ROUNDS,
  mergeRepairRound,
  singleRound,
  violationSummary,
} from "./repair.js";

/**
 * Four lines, two of them damaged: line 2 carries an enum that is not in the
 * table and line 4 an unknown tag. Lines 1 and 3 are good and must never be
 * re-asked — re-asking them is how a model re-answers events it already
 * covered and the merge doubles a claim.
 */
const FOUR_LINES = [
  "F | 1 | a1 | 1p | 0.9 | 2026-08-01 | likes filter coffee",
  "F | 2 | a1 | zz | 0.9 | 2026-08-01 | drinks it black",
  "P | 3 | a2 | 1p | 0.8 | 2026-08-02 | prefers window seats",
  "U | 4 | a2 | 1p | 0.7 | 2026-08-02 | takes the aisle when flying with kids",
].join("\n");

describe("the ask covers the failing lines and nothing else", () => {
  it("two damaged lines produce a repair asking only for those two", () => {
    const first = parseWire(FOUR_LINES);
    expect(first.records).toHaveLength(2);
    expect(first.violations).toHaveLength(2);

    const ask = buildRepairAsk(first);
    expect(ask.needed).toBe(true);
    expect(ask.violations.map((v) => v.line)).toEqual([2, 4]);

    // Exactly two `line N —` asks, for lines 2 and 4.
    const asks = ask.message.match(/^line \d+ — /gm) ?? [];
    expect(asks).toHaveLength(2);
    expect(ask.message).toContain("line 2 — bad_enum");
    expect(ask.message).toContain("line 4 — unknown_tag");
    expect(ask.message).not.toMatch(/^line 1 — /m);
    expect(ask.message).not.toMatch(/^line 3 — /m);

    // The accepted lines' own text never appears in the ask.
    expect(ask.message).not.toContain("likes filter coffee");
    expect(ask.message).not.toContain("prefers window seats");
  });

  it("quotes the model's original text verbatim (§5.8.1)", () => {
    const ask = buildRepairAsk(parseWire(FOUR_LINES));
    expect(ask.message).toContain("F | 2 | a1 | zz | 0.9 | 2026-08-01 | drinks it black");
    expect(ask.message).toContain("takes the aisle when flying with kids");
  });

  it("instructs re-emit-only and no re-answering of covered events", () => {
    const ask = buildRepairAsk(parseWire(FOUR_LINES));
    expect(ask.message).toContain("Re-emit ONLY the corrected lines");
    expect(ask.message).toContain("Do not repeat the lines that were accepted");
    expect(ask.message).toContain("Do not re-answer the events those accepted lines already covered");
  });

  it("asks nothing when round one was clean", () => {
    const ask = buildRepairAsk(parseWire("F | 1 | a1 | 1p | 0.9 | 2026-08-01 | fine"));
    expect(ask.needed).toBe(false);
    expect(ask.message).toBe("");
  });

  it("asks once for the whole answer when it was all prose (§5.8.3)", () => {
    const first = parseWire("Sure! Here is what I found about your coffee habits.");
    expect(first.violations).toHaveLength(1);
    expect(first.violations[0].scope).toBe("response");

    const ask = buildRepairAsk(first);
    expect(ask.wholeAnswer).toBe(true);
    expect(ask.violations).toHaveLength(1);
    expect(ask.message).toContain("Re-emit the WHOLE answer as wire lines");
    // The prose is echoed, not summarised away.
    expect(ask.message).toContain("Sure! Here is what I found");
  });

  it("asks once per line even when a line collects two verdicts", () => {
    const first = parseWire(FOUR_LINES);
    const doubled = {
      ...first,
      violations: [...first.violations, { ...first.violations[0], rule: "other" }],
    };
    expect(askableViolations(doubled).map((v) => v.line)).toEqual([2, 4]);
  });

  it("formats a violation as `line N — rule: detail` over the model's line", () => {
    const v = parseWire(FOUR_LINES).violations[0];
    expect(formatViolation(v)).toBe(`line 2 — bad_enum: attribution=zz\n    ${v.raw}`);
  });
});

describe("merging the one bounded round", () => {
  const first = parseWire(FOUR_LINES);
  const ask = buildRepairAsk(first);

  it("keeps the accepted round-one lines and adds the repaired ones", () => {
    const second = parseWire(
      [
        "F | 2 | a1 | 1p | 0.9 | 2026-08-01 | drinks it black",
        "P | 4 | a2 | 1p | 0.7 | 2026-08-02 | takes the aisle when flying with kids",
      ].join("\n"),
    );
    const merged = mergeRepairRound(first, second, ask);

    expect(merged.records).toHaveLength(4);
    // Round one's accepted records come first and are untouched.
    expect(merged.records[0].values.text).toBe("likes filter coffee");
    expect(merged.records[1].values.text).toBe("prefers window seats");
    expect(merged.records[2].values.text).toBe("drinks it black");
    expect(merged.violations).toHaveLength(0);
    expect(merged.quarantine).toBe(false);
    expect(merged.coverage).toEqual({
      asked: 2,
      answered: 2,
      unanswered: 0,
      pairingCertain: true,
    });
  });

  it("is bounded at one round — always exactly two calls' worth", () => {
    expect(MAX_REPAIR_ROUNDS).toBe(1);
    const second = parseWire("F | 2 | a1 | 1p | 0.9 | 2026-08-01 | drinks it black");
    expect(mergeRepairRound(first, second, ask).rounds).toBe(2);
    expect(singleRound(first).rounds).toBe(1);
  });

  it("a second failure leaves the violations in the result rather than looping", () => {
    const second = parseWire(
      [
        "F | 2 | a1 | qq | 0.9 | 2026-08-01 | drinks it black",
        "U | 4 | a2 | 1p | 0.7 | 2026-08-02 | takes the aisle",
      ].join("\n"),
    );
    const merged = mergeRepairRound(first, second, ask);
    expect(merged.records).toHaveLength(2); // round one's, still kept
    expect(merged.violations.map((v) => v.rule)).toEqual(["bad_enum", "unknown_tag"]);
    expect(merged.quarantine).toBe(true);
    expect(merged.coverage.unanswered).toBe(0);
  });

  it("carries the originals forward when the repair answered fewer lines than asked", () => {
    const second = parseWire("F | 2 | a1 | 1p | 0.9 | 2026-08-01 | drinks it black");
    const merged = mergeRepairRound(first, second, ask);
    expect(merged.records).toHaveLength(3);
    expect(merged.coverage).toEqual({
      asked: 2,
      answered: 1,
      unanswered: 1,
      pairingCertain: false,
    });
    // One ask went unanswered, so one original violation survives — with the
    // model's own bytes on it, never a paraphrase.
    expect(merged.violations).toHaveLength(1);
    expect(merged.violations[0].raw).toContain("takes the aisle when flying with kids");
    expect(merged.quarantine).toBe(true);
  });

  it("keeps the response-scoped verdict when the repair was prose too", () => {
    const second = parseWire("Sorry about that — I will try again.");
    const merged = mergeRepairRound(first, second, ask);
    expect(merged.violations.some((v) => v.scope === "response")).toBe(true);
    expect(merged.violations.filter((v) => v.scope === "line")).toHaveLength(2);
    expect(merged.records).toHaveLength(2);
  });

  it("carries skipped lines from both rounds — skipped is not deleted", () => {
    const withFence = parseWire("```\nF | 1 | a1 | 1p | 0.9 | 2026-08-01 | fine\n```");
    const second = parseWire("# heading\nF | 2 | a1 | 1p | 0.9 | 2026-08-01 | also fine");
    const merged = mergeRepairRound(withFence, second, buildRepairAsk(withFence));
    expect(merged.skipped.length).toBe(withFence.skipped.length + second.skipped.length);
    expect(merged.skipped.every((s) => typeof s.raw === "string")).toBe(true);
  });

  it("summarises surviving violations one line each for the quarantine row", () => {
    expect(violationSummary(first.violations)).toBe(
      "line 2 — bad_enum: attribution=zz\nline 4 — unknown_tag: no tag in the closed vocabulary: \"U\"",
    );
  });
});

describe("a clean round one", () => {
  it("needs no repair and is not quarantined", () => {
    const outcome = singleRound(parseWire("F | 1 | a1 | 1p | 0.9 | 2026-08-01 | fine"));
    expect(outcome.records).toHaveLength(1);
    expect(outcome.violations).toHaveLength(0);
    expect(outcome.quarantine).toBe(false);
  });
});
