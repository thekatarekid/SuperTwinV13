// ===========================================================================
// Candidate-space retrieval — the four lanes (build P1.2, spec §6.4.4).
//
//   FTS        salient bundle tokens against spaces_fts (label/goal/exemplars)
//   embedding  bundle text against space_embeddings — retrieve-then-judge:
//              this lane only NOMINATES candidates (top-K by cosine), the
//              judgment is Orient's, never a bare cosine threshold. The
//              embedder is the model-agnostic retrieval interface (e5 today,
//              EmbeddingGemma at P4.3 — same code path).
//   entities   event participants/mentions against space_entities
//   bridges    event_bridge_keys (url/phone/email/order-id) against
//              space_bridge_keys — exact match, the strongest signal
//
// plus a RECENCY BOOST (spaces touched recently score higher), merged into
// one ranked list of the top 3–5 with exemplar episode summaries.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { BundleEvent } from "../scheduler/dispatch.js";
import { getEmbedder, semanticEnabled } from "../retrieval/embedder.js";
import { cosine } from "../retrieval/semantic.js";
import { STOPWORDS } from "../retrieval/query.js";

export interface CandidateSpace {
  id: string;
  label: string;
  lifeArea: string | null;
  goal: string | null;
  status: string;
  exemplars: string[];
  /** Which lanes nominated it. */
  lanes: string[];
  score: number;
}

export interface CandidateOptions {
  /** Top-K returned (spec: 3–5). */
  limit?: number;
  /** Half-life of the recency boost, hours. */
  recencyHalfLifeHours?: number;
  nowMs?: number;
}

const DEFAULT_LIMIT = 5;
const LANE_WEIGHTS: Record<string, number> = {
  bridge: 2.0,
  fts: 1.0,
  entity: 1.0,
  embedding: 0.8,
};
const RECENCY_WEIGHT = 0.5;

