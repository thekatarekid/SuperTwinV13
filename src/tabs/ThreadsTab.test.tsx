// The Threads surface (arch §14.4 arcs, build item 2.7).
//
// What this file is really testing:
//
//  1. EVERY MEMBERSHIP ROW SHOWS ITS SIGNAL AND VALUE — the item's acceptance
//     criterion. Both kinds of row: the BOUND BY signals and the episodes.
//  2. SIGNALS ARE IN PRECEDENCE ORDER — the ladder order (§11.2), not the
//     worker's array order.
//  3. ALL ARCS, PROMOTED OR NOT. An unpromoted thread is listed and says so.
//  4. THE UNSURE QUEUE IS THE ONLY PLACE A `un` IS RESOLVED (§11.2 rule 5).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ThreadsTab } from "./ThreadsTab";
import type {
  ArcQuestionView,
  ArcView,
  ArcsPage,
  BindingSignalView,
  ThreadsClient,
} from "../lib/threads-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

// Deliberately NOT in precedence order — the surface must sort them.
const bindings: BindingSignalView[] = [
  {
    id: "sig_adj",
    rung: 4,
    signal: "adjudicated",
    value: 0.9,
    measure: "confidence",
    between: "mmt ep",
    episodeId: "epi_4",
    reason: "same trip, same villa",
  },
  {
    id: "sig_overlap",
    rung: 2,
    signal: "overlap",
    value: 0.71,
    measure: "score",
    between: "wa ↔ wa",
    episodeId: "epi_2",
    reason: null,
  },
  {
    id: "sig_url",
    rung: 1,
    signal: "url",
    value: "booking.com/villa-amara",
    measure: "exact",
    between: "web ↔ wa",
    episodeId: "epi_1",
    reason: null,
  },
  {
    id: "sig_attendees",
    rung: 1,
    signal: "attendees",
    value: 0.75,
    measure: "jaccard",
    between: "cal ↔ wa",
    episodeId: "epi_3",
    reason: null,
  },
];

const goa: ArcView = {
  id: "arc_1",
  label: "Goa trip",
  state: "live",
  pinned: false,
  promotedSpaceId: "spc_1",
  promotedLabel: "Goa trip",
  bindings,
  episodes: [
    { episodeId: "epi_1", label: "villa shortlist", sourceLabel: "wa", at: "2025-06-04T00:00:00.000Z" },
    { episodeId: "epi_2", label: "villa photos", sourceLabel: "wa", at: "2025-06-20T00:00:00.000Z" },
    { episodeId: "epi_3", label: "trip invite", sourceLabel: "cal", at: "2025-08-01T00:00:00.000Z" },
    { episodeId: "epi_4", label: "hotel confirm", sourceLabel: "mmt", at: "2025-09-01T00:00:00.000Z" },
    // No signal on record — the surface must SAY so, not go blank.
    { episodeId: "epi_5", label: "packing list", sourceLabel: "wa", at: "2025-09-02T00:00:00.000Z" },
  ],
  contributions: [
    { episodeId: "epi_1", sourceLabel: "wa", at: "2025-06-04T00:00:00.000Z" },
    { episodeId: "epi_2", sourceLabel: "wa", at: "2025-06-20T00:00:00.000Z" },
    { episodeId: "epi_3", sourceLabel: "cal", at: "2025-08-01T00:00:00.000Z" },
    { episodeId: "epi_4", sourceLabel: "mmt", at: "2025-09-01T00:00:00.000Z" },
  ],
  anchors: [
    { id: "ent_1", label: "Rohan" },
    { id: "ent_2", label: "Villa Amara" },
  ],
  sourceCount: 5,
  stillGrowing: true,
  growingNote: "90d+ history queued",
  provisional: false,
  lastActiveAt: "2025-09-02T00:00:00.000Z",
};

