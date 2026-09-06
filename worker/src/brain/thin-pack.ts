// ===========================================================================
// Thin context packing for the Lane-B passes (build P1.4/P1.5).
//
// The REAL packer (build P1.2, worker/src/packer/) is Lane A's; these are the
// thin, DB-direct blocks the Extract/Decide/consolidation runners need TODAY,
// written against the same world-model tables so the Gates-phase integration
// swaps the string source, not the pass code. Deliberately code-only: no model
// calls, no retrieval judging — just honest, time-ordered evidence.
// ===========================================================================

import { getDb } from "../db/connection.js";

export interface PackedEpisode {
  episodeId: string;
  streamId: string | null;
  spaceId: string | null;
  summary: string | null;
  text: string;
  eventIds: string[];
}

interface EpisodeRow {
  id: string;
  stream_id: string | null;
  space_id: string | null;
  summary: string | null;
  first_ts: string | null;
  last_ts: string | null;
}

interface EventRow {
  id: string;
  ts: string | null;
  actor: string | null;
  text: string | null;
  roles_json: string | null;
}

function senderOf(e: EventRow): string {
  if (e.actor !== null && e.actor !== "") return e.actor;
  if (e.roles_json !== null) {
    try {
      const roles = JSON.parse(e.roles_json) as { sender?: unknown };
      if (typeof roles.sender === "string" && roles.sender !== "") return roles.sender;
    } catch {
      /* roles stay unknown */
    }
  }
  return "unknown";
}

/** Member events of one episode, via its stored ranges, time-ordered. */
export function episodeEvents(episodeId: string, streamId: string | null): EventRow[] {
  const db = getDb();
  const ranges = db
    .prepare(
      `SELECT start_event_id, end_event_id, start_rowid, end_rowid
         FROM episode_events WHERE episode_id = ? ORDER BY start_rowid, created_at`,
    )
    .all(episodeId) as {
    start_event_id: string;
    end_event_id: string;
    start_rowid: number | null;
    end_rowid: number | null;
  }[];
  const seen = new Set<string>();
  const out: EventRow[] = [];
  for (const r of ranges) {
    let rows: EventRow[];
    if (r.start_rowid !== null && r.end_rowid !== null) {
      // A range spans in-stream insertion order; other streams' events that
      // happen to share the rowid window are NOT members.
      rows = db
        .prepare(
          `SELECT id, ts, actor, text, roles_json FROM events
            WHERE rowid BETWEEN ? AND ? ${streamId !== null ? "AND stream_id = ?" : ""}
            ORDER BY rowid`,
        )
        .all(...(streamId !== null ? [r.start_rowid, r.end_rowid, streamId] : [r.start_rowid, r.end_rowid])) as EventRow[];
    } else {
      rows = db
        .prepare(`SELECT id, ts, actor, text, roles_json FROM events WHERE id IN (?, ?) ORDER BY rowid`)
        .all(r.start_event_id, r.end_event_id) as EventRow[];
    }
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/** One episode as an evidence block: header + its member events, verbatim. */
export function packEpisode(episodeId: string): PackedEpisode | null {
  const db = getDb();
  const ep = db
    .prepare(`SELECT id, stream_id, space_id, summary, first_ts, last_ts FROM episodes WHERE id = ?`)
    .get(episodeId) as EpisodeRow | undefined;
  if (!ep) return null;
  const events = episodeEvents(ep.id, ep.stream_id);
  const lines: string[] = [
    `EPISODE ${ep.id}` +
      (ep.stream_id !== null ? ` stream=${ep.stream_id}` : "") +
      (ep.summary !== null ? ` — ${ep.summary}` : ""),
  ];
  for (const e of events) {
    lines.push(`[${e.id}] ${e.ts ?? "?"} ${senderOf(e)}: ${e.text ?? "(no text)"}`);
  }
  return {
    episodeId: ep.id,
    streamId: ep.stream_id,
    spaceId: ep.space_id,
    summary: ep.summary,
    text: lines.join("\n"),
    eventIds: events.map((e) => e.id),
  };
}

/** Several episodes, time-ordered by their first event, as one block. */
export function packEpisodes(episodeIds: readonly string[]): PackedEpisode[] {
  const packed = episodeIds
    .map((id) => packEpisode(id))
    .filter((p): p is PackedEpisode => p !== null);
  return packed;
}

export interface SpaceCard {
  id: string;
  label: string;
  goal: string | null;
  lifeArea: string | null;
  status: string;
  planJson: string | null;
  text: string;
}

/** The space's current state: card, chapters, open tasks, plan. */
export function packSpaceState(spaceId: string): SpaceCard | null {
  const db = getDb();
  const sp = db
    .prepare(`SELECT id, label, goal, life_area, status, plan_json, summary, latest FROM spaces WHERE id = ?`)
    .get(spaceId) as
    | {
        id: string;
        label: string;
        goal: string | null;
        life_area: string | null;
        status: string;
        plan_json: string | null;
        summary: string | null;
        latest: string | null;
      }
    | undefined;
  if (!sp) return null;
  const chapters = db
    .prepare(
      `SELECT id, label, status, target_date FROM chapters WHERE space_id = ? ORDER BY created_at`,
    )
    .all(spaceId) as { id: string; label: string; status: string; target_date: string | null }[];
  const tasks = db
    .prepare(
      `SELECT id, title, type, status, due FROM tasks
        WHERE space_id = ? AND status NOT IN ('done','cancelled','dismissed')
        ORDER BY created_at`,
    )
    .all(spaceId) as { id: string; title: string; type: string; status: string; due: string | null }[];
  const lines: string[] = [
    `SPACE ${sp.id} "${sp.label}"` +
      (sp.life_area !== null ? ` area=${sp.life_area}` : "") +
      ` status=${sp.status}` +
      (sp.goal !== null ? `\ngoal: ${sp.goal}` : ""),
  ];
  if (sp.summary !== null) lines.push(`summary: ${sp.summary}`);
  if (sp.latest !== null) lines.push(`latest: ${sp.latest}`);
  if (chapters.length > 0) {
    lines.push("milestones (chapters):");
    for (const c of chapters) {
      lines.push(
        `  ${c.id} "${c.label}" status=${c.status}` + (c.target_date !== null ? ` target=${c.target_date}` : ""),
      );
    }
  }
  if (tasks.length > 0) {
    lines.push("open tasks:");
    for (const t of tasks) {
      lines.push(`  ${t.id} "${t.title}" type=${t.type} status=${t.status}` + (t.due !== null ? ` due=${t.due}` : ""));
    }
  }
  if (sp.plan_json !== null) lines.push(`plan: ${sp.plan_json}`);
  return {
    id: sp.id,
    label: sp.label,
    goal: sp.goal,
    lifeArea: sp.life_area,
    status: sp.status,
    planJson: sp.plan_json,
    text: lines.join("\n"),
  };
}
