# Retrieval tiers and the graph store — decision record

Referenced by `SuperTwinV13_Product_V6.md` §23.4 and §23.5. The PRD carries the decisions; this carries the reasoning, the measurements and the code shapes.

Date: 2026-09-05. Status: accepted, unimplemented.

* * *

## 1. What prompted this

V6 §23.4 described retrieval as one pipeline: lexical plus vector plus exact keys, fused, reranked, judged. Two problems.

1. It is a **similarity** pipeline. It returns the k things most like your words. A large share of real questions are not similarity questions.
2. The grounded bar (§16.1) said "instant results while typing" and "every answer cites events" without saying by what mechanism.

## 2. Questions similarity cannot answer

| Question | Why top-k fails |
|---|---|
| How much did I spend on cabs last month? | No ranking of chunks is a sum. Needs SQL over typed fields. |
| Did Karan ever pay the advance? | Proving **absence** is not retrieval. Needs a bounded scan of one thread. |
| Who recommended the place Rohan mentioned at dinner? | Three hops. Single-shot cannot chain. |
| What happened Tuesday afternoon? | A range scan on the log. Not a search at all. |
| What does Ma care about? | Entity-anchored traversal of the claim graph. |
| Everything about my passport renewal | Needs *completeness*. Top-30 silently truncates and the answer looks confident. |

The last row is the dangerous one: a truncated answer to an enumeration question is a silent correctness bug, not a quality issue.

## 3. Five methods

1. **Lexical (BM25)** — rare tokens, names, numbers.
2. **Vector (local, 768-d)** — paraphrase.
3. **Structured (SQL over the world model)** — sums, counts, ranges, status filters, enumeration by type.
4. **Graph traversal** — person → claims → episodes → spaces → people; bridges as edges.
5. **Time-window scan** — the timeline, unscored.

Methods 3 and 4 were missing. Method 3 is the bigger gap, and it is blocked on extraction, not on retrieval: if a cab receipt lands as the sentence "paid ₹340 to Uber" and nothing else, no retrieval design can ever sum it. Hence the typed-fields change in §11.14.

### Fusion

Union-then-rerank is wrong. BM25 and cosine scores live on different scales, so a naive union lets whichever scorer happens to run hot dominate the candidate pool. Use **reciprocal rank fusion**: combine positions, not scores.

```
score(d) = Σ over lists L of  1 / (k + rank_L(d))          k ≈ 60
```

Same cost, better recall, no calibration to maintain. This also removes the `embedder_calib` class of problem that V11 had.

## 4. Three tiers

| Tier | What | Latency | Model calls | Users |
|---|---|---|---|---|
| T0 | hybrid, fused, reranked, judged | ~150 ms | 0 | packer, bar type-ahead, consolidation |
| T1 | one call plans, code executes | ~1 s | 1 | most bar questions, executor context |
| T2 | agentic loop | 5–30 s | 3–8 | multi-hop, absence, "everything about X" |

### Why the packer must stay at T0

The packer runs on every bundle. From V6 §11.3, measured: ~115 bundles a day with screen on at balanced freshness, and a steady-state target of $11–20 a month.

```
packer at T0:   115 bundles/day × 0 retrieval calls  =  0 extra calls
packer at T2:   115 × ~5 calls                       =  575 extra calls/day
                → roughly 3–5× the monthly model spend
                → plus 5–30 s added to a 45 s flush window, which breaks
                  the ≤10 min freshness promise under any real load
```

So: hard invariant (§23.7.13). Thin context in the packer produces a question, never a search loop. The bar and the executor escalate freely because a human is waiting and it is a handful of escalations a day.

### T2 belongs where a loop already exists

The executor (§12.1) already loops, reads and re-queries. Its context gathering *is* agentic retrieval; it simply was not named. No new machinery — T2 is the executor's inner loop exposed to the bar.

## 5. The grounded bar mechanism

```
 keystroke ─► T0, local, no model, <150 ms ─► live list
      │ Enter
      ▼
 ROUTE  one fast call → { class, methods, entities, time, filters, completeness }
      ▼
 EXECUTE  methods in parallel → RRF → cross-encoder → judge
      ▼
 SUFFICIENCY (code, not model)
   lookup     → is there a verbatim quote covering the claim?
   aggregate  → is the set complete, or did a source window cut it?
   absence    → was the full thread scanned, or only top-k?
   multihop   → did every hop resolve?
      ├─ pass ────► answer with citations
      ├─ fail ────► escalate to T2, stream progress
      └─ general ─► model answers directly, labelled "not from your data"
```

Sufficiency is checked in code because asking a model "did you have enough?" inherits the model's own optimism. It is the same reason Critic is a separate pass from Orient.

The **coverage index** is what makes a partial answer honest. Without per-source, per-date-range knowledge of what was never captured, "I found three" is indistinguishable from "there are three".

## 6. The graph: what exists today

Checked against the repo on 2026-09-05.

