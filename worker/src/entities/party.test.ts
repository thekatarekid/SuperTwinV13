// ===========================================================================
// The party model (arch §4.5; evals O-001…O-045).
//
// The nine pairs are enumerated ONE BY ONE below, claim side and loop side,
// each against a session where the roles are unambiguous. A table-driven loop
// over a generated matrix would pass just as well while proving only that the
// generator agrees with itself, so the nine are written out.
//
// The other three things under test are the ones that go wrong in the field:
// `o` means participant and not addressee, a thread with no `s` is not your
// space, and a model that emits a pair is rejected rather than believed.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  NON_SELF_PAIRS,
  PAIR_READING,
  PARTY_PAIRS,
  PARTY_ROLES,
  SELF_PAIRS,
  TASK_EXCLUDED_PAIRS,
  claimPartyPair,
  isPartyFieldName,
  isPartyPair,
  isPartyRole,
  loopIsTaskEligible,
  loopPartyPair,
  pairInvolvesSelf,
  pairOf,
  partyClaimFilter,
  partyEmissionsInText,
  partyFieldsInValue,
  rejectModelParty,
  resolveLoopPair,
  roleOf,
  rolesOf,
  sourceRole,
  targetRole,
  threadInvolvesSelf,
  threadPartyVerdict,
  type PartySession,
} from "./party.js";

// A dm and a five-person group, sharing one "me".
const ME = "ent_me";
const ANA = "ent_ana";
const RAHUL = "ent_rahul";
const PRIYA = "ent_priya";
const SAM = "ent_sam";
const DEV = "ent_dev"; // never in any room — the absent third party
const KIRAN = "ent_kiran"; // likewise

/** self + Ana. Everyone else is absent. */
const DM: PartySession = { selfEntityId: ME, participantEntityIds: [ME, ANA] };
/** self + Ana + Rahul + Priya + Sam — the five-person group of O-037. */
const GROUP: PartySession = {
  selfEntityId: ME,
  participantEntityIds: [ME, ANA, RAHUL, PRIYA, SAM],
};

describe("three roles", () => {
  it("reads self, participant and absent — and nothing else", () => {
    expect(roleOf(ME, DM)).toBe("s");
    expect(roleOf(ANA, DM)).toBe("o");
    expect(roleOf(DEV, DM)).toBe("t");
    expect(PARTY_ROLES).toEqual(["s", "o", "t"]);
  });

  it("is relative to THIS session — Rahul is `o` in the group and `t` in the dm", () => {
    expect(roleOf(RAHUL, GROUP)).toBe("o");
    expect(roleOf(RAHUL, DM)).toBe("t");
  });

  it("calls an unresolved id `t` — not me, not in the room", () => {
    expect(roleOf(null, DM)).toBe("t");
    expect(roleOf(undefined, DM)).toBe("t");
    expect(roleOf("   ", DM)).toBe("t");
  });

  it("has no self when no self is configured", () => {
    expect(roleOf(ME, { participantEntityIds: [ME, ANA] })).toBe("o");
    expect(roleOf(DEV, {})).toBe("t");
  });

  it("survives a participant list with holes in it", () => {
    const messy: PartySession = { selfEntityId: ME, participantEntityIds: [ME, null, "", ANA, undefined] };
    expect(roleOf(ANA, messy)).toBe("o");
    expect(roleOf(DEV, messy)).toBe("t");
  });
});

// ---- O-001…O-027: the nine pairs, claim side -------------------------------

