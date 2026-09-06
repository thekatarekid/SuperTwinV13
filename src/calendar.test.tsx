// ===========================================================================
// Calendar tab — V6 P1 S5.3 component tests (CAL-01 · CAL-02 · CAL-05, UI half).
//
// CAL-05: the four layers render apart and together — toggling one off removes
// only its rows, and no row ever appears under two layers. CAL-01: a
// chat-derived event carries its "tentative" mark and its original words, and
// confirming it posts to the worker. CAL-02: an opened lead-time plan offers
// the three snooze options, and choosing one posts the choice (the worker
// learns it). TIM-02: the relative label is what the worker sent — this screen
// never computes one, so a stored "tomorrow" can never go stale.
//
// The worker-side halves live in worker/src/calendar/*.test.ts,
// worker/src/server/calendar-routes.test.ts and the CAL executor.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Calendar } from "./screens/Calendar";
import { stubWorker, type WorkerStub } from "./test-utils";
import type { CalendarItemView, CalendarViewResponse } from "./lib/api";

function item(over: Partial<CalendarItemView> & Pick<CalendarItemView, "layer" | "kind" | "refId" | "title">): CalendarItemView {
  return {
    at: "2026-09-01",
    day: "2026-09-01",
    allDay: true,
    status: null,
    relative: "in 3 days",
    rendered: "2026-09-01",
    sourceTz: null,
    spaceId: null,
    spaceLabel: null,
    personEntityId: null,
    personName: null,
    phrase: null,
    detail: {},
    ...over,
  };
}

const dinner = item({
  layer: "my_events",
  kind: "event",
  refId: "cev_dinner",
  title: "Dinner with Rohan",
  at: "2026-09-01T14:30:00.000Z",
  rendered: "2026-09-01 20:00 IST",
  allDay: false,
  status: "tentative",
  phrase: "dinner sat 8pm",
});

const mine = item({ layer: "my_tasks", kind: "task_due", refId: "tsk_mine", title: "Pay the maintenance", day: "2026-09-02", at: "2026-09-02", status: "open", relative: "in 4 days" });

const twin = item({
  layer: "twin_tasks",
  kind: "twin_step",
  refId: "tsk_twin",
  title: "Web check-in for the Goa flight",
  day: "2026-09-03",
  at: "2026-09-03T01:30:00.000Z",
  rendered: "2026-09-03 07:00 IST",
  allDay: false,
  status: "scheduled",
  relative: "in 5 days",
});

const maBirthday = item({
  layer: "people",
  kind: "person_date",
  refId: "pdt_ma",
  title: "Ma's birthday",
  day: "2026-09-20",
  at: "2026-09-20",
  status: "opened",
  relative: "in 22 days",
  personEntityId: "ent_ma",
  personName: "Ma",
  spaceId: "sp_ma",
  spaceLabel: "Ma's birthday on 2026-09-20",
  detail: { kind: "birthday", circle: "family", mode: "plan", lead_days: 14, plan: { id: "cpl_ma", status: "opened", opens_at: "2026-09-06", snoozed_until: null } },
});

const view: CalendarViewResponse = {
  from: "2026-08-29",
  to: "2026-09-28",
  tz: "Asia/Kolkata",
  layers: ["my_events", "my_tasks", "twin_tasks", "people"],
  items: [dinner, mine, twin, maBirthday],
  counts: { my_events: 1, my_tasks: 1, twin_tasks: 1, people: 1 },
};

let stub: WorkerStub;

