// The Tasks surface (arch §14.7, build item 3.10).
//
// The item's acceptance criterion is the first describe block: **no loop owned
// by another person appears in Tasks.** It is tested at the unit level in
// tasks/partition.test.ts and again here, through the rendered surface, with a
// worker that lies about the sectioning.
//
// The rest: two lists with different verbs, one-tap done checks carrying the
// evidence quote, lapsed rows that say why (including "born lapsed"), grouping
// by space, and §14.0b's provisional marker.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { TasksTab } from "./TasksTab";
import type { TaskView, TasksClient, TasksPage } from "../lib/tasks-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

const receipt: MutationReceipt = {
  mutationId: "mut_3",
  actor: "user",
  targetKind: "loop",
  targetId: "loop_1",
  field: "state",
};

function task(over: Partial<TaskView> & { id: string }): TaskView {
  return {
    intent: "send the villa link",
    origin: "explicit",
    state: "open",
    stateReason: null,
    stateNote: null,
    triage: "approve",
    ownerIsSelf: true,
    ownerLabel: "you",
    counterpartyLabel: "Pranjali",
    dueAt: "2026-08-16",
    dueLabel: "due today",
    recurrence: null,
    nextOccurrenceAt: null,
    spaceId: "arc_77",
    spaceLabel: "Goa trip",
    confidence: 0.9,
    inferredFrom: null,
    provisional: false,
    pendingNote: null,
    updatedAt: null,
    evidence: [
      { eventId: "ev_1", quote: "i'll send you that villa link tonight", at: "12 Aug", episodeId: null },
    ],
    ...over,
  };
}

const mine = task({ id: "loop_1", intent: "Send Pranjali the Goa villa link" });

/** The worker sent this as a task. It is Rohan's. It must not appear as one. */
const theirs = task({
  id: "loop_rohan",
  intent: "hold the villa till 20 Aug",
  ownerIsSelf: false,
  ownerLabel: "Rohan",
});

/** Owner flag says self, triage says context — the second guard must catch it. */
const contextual = task({ id: "loop_cx", intent: "read up on Goa beaches", triage: "context" });

const suggestion = task({
  id: "loop_impl",
  intent: "Compare broadband plans in Bangalore",
  origin: "implicit",
  dueLabel: null,
  dueAt: null,
  spaceId: "arc_88",
  spaceLabel: "Broadband renewal",
  inferredFrom: '"ACT is way overpriced"',
});

const lapsed = task({
  id: "loop_lapsed",
  intent: "Reply to Dr. Rao about Tuesday",
  state: "lapsed",
  stateReason: "born_lapsed",
  dueLabel: "due 20 Jul",
});

const live = task({
  id: "loop_live",
  intent: "Book the cab",
  provisional: true,
  updatedAt: "12s ago",
  pendingNote: "1 voice note still transcribing",
});

function page(tasks: TaskView[]): TasksPage {
  return {
    tasks,
    doneChecks: [
      {
        id: "q_1",
        loopId: "loop_1",
        intent: "Send Pranjali the villa link",
        observation: "I saw a booking.com link at 21:04",
        quote: "here — https://booking.com/villa-amara",
        at: null,
      },
    ],
    waitingOnOthers: [
      { id: "w_1", personLabel: "Pranjali", intent: "broadband renews 28th", dueLabel: null },
    ],
  };
}

function makeClient(over: Partial<TasksClient> = {}): TasksClient {
  return {
    getCoverage: vi.fn(async () => ({ mode: "steady" as const, rows: [] })),
    listTasks: vi.fn(async () => page([mine, theirs, contextual, suggestion, lapsed])),
    markTask: vi.fn(async () => receipt),
    acceptSuggestion: vi.fn(async () => receipt),
    rejectSuggestion: vi.fn(async () => receipt),
    answerDoneCheck: vi.fn(async () => receipt),
    ...over,
  };
}

const list = (name: string) => screen.getByRole("region", { name }) as HTMLElement;
const row = (id: string) => document.querySelector(`[data-task-id="${id}"]`) as HTMLElement;

function renderTab(client: TasksClient, onOpenSpace?: (id: string) => void) {
  return render(<TasksTab client={client} coveragePollMs={0} onOpenSpace={onOpenSpace} />);
}

describe("no loop owned by another person appears in Tasks — the acceptance criterion", () => {
  it("keeps another person's loop out of both task lists", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");

    const explicit = list("YOU SAID YOU'D DO THIS");
    const implicit = list("SUGGESTED BY YOUR TWIN");
    expect(within(explicit).queryByText("hold the villa till 20 Aug")).toBeNull();
    expect(within(implicit).queryByText("hold the villa till 20 Aug")).toBeNull();
    expect(row("loop_rohan")).toBeNull();
  });

  it("files it under waiting on others, with the reason it was excluded", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");
    const waiting = list("Waiting on others");
    expect(within(waiting).getByText(/hold the villa till 20 Aug/)).toBeTruthy();
    expect(within(waiting).getByText(/owned by Rohan — context, not a task/)).toBeTruthy();
    expect(within(waiting).getByText(/not your tasks — context only/)).toBeTruthy();
  });

  it("also excludes a context triage the worker sent as a task", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");
    expect(row("loop_cx")).toBeNull();
    expect(
      within(list("Waiting on others")).getByText(/triaged as context — not yours to act on/),
    ).toBeTruthy();
  });

  it("counts only your loops in the header", async () => {
    renderTab(makeClient());
    expect(await screen.findByText("● 1 you said you'd do")).toBeTruthy();
    expect(screen.getByText("○ 1 suggested")).toBeTruthy();
  });
});

