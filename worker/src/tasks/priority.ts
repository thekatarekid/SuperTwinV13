// ===========================================================================
// The prioritized task list (V6 P1 S5.2, Product_V6 §11.13, Product_V6_Phase1
// §14.4, GoldenEvals TSK-01).
//
// ONE list across every space. Code decides the section AND the score; the
// model is never asked to rank. Every row carries the factors that shaped its
// score so the UI can explain the order on hover ("Score explained on hover").
//
//   Sections, in display order:
//     needs_you   — a gate or a question: needs_approval / needs_input, a
//                   "done?" card the twin asked by code, or a schedule that
//                   waits for the user to confirm.
//     today       — due today or overdue, or a step that fires today.
//     this_week   — due inside the next 7 days.
//     later       — open with a farther due or none.
//     waiting     — another person's task (monitored), or the twin is mid-run.
//     done_today  — closed as done today (cancelled never shows here).
//
//   Score = deadline + gate + value + effort + emotional weight + waiting
//           parties + user pin. A task for the user alone with no one waiting
//           scores on its own merits (no waiting term, no penalty).
//
// Pure around the database: `now` and the time zone are parameters, so the
// tests and the TSK-01 fixture pin the clock.
// ===========================================================================

import { getDb } from "../db/connection.js";

export const SECTIONS = ["needs_you", "today", "this_week", "later", "waiting", "done_today"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  needs_you: "Needs you",
  today: "Today",
  this_week: "This week",
  later: "Later",
  waiting: "Waiting on others",
  done_today: "Done today",
};

/** The user's rendering zone until a location claim says otherwise (§11.6.6). */
export const DEFAULT_TZ = "Asia/Kolkata";
export const WEEK_MS = 7 * 24 * 3_600_000;

export interface ScoreFactor {
  factor: "deadline" | "gate" | "value" | "effort" | "emotional" | "waiting" | "pin";
  delta: number;
  note: string;
}

export interface PrioritizedTask {
  id: string;
  title: string;
  space_id: string | null;
  space_label: string | null;
  type: string;
  category: string | null;
  risk_class: string;
  owner: string | null;
  status: string;
  due: string | null;
  /** Render-time only (§11.6.5): "today" · "2 days overdue" · "in 3 days" · null. */
  due_label: string | null;
  section: Section;
  score: number;
  /** The explanation the UI shows on hover — every factor that moved the score. */
  why: ScoreFactor[];
  /** The one-tap action the row offers. */
  action: "approve" | "answer" | "done?" | "confirm" | "open" | null;
  suggested: boolean;
  schedule: { fire_at: string | null; mode: string; proposed: boolean; step: string | null } | null;
}

export interface PrioritizedList {
  generated_at: string;
  tz: string;
  sections: { id: Section; label: string; tasks: PrioritizedTask[] }[];
  total: number;
}

interface Row {
  id: string;
  title: string;
  space_id: string | null;
  space_label: string | null;
  type: string;
  category: string | null;
  risk_class: string;
  owner: string | null;
  status: string;
  due: string | null;
  confidence: number | null;
  schedule_json: string | null;
  evidence_json: string | null;
  closed_at: string | null;
  updated_at: string | null;
  created_at: string;
  /** 1 when a code-written "done?" card is open on the task. */
  asked: number;
  /** 1 when the user pinned the task (latest pin/unpin decision). */
  pinned: number;
}

// ---------------------------------------------------------------------------
// Time helpers — the view clock renders relative to `now` (§11.6.5); nothing
// relative is stored.
// ---------------------------------------------------------------------------

