// The Episodes surface (arch §14.3, build item 2.7).
//
// What this file is really testing:
//
//  1. EVERY MEMBERSHIP ROW SHOWS ITS SIGNAL AND VALUE — the item's acceptance
//     criterion, asserted on a seed row, an attach row and a split row.
//  2. `[ why? ]` RENDERS THE PERSISTED VERDICT — the exact candidates the model
//     saw and its stated reason, verbatim, and an honest "no model was asked"
//     when a code rule decided it.
//  3. GESTURES WRITE mutations(actor:user) and print their receipt.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { EpisodesTab } from "./EpisodesTab";
import type {
  EpisodeSessionView,
  EpisodeView,
  EpisodesClient,
  EpisodesPage,
} from "../lib/episodes-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

const seed: EpisodeSessionView = {
  sessionId: "ses_1",
  streamLabel: "Rohan",
  startedAt: "2025-08-11T09:12:00.000Z",
  provenance: "seed",
  decidedBy: "code:1v1",
  confidence: 1,
  reason: "1:1 default, no model call",
  splitFromSessionId: null,
  splitTopicCount: null,
  verdict: null,
  sessionOpen: false,
};

const attached: EpisodeSessionView = {
  sessionId: "ses_2",
  streamLabel: "Rohan",
  startedAt: "2025-08-13T20:40:00.000Z",
  provenance: "attached",
  decidedBy: "agent:p-ep2",
  confidence: 0.93,
  reason: "continues the Amara booking",
  splitFromSessionId: null,
  splitTopicCount: null,
  verdict: {
    id: "ver_5",
    decision: "at",
    reason: "continues the Amara booking discussed on Monday",
    confidence: 0.93,
    candidates: [
      { episodeId: "epi_1", label: "villa shortlist for Goa", lastActiveAt: "2025-08-11T09:41:00.000Z" },
      { episodeId: "epi_9", label: "flight price alerts", lastActiveAt: "2025-08-10T18:00:00.000Z" },
    ],
    model: "claude-haiku",
    createdAt: "2025-08-13T20:41:00.000Z",
  },
  sessionOpen: true,
};

const split: EpisodeSessionView = {
  sessionId: "ses_2",
  streamLabel: "Rohan",
  startedAt: "2025-08-13T20:40:00.000Z",
  provenance: "split",
  decidedBy: "agent:p-ep2",
  confidence: 0.88,
  reason: "a second topic ran alongside the villa thread",
  splitFromSessionId: "ses_2",
  splitTopicCount: 2,
  verdict: null,
  sessionOpen: false,
};

const villa: EpisodeView = {
  id: "epi_1",
  label: "villa shortlist for Goa",
  labelSource: "agent:p-ep1",
  state: "open",
  outcome: null,
  sourceLabel: "WhatsApp",
  streamId: "str_1",
  streamLabel: "Rohan",
  startedAt: "2025-08-11T09:12:00.000Z",
  lastActiveAt: "2025-08-13T20:40:00.000Z",
  quietDays: null,
  sessions: [seed, attached],
  entities: [
    { id: "ent_1", label: "Rohan" },
    { id: "ent_2", label: "Villa Amara" },
    { id: "ent_3", label: "Goa" },
  ],
  arc: { id: "arc_1", label: "Goa trip" },
  provisional: false,
  splitFromEpisodeId: null,
};

const medical: EpisodeView = {
  id: "epi_2",
  label: "mom's medical reports",
  labelSource: "agent:p-ep1",
  state: "closed",
  outcome: "faded",
  sourceLabel: "WhatsApp",
  streamId: "str_1",
  streamLabel: "Rohan",
  startedAt: "2025-08-13T20:40:00.000Z",
  lastActiveAt: "2025-08-13T21:00:00.000Z",
  quietDays: 21,
  sessions: [split],
  entities: [],
  arc: null,
  provisional: true,
  splitFromEpisodeId: "epi_1",
};

const page = (episodes: EpisodeView[] = [villa, medical]): EpisodesPage => ({
  episodes,
  counts: { open: 22, concluded: 61, faded: 31 },
  streams: [
    { id: "str_1", label: "Rohan" },
    { id: "str_2", label: "Pranjali" },
  ],
});

const receipt: MutationReceipt = {
  mutationId: "mut_31",
  actor: "user",
  targetKind: "episode",
  targetId: "epi_1",
  field: "detach",
};

