// ===========================================================================
// Spaces — list and view reads (V6 P1 S5.1; Product_V6 §11.11).
//
//   spacesList()   grouped by life area (spec order, "Other" last), dormant
//                  collapsed into their own bucket. Row: label, area, summary
//                  line, next action, task count, freshness, people chips.
//   spaceView(id)  goal · summary · latest · plan · milestone rail (chapters
//                  with a target date, only if any) · tasks · follow-ups ·
//                  episodes as the evidence timeline · enrichment · people ·
//                  birth (how it was born and the utterance/messages that
//                  justified it — SPC-05's "why?" reads `birth.thread_id`).
//
// Every element carries the (kind, id) pair the why-panel needs to fetch its
// decisions; the UI opens one panel per element, not one per modal.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { enrichmentsFor, type EnrichmentRow } from "./enrichment.js";
import { lifeAreaRank, normalizeLifeArea } from "./life-areas.js";
import type { BirthEvidence, BirthMode } from "./birth.js";

export interface SpaceRowFull {
  id: string;
  label: string;
  life_area: string | null;
  goal: string | null;
  status: string;
  horizon: string | null;
  permanence: string | null;
  cadence: string | null;
  exemplars_json: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string | null;
  summary: string | null;
  latest: string | null;
  latest_ts: string | null;
  plan_json: string | null;
  born_via: BirthMode | null;
  birth_evidence_json: string | null;
  bar_thread_id: string | null;
  dormant_at: string | null;
  woken_at: string | null;
}

export interface SpaceListRow extends SpaceRowFull {
  area: string;
  task_count: number;
  next_action: string | null;
  freshness: string | null;
  people: string[];
}

export interface SpaceListArea {
  area: string;
  spaces: SpaceListRow[];
}

export interface SpacesList {
  areas: SpaceListArea[];
  /** Dormant spaces, collapsed by default in the UI. */
  dormant: SpaceListRow[];
  /**
   * FIX-C7. How many inferred spaces are sitting in the REVIEW QUEUE
   * (`status='proposed'`). They are deliberately absent from `areas` and
   * `dormant` — propose-only birth (Product_V6_Phase1 §13.3) exists to
   * require the approval, and widening the list filter would bypass it — but
   * the screen must not answer "no spaces yet" while five proposals wait.
   * The count is what lets the empty state point at Review instead of lying.
   */
  proposed_count: number;
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const OPEN = `('open','scheduled','executing','needs_input','needs_approval')`;

function peopleFor(spaceId: string, limit = 3): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT e.actor AS actor
         FROM episodes ep
         JOIN episode_events ee ON ee.episode_id = ep.id
              AND ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
         JOIN events e ON e.rowid BETWEEN ee.start_rowid AND ee.end_rowid
        WHERE ep.space_id = ? AND e.actor IS NOT NULL AND e.actor != 'self'
        LIMIT ?`,
    )
    .all(spaceId, limit) as { actor: string }[];
  return rows.map((r) => r.actor.replace(/^contact:/, ""));
}

function decorate(row: SpaceRowFull): SpaceListRow {
  const db = getDb();
  const taskCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status IN ${OPEN}`).get(row.id) as { n: number }
  ).n;
  const next = db
    .prepare(
      `SELECT title FROM tasks WHERE space_id = ? AND status IN ${OPEN}
        ORDER BY (due IS NULL), due, created_at LIMIT 1`,
    )
    .get(row.id) as { title: string } | undefined;
  const fresh = db
    .prepare(`SELECT MAX(last_ts) AS ts FROM episodes WHERE space_id = ?`)
    .get(row.id) as { ts: string | null };
  return {
    ...row,
    area: normalizeLifeArea(row.life_area),
    task_count: taskCount,
    next_action: next?.title ?? null,
    freshness: fresh.ts ?? row.latest_ts ?? row.updated_at ?? row.created_at,
    people: peopleFor(row.id),
  };
}

/**
 * The list, grouped by life area; dormant spaces in their own bucket.
 *
 * `proposed` spaces stay OUT of both buckets on purpose: in propose-only mode
 * (the fresh-install default) an inferred space is a question, not a space,
 * and the Review queue is its only promotion path. What this read adds is the
 * COUNT of them, so the screen can say how many are waiting (FIX-C7).
 */
