// ===========================================================================
// [CODE] Episodes surface routes — arch §14.3, build item 2.7.
//
//   GET  /api/episodes                 the page: episodes, head counts, streams
//   POST /api/episodes/:id/detach      pull ONE session out into its own episode
//   POST /api/episodes/:id/split       cut the named sessions out into one episode
//   POST /api/episodes/:id/merge       fold this episode back into another
//   POST /api/episodes/:id/relabel     the human names it; label_source := user
//   POST /api/episodes/:id/close       close it with a stated outcome
//
// Two rules shape everything below.
//
//  1. THE VERDICT IS READ, NEVER REBUILT. Every membership row's signal,
//     confidence and reason come out of the PERSISTED `episode_verdicts` row
//     (`readVerdictForSession`), because a surface that re-derived "why" would
//     be showing today's reasoning for yesterday's decision (§14.3). A code
//     rule spent no model call, so its row has no verdict and says so — null
//     renders as "no model was asked", never as a blank.
//  2. EVERY GESTURE RETURNS ITS RECEIPT. All five writes land a
//     `mutations(actor:user)` row through {@link logMutation} and answer with
//     the `MutationReceipt` the surface prints, so a gesture that wrote nothing
//     and a gesture that wrote a row are distinguishable from the UI.
//
// An empty corpus is a normal answer, not an error: with no episodes derived
// yet every read here returns `{ episodes: [], counts: {…0}, streams: [] }`.
// ===========================================================================

import { createHash } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { readProvisionalArcs } from "../arcs/provisional.js";
import { getDb } from "../db/connection.js";
import { EPISODE_CLOSED, EPISODE_FADED, EPISODE_OPEN, quietMs } from "../episodes/aging.js";
import { readEpisode, readEpisodesOfStream, readVerdictForSession, writeEpisode } from "../episodes/store.js";
import { logMutation } from "../entities/merge.js";

/** The one actor a surface gesture may ever write under (§14.0, §6). */
const USER_ACTOR = "user";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `episodes.outcome` for one that was folded back into another. It is a
 * TOMBSTONE, not a conclusion: the row stays so the merge can be read back off
 * the ledger, but the surface never lists it and the head chips never count it
 * — the same shape as an entity merge, where reads follow the redirect (§10.3).
 */
const MERGED_OUTCOME = "merged";

/** The three head buckets: `[open][closed·concluded][closed·faded]`. */
const STATE_FILTERS = ["open", "concluded", "faded"] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

