// ===========================================================================
// Spaces view — V6 P1 S5.1 component tests (Product_V6_Phase1 §13.5).
//
// The list groups by LIFE AREA in spec order with "Other" last and dormant
// apart; a drag between area groups posts the re-file (direct manipulation
// IS the correction); the view carries a why-panel on every element, the
// birth block quotes the sentence that justified the space (SPC-05), the
// milestone rail appears only when the goal is staged, and an episode
// dragged out of the timeline re-files. Worker-side halves live in
// worker/src/server/spaces-routes.test.ts and worker/src/spaces/spaces.test.ts.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Spaces } from "./screens/Spaces";
import { stubWorker, type WorkerStub } from "./test-utils";
import type { SpaceListRow, SpaceView, SpacesList } from "./lib/api";

const base: SpaceListRow = {
  id: "sp_goa",
  label: "Goa trip in December",
  life_area: "Travel",
  goal: "lock the trip",
  status: "active",
  horizon: "short",
  permanence: "ephemeral",
  cadence: "one-time",
  exemplars_json: null,
  confidence: 0.9,
  created_at: "2026-08-01",
  updated_at: "2026-08-27",
  area: "Travel",
  summary: "Dates agreed, villa pending",
  latest: "advance due today",
  latest_ts: "2026-08-27T10:00:00.000Z",
  born_via: "inferred",
  task_count: 2,
  next_action: "book the villa",
  freshness: "2026-08-27T10:00:00.000Z",
  people: ["rohan"],
};

const itr: SpaceListRow = {
  ...base,
  id: "sp_itr",
  label: "ITR filing FY26",
  life_area: "Money",
  area: "Money",
  born_via: "asked",
  task_count: 0,
  next_action: null,
  people: [],
};

const stray: SpaceListRow = {
  ...base,
  id: "sp_stray",
  label: "Unfiled thing",
  life_area: null,
  area: "Other",
  born_via: null,
  task_count: 0,
  next_action: null,
};

const dormant: SpaceListRow = {
  ...base,
  id: "sp_ma",
  label: "Ma's birthday",
  life_area: "People",
  area: "People",
  status: "dormant",
  task_count: 0,
  next_action: null,
};

const list: SpacesList = {
  areas: [
    { area: "Money", spaces: [itr] },
    { area: "Travel", spaces: [base] },
    { area: "Other", spaces: [stray] },
  ],
  dormant: [dormant],
};

const view: SpaceView = {
  space: {
    ...base,
    summary: "Dates agreed, villa pending",
    latest: "advance due today",
    latest_ts: "2026-08-27T10:00:00.000Z",
    plan_json: null,
    born_via: "asked",
    birth_evidence_json: null,
    bar_thread_id: "th_bar_1",
    dormant_at: null,
    woken_at: null,
  },
  area: "Travel",
  plan: null,
  milestones: [
    { id: "ch_1", label: "book the villa", status: "active", target_date: "2026-09-01", summary: null },
  ],
  chapters: [
    { id: "ch_1", label: "book the villa", status: "active", target_date: "2026-09-01", summary: null },
    { id: "ch_2", label: "ideas", status: "active", target_date: null, summary: null },
  ],
  tasks: [
    {
      id: "t1",
      title: "book the villa",
      type: "explicit",
      status: "open",
      owner: "self",
      due: "2026-09-01",
      chapter_id: "ch_1",
      evidence_json: null,
      confidence: 0.9,
    },
  ],
  follow_ups: [],
  episodes: [
    {
      id: "ep_1",
      summary: "Dates 18-21 Dec agreed",
      state: "open",
      first_ts: "2026-08-20T10:00:00.000Z",
      last_ts: "2026-08-20T10:00:00.000Z",
      chapter_id: null,
      stream_id: "st_1",
      quotes: [{ event_id: "e1", ts: "2026-08-20T10:00:00.000Z", actor: "contact:rohan", text: "lets lock goa 18-21 dec" }],
    },
  ],
  enrichments: [
    {
      id: "en_1",
      kind: "fare",
      url: "https://x/fare",
      content_hash: "abc",
      summary: "CCU-GOI Rs 4,300",
      fetched_at: "2026-08-27T10:00:00.000Z",
      changed_at: "2026-08-26T10:00:00.000Z",
      fetch_count: 3,
    },
  ],
  people: ["rohan"],
  birth: {
    via: "asked",
    evidence: [{ quote: "plan a goa trip in december", event_ids: [], thread_id: "th_bar_1" }],
    thread_id: "th_bar_1",
    woken_at: null,
  },
};

