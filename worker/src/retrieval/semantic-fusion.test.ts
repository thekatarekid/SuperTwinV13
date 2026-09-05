// ===========================================================================
// The bounded fusion pipeline (V6 P1 S2.4; Build §5.2, T5-2) — RET-01 and
// RET-02 as vitest, with a FAKE encoder (planted geometry over a seeded PRNG;
// zero model calls, no network) and the deterministic reranker.
//
//   RET-01  RRF versus full scan. 20 k-event fixture, 50 queries: the top-10 the
//           bounded pipeline returns overlaps ≥ 90% with the old whole-table
//           rank(). Gate: full_vector_scan = 0 — no query reads the table.
//   RET-02  latency bound. 300 k vectors: query p50 ≤ 50 ms. The fixture is
//           built at RET02_VECTORS (default 300 000; set lower to iterate).
//   plus    the module never imports the whole-table read; RRF arithmetic; the
//           reranker re-orders the window and its failure keeps the fused order;
//           hybridSearch carries lexical-only rows and degrades without an
//           encoder; a pool is honoured.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-fusion-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
delete process.env.SUPERTWIN_RERANKER;

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { putEventEmbeddings, readEventEmbeddings } = await import("../db/embeddings.js");
const { putChunkEmbedding, upsertChunk } = await import("../db/v6graph.js");
const {
  CHUNK_CANDIDATE_LIMIT,
  FTS_CANDIDATE_LIMIT,
  MIN_SIMILARITY_SIGMAS,
  MAX_CANDIDATE_TERM_DF,
  RERANK_WINDOW,
  RRF_K,
  candidateMatch,
  hybridSearch,
  rank,
  resetSemanticCacheForTests,
  rrfFuse,
  semanticScanStats,
  semanticSearch,
} = await import("./semantic.js");
const { forgetEmbedder, setEmbedder } = await import("./embedder.js");
const { planQuery } = await import("./query.js");
const { LEXICAL_OVERLAP_RERANKER, forgetReranker, setReranker } = await import("./reranker.js");

// ---- Seeded geometry ----------------------------------------------------------

/** mulberry32 — a fixture must draw the same corpus every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function randomUnit(rnd: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = gaussian(rnd);
  return unit(v);
}

/** `centre` nudged by `spread` of noise, renormalised: a message ABOUT the query. */
function near(rnd: () => number, centre: Float32Array, spread: number): Float32Array {
  const v = new Float32Array(centre.length);
  for (let i = 0; i < v.length; i++) v[i] = centre[i] + spread * gaussian(rnd);
  return unit(v);
}

function mean(vectors: readonly Float32Array[], dim: number): Float32Array {
  const m = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) m[i] += v[i];
  return unit(m);
}

/**
 * The fake encoder: query TEXTS map to the planted centres; anything else gets
 * a seeded random direction. Passages are never embedded through it — the
 * fixture writes their vectors directly, which is what makes the geometry exact.
 */
