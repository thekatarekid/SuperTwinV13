// ===========================================================================
// Canonical Claude model catalog — the single source of truth for the model
// picker. The worker OWNS this list and serves it over
// GET /api/settings/model; the frontend renders whatever it receives.
//
// The empty-string id ("") is the "Default (subscription)" sentinel: when it is
// the selected model the adapter passes NO `--model` flag, preserving the exact
// pre-feature behavior (subscription default) so Phase 1/2 evals do not regress.
// Every other id is passed verbatim to `claude --model <id>`.
// ===========================================================================

export interface ModelOption {
  id: string;
  label: string;
  family: string;
}

// ===========================================================================
// The CURATED FALLBACK registry (defect 6).
//
// discovery.ts reads the real list — versions, per-million prices, reasoning
// levels — straight out of this machine's `claude` binary, because a list
// hardcoded here is a list that is wrong the day the CLI updates. This is what
// answers when that read cannot: no `claude` on the box, a build that moved
// its catalogue, a parse that did not recognise the shape.
//
// It is deliberately NOT the same thing as MODEL_CATALOG above (which is the
// §4.2 subscription-default picker and keeps its "" sentinel). Every row here
// is a version anyone can price, and Settings SAYS when it is showing this
// list rather than the discovered one — a stale list presented as live is the
// failure mode this whole module exists to avoid.
//
// Prices are USD per million tokens, read from the CLI's own pricing tiers at
// the revision this was pinned against (2.1.246).
// ===========================================================================

export type CuratedThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CuratedModel {
  /** What `claude --model` is given. */
  id: string;
  label: string;
  family: string;
  /** True for a moving family alias; those keep working for stored settings. */
  alias: boolean;
  resolvesTo?: string;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** Empty = this model has no reasoning dial at all. */
  thinkingLevels: readonly CuratedThinkingLevel[];
  /** True when the levels drive `--effort`, false for MAX_THINKING_TOKENS. */
  effort: boolean;
  contextWindow: number | null;
}

/** The full extended-thinking ladder (§4.3), for models with no `--effort`. */
const LADDER = ["off", "low", "medium", "high", "xhigh", "max"] as const;

export const FALLBACK_MODEL_CATALOG: readonly CuratedModel[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    family: "haiku",
    alias: false,
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingLevels: LADDER,
    effort: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",
    family: "sonnet",
    alias: false,
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingLevels: LADDER,
    effort: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    family: "sonnet",
    alias: false,
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    effort: true,
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    family: "sonnet",
    alias: false,
    inputPerMTok: 2,
    outputPerMTok: 10,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "claude-opus-4-5-20251101",
    label: "Opus 4.5",
    family: "opus",
    alias: false,
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: LADDER,
    effort: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    family: "opus",
    alias: false,
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    effort: true,
    contextWindow: 200_000,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    family: "opus",
    alias: false,
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    family: "opus",
    alias: false,
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    family: "opus",
    alias: false,
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    // Fable rejects a disabled reasoning budget, so "off" is not offered.
    id: "claude-fable-5",
    label: "Fable 5",
    family: "fable",
    alias: false,
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "haiku",
    label: "Haiku (latest → Haiku 4.5)",
    family: "haiku",
    alias: true,
    resolvesTo: "claude-haiku-4-5-20251001",
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingLevels: LADDER,
    effort: false,
    contextWindow: 200_000,
  },
  {
    id: "sonnet",
    label: "Sonnet (latest → Sonnet 5)",
    family: "sonnet",
    alias: true,
    resolvesTo: "claude-sonnet-5",
    inputPerMTok: 2,
    outputPerMTok: 10,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "opus",
    label: "Opus (latest → Opus 5)",
    family: "opus",
    alias: true,
    resolvesTo: "claude-opus-5",
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingLevels: LADDER,
    effort: true,
    contextWindow: 1_000_000,
  },
  {
    id: "fable",
    label: "Fable (latest → Fable 5)",
    family: "fable",
    alias: true,
    resolvesTo: "claude-fable-5",
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: true,
    contextWindow: 1_000_000,
  },
];

