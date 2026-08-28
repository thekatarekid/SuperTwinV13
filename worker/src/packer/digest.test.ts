// ===========================================================================
// Content-economy tests (build P1.2, spec §4.5): digest-line generation with
// the per-content-hash cache (same hash = ZERO new model calls), L0/L1/L2
// serving rules, the L2 log, and the escalation-rate metric.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, contentHash, type EventEnvelope } from "../db/eventlog.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider } from "../providers/types.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "../brain/llm.js";
import {
  digestLineFor,
  distillContent,
  ensureDigests,
  escalationRate,
  heavyContentOf,
  newServeCounters,
  readCachedDigest,
  recordContextStats,
  renderDigestLine,
  serveContent,
} from "./digest.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-digest-"));
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

const PAGE_TEXT =
  "Goa Villas — Book premium villas in North Goa\n" +
  "Anjuna 3BHK private pool villa, Dec 18-21 available.\n".repeat(30);

function pageEvent(url = "https://www.goibibo.com/hotels/goa"): EventEnvelope {
  const env: EventEnvelope = {
    ts: "2026-08-28T10:00:00.000Z",
    source: "browser",
    kind: "browser.page_text",
    origin: "live",
    streamKey: "tab:1",
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { url, title: "Goa Villas", page_text: PAGE_TEXT },
  };
  env.contentHash = contentHash(env);
  return env;
}

function stubDeps(): JsonPassDeps & { calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      calls++;
      opts.onEvent({
        type: "delta",
        text: '{"doc_type":"listing","key_entities":["Goa","Anjuna"],"gist":"North Goa villa listings for Dec 18-21"}',
      });
      const usage = {
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
    recordRun: () => "run",
    quarantine: () => {},
    calls: () => calls,
  };
}

describe("digest-line generation + cache", () => {
  it("pays the model once per unique content-hash — a repeat is a cache hit with zero calls", async () => {
    const deps = stubDeps();
    const env = pageEvent();
    appendEvent(env);

    const first = await digestLineFor(env, deps);
    expect(deps.calls()).toBe(1);
    expect(first).not.toBeNull();
    expect(first!.doc_type).toBe("listing");
    expect(first!.gist).toBe("North Goa villa listings for Dec 18-21");
    expect(first!.domain).toBe("www.goibibo.com");
    expect(first!.token_count).toBeGreaterThan(100);

    // Same hash again — cache answers, zero new calls.
    const second = await digestLineFor(env, deps);
    expect(deps.calls()).toBe(1);
    expect(second).toEqual(first);
    expect(readCachedDigest(env.contentHash!)).toEqual(first);

    // ensureDigests over the same batch: still zero new calls.
    expect(await ensureDigests([env, pageEvent()], deps)).toBe(0);
    expect(deps.calls()).toBe(1);
  });

  it("skips content-light events entirely", async () => {
    const deps = stubDeps();
    const env: EventEnvelope = {
      ts: "2026-08-28T10:00:00.000Z",
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: "a@g.us",
      actor: "self",
      roles: { sender: "self", audience: [], receiver: [], mentions: [] },
      payload: { text: "short message" },
      contentHash: "h_light",
    };
    expect(heavyContentOf(env)).toBeNull();
    expect(await digestLineFor(env, deps)).toBeNull();
    expect(deps.calls()).toBe(0);
  });
});

describe("L0/L1/L2 serving", () => {
  it("serves the digest line at L0, a distillation at L1, full text at L2 — and logs L2", async () => {
    const deps = stubDeps();
    const env = pageEvent();
    appendEvent(env);
    await digestLineFor(env, deps);

    const counters = newServeCounters();
    const l0 = serveContent(env, "L0", { counters });
    expect(l0).toContain("[listing] Goa Villas (www.goibibo.com)");
    expect(l0.length).toBeLessThan(250);

    const l1 = serveContent(env, "L1", { counters });
    expect(l1.length).toBeLessThan(PAGE_TEXT.length * 0.3);
    expect(l1.length).toBeGreaterThan(0);

    const l2 = serveContent(env, "L2", { counters, runId: "run_1", consumer: "executor" });
    expect(l2).toBe(PAGE_TEXT);
    expect(counters).toEqual({ l0: 1, l1: 1, l2: 1 });

    // L2 requests are logged (spec §4.5.2).
    const logged = getDb()
      .prepare(`SELECT level, consumer, run_id FROM context_escalations`)
      .all() as { level: string; consumer: string; run_id: string | null }[];
    expect(logged).toEqual([{ level: "L2", consumer: "executor", run_id: "run_1" }]);
  });

  it("content-light events pass through untouched at any level", () => {
    const env: EventEnvelope = {
      ts: "2026-08-28T10:00:00.000Z",
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: "a@g.us",
      actor: "self",
      roles: { sender: "self", audience: [], receiver: [], mentions: [] },
      payload: { text: "chai at 5?" },
    };
    const counters = newServeCounters();
    expect(serveContent(env, "L0", { counters })).toBe("chai at 5?");
    expect(serveContent(env, "L2", { counters })).toBe("chai at 5?");
    expect(counters).toEqual({ l0: 0, l1: 0, l2: 0 });
  });
});

describe("escalation-rate metric (run ledger)", () => {
  it("aggregates per-run level counts into the watched rate", () => {
    recordContextStats("run_a", { l0: 8, l1: 1, l2: 1 });
    recordContextStats("run_b", { l0: 10, l1: 0, l2: 0 });
    // Merge-in on the same run id accumulates.
    recordContextStats("run_b", { l0: 0, l1: 2, l2: 0 });
    const m = escalationRate();
    expect(m.serves).toBe(22);
    expect(m.l1).toBe(3);
    expect(m.l2).toBe(1);
    expect(m.rate).toBeCloseTo(4 / 22);
  });
});

describe("distillContent", () => {
  it("keeps structure and stays within ~20% of the source", () => {
    const text = Array.from({ length: 50 }, (_, i) =>
      i % 10 === 0 ? `# Section ${i}` : `Paragraph ${i} sentence one. And a second sentence too.`,
    ).join("\n");
    const out = distillContent(text, 0.15);
    expect(out.length).toBeLessThan(text.length * 0.3);
    expect(out).toContain("# Section 0");
  });
});

describe("renderDigestLine", () => {
  it("is a one-liner with the content_ref", () => {
    const line = renderDigestLine({
      title: "T",
      domain: "d.com",
      doc_type: "article",
      key_entities: ["A"],
      gist: "g",
      token_count: 1234,
      content_ref: "evt:e1",
    });
    expect(line).toBe("[article] T (d.com) · A — g (1234 tok, evt:e1)");
  });
});