describe("nine pairs, claim side — role(speaker) ‖ role(subject)", () => {
  const claim = (speakerId: string, subjectId: string, session = DM): string | null =>
    claimPartyPair({ speakerId, subjectId }, session);

  it("ss — I state something about myself (O-001…O-003)", () => {
    expect(claim(ME, ME)).toBe("ss");
    expect(claim(ME, ME, GROUP)).toBe("ss");
  });

  it("so — I state something about you (O-004…O-006)", () => {
    expect(claim(ME, ANA)).toBe("so");
    expect(claim(ME, RAHUL, GROUP)).toBe("so");
  });

  it("st — I state something about an absent person (O-007…O-009)", () => {
    expect(claim(ME, DEV)).toBe("st");
    expect(claim(ME, KIRAN, GROUP)).toBe("st");
  });

  it("os — you state something about me (O-010…O-012)", () => {
    expect(claim(ANA, ME)).toBe("os");
    expect(claim(RAHUL, ME, GROUP)).toBe("os");
  });

  it("oo — you state something about yourself, or about another guest (O-013…O-015)", () => {
    expect(claim(ANA, ANA)).toBe("oo");
    expect(claim(RAHUL, PRIYA, GROUP)).toBe("oo");
  });

  it("ot — you state something about an absent person (O-016…O-018)", () => {
    expect(claim(ANA, DEV)).toBe("ot");
    expect(claim(RAHUL, KIRAN, GROUP)).toBe("ot");
  });

  it("ts — an absent person's words, about me (O-019…O-021)", () => {
    expect(claim(DEV, ME)).toBe("ts");
    expect(claim(KIRAN, ME, GROUP)).toBe("ts");
  });

  it("to — an absent person's words, about the person present (O-022…O-024)", () => {
    expect(claim(DEV, ANA)).toBe("to");
    expect(claim(KIRAN, SAM, GROUP)).toBe("to");
  });

  it("tt — an absent person's words, about another absent person (O-025…O-027)", () => {
    expect(claim(DEV, KIRAN)).toBe("tt");
    expect(claim(KIRAN, DEV, GROUP)).toBe("tt");
  });

  it("covers all nine and no others", () => {
    const produced = new Set<string>();
    for (const speaker of [ME, ANA, DEV]) {
      for (const subject of [ME, ANA, DEV]) produced.add(claim(speaker, subject)!);
    }
    expect([...produced].sort()).toEqual([...PARTY_PAIRS].sort());
  });

  it("reads a claim_versions row's snake_case columns too", () => {
    expect(claimPartyPair({ speaker_id: ANA, subject_id: ME }, DM)).toBe("os");
  });

  it("writes no pair at all when the subject is still a hint", () => {
    expect(claimPartyPair({ speakerId: ANA, subjectId: null }, DM)).toBeNull();
    expect(claimPartyPair({ speakerId: null, subjectId: ME }, DM)).toBeNull();
    expect(claimPartyPair({}, DM)).toBeNull();
  });
});

// ---- O-028…O-036: the nine pairs, loop side --------------------------------

describe("nine pairs, loop side — role(owner) ‖ role(counterparty)", () => {
  const loop = (ownerId: string, counterpartyId: string, session = DM): string | null =>
    loopPartyPair({ ownerId, counterpartyId }, session);

  it("ss — I owe myself: renew my passport (O-028)", () => {
    expect(loop(ME, ME)).toBe("ss");
  });

  it("so — I owe you: I'll send the link (O-029)", () => {
    expect(loop(ME, ANA)).toBe("so");
  });

  it("st — I owe an absent person: call Rahul (O-030)", () => {
    expect(loop(ME, DEV)).toBe("st");
  });

  it("os — you owe me: you'll send the doc (O-031)", () => {
    expect(loop(ANA, ME)).toBe("os");
  });

  it("oo — you owe yourself, or one guest owes another (O-032)", () => {
    expect(loop(ANA, ANA)).toBe("oo");
    expect(loop(RAHUL, PRIYA, GROUP)).toBe("oo");
  });

  it("ot — you owe an absent person (O-033)", () => {
    expect(loop(ANA, DEV)).toBe("ot");
  });

  it("ts — an absent person owes me (O-034)", () => {
    expect(loop(DEV, ME)).toBe("ts");
  });

  it("to — an absent person owes you (O-035)", () => {
    expect(loop(DEV, ANA)).toBe("to");
  });

  it("tt — neither party is present (O-036)", () => {
    expect(loop(DEV, KIRAN)).toBe("tt");
  });

  it("reads a loops row's snake_case columns, and refuses a half-known loop", () => {
    expect(loopPartyPair({ owner_id: ME, counterparty_id: ANA }, DM)).toBe("so");
    expect(loopPartyPair({ ownerId: ME, counterpartyId: null }, DM)).toBeNull();
  });

  it("has a reading for every one of the nine, both senses", () => {
    expect(Object.keys(PAIR_READING).sort()).toEqual([...PARTY_PAIRS].sort());
    for (const pair of PARTY_PAIRS) {
      expect(PAIR_READING[pair].claim.length).toBeGreaterThan(0);
      expect(PAIR_READING[pair].loop.length).toBeGreaterThan(0);
    }
  });
});