function makeClient(over: Partial<EpisodesClient> = {}): EpisodesClient {
  return {
    getCoverage: vi.fn(async () => ({
      mode: "bootstrap" as const,
      rows: [{ horizon: "d30" as const, totalUnits: 800, doneUnits: 568 }],
      pausedLabel: null,
      remainingMinutes: 14,
    })),
    listEpisodes: vi.fn(async () => page()),
    detachSession: vi.fn(async () => receipt),
    splitEpisode: vi.fn(async () => receipt),
    mergeEpisode: vi.fn(async () => receipt),
    relabelEpisode: vi.fn(async () => receipt),
    closeEpisode: vi.fn(async () => receipt),
    ...over,
  } as unknown as EpisodesClient;
}

const mount = (client: EpisodesClient) =>
  render(<EpisodesTab client={client} coveragePollMs={0} />);

async function card(episodeId: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector(`[data-episode-id="${episodeId}"]`);
    expect(found).toBeTruthy();
  });
  return found as unknown as HTMLElement;
}

describe("Episodes surface — chrome and filters", () => {
  it("carries the coverage meter, like every surface (§14.0)", async () => {
    mount(makeClient());
    await waitFor(() => expect(screen.getByLabelText("Understanding your history")).toBeTruthy());
  });

  it("offers the three state filters with their counts", async () => {
    mount(makeClient());
    expect(await screen.findByRole("button", { name: "open 22" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "closed·concluded 61" })).toBeTruthy();
    // A fade is the clock's doing, a conclusion is the episode's — never merged.
    expect(screen.getByRole("button", { name: "closed·faded 31" })).toBeTruthy();
  });

  it("filters by state and by stream", async () => {
    const client = makeClient();
    mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "closed·faded 31" }));
    await waitFor(() =>
      expect(client.listEpisodes).toHaveBeenCalledWith(
        expect.objectContaining({ state: "faded" }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by stream"), { target: { value: "str_2" } });
    await waitFor(() =>
      expect(client.listEpisodes).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: "str_2" }),
        expect.anything(),
      ),
    );
  });

  it("reports a failed read instead of rendering an empty surface", async () => {
    mount(makeClient({ listEpisodes: vi.fn(async () => { throw new Error("GET /api/episodes → 500"); }) }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/api\/episodes → 500/);
  });
});

describe("every membership row shows its signal and value", () => {
  it("shows the seed row's rule and confidence", async () => {
    mount(makeClient());
    const episode = await card("epi_1");
    expect(within(episode).getByText("seed · code:1v1 · conf 1.00")).toBeTruthy();
  });

  it("shows the attach row's model, confidence and reason", async () => {
    mount(makeClient());
    const episode = await card("epi_1");
    expect(within(episode).getByText("ATTACHED · agent:p-ep2 · conf 0.93")).toBeTruthy();
    expect(within(episode).getByText("“continues the Amara booking”")).toBeTruthy();
  });

  it("shows split provenance with the session it was cut from", async () => {
    mount(makeClient());
    const episode = await card("epi_2");
    expect(
      within(episode).getByText("SPLIT from session ses_2 (2 topics) · agent:p-ep2 · conf 0.88"),
    ).toBeTruthy();
  });

  it("never leaves a row without a signal or a value", async () => {
    const bare: EpisodeView = {
      ...villa,
      id: "epi_3",
      sessions: [{ ...seed, decidedBy: null, confidence: null }],
    };
    mount(makeClient({ listEpisodes: vi.fn(async () => page([bare])) }));
    const episode = await card("epi_3");
    expect(within(episode).getByText(/unattributed · no confidence measured/)).toBeTruthy();
  });
});

describe("[ why? ] renders the persisted verdict (§14.3)", () => {
  it("shows the exact candidates the model saw and its stated reason", async () => {
    mount(makeClient());
    const episode = await card("epi_1");
    const row = within(episode).getByText("ATTACHED · agent:p-ep2 · conf 0.93").closest("li")!;

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "why?" }));

    const note = await within(episode).findByRole("note");
    expect(note.textContent).toContain("villa shortlist for Goa [epi_1]");
    expect(note.textContent).toContain("flight price alerts [epi_9]");
    // Verbatim, not paraphrased.
    expect(note.textContent).toContain("“continues the Amara booking discussed on Monday”");
    expect(note.textContent).toContain("ver_5");
  });

  it("says no model was asked when a code rule decided it", async () => {
    mount(makeClient());
    const episode = await card("epi_1");
    const row = within(episode).getByText("seed · code:1v1 · conf 1.00").closest("li")!;

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "why?" }));

    const note = await within(episode).findByRole("note");
    expect(note.textContent).toMatch(/no model was asked/);
    expect(note.textContent).toContain("code:1v1");
  });
});

