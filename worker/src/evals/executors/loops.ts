// ===========================================================================
// [CODE] Category N executor — the real loop pipeline (build items 3.1 + 3.2).
//
// N is `[CODE]` end to end: `frozen_response` carries the frozen P-CL1 answer
// (real wire `T` / claim lines), and everything downstream is product code —
// `packPrompt` builds the same prompt-local alias table a live call would,
// `parseCl1Response` reads the answer, `loopCodeFacts` derives the code-written
// half (state, triage, party_pair, next_occurrence, horizon — §11.4), and each
// loop is PERSISTED to a real temp SQLite DB with the real migrations. The
// gates are then measured off the persisted rows, re-derived by
// `deriveLoopStateFromRow` / `pastDueOpenViolations` — never off in-memory
// values the insert could have diverged from.
//
// The two zero-violation gates this file exists to feed:
//
//   loops_born_past_due_open    a past due may read `open` only through a
//                               projected FUTURE occurrence (§11.4)
//   loops_non_user_owner_tasks  task = loop WHERE owner == me AND
//                               state ∈ {open, latent} (§11.3.1)
//
// Nothing here re-implements the state function, the triage default or the
// loop key; nothing lowers a threshold; and per build rule 9 every parsed
// record is accounted for (`extractionAccounts`) — a dropped line fails the
// `all_model_output_discarded` gate.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopCodeFacts, type LoopCodeFacts } from "../../claims/codefacts.js";
import {
  extractionAccounts,
  parseCl1Response,
  type ExtractedClaim,
  type ExtractedLoop,
} from "../../claims/extract.js";
import { loopIdForKey, loopKey } from "../../claims/keys.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { ensureMeEntity } from "../../entities/binding.js";
import type { PartySession } from "../../entities/party.js";
import {
  deriveLoopStateFromRow,
  isTaskState,
  nextOccurrenceUtc,
  pastDueOpenViolations,
  type LoopStateRow,
} from "../../loops/state.js";
import { packPrompt, type PackEntity, type PackEvent, type PackInput } from "../../wire/pack.js";
import type { Fixture, FixtureEvent } from "../fixtures.js";
import type { Executor, GateObservation, Produced } from "../runner.js";

/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = "2026-08-15T12:00:00.000Z";

// ---- the fixture's world ---------------------------------------------------