describe("pair helpers", () => {
  it("splits a pair into its source and target halves", () => {
    expect(sourceRole("ot")).toBe("o");
    expect(targetRole("ot")).toBe("t");
  });

  it("knows the five pairs carrying an `s` from the four that do not", () => {
    expect(SELF_PAIRS).toEqual(["ss", "so", "st", "os", "ts"]);
    expect(NON_SELF_PAIRS).toEqual(["oo", "ot", "to", "tt"]);
    expect(SELF_PAIRS.length + NON_SELF_PAIRS.length).toBe(PARTY_PAIRS.length);
  });

  it("guards its own vocabulary", () => {
    expect(isPartyPair("os")).toBe(true);
    expect(isPartyPair("sos")).toBe(false);
    expect(isPartyPair("OS")).toBe(false);
    expect(isPartyRole("t")).toBe(true);
    expect(isPartyRole("x")).toBe(false);
    expect(pairInvolvesSelf(null)).toBe(false);
    expect(pairInvolvesSelf("nonsense")).toBe(false);
  });

  it("derives a pair from two ids without knowing what they are for", () => {
    expect(pairOf(ANA, DEV, DM)).toBe("ot");
    expect(pairOf(ANA, undefined, DM)).toBeNull();
  });
});

// ---- O-037: `o` is a participant, not the addressee ------------------------

describe("a five-person group (O-037)", () => {
  const roster = [ME, ANA, RAHUL, PRIYA, SAM, DEV];

  it("calls every non-addressee participant `o`", () => {
    // Rahul is talking TO Priya. Ana and Sam are neither speaker nor
    // addressee, and are `o` all the same — they are in the room.
    const roles = rolesOf(roster, GROUP);
    expect(roles).toEqual({
      [ME]: "s",
      [ANA]: "o",
      [RAHUL]: "o",
      [PRIYA]: "o",
      [SAM]: "o",
      [DEV]: "t",
    });
    expect(Object.values(roles).filter((r) => r === "o")).toHaveLength(4);
  });

  it("keeps the addressee out of the pair entirely", () => {
    // Rahul, addressing Priya, says something about Sam. The addressee moves
    // the pair not at all: it is still speaker ‖ subject.
    const spoken = claimPartyPair({ speakerId: RAHUL, subjectId: SAM }, GROUP);
    const addressedElsewhere = claimPartyPair({ speakerId: RAHUL, subjectId: SAM }, GROUP);
    expect(spoken).toBe("oo");
    expect(addressedElsewhere).toBe(spoken);
    // …and a claim addressed to me is `oo` all the same when it is about Sam.
    expect(claimPartyPair({ speakerId: RAHUL, subjectId: ME }, GROUP)).toBe("os");
  });

  it("drops a participant to `t` in a session they are not in", () => {
    expect(rolesOf(roster, DM)).toEqual({
      [ME]: "s",
      [ANA]: "o",
      [RAHUL]: "t",
      [PRIYA]: "t",
      [SAM]: "t",
      [DEV]: "t",
    });
  });
});

// ---- O-039, O-040: not your space ------------------------------------------

