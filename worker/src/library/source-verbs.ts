// ===========================================================================
// The verbs — V6 P1 S1.7 (Build §4.2 [D]; backlog T4-11, T4-12; Product_V6_
// Phase1 §Sources 3). Pause · resume · disconnect · delete per source, forget
// the last N minutes, and review-and-delete what was understood outside a
// shortened window. Every delete is a PREVIEW first, then a cascade, never a
// raw DELETE.
//
//   Consent flips BEFORE teardown (T4-11).  pauseSource / disconnectSource /
//   deleteSource write the consent row first and only then stop the adapter.
//   A teardown that throws is logged and swallowed: the funnel gate reads the
//   row, not the adapter, so capture is already blocked when the driver
//   misbehaves (CNS-06). Resume is the mirror: row → 'connected', then start.
//
//   Preview = dry run.  previewCascade() runs the real hardDeleteEvents()
//   inside an outer transaction and rolls it back, so the numbers on the
//   confirm card are exactly the numbers the confirm will produce — the same
//   code path, not an estimate. better-sqlite3 nests the inner transaction as
//   a savepoint; the outer rollback undoes everything including the tombstone.
//
//   Delete goes through hardDeleteEvents (T4-12).  deleteSourceData() replaces
//   db/ingest.resetSourceData: cascade first, then the stream / channel /
//   actor shells, orphaned legacy people, coverage rows and import flags. No
//   episode, claim, task or edge cites a deleted event afterwards (CNS-07).
//
//   Shortening keeps understanding (D4, CNS-08).  Rows understood before the
//   UNDERSTAND floor moved stay as they are; outsideWindowEpisodes() lists the
//   episodes that now lie before the floor, labelled, and
//   deleteOutsideWindow() removes exactly those — their member events through
//   the cascade — on the user's say-so.
//
// Zero model calls. SQLite + the supervisor's drivers only.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateDelete, importDoneKey, importRangeKey } from "../db/ingest.js";
import {
  captureAllowed,
  getConsent,
  revokeConsent,
  setConsentState,
  type ConsentRow,
  type ConsentState,
} from "../db/v6core.js";
import {
  disarmScreenRecording,
  getSourceSupervisor,
  SUPERVISED_SOURCES,
  type SupervisedSource,
} from "../adapters/supervisor.js";
import { hardDeleteEvents, type CascadeReport } from "./delete-cascade.js";

// ---- preview ---------------------------------------------------------------------

/** What the confirm card shows: the cascade numbers plus the spaces they touch. */
export interface CascadePreview extends CascadeReport {
  /** Distinct spaces whose episodes cite at least one doomed event. */
  spaces_touched: number;
  /** ts range of the doomed events (ISO), for the card's "from … to …" line. */
  first_ts: string | null;
  last_ts: string | null;
}

class PreviewRollback extends Error {
  constructor(public readonly report: CascadeReport) {
    super("preview rollback");
  }
}

function idsPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Spaces touched by the episodes that cite any of `ids` (before any delete). */
function spacesTouched(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _preview_ids (id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM _preview_ids`);
  const ins = db.prepare(`INSERT OR IGNORE INTO _preview_ids (id) VALUES (?)`);
  for (const id of ids) ins.run(id);
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT e.space_id) AS n
         FROM episodes e
        WHERE e.space_id IS NOT NULL
          AND e.id IN (
            SELECT episode_id FROM episode_events
             WHERE start_event_id IN (SELECT id FROM _preview_ids)
                OR end_event_id   IN (SELECT id FROM _preview_ids)
                OR event_id       IN (SELECT id FROM _preview_ids))`,
    )
    .get() as { n: number };
  db.exec(`DELETE FROM _preview_ids`);
  return r.n;
}

