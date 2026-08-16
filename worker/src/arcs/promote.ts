// ===========================================================================
// [CODE] PROMOTION — an arc becomes a space. Arch §11.3, build item 3.6.
//
// ⚠ THERE IS NO `spaces` TABLE AND THERE NEVER WILL BE. "Space" is the
// product's word for `arc WHERE promoted`. Promotion writes FIELDS on `arcs` —
// promoted, promotion_reason, archetype, archetype_source, status, ends_at,
// cadence, user_label — and nothing else. No row is created on promotion, no
// row is deleted on demotion, and the id never changes. Demotion is the same
// fields flipping back. This is the whole reason the prior system's id-sync
// bug class does not exist here (evals P-030).
//
// FOUR ROUTES, ANY ONE OF WHICH IS ENOUGH:
//
//   ⚑ cmt COMMITMENT  holds ≥1 loop in state `open`
//   ⚓ ref REFERENCE   anchored on a durable entity reached by a `has` or
//                     `located_at` edge FROM me — "my flat", "my car"
//   ↻ rec RECURRENCE  ≥3 episodes · ≥3 distinct days · spanning ≥2 weeks ·
//                     the user participated                (cap ~10 live)
//   📌 usr USER        explicitly pinned
//
// The reference route is the one a loop-only system cannot see at all: a flat
// generates no commitment, so it never became a space, so every fact about it
// scattered. Recurrence is the other: a hobby has no due date and no
// counterparty, and a loop-only system files it as noise.
//
// ⚠ PARTY RULE — THE HARD WALL. An arc whose loops carry no `s` in either
// position of `party_pair` is NOT a space. It is context on the person it is
// about, and it belongs on their People record. This single boolean is what
// kills the prior system's "8 spaces that were really other people's lives",
// so it is checked BEFORE any route and it is not a score.
//
// STATUS is derived from member loops on every reconcile, never stored by a
// model: ≥1 open → active · latent only → dormant · all done/lapsed/dropped →
// archived (retrievable, not surfaced) · a loopless ref/rec space → active
// while the evidence is fresh, dormant after 8 weeks quiet.
//
// `promotion_reason` is recorded on every promoted arc so "why is this a
// space?" always answers, with the route AND the loops behind it.
// ===========================================================================

import { pairInvolvesSelf, resolveLoopPair, type PartyPair, type PartySession } from "../entities/party.js";
import { classifyArchetype, type Archetype, type ArchetypeShape, type ArchetypeSource } from "./archetype.js";

// ---- the closed sets -------------------------------------------------------

/** §11.3's four routes. `promotion_reason` is always one of these or NULL. */
export const PROMOTION_ROUTES = ["cmt", "ref", "rec", "usr"] as const;
export type PromotionRoute = (typeof PROMOTION_ROUTES)[number];

const ROUTE_SET: ReadonlySet<string> = new Set(PROMOTION_ROUTES);

export function isPromotionRoute(value: unknown): value is PromotionRoute {
  return typeof value === "string" && ROUTE_SET.has(value);
}

/**
 * Which route gets RECORDED when several qualify. Promotion itself is an OR —
 * this only decides the sentence the UI renders, so the most concrete
 * justification wins: an open loop beats an anchor beats a rhythm beats a pin.
 */
export const ROUTE_PRECEDENCE: readonly PromotionRoute[] = ["cmt", "ref", "rec", "usr"];

export const ROUTE_MARKERS: Readonly<Record<PromotionRoute, string>> = {
  cmt: "⚑",
  ref: "⚓",
  rec: "↻",
  usr: "📌",
};

export const ROUTE_NAMES: Readonly<Record<PromotionRoute, string>> = {
  cmt: "commitment",
  ref: "reference",
  rec: "recurrence",
  usr: "user",
};

