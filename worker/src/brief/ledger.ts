// ===========================================================================
// The brief's LEDGER — composed by code (Product_V6 §14.4 item 7; Build §7.2
// lane B: "composed by code at the set times"; GoldenEvals BRF-02).
//
// Three parts, all decided here, none of them asked of a model:
//
//   needs you   the prioritized list's `needs_you` section — a gate, a
//               question, a "done?" the twin asked by code — plus any open
//               question row that hangs off no task.
//   today       today's calendar (my events and people's dates) and the
//               tasks the prioritized list already put in `today`. Tasks come
//               from the task list, events from the calendar, so nothing is
//               counted twice.
//   moved       what changed in the window since the last brief: a space's
//               `latest` line, a task closed, an event confirmed, a piece of
//               prepared work finished.
//
// Nothing is recomputed that another module already decides: sections and
// scores are tasks/priority.ts, the calendar is calendar/layers.ts. This
// module orders, trims and chips them.
//
// Every item carries a SOURCE CHIP (`tsk_…`, `sp_…`, `cal_…`, `art_…`,
// `q_…`) — the id the why-panel resolves, and the reason the prose can be
// checked against the world model instead of trusted.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { calendarView } from "../calendar/layers.js";
import { DEFAULT_TZ, localDate, localTime, renderRelative } from "../calendar/clocks.js";
import { listPrioritizedTasks, type PrioritizedTask } from "../tasks/priority.js";

/** Items per part. A brief is a glance, not a report. */
export const PART_CAP = 8;

export const BRIEF_PARTS = ["needs_you", "today", "moved"] as const;
export type BriefPart = (typeof BRIEF_PARTS)[number];

export const PART_LABELS: Record<BriefPart, string> = {
  needs_you: "Needs you",
  today: "Today",
  moved: "Moved",
};

export interface BriefItem {
  /** One line, already phrased enough to survive if the call fails. */
  text: string;
  /** The row this line came from: `tsk_…` · `sp_…` · `cal_…` · `art_…` · `q_…`. */
  source: string;
  /** What kind of row that is, for the why-panel. */
  kind: "task" | "question" | "event" | "space" | "artifact";
}

export interface BriefLedger {
  /** The instant the ledger was composed. */
  now: string;
  tz: string;
  /** Start of the "moved" window — the previous brief (null on the first). */
  since: string | null;
  needs_you: BriefItem[];
  today: BriefItem[];
  moved: BriefItem[];
  /** Items dropped by PART_CAP, per part. */
  truncated: Record<BriefPart, number>;
}

export interface LedgerOptions {
  now?: Date;
  tz?: string;
  /** The previous brief's instant. null = the first brief. */
  since?: string | null;
}

export function ledgerItemCount(ledger: BriefLedger): number {
  return ledger.needs_you.length + ledger.today.length + ledger.moved.length;
}

