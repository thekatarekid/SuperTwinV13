// ===========================================================================
// [CODE] Category Q executor — the Tasks view over the real loop machinery.
//
// Q is §11.3's one-line thesis made measurable: `task = loop WHERE owner_id ==
// me AND state ∈ {open, latent}` — a QUERY, not a stored duplicate. Every case
// persists its loops to a real temp SQLite DB (real migrations, real `loops`
// rows), and the Tasks view is then computed by the REAL `tasksFrom()` over
// those rows — never by a filter re-implemented here. The three invariants the
// worker tests already assert are measured here over the Q corpus:
//
//   * zero non-self loops in Tasks        (`tasksFrom` + `nonSelfLoopsInTasks`)
//   * zero loops born past-due as open    (`pastDueOpenViolations`)
//   * `possibly_done` does not exist      (`doneStateViolations`, §11.4.3)
//
// The fixture's loops live in `given.open.loops`, one object per loop:
//
//   { "t": "t1", "intent": "…", "origin": "explicit"|"implicit",
//     "owner": "self"|"a1", "counterparty": "self"|"a1"|null,
//     "due": iso|null, "recurrence": "monthly"|null,
//     "stated_at": iso|null, "last_reinforced_at": iso|null,
//     "resolution_evidence_event": n|null,   // a given.events number
//     "user_gesture": "done"|"dropped"|null, // §14.8: state written directly
//     "not_useful": true,                    // the tap on a suggestion
//     "attempt_state": "possibly_done" }     // Q-028: the state that must FAIL
//
// Two frozen-wire flows ride on top, both through the real prompt modules:
//   `S|…` lines → P-DD1 (`parseDd1Response` → `applyDd1Answer`): `ps` leaves
//                 the loop OPEN and raises a one-tap question (Q-029).
//   `J|…` lines → P-TR1 (`parseTr1Response` → `tr1Assignments`): approvals
//                 attach per LOOP; a blanket line resolves to no loop and is
//                 kept in `unresolved`, reported and never applied (Q-030).
//
// "Not useful" (Q-021..024) is §14.7.2 — rejection TEACHES, never deletes: the
// tap writes a user-sourced preference claim through the real `writeClaim`
// path (actor `user`, so it enters `claims_active` and every future roster),
// and the loop takes the §14.8 `dropped` gesture through the real state
// function. The row is retained; only the view changes.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loopCodeFacts,
  nonSelfLoopsInTasks,
  tasksFrom,
  type LoopCodeFactsInput,
} from "../../claims/codefacts.js";
import { loopIdForKey, loopKey } from "../../claims/keys.js";
import { activeClaims, writeClaim } from "../../claims/write.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { ensureMeEntity } from "../../entities/binding.js";
import type { PartySession } from "../../entities/party.js";
import {
  applyDd1Answer,
  doneStateViolations,
  type DoneApplication,
  type DoneOutcome,
} from "../../loops/done.js";
import {
  ABOLISHED_STATES,
  deriveLoopStateFromRow,
  isTaskState,
  pastDueOpenViolations,
  type LoopStateRow,
  type UserGesture,
} from "../../loops/state.js";
import { tr1Assignments, type Tr1Assignment } from "../../loops/triage.js";
import { buildDd1Prompt, dd1Accounts, parseDd1Response, type Dd1Loop } from "../../prompts/p-dd1.js";
import { buildTr1Prompt, parseTr1Response, tr1Accounts, type Tr1Loop } from "../../prompts/p-tr1.js";
import { packPrompt, type PackEntity, type PackEvent } from "../../wire/pack.js";
import type { Fixture, FixtureEvent } from "../fixtures.js";
import type { Executor, GateObservation, Produced } from "../runner.js";
import { doneCorpusObservations } from "./done-corpus.js";

/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = "2026-08-15T12:00:00.000Z";

/** §14.7 — the two lists' verbs. Different products, never interleaved. */
const EXPLICIT_VERB = "you said you'd do this";
const IMPLICIT_VERB = "suggested by your twin";

// ---- the fixture's world ---------------------------------------------------

