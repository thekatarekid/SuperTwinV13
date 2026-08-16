// ===========================================================================
// [CODE] The world the entity-graph categories are posed in (build item 1.5).
//
// Categories G (identity), H (mentions) and I (edges) all need the same three
// things: a temp DB with real migrations, a roster and some events built out of
// the fixture's `given`, and a way to say "now bind this" or "now the model
// answered THIS". So they share one world and differ only in what they report.
//
// Two inputs drive a case, separated by a `#WIRE` line in `frozen_response`:
//
//   ABOVE  a [CODE] script — the binds, metadata edges, merges and splits that
//          happen with no model in the room at all.
//   BELOW  a frozen P-EP1 (or P-AG1) answer in STW-2, parsed by the REAL wire
//          parser and applied through the REAL entity API. Nothing here
//          re-implements a bind, an edge write or a merge.
//
// Every entity carries a LABEL (`a1`, `k1`, `me`, whatever the script named
// it). Expectations are written against labels because ids are minted at
// random — which is the point of minting them.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../../db/connection.js";
import {
  auditMetadataEdges,
  auditResolutionRecall,
  auditResolutions,
  type MetadataMembership,
} from "../../entities/audit.js";
import { ensureMeEntity, meEntityId, mentionsOfEvent, type RosterEntry } from "../../entities/binding.js";
import { edgeEvidence, listEdges, type EdgeRow } from "../../entities/edges.js";
import { isNegativePair, readDecision } from "../../entities/merge.js";
import { createEntity, isEntityType, listEntities, resolveEntityId, type EntityType } from "../../entities/registry.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { identitiesOf, type IdentityKind } from "../../entities/identities.js";
import { ENUMS } from "../../wire/tolerance.js";
import type { Fixture } from "../fixtures.js";
import type { GateObservation, Produced } from "../runner.js";

const SOURCE = "whatsapp";
const SELF_JID = "919999900000@s.whatsapp.net";

export interface ScriptLine {
  tag: string;
  fields: Record<string, string>;
}

export interface BindRecord {
  as: string;
  rung: string;
  decided_by: string;
  confidence: number;
  entity: string;
}

export class World {
  /** label → entity id. */
  readonly ids = new Map<string, string>();
  /** entity id → label, for reporting. */
  readonly labels = new Map<string, string>();
  /** fixture event number → event id. */
  readonly events = new Map<number, string>();
  readonly binds: BindRecord[] = [];
  readonly roster: RosterEntry[] = [];
  /**
   * Every member a SOURCE named in a participant/attendee list, as the real
   * binder resolved it. The expectation behind `entities_metadata_edges`: the
   * list came from the source, so the edge is owed whatever any model says.
   */
  readonly memberships: MetadataMembership[] = [];
  modelCalls = 0;
  merged: boolean | null = null;
  refuseReason = "";
  routedTo = "none";
  similarityRung: boolean | null = null;
  splitDone = false;
  lastPair: [string, string] | null = null;
  lastWinner: string | null = null;
  value: number | null = null;
  unlabeled = 0;
  otherLines = 0;
  lastBoundTo = "";

  label(entityId: string, name?: string): string {
    const known = this.labels.get(entityId);
    if (known) return known;
    this.unlabeled += 1;
    const chosen = name ?? `x${this.unlabeled}`;
    this.labels.set(entityId, chosen);
    this.ids.set(chosen, entityId);
    return chosen;
  }

  /** A label, an entity id, or `self`/`me`. Throws rather than guesses. */
  entity(ref: string): string {
    const key = ref.trim();
    if (key === "self" || key === "me") {
      const me = meEntityId();
      if (me) return me;
    }
    const direct = this.ids.get(key);
    if (direct) return resolveEntityId(direct) ?? direct;
    if (key.startsWith("ent_")) return key;
    throw new Error(`entity world: no entity labelled ${JSON.stringify(key)}`);
  }

  /**
   * The id the label was FILED under, tombstone and all. A split names the
   * tombstone, so resolving it first would hand `splitEntity` the survivor and
   * quietly make the undo a no-op.
   */
  rawEntity(ref: string): string {
    const key = ref.trim();
    const direct = this.ids.get(key);
    if (direct) return direct;
    return this.entity(key);
  }

