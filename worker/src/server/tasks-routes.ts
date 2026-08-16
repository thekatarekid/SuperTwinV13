// ===========================================================================
// [CODE] Tasks surface routes — arch §14.7, build item 3.10.
//
// One read and six writes. The read is the whole surface in a single call, for
// the same reason /api/ops/import is one call: the header counts
//
//   ● N you said you'd do   ○ N suggested   ⏳ N need a check
//
// are the LENGTHS of the three lists this response carries (`tasks` split by
// origin, and `doneChecks`), so a counter can never disagree with the list
// under it. Nothing here recounts anything the surface then re-derives.
//
//   GET  /api/tasks?origin=&space=&q=   the page: tasks, done checks, waiting
//   POST /api/tasks/:id/done            §14.8 user gesture → done
//   POST /api/tasks/:id/drop            §14.8 user gesture → dropped
//   POST /api/tasks/:id/snooze          { until? } — moves the due, re-derives
//   POST /api/tasks/:id/accept          "yes, track it" on a suggestion
//   POST /api/tasks/:id/reject          "not useful" — TEACHES, never deletes
//   POST /api/questions/:id             { done } — the one-tap done check
//
// THREE THINGS THIS FILE REFUSES TO DO ITSELF
//
//  1. IT NEVER RE-IMPLEMENTS THE STATE FUNCTION. Every state and every reason
//     comes out of `loops/state.ts` (`deriveLoopState`), so a gesture and the
//     pipeline can never disagree about what `done` means. A gesture is one
//     more input to that function — `userGesture` — not a second code path.
//  2. IT NEVER DELETES. "Not useful" writes a user-sourced preference claim
//     through the real `writeClaim` path and takes the §14.8 `dropped`
//     gesture (§14.7 rule 2). The row is retained; only the view changes.
//  3. IT NEVER DECIDES OWNERSHIP TWICE. `ownerIsSelf` is the worker's answer
//     (`owner_id` resolved against the `me` entity) and the surface re-checks
//     it in `tasks/partition.ts`. Two independent guards, on purpose — a loop
//     owned by another person goes to `waitingOnOthers`, which is context.
//
// STORED STATE WINS FOR TERMINAL ROWS. `open`/`latent` are re-derived on read
// because passing time turns `open` into `lapsed` on its own (state.ts's own
// note), but `done`/`dropped`/`lapsed` are left exactly as stored: they encode
// a user gesture or resolving evidence, and `loops` carries no `user_gesture`
// column to re-derive them from. Recomputing those would silently undo a tap.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { writeClaim } from "../claims/write.js";
import { getDb } from "../db/connection.js";
import { ensureMeEntity, meEntityId } from "../entities/binding.js";
import { logMutation } from "../entities/merge.js";
import { getEntity, resolveEntityId } from "../entities/registry.js";
import { doneQuestionText } from "../loops/done.js";
import {
  deriveLoopState,
  loopHorizon,
  loopStateInputFromRow,
  type LoopStateFacts,
  type UserGesture,
} from "../loops/state.js";
import { tr1DefaultTriage } from "../loops/triage.js";

/** The one actor a surface gesture may ever write under (§14.8, surfaces §1). */
const USER_ACTOR = "user";

/** A read cap. The surface paginates by filtering, never by offset. */
const TASK_LIMIT = 500;

/** A snooze with no date is "not today" — the smallest honest answer. */
const DEFAULT_SNOOZE_MS = 86_400_000;

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
// The view shapes (src/lib/tasks-client.ts is the contract)
// ---------------------------------------------------------------------------

export interface LoopEvidenceView {
  eventId: string;
  /** VERBATIM, straight off the `evidence` row. Never re-worded (§6). */
  quote: string;
  at: string | null;
  episodeId: string | null;
}

export interface TaskView {
  id: string;
  intent: string;
  origin: string;
  state: string;
  stateReason: string | null;
  stateNote: string | null;
  triage: string;
  ownerIsSelf: boolean;
  ownerLabel: string;
  counterpartyLabel: string | null;
  dueAt: string | null;
  dueLabel: string | null;
  recurrence: string | null;
  nextOccurrenceAt: string | null;
  spaceId: string | null;
  spaceLabel: string | null;
  confidence: number | null;
  inferredFrom: string | null;
  provisional: boolean;
  pendingNote: string | null;
  updatedAt: string | null;
  evidence: LoopEvidenceView[];
}

