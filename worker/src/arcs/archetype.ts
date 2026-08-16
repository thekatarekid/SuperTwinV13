// ===========================================================================
// [CODE] The eight archetypes — arch §11.3, build items 3.6 and 3.7.
//
// An archetype is the SHAPE of a thread, not its subject. "Cooking" is not an
// archetype; "a self-directed recurring activity you do" is. The prior system
// had five shapes and forced every promoted thread into them, which is why a
// flat and a project came out looking the same. Eight fixed shapes, chosen
// from a CLOSED set, and non-determinism never reaches the interface layer.
//
// WHO WRITES IT. `archetype_source` says: `code` is the shape classifier in
// this file (the first-paint default — deterministic, no model call), `model`
// is P-SP1 (item 3.7, deferred, never on the paint path), `user` is a person
// correcting it. A user's choice is a hard wall: `code` never overwrites it.
//
// ARCHETYPE IS REVISABLE. "Learning guitar" is a `pursuit` until there is a
// recital date, and then it is a `project`. `reviseArchetype` is the only way
// the field changes, and it always returns the transition — from, to, reason —
// so the change is recorded rather than silently applied (evals P-049).
//
// PURSUIT vs WATCH is one question: **do you act, or do you observe?** The
// tell is mechanical — if the evidence is mostly the user's OWN events it is a
// pursuit; if it is mostly things arriving AT them it is a watch. That is
// `ownEventRatio`, and it is counted, never guessed.
// ===========================================================================

/** §11.3's closed set. Stored as the three-letter code; there is no ninth. */
export const ARCHETYPES = ["prj", "evt", "rhy", "adm", "hld", "mat", "pur", "wch"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

const ARCHETYPE_SET: ReadonlySet<string> = new Set(ARCHETYPES);

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === "string" && ARCHETYPE_SET.has(value);
}

/** The product's word for each code. The UI renders these, never the code. */
export const ARCHETYPE_NAMES: Readonly<Record<Archetype, string>> = {
  prj: "project",
  evt: "event",
  rhy: "rhythm",
  adm: "admin",
  hld: "holding",
  mat: "matter",
  pur: "pursuit",
  wch: "watch",
};

export const ARCHETYPE_BY_NAME: Readonly<Record<string, Archetype>> = Object.freeze(
  Object.fromEntries(Object.entries(ARCHETYPE_NAMES).map(([code, name]) => [name, code as Archetype])),
);

/** Accepts the code or the product word — a fixture and a UI spell it differently. */
export function toArchetype(value: unknown): Archetype | null {
  if (isArchetype(value)) return value;
  if (typeof value === "string" && value in ARCHETYPE_BY_NAME) return ARCHETYPE_BY_NAME[value]!;
  return null;
}

export function archetypeName(code: Archetype): string {
  return ARCHETYPE_NAMES[code];
}

/** §11.3's icon + accent table, kept beside the codes so no surface re-invents it. */
export const ARCHETYPE_DISPLAY: Readonly<
  Record<Archetype, { icon: string; accent: string; shape: string }>
> = {
  prj: { icon: "🎯", accent: "indigo", shape: "an outcome with a span and many steps" },
  evt: { icon: "📅", accent: "amber", shape: "a single point in time approaching" },
  rhy: { icon: "🔁", accent: "green", shape: "a recurring commitment to others" },
  adm: { icon: "🧾", accent: "slate", shape: "a recurring external duty with a ledger" },
  hld: { icon: "📦", accent: "stone", shape: "a durable thing you own or inhabit" },
  mat: { icon: "🌀", accent: "rose", shape: "an unresolved situation with no fixed end" },
  pur: { icon: "🌱", accent: "lime", shape: "a self-directed recurring activity you do" },
  wch: { icon: "👁", accent: "teal", shape: "a topic you follow without doing" },
};

/** Who chose the archetype. `code` is this file; `model` is P-SP1; `user` wins. */
export const ARCHETYPE_SOURCES = ["code", "model", "user"] as const;
export type ArchetypeSource = (typeof ARCHETYPE_SOURCES)[number];

export function isArchetypeSource(value: unknown): value is ArchetypeSource {
  return value === "code" || value === "model" || value === "user";
}

// ---- the shape -------------------------------------------------------------

/**
 * Everything the classifier is allowed to look at. Every field is a COUNT or a
 * BOOLEAN derived elsewhere — no text, no label, no subject. That is the whole
 * point: the shape decides, and "is this about cooking" can never leak in.
 */
export interface ArchetypeShape {
  /** The promotion route that qualified, when there is one. */
  route?: string | null;
  /** A stated outcome the thread is working toward. */
  hasOutcome?: boolean;
  /** Distinct steps toward that outcome — loops, milestones, stages. */
  stepCount?: number;
  /** A fixed end point: a wedding date, a lease expiry, a recital. */
  endsAt?: string | null;
  /** `one_time` or `recurring` — the arc's own cadence field. */
  cadence?: string | null;
  /** Evidence repeats on a schedule (a recurrence string, or a rec-route arc). */
  recurring?: boolean;
  /** Who the recurrence is owed to. `none` means nobody — it is yours alone. */
  obligationTo?: "none" | "person" | "org" | null;
  /** Amounts, invoices, dues, receipts — a ledger the duty is tracked in. */
  hasLedger?: boolean;
  /** Anchored on a durable thing reached by a `has`/`located_at` edge from me. */
  durableAnchor?: boolean;
  /** Share of the evidence that is the user's OWN events. Act, or observe. */
  ownEventRatio?: number | null;
  /** Loops still open on the thread. */
  openLoops?: number;
}