const unpromoted: ArcView = {
  ...goa,
  id: "arc_2",
  label: "broadband billing",
  state: "dormant",
  promotedSpaceId: null,
  promotedLabel: null,
  bindings: [],
  episodes: [{ episodeId: "epi_9", label: "ACT invoice", sourceLabel: "gmail", at: "2025-07-01T00:00:00.000Z" }],
  contributions: [{ episodeId: "epi_9", sourceLabel: "gmail", at: "2025-07-01T00:00:00.000Z" }],
  anchors: [],
  sourceCount: 1,
  stillGrowing: false,
  growingNote: null,
  provisional: true,
};

const page = (arcs: ArcView[] = [goa, unpromoted]): ArcsPage => ({
  arcs,
  counts: { live: 18, dormant: 24, archived: 61 },
});

const question: ArcQuestionView = {
  id: "aq_1",
  episodeId: "epi_7",
  episodeLabel: "flight price alerts",
  arcId: "arc_1",
  arcLabel: "Goa trip",
  reasoning: "both mention the same dates but share no booking, person or place",
  confidence: 0.55,
  askedAt: "2025-09-03T00:00:00.000Z",
};

const receipt: MutationReceipt = {
  mutationId: "mut_77",
  actor: "user",
  targetKind: "arc",
  targetId: "arc_1",
  field: "pin",
};

function makeClient(over: Partial<ThreadsClient> = {}): ThreadsClient {
  return {
    getCoverage: vi.fn(async () => ({
      mode: "bootstrap" as const,
      rows: [{ horizon: "d30" as const, totalUnits: 800, doneUnits: 568 }],
      pausedLabel: null,
      remainingMinutes: 14,
    })),
    listArcs: vi.fn(async () => page()),
    listArcQuestions: vi.fn(async () => [question]),
    removeArcEpisode: vi.fn(async () => receipt),
    splitArc: vi.fn(async () => receipt),
    mergeArc: vi.fn(async () => receipt),
    pinArc: vi.fn(async () => receipt),
    relabelArc: vi.fn(async () => receipt),
    answerArcQuestion: vi.fn(async () => receipt),
    ...over,
  } as unknown as ThreadsClient;
}

const mount = (client: ThreadsClient) => render(<ThreadsTab client={client} coveragePollMs={0} />);

async function card(arcId: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector(`[data-arc-id="${arcId}"]`);
    expect(found).toBeTruthy();
  });
  return found as unknown as HTMLElement;
}

describe("Threads surface — chrome, filters and scope", () => {
  it("carries the coverage meter, like every surface (§14.0)", async () => {
    mount(makeClient());
    await waitFor(() => expect(screen.getByLabelText("Understanding your history")).toBeTruthy());
  });

  it("offers the three state filters with counts and filters by them", async () => {
    const client = makeClient();
    mount(client);
    expect(await screen.findByRole("button", { name: "live 18" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "dormant 24" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "archived 61" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "archived 61" }));
    await waitFor(() =>
      expect(client.listArcs).toHaveBeenCalledWith(
        expect.objectContaining({ state: "archived" }),
        expect.anything(),
      ),
    );
  });

  it("lists ALL arcs, promoted or not, and says which is which", async () => {
    mount(makeClient());
    const promoted = await card("arc_1");
    const plain = await card("arc_2");

    expect(within(promoted).getByText(/space: “Goa trip” ──▶/)).toBeTruthy();
    // Promotion is a field on the arc, so an unpromoted thread is still listed.
    expect(within(plain).getByText(/space: not promoted/)).toBeTruthy();
  });

  it("searches and filters to pinned", async () => {
    const client = makeClient();
    mount(client);
    await card("arc_1");

    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "goa" } });
    await waitFor(() =>
      expect(client.listArcs).toHaveBeenCalledWith(
        expect.objectContaining({ q: "goa" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /pinned only/ }));
    await waitFor(() =>
      expect(client.listArcs).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedOnly: true }),
        expect.anything(),
      ),
    );
  });
});