function isStateFilter(v: string | null): v is StateFilter {
  return v !== null && (STATE_FILTERS as readonly string[]).includes(v);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Views — the shapes in `src/lib/episodes-client.ts`, which the tab compiles
// against. Nothing here is a table row.
// ---------------------------------------------------------------------------

export type EpisodeProvenance = "seed" | "attached" | "split";

export interface VerdictCandidateView {
  episodeId: string;
  label: string | null;
  lastActiveAt: string | null;
}

export interface EpisodeVerdictView {
  id: string;
  decision: string;
  reason: string;
  confidence: number | null;
  candidates: VerdictCandidateView[];
  model: string | null;
  createdAt: string | null;
}

export interface EpisodeSessionView {
  sessionId: string;
  streamLabel: string;
  startedAt: string | null;
  provenance: EpisodeProvenance;
  decidedBy: string | null;
  confidence: number | null;
  reason: string;
  splitFromSessionId: string | null;
  splitTopicCount: number | null;
  verdict: EpisodeVerdictView | null;
  sessionOpen: boolean;
}

export interface EpisodeView {
  id: string;
  label: string | null;
  labelSource: string | null;
  state: "open" | "closed";
  outcome: string | null;
  sourceLabel: string;
  streamId: string | null;
  streamLabel: string;
  startedAt: string | null;
  lastActiveAt: string | null;
  quietDays: number | null;
  sessions: EpisodeSessionView[];
  entities: { id: string; label: string }[];
  arc: { id: string; label: string | null } | null;
  provisional: boolean;
  splitFromEpisodeId: string | null;
}

export interface EpisodesPage {
  episodes: EpisodeView[];
  counts: Record<StateFilter, number>;
  streams: { id: string; label: string }[];
}

/** What `POST`ing a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A label the surface can actually print. Falling back to the id is deliberate:
 * an unlabelled stream is a real thing, and "unnamed" would hide which one it is.
 */
function orId(label: string | null | undefined, id: string): string {
  return typeof label === "string" && label.trim() !== "" ? label : id;
}

/** `null`/`open` both mean open — a row minted before aging existed is not closed. */
function stateOf(arcState: string | null): "open" | "closed" {
  return arcState === EPISODE_CLOSED ? "closed" : "open";
}

function bucketOf(arcState: string | null, outcome: string | null): StateFilter {
  if (stateOf(arcState) === "open") return "open";
  return outcome === EPISODE_FADED ? "faded" : "concluded";
}

interface MembershipRow {
  session_id: string;
  added_by: string | null;
  started_at: string | null;
  status: string | null;
  stream_id: string | null;
  stream_label: string | null;
}

/**
 * One episode's membership, with the session facts the row needs beside it.
 *
 * No store function reads `episode_sessions` in this direction (`store.ts` has
 * the inverse, `readEpisodesOfSession`), and the surface needs the session's
 * clock and stream on the same row, so the join lives here.
 */
function membershipOf(episodeId: string): MembershipRow[] {
  return getDb()
    .prepare(
      `SELECT es.session_id  AS session_id,
              es.added_by    AS added_by,
              s.started_at   AS started_at,
              s.status       AS status,
              s.stream_id    AS stream_id,
              st.label       AS stream_label
         FROM episode_sessions es
         LEFT JOIN sessions s  ON s.id  = es.session_id
         LEFT JOIN streams  st ON st.id = s.stream_id
        WHERE es.episode_id = ?
        ORDER BY s.started_at, es.session_id`,
    )
    .all(episodeId) as MembershipRow[];
}

/** The `output_json` an episode verdict carries — see `episodes/engine.ts`. */
interface VerdictOutput {
  segments?: { episodeId?: unknown; confidence?: unknown }[];
  reason?: unknown;
}

function verdictOutput(raw: unknown): VerdictOutput {
  return typeof raw === "object" && raw !== null ? (raw as VerdictOutput) : {};
}

/**
 * THE SIGNAL — which rule or model made this call. Read off the verdict's own
 * `decision`, never guessed: `code:1v1` is the 1:1 default that spent no model
 * call (§11.1), `agent:p-ep2` is the judge, `code:hash-reuse` is the hash gate
 * re-using an answer. A row with no verdict at all reports null, which the
 * surface prints as `unattributed` — a bug report, not a blank.
 */
function signalFor(decision: string | null, addedBy: string | null): string | null {
  if (addedBy !== null && addedBy.startsWith(USER_ACTOR)) return USER_ACTOR;
  switch (decision) {
    case "judged":
      return "agent:p-ep2";
    case "one_to_one":
    case "one_to_one_fallback":
      return "code:1v1";
    case "hash_reuse":
      return "code:hash-reuse";
    default:
      return decision === null ? null : decision;
  }
}

function sessionRow(episodeId: string, row: MembershipRow): EpisodeSessionView {
  const stored = readVerdictForSession(row.session_id);
  const output = verdictOutput(stored?.output);
  const segments = Array.isArray(output.segments) ? output.segments : [];
  const mine = segments.find((s) => s.episodeId === episodeId);
  const confidence = typeof mine?.confidence === "number" ? mine.confidence : null;
  const reason = typeof output.reason === "string" ? output.reason : "";

  // A session cut into more than one topic is a SPLIT on every one of them, and
  // the row names the session it was cut out of (§14.3's `SPLIT from session`).
  // A user gesture says so on `added_by`; it has no topic count to report.
  const userSplit = row.added_by !== null && row.added_by.startsWith(`${USER_ACTOR}:`);
  const provenance: EpisodeProvenance =
    segments.length > 1 || userSplit ? "split" : row.added_by === "attach" ? "attached" : "seed";

  const candidates = Array.isArray(stored?.candidates) ? (stored.candidates as Record<string, unknown>[]) : [];

  return {
    sessionId: row.session_id,
    streamLabel: orId(row.stream_label, row.stream_id ?? ""),
    startedAt: row.started_at,
    provenance,
    decidedBy: signalFor(stored?.decision ?? null, row.added_by),
    confidence,
    reason,
    splitFromSessionId: provenance === "split" ? row.session_id : null,
    splitTopicCount: provenance === "split" && segments.length > 1 ? segments.length : null,
    verdict:
      stored === null
        ? null
        : {
            id: stored.id,
            decision: stored.decision ?? "",
            reason,
            confidence,
            // Exactly the candidate set the model saw, in the order it saw it.
            candidates: candidates.map((c) => ({
              episodeId: String(c.id ?? ""),
              label: typeof c.label === "string" ? c.label : null,
              lastActiveAt: typeof c.lastActiveAt === "string" ? c.lastActiveAt : null,
            })),
            model: stored.model,
            createdAt: stored.createdAt,
          },
    // §14.0b: an episode built on a session that is still running is LIVE output.
    sessionOpen: row.status !== "sealed",
  };
}

/** id → label for every entity named on the page, in one read. */
function entityLabels(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT id, canonical FROM entities WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; canonical: string | null }[];
  for (const r of rows) out.set(r.id, orId(r.canonical, r.id));
  return out;
}

