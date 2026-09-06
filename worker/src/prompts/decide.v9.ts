// ===========================================================================
// decide.v9 — the DECIDE pass prompt (V6 P1 S3.7, Prompts_V6_Phase1 P-05).
//
// One space, its full state, the new committed items. Output only what
// changed: summary · latest · plan · milestones (only if the goal has
// stages) · tasks · closures · schedules · follow-ups · questions.
//
// The SYSTEM text is P-05 verbatim. The OUTPUT block is P-05's shape with two
// code-facing additions the appliers need and the prompt doc leaves to the
// live.decide.tasks shape:
//   - tasks carry "risk_class" — the schedule policy (code) reads the risk of
//     the task a schedule serves; without it every schedule would confirm.
//   - schedules carry "window_opens_at" — the instant the EVIDENCE says the
//     window opens. Code enforces TIM-04 on it: a fire_at before the window
//     is moved to the window (or, with a poll plan, to at most POLL_LEAD_MAX
//     before it). The rule is stated in the prompt AND checked in code.
//
// Validation maps v9 onto the v8 applier shape (chapters ← milestones,
// followups ← follow_ups, closures verdict done|cancelled|check_at ←
// close/suggest_close + outcome) so decide-apply / decide-pass keep one
// code path. Legacy v8 keys (chapters, followups, close/suggest_close) are
// still accepted — the brain tests and older fixtures speak v8.
// ===========================================================================

import {
  RISK_CLASSES,
  TASK_CATEGORIES,
  type DecideClosure,
  type DecideEvidence,
  type DecideTask,
} from "./decide.v1.js";
import {
  validateDecideV8Output,
  type DecideFollowupV8,
  type DecideOutputV8,
  type DecideScheduleV8,
} from "./decide.v8.js";

export const DECIDE_V9_ID = "decide.v9";

/** Prompts_V6_Phase1 P-05 — system prompt, verbatim. */
export const DECIDE_V9_CORE = `You run for ONE space with its full state and the new committed items. Keep it
moving toward its goal. Output only what changed.
RULES
1. Summary: two lines, what is true now. Latest: one line, what just moved.
2. Plan: ordered steps to the goal. Milestones only if the goal has stages.
3. Tasks: explicit (someone said it), implicit (entailed: "flights booked" entails
   "web check-in"), suggested (plan gaps; marked). Owner from roles. Another
   person's task becomes a monitor for the user.
4. Closure needs hard evidence. One-sided intent → "check_at" at the expected time.
   Cancellation → "cancelled".
5. Schedules name a task. Wait-until windows start just before they open with a
   poll plan. Recurrences are expressed as rules and are always "confirm".
   Only a pure read-only time-bound check may be "auto". Never fire early: a
   fire_at is never before the evidence says the window opens (TIM-04).
6. Follow-ups on completion: reminders, checks, cabs, thank-yous, reviews.
7. Past dates from history are never due; they are closure questions.`;

