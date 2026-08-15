// ===========================================================================
// Extraction + Spaces data access (Phase 2). Single-writer rules apply: this
// module is the only SQLite surface for spaces/goals/milestones/tasks/
// space_events/space_people/patterns/evaluations. In V8 only app_state (settings,
// model selection, toggles), extraction_runs (the runs viewer + quota) and
// evaluations are read at runtime; the rest are inert schema kept for the DB.
//
// Idempotency design (spec: re-run over the same events must not duplicate):
//   - space ids are deterministic from the slug ("sp:<slug>") so re-proposing
//     the same space converges; INSERT OR IGNORE keeps the first row.
//   - goal/milestone ids are deterministic from their parent + slug(title).
//   - task ids are "t:<space>:<slug(title)>:<hash(source_event_ids)>" so the
//     same extracted task collapses, while user status edits (done/dismissed)
//     survive re-runs (INSERT OR IGNORE never touches the existing row).
//   - space_events / space_people have composite PKs → INSERT OR IGNORE.
//
// The extraction cursor is the last processed events.rowid (insertion order,
// NOT event ts) so backfilled OLD events still flow through extraction exactly
// once, in arrival order, across restarts.
// ===========================================================================

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "../db/connection.js";
import { slugify } from "../brain/markdown.js";
import type { ModelRole } from "../providers/claude-local/models.js";
import { billableTokens } from "../providers/usage.js";

// ---- app_state keys ---------------------------------------------------------

// The `extraction.` prefix outlives the engine and the folder it was named for:
// these keys sit in every existing install's app_state, so renaming them would
// silently reset the switches and cursor they stand for.
export const EXTRACTION_ENABLED_KEY = "extraction.enabled";
export const EXTRACTION_CURSOR_KEY = "extraction.cursor";
/**
 * Legacy single-model key (pre per-role selection). Kept ONLY for the migration
 * fallback read in getSelectedModel — rows are never deleted. New writes go to
 * the per-role keys below.
 */
export const MODEL_KEY = "selected_model";
/** Per-role selected-model keys (empty string = subscription default). */
export const MODEL_KEY_BY_ROLE: Record<ModelRole, string> = {
  chat: "selected_model_chat",
  media: "selected_model_media",
};
/**
 * What a role falls back to when the user has not picked anything. Chat inherits
 * the subscription default (""); media reading is a high-volume background job,
 * so it pins the cheapest vision-capable model instead.
 */
export const MODEL_DEFAULT_BY_ROLE: Record<ModelRole, string> = {
  chat: "",
  media: "claude-haiku-4-5-20251001",
};
export const EXTRACTION_LAST_RUN_KEY = "extraction.last_run_ts";
export const EXTRACTION_LAST_STATUS_KEY = "extraction.last_run_status";
export const EXTRACTION_LAST_ERROR_KEY = "extraction.last_error";
/** macOS notifications toggle (default ON; value "0" disables). */
export const NOTIFICATIONS_ENABLED_KEY = "notifications.enabled";
/** Media reader: describe media as it arrives (default ON; value "0" disables). */
export const MEDIA_DESCRIBE_ENABLED_KEY = "media.describe_enabled";
/** Media reader: work through the history-sync backlog (default ON). */
export const MEDIA_BACKFILL_ENABLED_KEY = "media.backfill_enabled";
/** Media reader: photos and stickers (default ON). */
export const MEDIA_IMAGES_ENABLED_KEY = "media.images_enabled";
/** Media reader: the single thumbnail frame of a video (default OFF). */
export const MEDIA_VIDEO_ENABLED_KEY = "media.video_enabled";
/** Media reader: media in business / official-account chats (default OFF). */
export const MEDIA_BUSINESS_ENABLED_KEY = "media.business_enabled";
/**
 * Link scraper: fetch the pages links point at (default OFF). Fetching one is
 * an outbound request to a URL chosen by whoever sent the message, and is
 * observable by them — so it stays off until the user asks for it.
 */
export const MEDIA_LINK_SCRAPE_ENABLED_KEY = "media.link_scrape_enabled";
/** Media reader: descriptions per minute the backfill queue may request. */
export const MEDIA_RATE_PER_MIN_KEY = "media.rate_per_min";
export const DEFAULT_MEDIA_RATE_PER_MIN = 20;
/** Media reader: work units in flight at once (v6 §5). A batch counts as one. */
export const MEDIA_CONCURRENCY_KEY = "media.concurrency";
export const DEFAULT_MEDIA_CONCURRENCY = 5;
/**
 * Ceiling on that. Each slot holds a CLI child and a model call open, so a
 * nonsense value spends the five-hour subscription window in one burst — the
 * refusal the queue then has to back off from.
 */
export const MAX_MEDIA_CONCURRENCY = 20;
/**
 * Sample frames across a video instead of reading its one thumbnail (v5 §2,
 * default OFF). Frames are the only one of the three below that costs tokens,
 * which is why it is also the only one an install has to opt into.
 */
export const MEDIA_VIDEO_FRAMES_ENABLED_KEY = "media.video_frames_enabled";
/** Transcribe the audio track inside a video (v6 §6, default ON). */
export const MEDIA_VIDEO_AUDIO_ENABLED_KEY = "media.video_audio_enabled";
/** Transcribe voice notes and audio attachments (v6 §6, default ON). */
export const MEDIA_VOICE_NOTES_ENABLED_KEY = "media.voice_notes_enabled";
/** Seconds between sampled frames. */
export const MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY = "media.video_frame_interval_sec";
/** Ceiling on frames per video, however long it runs. */
export const MEDIA_VIDEO_FRAME_MAX_KEY = "media.video_frame_max";
/**
 * Tallest video the link reader will fetch (v7 §4). It only bites where we get
 * to choose the file — a linked video we download — because an attachment
 * arrives at whatever resolution it was sent at.
 */
export const MEDIA_VIDEO_MAX_HEIGHT_KEY = "media.video_max_height";
/** whisper.cpp model id (no `ggml-` prefix, no `.bin`). */
export const MEDIA_WHISPER_MODEL_KEY = "media.whisper_model";
export const DEFAULT_VIDEO_FRAME_INTERVAL_SEC = 5;
export const DEFAULT_VIDEO_FRAME_MAX = 8;
/**
 * Both frame bounds are clamped because together they decide how many images
 * one model call is asked to hold apart: an interval of 0 would divide by
 * nothing, and 200 frames would overrun the answer and cost the whole call.
 */
export const MAX_VIDEO_FRAME_INTERVAL_SEC = 3600;
export const MAX_VIDEO_FRAME_MAX = 20;
/**
 * 480p, because nothing downstream can use more: a sampled frame is downscaled
 * to 768 px on its longest edge, and whisper hears the audio track whatever the
 * picture was. Every pixel above this is bandwidth spent on a file that is
 * deleted minutes later.
 */
export const DEFAULT_VIDEO_MAX_HEIGHT = 480;
/** Below this nothing is legible in a frame; above it, see the default's note. */
export const MIN_VIDEO_MAX_HEIGHT = 144;
export const MAX_VIDEO_MAX_HEIGHT = 1080;
/** The model shipped inside the .app, so transcription works with no network. */
export const DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0";

/** Semantic retrieval (tier 3). Off until the user fetches the encoder. */
export const RETRIEVAL_SEMANTIC_ENABLED_KEY = "retrieval.semantic_enabled";

/** Outcome of the most recent extraction attempt (persisted for the UI). */
export type LastRunStatus = "ok" | "error" | "busy" | "noop";

// ---- Row shapes -------------------------------------------------------------

export interface PendingEventRow {
  rowid: number;
  id: string;
  ts: string | null;
  kind: string | null;
  text: string;
  actor_name: string | null;
  channel_name: string | null;
  channel_id: string | null;
}

export interface SpaceRow {
  id: string;
  name: string | null;
  type: string | null;
  permanence: string | null;
  status: string | null;
  latest_update: string | null;
  latest_update_ts: string | null;
  ends_at: string | null;
  created_at: string;
  slug: string | null;
  user_pinned: number;
}

