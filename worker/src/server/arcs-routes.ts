// ===========================================================================
// [CODE] Threads surface routes — arch §14.4 (arcs), build item 2.7.
//
// A thread IS an arc, promoted or not: promotion is a FIELD on `arcs` (brief
// rule 6), so this surface never filters on it and there is no second table to
// join. `/api/spaces` is the same rows behind `WHERE promoted = 1` and is
// served elsewhere (item 3.10) — nothing here knows about it.
//
//   GET  /api/arcs?state=&q=&pinned=1     every arc + the per-state census
//   GET  /api/arcs/questions              the `un` queue (§11.2 rule 5)
//   POST /api/arcs/:id/remove-episode     { episodeId }
//   POST /api/arcs/:id/split              { episodeIds }
//   POST /api/arcs/:id/merge              { into }
//   POST /api/arcs/:id/pin                { pinned }
//   POST /api/arcs/:id/relabel            { label }
//   POST /api/arcs/questions/:id          { answer: same|separate|later }
//
// THE READ CARRIES ITS OWN EVIDENCE. §14.4's acceptance criterion is "every
// membership row shows its signal and value", so `bindings` is assembled from
// the `arc_episodes` row that admitted the episode AND from the `arc_verdicts`
// row the ladder persisted for it — the rung, the measured number, and rung
// ④'s stated reason verbatim. A membership with nothing on record is served
// with `value: null`, which the surface renders "not measured"; it is never
// dressed up as a zero.
//
// EVERY GESTURE IS A HARD WALL, NOT A HINT. A user who removes, splits, merges
// or pins has told the system something it could not derive (§11.2 step ④), so
// each write lands as a `mutations` row in exactly the shape
// `arcs/constraints.ts#readUserConstraints` reads back:
//
//     field `split` on the arc they were taken OUT of  → never re-merged
//     field `move`  on the arc they were welded INTO   → left where they are
//
// and every one of them carries `actor = 'user'`, which is also what makes it
// invisible to `undoRun` (a run must never undo a person's correction).
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import type { LadderRung } from "../arcs/ladder.js";
import { pinArc, setUserLabel, unpinArc } from "../arcs/promote-store.js";
import {
  ARC_ARCHIVED,
  ARC_DORMANT,
  ARC_LIVE,
  attachEpisode,
  detachEpisode,
  writeProvisionalArc,
} from "../arcs/provisional.js";
import { splitKey } from "../arcs/reconcile.js";
import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { readCoverage } from "../scheduler/queue.js";
import { HORIZONS } from "../tiers/priority.js";
import { answerQuestion } from "./ops-routes.js";

/** The one actor a surface gesture may ever write under (§14.0). */
export const USER_ACTOR = "user";

/** §14.4's `[live 18][dormant 24][archived 61]`. */
export const ARC_STATES = [ARC_LIVE, ARC_DORMANT, ARC_ARCHIVED] as const;
export type ArcState = (typeof ARC_STATES)[number];

/** The `un` queue's three answers (`src/lib/threads-client.ts`). */
export const ARC_ANSWERS = ["same", "separate", "later"] as const;
export type ArcAnswer = (typeof ARC_ANSWERS)[number];

/** One page of threads is a page, not a corpus dump. */
export const MAX_ARCS = 200;
export const MAX_ARC_QUESTIONS = 200;

// ---------------------------------------------------------------------------
// The view shapes. These mirror `src/lib/threads-client.ts` exactly — the
// surface compiles against that file, so a field renamed here is a 404 there.
// ---------------------------------------------------------------------------

/** What `POST`ing a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

/** The §11.2 ladder rung. 1 is a shared literal; 4 is a model's opinion. */
export type ArcRung = 1 | 2 | 3 | 4;
export type SignalMeasure = "exact" | "jaccard" | "score" | "confidence";

export interface BindingSignalView {
  id: string;
  rung: ArcRung;
  signal: string;
  value: string | number | null;
  measure: SignalMeasure | null;
  between: string;
  episodeId: string | null;
  reason: string | null;
}

