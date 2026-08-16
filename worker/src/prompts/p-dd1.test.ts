import { beforeEach, describe, expect, it } from "vitest";

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { packPrompt } from "../wire/pack.js";
import { resetLegendCache } from "./legend.js";
import {
  DD1_STATES,
  P_DD1,
  P_DD1_SYSTEM,
  buildDd1Prompt,
  buildDd1System,
  buildDd1User,
  chunkDd1Loops,
  dd1Accounts,
  dd1StateCode,
  dd1SendOptions,
  parseDd1Response,
  type Dd1Loop,
} from "./p-dd1.js";

beforeEach(() => {
  resetLegendCache();
});

/** §12.9's own USER block, loop for loop. */
export const LOOPS: Dd1Loop[] = [
  {
    loopId: "l1",
    intent: "Send Pranjali the Goa villa link",
    ownerId: "self",
    counterpartyId: "e-pranjali",
    due: "12 Aug",
    statedAt: "2026-08-12T19:40:00.000Z",
  },
  {
    loopId: "l2",
    intent: "Confirm villa to Rohan",
    ownerId: "self",
    counterpartyId: "e-rohan",
    due: "20 Aug",
    statedAt: "2026-08-10T09:00:00.000Z",
  },
];

/** §12.9's transcript, packed by the real packer against a shared table. */
export function packTranscript(table: AliasTable): string {
  const packed = packPrompt(
    {
      tz: "Asia/Kolkata",
      entities: [
        { id: "e-pranjali", name: "Pranjali" },
        { id: "e-rohan", name: "Rohan" },
      ],
      streams: [
        { id: "s1", name: "Pranjali", kind: "dm", participantIds: ["self", "e-pranjali"] },
        { id: "s2", name: "Rohan", kind: "dm", participantIds: ["self", "e-rohan"] },
      ],
      events: [
        {
          id: "ev1",
          streamId: "s1",
          at: "2026-08-12T15:34:00.000Z",
          speakerId: "self",
          text: "here — https://booking.com/villa-amara",
        },
        {
          id: "ev2",
          streamId: "s1",
          at: "2026-08-12T15:36:00.000Z",
          speakerId: "e-pranjali",
          text: "ooh this looks great",
        },
        {
          id: "ev3",
          streamId: "s2",
          at: "2026-08-12T16:40:00.000Z",
          speakerId: "self",
          text: "will confirm the villa by tomorrow for sure",
        },
      ],
    },
    { table },
  );
  if (!packed.ok) throw new Error("pack failed");
  return packed.text;
}

export function dd1Fixture() {
  const table = createAliasTable();
  const transcript = packTranscript(table);
  return buildDd1Prompt(LOOPS, transcript, table);
}

describe("P-DD1 settings", () => {
  it("transcribes §12.9 — haiku-4-5, 1 turn, thinking off, 90 s, 30 loops, 1500 out", () => {
    expect(P_DD1.model).toBe("haiku-4-5");
    expect(P_DD1.turns).toBe(1);
    expect(P_DD1.thinking).toBe("off");
    expect(P_DD1.tools).toBe("none");
    expect(P_DD1.timeoutSeconds).toBe(90);
    expect(P_DD1.maxLoopsPerCall).toBe(30);
    expect(P_DD1.maxOutputTokens).toBe(1_500);
    expect(P_DD1.onCriticalPath).toBe(false);
  });

  it("fixes the send shape so no call site can raise it", () => {
    expect(dd1SendOptions()).toEqual({
      model: "haiku-4-5",
      maxTurns: 1,
      timeoutMs: 90_000,
      maxOutputTokens: 1_500,
      thinkingBudget: "off",
      plainCompletion: true,
    });
  });

  it("carries §12.9's evidence rules verbatim", () => {
    expect(P_DD1_SYSTEM).toContain("Intent to do it later is NOT done.");
    expect(P_DD1_SYSTEM).toContain("Never mark done on a guess.");
    expect(P_DD1_SYSTEM).toContain("Count only evidence occurring\n  AFTER the loop was stated.");
  });

  it("prefixes the shared legend and renders the S template", () => {
    const system = buildDd1System();
    expect(system).toContain("WIRE FORMAT — STW-2");
    expect(system).toContain("S | <loop> | <state> | <event> | <confidence> | <quote>");
    expect(system.endsWith(P_DD1_SYSTEM)).toBe(true);
  });

  it("caps a batch at 30 loops", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ loopId: `l${i}`, intent: "x" }));
    expect(chunkDd1Loops(many).map((c) => c.length)).toEqual([30, 30, 10]);
  });
});

