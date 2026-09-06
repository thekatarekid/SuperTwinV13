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
//               dates (milestones), the DERIVED calendar's own events (with
//               their tentative/confirmed status) and the days a person's
//               date opens its planning space — capped, nearest first
//               (V6 P1 S5.3; Prompts P-01 `[CALENDAR next 7d]`)
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
  kind: "due" | "fires" | "milestone" | "event" | "planning";
  refId: string;
  title: string;
  spaceId: string | null;
  spaceLabel: string | null;
  /**
   * V6 P1 S5.3: an event's `tentative` / `confirmed`. Rendered in parentheses
   * so the model can never read a chat-derived plan as firm (CAL-01). Null on
   * every other kind.
   */
  status?: string | null;
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

  // V6 P1 S5.3 (Prompts P-01: `[CALENDAR next 7d] … dinner Rohan (tentative) ·
  // … planning opens: Ma's birthday`). The DERIVED calendar reaches the pack:
  // chat-derived events carry their status, so a plan the user never confirmed
  // can never be read as firm; cancelled events are gone.
  const events = db
    .prepare(
      `SELECT ev.id, ev.title, ev.starts_at, ev.status, ev.space_id, sp.label AS space_label
         FROM calendar_events ev LEFT JOIN spaces sp ON sp.id = ev.space_id
        WHERE ev.status <> 'cancelled' AND ev.starts_at >= ? AND ev.starts_at <= ?
        ORDER BY ev.starts_at, ev.id LIMIT ?`,
    )
    .all(from, to, limit) as {
    id: string;
    title: string;
    starts_at: string;
    status: string;
    space_id: string | null;
    space_label: string | null;
  }[];
  for (const r of events) {
    items.push({ at: r.starts_at, kind: "event", refId: r.id, title: r.title, spaceId: r.space_id, spaceLabel: r.space_label, status: r.status });
  }

  // Lead-time planning: the day a person's date opens its planning space. A
  // snoozed plan opens on the snooze day, not the original one.
  const planning = db
    .prepare(
      `SELECT p.id, COALESCE(p.snoozed_until, p.opens_at) AS opens_on, p.occurrence, p.space_id,
              sp.label AS space_label, e.canonical AS person_name, d.kind AS date_kind, d.label AS date_label
         FROM calendar_plans p
         JOIN person_dates d ON d.id = p.person_date_id
         JOIN entities e ON e.id = d.person_entity_id
         LEFT JOIN spaces sp ON sp.id = p.space_id
        WHERE p.status IN ('pending','opened','snoozed')
          AND COALESCE(p.snoozed_until, p.opens_at) >= ? AND COALESCE(p.snoozed_until, p.opens_at) <= ?
        ORDER BY opens_on, p.id LIMIT ?`,
    )
    .all(fromDay, toDay, limit) as {
    id: string;
    opens_on: string;
    occurrence: string;
    space_id: string | null;
    space_label: string | null;
    person_name: string | null;
    date_kind: string;
    date_label: string | null;
  }[];
  for (const r of planning) {
    const what = r.date_label ?? (r.date_kind === "other" ? "date" : r.date_kind);
    items.push({
      at: r.opens_on,
      kind: "planning",
      refId: r.id,
      title: `planning opens: ${r.person_name ?? "someone"}'s ${what} on ${r.occurrence}`,
      spaceId: r.space_id,
      spaceLabel: r.space_label,
    });
  }

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
  // A chat-derived event says so: "(tentative)" until the user or a booking
  // firms it (V6 P1 S5.3, CAL-01).
  const status = i.status ? ` (${i.status})` : "";
  return `${when} · ${i.kind} · ${i.refId} "${i.title}"${status}${space}`;
}
