// ===========================================================================
// [CODE] Adapter registry + the SourceManifest contract (arch §2.1, §2.2;
// build item 1.1).
//
// A source is DATA before it is code. Everything the core needs to know about
// a source — what shape its lanes are, how "me" appears in it, which direction
// its history arrives in, where its sessions break, what it can be bridged on —
// lives in a `SourceManifest`, and the registry is the only door into the core.
//
// Two rules give the contract teeth:
//
//   1. **Validation happens at REGISTRATION, not at first use.** A manifest
//      naming a stream kind that does not exist, a manifest with no
//      `self_identity`, or an `ambient` source with `salience.prefilter:"none"`
//      is a BOOT ERROR (§2.2 notes 3 and 4). A source whose "me" cannot be
//      resolved binds every message to a stranger, and an unfiltered ambient
//      stream is 10⁵ events/day walking into a segmenter built for 10³. Neither
//      is a runtime warning; both stop the boot.
//
//   2. **Nothing else may construct an adapter.** `worker/src/index.ts` asks
//      the registry, and the registry hands back a validated pair. That is what
//      makes "adding a source = adapter + manifest, zero core file changes"
//      (§2.2 note 5) true rather than aspirational.
//
// The registry holds EXACTLY ONE adapter today (whatsapp). The plural API is
// deliberate — it is the shape the second source needs — but nothing here
// invents a second registration.
// ===========================================================================

import type { SourceAdapter } from "./source-adapter.js";

// ---- The five stream kinds (§2.1) -----------------------------------------

/**
 * The extensibility spine. A source's lanes are one of these five shapes, and
 * the shape — not the source — decides how a session ends.
 */
export const STREAM_KINDS = [
  "conversation",
  "document",
  "activity",
  "ambient",
  "bounded",
] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

export function isStreamKind(v: unknown): v is StreamKind {
  return typeof v === "string" && (STREAM_KINDS as readonly string[]).includes(v);
}

// ---- Manifest vocabularies (§2.2) -----------------------------------------

export const IDENTITY_KINDS = [
  "jid",
  "phone",
  "email",
  "handle",
  "account_id",
  "device_id",
  "profile_url",
] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export const BRIDGE_KEYS = [
  "url",
  "order_id",
  "file_id",
  "attendee_set",
  "phone",
  "email",
  "media_work_id",
  "geo_time",
] as const;
export type BridgeKey = (typeof BRIDGE_KEYS)[number];

export const ACTOR_MODELS = ["multi_actor", "single_actor"] as const;
export type ActorModel = (typeof ACTOR_MODELS)[number];

/** §2.2 note 1: `desc` is what the scheduler asks for first. */
export const BACKFILL_ORDERS = ["desc", "asc", "unordered"] as const;
export type BackfillOrder = (typeof BACKFILL_ORDERS)[number];

export const SALIENCE_PREFILTERS = ["none", "dedupe", "vad", "diff", "threshold"] as const;
export type SaliencePrefilter = (typeof SALIENCE_PREFILTERS)[number];

export const ENRICHMENT_KINDS = ["image", "video", "audio", "link", "doc"] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];

/**
 * What the core knows about a lane BEFORE its kind is decided — the argument
 * `stream_kind_of` receives. `kind` is the source's own word for the lane
 * ("dm", "group", "feed", "calendar"), never one of the five kinds.
 */
export interface StreamRef {
  external_key: string;
  kind?: string;
  label?: string;
  /** Known participants, when the source counts them. */
  participant_count?: number;
}

export interface SourceCapabilities {
  backfill: boolean;
  live: boolean;
  media: boolean;
  revisions: boolean;
  edits: boolean;
  deletion: boolean;
  /**
   * §2.2 note 1. `desc` = the source can be driven newest-page-first. `asc` or
   * `unordered` = the scheduler buffers pages and re-orders them into
   * descending cohorts itself (see `./backfill-order.ts`).
   */
  backfill_order: BackfillOrder;
  backfill_paged: boolean;
  /** Events per page the source hands back, for cohort sizing. */
  page_hint_events: number;
}

