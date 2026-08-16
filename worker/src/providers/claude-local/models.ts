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