describe("binding signals in precedence order with measured values", () => {
  it("orders the BOUND BY rows by ladder rung, not by the worker's order", async () => {
    mount(makeClient());
    const arc = await card("arc_1");
    const rows = within(arc)
      .getByLabelText("Binding signals in precedence order")
      .querySelectorAll("li");

    expect([...rows].map((li) => li.getAttribute("data-rung"))).toEqual(["1", "1", "2", "4"]);
  });

  it("shows every signal with its measured value, formatted by its measure", async () => {
    mount(makeClient());
    const arc = await card("arc_1");
    const list = within(arc).getByLabelText("Binding signals in precedence order");

    expect(within(list).getByText("booking.com/villa-amara · exact")).toBeTruthy();
    expect(within(list).getByText("J=0.75")).toBeTruthy();
    expect(within(list).getByText("0.71")).toBeTruthy();
    expect(within(list).getByText("conf 0.90")).toBeTruthy();
  });

  it("never renders a signal row without a value", async () => {
    const unmeasured: ArcView = {
      ...goa,
      id: "arc_3",
      bindings: [{ ...bindings[1], id: "sig_x", value: null, measure: null }],
    };
    mount(makeClient({ listArcs: vi.fn(async () => page([unmeasured])) }));
    const arc = await card("arc_3");
    expect(within(arc).getByText("not measured")).toBeTruthy();
  });

  it("gives every episode row the signal that admitted it", async () => {
    mount(makeClient());
    const arc = await card("arc_1");
    const list = within(arc).getByLabelText("Episodes in this thread");

    expect(within(list).getByText("① url · booking.com/villa-amara · exact")).toBeTruthy();
    expect(within(list).getByText("② overlap · 0.71")).toBeTruthy();
    expect(within(list).getByText("④ adjudicated · conf 0.90")).toBeTruthy();
    // The one membership nothing explains is called out, not left blank.
    expect(within(list).getByText(/unbound — no signal on record/)).toBeTruthy();
  });

  it("[ why together? ] expands the stated reasons verbatim", async () => {
    mount(makeClient());
    const arc = await card("arc_1");

    expect(within(arc).queryByText("“same trip, same villa”")).toBeNull();
    fireEvent.click(within(arc).getByRole("button", { name: "why together?" }));
    expect(within(arc).getByText("“same trip, same villa”")).toBeTruthy();
    // A code rung has no stated reason and says so rather than faking one.
    expect(within(arc).getAllByText(/decided in code, no stated reason/).length).toBeGreaterThan(0);
  });
});

describe("the source-contribution timeline", () => {
  it("draws one mark per contribution, ends labelled from the data", async () => {
    mount(makeClient());
    const arc = await card("arc_1");
    const timeline = within(arc).getByLabelText("Source contributions");

    expect(timeline.querySelectorAll(".arc-timeline__mark")).toHaveLength(4);
    expect(within(timeline).getByText(/4 contributions from wa, cal, mmt/)).toBeTruthy();
  });

  it("marks an arc that is still receiving older cohorts", async () => {
    mount(makeClient());
    const arc = await card("arc_1");
    expect(within(arc).getByText(/still growing — 90d\+ history queued/)).toBeTruthy();
  });
});

describe("the unsure queue is the human loop (§11.2 rule 5)", () => {
  it("shows the question with P-AG2's reasoning verbatim", async () => {
    mount(makeClient());
    const queue = await screen.findByLabelText("Unsure queue");

    expect(within(queue).getByText(/“flight price alerts” episode → thread “Goa trip”\?/)).toBeTruthy();
    expect(
      within(queue).getByText("“both mention the same dates but share no booking, person or place”"),
    ).toBeTruthy();
    expect(within(queue).getByText(/nothing is bound while a question waits/)).toBeTruthy();
  });

  it("answers as the user and prints the receipt", async () => {
    const client = makeClient();
    mount(client);
    const queue = await screen.findByLabelText("Unsure queue");

    fireEvent.click(within(queue).getByRole("button", { name: "no, separate" }));
    await waitFor(() =>
      expect(client.answerArcQuestion).toHaveBeenCalledWith({
        id: "aq_1",
        answer: "separate",
        actor: "user",
      }),
    );
    expect(await screen.findByText(/mutation mut_77 · actor user/)).toBeTruthy();
  });

  it("renders no queue when nothing is unsure", async () => {
    mount(makeClient({ listArcQuestions: vi.fn(async () => []) }));
    await card("arc_1");
    expect(screen.queryByLabelText("Unsure queue")).toBeNull();
  });
});