beforeEach(() => {
  stub = stubWorker();
  stub.routes.set("/api/calendar", view);
  stub.routes.set("/api/calendar/events/cev_dinner/confirm", { event: { id: "cev_dinner", status: "confirmed" } });
  stub.routes.set("/api/calendar/events/cev_dinner/cancel", { event: { id: "cev_dinner", status: "cancelled" } });
  stub.routes.set("/api/calendar/plans/cpl_ma/snooze", { plan: { id: "cpl_ma", status: "snoozed", snoozed_until: "2026-09-10" }, learned_lead_days: 10 });
  stub.routes.set("/api/calendar/plans/cpl_ma/stop", { plan: { id: "cpl_ma", status: "stopped" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Calendar — layers separable (CAL-05)", () => {
  it("renders all four layers together, each row once", async () => {
    render(<Calendar />);
    await screen.findByText("Dinner with Rohan");
    expect(screen.getByText("Pay the maintenance")).toBeTruthy();
    expect(screen.getByText("Web check-in for the Goa flight")).toBeTruthy();
    expect(screen.getByText("Ma's birthday")).toBeTruthy();
    // Each title appears exactly once — no row is in two layers.
    expect(screen.getAllByText("Pay the maintenance")).toHaveLength(1);
    expect(screen.getAllByText("Web check-in for the Goa flight")).toHaveLength(1);
  });

  it("'my tasks' and 'twin's tasks' toggle independently", async () => {
    render(<Calendar />);
    await screen.findByText("Pay the maintenance");

    fireEvent.click(screen.getByLabelText("◻ my tasks layer"));
    await waitFor(() => expect(screen.queryByText("Pay the maintenance")).toBeNull());
    // The twin's step is untouched — separate views.
    expect(screen.getByText("Web check-in for the Goa flight")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("◆ twin's tasks layer"));
    await waitFor(() => expect(screen.queryByText("Web check-in for the Goa flight")).toBeNull());
    expect(screen.getByText("Dinner with Rohan")).toBeTruthy();
  });

  it("one layer alone shows only its rows; the counts are the worker's", async () => {
    render(<Calendar />);
    await screen.findByText("Dinner with Rohan");
    for (const label of ["◻ my tasks layer", "◆ twin's tasks layer", "● people layer"]) {
      fireEvent.click(screen.getByLabelText(label));
    }
    await waitFor(() => expect(screen.queryByText("Ma's birthday")).toBeNull());
    expect(screen.getByText("Dinner with Rohan")).toBeTruthy();
    expect(screen.queryByText("Pay the maintenance")).toBeNull();
    // Counts still report what each layer holds, toggled off or not.
    expect(within(screen.getByLabelText("◻ my tasks layer")).getByText("1")).toBeTruthy();
  });

  it("an empty window says so rather than rendering nothing", async () => {
    stub.routes.set("/api/calendar", { ...view, items: [], counts: { my_events: 0, my_tasks: 0, twin_tasks: 0, people: 0 } });
    render(<Calendar />);
    expect(await screen.findByText("nothing dated in this window")).toBeTruthy();
  });
});

describe("Calendar — tentative until confirmed (CAL-01)", () => {
  it("marks a chat-derived event tentative and keeps its words", async () => {
    render(<Calendar />);
    await screen.findByText("Dinner with Rohan");
    expect(screen.getByLabelText("tentative")).toBeTruthy();
    expect(screen.getByText("“dinner sat 8pm”")).toBeTruthy();
    // The instant is the worker's render — the screen never recomputes it.
    expect(screen.getByText("2026-09-01 20:00 IST")).toBeTruthy();
  });

  it("confirming posts to the worker and re-reads the view", async () => {
    render(<Calendar />);
    await screen.findByText("Dinner with Rohan");
    fireEvent.click(screen.getByLabelText("confirm Dinner with Rohan"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/calendar/events/cev_dinner/confirm" && c.method === "POST")).toBe(true),
    );
    // And the view is re-read, so the mark can drop.
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/calendar").length).toBeGreaterThan(1));
  });

  it("a firm task carries no tentative mark and no confirm control", async () => {
    render(<Calendar />);
    await screen.findByText("Pay the maintenance");
    expect(screen.queryByLabelText("confirm Pay the maintenance")).toBeNull();
    expect(screen.getAllByLabelText("tentative")).toHaveLength(1);
  });
});

describe("Calendar — lead-time planning (CAL-02)", () => {
  it("an opened plan offers the three snooze options and posts the choice", async () => {
    render(<Calendar />);
    await screen.findByText("Ma's birthday");
    expect(screen.getByLabelText("snooze Ma's birthday — next week")).toBeTruthy();
    expect(screen.getByLabelText("snooze Ma's birthday — 3 days before")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("snooze Ma's birthday — 10 days before"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/calendar/plans/cpl_ma/snooze");
      expect(call?.body).toEqual({ choice: "10_days_before" });
    });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("'don't plan this' stops the plan", async () => {
    render(<Calendar />);
    await screen.findByText("Ma's birthday");
    fireEvent.click(screen.getByLabelText("stop planning Ma's birthday"));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/calendar/plans/cpl_ma/stop")).toBe(true));
  });

  it("a date with no open plan offers no snooze", async () => {
    const wish = { ...maBirthday, status: "wish", detail: { ...maBirthday.detail, mode: "wish", plan: null } };
    stub.routes.set("/api/calendar", { ...view, items: [wish] });
    render(<Calendar />);
    await screen.findByText("Ma's birthday");
    expect(screen.queryByLabelText("snooze Ma's birthday — next week")).toBeNull();
  });
});

describe("Calendar — view time (TIM-02)", () => {
  it("the relative label is the worker's, never recomputed here", async () => {
    render(<Calendar />);
    const heading = await screen.findByRole("heading", { name: /2026-09-01/ });
    expect(heading.textContent).toContain("in 3 days");
  });

  it("the range chips re-ask the worker", async () => {
    render(<Calendar />);
    await screen.findByText("Dinner with Rohan");
    const before = stub.calls.filter((c) => c.path === "/api/calendar").length;
    fireEvent.click(screen.getByRole("button", { name: "week" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/calendar").length).toBeGreaterThan(before));
  });

  it("an unreachable worker says so", async () => {
    stub.routes.delete("/api/calendar");
    render(<Calendar />);
    expect(await screen.findByText("worker unreachable")).toBeTruthy();
  });
});
