// ===========================================================================
// [CODE] Deep graph snapshot and comparison — build item 4.3.
//
// The acceptance is "identical final graph", and this file is where IDENTICAL
// is defined. Everything content-bearing is read back and compared by
// CONTENT-DERIVED keys:
//
//   entities   — the identity set (kind:value_norm…) or type+canonical,
//                because entity ids are MINTED (deliberately random, see
//                registry.ts) and two confluent runs mint in different orders;
//   claims     — (kind, subject key, predicate, text, stated_at, window),
//                because a reinforced version's row id derives from whichever
//                statement arrived first;
//   loops      — (owner key, counterparty key, intent) — the §11.6 loop key
//                re-expressed over content keys;
//   arcs       — (sorted anchor keys, label) for the same reason;
//   edges      — (kind, subtype, src key, dst key, status);
//   sessions / episodes / events — their own ids, which ARE content-derived
//                (`sessionIdOf`, `episodeIdFor`, `"<source>:"+external_id`).
//
// What is deliberately EXCLUDED: minted row ids, verdict ids (known-accepted
// nondeterminism), `ingested_at` (audit only — a column the comparison must
// not even read, per build rule 8), `created_at`/`updated_at` wall-clock
// stamps, and the `mutations` audit log (it records arrival order by design).
//
// A divergence is never a boolean: `compareSnapshots` names the table, the
// rows only one side has, and both serialised forms — the FAIL comes with its
// diff.
// ===========================================================================

import { getDb } from "../db/connection.js";

export interface GraphSnapshot {
  /** table → sorted canonical row strings. */
  tables: Record<string, string[]>;
}

export interface TableDiff {
  table: string;
  onlyInA: string[];
  onlyInB: string[];
}

export interface SnapshotComparison {
  identical: boolean;
  diffs: TableDiff[];
  /** table → row count, so coverage is REPORTED, not implied. */
  coverage: Record<string, number>;
}

type Row = Record<string, unknown>;

function all(sql: string, ...params: unknown[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}

// ---------------------------------------------------------------------------
// Entity content keys
// ---------------------------------------------------------------------------

/**
 * id → content key for every entity, aliases folded onto their merge target.
 * The key is the sorted identity set; an identity-less entity (a minted anchor
 * like a place) falls back to type+canonical.
 */
export function entityKeyMap(): Map<string, string> {
  const entities = all(`SELECT id, type, canonical, merged_into FROM entities`);
  const identities = all(`SELECT entity_id, kind, value_norm FROM entity_identities`);

  const resolve = new Map<string, string>();
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const target = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const row = byId.get(cur);
      const next = row?.merged_into;
      if (typeof next !== "string" || next === "") break;
      cur = next;
    }
    return cur;
  };

  const identitySets = new Map<string, string[]>();
  for (const row of identities) {
    const owner = target(String(row.entity_id));
    const list = identitySets.get(owner) ?? [];
    list.push(`${String(row.kind)}:${String(row.value_norm)}`);
    identitySets.set(owner, list);
  }

  for (const e of entities) {
    const id = String(e.id);
    const owner = target(id);
    const set = identitySets.get(owner);
    const key =
      set !== undefined && set.length > 0
        ? `id{${[...new Set(set)].sort().join(",")}}`
        : `canon{${String(byId.get(owner)?.type ?? "")}|${String(byId.get(owner)?.canonical ?? "").toLowerCase()}}`;
    resolve.set(id, key);
  }
  return resolve;
}

function keyOf(map: Map<string, string>, id: unknown): string | null {
  if (typeof id !== "string" || id === "") return null;
  return map.get(id) ?? `unknown{${id}}`;
}

function translateIdArray(map: Map<string, string>, raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => keyOf(map, v) ?? String(v)).sort();
  } catch {
    return [];
  }
}