/**
 * The catalog, in display order. The first entry ("") is the default sentinel;
 * "latest" aliases (opus/sonnet/haiku/fable) sit above their pinned versions
 * within each family. Keep this list and DEFAULT_MODEL_ID in sync.
 */
export const MODEL_CATALOG: ModelOption[] = [
  { id: "", label: "Default (subscription)", family: "Default" },
  { id: "opus", label: "Opus (latest)", family: "Opus" },
  { id: "claude-opus-4-8", label: "Opus 4.8", family: "Opus" },
  { id: "claude-opus-4-5-20251101", label: "Opus 4.5", family: "Opus" },
  { id: "sonnet", label: "Sonnet (latest)", family: "Sonnet" },
  { id: "claude-sonnet-5", label: "Sonnet 5", family: "Sonnet" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", family: "Sonnet" },
  { id: "haiku", label: "Haiku (latest)", family: "Haiku" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", family: "Haiku" },
  { id: "fable", label: "Fable (latest)", family: "Fable" },
  { id: "claude-fable-5", label: "Fable 5", family: "Fable" },
];

/** The default selection: "" = subscription default (no `--model` flag). */
export const DEFAULT_MODEL_ID = "";

/**
 * True iff `id` matches the `id` of some catalog entry. Note "" is VALID — it is
 * the default sentinel. Used to reject arbitrary/unknown ids at the API edge.
 */
export function isValidModelId(id: string): boolean {
  return MODEL_CATALOG.some((m) => m.id === id);
}

// ===========================================================================
// Per-role model selection. The worker OWNS this list and serves it over
// GET /api/settings/models; the frontend renders whatever it receives.
//
// Every step has its own picker (arch §4.2): the defaults below are a starting
// point and the gold set decides. Judgment steps (entity, episode, arc, extract,
// adjudicate) default to Sonnet 5 — the entity pass and the claims+loops pass
// stay SEPARATE calls because one merged call loses roster discipline. The
// mechanical steps (media, triage, done_detect, classify) default to Haiku 4.5.
// Chat keeps "" — the subscription default.
//
// The picker is data-driven, so adding a role here is all the UI needs; the
// per-role app_state keys and defaults live in db/settings.ts.
// ===========================================================================

export type ModelRole =
  | "chat"
  | "media"
  | "entity"
  | "episode"
  | "arc"
  | "extract"
  | "triage"
  | "done_detect"
  | "classify"
  | "adjudicate";

export interface RoleOption {
  key: ModelRole;
  label: string;
  description: string;
  future: boolean;
}

export const MODEL_ROLES: RoleOption[] = [
  { key: "chat", label: "Chat", description: "Interactive chat and agent replies", future: false },
  {
    key: "media",
    label: "Media reading",
    description: "Reads images and documents attached to your messages",
    future: false,
  },
  {
    key: "entity",
    label: "People and things",
    description: "Names who and what a conversation is about",
    future: false,
  },
  {
    key: "episode",
    label: "Episodes",
    description: "Cuts a stream of messages into episodes",
    future: false,
  },
  {
    key: "arc",
    label: "Arcs",
    description: "Decides which running thread an episode belongs to",
    future: false,
  },
  {
    key: "extract",
    label: "Claims and loops",
    description: "Reads claims and open loops out of an episode",
    future: false,
  },
  {
    key: "triage",
    label: "Triage",
    description: "Sorts open loops by what needs you first",
    future: false,
  },
  {
    key: "done_detect",
    label: "Done detection",
    description: "Notices when an open loop has already been closed",
    future: false,
  },
  {
    key: "classify",
    label: "Labels",
    description: "Names arcs and spaces and gives them an archetype",
    future: false,
  },
  {
    key: "adjudicate",
    label: "Adjudication",
    description: "Settles identity matches and contradictory claims",
    future: false,
  },
];

/** True iff `r` is one of the known role keys. Used to reject bad roles at the edge. */
export function isValidRole(r: string): r is ModelRole {
  return MODEL_ROLES.some((x) => x.key === r);
}
