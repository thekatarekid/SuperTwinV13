// ===========================================================================
// Rung ④ and the bootstrap batch (build item 1.10, arch §12.2; evals G-039..044).
//
// The agent PROPOSES and this file proves it: a `same` binds only at or above
// the 0.8 bar the evals state, a `same` below it and an `un` both land in the
// queue, and a `diff` becomes a decision so the pair is never re-proposed.
//
// Then the two scheduling rules that keep an agent turn off the path the user
// is waiting on — the first-paint throw, and horizon-by-horizon draining.
// ===========================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../db/calib.js";
import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { upsertSource } from "../db/ingest.js";
import { isNegativePair, openResolutionQuestions, recordDecision } from "./merge.js";
import { createEntity, resolveEntityId } from "./registry.js";
import {
  AgentBatch,
  FirstPaintViolation,
  adjudicatePair,
  applyAgentVerdict,
  flushAgentBatch,
  type AgentRequest,
  type AgentVerdict,
} from "./adjudicate.js";
import { AGENT_BIND_BAR, resolvePair, routePair } from "./resolve.js";

const MODEL = "test-embedder";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-resolve-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function person(name: string): string {
  return createEntity({ type: "person", canonical: name, provisional: true }).id;
}

/** A measured floor for the entity-name channel. 1,200 pairs, measured now. */
function calibrate(floor = 0.8): void {
  putCalib({
    model: MODEL,
    useCase: "entity_name",
    floor,
    measuredAt: new Date().toISOString(),
    nPairs: 1200,
  });
}

function pair() {
  return { left: person("Papa (new number Jio)"), right: person("Papa") };
}

describe("rung ④ — P-AG1", () => {
  const same: AgentVerdict = {
    left: "",
    right: "",
    verdict: "same",
    confidence: 0.88,
    reason: "same group, same address term, old number went silent",
  };

  it("binds a `same` at or above the 0.8 bar (G-039..044)", () => {
    const { left, right } = pair();
    const res = applyAgentVerdict({ ...same, left, right }, { left, right });
    expect(res.outcome).toBe("merged");
    expect(res.decidedBy).toBe("agent:p-ag1");
    expect(res.confidence).toBe(0.88);
    expect(resolveEntityId(right)).toBe(left);
  });

  it("queues a `same` BELOW the bar rather than binding it", () => {
    const { left, right } = pair();
    const res = applyAgentVerdict({ ...same, left, right, confidence: AGENT_BIND_BAR - 0.01 }, { left, right });
    expect(res.outcome).toBe("queued");
    expect(resolveEntityId(right)).toBe(right);
    expect(openResolutionQuestions()).toHaveLength(1);
  });

  it("records a `diff` as a decision, so it is never re-proposed", () => {
    const { left, right } = pair();
    const res = applyAgentVerdict(
      { left, right, verdict: "different", confidence: 0.9, reason: "different phones, no shared group" },
      { left, right },
    );
    expect(res.outcome).toBe("different");
    expect(isNegativePair(left, right)).toBe(true);
    expect(routePair({ left, right, model: MODEL, score: 0.99 }).refused).toBe("negative_pair");
  });

  it("queues when the agent produced no usable verdict", async () => {
    calibrate();
    const { left, right } = pair();
    const res = await adjudicatePair({ left, right, model: MODEL, score: 0.5 }, async () => null);
    expect(res.outcome).toBe("queued");
    expect(res.decidedBy).toBe("agent:p-ag1:no_verdict");
  });

  it("runs the adjudicator only for pairs the router sends it", async () => {
    calibrate();
    const { left, right } = pair();
    let calls = 0;
    const res = await adjudicatePair({ left, right, model: MODEL, score: 0.95 }, async () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
    expect(res.outcome).toBe("merged");
  });

  it("THROWS rather than run on the first-paint path", async () => {
    calibrate();
    const { left, right } = pair();
    let calls = 0;
    await expect(
      adjudicatePair({ left, right, model: MODEL, score: 0.5, firstPaint: true }, async () => {
        calls += 1;
        return { left, right, verdict: "same", confidence: 0.99, reason: "no" };
      }),
    ).rejects.toBeInstanceOf(FirstPaintViolation);
    expect(calls).toBe(0);
  });

  it("routes an in-band first-paint pair away from the agent entirely", () => {
    calibrate();
    const { left, right } = pair();
    const route = routePair({ left, right, model: MODEL, score: 0.5, firstPaint: true });
    expect(route.next).toBe("queue");
    expect(route.decidedBy).toBe("code:first_paint");
  });
});

describe("bootstrap batching", () => {
  it("parks agent-rung pairs on the batch instead of adjudicating each one", () => {
    calibrate();
    const batch = new AgentBatch();
    const a = pair();
    const b = pair();
    resolvePair({ ...a, model: MODEL, score: 0.5, mode: "bootstrap", horizon: "d7" }, { batch });
    resolvePair({ ...b, model: MODEL, score: 0.5, mode: "bootstrap", horizon: "d30" }, { batch });
    expect(batch.size()).toBe(2);
    expect(batch.size("d7")).toBe(1);
    // Nothing was decided and nothing was asked while they waited.
    expect(openResolutionQuestions()).toHaveLength(0);
  });

  it("dedupes the same pair, in either order, inside one horizon", () => {
    calibrate();
    const batch = new AgentBatch();
    const { left, right } = pair();
    resolvePair({ left, right, model: MODEL, score: 0.5, horizon: "d7" }, { batch });
    resolvePair({ left: right, right: left, model: MODEL, score: 0.5, horizon: "d7" }, { batch });
    expect(batch.size("d7")).toBe(1);
  });

  it("drains ONE horizon at a time and applies each verdict", async () => {
    calibrate();
    const batch = new AgentBatch();
    const a = pair();
    const b = pair();
    resolvePair({ ...a, model: MODEL, score: 0.5, horizon: "d7" }, { batch });
    resolvePair({ ...b, model: MODEL, score: 0.5, horizon: "d30" }, { batch });

    const results = await flushAgentBatch(
      "d7",
      async (request: AgentRequest) => ({
        left: request.left,
        right: request.right,
        verdict: "same",
        confidence: 0.9,
        reason: "shared group",
      }),
      { batch, ctx: { model: MODEL } },
    );
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("merged");
    expect(resolveEntityId(a.right)).toBe(a.left);
    // The other horizon is untouched, still parked.
    expect(batch.size("d30")).toBe(1);
    expect(resolveEntityId(b.right)).toBe(b.right);
  });

  it("re-routes a parked pair before asking — it may have been settled meanwhile", async () => {
    calibrate();
    const batch = new AgentBatch();
    const { left, right } = pair();
    resolvePair({ left, right, model: MODEL, score: 0.5, horizon: "d7" }, { batch });
    recordDecision({ left, right, verdict: "different", decidedBy: "user", reason: "answered while queued" });

    let calls = 0;
    const results = await flushAgentBatch(
      "d7",
      async () => {
        calls += 1;
        return null;
      },
      { batch, ctx: { model: MODEL } },
    );
    expect(calls).toBe(0);
    expect(results[0].refused).toBe("negative_pair");
  });
});