| Present | Where |
|---|---|
| `entities`, `entity_identities` | nodes, merge resolution, provisional people |
| `entity_edges` | `kind · subtype · src · dst · confidence · decided_by · status · valid_from · valid_to` |
| `edge_evidence` | `edge_id · event_id · quote` |
| `mentions`, `space_entities`, `space_links`, `space_claims` | entity↔episode, entity↔space, space↔space |
| `bridges`, `event_bridge_keys`, `space_bridge_keys` | exact-match edges |
| `worker/src/entities/edges.ts` | `writeEdge · supersedeEdge · rejectEdge · addEdgeEvidence · edgesFrom · edgesTo · edgesOf · listEdges · repointEdges` |

That is a typed, weighted, bitemporal, evidence-backed property graph. Better provenance than a graph DB gives by default — there you would model edge evidence and validity by hand.

### It is never walked

```
callers of edgesOf outside tests:  1
  └─ worker/src/server/worldmodel-routes.ts:58   (REST route, renders a person card)

WITH RECURSIVE anywhere in worker/src:  0
```

Edges are written on every extraction and read once, one hop, for the UI. Bridges are extracted and never consumed — V2 flagged them "built, never wired" and they still are.

**Graph search does not work today because no traversal was written, not because of the storage engine.**

## 7. Why not a graph database

### Scale

Heavy user after years: ~3k–10k entities, ~30k–100k edges, ~50k claims. A bounded 3-hop walk with fan-out caps touches a few thousand indexed rows — single-digit milliseconds in `better-sqlite3`, which is synchronous and in-process.

Graph engines earn out around 10⁸–10⁹ edges, where index-free adjacency beats B-tree descent. That is three to four orders of magnitude away. The win here is unmeasurable.

### Four costs

1. **A second source of truth.** Rebuildable from the event log, so it would be a projection — but one that drifts, needs its own rebuild path, migrations, and repair job.
2. **Distribution weight.** Tauri app, signed and notarized. A JVM is out. Embedded engines are per-arch native binaries: bundle size, codesigning, two more failure modes at install.
3. **Loss of transactional atomicity.** A critic-gated commit writes episodes, edges, claims and evidence in **one SQLite transaction**. Splitting the store makes that a two-phase write with a partial-failure mode — attacking the "no write without evidence" and "≥95% containment" invariants. Trading a correctness guarantee for an unmeasurable performance win.
4. **Loss of the join.** The valuable queries are hybrid:

   > walk from Ma to her claims, restricted to claims with evidence from tier-1 streams in the last six months, ranked by BM25 against the query, excluding superseded ones

   One statement in one database, planner-optimized. Across two stores it becomes application-level join logic: pull candidate ids from the graph, round-trip into SQLite, filter and re-rank in memory. Slower, more code, and it makes the fused retrieval design harder — the opposite of the goal.

### Revisit threshold

- edges pass ~10⁷, or
- variable-length path queries become a language need across many unforeseen query shapes rather than a handful of known walks, or
- graphs move server-side and stop being per-device.

Then: an **embedded** engine (Kuzu class, no JVM) as a rebuildable projection off the event log, never as a second source of truth. Measure before adopting; at 10⁷ edges a well-indexed SQLite usually still holds.

## 8. Traversal shape

Either a recursive CTE:

```sql
WITH RECURSIVE walk(node, hop, score) AS (
  SELECT id, 0, 1.0 FROM entities WHERE id IN (/* seeds */)
  UNION ALL
  SELECT CASE WHEN e.src_entity_id = w.node THEN e.dst_entity_id ELSE e.src_entity_id END,
         w.hop + 1,
         w.score * COALESCE(e.confidence, 0.5) * 0.6          -- per-hop decay
  FROM walk w JOIN entity_edges e
    ON (e.src_entity_id = w.node OR e.dst_entity_id = w.node)
  WHERE w.hop < 3 AND w.score > 0.05
    AND e.status = 'active'
    AND (e.valid_to IS NULL OR e.valid_to > :now)
    AND e.kind IN (:kinds)
)
SELECT node, MAX(score) s FROM walk
WHERE node NOT IN (:hub_ids) GROUP BY node ORDER BY s DESC LIMIT 30;
```

…or, preferred, a ~40-line BFS in TypeScript over prepared statements. Pure SQL makes per-node fan-out capping and cycle detection awkward; a loop gives both plus explicit scoring, and the round-trips are free because `better-sqlite3` is in-process and synchronous.

Either way: **no new dependency.**

## 9. Work items

| # | Item | Phase | Blocked on |
|---|---|---|---|
| 1 | RRF fusion replacing score union | P1 | — |
| 2 | Typed fields in extraction and the claims schema | P1 | extraction prompt + migration |
| 3 | Structured retrieval method over typed fields | P1 | 2 |
| 4 | Coverage index per source per date range | P1 | — |
| 5 | Wire the bridges into retrieval and the packer | P1 | — |
| 6 | Bounded graph walk, 2 hops, hub exclusion | P1 | 5 |
| 7 | Route pass and T1 planned retrieval | P2 | — |
| 8 | Sufficiency checks per question class | P2 | 7 |
| 9 | T2 agentic loop, budgeted | P2 | executor |
| 10 | Measure hop limit, fan-out cap, hub list on a real graph | P2 | 6 |

Item 5 is the highest value per unit of work: bridges are the highest-precision edges in the system and the only thing that joins a browser visit to a chat message to a confirmation mail. They are already extracted.
