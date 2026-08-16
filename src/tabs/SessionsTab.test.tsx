// The Sessions surface (arch §14.2, build item 1.11).
//
// Two things this file is really testing:
//
//  1. EVERY SESSION BOUNDARY IS EXPLAINABLE IN ONE LINE — the item's acceptance
//     criterion. Both ends, always, with the rule and the measured value.
//  2. REPLAY DIFFS, IT DOES NOT APPLY. The apply call must be unreachable until
//     a human has seen the diff and confirmed it, because a re-cut rewrites
//     session ids and everything built on them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SessionsTab } from "./SessionsTab";
import type {
  MutationReceipt,
  ReplayDiff,
  SessionView,
  SessionsPage,
  StreamSegmentation,
  SurfacesClient,
} from "../lib/surfaces-client";

afterEach(cleanup);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const sealed: SessionView = {
  id: "ses_1",
  streamId: "str_1",
  streamLabel: "Pranjali",
  sourceId: "whatsapp",
  sourceLabel: "WhatsApp",
  kind: "conversation",
  startedAt: "2025-08-14T09:12:00.000Z",
  endedAt: "2025-08-14T09:41:00.000Z",
  eventCount: 14,
  participants: ["me", "Pranjali"],
  status: "sealed",
  sealMode: "debounce",
  sealedAt: "2025-08-14T10:26:00.000Z",
  contentHash: "3f9ab21c",
  supersededHash: null,
  boundaryStart: {
    reason: "gap",
    measured: { gap_ms: 7 * HOUR + 20 * MINUTE, threshold_ms: 6 * HOUR },
  },
  boundaryEnd: { reason: "debounce", measured: { idle_ms: 45 * MINUTE, debounce_ms: 45 * MINUTE } },
  pendingEnrichmentCount: 0,
  enrichmentNote: null,
  reprocessCount: 0,
  reprocessedAt: null,
  reprocessReason: null,
  lateArrival: false,
  overlapOf: null,
  understood: true,
};

const open: SessionView = {
  ...sealed,
  id: "ses_2",
  streamId: "str_2",
  streamLabel: "Rohan",
  eventCount: 9,
  status: "open",
  sealMode: null,
  sealedAt: null,
  contentHash: null,
  boundaryEnd: null,
  pendingEnrichmentCount: 1,
  enrichmentNote: "1 voice note pending · text understood immediately",
  reprocessCount: 1,
  reprocessedAt: "2025-08-14T14:53:00.000Z",
  reprocessReason: "transcript landed",
  understood: false,
};

const page = (sessions: SessionView[] = [sealed, open]): SessionsPage => ({
  sessions,
  sealedCount: 38,
  sources: [{ id: "whatsapp", label: "WhatsApp" }],
  streams: [
    { id: "str_1", label: "Pranjali", sourceId: "whatsapp" },
    { id: "str_2", label: "Rohan", sourceId: "whatsapp" },
  ],
});

const segmentation: StreamSegmentation = {
  streamId: "str_1",
  streamLabel: "Pranjali",
  kind: "conversation",
  defaults: {
    gapMs: 6 * HOUR,
    shiftMinGapMs: 1 * HOUR,
    sizeCapEvents: 40,
    sizeCapChars: 24_000,
    dayBoundary: true,
    debounceMs: 45 * MINUTE,
    ceilingMs: 24 * HOUR,
  },
  overrides: {},
  get effective() {
    return this.defaults;
  },
};

const diff: ReplayDiff = {
  streamId: "str_1",
  params: { gapMs: 4 * HOUR },
  sessionsBefore: 3,
  sessionsAfter: 5,
  rows: [
    {
      change: "added",
      startedAt: "2025-08-14T12:00:00.000Z",
      endedAt: "2025-08-14T12:30:00.000Z",
      eventCount: 4,
      boundaryStart: { reason: "gap", measured: { gap_ms: 5 * HOUR, threshold_ms: 4 * HOUR } },
      boundaryEnd: null,
    },
  ],
};