/** §14.7's "DID YOU DO THIS?" — one tap, with the evidence quote. */
export interface DoneCheckView {
  id: string;
  loopId: string;
  intent: string;
  observation: string;
  quote: string;
  at: string | null;
}

/** §14.7's "WAITING ON OTHERS": context only. Never a to-do. */
export interface WaitingItemView {
  id: string;
  personLabel: string;
  intent: string;
  dueLabel: string | null;
}

export interface TasksPage {
  tasks: TaskView[];
  doneChecks: DoneCheckView[];
  waitingOnOthers: WaitingItemView[];
}

/** What a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A `loops` row as this surface reads it. `loops` has no `user_gesture`. */
interface LoopRow {
  id: string;
  intent: string | null;
  origin: string | null;
  owner_id: string | null;
  counterparty_id: string | null;
  triage: string | null;
  state: string | null;
  state_reason: string | null;
  due_utc: string | null;
  recurrence: string | null;
  next_occurrence_utc: string | null;
  arc_id: string | null;
  confidence: number | null;
  resolution_evidence_event_id: string | null;
  stated_at: string | null;
  updated_at: string | null;
}

const LOOP_COLUMNS = `id, intent, origin, owner_id, counterparty_id, triage, state, state_reason,
                      due_utc, recurrence, next_occurrence_utc, arc_id, confidence,
                      resolution_evidence_event_id, stated_at, updated_at`;

function readLoop(id: string): LoopRow | null {
  return (getDb().prepare(`SELECT ${LOOP_COLUMNS} FROM loops WHERE id = ?`).get(id) as LoopRow | undefined) ?? null;
}