function tsRange(ids: string[]): { first_ts: string | null; last_ts: string | null } {
  if (ids.length === 0) return { first_ts: null, last_ts: null };
  const db = getDb();
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _preview_ids (id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM _preview_ids`);
  const ins = db.prepare(`INSERT OR IGNORE INTO _preview_ids (id) VALUES (?)`);
  for (const id of ids) ins.run(id);
  const r = db
    .prepare(`SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM events WHERE id IN (SELECT id FROM _preview_ids)`)
    .get() as { first_ts: string | null; last_ts: string | null };
  db.exec(`DELETE FROM _preview_ids`);
  return r;
}

/**
 * Dry-run the cascade over `eventIds`: the real hardDeleteEvents(), rolled
 * back. Nothing is written — not even the tombstone decision.
 */
export function previewCascade(eventIds: string[]): CascadePreview {
  const ids = [...new Set(eventIds)].filter((id) => typeof id === "string" && id.length > 0);
  const spaces = spacesTouched(ids);
  const range = tsRange(ids);
  const db = getDb();
  let report: CascadeReport | null = null;
  const dry = db.transaction(() => {
    const r = hardDeleteEvents(ids, { reason: "preview", by: "preview" });
    throw new PreviewRollback(r);
  });
  try {
    dry();
  } catch (err) {
    if (!(err instanceof PreviewRollback)) throw err;
    report = err.report;
  }
  return { ...(report as CascadeReport), decision_id: null, spaces_touched: spaces, ...range };
}

// ---- event selections ------------------------------------------------------------

/** Every event id of a source (events.source_id — the funnels write it). */
export function sourceEventIds(source: string): string[] {
  return (
    getDb()
      .prepare(`SELECT id FROM events WHERE source_id = ? OR source_type = ?`)
      .all(source, source) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Events said in the last `minutes` (ts ≥ now − N min), every source. Live
 * captures only: a backfill that IMPORTED old history in the last ten minutes
 * is not "what just happened" and stays.
 */
export function recentEventIds(minutes: number, nowMs: number = Date.now()): string[] {
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
  const cutoff = new Date(nowMs - mins * 60_000).toISOString();
  return (
    getDb()
      .prepare(`SELECT id FROM events WHERE ts >= ? AND (origin IS NULL OR origin <> 'backfill')`)
      .all(cutoff) as { id: string }[]
  ).map((r) => r.id);
}

// ---- forget last N minutes --------------------------------------------------------

export function previewForget(minutes: number, nowMs: number = Date.now()): CascadePreview & { minutes: number } {
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
  return { ...previewCascade(recentEventIds(mins, nowMs)), minutes: mins };
}

export function forgetLastMinutes(
  minutes: number,
  opts: { by?: string; nowMs?: number } = {},
): CascadeReport & { minutes: number } {
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
  const ids = recentEventIds(mins, opts.nowMs ?? Date.now());
  const report = hardDeleteEvents(ids, {
    reason: `user forgot the last ${mins} minutes`,
    by: opts.by ?? "user",
    targetKind: "capture",
    targetId: "forget",
  });
  return { ...report, minutes: mins };
}

// ---- per-source verbs --------------------------------------------------------------

export type SourceVerb = "pause" | "resume" | "disconnect" | "delete";

export interface VerbOutcome {
  source: string;
  verb: SourceVerb;
  /** The consent row after the flip (null when there was none to flip). */
  consent: ConsentRow | null;
  /** captureAllowed(source) after the verb — the funnel's own answer. */
  captureAllowed: boolean;
  /** The adapter was running and stop() was called. */
  stopped: boolean;
  /** stop() threw; capture is still blocked (the row flipped first). */
  teardownError: string | null;
  decision_id: string | null;
}

function isSupervised(source: string): source is SupervisedSource {
  return (SUPERVISED_SOURCES as readonly string[]).includes(source);
}

/** Stop the adapter. Never throws — the caller already flipped the row. */
async function teardown(source: string): Promise<{ stopped: boolean; error: string | null }> {
  const sup = getSourceSupervisor();
  if (!sup || !isSupervised(source)) return { stopped: false, error: null };
  try {
    const stopped = await sup.stop(source);
    // The supervisor swallows a driver's throw (it logs); surface it here so
    // the verb's outcome can say "paused; the adapter refused to stop".
    return { stopped, error: stopped ? sup.lastStopError(source) : null };
  } catch (err) {
    return { stopped: true, error: (err as Error).message };
  }
}

async function flipThenStop(
  source: string,
  verb: SourceVerb,
  state: ConsentState,
  by: string,
): Promise<VerbOutcome> {
  const before = getConsent(source);
  // 1. The row. From here on the funnel drops the source's events, whatever
  //    the adapter does next.
  const consent = setConsentState(source, state);
  // 2. The adapter — a throw here changes nothing about (1).
  const t = await teardown(source);
  if (verb === "disconnect" && source === "screen") disarmScreenRecording();
  const decision_id = writeDecision({
    pass: by,
    targetKind: "consent",
    targetId: source,
    action: `source_${verb}`,
    old: { state: before?.state ?? null },
    new: { state: consent?.state ?? null, teardown_error: t.error },
    reason: `user ${verb === "pause" ? "paused" : "disconnected"} ${source}; consent flipped before teardown`,
  });
  return {
    source,
    verb,
    consent,
    captureAllowed: captureAllowed(source),
    stopped: t.stopped,
    teardownError: t.error,
    decision_id,
  };
}

/** Pause: consent → 'paused', then stop the adapter. Data stays. */
export function pauseSource(source: string, by = "user"): Promise<VerbOutcome> {
  return flipThenStop(source, "pause", "paused", by);
}

/** Disconnect: consent → 'disconnected', adapter stopped, data stays. */
export function disconnectSource(source: string, by = "user"): Promise<VerbOutcome> {
  return flipThenStop(source, "disconnect", "disconnected", by);
}

/** Resume a paused / disconnected source: row → 'connected', THEN start. */
export async function resumeSource(source: string, by = "user"): Promise<VerbOutcome> {
  const before = getConsent(source);
  const consent = setConsentState(source, "connected");
  let error: string | null = null;
  const sup = getSourceSupervisor();
  if (consent && sup && isSupervised(source)) {
    try {
      const outcome = await sup.start(source);
      if (!outcome.started && outcome.reason !== "already-running" && outcome.reason !== "not-armed") {
        error = `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`;
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }
  const decision_id = consent
    ? writeDecision({
        pass: by,
        targetKind: "consent",
        targetId: source,
        action: "source_resume",
        old: { state: before?.state ?? null },
        new: { state: consent.state, start_error: error },
      })
    : null;
  return {
    source,
    verb: "resume",
    consent,
    captureAllowed: captureAllowed(source),
    stopped: false,
    teardownError: error,
    decision_id,
  };
}

// ---- delete ----------------------------------------------------------------------

export interface SourceDeleteResult {
  events: number;
  streams: number;
  actors: number;
  cascade: CascadeReport;
}

/**
 * Wipe one source's data — every event through the cascade, then the shells.
 * Replaces db/ingest.resetSourceData (T4-12). Clears the import flags so a
 * reconnect restarts from the range picker. Does NOT touch the consent row:
 * `deleteSource` (the verb) revokes it first; `relink` keeps it.
 */
export function deleteSourceData(source: string, opts: { reason?: string; by?: string } = {}): SourceDeleteResult {
  const db = getDb();
  const tx = db.transaction((): SourceDeleteResult => {
    const ids = sourceEventIds(source);
    const streams = (db.prepare(`SELECT COUNT(*) AS n FROM streams WHERE source_id = ?`).get(source) as { n: number }).n;
    const actors = (db.prepare(`SELECT COUNT(*) AS n FROM actors WHERE source_id = ?`).get(source) as { n: number }).n;
    const cascade = hardDeleteEvents(ids, {
      reason: opts.reason ?? `user deleted the ${source} source`,
      by: opts.by ?? "user",
      targetKind: "source",
      targetId: source,
    });
    // Shells and mirrors, once no event references them. FTS follows the
    // event delete through its triggers; watermarks cascade with streams.
    db.prepare(`DELETE FROM streams WHERE source_id = ?`).run(source);
    db.prepare(`DELETE FROM channels WHERE source_id = ?`).run(source);
    db.prepare(`DELETE FROM actors WHERE source_id = ?`).run(source);
    db.prepare(
      `DELETE FROM legacy_people
        WHERE NOT EXISTS (SELECT 1 FROM actors a WHERE a.person_id = legacy_people.id)`,
    ).run();
    try {
      db.prepare(`DELETE FROM coverage WHERE source = ?`).run(source);
    } catch {
      // coverage table absent on an older DB — nothing to clear.
    }
    appStateDelete(importDoneKey(source));
    appStateDelete(importRangeKey(source));
    return { events: cascade.events_deleted, streams, actors, cascade };
  });
  return tx();
}

export interface SourceDeletePreview extends CascadePreview {
  streams: number;
  actors: number;
}

/** The numbers the delete card shows — N events / M episodes / K spaces … */
export function previewSourceDelete(source: string): SourceDeletePreview {
  const db = getDb();
  const preview = previewCascade(sourceEventIds(source));
  const streams = (db.prepare(`SELECT COUNT(*) AS n FROM streams WHERE source_id = ?`).get(source) as { n: number }).n;
  const actors = (db.prepare(`SELECT COUNT(*) AS n FROM actors WHERE source_id = ?`).get(source) as { n: number }).n;
  return { ...preview, streams, actors };
}

export interface DeleteSourceOutcome extends VerbOutcome {
  deleted: SourceDeleteResult;
}

/**
 * The delete verb: revoke consent → stop the adapter → cascade the data.
 * Order matters: the row is dead before the first DELETE, so nothing can be
 * captured into the gap. Screen also forgets "Record from now on".
 */
export async function deleteSource(source: string, by = "user"): Promise<DeleteSourceOutcome> {
  const before = getConsent(source);
  revokeConsent(source);
  const t = await teardown(source);
  if (source === "screen") disarmScreenRecording();
  const deleted = deleteSourceData(source, { by, reason: `user deleted the ${source} source (preview confirmed)` });
  const decision_id = writeDecision({
    pass: by,
    targetKind: "consent",
    targetId: source,
    action: "source_delete",
    old: { state: before?.state ?? null },
    new: {
      state: "revoked",
      events_deleted: deleted.events,
      episodes_deleted: deleted.cascade.episodes_deleted,
      teardown_error: t.error,
    },
    reason: `user deleted ${source}; consent revoked before teardown, data cascaded`,
  });
  return {
    source,
    verb: "delete",
    consent: getConsent(source),
    captureAllowed: captureAllowed(source),
    stopped: t.stopped,
    teardownError: t.error,
    decision_id,
    deleted,
  };
}

// ---- outside-window review (CNS-08) -------------------------------------------------

export interface OutsideWindowEpisode {
  id: string;
  space_id: string | null;
  summary: string | null;
  first_ts: string | null;
  last_ts: string | null;
  events: number;
  label: "outside-understand-window";
}

export interface OutsideWindowReview {
  source: string;
  understand_from: string | null;
  episodes: OutsideWindowEpisode[];
  /** Member events of those episodes (what review-and-delete removes). */
  event_ids: string[];
}

/**
 * Episodes built from the source's events that now lie entirely before its
 * UNDERSTAND floor — what shortening left behind, labelled. Empty when the
 * floor is unset (nothing is understood) or nothing predates it.
 */
export function outsideWindowEpisodes(source: string): OutsideWindowReview {
  const consent = getConsent(source);
  const floor = consent?.understandFrom ?? null;
  if (!floor) return { source, understand_from: null, episodes: [], event_ids: [] };
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.id, e.space_id, e.summary, e.first_ts, e.last_ts,
              (SELECT COUNT(*) FROM episode_events m WHERE m.episode_id = e.id) AS ranges
         FROM episodes e
        WHERE EXISTS (
                SELECT 1 FROM episode_events m
                  JOIN events ev ON ev.id = COALESCE(m.event_id, m.start_event_id)
                 WHERE m.episode_id = e.id
                   AND (ev.source_id = ? OR ev.source_type = ?))
          AND NOT EXISTS (
                SELECT 1 FROM episode_events m
                  JOIN events ev ON ev.id = COALESCE(m.event_id, m.end_event_id)
                 WHERE m.episode_id = e.id AND ev.ts >= ?)
        ORDER BY e.first_ts, e.id`,
    )
    .all(source, source, floor) as {
    id: string;
    space_id: string | null;
    summary: string | null;
    first_ts: string | null;
    last_ts: string | null;
    ranges: number;
  }[];
  if (rows.length === 0) return { source, understand_from: floor, episodes: [], event_ids: [] };
  const marks = idsPlaceholders(rows.length);
  const ids = rows.map((r) => r.id);
  const members = db
    .prepare(
      `SELECT DISTINCT ev.id
         FROM episode_events m
         JOIN events ev ON ev.id IN (m.event_id, m.start_event_id, m.end_event_id)
        WHERE m.episode_id IN (${marks})
          AND (ev.source_id = ? OR ev.source_type = ?)`,
    )
    .all(...ids, source, source) as { id: string }[];
  return {
    source,
    understand_from: floor,
    episodes: rows.map((r) => ({
      id: r.id,
      space_id: r.space_id,
      summary: r.summary,
      first_ts: r.first_ts,
      last_ts: r.last_ts,
      events: r.ranges,
      label: "outside-understand-window",
    })),
    event_ids: members.map((m) => m.id),
  };
}