describe("live output is marked (§14.0b)", () => {
  it("marks an episode whose session is still open", async () => {
    mount(makeClient());
    const episode = await card("epi_1");
    expect(within(episode).getAllByText(/conversation in progress/).length).toBeGreaterThan(0);
  });

  it("explains a fade as the clock's doing, with the measured quiet", async () => {
    mount(makeClient());
    const episode = await card("epi_2");
    expect(within(episode).getByText(/faded — quiet for 21 days, not concluded/)).toBeTruthy();
  });

  it("keeps a provisional episode that vanishes, struck through and labelled", async () => {
    const listEpisodes = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValue(page([villa]));
    const client = makeClient({ listEpisodes });
    mount(client);
    await card("epi_2");

    // A gesture triggers the reload that loses epi_2.
    const episode = await card("epi_1");
    fireEvent.click(within(episode).getByRole("button", { name: "relabel" }));
    fireEvent.click(within(episode).getByRole("button", { name: "confirm relabel" }));

    const gone = await card("epi_2");
    await waitFor(() => expect(gone.className).toMatch(/episode--retracted/));
    expect(within(gone).getByRole("status").textContent).toMatch(/no longer listed/);
  });
});

describe("gestures write mutations(actor:user)", () => {
  it("detaches a session and prints the receipt", async () => {
    const client = makeClient();
    mount(client);
    const episode = await card("epi_1");

    const row = within(episode).getByText("ATTACHED · agent:p-ep2 · conf 0.93").closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "detach session" }));

    await waitFor(() =>
      expect(client.detachSession).toHaveBeenCalledWith({
        id: "epi_1",
        sessionId: "ses_2",
        actor: "user",
      }),
    );
    expect(await screen.findByText(/mutation mut_31 · actor user/)).toBeTruthy();
  });

  it("splits the picked sessions out", async () => {
    const client = makeClient();
    mount(client);
    const episode = await card("epi_1");

    fireEvent.click(within(episode).getByRole("button", { name: "split" }));
    fireEvent.click(within(episode).getByLabelText(/ses_2/));
    fireEvent.click(within(episode).getByRole("button", { name: "confirm split" }));

    await waitFor(() =>
      expect(client.splitEpisode).toHaveBeenCalledWith({
        id: "epi_1",
        sessionIds: ["ses_2"],
        actor: "user",
      }),
    );
  });

  it("offers merge back only on an episode that was split out", async () => {
    const client = makeClient();
    mount(client);
    const villaCard = await card("epi_1");
    expect(within(villaCard).queryByRole("button", { name: "merge back" })).toBeNull();

    const medicalCard = await card("epi_2");
    fireEvent.click(within(medicalCard).getByRole("button", { name: "merge back" }));
    await waitFor(() =>
      expect(client.mergeEpisode).toHaveBeenCalledWith({
        id: "epi_2",
        into: "epi_1",
        actor: "user",
      }),
    );
  });

  it("relabels and closes as the user", async () => {
    const client = makeClient({
      relabelEpisode: vi.fn(async () => ({ ...receipt, mutationId: "mut_32", field: "relabel" })),
      closeEpisode: vi.fn(async () => ({ ...receipt, mutationId: "mut_33", field: "close" })),
    });
    mount(client);
    const episode = await card("epi_1");

    fireEvent.click(within(episode).getByRole("button", { name: "relabel" }));
    fireEvent.change(within(episode).getByLabelText("Relabel to"), {
      target: { value: "Goa villa shortlist" },
    });
    fireEvent.click(within(episode).getByRole("button", { name: "confirm relabel" }));
    await waitFor(() =>
      expect(client.relabelEpisode).toHaveBeenCalledWith({
        id: "epi_1",
        label: "Goa villa shortlist",
        actor: "user",
      }),
    );

    fireEvent.click(within(episode).getByRole("button", { name: "close" }));
    fireEvent.click(within(episode).getByRole("button", { name: "confirm close" }));
    await waitFor(() =>
      expect(client.closeEpisode).toHaveBeenCalledWith({
        id: "epi_1",
        outcome: "concluded",
        actor: "user",
      }),
    );
  });

  it("reports a failed gesture rather than pretending it wrote", async () => {
    const client = makeClient({
      relabelEpisode: vi.fn(async () => {
        throw new Error("POST /api/episodes/epi_1/relabel → 409");
      }),
    });
    mount(client);
    const episode = await card("epi_1");
    fireEvent.click(within(episode).getByRole("button", { name: "relabel" }));
    fireEvent.click(within(episode).getByRole("button", { name: "confirm relabel" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/relabel failed/);
    expect(screen.queryByText(/mutation mut_31/)).toBeNull();
  });
});
