// The People surface (arch §14.1 / §14.8, build item 3.10).
//
// What this file is really testing:
//
//  1. THE TIER IS COMPUTED AND SHOWS ITS ARITHMETIC. A badge with no numbers
//     beside it would be an unexplained assertion.
//  2. A PERSON HAS THREADS, NOT TASKS. No task list, no priority; open loops
//     appear in both directions and are labelled as context.
//  3. EVERY CLAIM ON THE CARD CARRIES ITS PROVENANCE AND ITS QUOTE.
//  4. Coverage meter and §14.0b retention, like all eight surfaces.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PeopleTab } from "./PeopleTab";
import type { PeopleClient, PeoplePage, PersonView } from "../lib/people-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

const receipt: MutationReceipt = {
  mutationId: "mut_7",
  actor: "user",
  targetKind: "entity",
  targetId: "ent_1",
  field: "pinned",
};

const pranjali: PersonView = {
  id: "ent_1",
  label: "Pranjali Sachdeva",
  relationship: "sister",
  relationshipQuote: "my sister is coming over",
  tier: "inner_circle",
  stats: {
    bidirectionalWeeks12: 9,
    bidirectionalLast4Weeks: true,
    daysSinceContact: 2,
    reciprocity: 0.55,
    reciprocityWindow: "12 weeks",
    rhythmLabel: "≈ 4× a week",
  },
  pinned: false,
  provisional: false,
  identities: [
    { id: "idn_1", kind: "phone", value: "9177…03", sourceLabel: "whatsapp", decidedBy: "code:exact" },
  ],
  claims: [
    {
      id: "clm_1",
      kind: "habit",
      text: "Attends bhangra classes on Saturdays.",
      confidence: 0.95,
      attribution: "first_person",
      decidedBy: "agent:p-cl1",
      quote: "i've started bhangra classes",
      eventId: "ev_9001",
    },
  ],
  threads: [{ arcId: "arc_77", label: "Goa trip", state: "live", lastActiveAt: null }],
  sharedSpaces: [{ spaceId: "arc_77", label: "Goa trip", archetype: "evt" }],
  openLoops: [
    {
      id: "loop_1",
      intent: "send the villa link",
      direction: "you_owe_them",
      dueLabel: "due today",
      quote: "i'll send you that villa link tonight",
    },
    {
      id: "loop_2",
      intent: "share the packing list",
      direction: "they_owe_you",
      dueLabel: null,
      quote: "i'll put the list together",
    },
  ],
  recommendations: [
    { claimId: "clm_r", text: "Try the Koshy's breakfast.", at: null, quote: "you have to try koshy's" },
  ],
  timeline: [{ at: "2024-01-04", label: "first message", sourceLabel: "whatsapp" }],
};

/** The worker's tier and the numbers disagree — the card must say so. */
const mismatched: PersonView = {
  ...pranjali,
  id: "ent_2",
  label: "Rahul Arora",
  tier: "inner_circle",
  stats: {
    bidirectionalWeeks12: 0,
    bidirectionalLast4Weeks: false,
    daysSinceContact: 400,
    reciprocity: null,
    reciprocityWindow: null,
    rhythmLabel: null,
  },
};

const live: PersonView = { ...pranjali, id: "ent_3", label: "Unknown 9188…12", provisional: true };

function page(people: PersonView[]): PeoplePage {
  return {
    counts: { inner_circle: 6, active: 24, dormant: 41, archived: 88 },
    people,
  };
}

function makeClient(over: Partial<PeopleClient> = {}): PeopleClient {
  return {
    getCoverage: vi.fn(async () => ({ mode: "steady" as const, rows: [] })),
    listPeople: vi.fn(async () => page([pranjali, mismatched])),
    pinPerson: vi.fn(async () => receipt),
    renamePerson: vi.fn(async () => receipt),
    ...over,
  };
}

const card = (id: string) => document.querySelector(`[data-person-id="${id}"]`) as HTMLElement;

function renderTab(client: PeopleClient) {
  return render(<PeopleTab client={client} coveragePollMs={0} />);
}