  nameOf(entityId: string): string {
    const resolved = resolveEntityId(entityId) ?? entityId;
    return this.labels.get(resolved) ?? this.labels.get(entityId) ?? resolved;
  }

  event(n: number): string {
    const id = this.events.get(n);
    if (!id) throw new Error(`entity world: no event ${n} in this fixture`);
    return id;
  }
}

// ---- parsing ---------------------------------------------------------------

export function splitScript(text: string): { script: ScriptLine[]; wire: string; post: ScriptLine[] } {
  const lines = (typeof text === "string" ? text : "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "#WIRE");
  const postAt = lines.findIndex((l) => l.trim() === "#POST");
  const wireEnd = postAt === -1 ? lines.length : postAt;
  const head = lines.slice(0, at === -1 ? wireEnd : at);
  const wire = at === -1 ? "" : lines.slice(at + 1, wireEnd).join("\n");
  const post = postAt === -1 ? [] : parseScript(lines.slice(postAt + 1));
  return { script: parseScript(head), wire, post };
}

/** One `tag|k=v|…` line per action. Blank lines and `#` comments are skipped. */
function parseScript(lines: readonly string[]): ScriptLine[] {
  const script: ScriptLine[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`entity script: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    script.push({ tag, fields });
  }
  return script;
}

export function req(f: Record<string, string>, key: string, tag: string): string {
  const v = f[key];
  if (v === undefined) throw new Error(`entity script: ${tag} needs ${key}=`);
  return v;
}

export function num(f: Record<string, string>, key: string, fallback: number): number {
  const raw = f[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`entity script: ${key}=${raw} is not a number`);
  return n;
}

/** `a1=jid:919…@s.whatsapp.net` or `a1=email:x@y.com:organizer`. */
export function parseMembers(raw: string): { label: string; kind: IdentityKind; value: string; role?: string }[] {
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((entry) => {
    const eq = entry.indexOf("=");
    if (eq === -1) throw new Error(`entity script: member ${JSON.stringify(entry)} needs a label=`);
    const label = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1).trim();
    const colon = rest.indexOf(":");
    if (colon === -1) throw new Error(`entity script: member ${JSON.stringify(entry)} needs kind:value`);
    const kind = rest.slice(0, colon).trim() as IdentityKind;
    const tail = rest.slice(colon + 1).trim();
    // A trailing `:role` only ever follows an email or a handle, never a jid,
    // so the LAST colon is the role separator when there is more than one.
    const at = tail.lastIndexOf(":");
    if (at > 0 && !tail.slice(at + 1).includes("@") && !/^\d+$/.test(tail.slice(at + 1))) {
      return { label, kind, value: tail.slice(0, at), role: tail.slice(at + 1) };
    }
    return { label, kind, value: tail };
  });
}

/** `a3=Indiranagar [plc]` → label a3, name Indiranagar, type place. */
function parseRosterEntry(entry: string): { label: string; name: string; type: EntityType } {
  const eq = entry.indexOf("=");
  const label = eq === -1 ? entry.trim() : entry.slice(0, eq).trim();
  let name = eq === -1 ? entry.trim() : entry.slice(eq + 1).trim();
  let type: EntityType = "person";
  const bracket = /\[([a-z_]+)\]\s*$/i.exec(name);
  if (bracket) {
    name = name.slice(0, bracket.index).trim();
    const decoded = ENUMS.entity_type.decode(bracket[1]);
    if (!decoded || !isEntityType(decoded.stored)) {
      throw new Error(`entity world: roster entry ${JSON.stringify(entry)} names no known type`);
    }
    type = decoded.stored;
  }
  return { label, name, type };
}

// ---- world construction ----------------------------------------------------

export function buildWorld(fixture: Fixture): World {
  const world = new World();
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });

  for (const entry of fixture.given.roster) {
    if (entry.trim() === "") continue;
    const { label, name, type } = parseRosterEntry(entry);
    if (label === "self") {
      const me = ensureMeEntity();
      world.label(me, "self");
      continue;
    }
    const row = createEntity({ type, canonical: name, provisional: false });
    world.label(row.id, label);
    world.roster.push({ entityId: row.id, label: name });
  }

  const streams = fixture.given.streams.length > 0
    ? fixture.given.streams
    : [{ alias: "c1", name: "c1", kind: "dm", participants: [] }];
  const streamIds = new Map<string, string>();
  for (const s of streams) {
    streamIds.set(
      s.alias,
      upsertStream({ sourceId: SOURCE, sourceExtId: s.alias, name: s.name, kind: s.kind === "group" ? "group" : "dm" }),
    );
  }

  for (const ev of fixture.given.events) {
    const alias = typeof ev.c === "string" && streamIds.has(ev.c) ? ev.c : streams[0].alias;
    const who = ev.who === "self" ? SELF_JID : ev.who;
    const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: who, displayName: ev.who });
    const row = insertEvent({
      externalId: `${alias}/e${ev.n}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId: streamIds.get(alias)!,
      actorId,
      ts: ev.ts,
      kind: "message",
      text: ev.text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    world.events.set(ev.n, row.id);
  }
  return world;
}

// ---- reporting -------------------------------------------------------------

function edgeRecord(world: World, e: EdgeRow): Record<string, unknown> {
  return {
    src: world.nameOf(e.srcEntityId),
    kind: e.kind,
    subtype: e.subtype,
    dst: world.nameOf(e.dstEntityId),
    confidence: e.confidence,
    decided_by: e.decidedBy,
    status: e.status,
    valid_to: e.validTo,
    quotes: edgeEvidence(e.id).map((q) => q.quote),
  };
}

export function snapshot(world: World, fixture: Fixture): Produced {
  const live = listEntities();
  const labels = [...world.labels.keys()];
  const distinct = new Set(labels.map((id) => resolveEntityId(id)).filter((v) => v !== null));

  const edges = listEdges().map((e) => edgeRecord(world, e));
  const mentions: Record<string, unknown>[] = [];
  for (const [n] of [...world.events.entries()].sort((a, b) => a[0] - b[0])) {
    for (const m of mentionsOfEvent(world.event(n))) {
      mentions.push({
        ev: n,
        surface: m.surfaceText,
        entity: m.entityId ? world.nameOf(m.entityId) : null,
        confidence: m.confidence,
        hint: m.entityHint,
        decided_by: m.decidedBy,
      });
    }
  }

  const me = meEntityId();
  const db = getDb();
  const questionsOpen = (db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE status = 'open'`).get() as { n: number }).n;
  const mutations = (db.prepare(`SELECT COUNT(*) AS n FROM mutations`).get() as { n: number }).n;
  const aliasRows = (
    db.prepare(`SELECT COUNT(*) AS n FROM entity_identities WHERE kind = 'alias' AND source_id <> 'system'`).get() as {
      n: number;
    }
  ).n;
  const aliasEvidence = (
    db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE subject_kind = 'identity'`).get() as { n: number }
  ).n;

  const pair = world.lastPair;
  const decision = pair ? readDecision(pair[0], pair[1]) : null;

  const state: Record<string, unknown> = {
    entity_count: live.length,
    person_count: live.filter((e) => e.type === "person").length,
    distinct_entities: distinct.size,
    model_calls: world.modelCalls,
    last_rung: world.binds.at(-1)?.rung ?? "",
    last_decided_by: world.binds.at(-1)?.decided_by ?? "",
    last_confidence: world.binds.at(-1)?.confidence ?? null,
    last_minted: world.binds.at(-1)?.rung === "mint",
    last_bound_to: world.lastBoundTo,
    other_lines: world.otherLines,
    merged: world.merged,
    refuse_reason: world.refuseReason,
    routed_to: world.routedTo,
    similarity_rung: world.similarityRung,
    split: world.splitDone,
    verdict: decision?.verdict ?? "",
    verdict_decided_by: decision?.decidedBy ?? "",
    negative_pair: pair ? isNegativePair(pair[0], pair[1]) : false,
    questions_open: questionsOpen,
    mutations,
    alias_rows: aliasRows,
    alias_evidence: aliasEvidence,
    edges_written: edges.length,
    metadata_edges: edges.filter((e) => e.decided_by === "code:metadata").length,
    mentions_written: mentions.length,
    self_identities: me ? identitiesOf(me).length : 0,
    me_singleton: me !== null && live.filter((e) => e.id === me).length === 1,
    reads_redirect: pair !== null && world.lastWinner !== null && resolveEntityId(pair[1]) === world.lastWinner,
    tombstones: world.lastWinner ? Math.max(0, distinctTombstones(world.lastWinner)) : 0,
    refs_resolved: world.lastWinner ? refsResolved(world.lastWinner) : 0,
    all_binds_have_decider: world.binds.every((b) => b.decided_by !== ""),
    all_binds_have_confidence: world.binds.every((b) => typeof b.confidence === "number"),
  };

  return {
    gates: gateObservations(world),
    output: {
      binds: world.binds,
      entities: live
        .map((e) => ({ as: world.nameOf(e.id), type: e.type, subtype: e.subtype, canonical: e.canonical }))
        .sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0)),
      edges,
      mentions,
      questions: (
        db.prepare(`SELECT target_id, question FROM questions WHERE status = 'open' ORDER BY id`).all() as {
          target_id: string;
          question: string;
        }[]
      ).map((q) => ({ question: q.question })),
    },
    state,
    metrics: {
      value: world.value ?? 0,
      model_calls: world.modelCalls,
      entity_count: live.length,
      fixture_events: fixture.given.events.length,
    },
  };
}