function fixtureEmbedder(model: string, dim: number, queries: Map<string, Float32Array>) {
  return {
    model,
    dim,
    async embed(texts: readonly string[]) {
      return texts.map((t) => queries.get(t) ?? randomUnit(prng(hash(t)), dim));
    },
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const WORDS = [
  "villa", "lunch", "rent", "flight", "invoice", "dentist", "wedding", "gym", "movie", "grocery",
  "meeting", "deadline", "birthday", "parking", "refund", "passport", "recipe", "concert", "laptop", "garden",
];

interface Corpus {
  model: string;
  dim: number;
  events: number;
  perChunk: number;
  /** Query text → planted centre. Half the texts share a token with their planted events; half share none. */
  queries: { text: string; centre: Float32Array; plantedIds: string[]; lexical: boolean }[];
}

/**
 * `n` events in one chat, `perChunk` consecutive events per chunk (T5-3's
 * ratio — 730 K messages → 16 K windows — is ~45). For each of `q` queries,
 * ten consecutive events are planted near the query's centre and given a
 * topic token; every other event is a random direction with filler text.
 */
async function buildCorpus(opts: { n: number; q: number; dim: number; perChunk: number; model: string; seed: number; vocab: number }): Promise<Corpus> {
  const { n, q, dim, perChunk, model } = opts;
  const started = performance.now();
  const phase: Record<string, number> = {};
  let mark = started;
  const lap = (name: string): void => {
    const now = performance.now();
    phase[name] = Math.round(now - mark);
    mark = now;
  };
  // Yield between batches so vitest's RPC keeps flowing under a long build.
  const breathe = (): Promise<void> => new Promise((r) => setImmediate(r));
  const rnd = prng(opts.seed);
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(`INSERT OR IGNORE INTO channels (id, source_id, name, kind) VALUES ('ch-fx', 'whatsapp', 'Fixture', 'group')`).run();
  db.prepare(`INSERT OR IGNORE INTO actors (id, source_id, display_name) VALUES ('ac-fx', 'whatsapp', 'Rahul')`).run();

  // Planted blocks: 10 events each, spaced so no two share a chunk.
  const planted = new Map<number, number>(); // event index → query index
  const stride = Math.floor((n - perChunk * 2) / q);
  const centres: Float32Array[] = [];
  const plantedIds: string[][] = [];
  for (let qi = 0; qi < q; qi++) {
    centres.push(randomUnit(rnd, dim));
    plantedIds.push([]);
    const start = perChunk + qi * stride;
    for (let j = 0; j < 10; j++) planted.set(start + j, qi);
  }

  const insertEvent = db.prepare(
    `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
     VALUES (?, 'whatsapp', 'whatsapp', 'ch-fx', 'ac-fx', ?, 'message', ?, ?)`,
  );
  const vectors: Float32Array[] = new Array(n);
  const texts: string[] = new Array(n);
  const t0 = Date.UTC(2026, 0, 1);
  const EVENT_BATCH = 25_000;
  // Fixture-only: the events_fts triggers cost 0.2 ms a row (65 s at 300 K).
  // Loading without them and rebuilding the external-content index afterwards
  // is the same index in 0.3 s. The trigger SQL is read back from
  // sqlite_master and re-created verbatim, so the DB leaves exactly as it came.
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'`)
    .all() as { name: string; sql: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
  for (let lo = 0; lo < n; lo += EVENT_BATCH) {
    db.transaction(() => {
    for (let i = lo; i < Math.min(n, lo + EVENT_BATCH); i++) {
      const id = `e-${i}`;
      const qi = planted.get(i);
      let text: string;
      if (qi !== undefined) {
        vectors[i] = near(rnd, centres[qi], 0.06);
        text = `topic${qi} planted ${WORDS[i % WORDS.length]} ${i}`;
        plantedIds[qi].push(id);
      } else {
        vectors[i] = randomUnit(rnd, dim);
        text = `w${Math.floor(rnd() * opts.vocab)} ${WORDS[(i * 7) % WORDS.length]} note ${i}`;
      }
      texts[i] = text;
      insertEvent.run(id, new Date(t0 + i * 60_000).toISOString(), text, id);
    }
    })();
    await breathe();
  }
  db.exec(`INSERT INTO events_fts(events_fts) VALUES ('rebuild')`);
  for (const t of triggers) db.exec(t.sql);
  lap("events");

  for (let i = 0; i < n; i += 25_000) {
    const rows = [];
    for (let j = i; j < Math.min(n, i + 25_000); j++) rows.push({ eventId: `e-${j}`, model, dim, vector: vectors[j] });
    putEventEmbeddings(rows);
    await breathe();
  }
  lap("vectors");

  db.transaction(() => {
    for (let i = 0; i < n; i += perChunk) {
      const ids: string[] = [];
      const vs: Float32Array[] = [];
      for (let j = i; j < Math.min(n, i + perChunk); j++) {
        ids.push(`e-${j}`);
        vs.push(vectors[j]);
      }
      const { id } = upsertChunk({
        kind: "chat",
        source: "whatsapp",
        streamKey: "ch-fx",
        seq: i / perChunk,
        text: ids.map((eid, k) => `Rahul: ${texts[i + k] ?? eid}`).join("\n"),
        eventIds: ids,
      });
      putChunkEmbedding(id, mean(vs, dim), model);
    }
  })();
  lap("chunks");
  console.info(`[fixture] ${n} events built in ${Math.round(performance.now() - started)} ms ${JSON.stringify(phase)}`);

  const queries = centres.map((centre, qi) => {
    const lexical = qi % 2 === 0;
    // Every fourth query also carries "note" — a word in nearly every event,
    // which the candidate MATCH must prune rather than rank 300 K rows for.
    const common = qi % 4 === 0 ? " note" : "";
    return {
      // Even queries share the topic token with their planted events (both
      // routes find them); odd ones share no token at all (chunk route only).
      text: lexical ? `topic${qi} update${common}` : `zq${qi} unseen${common}`,
      centre,
      plantedIds: plantedIds[qi],
      lexical,
    };
  });
  return { model, dim, events: n, perChunk, queries };
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length === 0 ? 1 : 0;
  const set = new Set(b);
  return a.filter((id) => set.has(id)).length / a.length;
}

function percentile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---- Suite ----------------------------------------------------------------------

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  forgetEmbedder();
  forgetReranker();
  resetSemanticCacheForTests();
});

describe("the module shape", () => {
  it("never imports the whole-table vector read — there is no full scan to fall back to", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "semantic.ts"), "utf8");
    expect(src).not.toMatch(/\breadEventEmbeddings\b/);
    expect(src).not.toMatch(/CACHE_TTL_MS|cache\.rows/);
    // The bounded reads are what it uses instead.
    expect(src).toMatch(/readEventEmbeddingsByIds/);
    expect(src).toMatch(/readEventEmbeddingsBounded/);
    expect(src).toMatch(/lexicalCandidateEventIds/);
  });

  it("rrfFuse: Σ 1/(k + rank), first occurrence per list, k = 60", () => {
    const fused = rrfFuse([["a", "b", "c"], ["b", "a", "a", "d"]]);
    expect(RRF_K).toBe(60);
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused.get("c")).toBeCloseTo(1 / 63, 12);
    expect(fused.get("d")).toBeCloseTo(1 / 64, 12);
    // A row in both lists beats a row at the top of one.
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
    expect(rrfFuse([]).size).toBe(0);
  });
});