describe("the computed tier", () => {
  it("shows the tier with the arithmetic that produced it", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    expect(within(p).getByText("inner circle")).toBeTruthy();
    expect(within(p).getByText("both ways in 9 of the last 12 weeks")).toBeTruthy();
    expect(p.className).toContain("person--inner_circle");
  });

  it("states the rule on the surface that applies it", async () => {
    renderTab(makeClient());
    expect(
      await screen.findByText(/tier is computed — inner circle is both ways in ≥8 of 12 weeks/),
    ).toBeTruthy();
  });

  it("names a worker/derivation disagreement instead of hiding it", async () => {
    renderTab(makeClient());
    await screen.findByText("Rahul Arora");
    expect(
      within(card("ent_2")).getByText(/worker says inner_circle, these numbers say archived/),
    ).toBeTruthy();
  });

  it("filters by tier", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Pranjali Sachdeva");
    fireEvent.click(screen.getByRole("button", { name: /^dormant/ }));
    await waitFor(() =>
      expect(client.listPeople).toHaveBeenLastCalledWith({ tier: "dormant", q: "" }, expect.anything()),
    );
  });

  it("shows the contact rhythm and reciprocity with their window", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    expect(
      within(card("ent_1")).getByText(/≈ 4× a week · you sent 55% over 12 weeks · last contact 2d ago/),
    ).toBeTruthy();
  });
});

describe("threads, not tasks", () => {
  it("says so, and shows no task verbs", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    fireEvent.click(within(p).getByRole("button", { name: "more" }));
    expect(within(p).getByText(/threads only — no tasks, no priority/)).toBeTruthy();
    for (const verb of ["done", "drop", "snooze", "not useful"]) {
      expect(within(p).queryByRole("button", { name: verb })).toBeNull();
    }
  });

  it("shows open loops in both directions, labelled as context", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    fireEvent.click(within(p).getByRole("button", { name: "more" }));
    expect(within(p).getByText(/context, in both directions — never a task list/)).toBeTruthy();
    expect(within(p).getByText(/you → Pranjali Sachdeva: send the villa link/)).toBeTruthy();
    expect(within(p).getByText(/Pranjali Sachdeva → you: share the packing list/)).toBeTruthy();
  });
});

describe("provenance on the card", () => {
  it("every claim carries confidence, attribution, decided_by and a quote", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    fireEvent.click(within(p).getByRole("button", { name: "more" }));
    expect(within(p).getByText("0.95 · first_person · agent:p-cl1")).toBeTruthy();
    expect(within(p).getByText("i've started bhangra classes")).toBeTruthy();
  });

  it("shows identities with who decided them, and the elided value", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    fireEvent.click(within(p).getByRole("button", { name: "more" }));
    expect(within(p).getByText("9177…03")).toBeTruthy();
    expect(within(p).getByText("code:exact")).toBeTruthy();
  });

  it("shows their recommendations with the quote", async () => {
    renderTab(makeClient());
    await screen.findByText("Pranjali Sachdeva");
    const p = card("ent_1");
    fireEvent.click(within(p).getByRole("button", { name: "more" }));
    expect(within(p).getByText(/Try the Koshy's breakfast/)).toBeTruthy();
    expect(within(p).getByText("you have to try koshy's")).toBeTruthy();
  });
});

describe("gestures and chrome", () => {
  it("pin writes a mutation receipt", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Pranjali Sachdeva");
    fireEvent.click(within(card("ent_1")).getByRole("button", { name: "pin" }));
    await waitFor(() =>
      expect(client.pinPerson).toHaveBeenCalledWith({ id: "ent_1", pinned: true, actor: "user" }),
    );
    expect(await screen.findByText(/mutation mut_7/)).toBeTruthy();
  });

  it("marks a provisional person and keeps it when it disappears", async () => {
    const listPeople = vi
      .fn<PeopleClient["listPeople"]>()
      .mockResolvedValueOnce(page([pranjali, live]))
      .mockResolvedValue(page([pranjali]));
    renderTab(makeClient({ listPeople }));
    await screen.findByText("Unknown 9188…12");

    fireEvent.click(within(card("ent_1")).getByRole("button", { name: "pin" }));
    expect(await screen.findByText(/no longer returned/)).toBeTruthy();
    expect(screen.getByText("Unknown 9188…12")).toBeTruthy();
  });

  it("carries the coverage meter, like all eight surfaces", async () => {
    const client = makeClient();
    renderTab(client);
    await waitFor(() => expect(client.getCoverage).toHaveBeenCalled());
  });

  it("reports a failed read", async () => {
    renderTab(makeClient({ listPeople: vi.fn(async () => { throw new Error("offline"); }) }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "offline");
  });
});
