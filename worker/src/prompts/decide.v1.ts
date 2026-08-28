// ===========================================================================
// DECIDE v1 (build P1.4, spec §8.4) — the per-space reduce pass. Sonnet-class
// recommended, Haiku by default (build convention 7).
//
// The SYSTEM core is the spec §8.4 text VERBATIM (v1). P1 SCOPE (build P1.4):
// chapters, tasks, closures, plan are ACTED ON; schedules and follow-ups are
// EMITTED by the model and validated here, but the runner holds them as
// `deferred` rows — they activate in P3, never in P1.
// ===========================================================================

export const DECIDE_V1_ID = "decide.v1";

/** Spec §8.4 "System (core)" — verbatim. */
export const DECIDE_V1_CORE = `You run for ONE space with its full state and its new committed
episodes (all sources, time-ordered). Produce:
1. CHAPTERS: group this space's episodes into cross-stream sub-goal
   chapters ("Flights","Stay"). Create sparingly; single-shot spaces
   need none. Chapters with dates are the milestones.
2. TASKS: explicit / implicit (entailed) / suggested (from plan gaps;
   ≤2/day/space; clearly marked). Fields: title, type, category
   (communication|transaction|research|scheduling|filing|creation|
   monitoring|errand), risk class (auto|approve-final|approve-first|
   advise-only — conservative: anything moving money or messaging
   people is never auto), owner (resolved; others' tasks are not the
   user's — at most a monitoring item), due (absolute), evidence.
3. SCHEDULES: emit schedule candidates when time windows are computable
   (check-in opens T-48h; ticket window 10am → poll 09:55; traffic
   check with lead time). mode=auto ONLY if action is auto-class AND
   intent is high-confidence AND value is time-bound; else confirm.
4. CLOSURES: two-sided/hard evidence → close (≥0.85). One-sided intent
   → suggest_close only. Similar-but-different ≠ close. Cancellation
   closes as cancelled, never done. False close = data loss.
5. FOLLOW-UPS: when a task just closed (by us or by the user), propose
   the 1–2 most helpful next tasks from the plan ("because: flights
   booked ✓"). Same auto/confirm policy.
6. PLAN: update goal → chapters → next actions when materially changed.
Age-band policy is hard. JSON only.`;

/** v1 output contract (the spec §8.4 example, pinned as a schema). */
export const DECIDE_V1_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
{"space":"sp_x",
 "chapters":[{"id":"existing ch_ id or null","label":"Flights","status":"active",
   "episodes":["ep_412"],"target":"2026-08-29"}],
 "tasks":[{"title":"…","type":"explicit","category":"transaction",
   "risk_class":"approve-final","owner":"self","chapter":"Flights",
   "due":"2026-08-29","evidence":[{"event_ids":["e1"],"quote":"…"}],
   "confidence":0.9}],
 "schedules":[{"task":"…","fire_at":"2026-12-16T07:00+05:30","mode":"auto",
   "reason":"…"}],
 "closures":[{"task":"tsk_x or exact task title","verdict":"close",
   "outcome":"done","reason":"…","confidence":0.9}],
 "followups":[{"title":"…","because":"…"}],
 "plan":{"next":["…"]}}
closures.verdict is "close" or "suggest_close"; closures.outcome is "done" or
"cancelled". Use empty arrays for sections with nothing to say; plan may be
null when nothing materially changed.`;

/** The byte-stable system prompt for the decide.v1 pass. */
export const DECIDE_V1_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V1_OUTPUT}`;

// ---------------------------------------------------------------------------
// Output types + tolerant validation
// ---------------------------------------------------------------------------

export interface DecideEvidence {
  event_ids: string[];
  quote: string;
}

export interface DecideChapter {
  id?: string | null;
  label: string;
  status: string; // active|done|dropped
  episodes: string[];
  target?: string | null;
}

export const TASK_CATEGORIES = [
  "communication",
  "transaction",
  "research",
  "scheduling",
  "filing",
  "creation",
  "monitoring",
  "errand",
] as const;

export const RISK_CLASSES = ["auto", "approve-final", "approve-first", "advise-only"] as const;

export interface DecideTask {
  title: string;
  type: "explicit" | "implicit" | "suggested";
  category: string | null;
  risk_class: (typeof RISK_CLASSES)[number];
  owner: string; // 'self' or roster ref
  chapter?: string | null;
  due?: string | null;
  evidence: DecideEvidence[];
  confidence: number;
}

export interface DecideSchedule {
  task: string;
  fire_at?: string | null;
  recurrence?: string | null;
  mode: "auto" | "confirm";
  reason?: string | null;
}

