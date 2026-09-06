// ===========================================================================
// The derived calendar's LAYERS (V6 P1 S5.3; Product_V6 §11.9.1, Phase1 §16).
//
//   my_events    calendar_events (tentative shown as such; cancelled hidden)
//   my_tasks     open tasks the user owns, with a due date
//   twin_tasks   the twin's scheduled steps (a fire_at / scheduled|executing)
//   people       people's dates (+ their open plans) and tasks OTHER people own
//
// "Every layer can be shown alone or together. 'My tasks' and 'twin's tasks'
// are separate views" (§11.9.1, CAL-05). Nothing is copied: tasks are read
// from `tasks`, rules are expanded at VIEW time, and every relative label
// ("in 3 days") is computed here from the viewer's clock and zone — the
// stored instants never change (TIM-02).
// ===========================================================================

import { getDb } from "../db/connection.js";
import { OPEN_TASK_STATUSES } from "../packer/agenda.js";
import {
  addDays,
  DEFAULT_TZ,
  describeRule,
  isValidTz,
  localDate,
  nextOccurrences,
  renderInstant,
  renderRelative,
} from "./clocks.js";
import { calendarSettings, effectivePolicy } from "./lead-time.js";
import { nextOccurrence, parseRuleRow, type CalendarEventRow, type CalendarRuleRow, type PersonDateRow } from "./store.js";

export const LAYERS = ["my_events", "my_tasks", "twin_tasks", "people"] as const;
export type Layer = (typeof LAYERS)[number];

export function isLayer(v: unknown): v is Layer {
  return typeof v === "string" && (LAYERS as readonly string[]).includes(v);
}

export type ItemKind =
  | "event"
  | "rule_occurrence"
  | "task_due"
  | "twin_step"
  | "person_date"
  | "their_task";

export interface CalendarViewItem {
  layer: Layer;
  kind: ItemKind;
  /** Row id in its own table. */
  refId: string;
  title: string;
  /** Absolute instant (ISO) or a yyyy-mm-dd for date-only items. */
  at: string;
  /** yyyy-mm-dd in the viewer's zone. */
  day: string;
  allDay: boolean;
  /** tentative | confirmed (events); proposed | confirmed (rule occurrences); task status; plan status. */
  status: string | null;
  /** VIEW time: "today" / "in 3 days" / "2 days overdue" — never stored. */
  relative: string;
  /** Viewer's zone first, the source zone noted when it differs (TIM-04). */
  rendered: string;
  /** The zone the source named, when it is not the viewer's. */
  sourceTz: string | null;
  spaceId: string | null;
  spaceLabel: string | null;
  personEntityId: string | null;
  personName: string | null;
  /** The original words, when the item came from a phrase. */
  phrase: string | null;
  /** Item-specific facts for the why-panel. */
  detail: Record<string, unknown>;
}

export interface CalendarViewOptions {
  /** yyyy-mm-dd inclusive range in the viewer's zone. */
  from: string;
  to: string;
  /** Which layers; default all four. */
  layers?: readonly Layer[];
  /** VIEW time — when the user is looking. */
  viewNow: Date;
  /** The viewer's zone; default the user's. */
  tz?: string;
  /** Show tentative events (default true); false = firm only. */
  includeTentative?: boolean;
  /** Include proposed (unconfirmed) rules' occurrences, marked (default false). */
  includeProposedRules?: boolean;
}

export interface CalendarView {
  from: string;
  to: string;
  tz: string;
  layers: Layer[];
  items: CalendarViewItem[];
  /** Per-layer counts — the layer chips. */
  counts: Record<Layer, number>;
}

function liveStatuses(): string {
  return OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",");
}

function isoDayBounds(from: string, to: string): { fromIso: string; toIso: string } {
  // Widen by a day on each side in UTC and let the per-item day filter decide
  // — a zone offset never drops an item on the range's edge.
  return { fromIso: `${addDays(from, -1)}T00:00:00.000Z`, toIso: `${addDays(to, 1)}T23:59:59.999Z` };
}