/** Salient tokens of the bundle text: stopwords out, short tokens out. */
export function salientTokens(events: Pick<BundleEvent, "text">[], cap = 24): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    for (const raw of (e.text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3 || STOPWORDS.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
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

function exemplarsOf(row: SpaceRow): string[] {
  try {
    const parsed = JSON.parse(row.exemplars_json ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string").slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

/**
 * The four lanes + recency, merged. Only non-archived/rejected spaces compete;
 * proposed spaces DO compete (matching an existing proposal beats proposing a
 * duplicate).
 */
export async function candidateSpaces(
  events: BundleEvent[],
  opts: CandidateOptions = {},
): Promise<CandidateSpace[]> {
  const db = getDb();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const nowMs = opts.nowMs ?? Date.now();
  const halfLifeMs = (opts.recencyHalfLifeHours ?? 72) * 3_600_000;

  // spaceId -> {lanes, laneScore}
  const nominated = new Map<string, { lanes: Set<string>; score: number }>();
  const nominate = (spaceId: string, lane: string, strength = 1): void => {
    const cur = nominated.get(spaceId) ?? { lanes: new Set<string>(), score: 0 };
    if (!cur.lanes.has(lane)) {
      cur.lanes.add(lane);
      cur.score += (LANE_WEIGHTS[lane] ?? 1) * strength;
    }
    nominated.set(spaceId, cur);
  };

  // ---- Lane 1: FTS ---------------------------------------------------------
  const tokens = salientTokens(events);
  if (tokens.length > 0) {
    const match = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    try {
      const rows = db
        .prepare(
          `SELECT space_id, rank FROM spaces_fts WHERE spaces_fts MATCH ?
            ORDER BY rank LIMIT 10`,
        )
        .all(match) as { space_id: string; rank: number }[];
      for (const r of rows) nominate(r.space_id, "fts");
    } catch {
      // A hostile MATCH string is a no-op lane, never a failed pack.
    }
  }

  // ---- Lane 2: embeddings (retrieve-then-judge — nomination only) ----------
  if (semanticEnabled()) {
    try {
      const embedder = await getEmbedder();
      if (embedder) {
        const text = events
          .map((e) => e.text ?? "")
          .filter((t) => t.length > 0)
          .join("\n")
          .slice(0, 2000);
        if (text.length > 0) {
          const [vec] = await embedder.embed([text], "query");
          const rows = db
            .prepare(`SELECT space_id, vec, dim FROM space_embeddings`)
            .all() as { space_id: string; vec: Buffer; dim: number }[];
          const scored = rows
            .map((r) => {
              const arr = new Float32Array(
                r.vec.buffer,
                r.vec.byteOffset,
                r.vec.byteLength / 4,
              );
              return { id: r.space_id, sim: cosine(vec, arr) };
            })
            .sort((a, b) => b.sim - a.sim)
            .slice(0, 5);
          for (const s of scored) nominate(s.id, "embedding", Math.max(0, s.sim));
        }
      }
    } catch {
      // Embedding lane down = three lanes, never a failed pack.
    }
  }

  // ---- Lane 3: entity overlap ---------------------------------------------
  const participants = new Set<string>();
  for (const e of events) {
    try {
      const roles = JSON.parse(e.rolesJson ?? "{}") as {
        sender?: string;
        audience?: string[];
        mentions?: string[];
      };
      if (roles.sender) participants.add(roles.sender);
      for (const a of roles.audience ?? []) participants.add(a);
      for (const m of roles.mentions ?? []) participants.add(m);
    } catch {
      /* skip */
    }
  }
  if (participants.size > 0) {
    const refs = [...participants];
    const placeholders = refs.map(() => "?").join(",");
    // Participant refs are entity ids when resolved; also try identity values.
    const rows = db
      .prepare(
        `SELECT se.space_id, COUNT(*) AS overlap
           FROM space_entities se
          WHERE se.entity_id IN (${placeholders})
             OR se.entity_id IN (
                  SELECT entity_id FROM entity_identities
                   WHERE value_norm IN (${placeholders}))
          GROUP BY se.space_id ORDER BY overlap DESC LIMIT 10`,
      )
      .all(...refs, ...refs) as { space_id: string; overlap: number }[];
    for (const r of rows) nominate(r.space_id, "entity", Math.min(2, r.overlap) / 2);
  }

  // ---- Lane 4: bridge exact-match ------------------------------------------
  const eventIds = events.map((e) => e.id);
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT sbk.space_id
           FROM event_bridge_keys ebk
           JOIN space_bridge_keys sbk
             ON sbk.kind = ebk.kind AND sbk.value_norm = ebk.value_norm
          WHERE ebk.event_id IN (${placeholders})`,
      )
      .all(...eventIds) as { space_id: string }[];
    for (const r of rows) nominate(r.space_id, "bridge");
  }

  if (nominated.size === 0) return [];

  // ---- Hydrate + recency boost + rank --------------------------------------
  const ids = [...nominated.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, label, life_area, goal, status, exemplars_json, updated_at, created_at
         FROM spaces
        WHERE id IN (${placeholders})
          AND status NOT IN ('archived', 'rejected')`,
    )
    .all(...ids) as SpaceRow[];

  const out: CandidateSpace[] = rows.map((row) => {
    const nom = nominated.get(row.id)!;
    const touched = Date.parse(row.updated_at ?? row.created_at);
    const age = Number.isFinite(touched) ? Math.max(0, nowMs - touched) : Infinity;
    const recency = Number.isFinite(age) ? Math.pow(0.5, age / halfLifeMs) : 0;
    return {
      id: row.id,
      label: row.label,
      lifeArea: row.life_area,
      goal: row.goal,
      status: row.status,
      exemplars: exemplarsOf(row),
      lanes: [...nom.lanes].sort(),
      score: nom.score + RECENCY_WEIGHT * recency,
    };
  });
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}

/**
 * Recent-context spaces (spec §6.4.5): active in the last few hours, offered
 * as WEAK candidates even with no content match — a hint the model may weigh,
 * never a join rule.
 */
export function recentContextSpaces(
  opts: { hours?: number; limit?: number; nowMs?: number; excludeIds?: readonly string[] } = {},
): { id: string; label: string; lastActive: string }[] {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - (opts.hours ?? 6) * 3_600_000).toISOString();
  const exclude = new Set(opts.excludeIds ?? []);
  const rows = getDb()
    .prepare(
      `SELECT id, label, updated_at FROM spaces
        WHERE status IN ('active', 'proposed') AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(cutoff, (opts.limit ?? 3) + exclude.size) as {
    id: string;
    label: string;
    updated_at: string;
  }[];
  return rows
    .filter((r) => !exclude.has(r.id))
    .slice(0, opts.limit ?? 3)
    .map((r) => ({ id: r.id, label: r.label, lastActive: r.updated_at }));
}
