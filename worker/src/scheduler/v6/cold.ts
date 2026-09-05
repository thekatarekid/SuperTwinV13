// ===========================================================================
// [CODE] The cold window (Product_V6 §11.3, P1 §6; GoldenEvals BND-04..07,
// GATE-08).
//
// Events the gate left cold accumulate and flush on `idle` seconds of silence
// or `max` seconds after the first, whichever comes first. Five rules:
//
//   presets        Live 120/180 · Balanced 300/540 (default) · Relaxed 420/600;
//                  max never exceeds 600 s
//   bootstrapping  under ~20 spaces or in the first 7 days → 60/180 (GATE-08)
//   floor          30 s between flushes: the second hot event in 5 s rides the
//                  next flush (BND-06)
//   cap            20k chars of accumulated content force a cut (BND-05 sibling)
//   novelty        repeated content never resets the idle timer and never
//                  counts; heartbeats alone never flush (BND-07)
//   empty          an empty accumulator never flushes: no new event, no call
//
// This file is the arithmetic. The dispatcher feeds it events and asks
// `dueAt()`; the clock is whatever the caller passes, so every test is exact.
// ===========================================================================

export interface ColdParams {
  idleMs: number;
  maxMs: number;
}

export type FreshnessPreset = "live" | "balanced" | "relaxed";

/** Settings › Assist presets (P1 §6.2). */
export const FRESHNESS_PRESETS: Record<FreshnessPreset, ColdParams> = {
  live: { idleMs: 120_000, maxMs: 180_000 },
  balanced: { idleMs: 300_000, maxMs: 540_000 },
  relaxed: { idleMs: 420_000, maxMs: 600_000 },
};

export const DEFAULT_PRESET: FreshnessPreset = "balanced";

/** Max is never above this, whatever the preset says. */
export const MAX_WINDOW_MS = 600_000;

/** Bootstrapping window while the world model is sparse. */
export const BOOTSTRAP_PARAMS: ColdParams = { idleMs: 60_000, maxMs: 180_000 };
/** "Under ~20 spaces" — bootstrapping ends at the 20th space. */
export const BOOTSTRAP_SPACES = 20;
/** "The first 7 days" — from the first consent. */
export const BOOTSTRAP_DAYS = 7;

/** 30 s between flushes. */
export const FLUSH_FLOOR_MS = 30_000;
/** Accumulated content that forces a cut. */
export const CHAR_CAP = 20_000;
/** Novelty memory per stream (keys), oldest evicted first. */
export const SEEN_KEYS_PER_STREAM = 512;

export function presetParams(preset: FreshnessPreset | string | null | undefined): ColdParams {
  const p = FRESHNESS_PRESETS[(preset ?? DEFAULT_PRESET) as FreshnessPreset] ?? FRESHNESS_PRESETS[DEFAULT_PRESET];
  return { idleMs: Math.min(p.idleMs, MAX_WINDOW_MS), maxMs: Math.min(p.maxMs, MAX_WINDOW_MS) };
}

export interface BootstrapInput {
  /** Spaces the world model holds (any non-rejected status). */
  spaces: number;
  /** Epoch ms of the first consent; null = nothing connected yet. */
  firstConsentMs: number | null;
  nowMs: number;
}

/** GATE-08: sparse world model → the 60/180 window; past the 20th space AND day 8 → the preset. */
export function isBootstrapping(input: BootstrapInput): boolean {
  if (input.spaces < BOOTSTRAP_SPACES) return true;
  if (input.firstConsentMs === null) return true;
  return input.nowMs - input.firstConsentMs < BOOTSTRAP_DAYS * 86_400_000;
}

/** The window in force: bootstrapping, else the preset. */
export function effectiveParams(preset: FreshnessPreset | string | null | undefined, boot: BootstrapInput): ColdParams {
  return isBootstrapping(boot) ? BOOTSTRAP_PARAMS : presetParams(preset);
}

// ---- The accumulator --------------------------------------------------------

export interface PendingEvent {
  rowid: number;
  id: string;
  streamId: string;
  /** Novelty key (content hash). */
  contentKey: string;
  chars: number;
  /** Whether this event counted as content-new when it arrived. */
  contentNew: boolean;
  /** Arrival time used for the window arithmetic. */
  atMs: number;
}

