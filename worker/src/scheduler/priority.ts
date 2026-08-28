// ===========================================================================
// Processing order — build P1.6, spec §5.2; evals CAT-05, AGE ordering.
//
// The §5.2 ladder, verbatim:
//
//   1. LIVE PREEMPTS EVERYTHING, ALWAYS.
//   2. Backfill: day-major, newest day first; within a day, source order
//      (WhatsApp -> Screen -> Browser -> ...); within a source, Cat 1 streams
//      ordered by engagement score (recency-weighted user-reply frequency —
//      an ordering signal ONLY, never relationship value).
//   3. Cat-1 data + Cat-1 media enrichment run in parallel on all CLI slots.
//      ONLY when all Cat 1 is done -> Cat 2 data (Digest pass) -> Cat 2 media
//      enrichment last (mostly lazy). Whisper is local and exempt.
//   4. First-experience slice: most recent 3–7 days of top-engagement chats
//      first -> first proposals on screen in ~2–3 minutes.
//
// This module is the ONE place those rules are code. dispatch.ts orders its
// tick plan with compareBundles(); the slot planner (dispatch + the P1.8
// enrichment lane) admits work through admitWork()/planCliSlots() — the
// CAT-05 `slot-leak` (any Cat-2 call while Cat-1 pending) is impossible by
// construction there, and the deterministic test proves it.
//
// Band ordering (A > B > C > D, BND lanes) and day-major agree by
// construction — a band is a monotone function of the day — so the comparator
// keeps band as the coarse key (the BND-0x contract) and refines inside it
// with the §5.2 keys.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { StreamCategory } from "../categories/chat.js";
import type { AgeBand } from "../db/eventlog.js";

// ---- Source order (spec §5.2.2) --------------------------------------------

/** WhatsApp -> Screen -> Browser -> everything else. */
export const SOURCE_ORDER: readonly string[] = ["wa", "screen", "browser"];

export function sourceRank(source: string | null | undefined): number {
  const i = SOURCE_ORDER.indexOf(source ?? "");
  return i === -1 ? SOURCE_ORDER.length : i;
}

/** streams.id is `${source}:st:${key}` (db/eventlog.ts) — recover the source. */
export function sourceOfStreamId(streamId: string): string {
  const cut = streamId.indexOf(":st:");
  return cut > 0 ? streamId.slice(0, cut) : "";
}

// ---- The comparator --------------------------------------------------------

const BAND_ORDER: Record<AgeBand, number> = { A: 0, B: 1, C: 2, D: 3 };

/** What compareBundles needs to know about one bundle. */
export interface OrderableBundle {
  streamId: string;
  streamKey: string;
  lane: "live" | "backfill";
  ageBand: AgeBand;
  /** Newest event day in the bundle, "YYYY-MM-DD"; "" when unknown. */
  day?: string;
  /** Stream category; null/undefined = unknown, ordered as Cat 1 (early — misclassification costs latency, never data). */
  category?: StreamCategory | null;
  part: number;
}

export interface OrderContext {
  /** streamId -> engagement score (ordering signal only). */
  engagement: ReadonlyMap<string, number>;
}

function categoryRank(category: StreamCategory | null | undefined): number {
  return category === "cat2" ? 1 : 0;
}

/**
 * The §5.2 order: live first; backfill by band (BND contract), then
 * day-major newest first, then source order, then Cat 1 before Cat 2, then
 * engagement descending, then stream key + part for determinism.
 */
export function compareBundles(
  a: OrderableBundle,
  b: OrderableBundle,
  ctx: OrderContext,
): number {
  if (a.lane !== b.lane) return a.lane === "live" ? -1 : 1;
  if (a.lane === "backfill") {
    if (BAND_ORDER[a.ageBand] !== BAND_ORDER[b.ageBand]) {
      return BAND_ORDER[a.ageBand] - BAND_ORDER[b.ageBand];
    }
    const da = a.day ?? "";
    const db_ = b.day ?? "";
    if (da !== db_) return da > db_ ? -1 : 1; // newest day first
    const sa = sourceRank(sourceOfStreamId(a.streamId));
    const sb = sourceRank(sourceOfStreamId(b.streamId));
    if (sa !== sb) return sa - sb;
    if (categoryRank(a.category) !== categoryRank(b.category)) {
      return categoryRank(a.category) - categoryRank(b.category);
    }
  }
  const ea = ctx.engagement.get(a.streamId) ?? 0;
  const eb = ctx.engagement.get(b.streamId) ?? 0;
  if (ea !== eb) return eb - ea;
  if (a.streamKey !== b.streamKey) return a.streamKey < b.streamKey ? -1 : 1;
  return a.part - b.part;
}

// ---- Slot policy (spec §5.2.3; eval CAT-05) --------------------------------

export type SlotWorkKind = "data" | "media";

/** One candidate for a CLI slot — a understanding bundle or an enrichment item. */
export interface SlotWork {
  id: string;
  lane: "live" | "backfill";
  kind: SlotWorkKind;
  category: StreamCategory;
  /** Local compute (whisper) — exempt from the CLI slot policy entirely. */
  local?: boolean;
}

/** What the gate needs to know about the world beyond the candidates. */
export interface SlotState {
  /** Cat-1 data (bundles/events) not yet processed, anywhere. */
  cat1DataPending: number;
  /** Cat-1 media enrichment items not yet resolved, anywhere. */
  cat1MediaPending: number;
}

