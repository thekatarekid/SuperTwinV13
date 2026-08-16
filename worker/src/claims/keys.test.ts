// ===========================================================================
// Claim and loop identity (build item 3.3, arch §11.6; evals R-032..035).
//
// Two properties are load-bearing and both are tested here: normalisation
// merges the same claim said twice (so a reinforcement is possible at all),
// and it never merges two DIFFERENT claims — order, tense and negation all
// survive it. The loop key's ban on `space_id`/`arc_id` is asserted against
// the function's own behaviour, not against a comment.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  ABSENT_PART,
  claimKey,
  claimVersionId,
  KEY_STOPWORDS,
  loopIdForKey,
  loopKey,
  normalizeIntent,
  normalizeKeyText,
  normalizePredicate,
  partyKeyPart,
} from "./keys.js";

describe("normalizeKeyText", () => {
  it("lowercases, unaccents, strips punctuation and collapses whitespace", () => {
    expect(normalizeKeyText("  Lives in  Kôramangala!! ")).toBe("lives in koramangala");
  });

  it("drops articles and possessives but nothing else", () => {
    expect(normalizeKeyText("my flat in the Koramangala")).toBe("flat in koramangala");
    for (const word of KEY_STOPWORDS) expect(normalizeKeyText(word)).toBe("");
  });

  it("keeps word ORDER — opposites must not collapse into one key", () => {
    expect(normalizeKeyText("prefers tea over coffee")).not.toBe(
      normalizeKeyText("prefers coffee over tea"),
    );
  });

  it("keeps tense — past and present are different claims (§12.7)", () => {
    expect(normalizeKeyText("lived in Ratlam")).not.toBe(normalizeKeyText("lives in Ratlam"));
  });

  it("keeps negation", () => {
    expect(normalizeKeyText("does not drink coffee")).not.toBe(normalizeKeyText("does drink coffee"));
  });

  it("is total: null, undefined and non-strings are the empty stem", () => {
    expect(normalizeKeyText(null)).toBe("");
    expect(normalizeKeyText(undefined)).toBe("");
    expect(normalizeKeyText(42 as unknown as string)).toBe("");
  });

  it("predicate and intent share the one normaliser", () => {
    expect(normalizePredicate("The Rent!")).toBe(normalizeIntent("the rent"));
  });
});

describe("partyKeyPart", () => {
  it("prefers the real id", () => {
    expect(partyKeyPart("a1", "Rahul")).toBe("a1");
  });

  it("falls back to a MARKED hint stem — a name is never an id", () => {
    expect(partyKeyPart(null, "Pranjali's landlord")).toBe("+pranjalis landlord");
    expect(partyKeyPart(null, "Pranjalis  Landlord")).toBe("+pranjalis landlord");
  });

  it("is the absent marker when there is neither", () => {
    expect(partyKeyPart(null, null)).toBe(ABSENT_PART);
    expect(partyKeyPart("   ", "")).toBe(ABSENT_PART);
  });
});

describe("claimKey", () => {
  const base = { kind: "fact", subjectId: "a1", predicate: "Lives in Koramangala." };

  it("is sha1 — 40 lowercase hex", () => {
    expect(claimKey(base)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is stable across punctuation, case and articles", () => {
    expect(claimKey({ ...base, predicate: "lives in the koramangala" })).toBe(
      claimKey({ ...base, predicate: "Lives in Koramangala." }),
    );
  });

  it("separates kind, subject and predicate", () => {
    expect(claimKey({ ...base, kind: "preference" })).not.toBe(claimKey(base));
    expect(claimKey({ ...base, subjectId: "a2" })).not.toBe(claimKey(base));
    expect(claimKey({ ...base, predicate: "lives in Indiranagar" })).not.toBe(claimKey(base));
  });

  it("cannot be spoofed across the separator", () => {
    expect(claimKey({ kind: "fact", subjectId: "a1|x", predicate: "y" })).not.toBe(
      claimKey({ kind: "fact", subjectId: "a1", predicate: "x|y" }),
    );
  });
});

describe("claimVersionId", () => {
  it("is derived from (key, stated_at, text) — a replay reproduces it", () => {
    const key = claimKey({ kind: "fact", subjectId: "a1", predicate: "lives in Koramangala" });
    const id = claimVersionId(key, "2026-03-02T10:00:00Z", "Lives in Koramangala.");
    expect(id).toBe(claimVersionId(key, "2026-03-02T10:00:00Z", "Lives in Koramangala."));
    expect(id).toMatch(/^clm_[0-9a-f]{16}$/);
  });

  it("differs when it was SAID at a different time", () => {
    const key = "k";
    expect(claimVersionId(key, "2026-03-02T10:00:00Z", "x")).not.toBe(
      claimVersionId(key, "2026-08-11T10:00:00Z", "x"),
    );
  });
});

describe("loopKey", () => {
  const base = { ownerId: "a1", counterpartyId: "a2", intent: "send the rent receipt" };

  it("is sha1 over owner, counterparty and the normalised intent", () => {
    expect(loopKey(base)).toMatch(/^[0-9a-f]{40}$/);
    expect(loopKey({ ...base, intent: "Send the RENT receipt!" })).toBe(loopKey(base));
  });

  it("swapping the parties is a different loop", () => {
    expect(loopKey({ ...base, ownerId: "a2", counterpartyId: "a1" })).not.toBe(loopKey(base));
  });

  it("ignores anything that is not owner, counterparty or intent — no space_id, no arc_id", () => {
    const withCircularFields = {
      ...base,
      space_id: "n9",
      arc_id: "n9",
      spaceId: "n9",
      arcId: "n9",
    } as unknown as typeof base;
    expect(loopKey(withCircularFields)).toBe(loopKey(base));
  });

  it("still keys a loop whose parties are only hints", () => {
    const key = loopKey({ ownerHint: "the landlord", counterpartyHint: "me", intent: "rent" });
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(key).not.toBe(loopKey({ intent: "rent" }));
  });

  it("mints a derived id", () => {
    expect(loopIdForKey(loopKey(base))).toBe(`lp_${loopKey(base).slice(0, 16)}`);
  });
});