export interface SpaceCard {
  id: string;
  name: string | null;
  type: string | null;
  permanence: string | null;
  status: string | null;
  latest_update: string | null;
  latest_update_ts: number | null;
  ends_at: number | null;
  goal_count: number;
  open_explicit_tasks: number;
  open_implicit_tasks: number;
  people: string[];
  updated_at: number;
}

export interface GoalRow {
  id: string;
  space_id: string;
  name: string | null;
  recurring: number;
}

export interface MilestoneRow {
  id: string;
  goal_id: string;
  name: string | null;
  status: string | null;
}

/**
 * Canonical task status lifecycle (contract §2). `open` is the initial value
 * written by extraction (kept for Phase 2 back-compat); the fuller lifecycle is
 * driven by the Phase 3/4 writers below.
 */
export type TaskStatus =
  | "open"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "dismissed"
  | "possibly_done";

export interface TaskRow {
  id: string;
  space_id: string;
  goal_id: string | null;
  origin: string | null;
  status: string | null;
  execute_at: string | null;
  recurrence: string | null;
  title: string | null;
  approved: number;
  source_event_ids: string | null;
  created_at: string;
  // ---- 0006 additions ----
  task_type: string | null;
  urgency: string | null;
  intent: string | null;
  triage: string | null;
  snoozed_until: string | null;
  done_evidence_event_id: string | null;
  done_confidence: string | null;
  plan: string | null;
  result: string | null;
  error: string | null;
  updated_at: string | null;
}

export interface TaskFilter {
  status?: string;
  space_id?: string;
  origin?: string;
  triage?: string;
}

export interface RunListRow {
  id: string;
  process: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /** null when the run died before the CLI reported a cost — NOT $0. */
  cost_usd: number | null;
  duration_ms: number;
  status: string;
  created_at: string;
}

/**
 * What media reading spent over a window. Media runs are logged but never
 * counted against the chat quota (v3 §1) — a background backlog must not lock
 * the user out of chat — so this is the line that keeps that spend visible.
 */
export interface MediaSpend {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  /** null when no run in the window reported a cost — NOT $0. */
  costUsd: number | null;
  runCount: number;
}

export interface PatternRow {
  slug: string;
  kind: "habit" | "workflow";
  title: string | null;
  status: "candidate" | "confirmed" | "dismissed";
  evidence_count: number;
  evidence_event_ids: string | null;
}

export interface PersonListRow {
  id: string;
  name: string | null;
  shared_spaces: string[];
  last_interaction_ts: number | null;
}

// ---- Small utils ------------------------------------------------------------

export function isoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function sourceHash(ids: string[]): string {
  const h = createHash("sha256");
  h.update([...ids].sort().join("\n"));
  return h.digest("hex").slice(0, 8);
}

export function spaceIdForSlug(slug: string): string {
  return `sp:${slug}`;
}

export function goalIdFor(spaceId: string, title: string): string {
  return `g:${spaceId}:${slugify(title)}`;
}

export function milestoneIdFor(goalId: string, title: string): string {
  return `m:${goalId}:${slugify(title)}`;
}

export function taskIdFor(
  spaceId: string,
  title: string,
  sourceEventIds: string[],
): string {
  return `t:${spaceId}:${slugify(title)}:${sourceHash(sourceEventIds)}`;
}

export function personIdForName(name: string): string {
  return `pe:${slugify(name)}`;
}

/** SQLite ISO-millis timestamp expression (matches created_at defaults). */
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/** Full `tasks` column list shared by every task-row SELECT (stable order). */
const TASK_COLUMNS = `
  id, space_id, goal_id, origin, status, execute_at, recurrence, title, approved,
  source_event_ids, created_at, task_type, urgency, intent, triage, snoozed_until,
  done_evidence_event_id, done_confidence, plan, result, error, updated_at
`;

// ---------------------------------------------------------------------------
// Prepared-statement cache (same pattern as db/index.ts).
// ---------------------------------------------------------------------------

interface Stmts {
  db: Database.Database;
  stateGet: Database.Statement;
  stateSet: Database.Statement;
  pendingEvents: Database.Statement;
  pendingCount: Database.Statement;
  maxEventRowid: Database.Statement;
  listSpaces: Database.Statement;
  listSpacesByStatus: Database.Statement;
  getSpace: Database.Statement;
  getSpaceBySlug: Database.Statement;
  insertSpace: Database.Statement;
  updateSpaceLatest: Database.Statement;
  updateSpaceName: Database.Statement;
  updateSpaceStatus: Database.Statement;
  pinSpace: Database.Statement;
  spaceGoals: Database.Statement;
  goalMilestones: Database.Statement;
  insertGoal: Database.Statement;
  insertMilestone: Database.Statement;
  spaceTasks: Database.Statement;
  getTask: Database.Statement;
  insertTask: Database.Statement;
  updateTaskStatus: Database.Statement;
  moveTask: Database.Statement;
  approveTask: Database.Statement;
  moveTasksToSpace: Database.Statement;
  scheduleTask: Database.Statement;
  snoozeTask: Database.Statement;
  rejectTask: Database.Statement;
  markTaskDone: Database.Statement;
  dueTasks: Database.Statement;
  queueableTaskIds: Database.Statement;
  queueTasks: Database.Statement;
  listRuns: Database.Statement;
  mediaSpend: Database.Statement;
  linkSpaceEvent: Database.Statement;
  moveSpaceEvents: Database.Statement;
  moveSpaceEvent: Database.Statement;
  spaceEventsPage: Database.Statement;
  spaceEventsPageBefore: Database.Statement;
  spaceChannels: Database.Statement;
  spacePeople: Database.Statement;
  linkSpacePerson: Database.Statement;
  moveSpacePeople: Database.Statement;
  goalCount: Database.Statement;
  openTaskCounts: Database.Statement;
  findPersonByName: Database.Statement;
  insertPerson: Database.Statement;
  getPerson: Database.Statement;
  listPeopleWithSpaces: Database.Statement;
  personSpaces: Database.Statement;
  personLastInteraction: Database.Statement;
  repointActors: Database.Statement;
  repointSpacePeople: Database.Statement;
  deleteSpacePersonDupes: Database.Statement;
  deletePerson: Database.Statement;
  getPattern: Database.Statement;
  listPatterns: Database.Statement;
  upsertPattern: Database.Statement;
  setPatternStatus: Database.Statement;
  insertEvaluation: Database.Statement;
  evaluationSummary: Database.Statement;
  tasksCompletedSince: Database.Statement;
  pendingProposals: Database.Statement;
  evaluationsByTypeSince: Database.Statement;
  evaluationsAll: Database.Statement;
}

let stmts: Stmts | null = null;