export const DECIDE_V9_OUTPUT = `OUTPUT (one JSON object, nothing else)
{"summary":"…","latest":"…","plan":["…"],"milestones":[{"label":"…","state":"done"|"active"|"todo","episodes":["ep_…"]}],
 "tasks":[{"title":"…","type":"…","owner":"self"|"<person id>"|"unknown","space":"<id>",
   "due":"<ISO or null>","origin":"explicit"|"implicit"|"suggested","steps":["…"],
   "category":"communication|transaction|research|scheduling|filing|creation|monitoring|errand",
   "risk_class":"auto"|"approve-final"|"approve-first"|"advise-only",
   "evidence":[{"event_ids":["e1"],"quote":"<verbatim>"}],"confidence":0.0}],
 "closures":[{"task":"<id or exact title>","verdict":"done"|"cancelled"|"check_at",
   "check_at":"<ISO if check_at>","evidence":[…],"confidence":0.0}],
 "schedules":[{"task":"<id or title>","fire_at":"<ISO>","mode":"auto"|"confirm",
   "window_opens_at":"<ISO the evidence says the window opens, or null>",
   "recurrence":"<rule or omit>","polling":{"interval_min":2,"until":"<ISO>","max":20},
   "reason":"<the math: how fire_at derives from the evidence>","evidence":[…]}],
 "follow_ups":[{"title":"…","after":"<task id>","fire_at":"<ISO or null>"}],
 "questions":[{"kind":"person"|"date"|"amount"|"filing","text":"…","event_ids":["e3"]}]}
Shape notes:
- Milestones are STAGES of the goal (Flights · Stay · Day trips). A one-shot
  goal has none: "milestones":[]. Never a single milestone. Name the new
  episodes a stage receives in its "episodes".
- Every fire_at is an absolute instant with an offset. Do the T-48h / lead-time
  math in the timezone the evidence states (a PDT departure → PDT arithmetic),
  then emit the instant; the user's zone is for rendering, never for the math.
- "window_opens_at" is REQUIRED on a schedule that waits for something to open
  (check-in, tickets, a sale): the instant the evidence says it opens. With a
  poll plan fire_at may lead it by a few minutes; without one fire_at equals it.
- risk_class follows the ACTION: a read-only lookup or check is "auto"; drafting
  is "auto" but sending is "approve-final"; anything paying or booking is
  "approve-final"; a physical errand only the user can do is "advise-only".
- DATES: resolve every relative date with the [CALENDAR] block against the
  MESSAGE timestamp (never today's date). Indian English "day after" (bare) is
  the day after tomorrow. Worked: message Tue 2026-08-25, "by day after" →
  2026-08-27; message Mon 2026-08-24, "by friday" → 2026-08-28. Emit absolute
  dates only; a past date from history is a closure question, never a due.
- Use empty arrays for sections with nothing to say. summary/latest/plan may be
  null when nothing materially changed.`;

export const DECIDE_V9_SYSTEM = `${DECIDE_V9_CORE}\n\n${DECIDE_V9_OUTPUT}`;

// ---------------------------------------------------------------------------
// v9 output types (v8 applier shape + the v9 sections)
// ---------------------------------------------------------------------------

export type MilestoneState = "done" | "active" | "todo";

export interface DecideMilestone {
  label: string;
  state: MilestoneState;
  /** Episode ids this stage receives (DEC-01 routing). */
  episodes: string[];
  target?: string | null;
}

export interface DecideQuestion {
  kind: string;
  text: string;
  event_ids: string[];
}

export interface DecideTaskV9 extends DecideTask {
  /** The space the model filed it under (informational; the pass owns the space). */
  space?: string | null;
  steps: string[];
}

export interface DecideClosureV9 extends DecideClosure {
  /** Set when the model asked for a "check_at" (one-sided intent, rule 4). */
  check_at?: string | null;
  evidence: DecideEvidence[];
}

export interface DecideScheduleV9 extends DecideScheduleV8 {
  /** The instant the evidence says the window opens (TIM-04 anchor). */
  window_opens_at?: string | null;
  evidence: DecideEvidence[];
}

export interface DecideFollowupV9 extends DecideFollowupV8 {
  /** The task this follow-up comes after (id or title). */
  after?: string | null;
  fire_at?: string | null;
}

