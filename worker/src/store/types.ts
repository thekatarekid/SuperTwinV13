// ===========================================================================
// Extraction engine contract types (Phase 2, spec "Extraction engine").
//
// Two stages per event batch:
//   1. assign  — route each event to an existing space, a NEW-space proposal
//                (keyed so proposals cluster across chats), or noise (ignore).
//                May also emit merge hints between existing spaces.
//   2. extract — per touched space: refreshed latest_update (always), goals
//                (≥1 invariant on new spaces), milestones only when warranted,
//                explicit tasks + implicit suggestions (tagged origin), people
//                mentioned, and pattern candidates (habit/workflow).
//
// `ExtractionLLM` is the seam: the real implementation drives the claude-local
// provider (one `claude -p` call per stage, JSON out); tests inject a fake.
// ===========================================================================

// ---- Stage 1: assign --------------------------------------------------------

/** Compact event representation given to the assign prompt. */
export interface AssignEvent {
  id: string;
  ts: string | null;
  actor: string | null;
  chat: string | null;
  text: string;
}

/** Current space directory entry given to the assign prompt. */
export interface SpaceDirectoryEntry {
  id: string;
  name: string | null;
  type: string | null;
  latest_update: string | null;
  /** People + chat names already attached to the space (routing context). */
  members: string[];
  /** User pinned this space (merge/split/rename) — never re-merge/split it. */
  user_pinned: boolean;
}

export interface AssignInput {
  events: AssignEvent[];
  spaces: SpaceDirectoryEntry[];
}

/** Proposal for a space that does not exist yet. `key` clusters proposals for
 * the SAME real-world thread across chats (same trip in 2 groups + 1 DM must
 * share one key → one space). */
export interface NewSpaceProposal {
  key: string;
  name: string;
  type: "recurring" | "one_time" | "long_running";
  permanence: "permanent" | "ephemeral";
  ends_at?: string | null;
}

export interface EventAssignment {
  event_id: string;
  /** Existing space id, when routed to a known space. */
  space_id?: string | null;
  /** New-space proposal, when no existing space fits. */
  new_space?: NewSpaceProposal | null;
  /** true = noise (greetings, stickers, chatter) — drop from extraction. */
  ignore?: boolean;
}

/** Cross-chat merge hint between two EXISTING spaces. */
export interface MergeHint {
  source_space_id: string;
  target_space_id: string;
}

export interface AssignResult {
  assignments: EventAssignment[];
  merges?: MergeHint[];
}

// ---- Stage 2: extract -------------------------------------------------------

export interface ExtractSpaceContext {
  space_id: string | null; // null for a brand-new space
  name: string;
  type: string;
  is_new: boolean;
  /** Current space.md content (empty for new spaces). */
  markdown: string;
  open_tasks: { id: string; title: string | null; origin: string | null }[];
  goals: { id: string; title: string | null }[];
}

export interface ExtractInput {
  space: ExtractSpaceContext;
  events: AssignEvent[];
}

export interface ExtractedGoal {
  title: string;
  recurring?: boolean;
}

export interface ExtractedMilestone {
  goal_title: string;
  title: string;
  status?: "open" | "done";
}

export interface ExtractedTask {
  title: string;
  origin: "explicit" | "implicit";
  source_event_ids: string[];
  goal_title?: string | null;
}

export interface ExtractedPerson {
  name: string;
  commitments?: { text: string; source_event_id?: string | null }[];
}

export interface ExtractedPattern {
  kind: "habit" | "workflow";
  title: string;
  cadence?: string | null;
  steps?: string[];
  evidence_event_ids: string[];
}

export interface ExtractResult {
  /** One-line "what you should know now". ALWAYS present (invariant). */
  latest_update: string;
  goals: ExtractedGoal[];
  milestones: ExtractedMilestone[];
  tasks: ExtractedTask[];
  people: ExtractedPerson[];
  patterns: ExtractedPattern[];
  /** Optional short state summary for space.md. */
  state?: string | null;
}

// ---- The LLM seam -----------------------------------------------------------

export interface ExtractionLLM {
  assign(input: AssignInput): Promise<AssignResult>;
  extract(input: ExtractInput): Promise<ExtractResult>;
}

// ---- Engine stream frames (contract: GET /api/extraction/stream) -----------

/** Why a backlog drain loop ended (see startDrain). */
export type DrainReason =
  | "empty"
  | "stopped"
  | "disabled"
  | "paused"
  | "quota"
  | "error";

export type ExtractionStreamFrame =
  | { type: "run_started" }
  | { type: "run_finished"; space_ids?: string[] }
  | { type: "space_updated"; space_ids: string[] }
  // Backlog drain (opt-in continuous drain of a large imported backlog).
  | { type: "drain_started"; total: number }
  | { type: "run_progress"; processed: number; remaining: number }
  | { type: "drain_finished"; reason: DrainReason };
