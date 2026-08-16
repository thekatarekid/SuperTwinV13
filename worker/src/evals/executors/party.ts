// ===========================================================================
// [CODE] Category O executor — the real party model (worker/src/entities/party).
//
// O is `[CODE]` end to end: the pair is derived from roles and never asked of
// a model, so `frozen_response` is a scenario script rather than a verdict and
// the executor is the product. Nothing below re-derives a role, a pair, a
// promotion verdict or a task admission — every value comes back out of
// `entities/party.ts`.
//
// The world comes from the fixture's `given`: each stream's `participants`
// list IS the session, and an alias maps to a minted entity id (`self` ->
// `ent_self`, `a1` -> `ent_a1`) so nothing is ever keyed by a name string.
//
// Scenario records, one per line, `tag|field=value|…`:
//
//   roles|c=c2|of=self,a1,a5           every alias's role in that session
//   claim|c=c1|speaker=self|subject=a1 [|to=a3]   the addressee is carried but
//                                                 never reaches the derivation
//   loop|c=c1|owner=self|counterparty=a1
//   arc|c=c2|loops=a2>a3,a1>a5         owner>counterparty, comma separated
//   tasks|c=c2|loops=self>a1,a2>a3     what may and may not reach the list
//   reject|c=c1|speaker=a1|subject=self    the model text follows `#MODEL`
//   store|c=c1|key=k1|speaker=a2|subject=a1|text=…   a real claim_versions row
//   query|pair=ot|speaker=a2|subject=a1              run the real filter on it
//
// `store`/`query` open a real temp SQLite database with real migrations, so
// "party_pair is queryable" is proven against the schema rather than against a
// list in memory. Every other record is pure and opens nothing.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import {
  claimPartyPair,
  isPartyFieldName,
  loopIsTaskEligible,
  loopPartyPair,
  partyClaimFilter,
  rejectModelParty,
  roleOf,
  rolesOf,
  threadPartyVerdict,
  type PartyPair,
  type PartySession,
} from "../../entities/party.js";
import { TAG_SPECS } from "../../wire/index.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, Produced } from "../runner.js";

/** The line that separates the scenario from the frozen model answer. */
export const MODEL_SEPARATOR = "#MODEL";

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

export function splitScenario(text: string): { scenario: ScenarioLine[]; model: string } {
  const lines = (typeof text === "string" ? text : "").split("\n");
  const at = lines.findIndex((l) => l.trim() === MODEL_SEPARATOR);
  const head = at === -1 ? lines : lines.slice(0, at);
  const model = at === -1 ? "" : lines.slice(at + 1).join("\n");
  const scenario: ScenarioLine[] = [];
  for (const raw of head) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`party scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    scenario.push({ tag, fields });
  }
  return { scenario, model };
}

// ---- the world -------------------------------------------------------------

/** `self` -> `ent_self`, `a1` -> `ent_a1`. Never a name string. */
export function entityIdOf(alias: string): string {
  return `ent_${alias}`;
}

interface World {
  /** Stream alias -> the session that stream is. */
  sessions: Map<string, PartySession>;
  /** Every alias the fixture names, in roster order, self first. */
  aliases: string[];
  labels: Map<string, string>;
  single: string | null;
}

function buildWorld(fixture: Fixture): World {
  const labels = new Map<string, string>([["self", "Me"]]);
  for (const entry of fixture.given.roster) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    labels.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  const aliases = ["self", ...[...labels.keys()].filter((a) => a !== "self")];

  const sessions = new Map<string, PartySession>();
  for (const stream of fixture.given.streams) {
    sessions.set(stream.alias, {
      selfEntityId: entityIdOf("self"),
      participantEntityIds: stream.participants.map(entityIdOf),
    });
  }
  const streamAliases = [...sessions.keys()];
  return { sessions, aliases, labels, single: streamAliases.length === 1 ? streamAliases[0]! : null };
}

function sessionOf(world: World, fields: Record<string, string>): PartySession {
  const alias = fields.c ?? world.single;
  if (!alias) throw new Error("party scenario: a record names no stream and there is more than one");
  const session = world.sessions.get(alias);
  if (!session) throw new Error(`party scenario: no stream aliased ${JSON.stringify(alias)}`);
  return session;
}

function required(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined || value === "") {
    throw new Error(`party scenario: missing ${key}`);
  }
  return value;
}

/** `self>a1,a2>a3` -> owner/counterparty alias pairs. */
function parseLoopList(raw: string): { owner: string; counterparty: string }[] {
  const out: { owner: string; counterparty: string }[] = [];
  for (const item of raw.split(",")) {
    const text = item.trim();
    if (text === "") continue;
    const at = text.indexOf(">");
    if (at === -1) throw new Error(`party scenario: loop ${JSON.stringify(text)} is not owner>counterparty`);
    out.push({ owner: text.slice(0, at).trim(), counterparty: text.slice(at + 1).trim() });
  }
  return out;
}

// ---- the run ---------------------------------------------------------------

interface Run {
  output: Record<string, unknown>;
  state: Record<string, unknown>;
  metrics: Record<string, number>;
  db: DbHandle | null;
}

interface DbHandle {
  dir: string;
  previous: string | undefined;
}

function openDb(run: Run): void {
  if (run.db) return;
  const dir = mkdtempSync(join(tmpdir(), "st-eval-party-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  run.db = { dir, previous };
  runMigrations();
}

function closeRunDb(run: Run): void {
  if (!run.db) return;
  closeDb();
  if (run.db.previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
  else process.env.SUPERTWIN_DB_PATH = run.db.previous;
  rmSync(run.db.dir, { recursive: true, force: true });
  run.db = null;
}

function ensureEntity(alias: string, label: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO entities (id, type, canonical, provisional) VALUES (?, 'person', ?, 0)`)
    .run(entityIdOf(alias), label);
}