/** episode id → the arc it has been bound to, in one read. */
function arcBindings(): Map<string, { id: string; label: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT ae.episode_id AS episode_id, a.id AS arc_id, COALESCE(a.user_label, a.label) AS label
         FROM arc_episodes ae JOIN arcs a ON a.id = ae.arc_id`,
    )
    .all() as { episode_id: string; arc_id: string; label: string | null }[];
  const out = new Map<string, { id: string; label: string | null }>();
  for (const r of rows) out.set(r.episode_id, { id: r.arc_id, label: r.label });
  return out;
}

/** source id → its name, for the `WhatsApp/Rohan` half of the head line. */
function sourceNames(): Map<string, string> {
  const rows = getDb().prepare(`SELECT id, name FROM sources`).all() as { id: string; name: string | null }[];
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.id, orId(r.name, r.id));
  return out;
}

/**
 * Which episodes were split OUT of another, and out of which.
 *
 * `episodes` has no column for it — the split is a HUMAN gesture, so the
 * `mutations` ledger is where it is recorded (and where undo would find it).
 * The newest row wins, exactly like a re-judge does for verdicts.
 */
function splitParents(): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT target_id, new_json FROM mutations
        WHERE target_kind = 'episode' AND field = 'split_from'
        ORDER BY ts, rowid`,
    )
    .all() as { target_id: string; new_json: string | null }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.new_json === null) continue;
    try {
      const parsed: unknown = JSON.parse(r.new_json);
      if (typeof parsed === "string" && parsed !== "") out.set(r.target_id, parsed);
    } catch {
      // A ledger row we cannot parse is not a reason to fail the page.
    }
  }
  return out;
}

