// ===========================================================================
// [CODE] The actions a G/H/I case can take — the [CODE] script above `#WIRE`
// and the frozen model answer below it (build item 1.5).
//
// Split out of `entity-world.ts` so the world (build it, read it back) stays
// separable from the verbs (bind it, merge it, split it, apply what the model
// said). Every verb delegates: there is no decision in this file that
// `entities/` does not make.
// ===========================================================================

import { isCalibUseCase, putCalib, type CalibUseCase } from "../../db/calib.js";
import { getDb } from "../../db/connection.js";
import {
  bindCalendarAttendees,
  bindGroupParticipants,
  bindIdentity,
  bindRosterMention,
  bindSelfIdentity,
  ensureMeEntity,
  recordAliasIdentity,
  recordMention,
} from "../../entities/binding.js";
import { listEdges, supersedeEdge, writeEdge } from "../../entities/edges.js";
import type { IdentityKind } from "../../entities/identities.js";
import {
  compactMerges,
  mergeEntities,
  queueResolution,
  recordDecision,
  splitEntity,
} from "../../entities/merge.js";
import { applyAgentVerdict } from "../../entities/adjudicate.js";
import {
  resolvePair,
  routePair,
  type PairContext,
  type PairResolution,
} from "../../entities/resolve.js";
import { createEntity, isEntityType, type EntityType } from "../../entities/registry.js";
import { parseWire, type WireRecord } from "../../wire/index.js";
import { ENUMS } from "../../wire/tolerance.js";
import type { Fixture } from "../fixtures.js";
import type { Produced } from "../runner.js";
import {
  buildWorld,
  inEvalDb,
  num,
  parseMembers,
  req,
  snapshot,
  splitScript,
  type ScriptLine,
  type World,
} from "./entity-world.js";

const SOURCE = "whatsapp";

// ---- the [CODE] script -----------------------------------------------------

function bindThrough(world: World, f: Record<string, string>, tag: string): string {
  const kind = req(f, "kind", tag) as IdentityKind;
  const type = f.type && isEntityType(f.type) ? (f.type as EntityType) : "person";
  const res = bindIdentity({
    sourceId: f.src ?? SOURCE,
    kind,
    value: req(f, "v", tag),
    type,
    subtype: f.sub ?? null,
    displayName: f.name ?? null,
    seenAt: f.seen ?? null,
  });
  const label = world.label(res.entityId, f.as);
  world.lastBoundTo = label;
  world.binds.push({
    as: f.as ?? label,
    rung: res.rung,
    decided_by: res.decidedBy,
    confidence: res.confidence,
    entity: label,
  });
  return res.entityId;
}

/**
 * Rungs ③–⑤ are `entities/resolve.ts`'s, and this is the only place the eval
 * world touches them — so a G case that passes is the REAL ladder passing,
 * not a second implementation that happens to agree with it (item 1.10).
 */
const ROUTED: Record<PairResolution["outcome"], string> = {
  merged: "bind",
  queued: "queue",
  deferred: "agent",
  different: "different",
  refused: "refused",
};

function recordPair(world: World, res: PairResolution): void {
  world.lastPair = [res.left, res.right];
  world.merged = res.outcome === "merged";
  world.refuseReason = res.refused ?? "";
  world.routedTo = ROUTED[res.outcome];
  if (res.merge?.merged) world.lastWinner = res.merge.winner;
}

/**
 * The fixture states ONE bar — "below bar -> resolution queue". So the band
 * floor is 0: anything under the bind bar is in-band, i.e. a question, which
 * is the conservative reading and the one the eval doc asserts. No threshold
 * is invented here; both numbers come off the fixture line.
 */
function fixtureBars(bar: number): { bind: number; band: number } {
  return { bind: bar, band: 0 };
}