let stub: WorkerStub;

beforeEach(() => {
  stub = stubWorker();
  stub.routes.set("/api/spaces/list", list);
  stub.routes.set("/api/spaces/sp_goa/view", view);
  stub.routes.set("/api/spaces/sp_goa/refile", { moved: true, decisionId: "d1", from: "Travel", to: "Money" });
  stub.routes.set("/api/spaces/sp_itr/refile", { moved: true, decisionId: "d2", from: "Money", to: "Travel" });
  stub.routes.set("/api/spaces/sp_ma/wake", { woke: true });
  const decision = (id: string, action: string, reason: string) => ({
    decisions: [
      {
        id,
        runId: null,
        pass: "user",
        action,
        reason,
        confidence: null,
        createdAt: "2026-08-27",
        oldJson: null,
        newJson: null,
        reversedAt: null,
        traceId: null,
      },
    ],
  });
  stub.routes.set("/api/decisions/space/sp_goa", decision("d_sp", "create", 'asked for in the bar: "plan a goa trip in december"'));
  stub.routes.set("/api/decisions/task/t1", decision("d_t1", "create", "named in the villa thread"));
  stub.routes.set("/api/decisions/episode/ep_1", decision("d_ep", "attach", "same trip"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Spaces list (Product_V6_Phase1 §13.5)", () => {
  it("groups by life area in spec order, Other last, dormant in its own bucket", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    const groups = screen.getAllByLabelText(/^life area /).map((el) => el.getAttribute("aria-label"));
    expect(groups).toEqual(["life area Money", "life area Travel", "life area Other"]);
    expect(within(screen.getByLabelText("life area Other")).getByText("Unfiled thing")).toBeTruthy();
    expect(within(screen.getByLabelText("dormant spaces")).getByText("Ma's birthday")).toBeTruthy();
    // The row carries what the list promises: open count and the next action.
    const row = screen.getByLabelText("space Goa trip in December");
    expect(within(row).getByText("2 open")).toBeTruthy();
    expect(within(row).getByText(/book the villa/)).toBeTruthy();
    // A space the user asked for says so.
    expect(within(screen.getByLabelText("space ITR filing FY26")).getByText("you asked")).toBeTruthy();
  });

  it("drag to re-file posts the move to the space's own route and reports it", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.dragStart(screen.getByLabelText("space Goa trip in December"));
    const money = screen.getByLabelText("life area Money");
    fireEvent.dragOver(money);
    expect(money.className).toContain("drop-target");
    fireEvent.drop(money);
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/spaces/sp_goa/refile" && c.method === "POST");
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ life_area: "Money" });
    });
    await waitFor(() => screen.getByRole("status"));
    expect(within(screen.getByRole("status")).getByText("Goa trip in December → Money")).toBeTruthy();
  });

  it("dropping a space on the group it already sits in posts nothing", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.dragStart(screen.getByLabelText("space Goa trip in December"));
    fireEvent.drop(screen.getByLabelText("life area Travel"));
    expect(stub.calls.filter((c) => c.path.endsWith("/refile"))).toHaveLength(0);
  });

  it("a dormant space offers wake — the woken birth by hand", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("dormant space Ma's birthday"));
    fireEvent.click(screen.getByLabelText("wake Ma's birthday"));
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/spaces/sp_ma/wake");
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ signal: "user" });
    });
  });

  it("says so when there is nothing yet", async () => {
    stub.routes.set("/api/spaces/list", { areas: [], dormant: [] });
    render(<Spaces />);
    await waitFor(() => screen.getByText(/no spaces yet/));
  });
});

