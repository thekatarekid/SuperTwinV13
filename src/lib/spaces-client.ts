// [CODE] The read/write API behind the Spaces surface — arch §14.6, build
// item 3.10.
//
// `/api/spaces` IS A FILTERED VIEW OVER `arcs`. There is no `spaces` table
// (brief rule 6): promotion is `arcs.promoted`, and a space id IS an arc id.
// The client says so in its types — `arcId` is on every row — so nobody
// reading this file can come away thinking a space is its own object.
//
//  1. ONE CARD LAYOUT, EIGHT ARCHETYPES. The differentiation is icon + accent
//     + SIGNAL STRIP, and the strip's text is composed by the worker, not
//     here: `₹1,499 due 28 Aug · unpaid` needs a ledger the browser has not
//     got. The surface renders the strip; it never invents one.
//  2. CONTEXT CLAIMS ARE COMPUTED AT QUERY TIME, NOT STORED ON THE SPACE
//     (§14.6). They arrive per-request, preferences weighted first, and the
//     `weighted` flag says which ordering rule put them there.
//  3. `[ why a space? ]` IS THE ROUTE AND THE LOOPS. `promotionReason` plus
//     `promotingLoops` — an unexplained promotion is not shippable.
//  4. AN ARC WITH NO LIVE LOOP IS NOT A SPACE. Those arcs come back in
//     `notSpaces`, browsable, and are never mixed into the list.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// Vocabulary (§11.3)
// ---------------------------------------------------------------------------

export const ARCHETYPES = ["prj", "evt", "rhy", "adm", "hld", "mat", "pur", "wch"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

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

/** §14.6's icon per archetype. The accent is the CSS modifier's job. */
export const ARCHETYPE_ICON: Readonly<Record<Archetype, string>> = {
  prj: "🎯",
  evt: "📅",
  rhy: "🔁",
  adm: "🧾",
  hld: "📦",
  mat: "🌀",
  pur: "🌱",
  wch: "👁",
};

export const ARCHETYPE_SOURCES = ["code", "model", "user"] as const;
export type ArchetypeSource = (typeof ARCHETYPE_SOURCES)[number];

export const SPACE_STATUSES = ["active", "dormant", "archived"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** The promotion routes (§14.6's markers): commitment, reference, recurrence, user. */
export const PROMOTION_REASONS = ["cmt", "ref", "rec", "usr"] as const;
export type PromotionReason = (typeof PROMOTION_REASONS)[number];

export const PROMOTION_MARKER: Readonly<Record<PromotionReason, { glyph: string; name: string }>> = {
  cmt: { glyph: "⚑", name: "commitment" },
  ref: { glyph: "⚓", name: "reference" },
  rec: { glyph: "↻", name: "recurrence" },
  usr: { glyph: "📌", name: "user" },
};

// ---------------------------------------------------------------------------
// The space
// ---------------------------------------------------------------------------

/** One loop inside a space. `ownerIsSelf` is what keeps Tasks honest. */
export interface SpaceLoopView {
  id: string;
  intent: string;
  state: string;
  dueAt: string | null;
  ownerLabel: string;
  ownerIsSelf: boolean;
}

/** A claim shown as context. Computed at query time — never stored (§14.6). */
export interface SpaceContextClaim {
  claimId: string;
  kind: string;
  text: string;
  confidence: number | null;
  /** True when the preference weighting is what surfaced it. */
  weighted: boolean;
}

export interface SpaceView {
  /** A space id IS an arc id. Both names are here so neither can be forgotten. */
  id: string;
  arcId: string;
  label: string;
  /** A user label outranks every model label (§14.8) — this says which it is. */
  labelSource: "model" | "user" | null;
  archetype: Archetype | null;
  archetypeSource: ArchetypeSource | null;
  status: SpaceStatus;
  promotionReason: PromotionReason | null;
  /** The worker's own line: `▓▓▓░░ 3 of 7`, `⏳ 31 days`, `next Sat · streak 6`. */
  signalStrip: string | null;
  pinned: boolean;
  /** Quiet, but not archived — §14.6's 💤. */
  dormantNote: string | null;
  /** Older cohorts still landing — §14.6's ◍ still growing. */
  stillGrowing: boolean;
  /** Live output on an open session (§14.0b). */
  provisional: boolean;
  endsAt: string | null;
  cadence: string | null;
  loops: SpaceLoopView[];
  people: { id: string; label: string }[];
  sources: string[];
  contextClaims: SpaceContextClaim[];
  /** `[ why a space? ]`: the rule, verbatim, and the loops that caused it. */
  promotionRule: string | null;
  promotingLoopIds: string[];
}

/** An arc with no live loop and no reference anchor. Browsable, never a space. */
export interface NotASpaceView {
  arcId: string;
  label: string;
  reason: string;
}

export interface LifeProjectView {
  id: string;
  name: string;
  /** Space (= arc) ids. A life project never owns loops of its own. */
  spaceIds: string[];
  spaceLabels: string[];
  /** Emerged and confirmed, or the user's. Never scaffolded (item 3.9). */
  emerged: boolean;
}

export interface SpacesPage {
  counts: Record<SpaceStatus, number>;
  spaces: SpaceView[];
  notSpaces: NotASpaceView[];
  lifeProjects: LifeProjectView[];
}

export interface SpaceQuery {
  status?: SpaceStatus | null;
  archetype?: Archetype | null;
  q?: string;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface SpacesClient extends CoverageClient {
  listSpaces(query: SpaceQuery, signal?: AbortSignal): Promise<SpacesPage>;
  /** The model never reverts a user archetype (§14.8). */
  setArchetype(
    p: GestureActor & { id: string; archetype: Archetype },
  ): Promise<MutationReceipt>;
  relabelSpace(p: GestureActor & { id: string; label: string }): Promise<MutationReceipt>;
  pinSpace(p: GestureActor & { id: string; pinned: boolean }): Promise<MutationReceipt>;
  archiveSpace(p: GestureActor & { id: string; archived: boolean }): Promise<MutationReceipt>;
  listGoals(signal?: AbortSignal): Promise<LifeProjectView[]>;
}

export const spacesClient: SpacesClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listSpaces: (query, signal) =>
    getJson<SpacesPage>(
      `/api/spaces${qs({
        status: query.status ?? undefined,
        archetype: query.archetype ?? undefined,
        q: query.q,
      })}`,
      signal,
    ),

  setArchetype: ({ id, archetype, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/spaces/${pathId(id)}/archetype`, { archetype, actor }),

  relabelSpace: ({ id, label, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/spaces/${pathId(id)}/relabel`, { label, actor }),

  pinSpace: ({ id, pinned, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/spaces/${pathId(id)}/pin`, { pinned, actor }),

  archiveSpace: ({ id, archived, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/spaces/${pathId(id)}/archive`, { archived, actor }),

  listGoals: (signal) => getJson<LifeProjectView[]>("/api/goals", signal),
};
