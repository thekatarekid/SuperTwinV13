// ===========================================================================
// [CODE] Session policies — the five stream-kind boundary rules (arch §2.1,
// §10.4; build item 1.7).
//
// Sessions are MECHANICAL. Nothing in this directory calls a model, and nothing
// in this directory may: a boundary that needed a verdict could not be replayed
// byte-for-byte, and §10.4's whole claim is that the same segmenter runs over
// 24 months of backfill and over the live tail and lands on the same cuts.
//
// This file holds the PARAMETERS and the vocabulary; `./segment.ts` holds the
// walk that applies them.
//
// Where the numbers come from, in order of authority (last wins):
//
//   1. KIND_DEFAULTS below — arch §10.4's documented defaults per stream kind.
//      These are the fallback for the fields a manifest has no slot for
//      (ceilings, the ambient silence threshold, whether caps apply at all).
//   2. The ADAPTER MANIFEST's `segmentation` block (`gap_ms`,
//      `gap_ms_by_stream`, `shift_min_gap_ms`, `size_cap_events`,
//      `size_cap_chars`, `day_boundary`, `participant_shift`, `debounce_ms`).
//      A source's windows are DATA (§2.2 note 2) — they are not constants in
//      the segmenter, and a second source must be able to disagree with
//      WhatsApp about what six hours of silence means.
//   3. `streams.segmentation_override_json` — the per-stream override. A group
//      that is really a broadcast, or the self-chat where a participant shift
//      is meaningless (§2 fact 3), says so here.
//
// The measured value of every rule is recorded alongside the reason, so a
// boundary can always answer "why here, and by how much".
// ===========================================================================

import {
  gapMsFor,
  type SourceManifest,
  type SourceSegmentation,
  type StreamKind,
} from "../adapters/registry.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// ---- vocabulary ------------------------------------------------------------

/**
 * Why a session started or ended. The first ten are the list carried on the
 * `sessions` table in migration 0020; the last two are §10.4's own words for
 * cases that list does not spell out:
 *
 *   - `author_shift`  — §10.4 DOCUMENT. A document has authors, not
 *                       participants, and calling this `participant_shift`
 *                       would hide which rule actually fired.
 *   - `late_arrival`  — §10.4 note 8. An event that lands inside a sealed
 *                       session's range opens a NEW session, and this is why
 *                       that session exists.
 */
export const BOUNDARY_REASONS = [
  "gap",
  "participant_shift",
  "reply_break",
  "size_cap",
  "day_boundary",
  "context_shift",
  "record_bounded",
  "ceiling",
  "debounce",
  "stream_start",
  "author_shift",
  "late_arrival",
] as const;
export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

export function isBoundaryReason(v: unknown): v is BoundaryReason {
  return typeof v === "string" && (BOUNDARY_REASONS as readonly string[]).includes(v);
}

/** §10.4 sealing. `immediate` = bootstrap, `debounce` = steady, `ceiling` = the clock ran out. */
export const SEAL_MODES = ["immediate", "debounce", "ceiling"] as const;
export type SealMode = (typeof SEAL_MODES)[number];

/** Which scheduling regime the segmenter is running under. */
export const RUN_MODES = ["bootstrap", "steady"] as const;
export type SegmentRunMode = (typeof RUN_MODES)[number];

/**
 * ~4 chars per token on this corpus — the same ratio the WhatsApp manifest
 * documents on `size_cap_chars`. The cap is COUNTED in chars because the
 * segmenter must not need a tokenizer to find a boundary; it is REPORTED in
 * tokens because that is the number §10.4 states.
 */
export const CHARS_PER_TOKEN = 4;