export function ledgerIsEmpty(ledger: BriefLedger): boolean {
  return ledgerItemCount(ledger) === 0;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The whole ledger. One pass over tasks, one over the calendar, a few COUNT-shaped reads. */
export function composeLedger(opts: LedgerOptions = {}): BriefLedger {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const since = opts.since ?? null;

  const list = listPrioritizedTasks({ now, tz });
  const bySection = new Map(list.sections.map((s) => [s.id, s.tasks]));

  const needsRaw: BriefItem[] = [
    ...(bySection.get("needs_you") ?? []).map(taskItem),
    ...openQuestions(bySection.get("needs_you") ?? []),
  ];
  const todayRaw: BriefItem[] = [
    ...todayCalendar(now, tz),
    ...(bySection.get("today") ?? []).map(taskItem),
  ];
  const movedRaw: BriefItem[] = movedSince(since, now, tz);

  const truncated: Record<BriefPart, number> = { needs_you: 0, today: 0, moved: 0 };
  const cap = (part: BriefPart, items: BriefItem[]): BriefItem[] => {
    const unique = dedupe(items);
    truncated[part] = Math.max(0, unique.length - PART_CAP);
    return unique.slice(0, PART_CAP);
  };

  return {
    now: now.toISOString(),
    tz,
    since,
    needs_you: cap("needs_you", needsRaw),
    today: cap("today", todayRaw),
    moved: cap("moved", movedRaw),
    truncated,
  };
}

function dedupe(items: BriefItem[]): BriefItem[] {
  const seen = new Set<string>();
  const out: BriefItem[] = [];
  for (const item of items) {
    if (seen.has(item.source)) continue;
    seen.add(item.source);
    out.push(item);
  }
  return out;
}

function taskItem(t: PrioritizedTask): BriefItem {
  const bits = [t.title];
  if (t.due_label) bits.push(`(${t.due_label})`);
  else if (t.action === "approve") bits.push("(waiting for your approval)");
  else if (t.action === "answer") bits.push("(waiting on your answer)");
  else if (t.action === "done?") bits.push("(done?)");
  if (t.suggested) bits.push("· suggested");
  return { text: bits.join(" "), source: t.id, kind: "task" };
}

/**
 * Open questions the twin asked that are NOT already represented by a
 * needs-you task — a question on a task the list already carries would be the
 * same line twice.
 */
function openQuestions(needsYou: readonly PrioritizedTask[]): BriefItem[] {
  const covered = new Set(needsYou.map((t) => t.id));
  let rows: { id: string; question: string; target_id: string | null }[] = [];
  try {
    rows = getDb()
      .prepare(
        `SELECT id, question, target_id FROM questions
          WHERE status = 'open' ORDER BY asked_at DESC, rowid DESC LIMIT 20`,
      )
      .all() as { id: string; question: string; target_id: string | null }[];
  } catch {
    return [];
  }
  return rows
    .filter((r) => !(r.target_id && covered.has(r.target_id)))
    .map((r) => ({ text: r.question, source: r.id, kind: "question" as const }));
}

/** Today's calendar: my events and people's dates. Tasks come from the task list. */
function todayCalendar(now: Date, tz: string): BriefItem[] {
  const day = localDate(now.getTime(), tz);
  let view;
  try {
    view = calendarView({ from: day, to: day, viewNow: now, tz, layers: ["my_events", "people"] });
  } catch {
    return [];
  }
  return view.items.map((i) => {
    const when = i.allDay ? "all day" : localTime(Date.parse(i.at), tz);
    const tentative = i.status === "tentative" || i.status === "proposed" ? " (tentative)" : "";
    return { text: `${i.title} ${when}${tentative}`.trim(), source: i.refId, kind: "event" as const };
  });
}

// ---------------------------------------------------------------------------
// "What moved since the last brief"
// ---------------------------------------------------------------------------

/**
 * The window's news, newest first. Read straight off the same tables the
 * delta counts, so a brief can never say "nothing moved" while the delta said
 * it did — or the other way round.
 */
function movedSince(since: string | null, now: Date, tz: string): BriefItem[] {
  const db = getDb();
  const rows: { at: string; item: BriefItem }[] = [];
  const bound = since ?? "0000";

  const push = (at: string | null | undefined, item: BriefItem): void => {
    rows.push({ at: at ?? "", item });
  };

  try {
    for (const s of db
      .prepare(
        `SELECT id, label, latest, latest_ts FROM spaces
          WHERE latest IS NOT NULL AND latest != '' AND COALESCE(latest_ts, updated_at, created_at) >= ?
          ORDER BY COALESCE(latest_ts, updated_at, created_at) DESC LIMIT ?`,
      )
      .all(bound, PART_CAP * 2) as { id: string; label: string; latest: string; latest_ts: string | null }[]) {
      push(s.latest_ts, { text: `${s.label}: ${s.latest}`, source: s.id, kind: "space" });
    }
  } catch {
    /* no spaces table on this install */
  }

  try {
    for (const t of db
      .prepare(
        `SELECT id, title, status, closed_at FROM tasks
          WHERE closed_at IS NOT NULL AND closed_at >= ? AND status IN ('done','cancelled')
          ORDER BY closed_at DESC LIMIT ?`,
      )
      .all(bound, PART_CAP) as { id: string; title: string; status: string; closed_at: string }[]) {
      push(t.closed_at, {
        text: `${t.title} — ${t.status === "cancelled" ? "cancelled" : "done"}`,
        source: t.id,
        kind: "task",
      });
    }
  } catch {
    /* no tasks table */
  }

  try {
    for (const e of db
      .prepare(
        `SELECT id, title, starts_at, confirmed_at FROM calendar_events
          WHERE confirmed_at IS NOT NULL AND confirmed_at >= ? AND status = 'confirmed'
          ORDER BY confirmed_at DESC LIMIT ?`,
      )
      .all(bound, PART_CAP) as { id: string; title: string; starts_at: string; confirmed_at: string }[]) {
      push(e.confirmed_at, {
        text: `${e.title} confirmed for ${renderRelative(e.starts_at, now, tz)}`,
        source: e.id,
        kind: "event",
      });
    }
  } catch {
    /* no calendar on this install */
  }

  try {
    for (const a of db
      .prepare(
        `SELECT id, title, summary, created_at FROM artifacts
          WHERE created_at >= ? AND status IN ('new','seen')
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(bound, PART_CAP) as { id: string; title: string; summary: string | null; created_at: string }[]) {
      push(a.created_at, {
        text: a.summary?.trim() ? `${a.title} — ${a.summary.trim()}` : a.title,
        source: a.id,
        kind: "artifact",
      });
    }
  } catch {
    /* no artifacts table */
  }

  return rows.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).map((r) => r.item);
}

// ---------------------------------------------------------------------------
// The packed half of the call
// ---------------------------------------------------------------------------

/**
 * The ledger as brief.v2's user block. Every line already carries its chip,
 * so the model's whole job is phrasing — and any figure in the answer that is
 * not in this text is an invention (prompts/brief.v2.ts figuresNotInLedger).
 */
export function packBriefV2User(ledger: BriefLedger): string {
  const lines: string[] = [
    `NOW ${localDate(Date.parse(ledger.now), ledger.tz)} ${localTime(Date.parse(ledger.now), ledger.tz)} (${ledger.tz})`,
    `SINCE LAST BRIEF ${ledger.since ?? "— first brief"}`,
  ];
  for (const part of BRIEF_PARTS) {
    lines.push("", PART_LABELS[part].toUpperCase());
    const items = ledger[part];
    if (items.length === 0) lines.push("- (nothing)");
    for (const item of items) lines.push(`- [${item.source}] ${item.text}`);
    if (ledger.truncated[part] > 0) lines.push(`- (+${ledger.truncated[part]} more not shown)`);
  }
  return lines.join("\n");
}

/**
 * The brief code writes when the model call is unavailable or refused — the
 * ledger itself, rendered. A brief that costs nothing is still a brief; a
 * missing one is a broken promise at 08:30.
 */
export function renderLedgerFallback(ledger: BriefLedger): string {
  const parts: string[] = [];
  for (const part of BRIEF_PARTS) {
    const items = ledger[part];
    if (items.length === 0) continue;
    parts.push(`**${PART_LABELS[part]}** · ${items.map((i) => i.text).join(" · ")}`);
  }
  return parts.join("\n");
}