function s(): Stmts {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    stateGet: db.prepare(`SELECT value FROM app_state WHERE key = ?`),
    stateSet: db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    // Extraction batch: textual events past the cursor, in insertion order.
    // Reactions/system/revoked rows are noise for the extractor.
    pendingEvents: db.prepare(`
      SELECT
        e.rowid        AS rowid,
        e.id           AS id,
        e.ts           AS ts,
        e.kind         AS kind,
        COALESCE(e.text, '') AS text,
        a.display_name AS actor_name,
        c.name         AS channel_name,
        e.channel_id   AS channel_id
      FROM events e
      LEFT JOIN actors a   ON a.id = e.actor_id
      LEFT JOIN channels c ON c.id = e.channel_id
      WHERE e.rowid > @cursor
        AND e.kind NOT IN ('reaction', 'revoked', 'system')
        AND NULLIF(TRIM(e.text), '') IS NOT NULL
      ORDER BY e.rowid ASC
      LIMIT @limit
    `),
    pendingCount: db.prepare(`
      SELECT COUNT(*) AS n FROM events e
      WHERE e.rowid > @cursor
        AND e.kind NOT IN ('reaction', 'revoked', 'system')
        AND NULLIF(TRIM(e.text), '') IS NOT NULL
    `),
    maxEventRowid: db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM events`),
    listSpaces: db.prepare(`
      SELECT * FROM spaces ORDER BY COALESCE(latest_update_ts, created_at) DESC
    `),
    listSpacesByStatus: db.prepare(`
      SELECT * FROM spaces WHERE status = ?
      ORDER BY COALESCE(latest_update_ts, created_at) DESC
    `),
    getSpace: db.prepare(`SELECT * FROM spaces WHERE id = ?`),
    getSpaceBySlug: db.prepare(`SELECT * FROM spaces WHERE slug = ?`),
    insertSpace: db.prepare(`
      INSERT OR IGNORE INTO spaces
        (id, name, type, permanence, status, latest_update, latest_update_ts,
         ends_at, slug, user_pinned)
      VALUES
        (@id, @name, @type, @permanence, 'active', NULL, NULL, @endsAt, @slug, 0)
    `),
    updateSpaceLatest: db.prepare(`
      UPDATE spaces SET latest_update = @text, latest_update_ts = @ts
      WHERE id = @id
    `),
    updateSpaceName: db.prepare(`UPDATE spaces SET name = @name WHERE id = @id`),
    updateSpaceStatus: db.prepare(`UPDATE spaces SET status = @status WHERE id = @id`),
    pinSpace: db.prepare(`UPDATE spaces SET user_pinned = 1 WHERE id = ?`),
    spaceGoals: db.prepare(`
      SELECT id, space_id, name, recurring FROM goals WHERE space_id = ? ORDER BY created_at ASC, id ASC
    `),
    goalMilestones: db.prepare(`
      SELECT id, goal_id, name, status FROM milestones WHERE goal_id = ? ORDER BY created_at ASC, id ASC
    `),
    insertGoal: db.prepare(`
      INSERT OR IGNORE INTO goals (id, space_id, name, recurring)
      VALUES (@id, @spaceId, @name, @recurring)
    `),
    insertMilestone: db.prepare(`
      INSERT OR IGNORE INTO milestones (id, goal_id, name, status)
      VALUES (@id, @goalId, @name, @status)
    `),
    spaceTasks: db.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM tasks WHERE space_id = ? ORDER BY created_at ASC, id ASC
    `),
    getTask: db.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM tasks WHERE id = ?
    `),
    insertTask: db.prepare(`
      INSERT OR IGNORE INTO tasks
        (id, space_id, goal_id, origin, status, title, approved, source_event_ids)
      VALUES
        (@id, @spaceId, @goalId, @origin, 'open', @title, 0, @sourceEventIds)
    `),
    updateTaskStatus: db.prepare(`UPDATE tasks SET status = @status WHERE id = @id`),
    moveTask: db.prepare(`
      UPDATE tasks SET space_id = @spaceId, goal_id = NULL WHERE id = @id
    `),
    approveTask: db.prepare(`UPDATE tasks SET approved = 1 WHERE id = ?`),
    moveTasksToSpace: db.prepare(`
      UPDATE tasks SET space_id = @target, goal_id = NULL WHERE space_id = @source
    `),
    scheduleTask: db.prepare(`
      UPDATE tasks SET execute_at = @executeAt, recurrence = @recurrence,
        updated_at = ${NOW_SQL}
      WHERE id = @id
    `),
    // Snooze always parks the task back to 'open' (contract §3.2: possibly_done
    // returns to open, otherwise stays open) and drops it from the queue until
    // snoozed_until elapses.
    snoozeTask: db.prepare(`
      UPDATE tasks SET snoozed_until = @until, status = 'open', updated_at = ${NOW_SQL}
      WHERE id = @id
    `),
    rejectTask: db.prepare(`
      UPDATE tasks SET status = 'dismissed', updated_at = ${NOW_SQL} WHERE id = @id
    `),
    markTaskDone: db.prepare(`
      UPDATE tasks SET status = @status, done_evidence_event_id = @evidence,
        done_confidence = @confidence, updated_at = ${NOW_SQL}
      WHERE id = @id
    `),
    // Due queue: immediate queued tasks first (execute_at NULL), then scheduled
    // ones whose time has come; snoozed-in-the-future tasks are excluded.
    dueTasks: db.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM tasks
      WHERE status = 'queued'
        AND (snoozed_until IS NULL OR snoozed_until <= @now)
        AND (execute_at IS NULL OR execute_at <= @now)
      ORDER BY (execute_at IS NULL) DESC, execute_at ASC
    `),
    queueableTaskIds: db.prepare(`
      SELECT id FROM tasks
      WHERE triage = 'auto' AND status = 'open'
        AND (snoozed_until IS NULL OR snoozed_until <= @now)
    `),
    queueTasks: db.prepare(`
      UPDATE tasks SET status = 'queued', updated_at = ${NOW_SQL}
      WHERE triage = 'auto' AND status = 'open'
        AND (snoozed_until IS NULL OR snoozed_until <= @now)
    `),
    listRuns: db.prepare(`
      SELECT id, COALESCE(role, kind) AS process, COALESCE(model, '') AS model,
             input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             output_tokens, cost_usd, duration_ms, status, created_at
      FROM extraction_runs ORDER BY created_at DESC, id DESC LIMIT ?
    `),
    // SUM(cost_usd) stays NULL when no row reported one, which is how a window
    // with no cost figures is told apart from one that genuinely cost nothing.
    mediaSpend: db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0)                AS input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
             COALESCE(SUM(output_tokens), 0)               AS output_tokens,
             SUM(cost_usd)                                 AS cost_usd,
             COUNT(*)                                      AS run_count
      FROM extraction_runs
      WHERE COALESCE(role, kind) = 'media' AND created_at >= ?
    `),
    linkSpaceEvent: db.prepare(`
      INSERT OR IGNORE INTO space_events (space_id, event_id) VALUES (?, ?)
    `),
    moveSpaceEvents: db.prepare(`
      UPDATE OR IGNORE space_events SET space_id = @target WHERE space_id = @source
    `),
    moveSpaceEvent: db.prepare(`
      UPDATE OR IGNORE space_events SET space_id = @target
      WHERE space_id = @source AND event_id = @eventId
    `),
    spaceEventsPage: db.prepare(`
      SELECT e.id AS id, e.ts AS ts, a.display_name AS actor_name,
             c.name AS channel_name, e.text AS text, e.kind AS kind
      FROM space_events se
      JOIN events e ON e.id = se.event_id
      LEFT JOIN actors a   ON a.id = e.actor_id
      LEFT JOIN channels c ON c.id = e.channel_id
      WHERE se.space_id = @spaceId
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    spaceEventsPageBefore: db.prepare(`
      SELECT e.id AS id, e.ts AS ts, a.display_name AS actor_name,
             c.name AS channel_name, e.text AS text, e.kind AS kind
      FROM space_events se
      JOIN events e ON e.id = se.event_id
      LEFT JOIN actors a   ON a.id = e.actor_id
      LEFT JOIN channels c ON c.id = e.channel_id
      WHERE se.space_id = @spaceId AND e.ts < @before
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    spaceChannels: db.prepare(`
      SELECT DISTINCT c.id AS id, c.name AS name
      FROM space_events se
      JOIN events e ON e.id = se.event_id
      JOIN channels c ON c.id = e.channel_id
      WHERE se.space_id = ?
    `),
    spacePeople: db.prepare(`
      SELECT p.id AS id, p.name AS name
      FROM space_people sp JOIN people p ON p.id = sp.person_id
      WHERE sp.space_id = ? ORDER BY sp.created_at ASC
    `),
    linkSpacePerson: db.prepare(`
      INSERT OR IGNORE INTO space_people (space_id, person_id) VALUES (?, ?)
    `),
    moveSpacePeople: db.prepare(`
      UPDATE OR IGNORE space_people SET space_id = @target WHERE space_id = @source
    `),
    goalCount: db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE space_id = ?`),
    openTaskCounts: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN origin = 'explicit' AND status = 'open' THEN 1 ELSE 0 END), 0) AS explicit_open,
        COALESCE(SUM(CASE WHEN origin = 'implicit' AND status = 'open' THEN 1 ELSE 0 END), 0) AS implicit_open
      FROM tasks WHERE space_id = ?
    `),
    // Conservative entity resolution: exact case-insensitive name match only
    // (spec: person merge errors < 5% — precision over recall).
    findPersonByName: db.prepare(`
      SELECT id, name FROM people
      WHERE name IS NOT NULL AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY created_at ASC LIMIT 1
    `),
    insertPerson: db.prepare(`
      INSERT OR IGNORE INTO people (id, name) VALUES (@id, @name)
    `),
    getPerson: db.prepare(`SELECT id, name FROM people WHERE id = ?`),
    listPeopleWithSpaces: db.prepare(`
      SELECT p.id AS id, p.name AS name
      FROM people p
      WHERE EXISTS (SELECT 1 FROM space_people sp WHERE sp.person_id = p.id)
      ORDER BY p.name ASC
    `),
    personSpaces: db.prepare(`
      SELECT s.* FROM space_people sp JOIN spaces s ON s.id = sp.space_id
      WHERE sp.person_id = ?
      ORDER BY COALESCE(s.latest_update_ts, s.created_at) DESC
    `),
    personLastInteraction: db.prepare(`
      SELECT MAX(e.ts) AS ts
      FROM actors a JOIN events e ON e.actor_id = a.id
      WHERE a.person_id = ?
    `),
    repointActors: db.prepare(`
      UPDATE actors SET person_id = @target WHERE person_id = @source
    `),
    repointSpacePeople: db.prepare(`
      UPDATE OR IGNORE space_people SET person_id = @target WHERE person_id = @source
    `),
    deleteSpacePersonDupes: db.prepare(`
      DELETE FROM space_people WHERE person_id = ?
    `),
    deletePerson: db.prepare(`DELETE FROM people WHERE id = ?`),
    getPattern: db.prepare(`SELECT * FROM patterns WHERE slug = ?`),
    listPatterns: db.prepare(`
      SELECT * FROM patterns ORDER BY updated_at DESC, slug ASC
    `),
    // Existing confirmed/dismissed status is a user decision — never downgrade
    // it back to candidate; evidence keeps accumulating either way.
    upsertPattern: db.prepare(`
      INSERT INTO patterns (slug, kind, title, status, evidence_count, evidence_event_ids)
      VALUES (@slug, @kind, @title, 'candidate', @evidenceCount, @evidenceEventIds)
      ON CONFLICT(slug) DO UPDATE SET
        title              = COALESCE(excluded.title, patterns.title),
        evidence_count     = excluded.evidence_count,
        evidence_event_ids = excluded.evidence_event_ids,
        updated_at         = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    setPatternStatus: db.prepare(`
      UPDATE patterns SET status = @status,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE slug = @slug
    `),
    insertEvaluation: db.prepare(`
      INSERT INTO evaluations (output_type, output_id, verdict, note)
      VALUES (@outputType, @outputId, @verdict, @note)
    `),
    evaluationSummary: db.prepare(`
      SELECT output_type,
        SUM(CASE WHEN verdict = 'up' THEN 1 ELSE 0 END)   AS up,
        SUM(CASE WHEN verdict = 'down' THEN 1 ELSE 0 END) AS down
      FROM evaluations GROUP BY output_type
    `),
    tasksCompletedSince: db.prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE status = 'done' AND updated_at >= @ts
      ORDER BY updated_at DESC
    `),
    // Implicit (assistant-suggested) tasks still awaiting approval — mirrors the
    // UI's needsApproval (origin implicit + approved != 1) gated to open ones.
    pendingProposals: db.prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE origin = 'implicit' AND approved = 0 AND status = 'open'
      ORDER BY created_at DESC
    `),
    evaluationsByTypeSince: db.prepare(`
      SELECT output_type, verdict, COUNT(*) AS n
      FROM evaluations WHERE ts >= @ts
      GROUP BY output_type, verdict
    `),
    // Raw evaluation rows (oldest first) — the improvement loop reads down-votes
    // with notes and buckets verdicts into weekly quality snapshots.
    evaluationsAll: db.prepare(`
      SELECT id, output_type, output_id, verdict, note, ts
      FROM evaluations ORDER BY ts ASC, id ASC
    `),
  };
  return stmts;
}