function marks(n: number): string {
  return new Array(n).fill("?").join(",");
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "due today" · "due 20 Jul" · "overdue". Composed here rather than in the
 * browser because §14.7 prints it beside a state the worker derived, and two
 * clocks would eventually disagree about which day "today" is.
 */
function dueLabel(dueUtc: string | null, now: number): string | null {
  if (dueUtc === null || dueUtc.trim() === "") return null;
  const ms = Date.parse(dueUtc);
  if (Number.isNaN(ms)) return null;
  if (ms <= now) return "overdue";
  if (loopHorizon(dueUtc, now) === "today") return "due today";
  const d = new Date(ms);
  return `due ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * §14.7 rule 4 — a lapsed task says WHY. The surface already spells out
 * `past_due_no_recurrence` and `born_lapsed` itself, so this supplies a
 * sentence only for the reasons it has no wording for, and null otherwise:
 * the client's fallback is better English than a duplicate of it here.
 */
const STATE_NOTES: Readonly<Record<string, string>> = {
  recurrence_exhausted: "the recurring series has ended — there is no next occurrence",
  recurrence_unparsed: "the stated cadence could not be read, so no next occurrence was projected",
  no_intent: "no intent was ever stated for it",
};

/** `entities.canonical`, following any merge tombstone. */
function labelOf(entityId: string | null): string | null {
  if (entityId === null || entityId.trim() === "") return null;
  const row = getEntity(entityId);
  return row?.canonical ?? null;
}

/**
 * The stored triage in the surface's spelling. The DB's long form is `approval`
 * (`claims/codefacts.ts` TRIAGE_CLASSES); the client's enum spells it
 * `approve`. One mapping, here, rather than two vocabularies in the wire.
 */
function triageOut(stored: string | null, ownerIsSelf: boolean, origin: string | null): string {
  const value =
    stored ?? tr1DefaultTriage({ ownerId: ownerIsSelf ? "self" : "other", origin }).triage;
  return value === "approval" ? "approve" : value;
}

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

interface EvidenceRow {
  subject_id: string;
  event_id: string;
  quote: string;
  episode_id: string | null;
  ts: string | null;
}

interface PendingRow {
  subject_id: string;
  transcribing: number;
  enriching: number;
}

interface ArcRow {
  id: string;
  label: string | null;
  user_label: string | null;
  promoted: number;
}

/**
 * §14.0b rule 5 — "a partially-read conversation never looks complete". A loop
 * whose evidence still has a transcript or an enrichment in flight is marked
 * provisional and says what is outstanding, in its own words.
 */
function pendingNote(row: PendingRow | undefined): string | null {
  if (!row) return null;
  if (row.transcribing > 0) {
    return `${row.transcribing} voice note${row.transcribing === 1 ? "" : "s"} still transcribing`;
  }
  if (row.enriching > 0) {
    return `${row.enriching} message${row.enriching === 1 ? "" : "s"} still being read`;
  }
  return null;
}

function tasksPage(query: URLSearchParams, now = Date.now()): TasksPage {
  const db = getDb();
  const me = meEntityId();

  // Only live work and history that is still shown: `done` and `dropped` are
  // retained rows, but they are not a task list (§14.7, tasks/partition.ts).
  const where: string[] = ["(state IS NULL OR state IN ('open','latent','lapsed'))"];
  const params: string[] = [];
  const origin = query.get("origin");
  if (origin === "explicit" || origin === "implicit") {
    where.push("origin = ?");
    params.push(origin);
  }
  const space = query.get("space");
  if (space !== null && space !== "") {
    where.push("arc_id = ?");
    params.push(space);
  }
  const q = query.get("q");
  if (q !== null && q.trim() !== "") {
    where.push("intent LIKE ? ESCAPE '\\'");
    params.push(`%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }

  const rows = db
    .prepare(
      `SELECT ${LOOP_COLUMNS} FROM loops
        WHERE ${where.join(" AND ")}
        ORDER BY (due_utc IS NULL), due_utc, stated_at DESC, id
        LIMIT ?`,
    )
    .all(...params, TASK_LIMIT) as LoopRow[];

  // An empty graph is the normal state before the first derivation pass, so
  // every join below is skipped rather than issued with an empty IN ().
  if (rows.length === 0) return { tasks: [], doneChecks: doneChecks(), waitingOnOthers: [] };

  const ids = rows.map((r) => r.id);
  const evidence = db
    .prepare(
      `SELECT ev.subject_id, ev.event_id, ev.quote, ev.episode_id, e.ts
         FROM evidence ev LEFT JOIN events e ON e.id = ev.event_id
        WHERE ev.subject_kind = 'loop' AND ev.subject_id IN (${marks(ids.length)})
        ORDER BY e.ts DESC, ev.event_id`,
    )
    .all(...ids) as EvidenceRow[];
  const evidenceByLoop = new Map<string, LoopEvidenceView[]>();
  for (const row of evidence) {
    const list = evidenceByLoop.get(row.subject_id) ?? [];
    list.push({ eventId: row.event_id, quote: row.quote, at: row.ts, episodeId: row.episode_id });
    evidenceByLoop.set(row.subject_id, list);
  }

  const pending = db
    .prepare(
      `SELECT ev.subject_id,
              SUM(CASE WHEN e.transcript_status = 'pending' THEN 1 ELSE 0 END) AS transcribing,
              SUM(CASE WHEN e.enrichment_state  = 'pending' THEN 1 ELSE 0 END) AS enriching
         FROM evidence ev JOIN events e ON e.id = ev.event_id
        WHERE ev.subject_kind = 'loop' AND ev.subject_id IN (${marks(ids.length)})
        GROUP BY ev.subject_id`,
    )
    .all(...ids) as PendingRow[];
  const pendingByLoop = new Map(pending.map((p) => [p.subject_id, p]));

  // "A promoted arc IS the space" (§14.7). An arc that has not been promoted
  // is not one, so the row groups under "no space" rather than borrowing a
  // label the user has never seen.
  const arcIds = [...new Set(rows.map((r) => r.arc_id).filter((id): id is string => id !== null))];
  const arcs = arcIds.length
    ? (db
        .prepare(`SELECT id, label, user_label, promoted FROM arcs WHERE id IN (${marks(arcIds.length)})`)
        .all(...arcIds) as ArcRow[])
    : [];
  const arcById = new Map(arcs.map((a) => [a.id, a]));

  const tasks: TaskView[] = [];
  const waitingOnOthers: WaitingItemView[] = [];

  for (const row of rows) {
    const ownerIsSelf =
      me !== null && row.owner_id !== null && resolveEntityId(row.owner_id) === me;
    // Terminal rows keep the state they were written with (see the header);
    // everything else is re-derived so the clock alone can lapse a task.
    const stored = row.state;
    const terminal = stored === "done" || stored === "dropped" || stored === "lapsed";
    const derived = deriveLoopState(loopStateInputFromRow(row), now);
    const state = terminal ? stored : derived.state;
    const stateReason = terminal ? row.state_reason : derived.stateReason;
    const nextOccurrenceAt = terminal ? row.next_occurrence_utc : derived.nextOccurrenceUtc;

    const ownerLabel = labelOf(row.owner_id);
    const counterpartyLabel = labelOf(row.counterparty_id);
    const label = dueLabel(row.due_utc, now);

    if (!ownerIsSelf) {
      // §14.7.5 — another person's open loop is context on that person. It is
      // never a task, and it is never silently dropped either.
      if (state === "open" || state === "latent") {
        waitingOnOthers.push({
          id: row.id,
          personLabel: ownerLabel ?? "someone",
          intent: row.intent ?? "",
          dueLabel: label,
        });
      }
      continue;
    }

    const arc = row.arc_id === null ? undefined : arcById.get(row.arc_id);
    const space = arc && arc.promoted === 1 ? arc : undefined;
    const note = pendingNote(pendingByLoop.get(row.id));
    tasks.push({
      id: row.id,
      intent: row.intent ?? "",
      origin: row.origin === "implicit" ? "implicit" : "explicit",
      state,
      stateReason,
      stateNote: STATE_NOTES[stateReason ?? ""] ?? null,
      triage: triageOut(row.triage, ownerIsSelf, row.origin),
      ownerIsSelf,
      ownerLabel: ownerLabel ?? "you",
      counterpartyLabel,
      dueAt: row.due_utc,
      dueLabel: label,
      recurrence: row.recurrence,
      nextOccurrenceAt,
      spaceId: space?.id ?? null,
      spaceLabel: space ? (space.user_label ?? space.label ?? null) : null,
      confidence: row.confidence,
      // No column carries the model's "inferred from" sentence: extraction
      // emits the intent and the evidence, and neither is a rationale. Null
      // until one is stored — the surface prints nothing rather than a guess.
      inferredFrom: null,
      provisional: note !== null,
      pendingNote: note,
      updatedAt: row.updated_at,
      evidence: evidenceByLoop.get(row.id) ?? [],
    });
  }

  return { tasks, doneChecks: doneChecks(), waitingOnOthers };
}