/**
 * Rows are BUILT with a fixed literal key order above, so plain stringify is
 * canonical. (A key-sorting replacer array would also FILTER nested objects'
 * keys, which silently empties them — measured the hard way.)
 */
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export function takeSnapshot(): GraphSnapshot {
  const ek = entityKeyMap();
  const tables: Record<string, string[]> = {};
  const put = (table: string, rows: object[]): void => {
    tables[table] = rows.map((r) => canonical(r)).sort();
  };

  // -- events (ids are `<source>:<external_id>`, content-derived) -----------
  put(
    "events",
    all(`SELECT id, stream_id, ts, kind, text, external_id FROM events`).map((r) => ({
      id: r.id,
      stream_id: r.stream_id,
      ts: r.ts,
      kind: r.kind,
      text: r.text,
      external_id: r.external_id,
    })),
  );

  // -- entities --------------------------------------------------------------
  put(
    "entities",
    all(`SELECT id, type, subtype, canonical, provisional FROM entities WHERE merged_into IS NULL`).map((r) => ({
      key: keyOf(ek, r.id),
      type: r.type,
      subtype: r.subtype,
      canonical: r.canonical,
      provisional: r.provisional,
    })),
  );

  // -- edges -----------------------------------------------------------------
  put(
    "entity_edges",
    all(`SELECT kind, subtype, src_entity_id, dst_entity_id, status, decided_by FROM entity_edges`).map((r) => ({
      kind: r.kind,
      subtype: r.subtype,
      src: keyOf(ek, r.src_entity_id),
      dst: keyOf(ek, r.dst_entity_id),
      status: r.status,
      decided_by: r.decided_by,
    })),
  );

  // -- sessions (ids from sessionIdOf — content-derived) ---------------------
  put(
    "sessions",
    all(
      `SELECT id, stream_id, started_at, ended_at, event_ids, participant_entity_ids,
              boundary_reason_start, boundary_reason_end, seal_mode, content_hash, status
         FROM sessions`,
    ).map((r) => ({
      id: r.id,
      stream_id: r.stream_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      event_ids: r.event_ids,
      participants: translateIdArray(ek, r.participant_entity_ids),
      boundary_reason_start: r.boundary_reason_start,
      boundary_reason_end: r.boundary_reason_end,
      seal_mode: r.seal_mode,
      content_hash: r.content_hash,
      status: r.status,
    })),
  );

  // -- episodes (ids from episodeIdFor — content-derived) --------------------
  put(
    "episodes",
    all(`SELECT id, stream_id, topic_label, label_source, session_ids, event_ids, started_at, ended_at FROM episodes`).map(
      (r) => ({
        id: r.id,
        stream_id: r.stream_id,
        topic_label: r.topic_label,
        label_source: r.label_source,
        session_ids: r.session_ids,
        event_ids: r.event_ids,
        started_at: r.started_at,
        ended_at: r.ended_at,
      }),
    ),
  );
  put(
    "episode_sessions",
    all(`SELECT episode_id, session_id, added_by FROM episode_sessions`).map((r) => ({
      episode_id: r.episode_id,
      session_id: r.session_id,
      added_by: r.added_by,
    })),
  );

  // -- episode verdict SHAPE (ids and stamps excluded — known-accepted) ------
  // `decision` is excluded too, and deliberately: it records WHICH path
  // answered (`one_to_one` when a stream had no open episodes yet vs
  // `one_to_one_fallback` when it did), and whether a stream already had an
  // open episode at pass time is a fact ABOUT processing order, like the
  // verdict id. The partition the pass produced — which events landed in
  // which episode — is the graph, and it is compared in full.
  put(
    "episode_verdict_shapes",
    all(`SELECT session_id, output_json FROM episode_verdicts`).map((r) => {
      let segments: unknown = null;
      try {
        const output = JSON.parse(String(r.output_json ?? "null")) as { segments?: { eventIds?: string[]; episodeId?: string }[] };
        segments = (output?.segments ?? []).map((s) => ({ episodeId: s.episodeId ?? null, eventIds: [...(s.eventIds ?? [])].sort() }));
      } catch {
        segments = "unparseable";
      }
      return { session_id: r.session_id, segments };
    }),
  );

  // -- claim versions, keyed by content --------------------------------------
  const versions = all(
    `SELECT id, kind, subject_id, predicate, text, confidence, stated_at,
            valid_from, valid_to, closed_by, closed_reason
       FROM claim_versions`,
  );
  const versionContent = new Map(
    versions.map((v) => [String(v.id), `${String(v.kind)}|${keyOf(ek, v.subject_id)}|${String(v.text)}|${String(v.stated_at)}`]),
  );
  put(
    "claim_versions",
    versions.map((v) => ({
      kind: v.kind,
      subject: keyOf(ek, v.subject_id),
      predicate: v.predicate,
      text: v.text,
      confidence: v.confidence,
      stated_at: v.stated_at,
      valid_from: v.valid_from,
      valid_to: v.valid_to,
      closed_by: v.closed_by === null ? null : (versionContent.get(String(v.closed_by)) ?? `unknown{${String(v.closed_by)}}`),
      closed_reason: v.closed_reason,
    })),
  );

  // -- the ACTIVE set — the claims_active VIEW itself, never re-derived ------
  put(
    "claims_active",
    all(`SELECT kind, subject_id, predicate, text, confidence, stated_at FROM claims_active`).map((r) => ({
      kind: r.kind,
      subject: keyOf(ek, r.subject_id),
      predicate: r.predicate,
      text: r.text,
      confidence: r.confidence,
      stated_at: r.stated_at,
    })),
  );

  // -- claim evidence --------------------------------------------------------
  put(
    "evidence",
    all(`SELECT subject_kind, subject_id, event_id, quote FROM evidence`).map((r) => ({
      subject_kind: r.subject_kind,
      subject: versionContent.get(String(r.subject_id)) ?? `unknown{${String(r.subject_id)}}`,
      event_id: r.event_id,
      quote: r.quote,
    })),
  );

  // -- arcs, keyed by anchors+label ------------------------------------------
  const arcs = all(
    `SELECT id, label, label_source, anchor_entity_ids, state, promoted, promotion_reason,
            status, cadence, archetype, started_at, last_evidence_at
       FROM arcs`,
  );
  const arcContent = new Map(
    arcs.map((a) => [String(a.id), `arc{${translateIdArray(ek, a.anchor_entity_ids).join(",")}|${String(a.label ?? "").toLowerCase()}}`]),
  );
  const arcEpisodes = all(`SELECT arc_id, episode_id, added_by FROM arc_episodes`);
  put(
    "arcs",
    arcs.map((a) => ({
      key: arcContent.get(String(a.id)),
      label: a.label,
      label_source: a.label_source,
      anchors: translateIdArray(ek, a.anchor_entity_ids),
      state: a.state,
      promoted: a.promoted,
      promotion_reason: a.promotion_reason,
      status: a.status,
      cadence: a.cadence,
      archetype: a.archetype,
      started_at: a.started_at,
      last_evidence_at: a.last_evidence_at,
      episodes: arcEpisodes
        .filter((m) => m.arc_id === a.id)
        .map((m) => `${String(m.episode_id)}·${String(m.added_by)}`)
        .sort(),
    })),
  );

  // -- loops, keyed by (owner, counterparty, intent) over content keys -------
  put(
    "loops",
    all(
      `SELECT owner_id, counterparty_id, intent, origin, direction, party_pair, due_utc,
              recurrence, next_occurrence_utc, state, state_reason,
              resolution_evidence_event_id, stated_at, arc_id
         FROM loops`,
    ).map((r) => ({
      owner: keyOf(ek, r.owner_id),
      counterparty: keyOf(ek, r.counterparty_id),
      intent: r.intent,
      origin: r.origin,
      direction: r.direction,
      party_pair: r.party_pair,
      due_utc: r.due_utc,
      recurrence: r.recurrence,
      next_occurrence_utc: r.next_occurrence_utc,
      state: r.state,
      state_reason: r.state_reason,
      resolution_evidence_event_id: r.resolution_evidence_event_id,
      stated_at: r.stated_at,
      arc: r.arc_id === null ? null : (arcContent.get(String(r.arc_id)) ?? `unknown{${String(r.arc_id)}}`),
    })),
  );

  return { tables };
}

