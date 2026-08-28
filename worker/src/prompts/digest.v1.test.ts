// ===========================================================================
// digest.v1 — output-contract unit tests (P1.6; the deterministic layer of
// CAT-04). No model calls: the contract is the parser, and the parser is
// code.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  DIGEST_V1_CORE,
  DIGEST_V1_SYSTEM,
  packDigestUser,
  parseDigestV1,
} from "./digest.v1.js";

const GOOD = JSON.stringify({
  summary:
    "School Batch 2014 spent the month planning a reunion. Dev announced a job change. " +
    "The group meets yearly around December. Most traffic was logistics chatter.",
  claims: [
    {
      subject: "Dev",
      text: "Dev changed jobs to Flipkart",
      evidence: [{ quote: "guys big news, joined flipkart today!" }],
    },
  ],
  recurrences: [
    {
      label: "annual batch reunion",
      cadence: "yearly",
      evidence: [{ quote: "same as every year, december reunion?" }],
    },
  ],
});

describe("parseDigestV1 · the §8.5 contract", () => {
  it("accepts a clean summary + quoted claims + recurrences", () => {
    const { result, violations } = parseDigestV1(GOOD);
    expect(violations).toEqual([]);
    expect(result?.summary).toContain("reunion");
    expect(result?.claims).toHaveLength(1);
    expect(result?.claims[0].evidence[0].quote).toContain("flipkart");
    expect(result?.recurrences[0].cadence).toBe("yearly");
  });

  it("strips episodes/tasks/spaces with named digest-inflation violations (CAT-04)", () => {
    const inflated = JSON.stringify({
      summary: "A month of chatter. Plans were made. People talked. Nothing else.",
      claims: [],
      recurrences: [],
      episodes: [{ title: "Reunion planning" }],
      tasks: [{ title: "Book venue" }],
      spaces: [{ label: "Batch reunion 2026" }],
    });
    const { result, violations } = parseDigestV1(inflated);
    expect(violations).toContain("digest-inflation:episodes");
    expect(violations).toContain("digest-inflation:tasks");
    expect(violations).toContain("digest-inflation:spaces");
    // The result carries NOTHING from the forbidden keys.
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("Book venue");
    expect(JSON.stringify(result)).not.toContain("Batch reunion 2026");
  });

  it("empty forbidden arrays are tolerated (the model saying 'none')", () => {
    const { violations } = parseDigestV1(
      JSON.stringify({ summary: "Quiet month. Nothing much. Mostly memes. Some birthdays.", claims: [], recurrences: [], episodes: [], tasks: [], spaces: [] }),
    );
    expect(violations).toEqual([]);
  });

  it("drops a claim without a verbatim quote, named", () => {
    const { result, violations } = parseDigestV1(
      JSON.stringify({
        summary: "One claim came unquoted. It does not survive. The rest is fine. Truly.",
        claims: [
          { subject: "Dev", text: "Dev moved to Pune", evidence: [] },
          { subject: "Asha", text: "Asha got married", evidence: [{ quote: "just got married!!" }] },
        ],
        recurrences: [],
      }),
    );
    expect(violations).toContain("claim-unquoted:0");
    expect(result?.claims).toHaveLength(1);
    expect(result?.claims[0].subject).toBe("Asha");
  });

  it("survives a chatty answer around the JSON, and fails closed on junk", () => {
    const chatty = `Sure! Here is the digest:\n${GOOD}\nHope that helps.`;
    expect(parseDigestV1(chatty).result?.claims).toHaveLength(1);
    const junk = parseDigestV1("I could not process this month.");
    expect(junk.result).toBeNull();
    expect(junk.violations).toEqual(["unparseable"]);
  });

  it("flags a missing summary", () => {
    const { violations } = parseDigestV1(JSON.stringify({ claims: [], recurrences: [] }));
    expect(violations).toContain("missing-summary");
  });
});

describe("packDigestUser · one stream, one month-chunk", () => {
  it("carries the stream, the range, and the predecessor summary (BND-05)", () => {
    const user = packDigestUser({
      streamKey: "batch2014@g.us",
      events: [
        { ts: "2024-03-02T10:00:00Z", actor: "contact:dev", text: "reunion when?" },
        { ts: "2024-03-28T19:00:00Z", actor: "contact:asha", text: "december, always" },
      ],
      predecessorSummary: "[part 1: reunion chatter]",
    });
    expect(user).toContain("batch2014@g.us");
    expect(user).toContain("2 messages");
    expect(user).toContain("2024-03-02T10:00:00Z → 2024-03-28T19:00:00Z");
    expect(user).toContain("PREVIOUS CHUNK: [part 1: reunion chatter]");
    expect(user).toContain("contact:asha: december, always");
  });
});

describe("versioned module invariants", () => {
  it("the system half opens with the verbatim §8.5 core", () => {
    expect(DIGEST_V1_SYSTEM.startsWith(DIGEST_V1_CORE)).toBe(true);
    expect(DIGEST_V1_CORE).toContain("No episodes,\nno tasks, no spaces. JSON only.");
  });
});