/** `arcs.status` — the SPACE's state, derived from member loops. */
export const SPACE_STATUSES = ["active", "dormant", "archived"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** `arcs.cadence` (§11.3 item 4). */
export const CADENCES = ["one_time", "recurring"] as const;
export type Cadence = (typeof CADENCES)[number];

/** The recurrence route's four bars, from §11.3. Not one of them is optional. */
export const REC_MIN_EPISODES = 3;
export const REC_MIN_DISTINCT_DAYS = 3;
export const REC_MIN_SPAN_DAYS = 14;
/** "cap ~10 live" — recurrence-only spaces beyond this stay browsable threads. */
export const REC_LIVE_CAP = 10;

/** A loopless ref/rec space goes quiet after this long without evidence. */
export const SPACE_QUIET_WEEKS = 8;

const DAY_MS = 86_400_000;
const SPACE_QUIET_MS = SPACE_QUIET_WEEKS * 7 * DAY_MS;

/** §6's edge kinds that mean "mine" — `has` absorbs owns/subscribes. */
export const REFERENCE_EDGE_KINDS = ["has", "located_at"] as const;

/** A person is never a durable anchor: that is a relationship, not a holding. */
export const NON_DURABLE_ANCHOR_TYPES: readonly string[] = ["person"];

// ---- the inputs ------------------------------------------------------------

export interface PromotionLoop {
  id?: string;
  state?: string | null;
  origin?: string | null;
  partyPair?: string | null;
  party_pair?: string | null;
  ownerId?: string | null;
  counterpartyId?: string | null;
  recurrence?: string | null;
  dueUtc?: string | null;
}

export interface PromotionEpisode {
  id: string;
  /** The episode clock. `ingested_at` is never read, here or anywhere (rule 8). */
  startedAt?: string | null;
  entityIds?: readonly string[] | null;
  /** Set when the world already knows; otherwise derived from `entityIds`. */
  selfParticipated?: boolean;
  /** True when the evidence is the user's own doing rather than arriving at them. */
  userAuthored?: boolean;
}

/** An active `has`/`located_at` edge FROM me, already resolved to its target. */
export interface PromotionEdge {
  entityId: string;
  kind: string;
  subtype?: string | null;
  status?: string | null;
  /** The target's entity type — a person can never be a durable anchor. */
  entityType?: string | null;
}

export interface PromotionInput {
  arcId: string;
  anchorEntityIds?: readonly string[] | null;
  loops?: readonly PromotionLoop[] | null;
  episodes?: readonly PromotionEpisode[] | null;
  /** Edges whose source is `me`. Anything else is not a reference to MY thing. */
  selfEdges?: readonly PromotionEdge[] | null;
  userPinned?: boolean;
  lastEvidenceAt?: string | null;
  /** What the row says today — used to keep an archived space retrievable. */
  wasPromoted?: boolean;
  previousReason?: PromotionRoute | null;
  archetype?: Archetype | null;
  archetypeSource?: ArchetypeSource | null;
  cadence?: Cadence | null;
  endsAt?: string | null;
  /** Extra shape signals the classifier cannot count for itself (item 3.7). */
  shape?: ArchetypeShape;
  session?: PartySession;
  now?: number | string | Date;
}

// ---- clocks ----------------------------------------------------------------

function toMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function nowMs(now: PromotionInput["now"]): number {
  return toMs(now) ?? Date.now();
}

/** The calendar day an ISO timestamp falls on, for "≥3 distinct days". */
function dayKey(iso: string): string | null {
  const ms = toMs(iso);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

// ---- the party wall --------------------------------------------------------

export interface PartyGate {
  pairs: (PartyPair | null)[];
  involvesSelf: boolean;
  /** True when the arc must not be promoted by ANY route. */
  blocked: boolean;
  reason: "self_involved" | "no_loops" | "no_self_in_any_loop";
  livesOn: "space" | "people_record" | "thread";
}

/**
 * §11.3's ⚠ PARTY RULE. A thread with loops, none of which carry an `s`, is
 * blocked outright — no route may rescue it. A thread with NO loops is not
 * blocked: the ref, rec and usr routes each carry their own evidence that the
 * thread is the user's (an edge from me, participation, a pin), and a flat
 * with no open loop is exactly the case the loop-only system missed.
 */
export function partyGate(
  loops: readonly PromotionLoop[] | null | undefined,
  session: PartySession = {},
): PartyGate {
  const list = loops ?? [];
  const pairs = list.map((loop) => resolveLoopPair(loop, session));
  const involvesSelf = pairs.some((pair) => pairInvolvesSelf(pair));
  if (list.length === 0) {
    return { pairs, involvesSelf: false, blocked: false, reason: "no_loops", livesOn: "thread" };
  }
  if (involvesSelf) {
    return { pairs, involvesSelf: true, blocked: false, reason: "self_involved", livesOn: "space" };
  }
  return {
    pairs,
    involvesSelf: false,
    blocked: true,
    reason: "no_self_in_any_loop",
    livesOn: "people_record",
  };
}

// ---- the four routes -------------------------------------------------------

export interface RouteEvidence {
  route: PromotionRoute;
  qualifies: boolean;
  /** The sentence "why is this a space?" renders. Always populated. */
  detail: string;
  /** The counted facts behind the verdict — never a re-derivation in a UI. */
  facts: Record<string, number | string | boolean | null>;
}

/** ⚑ cmt — holds ≥1 loop in state `open` that is the user's own. */
export function commitmentRoute(input: PromotionInput): RouteEvidence {
  const session = input.session ?? {};
  const open = (input.loops ?? []).filter(
    (loop) => loop.state === "open" && pairInvolvesSelf(resolveLoopPair(loop, session)),
  );
  return {
    route: "cmt",
    qualifies: open.length > 0,
    detail:
      open.length > 0
        ? `${open.length} open loop${open.length === 1 ? "" : "s"} you are on the hook for`
        : "no open loop involving you",
    facts: { open_loops: open.length },
  };
}

/** ⚓ ref — anchored on a durable entity reached by `has`/`located_at` from me. */
export function referenceRoute(input: PromotionInput): RouteEvidence {
  const anchors = new Set(input.anchorEntityIds ?? []);
  const kinds: ReadonlySet<string> = new Set(REFERENCE_EDGE_KINDS);
  const matches = (input.selfEdges ?? []).filter(
    (edge) =>
      kinds.has(edge.kind) &&
      (edge.status ?? "active") === "active" &&
      anchors.has(edge.entityId) &&
      !NON_DURABLE_ANCHOR_TYPES.includes(edge.entityType ?? ""),
  );
  const first = matches[0];
  return {
    route: "ref",
    qualifies: matches.length > 0,
    detail: first
      ? `anchored on a durable thing you have a ${first.kind} relation to`
      : "no has/located_at edge from you to a durable anchor",
    facts: {
      anchors: anchors.size,
      matching_edges: matches.length,
      edge_kind: first?.kind ?? null,
      edge_subtype: first?.subtype ?? null,
      anchor_entity_id: first?.entityId ?? null,
    },
  };
}

export interface RecurrenceCounts {
  episodes: number;
  distinctDays: number;
  spanDays: number;
  userParticipated: boolean;
}

/** The rec route's four counts, exposed so a surface can show the bars. */
export function recurrenceCounts(
  episodes: readonly PromotionEpisode[] | null | undefined,
  session: PartySession = {},
): RecurrenceCounts {
  const list = episodes ?? [];
  const days = new Set<string>();
  let earliest: number | null = null;
  let latest: number | null = null;
  let participated = false;
  const self = session.selfEntityId ?? null;
  for (const ep of list) {
    const ms = toMs(ep.startedAt);
    if (ms !== null) {
      const key = dayKey(ep.startedAt!);
      if (key !== null) days.add(key);
      earliest = earliest === null || ms < earliest ? ms : earliest;
      latest = latest === null || ms > latest ? ms : latest;
    }
    if (ep.selfParticipated === true) participated = true;
    else if (self !== null && (ep.entityIds ?? []).includes(self)) participated = true;
  }
  const spanDays =
    earliest === null || latest === null ? 0 : Math.floor((latest - earliest) / DAY_MS);
  return { episodes: list.length, distinctDays: days.size, spanDays, userParticipated: participated };
}

/** ↻ rec — ≥3 episodes · ≥3 distinct days · ≥2 weeks · the user participated. */
export function recurrenceRoute(input: PromotionInput): RouteEvidence {
  const c = recurrenceCounts(input.episodes, input.session ?? {});
  const qualifies =
    c.episodes >= REC_MIN_EPISODES &&
    c.distinctDays >= REC_MIN_DISTINCT_DAYS &&
    c.spanDays >= REC_MIN_SPAN_DAYS &&
    c.userParticipated;
  return {
    route: "rec",
    qualifies,
    detail: qualifies
      ? `${c.episodes} episodes across ${c.distinctDays} days over ${c.spanDays} days, you took part`
      : `${c.episodes}/${REC_MIN_EPISODES} episodes · ${c.distinctDays}/${REC_MIN_DISTINCT_DAYS} days · ` +
        `${c.spanDays}/${REC_MIN_SPAN_DAYS} day span · participated=${c.userParticipated}`,
    facts: { ...c },
  };
}

/** 📌 usr — the user said so. No amount of evidence overrules a person. */
export function userRoute(input: PromotionInput): RouteEvidence {
  const pinned = input.userPinned === true;
  return {
    route: "usr",
    qualifies: pinned,
    detail: pinned ? "you pinned this thread" : "not pinned",
    facts: { user_pinned: pinned },
  };
}

export function evaluateRoutes(input: PromotionInput): Record<PromotionRoute, RouteEvidence> {
  return {
    cmt: commitmentRoute(input),
    ref: referenceRoute(input),
    rec: recurrenceRoute(input),
    usr: userRoute(input),
  };
}

// ---- status ----------------------------------------------------------------

export interface StatusVerdict {
  status: SpaceStatus;
  reason:
    | "open_loop"
    | "latent_only"
    | "all_loops_resolved"
    | "loopless_fresh"
    | "loopless_quiet";
}

/**
 * §11.3's status table, in order. A loopless space (ref/rec/usr) has no loops
 * to read, so it is `active` while the evidence is fresh and `dormant` after
 * eight weeks of quiet — the clock, never a model.
 */
export function deriveStatus(input: PromotionInput): StatusVerdict {
  const loops = input.loops ?? [];
  if (loops.some((l) => l.state === "open")) return { status: "active", reason: "open_loop" };
  if (loops.some((l) => l.state === "latent")) return { status: "dormant", reason: "latent_only" };
  if (loops.length > 0) return { status: "archived", reason: "all_loops_resolved" };

  const last = toMs(input.lastEvidenceAt);
  if (last === null) return { status: "active", reason: "loopless_fresh" };
  const quiet = nowMs(input.now) - last;
  return quiet <= SPACE_QUIET_MS
    ? { status: "active", reason: "loopless_fresh" }
    : { status: "dormant", reason: "loopless_quiet" };
}

// ---- the verdict -----------------------------------------------------------

export interface PromotionVerdict {
  arcId: string;
  promoted: boolean;
  promotionReason: PromotionRoute | null;
  /** Every route that qualified, in precedence order. Promotion is an OR. */
  routes: PromotionRoute[];
  evidence: Record<PromotionRoute, RouteEvidence>;
  status: SpaceStatus | null;
  statusReason: StatusVerdict["reason"] | null;
  party: PartyGate;
  /** `space` · `people_record` (the party wall) · `thread` (nothing qualified). */
  livesOn: PartyGate["livesOn"];
  archetype: Archetype | null;
  archetypeSource: ArchetypeSource | null;
  archetypeRule: string | null;
  cadence: Cadence | null;
  endsAt: string | null;
  /** True when a previously promoted arc is being un-promoted (a field flip). */
  demoted: boolean;
  /** True when nothing qualifies but the arc stays a retrievable archived space. */
  retained: boolean;
}

/** The archetype shape, assembled from what promotion already counted. */
function shapeOf(input: PromotionInput, routes: PromotionRoute[]): ArchetypeShape {
  const loops = input.loops ?? [];
  const episodes = input.episodes ?? [];
  const authored = episodes.filter((e) => e.userAuthored === true).length;
  const known = episodes.filter((e) => e.userAuthored !== undefined).length;
  const ref = referenceRoute(input);
  const supplied = input.shape ?? {};
  return {
    route: routes[0] ?? null,
    openLoops: loops.filter((l) => l.state === "open").length,
    stepCount: supplied.stepCount ?? loops.length,
    recurring:
      supplied.recurring ??
      (input.cadence === "recurring" || loops.some((l) => (l.recurrence ?? "") !== "")),
    cadence: input.cadence ?? null,
    endsAt: input.endsAt ?? null,
    durableAnchor: supplied.durableAnchor ?? ref.qualifies,
    ownEventRatio: supplied.ownEventRatio ?? (known > 0 ? authored / known : null),
    hasOutcome: supplied.hasOutcome,
    hasLedger: supplied.hasLedger,
    obligationTo: supplied.obligationTo,
  };
}

/**
 * The whole of item 3.6 in one pure function. Nothing here reads or writes the
 * database; `./promote-store.ts` does that, so the rules can be tested against
 * a table of cases rather than against a schema.
 */
export function promotionVerdict(input: PromotionInput): PromotionVerdict {
  const party = partyGate(input.loops, input.session ?? {});
  const evidence = evaluateRoutes(input);
  const routes = party.blocked
    ? []
    : ROUTE_PRECEDENCE.filter((route) => evidence[route].qualifies);

  const wasPromoted = input.wasPromoted === true;
  const statusVerdict = deriveStatus(input);
  const hadLoops = (input.loops ?? []).length > 0;

  // "all done/lapsed/dropped → archived (retrievable, not surfaced)". An
  // archived space is still a space: the row keeps `promoted`, keeps its
  // reason, and keeps its id. Only a thread that never qualified — or one the
  // user unpinned — flips `promoted` back to 0.
  const retained =
    routes.length === 0 && wasPromoted && !party.blocked && hadLoops && statusVerdict.status === "archived";
  const promoted = routes.length > 0 || retained;
  const promotionReason = routes[0] ?? (retained ? input.previousReason ?? null : null);

  const status = promoted ? statusVerdict.status : null;
  const verdict: PromotionVerdict = {
    arcId: input.arcId,
    promoted,
    promotionReason,
    routes,
    evidence,
    status,
    statusReason: promoted ? statusVerdict.reason : null,
    party,
    livesOn: party.blocked ? "people_record" : promoted ? "space" : "thread",
    archetype: input.archetype ?? null,
    archetypeSource: input.archetypeSource ?? null,
    archetypeRule: null,
    cadence: input.cadence ?? null,
    endsAt: input.endsAt ?? null,
    demoted: wasPromoted && !promoted,
    retained,
  };

  if (promoted) {
    const shaped = classifyArchetype(shapeOf(input, routes));
    verdict.archetypeRule = shaped.rule;
    // The stored archetype wins unless there is none: item 3.7's model answer
    // and a user's correction both land through `reviseArchetype`, never here.
    if (verdict.archetype === null && shaped.archetype !== null) {
      verdict.archetype = shaped.archetype;
      verdict.archetypeSource = "code";
    }
  }
  return verdict;
}

// ---- the recurrence cap ----------------------------------------------------

/**
 * "cap ~10 live". Recurrence is the loosest route, so a corpus with a hundred
 * repeating topics would otherwise bury the ten that matter. Arcs promoted by
 * recurrence ALONE compete; the freshest ten stay, the rest go back to being
 * browsable threads. An arc with any other route is never capped.
 */
export function applyRecurrenceCap(
  verdicts: readonly PromotionVerdict[],
  lastEvidenceAt: ReadonlyMap<string, string | null>,
  cap: number = REC_LIVE_CAP,
): PromotionVerdict[] {
  const recOnly = verdicts.filter(
    (v) => v.promoted && v.routes.length === 1 && v.routes[0] === "rec" && v.status !== "archived",
  );
  if (recOnly.length <= cap) return [...verdicts];

  const ranked = [...recOnly].sort((a, b) => {
    const am = toMs(lastEvidenceAt.get(a.arcId) ?? null) ?? 0;
    const bm = toMs(lastEvidenceAt.get(b.arcId) ?? null) ?? 0;
    return bm - am || a.arcId.localeCompare(b.arcId);
  });
  const evicted = new Set(ranked.slice(cap).map((v) => v.arcId));
  return verdicts.map((v) =>
    evicted.has(v.arcId)
      ? {
          ...v,
          promoted: false,
          promotionReason: null,
          routes: [],
          status: null,
          statusReason: null,
          livesOn: "thread" as const,
          demoted: true,
          retained: false,
          evidence: {
            ...v.evidence,
            rec: {
              ...v.evidence.rec,
              qualifies: false,
              detail: `${v.evidence.rec.detail} — beyond the ${cap} live recurrence spaces`,
            },
          },
        }
      : v,
  );
}

// ---- "why is this a space?" ------------------------------------------------

/**
 * §11.3: `promotion_reason` is recorded, so "why is this a space?" always
 * answers. This is that answer — the route, its counted evidence, and the
 * loops behind it. It never returns an empty string.
 */
export function explainPromotion(verdict: PromotionVerdict): string {
  if (verdict.party.blocked) {
    return "not a space — no loop on this thread involves you; it is context on their People record";
  }
  if (!verdict.promoted) {
    const why = ROUTE_PRECEDENCE.map((r) => `${r}: ${verdict.evidence[r].detail}`).join(" · ");
    return `not a space — no route qualified (${why})`;
  }
  const reason = verdict.promotionReason;
  const head =
    reason === null
      ? "a space"
      : `${ROUTE_MARKERS[reason]} ${ROUTE_NAMES[reason]} — ${verdict.evidence[reason].detail}`;
  const also = verdict.routes.filter((r) => r !== reason);
  const tail = also.length > 0 ? ` (also ${also.map((r) => ROUTE_NAMES[r]).join(", ")})` : "";
  return `${head}${tail} · status ${verdict.status}`;
}