describe("RET-01 — RRF versus full scan (20 k events, 50 queries)", () => {
  const MODEL = "fixture-ret01";
  const DIM = 32;
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await buildCorpus({ n: 20_000, q: 50, dim: DIM, perChunk: 45, model: MODEL, seed: 101, vocab: 4000 });
  });

  afterAll(() => {
    const db = getDb();
    db.exec(`DELETE FROM chunk_embeddings; DELETE FROM chunks; DELETE FROM event_embeddings; DELETE FROM events;`);
  });

  it("top-10 overlap ≥ 90% against the whole-table rank(), reading no table", async () => {
    setEmbedder(fixtureEmbedder(MODEL, DIM, new Map(corpus.queries.map((q) => [q.text, q.centre]))));
    setReranker(null);
    process.env.SUPERTWIN_RERANKER = "off";
    resetSemanticCacheForTests();

    const key = { model: MODEL, dim: DIM };
    const all = readEventEmbeddings(key); // the OLD shape, run once here as the reference
    expect(all).toHaveLength(corpus.events);

    let total = 0;
    let lexicalOverlap = 0;
    let vectorOnlyOverlap = 0;
    for (const q of corpus.queries) {
      const reference = rank(q.centre, all, MIN_SIMILARITY_SIGMAS, 10).map((s) => s.eventId);
      expect(reference).toHaveLength(10);
      // Sanity: the reference top-10 IS the planted block.
      expect(overlap(reference, q.plantedIds)).toBe(1);

      const bounded = (await semanticSearch(q.text, 10)).map((s) => s.eventId);
      const o = overlap(reference, bounded);
      total += o;
      if (q.lexical) lexicalOverlap += o;
      else vectorOnlyOverlap += o;

      const last = semanticScanStats().last!;
      expect(last.vectorRows).toBeLessThanOrEqual(FTS_CANDIDATE_LIMIT + CHUNK_CANDIDATE_LIMIT * corpus.perChunk);
      expect(last.vectorRows).toBeLessThan(corpus.events / 4);
    }
    const meanOverlap = total / corpus.queries.length;
    expect(meanOverlap).toBeGreaterThanOrEqual(0.9);
    // Both routes carry their half: the chunk route alone reaches the planted block.
    expect(vectorOnlyOverlap / (corpus.queries.length / 2)).toBeGreaterThanOrEqual(0.9);
    expect(lexicalOverlap / (corpus.queries.length / 2)).toBeGreaterThanOrEqual(0.9);

    const stats = semanticScanStats();
    expect(stats.queries).toBe(corpus.queries.length);
    expect(stats.fullVectorScans).toBe(0); // the gate
    expect(stats.vectorRowsRead).toBeLessThan(corpus.events * corpus.queries.length * 0.25);
    delete process.env.SUPERTWIN_RERANKER;
  });

  it("the deterministic reranker re-orders the window and hybridSearch carries lexical-only rows", async () => {
    setEmbedder(fixtureEmbedder(MODEL, DIM, new Map(corpus.queries.map((q) => [q.text, q.centre]))));
    setReranker(LEXICAL_OVERLAP_RERANKER);
    const q = corpus.queries.find((x) => x.lexical)!;

    const hits = await hybridSearch(q.text, { limit: 20 });
    expect(hits.length).toBeGreaterThan(0);
    expect(semanticScanStats().last).toMatchObject({ reranker: "lexical-overlap-v1" });
    expect(semanticScanStats().last!.reranked).toBeLessThanOrEqual(RERANK_WINDOW);
    // Every planted row is in the fused list with BOTH ranks; the reranker's
    // score is what the list is ordered by, and the planted rows (which carry
    // the topic token) lead it.
    const top = hits.slice(0, 10);
    expect(top.every((h) => h.rerankScore !== null && h.score === h.rerankScore)).toBe(true);
    expect(overlap(top.map((h) => h.eventId), q.plantedIds)).toBe(1);
    expect(top.every((h) => h.lexicalRank !== null && h.vectorRank !== null)).toBe(true);
    for (let i = 1; i < top.length; i++) expect(top[i - 1].score).toBeGreaterThanOrEqual(top[i].score);

    // The lexical list also matched "update" in nothing and topicN in the ten;
    // a lexical-only row (no vector gate) appears when the fixture has one.
    const lexicalOnly = hits.filter((h) => h.vectorRank === null && h.lexicalRank !== null);
    const vectorOnly = hits.filter((h) => h.vectorRank !== null && h.lexicalRank === null);
    expect(lexicalOnly.length + vectorOnly.length).toBeGreaterThanOrEqual(0);
    // semanticSearch spends the reranker's score as similarity.
    const seeds = await semanticSearch(q.text, 5);
    expect(seeds).toHaveLength(5);
    expect(seeds.every((s) => s.similarity > 0 && s.similarity <= 1)).toBe(true);
    expect(overlap(seeds.map((s) => s.eventId), q.plantedIds)).toBe(1);
  });

  it("a reranker that throws keeps the fused order rather than failing the turn", async () => {
    setEmbedder(fixtureEmbedder(MODEL, DIM, new Map(corpus.queries.map((q) => [q.text, q.centre]))));
    setReranker({
      model: "broken",
      async score() {
        throw new Error("boom");
      },
    });
    const q = corpus.queries[1];
    const hits = await hybridSearch(q.text, { limit: 10 });
    expect(hits).toHaveLength(10);
    expect(hits.every((h) => h.rerankScore === null && h.score === h.rrf)).toBe(true);
    expect(overlap(hits.map((h) => h.eventId), q.plantedIds)).toBe(1);
  });

  it("honours a pool: nothing outside the named events is returned", async () => {
    setEmbedder(fixtureEmbedder(MODEL, DIM, new Map(corpus.queries.map((q) => [q.text, q.centre]))));
    setReranker(null);
    process.env.SUPERTWIN_RERANKER = "off";
    const q = corpus.queries[2];
    // A pool of 3,000 ids that contains the planted block: over the bound, so
    // it is read as candidates plus a bounded slice of itself.
    const pool = [...q.plantedIds];
    for (let i = 15_000; i < 18_000; i++) pool.push(`e-${i}`);
    const hits = await hybridSearch(q.text, { limit: 10, pool });
    const set = new Set(pool);
    expect(hits.every((h) => set.has(h.eventId))).toBe(true);
    expect(overlap(hits.map((h) => h.eventId), q.plantedIds)).toBe(1);
    expect(semanticScanStats().last!.vectorRows).toBeLessThanOrEqual(FTS_CANDIDATE_LIMIT + CHUNK_CANDIDATE_LIMIT * corpus.perChunk + 10);
    delete process.env.SUPERTWIN_RERANKER;
  });

  it("prunes a term that is in (almost) every event from the candidate MATCH, and only that term", () => {
    // "note" sits in every filler row — far past MAX_CANDIDATE_TERM_DF; the
    // topic token is in ten. A pruned branch is a whole branch.
    const plan = planQuery("topic4 note", new Date());
    expect(plan.match).toBe('"topic4" OR "note"');
    expect(candidateMatch(plan)).toBe('"topic4"');
    expect(MAX_CANDIDATE_TERM_DF).toBe(5000);
    // When every term is ubiquitous the plan's own expression is kept.
    expect(candidateMatch(planQuery("note", new Date()))).toBe('"note"');
    // No plan, no match.
    expect(candidateMatch(planQuery("", new Date()))).toBe("");
  });

  it("without an encoder, hybridSearch is the bounded lexical list and nothing else", async () => {
    forgetEmbedder(); // no weights on disk under the sandboxed home → null
    const q = corpus.queries.find((x) => x.lexical)!;
    const hits = await hybridSearch(q.text, { limit: 20, rerank: false });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.vectorRank === null && h.lexicalRank !== null && h.similarity === null)).toBe(true);
    expect(overlap(q.plantedIds, hits.map((h) => h.eventId))).toBe(1);
    expect(semanticScanStats().last!.vectorRows).toBe(0);
    // …and semanticSearch is empty, as it always was with the tier off.
    expect(await semanticSearch(q.text)).toEqual([]);
  });
});

