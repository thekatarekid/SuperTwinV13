// ===========================================================================
// [CANDIDATE SPACES] — T0 retrieval, hard cap 5, never an enumeration
// (V6 P1 S3.2; Build §6.1; Product_V6 §23.7 rules 10 + 15; PCK-02, PCK-07).
//
// Candidate spaces come from RETRIEVAL, whatever the space count. Measured on
// the prior build: enumerating all 104 spaces produced a 37,000-character
// prompt that grew with every space the user accumulated. This module never
// reads the spaces table without a bounded candidate set in hand, and it
// never calls a model: every lane is local SQL or a local vector read.
//
//   retrieval  the S2.4 hybrid pipeline (retrieval/semantic.ts hybridSearch:
//              FTS ∪ chunk vectors → RRF) over the bundle's salient text →
//              the spaces those events were filed into (episode membership)
//   card       lexical over the space / episode CARD chunks (chunks_fts),
//              plus a bounded vector read over the space cards when the
//              encoder is on (S2.2 cards are chunks)
//   fts        spaces_fts (label · goal · exemplars) — the V13 lane, kept
//   entity     event participants against space_entities
//   bridge     event_bridge_keys against space_bridge_keys — exact match,
//              the strongest signal
//
// The lanes are fused by reciprocal rank (k = 60, Product_V6 §20.2) with a
// per-lane weight; ties break on recency, then id, so the pack is
// deterministic for a given world. The reranker is NOT run here: the packer
// has a 200 ms budget (PCK-07) and the Orient model is the judge of the five.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { BundleEvent } from "../scheduler/dispatch.js";
import { hybridSearch } from "../retrieval/semantic.js";
import { searchChunksLexical } from "../retrieval/lexical.js";
import { planQuery, STOPWORDS } from "../retrieval/query.js";
import { vectorSearchChunks } from "../retrieval/chunk-index.js";
import { semanticEnabled } from "../retrieval/embedder.js";

export interface CandidateSpace {
  id: string;
  label: string;
  lifeArea: string | null;
  goal: string | null;
  status: string;
  /** Exemplar episode summaries (stored exemplars, else the latest episodes). */
  exemplars: string[];
  /** Which lanes nominated it, sorted. */
  lanes: string[];
  /** Fused score (RRF); higher is better. */
  score: number;
}

export interface CandidateOptions {
  /** Hard cap on the list. Never above MAX_CANDIDATE_SPACES. */
  limit?: number;
  nowMs?: number;
  /** Exemplars per candidate. */
  exemplarLimit?: number;
}

/** The hard cap (Product_V6_Phase1 §24.8). */
export const MAX_CANDIDATE_SPACES = 5;
export const RRF_K = 60;

const LANE_WEIGHTS: Record<string, number> = {
  bridge: 2.0,
  entity: 1.0,
  retrieval: 1.0,
  card: 1.0,
  fts: 0.8,
};

/** Bounded reads per lane. */
const RETRIEVAL_HITS = 50;
const CARD_HITS = 20;
const CARD_VECTOR_HITS = 10;
const FTS_HITS = 10;
const ENTITY_HITS = 10;
const QUERY_CHARS = 1_000;

/** Salient tokens of the bundle text: stopwords out, short tokens out. */
export function salientTokens(events: readonly Pick<BundleEvent, "text">[], cap = 24): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    for (const raw of (e.text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3 || STOPWORDS.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([t]) => t);
}

interface SpaceRow {
  id: string;
  label: string;
  life_area: string | null;
  goal: string | null;
  status: string;
  exemplars_json: string | null;
  updated_at: string | null;
  created_at: string;
}

