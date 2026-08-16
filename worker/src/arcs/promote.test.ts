// ===========================================================================
// Promotion rules (§11.3, item 3.6) — the pure half.
//
//   P-001..P-006  commitment route
//   P-007..P-012  reference route — the case a loop-only system cannot see
//   P-013..P-018  recurrence route
//   P-019..P-022  the recurrence bars, and what fails them
//   P-023..P-025  the user route
//   P-026..P-029  status derivation, archived is still retrievable
//   P-050         promotion_reason recorded and renderable
//
// Plus the three GLOBAL acceptance targets, measured against a ~3,000-event
// synthetic corpus: ≤45 spaces, >90% justified by a route, and ZERO spaces
// that are another person's life.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  REC_LIVE_CAP,
  REC_MIN_DISTINCT_DAYS,
  REC_MIN_EPISODES,
  REC_MIN_SPAN_DAYS,
  SPACE_QUIET_WEEKS,
  applyRecurrenceCap,
  deriveStatus,
  evaluateRoutes,
  explainPromotion,
  partyGate,
  promotionVerdict,
  recurrenceCounts,
  type PromotionEpisode,
  type PromotionInput,
  type PromotionVerdict,
} from "./promote.js";

const SELF = "ent_self";
const OTHER = "ent_a1";
const THIRD = "ent_a2";
const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const DAY = 86_400_000;

const session = { selfEntityId: SELF, participantEntityIds: [SELF, OTHER] };

function input(over: Partial<PromotionInput> = {}): PromotionInput {
  return { arcId: "arc1", session, now: NOW, ...over };
}

/** `n` open loops, all of them mine. */
function openLoops(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    state: "open",
    ownerId: SELF,
    counterpartyId: OTHER,
  }));
}