/** The four layers over [from, to], rendered for the viewer. */
export function calendarView(opts: CalendarViewOptions): CalendarView {
  const tz = opts.tz && isValidTz(opts.tz) ? opts.tz : DEFAULT_TZ;
  const layers = (opts.layers ?? LAYERS).filter(isLayer);
  const want = new Set<Layer>(layers);
  const items: CalendarViewItem[] = [];
  const db = getDb();
  const { fromIso, toIso } = isoDayBounds(opts.from, opts.to);
  const inRange = (day: string): boolean => day >= opts.from && day <= opts.to;

  const base = (
    layer: Layer,
    kind: ItemKind,
    refId: string,
    title: string,
    at: string,
    allDay: boolean,
    sourceTz: string | null,
  ): CalendarViewItem => {
    const day = at.length === 10 ? at : localDate(Date.parse(at), tz);
    return {
      layer,
      kind,
      refId,
      title,
      at,
      day,
      allDay,
      status: null,
      relative: renderRelative(at, opts.viewNow, tz),
      rendered: allDay || at.length === 10 ? day : renderInstant(at, tz, sourceTz),
      sourceTz: sourceTz && sourceTz !== tz ? sourceTz : null,
      spaceId: null,
      spaceLabel: null,
      personEntityId: null,
      personName: null,
      phrase: null,
      detail: {},
    };
  };

  // ---- my_events -----------------------------------------------------------
  if (want.has("my_events")) {
    const rows = db
      .prepare(
        `SELECT ev.*, sp.label AS space_label, e.canonical AS person_name
           FROM calendar_events ev
           LEFT JOIN spaces sp ON sp.id = ev.space_id
           LEFT JOIN entities e ON e.id = ev.person_entity_id
          WHERE ev.status <> 'cancelled' AND ev.starts_at >= ? AND ev.starts_at <= ?
          ORDER BY ev.starts_at, ev.id`,
      )
      .all(fromIso, toIso) as Array<CalendarEventRow & { space_label: string | null; person_name: string | null }>;
    for (const r of rows) {
      if (r.status === "tentative" && opts.includeTentative === false) continue;
      const it = base("my_events", "event", r.id, r.title, r.starts_at, r.all_day === 1, r.tz);
      if (!inRange(it.day)) continue;
      it.status = r.status;
      it.spaceId = r.space_id;
      it.spaceLabel = r.space_label;
      it.personEntityId = r.person_entity_id;
      it.personName = r.person_name;
      it.phrase = r.phrase;
      it.detail = { origin: r.origin, confirmed_by: r.confirmed_by, message_ts: r.message_ts, ends_at: r.ends_at };
      items.push(it);
    }

    const rules = db
      .prepare(`SELECT r.*, sp.label AS space_label FROM calendar_rules r LEFT JOIN spaces sp ON sp.id = r.space_id WHERE r.status <> 'dismissed' ORDER BY r.created_at, r.id`)
      .all() as Array<CalendarRuleRow & { space_label: string | null }>;
    for (const r of rules) {
      if (r.status === "proposed" && !opts.includeProposedRules) continue;
      const rule = parseRuleRow(r);
      const anchorDay = r.message_ts ? localDate(Date.parse(r.message_ts), r.tz) : opts.from;
      // Enough occurrences to cover the range, then filter.
      const span = Math.max(1, Math.ceil((Date.parse(`${opts.to}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000) + 1);
      const n = rule.freq === "daily" ? span : rule.freq === "weekly" ? Math.ceil(span / 7) + 1 : rule.freq === "monthly" ? Math.ceil(span / 28) + 1 : 2;
      for (const day of nextOccurrences(rule, opts.from, n, anchorDay)) {
        if (!inRange(day)) continue;
        const at = rule.time ? `${day}T${rule.time}` : day;
        const it = base("my_events", "rule_occurrence", r.id, r.title, day, !rule.time, r.tz);
        it.status = r.status;
        it.spaceId = r.space_id;
        it.spaceLabel = r.space_label;
        it.phrase = r.phrase;
        it.rendered = rule.time ? `${day} ${rule.time}` : day;
        it.detail = { rule: describeRule(rule), local: at, proposed: r.status === "proposed" };
        items.push(it);
      }
    }
  }

  // ---- my_tasks / twin_tasks / their tasks --------------------------------
  if (want.has("my_tasks") || want.has("twin_tasks") || want.has("people")) {
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.owner, t.owner_entity_id, t.due, t.schedule_json, t.type, t.space_id,
                sp.label AS space_label, e.canonical AS owner_name,
                json_extract(t.schedule_json, '$.fire_at') AS fire_at,
                json_extract(t.schedule_json, '$.mode') AS sched_mode
           FROM tasks t
           LEFT JOIN spaces sp ON sp.id = t.space_id
           LEFT JOIN entities e ON e.id = t.owner_entity_id
          WHERE t.status IN (${liveStatuses()})
            AND ((t.due IS NOT NULL AND t.due >= ? AND t.due <= ?)
              OR (json_extract(t.schedule_json, '$.fire_at') >= ? AND json_extract(t.schedule_json, '$.fire_at') <= ?))
          ORDER BY COALESCE(json_extract(t.schedule_json, '$.fire_at'), t.due), t.id`,
      )
      .all(fromIso.slice(0, 10), toIso, fromIso.slice(0, 10), toIso) as Array<{
      id: string;
      title: string;
      status: string;
      owner: string | null;
      owner_entity_id: string | null;
      due: string | null;
      schedule_json: string | null;
      type: string;
      space_id: string | null;
      space_label: string | null;
      owner_name: string | null;
      fire_at: string | null;
      sched_mode: string | null;
    }>;
    for (const t of rows) {
      const twinStep = t.fire_at !== null || t.status === "scheduled" || t.status === "executing";
      const mine = t.owner === null || t.owner === "self" || t.owner === "" ;
      if (twinStep) {
        // The twin's step: it fires at fire_at (its own clock), whoever the task is for.
        if (want.has("twin_tasks")) {
          const at = t.fire_at ?? t.due!;
          const it = base("twin_tasks", "twin_step", t.id, t.title, at, at.length === 10, null);
          if (inRange(it.day)) {
            it.status = t.status;
            it.spaceId = t.space_id;
            it.spaceLabel = t.space_label;
            it.detail = { mode: t.sched_mode, fire_at: t.fire_at, due: t.due, type: t.type, owner: t.owner ?? "self" };
            items.push(it);
          }
        }
        continue;
      }
      if (!t.due) continue;
      if (mine) {
        if (!want.has("my_tasks")) continue;
        const it = base("my_tasks", "task_due", t.id, t.title, t.due, t.due.length === 10, null);
        if (!inRange(it.day)) continue;
        it.status = t.status;
        it.spaceId = t.space_id;
        it.spaceLabel = t.space_label;
        it.detail = { type: t.type, owner: "self" };
        items.push(it);
      } else {
        if (!want.has("people")) continue;
        const it = base("people", "their_task", t.id, t.title, t.due, t.due.length === 10, null);
        if (!inRange(it.day)) continue;
        it.status = t.status;
        it.spaceId = t.space_id;
        it.spaceLabel = t.space_label;
        it.personEntityId = t.owner_entity_id;
        it.personName = t.owner_name ?? t.owner;
        it.detail = { type: t.type, owner: t.owner };
        items.push(it);
      }
    }
  }

  // ---- people's dates ------------------------------------------------------
  if (want.has("people")) {
    const settings = calendarSettings();
    const rows = db
      .prepare(
        `SELECT d.*, e.canonical AS person_name, e.circle AS circle
           FROM person_dates d JOIN entities e ON e.id = d.person_entity_id
          WHERE e.merged_into IS NULL`,
      )
      .all() as Array<PersonDateRow & { person_name: string | null; circle: string | null }>;
    for (const d of rows) {
      const occurrence = nextOccurrence(d, opts.from);
      if (!occurrence || !inRange(occurrence)) continue;
      const policy = effectivePolicy(d, d.circle, settings);
      const plan = db
        .prepare(`SELECT id, status, opens_at, snoozed_until, space_id, lead_days FROM calendar_plans WHERE person_date_id = ? AND occurrence = ?`)
        .get(d.id, occurrence) as { id: string; status: string; opens_at: string; snoozed_until: string | null; space_id: string | null; lead_days: number } | undefined;
      const what = d.label ?? (d.kind === "other" ? "date" : d.kind);
      const it = base("people", "person_date", d.id, `${d.person_name ?? "someone"}'s ${what}`, occurrence, true, null);
      it.status = plan?.status ?? (policy.mode === "plan" ? "planned" : "wish");
      it.personEntityId = d.person_entity_id;
      it.personName = d.person_name;
      it.spaceId = plan?.space_id ?? null;
      it.detail = {
        kind: d.kind,
        circle: d.circle,
        mode: policy.mode,
        lead_days: policy.leadDays,
        learned: d.lead_days !== null || d.mode !== null,
        plan: plan ? { id: plan.id, status: plan.status, opens_at: plan.opens_at, snoozed_until: plan.snoozed_until } : null,
      };
      items.push(it);
    }
  }

  items.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : a.refId < b.refId ? -1 : 1));
  const counts = { my_events: 0, my_tasks: 0, twin_tasks: 0, people: 0 } as Record<Layer, number>;
  for (const it of items) counts[it.layer] += 1;
  return { from: opts.from, to: opts.to, tz, layers, items, counts };
}

/** One layer alone (§11.9.1). */
export function layerView(layer: Layer, opts: Omit<CalendarViewOptions, "layers">): CalendarView {
  return calendarView({ ...opts, layers: [layer] });
}