/**
 * The three §14.2 entity rows a case's ASSERTION cannot carry, measured off the
 * graph this case actually built (`entities/audit.ts`):
 *
 *   entities_no_silent_guess   one observation per resolution that committed —
 *                              a merge, an identity, a linked mention, an edge,
 *                              a `same` verdict. A failed observation IS the
 *                              violation the gate counts, so the gate's value is
 *                              literally "how many silent guesses happened".
 *   entities_recall            one per join the graph owed itself: a phone or
 *                              email under two sources, a stored `same` verdict.
 *   entities_metadata_edges    one per member a source named in a participant
 *                              or attendee list.
 *
 * A case with none of these emits nothing, which is right — it measured
 * nothing, and a gate nobody measured stays `no data`.
 */
export function gateObservations(world: World): GateObservation[] {
  const out: GateObservation[] = [];

  // One observation per resolution the audit EXAMINED — clean ones included,
  // so the gate has a denominator and cannot read `no data` merely because
  // nothing went wrong.
  for (const audit of auditResolutions()) {
    out.push({
      gate: "entities_no_silent_guess",
      passed: audit.guess === null,
      ...(audit.guess ? { note: `${audit.subject} ${audit.id}: ${audit.guess.reason}` } : {}),
    });
  }

  for (const opportunity of auditResolutionRecall()) {
    out.push({
      gate: "entities_recall",
      passed: opportunity.recovered,
      note: opportunity.reason,
    });
  }

  for (const check of auditMetadataEdges(world.memberships)) {
    out.push({
      gate: "entities_metadata_edges",
      passed: check.captured,
      note: check.reason,
    });
  }

  return out;
}

function distinctTombstones(winner: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM entities WHERE merged_into = ?`).get(winner) as { n: number }
  ).n;
}

/** Mentions and edges that still land on the survivor after a tombstone merge. */
function refsResolved(winner: string): number {
  const db = getDb();
  const mentionRefs = db.prepare(`SELECT entity_id AS id FROM mentions WHERE entity_id IS NOT NULL`).all() as {
    id: string;
  }[];
  const edgeRefs = db.prepare(`SELECT src_entity_id AS id FROM entity_edges`).all() as { id: string }[];
  return [...mentionRefs, ...edgeRefs].filter((r) => resolveEntityId(r.id) === winner).length;
}

/** Runs one case against a throwaway DB with real migrations. */
export function inEvalDb<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-entities-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return fn();
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