export function tokensOfChars(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ---- the resolved policy ---------------------------------------------------

/**
 * Everything the walk needs, already resolved. No lookups happen inside the
 * walk: a boundary decided by a value that could still change is a boundary
 * that cannot be replayed.
 */
export interface SessionPolicy {
  kind: StreamKind;
  /** Silence that ends a session. `gap > gap_ms` cuts; exactly `gap_ms` does not. */
  gap_ms: number;
  /** A participant shift below this gap is turn-taking, not a new session. */
  shift_min_gap_ms: number;
  /** Hard event cap. `Infinity` = no cap (BOUNDED). */
  size_cap_events: number;
  /** Hard text cap in chars. `Infinity` = no cap. */
  size_cap_chars: number;
  /** Cut at local midnight in the STREAM's tz. */
  day_boundary: boolean;
  /** Only ever true for a multi-actor lane (§2 fact 3). */
  participant_shift: boolean;
  /** DOCUMENT: a different author is a different sitting, with no min gap. */
  author_shift: boolean;
  /** A reply targeting an event older than `gap_ms` opens a new session. */
  reply_break: boolean;
  /** ACTIVITY/AMBIENT: domain · app id · vertical · speaker · scene. */
  context_shift: boolean;
  /** AMBIENT: silence longer than this is a context shift. 0 = off. */
  silence_ms: number;
  /** Wall-clock span after which the session seals no matter what. `Infinity` = none. */
  ceiling_ms: number;
  /** AMBIENT: accumulated ACTIVE content span that caps a session. `Infinity` = none. */
  active_cap_ms: number;
  /** Steady-state quiet window before a live session is worth sealing. */
  debounce_ms: number;
  /** BOUNDED: the record IS the session, so no cap of any kind applies. */
  caps_apply: boolean;
  /** ACTIVITY: a transaction is ALWAYS its own single-event session (§2.1). */
  transaction_isolates: boolean;
}

/** The subset of a policy a manifest or a per-stream override may state. */
export type PolicyOverride = Partial<SessionPolicy>;

/**
 * §10.4's defaults, per kind. These are the FALLBACK — a manifest that states
 * a window overrides the row it lands in.
 */
export const KIND_DEFAULTS: Readonly<Record<StreamKind, SessionPolicy>> = {
  //  gap > G (6h 1:1 / 4h group, per-stream) ∪ participant shift ∪ reply-chain
  //  break ∪ 40 events / 6k tokens ∪ local midnight; 24h ceiling.
  conversation: {
    kind: "conversation",
    gap_ms: 6 * HOUR,
    shift_min_gap_ms: 1 * HOUR,
    size_cap_events: 40,
    size_cap_chars: 6_000 * CHARS_PER_TOKEN,
    day_boundary: true,
    participant_shift: true,
    author_shift: false,
    reply_break: true,
    context_shift: false,
    silence_ms: 0,
    ceiling_ms: 24 * HOUR,
    active_cap_ms: Infinity,
    debounce_ms: 45 * MINUTE,
    caps_apply: true,
    transaction_isolates: false,
  },
  //  revision gap > 45m ∪ author shift ∪ 200-revision cap.
  document: {
    kind: "document",
    gap_ms: 45 * MINUTE,
    shift_min_gap_ms: 0,
    size_cap_events: 200,
    size_cap_chars: Infinity,
    day_boundary: false,
    participant_shift: false,
    author_shift: true,
    reply_break: false,
    context_shift: false,
    silence_ms: 0,
    ceiling_ms: 24 * HOUR,
    active_cap_ms: Infinity,
    debounce_ms: 45 * MINUTE,
    caps_apply: true,
    transaction_isolates: false,
  },
  //  gap > 30m ∪ context shift (registrable domain / app id / commerce
  //  vertical) ∪ 100-event cap; kind=order ALWAYS seals alone.
  activity: {
    kind: "activity",
    gap_ms: 30 * MINUTE,
    shift_min_gap_ms: 0,
    size_cap_events: 100,
    size_cap_chars: Infinity,
    day_boundary: false,
    participant_shift: false,
    author_shift: false,
    reply_break: false,
    context_shift: true,
    silence_ms: 0,
    ceiling_ms: 24 * HOUR,
    active_cap_ms: Infinity,
    debounce_ms: 30 * MINUTE,
    caps_apply: true,
    transaction_isolates: true,
  },
  //  after prefilter: context shift (app · speaker · scene · silence > 90s)
  //  ∪ 10-min cap ∪ 15-min ceiling.
  //
  //  The two ambient limits are not the same limit twice. `active_cap_ms`
  //  counts CONTENT — the span between frames that survived the perceptual
  //  collapse — so a stream that keeps changing is cut every ten minutes.
  //  `ceiling_ms` counts the WALL CLOCK, so a single app stared at for sixteen
  //  minutes (which collapses to one frame and accrues no active span) is still
  //  cut, at fifteen. Without both, one of §10.4's two numbers is unreachable.
  ambient: {
    kind: "ambient",
    // §10.4 files ambient silence under CONTEXT SHIFT, not under the gap rule —
    // "app · speaker · scene · silence > 90s" is one rule with four triggers.
    // Giving ambient a gap window too would report `gap` for a silence that
    // §10.4 calls a context shift, so the gap rule is off and `silence_ms` owns
    // it. A source that genuinely wants a separate window states one.
    gap_ms: Infinity,
    shift_min_gap_ms: 0,
    size_cap_events: Infinity,
    size_cap_chars: Infinity,
    day_boundary: false,
    participant_shift: false,
    author_shift: false,
    reply_break: false,
    context_shift: true,
    silence_ms: 90 * SECOND,
    ceiling_ms: 15 * MINUTE,
    active_cap_ms: 10 * MINUTE,
    debounce_ms: 10 * MINUTE,
    caps_apply: true,
    transaction_isolates: false,
  },
  //  session = the record. Caps do NOT apply.
  bounded: {
    kind: "bounded",
    gap_ms: Infinity,
    shift_min_gap_ms: 0,
    size_cap_events: Infinity,
    size_cap_chars: Infinity,
    day_boundary: false,
    participant_shift: false,
    author_shift: false,
    reply_break: false,
    context_shift: false,
    silence_ms: 0,
    ceiling_ms: Infinity,
    active_cap_ms: Infinity,
    debounce_ms: 0,
    caps_apply: false,
    transaction_isolates: false,
  },
};

// ---- resolution ------------------------------------------------------------

export interface ResolvePolicyInput {
  kind: StreamKind;
  /** The adapter manifest's `segmentation` block, when the lane has a source. */
  segmentation?: SourceSegmentation | null;
  /** The source's own word for the lane ("dm", "group") — picks `gap_ms_by_stream`. */
  lane?: string | null;
  /** `streams.segmentation_override_json`, already parsed. */
  override?: PolicyOverride | null;
  /** §2 fact 3 — a single-actor lane has no participants to shift between. */
  actor_model?: "multi_actor" | "single_actor";
}

function positive(n: unknown): n is number {
  return typeof n === "number" && !Number.isNaN(n) && n > 0;
}

/**
 * The policy this lane is segmented by. Pure: same input, same object, so two
 * runs of the segmenter cannot disagree about the window they measured against.
 */
export function resolvePolicy(input: ResolvePolicyInput): SessionPolicy {
  const base = KIND_DEFAULTS[input.kind];
  if (!base) throw new Error(`unknown stream kind ${JSON.stringify(input.kind)}`);
  const policy: SessionPolicy = { ...base };

  const seg = input.segmentation;
  if (seg) {
    // BOUNDED is exempt: §10.4 says caps do not apply, and a manifest that
    // ships a cap did not mean it for a lane whose record already has an end.
    const capped = policy.caps_apply;
    // The per-lane override rule lives on the registry; reusing it here is the
    // point — two spellings of "which gap governs this lane" is one too many.
    const gap = gapMsFor({ segmentation: seg } as unknown as SourceManifest<never>, input.lane ?? undefined);
    if (positive(gap)) policy.gap_ms = gap;
    if (positive(seg.shift_min_gap_ms)) policy.shift_min_gap_ms = seg.shift_min_gap_ms;
    if (capped && positive(seg.size_cap_events)) policy.size_cap_events = seg.size_cap_events;
    if (capped && positive(seg.size_cap_chars)) policy.size_cap_chars = seg.size_cap_chars;
    if (typeof seg.day_boundary === "boolean") policy.day_boundary = seg.day_boundary;
    if (typeof seg.participant_shift === "boolean") policy.participant_shift = seg.participant_shift;
    if (positive(seg.debounce_ms)) policy.debounce_ms = seg.debounce_ms;
  }

  if (input.actor_model === "single_actor") policy.participant_shift = false;

  for (const [key, value] of Object.entries(input.override ?? {})) {
    if (value === undefined) continue;
    (policy as unknown as Record<string, unknown>)[key] = value;
  }

  // A shift needs BOTH halves of the conjunction to mean anything: with no
  // minimum gap every turn is a "shift", which is the bug §10.4 names.
  if (policy.participant_shift && !positive(policy.shift_min_gap_ms)) {
    policy.participant_shift = false;
  }
  return policy;
}

/**
 * Parse `streams.segmentation_override_json`. A malformed override is IGNORED
 * rather than fatal — the manifest's defaults are always a valid policy, and
 * refusing to segment a stream because someone typed a bad JSON blob into a
 * settings row would lose the stream, not fix the blob.
 */
export function parseOverride(json: string | null | undefined): PolicyOverride | null {
  if (typeof json !== "string" || json.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: PolicyOverride = {};
  const rec = raw as Record<string, unknown>;
  const numeric = [
    "gap_ms",
    "shift_min_gap_ms",
    "size_cap_events",
    "size_cap_chars",
    "silence_ms",
    "ceiling_ms",
    "active_cap_ms",
    "debounce_ms",
  ] as const;
  for (const key of numeric) {
    const v = rec[key];
    if (typeof v === "number" && !Number.isNaN(v) && v >= 0) (out as Record<string, unknown>)[key] = v;
  }
  const flags = [
    "day_boundary",
    "participant_shift",
    "author_shift",
    "reply_break",
    "context_shift",
    "caps_apply",
    "transaction_isolates",
  ] as const;
  for (const key of flags) {
    const v = rec[key];
    if (typeof v === "boolean") (out as Record<string, unknown>)[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---- time ------------------------------------------------------------------

/**
 * An ISO stamp as epoch ms. An unparseable one reads as 0 rather than NaN: a
 * NaN would poison every comparison it touched and turn one malformed row into
 * a stream with no boundaries at all.
 */
export function tsMs(iso: string | null | undefined): number {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

// ---- local time (§10.4 note 6) --------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz });
  } catch {
    // An unknown zone falls back to UTC rather than throwing: a stream with a
    // typo'd tz still has to be segmented, and every other rule still works.
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
  }
  formatters.set(tz, fmt);
  return fmt;
}

/**
 * The local calendar day (`YYYY-MM-DD`) an instant falls on IN THE STREAM'S TZ.
 * Midnight is not a UTC fact — 23:50 and 00:01 in Asia/Kolkata are two days
 * apart while their UTC stamps sit inside the same one.
 */
export function localDayKey(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return "";
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** True when `next` falls on a later local day than `prev` in the stream's tz. */
export function crossesDayBoundary(prevMs: number, nextMs: number, tz: string): boolean {
  return localDayKey(prevMs, tz) !== localDayKey(nextMs, tz);
}

// ---- context keys (ACTIVITY / AMBIENT) ------------------------------------

/**
 * Multi-label public suffixes seen on this corpus. Not a full PSL — a full one
 * is a 200 KB data file that would have to be kept fresh, and getting
 * `zomato.co.in` wrong costs one extra session boundary, not a wrong claim.
 */
const MULTI_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.in",
  "net.in",
  "org.in",
  "co.jp",
  "co.nz",
  "co.za",
  "com.au",
  "net.au",
  "com.br",
  "com.sg",
  "com.mx",
]);

/**
 * The REGISTRABLE domain of a URL — `www.zomato.com/order/12` and
 * `zomato.com/x` are one context, `airbnb.com` is another. Returns null when
 * there is no host to read.
 */
export function registrableDomain(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  let host = url.trim();
  const scheme = host.indexOf("://");
  if (scheme !== -1) host = host.slice(scheme + 3);
  host = host.split("/")[0]!.split("?")[0]!.split("#")[0]!;
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  host = host.split(":")[0]!.toLowerCase();
  if (host === "") return null;
  const labels = host.split(".").filter((l) => l !== "");
  if (labels.length <= 2) return labels.join(".") || null;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}