describe("two lists, different verbs (§14.7 rule 1)", () => {
  it("explicit tasks get done / drop / snooze", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Send Pranjali the Goa villa link");
    const mineRow = row("loop_1");
    for (const verb of ["done", "drop", "snooze"]) {
      expect(within(mineRow).getByRole("button", { name: verb })).toBeTruthy();
    }
    fireEvent.click(within(mineRow).getByRole("button", { name: "done" }));
    await waitFor(() =>
      expect(client.markTask).toHaveBeenCalledWith({ id: "loop_1", gesture: "done", actor: "user" }),
    );
  });

  it("implicit suggestions get yes / not useful, and say that rejection teaches", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Compare broadband plans in Bangalore");
    const sugg = row("loop_impl");
    expect(within(sugg).getByText(/rejection teaches, permanently/)).toBeTruthy();
    expect(within(sugg).getByText(/inferred from: "ACT is way overpriced"/)).toBeTruthy();
    expect(within(sugg).queryByRole("button", { name: "done" })).toBeNull();

    fireEvent.click(within(sugg).getByRole("button", { name: "not useful" }));
    await waitFor(() =>
      expect(client.rejectSuggestion).toHaveBeenCalledWith({ id: "loop_impl", actor: "user" }),
    );
    expect(await screen.findByText(/mutation mut_3/)).toBeTruthy();
  });
});

describe("lapsed tasks say why", () => {
  it("prints born lapsed in full", async () => {
    renderTab(makeClient());
    await screen.findByText("Reply to Dr. Rao about Tuesday");
    expect(
      within(row("loop_lapsed")).getByText(
        /LAPSED — born lapsed — the due date had passed when it was found/,
      ),
    ).toBeTruthy();
  });
});

describe("did you do this?", () => {
  it("is one tap, with the evidence quote and the observation", async () => {
    const client = makeClient();
    renderTab(client);
    const check = await screen.findByText("Send Pranjali the villa link");
    const item = check.closest("li") as HTMLElement;
    expect(within(item).getByText("— I saw a booking.com link at 21:04")).toBeTruthy();
    expect(within(item).getByText("here — https://booking.com/villa-amara")).toBeTruthy();

    fireEvent.click(within(item).getByRole("button", { name: "yes" }));
    await waitFor(() =>
      expect(client.answerDoneCheck).toHaveBeenCalledWith({ id: "q_1", done: true, actor: "user" }),
    );
  });
});

describe("grouping and provenance", () => {
  it("groups each list by space", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");
    expect(
      within(list("YOU SAID YOU'D DO THIS")).getByRole("heading", { name: "Goa trip" }),
    ).toBeTruthy();
    expect(
      within(list("SUGGESTED BY YOUR TWIN")).getByRole("heading", { name: "Broadband renewal" }),
    ).toBeTruthy();
  });

  it("[ why? ] shows the evidence, the origin and the triage", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");
    const mineRow = row("loop_1");
    fireEvent.click(within(mineRow).getByRole("button", { name: "why?" }));
    expect(within(mineRow).getByText("ev_1")).toBeTruthy();
    expect(
      within(mineRow).getByText(/origin explicit · triage approve · owner you · confidence 0\.90/),
    ).toBeTruthy();
  });

  it("shows the evidence quote on the face of the row", async () => {
    renderTab(makeClient());
    await screen.findByText("Send Pranjali the Goa villa link");
    expect(
      within(row("loop_1")).getByText("i'll send you that villa link tonight"),
    ).toBeTruthy();
  });
});

describe("provisional output (§14.0b)", () => {
  it("marks a live task and its pending attachment", async () => {
    renderTab(makeClient({ listTasks: vi.fn(async () => page([mine, live])) }));
    await screen.findByText("Book the cab");
    const liveRow = row("loop_live");
    expect(within(liveRow).getByText(/conversation in progress · updated 12s ago/)).toBeTruthy();
    expect(within(liveRow).getByText(/1 voice note still transcribing/)).toBeTruthy();
  });

  it("keeps a vanished provisional task, struck through, until dismissed", async () => {
    const listTasks = vi
      .fn<TasksClient["listTasks"]>()
      .mockResolvedValueOnce(page([mine, live]))
      .mockResolvedValue(page([mine]));
    renderTab(makeClient({ listTasks }));
    await screen.findByText("Book the cab");

    fireEvent.click(within(row("loop_1")).getByRole("button", { name: "done" }));
    const withdrawn = await screen.findByText(/withdrawn as the conversation resolved/);
    expect(screen.getByText("Book the cab")).toBeTruthy();

    fireEvent.click(within(withdrawn as HTMLElement).getByRole("button", { name: "dismiss" }));
    await waitFor(() => expect(screen.queryByText("Book the cab")).toBeNull());
  });
});

describe("chrome", () => {
  it("carries the coverage meter, like all eight surfaces", async () => {
    const client = makeClient();
    renderTab(client);
    await waitFor(() => expect(client.getCoverage).toHaveBeenCalled());
  });

  it("opens the space a task belongs to", async () => {
    const onOpenSpace = vi.fn();
    renderTab(makeClient(), onOpenSpace);
    await screen.findByText("Send Pranjali the Goa villa link");
    fireEvent.click(within(row("loop_1")).getByRole("button", { name: "open space" }));
    expect(onOpenSpace).toHaveBeenCalledWith("arc_77");
  });

  it("reports a failed read", async () => {
    renderTab(makeClient({ listTasks: vi.fn(async () => { throw new Error("down"); }) }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "down");
  });
});
