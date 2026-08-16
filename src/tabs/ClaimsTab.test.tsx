// The Claims surface (arch §14.5, build item 3.10).
//
// What this file is really testing:
//
//  1. EVERY ASSERTION ANSWERS "WHY DO YOU THINK THIS?" — the item's acceptance
//     criterion. Confidence, attribution, decided_by and a VERBATIM quote, on
//     every claim, and a named gap when one is missing.
//  2. SUPERSEDE CHAINS ARE BROWSABLE, newest first.
//  3. THE CONFLICT QUEUE CARRIES THE ADJUDICATOR'S REASONING VERBATIM and is
//     not hidden by a filter.
//  4. PROVISIONAL OUTPUT IS MARKED AND NEVER SILENTLY RETRACTED (§14.0b).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ClaimsTab } from "./ClaimsTab";
import type {
  ClaimConflictView,
  ClaimView,
  ClaimsClient,
  ClaimsPage,
} from "../lib/claims-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

const receipt: MutationReceipt = {
  mutationId: "mut_1",
  actor: "user",
  targetKind: "claim",
  targetId: "clm_1",
  field: "pinned",
};

const bhangra: ClaimView = {
  id: "clm_1",
  claimKey: "key_habit",
  kind: "habit",
  text: "Attends bhangra classes on Saturdays.",
  subjectId: "ent_pranjali",
  subjectLabel: "Pranjali Sachdeva",
  subjectIsHint: false,
  status: "active",
  confidence: 0.95,
  attribution: "first_person",
  decidedBy: "agent:p-cl1",
  statedAt: "2026-08-11T00:00:00.000Z",
  validFrom: null,
  validTo: null,
  pinned: false,
  provisional: false,
  evidence: [
    { eventId: "ev_9001", quote: "i've started bhangra classes", episodeId: "epi_2", at: null },
  ],
  versions: [
    {
      id: "v1",
      version: 1,
      text: "Attends bhangra classes on Saturdays.",
      status: "active",
      statedAt: "2026-08-11T00:00:00.000Z",
      reason: "original",
      decidedBy: "agent:p-cl1",
      confidence: 0.95,
    },
  ],
};

/** Three versions, deliberately out of order in the array. */
const residence: ClaimView = {
  ...bhangra,
  id: "clm_2",
  claimKey: "key_residence",
  kind: "preference",
  text: "Prefers houses in Indiranagar",
  evidence: [{ eventId: "ev_7", quote: "indiranagar only, really", episodeId: null, at: null }],
  versions: [
    { id: "v2", version: 2, text: "v2 text", status: "superseded", statedAt: "2026-07-04T00:00:00.000Z", reason: "refined by better evidence", decidedBy: "agent:p-ag3", confidence: 0.8 },
    { id: "v1", version: 1, text: "v1 text", status: "superseded", statedAt: "2026-05-20T00:00:00.000Z", reason: "original", decidedBy: "agent:p-cl1", confidence: 0.7 },
    { id: "v3", version: 3, text: "v3 text", status: "active", statedAt: "2026-08-11T00:00:00.000Z", reason: "refined by better evidence", decidedBy: "agent:p-ag3", confidence: 0.9 },
  ],
};

/** Missing every piece of provenance — the surface must SAY so. */
const bare: ClaimView = {
  ...bhangra,
  id: "clm_3",
  claimKey: "key_bare",
  kind: "opinion",
  text: "Considers ACT broadband overpriced.",
  confidence: null,
  attribution: null,
  decidedBy: null,
  evidence: [],
  versions: [],
};

const live: ClaimView = {
  ...bhangra,
  id: "clm_live",
  claimKey: "key_live",
  kind: "fact",
  text: "Dinner is at 8 tonight.",
  provisional: true,
};

const conflict: ClaimConflictView = {
  id: "cf_1",
  subjectLabel: "Rahul Arora",
  incoming: { ...bhangra, id: "clm_now", kind: "fact", text: "Lives in Indiranagar." },
  stored: {
    ...bhangra,
    id: "clm_was",
    kind: "fact",
    text: "Lives in Koramangala.",
    status: "superseded",
    validTo: "2026-09-01T00:00:00.000Z",
    evidence: [{ eventId: "ev_3", quote: "still in koramangala for now", episodeId: null, at: null }],
  },
  verdict: "contradiction",
  confidence: 0.9,
  reasoning:
    "the incoming claim is older and describes the residence before the stated move",
  raisedAt: null,
};