export interface ArchetypeVerdict {
  archetype: Archetype | null;
  source: ArchetypeSource;
  /** The rule that fired, named so "why this shape?" answers without guessing. */
  rule: string;
}

const num = (value: number | null | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** "Do you act, or do you observe?" — the only question that splits these two. */
export function actOrObserve(ownEventRatio: number | null | undefined): "pur" | "wch" {
  return num(ownEventRatio, 0) >= 0.5 ? "pur" : "wch";
}

/**
 * The `[CODE]` classifier: first paint, deterministic, zero model calls. The
 * order is the argument — each rule is written so the shape it names cannot
 * also satisfy an earlier one.
 */
export function classifyArchetype(shape: ArchetypeShape): ArchetypeVerdict {
  const steps = num(shape.stepCount, 0);
  const openLoops = num(shape.openLoops, 0);
  const recurring = shape.recurring === true || shape.cadence === "recurring";
  const obligation = shape.obligationTo ?? null;
  const owed = obligation === "person" || obligation === "org";

  // A single dated point, nothing recurring, nothing to build up to. A wedding,
  // a flight, an appointment: the date arrives and the thread is over.
  if (shape.endsAt != null && !recurring && steps <= 1 && shape.durableAnchor !== true) {
    return { archetype: "evt", source: "code", rule: "single_date_approaching" };
  }

  // An outcome with steps — a span you are working across. Checked before the
  // recurring shapes so a recital date on a weekly habit reads as a project.
  if (shape.hasOutcome === true && steps >= 2) {
    return { archetype: "prj", source: "code", rule: "outcome_with_steps" };
  }

  // A recurring duty with a ledger is admin whether or not anyone is waiting.
  if (recurring && shape.hasLedger === true) {
    return { archetype: "adm", source: "code", rule: "recurring_duty_with_ledger" };
  }

  // A recurring commitment TO SOMEONE. The obligation is what separates a
  // rhythm from a pursuit: both repeat, only one is owed.
  if (recurring && owed) {
    return { archetype: "rhy", source: "code", rule: "recurring_commitment_to_others" };
  }

  // A durable thing you own or inhabit, with nothing being built on it.
  if (shape.durableAnchor === true && shape.hasOutcome !== true) {
    return { archetype: "hld", source: "code", rule: "durable_thing_owned_or_inhabited" };
  }

  // Repeating, owed to nobody → act or observe.
  if (recurring || shape.route === "rec") {
    const archetype = actOrObserve(shape.ownEventRatio);
    return {
      archetype,
      source: "code",
      rule: archetype === "pur" ? "self_directed_recurring_activity" : "followed_without_doing",
    };
  }

  // Open, no fixed end, no rhythm: a situation rather than a plan.
  if (openLoops >= 1 && shape.endsAt == null) {
    return { archetype: "mat", source: "code", rule: "unresolved_no_fixed_end" };
  }

  if (shape.route === "ref") return { archetype: "hld", source: "code", rule: "reference_route_default" };
  if (shape.route === "cmt") return { archetype: "mat", source: "code", rule: "commitment_route_default" };

  // Unknown beats wrong: an unpromoted or shapeless thread carries no archetype.
  return { archetype: null, source: "code", rule: "no_shape" };
}

// ---- revision --------------------------------------------------------------

export interface ArchetypeTransition {
  from: Archetype | null;
  to: Archetype;
  reason: string;
  source: ArchetypeSource;
}

export interface ArchetypeRevision {
  archetype: Archetype | null;
  source: ArchetypeSource;
  changed: boolean;
  /** Present exactly when `changed` — this is the record §11.3 asks for. */
  transition: ArchetypeTransition | null;
  /** Set when a lower-authority source tried to overwrite a higher one. */
  blocked: boolean;
}

const AUTHORITY: Readonly<Record<ArchetypeSource, number>> = { code: 0, model: 1, user: 2 };

export interface ReviseParams {
  current: Archetype | null;
  currentSource?: ArchetypeSource | null;
  next: Archetype | null;
  nextSource: ArchetypeSource;
  reason?: string;
}

/**
 * The only way `archetype` changes. A revision from a weaker source than the
 * one already on the row is REFUSED, not silently applied — `code` may not
 * undo a person's correction, and P-SP1 may not undo it either.
 */
export function reviseArchetype(params: ReviseParams): ArchetypeRevision {
  const currentSource: ArchetypeSource = isArchetypeSource(params.currentSource)
    ? params.currentSource
    : "code";
  const { current, next, nextSource } = params;

  if (next === null || next === current) {
    return { archetype: current, source: currentSource, changed: false, transition: null, blocked: false };
  }
  if (current !== null && AUTHORITY[nextSource] < AUTHORITY[currentSource]) {
    return { archetype: current, source: currentSource, changed: false, transition: null, blocked: true };
  }
  return {
    archetype: next,
    source: nextSource,
    changed: true,
    blocked: false,
    transition: {
      from: current,
      to: next,
      reason: params.reason ?? "shape changed",
      source: nextSource,
    },
  };
}

/** One line a surface can render: `pursuit → project (a recital date was set)`. */
export function describeTransition(t: ArchetypeTransition): string {
  const from = t.from === null ? "unshaped" : ARCHETYPE_NAMES[t.from];
  return `${from} → ${ARCHETYPE_NAMES[t.to]} (${t.reason})`;
}