export function previewOutsideWindowDelete(source: string): CascadePreview & { episodes: number } {
  const review = outsideWindowEpisodes(source);
  return { ...previewCascade(review.event_ids), episodes: review.episodes.length };
}

/** Review-and-delete: exactly the labelled episodes, via their member events. */
export function deleteOutsideWindow(source: string, by = "user"): CascadeReport & { episodes: number } {
  const review = outsideWindowEpisodes(source);
  const report = hardDeleteEvents(review.event_ids, {
    reason: `user deleted what ${source} understood before ${review.understand_from ?? "?"} (window shortened)`,
    by,
    targetKind: "source",
    targetId: source,
  });
  return { ...report, episodes: review.episodes.length };
}

// ---- capture state (the tray) ------------------------------------------------------

export interface SourceCaptureState {
  source: string;
  consent: ConsentState | null;
  /** The adapter is running under the supervisor. */
  running: boolean;
  /** captureAllowed(source): the funnel would admit this source right now. */
  capturing: boolean;
}

/** Real capture state per supervised source — what the tray renders. */
export function sourceCaptureStates(): SourceCaptureState[] {
  const sup = getSourceSupervisor();
  return SUPERVISED_SOURCES.map((source) => ({
    source,
    consent: getConsent(source)?.state ?? null,
    running: sup ? sup.isRunning(source) : false,
    capturing: captureAllowed(source),
  }));
}

/** One-click stop: pause every source the funnel would currently admit. */
export async function stopAllCapture(by = "tray"): Promise<VerbOutcome[]> {
  const out: VerbOutcome[] = [];
  for (const source of SUPERVISED_SOURCES) {
    if (captureAllowed(source)) out.push(await pauseSource(source, by));
  }
  return out;
}
