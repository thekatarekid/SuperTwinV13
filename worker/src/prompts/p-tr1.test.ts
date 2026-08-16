import { beforeEach, describe, expect, it } from "vitest";

import { createAliasTable } from "../wire/aliases.js";
import { resetLegendCache } from "./legend.js";
import {
  P_TR1,
  P_TR1_SYSTEM,
  TRIAGE_CLASSES,
  buildTr1Prompt,
  buildTr1System,
  buildTr1User,
  chunkLoops,
  parseTr1Response,
  tr1Accounts,
  tr1SendOptions,
  triageCode,
  type Tr1Loop,
} from "./p-tr1.js";

beforeEach(() => {
  resetLegendCache();
});

const TODAY = "2026-08-15";
const NOW = "2026-08-15T09:00:00.000Z";

/** §12.8's own USER block, loop for loop. */
const LOOPS: Tr1Loop[] = [
  {
    loopId: "l1",
    intent: "Send Pranjali the Goa villa link",
    origin: "explicit",
    ownerId: "self",
    counterpartyId: "e-pranjali",
    dueUtc: "2026-08-16",
    stake: "low",
    statedAt: "2026-08-12T19:40:00.000Z",
  },
  {
    loopId: "l2",
    intent: "Pranjali's broadband renews",
    origin: "explicit",
    ownerId: "e-pranjali",
    dueUtc: "2026-08-28",
    recurrence: "monthly",
    stake: "medium",
    statedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    loopId: "l3",
    intent: "Compare broadband plans",
    origin: "implicit",
    ownerId: "self",
    stake: "medium",
    statedAt: "2026-08-14T10:00:00.000Z",
  },
  {
    loopId: "l4",
    intent: "Summarise the rent agreement PDF",
    origin: "explicit",
    ownerId: "self",
    stake: "low",
    statedAt: "2026-08-13T10:00:00.000Z",
  },
  {
    loopId: "l5",
    intent: "Book the Ratlam tickets",
    origin: "explicit",
    ownerId: "self",
    dueUtc: "2024-11-02",
    stake: "medium",
    statedAt: "2024-10-30T10:00:00.000Z",
  },
  {
    loopId: "l6",
    intent: "Renew health insurance policy",
    origin: "explicit",
    ownerId: "self",
    dueUtc: "2025-03-15",
    recurrence: "annual",
    stake: "high",
    statedAt: "2025-03-01T10:00:00.000Z",
  },
];

function prompt() {
  return buildTr1Prompt(LOOPS, createAliasTable(), { today: TODAY, now: NOW });
}

describe("P-TR1 settings", () => {
  it("transcribes §12.8 — haiku-4-5, 1 turn, thinking off, 90 s, 50 loops, 2000 out", () => {
    expect(P_TR1.model).toBe("haiku-4-5");
    expect(P_TR1.turns).toBe(1);
    expect(P_TR1.thinking).toBe("off");
    expect(P_TR1.tools).toBe("none");
    expect(P_TR1.timeoutSeconds).toBe(90);
    expect(P_TR1.maxLoopsPerCall).toBe(50);
    expect(P_TR1.maxOutputTokens).toBe(2_000);
    expect(P_TR1.onCriticalPath).toBe(false);
  });

  it("fixes the send shape so no call site can raise it", () => {
    expect(tr1SendOptions()).toEqual({
      model: "haiku-4-5",
      maxTurns: 1,
      timeoutMs: 90_000,
      maxOutputTokens: 2_000,
      thinkingBudget: "off",
      plainCompletion: true,
    });
  });

  it("carries §12.8's three ALWAYS/NEVER rules verbatim", () => {
    expect(P_TR1_SYSTEM).toContain("origin im is ALWAYS ap or cx. Never au.");
    expect(P_TR1_SYSTEM).toContain("owner not self is ALWAYS cx.");
    expect(P_TR1_SYSTEM).toContain("Past due AND no recurrence → cx. It is history.");
    expect(P_TR1_SYSTEM).toContain("Torn between au and ap → choose ap.");
  });

  it("prefixes the shared legend, and the legend renders the J.triage template", () => {
    const system = buildTr1System();
    expect(system).toContain("WIRE FORMAT — STW-2");
    expect(system).toContain("J | <loop> | <class> | <urgency> | <reason>");
    expect(system.endsWith(P_TR1_SYSTEM)).toBe(true);
  });

  it("caps a batch at 50 loops", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ loopId: `l${i}`, intent: "x" }));
    expect(chunkLoops(many).map((c) => c.length)).toEqual([50, 50, 20]);
  });
});