export interface ArcContribution {
  episodeId: string;
  sourceLabel: string;
  at: string;
}

export interface ArcEpisodeView {
  episodeId: string;
  label: string | null;
  sourceLabel: string;
  at: string | null;
}

export interface ArcView {
  id: string;
  label: string | null;
  state: ArcState;
  pinned: boolean;
  promotedSpaceId: string | null;
  promotedLabel: string | null;
  bindings: BindingSignalView[];
  episodes: ArcEpisodeView[];
  contributions: ArcContribution[];
  anchors: { id: string; label: string }[];
  sourceCount: number;
  stillGrowing: boolean;
  growingNote: string | null;
  provisional: boolean;
  lastActiveAt: string | null;
}

export interface ArcsPage {
  arcs: ArcView[];
  counts: Record<ArcState, number>;
}

export interface ArcQuestionView {
  id: string;
  episodeId: string;
  episodeLabel: string | null;
  arcId: string;
  arcLabel: string | null;
  reasoning: string;
  confidence: number | null;
  askedAt: string | null;
}

// ---------------------------------------------------------------------------
// http helpers — file-local, exactly as in `./ops-routes.ts`
// ---------------------------------------------------------------------------

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
// small readers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function jsonArray(raw: unknown): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function isArcState(value: unknown): value is ArcState {
  return typeof value === "string" && (ARC_STATES as readonly string[]).includes(value);
}