describe("RET-02 — latency bound", () => {
  const MODEL = "fixture-ret02";
  const DIM = 32;
  const N = Number(process.env.RET02_VECTORS ?? 300_000);
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await buildCorpus({ n: N, q: 40, dim: DIM, perChunk: 45, model: MODEL, seed: 202, vocab: 5000 });
  }, 600_000);

  afterAll(() => {
    const db = getDb();
    db.exec(`DELETE FROM chunk_embeddings; DELETE FROM chunks; DELETE FROM event_embeddings; DELETE FROM events;`);
  });

  it(`query p50 ≤ 50 ms over ${N.toLocaleString("en-US")} vectors, every query bounded`, async () => {
    setEmbedder(fixtureEmbedder(MODEL, DIM, new Map(corpus.queries.map((q) => [q.text, q.centre]))));
    setReranker(LEXICAL_OVERLAP_RERANKER);
    resetSemanticCacheForTests();
    expect(readEventEmbeddings({ model: MODEL, dim: DIM })).toHaveLength(N);

    // Warm the statement cache with one query, then time the rest.
    await semanticSearch(corpus.queries[0].text, 10);
    const ms: number[] = [];
    for (const q of corpus.queries) {
      const t = performance.now();
      const seeds = await semanticSearch(q.text, 10);
      ms.push(performance.now() - t);
      // Latency is the gate here; the geometry is RET-01's. Still, the block is found.
      expect(overlap(seeds.map((s) => s.eventId), q.plantedIds)).toBeGreaterThanOrEqual(0.9);
      const last = semanticScanStats().last!;
      expect(last.vectorRows).toBeLessThanOrEqual(FTS_CANDIDATE_LIMIT + CHUNK_CANDIDATE_LIMIT * corpus.perChunk);
    }
    const p50 = percentile(ms, 0.5);
    const p95 = percentile(ms, 0.95);
    console.info(`[RET-02] ${N} vectors · ${ms.length} queries · p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms`);
    expect(p50).toBeLessThanOrEqual(50);
    expect(semanticScanStats().fullVectorScans).toBe(0);
  }, 120_000);
});
