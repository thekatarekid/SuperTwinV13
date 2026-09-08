// ===========================================================================
// The Extract drain (V6 P1 E1) — the production caller `runExtractPass` never
// had. Stubbed provider, real temp DB, ZERO live model calls.
//
//   batching     one bundle across many streams is ONE call, not one per
//                stream (the reason the pass was left unwired), and the
//                episode / event ceilings split it when it is genuinely big.
//   cap          at most `maxCalls` calls leave one tick; what does not fit
//                keeps its place in the queue with no strike against it.
//   skip         nothing pending and nothing to seed → zero calls, no line.
//   hold         the budget latch stands the drain down BEFORE it claims, so
//                the queue survives a trip untouched.
//   surfaces     once claims exist, "Who I am" and the People circles read
//                them — the whole point of wiring the pass in.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { SELF_ENTITY_ID } from "../db/v6graph.js";
import { buildWhoIAm } from "../people/who-i-am.js";
import { circleOf, listEntities } from "../entities/registry.js";
import {
  resetBudgetForTests,
  resetHoldLogForTests,
  setBudgetStore,
  tripBudget,
  type BudgetStore,
} from "../providers/budget.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import {
  EXTRACT_BATCH_EPISODES,
  EXTRACT_CALLS_PER_TICK,
  EXTRACT_INTERVAL_MS,
  extractDrainLogLine,
  extractDrainTick,
  planExtractBatches,
} from "./extract-drain.js";
import {
  claimExtractBatch,
  deadLetteredExtractCount,
  enqueueExtract,
  pendingExtractCount,
  type ExtractQueueRow,
} from "./extract-queue.js";
import { providerV2TestDouble as brainTestProvider, providerRequestText } from "../providers/test-support.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-xdrain-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetBudgetForTests();
  resetHoldLogForTests();
});

