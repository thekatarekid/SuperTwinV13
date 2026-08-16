import { describe, expect, it } from "vitest";

import type { PartySession } from "../entities/party.js";
import { tr1DefaultTriage } from "../loops/triage.js";
import {
  ATTRIBUTIONS,
  TRIAGE_CLASSES,
  claimCodeFacts,
  deriveAttribution,
  deriveTriage,
  eventCodeFacts,
  loopCodeFacts,
  nonSelfLoopsInTasks,
  tasksFrom,
} from "./codefacts.js";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;

const ME = "ent_me";
const PRANJALI = "ent_pranjali";
const ROHAN = "ent_rohan";
const LANDLORD = "ent_landlord";

const SESSION: PartySession = { selfEntityId: ME, participantEntityIds: [ME, PRANJALI] };

function daysFromNow(n: number): string {
  return new Date(NOW_MS + n * DAY).toISOString();
}

describe("eventCodeFacts — §11.4 'ALSO AT CREATION'", () => {
  it("takes speaker_id from events.actor_entity_id and stated_at from events.ts", () => {
    expect(eventCodeFacts({ id: "ev1", actor_entity_id: PRANJALI, ts: "2026-03-01T09:00:00Z" })).toEqual({
      speakerId: PRANJALI,
      statedAt: "2026-03-01T09:00:00Z",
    });
  });

  it("never reads ingested_at — precedence is stated_at alone", () => {
    const withIngest = { actor_entity_id: ME, ts: "2024-01-01T00:00:00Z", ingested_at: NOW };
    expect(eventCodeFacts(withIngest as never).statedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("an event with no resolved actor yields no speaker — null beats a guess", () => {
    expect(eventCodeFacts({ actor_raw: "Some Name", ts: NOW } as never).speakerId).toBeNull();
    expect(eventCodeFacts(null)).toEqual({ speakerId: null, statedAt: null });
  });
});

describe("attribution downgrade — §11.4", () => {
  it("first_person with subject ≠ speaker downgrades to about_other and flags", () => {
    const a = deriveAttribution("first_person", PRANJALI, ME);
    expect(a.attribution).toBe("about_other");
    expect(a.statedAttribution).toBe("first_person");
    expect(a.downgraded).toBe(true);
  });

  it("first_person with subject == speaker is left alone", () => {
    const a = deriveAttribution("first_person", ME, ME);
    expect(a.attribution).toBe("first_person");
    expect(a.downgraded).toBe(false);
  });

  it("an unresolved subject is not a mismatch — unknown beats wrong", () => {
    expect(deriveAttribution("first_person", null, ME).downgraded).toBe(false);
    expect(deriveAttribution("first_person", PRANJALI, null).downgraded).toBe(false);
  });

  it("other attributions pass through untouched", () => {
    for (const attribution of ATTRIBUTIONS.filter((a) => a !== "first_person")) {
      const a = deriveAttribution(attribution, PRANJALI, ME);
      expect(a.attribution).toBe(attribution);
      expect(a.downgraded).toBe(false);
    }
  });
});

describe("claimCodeFacts", () => {
  it("derives speaker, stated_at, party_pair and attribution in one pass", () => {
    const facts = claimCodeFacts(
      {
        subjectId: PRANJALI,
        attribution: "about_other",
        event: { actor_entity_id: ME, ts: "2026-04-02T07:15:00Z" },
      },
      SESSION,
    );
    expect(facts).toMatchObject({
      speakerId: ME,
      statedAt: "2026-04-02T07:15:00Z",
      attribution: "about_other",
      partyPair: "so",
    });
    expect(facts.flags).toEqual([]);
  });

  it("the event wins over a caller-supplied speaker", () => {
    const facts = claimCodeFacts(
      { subjectId: ME, speakerId: ROHAN, event: { actor_entity_id: PRANJALI, ts: NOW } },
      SESSION,
    );
    expect(facts.speakerId).toBe(PRANJALI);
    expect(facts.partyPair).toBe("os");
  });

  it("downgrades and flags together", () => {
    const facts = claimCodeFacts(
      { subjectId: PRANJALI, attribution: "first_person", event: { actor_entity_id: ME, ts: NOW } },
      SESSION,
    );
    expect(facts.attribution).toBe("about_other");
    expect(facts.statedAttribution).toBe("first_person");
    expect(facts.flags).toContain("attribution_downgraded");
  });

  it("an unresolved subject yields a null pair and a flag, never a fabricated role", () => {
    const facts = claimCodeFacts({ subjectId: null, event: { actor_entity_id: ME, ts: NOW } }, SESSION);
    expect(facts.partyPair).toBeNull();
    expect(facts.flags).toContain("subject_unresolved");
  });

  it("a third party the session never met reads 't'", () => {
    const facts = claimCodeFacts({ subjectId: LANDLORD, event: { actor_entity_id: ME, ts: NOW } }, SESSION);
    expect(facts.partyPair).toBe("st");
  });
});

describe("deriveTriage", () => {
  it("owner ≠ me → context, whoever the counterparty is (§12.8)", () => {
    expect(deriveTriage({ ownerId: PRANJALI, counterpartyId: ROHAN, origin: "explicit" }, SESSION)).toBe("context");
    expect(deriveTriage({ ownerId: LANDLORD, counterpartyId: ROHAN, origin: "implicit" }, SESSION)).toBe("context");
    // The `os` pair — "You owe me". Self IS at one end, and it is STILL cx:
    // §12.8 says "owner not self is ALWAYS cx", and §14.7 files this under
    // "waiting on others", which is context only. Acting on it unasked would
    // be acting on someone else's obligation.
    expect(deriveTriage({ ownerId: PRANJALI, counterpartyId: ME, origin: "explicit" }, SESSION)).toBe("context");
  });

  it("I own it and said it explicitly → auto", () => {
    expect(deriveTriage({ ownerId: ME, counterpartyId: PRANJALI, origin: "explicit" }, SESSION)).toBe("auto");
    expect(deriveTriage({ ownerId: ME, counterpartyId: ROHAN, origin: "explicit" }, SESSION)).toBe("auto");
  });

  it("agrees with `loops/triage.ts`, the other place the owner rule is applied", () => {
    // Two modules, two id conventions (db entity ids here, the wire's `self`
    // alias there). One rule. They disagreed once; this is what catches it.
    for (const origin of ["explicit", "implicit", undefined]) {
      expect(deriveTriage({ ownerId: PRANJALI, counterpartyId: ME, origin }, SESSION)).toBe(
        tr1DefaultTriage({ ownerId: "a1", origin }).triage,
      );
      expect(deriveTriage({ ownerId: ME, counterpartyId: PRANJALI, origin: "implicit" }, SESSION)).toBe(
        tr1DefaultTriage({ ownerId: "self", origin: "implicit" }).triage,
      );
    }
  });

  it("implicit is NEVER auto (§11.5.2)", () => {
    expect(deriveTriage({ ownerId: ME, counterpartyId: PRANJALI, origin: "implicit" }, SESSION)).toBe("approval");
  });

  it("an unknown origin is not an explicit one — the safe default is never auto", () => {
    expect(deriveTriage({ ownerId: ME, counterpartyId: PRANJALI }, SESSION)).toBe("approval");
    expect(deriveTriage({ ownerId: ME, counterpartyId: null }, SESSION)).toBe("approval");
  });

  it("only ever returns a member of the closed set", () => {
    for (const owner of [ME, PRANJALI, LANDLORD, null]) {
      for (const cpty of [ME, PRANJALI, LANDLORD, null]) {
        expect(TRIAGE_CLASSES).toContain(deriveTriage({ ownerId: owner, counterpartyId: cpty }, SESSION));
      }
    }
  });
});

describe("loopCodeFacts", () => {
  it("derives pair, triage, state, next occurrence and horizon at once", () => {
    const facts = loopCodeFacts(
      {
        ownerId: ME,
        counterpartyId: LANDLORD,
        origin: "explicit",
        intent: "renew the lease",
        dueUtc: "2025-03-04T00:00:00Z",
        recurrence: "annual",
        event: { actor_entity_id: ME, ts: "2025-02-01T00:00:00Z" },
      },
      SESSION,
      NOW,
    );
    expect(facts).toMatchObject({
      speakerId: ME,
      statedAt: "2025-02-01T00:00:00Z",
      partyPair: "st",
      triage: "auto",
      state: "open",
      stateReason: "recurrence_next_future",
      nextOccurrenceUtc: "2027-03-04T00:00:00.000Z",
      dueInPast: true,
      taskEligible: true,
      isTask: true,
    });
  });

  it("a loop someone else owns is context and is not a task, even with me as counterparty", () => {
    const facts = loopCodeFacts(
      {
        ownerId: PRANJALI,
        counterpartyId: ME,
        origin: "explicit",
        intent: "send me the receipt",
        dueUtc: daysFromNow(3),
        event: { actor_entity_id: PRANJALI, ts: NOW },
      },
      SESSION,
      NOW,
    );
    expect(facts.partyPair).toBe("os");
    // Context, exactly as this test's name says: the owner is Pranjali, and
    // §12.8's rule is about the OWNER, not about self appearing in the pair.
    expect(facts.triage).toBe("context");
    expect(facts.state).toBe("open");
    expect(facts.taskEligible).toBe(false);
    expect(facts.isTask).toBe(false);
  });

  it("someone else's business entirely: context, no self in the pair", () => {
    const facts = loopCodeFacts(
      {
        ownerId: PRANJALI,
        counterpartyId: ROHAN,
        origin: "explicit",
        intent: "drop the keys",
        dueUtc: daysFromNow(2),
      },
      SESSION,
      NOW,
    );
    expect(facts.partyPair).toBe("ot");
    expect(facts.triage).toBe("context");
    expect(facts.isTask).toBe(false);
    expect(facts.flags).toContain("no_self_in_pair");
  });

  it("a done loop leaves every surface immediately (§11.4.4) but is still a row", () => {
    const facts = loopCodeFacts(
      { ownerId: ME, counterpartyId: PRANJALI, intent: "compare flights", resolutionEvidenceEventId: "ev_77" },
      SESSION,
      NOW,
    );
    expect(facts.state).toBe("done");
    expect(facts.isTask).toBe(false);
    expect(facts.taskEligible).toBe(true);
  });

  it("stated_at comes from the event, never from the caller when both exist", () => {
    const facts = loopCodeFacts(
      { ownerId: ME, counterpartyId: ME, statedAt: NOW, event: { actor_entity_id: ME, ts: "2023-09-09T00:00:00Z" } },
      SESSION,
      NOW,
    );
    expect(facts.statedAt).toBe("2023-09-09T00:00:00Z");
  });

  it("an unresolved owner flags rather than guessing, and never enters Tasks", () => {
    const facts = loopCodeFacts({ counterpartyId: PRANJALI, dueUtc: daysFromNow(1) }, SESSION, NOW);
    expect(facts.partyPair).toBeNull();
    expect(facts.flags).toContain("owner_unresolved");
    // Neither end is `me`, so the §11.4 rule fires exactly as written: context.
    expect(facts.triage).toBe("context");
    expect(facts.isTask).toBe(false);
  });
});

describe("ACCEPTANCE — zero non-self loops in Tasks", () => {
  const loops = [
    { id: "t1", ownerId: ME, counterpartyId: PRANJALI, origin: "explicit", intent: "book the cab", dueUtc: daysFromNow(2) },
    { id: "t2", ownerId: ME, counterpartyId: LANDLORD, origin: "explicit", intent: "renew lease", dueUtc: "2025-03-04T00:00:00Z", recurrence: "annual" },
    { id: "t3", ownerId: PRANJALI, counterpartyId: ROHAN, origin: "explicit", intent: "her deadline", dueUtc: daysFromNow(1) },
    { id: "t4", ownerId: LANDLORD, counterpartyId: ROHAN, origin: "implicit", intent: "their paperwork", dueUtc: daysFromNow(5) },
    { id: "t5", ownerId: PRANJALI, counterpartyId: ME, origin: "explicit", intent: "she owes me the file", dueUtc: daysFromNow(4) },
    { id: "t6", ownerId: ME, counterpartyId: ME, origin: "implicit", intent: "old idea", statedAt: "2018-01-01T00:00:00Z" },
    { id: "t7", ownerId: ME, counterpartyId: PRANJALI, origin: "explicit", intent: "done thing", resolutionEvidenceEventId: "ev1" },
    { id: "t8", ownerId: ME, counterpartyId: PRANJALI, origin: "explicit", intent: "lapsed thing", dueUtc: "2024-01-01T00:00:00Z" },
  ];

  const tasks = tasksFrom(loops, SESSION, NOW);

  it("admits only loops I own that are open or latent", () => {
    expect(tasks.map((t) => t.loop.id)).toEqual(["t1", "t2", "t6"]);
  });

  it("no admitted task carries a pair without an 's'", () => {
    expect(nonSelfLoopsInTasks(tasks)).toEqual([]);
  });

  it("every non-self loop is triaged as context", () => {
    for (const loop of loops) {
      const facts = loopCodeFacts(loop, SESSION, NOW);
      if (facts.partyPair === "ot" || facts.partyPair === "oo" || facts.partyPair === "tt") {
        expect(facts.triage).toBe("context");
      }
    }
  });

  it("rejected loops are still derived — a view, never a deletion", () => {
    expect(loops.map((l) => loopCodeFacts(l, SESSION, NOW).state)).toHaveLength(loops.length);
    expect(loopCodeFacts(loops[2], SESSION, NOW).state).toBe("open");
  });
});
