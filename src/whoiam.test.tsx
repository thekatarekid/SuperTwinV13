// ===========================================================================
// The "Who I am" card and the follow-up radar — V6 P1 R2 (the two S5.4
// surfaces the worker built and nothing rendered).
//
// Product_V6 §8.3.2: the card is built by PROCESSING, so what the UI must
// prove is that it never asks. Nothing to fill in, every line carrying its own
// evidence and confidence, "edit" meaning a correction on the claim behind the
// line, and an empty card saying so in the worker's own words.
//
// Product_V6 §11.8.3 for the radar: two directions, the follow-up date the
// twin starts acting on, overdue said out loud, and a lead time that can be
// learned for one person.
//
// The worker is stubbed: no network, no worker, no model.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { People } from "./screens/People";
import { Radar } from "./screens/people/Radar";
import { WhoIAm } from "./screens/people/WhoIAm";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_CARD = {
  selfId: "ent_self",
  filledBy: "processing",
  basics: [],
  life: [],
  narrative: [],
  traits: [],
  voice: [],
  people: {},
  counts: { claims: 0, people: 0 },
  empty: true,
  emptyNote: "Nothing yet — this card fills from processing over the first hour. There is no form.",
};

const FILLED_CARD = {
  ...EMPTY_CARD,
  basics: [
    {
      text: "lives in Bengaluru",
      confidence: 0.9,
      evidence: [{ event_ids: ["e1"], quote: "I'm in Bengaluru now" }],
      claimKey: "self.home",
      kind: "fact",
      statedAt: "2026-08-01T00:00:00.000Z",
      source: "processing",
      editable: true,
    },
  ],
  life: [
    {
      text: "coworkers: Sameer",
      confidence: null,
      evidence: [],
      claimKey: null,
      kind: "circle",
      statedAt: null,
      source: "circles",
      editable: false,
    },
  ],
  voice: [
    {
      text: "DM with Rohan: hinglish · short · 🔥-heavy",
      confidence: null,
      evidence: [],
      claimKey: null,
      kind: "tone",
      statedAt: null,
      source: "tone",
      editable: false,
    },
  ],
  counts: { claims: 1, people: 1 },
  empty: false,
  emptyNote: null,
};

const RADAR = [
  {
    personId: "ent_sameer",
    personName: "Sameer",
    circle: "coworkers",
    direction: "i_owe",
    streamKey: "sameer@s.whatsapp.net",
    streamId: "str_s",
    isGroup: false,
    askedAt: "2026-09-01T05:00:00.000Z",
    askText: "hey, done with the deck?",
    eventId: "e1",
    leadDays: 3,
    followUpAt: "2026-09-04T05:00:00.000Z",
    ageDays: 5,
    overdue: true,
  },
  {
    personId: "ent_priya",
    personName: "Priya",
    circle: "friends",
    direction: "they_owe",
    streamKey: "priya@s.whatsapp.net",
    streamId: "str_p",
    isGroup: false,
    askedAt: "2026-09-05T05:00:00.000Z",
    askText: "still on for saturday?",
    eventId: "e2",
    leadDays: 5,
    followUpAt: "2026-09-10T05:00:00.000Z",
    ageDays: 1,
    overdue: false,
  },
];

function stubPeople(over: Record<string, unknown> = {}): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/people", { people: [], open_questions: [] });
  stub.routes.set("/api/people/aliases", { aliases: {} });
  stub.routes.set("/api/people/who-i-am", EMPTY_CARD);
  stub.routes.set("/api/people/radar", { radar: [] });
  for (const [path, body] of Object.entries(over)) stub.routes.set(path, body);
  return stub;
}