/**
 * Segmentation defaults. §2.2 note 2: these are DATA — per-source defaults,
 * per-stream overridable at runtime (`streams.segmentation_override_json`).
 *
 * `gap_ms_by_stream` is the per-lane-shape override of `gap_ms`, keyed by the
 * source's own lane word ("dm", "group"). A conversation between two people
 * tolerates a longer silence than a group before the thread is over, and the
 * manifest is where that difference belongs.
 */
export interface SourceSegmentation {
  gap_ms: number;
  gap_ms_by_stream?: Readonly<Record<string, number>>;
  size_cap_events: number;
  size_cap_chars: number;
  day_boundary: boolean;
  participant_shift: boolean;
  shift_min_gap_ms: number;
  debounce_ms: number;
}

export interface SourceEnrichment {
  kinds: readonly EnrichmentKind[];
  /** Scheduler planning input (§8.5) — how long each kind takes at p50. */
  expected_latency_ms_p50: Readonly<Partial<Record<EnrichmentKind, number>>>;
}

/**
 * How "me" appears in this source (§2.2 note 4). `value_getter` is resolved
 * lazily — the self JID is not known until the daemon pairs — and returns null
 * until it is. A manifest with no `self_identity` fails registration; a
 * `value_getter` that has not resolved yet does not.
 */
export interface SelfIdentity {
  kind: IdentityKind;
  value_getter: () => string | null;
}

/** The whole extension contract (arch §2.2). */
export interface SourceManifest<E = unknown> {
  source_id: string;
  display_name: string;
  stream_kind_of: (stream: StreamRef) => StreamKind;
  actor_model: ActorModel;
  self_identity: SelfIdentity;
  streams: { key: (ev: E) => string; label: (ev: E) => string };
  identities_emitted: readonly IdentityKind[];
  capabilities: SourceCapabilities;
  segmentation: SourceSegmentation;
  enrichment: SourceEnrichment;
  salience: { prefilter: SaliencePrefilter };
  bridge_keys: readonly BridgeKey[];
}

// ---- Boot errors ----------------------------------------------------------

/**
 * A manifest the core refuses to run with. Thrown by `validateManifest` and
 * `registerSource`; carries every problem at once, because fixing one typo per
 * boot is nobody's afternoon.
 */
