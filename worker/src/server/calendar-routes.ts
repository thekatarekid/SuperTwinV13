// ===========================================================================
// [CODE] Calendar routes — V6 P1 S5.3 (Product_V6_Phase1 §16, §21 Calendar tab,
// Settings › Calendar).
//
//   GET  /api/calendar?from=&to=&layers=my_events,my_tasks&tz=&tentative=0
//                                          the four layers, rendered at VIEW time
//   POST /api/calendar/events              {title, starts_at, ends_at?, tz?, all_day?}  (the bar / the tab)
//   POST /api/calendar/events/:id/confirm  user confirms a tentative event
//   POST /api/calendar/events/:id/cancel
//   POST /api/calendar/rules/:id/confirm   {rule?} — the recurrence suggestion's yes
//   POST /api/calendar/rules/:id/dismiss
//   POST /api/calendar/dates               {person_entity_id, kind, month, day, year?, label?, mode?, lead_days?}
//   POST /api/calendar/dates/:id/policy    {mode?, lead_days?}
//   POST /api/calendar/plans/:id/snooze    {choice: next_week|10_days_before|3_days_before}
//   POST /api/calendar/plans/:id/stop
//   GET/POST /api/settings/calendar        per-circle mode + lead time
//
// Every write goes through calendar/store.ts (decisions rows, clocks injected).
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  calendarSettings,
  calendarView,
  cancelEvent,
  confirmEvent,
  confirmRule,
  createUserEvent,
  DEFAULT_TZ,
  dismissRule,
  isLayer,
  isSnoozeChoice,
  isValidTz,
  localDate,
  parseRecurrence,
  setCalendarSettings,
  setPersonDatePolicy,
  snoozeOptions,
  snoozePlan,
  stopPlan,
  upsertPersonDate,
  type DateKind,
  type Layer,
  type RecurrenceRule,
} from "../calendar/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const DATE_KINDS: readonly DateKind[] = ["birthday", "anniversary", "exam", "flight", "other"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
}

