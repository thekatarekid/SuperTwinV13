// ===========================================================================
// P3.5 — task modal live states + approval flow (spec §14.6).
//
// Covers: the executing state with the live generative result region, the
// question card (answer → POST /answer → session resumes), and the WhatsApp
// draft-send flow end to end in the UI: draft → approval modal (shows exactly
// what will happen) → Approve mints the token → POST /send with it → receipt.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { stubWorker, type WorkerStub } from "./test-utils";
import type { EnvelopeView, TaskRunState } from "./lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseTask = {
  id: "t1",
  title: "Book villa",
  status: "open",
  space_id: "sp_goa",
  chapter_id: null,
  category: "transaction",
  risk_class: "approve-first",
  owner: "self",
  due: "2026-09-02",
  evidence_json: JSON.stringify([{ quote: "lets lock goa 18-21 dec", event_ids: ["e1"] }]),
  confidence: 0.9,
};

const emptyEnvelope = {
  criteria: [],
  attempts: [],
  question: null,
  approval_request: null,
  gaps: [],
  next: null,
};

function runState(status: string, envelope: Record<string, unknown> | null): TaskRunState {
  return {
    task: { ...baseTask, status },
    run: envelope
      ? {
          run_id: "run1",
          envelope: { ...emptyEnvelope, ...envelope } as unknown as EnvelopeView,
          invocations: [{ tool: "world_model_read", status: "ok" }],
        }
      : null,
  };
}

async function openTaskModal(stub: WorkerStub): Promise<HTMLElement> {
  render(<App />);
  await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
  fireEvent.click(screen.getByText("Book villa"));
  const dialog = await screen.findByRole("dialog");
  // Wait for the modal's run fetch to land.
  await waitFor(() =>
    expect(stub.calls.some((c) => c.path === "/api/tasks/t1/run" && c.method === "GET")).toBe(true),
  );
  return dialog;
}