/** Expose the shared handle for transactions spanning this module. */
export function extractionDb(): Database.Database {
  return s().db;
}

// ---- Extraction state (cursor + kill-switch) --------------------------------

export function getExtractionEnabled(): boolean {
  const v = s().stateGet.get(EXTRACTION_ENABLED_KEY) as { value: string | null } | undefined;
  // Default ON: extraction runs unless the user flipped the kill-switch.
  return v ? v.value !== "0" : true;
}

export function setExtractionEnabled(enabled: boolean): void {
  s().stateSet.run({ key: EXTRACTION_ENABLED_KEY, value: enabled ? "1" : "0" });
}

/** macOS notifications toggle. Default ON — off only when explicitly set to "0". */
export function getNotificationsEnabled(): boolean {
  const v = s().stateGet.get(NOTIFICATIONS_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setNotificationsEnabled(v: boolean): void {
  s().stateSet.run({ key: NOTIFICATIONS_ENABLED_KEY, value: v ? "1" : "0" });
}

// ---- Media reader settings ---------------------------------------------------

/** Describe media as it arrives. Default ON — off only when explicitly "0". */
export function getMediaDescribeEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_DESCRIBE_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setMediaDescribeEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_DESCRIBE_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Work through the already-imported media backlog. Default ON. */
export function getMediaBackfillEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_BACKFILL_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setMediaBackfillEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_BACKFILL_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Photos and stickers. Default ON — the media the reader was built for. */
export function getMediaImagesEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_IMAGES_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setMediaImagesEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_IMAGES_ENABLED_KEY, value: v ? "1" : "0" });
}

/**
 * Video thumbnails. Default OFF, so the test is inverted from every switch
 * above: an unset key must read false. Written as `=== "1"` rather than
 * `!== "0"` because those two differ exactly on the unset case, which is the
 * one that decides whether a fresh install ships this reading or not.
 */
export function getMediaVideoEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_VIDEO_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value === "1" : false;
}

export function setMediaVideoEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_VIDEO_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Media in business / official-account chats. Default OFF (inverted test). */
export function getMediaBusinessEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_BUSINESS_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value === "1" : false;
}

export function setMediaBusinessEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_BUSINESS_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Fetch link targets. Default OFF (inverted test) — it is observable traffic. */
export function getMediaLinkScrapeEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_LINK_SCRAPE_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value === "1" : false;
}

export function setMediaLinkScrapeEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_LINK_SCRAPE_ENABLED_KEY, value: v ? "1" : "0" });
}

/**
 * What the user CHOSE, or null if they never have. Null is not "off": the
 * encoder ships inside the app now, and the caller that knows whether the
 * weights are actually on disk (retrieval/embedder.ts) is the one entitled to
 * pick a default. Reading the unset row as `false` here is what left the index
 * at 0 of 595 rows on every install that never opened Settings.
 */
