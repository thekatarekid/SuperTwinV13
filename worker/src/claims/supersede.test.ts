// ===========================================================================
// Precedence and supersession (build item 3.3, arch §11.6; evals R-016..027).
//
// The §12.7 case is the one to keep staring at: B arrives second, was SAID
// five months earlier, and must land as the predecessor. Every test here poses
// the pair BOTH ways round — stored older / stored newer — because a rule that
// only holds in one arrival order is the bug this module exists to prevent.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  activeVersion,
  isClosed,
  orderVersions,
  planSupersession,
  plainInsertPlan,
  precedenceOf,
  predecessors,
  type ClaimVersionLike,
} from "./supersede.js";

const NOW = "2026-08-15T12:00:00.000Z";

function v(id: string, statedAt: string, extra: Partial<ClaimVersionLike> = {}): ClaimVersionLike {
  return { id, claimKey: "k", statedAt, ...extra };
}

describe("activeVersion", () => {
  it("is the greatest stated_at that is not closed", () => {
    const set = [v("c1", "2026-03-02"), v("c3", "2026-08-11"), v("c2", "2026-05-01")];
    expect(activeVersion(set, NOW)?.id).toBe("c3");
  });

  it("skips a version another version closed", () => {
    const set = [v("c1", "2026-03-02"), v("c2", "2026-08-11", { closedBy: "c3" })];
    expect(activeVersion(set, NOW)?.id).toBe("c1");
  });

  it("skips a version whose validity window has ended", () => {
    const set = [v("c1", "2026-03-02"), v("c2", "2026-08-11", { validTo: "2026-08-01" })];
    expect(activeVersion(set, NOW)?.id).toBe("c1");
  });

  it("keeps a window that ends in the future", () => {
    expect(activeVersion([v("c2", "2026-08-11", { validTo: "2027-01-01" })], NOW)?.id).toBe("c2");
  });

  it("breaks a stated_at tie by id descending, exactly like the view", () => {
    expect(activeVersion([v("c1", "2026-08-11"), v("c2", "2026-08-11")], NOW)?.id).toBe("c2");
  });

  it("is null when every version is closed", () => {
    expect(activeVersion([v("c1", "2026-03-02", { closedBy: "c2" })], NOW)).toBeNull();
    expect(activeVersion([], NOW)).toBeNull();
  });

  it("does not care what order the versions were handed to it", () => {
    const set = [v("c1", "2026-03-02"), v("c3", "2026-08-11"), v("c2", "2026-05-01")];
    const forwards = activeVersion(set, NOW)?.id;
    const backwards = activeVersion([...set].reverse(), NOW)?.id;
    expect(forwards).toBe(backwards);
    expect(orderVersions(set).map((x) => x.id)).toEqual(["c3", "c2", "c1"]);
  });

  it("reports the rest as predecessors", () => {
    const set = [v("c1", "2026-03-02"), v("c2", "2026-08-11")];
    expect(predecessors(set, NOW).map((x) => x.id)).toEqual(["c1"]);
  });

  it("isClosed reads closed_by and the window, and nothing else", () => {
    expect(isClosed(v("c1", "2026-01-01"), NOW)).toBe(false);
    expect(isClosed(v("c1", "2026-01-01", { closedBy: "c2" }), NOW)).toBe(true);
    expect(isClosed(v("c1", "2026-01-01", { validTo: "2026-01-02" }), NOW)).toBe(true);
  });
});

describe("precedenceOf", () => {
  it("says the incoming one is later when it was SAID later", () => {
    expect(precedenceOf(v("a", "2026-03-02"), v("b", "2026-08-11"))).toBe("incoming_later");
  });

  it("says the STORED one is later when the incoming one was said earlier", () => {
    expect(precedenceOf(v("a", "2026-08-11"), v("b", "2026-03-02"))).toBe("stored_later");
  });
});

describe("planSupersession", () => {
  /** §12.7: A stored, said 2026-08-11. B incoming, said 2026-03-02. */
  const stored = v("clm_a", "2026-08-11");
  const incoming = v("clm_b", "2026-03-02");

  it("contradiction: the EARLIER-said claim closes, whichever side it arrived on", () => {
    const plan = planSupersession({
      stored,
      incoming,
      relation: "contradiction",
      validTo: "2026-09-01",
      later: "A",
    });
    expect(plan.incomingWins).toBe(false);
    expect(plan.laterId).toBe("clm_a");
    expect(plan.close).toEqual({
      id: "clm_b",
      closedBy: "clm_a",
      closedReason: "contradiction",
      validTo: "2026-09-01",
    });
    expect(plan.action).toBe("supersede");
  });

  it("the mirror case — the incoming claim IS newer — closes the stored one", () => {
    const plan = planSupersession({
      stored: v("clm_a", "2026-03-02"),
      incoming: v("clm_b", "2026-08-11"),
      relation: "contradiction",
    });
    expect(plan.incomingWins).toBe(true);
    expect(plan.close).toMatchObject({ id: "clm_a", closedBy: "clm_b" });
  });

  it("falls back to the later claim's stated_at when no valid_to was implied", () => {
    const plan = planSupersession({ stored, incoming, relation: "contradiction" });
    expect(plan.close?.validTo).toBe("2026-08-11");
  });

  it("refinement closes the earlier claim too, with its own reason", () => {
    const plan = planSupersession({ stored, incoming, relation: "refinement" });
    expect(plan.close).toMatchObject({ id: "clm_b", closedReason: "refinement" });
  });

  it("duplicate reinforces and closes nothing", () => {
    const plan = planSupersession({ stored, incoming, relation: "duplicate" });
    expect(plan.action).toBe("reinforce");
    expect(plan.close).toBeNull();
    expect(plan.asksUser).toBe(false);
  });

  it("distinct inserts and closes nothing", () => {
    const plan = planSupersession({ stored, incoming, relation: "distinct" });
    expect(plan.action).toBe("insert");
    expect(plan.close).toBeNull();
  });

  it("unsure inserts AND owes the user a question", () => {
    const plan = planSupersession({ stored, incoming, relation: "unsure" });
    expect(plan.action).toBe("insert");
    expect(plan.asksUser).toBe(true);
  });

  it("records a disagreement with the model's `later` instead of following it", () => {
    const plan = planSupersession({ stored, incoming, relation: "contradiction", later: "B" });
    // The model said B is later; stated_at says A is. stated_at wins.
    expect(plan.laterId).toBe("clm_a");
    expect(plan.laterDisagrees).toBe(true);
  });

  it("is arrival-order independent: swapping the labels swaps nothing that matters", () => {
    const forwards = planSupersession({ stored, incoming, relation: "contradiction" });
    const backwards = planSupersession({ stored: incoming, incoming: stored, relation: "contradiction" });
    expect(backwards.close).toEqual(forwards.close);
    expect(backwards.laterId).toBe(forwards.laterId);
  });

  it("resolves a same-instant pair the way the view would", () => {
    const plan = planSupersession({
      stored: v("clm_a", "2026-08-11"),
      incoming: v("clm_b", "2026-08-11"),
      relation: "contradiction",
    });
    expect(plan.laterId).toBe("clm_b");
    expect(plan.close?.id).toBe("clm_a");
  });
});

describe("plainInsertPlan", () => {
  it("is an insert that closes nothing and asks nobody", () => {
    const plan = plainInsertPlan(v("clm_new", "2026-08-11"));
    expect(plan).toMatchObject({ action: "insert", close: null, asksUser: false, verdict: null });
  });
});
