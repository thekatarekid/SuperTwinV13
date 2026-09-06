// ===========================================================================
// SURFACE ROUTER — `surface-router.v1` (V6 Phase 1, S4.3; Build §7.1;
// Product_V6_Phase1 §18.2–18.5; Product_V6 §14.3–14.5; Prompts P-10 is the
// prose contract for the card this module composes).
//
//   executor-lite artifact / question card ─► surface-router.v1 ─► surfaces
//
// THE ONE RULE. The router decides WHERE and in what ORDER, never WHETHER.
// There is no hold state, no quiet hours, no cap and no cooldown. A card the
// user is not there to see is routed to a surface they ARE on — never
// withheld (`router_withheld = 0`, NUD-02). The only reason a Mac card is not
// shown is that the user is not at the Mac.
//
// Everything the router needs is decidable in code, so it IS code: presence
// is the last screen event's age, the decay order is a fixed list, the merge
// window / card duration / intent floor / blocked kinds are Settings › Assist
// rows (settings/p1-settings.ts, S5.6). No model call, ever — routing a
// finished artifact must not cost a token, and a router that could fail open
// would decide "whether" by accident.
//
//   PRESENCE (NUD-01/02). A screen event inside MAC_ACTIVE_WINDOW_MS (3 min)
//   means the user is at the Mac: the top item earns a card ON TOP of the
//   panel, shelf, space and timeline. Away: exactly the same set minus the
//   card. Nothing else changes — that identity is what the withheld gate
//   measures.
//
//   MERGE PER SPACE (NUD-04). Pending items on one space that arrived inside
//   the merge window of each other collapse into ONE card, one line per item:
//   "Goa trip: villa comparison · Karan replied · fare dropped". Three helps,
//   one glance.
//
//   DECAY ORDER (NUD-05). help_now → needs_you → something_moved →
//   done_for_you → done_in_advance → understanding; newest first inside a
//   kind. Rank 0 is the card; every other pending item is already on its
//   durable surfaces and takes the card when its turn comes ("one at a time",
//   §14.4.1).
//
//   HOUSEKEEPING STAYS INSIDE (NUD-06). Claims extracted, a cursor advanced,
//   a retry, a partial step, a duplicate: not one of the six kinds, so not a
//   nudge. It lands on Home › Recent understanding and nowhere else.
//
//   DISMISSALS RANK, THEY DO NOT MUTE (NUD-07). Every "Not now" adds one to
//   that kind's decay index, so it sinks below kinds the user still reads. It
//   never loses a surface: the third fare alert is on the panel the moment it
//   exists, and earns the card once nothing outranks it.
//
//   "DON'T DO THIS" BLOCKS, REVERSIBLY (NUD-08). A kind in
//   `assist.blocked_kinds` never shows as a nudge — no card, no panel, no
//   shelf. It is still filed in its space and on the timeline (nothing is
//   ever lost), it is listed in Settings › Assist, and removing it there
//   restores the kind on the very next route.
//
//   THE INTENT FLOOR (LIV-06, NUD-09). A card must name the right goal.
//   Below `assist.intent_confidence_min` the item is shelved, never carded —
//   and a card whose named space is NOT the item's own space is a wrong-goal
//   card, which is the one failure that would make the user stop reading
//   cards. `wrongGoalCards()` counts them for the precision gate.
//
// State: none of its own. Presence is `events`, the pending set is
// `artifacts`, "shown" is `artifacts.nudged_at`, "opened" is
// `artifacts.seen_at`, the per-kind dismissal counter and the blocked list
// are `app_state` rows. Every routing is a `decisions` row, so "why did this
// pop?" answers itself.
// ===========================================================================

import { listPreparedActions, PREPARED_ACTION_KIND, PREPARED_KINDS, type PreparedKind } from "../brain/live.js";
import { getArtifact, markNudged, recordSignal, setArtifactStatus, type ArtifactRow } from "../assist/artifacts.js";
import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { assistP1Settings } from "../settings/p1-settings.js";
import { nudgeThresholds, nudgeVerdict } from "./nudge-verdict.js";

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

/**
 * P-10's five nudge surfaces plus `understanding` — Home › Recent
 * understanding, where the twin's own bookkeeping lands (§14.5). A nudge
 * never routes there and housekeeping never routes anywhere else.
 */
