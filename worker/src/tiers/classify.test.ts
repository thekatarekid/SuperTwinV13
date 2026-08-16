// ===========================================================================
// Business-channel heuristics (arch §9.3; evals B-023…B-032, B-038).
//
// The point of these cases is as much what the code REFUSES to decide as what
// it decides: a mixed channel is `ambiguous` and goes to P-TI1, because a
// heuristic that guesses to save a haiku call is the expensive kind of cheap.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { classifyBusinessSample, signalsFor, tierForChannelClass } from "./classify.js";

const HDFC_TX = [
  "Rs.3398.23 debited from a/c XX4412 on 11-Aug toward Axis Max Life premium",
  "Your card ending 8891 was used for Rs.1,499 at ACT FIBERNET",
  "Statement for Aug is ready. Total due Rs.24,110 by 05-Sep",
  "Your order OD4419283746 has been delivered",
];

const PROMO = [
  "FLAT 60% OFF on your first 3 orders this weekend! Use code WEEKEND60",
  "Limited time offer - 40% off on everything. Shop now",
  "We miss you! Here's Rs.150 off your next order",
  "Biggest sale of the year starts tonight. Unsubscribe to stop these",
];

describe("transactional channels", () => {
  it("reads a bank's sample as tx and hands the tier back as T2", () => {
    const result = classifyBusinessSample(HDFC_TX);
    expect(result.verdict).toBe("tx");
    expect(result.rule).toBe("business_tx_code");
    expect(tierForChannelClass("tx")).toBe("T2");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("reads the specific tells §9.3 names", () => {
    expect(signalsFor("Your order OD44192 has been delivered").strongTx).toContain("id");
    expect(signalsFor("Rs.3398 debited from a/c XX4412").strongTx).toContain("masked_account");
    expect(signalsFor("Total due Rs.24,110 by 05-Sep").strongTx).toContain("due_date");
    expect(signalsFor("Your appointment on 12 Aug is confirmed").strongTx).toContain("tx_keyword");
  });
});

describe("promotional channels", () => {
  it("reads a campaign sample as pm and hands the tier back as T4", () => {
    const result = classifyBusinessSample(PROMO);
    expect(result.verdict).toBe("pm");
    expect(result.rule).toBe("business_pm_code");
    expect(tierForChannelClass("pm")).toBe("T4");
  });

  it("does not let a rupee figure inside an offer masquerade as a transaction", () => {
    // "Rs.150 off your next order" is a campaign with a number in it.
    const signals = signalsFor("We miss you! Here's Rs.150 off your next order");
    expect(signals.weakTx).toContain("amount");
    expect(signals.strongTx).toEqual([]);
    expect(signals.verdict).toBe("pm");
  });

  it("counts an amount on its own as a weak transactional tell", () => {
    expect(signalsFor("Rs.499 received").verdict).toBe("tx");
  });
});

describe("what code refuses to decide", () => {
  it("hands a mixed channel to P-TI1 rather than guessing", () => {
    const mixed = [...PROMO.slice(0, 3), "Your order from Meghana Foods has been delivered"];
    const result = classifyBusinessSample(mixed);
    expect(result.verdict).toBe("ambiguous");
    expect(result.rule).toBe("business_ambiguous");
    expect(result.confidence).toBeNull();
    expect(result.counts.tx).toBe(1);
    expect(result.counts.pm).toBe(3);
  });

  it("hands over a sample that says nothing either way", () => {
    const result = classifyBusinessSample(["Hi", "Thanks for reaching out", "Noted"]);
    expect(result.verdict).toBe("ambiguous");
  });

  it("hands over an empty sample instead of inventing a tier", () => {
    expect(classifyBusinessSample([]).verdict).toBe("ambiguous");
    expect(classifyBusinessSample(["", "   "]).verdict).toBe("ambiguous");
  });
});