export function spacesList(): SpacesList {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM spaces WHERE status IN ('active','dormant')
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all() as SpaceRowFull[];
  const proposedCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'proposed'`).get() as { n: number }
  ).n;
  const byArea = new Map<string, SpaceListRow[]>();
  const dormant: SpaceListRow[] = [];
  for (const r of rows) {
    const d = decorate(r);
    if (r.status === "dormant") {
      dormant.push(d);
      continue;
    }
    const list = byArea.get(d.area) ?? [];
    list.push(d);
    byArea.set(d.area, list);
  }
  const areas = [...byArea.entries()]
    .sort((a, b) => lifeAreaRank(a[0]) - lifeAreaRank(b[0]))
    .map(([area, spaces]) => ({ area, spaces }));
  return { areas, dormant, proposed_count: proposedCount };
}

export interface ViewTask {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string | null;
  due: string | null;
  chapter_id: string | null;
  evidence_json: string | null;
  confidence: number | null;
}

export interface ViewChapter {
  id: string;
  label: string;
  status: string;
  target_date: string | null;
  summary: string | null;
}

export interface ViewEpisode {
  id: string;
  summary: string | null;
  state: string;
  first_ts: string | null;
  last_ts: string | null;
  chapter_id: string | null;
  stream_id: string | null;
  /** Up to three member events as the evidence quotes. */
  quotes: { event_id: string; ts: string | null; actor: string | null; text: string | null }[];
}

export interface ViewFollowUp {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  task_id: string | null;
}

export interface SpaceView {
  space: SpaceRowFull;
  area: string;
  plan: unknown;
  /** Chapters with a target date — the milestone rail; [] when the goal has no stages. */
  milestones: ViewChapter[];
  chapters: ViewChapter[];
  tasks: ViewTask[];
  follow_ups: ViewFollowUp[];
  episodes: ViewEpisode[];
  enrichments: EnrichmentRow[];
  people: string[];
  birth: {
    via: BirthMode | null;
    evidence: BirthEvidence[];
    thread_id: string | null;
    woken_at: string | null;
  };
}

export function spaceView(spaceId: string): SpaceView | null {
  const db = getDb();
  const space = db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(spaceId) as SpaceRowFull | undefined;
  if (!space) return null;
  const chapters = db
    .prepare(
      `SELECT id, label, status, target_date, summary FROM chapters WHERE space_id = ?
        ORDER BY (target_date IS NULL), target_date, created_at`,
    )
    .all(spaceId) as ViewChapter[];
  const tasks = db
    .prepare(
      `SELECT id, title, type, status, owner, due, chapter_id, evidence_json, confidence
         FROM tasks WHERE space_id = ?
        ORDER BY (status IN ${OPEN}) DESC, (due IS NULL), due, created_at`,
    )
    .all(spaceId) as ViewTask[];
  const followUps = (
    db
      .prepare(
        `SELECT id, kind, payload_json, status, task_id FROM deferred_outputs
          WHERE space_id = ? AND status = 'deferred' ORDER BY created_at`,
      )
      .all(spaceId) as { id: string; kind: string; payload_json: string; status: string; task_id: string | null }[]
  ).map((r) => ({ id: r.id, kind: r.kind, payload: parseJson<unknown>(r.payload_json, null), status: r.status, task_id: r.task_id }));
  const episodes = (
    db
      .prepare(
        `SELECT id, summary, state, first_ts, last_ts, chapter_id, stream_id FROM episodes
          WHERE space_id = ? ORDER BY last_ts DESC, created_at DESC LIMIT 60`,
      )
      .all(spaceId) as Omit<ViewEpisode, "quotes">[]
  ).map((ep) => ({
    ...ep,
    quotes: db
      .prepare(
        `SELECT e.id AS event_id, e.ts, e.actor, e.text
           FROM episode_events ee
           JOIN events e ON ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
                AND e.rowid BETWEEN ee.start_rowid AND ee.end_rowid
          WHERE ee.episode_id = ? ORDER BY e.rowid LIMIT 3`,
      )
      .all(ep.id) as ViewEpisode["quotes"],
  }));
  return {
    space,
    area: normalizeLifeArea(space.life_area),
    plan: parseJson<unknown>(space.plan_json, null),
    milestones: chapters.filter((c) => c.target_date !== null),
    chapters,
    tasks,
    follow_ups: followUps,
    episodes,
    enrichments: enrichmentsFor(spaceId),
    people: peopleFor(spaceId, 8),
    birth: {
      via: space.born_via,
      evidence: parseJson<BirthEvidence[]>(space.birth_evidence_json, []),
      thread_id: space.bar_thread_id,
      woken_at: space.woken_at,
    },
  };
}