describe("task modal live states (spec §14.6)", () => {
  it("executing: status line + live generative result region", async () => {
    const stub = stubWorker();
    stub.routes.set(
      "/api/tasks/t1/run",
      runState("executing", {
        status: "partial",
        result: {
          result_type: "comparison_table",
          data: {
            title: "CCU-GOI fares",
            columns: ["flight", "price"],
            rows: [["IndiGo 6E-204", "₹4,850"], ["Air India 671", "₹5,200"]],
            recommendation: "best fit",
          },
        },
      }),
    );

    const dialog = await openTaskModal(stub);
    await waitFor(() => {
      expect(within(dialog).getByLabelText("task status").textContent).toContain("executing");
    });
    const region = within(dialog).getByTestId("result-region");
    expect(region.textContent).toContain("IndiGo 6E-204");
    expect(region.textContent).toContain("₹4,850");
    expect(within(dialog).getByLabelText("live activity").textContent).toContain(
      "world_model_read",
    );
  });

  it("question card: answer posts to /answer and resumes the session", async () => {
    const stub = stubWorker();
    stub.routes.set(
      "/api/tasks/t1/run",
      runState("needs_input", {
        status: "needs_input",
        question: "Window or aisle seats?",
        result: null,
      }),
    );
    stub.routes.set("/api/tasks/t1/answer", runState("open", null));
    stub.routes.set("/api/tasks/t1/execute", {
      run_id: "run2",
      task_status: "executing",
      envelope: { ...emptyEnvelope, status: "partial", result: null },
    });

    const dialog = await openTaskModal(stub);
    const card = await within(dialog).findByLabelText("question card");
    expect(card.textContent).toContain("Window or aisle seats?");

    fireEvent.change(within(card).getByLabelText("your answer"), {
      target: { value: "aisle please" },
    });
    fireEvent.click(within(card).getByText("Answer"));

    await waitFor(() => {
      const answered = stub.calls.find(
        (c) => c.path === "/api/tasks/t1/answer" && c.method === "POST",
      );
      expect(answered?.body).toEqual({ answer: "aisle please" });
    });
    // The session resumes with the answer in context.
    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.path === "/api/tasks/t1/execute" && c.method === "POST"),
      ).toBe(true),
    );
  });

  it("draft-send end to end: draft → approval modal → mint → tokened send → receipt", async () => {
    const stub = stubWorker();
    stub.routes.set(
      "/api/tasks/t1/run",
      runState("needs_approval", {
        status: "needs_approval",
        approval_request: "Send this WhatsApp draft to Rohan",
        result: {
          result_type: "draft_preview",
          data: {
            to: "15551234567@s.whatsapp.net",
            channel: "whatsapp",
            body: "locking goa 18-21 dec then? 🔥",
          },
        },
      }),
    );
    stub.routes.set("/api/approvals/mint", {
      token: "tok-abc",
      action: "whatsapp.send",
      expires_at: "2026-08-29T10:05:00Z",
    });
    stub.routes.set(
      "/api/tasks/t1/send",
      runState("done", {
        status: "done",
        result: {
          result_type: "receipt",
          data: {
            action: "whatsapp.send",
            summary: "sent to 15551234567@s.whatsapp.net: locking goa 18-21 dec then? 🔥",
            performed_at: "2026-08-29T10:00:00Z",
          },
        },
      }),
    );

    const dialog = await openTaskModal(stub);

    // The draft renders in the result region; the approve entry point appears.
    await waitFor(() =>
      expect(within(dialog).getByTestId("result-region").textContent).toContain(
        "locking goa 18-21 dec then?",
      ),
    );
    fireEvent.click(within(dialog).getByText("Review & approve"));

    // The approval modal states exactly what will happen (spec §14.6) — and
    // GATE-A-03: who it goes to is on its own row, the text is verbatim.
    const approval = await screen.findByRole("dialog", { name: "Approve send" });
    const happens = within(approval).getByLabelText("what happens");
    expect(happens.textContent).toContain("Send WhatsApp to 15551234567@s.whatsapp.net");
    expect(happens.textContent).toContain("locking goa 18-21 dec then?");
    expect(within(approval).getByTestId("approval-recipient").textContent).toContain(
      "15551234567@s.whatsapp.net",
    );
    expect(approval.textContent).toContain("Send this WhatsApp draft to Rohan");

    // Approve = mint THEN send with the minted token — in that order. The mint
    // is BOUND to what the card just displayed (S4.5): the token authorizes
    // that recipient and those words, and the worker + daemon refuse any other.
    fireEvent.click(within(approval).getByText("Approve & send"));
    await waitFor(() => {
      const mint = stub.calls.find((c) => c.path === "/api/approvals/mint");
      expect(mint?.body).toEqual({
        action: "whatsapp.send",
        bind: {
          to: "15551234567@s.whatsapp.net",
          text: "locking goa 18-21 dec then? 🔥",
        },
      });
      const send = stub.calls.find((c) => c.path === "/api/tasks/t1/send");
      expect(send?.body).toEqual({ approval_token: "tok-abc" });
      expect(stub.calls.indexOf(mint!)).toBeLessThan(stub.calls.indexOf(send!));
    });

    // The modal flips to done + receipt.
    await waitFor(() => {
      expect(within(dialog).getByLabelText("task status").textContent).toContain("done");
      expect(within(dialog).getByTestId("result-region").textContent).toContain("sent to");
    });
  });

  it("Discard closes the approval modal without minting anything", async () => {
    const stub = stubWorker();
    stub.routes.set(
      "/api/tasks/t1/run",
      runState("needs_approval", {
        status: "needs_approval",
        approval_request: "Send it?",
        result: {
          result_type: "draft_preview",
          data: { to: "x@s.whatsapp.net", channel: "whatsapp", body: "hi" },
        },
      }),
    );

    const dialog = await openTaskModal(stub);
    fireEvent.click(await within(dialog).findByText("Review & approve"));
    const approval = await screen.findByRole("dialog", { name: "Approve send" });
    fireEvent.click(within(approval).getByText("Discard"));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Approve send" })).toBeNull(),
    );
    expect(stub.calls.some((c) => c.path === "/api/approvals/mint")).toBe(false);
  });
});