/** Handle one calendar route. Returns false for any path it does not claim. */
export async function handleCalendarRoute(req: IncomingMessage, res: ServerResponse, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/settings/calendar") {
    if (method === "GET") {
      sendJson(res, 200, { circles: calendarSettings() });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const patch = (body.circles && typeof body.circles === "object" ? body.circles : body) as Record<string, Record<string, unknown>>;
      const cleaned: Record<string, { mode?: "plan" | "wish"; leadDays?: number }> = {};
      for (const [circle, v] of Object.entries(patch)) {
        if (!v || typeof v !== "object") continue;
        const o: { mode?: "plan" | "wish"; leadDays?: number } = {};
        if (v.mode === "plan" || v.mode === "wish") o.mode = v.mode;
        const lead = int(v.lead_days ?? v.leadDays);
        if (lead !== null) o.leadDays = lead;
        cleaned[circle] = o;
      }
      sendJson(res, 200, { circles: setCalendarSettings(cleaned) });
      return true;
    }
    return false;
  }

  if (!path.startsWith("/api/calendar")) return false;

  if (method === "GET" && path === "/api/calendar") {
    const tz = str(url.searchParams.get("tz")) ?? DEFAULT_TZ;
    const viewNow = now();
    const today = localDate(viewNow.getTime(), isValidTz(tz) ? tz : DEFAULT_TZ);
    const from = str(url.searchParams.get("from")) ?? today;
    const to = str(url.searchParams.get("to")) ?? localDate(viewNow.getTime() + 30 * 86_400_000, isValidTz(tz) ? tz : DEFAULT_TZ);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      sendJson(res, 400, { error: "from/to must be yyyy-mm-dd with from <= to" });
      return true;
    }
    const layersParam = str(url.searchParams.get("layers"));
    const layers = layersParam ? (layersParam.split(",").map((s) => s.trim()).filter(isLayer) as Layer[]) : undefined;
    const view = calendarView({
      from,
      to,
      layers,
      viewNow,
      tz,
      includeTentative: url.searchParams.get("tentative") !== "0",
      includeProposedRules: url.searchParams.get("proposed") === "1",
    });
    sendJson(res, 200, view);
    return true;
  }

  if (method !== "POST") return false;

  if (path === "/api/calendar/events") {
    const body = await readJsonBody(req);
    const title = str(body.title);
    const startsAt = str(body.starts_at);
    if (!title || !startsAt || Number.isNaN(Date.parse(startsAt))) {
      sendJson(res, 400, { error: "title and an ISO starts_at are required" });
      return true;
    }
    const tz = str(body.tz);
    const ev = createUserEvent(
      {
        title,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: str(body.ends_at),
        tz: tz && isValidTz(tz) ? tz : DEFAULT_TZ,
        allDay: body.all_day === true,
        spaceId: str(body.space_id),
        personEntityId: str(body.person_entity_id),
      },
      now(),
    );
    sendJson(res, 201, { event: ev });
    return true;
  }

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/calendar\/events\/([^/]+)\/(confirm|cancel)$/))) {
    const id = decodeURIComponent(m[1]!);
    const ev = m[2] === "confirm" ? confirmEvent(id, "user", now()) : cancelEvent(id, "user", now());
    if (!ev) sendJson(res, 404, { error: "no such event" });
    else sendJson(res, 200, { event: ev });
    return true;
  }

  if ((m = path.match(/^\/api\/calendar\/rules\/([^/]+)\/(confirm|dismiss)$/))) {
    const id = decodeURIComponent(m[1]!);
    if (m[2] === "dismiss") {
      const r = dismissRule(id, now());
      if (!r) sendJson(res, 404, { error: "no such rule" });
      else sendJson(res, 200, { rule: r });
      return true;
    }
    const body = await readJsonBody(req);
    let edited: RecurrenceRule | undefined;
    const phrase = str(body.phrase);
    if (phrase) {
      const parsed = parseRecurrence(phrase);
      if (!parsed) {
        sendJson(res, 400, { error: `"${phrase}" is not a recurring phrase` });
        return true;
      }
      edited = parsed;
    } else if (body.rule && typeof body.rule === "object") {
      edited = body.rule as RecurrenceRule;
    }
    const r = confirmRule(id, now(), edited);
    if (!r) sendJson(res, 404, { error: "no such rule" });
    else sendJson(res, 200, { rule: r });
    return true;
  }

  if (path === "/api/calendar/dates") {
    const body = await readJsonBody(req);
    const person = str(body.person_entity_id);
    const kind = str(body.kind) as DateKind | null;
    const month = int(body.month);
    const day = int(body.day);
    if (!person || !kind || !DATE_KINDS.includes(kind) || month === null || day === null) {
      sendJson(res, 400, { error: "person_entity_id, kind, month and day are required" });
      return true;
    }
    try {
      const row = upsertPersonDate(
        {
          personEntityId: person,
          kind,
          label: str(body.label),
          month,
          day,
          year: int(body.year),
          mode: body.mode === "plan" || body.mode === "wish" ? body.mode : null,
          leadDays: int(body.lead_days),
          createdBy: "user",
        },
        now(),
      );
      sendJson(res, 201, { date: row });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if ((m = path.match(/^\/api\/calendar\/dates\/([^/]+)\/policy$/))) {
    const id = decodeURIComponent(m[1]!);
    const body = await readJsonBody(req);
    const patch: { mode?: "plan" | "wish" | null; leadDays?: number | null } = {};
    if (body.mode === "plan" || body.mode === "wish" || body.mode === null) patch.mode = body.mode as "plan" | "wish" | null;
    if (body.lead_days === null) patch.leadDays = null;
    else if (int(body.lead_days) !== null) patch.leadDays = int(body.lead_days);
    const row = setPersonDatePolicy(id, patch, "user", now());
    if (!row) sendJson(res, 404, { error: "no such date" });
    else sendJson(res, 200, { date: row });
    return true;
  }

  if ((m = path.match(/^\/api\/calendar\/plans\/([^/]+)\/snooze$/))) {
    const id = decodeURIComponent(m[1]!);
    const body = await readJsonBody(req);
    if (!isSnoozeChoice(body.choice)) {
      sendJson(res, 400, { error: "choice must be next_week | 10_days_before | 3_days_before" });
      return true;
    }
    const r = snoozePlan(id, body.choice, now());
    if (!r) sendJson(res, 404, { error: "no such plan, or that snooze would land on the date itself" });
    else sendJson(res, 200, { plan: r.plan, learned_lead_days: r.learnedLeadDays, options: snoozeOptions(localDate(now().getTime(), DEFAULT_TZ), r.plan.occurrence) });
    return true;
  }

  if ((m = path.match(/^\/api\/calendar\/plans\/([^/]+)\/stop$/))) {
    const id = decodeURIComponent(m[1]!);
    const r = stopPlan(id, now());
    if (!r) sendJson(res, 404, { error: "no such plan" });
    else sendJson(res, 200, { plan: r });
    return true;
  }

  return false;
}