interface World {
  aliases: { alias: string; label: string }[];
  events: FixtureEvent[];
}

function worldOf(fixture: Fixture): World {
  const aliases: World["aliases"] = [];
  for (const entry of fixture.given.roster) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const alias = entry.slice(0, eq).trim();
    if (alias === "self") continue;
    aliases.push({ alias, label: entry.slice(eq + 1).trim() });
  }
  const events = [...fixture.given.events].sort((a, b) => a.n - b.n);
  return { aliases, events };
}

const entityIdOf = (alias: string): string => `ent_${alias}`;
const eventIdOf = (n: number): string => `ev${n}`;

// ---- the loop spec ---------------------------------------------------------

interface LoopSpec {
  t: string;
  intent: string;
  origin: string | null;
  owner: string;
  counterparty: string | null;
  due: string | null;
  recurrence: string | null;
  statedAt: string | null;
  lastReinforcedAt: string | null;
  resolutionEvidenceEvent: number | null;
  userGesture: UserGesture | null;
  notUseful: boolean;
  attemptState: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function specOf(raw: unknown, index: number): LoopSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`tasks executor: given.open.loops[${index}] is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const t = str(r.t);
  const intent = str(r.intent);
  const owner = str(r.owner);
  if (!t || !intent || !owner) {
    throw new Error(`tasks executor: given.open.loops[${index}] needs t, intent and owner`);
  }
  const gesture = str(r.user_gesture);
  if (gesture !== null && gesture !== "done" && gesture !== "dropped") {
    throw new Error(`tasks executor: given.open.loops[${index}].user_gesture must be done|dropped`);
  }
  const ev = r.resolution_evidence_event;
  return {
    t,
    intent,
    origin: str(r.origin),
    owner,
    counterparty: str(r.counterparty),
    due: str(r.due),
    recurrence: str(r.recurrence),
    statedAt: str(r.stated_at),
    lastReinforcedAt: str(r.last_reinforced_at),
    resolutionEvidenceEvent: typeof ev === "number" && Number.isInteger(ev) ? ev : null,
    userGesture: gesture as UserGesture | null,
    notUseful: r.not_useful === true,
    attemptState: str(r.attempt_state),
  };
}

// ---- persistence -----------------------------------------------------------

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-tasks-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return body();
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedWorld(world: World): void {
  const db = getDb();
  for (const a of world.aliases) {
    db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES (?, 'person', ?)`).run(
      entityIdOf(a.alias),
      a.label,
    );
  }
  for (const e of world.events) {
    db.prepare(`INSERT OR IGNORE INTO events (id, ts, kind, text) VALUES (?, ?, 'message', ?)`).run(
      eventIdOf(e.n),
      e.ts,
      e.text,
    );
  }
}

interface PersistedLoop {
  id: string;
  spec: LoopSpec;
  /** The state the loop was BORN with — "born lapsed" is read off this. */
  bornState: string;
  bornReason: string;
}

/** `ent_a1` → `a1`, the me entity → `self`. For readable expectations. */
function aliasOf(entityId: string | null, me: string): string | null {
  if (entityId === null) return null;
  if (entityId === me) return "self";
  return entityId.startsWith("ent_") ? entityId.slice(4) : entityId;
}

function inputOf(spec: LoopSpec, me: string): LoopCodeFactsInput {
  const map = (alias: string | null): string | null =>
    alias === null ? null : alias === "self" ? me : entityIdOf(alias);
  return {
    ownerId: map(spec.owner),
    counterpartyId: map(spec.counterparty),
    origin: spec.origin,
    intent: spec.intent,
    dueUtc: spec.due,
    recurrence: spec.recurrence,
    statedAt: spec.statedAt,
    lastReinforcedAt: spec.lastReinforcedAt,
    resolutionEvidenceEventId:
      spec.resolutionEvidenceEvent === null ? null : eventIdOf(spec.resolutionEvidenceEvent),
    // §14.8 — "not useful" writes state directly, through the SAME UserGesture
    // the done/drop taps use. Teaching happens beside it, in `teachRejections`.
    userGesture: spec.userGesture ?? (spec.notUseful ? "dropped" : null),
  };
}