function page(claims: ClaimView[]): ClaimsPage {
  const groups = new Map<string, ClaimView[]>();
  for (const claim of claims) {
    const key = claim.subjectLabel;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  return {
    counts: { habit: 12, preference: 57, opinion: 40, fact: 144 },
    conflictCount: 1,
    groups: [...groups.entries()].map(([label, rows]) => ({
      subjectId: rows[0]!.subjectId,
      subjectLabel: label,
      claims: rows,
    })),
    subjects: [{ id: "ent_pranjali", label: "Pranjali Sachdeva" }],
  };
}

function makeClient(over: Partial<ClaimsClient> = {}): ClaimsClient {
  return {
    getCoverage: vi.fn(async () => ({ mode: "steady" as const, rows: [] })),
    listClaims: vi.fn(async () => page([bhangra, residence, bare])),
    listConflicts: vi.fn(async () => [conflict]),
    answerConflict: vi.fn(async () => receipt),
    pinClaim: vi.fn(async () => receipt),
    rejectClaim: vi.fn(async () => receipt),
    correctClaim: vi.fn(async () => receipt),
    splitClaim: vi.fn(async () => receipt),
    ...over,
  };
}

function renderTab(client: ClaimsClient) {
  return render(<ClaimsTab client={client} coveragePollMs={0} />);
}

describe("provenance — the acceptance criterion", () => {
  it("shows confidence, attribution and decided_by on every claim", async () => {
    renderTab(makeClient());
    await screen.findByText("Attends bhangra classes on Saturdays.");
    const row = document.querySelector('[data-claim-id="clm_1"]') as HTMLElement;
    expect(within(row).getByText("0.95 · 1st-person · agent:p-cl1")).toBeTruthy();
  });

  it("names the missing pieces instead of rendering a blank", async () => {
    renderTab(makeClient());
    const gap = await screen.findByText(
      /unexplained — missing confidence, attribution, decided_by, evidence quote/,
    );
    expect(gap).toBeTruthy();
  });

  it("[ why? ] reveals the verbatim quote with its event id", async () => {
    renderTab(makeClient());
    await screen.findByText("Attends bhangra classes on Saturdays.");
    const row = document.querySelector('[data-claim-id="clm_1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "why?" }));
    expect(within(row).getByText("i've started bhangra classes")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "ev_9001" })).toBeTruthy();
  });
});

describe("supersede chains are browsable", () => {
  it("lists every version, newest first, with its reason", async () => {
    renderTab(makeClient());
    await screen.findByText("Prefers houses in Indiranagar");
    const row = document.querySelector('[data-claim-id="clm_2"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "why?" }));
    const chain = within(row).getByRole("list", { name: /History of/ });
    const versions = within(chain).getAllByRole("listitem");
    expect(versions.map((li) => li.querySelector(".claim__version-no")?.textContent)).toEqual([
      "v3",
      "v2",
      "v1",
    ]);
    expect(within(chain).getAllByText("refined by better evidence").length).toBe(2);
    expect(within(chain).getByText("original")).toBeTruthy();
  });
});

describe("the conflict queue", () => {
  it("renders the adjudicator's reasoning verbatim", async () => {
    renderTab(makeClient());
    expect(
      await screen.findByText(
        "the incoming claim is older and describes the residence before the stated move",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/contradiction 0\.90/)).toBeTruthy();
  });

  it("shows both quotes on demand", async () => {
    renderTab(makeClient());
    await screen.findByText(/⚠ CONFLICT — Rahul Arora/);
    fireEvent.click(screen.getByRole("button", { name: "show both quotes" }));
    expect(screen.getByText("still in koramangala for now")).toBeTruthy();
  });

  it("answers write a mutation receipt", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText(/⚠ CONFLICT — Rahul Arora/);
    fireEvent.click(screen.getByRole("button", { name: "both true" }));
    await waitFor(() => expect(client.answerConflict).toHaveBeenCalledWith({
      id: "cf_1",
      answer: "both_true",
      actor: "user",
    }));
    expect(await screen.findByText(/mutation mut_1/)).toBeTruthy();
  });

  it("stays visible when a kind filter is applied — a contradiction outranks a filter", async () => {
    const client = makeClient({ listClaims: vi.fn(async () => page([bhangra])) });
    renderTab(client);
    await screen.findByText(/⚠ CONFLICT — Rahul Arora/);
    fireEvent.click(screen.getByRole("button", { name: /^habit/ }));
    await waitFor(() => expect(client.listClaims).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/⚠ CONFLICT — Rahul Arora/)).toBeTruthy();
  });
});