describe('the "Who I am" card (Product_V6 §8.3.2)', () => {
  it("says it is built by processing and offers no form to fill", async () => {
    stubPeople();
    render(<WhoIAm />);
    const card = await screen.findByLabelText("Who I am");
    expect(within(card).getByText(/no form and no confirmation step/)).toBeTruthy();
    expect(await within(card).findByText(/There is no form/)).toBeTruthy();
    // The one thing an onboarding form would have: a text field. There is none.
    expect(card.querySelectorAll("input, textarea, select").length).toBe(0);
  });

  it("prints every line with its evidence and confidence, and marks derived lines", async () => {
    stubPeople({ "/api/people/who-i-am": FILLED_CARD });
    render(<WhoIAm />);
    const line = await screen.findByLabelText("who i am line lives in Bengaluru");
    expect(within(line).getByText("90%")).toBeTruthy();
    expect(within(line).getByText(/I'm in Bengaluru now/)).toBeTruthy();
    // A circle/tone line is read off the record, not claimed — it says so and
    // carries no correction chips.
    const derived = screen.getByLabelText("who i am line coworkers: Sameer");
    expect(within(derived).getByText("from circles")).toBeTruthy();
    expect(within(derived).queryByText("Not true")).toBeNull();
    expect(screen.getByLabelText("who i am line DM with Rohan: hinglish · short · 🔥-heavy")).toBeTruthy();
  });

  it("editing a line is a correction on the claim behind it, not a form field", async () => {
    const onCorrection = vi.fn();
    const onTellTwin = vi.fn();
    stubPeople({ "/api/people/who-i-am": FILLED_CARD });
    render(<WhoIAm onCorrection={onCorrection} onTellTwin={onTellTwin} />);
    fireEvent.click(await screen.findByLabelText("outdated lives in Bengaluru"));
    expect(onCorrection).toHaveBeenCalledWith("self.home", { type: "outdated" });
    fireEvent.click(screen.getByLabelText("not true lives in Bengaluru"));
    expect(onCorrection).toHaveBeenCalledWith("self.home", { type: "not_true" });
    fireEvent.click(screen.getByLabelText("tell the twin about lives in Bengaluru"));
    expect(onTellTwin).toHaveBeenCalledWith("self.home", "lives in Bengaluru");
  });

  it("an evidence chip opens the event it quotes", async () => {
    const onOpenEvent = vi.fn();
    stubPeople({ "/api/people/who-i-am": FILLED_CARD });
    render(<WhoIAm onOpenEvent={onOpenEvent} />);
    fireEvent.click(await screen.findByLabelText("evidence for lives in Bengaluru"));
    expect(onOpenEvent).toHaveBeenCalledWith("e1");
  });
});

describe("the follow-up radar (Product_V6 §11.8.3, CRM-01/02)", () => {
  it("splits the two directions and names when the twin starts acting", async () => {
    stubPeople({ "/api/people/radar": { radar: RADAR } });
    render(<Radar />);
    const owed = await screen.findByLabelText("radar i_owe");
    expect(within(owed).getByText("You owe a reply")).toBeTruthy();
    const sameer = within(owed).getByLabelText("radar i_owe Sameer");
    expect(within(sameer).getByText(/done with the deck/)).toBeTruthy();
    expect(within(sameer).getByText("overdue — start was 2026-09-04")).toBeTruthy();
    const waiting = screen.getByLabelText("radar they_owe");
    expect(within(waiting).getByText("starts 2026-09-10")).toBeTruthy();
    // The overdue count rides the heading, so the screen says it once.
    expect(screen.getByText("1 overdue")).toBeTruthy();
  });

  it("an empty radar is a sentence, not a blank card", async () => {
    stubPeople();
    render(<Radar />);
    expect(await screen.findByText("nothing owed either way")).toBeTruthy();
  });

  it("a lead time can be learned for one person", async () => {
    const stub = stubPeople({ "/api/people/radar": { radar: RADAR } });
    stub.routes.set("/api/people/ent_sameer/radar-lead", { person: "ent_sameer", radar_lead_days: 1 });
    render(<Radar />);
    const input = (await screen.findByLabelText("lead days for Sameer")) as HTMLInputElement;
    expect(input.value).toBe("3");
    fireEvent.blur(input, { target: { value: "1" } });
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/people/ent_sameer/radar-lead");
      expect(post?.body).toEqual({ days: 1 });
    });
  });
});

describe("People carries both surfaces above the circles", () => {
  it("renders the card and the radar on the People screen", async () => {
    stubPeople({ "/api/people/who-i-am": FILLED_CARD, "/api/people/radar": { radar: RADAR } });
    render(<People />);
    expect(await screen.findByLabelText("Who I am")).toBeTruthy();
    expect(await screen.findByLabelText("Follow-up radar")).toBeTruthy();
    expect(screen.getByLabelText("People")).toBeTruthy();
  });

  it("a Who I am chip posts the claim correction through the one pipeline, with undo", async () => {
    const stub = stubPeople({ "/api/people/who-i-am": FILLED_CARD });
    render(<People />);
    fireEvent.click(await screen.findByLabelText("not true lives in Bengaluru"));
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/corrections");
      expect(post?.body).toEqual({
        target: { kind: "claim", id: "self.home" },
        structured: { type: "not_true" },
      });
    });
    expect(await screen.findByRole("button", { name: "undo" })).toBeTruthy();
  });
});