function marks(n: number): string {
  return new Array(n).fill("?").join(", ");
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

interface ArcRowRaw {
  id: string;
  label: string | null;
  user_label: string | null;
  state: string;
  user_pinned: number;
  promoted: number;
  arc_key: string;
  anchor_entity_ids: string | null;
  source_ids: string | null;
  last_evidence_at: string | null;
}

interface MembershipRow {
  arc_id: string;
  episode_id: string;
  added_by: string | null;
  signal: string | null;
  signal_detail_json: string | null;
  topic_label: string | null;
  source_id: string | null;
  started_at: string | null;
}

/**
 * The population, before the state chips narrow it. `q` matches the label the
 * surface actually renders — the user's word first, the derived one second —
 * because searching text nobody can see is how a search box loses trust.
 */
function readArcRows(q: string, pinnedOnly: boolean): ArcRowRaw[] {
  return getDb()
    .prepare(
      `SELECT id, label, user_label, state, user_pinned, promoted, arc_key,
              anchor_entity_ids, source_ids, last_evidence_at
         FROM arcs
        WHERE (@pinned = 0 OR user_pinned = 1)
          AND (@q = ''
               OR lower(COALESCE(user_label, '')) LIKE @like
               OR lower(COALESCE(label, '')) LIKE @like)
        ORDER BY COALESCE(last_evidence_at, started_at, created_at) DESC, id`,
    )
    .all({ pinned: pinnedOnly ? 1 : 0, q, like: `%${q.toLowerCase()}%` }) as ArcRowRaw[];
}

function readMemberships(arcIds: readonly string[]): MembershipRow[] {
  if (arcIds.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT ae.arc_id, ae.episode_id, ae.added_by, ae.signal, ae.signal_detail_json,
              e.topic_label, e.source_id, e.started_at
         FROM arc_episodes ae LEFT JOIN episodes e ON e.id = ae.episode_id
        WHERE ae.arc_id IN (${marks(arcIds.length)})
        ORDER BY COALESCE(e.started_at, ae.episode_id), ae.episode_id`,
    )
    .all(...arcIds) as MembershipRow[];
}

/** The persisted verdict per episode, newest last so the map keeps the newest. */
function readVerdicts(episodeIds: readonly string[]): Map<string, { candidates: unknown; output: unknown }> {
  const out = new Map<string, { candidates: unknown; output: unknown }>();
  if (episodeIds.length === 0) return out;
  const rows = getDb()
    .prepare(
      `SELECT episode_id, candidates_json, output_json FROM arc_verdicts
        WHERE episode_id IN (${marks(episodeIds.length)})
        ORDER BY created_at, rowid`,
    )
    .all(...episodeIds) as { episode_id: string; candidates_json: string | null; output_json: string | null }[];
  for (const row of rows) {
    out.set(row.episode_id, {
      candidates: parseJson(row.candidates_json),
      output: parseJson(row.output_json),
    });
  }
  return out;
}

function readAnchorLabels(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT id, canonical FROM entities WHERE id IN (${marks(ids.length)})`)
    .all(...ids) as { id: string; canonical: string | null }[];
  for (const row of rows) out.set(row.id, row.canonical ?? row.id);
  return out;
}

/**
 * Arc keys a `provisional_arcs` row is still carrying. Reconcile has not folded
 * that row in yet, so what the thread contains may still change under the
 * reader — which is precisely what §14.0b's `provisional` flag means.
 */
function readUnsettledKeys(): Set<string> {
  const rows = getDb()
    .prepare(`SELECT DISTINCT arc_key_candidate AS key FROM provisional_arcs WHERE arc_key_candidate IS NOT NULL`)
    .all() as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

/**
 * "⟳ still growing". Coverage is tracked at `global|source|stream` scope only —
 * there is no per-arc row to read — so this is the corpus-wide truth: while an
 * older horizon is still landing, every thread on the surface may still grow.
 * The note names the horizon verbatim rather than prettifying it, because a
 * label the scheduler did not write is a label that can disagree with it.
 */
function growth(): { stillGrowing: boolean; note: string | null } {
  const pending = readCoverage("global", "all").filter((r) => r.totalUnits > 0 && r.doneUnits < r.totalUnits);
  if (pending.length === 0) return { stillGrowing: false, note: null };
  const deepest = [...pending].sort((a, b) => HORIZONS.indexOf(b.horizon) - HORIZONS.indexOf(a.horizon))[0];
  return { stillGrowing: true, note: deepest ? `${deepest.horizon} history queued` : null };
}

// ---- bindings --------------------------------------------------------------

/** The ladder's own rung names, so this mapping cannot drift from §11.2. */
const RUNG_OF: Record<LadderRung, ArcRung> = {
  bridge: 1,
  overlap: 2,
  similarity: 3,
  adjudication: 4,
};

/**
 * One membership row, explained. The rung comes from whatever admitted the
 * episode (`arc_episodes.signal`), and the measured value comes from the
 * verdict the ladder persisted for it — never from a recomputation here, which
 * could disagree with the decision that was actually made.
 *
 * Signals not on the ladder still get a rung, because a row with no rung cannot
 * be sorted into precedence order and would silently vanish from the list:
 * `arc_key` (reconcile's shared key) and the user's own gestures are literals,
 * so they sit at rung ①.
 */
function bindingOf(row: MembershipRow, verdict: { candidates: unknown; output: unknown } | undefined): BindingSignalView {
  const id = `bind_${row.arc_id}_${row.episode_id}`;
  const source = row.source_id ?? "unknown";
  const detail = record(parseJson(row.signal_detail_json));
  const output = record(verdict?.output);
  const candidates = record(verdict?.candidates);
  const signal = row.signal ?? row.added_by ?? "unbound";

  const base = {
    id,
    episodeId: row.episode_id,
    between: `${source} ep`,
    reason: null as string | null,
  };

  if (signal === "bridge") {
    const bridge = record(output?.bridge);
    const left = str(bridge?.leftId);
    const right = str(bridge?.rightId);
    return {
      ...base,
      rung: RUNG_OF.bridge,
      signal: str(bridge?.kind) ?? "bridge",
      value: str(bridge?.valueNorm) ?? num(detail?.confidence),
      measure: "exact",
      between: left !== null && right !== null ? `${left} ↔ ${right}` : base.between,
    };
  }

  if (signal === "overlap" || signal === "similarity") {
    const listed = Array.isArray(candidates?.[signal === "overlap" ? "overlaps" : "similarities"])
      ? (candidates[signal === "overlap" ? "overlaps" : "similarities"] as unknown[])
      : [];
    const mine = listed.map(record).find((c) => str(c?.arc) === row.arc_id);
    return {
      ...base,
      rung: RUNG_OF[signal],
      signal,
      value: num(mine?.score) ?? num(detail?.confidence),
      measure: "score",
    };
  }

  if (signal === "adjudication") {
    const adjudged = record(output?.verdict);
    return {
      ...base,
      rung: RUNG_OF.adjudication,
      signal: "adjudicated",
      value: num(adjudged?.confidence) ?? num(detail?.confidence),
      measure: "confidence",
      // Rung ④'s stated reason is the model's own sentence (brief rule 9).
      reason: str(adjudged?.reason) ?? str(detail?.reason),
    };
  }

  if (signal === "arc_key") {
    return {
      ...base,
      rung: 1,
      signal: "arc_key",
      // The key is a literal both sides share; the first 12 hex identify it.
      value: (str(detail?.arc_key) ?? "").slice(0, 12) || null,
      measure: "exact",
    };
  }

  if (row.added_by === "user" || signal.startsWith("user")) {
    return {
      ...base,
      rung: 1,
      signal: "you",
      value: signal,
      measure: "exact",
      reason: str(detail?.reason),
    };
  }

  // Anything else is served honestly rather than dropped: the surface prints
  // "not measured", which is the one thing a membership must never hide.
  return { ...base, rung: 4, signal, value: num(detail?.confidence), measure: "confidence" };
}

// ---- the page --------------------------------------------------------------

function buildArcsPage(state: ArcState | null, q: string, pinnedOnly: boolean): ArcsPage {
  const all = readArcRows(q, pinnedOnly);

  // The chips are a census of what the search and the pin toggle already
  // narrowed to — picking a state must not renumber the other two.
  const counts: Record<ArcState, number> = { live: 0, dormant: 0, archived: 0 };
  for (const row of all) {
    if (isArcState(row.state)) counts[row.state] += 1;
  }

  const chosen = (state === null ? all : all.filter((r) => r.state === state)).slice(0, MAX_ARCS);
  if (chosen.length === 0) return { arcs: [], counts };

  const memberships = readMemberships(chosen.map((r) => r.id));
  const verdicts = readVerdicts([...new Set(memberships.map((m) => m.episode_id))]);
  const anchorLabels = readAnchorLabels([...new Set(chosen.flatMap((r) => jsonArray(r.anchor_entity_ids)))]);
  const unsettled = readUnsettledKeys();
  const { stillGrowing, note } = growth();

  const byArc = new Map<string, MembershipRow[]>();
  for (const row of memberships) {
    const list = byArc.get(row.arc_id);
    if (list === undefined) byArc.set(row.arc_id, [row]);
    else list.push(row);
  }

  const arcs = chosen.map((row): ArcView => {
    const members = byArc.get(row.id) ?? [];
    const label = row.user_label ?? row.label;
    const episodes: ArcEpisodeView[] = members.map((m) => ({
      episodeId: m.episode_id,
      label: m.topic_label,
      sourceLabel: m.source_id ?? "unknown",
      at: m.started_at,
    }));
    const sources = new Set<string>([...jsonArray(row.source_ids)]);
    for (const episode of episodes) sources.add(episode.sourceLabel);

    return {
      id: row.id,
      label,
      state: isArcState(row.state) ? row.state : ARC_LIVE,
      pinned: Number(row.user_pinned ?? 0) === 1,
      // A promoted arc IS the space — same row, same id (brief rule 6).
      promotedSpaceId: Number(row.promoted ?? 0) === 1 ? row.id : null,
      promotedLabel: Number(row.promoted ?? 0) === 1 ? label : null,
      bindings: members.map((m) => bindingOf(m, verdicts.get(m.episode_id))),
      episodes,
      contributions: episodes
        .filter((e): e is ArcEpisodeView & { at: string } => e.at !== null)
        .map((e) => ({ episodeId: e.episodeId, sourceLabel: e.sourceLabel, at: e.at })),
      anchors: jsonArray(row.anchor_entity_ids).map((id) => ({ id, label: anchorLabels.get(id) ?? id })),
      sourceCount: sources.size,
      stillGrowing,
      growingNote: stillGrowing ? note : null,
      provisional: unsettled.has(row.arc_key),
      lastActiveAt: row.last_evidence_at,
    };
  });

  return { arcs, counts };
}

// ---- the unsure queue ------------------------------------------------------

/**
 * The arc a question is about. `questions` rows are filed against the EPISODE
 * (that is what `askArcQuestion` writes), so the candidate arc is read back off
 * the verdict that raised the question: P-AG2's own join target first, then the
 * arcs rung ③ nominated for it.
 */
function questionSubject(verdict: { candidates: unknown; output: unknown } | undefined): {
  arcId: string | null;
  reasoning: string | null;
  confidence: number | null;
} {
  const output = record(verdict?.output);
  const candidates = record(verdict?.candidates);
  const adjudged = record(output?.verdict);
  const nominated = Array.isArray(candidates?.nominated) ? (candidates.nominated as unknown[]) : [];
  return {
    arcId: str(adjudged?.arcId) ?? str(nominated[0]),
    reasoning: str(adjudged?.reason) ?? str(output?.reason),
    confidence: num(adjudged?.confidence),
  };
}

interface QuestionRow {
  id: string;
  episode_id: string | null;
  question: string;
  asked_at: string | null;
}

function readOpenArcQuestions(): QuestionRow[] {
  return getDb()
    .prepare(
      `SELECT id, target_id AS episode_id, question, asked_at
         FROM questions
        WHERE status = 'open' AND kind = 'arc_binding'
        ORDER BY asked_at, id LIMIT ?`,
    )
    .all(MAX_ARC_QUESTIONS) as QuestionRow[];
}

function buildQuestions(): ArcQuestionView[] {
  const rows = readOpenArcQuestions();
  if (rows.length === 0) return [];

  const episodeIds = [...new Set(rows.map((r) => r.episode_id).filter((id): id is string => id !== null))];
  const verdicts = readVerdicts(episodeIds);
  const episodeLabels = new Map<string, string | null>();
  if (episodeIds.length > 0) {
    for (const row of getDb()
      .prepare(`SELECT id, topic_label FROM episodes WHERE id IN (${marks(episodeIds.length)})`)
      .all(...episodeIds) as { id: string; topic_label: string | null }[]) {
      episodeLabels.set(row.id, row.topic_label);
    }
  }

  const subjects = rows.map((row) => ({
    row,
    subject: questionSubject(row.episode_id === null ? undefined : verdicts.get(row.episode_id)),
  }));
  const arcIds = [...new Set(subjects.map((s) => s.subject.arcId).filter((id): id is string => id !== null))];
  const arcLabels = new Map<string, string | null>();
  if (arcIds.length > 0) {
    for (const row of getDb()
      .prepare(`SELECT id, label, user_label FROM arcs WHERE id IN (${marks(arcIds.length)})`)
      .all(...arcIds) as { id: string; label: string | null; user_label: string | null }[]) {
      arcLabels.set(row.id, row.user_label ?? row.label);
    }
  }

  return subjects.map(({ row, subject }) => ({
    id: row.id,
    episodeId: row.episode_id ?? "",
    episodeLabel: row.episode_id === null ? null : (episodeLabels.get(row.episode_id) ?? null),
    // No recorded candidate is not a reason to withhold the question — the
    // human is still owed it, and the queue renders the id it does have.
    arcId: subject.arcId ?? "",
    arcLabel: subject.arcId === null ? null : (arcLabels.get(subject.arcId) ?? null),
    // Verbatim, and never the ladder's paraphrase when the model spoke.
    reasoning: subject.reasoning ?? row.question,
    confidence: subject.confidence,
    askedAt: row.asked_at,
  }));
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

function receipt(mutationId: string, targetKind: string, targetId: string, field: string): MutationReceipt {
  return { mutationId, actor: USER_ACTOR, targetKind, targetId, field };
}

/**
 * `pinArc` and `setUserLabel` write their own `mutations` row and hand back a
 * verdict rather than an id, so the row they wrote is picked up by rowid
 * watermark. A gesture that changed nothing wrote nothing — and still owes the
 * surface a receipt, so one is written here saying exactly that.
 */
function mutationWatermark(): number {
  const row = getDb().prepare(`SELECT COALESCE(MAX(rowid), 0) AS high FROM mutations`).get() as { high: number };
  return Number(row.high ?? 0);
}

function mutationSince(mark: number, targetId: string, field: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM mutations
        WHERE rowid > ? AND target_kind = 'arc' AND target_id = ? AND field = ?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(mark, targetId, field) as { id: string } | undefined;
  return row?.id ?? null;
}

function arcExists(id: string): boolean {
  return getDb().prepare(`SELECT 1 FROM arcs WHERE id = ?`).get(id) !== undefined;
}

function memberEpisodeIds(arcId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT episode_id FROM arc_episodes WHERE arc_id = ? ORDER BY episode_id`)
      .all(arcId) as { episode_id: string }[]
  ).map((r) => r.episode_id);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle a threads request. Returns true when this module owns the path. */
export async function handleArcsRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/arcs" && !path.startsWith("/api/arcs/")) return false;

  // ---- GET /api/arcs?state=&q=&pinned=1 -----------------------------------
  if (method === "GET" && path === "/api/arcs") {
    const raw = url.searchParams.get("state");
    if (raw !== null && raw !== "" && !isArcState(raw)) {
      sendJson(res, 400, { error: `state must be one of ${ARC_STATES.join(", ")}` });
      return true;
    }
    sendJson(
      res,
      200,
      buildArcsPage(
        raw === null || raw === "" ? null : raw,
        (url.searchParams.get("q") ?? "").trim(),
        url.searchParams.get("pinned") === "1",
      ),
    );
    return true;
  }

  // ---- GET /api/arcs/questions --------------------------------------------
  if (method === "GET" && path === "/api/arcs/questions") {
    sendJson(res, 200, buildQuestions());
    return true;
  }

  // ---- POST /api/arcs/questions/:id { answer } ----------------------------
  const answering = path.match(/^\/api\/arcs\/questions\/([^/]+)$/);
  if (method === "POST" && answering) {
    const id = decodeURIComponent(answering[1]!);
    const body = await readJsonBody(req);
    const answer = body?.answer;
    if (typeof answer !== "string" || !(ARC_ANSWERS as readonly string[]).includes(answer)) {
      sendJson(res, 400, { error: `answer must be one of ${ARC_ANSWERS.join(", ")}` });
      return true;
    }
    const question = getDb()
      .prepare(`SELECT id, target_id AS episode_id FROM questions WHERE id = ? AND status = 'open'`)
      .get(id) as { id: string; episode_id: string | null } | undefined;
    if (question === undefined) {
      sendJson(res, 404, { error: "no open question with that id" });
      return true;
    }
    const episodeId = question.episode_id ?? "";
    const subject = questionSubject(episodeId === "" ? undefined : readVerdicts([episodeId]).get(episodeId));

    // "later" is a scheduling choice, not an answer: the question stays open
    // and nothing is bound. The deferral is still recorded, because a gesture
    // the user made and cannot see a receipt for is a gesture they will repeat.
    if (answer === "later") {
      answerQuestion(id, "later");
      const mutationId = logMutation({
        actor: USER_ACTOR,
        targetKind: "question",
        targetId: id,
        field: "answer",
        oldValue: null,
        newValue: { answer, episodeId },
        reason: "user deferred this binding question; it stays open and nothing is bound",
      });
      sendJson(res, 200, receipt(mutationId, "question", id, "answer"));
      return true;
    }

    if (subject.arcId === null) {
      sendJson(res, 409, { error: "no candidate arc is recorded for this question" });
      return true;
    }
    const arcId = subject.arcId;

    if (answer === "same") {
      attachEpisode({
        arcId,
        episodeId,
        addedBy: "user",
        signal: "user_answer",
        detail: { question_id: id, answer },
      });
    }
    // `move` welds, `split` forbids — the two shapes `readUserConstraints`
    // reads. Either way reconcile plans around the answer instead of re-asking.
    const field = answer === "same" ? "move" : "split";
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "arc",
      targetId: arcId,
      field,
      oldValue: null,
      newValue: { episodeIds: [episodeId] },
      reason:
        answer === "same"
          ? "user answered the unsure queue: same thread"
          : "user answered the unsure queue: separate threads",
    });
    answerQuestion(id, answer);
    sendJson(res, 200, receipt(mutationId, "arc", arcId, field));
    return true;
  }

  // Everything below is a gesture on one arc.
  const gesture = path.match(/^\/api\/arcs\/([^/]+)\/(remove-episode|split|merge|pin|relabel)$/);
  if (method !== "POST" || gesture === null) {
    sendJson(res, 404, { error: "unknown arcs route" });
    return true;
  }
  const arcId = decodeURIComponent(gesture[1]!);
  const kind = gesture[2]!;
  if (!arcExists(arcId)) {
    sendJson(res, 404, { error: "no arc with that id" });
    return true;
  }
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { error: "invalid body" });
    return true;
  }

  // ---- POST /api/arcs/:id/remove-episode { episodeId } --------------------
  if (kind === "remove-episode") {
    const episodeId = body.episodeId;
    if (typeof episodeId !== "string" || episodeId === "") {
      sendJson(res, 400, { error: "episodeId (string) required" });
      return true;
    }
    if (!memberEpisodeIds(arcId).includes(episodeId)) {
      sendJson(res, 404, { error: "that episode is not in this arc" });
      return true;
    }
    detachEpisode(arcId, episodeId);
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "arc",
      targetId: arcId,
      field: "split",
      oldValue: { episodeIds: [episodeId] },
      newValue: { episodeIds: [episodeId] },
      reason: "user removed this episode from the thread; reconcile never re-merges it",
    });
    sendJson(res, 200, receipt(mutationId, "arc", arcId, "split"));
    return true;
  }

  // ---- POST /api/arcs/:id/split { episodeIds } ----------------------------
  if (kind === "split") {
    const episodeIds = [...new Set(stringList(body.episodeIds))].sort();
    if (episodeIds.length === 0) {
      sendJson(res, 400, { error: "episodeIds (string[]) required" });
      return true;
    }
    const members = new Set(memberEpisodeIds(arcId));
    const strangers = episodeIds.filter((id) => !members.has(id));
    if (strangers.length > 0) {
      sendJson(res, 404, { error: `not in this arc: ${strangers.join(", ")}` });
      return true;
    }
    for (const episodeId of episodeIds) detachEpisode(arcId, episodeId);

    // The episodes taken out need a home while they wait, and reconcile already
    // has one for exactly this case: a provisional row under a split-derived
    // key, with the same derived id reconcile's own exile branch uses, so the
    // next pass finds the row it would have written rather than a duplicate.
    const key = splitKey(arcId, episodeIds);
    writeProvisionalArc({
      id: `prov_split_${key.slice(0, 16)}`,
      arcKeyCandidate: key,
      episodeIds,
    });

    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "arc",
      targetId: arcId,
      field: "split",
      oldValue: { episodeIds },
      newValue: { episodeIds },
      reason: `user split ${episodeIds.length} episode(s) out of this thread`,
    });
    sendJson(res, 200, receipt(mutationId, "arc", arcId, "split"));
    return true;
  }

  // ---- POST /api/arcs/:id/merge { into } ----------------------------------
  if (kind === "merge") {
    const into = body.into;
    if (typeof into !== "string" || into === "") {
      sendJson(res, 400, { error: "into (string) required" });
      return true;
    }
    if (into === arcId) {
      sendJson(res, 400, { error: "an arc cannot be merged into itself" });
      return true;
    }
    if (!arcExists(into)) {
      sendJson(res, 404, { error: "no surviving arc with that id" });
      return true;
    }
    const episodeIds = memberEpisodeIds(arcId);
    for (const episodeId of episodeIds) {
      attachEpisode({
        arcId: into,
        episodeId,
        addedBy: "user",
        signal: "user_move",
        detail: { from_arc_id: arcId },
      });
      detachEpisode(arcId, episodeId);
    }
    // `move` on the DESTINATION welds every episode there (§11.2 step ④).
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "arc",
      targetId: into,
      field: "move",
      oldValue: { fromArcId: arcId, episodeIds },
      newValue: { episodeIds },
      reason: `user merged ${arcId} into ${into}`,
    });

    // The emptied thread is ARCHIVED, never deleted: the id keeps resolving and
    // the merge stays undoable. No store function writes `state` on a user
    // gesture — `reconcile/ageArcs` owns the clock, and the clock is not what
    // happened here — so the one field is written inline.
    const before = getDb().prepare(`SELECT state FROM arcs WHERE id = ?`).get(arcId) as { state: string };
    if (before.state !== ARC_ARCHIVED) {
      getDb()
        .prepare(
          `UPDATE arcs SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(ARC_ARCHIVED, arcId);
      logMutation({
        actor: USER_ACTOR,
        targetKind: "arc",
        targetId: arcId,
        field: "state",
        oldValue: before.state,
        newValue: ARC_ARCHIVED,
        reason: `merged into ${into} by the user`,
      });
    }
    sendJson(res, 200, receipt(mutationId, "arc", into, "move"));
    return true;
  }

  // ---- POST /api/arcs/:id/pin { pinned } ----------------------------------
  if (kind === "pin") {
    const pinned = body.pinned;
    if (typeof pinned !== "boolean") {
      sendJson(res, 400, { error: "pinned (boolean) required" });
      return true;
    }
    const mark = mutationWatermark();
    // The pin itself is logged under `user`; the promotion fields it re-derives
    // are logged under `code:promote`, which is what they are.
    if (pinned) pinArc(arcId);
    else unpinArc(arcId);
    const mutationId =
      mutationSince(mark, arcId, "user_pinned") ??
      logMutation({
        actor: USER_ACTOR,
        targetKind: "arc",
        targetId: arcId,
        field: "user_pinned",
        oldValue: pinned ? 1 : 0,
        newValue: pinned ? 1 : 0,
        reason: pinned ? "already pinned" : "already unpinned",
      });
    sendJson(res, 200, receipt(mutationId, "arc", arcId, "user_pinned"));
    return true;
  }

  // ---- POST /api/arcs/:id/relabel { label } -------------------------------
  const label = body.label;
  if (typeof label !== "string") {
    sendJson(res, 400, { error: "label (string) required" });
    return true;
  }
  const trimmed = label.trim();
  const mark = mutationWatermark();
  // An empty label clears the user's word rather than storing "", so the
  // derived label surfaces again instead of a blank card.
  setUserLabel(arcId, trimmed === "" ? null : trimmed);
  const mutationId =
    mutationSince(mark, arcId, "user_label") ??
    logMutation({
      actor: USER_ACTOR,
      targetKind: "arc",
      targetId: arcId,
      field: "user_label",
      oldValue: trimmed === "" ? null : trimmed,
      newValue: trimmed === "" ? null : trimmed,
      reason: "the thread already carried this label",
    });
  sendJson(res, 200, receipt(mutationId, "arc", arcId, "user_label"));
  return true;
}