/** Local calendar day key (YYYY-MM-DD) of an instant in a zone. */
export function dayKey(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse a stored due (ISO instant, or a date-only day that ends at 23:59 local). */
export function dueInstant(due: string | null, tz: string): Date | null {
  if (due === null || due.trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    // End of that local day: find the offset the zone has on that date.
    const probe = new Date(`${due}T12:00:00Z`);
    const offsetMin = zoneOffsetMinutes(probe, tz);
    const ms = Date.parse(`${due}T23:59:59Z`) - offsetMin * 60_000;
    return new Date(ms);
  }
  const ms = Date.parse(due);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function zoneOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function dayDiff(instant: Date, now: Date, tz: string): number {
  const a = Date.parse(`${dayKey(instant, tz)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(now, tz)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** The view-time label for a due (§11.6 view clock). */
export function relativeDueLabel(due: string | null, now: Date, tz: string): string | null {
  const at = dueInstant(due, tz);
  if (!at) return null;
  const d = dayDiff(at, now, tz);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "1 day overdue";
  if (d < 0) return `${-d} days overdue`;
  return `in ${d} days`;
}

// ---------------------------------------------------------------------------
// Section + score
// ---------------------------------------------------------------------------

function isSelf(owner: string | null): boolean {
  if (owner === null) return true;
  const o = owner.trim().toLowerCase();
  return o === "" || o === "self" || o === "user" || o === "me";
}

interface ParsedSchedule {
  fire_at: string | null;
  mode: string;
  proposed: boolean;
  step: string | null;
}

function parseSchedule(json: string | null): ParsedSchedule | null {
  if (json === null) return null;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    if (typeof p !== "object" || p === null) return null;
    return {
      fire_at: typeof p.fire_at === "string" ? p.fire_at : null,
      mode: typeof p.mode === "string" ? p.mode : "auto",
      proposed: p.proposed === true,
      step: typeof p.step === "string" ? p.step : null,
    };
  } catch {
    return null;
  }
}

const CLOSED = new Set(["done", "cancelled", "dismissed"]);

export function sectionFor(row: Row, now: Date, tz: string): Section | null {
  const sched = parseSchedule(row.schedule_json);
  if (row.status === "done") {
    return row.closed_at !== null && dayKey(new Date(row.closed_at), tz) === dayKey(now, tz) ? "done_today" : null;
  }
  if (CLOSED.has(row.status) || row.status === "dormant") return null;
  if (row.status === "needs_approval" || row.status === "needs_input") return "needs_you";
  if (row.asked === 1) return "needs_you";
  if (sched?.proposed) return "needs_you";
  if (!isSelf(row.owner) || row.category === "monitoring" || row.status === "executing") return "waiting";
  const due = dueInstant(row.due, tz);
  const fire = sched?.fire_at ? new Date(sched.fire_at) : null;
  const dueDays = due ? dayDiff(due, now, tz) : null;
  const fireDays = fire && !Number.isNaN(fire.getTime()) ? dayDiff(fire, now, tz) : null;
  if ((dueDays !== null && dueDays <= 0) || (fireDays !== null && fireDays <= 0)) return "today";
  if (dueDays !== null && due!.getTime() - now.getTime() <= WEEK_MS) return "this_week";
  if (fireDays !== null && fire!.getTime() - now.getTime() <= WEEK_MS) return "this_week";
  return "later";
}

export function scoreFor(row: Row, section: Section, now: Date, tz: string): { score: number; why: ScoreFactor[] } {
  const why: ScoreFactor[] = [];
  const sched = parseSchedule(row.schedule_json);
  const due = dueInstant(row.due, tz);

  // Deadline: the closer (or the more overdue), the higher.
  if (due) {
    const d = dayDiff(due, now, tz);
    if (d < 0) why.push({ factor: "deadline", delta: 40, note: `${-d} day${d === -1 ? "" : "s"} overdue` });
    else if (d === 0) why.push({ factor: "deadline", delta: 30, note: "due today" });
    else if (d <= 3) why.push({ factor: "deadline", delta: 20, note: `due in ${d} day${d === 1 ? "" : "s"}` });
    else if (d <= 7) why.push({ factor: "deadline", delta: 10, note: `due in ${d} days` });
    else why.push({ factor: "deadline", delta: 2, note: `due in ${d} days — plenty of runway` });
  } else if (sched?.fire_at) {
    const d = dayDiff(new Date(sched.fire_at), now, tz);
    why.push({ factor: "deadline", delta: d <= 0 ? 25 : d <= 7 ? 10 : 2, note: d <= 0 ? "a step fires today" : `a step fires in ${d} days` });
  } else {
    why.push({ factor: "deadline", delta: 0, note: "no due date" });
  }

  // Gate needed: the user is the blocker.
  if (row.status === "needs_approval") why.push({ factor: "gate", delta: 50, note: "waiting for your approval" });
  else if (row.status === "needs_input") why.push({ factor: "gate", delta: 45, note: "waiting for your answer" });
  else if (row.asked === 1) why.push({ factor: "gate", delta: 35, note: "the twin asked: done?" });
  else if (sched?.proposed) why.push({ factor: "gate", delta: 30, note: "a schedule waits for your confirm" });

  // Value: how sure the twin is this matters (explicit > implicit > suggested).
  const base = row.type === "explicit" ? 15 : row.type === "implicit" ? 10 : 5;
  const conf = typeof row.confidence === "number" ? Math.round(row.confidence * 10) : 5;
  why.push({ factor: "value", delta: base + conf, note: `${row.type} task, confidence ${row.confidence ?? "n/a"}` });

  // Effort: read-only and drafting steps the twin can run itself cost less of
  // the user's attention; errands only the user can do cost more.
  if (row.risk_class === "auto") why.push({ factor: "effort", delta: 5, note: "the twin can run this itself" });
  else if (row.risk_class === "advise-only" && row.category === "errand") why.push({ factor: "effort", delta: -5, note: "an errand only you can do" });

  // Emotional weight: a person is on the other end of a message or a payment.
  if (row.category === "communication") why.push({ factor: "emotional", delta: 8, note: "someone is waiting on a reply" });
  else if (row.category === "transaction") why.push({ factor: "emotional", delta: 6, note: "money moves" });

  // Waiting parties: theirs, not yours — you are monitoring, not doing.
  if (section === "waiting") {
    const who = isSelf(row.owner) ? "the twin" : (row.owner ?? "").split(":").pop() ?? row.owner;
    why.push({ factor: "waiting", delta: -20, note: `waiting on ${who}` });
  }

  // User pin wins over everything else.
  if (row.pinned === 1) why.push({ factor: "pin", delta: 100, note: "pinned by you" });

  return { score: why.reduce((s, f) => s + f.delta, 0), why };
}

function actionFor(row: Row, section: Section): PrioritizedTask["action"] {
  if (row.status === "needs_approval") return "approve";
  if (row.status === "needs_input") return "answer";
  if (row.asked === 1) return "done?";
  if (parseSchedule(row.schedule_json)?.proposed) return "confirm";
  return section === "done_today" ? null : "open";
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListOptions {
  now?: Date;
  tz?: string;
  /** Restrict to one space (the space view's task block). */
  spaceId?: string | null;
}

/** The list the UI renders. A single pass over the tasks table, zero calls. */
export function listPrioritizedTasks(opts: ListOptions = {}): PrioritizedList {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const db = getDb();
  const where = opts.spaceId ? `WHERE t.space_id = ?` : "";
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.space_id, s.label AS space_label, t.type, t.category, t.risk_class,
              t.owner, t.status, t.due, t.confidence, t.schedule_json, t.evidence_json,
              t.closed_at, t.updated_at, t.created_at,
              -- A "done?" card stands when the LAST card-relevant decision on the
              -- task is the ask itself. Ordered by rowid, never by a clock: the
              -- decisions table is append-only, so this is exact under a pinned
              -- fixture clock as well as in production.
              COALESCE((SELECT CASE WHEN d.action = 'ask_done' THEN 1 ELSE 0 END FROM decisions d
                         WHERE d.target_kind = 'task' AND d.target_id = t.id
                           AND d.action IN ('ask_done','answer_not_yet','escalate_check','close','dormant')
                           AND d.reversed_at IS NULL
                         ORDER BY d.rowid DESC LIMIT 1), 0) AS asked,
              COALESCE((SELECT CASE WHEN d.action = 'pin' THEN 1 ELSE 0 END FROM decisions d
                         WHERE d.target_kind = 'task' AND d.target_id = t.id
                           AND d.action IN ('pin','unpin') AND d.reversed_at IS NULL
                         ORDER BY d.rowid DESC LIMIT 1), 0) AS pinned
         FROM tasks t LEFT JOIN spaces s ON s.id = t.space_id
         ${where}
         ORDER BY t.created_at, t.rowid`,
    )
    .all(...(opts.spaceId ? [opts.spaceId] : [])) as Row[];

  const buckets = new Map<Section, PrioritizedTask[]>(SECTIONS.map((s) => [s, []]));
  for (const row of rows) {
    const section = sectionFor(row, now, tz);
    if (section === null) continue;
    const { score, why } = scoreFor(row, section, now, tz);
    const sched = parseSchedule(row.schedule_json);
    buckets.get(section)!.push({
      id: row.id,
      title: row.title,
      space_id: row.space_id,
      space_label: row.space_label,
      type: row.type,
      category: row.category,
      risk_class: row.risk_class,
      owner: row.owner,
      status: row.status,
      due: row.due,
      due_label: relativeDueLabel(row.due, now, tz),
      section,
      score,
      why,
      action: actionFor(row, section),
      suggested: row.type === "suggested",
      schedule: sched,
    });
  }
  let total = 0;
  const sections = SECTIONS.map((id) => {
    const tasks = buckets.get(id)!.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    total += tasks.length;
    return { id, label: SECTION_LABELS[id], tasks };
  });
  return { generated_at: now.toISOString(), tz, sections, total };
}