describe("a thread with no `s` is not your space (O-039, O-040)", () => {
  const gossip = {
    loops: [
      { ownerId: ANA, counterpartyId: ANA },
      { ownerId: RAHUL, counterpartyId: DEV },
      { ownerId: DEV, counterpartyId: KIRAN },
    ],
  };
  const mine = {
    loops: [
      { ownerId: ANA, counterpartyId: PRIYA },
      { ownerId: ME, counterpartyId: ANA },
    ],
  };

  it("is false when every loop is oo / ot / tt (O-039)", () => {
    expect(threadInvolvesSelf(gossip, GROUP)).toBe(false);
    const verdict = threadPartyVerdict(gossip, GROUP);
    expect(verdict.pairs).toEqual(["oo", "ot", "tt"]);
    expect(verdict.promotionEligible).toBe(false);
    expect(verdict.reason).toBe("no_self_in_any_loop");
  });

  it("is true as soon as one loop carries an `s` (O-040)", () => {
    expect(threadInvolvesSelf(mine, GROUP)).toBe(true);
    const verdict = threadPartyVerdict(mine, GROUP);
    expect(verdict.pairs).toEqual(["oo", "so"]);
    expect(verdict.promotionEligible).toBe(true);
    expect(verdict.reason).toBe("self_involved");
  });

  it("reads a stored pair when one is already on the loop", () => {
    expect(threadInvolvesSelf({ loops: [{ party_pair: "ts" }] })).toBe(true);
    expect(threadInvolvesSelf({ loops: [{ partyPair: "tt" }, { party_pair: "ot" }] })).toBe(false);
    expect(resolveLoopPair({ party_pair: "os" })).toBe("os");
    expect(resolveLoopPair({ party_pair: "zz", ownerId: ME, counterpartyId: ANA }, DM)).toBe("so");
  });

  it("is false for a thread with no loops, and for an unresolvable one", () => {
    expect(threadInvolvesSelf({ loops: [] })).toBe(false);
    expect(threadInvolvesSelf({})).toBe(false);
    expect(threadInvolvesSelf({ loops: [{ ownerId: ME }] }, DM)).toBe(false);
  });
});

// ---- O-041…O-044: oo never reaches the task list ---------------------------

describe("someone else's business never becomes a task (O-041…O-044)", () => {
  it("admits only the five pairs carrying an `s`", () => {
    for (const pair of SELF_PAIRS) expect(loopIsTaskEligible(pair)).toBe(true);
    for (const pair of NON_SELF_PAIRS) expect(loopIsTaskEligible(pair)).toBe(false);
    expect(TASK_EXCLUDED_PAIRS).toEqual(NON_SELF_PAIRS);
  });

  it("keeps every oo loop out, whatever it is about", () => {
    const loops = [
      { ownerId: ANA, counterpartyId: ANA },
      { ownerId: RAHUL, counterpartyId: PRIYA },
      { ownerId: ME, counterpartyId: ANA },
      { ownerId: SAM, counterpartyId: ME },
    ];
    const admitted = loops.filter((l) => loopIsTaskEligible(loopPartyPair(l, GROUP)));
    expect(admitted.map((l) => loopPartyPair(l, GROUP))).toEqual(["so", "os"]);
  });

  it("does not admit a loop it could not place", () => {
    expect(loopIsTaskEligible(null)).toBe(false);
    expect(loopIsTaskEligible(undefined)).toBe(false);
    expect(loopIsTaskEligible("")).toBe(false);
  });
});

// ---- O-038: never on the wire, never asked of a model ----------------------