interface QuestionRow {
  id: string;
  target_id: string;
  question: string;
  asked_at: string | null;
  intent: string | null;
}

/**
 * §14.7 rule 3 — "DID YOU DO THIS?", one tap with the evidence quote. The
 * `questions` table stores the worker's own sentence; the quote is read off
 * the loop's evidence rather than duplicated into the question row, so the
 * proof a person sees is the same row every other surface quotes.
 */
function doneChecks(): DoneCheckView[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT q.id, q.target_id, q.question, q.asked_at, l.intent
         FROM questions q LEFT JOIN loops l ON l.id = q.target_id
        WHERE q.status = 'open' AND q.kind = 'done_check' AND q.target_kind = 'loop'
        ORDER BY q.asked_at, q.id LIMIT 200`,
    )
    .all() as QuestionRow[];
  if (rows.length === 0) return [];

  const loopIds = [...new Set(rows.map((r) => r.target_id))];
  const quotes = db
    .prepare(
      `SELECT ev.subject_id, ev.event_id, ev.quote, ev.episode_id, e.ts
         FROM evidence ev LEFT JOIN events e ON e.id = ev.event_id
        WHERE ev.subject_kind = 'loop' AND ev.subject_id IN (${marks(loopIds.length)})
        ORDER BY e.ts DESC, ev.event_id`,
    )
    .all(...loopIds) as EvidenceRow[];
  const newest = new Map<string, EvidenceRow>();
  for (const row of quotes) if (!newest.has(row.subject_id)) newest.set(row.subject_id, row);

  return rows.map((row) => {
    const quote = newest.get(row.target_id);
    return {
      id: row.id,
      loopId: row.target_id,
      intent: row.intent ?? "",
      observation: row.question.trim() === "" ? doneQuestionText(row.intent) : row.question,
      quote: quote?.quote ?? "",
      at: quote?.ts ?? row.asked_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Writes — every one of them a `mutations` row with actor `user`
// ---------------------------------------------------------------------------

/**
 * Write the derived facts back. `dueUtc === undefined` leaves the due alone;
 * snooze is the one gesture that moves it, and it passes the new value in.
 */
function applyFacts(id: string, facts: LoopStateFacts, dueUtc?: string): void {
  const db = getDb();
  if (dueUtc === undefined) {
    db.prepare(
      `UPDATE loops SET state = ?, state_reason = ?, next_occurrence_utc = ?, horizon = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(facts.state, facts.stateReason, facts.nextOccurrenceUtc, facts.horizon, id);
    return;
  }
  db.prepare(
    `UPDATE loops SET due_utc = ?, state = ?, state_reason = ?, next_occurrence_utc = ?, horizon = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(dueUtc, facts.state, facts.stateReason, facts.nextOccurrenceUtc, facts.horizon, id);
}

function receipt(mutationId: string, targetId: string, field: string, targetKind = "loop"): MutationReceipt {
  return { mutationId, actor: USER_ACTOR, targetKind, targetId, field };
}

/** §14.8 — a tap is one more input to the state function, not a second path. */
function applyGesture(row: LoopRow, gesture: UserGesture, reason: string): MutationReceipt {
  const facts = deriveLoopState({ ...loopStateInputFromRow(row), userGesture: gesture });
  applyFacts(row.id, facts);
  const id = logMutation({
    actor: USER_ACTOR,
    targetKind: "loop",
    targetId: row.id,
    field: "state",
    oldValue: { state: row.state, stateReason: row.state_reason },
    newValue: { state: facts.state, stateReason: facts.stateReason },
    reason,
  });
  return receipt(id, row.id, "state");
}

/**
 * §14.7 rule 2 — "REJECTING A SUGGESTION TEACHES." The tap writes a
 * user-sourced preference claim through the REAL write path (actor `user`, so
 * it enters `claims_active` and every future roster) and takes the §14.8
 * `dropped` gesture. There is no delete verb anywhere on this surface.
 */
function rejectSuggestion(row: LoopRow): MutationReceipt {
  const me = ensureMeEntity();
  const intent = row.intent ?? "";
  writeClaim(
    {
      kind: "preference",
      tag: "P",
      subjectId: me,
      text: `Prefers not to be reminded about: ${intent}`,
      speakerId: me,
      attribution: "first_person",
      statedAt: new Date().toISOString(),
    },
    { actor: USER_ACTOR, decidedBy: USER_ACTOR },
  );
  return applyGesture(row, "dropped", "not useful — the rejection teaches (§14.7 rule 2)");
}

/**
 * "yes, track it" (§14.7 rule 1's implicit verb). The loop becomes one the
 * user has now stated: `origin = explicit`, which is what actually changes the
 * surface — §11.5.7's aging applies only to implicit loops, so an adopted
 * suggestion stops drifting to `latent` and moves into "you said you'd do
 * this". The triage is deliberately untouched: implicit is NEVER `auto`
 * (§11.5.2) and a tap is not a grant of autonomy.
 */
function acceptSuggestion(row: LoopRow): MutationReceipt {
  const facts = deriveLoopState({ ...loopStateInputFromRow(row), origin: "explicit" });
  getDb().prepare(`UPDATE loops SET origin = 'explicit' WHERE id = ?`).run(row.id);
  applyFacts(row.id, facts);
  const id = logMutation({
    actor: USER_ACTOR,
    targetKind: "loop",
    targetId: row.id,
    field: "origin",
    oldValue: { origin: row.origin, state: row.state },
    newValue: { origin: "explicit", state: facts.state },
    reason: "yes, track it",
  });
  return receipt(id, row.id, "origin");
}

/** The one-tap done check. `yes` closes the loop; `no` only answers. */
function answerDoneCheck(questionId: string, done: boolean): MutationReceipt | null {
  const db = getDb();
  const question = db
    .prepare(`SELECT id, target_kind, target_id FROM questions WHERE id = ? AND status = 'open'`)
    .get(questionId) as { id: string; target_kind: string | null; target_id: string | null } | undefined;
  if (!question) return null;

  const answer = done ? "Yes, done" : "Not yet";
  db.prepare(
    `UPDATE questions
        SET status = 'answered', answer_json = ?,
            answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'open'`,
  ).run(JSON.stringify({ answer, done }), questionId);
  const mutationId = logMutation({
    actor: USER_ACTOR,
    targetKind: "question",
    targetId: questionId,
    field: "answer",
    newValue: { answer, done },
    reason: "done check answered",
  });

  // A `yes` is a user gesture on the loop, recorded as its own mutation so
  // "undo run X" reverses the state flip and the answer independently.
  if (done && question.target_kind === "loop" && question.target_id !== null) {
    const row = readLoop(question.target_id);
    if (row) applyGesture(row, "done", "done check answered yes");
  }
  return receipt(mutationId, questionId, "answer", "question");
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle a Tasks request. Returns true when this module owns the path. */
export async function handleTasksRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const owned =
    path === "/api/tasks" || path.startsWith("/api/tasks/") || path.startsWith("/api/questions/");
  if (!owned) return false;

  // ---- GET /api/tasks?origin=&space=&q= -----------------------------------
  if (method === "GET" && path === "/api/tasks") {
    sendJson(res, 200, tasksPage(url.searchParams));
    return true;
  }

  // ---- POST /api/tasks/:id/<gesture> --------------------------------------
  const gesture = path.match(/^\/api\/tasks\/([^/]+)\/(done|drop|snooze|accept|reject)$/);
  if (method === "POST" && gesture) {
    const id = decodeURIComponent(gesture[1]!);
    const verb = gesture[2]!;
    const body = await readJsonBody(req);
    if (body === undefined) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return true;
    }
    const row = readLoop(id);
    if (!row) {
      sendJson(res, 404, { error: "no loop with that id" });
      return true;
    }

    if (verb === "done") {
      sendJson(res, 200, applyGesture(row, "done", "marked done"));
      return true;
    }
    if (verb === "drop") {
      sendJson(res, 200, applyGesture(row, "dropped", "dropped"));
      return true;
    }
    if (verb === "accept") {
      sendJson(res, 200, acceptSuggestion(row));
      return true;
    }
    if (verb === "reject") {
      sendJson(res, 200, rejectSuggestion(row));
      return true;
    }

    // snooze { until? } — moves the due and re-derives. An unparseable date is
    // a 400, never a silent "tomorrow": a snooze the user cannot see is a task
    // that vanished.
    const until = body.until;
    let due: string;
    if (until === undefined || until === null) {
      due = new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString();
    } else if (typeof until === "string" && !Number.isNaN(Date.parse(until))) {
      due = new Date(Date.parse(until)).toISOString();
    } else {
      sendJson(res, 400, { error: "until must be an ISO timestamp" });
      return true;
    }
    const facts = deriveLoopState({ ...loopStateInputFromRow(row), dueUtc: due });
    applyFacts(row.id, facts, due);
    const mutationId = logMutation({
      actor: USER_ACTOR,
      targetKind: "loop",
      targetId: row.id,
      field: "due_utc",
      oldValue: { dueUtc: row.due_utc, state: row.state },
      newValue: { dueUtc: due, state: facts.state },
      reason: "snoozed",
    });
    sendJson(res, 200, receipt(mutationId, row.id, "due_utc"));
    return true;
  }

  // ---- POST /api/questions/:id { done } -----------------------------------
  const answer = path.match(/^\/api\/questions\/([^/]+)$/);
  if (method === "POST" && answer) {
    const id = decodeURIComponent(answer[1]!);
    const body = await readJsonBody(req);
    if (body === undefined || typeof body.done !== "boolean") {
      sendJson(res, 400, { error: "done (boolean) required" });
      return true;
    }
    const written = answerDoneCheck(id, body.done);
    if (written === null) {
      sendJson(res, 404, { error: "no open question with that id" });
      return true;
    }
    sendJson(res, 200, written);
    return true;
  }

  sendJson(res, 404, { error: "unknown tasks route" });
  return true;
}
