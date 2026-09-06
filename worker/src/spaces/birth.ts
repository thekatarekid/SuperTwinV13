// ===========================================================================
// Space birth — V6 P1 S5.1 (Build §8 lane A, Product_V6_Phase1 §13.3,
// Product_V6 §11.10 "Space birth").
//
// A space is born three ways, and only one of them is ever proposed:
//
//   INFERRED  Decide/Orient sees goal evidence → brain/commit.ts writes the
//             row with the status `spaceCreationStatus()` answers: 'proposed'
//             (the review queue) while the install is in propose-only mode,
//             'active' once it graduated. Dedupe happens there (S3.7). This
//             module only adds the sweep PREVIEW a proposal card shows.
//   ASKED     the user said it in the bar → `bornAsked()` here. Created
//             ACTIVE instantly, never proposed — even in propose-only mode,
//             which governs inference, not instruction. The utterance is the
//             birth evidence (SPC-05); the bar thread is remembered so "why?"
//             can reopen it. Dedupe still runs (§13.3 "even for user-created
//             spaces"): a near-match is an ASK, never a second space (SPC-03).
//   WOKEN     a dormant space gets a signal (calendar lead time, a message, a
//             user ask) → `wakeSpace()`: reactivated with its OLD evidence,
//             the sweep marker reset so the activation sweep runs again.
//
// The sweep runs at every birth (consolidation/sweep.ts, picked up by the
// consolidation job over `unsweptActiveSpaces()`); `sweepPreview()` is the
// zero-call look at what it WOULD pull in.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { findBirthDuplicate, type BirthDuplicate } from "../brain/space-birth.js";
import { enqueueDecide } from "../brain/decide-queue.js";
import { sweepCandidates } from "../consolidation/sweep.js";
import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { normalizeLifeArea } from "./life-areas.js";

export type BirthMode = "inferred" | "asked" | "woken";

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// ---- Sweep preview ---------------------------------------------------------

export interface SweepPreviewItem {
  episodeId: string;
  summary: string | null;
  lastTs: string | null;
  source: "unsorted" | "log";
}

export interface SweepPreview {
  spaceId: string;
  count: number;
  items: SweepPreviewItem[];
  /** One line for the proposal card: "will pull in 3 related items". */
  line: string;
}

/**
 * What the activation sweep would offer the review call for this space —
 * retrieval only (unsorted + FTS over the log), zero model calls. Shown on a
 * proposal card before the user approves (SPC-01) and reported after an
 * asked-for birth.
 */
export function sweepPreview(spaceId: string, limit = 8): SweepPreview {
  const db = getDb();
  const ids = sweepCandidates(spaceId);
  const items: SweepPreviewItem[] = [];
  for (const id of ids.slice(0, limit)) {
    const ep = db
      .prepare(
        `SELECT e.summary, e.last_ts,
                EXISTS(SELECT 1 FROM unsorted u WHERE u.episode_id = e.id) AS in_unsorted
           FROM episodes e WHERE e.id = ?`,
      )
      .get(id) as { summary: string | null; last_ts: string | null; in_unsorted: number } | undefined;
    if (!ep) continue;
    items.push({ episodeId: id, summary: ep.summary, lastTs: ep.last_ts, source: ep.in_unsorted ? "unsorted" : "log" });
  }
  const n = ids.length;
  const line = n === 0 ? "nothing related yet" : `will pull in ${n} related item${n === 1 ? "" : "s"}`;
  return { spaceId, count: n, items, line };
}

// ---- Asked-for birth -------------------------------------------------------

export interface BirthEvidence {
  quote: string;
  event_ids: string[];
  thread_id?: string | null;
}

export interface AskedBirthInput {
  label: string;
  goal?: string | null;
  lifeArea?: string | null;
  /** The bar sentence that asked for it — stored verbatim as the evidence. */
  utterance: string;
  /** The bar thread the sentence lives in ("why?" reopens it). */
  threadId?: string | null;
  /** Retrieval hits the bar already swept while parsing (exemplars). */
  exemplars?: { summary: string; event_ids: string[] }[];
  /** Skip the dedupe — the user answered "start a new one anyway". */
  forceNew?: boolean;
}

export type AskedBirthOutcome =
  | { outcome: "created"; spaceId: string; decisionId: string; label: string; preview: SweepPreview }
  | { outcome: "ask"; duplicate: BirthDuplicate; label: string };

/**
 * The imperative a bar sentence opens with is instruction, not name: "plan a
 * goa trip" names *goa trip*. Stripping it before the dedupe is what makes
 * SPC-03 an ASK rather than a second space beside `sp_goa_dec`, and it is
 * what puts a readable label on the card.
 */
const BAR_VERBS = new Set([
  "plan", "create", "start", "make", "track", "open", "add", "new", "set",
  "setup", "begin", "organise", "organize", "prepare", "book",
]);

export function barLabel(raw: string): string {
  const words = raw.trim().split(/\s+/).filter((w) => w !== "");
  let i = 0;
  if (words.length > 1 && BAR_VERBS.has(words[0]!.toLowerCase().replace(/[^a-z]/g, ""))) {
    i = 1;
    if (words[i]?.toLowerCase() === "up") i += 1; // "set up a ..."
    if (["a", "an", "the", "my", "our"].includes(words[i]?.toLowerCase() ?? "")) i += 1;
  }
  const stripped = words.slice(i).join(" ").trim();
  return stripped === "" ? raw.trim() : stripped;
}