describe("P-TR1 user block", () => {
  it("opens with SELF and TODAY", () => {
    expect(prompt().user.split("\n")[0]).toBe("SELF self   TODAY 2026-08-15");
  });

  it("prints one line per loop, aliased, with owner and counterparty", () => {
    const built = prompt();
    const lines = built.user.split("\n");
    expect(lines[1]).toBe(
      "t1 Send Pranjali the Goa villa link | ex | self | a1 | due 2026-08-16 | rec - | l",
    );
    expect(built.aliases.l1).toBe("t1");
  });

  it("gives a recurring loop its projected NEXT occurrence — the t5/t6 tell", () => {
    const lines = prompt().user.split("\n");
    // t5: past due, no recurrence. Dead.
    expect(lines[5]).toContain("due 2024-11-02 | rec -");
    // t6: past due, annual, next occurrence in the future. Live.
    expect(lines[6]).toContain("rec annual next 2027-03-15");
  });

  it("never leaks a real id into the prompt", () => {
    const built = prompt();
    expect(built.user).not.toContain("e-pranjali");
    expect(built.user).not.toContain("l1");
  });

  it("buildTr1User is stable — the same loops render the same bytes", () => {
    expect(buildTr1User(LOOPS, createAliasTable(), { today: TODAY, now: NOW })).toBe(
      buildTr1User(LOOPS, createAliasTable(), { today: TODAY, now: NOW }),
    );
  });
});

describe("P-TR1 answer", () => {
  /** §12.8's EXPECTED block. */
  const EXPECTED = [
    "J|t1|ap|h|outward-facing message to a person",
    "J|t2|cx|m|owned by Pranjali, not the user",
    "J|t3|ap|l|implicit inference, never auto",
    "J|t4|au|l|read-and-summarise, nothing leaves the device",
    "J|t5|cx|l|past due, no recurrence, historical",
    "J|t6|ap|m|recurring obligation with a future next occurrence",
  ].join("\n");

  it("parses the doc's own answer into six verdicts, in order", () => {
    const built = prompt();
    const answer = parseTr1Response(EXPECTED, built.table, LOOPS);
    expect(answer.verdicts.map((v) => [v.loopId, v.code])).toEqual([
      ["l1", "ap"],
      ["l2", "cx"],
      ["l3", "ap"],
      ["l4", "au"],
      ["l5", "cx"],
      ["l6", "ap"],
    ]);
    expect(answer.missing).toEqual([]);
    expect(answer.violations).toEqual([]);
    expect(answer.verdicts[3].reason).toBe("read-and-summarise, nothing leaves the device");
  });

  it("keeps the model's line byte-for-byte", () => {
    const built = prompt();
    const answer = parseTr1Response(EXPECTED, built.table, LOOPS);
    expect(answer.verdicts[0].raw).toBe("J|t1|ap|h|outward-facing message to a person");
  });

  it("reports an out-of-roster alias instead of guessing (§5.8.6)", () => {
    const built = prompt();
    const answer = parseTr1Response("J|t99|ap|h|who?", built.table, LOOPS);
    expect(answer.verdicts).toHaveLength(0);
    expect(answer.unresolved.map((v) => v.alias)).toEqual(["t99"]);
    expect(answer.missing).toHaveLength(LOOPS.length);
  });

  it("keeps a second answer for the same loop as a duplicate, in order", () => {
    const built = prompt();
    const answer = parseTr1Response("J|t1|ap|h|first\nJ|t1|cx|l|second", built.table, LOOPS);
    expect(answer.verdicts.map((v) => v.code)).toEqual(["ap"]);
    expect(answer.duplicates.map((v) => v.code)).toEqual(["cx"]);
  });

  it("discards nothing — every line lands in a bucket (R-040)", () => {
    const built = prompt();
    const answer = parseTr1Response(
      `${EXPECTED}\nD|n1|prj|one|-|0.9|not this call\nnonsense line\nJ|t1`,
      built.table,
      LOOPS,
    );
    const accounts = tr1Accounts(answer);
    expect(accounts.balanced).toBe(true);
    expect(accounts.seen).toBeGreaterThan(6);
  });

  it("round-trips every triage class through the wire enum", () => {
    expect(TRIAGE_CLASSES.map((c) => triageCode(c))).toEqual(["au", "ap", "cx"]);
  });
});