// ---------------------------------------------------------------------------
// Comparison — a FAIL always carries its diff
// ---------------------------------------------------------------------------

export function compareSnapshots(a: GraphSnapshot, b: GraphSnapshot): SnapshotComparison {
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  const diffs: TableDiff[] = [];
  const coverage: Record<string, number> = {};
  for (const table of names) {
    const rowsA = a.tables[table] ?? [];
    const rowsB = b.tables[table] ?? [];
    coverage[table] = Math.max(rowsA.length, rowsB.length);
    const setA = new Set(rowsA);
    const setB = new Set(rowsB);
    const onlyInA = rowsA.filter((r) => !setB.has(r));
    const onlyInB = rowsB.filter((r) => !setA.has(r));
    if (onlyInA.length > 0 || onlyInB.length > 0) diffs.push({ table, onlyInA, onlyInB });
  }
  return { identical: diffs.length === 0, diffs, coverage };
}

/** A human-readable diff — what the failing assertion prints. */
export function formatDiff(comparison: SnapshotComparison, labelA: string, labelB: string): string {
  if (comparison.identical) return "";
  const lines: string[] = [`graphs diverged between ${labelA} and ${labelB}:`];
  for (const d of comparison.diffs) {
    lines.push(`  table ${d.table}:`);
    for (const row of d.onlyInA) lines.push(`    only in ${labelA}: ${row}`);
    for (const row of d.onlyInB) lines.push(`    only in ${labelB}: ${row}`);
  }
  return lines.join("\n");
}