export interface DecideOutputV9 extends DecideOutputV8 {
  summary: string | null;
  latest: string | null;
  milestones: DecideMilestone[];
  /** Whether the model emitted a milestones section at all (staged goal). */
  staged: boolean;
  tasks: DecideTaskV9[];
  closures: DecideClosureV9[];
  schedules: DecideScheduleV9[];
  followups: DecideFollowupV9[];
  questions: DecideQuestion[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Confidence a hard-evidence closure carries when the model omits a number. */
export const EVIDENCED_CLOSURE_CONFIDENCE = 0.9;
/** Confidence an evidence-less done/cancelled verdict degrades to (a proposal). */
export const UNEVIDENCED_CLOSURE_CONFIDENCE = 0.5;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function evidenceOf(v: unknown): DecideEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: DecideEvidence[] = [];
  for (const e of v) {
    const r = rec(e);
    const quote = str(r.quote);
    if (quote !== null) out.push({ event_ids: strs(r.event_ids), quote });
  }
  return out;
}

/** Hard evidence = at least one verbatim quote that names an event. */
export function hasHardEvidence(evidence: readonly DecideEvidence[]): boolean {
  return evidence.some((e) => e.event_ids.length > 0 && e.quote.trim() !== "");
}

function milestoneOf(raw: unknown): DecideMilestone | null {
  const r = rec(raw);
  const label = str(r.label);
  if (label === null) return null;
  const s = str(r.state) ?? str(r.status);
  const state: MilestoneState = s === "done" ? "done" : s === "todo" || s === "planned" ? "todo" : "active";
  return { label, state, episodes: strs(r.episodes), target: str(r.target) ?? str(r.target_date) };
}

/**
 * Rewrite the v9 raw object into the v8 raw shape the v8/v1 validators read:
 * tasks.origin → type; milestones → chapters; done|cancelled|check_at →
 * close/suggest_close + outcome; follow_ups → followups (+ inline schedule).
 * Legacy v8 keys pass through untouched.
 */
function toV8Raw(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...root };

  if (!Array.isArray(root.chapters) && Array.isArray(root.milestones)) {
    out.chapters = root.milestones
      .map(milestoneOf)
      .filter((m): m is DecideMilestone => m !== null)
      .map((m) => ({
        id: null,
        label: m.label,
        status: m.state,
        episodes: m.episodes,
        target: m.target ?? null,
      }));
  }

  if (Array.isArray(root.tasks)) {
    out.tasks = root.tasks.map((t) => {
      const r = rec(t);
      const origin = str(r.origin);
      const type = str(r.type);
      const v8Type =
        origin === "explicit" || origin === "implicit" || origin === "suggested"
          ? origin
          : type === "explicit" || type === "implicit" || type === "suggested"
            ? type
            : "implicit";
      // A v9 "type" that is not an origin is a free-text kind ("check-in");
      // when it names a category, keep it as the category.
      const category =
        str(r.category) ??
        ((TASK_CATEGORIES as readonly string[]).includes(type ?? "") ? type : null);
      return { ...r, type: v8Type, category };
    });
  }

  if (Array.isArray(root.closures)) {
    out.closures = root.closures.map((c) => {
      const r = rec(c);
      const verdict = str(r.verdict);
      const evidence = evidenceOf(r.evidence);
      const stated = num(r.confidence);
      if (verdict === "done" || verdict === "cancelled") {
        return {
          ...r,
          verdict: "close",
          outcome: verdict,
          confidence:
            stated ?? (hasHardEvidence(evidence) ? EVIDENCED_CLOSURE_CONFIDENCE : UNEVIDENCED_CLOSURE_CONFIDENCE),
        };
      }
      if (verdict === "check_at") {
        return { ...r, v9_verdict: "check_at", verdict: "suggest_close", outcome: str(r.outcome) ?? "done", confidence: stated ?? 0.5 };
      }
      return r;
    });
  }

  if (!Array.isArray(root.followups) && Array.isArray(root.follow_ups)) {
    out.followups = root.follow_ups.map((f) => {
      const r = rec(f);
      const after = str(r.after);
      const fireAt = str(r.fire_at);
      return {
        ...r,
        because: str(r.because) ?? (after !== null ? `after: ${after}` : null),
        due: str(r.due) ?? fireAt,
        ...(fireAt !== null && r.schedule === undefined
          ? {
              schedule: {
                task: str(r.title),
                fire_at: fireAt,
                // A follow-up is a reminder for the user; it never auto-runs.
                mode: "confirm",
                reason: after !== null ? `follow-up after ${after}` : "follow-up",
              },
            }
          : {}),
      };
    });
  }

  return out;
}

/**
 * Validate the parsed JSON into a DecideOutputV9. Throws (repair trigger) only
 * when the top level is not an object; per-entry problems land in `skipped`.
 */