function persistLoop(spec: LoopSpec, me: string, session: PartySession): PersistedLoop {
  const input = inputOf(spec, me);
  const facts = loopCodeFacts(input, session, NOW);
  const key = loopKey({ ownerId: input.ownerId, counterpartyId: input.counterpartyId, intent: spec.intent });
  const id = loopIdForKey(key);
  getDb()
    .prepare(
      `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, party_pair,
                          horizon, due_utc, recurrence, next_occurrence_utc,
                          resolution_evidence_event_id, state, state_reason, triage, stated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      key,
      spec.intent,
      spec.origin,
      input.ownerId,
      input.counterpartyId,
      facts.partyPair,
      facts.horizon,
      spec.due,
      spec.recurrence,
      facts.nextOccurrenceUtc,
      input.resolutionEvidenceEventId,
      facts.state,
      facts.stateReason,
      facts.triage,
      facts.statedAt ?? spec.statedAt,
    );
  return { id, spec, bornState: facts.state, bornReason: facts.stateReason };
}

// ---- rejection teaches (Q-021..024) ----------------------------------------

/**
 * §14.7.2 — "Rejecting a suggestion writes a user-sourced preference claim."
 * The REAL write path: `writeClaim` with actor `user`, so the row lands in
 * `claim_versions`, the mutation says `user`, and `claims_active` — the roster
 * every future prompt reads — carries it. Nothing is deleted anywhere.
 */
function teachRejections(specs: readonly LoopSpec[], me: string): void {
  for (const spec of specs) {
    if (!spec.notUseful) continue;
    writeClaim(
      {
        kind: "preference",
        tag: "P",
        subjectId: me,
        text: `Prefers not to be reminded about: ${spec.intent}`,
        speakerId: me,
        attribution: "first_person",
        statedAt: NOW,
      },
      { actor: "user", decidedBy: "user", now: NOW },
    );
  }
}

// ---- the frozen-wire flows -------------------------------------------------

interface WireOutcome {
  application: DoneApplication | null;
  assignments: Tr1Assignment[];
  /** Blanket / off-roster verdict lines: reported, never applied (Q-030). */
  unresolvedLines: number;
  accounted: boolean | null;
}

function packedTable(world: World) {
  const entities: PackEntity[] = world.aliases.map((a) => ({ id: entityIdOf(a.alias), name: a.label }));
  const stream = {
    id: "str_c1",
    name: world.aliases[0]?.label ?? "chat",
    kind: "dm",
    participantIds: ["self", ...world.aliases.map((a) => entityIdOf(a.alias))],
  };
  const events: PackEvent[] = world.events.map((e) => ({
    id: eventIdOf(e.n),
    streamId: stream.id,
    at: e.ts,
    speakerId: e.who === "self" ? "self" : entityIdOf(e.who),
    text: e.text,
  }));
  const packed = packPrompt({ tz: "Asia/Kolkata", entities, streams: [stream], events });
  if (!packed.ok) throw new Error(`tasks executor: packer refused (${packed.reason})`);
  return packed;
}

function runDd1(response: string, world: World, loops: readonly PersistedLoop[]): WireOutcome {
  const packed = packedTable(world);
  const dd1Loops: Dd1Loop[] = loops.map((l) => ({
    loopId: l.id,
    intent: l.spec.intent,
    ownerId: l.spec.owner === "self" ? "self" : entityIdOf(l.spec.owner),
    counterpartyId: l.spec.counterparty === "self" ? "self" : l.spec.counterparty ? entityIdOf(l.spec.counterparty) : null,
    due: l.spec.due,
    statedAt: l.spec.statedAt,
  }));
  // Minting order == fixture order, so `t1` on the wire is the fixture's t1.
  buildDd1Prompt(dd1Loops, packed.text, packed.table);
  const answer = parseDd1Response(response, packed.table, dd1Loops);
  const eventTimes = new Map(world.events.map((e) => [eventIdOf(e.n), e.ts]));
  const application = applyDd1Answer(answer, dd1Loops, { eventTimes });

  const db = getDb();
  for (const outcome of application.outcomes) {
    if (outcome.state !== "done" && outcome.state !== "dropped") continue;
    // A close carries the evidence event the model cited and the check upheld,
    // so `deriveLoopStateFromRow` re-derives the same terminal state below.
    db.prepare(
      `UPDATE loops SET state = ?, state_reason = 'resolution_evidence',
              resolution_evidence_event_id = ? WHERE id = ?`,
    ).run(outcome.state, outcome.state === "done" ? outcome.evidenceEventId : null, outcome.loopId);
  }
  for (const q of application.questions) {
    db.prepare(
      `INSERT OR IGNORE INTO questions (id, kind, target_kind, target_id, question, options_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`q_${q.targetId}`, q.kind, q.targetKind, q.targetId, q.question, JSON.stringify(q.options));
  }
  return {
    application,
    assignments: [],
    unresolvedLines: answer.unresolved.length,
    accounted: dd1Accounts(answer).balanced,
  };
}