function episodesEvery(days: number, count: number, startDaysAgo: number): PromotionEpisode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ep${i}`,
    startedAt: new Date(NOW - startDaysAgo * DAY + i * days * DAY).toISOString(),
    entityIds: [SELF, OTHER],
  }));
}

// ---- P-001..P-006 ----------------------------------------------------------

describe("commitment route (P-001..P-006)", () => {
  for (let n = 1; n <= 6; n += 1) {
    it(`an arc with ${n} open loop(s) is a space via cmt, status active`, () => {
      const v = promotionVerdict(input({ loops: openLoops(n) }));
      expect(v.promoted).toBe(true);
      expect(v.promotionReason).toBe("cmt");
      expect(v.status).toBe("active");
      expect(v.evidence.cmt.facts.open_loops).toBe(n);
    });
  }

  it("a closed loop is not a commitment", () => {
    const v = promotionVerdict(input({ loops: [{ id: "l", state: "done", ownerId: SELF, counterpartyId: OTHER }] }));
    expect(v.evidence.cmt.qualifies).toBe(false);
  });
});

// ---- P-007..P-012 ----------------------------------------------------------

describe("reference route (P-007..P-012)", () => {
  const durables: [string, string, string][] = [
    ["my flat", "ent_flat", "located_at"],
    ["car", "ent_car", "has"],
    ["policy", "ent_policy", "has"],
    ["connection", "ent_conn", "has"],
    ["account", "ent_acct", "has"],
    ["lease", "ent_lease", "has"],
  ];
  for (const [what, id, kind] of durables) {
    it(`${what} with a ${kind} relation and NO loops is a space via ref`, () => {
      const v = promotionVerdict(
        input({
          loops: [],
          anchorEntityIds: [id],
          selfEdges: [{ entityId: id, kind, status: "active", entityType: "thing" }],
          lastEvidenceAt: new Date(NOW - 3 * DAY).toISOString(),
        }),
      );
      expect(v.promoted).toBe(true);
      expect(v.promotionReason).toBe("ref");
      expect(v.status).toBe("active");
    });
  }

  it("a person is never a durable anchor", () => {
    const v = promotionVerdict(
      input({
        loops: [],
        anchorEntityIds: [OTHER],
        selfEdges: [{ entityId: OTHER, kind: "has", status: "active", entityType: "person" }],
      }),
    );
    expect(v.evidence.ref.qualifies).toBe(false);
    expect(v.promoted).toBe(false);
  });

  it("a superseded edge does not anchor anything", () => {
    const v = promotionVerdict(
      input({
        loops: [],
        anchorEntityIds: ["ent_flat"],
        selfEdges: [{ entityId: "ent_flat", kind: "located_at", status: "superseded", entityType: "place" }],
      }),
    );
    expect(v.evidence.ref.qualifies).toBe(false);
  });

  it("an edge to something that is not an anchor of THIS arc does not count", () => {
    const v = promotionVerdict(
      input({
        loops: [],
        anchorEntityIds: ["ent_other_thing"],
        selfEdges: [{ entityId: "ent_flat", kind: "has", status: "active", entityType: "place" }],
      }),
    );
    expect(v.evidence.ref.qualifies).toBe(false);
  });
});

// ---- P-013..P-022 ----------------------------------------------------------

describe("recurrence route (P-013..P-022)", () => {
  for (let extra = 0; extra <= 5; extra += 1) {
    const count = REC_MIN_EPISODES + extra;
    const weeks = 2 + extra;
    it(`${count} episodes over ${weeks} weeks on ${count} days is a space via rec`, () => {
      const spacing = Math.floor((weeks * 7) / (count - 1));
      const v = promotionVerdict(
        input({ loops: [], episodes: episodesEvery(spacing, count, weeks * 7) }),
      );
      expect(v.promoted).toBe(true);
      expect(v.promotionReason).toBe("rec");
    });
  }

  for (let i = 1; i <= 4; i += 1) {
    it(`2 episodes on 1 day with no loops stays a browsable thread (${i})`, () => {
      const ts = new Date(NOW - 3 * DAY).toISOString();
      const v = promotionVerdict(
        input({
          loops: [],
          episodes: [
            { id: "e1", startedAt: ts, entityIds: [SELF] },
            { id: "e2", startedAt: ts, entityIds: [SELF] },
          ],
        }),
      );
      expect(v.promoted).toBe(false);
      expect(v.livesOn).toBe("thread");
      expect(v.promotionReason).toBeNull();
    });
  }

  it("all four bars are required — participation is not optional", () => {
    const eps = episodesEvery(7, 4, 28).map((e) => ({ ...e, entityIds: [OTHER, THIRD] }));
    const counts = recurrenceCounts(eps, session);
    expect(counts.episodes).toBeGreaterThanOrEqual(REC_MIN_EPISODES);
    expect(counts.distinctDays).toBeGreaterThanOrEqual(REC_MIN_DISTINCT_DAYS);
    expect(counts.spanDays).toBeGreaterThanOrEqual(REC_MIN_SPAN_DAYS);
    expect(counts.userParticipated).toBe(false);
    expect(evaluateRoutes(input({ loops: [], episodes: eps })).rec.qualifies).toBe(false);
  });

  it("a 10-day span fails the two-week bar however many episodes there are", () => {
    const v = promotionVerdict(input({ loops: [], episodes: episodesEvery(2, 6, 10) }));
    expect(v.evidence.rec.qualifies).toBe(false);
  });

  it("caps the live recurrence spaces at ~10", () => {
    const verdicts: PromotionVerdict[] = [];
    const last = new Map<string, string | null>();
    for (let i = 0; i < 14; i += 1) {
      const id = `arc${String(i).padStart(2, "0")}`;
      last.set(id, new Date(NOW - i * DAY).toISOString());
      verdicts.push(
        promotionVerdict(input({ arcId: id, loops: [], episodes: episodesEvery(7, 4, 28) })),
      );
    }
    expect(verdicts.every((v) => v.promoted)).toBe(true);
    const capped = applyRecurrenceCap(verdicts, last);
    expect(capped.filter((v) => v.promoted)).toHaveLength(REC_LIVE_CAP);
    // The freshest survive; the evicted are demoted, never deleted.
    expect(capped.filter((v) => !v.promoted).map((v) => v.arcId)).toEqual([
      "arc10",
      "arc11",
      "arc12",
      "arc13",
    ]);
    expect(capped.every((v) => v.arcId !== "")).toBe(true);
  });

  it("an arc with another route is never capped", () => {
    const verdicts = [promotionVerdict(input({ arcId: "keep", loops: openLoops(1), episodes: episodesEvery(7, 4, 28) }))];
    expect(applyRecurrenceCap(verdicts, new Map(), 0)[0]!.promoted).toBe(true);
  });
});

// ---- P-023..P-025 ----------------------------------------------------------

describe("user route (P-023..P-025)", () => {
  for (let i = 1; i <= 3; i += 1) {
    it(`a pinned thread is a space via usr (${i})`, () => {
      const v = promotionVerdict(input({ loops: [], userPinned: true }));
      expect(v.promoted).toBe(true);
      expect(v.promotionReason).toBe("usr");
    });
  }

  it("a pin outlives every loop closing — the space is permanent", () => {
    const v = promotionVerdict(
      input({ loops: [{ id: "l", state: "done", ownerId: SELF, counterpartyId: OTHER }], userPinned: true }),
    );
    expect(v.promoted).toBe(true);
    expect(v.routes).toEqual(["usr"]);
  });
});

// ---- P-026..P-029, status --------------------------------------------------

describe("status derivation (P-026..P-029)", () => {
  it("≥1 open loop → active", () => {
    expect(deriveStatus(input({ loops: [...openLoops(1), { id: "x", state: "done" }] })).status).toBe("active");
  });

  it("latent only → dormant", () => {
    expect(deriveStatus(input({ loops: [{ id: "l", state: "latent" }] })).status).toBe("dormant");
  });

  for (let i = 1; i <= 4; i += 1) {
    it(`all loops done/lapsed → archived, still a promoted space (${i})`, () => {
      const v = promotionVerdict(
        input({
          wasPromoted: true,
          previousReason: "cmt",
          loops: [
            { id: "a", state: "done", ownerId: SELF, counterpartyId: OTHER },
            { id: "b", state: "lapsed", ownerId: SELF, counterpartyId: OTHER },
          ],
        }),
      );
      expect(v.status).toBe("archived");
      expect(v.promoted).toBe(true);
      expect(v.retained).toBe(true);
      expect(v.arcId).toBe("arc1");
      expect(v.promotionReason).toBe("cmt");
    });
  }

  it("a loopless reference space goes dormant after 8 weeks quiet", () => {
    const quiet = new Date(NOW - (SPACE_QUIET_WEEKS * 7 + 1) * DAY).toISOString();
    const v = promotionVerdict(
      input({
        loops: [],
        anchorEntityIds: ["ent_flat"],
        selfEdges: [{ entityId: "ent_flat", kind: "located_at", status: "active", entityType: "place" }],
        lastEvidenceAt: quiet,
      }),
    );
    expect(v.promoted).toBe(true);
    expect(v.status).toBe("dormant");
    expect(v.statusReason).toBe("loopless_quiet");
  });
});

// ---- the party wall --------------------------------------------------------

describe("party rule — zero spaces that are another person's life", () => {
  it("an arc whose loops carry no `s` is not a space by any route", () => {
    const loops = [
      { id: "l1", state: "open", ownerId: OTHER, counterpartyId: THIRD },
      { id: "l2", state: "open", ownerId: THIRD, counterpartyId: OTHER },
    ];
    const v = promotionVerdict(
      input({
        loops,
        userPinned: true,
        anchorEntityIds: ["ent_flat"],
        selfEdges: [{ entityId: "ent_flat", kind: "has", status: "active", entityType: "place" }],
        episodes: episodesEvery(7, 4, 28),
      }),
    );
    expect(v.promoted).toBe(false);
    expect(v.routes).toEqual([]);
    expect(v.livesOn).toBe("people_record");
    expect(v.party.blocked).toBe(true);
    expect(explainPromotion(v)).toContain("People record");
  });

  it("one loop with an `s` is enough to clear the wall", () => {
    const gate = partyGate(
      [
        { id: "l1", state: "open", ownerId: OTHER, counterpartyId: THIRD },
        { id: "l2", state: "open", ownerId: SELF, counterpartyId: OTHER },
      ],
      session,
    );
    expect(gate.blocked).toBe(false);
    expect(gate.involvesSelf).toBe(true);
  });

  it("no loops at all is not a party violation — ref/rec carry their own evidence", () => {
    expect(partyGate([], session).blocked).toBe(false);
    expect(partyGate([], session).reason).toBe("no_loops");
  });
});

// ---- P-050 -----------------------------------------------------------------

describe("why is this a space? (P-050)", () => {
  it("every promoted verdict records a route and renders a reason", () => {
    const v = promotionVerdict(input({ loops: openLoops(2) }));
    expect(v.promotionReason).not.toBeNull();
    const text = explainPromotion(v);
    expect(text).toContain("commitment");
    expect(text).toContain("2 open loops");
    expect(text).toContain("status active");
  });

  it("an unpromoted thread explains what it would take", () => {
    const text = explainPromotion(promotionVerdict(input({ loops: [] })));
    expect(text).toContain("no route qualified");
    expect(text).toContain("cmt:");
    expect(text).toContain("rec:");
  });

  it("promotion is an OR — every qualifying route is listed", () => {
    const v = promotionVerdict(
      input({
        loops: openLoops(1),
        userPinned: true,
        anchorEntityIds: ["ent_flat"],
        selfEdges: [{ entityId: "ent_flat", kind: "has", status: "active", entityType: "place" }],
      }),
    );
    expect(v.routes).toEqual(["cmt", "ref", "usr"]);
    expect(v.promotionReason).toBe("cmt");
    expect(explainPromotion(v)).toContain("also reference, user");
  });
});

// ---- the three global acceptance targets -----------------------------------

/**
 * A synthetic corpus in the shape the acceptance criteria describe: ~3,000
 * events over a year, a handful of genuine commitments, a few holdings, some
 * hobbies, a long tail of chatter, and — the case that matters — a pile of
 * threads that are entirely other people's business.
 */
function corpus(): { verdicts: PromotionVerdict[]; events: number } {
  const arcs: PromotionInput[] = [];
  let events = 0;
  const push = (i: PromotionInput, n: number): void => {
    arcs.push(i);
    events += n;
  };

  // 12 genuine commitments — mine, open.
  for (let i = 0; i < 12; i += 1) {
    push(input({ arcId: `cmt${i}`, loops: openLoops(1 + (i % 3)), lastEvidenceAt: new Date(NOW - i * DAY).toISOString() }), 40);
  }
  // 8 holdings — a flat, a car, policies. No loops at all.
  for (let i = 0; i < 8; i += 1) {
    push(
      input({
        arcId: `ref${i}`,
        loops: [],
        anchorEntityIds: [`ent_thing${i}`],
        selfEdges: [{ entityId: `ent_thing${i}`, kind: i % 2 ? "has" : "located_at", status: "active", entityType: "thing" }],
        lastEvidenceAt: new Date(NOW - i * DAY).toISOString(),
      }),
      25,
    );
  }
  // 18 hobbies and followed topics — only 10 may stay live.
  for (let i = 0; i < 18; i += 1) {
    push(
      input({
        arcId: `rec${String(i).padStart(2, "0")}`,
        loops: [],
        episodes: episodesEvery(7, 4, 28 + i),
        lastEvidenceAt: new Date(NOW - i * DAY).toISOString(),
      }),
      30,
    );
  }
  // 30 threads that are OTHER PEOPLE'S LIVES. Loops, evidence, recurrence —
  // everything except an `s`. Not one may become a space.
  for (let i = 0; i < 30; i += 1) {
    push(
      input({
        arcId: `theirs${i}`,
        loops: [
          { id: `t${i}a`, state: "open", ownerId: OTHER, counterpartyId: THIRD },
          { id: `t${i}b`, state: "open", ownerId: THIRD, counterpartyId: OTHER },
        ],
        episodes: episodesEvery(7, 5, 35),
        anchorEntityIds: [`ent_theirs${i}`],
        selfEdges: [],
        lastEvidenceAt: new Date(NOW - i * DAY).toISOString(),
      }),
      20,
    );
  }
  // 60 threads of ordinary chatter — nothing qualifies, nothing is lost.
  for (let i = 0; i < 60; i += 1) {
    push(
      input({
        arcId: `thread${i}`,
        loops: [],
        episodes: [{ id: `c${i}`, startedAt: new Date(NOW - i * DAY).toISOString(), entityIds: [SELF, OTHER] }],
        lastEvidenceAt: new Date(NOW - i * DAY).toISOString(),
      }),
      20,
    );
  }

  const last = new Map(arcs.map((a) => [a.arcId, a.lastEvidenceAt ?? null]));
  return { verdicts: applyRecurrenceCap(arcs.map(promotionVerdict), last), events };
}

describe("global acceptance — ~3,000 events", () => {
  const { verdicts, events } = corpus();
  const spaces = verdicts.filter((v) => v.promoted && v.status !== "archived");

  it("the corpus is the size the acceptance criteria name", () => {
    expect(events).toBeGreaterThanOrEqual(2_800);
    expect(events).toBeLessThanOrEqual(3_200);
  });

  it("≤ 45 spaces", () => {
    expect(spaces.length).toBeLessThanOrEqual(45);
    // …and not zero: a promoter that promotes nothing passes the cap for the
    // wrong reason.
    expect(spaces.length).toBeGreaterThan(20);
  });

  it("> 90% of spaces are justified by a recorded route", () => {
    const justified = spaces.filter((v) => v.promotionReason !== null).length;
    expect(justified / spaces.length).toBeGreaterThan(0.9);
    // The route is not just recorded, it is renderable.
    for (const v of spaces) expect(explainPromotion(v)).not.toBe("");
  });

  it("ZERO spaces that are another person's life", () => {
    const theirs = spaces.filter((v) => v.arcId.startsWith("theirs"));
    expect(theirs).toHaveLength(0);
    expect(verdicts.filter((v) => v.party.blocked)).toHaveLength(30);
    for (const v of verdicts.filter((v) => v.party.blocked)) {
      expect(v.livesOn).toBe("people_record");
      expect(v.promoted).toBe(false);
    }
  });

  it("nothing is deleted — every arc still has a verdict and an id", () => {
    expect(verdicts).toHaveLength(12 + 8 + 18 + 30 + 60);
    expect(new Set(verdicts.map((v) => v.arcId)).size).toBe(verdicts.length);
  });
});