/**
 * The bar's path. Never proposed: the row is born 'active' whatever the
 * graduation mode says. Deduped first — a live near-match returns `ask` and
 * writes nothing; the caller turns that into the one-tap question.
 */
export function bornAsked(input: AskedBirthInput): AskedBirthOutcome {
  const label = barLabel(input.label);
  if (!input.forceNew) {
    const dup = findBirthDuplicate(label, input.goal ?? null);
    if (dup) return { outcome: "ask", duplicate: dup, label };
  }
  const db = getDb();
  const spaceId = mintId("sp");
  const evidence: BirthEvidence[] = [
    { quote: input.utterance, event_ids: [], thread_id: input.threadId ?? null },
  ];
  const exemplars = input.exemplars ?? [];
  db.prepare(
    `INSERT INTO spaces (id, label, life_area, goal, status, created_by, exemplars_json,
                         born_via, birth_evidence_json, bar_thread_id, updated_at)
     VALUES (?, ?, ?, ?, 'active', 'user', ?, 'asked', ?, ?, ${NOW})`,
  ).run(
    spaceId,
    label,
    input.lifeArea ? normalizeLifeArea(input.lifeArea) : null,
    input.goal ?? null,
    JSON.stringify(exemplars),
    JSON.stringify(evidence),
    input.threadId ?? null,
  );
  const decisionId = writeDecision({
    pass: "user",
    targetKind: "space",
    targetId: spaceId,
    action: "create",
    new: {
      label,
      goal: input.goal ?? null,
      status: "active",
      created_by: "user",
      born_via: "asked",
      thread_id: input.threadId ?? null,
      forced_new: input.forceNew === true,
    },
    reason: `asked for in the bar: "${input.utterance}"`,
  });
  return { outcome: "created", spaceId, decisionId, label, preview: sweepPreview(spaceId) };
}

// ---- Woken birth -----------------------------------------------------------

export interface WakeInput {
  spaceId: string;
  /** What woke it: "calendar lead time T-14", "new message from Rohan", "user". */
  signal: string;
  by?: "code" | "user";
  runId?: string | null;
}

export interface WakeOutcome {
  woke: boolean;
  spaceId: string;
  decisionId: string | null;
  /** The evidence the space wakes WITH — its own episodes, tasks, exemplars. */
  oldEvidence: { episodes: number; openTasks: number; exemplars: unknown[] };
  reason?: string;
}

/** Mark the last unreversed sweep marker reversed so the activation sweep runs again. */
export function resetSweepMarker(spaceId: string, by: string): number {
  return getDb()
    .prepare(
      `UPDATE decisions SET reversed_at = ${NOW}, reversed_by = ?
        WHERE target_kind = 'space' AND target_id = ? AND action = 'sweep' AND reversed_at IS NULL`,
    )
    .run(by, spaceId).changes;
}

/**
 * Dormant → active with the old evidence intact (SPC-04). Nothing is
 * re-derived here: the episodes, tasks and exemplars the space already has
 * ARE the evidence it wakes with; Decide is re-queued to re-read the card and
 * the sweep runs again over what landed in unsorted while it slept.
 */
export function wakeSpace(input: WakeInput): WakeOutcome {
  const db = getDb();
  const row = db
    .prepare(`SELECT id, status, exemplars_json FROM spaces WHERE id = ?`)
    .get(input.spaceId) as { id: string; status: string; exemplars_json: string | null } | undefined;
  const evidence = (): WakeOutcome["oldEvidence"] => {
    const episodes = (db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE space_id = ?`).get(input.spaceId) as { n: number }).n;
    const openTasks = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status NOT IN ('done','cancelled','dismissed')`)
        .get(input.spaceId) as { n: number }
    ).n;
    let exemplars: unknown[] = [];
    try {
      const parsed = row?.exemplars_json ? JSON.parse(row.exemplars_json) : [];
      exemplars = Array.isArray(parsed) ? parsed : [];
    } catch {
      exemplars = [];
    }
    return { episodes, openTasks, exemplars };
  };
  if (!row) return { woke: false, spaceId: input.spaceId, decisionId: null, oldEvidence: { episodes: 0, openTasks: 0, exemplars: [] }, reason: "no such space" };
  if (row.status !== "dormant") {
    return { woke: false, spaceId: input.spaceId, decisionId: null, oldEvidence: evidence(), reason: `space is ${row.status}, not dormant` };
  }
  const old = evidence();
  db.prepare(
    `UPDATE spaces SET status = 'active', woken_at = ${NOW}, born_via = COALESCE(born_via, 'woken'),
            updated_at = ${NOW}
      WHERE id = ?`,
  ).run(input.spaceId);
  const decisionId = writeDecision({
    runId: input.runId ?? null,
    pass: input.by === "user" ? "user" : "code:wake",
    targetKind: "space",
    targetId: input.spaceId,
    action: "wake",
    old: { status: "dormant" },
    new: { status: "active", signal: input.signal, born_via: "woken", old_evidence: old },
    reason: `woken by ${input.signal} — reactivated with ${old.episodes} episode(s), ${old.openTasks} open task(s)`,
  });
  resetSweepMarker(input.spaceId, decisionId);
  enqueueDecide(input.spaceId, [], "live");
  return { woke: true, spaceId: input.spaceId, decisionId, oldEvidence: old };
}
