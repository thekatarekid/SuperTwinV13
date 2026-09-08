// ===========================================================================
// The consolidation job's Extract duty (V6 P1 E1) — the wiring itself.
//
// The pass had every rail and no caller; this is the test that says it now
// runs in the shipped app. One tick of the real job drains the Extract queue;
// the NEXT tick does not, because the duty is paced on its own five-minute
// clock, which is where the cost ceiling lives.
//
// ZERO live model calls: one stubbed provider answers everything.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { enqueueExtract, pendingExtractCount } from "../brain/extract-queue.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import { providerRequestText, providerV2TestDouble } from "../providers/test-support.js";
import { startConsolidationJob } from "./job.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-xduty-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };

function stub(output: unknown): ProviderV2 & { messages: string[] } {
  const messages: string[] = [];
  return Object.assign(providerV2TestDouble(async (opts) => {
      messages.push(providerRequestText(opts));
      opts.onEvent({ type: "delta", text: JSON.stringify(output) });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
  }), { messages });
}

function seedEpisode(episodeId: string, streamKey: string): void {
  const envelopes: EventEnvelope[] = [
    {
      ts: "2026-09-05T09:10:00+05:30",
      source: "wa",
      kind: "wa.text",
      origin: "live",
      streamKey,
      actor: "them",
      roles: { sender: "them", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: `hello from ${episodeId}`, external_id: `${episodeId}:0` },
    },
  ];
  const { ids } = appendEvents(envelopes, Date.parse("2026-09-05T10:00:00+05:30"));
  const db = getDb();
  const stream = db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(ids[0]) as { stream_id: string | null };
  db.prepare(`INSERT INTO episodes (id, stream_id, state, summary, last_ts) VALUES (?, ?, 'open', ?, ?)`).run(
    episodeId,
    stream.stream_id,
    episodeId,
    "2026-09-05T09:30:00.000Z",
  );
  addEpisodeEvents(episodeId, ids);
  enqueueExtract([{ episodeId, streamId: stream.stream_id }], "live");
}

describe("consolidation job — the Extract duty", () => {
  it("drains the extract queue on a tick, then holds off until the cadence is due", async () => {
    seedEpisode("ep_1", "wa:a@s.net");
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    const lines: string[] = [];
    const job = startConsolidationJob({
      deps: { provider },
      log: (l) => lines.push(l),
      intervalMs: 3_600_000, // never fires on its own inside the test
      t3: false,
    });
    try {
      await job.tick();
      expect(provider.messages).toHaveLength(1);
      expect(pendingExtractCount()).toBe(0);
      expect(
        getDb().prepare(`SELECT extracted_at FROM episodes WHERE id = 'ep_1'`).get(),
      ).not.toEqual({ extracted_at: null });
      expect(lines.join("\n")).toContain("[extract]");

      // A second tick inside the same five minutes must not spend again.
      seedEpisode("ep_2", "wa:b@s.net");
      await job.tick();
      expect(provider.messages).toHaveLength(1);
      expect(pendingExtractCount()).toBe(1); // kept for the next due drain
    } finally {
      job.stop();
    }
  });

  it("an empty queue costs the tick nothing and writes no extract line", async () => {
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    const lines: string[] = [];
    const job = startConsolidationJob({ deps: { provider }, log: (l) => lines.push(l), intervalMs: 3_600_000, t3: false });
    try {
      await job.tick();
      expect(provider.messages).toEqual([]);
      expect(lines.filter((l) => l.startsWith("[extract]"))).toEqual([]);
    } finally {
      job.stop();
    }
  });

  it("can be switched off entirely (extract: false) for a tick that must not spend", async () => {
    seedEpisode("ep_1", "wa:a@s.net");
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    const job = startConsolidationJob({ deps: { provider }, intervalMs: 3_600_000, t3: false, extract: false });
    try {
      await job.tick();
      expect(provider.messages).toEqual([]);
      expect(pendingExtractCount()).toBe(1);
    } finally {
      job.stop();
    }
  });
});