export type FlushTrigger = "hot" | "burst" | "cold" | "cap";

export interface ColdState {
  /** First content-new arrival since the last flush. */
  firstNewAtMs: number | null;
  /** Latest content-new arrival since the last flush. */
  lastNewAtMs: number | null;
  /** Content-new events accumulated. */
  newCount: number;
  /** Chars over content-new events. */
  chars: number;
  /** A hot / burst decision is waiting on the floor. */
  urgent: FlushTrigger | null;
  /** When the last flush left. */
  lastFlushAtMs: number | null;
}

export function emptyState(): ColdState {
  return { firstNewAtMs: null, lastNewAtMs: null, newCount: 0, chars: 0, urgent: null, lastFlushAtMs: null };
}

/**
 * The live accumulator: everything the gate did not flush yet. Novelty is
 * judged per stream over the keys seen since the last flush, plus whatever the
 * caller seeds from the log (so a restart does not mistake an old heartbeat
 * for news).
 */
export class ColdWindow {
  private state = emptyState();
  private readonly pending: PendingEvent[] = [];
  private readonly seen = new Map<string, Set<string>>();

  constructor(private params: ColdParams = FRESHNESS_PRESETS[DEFAULT_PRESET]) {}

  setParams(p: ColdParams): void {
    this.params = { idleMs: Math.min(p.idleMs, MAX_WINDOW_MS), maxMs: Math.min(p.maxMs, MAX_WINDOW_MS) };
  }

  get currentParams(): ColdParams {
    return this.params;
  }

  snapshot(): Readonly<ColdState> {
    return this.state;
  }

  /** Events accumulated (new and repeats), rowid order. */
  accumulated(): readonly PendingEvent[] {
    return this.pending;
  }

  /** Tell the window a content key already exists on a stream (seeded from the log). */
  markSeen(streamId: string, contentKey: string): void {
    this.remember(streamId, contentKey);
  }

  /** Whether a key would count as content-new right now. */
  isNew(streamId: string, contentKey: string): boolean {
    return !this.seenOf(streamId).has(contentKey);
  }

  /**
   * Accumulate one cold event. A repeat (key seen on the stream) rides along
   * but neither resets the idle clock nor counts (BND-07). Returns whether it
   * counted.
   */
  add(e: Omit<PendingEvent, "contentNew">): boolean {
    const contentNew = this.isNew(e.streamId, e.contentKey);
    this.remember(e.streamId, e.contentKey);
    this.pending.push({ ...e, contentNew });
    if (contentNew) {
      this.state.firstNewAtMs ??= e.atMs;
      this.state.lastNewAtMs = e.atMs;
      this.state.newCount += 1;
      this.state.chars += Math.max(0, e.chars);
    }
    return contentNew;
  }

  /**
   * Put a flushed event back (a retry, or a row the sink left unstamped).
   * Counts as content-new whatever the novelty memory says: it was new when it
   * arrived and it still needs a call.
   */
  readd(e: Omit<PendingEvent, "contentNew">): void {
    if (this.pending.some((p) => p.id === e.id)) return;
    this.pending.push({ ...e, contentNew: true });
    this.state.firstNewAtMs = this.state.firstNewAtMs === null ? e.atMs : Math.min(this.state.firstNewAtMs, e.atMs);
    this.state.lastNewAtMs = this.state.lastNewAtMs === null ? e.atMs : Math.max(this.state.lastNewAtMs, e.atMs);
    this.state.newCount += 1;
    this.state.chars += Math.max(0, e.chars);
  }

  /** A hot or burst decision (or a retry coming due): flush as soon as the floor allows. */
  urge(trigger: FlushTrigger): void {
    // Hot outranks every other label; either way it is "now".
    if (this.state.urgent !== "hot") this.state.urgent = trigger;
  }

  /** Whether accumulated content crossed the cap. */
  get capped(): boolean {
    return this.state.chars >= CHAR_CAP;
  }