/**
 * May this work occupy a CLI slot right now? The CAT-05 hard gate:
 * Cat-2 work (data OR media) is admitted ONLY when ALL Cat-1 work — data and
 * media both — is done. Live always passes; local (whisper) always passes.
 */
export function admitWork(work: SlotWork, state: SlotState): boolean {
  if (work.local) return true;
  if (work.lane === "live") return true;
  if (work.category === "cat1") return true;
  return state.cat1DataPending === 0 && state.cat1MediaPending === 0;
}

/**
 * Fill up to `freeSlots` CLI slots from `candidates`, §5.2 order:
 * live first; then Cat-1 data + Cat-1 media in their given interleaving
 * (they run in parallel on all slots — neither waits for the other); then —
 * only when the gate is clear — Cat-2 data (Digest) before Cat-2 media.
 * Local work never consumes a slot and is returned admitted alongside.
 */
export function planCliSlots(
  candidates: readonly SlotWork[],
  state: SlotState,
  freeSlots: number,
): { slots: SlotWork[]; local: SlotWork[] } {
  const local = candidates.filter((c) => c.local);
  const cli = candidates.filter((c) => !c.local && admitWork(c, state));
  const rank = (w: SlotWork): number => {
    if (w.lane === "live") return 0;
    if (w.category === "cat1") return 1; // data + media together, in parallel
    return w.kind === "data" ? 2 : 3; // Cat-2 data (Digest) before Cat-2 media
  };
  const ordered = cli
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map((x) => x.w);
  return { slots: ordered.slice(0, Math.max(0, freeSlots)), local };
}

/**
 * The live gate state, from the DB: how much Cat-1 work is still pending.
 * A stream with NO category yet counts as Cat 1 — unknown work is early
 * work, never quietly deprioritised.
 */
export function pendingCat1Counts(): SlotState {
  const db = getDb();
  const data = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM events e
         JOIN streams s ON s.id = e.stream_id
        WHERE e.dispatched_at IS NULL
          AND e.stream_key IS NOT NULL
          AND e.revoked_at IS NULL
          AND COALESCE(s.category, 'cat1') = 'cat1'`,
    )
    .get() as { n: number };
  const media = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM events e
         JOIN streams s ON s.id = e.stream_id
        WHERE e.enrichment_state = 'pending'
          AND COALESCE(s.category, 'cat1') = 'cat1'`,
    )
    .get() as { n: number };
  return { cat1DataPending: data.n, cat1MediaPending: media.n };
}

// ---- First-experience slice (spec §5.2.4) ----------------------------------

export interface FirstExperienceOptions {
  /** Recency window, days. Spec: 3–7. */
  days?: number;
  /** How many top-engagement chat streams make the slice. */
  topStreams?: number;
  nowMs?: number;
}

export const FIRST_EXPERIENCE_DAYS = 7;
export const FIRST_EXPERIENCE_TOP_STREAMS = 10;
const DAY_MS = 86_400_000;

/**
 * Is this install still in its first experience? True until the first bundle
 * has ever been dispatched — after that, normal §5.2 order stands on its own.
 */
export function isFirstExperience(): boolean {
  const row = getDb()
    .prepare(`SELECT EXISTS(SELECT 1 FROM events WHERE dispatched_at IS NOT NULL) AS seen`)
    .get() as { seen: number };
  return row.seen === 0;
}

/**
 * Pull the first-experience slice to the front of a sorted plan: backfill
 * bundles of top-engagement CHAT streams whose newest events fall in the last
 * 3–7 days jump ahead of all other backfill (never ahead of live), ordered by
 * engagement. Everything else keeps its relative order.
 */
export function applyFirstExperienceSlice<
  T extends OrderableBundle & { events: { ts: string | null }[] },
>(bundles: readonly T[], ctx: OrderContext, opts: FirstExperienceOptions = {}): T[] {
  const days = Math.min(7, Math.max(3, opts.days ?? FIRST_EXPERIENCE_DAYS));
  const topStreams = opts.topStreams ?? FIRST_EXPERIENCE_TOP_STREAMS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - days * DAY_MS;

  const isRecentChat = (b: T): boolean => {
    if (b.lane !== "backfill") return false;
    if (sourceOfStreamId(b.streamId) !== "wa") return false;
    if ((b.category ?? "cat1") !== "cat1") return false;
    return b.events.some((e) => {
      const t = e.ts ? Date.parse(e.ts) : NaN;
      return Number.isFinite(t) && t >= cutoff;
    });
  };

  const candidateStreams = [
    ...new Set(bundles.filter(isRecentChat).map((b) => b.streamId)),
  ]
    .sort((a, b) => (ctx.engagement.get(b) ?? 0) - (ctx.engagement.get(a) ?? 0))
    .slice(0, topStreams);
  const sliceSet = new Set(candidateStreams);

  const live: T[] = [];
  const slice: T[] = [];
  const rest: T[] = [];
  for (const b of bundles) {
    if (b.lane === "live") live.push(b);
    else if (isRecentChat(b) && sliceSet.has(b.streamId)) slice.push(b);
    else rest.push(b);
  }
  slice.sort(
    (a, b) =>
      (ctx.engagement.get(b.streamId) ?? 0) - (ctx.engagement.get(a.streamId) ?? 0) ||
      (a.streamKey < b.streamKey ? -1 : a.streamKey > b.streamKey ? 1 : 0) ||
      a.part - b.part,
  );
  return [...live, ...slice, ...rest];
}