export function runScript(world: World, script: readonly ScriptLine[]): void {
  for (const { tag, fields: f } of script) {
    switch (tag) {
      case "me":
        world.label(ensureMeEntity(), f.as ?? "me");
        break;
      case "self": {
        const me = bindSelfIdentity({
          sourceId: f.src ?? SOURCE,
          kind: req(f, "kind", tag) as IdentityKind,
          value: req(f, "v", tag),
        });
        world.label(me, f.as ?? "me");
        break;
      }
      case "bind":
        bindThrough(world, f, tag);
        break;
      case "group": {
        const members = parseMembers(f.members ?? "");
        const res = bindGroupParticipants({
          sourceId: f.src ?? SOURCE,
          group: { kind: (f.kind ?? "jid") as IdentityKind, value: req(f, "v", tag), displayName: f.name ?? null, subtype: f.sub ?? null },
          participants: members.map((m) => ({ kind: m.kind, value: m.value })),
          seenAt: f.seen ?? null,
        });
        world.label(res.containerEntityId, f.as);
        res.memberEntityIds.forEach((id, i) => world.label(id, members[i]?.label));
        break;
      }
      case "cal": {
        const members = parseMembers(f.att ?? "");
        const res = bindCalendarAttendees({
          sourceId: f.src ?? "calendar",
          occasion: { kind: (f.kind ?? "account_id") as IdentityKind, value: req(f, "v", tag), displayName: f.name ?? null, subtype: f.sub ?? null },
          attendees: members.map((m) => ({ kind: m.kind, value: m.value, role: m.role })),
          seenAt: f.seen ?? null,
        });
        world.label(res.containerEntityId, f.as);
        res.memberEntityIds.forEach((id, i) => world.label(id, members[i]?.label));
        break;
      }
      case "mention": {
        const res = bindRosterMention({
          eventId: world.event(num(f, "ev", 1)),
          surface: req(f, "s", tag),
          roster: world.roster,
          hint: f.hint ?? null,
        });
        world.value = res.mention.confidence;
        break;
      }
      case "ref":
        recordMention({
          eventId: world.event(num(f, "ev", 1)),
          surface: f.s ?? "ref",
          entityId: world.entity(req(f, "e", tag)),
          confidence: 1,
          decidedBy: "code:speaker",
        });
        break;
      case "alias":
        recordAliasIdentity({
          entityId: world.entity(req(f, "e", tag)),
          sourceId: f.src ?? SOURCE,
          alias: req(f, "a", tag),
          eventId: world.event(num(f, "ev", 1)),
          quote: req(f, "q", tag),
        });
        break;
      case "edge":
        writeEdge({
          kind: decodeEdgeKind(req(f, "k", tag)),
          subtype: f.sub ?? null,
          srcEntityId: world.entity(req(f, "src", tag)),
          dstEntityId: world.entity(req(f, "dst", tag)),
          confidence: num(f, "conf", 0.8),
          decidedBy: f.by ?? "llm:p-ep1",
          validFrom: f.from ?? null,
          eventId: f.ev ? world.event(num(f, "ev", 1)) : null,
          quote: f.q ?? null,
        });
        break;
      case "close": {
        const src = world.entity(req(f, "src", tag));
        const dst = world.entity(req(f, "dst", tag));
        const kind = decodeEdgeKind(req(f, "k", tag));
        const open = listEdges({ kind, status: "active" }).find(
          (e) => e.srcEntityId === src && e.dstEntityId === dst,
        );
        if (!open) throw new Error(`entity script: close names no open ${kind} edge`);
        supersedeEdge(open.id, {
          validTo: f.to ?? null,
          eventId: f.ev ? world.event(num(f, "ev", 1)) : null,
          quote: f.q ?? null,
        });
        break;
      }
      case "decide":
        world.lastPair = [world.entity(req(f, "l", tag)), world.entity(req(f, "r", tag))];
        recordDecision({
          left: world.lastPair[0],
          right: world.lastPair[1],
          verdict: req(f, "v", tag) as "same" | "different" | "unsure",
          decidedBy: f.by ?? "user",
          reason: f.reason ?? null,
        });
        break;
      case "merge": {
        const loser = world.entity(req(f, "loser", tag));
        const winner = world.entity(req(f, "winner", tag));
        const res = mergeEntities({ loser, winner, actor: f.by ?? "user", reason: f.reason ?? null });
        world.merged = res.merged;
        world.refuseReason = res.refused ?? "";
        world.lastPair = [winner, loser];
        world.lastWinner = res.merged ? res.winner : winner;
        break;
      }
      case "split": {
        const res = splitEntity({ entityId: world.rawEntity(req(f, "e", tag)), actor: f.by ?? "user", reason: f.reason ?? null });
        world.splitDone = res.split;
        break;
      }
      case "compact":
        compactMerges();
        break;
      case "queue":
        world.lastPair = [world.entity(req(f, "l", tag)), world.entity(req(f, "r", tag))];
        queueResolution({
          left: world.lastPair[0],
          right: world.lastPair[1],
          question: f.q ?? "Are these the same?",
          reason: f.reason ?? "ml:in_band",
        });
        world.routedTo = "queue";
        world.merged = false;
        break;
      case "calib": {
        const useCase = f.use ?? "entity_name";
        if (!isCalibUseCase(useCase)) throw new Error(`entity script: ${useCase} is not a calib use case`);
        putCalib({
          model: f.model ?? "Xenova/multilingual-e5-small",
          useCase,
          floor: num(f, "floor", 0.8),
          // A fixture that writes a calib row means "calibration is present",
          // so the row is measured NOW. A fixed date would silently turn every
          // in-band case into a stale-calibration case once it aged past the
          // 30-day limit. Staleness has its own case, and it writes no row.
          measuredAt: f.at ?? new Date().toISOString(),
          nPairs: num(f, "n", 1200),
        });
        break;
      }
      case "ml": {
        const model = f.model ?? "Xenova/multilingual-e5-small";
        const useCase = (f.use ?? "entity_name") as CalibUseCase;
        world.value = num(f, "score", 0);
        const ctx: PairContext = {
          left: world.entity(req(f, "l", tag)),
          right: world.entity(req(f, "r", tag)),
          useCase,
          model,
          score: world.value,
          bars: fixtureBars(num(f, "bar", 0.8)),
          // No agent lane in a frozen eval: rung ④ folds to rung ⑤, which is
          // exactly what "route to agent or queue" means with no agent.
          agentAvailable: false,
        };
        // Stale or absent calibration DISABLES the rung — the router says so,
        // this file only reports it. A guessed threshold is how 50 of 54
        // comparisons once collapsed to "same".
        world.similarityRung = routePair(ctx).mlEnabled;
        recordPair(world, resolvePair(ctx));
        break;
      }
      default:
        throw new Error(`entity script: unknown tag ${JSON.stringify(tag)}`);
    }
  }
}