const receipt: MutationReceipt = {
  mutationId: "mut_9",
  actor: "user",
  targetKind: "stream",
  targetId: "str_1",
  field: "segmentation",
};

function makeClient(over: Partial<SurfacesClient> = {}) {
  return {
    getCoverage: vi.fn(async () => ({
      mode: "bootstrap" as const,
      rows: [{ horizon: "d30" as const, totalUnits: 800, doneUnits: 568 }],
      pausedLabel: null,
      remainingMinutes: 14,
    })),
    listSessions: vi.fn(async () => page()),
    getSegmentation: vi.fn(async () => segmentation),
    saveSegmentation: vi.fn(async () => receipt),
    replaySegmentation: vi.fn(async () => diff),
    applySegmentation: vi.fn(async () => receipt),
    listEntities: vi.fn(),
    listResolutionQueue: vi.fn(),
    mergeEntity: vi.fn(),
    splitEntity: vi.fn(),
    renameEntity: vi.fn(),
    pinEntity: vi.fn(),
    addRelation: vi.fn(),
    rejectEdge: vi.fn(),
    answerResolution: vi.fn(),
    ...over,
  } as unknown as SurfacesClient;
}

const mount = (client: SurfacesClient) =>
  render(<SessionsTab client={client} coveragePollMs={0} />);

async function card(sessionId: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector(`[data-session-id="${sessionId}"]`);
    expect(found).toBeTruthy();
  });
  return found as unknown as HTMLElement;
}

describe("Sessions surface — every boundary explained in one line", () => {
  it("carries the coverage meter, like every surface (§14.0)", async () => {
    mount(makeClient());
    await waitFor(() => expect(screen.getByLabelText("Understanding your history")).toBeTruthy());
  });

  it("shows BOTH boundaries with the rule and the measured value", async () => {
    mount(makeClient());
    const session = await card("ses_1");

    expect(within(session).getByText("START: gap 7h20m > 6h")).toBeTruthy();
    expect(within(session).getByText("END: debounce 45m idle ≥ 45m")).toBeTruthy();
  });

  it("explains why an open session has no end rule instead of leaving a blank", async () => {
    mount(makeClient());
    const session = await card("ses_2");

    expect(within(session).getByText("END: open — no end rule has fired yet")).toBeTruthy();
  });

  it("shows seal_mode, the hash and the understanding state", async () => {
    mount(makeClient());
    const session = await card("ses_1");

    expect(within(session).getByText(/seal_mode: debounce/)).toBeTruthy();
    expect(within(session).getByText(/hash 3f9a…/)).toBeTruthy();
    expect(within(session).getByText(/✓understood/)).toBeTruthy();
  });

  it("shows participants, enrichment state and reprocess history", async () => {
    mount(makeClient());
    const session = await card("ses_2");

    expect(within(session).getByText(/participants: me, Pranjali/)).toBeTruthy();
    expect(
      within(session).getByText(/1 voice note pending · text understood immediately/),
    ).toBeTruthy();
    expect(within(session).getByText(/reprocessed .*transcript landed.*reprocess_count 1/)).toBeTruthy();
  });

  it("marks an open session as a conversation in progress (§14.0b)", async () => {
    mount(makeClient());
    const session = await card("ses_2");

    expect(within(session).getByText(/conversation in progress/)).toBeTruthy();
    expect(within(session).getByText(/seal_mode: not sealed/)).toBeTruthy();
  });

  it("filters by source, stream and date", async () => {
    const client = makeClient();
    mount(client);
    await card("ses_1");

    fireEvent.change(screen.getByLabelText("Filter by source"), {
      target: { value: "whatsapp" },
    });
    await waitFor(() =>
      expect(client.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "whatsapp" }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by stream"), { target: { value: "str_2" } });
    await waitFor(() =>
      expect(client.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: "str_2" }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by date"), {
      target: { value: "2025-08-14" },
    });
    await waitFor(() =>
      expect(client.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ date: "2025-08-14" }),
        expect.anything(),
      ),
    );
  });

  it("reports a worker still serving the Phase-0 chat-session list", async () => {
    const client = makeClient({
      listSessions: vi.fn(async () => {
        throw new Error("GET /api/sessions returned the Phase-0 chat-session list");
      }),
    });
    mount(client);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Phase-0 chat-session list/);
  });
});