export class ManifestError extends Error {
  readonly sourceId: string;
  readonly problems: readonly string[];
  constructor(sourceId: string, problems: readonly string[]) {
    super(`manifest ${JSON.stringify(sourceId)} is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ManifestError";
    this.sourceId = sourceId;
    this.problems = problems;
  }
}

/**
 * The lanes `stream_kind_of` is probed with at registration.
 *
 * The honest limit: the kind function is data-dependent, so no probe can prove
 * it never returns garbage. What the probe DOES prove is that the function
 * exists, does not throw on a lane it has never seen, and answers with one of
 * the five kinds for the ordinary shapes — which is what catches the typo
 * (`"conversations"`, `"chat"`) that would otherwise surface as a segmenter
 * with no rule, thousands of events later.
 */
const PROBE_STREAMS: readonly StreamRef[] = [
  { external_key: "__probe_dm__", kind: "dm", participant_count: 2 },
  { external_key: "__probe_group__", kind: "group", participant_count: 12 },
  { external_key: "__probe_unknown__", kind: "unknown" },
];

function isFn(v: unknown): v is (...args: never[]) => unknown {
  return typeof v === "function";
}

function positive(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Every problem with a manifest, in order. Empty = the manifest is registrable.
 *
 * `probes` overrides the lanes `stream_kind_of` is asked about — a source whose
 * kinds depend on the lane can hand the registry lanes worth probing.
 */
export function validateManifest(
  manifest: SourceManifest<never>,
  probes: readonly StreamRef[] = PROBE_STREAMS,
): string[] {
  const p: string[] = [];
  const m = manifest as unknown as Record<string, unknown>;

  if (typeof manifest?.source_id !== "string" || manifest.source_id.trim() === "") {
    p.push("source_id must be a non-empty string");
  }
  if (typeof manifest?.display_name !== "string" || manifest.display_name.trim() === "") {
    p.push("display_name must be a non-empty string");
  }

  // ---- stream_kind_of: the five kinds, nothing else (§2.1).
  if (!isFn(m.stream_kind_of)) {
    p.push("stream_kind_of must be a function (stream) => StreamKind");
  } else {
    for (const probe of probes) {
      let kind: unknown;
      try {
        kind = manifest.stream_kind_of(probe);
      } catch (err) {
        p.push(`stream_kind_of threw on ${JSON.stringify(probe.external_key)}: ${(err as Error).message}`);
        continue;
      }
      if (!isStreamKind(kind)) {
        p.push(
          `stream_kind_of(${JSON.stringify(probe.external_key)}) returned ${JSON.stringify(kind)}, ` +
            `which is not one of ${STREAM_KINDS.join(" | ")}`,
        );
        continue;
      }
      // §2.2 note 3: prefilter is MANDATORY for ambient.
      if (kind === "ambient" && manifest.salience?.prefilter === "none") {
        p.push(
          `stream_kind_of(${JSON.stringify(probe.external_key)}) is "ambient" but ` +
            `salience.prefilter is "none" — an ambient stream must be gated before segmentation (§2.1)`,
        );
      }
    }
  }

  if (!(ACTOR_MODELS as readonly string[]).includes(manifest?.actor_model as string)) {
    p.push(`actor_model must be one of ${ACTOR_MODELS.join(" | ")}`);
  }

  // ---- self_identity is MANDATORY (§2.2 note 4).
  const self = manifest?.self_identity;
  if (!self || typeof self !== "object") {
    p.push("self_identity is required — the canonical \"me\" entity binds through it");
  } else {
    if (!(IDENTITY_KINDS as readonly string[]).includes(self.kind)) {
      p.push(`self_identity.kind must be one of ${IDENTITY_KINDS.join(" | ")}`);
    }
    if (!isFn(self.value_getter)) {
      p.push("self_identity.value_getter must be a function () => string | null");
    }
  }

  if (!manifest?.streams || !isFn(manifest.streams.key) || !isFn(manifest.streams.label)) {
    p.push("streams.key and streams.label must both be functions (ev) => string");
  }

  if (!Array.isArray(manifest?.identities_emitted) || manifest.identities_emitted.length === 0) {
    p.push("identities_emitted must list at least one identity kind");
  } else {
    for (const id of manifest.identities_emitted) {
      if (!(IDENTITY_KINDS as readonly string[]).includes(id)) {
        p.push(`identities_emitted contains unknown identity kind ${JSON.stringify(id)}`);
      }
    }
  }

  // ---- capabilities.
  const cap = manifest?.capabilities;
  if (!cap || typeof cap !== "object") {
    p.push("capabilities is required");
  } else {
    for (const flag of ["backfill", "live", "media", "revisions", "edits", "deletion", "backfill_paged"] as const) {
      if (typeof cap[flag] !== "boolean") p.push(`capabilities.${flag} must be a boolean`);
    }
    if (!(BACKFILL_ORDERS as readonly string[]).includes(cap.backfill_order)) {
      p.push(`capabilities.backfill_order must be one of ${BACKFILL_ORDERS.join(" | ")}`);
    }
    if (!positive(cap.page_hint_events)) {
      p.push("capabilities.page_hint_events must be a positive number");
    }
  }

  // ---- segmentation defaults.
  const seg = manifest?.segmentation;
  if (!seg || typeof seg !== "object") {
    p.push("segmentation is required");
  } else {
    for (const n of ["gap_ms", "size_cap_events", "size_cap_chars", "shift_min_gap_ms", "debounce_ms"] as const) {
      if (!positive(seg[n])) p.push(`segmentation.${n} must be a positive number`);
    }
    for (const b of ["day_boundary", "participant_shift"] as const) {
      if (typeof seg[b] !== "boolean") p.push(`segmentation.${b} must be a boolean`);
    }
    for (const [lane, gap] of Object.entries(seg.gap_ms_by_stream ?? {})) {
      if (!positive(gap)) p.push(`segmentation.gap_ms_by_stream.${lane} must be a positive number`);
    }
    // A single-actor source has no participants to shift between (§2 fact 3).
    if (manifest.actor_model === "single_actor" && seg.participant_shift === true) {
      p.push("segmentation.participant_shift is meaningless for a single_actor source (§2 fact 3)");
    }
  }

  // ---- enrichment.
  const enr = manifest?.enrichment;
  if (!enr || !Array.isArray(enr.kinds)) {
    p.push("enrichment.kinds must be an array");
  } else {
    for (const k of enr.kinds) {
      if (!(ENRICHMENT_KINDS as readonly string[]).includes(k)) {
        p.push(`enrichment.kinds contains unknown kind ${JSON.stringify(k)}`);
      }
    }
    for (const [k, ms] of Object.entries(enr.expected_latency_ms_p50 ?? {})) {
      if (!positive(ms)) p.push(`enrichment.expected_latency_ms_p50.${k} must be a positive number`);
    }
  }

  if (!(SALIENCE_PREFILTERS as readonly string[]).includes(manifest?.salience?.prefilter as string)) {
    p.push(`salience.prefilter must be one of ${SALIENCE_PREFILTERS.join(" | ")}`);
  }

  if (!Array.isArray(manifest?.bridge_keys)) {
    p.push("bridge_keys must be an array");
  } else {
    for (const k of manifest.bridge_keys) {
      if (!(BRIDGE_KEYS as readonly string[]).includes(k)) {
        p.push(`bridge_keys contains unknown key ${JSON.stringify(k)}`);
      }
    }
  }

  return p;
}

/** Throwing form of `validateManifest` — this is the boot error. */
export function assertManifest(
  manifest: SourceManifest<never>,
  probes?: readonly StreamRef[],
): void {
  const problems = validateManifest(manifest, probes);
  if (problems.length > 0) {
    throw new ManifestError(String((manifest as { source_id?: unknown })?.source_id ?? "<unnamed>"), problems);
  }
}

// ---- The registry ---------------------------------------------------------

/** A validated source: its manifest, and the adapter that feeds it. */
export interface RegisteredSource<E = unknown> {
  manifest: SourceManifest<E>;
  adapter: SourceAdapter;
}

const REGISTRY = new Map<string, RegisteredSource<never>>();

/**
 * Validate a manifest and register its adapter. Throws `ManifestError` — a boot
 * error — when the manifest is invalid or the source is already registered.
 *
 * The `source_id` on the manifest and on the adapter must agree: the id is the
 * prefix on every event row and every `app_state` key this source owns, and two
 * spellings of it means two id spaces nothing joins.
 */
export function registerSource<E>(
  entry: RegisteredSource<E>,
  probes?: readonly StreamRef[],
): RegisteredSource<E> {
  const { manifest, adapter } = entry;
  assertManifest(manifest as unknown as SourceManifest<never>, probes);
  if (adapter.sourceId !== manifest.source_id) {
    throw new ManifestError(manifest.source_id, [
      `adapter.sourceId is ${JSON.stringify(adapter.sourceId)} but the manifest says ` +
        `${JSON.stringify(manifest.source_id)} — one source, one id`,
    ]);
  }
  if (REGISTRY.has(manifest.source_id)) {
    throw new ManifestError(manifest.source_id, ["already registered — a source id is registered once"]);
  }
  REGISTRY.set(manifest.source_id, entry as unknown as RegisteredSource<never>);
  return entry;
}

export function getSource(sourceId: string): RegisteredSource<never> | undefined {
  return REGISTRY.get(sourceId);
}

export function getManifest(sourceId: string): SourceManifest<never> | undefined {
  return REGISTRY.get(sourceId)?.manifest;
}

/** Registered source ids, sorted — the generic layer's list of sources. */
export function registeredSourceIds(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function registeredSources(): RegisteredSource<never>[] {
  return registeredSourceIds().map((id) => REGISTRY.get(id)!);
}

/** Drop every registration. Tests only — boot registers once. */
export function clearRegistry(): void {
  REGISTRY.clear();
}

// ---- Segmentation lookup --------------------------------------------------

/**
 * The gap that ends a session on this lane: the per-lane override when the
 * manifest declares one, else the source default (§2.2 note 2). Per-stream
 * runtime overrides live in `streams.segmentation_override_json` and are
 * applied by the segmenter on top of this.
 */
export function gapMsFor(manifest: SourceManifest<never>, streamKind: string | null | undefined): number {
  const byLane = manifest.segmentation.gap_ms_by_stream;
  if (byLane && streamKind && positive(byLane[streamKind])) return byLane[streamKind]!;
  return manifest.segmentation.gap_ms;
}
