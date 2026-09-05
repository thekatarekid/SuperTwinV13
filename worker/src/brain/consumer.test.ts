// ===========================================================================
// BND-09 · keyed in-flight and BND-10 · revalidate at execution (GoldenEvals
// V6 P1 §5.5, S0.3 / T0-2, T0-3). Old dispatcher + old consumer, stubbed
// provider, ZERO live model calls. Dies with the consumer in S3.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, markDispatched, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "./llm.js";
import { bundleKey, isBundleStale, runBrainTick, startBrainConsumer } from "./consumer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-consumer-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  // V6 S3.2: the sender resolves to a known person, so these worlds are not
  // thin-context (a bare stream + unresolved sender + tiny bundle would be
  // held one flush by the packer instead of reaching the stubbed model).
  getDb().prepare(`INSERT INTO entities (id, type, canonical, provisional) VALUES ('ent_rohan', 'person', 'Rohan Mehta', 0)`).run();
  getDb().prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('ei_rohan', 'ent_rohan', 'wa', 'handle', 'contact:rohan')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T19:40:00.000Z");

function waMessage(i: number, text: string, streamKey = "goa-gang@g.us"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `${streamKey}-x${i}` },
  };
}

// An empty Orient answer has nothing for the Critic to grade, so the Critic
// is skipped: ONE tick costs exactly ONE model call — which is what BND-09
// counts.
const EMPTY_ORIENT = JSON.stringify({ episodes: [], proposals: [], unsorted: [], questions: [] });

interface Gate {
  /** Resolve to let every parked provider call answer. */
  release: () => void;
}

/**
 * Provider stub whose calls PARK until `release()` — the window in which a
 * duplicate submission has to be a no-op. Every call answers the empty Orient
 * shape (the Critic never runs on an empty Orient).
 */
function gatedDeps(): JsonPassDeps & Gate & { calls: () => number } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let n = 0;
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      n++;
      await opened;
      opts.onEvent({ type: "delta", text: EMPTY_ORIENT });
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  return {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: () => "run_stub",
    quarantine: () => {},
    release: () => open(),
    calls: () => n,
  };
}

function seedBundle(texts: string[], streamKey = "goa-gang@g.us"): DeltaBundle {
  appendEvents(texts.map((t, i) => waMessage(i + 1, t, streamKey)));
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles.find((b) => b.streamKey === streamKey);
  if (!bundle) throw new Error("no bundle");
  return bundle;
}

function undispatched(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;
}

describe("BND-09 · keyed in-flight", () => {
  it("the same bundle key submitted twice before the first settles → one Orient call", async () => {
    const bundle = seedBundle(["guys lets lock goa 18-21 dec", "did anyone pay the pool??"]);
    const deps = gatedDeps();
    const consumer = startBrainConsumer(deps, () => {});

    consumer.onBundle(bundle);
    // A second copy of the same rows — the orphan path re-collecting what the
    // planned path already handed over — arrives while the first is parked.
    const twin = collectTick(T0 + 3_600_000).bundles.find((b) => b.streamKey === bundle.streamKey);
    expect(twin).toBeDefined();
    expect(bundleKey(twin!)).toBe(bundleKey(bundle));
    consumer.onBundle(twin!);
    // Let the tick reach the provider, then look at what parked.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(deps.calls()).toBe(1); // exactly one model call in flight

    deps.release();
    await consumer.drain();
    // Exactly one model call for the ONE tick that ran; the twin cost nothing.
    expect(deps.calls()).toBe(1);
    expect(undispatched()).toBe(0);
  });

  it("the key is the row range, so a different range on the same stream is not deduped", async () => {
    const bundle = seedBundle(["first planning message here"]);
    const deps = gatedDeps();
    const consumer = startBrainConsumer(deps, () => {});
    consumer.onBundle(bundle);
    appendEvents([waMessage(9, "a later message in the same stream")]);
    const later = collectTick(T0 + 3_600_000).bundles.find((b) => b.streamKey === bundle.streamKey)!;
    expect(bundleKey(later)).not.toBe(bundleKey(bundle));
    consumer.onBundle(later);
    deps.release();
    await consumer.drain();
    expect(deps.calls()).toBe(2); // one per distinct key
  });

  it("a settled key is admitted again (the registry is in-flight, not forever)", async () => {
    const bundle = seedBundle(["guys lets lock goa 18-21 dec"]);
    const deps = gatedDeps();
    deps.release();
    const consumer = startBrainConsumer(deps, () => {});
    consumer.onBundle(bundle);
    await consumer.drain();
    expect(deps.calls()).toBe(1);
    // Resubmitting after settle is not blocked by the registry — but the rows
    // are now dispatched, so revalidation (BND-10) makes it free.
    consumer.onBundle(bundle);
    await consumer.drain();
    expect(deps.calls()).toBe(1);
  });
});

describe("BND-10 · revalidate at execution", () => {
  it("rows marked dispatched between enqueue and run → zero calls, status stale", async () => {
    const bundle = seedBundle(["guys lets lock goa 18-21 dec", "random link btw"]);
    expect(isBundleStale(bundle)).toBe(false);
    // Another path marks the rows while this bundle waits in the queue.
    markDispatched(bundle);
    expect(isBundleStale(bundle)).toBe(true);

    const deps = gatedDeps();
    deps.release();
    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("stale");
    expect(report.orientRunIds).toEqual([]);
    expect(deps.calls()).toBe(0);
  });

  it("a partially-marked bundle is stale too — the remainder re-enters as a fresh bundle", async () => {
    const bundle = seedBundle(["guys lets lock goa 18-21 dec", "did anyone pay the pool??"]);
    const first = { ...bundle, events: bundle.events.slice(0, 1) };
    markDispatched(first);
    const deps = gatedDeps();
    deps.release();
    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("stale");
    expect(deps.calls()).toBe(0);
    expect(undispatched()).toBe(1); // containment: the unmarked row is still queued
  });

  it("an unmarked bundle runs normally", async () => {
    const bundle = seedBundle(["guys lets lock goa 18-21 dec"]);
    const deps = gatedDeps();
    deps.release();
    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("empty");
    expect(deps.calls()).toBe(1);
    expect(undispatched()).toBe(0);
  });
});