  /**
   * When the next flush is due, or null when nothing will ever flush from
   * the current state (empty accumulator; heartbeats only).
   */
  dueAt(): { atMs: number; trigger: FlushTrigger } | null {
    const s = this.state;
    if (s.newCount === 0) return null; // empty never flushes; repeats alone never flush
    const floorAt = s.lastFlushAtMs === null ? Number.NEGATIVE_INFINITY : s.lastFlushAtMs + FLUSH_FLOOR_MS;
    if (s.urgent) return { atMs: Math.max(floorAt, s.lastNewAtMs ?? 0), trigger: s.urgent };
    if (this.capped) return { atMs: Math.max(floorAt, s.lastNewAtMs ?? 0), trigger: "cap" };
    const idleAt = (s.lastNewAtMs ?? 0) + this.params.idleMs;
    const maxAt = (s.firstNewAtMs ?? 0) + this.params.maxMs;
    return { atMs: Math.max(floorAt, Math.min(idleAt, maxAt)), trigger: "cold" };
  }

  /** Whether a flush is due at `nowMs`. */
  due(nowMs: number): { trigger: FlushTrigger } | null {
    const d = this.dueAt();
    if (!d || nowMs < d.atMs) return null;
    return { trigger: d.trigger };
  }

  /**
   * Take the flush: everything accumulated, in rowid order, up to the char cap
   * — content past the cap stays for the next flush ("forces a cut"). Resets
   * the window; the floor starts now.
   */
  flush(nowMs: number): { events: PendingEvent[]; trigger: FlushTrigger; remaining: number } {
    const trigger = this.dueAt()?.trigger ?? "cold";
    const ordered = [...this.pending].sort((a, b) => a.rowid - b.rowid);
    const taken: PendingEvent[] = [];
    let chars = 0;
    for (const e of ordered) {
      if (taken.length > 0 && e.contentNew && chars + e.chars > CHAR_CAP) break;
      taken.push(e);
      if (e.contentNew) chars += e.chars;
    }
    const takenIds = new Set(taken.map((e) => e.id));
    const rest = ordered.filter((e) => !takenIds.has(e.id));
    this.pending.length = 0;
    this.pending.push(...rest);
    const restNew = rest.filter((e) => e.contentNew);
    this.state = {
      firstNewAtMs: restNew.length > 0 ? Math.min(...restNew.map((e) => e.atMs)) : null,
      lastNewAtMs: restNew.length > 0 ? Math.max(...restNew.map((e) => e.atMs)) : null,
      newCount: restNew.length,
      chars: restNew.reduce((n, e) => n + e.chars, 0),
      urgent: null,
      lastFlushAtMs: nowMs,
    };
    return { events: taken, trigger, remaining: rest.length };
  }

  /** Drop events that no longer need a flush (stamped elsewhere, dead-lettered). */
  forget(ids: readonly string[]): void {
    const drop = new Set(ids);
    const keep = this.pending.filter((e) => !drop.has(e.id));
    if (keep.length === this.pending.length) return;
    this.pending.length = 0;
    this.pending.push(...keep);
    const news = keep.filter((e) => e.contentNew);
    this.state.firstNewAtMs = news.length > 0 ? Math.min(...news.map((e) => e.atMs)) : null;
    this.state.lastNewAtMs = news.length > 0 ? Math.max(...news.map((e) => e.atMs)) : null;
    this.state.newCount = news.length;
    this.state.chars = news.reduce((n, e) => n + e.chars, 0);
    if (news.length === 0) this.state.urgent = null;
  }

  /**
   * Seen keys survive flushes — a heartbeat is a repeat of what came before,
   * not of what came since the last call — and are bounded per stream so a
   * long-lived stream cannot grow without limit.
   */
  private remember(streamId: string, contentKey: string): void {
    const s = this.seenOf(streamId);
    if (s.has(contentKey)) return;
    s.add(contentKey);
    if (s.size > SEEN_KEYS_PER_STREAM) {
      const oldest = s.values().next().value;
      if (oldest !== undefined) s.delete(oldest);
    }
  }

  private seenOf(streamId: string): Set<string> {
    let s = this.seen.get(streamId);
    if (!s) {
      s = new Set();
      this.seen.set(streamId, s);
    }
    return s;
  }
}