describe("P-DD1 user block", () => {
  it("prints the loops first, then the packed transcript", () => {
    const built = dd1Fixture();
    const lines = built.user.split("\n");
    expect(lines[0]).toBe(
      "t1 Send Pranjali the Goa villa link | self | a1 | due 12 Aug | said 2026-08-12T19:40",
    );
    expect(lines[1]).toBe("t2 Confirm villa to Rohan | self | a2 | due 20 Aug | said 2026-08-10T09:00");
    expect(built.user).toContain("#C c1 Pranjali | dm | self,a1");
    expect(built.user).toContain("here — https://booking.com/villa-amara");
  });

  it("shares one alias table with the transcript, so events resolve", () => {
    const built = dd1Fixture();
    expect(built.aliases).toEqual({ l1: "t1", l2: "t2" });
    expect(built.table.resolve("1").resolved?.id).toBe("ev1");
  });

  it("never leaks a real id", () => {
    const built = dd1Fixture();
    expect(built.user).not.toContain("e-pranjali");
    expect(built.user).not.toContain("ev1");
  });

  it("tolerates an empty transcript without a trailing blank line", () => {
    const table = createAliasTable();
    expect(buildDd1User(LOOPS, "", table).split("\n")).toHaveLength(2);
  });
});

describe("P-DD1 answer", () => {
  /** §12.9's EXPECTED block. */
  const EXPECTED = [
    "S|t1|dn|1|0.95|here — https://booking.com/villa-amara",
    "S|t2|op|-|0.9|",
  ].join("\n");

  it("parses the doc's own answer — one done with evidence, one still open", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response(EXPECTED, built.table, LOOPS);
    expect(answer.findings.map((f) => [f.loopId, f.code, f.eventId])).toEqual([
      ["l1", "dn", "ev1"],
      ["l2", "op", null],
    ]);
    expect(answer.findings[0].quote).toBe("here — https://booking.com/villa-amara");
    expect(answer.findings[0].confidence).toBe(0.95);
    expect(answer.missing).toEqual([]);
    expect(answer.violations).toEqual([]);
  });

  it("keeps the model's line byte-for-byte", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response(EXPECTED, built.table, LOOPS);
    expect(answer.findings[0].raw).toBe("S|t1|dn|1|0.95|here — https://booking.com/villa-amara");
  });

  it("reports an out-of-roster loop alias instead of guessing", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response("S|t9|dn|1|0.9|nope", built.table, LOOPS);
    expect(answer.findings).toHaveLength(0);
    expect(answer.unresolved[0].alias).toBe("t9");
    expect(answer.missing).toEqual(["l1", "l2"]);
  });

  it("keeps a finding whose cited event does not resolve, with eventId null", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response("S|t1|dn|zz9|0.9|invented", built.table, LOOPS);
    expect(answer.findings).toHaveLength(1);
    expect(answer.findings[0].eventId).toBeNull();
    expect(answer.findings[0].eventAlias).toBe("zz9");
  });

  it("keeps a second answer for the same loop as a duplicate", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response("S|t1|op|-|0.9|\nS|t1|dn|1|0.9|later", built.table, LOOPS);
    expect(answer.findings.map((f) => f.code)).toEqual(["op"]);
    expect(answer.duplicates.map((f) => f.code)).toEqual(["dn"]);
  });

  it("discards nothing — every line lands in a bucket (R-040)", () => {
    const built = dd1Fixture();
    const answer = parseDd1Response(
      `${EXPECTED}\nJ|t1|ap|h|not this call\nprose the model added\nS|t1`,
      built.table,
      LOOPS,
    );
    expect(dd1Accounts(answer).balanced).toBe(true);
  });

  it("knows all four answers, and none of them is a loop state named possibly_done", () => {
    expect(DD1_STATES).toEqual(["done", "possibly", "dropped", "still_open"]);
    expect(DD1_STATES.map((s) => dd1StateCode(s))).toEqual(["dn", "ps", "dr", "op"]);
    expect(DD1_STATES as readonly string[]).not.toContain("possibly_done");
  });
});