describe("Space view", () => {
  it("shows goal, summary, latest, the milestone rail, tasks, people and enrichment", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.click(screen.getByLabelText("space Goa trip in December"));
    await waitFor(() => screen.getByLabelText("space view Goa trip in December"));
    expect(screen.getByLabelText("goal").textContent).toBe("lock the trip");
    expect(screen.getByLabelText("summary").textContent).toBe("Dates agreed, villa pending");
    expect(screen.getByLabelText("latest").textContent).toContain("advance due today");
    // Only the dated chapter is a milestone.
    const rail = screen.getByLabelText("milestones");
    expect(within(rail).getByText("book the villa")).toBeTruthy();
    expect(within(rail).queryByText("ideas")).toBeNull();
    expect(within(screen.getByLabelText("tasks")).getByLabelText("task book the villa")).toBeTruthy();
    expect(within(screen.getByLabelText("people")).getByText("rohan")).toBeTruthy();
    expect(within(screen.getByLabelText("enrichment")).getByText(/CCU-GOI/)).toBeTruthy();
  });

  it("SPC-05: the birth block quotes the sentence and opens the bar thread", async () => {
    const onTellTwin = vi.fn();
    render(<Spaces onTellTwin={onTellTwin} />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.click(screen.getByLabelText("space Goa trip in December"));
    await waitFor(() => screen.getByLabelText("born"));
    const born = screen.getByLabelText("born");
    expect(within(born).getByText(/you asked for this in the bar/)).toBeTruthy();
    expect(within(born).getByLabelText("birth evidence").textContent).toContain("plan a goa trip in december");
    fireEvent.click(within(born).getByLabelText("open the bar thread"));
    expect(onTellTwin).toHaveBeenCalledWith("sp_goa", "Goa trip in December");
  });

  it("carries a why-panel on every element, one at a time", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.click(screen.getByLabelText("space Goa trip in December"));
    await waitFor(() => screen.getByLabelText("why this space"));
    expect(screen.getByLabelText("why book the villa")).toBeTruthy();
    expect(screen.getByLabelText("why Dates 18-21 Dec agreed")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("why this space"));
    await waitFor(() => screen.getByLabelText("why"));
    expect(stub.calls.some((c) => c.path === "/api/decisions/space/sp_goa")).toBe(true);
    // Opening a second element's panel replaces the first — one panel, not five.
    fireEvent.click(screen.getByLabelText("why book the villa"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/decisions/task/t1")).toBe(true),
    );
    expect(screen.getAllByLabelText("why")).toHaveLength(1);
  });

  it("drag an episode out of the timeline to re-file it (into a space, or back to unsorted)", async () => {
    stub.routes.set("/api/spaces/sp_goa/refile", { moved: true, decisionId: "d3", from: "sp_goa", to: "sp_itr" });
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.click(screen.getByLabelText("space Goa trip in December"));
    await waitFor(() => screen.getByLabelText("episode Dates 18-21 Dec agreed"));

    fireEvent.dragStart(screen.getByLabelText("episode Dates 18-21 Dec agreed"));
    await waitFor(() => screen.getByLabelText("re-file targets"));
    const target = screen.getByLabelText("re-file into ITR filing FY26");
    fireEvent.dragOver(target);
    expect(target.className).toContain("drop-target");
    fireEvent.drop(target);
    await waitFor(() => {
      const post = stub.calls.find(
        (c) => c.path === "/api/spaces/sp_goa/refile" && (c.body as { episode_id?: string }).episode_id === "ep_1",
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ episode_id: "ep_1", to_space_id: "sp_itr" });
    });
  });

  it("dragging an episode to unsorted sends to_space_id null", async () => {
    render(<Spaces />);
    await waitFor(() => screen.getByLabelText("space Goa trip in December"));
    fireEvent.click(screen.getByLabelText("space Goa trip in December"));
    await waitFor(() => screen.getByLabelText("episode Dates 18-21 Dec agreed"));
    fireEvent.dragStart(screen.getByLabelText("episode Dates 18-21 Dec agreed"));
    fireEvent.drop(await screen.findByLabelText("re-file into unsorted"));
    await waitFor(() => {
      const post = stub.calls.find(
        (c) => c.path === "/api/spaces/sp_goa/refile" && (c.body as { episode_id?: string }).episode_id === "ep_1",
      );
      expect(post!.body).toEqual({ episode_id: "ep_1", to_space_id: null });
    });
  });
});