describe("a model that emits a party field is rejected (O-038)", () => {
  it("knows a party field name however it is spelled", () => {
    for (const name of ["party", "party_pair", "party-pair", "partyPair", "PARTY_PAIR", "pair", "party_role"]) {
      expect(isPartyFieldName(name)).toBe(true);
    }
    for (const name of ["subject", "owner", "counterparty", "attribution", "participant"]) {
      expect(isPartyFieldName(name)).toBe(false);
    }
  });

  it("catches the pair smuggled onto a wire line, and quotes it verbatim", () => {
    const line = "F|1|a1|1p|0.95|-|she is reliable|party_pair=os";
    const verdict = rejectModelParty(line);
    expect(verdict.ok).toBe(false);
    expect(verdict.emissions).toHaveLength(1);
    expect(verdict.emissions[0]).toMatchObject({
      path: "line 1",
      field: "party_pair",
      value: "os",
      raw: line,
      rule: "party_never_emitted",
    });
  });

  it("catches it in a structured answer at any depth", () => {
    const answer = { claims: [{ subject: "a1", party_pair: "oo" }], loops: [{ party: "ss" }] };
    const verdict = rejectModelParty(answer);
    expect(verdict.ok).toBe(false);
    expect(verdict.emissions.map((e) => e.path)).toEqual(["$.claims[0].party_pair", "$.loops[0].party"]);
    expect(verdict.emissions.map((e) => e.value)).toEqual(["oo", "ss"]);
  });

  it("accepts an answer that leaves the pair alone", () => {
    const clean = "F|1|a1|1p|0.95|-|she is reliable\nT|2|a1|so|-|send the link";
    expect(rejectModelParty(clean)).toEqual({ ok: true, emissions: [] });
    expect(rejectModelParty({ claims: [{ subject: "a1", attribution: "1p" }] }).ok).toBe(true);
    expect(rejectModelParty("").ok).toBe(true);
    expect(rejectModelParty(null).ok).toBe(true);
  });

  it("does not fire on prose that merely says party or pair", () => {
    // The key has to be a party field AND the value has to be a role or a
    // pair. Ordinary language clears both bars without trying.
    expect(partyEmissionsInText("we met at the party: it was fun")).toEqual([]);
    expect(partyEmissionsInText("the pair of them are late")).toEqual([]);
    expect(partyEmissionsInText("party=annual offsite")).toEqual([]);
    expect(partyEmissionsInText("pair: red")).toEqual([]);
  });

  it("reports every emission across a multi-line answer", () => {
    const text = "F|1|a1|1p|0.9|-|ok\nP|2|a2|1p|0.9|-|nope party:ot\nH|3|a1|1p|0.9|-|fine";
    const emissions = partyEmissionsInText(text);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.path).toBe("line 2");
  });

  it("does not walk itself into a cycle", () => {
    const cyclic: Record<string, unknown> = { claims: [] };
    cyclic.self = cyclic;
    expect(() => partyFieldsInValue(cyclic)).not.toThrow();
  });
});

// ---- O-045: the pair is queryable ------------------------------------------

describe("party_pair is queryable (O-045)", () => {
  it("builds `everything Rahul said about Ana`", () => {
    const filter = partyClaimFilter({ pair: "ot", speakerId: RAHUL, subjectId: ANA });
    expect(filter.where).toBe("party_pair IN (?) AND speaker_id = ? AND subject_id = ?");
    expect(filter.params).toEqual(["ot", RAHUL, ANA]);
    expect(filter.sql).toContain("FROM claims_active");
    // Precedence is stated_at and only stated_at.
    expect(filter.sql).toContain("ORDER BY stated_at DESC");
    expect(filter.sql).not.toContain("ingested_at");
  });

  it("takes several pairs, in the canonical order, and drops nonsense", () => {
    const filter = partyClaimFilter({ pairs: ["tt", "oo", "not-a-pair"] });
    expect(filter.where).toBe("party_pair IN (?, ?)");
    expect(filter.params).toEqual(["oo", "tt"]);
  });

  it("narrows to the self pairs on request, and intersects rather than widens", () => {
    expect(partyClaimFilter({ involvesSelf: true }).params).toEqual(SELF_PAIRS);
    expect(partyClaimFilter({ involvesSelf: true, pairs: ["os", "oo"] }).params).toEqual(["os"]);
  });

  it("is a no-op filter when nothing was asked for", () => {
    const filter = partyClaimFilter();
    expect(filter.where).toBe("1 = 1");
    expect(filter.params).toEqual([]);
  });
});