export function validateDecideV9Output(parsed: unknown): DecideOutputV9 {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'expected a single JSON object with "summary", "latest", "plan", "milestones", "tasks", "closures", "schedules", "follow_ups", "questions"',
    );
  }
  const root = parsed as Record<string, unknown>;
  const v8Raw = toV8Raw(root);
  const base = validateDecideV8Output(v8Raw);

  // ---- tasks: steps + space, risk stays v1-validated (unknown → advise-only)
  const rawTasks = Array.isArray(v8Raw.tasks) ? v8Raw.tasks : [];
  const tasks: DecideTaskV9[] = [];
  let tc = 0;
  for (const kept of base.tasks) {
    let raw: Record<string, unknown> = {};
    while (tc < rawTasks.length) {
      const r = rec(rawTasks[tc]);
      tc += 1;
      if (str(r.title) !== null) {
        raw = r;
        break;
      }
    }
    tasks.push({ ...kept, space: str(raw.space), steps: strs(raw.steps) });
  }

  // ---- closures: check_at + evidence
  const rawClosures = Array.isArray(v8Raw.closures) ? v8Raw.closures : [];
  const closures: DecideClosureV9[] = [];
  let cc = 0;
  for (const kept of base.closures) {
    let raw: Record<string, unknown> = {};
    while (cc < rawClosures.length) {
      const r = rec(rawClosures[cc]);
      cc += 1;
      if (str(r.task) !== null) {
        raw = r;
        break;
      }
    }
    const checkAt = str(raw.check_at);
    closures.push({
      ...kept,
      evidence: evidenceOf(raw.evidence),
      // A check_at verdict with no instant still marks the closure as a check
      // (the applier picks a default); a stray check_at on a done verdict is ignored.
      check_at: raw.v9_verdict === "check_at" ? (checkAt ?? "") : null,
    });
  }

  // ---- schedules: window_opens_at + evidence
  const rawSchedules = Array.isArray(v8Raw.schedules) ? v8Raw.schedules : [];
  const schedules: DecideScheduleV9[] = [];
  let sc = 0;
  for (const kept of base.schedules) {
    let raw: Record<string, unknown> = {};
    while (sc < rawSchedules.length) {
      const r = rec(rawSchedules[sc]);
      sc += 1;
      if (str(r.task) !== null) {
        raw = r;
        break;
      }
    }
    schedules.push({
      ...kept,
      window_opens_at: str(raw.window_opens_at) ?? str(raw.window_opens) ?? null,
      evidence: evidenceOf(raw.evidence),
    });
  }

  // ---- follow-ups: after + fire_at
  const rawFollowups = Array.isArray(v8Raw.followups) ? v8Raw.followups : [];
  const followups: DecideFollowupV9[] = [];
  let fc = 0;
  for (const kept of base.followups) {
    let raw: Record<string, unknown> = {};
    while (fc < rawFollowups.length) {
      const r = rec(rawFollowups[fc]);
      fc += 1;
      if (str(r.title) !== null) {
        raw = r;
        break;
      }
    }
    followups.push({ ...kept, after: str(raw.after), fire_at: str(raw.fire_at) });
  }

  const milestones = Array.isArray(root.milestones)
    ? root.milestones.map(milestoneOf).filter((m): m is DecideMilestone => m !== null)
    : [];

  const questions: DecideQuestion[] = [];
  for (const q of Array.isArray(root.questions) ? root.questions : []) {
    const r = rec(q);
    const text = str(r.text);
    if (text === null) continue;
    questions.push({ kind: str(r.kind) ?? "filing", text, event_ids: strs(r.event_ids) });
  }

  // plan: P-05 emits an ordered list of steps; the v1 {next:[…]} shape and
  // null pass through (the applier stores the JSON as-is, on change).
  const plan = Array.isArray(root.plan) ? strs(root.plan) : (root.plan ?? null);

  return {
    ...base,
    plan,
    tasks,
    closures,
    schedules,
    followups,
    summary: str(root.summary),
    latest: str(root.latest),
    milestones,
    staged: Array.isArray(root.milestones) && milestones.length > 0,
    questions,
  };
}

export { RISK_CLASSES, TASK_CATEGORIES };