export interface DecideClosure {
  task: string; // task id or exact title
  verdict: "close" | "suggest_close";
  outcome: "done" | "cancelled";
  reason?: string | null;
  confidence: number;
}

export interface DecideFollowup {
  title: string;
  because?: string | null;
}

export interface DecideOutput {
  space?: string | null;
  chapters: DecideChapter[];
  tasks: DecideTask[];
  schedules: DecideSchedule[];
  closures: DecideClosure[];
  followups: DecideFollowup[];
  plan: unknown | null;
  skipped: { section: string; entry: unknown; reason: string }[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function evidenceOf(v: unknown): DecideEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: DecideEvidence[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const quote = str(r.quote);
    const ids = Array.isArray(r.event_ids)
      ? r.event_ids.filter((x): x is string => typeof x === "string")
      : [];
    if (quote !== null) out.push({ event_ids: ids, quote });
  }
  return out;
}

/**
 * Validate the parsed JSON into a DecideOutput. Throws (repair trigger) only
 * when the top level is not an object; per-entry problems land in `skipped`.
 */
export function validateDecideOutput(parsed: unknown): DecideOutput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'expected a single JSON object with "chapters", "tasks", "schedules", "closures", "followups", "plan"',
    );
  }
  const root = parsed as Record<string, unknown>;
  const out: DecideOutput = {
    space: str(root.space),
    chapters: [],
    tasks: [],
    schedules: [],
    closures: [],
    followups: [],
    plan: root.plan ?? null,
    skipped: [],
  };

  for (const c of Array.isArray(root.chapters) ? root.chapters : []) {
    const r = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const label = str(r.label);
    if (label === null) {
      out.skipped.push({ section: "chapters", entry: c, reason: "missing label" });
      continue;
    }
    out.chapters.push({
      id: str(r.id),
      label,
      status: str(r.status) ?? "active",
      episodes: Array.isArray(r.episodes)
        ? r.episodes.filter((x): x is string => typeof x === "string")
        : [],
      target: str(r.target),
    });
  }

  for (const t of Array.isArray(root.tasks) ? root.tasks : []) {
    const r = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const title = str(r.title);
    if (title === null) {
      out.skipped.push({ section: "tasks", entry: t, reason: "missing title" });
      continue;
    }
    const typeRaw = str(r.type);
    const type = typeRaw === "explicit" || typeRaw === "suggested" ? typeRaw : "implicit";
    const riskRaw = str(r.risk_class);
    // Conservative on nonsense: an unknown risk class degrades to advise-only,
    // it NEVER degrades to auto (spec §8.4.2).
    const risk_class = (RISK_CLASSES as readonly string[]).includes(riskRaw ?? "")
      ? (riskRaw as DecideTask["risk_class"])
      : "advise-only";
    const category = str(r.category);
    out.tasks.push({
      title,
      type,
      category: (TASK_CATEGORIES as readonly string[]).includes(category ?? "") ? category : null,
      risk_class,
      owner: str(r.owner) ?? "self",
      chapter: str(r.chapter),
      due: str(r.due),
      evidence: evidenceOf(r.evidence),
      confidence: num(r.confidence) ?? 0.5,
    });
  }

  for (const s of Array.isArray(root.schedules) ? root.schedules : []) {
    const r = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    const task = str(r.task);
    if (task === null) {
      out.skipped.push({ section: "schedules", entry: s, reason: "missing task" });
      continue;
    }
    out.schedules.push({
      task,
      fire_at: str(r.fire_at),
      recurrence: str(r.recurrence),
      // Conservative on nonsense: anything not exactly "auto" confirms.
      mode: str(r.mode) === "auto" ? "auto" : "confirm",
      reason: str(r.reason),
    });
  }

  for (const c of Array.isArray(root.closures) ? root.closures : []) {
    const r = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const task = str(r.task);
    if (task === null) {
      out.skipped.push({ section: "closures", entry: c, reason: "missing task ref" });
      continue;
    }
    out.closures.push({
      task,
      // Conservative on nonsense: anything not exactly "close" only suggests.
      verdict: str(r.verdict) === "close" ? "close" : "suggest_close",
      outcome: str(r.outcome) === "cancelled" ? "cancelled" : "done",
      reason: str(r.reason),
      confidence: num(r.confidence) ?? 0,
    });
  }

  for (const f of Array.isArray(root.followups) ? root.followups : []) {
    const r = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
    const title = str(r.title);
    if (title === null) {
      out.skipped.push({ section: "followups", entry: f, reason: "missing title" });
      continue;
    }
    out.followups.push({ title, because: str(r.because) });
  }

  return out;
}