function decodeEdgeKind(raw: string): Parameters<typeof writeEdge>[0]["kind"] {
  const hit = ENUMS.edge_kind.decode(raw);
  if (!hit) throw new Error(`entity script: ${JSON.stringify(raw)} is not an edge kind`);
  return hit.stored as Parameters<typeof writeEdge>[0]["kind"];
}

// ---- the frozen model answer ----------------------------------------------

export interface WireApplication {
  violations: number;
  records: number;
}

/** Applies a frozen P-EP1 / P-AG1 answer through the real parser and real API. */
export function applyWire(world: World, text: string): WireApplication {
  if (text.trim() === "") return { violations: 0, records: 0 };
  const parsed = parseWire(text);
  world.modelCalls += 1;
  for (const record of parsed.records) applyRecord(world, record);
  return { violations: parsed.violations.length, records: parsed.records.length };
}

function applyRecord(world: World, record: WireRecord): void {
  const v = record.values;
  switch (record.tag) {
    case "N": {
      const type = v.type as string | null;
      if (!type || !isEntityType(type)) throw new Error(`P-EP1: N line typed ${String(type)}`);
      const row = createEntity({
        type,
        subtype: (v.subtype as string | null) ?? null,
        canonical: (v.name as string | null) ?? null,
        provisional: true,
      });
      world.label(row.id, (v.entity as string | null) ?? undefined);
      break;
    }
    case "M": {
      const events = (v.events as number[] | null) ?? [];
      const alias = v.entity as string | null;
      // An alias the roster never carried is NOT resolved to a guess: the
      // mention lands unlinked with a hint, which is the whole rule.
      let entityId: string | null = null;
      if (alias) {
        try {
          entityId = world.entity(alias);
        } catch {
          entityId = null;
        }
      }
      recordMention({
        eventId: world.event(events[0] ?? 1),
        surface: (v.surface as string | null) ?? "",
        entityId,
        hint: (v.hint as string | null) ?? (entityId ? null : ((v.surface as string | null) ?? null)),
        confidence: (v.confidence as number | null) ?? 0.5,
        decidedBy: entityId ? "llm:p-ep1" : "llm:p-ep1:unresolved",
      });
      world.value = (v.confidence as number | null) ?? 0;
      break;
    }
    case "L": {
      const events = (v.events as number[] | null) ?? [];
      const eventId = world.event(events[0] ?? 1);
      writeEdge({
        kind: v.kind as Parameters<typeof writeEdge>[0]["kind"],
        subtype: (v.subtype as string | null) ?? null,
        srcEntityId: world.entity(String(v.src)),
        dstEntityId: world.entity(String(v.dst)),
        confidence: (v.confidence as number | null) ?? 0.7,
        decidedBy: "llm:p-ep1",
        // An edge is valid from the day it was said. The model never states
        // that — it is on the event, and reading it off the event is what makes
        // a later move able to close this one with a real date.
        validFrom: eventDate(eventId),
        eventId,
        quote: (v.quote as string | null) ?? null,
      });
      break;
    }
    case "Q": {
      const about = (v.about as string | null) ?? "-";
      getDb()
        .prepare(
          `INSERT INTO questions (id, kind, target_kind, target_id, question, status)
           VALUES (?, 'identity', 'mention', ?, ?, 'open')`,
        )
        .run(`qst_${world.labels.size}_${about}`, about, (v.question as string | null) ?? "");
      break;
    }
    case "V": {
      if (record.variant !== "V.entity") throw new Error(`P-AG1: got ${record.variant}, not an entity verdict`);
      const left = world.entity(String(v.left));
      const right = world.entity(String(v.right));
      const conf = (v.confidence as number | null) ?? 0;
      world.value = conf;
      // Rung ④'s verdict, applied by the real ladder: `same` binds at or above
      // AGENT_BIND_BAR, `un` goes to the queue and is never auto-retried.
      recordPair(
        world,
        applyAgentVerdict(
          {
            left,
            right,
            verdict: (v.verdict as "same" | "different" | "unsure" | null) ?? "unsure",
            confidence: conf,
            reason: (v.reason as string | null) ?? "",
          },
          { left, right },
        ),
      );
      break;
    }
    default:
      // A claim tag in a P-EP1 answer belongs to another pass, not to this
      // one. It is COUNTED and left alone — ordered, never censored.
      world.otherLines += 1;
      break;
  }
}

/** The date an event was stated on — `events.ts`, never `ingested_at`. */
function eventDate(eventId: string): string | null {
  const row = getDb().prepare(`SELECT ts FROM events WHERE id = ?`).get(eventId) as { ts: string } | undefined;
  return row ? row.ts.slice(0, 10) : null;
}

/** The one entry point every entity-graph category shares. */
export function runEntityCase(fixture: Fixture, response: string): Produced {
  return inEvalDb(() => {
    const world = buildWorld(fixture);
    const { script, wire, post } = splitScript(response);
    runScript(world, script);
    applyWire(world, wire);
    runScript(world, post);
    return snapshot(world, fixture);
  });
}