export const SURFACES = ["card", "panel", "shelf", "space", "timeline", "understanding"] as const;
export type Surface = (typeof SURFACES)[number];

/** Everything that is not the card. An item ALWAYS has these (unless blocked). */
export const DURABLE_SURFACES: readonly Surface[] = Object.freeze(["panel", "shelf", "space", "timeline"]);

/** §14.4.10 / §18.4 — the order the value of each kind dies in. */
export const DECAY_ORDER: readonly PreparedKind[] = Object.freeze([
  "help_now",
  "needs_you",
  "something_moved",
  "done_for_you",
  "done_in_advance",
  "understanding",
]);

/** "Mac active" = a screen event newer than this (§14.3). */
export const MAC_ACTIVE_WINDOW_MS = 3 * 60_000;

/** app_state prefix for the per-kind "Not now" counter (§14.4.11). */
export const DISMISS_KEY_PREFIX = "assist.dismissed.";

export function decayIndex(kind: string): number {
  const i = DECAY_ORDER.indexOf(kind as PreparedKind);
  return i === -1 ? DECAY_ORDER.length : i;
}

export function isNudgeKind(kind: string): kind is PreparedKind {
  return (PREPARED_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** One finished thing asking to be delivered. */
export interface RoutableItem {
  /** Artifact id — what every surface links to. */
  id: string;
  /** One of the six kinds; anything else is housekeeping. */
  kind: string;
  spaceId: string | null;
  /** The intent line: "Saw you comparing villas in Anjuna". */
  intent: string;
  intentConfidence: number;
  /** "What I did", one line — the merged card gets one of these per item. */
  line: string;
  /** Artifact peek: the first line of the body. */
  peek: string | null;
  /** When the artifact became ready (ms). Newest first inside a kind. */
  readyAtMs: number;
}

export interface RouterContext {
  nowMs: number;
  /** Screen event inside MAC_ACTIVE_WINDOW_MS. */
  macActive: boolean;
  intentFloor: number;
  mergeWindowMs: number;
  cardDurationMs: number;
  blockedKinds: readonly string[];
  /** Per-kind "Not now" counts — they rank, they never mute. */
  dismissals: Readonly<Record<string, number>>;
  /** space id → label, for the merged card's title. */
  spaceLabels: Readonly<Record<string, string>>;
}

export interface RoutedCard {
  /** The space (or the intent when there is no space). */
  title: string;
  /** One line per merged item, joined by " · ". */
  line: string;
  peek: string | null;
  /** The space this card names — must be the item's own (NUD-09). */
  spaceId: string | null;
  /** Auto-close deadline; the card costs at most a glance (§14.4.1). */
  autoCloseAtMs: number;
}

export type RouteReason =
  | "card_and_panel"
  | "away_no_card"
  | "queued_behind"
  | "below_intent_floor"
  | "blocked_kind"
  | "housekeeping";

export interface RoutedItemPlan {
  id: string;
  kind: string;
  spaceId: string | null;
  surfaces: Surface[];
  /** Position in the decay order; 0 is next on the card. */
  rank: number;
  /** Other artifact ids folded into this card. */
  mergedWith: string[];
  card: RoutedCard | null;
  reason: RouteReason;
  blocked: boolean;
  housekeeping: boolean;
}

export interface RoutePlan {
  presence: "mac_active" | "away";
  items: RoutedItemPlan[];
  /** The one card showing now (rank 0 and eligible), or null. */
  current: RoutedItemPlan | null;
  /** Items routed nowhere at all. The router never withholds: always 0. */
  withheld: number;
}

// ---------------------------------------------------------------------------
// The decision (pure — no database, no clock of its own)
// ---------------------------------------------------------------------------

interface Group {
  lead: RoutableItem;
  members: RoutableItem[];
  /** The most urgent kind in the group — a merged card is as urgent as its best item. */
  kind: string;
  readyAtMs: number;
}

/**
 * Pending items on one space that arrived inside the merge window of each
 * other collapse into one card (§14.4.9). Chained, not anchored: three items
 * two minutes apart are one short window, which is what "three helps, one
 * glance" means. Items with no space never merge — there is no "one space"
 * for them to be about.
 */
export function mergeGroups(items: readonly RoutableItem[], mergeWindowMs: number): Group[] {
  const bySpace = new Map<string, RoutableItem[]>();
  const solo: RoutableItem[] = [];
  for (const item of items) {
    if (!item.spaceId) solo.push(item);
    else bySpace.set(item.spaceId, [...(bySpace.get(item.spaceId) ?? []), item]);
  }
  const groups: Group[] = [];
  const push = (members: RoutableItem[]): void => {
    const ordered = [...members].sort((a, b) => a.readyAtMs - b.readyAtMs);
    const lead = ordered.reduce((best, cur) => {
      const d = decayIndex(cur.kind) - decayIndex(best.kind);
      if (d !== 0) return d < 0 ? cur : best;
      return cur.readyAtMs > best.readyAtMs ? cur : best;
    }, ordered[0]!);
    groups.push({
      lead,
      members: ordered,
      kind: lead.kind,
      readyAtMs: Math.max(...ordered.map((m) => m.readyAtMs)),
    });
  };
  for (const item of solo) push([item]);
  for (const list of bySpace.values()) {
    const ordered = [...list].sort((a, b) => a.readyAtMs - b.readyAtMs);
    let run: RoutableItem[] = [];
    for (const item of ordered) {
      const prev = run[run.length - 1];
      if (prev && item.readyAtMs - prev.readyAtMs > mergeWindowMs) {
        push(run);
        run = [];
      }
      run.push(item);
    }
    if (run.length > 0) push(run);
  }
  return groups;
}

/** The merged card's line: one line per item, oldest first, joined by " · ". */
export function cardLine(members: readonly RoutableItem[]): string {
  return members.map((m) => m.line.trim()).filter((l) => l !== "").join(" · ");
}

function cardTitle(group: Group, ctx: RouterContext): string {
  const label = group.lead.spaceId ? ctx.spaceLabels[group.lead.spaceId] : undefined;
  return label ?? group.lead.spaceId ?? group.lead.intent;
}

/**
 * Route one pending set. Ordering is (decay index + that kind's dismissals),
 * ties broken by the base decay index and then newest first, so a dismissed
 * kind sinks past the kinds the user still reads without ever losing a
 * surface.
 */
export function routeSurfaces(items: readonly RoutableItem[], ctx: RouterContext): RoutePlan {
  const nudgeable: RoutableItem[] = [];
  const housekeeping: RoutableItem[] = [];
  for (const item of items) (isNudgeKind(item.kind) ? nudgeable : housekeeping).push(item);

  const groups = mergeGroups(nudgeable, ctx.mergeWindowMs);
  const scored = groups
    .map((g) => ({
      group: g,
      base: decayIndex(g.kind),
      effective: decayIndex(g.kind) + Math.max(0, ctx.dismissals[g.kind] ?? 0),
    }))
    .sort((a, b) => a.effective - b.effective || a.base - b.base || b.group.readyAtMs - a.group.readyAtMs);

  const plans: RoutedItemPlan[] = [];
  let cardTaken = false;
  scored.forEach((entry, rank) => {
    const { group } = entry;
    // S4.4: one verdict function, shared with the writer (brain/live.ts), so
    // the floor the prepared row was stamped with is the floor the router
    // reads back. `nudgeVerdict` is the only place either of them applies it.
    const verdict = nudgeVerdict(
      { kind: group.kind, intentConfidence: group.lead.intentConfidence },
      { intentFloor: ctx.intentFloor, blockedKinds: ctx.blockedKinds },
    );
    const blocked = verdict.verdict === "blocked";
    const aboveFloor = verdict.verdict === "card";
    // A blocked kind is the user's own "whether"; it is filed, never shown.
    if (blocked) {
      plans.push({
        id: group.lead.id,
        kind: group.kind,
        spaceId: group.lead.spaceId,
        surfaces: ["space", "timeline"],
        rank,
        mergedWith: group.members.filter((m) => m.id !== group.lead.id).map((m) => m.id),
        card: null,
        reason: "blocked_kind",
        blocked: true,
        housekeeping: false,
      });
      return;
    }
    const surfaces: Surface[] = [...DURABLE_SURFACES];
    let card: RoutedCard | null = null;
    let reason: RouteReason;
    if (!aboveFloor) {
      reason = "below_intent_floor";
    } else if (!ctx.macActive) {
      reason = "away_no_card";
    } else if (cardTaken) {
      reason = "queued_behind";
    } else {
      cardTaken = true;
      surfaces.unshift("card");
      card = {
        title: cardTitle(group, ctx),
        line: cardLine(group.members),
        peek: group.lead.peek,
        spaceId: group.lead.spaceId,
        autoCloseAtMs: ctx.nowMs + ctx.cardDurationMs,
      };
      reason = "card_and_panel";
    }
    plans.push({
      id: group.lead.id,
      kind: group.kind,
      spaceId: group.lead.spaceId,
      surfaces,
      rank,
      mergedWith: group.members.filter((m) => m.id !== group.lead.id).map((m) => m.id),
      card,
      reason,
      blocked: false,
      housekeeping: false,
    });
  });

  // Housekeeping never competes for a rank: it is not a nudge at all.
  for (const item of housekeeping) {
    plans.push({
      id: item.id,
      kind: item.kind,
      spaceId: item.spaceId,
      surfaces: ["understanding"],
      rank: plans.length,
      mergedWith: [],
      card: null,
      reason: "housekeeping",
      blocked: false,
      housekeeping: true,
    });
  }

  return {
    presence: ctx.macActive ? "mac_active" : "away",
    items: plans,
    current: plans.find((p) => p.card !== null) ?? null,
    withheld: plans.filter((p) => p.surfaces.length === 0).length,
  };
}

/**
 * NUD-09 — the precision gate. A card that names a space the item is not
 * about is the one real failure. Counted, never silently rendered.
 */
export function wrongGoalCards(plan: RoutePlan): RoutedItemPlan[] {
  return plan.items.filter((p) => p.card !== null && p.card.spaceId !== p.spaceId);
}

/**
 * `router_withheld` — the same item set routed away from the Mac must keep
 * every durable surface it had at the Mac. Anything else is a hold state,
 * and there is no hold state.
 */
export function withheldCount(active: RoutePlan, away: RoutePlan): number {
  const byId = new Map(active.items.map((p) => [p.id, p]));
  let withheld = away.withheld;
  for (const item of away.items) {
    const other = byId.get(item.id);
    if (!other) continue;
    const lost = other.surfaces.filter((s) => s !== "card" && !item.surfaces.includes(s));
    if (lost.length > 0) withheld += 1;
  }
  return withheld;
}

// ---------------------------------------------------------------------------
// The world the router reads
// ---------------------------------------------------------------------------

/** Last screen event inside the 3-minute window = the user is at the Mac. */
export function macActive(nowMs: number = Date.now()): boolean {
  const row = getDb()
    .prepare(`SELECT ts FROM events WHERE source_id = 'screen' AND ts IS NOT NULL ORDER BY ts DESC LIMIT 1`)
    .get() as { ts: string } | undefined;
  if (!row) return false;
  const ts = Date.parse(row.ts);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts < MAC_ACTIVE_WINDOW_MS;
}

export function kindDismissals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of DECAY_ORDER) {
    const raw = appStateGet(`${DISMISS_KEY_PREFIX}${kind}`);
    const n = raw === null ? 0 : Number(raw);
    out[kind] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

/** "Not now" — one more step down the order for that kind, never a mute. */
export function noteNotNow(kind: string): number {
  if (!isNudgeKind(kind)) return 0;
  const next = (kindDismissals()[kind] ?? 0) + 1;
  appStateSet(`${DISMISS_KEY_PREFIX}${kind}`, String(next));
  return next;
}

/** Reopening a kind's card forgives one dismissal (§14.4.11: rank, not mute). */
export function forgiveDismissal(kind: string): number {
  if (!isNudgeKind(kind)) return 0;
  const next = Math.max(0, (kindDismissals()[kind] ?? 0) - 1);
  appStateSet(`${DISMISS_KEY_PREFIX}${kind}`, String(next));
  return next;
}

export function routerContext(nowMs: number = Date.now(), overrides: Partial<RouterContext> = {}): RouterContext {
  const s = assistP1Settings();
  const t = nudgeThresholds();
  const labels: Record<string, string> = {};
  for (const row of getDb().prepare(`SELECT id, label FROM spaces`).all() as { id: string; label: string }[]) {
    labels[row.id] = row.label;
  }
  return {
    nowMs,
    macActive: macActive(nowMs),
    intentFloor: t.intentFloor,
    mergeWindowMs: s.merge_window_s * 1000,
    cardDurationMs: s.card_duration_s * 1000,
    blockedKinds: t.blockedKinds,
    dismissals: kindDismissals(),
    spaceLabels: labels,
    ...overrides,
  };
}

/**
 * The nudge kind of an artifact. The live pass's prepared action carries it
 * (`deferred_outputs.payload_json.kind`), joined through the artifact's
 * `topic_key` = `prepared:<prepared id>`. An artifact with no prepared action
 * behind it (the retired assist lane) is read off its own kind: a question
 * needs the user to finish, anything else was done for them.
 */
export function kindOfArtifact(a: ArtifactRow): { kind: string; intentConfidence: number } {
  const preparedId = a.topicKey?.startsWith("prepared:") ? a.topicKey.slice("prepared:".length) : null;
  if (preparedId) {
    const row = getDb()
      .prepare(`SELECT payload_json FROM deferred_outputs WHERE id = ? AND kind = ?`)
      .get(preparedId, PREPARED_ACTION_KIND) as { payload_json: string } | undefined;
    if (row) {
      try {
        const payload = JSON.parse(row.payload_json) as { kind?: unknown; intent_confidence?: unknown };
        const kind = typeof payload.kind === "string" ? payload.kind : "done_for_you";
        const conf = typeof payload.intent_confidence === "number" ? payload.intent_confidence : 1;
        return { kind, intentConfidence: conf };
      } catch {
        /* a corrupt payload is not a reason to withhold — fall through */
      }
    }
  }
  // S4.7: an injection card ("a page tried to instruct me") needs the user's
  // eyes, never the twin's action — it ranks with the questions.
  return {
    kind: a.kind === "question" || a.kind === "injection" ? "needs_you" : "done_for_you",
    intentConfidence: 1,
  };
}

/** First non-empty line of the artifact body — the peek (§14.4.1). */
export function peekOf(a: ArtifactRow): string | null {
  if (!a.bodyJson) return null;
  try {
    const body = JSON.parse(a.bodyJson) as Record<string, unknown>;
    const text = [body.body, body.summary, body.line].find((v) => typeof v === "string" && v.trim() !== "");
    if (typeof text !== "string") return null;
    const line = text.split("\n").find((l) => l.trim() !== "");
    return line ? line.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Artifacts that finished and have never had their card. */
export function pendingItems(): RoutableItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM artifacts
        WHERE status = 'new' AND nudged_at IS NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => {
    const a = hydrate(r);
    const { kind, intentConfidence } = kindOfArtifact(a);
    return {
      id: a.id,
      kind,
      spaceId: a.spaceId,
      intent: a.intent ?? a.title,
      intentConfidence,
      line: a.title,
      peek: peekOf(a),
      readyAtMs: Date.parse(a.createdAt),
    };
  });
}

/** Local hydrate: `artifacts` rows, the same shape assist/artifacts.ts uses. */
function hydrate(r: Record<string, unknown>): ArtifactRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    title: String(r.title),
    summary: (r.summary as string | null) ?? null,
    bodyJson: (r.body_json as string | null) ?? null,
    intent: (r.intent as string | null) ?? null,
    reasoning: (r.reasoning as string | null) ?? null,
    spaceId: (r.space_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    topicKey: (r.topic_key as string | null) ?? null,
    contentKey: (r.content_key as string | null) ?? null,
    producer: String(r.producer ?? "assist"),
    status: String(r.status) as ArtifactRow["status"],
    runId: (r.run_id as string | null) ?? null,
    nudgedAt: (r.nudged_at as string | null) ?? null,
    seenAt: (r.seen_at as string | null) ?? null,
    dismissedAt: (r.dismissed_at as string | null) ?? null,
    graduatedAt: (r.graduated_at as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

/** Route everything pending right now, against the live world. */
export function routeNow(nowMs: number = Date.now(), overrides: Partial<RouterContext> = {}): RoutePlan {
  return routeSurfaces(pendingItems(), routerContext(nowMs, overrides));
}

// ---------------------------------------------------------------------------
// The card's life (§14.4.1–2) — shown, opened, not now, auto-closed
// ---------------------------------------------------------------------------

/**
 * Cards SHOWN but not OPENED. This counter is what makes closing a card free
 * (§14.4.2): the glance costs nothing because nothing is lost.
 */
export function unreadCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE status = 'new' AND nudged_at IS NOT NULL AND seen_at IS NULL`,
    )
    .get() as { n: number };
  return Number(row.n);
}

export interface CardShown {
  id: string;
  merged: string[];
  unread: number;
}

/**
 * The card went up. Every merged member is stamped too — the card was about
 * all of them, so none of them pops again.
 */
export function markCardShown(plan: RoutedItemPlan, nowMs: number = Date.now()): CardShown {
  const ids = [plan.id, ...plan.mergedWith];
  for (const id of ids) markNudged(id, nowMs);
  writeDecision({
    pass: "surface-router.v1",
    targetKind: "artifact",
    targetId: plan.id,
    action: "route",
    new: {
      surfaces: plan.surfaces,
      rank: plan.rank,
      kind: plan.kind,
      merged_with: plan.mergedWith,
      card: plan.card,
    },
    reason: plan.reason,
  });
  return { id: plan.id, merged: plan.mergedWith, unread: unreadCount() };
}

/** Open — the card did its job; the dot clears everywhere. */
export function openCard(id: string, nowMs: number = Date.now()): { unread: number } {
  const a = getArtifact(id);
  if (a) {
    recordSignal(id, "opened_dwelled", { nowMs });
    setArtifactStatus(id, "seen", { by: "user", nowMs });
    const { kind } = kindOfArtifact(a);
    forgiveDismissal(kind);
  }
  return { unread: unreadCount() };
}

/**
 * "Not now" — a graded negative that RANKS the kind down and parks the work
 * in Prepared. It never mutes: the next one of that kind still routes to
 * every durable surface.
 */
export function notNowCard(id: string, nowMs: number = Date.now()): { unread: number; dismissals: number } {
  const a = getArtifact(id);
  let dismissals = 0;
  if (a) {
    recordSignal(id, "ignored", { nowMs });
    setArtifactStatus(id, "seen", { by: "user", nowMs });
    const { kind } = kindOfArtifact(a);
    dismissals = noteNotNow(kind);
    writeDecision({
      pass: "surface-router.v1",
      targetKind: "artifact",
      targetId: id,
      action: "not_now",
      new: { kind, dismissals },
      reason: "dismissals rank, they do not mute — the kind sinks in the decay order",
    });
  }
  return { unread: unreadCount(), dismissals };
}

/**
 * The 60-second auto-close. Nothing is lost: the artifact is already in the
 * panel, on the Prepared shelf, in its space and on the timeline, and it now
 * counts as unread on the menu-bar icon.
 */
export function autoCloseCard(id: string, nowMs: number = Date.now()): { unread: number } {
  const a = getArtifact(id);
  if (a) {
    markNudged(id, nowMs);
    writeDecision({
      pass: "surface-router.v1",
      targetKind: "artifact",
      targetId: id,
      action: "auto_close",
      new: { unread: true },
      reason: "card auto-closed unopened — kept in the panel, the shelf, the space and the timeline",
    });
  }
  return { unread: unreadCount() };
}

// ---------------------------------------------------------------------------
// What the nudge window polls
// ---------------------------------------------------------------------------

export interface NudgeView {
  presence: "mac_active" | "away";
  card: (RoutedCard & { id: string; kind: string; intent: string; mergedWith: string[] }) | null;
  unread: number;
  cardDurationMs: number;
  /** Pending items and where each one went — the panel's Prepared order. */
  routed: RoutedItemPlan[];
}

export function nudgeView(nowMs: number = Date.now(), overrides: Partial<RouterContext> = {}): NudgeView {
  const ctx = routerContext(nowMs, overrides);
  const plan = routeSurfaces(pendingItems(), ctx);
  const current = plan.current;
  const lead = current ? getArtifact(current.id) : null;
  return {
    presence: plan.presence,
    card:
      current && current.card
        ? {
            ...current.card,
            id: current.id,
            kind: current.kind,
            intent: lead?.intent ?? lead?.title ?? current.card.title,
            mergedWith: current.mergedWith,
          }
        : null,
    unread: unreadCount(),
    cardDurationMs: ctx.cardDurationMs,
    routed: plan.items,
  };
}

/** The prepared actions still waiting on executor-lite — the Prepared shelf's tail. */
export function shelfDepth(): number {
  return listPreparedActions({ limit: 500 }).length;
}
