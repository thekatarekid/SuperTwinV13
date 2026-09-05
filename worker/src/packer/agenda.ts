// ===========================================================================
// [OPEN TASKS] and [CALENDAR] (V6 P1 S3.2; Product P1 §7.2 "open tasks,
// calendar for the next days").
//
// Both blocks are bounded and scoped, never an enumeration:
//   open tasks  live tasks of the pack's spaces (the candidates + the spaces
//               of the streams' episodes) and unfiled tasks owned by the
//               roster, capped
//   calendar    what fires or falls due in the next days across the world
//               model — task due dates, scheduled fire_at, chapter target
//               dates (milestones) — capped, nearest first
// ===========================================================================

import { getDb } from "../db/connection.js";

export interface OpenTask {
  id: string;
  title: string;
  type: string;
  status: string;
  due: string | null;
  spaceId: string | null;
  spaceLabel: string | null;
  owner: string | null;
}

export const OPEN_TASKS_MAX = 12;
export const OPEN_TASK_STATUSES = ["open", "scheduled", "executing", "needs_input", "needs_approval"] as const;

/** Live tasks scoped to `spaceIds`, plus unfiled tasks owned by `ownerRefs`. */
export function openTasks(
  input: { spaceIds: readonly string[]; ownerRefs?: readonly string[] },
  opts: { limit?: number } = {},
): OpenTask[] {
  const limit = opts.limit ?? OPEN_TASKS_MAX;
  const spaceIds = [...new Set(input.spaceIds)];
  const owners = [...new Set((input.ownerRefs ?? []).filter((o) => o !== ""))];
  if (spaceIds.length === 0 && owners.length === 0) return [];
  const statuses = OPEN_TASK_STATUSES.map(() => "?").join(",");
  const clauses: string[] = [];
  const params: unknown[] = [...OPEN_TASK_STATUSES];
  if (spaceIds.length > 0) {
    clauses.push(`t.space_id IN (${spaceIds.map(() => "?").join(",")})`);
    params.push(...spaceIds);
  }
  if (owners.length > 0) {
    const ph = owners.map(() => "?").join(",");
    clauses.push(`(t.space_id IS NULL AND (t.owner IN (${ph}) OR t.owner_entity_id IN (${ph})))`);
    params.push(...owners, ...owners);
  }
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.title, t.type, t.status, t.due, t.space_id, sp.label AS space_label,
              COALESCE(t.owner_entity_id, t.owner) AS owner
         FROM tasks t LEFT JOIN spaces sp ON sp.id = t.space_id
        WHERE t.status IN (${statuses}) AND (${clauses.join(" OR ")})
        ORDER BY t.due IS NULL, t.due, t.created_at, t.id LIMIT ?`,
    )
    .all(...params) as {
    id: string;
    title: string;
    type: string;
    status: string;
    due: string | null;
    space_id: string | null;
    space_label: string | null;
    owner: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    due: r.due,
    spaceId: r.space_id,
    spaceLabel: r.space_label,
    owner: r.owner,
  }));
}

export function renderOpenTask(t: OpenTask): string {
  const bits = [`${t.id} "${t.title}"`, t.type, t.status];
  if (t.due) bits.push(`due ${t.due.slice(0, 16).replace("T", " ")}`);
  if (t.owner && t.owner !== "self") bits.push(`owner ${t.owner}`);
  if (t.spaceId) bits.push(`→ ${t.spaceId}${t.spaceLabel ? ` "${t.spaceLabel}"` : ""}`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarItem {
  /** ISO instant or date the item falls on. */
  at: string;
  kind: "due" | "fires" | "milestone";
  refId: string;
  title: string;
  spaceId: string | null;
  spaceLabel: string | null;
}

export const CALENDAR_MAX = 12;
export const CALENDAR_DAYS_AHEAD = 7;
export const CALENDAR_HOURS_BACK = 24;

/** Everything the world model has dated between now-24h and now+7d, nearest first. */
export function calendarItems(
  nowMs: number,
  opts: { daysAhead?: number; hoursBack?: number; limit?: number } = {},
): CalendarItem[] {
  const db = getDb();
  const from = new Date(nowMs - (opts.hoursBack ?? CALENDAR_HOURS_BACK) * 3_600_000).toISOString();
  const to = new Date(nowMs + (opts.daysAhead ?? CALENDAR_DAYS_AHEAD) * 86_400_000).toISOString();
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  const limit = opts.limit ?? CALENDAR_MAX;
  const live = OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",");
  const items: CalendarItem[] = [];

  const due = db
    .prepare(
      `SELECT t.id, t.title, t.due, t.space_id, sp.label AS space_label
         FROM tasks t LEFT JOIN spaces sp ON sp.id = t.space_id
        WHERE t.status IN (${live}) AND t.due IS NOT NULL AND t.due >= ? AND t.due <= ?
        ORDER BY t.due, t.id LIMIT ?`,
    )
    .all(fromDay, to, limit) as { id: string; title: string; due: string; space_id: string | null; space_label: string | null }[];
  for (const r of due) items.push({ at: r.due, kind: "due", refId: r.id, title: r.title, spaceId: r.space_id, spaceLabel: r.space_label });

  const fires = db
    .prepare(
      `SELECT t.id, t.title, json_extract(t.schedule_json, '$.fire_at') AS fire_at, t.space_id, sp.label AS space_label
         FROM tasks t LEFT JOIN spaces sp ON sp.id = t.space_id
        WHERE t.status IN (${live}) AND t.schedule_json IS NOT NULL
          AND json_extract(t.schedule_json, '$.fire_at') >= ? AND json_extract(t.schedule_json, '$.fire_at') <= ?
        ORDER BY fire_at, t.id LIMIT ?`,
    )
    .all(fromDay, to, limit) as { id: string; title: string; fire_at: string; space_id: string | null; space_label: string | null }[];
  for (const r of fires) {
    if (items.some((i) => i.refId === r.id && i.at === r.fire_at)) continue;
    items.push({ at: r.fire_at, kind: "fires", refId: r.id, title: r.title, spaceId: r.space_id, spaceLabel: r.space_label });
  }

  const milestones = db
    .prepare(
      `SELECT c.id, c.label, c.target_date, c.space_id, sp.label AS space_label
         FROM chapters c LEFT JOIN spaces sp ON sp.id = c.space_id
        WHERE c.status = 'active' AND c.target_date IS NOT NULL AND c.target_date >= ? AND c.target_date <= ?
        ORDER BY c.target_date, c.id LIMIT ?`,
    )
    .all(fromDay, toDay + "T99", limit) as { id: string; label: string; target_date: string; space_id: string | null; space_label: string | null }[];
  for (const r of milestones) items.push({ at: r.target_date, kind: "milestone", refId: r.id, title: r.label, spaceId: r.space_id, spaceLabel: r.space_label });

  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.refId < b.refId ? -1 : 1));
  return items.slice(0, limit);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function renderCalendarItem(i: CalendarItem): string {
  const t = Date.parse(i.at.length === 10 ? `${i.at}T00:00:00Z` : i.at);
  const when = Number.isFinite(t)
    ? `${i.at.slice(0, 10)} ${WEEKDAYS[new Date(t).getUTCDay()]}${i.at.length > 10 ? ` ${i.at.slice(11, 16)}` : ""}`
    : i.at;
  const space = i.spaceId ? ` → ${i.spaceId}${i.spaceLabel ? ` "${i.spaceLabel}"` : ""}` : "";
  return `${when} · ${i.kind} · ${i.refId} "${i.title}"${space}`;
}