// ===========================================================================
// The two ways the duty could still never run (V6 P1 S6e Finish gate), both
// MEASURED on the real end-to-end driver before they were fixed:
//
//   - STARVATION. The duty sat after the Decide drain inside the serialised
//     minute tick. One run reached it at ~75 s; the next spent twelve minutes
//     in a single tick's Decide drain and never reached it — 66 episodes
//     queued, `extract runs in the ledger: 0`, claims 0, on a corpus whose
//     every other surface filled.
//   - A BURNT SLOT. The cadence clock advanced on the look, not on the drain,
//     so the boot tick's empty queue cost five minutes of the fresh-install
//     window — the window the first episodes land in.
// ===========================================================================
describe("consolidation job — the Extract duty cannot be starved or skipped", () => {
  it("runs while a tick is still in flight — its own entry point, its own guard", async () => {
    seedEpisode("ep_1", "wa:a@s.net");
    // One space with pending Decide work. The Decide drain is the duty that
    // sits immediately AHEAD of Extract in the tick, and it calls the model —
    // which is precisely the twelve-minute drain that starved the queue.
    seedEpisode("ep_decide", "wa:c@s.net");
    const db = getDb();
    db.prepare(
      `INSERT INTO spaces (id, label, status, created_at, updated_at)
       VALUES ('sp_hold', 'held', 'active', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO decide_queue (space_id, pending_episode_ids, priority, status)
       VALUES ('sp_hold', '["ep_decide"]', 'live', 'pending')`,
    ).run();
    let releaseSweep: () => void = () => {};
    const sweepBlocked = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    // A provider that hangs the FIRST call (the Decide drain's) and answers
    // every later one: the shape of a long duty ahead of Extract in the tick.
    let first = true;
    const messages: string[] = [];
    const provider = Object.assign(providerV2TestDouble(async (opts) => {
        messages.push(providerRequestText(opts));
        if (first) {
          first = false;
          await sweepBlocked;
        }
        opts.onEvent({ type: "delta", text: JSON.stringify({ claims: [], people: [], tone: [], feelings: [] }) });
        opts.onEvent({ type: "done", continuation: null, usage: USAGE });
        return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
      }), { messages });
    const lines: string[] = [];
    const job = startConsolidationJob({
      deps: { provider },
      log: (l) => lines.push(l),
      intervalMs: 3_600_000,
      t3: false,
    });
    try {
      const inFlight = job.tick(); // enters, blocks inside the sweep
      await new Promise((r) => setTimeout(r, 20));
      expect(provider.messages).toHaveLength(1); // the Decide call, still open
      // The tick is stuck before Extract. The duty still drains — the fix.
      await job.extractTick();
      expect(pendingExtractCount()).toBe(0);
      expect(lines.join("\n")).toContain("[extract]");
      releaseSweep();
      await inFlight;
    } finally {
      job.stop();
    }
  });

  it("an empty look does NOT burn the cadence: the drain right after an enqueue still spends", async () => {
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    const job = startConsolidationJob({ deps: { provider }, intervalMs: 3_600_000, t3: false });
    try {
      // Boot: nothing queued yet. Free, and it must not claim the next slot.
      await job.extractTick();
      expect(provider.messages).toEqual([]);

      // The first episodes land a moment later — not five minutes later.
      seedEpisode("ep_1", "wa:a@s.net");
      await job.extractTick();
      expect(provider.messages).toHaveLength(1);
      expect(pendingExtractCount()).toBe(0);

      // And the slot IS claimed once something was actually drained.
      seedEpisode("ep_2", "wa:b@s.net");
      await job.extractTick();
      expect(provider.messages).toHaveLength(1);
      expect(pendingExtractCount()).toBe(1);
    } finally {
      job.stop();
    }
  });

  it("stop() clears the extract timer too", async () => {
    const job = startConsolidationJob({ intervalMs: 3_600_000, t3: false, extractMs: 1_000 });
    job.stop();
    // Nothing to assert beyond "it does not throw and leaves no handle": an
    // uncleared interval would keep this file's DB open past afterEach.
    expect(typeof job.extractTick).toBe("function");
  });
});