function runTr1(response: string, loops: readonly PersistedLoop[]): WireOutcome {
  const tr1Loops: Tr1Loop[] = loops.map((l) => ({
    loopId: l.id,
    intent: l.spec.intent,
    origin: l.spec.origin,
    ownerId: l.spec.owner === "self" ? "self" : entityIdOf(l.spec.owner),
    counterpartyId: l.spec.counterparty,
    dueUtc: l.spec.due,
    recurrence: l.spec.recurrence,
    statedAt: l.spec.statedAt,
    lastReinforcedAt: l.spec.lastReinforcedAt,
  }));
  const built = buildTr1Prompt(tr1Loops, undefined, { now: NOW });
  const answer = parseTr1Response(response, built.table, tr1Loops);
  const flip = tr1Assignments(answer, tr1Loops, NOW);
  const db = getDb();
  // Only PER-LOOP assignments exist to apply: a blanket line resolved to no
  // loop, landed in `unresolved`, and never reaches this write (Q-030).
  for (const a of flip.assignments) {
    db.prepare(`UPDATE loops SET triage = ? WHERE id = ?`).run(a.triage, a.loopId);
  }
  return {
    application: null,
    assignments: flip.assignments,
    unresolvedLines: answer.unresolved.length,
    accounted: tr1Accounts(answer).balanced,
  };
}

// ---- reading the rows back -------------------------------------------------

interface LoopRow extends LoopStateRow {
  id: string;
  intent: string | null;
  owner_id: string | null;
  counterparty_id: string | null;
  party_pair: string | null;
  triage: string | null;
  state: string | null;
  state_reason: string | null;
  next_occurrence_utc: string | null;
}

function readRows(): LoopRow[] {
  return getDb()
    .prepare(
      `SELECT id, intent, origin, owner_id, counterparty_id, party_pair, triage, due_utc,
              recurrence, next_occurrence_utc, resolution_evidence_event_id, state,
              state_reason, stated_at
         FROM loops ORDER BY rowid`,
    )
    .all() as LoopRow[];
}

// ---- the executor ----------------------------------------------------------

