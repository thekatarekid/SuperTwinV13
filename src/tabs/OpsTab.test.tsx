// Tests for the Ops surface (build item 4.4): the import meter renders the
// worker's fractions, quarantine replays after a fix, questions answer or
// defer, lanes pause and resume, and undo targets exactly the run whose button
// was pressed — every gesture through the injected client, no fetch anywhere.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpsTab } from "./OpsTab";
import type { OpsClient, OpsImportView } from "../lib/ops-client";
import type { RunListItem } from "../lib/worker-client";

afterEach(cleanup);

function importView(overrides: Partial<OpsImportView> = {}): OpsImportView {
  return {
    coverage: [
      {
        scopeKind: "global",
        scopeId: "all",
        horizon: "recent",
        totalUnits: 40,
        doneUnits: 25,
        fraction: 0.625,
      },
    ],
    depth: { ready: 3, running: 1, done: 20, paused: 0, quarantined: 1 },
    lanes: [
      { lane: "llm:understanding", pausedForMs: 0, paused: false, limit: 5 },
      { lane: "llm:enrichment", pausedForMs: 90_000, paused: true, limit: 3 },
    ],
    ...overrides,
  };
}

function run(id: string): RunListItem {
  return {
    id,
    process: "extract",
    model: "opus",
    input_tokens: 1_000,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 4_800,
    output_tokens: 350,
    cost_usd: 0.69,
    duration_ms: 9_000,
    status: "ok",
    created_at: "2026-08-15T10:00:00.000Z",
  };
}

function fakeClient(overrides: Partial<OpsClient> = {}): OpsClient {
  return {
    getImport: vi.fn().mockResolvedValue(importView()),
    listQuarantine: vi.fn().mockResolvedValue([
      {
        id: "wq-1",
        unitKind: "session",
        unitId: "sess-bad",
        cohortId: null,
        stage: "extract",
        priority: 7,
        attempts: 3,
        state: "quarantined",
        createdAt: "2026-08-15T09:00:00.000Z",
      },
    ]),
    replayQuarantined: vi.fn().mockResolvedValue({ ok: true, id: "wq-1" }),
    listQuestions: vi.fn().mockResolvedValue([
      {
        id: "qst-1",
        kind: "identity",
        targetKind: "entity_pair",
        targetId: "e1|e2",
        question: "Are these the same person?",
        options: ["same", "different", "later"],
        askedAt: "2026-08-15T08:00:00.000Z",
      },
    ]),
    answerQuestion: vi.fn().mockResolvedValue({ ok: true, deferred: false }),
    pauseLane: vi.fn().mockResolvedValue({ ok: true, pausedForMs: 300_000 }),
    resumeLane: vi.fn().mockResolvedValue({ ok: true }),
    undoRun: vi.fn().mockResolvedValue({ runId: "run-A", reversed: ["m1"], skippedUserMutations: [] }),
    ...overrides,
  };
}

function mount(client: OpsClient, runs: RunListItem[] = [run("run-A"), run("run-B")]) {
  const listRunsFn = vi.fn().mockResolvedValue(runs);
  render(<OpsTab client={client} listRunsFn={listRunsFn} pollMs={0} latencyPanel={null} />);
  return { listRunsFn };
}

describe("OpsTab", () => {
  it("renders the coverage meter with the worker's own fraction and the backlog", async () => {
    mount(fakeClient());
    const meter = await screen.findByRole("progressbar", { name: "recent coverage" });
    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(meter.getAttribute("aria-valuemax")).toBe("40");
    expect(screen.getByText("25/40 · 63%")).toBeTruthy();
    expect(screen.getByText(/3 ready · 1 running · 0 paused · 1 quarantined/)).toBeTruthy();
  });

  it("shows the pause countdown per lane and pauses/resumes through the client", async () => {
    const client = fakeClient();
    mount(client);
    const lanes = await screen.findByRole("region", { name: "Lanes" });
    // Enrichment is paused with a countdown; understanding runs.
    expect(within(lanes).getByText("paused — resumes in 1:30")).toBeTruthy();

    fireEvent.click(within(lanes).getByRole("button", { name: "Pause" }));
    expect(client.pauseLane).toHaveBeenCalledWith("llm:understanding");
    fireEvent.click(within(lanes).getByRole("button", { name: "Resume" }));
    expect(client.resumeLane).toHaveBeenCalledWith("llm:enrichment");
  });

  it("renders 4-way tokens with their sum and undoes exactly the pressed run", async () => {
    const client = fakeClient();
    mount(client);
    const runsPanel = await screen.findByRole("region", { name: "Runs" });
    // parts AND sum: 1,000 + 200 + 4,800 = 6,000 (§4.4.4).
    expect(within(runsPanel).getAllByText("6,000")).toHaveLength(2);
    expect(within(runsPanel).getAllByText("$0.69")).toHaveLength(2);

    const undoButtons = within(runsPanel).getAllByRole("button", { name: "Undo run" });
    expect(undoButtons).toHaveLength(2);
    fireEvent.click(undoButtons[1]!);
    expect(client.undoRun).toHaveBeenCalledTimes(1);
    expect(client.undoRun).toHaveBeenCalledWith("run-B");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("undid run run-A: 1 mutation(s) reversed"),
    );
  });

  it("replays a quarantined unit and re-reads the list", async () => {
    const client = fakeClient();
    mount(client);
    const panel = await screen.findByRole("region", { name: "Quarantine" });
    expect(within(panel).getByText("session · sess-bad")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Replay" }));
    expect(client.replayQuarantined).toHaveBeenCalledWith("wq-1");
    // The gesture refreshes rather than patching local state.
    await waitFor(() => expect(client.listQuarantine).toHaveBeenCalledTimes(2));
  });

  it("answers a question with the stored options and can defer with later", async () => {
    const client = fakeClient();
    mount(client);
    const panel = await screen.findByRole("region", { name: "Questions" });
    expect(within(panel).getByText("Are these the same person?")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "same" }));
    expect(client.answerQuestion).toHaveBeenCalledWith("qst-1", "same");
    fireEvent.click(within(panel).getByRole("button", { name: "later" }));
    expect(client.answerQuestion).toHaveBeenCalledWith("qst-1", "later");
  });

  it("reports the worker as unreachable when a read fails", async () => {
    const client = fakeClient({ getImport: vi.fn().mockRejectedValue(new Error("down")) });
    mount(client);
    expect(await screen.findByText("worker unreachable")).toBeTruthy();
  });
});
