// ===========================================================================
// Settings › Assist as the OUTPUT-side rule — V6 P1 R2 (Build §7.1 S4.4,
// Product_V6_Phase1 §18.2, §18.5, §25).
//
// S4.4 moved the behavioural thresholds into settings.ts and `nudgeVerdict()`
// and left the pane printing the numbers with no statement of the rule, beside
// four knobs of the retired input-side watcher. What this suite pins:
//
//   * the pane STATES the verdict — blocked / below the floor / at or above —
//     using the floor actually in force, so the number means something;
//   * the retired knobs are gone (§18.2: "No quiet hours, no cap, no
//     cooldown"), and a worker that has stopped sending them still renders;
//   * a blocked kind is reversible in one click and a rule can be taken back;
//   * leftover suppression rows appear only when they exist, named as
//     leftovers, and can be cleared.
//
// The worker is stubbed: no network, no worker, no model.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistPanel } from "./screens/settings/AssistPanel";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What a worker that has finished retiring `assist/` sends: no dead knobs. */
const P1_ONLY = {
  enabled: true,
  freshness: "balanced",
  freshness_window: { idle_s: 300, max_s: 540 },
  freshness_presets: {
    live: { idle_s: 120, max_s: 180 },
    balanced: { idle_s: 300, max_s: 540 },
    relaxed: { idle_s: 420, max_s: 600 },
  },
  burst: { k: 4, window_s: 180 },
  card_duration_s: 60,
  merge_window_s: 120,
  intent_floor: 0.7,
  blocked_kinds: ["something_moved"],
  behavioral_rules: [
    { id: "rule_1", text: "never nudge me about deliveries", source: "chip", created_at: "2026-09-01" },
  ],
};

function stubAssist(body: Record<string, unknown> = P1_ONLY): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/settings/assist", body);
  return stub;
}

describe("Settings › Assist states the output-side rule", () => {
  it("prints the three verdicts against the floor in force", async () => {
    stubAssist();
    render(<AssistPanel />);
    const rule = await screen.findByLabelText("the rule");
    expect(within(rule).getByText("blocked kind")).toBeTruthy();
    expect(within(rule).getByText("intent confidence < 0.7")).toBeTruthy();
    expect(within(rule).getByText("intent confidence ≥ 0.7")).toBeTruthy();
    // Below the floor the work is KEPT, not dropped — the pane must say so.
    expect(within(rule).getByText(/Prepared shelf/)).toBeTruthy();
    expect(within(rule).getByText(/never/)).toBeTruthy();
  });

  it("the floor the rule quotes is the floor the field edits", async () => {
    const stub = stubAssist({ ...P1_ONLY, intent_floor: 0.55 });
    render(<AssistPanel />);
    const rule = await screen.findByLabelText("the rule");
    expect(within(rule).getByText("intent confidence < 0.55")).toBeTruthy();
    const field = screen.getByLabelText("Intent-confidence floor (0–1)") as HTMLInputElement;
    expect(field.value).toBe("0.55");
    fireEvent.blur(field, { target: { value: "0.8" } });
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(post?.body).toEqual({ intent_floor: 0.8 });
    });
  });

  it("the retired input-side knobs are gone (§18.2: no quiet hours, no cap, no cooldown)", async () => {
    stubAssist();
    render(<AssistPanel />);
    await screen.findByLabelText("the rule");
    expect(screen.queryByText(/Quiet hours/)).toBeNull();
    expect(screen.queryByText(/Cooldown per context/)).toBeNull();
    expect(screen.queryByText(/Novelty threshold/)).toBeNull();
    // …and the pane still renders every live field beside them.
    expect(screen.getByRole("radiogroup", { name: "Freshness" })).toBeTruthy();
    expect(screen.getByLabelText("Burst threshold (events K)")).toBeTruthy();
    expect(screen.getByLabelText("Nudge card duration (seconds)")).toBeTruthy();
  });

  it("a blocked kind is reversible in one click, and a rule can be taken back", async () => {
    const stub = stubAssist();
    render(<AssistPanel />);
    fireEvent.click(await screen.findByLabelText("unblock something_moved"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ blocked_kinds: [] });
    });
    fireEvent.click(screen.getByLabelText("remove rule never nudge me about deliveries"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[1]!.body).toEqual({ remove_rule: "rule_1" });
    });
  });

  it("leftover suppression rows show only when they exist, named as leftovers", async () => {
    stubAssist();
    render(<AssistPanel />);
    await screen.findByLabelText("the rule");
    expect(screen.queryByText(/Left over from the retired watcher/)).toBeNull();

    vi.unstubAllGlobals();
    const stub = stubAssist({
      ...P1_ONLY,
      suppressed_contexts: [{ topic_key: "wa:deliveries", suppressed_until: "2026-10-01T00:00:00.000Z" }],
    });
    render(<AssistPanel />);
    expect(await screen.findByText(/Left over from the retired watcher/)).toBeTruthy();
    expect(screen.getByText("wa:deliveries")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "clear…" }));
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(post?.body).toEqual({ clear_suppressed: true });
    });
  });
});
