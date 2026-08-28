// Shared test scaffolding for the P1.7 shell suites: a fetch stub that
// routes worker API paths to canned JSON and records every call.

import { vi } from "vitest";
import type { HomeData } from "./lib/api";

export interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

export interface WorkerStub {
  calls: RecordedCall[];
  /** Mutable route table: path -> response body (matched by pathname). */
  routes: Map<string, unknown>;
}

export const homeFixture: HomeData = {
  today: [
    {
      id: "t1",
      title: "Book villa",
      status: "open",
      space_id: "sp_goa",
      chapter_id: null,
      category: "transaction",
      risk_class: "approve-final",
      owner: "self",
      due: "2026-09-02",
      evidence_json: JSON.stringify([{ quote: "lets lock goa 18-21 dec", event_ids: ["e1"] }]),
      confidence: 0.9,
    },
  ],
  spaces: [
    {
      id: "sp_goa",
      label: "Goa trip with Rohan",
      life_area: "Travel",
      goal: null,
      status: "active",
      horizon: "short",
      permanence: "ephemeral",
      cadence: "one-time",
      exemplars_json: null,
      confidence: 0.9,
      created_at: "2026-08-01",
      updated_at: null,
    },
    {
      id: "sp_side",
      label: "Side project",
      life_area: "Work",
      goal: null,
      status: "active",
      horizon: "long",
      permanence: "permanent",
      cadence: "recurring",
      exemplars_json: null,
      confidence: 0.8,
      created_at: "2026-08-01",
      updated_at: null,
    },
  ],
  review: [
    {
      id: "sp_prop",
      label: "Hampi trek in October",
      life_area: "Travel",
      goal: null,
      status: "proposed",
      horizon: "short",
      permanence: "ephemeral",
      cadence: "one-time",
      exemplars_json: JSON.stringify([{ summary: "october long weekend hampi?", event_ids: ["e2"] }]),
      confidence: 0.82,
      created_at: "2026-08-27",
      updated_at: null,
    },
  ],
  recent_understanding: [
    {
      id: "cv1",
      claim_key: "goa.budget",
      kind: "preference",
      text: "Trip budget ₹6k/night",
      confidence: 0.87,
      stated_at: "2026-08-24",
      evidence_json: JSON.stringify([{ quote: "max 6k a night yaar", event_ids: ["e3"] }]),
    },
  ],
};

/** Install a fetch stub. Returns the recorder + route table for assertions. */
export function stubWorker(home: HomeData = homeFixture): WorkerStub {
  const stub: WorkerStub = { calls: [], routes: new Map() };
  stub.routes.set("/api/home", home);
  stub.routes.set("/api/decisions/space/sp_prop", {
    decisions: [
      {
        id: "dec1",
        runId: "run1",
        pass: "decide",
        action: "create",
        reason: "2 chat mentions + 3 browser visits",
        confidence: 0.82,
        createdAt: "2026-08-27",
        oldJson: null,
        newJson: null,
        reversedAt: null,
        traceId: "trc1",
      },
    ],
  });
  stub.routes.set("/api/trace/trc1", {
    trace: {
      id: "trc1",
      pass: "decide",
      model: "haiku",
      prompt_version: "decide.v1",
      caller: "seed",
      system_prompt: "sys",
      packed_context: "4 events about hampi",
      raw_output: "propose space",
      parsed_result: null,
      created_at: "2026-08-27",
    },
  });
  stub.routes.set("/api/proposals/sp_prop/approve", { space: { id: "sp_prop", status: "active" }, decision_id: "dec2" });
  stub.routes.set("/api/corrections", {
    correction_id: "cor1",
    status: "applied",
    summary: "moved to sp_side",
    decision_id: "decX",
  });
  stub.routes.set("/api/corrections/cor1/undo", { undone: true });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      stub.calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (!stub.routes.has(path)) {
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      }
      return { ok: true, status: 200, json: async () => stub.routes.get(path) };
    }),
  );
  return stub;
}
