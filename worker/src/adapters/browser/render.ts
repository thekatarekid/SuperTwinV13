// ===========================================================================
// Browser visits at RENDER time (V6 P1 S1.4; backlog T6-3, T6-4; SRC-10).
//
// The log keeps every visit — a page reloaded six times in twenty seconds is
// six archive rows, and stays six rows. What the MODEL reads is another
// matter: six identical lines are attention spent on nothing. So the packer
// collapses a run of visits to the same URL within 30 seconds into one line:
//
//   e3–e8 08-28 13:58–13:59 self [browser.visit ×6 · typed · 12 visits all-time] Title https://…
//
// T6-4 decides what the head carries: the TRANSITION ("typed goibibo" is not
// "redirected to goibibo") and the browser's all-time `visit_count`. Never
// `dwell_ms` — 261 of the measured events were 0 and the rest 1–10 ms, a
// number that only ever misleads.
//
// Pure functions over already-loaded rows. Nothing here reads or writes.
// ===========================================================================

export const VISIT_COLLAPSE_MS = 30_000;

/** The minimum a caller has to hand over — the dispatcher's BundleEvent fits. */
export interface RenderableEvent {
  id: string;
  ts: string | null;
  kind: string | null;
  text?: string | null;
  payloadJson?: string | null;
  /** Already-parsed payload wins over `payloadJson` when both are present. */
  payload?: Record<string, unknown> | null;
}

function payloadOf(e: RenderableEvent): Record<string, unknown> {
  if (e.payload && typeof e.payload === "object") return e.payload;
  if (!e.payloadJson) return {};
  try {
    const parsed = JSON.parse(e.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function visitUrl(e: RenderableEvent): string | null {
  if (e.kind !== "browser.visit") return null;
  const url = payloadOf(e).url;
  return typeof url === "string" && url !== "" ? url : null;
}

function tsMs(e: RenderableEvent): number {
  const t = e.ts ? Date.parse(e.ts) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Group a bundle (in its own order) so that consecutive `browser.visit`
 * events to the SAME raw URL, all within `windowMs` of the run's first visit,
 * form one group. Every other event is a group of one. No event is dropped,
 * reordered or merged away — `groups.flat()` is the input.
 */
export function collapseVisitRuns<T extends RenderableEvent>(events: readonly T[], windowMs: number = VISIT_COLLAPSE_MS): T[][] {
  const groups: T[][] = [];
  let run: T[] | null = null;
  let runUrl: string | null = null;
  let runStart = NaN;
  for (const e of events) {
    const url = visitUrl(e);
    const t = tsMs(e);
    if (run && url !== null && url === runUrl && Number.isFinite(t) && Number.isFinite(runStart) && t - runStart <= windowMs && t >= runStart) {
      run.push(e);
      continue;
    }
    run = [e];
    runUrl = url;
    runStart = t;
    groups.push(run);
  }
  return groups;
}

/** "13:58" from an ISO timestamp; "?" when absent. */
export function hhmm(ts: string | null): string {
  if (!ts) return "?";
  const m = /T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : ts;
}

/** "08-28 13:58" from an ISO timestamp — the packer's own short form. */
function shortTs(ts: string | null): string {
  if (!ts) return "?";
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

/**
 * The bracketed head for a visit run: kind, ×N when collapsed, the transitions
 * seen (deduped, in order), and the browser's all-time visit count (T6-4).
 * Never dwell.
 */
export function visitRunHead(run: readonly RenderableEvent[]): string {
  const transitions: string[] = [];
  let visitCount = 0;
  let browser: string | null = null;
  for (const e of run) {
    const p = payloadOf(e);
    if (typeof p.transition === "string" && p.transition !== "" && !transitions.includes(p.transition)) transitions.push(p.transition);
    if (typeof p.visit_count === "number" && p.visit_count > visitCount) visitCount = p.visit_count;
    if (browser === null && typeof p.browser === "string") browser = p.browser;
  }
  const parts = [run.length > 1 ? `browser.visit ×${run.length}` : "browser.visit"];
  if (transitions.length > 0) parts.push(transitions.join("/"));
  if (visitCount > 0) parts.push(`${visitCount} visit${visitCount === 1 ? "" : "s"} all-time`);
  if (browser) parts.push(browser);
  return `[${parts.join(" · ")}]`;
}

/** "13:58–13:59" for a run, or the single time. */
export function visitRunSpan(run: readonly RenderableEvent[]): string {
  const first = run[0]?.ts ?? null;
  const last = run[run.length - 1]?.ts ?? null;
  if (run.length <= 1 || !first || !last || hhmm(first) === hhmm(last)) return shortTs(first);
  return `${shortTs(first)}–${hhmm(last)}`;
}

/** The body: the first event's text (title + stripped URL), capped. */
export function visitRunBody(run: readonly RenderableEvent[], maxChars = 1200): string {
  const first = run[0];
  if (!first) return "";
  const text = typeof first.text === "string" && first.text !== "" ? first.text : String(payloadOf(first).url ?? "");
  return text.slice(0, maxChars);
}

/**
 * One packed line for a visit run — SRC-10's "one packed line, ×6, first–last
 * times". `aliasOf` maps an event to its bundle alias (e1..eN) so a collapsed
 * line still names every alias it stands for.
 */
export function renderVisitRun(run: readonly RenderableEvent[], aliasOf: (e: RenderableEvent) => string, actor = "self"): string {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const alias = run.length > 1 ? `${aliasOf(first)}–${aliasOf(last)}` : aliasOf(first);
  return `${alias} ${visitRunSpan(run)} ${actor} ${visitRunHead(run)} ${visitRunBody(run)}`;
}

/** True when this group is a browser-visit run the visit renderer should own. */
export function isVisitRun(run: readonly RenderableEvent[]): boolean {
  return run.length > 0 && run.every((e) => e.kind === "browser.visit");
}