afterEach(() => {
  closeDb();
  resetBudgetForTests();
  resetHoldLogForTests();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };

/** A provider that answers every call with the same JSON and counts the calls. */
function stub(output: unknown): ProviderV2 & { messages: string[] } {
  const messages: string[] = [];
  return Object.assign(brainTestProvider(async (opts) => {
      messages.push(providerRequestText(opts));
      opts.onEvent({ type: "delta", text: JSON.stringify(output) });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
  }), { messages });
}

const EMPTY_OUT = { claims: [], people: [], tone: [], feelings: [] };
const NULLF = { amount: null, currency: null, date: null, status: null, merchant: null, order_id: null, location: null, duration_s: null };

/** One episode of `texts` on `streamKey`, committed and queued for Extract. */
function seedEpisode(
  episodeId: string,
  streamKey: string,
  texts: { actor: string; text: string; source?: string }[],
): { episodeId: string; ids: string[] } {
  const envelopes: EventEnvelope[] = texts.map((t, i) => ({
    ts: `2026-09-05T09:${String(10 + i).padStart(2, "0")}:00+05:30`,
    source: t.source ?? "wa",
    kind: `${t.source ?? "wa"}.text`,
    origin: "live",
    streamKey,
    actor: t.actor,
    roles: { sender: t.actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: t.text, external_id: `${episodeId}:${i}` },
  }));
  const { ids } = appendEvents(envelopes, Date.parse("2026-09-05T10:00:00+05:30"));
  const db = getDb();
  const stream = db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(ids[0]) as { stream_id: string | null };
  db.prepare(`INSERT INTO episodes (id, stream_id, state, summary, last_ts) VALUES (?, ?, 'open', ?, ?)`).run(
    episodeId,
    stream.stream_id,
    episodeId,
    `2026-09-05T09:30:00.000Z`,
  );
  addEpisodeEvents(episodeId, ids);
  enqueueExtract([{ episodeId, streamId: stream.stream_id }], "live");
  return { episodeId, ids };
}

function row(episodeId: string, streamId: string | null): ExtractQueueRow {
  return { episodeId, streamId, priority: "live", status: "pending", attempts: 0 };
}

// ---------------------------------------------------------------------------
// The batcher
// ---------------------------------------------------------------------------

describe("planExtractBatches — one bundle across many streams is ONE call", () => {
  it("packs fifteen streams' episodes into a single call instead of fifteen", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(`ep_${i}`, `st_${i}`));
    const batches = planExtractBatches(rows, { maxEpisodes: 15, maxEvents: 1000, maxCalls: 4 });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.episodeIds).toHaveLength(15);
    expect(batches[0]!.streams).toHaveLength(15);
  });

  it("splits on the episode ceiling and keeps a stream's episodes together", () => {
    const rows = [
      row("a1", "st_a"), row("b1", "st_b"), row("a2", "st_a"), row("b2", "st_b"),
    ];
    const batches = planExtractBatches(rows, { maxEpisodes: 2, maxEvents: 1000, maxCalls: 4 });
    expect(batches.map((b) => b.episodeIds)).toEqual([["a1", "a2"], ["b1", "b2"]]);
  });

  it("splits on the event ceiling, and one oversized episode still gets its call", () => {
    const rows = [row("small", "st_a"), row("huge", "st_a"), row("tail", "st_a")];
    const sizes = new Map([["small", 10], ["huge", 500], ["tail", 5]]);
    const batches = planExtractBatches(rows, { maxEpisodes: 9, maxEvents: 100, maxCalls: 9, sizes });
    expect(batches.map((b) => b.episodeIds)).toEqual([["small"], ["huge"], ["tail"]]);
    expect(batches[1]!.events).toBe(500);
  });

  it("never returns more than maxCalls batches, and returns nothing at all for zero", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`ep_${i}`, `st_${i}`));
    expect(planExtractBatches(rows, { maxEpisodes: 1, maxCalls: 2 })).toHaveLength(2);
    expect(planExtractBatches(rows, { maxCalls: 0 })).toEqual([]);
    expect(planExtractBatches([], {})).toEqual([]);
  });

  it("ships the ceilings the cost arithmetic is based on", () => {
    expect(EXTRACT_CALLS_PER_TICK).toBe(2);
    expect(EXTRACT_BATCH_EPISODES).toBe(6);
    // 2 calls per 5 minutes = 24 an hour, well inside the 400/hour ceiling.
    expect((3_600_000 / EXTRACT_INTERVAL_MS) * EXTRACT_CALLS_PER_TICK).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

describe("extractDrainTick — the lookup before the call", () => {
  it("an empty queue with nothing to seed costs ZERO calls and says nothing", async () => {
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider } });
    expect(report.status).toBe("idle");
    expect(report.modelCalls).toBe(0);
    expect(provider.messages).toEqual([]);
    expect(extractDrainLogLine(report)).toBeNull();
  });

  it("seeds a home the pass never ran on, then drains it — the upgrade path", async () => {
    // An episode that was committed before Extract had a caller: no queue row.
    seedEpisode("ep_old", "wa:old@s.net", [{ actor: "them", text: "hello there" }]);
    getDb().prepare(`DELETE FROM extract_queue`).run();
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider } });
    expect(report.seeded).toBe(1);
    expect(report.status).toBe("drained");
    expect(report.episodes).toBe(1);
    expect(pendingExtractCount()).toBe(0);
    // and the watermark means the next tick has nothing to do at all
    const again = await extractDrainTick({ deps: { provider } });
    expect(again.status).toBe("idle");
    expect(again.seeded).toBe(0);
    expect(provider.messages).toHaveLength(1);
  });

  it("spends at most maxCalls calls a tick; the rest keeps its place, unpunished", async () => {
    for (let i = 0; i < 5; i++) {
      seedEpisode(`ep_${i}`, `wa:s${i}@s.net`, [{ actor: "them", text: `message ${i}` }]);
    }
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider }, maxCalls: 2, maxEpisodes: 1 });
    expect(provider.messages).toHaveLength(2); // the CAP, not the backlog
    expect(report.modelCalls).toBe(2);
    expect(report.episodes).toBe(2);
    expect(pendingExtractCount()).toBe(3);
    const left = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM extract_queue WHERE attempts > 0`)
      .get() as { n: number };
    expect(left.n).toBe(0); // not attempted, so not a strike
  });

  it("stands down on the budget latch without claiming anything, and says so", async () => {
    seedEpisode("ep_1", "wa:a@s.net", [{ actor: "them", text: "hello there" }]);
    const mem = new Map<string, string>();
    const memStore: BudgetStore = {
      get: (k) => mem.get(k) ?? null,
      set: (k, v) => void mem.set(k, v),
      delete: (k) => void mem.delete(k),
    };
    setBudgetStore(memStore);
    tripBudget("$3/hour reached");
    const lines: string[] = [];
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider }, log: (l) => lines.push(l) });
    expect(report.status).toBe("held");
    expect(provider.messages).toEqual([]);
    expect(pendingExtractCount()).toBe(1); // kept exactly where it was
    expect(getDb().prepare(`SELECT status FROM extract_queue WHERE episode_id = 'ep_1'`).get()).toEqual({
      status: "pending",
    });
    expect(lines.join(" ")).toContain("[budget] HELD");
    expect(extractDrainLogLine(report)).toContain("waiting");
  });

  it("a failed pass keeps the work and takes one strike, never the watermark", async () => {
    seedEpisode("ep_1", "wa:a@s.net", [{ actor: "them", text: "hello there" }]);
    // An answer the validator rejects outright, twice (the repair round is
    // shown its own reply): the pass quarantines instead of writing.
    const bad = stub([]);
    const report = await extractDrainTick({ deps: { provider: bad, sleep: async () => {} } });
    expect(report.failedBatches).toBe(1);
    expect(report.episodes).toBe(0);
    expect(pendingExtractCount()).toBe(1);
    expect(deadLetteredExtractCount()).toBe(0);
    const ep = getDb().prepare(`SELECT extracted_at FROM episodes WHERE id = 'ep_1'`).get() as {
      extracted_at: string | null;
    };
    expect(ep.extracted_at).toBeNull();
  });

  it("claims episodes with no space too — an unspaced episode still holds facts", async () => {
    const { episodeId } = seedEpisode("ep_free", "wa:a@s.net", [{ actor: "them", text: "hello there" }]);
    expect(getDb().prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(episodeId)).toEqual({ space_id: null });
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider } });
    expect(report.episodes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The surfaces the pass feeds
// ---------------------------------------------------------------------------

describe("extractDrainTick — the surfaces read what the drain writes", () => {
  it("fills 'Who I am' and places a People circle from one drained episode", async () => {
    const before = buildWhoIAm();
    expect(before.empty).toBe(true);
    expect(before.counts.claims).toBe(0);

    const { ids } = seedEpisode("ep_1", "wa:home@s.net", [
      { actor: "self", source: "self", text: "I live in Pune and work at Falcon" },
      { actor: "them", text: "Meera is my sister, she called about the trip" },
    ]);
    const provider = stub({
      claims: [
        {
          subject: "self",
          kind: "fact",
          text: "Lives in Pune",
          provenance: "self_reported",
          fields: NULLF,
          evidence: [{ event_ids: [ids[0]], quote: "I live in Pune" }],
          confidence: 0.9,
        },
      ],
      people: [
        {
          id: "new:meera",
          name: "Meera",
          anchors: ["sister"],
          relationship: "sister",
          confidence: 0.8,
          evidence: [{ event_ids: [ids[1]], quote: "Meera is my sister" }],
        },
      ],
      tone: [],
      feelings: [
        {
          episode: "ep_1",
          feeling: "looking forward to the trip",
          evidence: [{ event_ids: [ids[1]], quote: "about the trip" }],
          confidence: 0.6,
        },
      ],
    });

    const report = await extractDrainTick({ deps: { provider } });
    expect(report.status).toBe("drained");
    expect(report.claimsWritten).toBeGreaterThan(0);
    expect(report.provisionalPeople).toBe(1);
    expect(report.feelings).toBe(1);

    // The card the user opens.
    const card = buildWhoIAm();
    expect(card.empty).toBe(false);
    expect(card.selfId).toBe(SELF_ENTITY_ID);
    expect([...card.basics, ...card.life, ...card.traits].map((l) => l.text)).toContain("Lives in Pune");
    expect(card.counts.claims).toBeGreaterThan(0);

    // The circle inference the drain runs after claims land — code, no call.
    const meera = listEntities({ type: "person" }).find((e) => e.canonical === "Meera");
    expect(meera).toBeDefined();
    expect(circleOf(meera!.id)).toBe("family");
    expect(report.circlesAssigned).toBeGreaterThan(0);
    expect(card.people.family.map((p) => p.name)).toContain("Meera");

    // One call bought all of it.
    expect(provider.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Batching over the real queue
// ---------------------------------------------------------------------------

describe("extractDrainTick — batching over the real queue", () => {
  it("drains four episodes across four streams in ONE call", async () => {
    for (let i = 0; i < 4; i++) {
      seedEpisode(`ep_${i}`, `wa:s${i}@s.net`, [{ actor: "them", text: `message ${i}` }]);
    }
    const provider = stub(EMPTY_OUT);
    const report = await extractDrainTick({ deps: { provider } });
    expect(provider.messages).toHaveLength(1);
    expect(report.batches).toBe(1);
    expect(report.episodes).toBe(4);
    expect(pendingExtractCount()).toBe(0);
    // every episode of every stream is named in the one pack
    for (let i = 0; i < 4; i++) expect(provider.messages[0]).toContain(`ep_${i}`);
    expect(claimExtractBatch(10)).toEqual([]);
    // and the operator can read what it cost, in one line
    expect(extractDrainLogLine(report)).toBe(
      "[extract] 1 call(s) over 4 episode(s): claims=0 people=0 tone=0 feelings=0 | 0 pending",
    );
  });
});