/** The streams the head's `[▾]` may filter by: the ones that have episodes. */
function streamsWithEpisodes(): { id: string; label: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT st.id AS id, st.label AS label
         FROM episodes e JOIN streams st ON st.id = e.stream_id
        WHERE e.outcome IS NOT '${MERGED_OUTCOME}'
        ORDER BY st.label, st.id`,
    )
    .all() as { id: string; label: string | null }[];
  return rows.map((r) => ({ id: r.id, label: orId(r.label, r.id) }));
}

/**
 * Whole-corpus totals for the head chips — NOT this page's. A count that moved
 * when the filter moved would be reporting the filter, not the corpus.
 */
function headCounts(): Record<StateFilter, number> {
  const rows = getDb()
    .prepare(
      `SELECT arc_state AS arc_state, outcome AS outcome, COUNT(*) AS n
         FROM episodes WHERE outcome IS NOT '${MERGED_OUTCOME}' GROUP BY 1, 2`,
    )
    .all() as { arc_state: string | null; outcome: string | null; n: number }[];
  const counts: Record<StateFilter, number> = { open: 0, concluded: 0, faded: 0 };
  for (const r of rows) counts[bucketOf(r.arc_state, r.outcome)] += r.n;
  return counts;
}

/**
 * Every episode, newest activity first.
 *
 * With a stream filter this is `readEpisodesOfStream`. Without one there is no
 * store function for "all of them", so the id sweep is here and the row read is
 * still `readEpisode` — one parser for the JSON columns, not two.
 */
function episodeRows(streamId: string | null) {
  if (streamId !== null) return readEpisodesOfStream(streamId);
  const ids = getDb()
    .prepare(`SELECT id FROM episodes ORDER BY COALESCE(ended_at, started_at) DESC, id ASC`)
    .all() as { id: string }[];
  return ids.map((r) => readEpisode(r.id)).filter((r): r is NonNullable<ReturnType<typeof readEpisode>> => r !== null);
}

function buildPage(state: StateFilter | null, streamId: string | null, now: number): EpisodesPage {
  const rows = episodeRows(streamId)
    .filter((e) => e.outcome !== MERGED_OUTCOME)
    .filter((e) => state === null || bucketOf(e.arcState, e.outcome) === state);

  const arcs = arcBindings();
  const sources = sourceNames();
  const parents = splitParents();
  // Not yet reconciled — the episode is still sitting in a provisional arc
  // batch, which is §14.0b's "minted this pass" in the form the DB records it.
  const pending = new Set(readProvisionalArcs().flatMap((p) => p.episodeIds));
  const labels = entityLabels([...new Set(rows.flatMap((e) => e.entityIds))]);

  const streamLabels = new Map<string, string | null>(
    (getDb().prepare(`SELECT id, label FROM streams`).all() as { id: string; label: string | null }[]).map((r) => [
      r.id,
      r.label,
    ]),
  );

  const episodes: EpisodeView[] = rows.map((e) => {
    const lastActiveAt = e.endedAt ?? e.startedAt;
    const quiet = quietMs(lastActiveAt, now);
    return {
      id: e.id,
      label: e.topicLabel,
      labelSource: e.labelSource,
      state: stateOf(e.arcState),
      outcome: e.outcome,
      sourceLabel: e.sourceId === null ? "" : (sources.get(e.sourceId) ?? e.sourceId),
      streamId: e.streamId,
      streamLabel: e.streamId === null ? "" : orId(streamLabels.get(e.streamId) ?? null, e.streamId),
      startedAt: e.startedAt,
      lastActiveAt,
      // The 14-day fade clock as MEASURED (§11.1). Null is "unknown", which is
      // not zero: an episode with no readable activity has no age.
      quietDays: quiet === null ? null : Math.floor(quiet / DAY_MS),
      sessions: membershipOf(e.id).map((row) => sessionRow(e.id, row)),
      entities: e.entityIds.map((id) => ({ id, label: labels.get(id) ?? id })),
      arc: arcs.get(e.id) ?? null,
      provisional: pending.has(e.id),
      splitFromEpisodeId: parents.get(e.id) ?? null,
    };
  });

  return { episodes, counts: headCounts(), streams: streamsWithEpisodes() };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface SessionFacts {
  id: string;
  streamId: string | null;
  sourceId: string | null;
  eventIds: string[];
  startedAt: string | null;
  endedAt: string | null;
}

function sessionFacts(id: string): SessionFacts | null {
  const row = getDb()
    .prepare(`SELECT id, stream_id, source_id, event_ids, started_at, ended_at FROM sessions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  let eventIds: string[] = [];
  try {
    const parsed: unknown = typeof row.event_ids === "string" ? JSON.parse(row.event_ids) : [];
    if (Array.isArray(parsed)) eventIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    eventIds = [];
  }
  return {
    id: row.id as string,
    streamId: (row.stream_id as string | null) ?? null,
    sourceId: (row.source_id as string | null) ?? null,
    eventIds,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

/**
 * The id a gesture mints.
 *
 * NOT `episodeIdFor`: that keys on (stream, anchor event, label), so pulling a
 * seed session out of an episode could land back on the id of the very episode
 * we are pulling it out of. Keying on the GESTURE instead makes a replayed
 * detach idempotent and cannot collide with a derived id.
 */
function gestureEpisodeId(gesture: string, fromEpisodeId: string, sessionIds: readonly string[]): string {
  const digest = createHash("sha1")
    .update(`${USER_ACTOR}:${gesture} ${fromEpisodeId} ${[...sessionIds].sort().join(",")}`)
    .digest("hex");
  return `ep_${digest.slice(0, 16)}`;
}

/**
 * Un-write one membership. `writeEpisode` only ever MERGES a session in (it is
 * the derivation's idempotent lander), so the removal side of a detach/split
 * has no store function and lives here. Spans are left alone deliberately:
 * without per-event times, narrowing them would put an invented instant on the
 * episode the session came out of.
 */
function removeSessions(episodeId: string, sessionIds: readonly string[], eventIds: readonly string[]): void {
  const db = getDb();
  const episode = readEpisode(episodeId);
  if (episode === null) return;
  const dropSessions = new Set(sessionIds);
  const dropEvents = new Set(eventIds);
  const del = db.prepare(`DELETE FROM episode_sessions WHERE episode_id = ? AND session_id = ?`);
  for (const sessionId of sessionIds) del.run(episodeId, sessionId);
  db.prepare(
    `UPDATE episodes SET session_ids = @sessionIds, event_ids = @eventIds, updated_at = @updatedAt WHERE id = @id`,
  ).run({
    id: episodeId,
    sessionIds: JSON.stringify(episode.sessionIds.filter((s) => !dropSessions.has(s))),
    eventIds: JSON.stringify(episode.eventIds.filter((e) => !dropEvents.has(e))),
    updatedAt: new Date().toISOString(),
  });
}

function receipt(mutationId: string, targetId: string, field: string | null): MutationReceipt {
  return { mutationId, actor: USER_ACTOR, targetKind: "episode", targetId, field };
}

/**
 * Move sessions out of `from` into a NEW episode, and record the parentage.
 * Detach and split are the same operation over one session or several — the
 * surface offers them as two gestures because they mean different things to a
 * human, not because they write differently.
 */
function cutOut(
  gesture: "detach" | "split",
  from: NonNullable<ReturnType<typeof readEpisode>>,
  sessions: readonly SessionFacts[],
): MutationReceipt {
  const newId = gestureEpisodeId(gesture, from.id, sessions.map((s) => s.id));
  const movedEvents = sessions.flatMap((s) => s.eventIds);

  for (const session of sessions) {
    writeEpisode({
      id: newId,
      // The stream is the session's own; an episode never spans streams (§11.1).
      streamId: session.streamId ?? from.streamId ?? "",
      sourceId: session.sourceId ?? from.sourceId ?? null,
      // The label is INHERITED, not authored: the human moved the session, they
      // did not name the result. `relabel` is the gesture that sets `user`.
      topicLabel: from.topicLabel,
      labelSource: from.labelSource,
      sessionId: session.id,
      eventIds: session.eventIds,
      entityIds: from.entityIds,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      addedBy: `${USER_ACTOR}:${gesture}`,
      verdictId: null,
    });
  }
  removeSessions(
    from.id,
    sessions.map((s) => s.id),
    movedEvents,
  );

  const mutationId = logMutation({
    actor: USER_ACTOR,
    targetKind: "episode",
    targetId: newId,
    field: "split_from",
    oldValue: null,
    newValue: from.id,
    reason: `${gesture}: ${sessions.map((s) => s.id).join(", ")} out of ${from.id}`,
  });
  return receipt(mutationId, newId, "split_from");
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle an episodes request. Returns true when this module owns the path. */
export async function handleEpisodesRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/episodes" && !path.startsWith("/api/episodes/")) return false;

  // ---- GET /api/episodes?state=&stream= -----------------------------------
  if (method === "GET" && path === "/api/episodes") {
    const rawState = url.searchParams.get("state");
    if (rawState !== null && !isStateFilter(rawState)) {
      sendJson(res, 400, { error: `state must be one of ${STATE_FILTERS.join(", ")}` });
      return true;
    }
    const stream = url.searchParams.get("stream");
    sendJson(res, 200, buildPage(isStateFilter(rawState) ? rawState : null, stream === "" ? null : stream, Date.now()));
    return true;
  }

  const gesture = path.match(/^\/api\/episodes\/([^/]+)\/(detach|split|merge|relabel|close)$/);
  if (method !== "POST" || gesture === null) {
    sendJson(res, 404, { error: "unknown episodes route" });
    return true;
  }

  const id = decodeURIComponent(gesture[1]!);
  const kind = gesture[2]!;
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return true;
  }
  const episode = readEpisode(id);
  if (episode === null) {
    sendJson(res, 404, { error: `no episode ${id}` });
    return true;
  }

  // ---- POST /api/episodes/:id/detach { sessionId } -------------------------
  if (kind === "detach") {
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      sendJson(res, 400, { error: "sessionId (string) required" });
      return true;
    }
    if (!episode.sessionIds.includes(sessionId)) {
      sendJson(res, 404, { error: `session ${sessionId} is not in episode ${id}` });
      return true;
    }
    const facts = sessionFacts(sessionId);
    if (facts === null) {
      sendJson(res, 404, { error: `no session ${sessionId}` });
      return true;
    }
    sendJson(res, 200, cutOut("detach", episode, [facts]));
    return true;
  }

  // ---- POST /api/episodes/:id/split { sessionIds } -------------------------
  if (kind === "split") {
    const raw = body.sessionIds;
    const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v !== "") : null;
    if (ids === null || ids.length === 0) {
      sendJson(res, 400, { error: "sessionIds (non-empty string array) required" });
      return true;
    }
    const missing = ids.filter((s) => !episode.sessionIds.includes(s));
    if (missing.length > 0) {
      sendJson(res, 404, { error: `not in episode ${id}: ${missing.join(", ")}` });
      return true;
    }
    // Splitting off EVERY session would empty the episode and rename nothing —
    // it is a no-op dressed as a write, so it is refused rather than recorded.
    if (ids.length >= episode.sessionIds.length) {
      sendJson(res, 400, { error: "a split must leave at least one session behind" });
      return true;
    }
    const facts = ids.map((s) => sessionFacts(s)).filter((f): f is SessionFacts => f !== null);
    if (facts.length !== ids.length) {
      sendJson(res, 404, { error: "one or more sessions do not exist" });
      return true;
    }
    sendJson(res, 200, cutOut("split", episode, facts));
    return true;
  }

  // ---- POST /api/episodes/:id/merge { into } -------------------------------
  // The undo of a split: every session moves to the target, and the emptied
  // episode is closed with `outcome = merged` rather than deleted. A delete
  // would destroy the information needed to tell what was folded where —
  // the same reason an entity merge is a tombstone and not a rewrite (§10.3).
  if (kind === "merge") {
    const into = body.into;
    if (typeof into !== "string" || into === "") {
      sendJson(res, 400, { error: "into (string) required" });
      return true;
    }
    if (into === id) {
      sendJson(res, 400, { error: "an episode cannot be merged into itself" });
      return true;
    }
    const target = readEpisode(into);
    if (target === null || target.outcome === MERGED_OUTCOME) {
      sendJson(res, 404, { error: `no episode ${into}` });
      return true;
    }
    for (const sessionId of episode.sessionIds) {
      const facts = sessionFacts(sessionId);
      if (facts === null) continue;
      writeEpisode({
        id: target.id,
        streamId: target.streamId ?? facts.streamId ?? "",
        sourceId: target.sourceId,
        // null keeps the target's own label — `writeEpisode` merges, and the
        // merge must not rename the episode the human is folding INTO.
        topicLabel: null,
        labelSource: null,
        sessionId,
        eventIds: facts.eventIds,
        entityIds: episode.entityIds,
        startedAt: facts.startedAt,
        endedAt: facts.endedAt,
        addedBy: `${USER_ACTOR}:merge`,
        verdictId: null,
      });
    }
    removeSessions(id, episode.sessionIds, episode.eventIds);
    getDb()
      .prepare(`UPDATE episodes SET arc_state = ?, outcome = ?, updated_at = ? WHERE id = ?`)
      .run(EPISODE_CLOSED, MERGED_OUTCOME, new Date().toISOString(), id);
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "episode",
      targetId: id,
      field: "merged_into",
      oldValue: { arcState: episode.arcState, outcome: episode.outcome, sessionIds: episode.sessionIds },
      newValue: into,
      reason: `merged back into ${into}`,
    });
    sendJson(res, 200, receipt(mutationId, id, "merged_into"));
    return true;
  }

  // ---- POST /api/episodes/:id/relabel { label } ----------------------------
  // `label_source = 'user'` is the whole point: `writeEpisode` refuses to
  // overwrite a user label, so a later derivation pass cannot undo this.
  if (kind === "relabel") {
    const label = body.label;
    if (typeof label !== "string" || label.trim() === "") {
      sendJson(res, 400, { error: "label (non-empty string) required" });
      return true;
    }
    const next = label.trim();
    getDb()
      .prepare(`UPDATE episodes SET topic_label = ?, label_source = 'user', updated_at = ? WHERE id = ?`)
      .run(next, new Date().toISOString(), id);
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "episode",
      targetId: id,
      field: "label",
      oldValue: episode.topicLabel,
      newValue: next,
      reason: null,
    });
    sendJson(res, 200, receipt(mutationId, id, "label"));
    return true;
  }

  // ---- POST /api/episodes/:id/close { outcome } ----------------------------
  // `faded` is the CLOCK's word (§11.1 rule 5). A human closing an episode has
  // concluded it, so the outcome they state is stored as given — but it may not
  // impersonate the fade, or the aging meter would be reporting a human.
  const outcome = body.outcome;
  if (typeof outcome !== "string" || outcome.trim() === "") {
    sendJson(res, 400, { error: "outcome (non-empty string) required" });
    return true;
  }
  const stated = outcome.trim();
  if (stated === EPISODE_FADED) {
    sendJson(res, 400, { error: `'${EPISODE_FADED}' is the aging clock's outcome, not a human one` });
    return true;
  }
  if (episode.arcState === EPISODE_CLOSED) {
    sendJson(res, 409, { error: `episode ${id} is already closed` });
    return true;
  }
  getDb()
    .prepare(`UPDATE episodes SET arc_state = ?, outcome = ?, updated_at = ? WHERE id = ?`)
    .run(EPISODE_CLOSED, stated, new Date().toISOString(), id);
  const mutationId = logMutation({
    actor: USER_ACTOR,
    targetKind: "episode",
    targetId: id,
    field: "outcome",
    oldValue: { arcState: episode.arcState ?? EPISODE_OPEN, outcome: episode.outcome },
    newValue: { arcState: EPISODE_CLOSED, outcome: stated },
    reason: null,
  });
  sendJson(res, 200, receipt(mutationId, id, "outcome"));
  return true;
}
