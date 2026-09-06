// ===========================================================================
// Artifact store (spec §10.5/§10.6) — stubbed provider, mocked clock, NO live
// model calls.
//
// These cases were `assist/assist.test.ts`'s "artifact store" block until R1
// (Build V6 P1 §2.3 / §7.3 step 3) deleted the assist lane. The STORE is not
// the lane: executor-lite and safety/injection.ts write into it and the
// router reads it, so the file moved to `surfaces/` and its tests came with
// it — deleting a lane must never quietly delete the coverage of something
// that outlived it.
//
// ONE ASSERTION DID NOT COME ACROSS, on purpose. The old lifecycle case also
// asserted that dismissing an artifact incremented `assist_topics.dismiss_count`
// (the retired gate's per-topic suppression) and that re-opening cleared it.
// That throttle is OUTPUT-side since S4.4 — the router's per-kind
// `assist.dismissed.*` counters — and is measured by NUD-07/NUD-08 and
// router.test.ts's dismissal block. The store's own half (the row moves, and
// every move writes a decisions row) is asserted here.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import type { Provider, Usage } from "../providers/types.js";
import {
  contentKeyFor,
  createArtifact,
  expireMomentBound,
  getArtifact,
  graduateArtifact,
  latestUnseen,
  listArtifacts,
  recordSignal,
  setArtifactStatus,
  signalScore,
} from "./artifacts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-artifacts-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date(2026, 7, 28, 14, 0, 0).getTime();
const MIN = 60_000;

/** A provider that answers every call with `text` and records the prompts. */
function stubProvider(text: string) {
  const messages: string[] = [];
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      messages.push(opts.message);
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  const deps: JsonPassDeps = { provider, recordRun: () => "run-1", quarantine: () => {} };
  return { deps, messages };
}

describe("artifact store (spec §10.5/§10.6)", () => {
  function mint(contentKey = "ck-1") {
    return createArtifact({
      kind: "comparison",
      title: "Villa comparison",
      summary: "compared 6 across 3 sites",
      body: { rows: 6 },
      intent: "Goa villas",
      topicKey: "stream:s",
      contentKey,
      nowMs: NOW,
    });
  }

  it("creates a durable row + decisions row; latestUnseen pins it", () => {
    const { artifact, created } = mint();
    expect(created).toBe(true);
    expect(artifact.status).toBe("new");
    expect(latestUnseen()!.id).toBe(artifact.id);
    const dec = getDb()
      .prepare(`SELECT action FROM decisions WHERE target_kind = 'artifact' AND target_id = ?`)
      .all(artifact.id) as { action: string }[];
    expect(dec.map((d) => d.action)).toContain("create");
  });

  it("dedups by content_key: identical content returns the standing artifact", () => {
    const first = mint();
    const second = mint();
    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(listArtifacts().length).toBe(1);
  });

  it("contentKeyFor is order-independent over event hashes", () => {
    const a = contentKeyFor({ topicKey: "t", intent: "i", action: "a", eventHashes: ["h1", "h2"] });
    const b = contentKeyFor({ topicKey: "t", intent: "i", action: "a", eventHashes: ["h2", "h1"] });
    expect(a).toBe(b);
  });

  it("walks the status lifecycle, every move stamped and written to decisions", () => {
    const { artifact } = mint();
    setArtifactStatus(artifact.id, "seen", { nowMs: NOW });
    expect(getArtifact(artifact.id)!.seenAt).not.toBeNull();
    setArtifactStatus(artifact.id, "dismissed", { nowMs: NOW });
    expect(getArtifact(artifact.id)!.dismissedAt).not.toBeNull();
    // Dismissed is not deleted (AST-05's assertion, now NUD-03/NUD-07): the
    // row survives with its provenance and can be re-opened.
    setArtifactStatus(artifact.id, "seen", { nowMs: NOW });
    expect(getArtifact(artifact.id)!.status).toBe("seen");
    expect(getArtifact(artifact.id)!.intent).toBe("Goa villas");
    const actions = (
      getDb()
        .prepare(`SELECT action FROM decisions WHERE target_kind = 'artifact' AND target_id = ?`)
        .all(artifact.id) as { action: string }[]
    ).map((d) => d.action);
    expect(actions).toEqual([
      "create",
      "status:seen",
      "status:dismissed",
      "status:seen",
    ]);
  });

  it("moment-bound artifacts expire past their window", () => {
    createArtifact({
      kind: "brief",
      title: "check-in window",
      expiresAt: new Date(NOW - MIN).toISOString(),
      nowMs: NOW - 60 * MIN,
    });
    expect(expireMomentBound(NOW)).toBe(1);
    expect(listArtifacts({ status: "expired" }).length).toBe(1);
  });

  it("records graded reconcile signals, not binary", () => {
    const { artifact } = mint();
    expect(recordSignal(artifact.id, "edited").weight).toBe(1.0);
    expect(recordSignal(artifact.id, "glanced").weight).toBe(0.2);
    expect(recordSignal(artifact.id, "dismissed").weight).toBe(-0.6);
    expect(signalScore(artifact.id)).toBeCloseTo(0.6);
    expect(() => recordSignal(artifact.id, "clicked")).toThrow(/unknown reconcile signal/);
  });

  it("graduates through the Critic gate: commit verdict writes a task", async () => {
    const { artifact } = mint();
    const { deps } = stubProvider(JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] }));
    const result = await graduateArtifact(artifact.id, deps, { nowMs: NOW });
    expect(result.status).toBe("graduated");
    const task = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.taskId!) as {
      title: string;
      created_by: string;
    };
    expect(task.title).toBe("Villa comparison");
    expect(task.created_by).toBe("assist:graduation");
    expect(getArtifact(artifact.id)!.status).toBe("graduated");
    expect(getArtifact(artifact.id)!.taskId).toBe(result.taskId);
  });

  it("a Critic reject blocks graduation — no task, status unchanged", async () => {
    const { artifact } = mint();
    const { deps } = stubProvider(
      JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "no evidence" }] }),
    );
    const result = await graduateArtifact(artifact.id, deps, { nowMs: NOW });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("no evidence");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });
    expect(getArtifact(artifact.id)!.status).toBe("new");
  });
});