function runScenario(fixture: Fixture, response: string, run: Run): void {
  const world = buildWorld(fixture);
  const { scenario, model } = splitScenario(response);
  const { output, state } = run;
  const pairs: (PartyPair | null)[] = [];

  for (const { tag, fields } of scenario) {
    switch (tag) {
      // ---- O-037: every participant is `o`, addressee or not.
      case "roles": {
        const session = sessionOf(world, fields);
        const asked = (fields.of ?? world.aliases.join(",")).split(",").map((a) => a.trim()).filter(Boolean);
        const byId = rolesOf(asked.map(entityIdOf), session);
        const byAlias: Record<string, string> = {};
        for (const alias of asked) byAlias[alias] = byId[entityIdOf(alias)] ?? roleOf(entityIdOf(alias), session);
        state.roles = byAlias;
        state.participants = Object.values(byAlias).filter((r) => r === "o").length;
        break;
      }

      // ---- O-001…O-027: claim.party_pair = role(speaker) ‖ role(subject).
      case "claim": {
        const session = sessionOf(world, fields);
        const speaker = required(fields, "speaker");
        const subject = required(fields, "subject");
        const pair = claimPartyPair(
          { speakerId: entityIdOf(speaker), subjectId: entityIdOf(subject) },
          session,
        );
        pairs.push(pair);
        state.party_pair = pair;
        state.speaker_role = roleOf(entityIdOf(speaker), session);
        state.subject_role = roleOf(entityIdOf(subject), session);
        state.derived_by = "code";
        if (fields.to !== undefined) {
          // The addressee is recorded ALONGSIDE the pair and takes no part in
          // it — `claimPartyPair` has no parameter it could arrive through.
          state.addressee_id = entityIdOf(fields.to);
          state.addressee_role = roleOf(entityIdOf(fields.to), session);
          state.addressee_in_pair = false;
        }
        pushRow(output, "claims", { speaker, subject, party_pair: pair });
        break;
      }

      // ---- O-028…O-036: loop.party_pair = role(owner) ‖ role(counterparty).
      case "loop": {
        const session = sessionOf(world, fields);
        const owner = required(fields, "owner");
        const counterparty = required(fields, "counterparty");
        const pair = loopPartyPair(
          { ownerId: entityIdOf(owner), counterpartyId: entityIdOf(counterparty) },
          session,
        );
        pairs.push(pair);
        state.party_pair = pair;
        state.owner_role = roleOf(entityIdOf(owner), session);
        state.counterparty_role = roleOf(entityIdOf(counterparty), session);
        state.derived_by = "code";
        pushRow(output, "loops", { owner, counterparty, party_pair: pair });
        break;
      }

      // ---- O-039, O-040: a thread with no `s` is not your space.
      case "arc": {
        const session = sessionOf(world, fields);
        const loops = parseLoopList(required(fields, "loops")).map((l) => ({
          ownerId: entityIdOf(l.owner),
          counterpartyId: entityIdOf(l.counterparty),
        }));
        const verdict = threadPartyVerdict({ loops }, session);
        state.pairs = verdict.pairs;
        state.involves_self = verdict.involvesSelf;
        state.promotion_eligible = verdict.promotionEligible;
        state.promotion_reason = verdict.reason;
        state.lives_on = verdict.involvesSelf ? "space" : "people_record";
        if (verdict.promotionEligible) pushRow(output, "spaces", { promoted: true });
        break;
      }

      // ---- O-041…O-044: `oo` is someone else's business.
      case "tasks": {
        const session = sessionOf(world, fields);
        for (const { owner, counterparty } of parseLoopList(required(fields, "loops"))) {
          const pair = loopPartyPair(
            { ownerId: entityIdOf(owner), counterpartyId: entityIdOf(counterparty) },
            session,
          );
          const row = { owner, counterparty, party_pair: pair };
          pushRow(output, loopIsTaskEligible(pair) ? "tasks" : "not_tasks", row);
        }
        state.tasks = (output.tasks as unknown[] | undefined)?.length ?? 0;
        state.excluded = (output.not_tasks as unknown[] | undefined)?.length ?? 0;
        state.task_pairs = ((output.tasks as { party_pair: string }[] | undefined) ?? []).map(
          (t) => t.party_pair,
        );
        break;
      }

      // ---- O-038: never on the wire, never asked of a model.
      case "reject": {
        const session = sessionOf(world, fields);
        const verdict = rejectModelParty(model);
        state.rejected = !verdict.ok;
        state.party_emissions = verdict.emissions.length;
        state.emitted_fields = verdict.emissions.map((e) => e.field);
        // The model's bytes come back untouched: rejection is a verdict, not
        // an edit (§5.8.1).
        state.quoted_verbatim = verdict.emissions.every((e) => model.includes(e.raw));
        // …and the wire has no field it could have arrived in.
        state.wire_party_fields = wirePartyFields().length;
        if (fields.speaker !== undefined && fields.subject !== undefined) {
          state.party_pair = claimPartyPair(
            { speakerId: entityIdOf(fields.speaker), subjectId: entityIdOf(fields.subject) },
            session,
          );
          state.derived_by = "code";
        }
        for (const emission of verdict.emissions) {
          pushRow(output, "rejected", { field: emission.field, value: emission.value });
        }
        break;
      }

      // ---- O-045: a real row, with the pair the code derived on it.
      case "store": {
        const session = sessionOf(world, fields);
        openDb(run);
        const speaker = required(fields, "speaker");
        const subject = required(fields, "subject");
        ensureEntity(speaker, world.labels.get(speaker) ?? speaker);
        ensureEntity(subject, world.labels.get(subject) ?? subject);
        const pair = claimPartyPair(
          { speakerId: entityIdOf(speaker), subjectId: entityIdOf(subject) },
          session,
        );
        getDb()
          .prepare(
            `INSERT INTO claim_versions
               (id, claim_key, kind, subject_id, predicate, text, speaker_id, attribution,
                party_pair, confidence, stated_at, decided_by)
             VALUES (?, ?, 'fact', ?, 'said', ?, ?, ?, ?, 0.9, ?, 'code')`,
          )
          .run(
            required(fields, "key"),
            required(fields, "key"),
            entityIdOf(subject),
            fields.text ?? "",
            entityIdOf(speaker),
            fields.attr ?? "about_other",
            pair,
            fields.at ?? "2026-08-12T21:10:00+05:30",
          );
        break;
      }

      case "query": {
        openDb(run);
        const filter = partyClaimFilter({
          pair: fields.pair,
          speakerId: fields.speaker ? entityIdOf(fields.speaker) : null,
          subjectId: fields.subject ? entityIdOf(fields.subject) : null,
        });
        const rows = getDb().prepare(filter.sql).all(...filter.params) as {
          claim_key: string;
          party_pair: string;
        }[];
        state.matched = rows.map((r) => r.claim_key);
        state.matched_pairs = [...new Set(rows.map((r) => r.party_pair))];
        state.filtered_on = ["party_pair", "speaker_id", "subject_id"].filter((c) =>
          filter.where.includes(c),
        );
        for (const row of rows) pushRow(run.output, "matches", { claim: row.claim_key });
        break;
      }

      default:
        throw new Error(`party scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  if (pairs.length > 1) state.derived_pairs = pairs;
}

function pushRow(output: Record<string, unknown>, bucket: string, row: unknown): void {
  const list = (output[bucket] as unknown[] | undefined) ?? [];
  list.push(row);
  output[bucket] = list;
}

/** Every field the STW-2 tag table declares that is a party field. Must be none. */
export function wirePartyFields(): string[] {
  const found: string[] = [];
  for (const specs of Object.values(TAG_SPECS)) {
    for (const spec of specs) {
      for (const field of spec.fields) if (isPartyFieldName(field.name)) found.push(field.name);
    }
  }
  return found;
}

export const partyExecutor: Executor = ({ fixture, response }): Produced => {
  const run: Run = { output: {}, state: {}, metrics: {}, db: null };
  try {
    runScenario(fixture, response, run);
  } finally {
    closeRunDb(run);
  }
  return { output: run.output, state: run.state, metrics: run.metrics };
};