interface World {
  /** roster alias → display label, in roster order. `self` excluded. */
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

/**
 * The same packer a live P-CL1 call uses builds the alias table, so `a1` and
 * event `1` mean in this eval exactly what they mean on the real wire.
 */
function tableFor(fixture: Fixture, world: World) {
  const entities: PackEntity[] = world.aliases.map((a) => ({ id: entityIdOf(a.alias), name: a.label }));
  const streams =
    fixture.given.streams.length > 0
      ? fixture.given.streams.map((s) => ({
          id: `str_${s.alias}`,
          name: s.name,
          kind: s.kind,
          participantIds: s.participants.map((p) => (p === "self" ? "self" : entityIdOf(p))),
        }))
      : [
          {
            id: "str_c1",
            name: world.aliases[0]?.label ?? "chat",
            kind: "dm",
            participantIds: ["self", ...world.aliases.map((a) => entityIdOf(a.alias))],
          },
        ];
  const events: PackEvent[] = world.events.map((e) => ({
    id: eventIdOf(e.n),
    streamId: streams[0].id,
    at: e.ts,
    speakerId: e.who === "self" ? "self" : entityIdOf(e.who),
    text: e.text,
  }));
  const input: PackInput = { tz: "Asia/Kolkata", entities, streams, events };
  const packed = packPrompt(input);
  if (!packed.ok) throw new Error(`loops executor: packer refused (${packed.reason})`);
  return packed.table;
}

// ---- persistence -----------------------------------------------------------

interface PersistedLoop {
  id: string;
  facts: LoopCodeFacts;
  loop: ExtractedLoop;
}

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-loops-"));
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

/** `ent_a1` → `a1`, the me entity → `self`. For readable expectations. */
function aliasOf(entityId: string | null, me: string): string | null {
  if (entityId === null) return null;
  if (entityId === me) return "self";
  return entityId.startsWith("ent_") ? entityId.slice(4) : entityId;
}

function persistLoop(loop: ExtractedLoop, world: World, me: string, session: PartySession): PersistedLoop {
  // The stating event: `speaker_id` from its actor, `stated_at` from its ts —
  // never from ingest time (§11.4, build rule 8).
  const evidenceId = loop.eventIds[0] ?? null;
  const stating = world.events.find((e) => evidenceId !== null && eventIdOf(e.n) === evidenceId) ?? null;
  const event =
    stating === null
      ? null
      : { actorEntityId: stating.who === "self" ? me : entityIdOf(stating.who), ts: stating.ts };

  const ownerId = loop.ownerId === "self" ? me : loop.ownerId;
  const counterpartyId = loop.counterpartyId === "self" ? me : loop.counterpartyId;

  const facts = loopCodeFacts(
    {
      ownerId,
      counterpartyId,
      origin: loop.origin,
      intent: loop.intent,
      dueUtc: loop.due,
      recurrence: loop.recurrence,
      event,
    },
    session,
    NOW,
  );

  const key = loopKey({
    ownerId,
    ownerHint: loop.ownerHint,
    counterpartyId,
    counterpartyHint: loop.counterpartyHint,
    intent: loop.intent,
  });
  const id = loopIdForKey(key);

  getDb()
    .prepare(
      `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, party_pair,
                          direction, stake, horizon, due_utc, recurrence, next_occurrence_utc,
                          state, state_reason, triage, confidence, stated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      key,
      loop.intent,
      loop.origin,
      ownerId,
      counterpartyId,
      facts.partyPair,
      loop.direction,
      loop.stake,
      facts.horizon,
      loop.due,
      loop.recurrence,
      facts.nextOccurrenceUtc,
      facts.state,
      facts.stateReason,
      facts.triage,
      loop.confidence,
      facts.statedAt,
    );

  return { id, facts, loop };
}

// ---- reading the rows back -------------------------------------------------

interface LoopRow extends LoopStateRow {
  id: string;
  intent: string | null;
  direction: string | null;
  owner_id: string | null;
  counterparty_id: string | null;
  party_pair: string | null;
  triage: string | null;
  state: string | null;
  state_reason: string | null;
  next_occurrence_utc: string | null;
  horizon: string | null;
}

function readRows(): LoopRow[] {
  return getDb()
    .prepare(
      `SELECT id, intent, origin, direction, owner_id, counterparty_id, party_pair, triage,
              due_utc, recurrence, next_occurrence_utc, state, state_reason, horizon, stated_at
         FROM loops ORDER BY rowid`,
    )
    .all() as LoopRow[];
}

// ---- the executor ----------------------------------------------------------

export const loopsExecutor: Executor = ({ fixture, response }) => {
  const world = worldOf(fixture);
  const table = tableFor(fixture, world);
  const answer = parseCl1Response(response, table);
  const accounted = extractionAccounts(answer);

  return inFreshDb((): Produced => {
    runMigrations();
    const me = ensureMeEntity();
    seedWorld(world);
    const session: PartySession = {
      selfEntityId: me,
      participantEntityIds: world.aliases.map((a) => entityIdOf(a.alias)),
    };

    for (const loop of answer.loops) persistLoop(loop, world, me, session);

    // Everything below is measured off the PERSISTED rows, re-derived by the
    // real state function — never off the values the insert happened to write.
    const rows = readRows();
    const bornOpenViolations = pastDueOpenViolations(rows, NOW);
    const rowFacts = rows.map((row) => {
      const derived = deriveLoopStateFromRow(row, NOW);
      const ownerIsSelf = row.owner_id === me;
      const isTask = ownerIsSelf && isTaskState(row.state);
      return { row, derived, ownerIsSelf, isTask };
    });
    const tasks = rowFacts.filter((r) => r.isTask);

    const gates: GateObservation[] = [
      {
        gate: "all_model_output_discarded",
        passed: accounted,
        note: accounted ? "every parsed record accounted for" : "a parsed record fell out of the buckets",
      },
    ];
    for (const { row, derived, ownerIsSelf, isTask } of rowFacts) {
      // §11.4 — a past due is `open` only through a projected future occurrence.
      gates.push({
        gate: "loops_born_past_due_open",
        passed: !bornOpenViolations.some((v) => v.id === row.id),
        note: `loop ${row.id}: state=${row.state} due=${row.due_utc ?? "-"}`,
      });
      // §11.3.1 — a loop owned by anyone but me is never in my task list.
      gates.push({
        gate: "loops_non_user_owner_tasks",
        passed: ownerIsSelf || !isTask,
        note: `loop ${row.id}: owner=${aliasOf(row.owner_id, me) ?? "-"} state=${row.state}`,
      });
      // Terminal loops are retained rows, not skipped extractions (§11.4.4).
      if (row.state === "lapsed" || row.state === "done" || row.state === "dropped") {
        gates.push({
          gate: "loops_done_retained",
          passed: true,
          note: `loop ${row.id} retained in state ${row.state}`,
        });
      }
      // Past due, no projected future occurrence → never a task (§12.8).
      if (derived.dueInPast && derived.nextOccurrenceUtc === null) {
        gates.push({
          gate: "loops_past_due_not_task",
          passed: !isTask,
          note: `loop ${row.id}: past due, no live recurrence`,
        });
      }
      // A recurring obligation with a future occurrence is live, whatever the
      // age of the evidence (§11.4.1).
      if (derived.dueInPast && derived.nextOccurrenceUtc !== null) {
        gates.push({
          gate: "loops_recurring_live",
          passed: row.state === "open",
          note: `loop ${row.id}: next=${derived.nextOccurrenceUtc}`,
        });
      }
    }

    const outLoops = rowFacts.map(({ row, isTask }) => ({
      intent: row.intent,
      owner: aliasOf(row.owner_id, me),
      counterparty: aliasOf(row.counterparty_id, me),
      origin: row.origin ?? null,
      direction: row.direction ?? null,
      party_pair: row.party_pair,
      state: row.state,
      state_reason: row.state_reason,
      triage: row.triage,
      due: row.due_utc ?? null,
      recurrence: row.recurrence ?? null,
      next_occurrence: row.next_occurrence_utc,
      horizon: row.horizon,
      is_task: isTask,
    }));
    const outClaims = answer.claims.map((c: ExtractedClaim) => ({
      tag: c.tag,
      kind: c.kind,
      subject: c.subjectId === "self" ? "self" : aliasOf(c.subjectId, me),
      text: c.text,
    }));

    return {
      output: { loops: outLoops, claims: outClaims },
      state: {
        loops: rows.length,
        rows: rows.length,
        claims: answer.claims.length,
        claim_kinds: answer.claims.map((c) => c.kind).sort(),
        states: rowFacts.map((r) => r.row.state),
        state_reasons: rowFacts.map((r) => r.row.state_reason),
        triages: rowFacts.map((r) => r.row.triage),
        origins: rowFacts.map((r) => r.row.origin ?? null),
        owners: rowFacts.map((r) => aliasOf(r.row.owner_id, me)),
        dues: rowFacts.map((r) => r.row.due_utc ?? null),
        next_occurrences: rowFacts.map((r) => r.row.next_occurrence_utc),
        tasks: tasks.length,
        auto_count: rowFacts.filter((r) => r.row.triage === "auto").length,
        past_due_open_violations: bornOpenViolations.length,
        unsupported: answer.unsupported.length,
        accounted,
      },
      metrics: {
        loops: rows.length,
        tasks: tasks.length,
        past_due_open_violations: bornOpenViolations.length,
      },
      gates,
    };
  });
};

/** Exercised by the executor tests: projection agrees with the stored column. */
export function projectedNextOccurrence(row: LoopStateRow, now: string = NOW): string | null {
  return nextOccurrenceUtc(
    { dueUtc: row.dueUtc ?? row.due_utc ?? null, recurrence: row.recurrence ?? null },
    now,
  );
}