export function getSemanticRetrievalPreference(): boolean | null {
  const v = s().stateGet.get(RETRIEVAL_SEMANTIC_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value === "1" : null;
}

export function setSemanticRetrievalEnabled(v: boolean): void {
  s().stateSet.run({ key: RETRIEVAL_SEMANTIC_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Backfill throttle in descriptions/minute; the default when unset or garbage. */
export function getMediaRatePerMin(): number {
  const v = s().stateGet.get(MEDIA_RATE_PER_MIN_KEY) as
    | { value: string | null }
    | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MEDIA_RATE_PER_MIN;
}

export function setMediaRatePerMin(n: number): void {
  s().stateSet.run({ key: MEDIA_RATE_PER_MIN_KEY, value: String(Math.floor(n)) });
}

/** Work units the queue may have in flight; the default when unset or garbage. */
export function getMediaConcurrency(): number {
  const v = s().stateGet.get(MEDIA_CONCURRENCY_KEY) as
    | { value: string | null }
    | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MEDIA_CONCURRENCY;
  return Math.min(Math.floor(n), MAX_MEDIA_CONCURRENCY);
}

export function setMediaConcurrency(n: number): void {
  s().stateSet.run({ key: MEDIA_CONCURRENCY_KEY, value: String(Math.floor(n)) });
}

// ---- Video frames and transcription (v5 §2/§3, v6 §6) ------------------------
//
// Frame sampling reads `=== "1"`, the inverted test, for the reason spelled out
// on getMediaVideoEnabled: an unset key is exactly the case that decides whether
// a fresh install ships work nobody asked for, and a frame costs tokens.
//
// The two transcription switches read `!== "0"` — the ordinary ON-by-default
// test — because whisper is local and costs no tokens (v6 §6). The polarity is
// the whole difference between the two groups, so they cannot share a helper.

/** Sample frames across a video rather than reading its thumbnail. Default OFF. */
export function getMediaVideoFramesEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_VIDEO_FRAMES_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value === "1" : false;
}

export function setMediaVideoFramesEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_VIDEO_FRAMES_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Transcribe the audio track inside a video. Default ON — it costs no tokens. */
export function getMediaVideoAudioEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_VIDEO_AUDIO_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setMediaVideoAudioEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_VIDEO_AUDIO_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Transcribe voice notes and audio attachments. Default ON, same reason. */
export function getMediaVoiceNotesEnabled(): boolean {
  const v = s().stateGet.get(MEDIA_VOICE_NOTES_ENABLED_KEY) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setMediaVoiceNotesEnabled(v: boolean): void {
  s().stateSet.run({ key: MEDIA_VOICE_NOTES_ENABLED_KEY, value: v ? "1" : "0" });
}

/** Seconds between sampled frames; the default when unset or garbage. */
export function getMediaVideoFrameIntervalSec(): number {
  const v = s().stateGet.get(MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY) as
    | { value: string | null }
    | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VIDEO_FRAME_INTERVAL_SEC;
  return Math.min(Math.floor(n), MAX_VIDEO_FRAME_INTERVAL_SEC);
}

export function setMediaVideoFrameIntervalSec(n: number): void {
  s().stateSet.run({
    key: MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY,
    value: String(Math.floor(n)),
  });
}

/** Ceiling on frames per video; the default when unset or garbage. */
export function getMediaVideoFrameMax(): number {
  const v = s().stateGet.get(MEDIA_VIDEO_FRAME_MAX_KEY) as
    | { value: string | null }
    | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VIDEO_FRAME_MAX;
  return Math.min(Math.floor(n), MAX_VIDEO_FRAME_MAX);
}

export function setMediaVideoFrameMax(n: number): void {
  s().stateSet.run({ key: MEDIA_VIDEO_FRAME_MAX_KEY, value: String(Math.floor(n)) });
}

/**
 * Tallest linked video the reader will fetch; the default when unset or
 * garbage. Clamped at both ends, unlike the settings above: a value under the
 * floor would match no published format at all and quietly send every download
 * to whatever the site calls "worst".
 */
export function getMediaVideoMaxHeight(): number {
  const v = s().stateGet.get(MEDIA_VIDEO_MAX_HEIGHT_KEY) as
    | { value: string | null }
    | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VIDEO_MAX_HEIGHT;
  return Math.min(
    Math.max(Math.floor(n), MIN_VIDEO_MAX_HEIGHT),
    MAX_VIDEO_MAX_HEIGHT,
  );
}

export function setMediaVideoMaxHeight(n: number): void {
  s().stateSet.run({
    key: MEDIA_VIDEO_MAX_HEIGHT_KEY,
    value: String(Math.floor(n)),
  });
}

/**
 * Selected whisper model id. Defaults to the one bundled in the .app, so
 * transcription works on a machine that has never been online; whether the id
 * names a model that exists is the transcriber's to answer, not this getter's.
 */
export function getMediaWhisperModel(): string {
  const v = s().stateGet.get(MEDIA_WHISPER_MODEL_KEY) as
    | { value: string | null }
    | undefined;
  const id = v?.value?.trim();
  return id ? id : DEFAULT_WHISPER_MODEL;
}

export function setMediaWhisperModel(id: string): void {
  s().stateSet.run({ key: MEDIA_WHISPER_MODEL_KEY, value: id.trim() });
}

/** Media rows per media_desc_status — the backfill progress the UI shows. */
export interface MediaQueueCounts {
  pending: number;
  done: number;
  unsupported: number;
  error: number;
}

export function mediaQueueCounts(): MediaQueueCounts {
  const counts: MediaQueueCounts = { pending: 0, done: 0, unsupported: 0, error: 0 };
  const st = s();
  const cols = st.db.pragma("table_info(events)") as { name: string }[];
  // A DB whose events table has no description status has nothing queued.
  if (!cols.some((c) => c.name === "media_desc_status")) return counts;
  const rows = st.db
    .prepare(
      `SELECT media_desc_status AS status, COUNT(*) AS n FROM events
       WHERE media_desc_status IS NOT NULL GROUP BY media_desc_status`,
    )
    .all() as { status: string; n: number }[];
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof MediaQueueCounts] = r.n;
  }
  return counts;
}

/** Per-process on/off toggle key prefix (app_state 'process_enabled_<role>'). */
export const PROCESS_ENABLED_KEY_PREFIX = "process_enabled_";

/**
 * Per-LLM-process on/off. Default ON when unset. Each role uses its own
 * 'process_enabled_<role>' key.
 */
export function getProcessEnabled(role: ModelRole): boolean {
  const v = s().stateGet.get(`${PROCESS_ENABLED_KEY_PREFIX}${role}`) as
    | { value: string | null }
    | undefined;
  return v ? v.value !== "0" : true;
}

export function setProcessEnabled(role: ModelRole, enabled: boolean): void {
  s().stateSet.run({
    key: `${PROCESS_ENABLED_KEY_PREFIX}${role}`,
    value: enabled ? "1" : "0",
  });
}

/**
 * Selected Claude model id for a role, falling back to the role's default
 * (MODEL_DEFAULT_BY_ROLE) when unset. Migration fallback: if this role has no
 * per-role value yet AND the legacy single-model key is set, return the legacy
 * value so existing installs keep their prior choice.
 */
export function getSelectedModel(role: ModelRole): string {
  const own = s().stateGet.get(MODEL_KEY_BY_ROLE[role]) as
    | { value: string | null }
    | undefined;
  if (own?.value) return own.value;
  if (role === "chat") {
    const legacy = s().stateGet.get(MODEL_KEY) as { value: string | null } | undefined;
    if (legacy?.value) return legacy.value;
  }
  return MODEL_DEFAULT_BY_ROLE[role];
}

/** Persist the selected model id for a role. Storing "" represents/clears to default. */
export function setSelectedModel(role: ModelRole, id: string): void {
  s().stateSet.run({ key: MODEL_KEY_BY_ROLE[role], value: id });
}

/**
 * Every role selection at once (each via getSelectedModel → legacy fallback).
 * Iterates the role key map so new roles are picked up automatically (§3.7).
 */
export function getAllSelectedModels(): Record<ModelRole, string> {
  const out = {} as Record<ModelRole, string>;
  for (const role of Object.keys(MODEL_KEY_BY_ROLE) as ModelRole[]) {
    out[role] = getSelectedModel(role);
  }
  return out;
}

export function getExtractionCursor(): number {
  const v = s().stateGet.get(EXTRACTION_CURSOR_KEY) as { value: string | null } | undefined;
  const n = v?.value != null ? Number(v.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setExtractionCursor(rowid: number): void {
  s().stateSet.run({ key: EXTRACTION_CURSOR_KEY, value: String(rowid) });
}

export function getLastRunTs(): number | null {
  const v = s().stateGet.get(EXTRACTION_LAST_RUN_KEY) as { value: string | null } | undefined;
  const n = v?.value != null ? Number(v.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function setLastRunTs(ms: number): void {
  s().stateSet.run({ key: EXTRACTION_LAST_RUN_KEY, value: String(ms) });
}

export function getLastRunStatus(): LastRunStatus | null {
  const v = s().stateGet.get(EXTRACTION_LAST_STATUS_KEY) as
    | { value: string | null }
    | undefined;
  const val = v?.value ?? null;
  return val === "ok" || val === "error" || val === "busy" || val === "noop"
    ? val
    : null;
}

export function setLastRunStatus(status: LastRunStatus): void {
  s().stateSet.run({ key: EXTRACTION_LAST_STATUS_KEY, value: status });
}

export function getLastError(): string | null {
  const v = s().stateGet.get(EXTRACTION_LAST_ERROR_KEY) as
    | { value: string | null }
    | undefined;
  return v?.value ?? null;
}

export function setLastError(message: string | null): void {
  s().stateSet.run({ key: EXTRACTION_LAST_ERROR_KEY, value: message ?? "" });
}

/**
 * Record the outcome of an attempt in one shot: always stamps last_run_ts (so
 * the UI can see the engine tried), plus status and a human error string.
 */
export function recordRunOutcome(
  status: LastRunStatus,
  error: string | null = null,
): void {
  const st = s();
  const now = Date.now();
  const tx = st.db.transaction(() => {
    st.stateSet.run({ key: EXTRACTION_LAST_RUN_KEY, value: String(now) });
    st.stateSet.run({ key: EXTRACTION_LAST_STATUS_KEY, value: status });
    st.stateSet.run({ key: EXTRACTION_LAST_ERROR_KEY, value: error ?? "" });
  });
  tx();
}

export function countRunsToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const row = s()
    .db.prepare(
      `SELECT COUNT(DISTINCT run_id) AS n FROM extraction_runs
       WHERE kind LIKE 'extraction%' AND created_at >= ?`,
    )
    .get(start.toISOString()) as { n: number };
  return row.n;
}

export function pendingEventCount(): number {
  const row = s().pendingCount.get({ cursor: getExtractionCursor() }) as { n: number };
  return row.n;
}

export function fetchPendingEvents(limit = 200): PendingEventRow[] {
  return s().pendingEvents.all({
    cursor: getExtractionCursor(),
    limit,
  }) as PendingEventRow[];
}

// ---- Spaces reads -----------------------------------------------------------

export function getSpaceRow(id: string): SpaceRow | null {
  return (s().getSpace.get(id) as SpaceRow | undefined) ?? null;
}

export function getSpaceBySlug(slug: string): SpaceRow | null {
  return (s().getSpaceBySlug.get(slug) as SpaceRow | undefined) ?? null;
}

export function listSpaceRows(status?: string | null): SpaceRow[] {
  if (status) return s().listSpacesByStatus.all(status) as SpaceRow[];
  return s().listSpaces.all() as SpaceRow[];
}

export function spaceCard(row: SpaceRow): SpaceCard {
  const st = s();
  const goals = (st.goalCount.get(row.id) as { n: number }).n;
  const counts = st.openTaskCounts.get(row.id) as {
    explicit_open: number;
    implicit_open: number;
  };
  const people = (st.spacePeople.all(row.id) as { id: string; name: string | null }[])
    .map((p) => p.name ?? p.id);
  const latestMs = isoToMs(row.latest_update_ts);
  const createdMs = isoToMs(row.created_at) ?? 0;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    permanence: row.permanence,
    status: row.status,
    latest_update: row.latest_update,
    latest_update_ts: latestMs,
    ends_at: isoToMs(row.ends_at),
    goal_count: goals,
    open_explicit_tasks: counts.explicit_open,
    open_implicit_tasks: counts.implicit_open,
    people,
    updated_at: Math.max(latestMs ?? 0, createdMs),
  };
}

export function spaceGoals(spaceId: string): (GoalRow & { milestones: MilestoneRow[] })[] {
  const st = s();
  const goals = st.spaceGoals.all(spaceId) as GoalRow[];
  return goals.map((g) => ({
    ...g,
    milestones: st.goalMilestones.all(g.id) as MilestoneRow[],
  }));
}

export function spaceTasks(spaceId: string): TaskRow[] {
  return s().spaceTasks.all(spaceId) as TaskRow[];
}

export function getTaskRow(id: string): TaskRow | null {
  return (s().getTask.get(id) as TaskRow | undefined) ?? null;
}

export function spacePeopleRows(spaceId: string): { id: string; name: string | null }[] {
  return s().spacePeople.all(spaceId) as { id: string; name: string | null }[];
}

export function spaceChannels(spaceId: string): { id: string; name: string | null }[] {
  return s().spaceChannels.all(spaceId) as { id: string; name: string | null }[];
}

export interface SpaceEventOut {
  id: string;
  ts: string | null;
  actor_name: string | null;
  channel_name: string | null;
  text: string | null;
  kind: string | null;
}

export function spaceEventsPage(opts: {
  spaceId: string;
  limit?: number;
  before?: string | null;
}): SpaceEventOut[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
  const st = s();
  if (opts.before) {
    return st.spaceEventsPageBefore.all({
      spaceId: opts.spaceId,
      before: opts.before,
      limit,
    }) as SpaceEventOut[];
  }
  return st.spaceEventsPage.all({ spaceId: opts.spaceId, limit }) as SpaceEventOut[];
}

// ---- Spaces writes (extractor + user controls) -------------------------------

export interface EnsureSpaceParams {
  name: string;
  type: string;
  permanence: string;
  endsAt?: string | null;
}

/** Create (or converge on) a space keyed by slug. Returns the space row. */
export function ensureSpace(params: EnsureSpaceParams): SpaceRow {
  const slug = slugify(params.name);
  const existing = getSpaceBySlug(slug);
  if (existing) return existing;
  const id = spaceIdForSlug(slug);
  s().insertSpace.run({
    id,
    name: params.name,
    type: params.type,
    permanence: params.permanence,
    endsAt: params.endsAt ?? null,
    slug,
  });
  return getSpaceRow(id) ?? getSpaceBySlug(slug)!;
}

/**
 * Refresh the space's latest_update line. Backfill-safety: an OLD batch never
 * regresses a newer latest_update (compare on latest_update_ts).
 */
export function setLatestUpdate(spaceId: string, text: string, ts: string): void {
  const row = getSpaceRow(spaceId);
  if (!row) return;
  if (row.latest_update_ts && row.latest_update_ts > ts) return;
  s().updateSpaceLatest.run({ id: spaceId, text, ts });
}

export function renameSpace(spaceId: string, name: string): void {
  s().updateSpaceName.run({ id: spaceId, name });
  s().pinSpace.run(spaceId); // user decision — extractor must not undo it
}

export function setSpaceStatus(spaceId: string, status: "active" | "archived"): void {
  s().updateSpaceStatus.run({ id: spaceId, status });
}

export function pinSpace(spaceId: string): void {
  s().pinSpace.run(spaceId);
}

export function addGoal(spaceId: string, title: string, recurring = false): string {
  const id = goalIdFor(spaceId, title);
  s().insertGoal.run({ id, spaceId, name: title, recurring: recurring ? 1 : 0 });
  return id;
}

export function addMilestone(goalId: string, title: string, status = "open"): string {
  const id = milestoneIdFor(goalId, title);
  s().insertMilestone.run({ id, goalId, name: title, status });
  return id;
}

export interface AddTaskParams {
  spaceId: string;
  title: string;
  origin: "explicit" | "implicit";
  goalId?: string | null;
  sourceEventIds?: string[];
}

/**
 * Insert a task with a stable dedupe id. Returns the id (existing or new).
 * INSERT OR IGNORE means a user's done/dismissed status is NEVER overwritten
 * by a re-run.
 */
export function addTask(params: AddTaskParams): { id: string; inserted: boolean } {
  const ids = params.sourceEventIds ?? [];
  const id = taskIdFor(params.spaceId, params.title, ids);
  const info = s().insertTask.run({
    id,
    spaceId: params.spaceId,
    goalId: params.goalId ?? null,
    origin: params.origin,
    title: params.title,
    sourceEventIds: JSON.stringify(ids),
  });
  return { id, inserted: info.changes > 0 };
}

export function setTaskStatus(id: string, status: "open" | "done" | "dismissed"): boolean {
  return s().updateTaskStatus.run({ id, status }).changes > 0;
}

export function moveTaskToSpace(id: string, spaceId: string): boolean {
  return s().moveTask.run({ id, spaceId }).changes > 0;
}

export function approveTask(id: string): boolean {
  return s().approveTask.run(id).changes > 0;
}

// ---- Phase 3/4 task lifecycle (single writer) --------------------------------

/**
 * Persist triage output (task_type/urgency/intent/triage), optionally setting
 * execute_at/recurrence when the triage supplied a schedule. Stamps updated_at;
 * does NOT change status. (Queueing is a separate step — queueTasks /
 * setTaskState.)
 */
export function setTaskTriage(
  id: string,
  p: {
    task_type: string;
    urgency: string;
    intent: string;
    triage: "auto" | "approval";
    execute_at?: string | null;
    recurrence?: string | null;
  },
): boolean {
  const sets = [
    "task_type = @task_type",
    "urgency = @urgency",
    "intent = @intent",
    "triage = @triage",
  ];
  const params: Record<string, unknown> = {
    id,
    task_type: p.task_type,
    urgency: p.urgency,
    intent: p.intent,
    triage: p.triage,
  };
  if (p.execute_at !== undefined) {
    sets.push("execute_at = @execute_at");
    params.execute_at = p.execute_at ?? null;
  }
  if (p.recurrence !== undefined) {
    sets.push("recurrence = @recurrence");
    params.recurrence = p.recurrence ?? null;
  }
  sets.push(`updated_at = ${NOW_SQL}`);
  const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`;
  return s().db.prepare(sql).run(params).changes > 0;
}

/** Set execute_at (ISO) + recurrence; stamps updated_at. */
export function scheduleTask(
  id: string,
  executeAt: string,
  recurrence?: string | null,
): boolean {
  return (
    s().scheduleTask.run({ id, executeAt, recurrence: recurrence ?? null }).changes > 0
  );
}

/**
 * Snooze: set snoozed_until = until (ISO) and park the task back to 'open' so it
 * drops out of the queue and done-detection nagging until the snooze elapses.
 */
export function snoozeTask(id: string, until: string): boolean {
  return s().snoozeTask.run({ id, until }).changes > 0;
}

/** Patch only the provided fields; always stamps updated_at. */
export function editTask(
  id: string,
  p: {
    title?: string;
    intent?: string;
    execute_at?: string | null;
    task_type?: string;
  },
): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (p.title !== undefined) {
    sets.push("title = @title");
    params.title = p.title;
  }
  if (p.intent !== undefined) {
    sets.push("intent = @intent");
    params.intent = p.intent;
  }
  if (p.execute_at !== undefined) {
    sets.push("execute_at = @execute_at");
    params.execute_at = p.execute_at ?? null;
  }
  if (p.task_type !== undefined) {
    sets.push("task_type = @task_type");
    params.task_type = p.task_type;
  }
  sets.push(`updated_at = ${NOW_SQL}`);
  const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`;
  return s().db.prepare(sql).run(params).changes > 0;
}

/**
 * Generic status setter — the workhorse for the executor (running/done/failed)
 * and one-tap confirm. Always stamps updated_at; applies any provided extra
 * fields in the same UPDATE.
 */
export function setTaskState(
  id: string,
  status: TaskStatus,
  extra?: {
    plan?: string | null;
    result?: string | null;
    error?: string | null;
    execute_at?: string | null;
    snoozed_until?: string | null;
    done_evidence_event_id?: string | null;
    done_confidence?: string | null;
    recurrence?: string | null;
  },
): boolean {
  const sets = ["status = @status"];
  const params: Record<string, unknown> = { id, status };
  const cols: [keyof NonNullable<typeof extra>, string][] = [
    ["plan", "plan"],
    ["result", "result"],
    ["error", "error"],
    ["execute_at", "execute_at"],
    ["snoozed_until", "snoozed_until"],
    ["done_evidence_event_id", "done_evidence_event_id"],
    ["done_confidence", "done_confidence"],
    ["recurrence", "recurrence"],
  ];
  for (const [key, col] of cols) {
    if (extra && extra[key] !== undefined) {
      sets.push(`${col} = @${col}`);
      params[col] = extra[key] ?? null;
    }
  }
  sets.push(`updated_at = ${NOW_SQL}`);
  const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`;
  return s().db.prepare(sql).run(params).changes > 0;
}

/**
 * Mark a task done from incoming-event evidence. 'confirmed' -> 'done';
 * 'possible' -> 'possibly_done'. No-op (false) if the task is already
 * done/dismissed so completed things are never re-nagged.
 */
export function markTaskDone(
  id: string,
  p: { evidence_event_id?: string | null; confidence: "confirmed" | "possible" },
): boolean {
  const row = getTaskRow(id);
  if (!row) return false;
  if (row.status === "done" || row.status === "dismissed") return false;
  const status = p.confidence === "confirmed" ? "done" : "possibly_done";
  return (
    s().markTaskDone.run({
      id,
      status,
      evidence: p.evidence_event_id ?? null,
      confidence: p.confidence,
    }).changes > 0
  );
}

/** Reject a proposed/suggested task -> 'dismissed'. Stamps updated_at. */
export function rejectTask(id: string): boolean {
  return s().rejectTask.run({ id }).changes > 0;
}

/**
 * Bulk-queue: every triage='auto' task still 'open' and not snoozed-in-future
 * -> 'queued'. Returns the affected task ids. Individual queueing uses
 * setTaskState(id, 'queued').
 */
export function queueTasks(): string[] {
  const now = new Date().toISOString();
  const st = s();
  const tx = st.db.transaction(() => {
    const ids = (st.queueableTaskIds.all({ now }) as { id: string }[]).map((r) => r.id);
    st.queueTasks.run({ now });
    return ids;
  });
  return tx();
}

// ---- Phase 3/4 task reads ----------------------------------------------------

/** List tasks with a dynamic WHERE over the provided filter keys. */
export function listTasks(filter?: TaskFilter): TaskRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const keys: (keyof TaskFilter)[] = ["status", "space_id", "origin", "triage"];
  for (const key of keys) {
    const v = filter?.[key];
    if (v !== undefined) {
      where.push(`${key} = @${key}`);
      params[key] = v;
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT ${TASK_COLUMNS} FROM tasks ${clause} ORDER BY created_at ASC, id ASC`;
  return s().db.prepare(sql).all(params) as TaskRow[];
}

/** Queued tasks due to run now (immediate first, then scheduled). */
export function dueTasks(nowIso: string): TaskRow[] {
  return s().dueTasks.all({ now: nowIso }) as TaskRow[];
}

/**
 * Flat per-LLM-call log for the runs viewer. Reads extraction_runs only —
 * process = COALESCE(role, kind), model = COALESCE(model, ''). Covers every LLM
 * process (chat/extraction/triage/done_detection/planning/execution) since they
 * all log here via db.logRun.
 */
export function listRuns(limit: number): RunListRow[] {
  const rows = s().listRuns.all(limit) as {
    id: number;
    process: string;
    model: string;
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    duration_ms: number;
    status: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    process: r.process,
    model: r.model,
    input_tokens: r.input_tokens,
    cache_creation_input_tokens: r.cache_creation_input_tokens,
    cache_read_input_tokens: r.cache_read_input_tokens,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
    duration_ms: r.duration_ms,
    status: r.status,
    created_at: r.created_at,
  }));
}

/** Media reading's spend over the same window the chat quota snapshot covers. */
export function mediaSpend(windowMs: number): MediaSpend {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = s().mediaSpend.get(since) as {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    run_count: number;
  };
  const usage = {
    inputTokens: row.input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens,
  };
  return {
    ...usage,
    billableTokens: billableTokens(usage),
    costUsd: row.cost_usd,
    runCount: row.run_count,
  };
}

export function linkEventToSpace(spaceId: string, eventId: string): void {
  s().linkSpaceEvent.run(spaceId, eventId);
}

export function linkPersonToSpace(spaceId: string, personId: string): void {
  s().linkSpacePerson.run(spaceId, personId);
}

/**
 * Merge `sourceId` into `targetId`: move events/tasks/goals/people links,
 * archive the source, and pin the TARGET when the merge came from the user
 * (extractor merges do not pin). Refuses no-ops.
 */
export function mergeSpaces(
  sourceId: string,
  targetId: string,
  opts: { byUser: boolean },
): boolean {
  const st = s();
  const source = getSpaceRow(sourceId);
  const target = getSpaceRow(targetId);
  if (!source || !target || sourceId === targetId) return false;
  const tx = st.db.transaction(() => {
    st.moveSpaceEvents.run({ source: sourceId, target: targetId });
    // Any leftover duplicate joins (already present on target) just vanish
    // when the source rows are cascade-deleted; explicit cleanup:
    st.db.prepare(`DELETE FROM space_events WHERE space_id = ?`).run(sourceId);
    st.moveTasksToSpace.run({ source: sourceId, target: targetId });
    st.db
      .prepare(`UPDATE goals SET space_id = @target WHERE space_id = @source`)
      .run({ source: sourceId, target: targetId });
    st.moveSpacePeople.run({ source: sourceId, target: targetId });
    st.db.prepare(`DELETE FROM space_people WHERE space_id = ?`).run(sourceId);
    st.updateSpaceStatus.run({ id: sourceId, status: "archived" });
    if (opts.byUser) {
      st.pinSpace.run(targetId);
      st.pinSpace.run(sourceId);
    }
  });
  tx();
  return true;
}

/**
 * Split: create a new pinned space `name` and move the given events/tasks from
 * `sourceId` into it. Pins BOTH spaces (user decision). Returns the new id.
 */
export function splitSpace(
  sourceId: string,
  name: string,
  eventIds: string[],
  taskIds: string[],
): string | null {
  const st = s();
  const source = getSpaceRow(sourceId);
  if (!source) return null;
  const created = ensureSpace({
    name,
    type: source.type ?? "one_time",
    permanence: source.permanence ?? "ephemeral",
  });
  const tx = st.db.transaction(() => {
    for (const evId of eventIds) {
      st.moveSpaceEvent.run({ source: sourceId, target: created.id, eventId: evId });
    }
    for (const tId of taskIds) {
      st.db
        .prepare(`UPDATE tasks SET space_id = @target WHERE id = @id AND space_id = @source`)
        .run({ id: tId, source: sourceId, target: created.id });
    }
    st.pinSpace.run(sourceId);
    st.pinSpace.run(created.id);
  });
  tx();
  return created.id;
}

// ---- People ------------------------------------------------------------------

/**
 * Resolve an extracted person name to an existing people row (exact
 * case-insensitive match — conservative by design), or create one.
 */
export function resolveOrCreatePerson(name: string): { id: string; name: string | null } | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return null;
  const st = s();
  const found = st.findPersonByName.get(trimmed) as
    | { id: string; name: string | null }
    | undefined;
  if (found) return found;
  const id = personIdForName(trimmed);
  st.insertPerson.run({ id, name: trimmed });
  return (st.getPerson.get(id) as { id: string; name: string | null } | undefined) ?? null;
}

export function getPersonRow(id: string): { id: string; name: string | null } | null {
  return (s().getPerson.get(id) as { id: string; name: string | null } | undefined) ?? null;
}

export function listPeople(): PersonListRow[] {
  const st = s();
  const rows = st.listPeopleWithSpaces.all() as { id: string; name: string | null }[];
  return rows.map((p) => {
    const spaces = st.personSpaces.all(p.id) as SpaceRow[];
    const last = st.personLastInteraction.get(p.id) as { ts: string | null };
    return {
      id: p.id,
      name: p.name,
      shared_spaces: spaces.map((sp) => sp.name ?? sp.id),
      last_interaction_ts: isoToMs(last?.ts ?? null),
    };
  });
}

export function personSpaces(personId: string): SpaceRow[] {
  return s().personSpaces.all(personId) as SpaceRow[];
}

export function mergePeople(sourceId: string, targetId: string): boolean {
  const st = s();
  if (sourceId === targetId) return false;
  const source = getPersonRow(sourceId);
  const target = getPersonRow(targetId);
  if (!source || !target) return false;
  const tx = st.db.transaction(() => {
    st.repointActors.run({ source: sourceId, target: targetId });
    st.repointSpacePeople.run({ source: sourceId, target: targetId });
    st.deleteSpacePersonDupes.run(sourceId); // rows that clashed with target
    st.deletePerson.run(sourceId);
  });
  tx();
  return true;
}

// ---- Patterns ----------------------------------------------------------------

export function getPattern(slug: string): PatternRow | null {
  return (s().getPattern.get(slug) as PatternRow | undefined) ?? null;
}

export function listPatterns(): PatternRow[] {
  return s().listPatterns.all() as PatternRow[];
}

export function upsertPatternRow(params: {
  slug: string;
  kind: "habit" | "workflow";
  title: string;
  evidenceEventIds: string[];
}): void {
  s().upsertPattern.run({
    slug: params.slug,
    kind: params.kind,
    title: params.title,
    evidenceCount: params.evidenceEventIds.length,
    evidenceEventIds: JSON.stringify(params.evidenceEventIds),
  });
}

export function setPatternStatus(
  slug: string,
  status: "candidate" | "confirmed" | "dismissed",
): boolean {
  return s().setPatternStatus.run({ slug, status }).changes > 0;
}

// ---- Evaluations ---------------------------------------------------------------

const EVAL_OUTPUT_TYPES = new Set([
  "space",
  "task",
  "suggestion",
  "update",
  "pattern",
  "chat_answer",
  "task_result",
]);

export function isEvalOutputType(v: unknown): v is string {
  return typeof v === "string" && EVAL_OUTPUT_TYPES.has(v);
}

export function addEvaluation(params: {
  outputType: string;
  outputId: string;
  verdict: "up" | "down";
  note?: string | null;
}): void {
  s().insertEvaluation.run({
    outputType: params.outputType,
    outputId: params.outputId,
    verdict: params.verdict,
    note: params.note ?? null,
  });
}

export function evaluationSummary(): Record<string, { up: number; down: number }> {
  const rows = s().evaluationSummary.all() as {
    output_type: string;
    up: number;
    down: number;
  }[];
  const out: Record<string, { up: number; down: number }> = {};
  for (const r of rows) out[r.output_type] = { up: r.up, down: r.down };
  return out;
}

// ---- Phase 5 feedback inputs -------------------------------------------------

/** Tasks marked done with updated_at >= tsMs (epoch ms). */
export function tasksCompletedSince(tsMs: number): any[] {
  return s().tasksCompletedSince.all({ ts: new Date(tsMs).toISOString() }) as any[];
}

/** Implicit tasks still awaiting approval (open, approved = 0). */
export function pendingProposals(): any[] {
  return s().pendingProposals.all() as any[];
}

/** Eval verdict counts grouped by output_type since tsMs (epoch ms). */
export function evaluationsByTypeSince(tsMs: number): any[] {
  return s().evaluationsByTypeSince.all({ ts: new Date(tsMs).toISOString() }) as any[];
}

/** Row shape returned by {@link evaluationsAll}. */
export interface EvaluationRow {
  id: number;
  output_type: string;
  output_id: string;
  verdict: "up" | "down";
  note: string | null;
  ts: string;
}

/** All evaluation rows, oldest first (improvement loop: down-votes + weekly buckets). */
export function evaluationsAll(): EvaluationRow[] {
  return s().evaluationsAll.all() as EvaluationRow[];
}