function storedExemplars(row: SpaceRow, limit: number): string[] {
  try {
    const parsed = JSON.parse(row.exemplars_json ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string" && e.length > 0).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

/** Latest episode summaries of a space — the exemplars when none are stored. */
function episodeExemplars(spaceId: string, limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT summary FROM episodes
        WHERE space_id = ? AND summary IS NOT NULL AND summary != ''
        ORDER BY COALESCE(last_ts, created_at) DESC, id LIMIT ?`,
    )
    .all(spaceId, limit) as { summary: string }[];
  return rows.map((r) => r.summary);
}

/** Spaces the given events were filed into, via explicit membership (S3.1) or legacy range endpoints. */
function spacesOfEvents(eventIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (eventIds.length === 0) return out;
  const ph = eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ee.event_id AS explicit_id, ee.start_event_id, ee.end_event_id, ep.space_id
         FROM episode_events ee JOIN episodes ep ON ep.id = ee.episode_id
        WHERE ep.space_id IS NOT NULL
          AND (ee.event_id IN (${ph}) OR ee.start_event_id IN (${ph}) OR ee.end_event_id IN (${ph}))`,
    )
    .all(...eventIds, ...eventIds, ...eventIds) as {
    explicit_id: string | null;
    start_event_id: string;
    end_event_id: string;
    space_id: string;
  }[];
  const wanted = new Set(eventIds);
  for (const r of rows) {
    for (const id of [r.explicit_id, r.start_event_id, r.end_event_id]) {
      if (!id || !wanted.has(id)) continue;
      const list = out.get(id) ?? [];
      if (!list.includes(r.space_id)) list.push(r.space_id);
      out.set(id, list);
    }
  }
  return out;
}

function spacesOfEpisodes(episodeIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (episodeIds.length === 0) return out;
  const ph = episodeIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, space_id FROM episodes WHERE id IN (${ph}) AND space_id IS NOT NULL`)
    .all(...episodeIds) as { id: string; space_id: string }[];
  for (const r of rows) out.set(r.id, r.space_id);
  return out;
}

/**
 * The five lanes fused by RRF, capped. Only non-archived/rejected spaces
 * compete; proposed spaces DO compete (matching an existing proposal beats
 * proposing a duplicate). Zero model calls; every read bounded.
 */
export async function candidateSpaces(
  events: readonly BundleEvent[],
  opts: CandidateOptions = {},
): Promise<CandidateSpace[]> {
  const db = getDb();
  const limit = Math.max(0, Math.min(opts.limit ?? MAX_CANDIDATE_SPACES, MAX_CANDIDATE_SPACES));
  if (limit === 0) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const exemplarLimit = opts.exemplarLimit ?? 2;

  // spaceId -> lane -> best rank (1-based) in that lane
  const ranks = new Map<string, Map<string, number>>();
  const nominate = (spaceId: string, lane: string, rank: number): void => {
    const lanes = ranks.get(spaceId) ?? new Map<string, number>();
    const cur = lanes.get(lane);
    if (cur === undefined || rank < cur) lanes.set(lane, rank);
    ranks.set(spaceId, lanes);
  };

  const tokens = salientTokens(events);
  const queryText = tokens.join(" ").slice(0, QUERY_CHARS);
  const now = new Date(nowMs);

  // ---- Lane: retrieval (S2.4 hybrid over events → their spaces) -------------
  if (queryText.length > 0) {
    try {
      const hits = await hybridSearch(queryText, { limit: RETRIEVAL_HITS, now, rerank: false });
      const ids = hits.map((h) => h.eventId);
      const bySpace = spacesOfEvents(ids);
      let rank = 0;
      const seen = new Set<string>();
      for (const id of ids) {
        for (const sp of bySpace.get(id) ?? []) {
          if (seen.has(sp)) continue;
          seen.add(sp);
          nominate(sp, "retrieval", ++rank);
        }
      }
    } catch {
      // A lane that fails is a lane that nominates nothing, never a failed pack.
    }
  }

  // ---- Lane: cards (chunks_fts over space + episode cards; vectors over space cards)
  if (queryText.length > 0) {
    const plan = planQuery(queryText, now);
    if (plan.match.length > 0) {
      try {
        const chunkHits = searchChunksLexical(plan.match, { limit: CARD_HITS, kinds: ["space", "episode"] });
        const episodeRefs = chunkHits
          .filter((h) => h.chunkKind === "episode" && h.refId)
          .map((h) => h.refId as string);
        const epSpace = spacesOfEpisodes(episodeRefs);
        let rank = 0;
        const seen = new Set<string>();
        for (const h of chunkHits) {
          const sp = h.chunkKind === "space" ? h.refId : h.refId ? epSpace.get(h.refId) ?? null : null;
          if (!sp || seen.has(sp)) continue;
          seen.add(sp);
          nominate(sp, "card", ++rank);
        }
      } catch {
        /* lexical lane down */
      }
    }
    if (semanticEnabled()) {
      try {
        const vec = await vectorSearchChunks(queryText, { limit: CARD_VECTOR_HITS, kinds: ["space"] });
        vec.forEach((h, i) => {
          if (h.chunk.refId) nominate(h.chunk.refId, "card", i + 1);
        });
      } catch {
        /* vector lane down */
      }
    }
  }

  // ---- Lane: spaces_fts ------------------------------------------------------
  if (tokens.length > 0) {
    const match = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    try {
      const rows = db
        .prepare(`SELECT space_id FROM spaces_fts WHERE spaces_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(match, FTS_HITS) as { space_id: string }[];
      rows.forEach((r, i) => nominate(r.space_id, "fts", i + 1));
    } catch {
      // A hostile MATCH string is a no-op lane.
    }
  }

  // ---- Lane: entity overlap -------------------------------------------------
  const participants = new Set<string>();
  for (const e of events) {
    try {
      const roles = JSON.parse(e.rolesJson ?? "{}") as { sender?: string; audience?: string[]; mentions?: string[] };
      if (roles.sender) participants.add(roles.sender);
      for (const a of roles.audience ?? []) participants.add(a);
      for (const m of roles.mentions ?? []) participants.add(m);
    } catch {
      /* skip */
    }
    if (e.actor) participants.add(e.actor);
  }
  participants.delete("self");
  if (participants.size > 0) {
    const refs = [...participants];
    const ph = refs.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT se.space_id, COUNT(*) AS overlap
           FROM space_entities se
          WHERE se.entity_id IN (${ph})
             OR se.entity_id IN (SELECT entity_id FROM entity_identities WHERE value_norm IN (${ph}))
          GROUP BY se.space_id ORDER BY overlap DESC, se.space_id LIMIT ?`,
      )
      .all(...refs, ...refs, ENTITY_HITS) as { space_id: string }[];
    rows.forEach((r, i) => nominate(r.space_id, "entity", i + 1));
  }

  // ---- Lane: bridge exact-match ---------------------------------------------
  const eventIds = events.map((e) => e.id);
  if (eventIds.length > 0) {
    const ph = eventIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT sbk.space_id
           FROM event_bridge_keys ebk
           JOIN space_bridge_keys sbk ON sbk.kind = ebk.kind AND sbk.value_norm = ebk.value_norm
          WHERE ebk.event_id IN (${ph}) ORDER BY sbk.space_id`,
      )
      .all(...eventIds) as { space_id: string }[];
    rows.forEach((r, i) => nominate(r.space_id, "bridge", i + 1));
  }

  if (ranks.size === 0) return [];

  // ---- Fuse (RRF) + hydrate the nominated rows only --------------------------
  const ids = [...ranks.keys()];
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, label, life_area, goal, status, exemplars_json, updated_at, created_at
         FROM spaces WHERE id IN (${ph}) AND status NOT IN ('archived', 'rejected')`,
    )
    .all(...ids) as SpaceRow[];

  const scored = rows.map((row) => {
    const lanes = ranks.get(row.id)!;
    let score = 0;
    for (const [lane, rank] of lanes) score += (LANE_WEIGHTS[lane] ?? 1) / (RRF_K + rank);
    const touched = Date.parse(row.updated_at ?? row.created_at);
    return { row, lanes: [...lanes.keys()].sort(), score, touched: Number.isFinite(touched) ? touched : 0 };
  });
  scored.sort((a, b) => b.score - a.score || b.touched - a.touched || (a.row.id < b.row.id ? -1 : 1));

  return scored.slice(0, limit).map(({ row, lanes, score }) => {
    let exemplars = storedExemplars(row, exemplarLimit);
    if (exemplars.length < exemplarLimit) {
      for (const ex of episodeExemplars(row.id, exemplarLimit)) {
        if (exemplars.length >= exemplarLimit) break;
        if (!exemplars.includes(ex)) exemplars = [...exemplars, ex];
      }
    }
    return {
      id: row.id,
      label: row.label,
      lifeArea: row.life_area,
      goal: row.goal,
      status: row.status,
      exemplars,
      lanes,
      score,
    };
  });
}