describe("replay — it diffs, it does not apply", () => {
  async function openReplay(client: SurfacesClient) {
    mount(client);
    const session = await card("ses_1");
    fireEvent.click(within(session).getByRole("button", { name: "replay stream" }));
    return await screen.findByLabelText("Replay stream");
  }

  it("edits candidate params and shows a diff WITHOUT applying anything", async () => {
    const client = makeClient();
    const panel = await openReplay(client);

    await screen.findByLabelText(/gap \(G\)/);
    fireEvent.change(within(panel).getByLabelText(/gap \(G\)/), { target: { value: "240" } });
    fireEvent.click(within(panel).getByRole("button", { name: "replay stream" }));

    await waitFor(() =>
      expect(client.replaySegmentation).toHaveBeenCalledWith({
        streamId: "str_1",
        params: expect.objectContaining({ gapMs: 4 * HOUR }),
      }),
    );
    expect(await screen.findByText(/3 sessions become 5/)).toBeTruthy();
    expect(screen.getByText(/nothing has been applied/)).toBeTruthy();
    // The whole point of the feature.
    expect(client.applySegmentation).not.toHaveBeenCalled();
  });

  it("explains every boundary in the diff too", async () => {
    const client = makeClient();
    const panel = await openReplay(client);
    fireEvent.click(within(panel).getByRole("button", { name: "replay stream" }));

    expect(await screen.findByText(/START: gap 5h > 4h/)).toBeTruthy();
  });

  it("applies only when a human confirms, and writes mutations(actor:user)", async () => {
    const client = makeClient();
    const panel = await openReplay(client);
    fireEvent.click(within(panel).getByRole("button", { name: "replay stream" }));
    fireEvent.click(await screen.findByRole("button", { name: "apply new params" }));

    await waitFor(() =>
      expect(client.applySegmentation).toHaveBeenCalledWith({
        streamId: "str_1",
        params: { gapMs: 4 * HOUR },
        actor: "user",
      }),
    );
    expect(await screen.findByText(/mutation mut_9 · actor user/)).toBeTruthy();
  });

  it("discards a diff without applying it", async () => {
    const client = makeClient();
    const panel = await openReplay(client);
    fireEvent.click(within(panel).getByRole("button", { name: "replay stream" }));
    fireEvent.click(await screen.findByRole("button", { name: "discard" }));

    await waitFor(() => expect(screen.queryByText(/3 sessions become 5/)).toBeNull());
    expect(client.applySegmentation).not.toHaveBeenCalled();
  });

  it("invalidates the diff when the params are edited under it", async () => {
    const client = makeClient();
    const panel = await openReplay(client);
    fireEvent.click(within(panel).getByRole("button", { name: "replay stream" }));
    await screen.findByText(/3 sessions become 5/);

    fireEvent.change(within(panel).getByLabelText(/debounce/), { target: { value: "10" } });

    expect(screen.queryByText(/3 sessions become 5/)).toBeNull();
    expect(screen.queryByRole("button", { name: "apply new params" })).toBeNull();
  });

  it("saves a per-stream segmentation override as the user", async () => {
    const client = makeClient();
    const panel = await openReplay(client);

    fireEvent.change(within(panel).getByLabelText(/ceiling/), { target: { value: "720" } });
    fireEvent.click(within(panel).getByRole("button", { name: "save override" }));

    await waitFor(() =>
      expect(client.saveSegmentation).toHaveBeenCalledWith({
        streamId: "str_1",
        overrides: expect.objectContaining({ ceilingMs: 12 * HOUR }),
        actor: "user",
      }),
    );
  });
});