export const tasksExecutor: Executor = ({ fixture, response }) => {
  const world = worldOf(fixture);
  const specs = fixture.given.open.loops.map((raw, i) => specOf(raw, i));

  return inFreshDb((): Produced => {
    runMigrations();
    const me = ensureMeEntity();
    seedWorld(world);
    const session: PartySession = {
      selfEntityId: me,
      participantEntityIds: world.aliases.map((a) => entityIdOf(a.alias)),
    };

    const persisted = specs.map((spec) => persistLoop(spec, me, session));
    const byId = new Map(persisted.map((p) => [p.id, p]));
    teachRejections(specs, me);

    const trimmed = response.trim();
    const wire: WireOutcome =
      trimmed.startsWith("S|") || trimmed.startsWith("S |")
        ? runDd1(trimmed, world, persisted)
        : trimmed.startsWith("J|") || trimmed.startsWith("J |")
          ? runTr1(trimmed, persisted)
          : { application: null, assignments: [], unresolvedLines: 0, accounted: null };

    // Everything below is measured off the PERSISTED rows, re-derived by the
    // real state function. The user gesture is the one input the schema does
    // not carry a column for, so it rides back in off the spec — the same
    // value `deriveLoopState` consumed on the way in.
    const rows = readRows();
    const rowLike = rows.map((row) => {
      const spec = byId.get(row.id)?.spec;
      return {
        ...row,
        user_gesture: spec?.userGesture ?? (spec?.notUseful ? ("dropped" as const) : null),
        last_reinforced_at: spec?.lastReinforcedAt ?? null,
      };
    });
    const bornOpenViolations = pastDueOpenViolations(rowLike, NOW);

    const rowFacts = rowLike.map((row) => {
      const derived = deriveLoopStateFromRow(row, NOW);
      const spec = byId.get(row.id)?.spec ?? null;
      const born = byId.get(row.id) ?? null;
      const ownerIsSelf = row.owner_id === me;
      return { row, derived, spec, born, ownerIsSelf };
    });

    // The Tasks view, computed by the PRODUCT's own function over the rows.
    const viewInputs = rowFacts.map(({ row }) => ({
      ownerId: row.owner_id,
      counterpartyId: row.counterparty_id,
      origin: row.origin ?? null,
      intent: row.intent,
      dueUtc: row.due_utc ?? null,
      recurrence: row.recurrence ?? null,
      statedAt: row.stated_at ?? null,
      lastReinforcedAt: row.last_reinforced_at ?? null,
      resolutionEvidenceEventId: row.resolution_evidence_event_id ?? null,
      userGesture: row.user_gesture ?? null,
      id: row.id,
    }));
    const taskRows = tasksFrom(viewInputs, session, NOW);
    const taskIds = new Set(taskRows.map((r) => r.loop.id));
    const nonSelfInView = nonSelfLoopsInTasks(taskRows);

    const tOf = (id: string): string => byId.get(id)?.spec.t ?? id;
    const tasks = taskRows.map((r) => ({
      t: tOf(r.loop.id),
      intent: r.loop.intent,
      owner: aliasOf(r.loop.ownerId ?? null, me),
      origin: r.loop.origin ?? null,
      state: r.facts.state,
    }));
    // §14.7.1 — TWO lists, different verbs. Split of the SAME task set, so a
    // loop in both (interleaving) would surface as an unexpected extra.
    const explicit = tasks.filter((t) => t.origin === "explicit").map((t) => ({ ...t, verb: EXPLICIT_VERB }));
    const implicit = tasks.filter((t) => t.origin === "implicit").map((t) => ({ ...t, verb: IMPLICIT_VERB }));
    // §14.7.5 — others' loops are context on that person, never a to-do.
    const waiting = rowFacts
      .filter((r) => !r.ownerIsSelf && isTaskState(r.derived.state))
      .map((r) => ({ t: tOf(r.row.id), intent: r.row.intent, owner: aliasOf(r.row.owner_id, me) }));
    const loopsOut = rowFacts.map((r) => ({
      t: tOf(r.row.id),
      state: r.row.state,
      state_reason: r.row.state_reason,
      retained: true,
    }));
    // §14.7.4 — lapsed says why, and "born lapsed" is read off the state the
    // loop was BORN with: it entered the DB already lapsed, honest backfill.
    const lapsed = rowFacts
      .filter((r) => r.row.state === "lapsed")
      .map((r) => ({
        t: tOf(r.row.id),
        state: "lapsed",
        reason: r.born?.bornState === "lapsed" ? "born lapsed" : "lapsed",
      }));
    const claims = activeClaims().map((c) => ({
      kind: c.kind,
      subject: aliasOf(c.subjectId, me),
      decided_by: c.decidedBy,
      text: c.text,
    }));
    const questionRows = getDb()
      .prepare(`SELECT kind, target_id, question, options_json FROM questions ORDER BY rowid`)
      .all() as { kind: string; target_id: string; question: string; options_json: string }[];
    const questions = questionRows.map((q) => ({
      t: tOf(q.target_id),
      kind: q.kind,
      question: q.question,
      options: (JSON.parse(q.options_json) as string[]).length,
    }));

    // Q-028 — the state that does not exist, refused by the REAL checker. The
    // attempt never touches a row; the refusal is the product behaving.
    const attempts = persisted
      .filter((p) => p.spec.attemptState !== null)
      .map((p) => ({ loopId: p.id, state: p.spec.attemptState as DoneOutcome["state"] }));
    const refusals = doneStateViolations(attempts).map((v) => ({
      t: tOf(v.loopId),
      state: v.state,
      rule: v.rule,
    }));
    const abolishedRows = rowFacts.filter((r) => ABOLISHED_STATES.includes(r.row.state ?? "")).length;

    // Q-030 — the approval queue is per-loop rows, each with its own class.
    const approvals = wire.assignments
      .filter((a) => a.triage === "approval")
      .map((a) => ({ t: tOf(a.loopId), triage: a.triage, source: a.source }));
    const blanket: never[] = []; // an applied grant with no loop cannot exist

    const gates: GateObservation[] = [];
    // §14.2's done-detection precision is a rate over the closes a P-DD1 pass
    // makes on a LABELLED population, which no single Q fixture is. The
    // labelled corpus (done-corpus.ts) rides with the first Q case that
    // completes — once per suite, so each close is counted exactly once.
    gates.push(...doneCorpusObservations());
    if (wire.accounted !== null) {
      gates.push({
        gate: "all_model_output_discarded",
        passed: wire.accounted,
        note: wire.accounted ? "every parsed record accounted for" : "a parsed record fell out of the buckets",
      });
    }
    gates.push({
      gate: "party_oo_in_tasks",
      passed: nonSelfInView.length === 0,
      note: `${nonSelfInView.length} task row(s) whose pair carries no s`,
    });
    for (const { row, derived, ownerIsSelf } of rowFacts) {
      gates.push({
        gate: "loops_born_past_due_open",
        passed: !bornOpenViolations.some((v) => v.id === row.id),
        note: `loop ${tOf(row.id)}: state=${row.state} due=${row.due_utc ?? "-"}`,
      });
      gates.push({
        gate: "loops_non_user_owner_tasks",
        passed: ownerIsSelf || !taskIds.has(row.id),
        note: `loop ${tOf(row.id)}: owner=${aliasOf(row.owner_id, me) ?? "-"} state=${row.state}`,
      });
      if (row.state === "lapsed" || row.state === "done" || row.state === "dropped") {
        gates.push({ gate: "loops_done_retained", passed: true, note: `loop ${tOf(row.id)} retained in state ${row.state}` });
      }
      if (derived.dueInPast && derived.nextOccurrenceUtc === null) {
        gates.push({
          gate: "loops_past_due_not_task",
          passed: !taskIds.has(row.id),
          note: `loop ${tOf(row.id)}: past due, no live recurrence`,
        });
      }
      if (derived.dueInPast && derived.nextOccurrenceUtc !== null) {
        gates.push({ gate: "loops_recurring_live", passed: derived.state === "open", note: `loop ${tOf(row.id)}: next=${derived.nextOccurrenceUtc}` });
      }
    }

    return {
      output: { tasks, explicit, implicit, waiting, loops: loopsOut, lapsed, claims, questions, refusals, approvals, blanket },
      state: {
        tasks: tasks.length,
        explicit: explicit.length,
        implicit: implicit.length,
        lists_disjoint: explicit.length + implicit.length === tasks.length,
        waiting: waiting.length,
        rows: rows.length,
        states: rowFacts.map((r) => r.row.state),
        claims: claims.length,
        questions: questions.length,
        abolished_state_rows: abolishedRows,
        refusals: refusals.length,
        blanket_applied: blanket.length,
        unresolved_lines: wire.unresolvedLines,
        non_self_in_tasks: nonSelfInView.length,
        past_due_open_violations: bornOpenViolations.length,
      },
      metrics: {
        tasks: tasks.length,
        rows: rows.length,
        past_due_open_violations: bornOpenViolations.length,
        non_self_in_tasks: nonSelfInView.length,
        abolished_state_rows: abolishedRows,
      },
      gates,
    };
  });
};