describe("gestures", () => {
  it("rejection says it teaches, and calls reject rather than any delete", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Attends bhangra classes on Saturdays.");
    const row = document.querySelector('[data-claim-id="clm_1"]') as HTMLElement;
    expect(within(row).getByText(/rejection teaches/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "reject" }));
    await waitFor(() => expect(client.rejectClaim).toHaveBeenCalled());
  });

  it("correct sends the user's own text", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Attends bhangra classes on Saturdays.");
    const row = document.querySelector('[data-claim-id="clm_1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "correct" }));
    fireEvent.change(within(row).getByLabelText("Corrected claim"), {
      target: { value: "Attends bhangra on Sundays." },
    });
    fireEvent.click(within(row).getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(client.correctClaim).toHaveBeenCalledWith({
        id: "clm_1",
        text: "Attends bhangra on Sundays.",
        actor: "user",
      }),
    );
  });
});

describe("provisional output (§14.0b)", () => {
  it("marks a live claim rather than withholding it", async () => {
    renderTab(makeClient({ listClaims: vi.fn(async () => page([bhangra, live])) }));
    expect(await screen.findByText("Dinner is at 8 tonight.")).toBeTruthy();
    expect(screen.getByText(/conversation in progress/)).toBeTruthy();
  });

  it("keeps a vanished provisional claim, struck through, until dismissed", async () => {
    const listClaims = vi
      .fn<ClaimsClient["listClaims"]>()
      .mockResolvedValueOnce(page([bhangra, live]))
      .mockResolvedValue(page([bhangra]));
    const client = makeClient({ listClaims, pinClaim: vi.fn(async () => receipt) });
    renderTab(client);
    await screen.findByText("Dinner is at 8 tonight.");

    // Any gesture reloads; the second answer no longer carries the live claim.
    const row = document.querySelector('[data-claim-id="clm_1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "pin" }));

    const withdrawn = await screen.findByText(/withdrawn as the conversation resolved/);
    expect(withdrawn).toBeTruthy();
    expect(screen.getByText("Dinner is at 8 tonight.")).toBeTruthy();

    fireEvent.click(within(withdrawn as HTMLElement).getByRole("button", { name: "dismiss" }));
    await waitFor(() => expect(screen.queryByText("Dinner is at 8 tonight.")).toBeNull());
  });
});

describe("the surface chrome", () => {
  it("groups claims by subject entity", async () => {
    renderTab(makeClient());
    const heading = await screen.findByRole("heading", { name: /Pranjali Sachdeva/ });
    expect(within(heading).getByText("3 claims")).toBeTruthy();
  });

  it("carries the coverage meter, like all eight surfaces", async () => {
    const client = makeClient({
      getCoverage: vi.fn(async () => ({
        mode: "bootstrap" as const,
        rows: [{ horizon: "d30" as const, totalUnits: 100, doneUnits: 71 }],
      })),
    });
    renderTab(client);
    await waitFor(() => expect(client.getCoverage).toHaveBeenCalled());
    expect(document.querySelector(".coverage-meter")).toBeTruthy();
  });

  it("reports a failed read instead of showing an empty corpus", async () => {
    renderTab(makeClient({ listClaims: vi.fn(async () => { throw new Error("boom"); }) }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "boom");
  });
});