describe("gestures write mutations(actor:user)", () => {
  it("removes an episode from the thread", async () => {
    const client = makeClient();
    mount(client);
    const arc = await card("arc_1");
    const row = arc.querySelector('[data-episode-id="epi_2"]') as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "remove episode" }));
    await waitFor(() =>
      expect(client.removeArcEpisode).toHaveBeenCalledWith({
        id: "arc_1",
        episodeId: "epi_2",
        actor: "user",
      }),
    );
  });

  it("splits picked episodes into their own thread", async () => {
    const client = makeClient();
    mount(client);
    const arc = await card("arc_1");

    fireEvent.click(within(arc).getByRole("button", { name: "split arc" }));
    fireEvent.click(within(arc).getByLabelText("villa photos"));
    fireEvent.click(within(arc).getByRole("button", { name: "confirm split" }));

    await waitFor(() =>
      expect(client.splitArc).toHaveBeenCalledWith({
        id: "arc_1",
        episodeIds: ["epi_2"],
        actor: "user",
      }),
    );
  });

  it("merges into another thread, pins and relabels", async () => {
    // Distinct receipts: three gestures write three `mutations` rows, and the
    // strip keys on the mutation id.
    const client = makeClient({
      mergeArc: vi.fn(async () => ({ ...receipt, mutationId: "mut_78", field: "merge" })),
      pinArc: vi.fn(async () => ({ ...receipt, mutationId: "mut_79" })),
      relabelArc: vi.fn(async () => ({ ...receipt, mutationId: "mut_80", field: "relabel" })),
    });
    mount(client);
    const arc = await card("arc_1");

    fireEvent.click(within(arc).getByRole("button", { name: "merge" }));
    fireEvent.change(within(arc).getByLabelText("Merge into"), { target: { value: "arc_2" } });
    fireEvent.click(within(arc).getByRole("button", { name: "confirm merge" }));
    await waitFor(() =>
      expect(client.mergeArc).toHaveBeenCalledWith({ id: "arc_1", into: "arc_2", actor: "user" }),
    );

    fireEvent.click(within(arc).getByRole("button", { name: "pin" }));
    await waitFor(() =>
      expect(client.pinArc).toHaveBeenCalledWith({ id: "arc_1", pinned: true, actor: "user" }),
    );

    fireEvent.click(within(arc).getByRole("button", { name: "relabel" }));
    fireEvent.change(within(arc).getByLabelText("Relabel to"), { target: { value: "Goa 2025" } });
    fireEvent.click(within(arc).getByRole("button", { name: "confirm relabel" }));
    await waitFor(() =>
      expect(client.relabelArc).toHaveBeenCalledWith({
        id: "arc_1",
        label: "Goa 2025",
        actor: "user",
      }),
    );
  });

  it("keeps a provisional thread that vanishes, struck through and labelled (§14.0b)", async () => {
    const listArcs = vi.fn().mockResolvedValueOnce(page()).mockResolvedValue(page([goa]));
    const client = makeClient({ listArcs });
    mount(client);
    await card("arc_2");

    const arc = await card("arc_1");
    fireEvent.click(within(arc).getByRole("button", { name: "pin" }));

    const gone = await card("arc_2");
    await waitFor(() => expect(gone.className).toMatch(/arc--retracted/));
    expect(within(gone).getByRole("status").textContent).toMatch(/no longer listed/);
  });

  it("reports a failed gesture rather than pretending it wrote", async () => {
    const client = makeClient({
      pinArc: vi.fn(async () => {
        throw new Error("POST /api/arcs/arc_1/pin → 500");
      }),
    });
    mount(client);
    const arc = await card("arc_1");
    fireEvent.click(within(arc).getByRole("button", { name: "pin" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/pin failed/);
    expect(screen.queryByText(/mutation mut_77/)).toBeNull();
  });
});
