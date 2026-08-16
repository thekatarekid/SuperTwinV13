// ===========================================================================
// [CODE] Category P executor — the real promotion engine (build item 3.6).
//
// P is `[CODE]` end to end: promotion is a function of loops, edges, episodes
// and the clock, so `frozen_response` carries a SCENARIO rather than a model
// verdict, and every number below comes back out of `worker/src/arcs/promote*`
// over a REAL temp SQLite database with the real migrations. That is
// deliberate: the one claim this category exists to prove is that a space is
// an `arc` row with `promoted = 1` and that demotion is a field flip, and no
// in-memory stand-in can prove either.
//
// Scenario records, one `tag|key=value|…` per line:
//
//   entity|id=flat|type=place
//   edge|kind=has|to=flat                an ACTIVE edge from me
//   arc|id=n1|anchors=flat|pinned=1|last=…|cadence=recurring|ends_at=…
//   loop|arc=n1|id=l1|state=open|owner=self|counterparty=a1
//   episode|arc=n1|id=e1|at=…|entities=self,a1|authored=1
//   shape|arc=n1|outcome=1|steps=4|ledger=1|obligation=org|own_ratio=0.9
//                                        signals item 3.7's model supplies;
//                                        everything else is counted from the DB
//   resolve|arc=n1|loops=l1,l2|state=done    later evidence closes them
//   pin|arc=n1   ·   unpin|arc=n1            the user route, as a gesture
//   sweep                                    run promotion over every arc
//   revise|arc=n1|to=prj|source=model|reason=…
//   report|arc=n1                            snapshot that arc's fields
//   gold|spaces=N                            the reference corpus's gold space
//                                            count — declares this scenario a
//                                            corpus and feeds the §14.2 spaces
//                                            gates; `arc|…|gold_archetype=hld`
//                                            marks per-arc archetype gold
//
// `self` is the real `me` entity (`ensureMeEntity`), so the party rule is
// evaluated against the same id the product uses, not against a string.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARCHETYPE_NAMES,
  toArchetype,
  type Archetype,
  type ArchetypeShape,
  type ArchetypeSource,
} from "../../arcs/archetype.js";
import {
  applyPromotionVerdict,
  pinArc,
  promoteArcs,
  readPromotionInput,
  readSpaces,
  setArchetype,
  unpinArc,
} from "../../arcs/promote-store.js";
import {
  applyRecurrenceCap,
  explainPromotion,
  promotionVerdict,
  type Cadence,
  type PromotionVerdict,
} from "../../arcs/promote.js";
import {
  anchorlessLabelRate,
  applySpacesCap,
  spaceJustificationRate,
} from "../../arcs/constraints.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { ensureMeEntity } from "../../entities/binding.js";
import { mutationsFor } from "../../entities/merge.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, GateObservation, Produced } from "../runner.js";

interface Line {
  tag: string;
  fields: Record<string, string>;
}

export function parseScenario(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`promotion scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function required(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined || value === "") throw new Error(`promotion scenario: missing ${key}`);
  return value;
}

const flag = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : value === "1" || value === "true";

const ratio = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---- the world -------------------------------------------------------------

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-promotion-"));
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

function pushRow(output: Record<string, unknown>, bucket: string, row: unknown): void {
  const rows = (output[bucket] as unknown[] | undefined) ?? [];
  rows.push(row);
  output[bucket] = rows;
}

function runScenario(fixture: Fixture, response: string): Produced {
  runMigrations();
  const me = ensureMeEntity();
  const db = getDb();
  const idOf = (alias: string): string => (alias === "self" ? me : `ent_${alias}`);

  const now = fixture.given.events.at(-1)?.ts ?? "2026-08-16T12:00:00.000Z";
  const shapes = new Map<string, ArchetypeShape>();
  /** Set by a `gold|spaces=N` record — this scenario is a reference corpus. */
  let goldSpaces: number | null = null;
  /** arc id → the gold archetype its `arc|…|gold_archetype=` field declared. */
  const goldArchetypes = new Map<string, Archetype>();
  const output: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};

  const ensureEntity = (alias: string, type: string): void => {
    db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`).run(
      idOf(alias),
      type,
      alias,
    );
  };
  for (const entry of fixture.given.roster) {
    const eq = entry.indexOf("=");
    if (eq !== -1) ensureEntity(entry.slice(0, eq).trim(), "person");
  }

  let sweep: { verdicts: PromotionVerdict[] } = { verdicts: [] };

  const runSweep = (): void => {
    if (shapes.size === 0) {
      sweep = promoteArcs({ now });
      return;
    }
    // Shape signals item 3.7's model supplies are merged onto the REAL input
    // read from the tables — the rules stay in `promote.ts` either way.
    const ids = (db.prepare(`SELECT id, last_evidence_at FROM arcs ORDER BY id`).all() as {
      id: string;
      last_evidence_at: string | null;
    }[]);
    const last = new Map(ids.map((r) => [r.id, r.last_evidence_at]));
    const raw = ids
      .map(({ id }) => readPromotionInput(id, { now }))
      .filter((i): i is NonNullable<typeof i> => i !== null)
      .map((input) => promotionVerdict({ ...input, shape: shapes.get(input.arcId) ?? input.shape }));
    // Same cap order as `promoteArcs`: recurrence first, then the corpus cap.
    const verdicts = applySpacesCap(applyRecurrenceCap(raw, last), last);
    for (const verdict of verdicts) applyPromotionVerdict(verdict);
    sweep = { verdicts };
  };

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      case "entity":
        ensureEntity(required(fields, "id"), fields.type ?? "thing");
        break;

      // An ACTIVE `has`/`located_at` edge from me — the reference route's whole
      // evidence, and the case a loop-only system cannot see at all.
      case "edge": {
        const kind = required(fields, "kind");
        const to = required(fields, "to");
        ensureEntity(to, fields.type ?? "thing");
        db.prepare(
          `INSERT OR IGNORE INTO entity_edges (id, kind, subtype, src_entity_id, dst_entity_id, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(`edge_${kind}_${to}`, kind, fields.subtype ?? null, me, idOf(to), fields.status ?? "active");
        break;
      }

      case "arc": {
        const id = required(fields, "id");
        if (fields.gold_archetype !== undefined) {
          const gold = toArchetype(fields.gold_archetype);
          if (gold === null) throw new Error(`promotion scenario: unknown gold_archetype ${fields.gold_archetype}`);
          goldArchetypes.set(id, gold);
        }
        db.prepare(
          `INSERT INTO arcs (id, arc_key, label, anchor_entity_ids, state, last_evidence_at,
                             user_pinned, cadence, ends_at)
           VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
        ).run(
          id,
          `key_${id}`,
          fields.label ?? id,
          JSON.stringify(list(fields.anchors).map(idOf)),
          fields.last ?? now,
          fields.pinned === "1" ? 1 : 0,
          fields.cadence ?? null,
          fields.ends_at ?? null,
        );
        break;
      }

      case "loop": {
        const id = required(fields, "id");
        db.prepare(
          `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, state,
                              recurrence, arc_id, stated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          `lk_${id}`,
          fields.intent ?? "do the thing",
          fields.origin ?? "explicit",
          idOf(fields.owner ?? "self"),
          idOf(fields.counterparty ?? "self"),
          required(fields, "state"),
          fields.recurrence ?? null,
          required(fields, "arc"),
          fields.at ?? now,
        );
        break;
      }

      case "episode": {
        const id = required(fields, "id");
        const at = required(fields, "at");
        db.prepare(
          `INSERT INTO episodes (id, source_id, topic_label, entity_ids, started_at, ended_at)
           VALUES (?, 'whatsapp', ?, ?, ?, ?)`,
        ).run(id, fields.label ?? id, JSON.stringify(list(fields.entities).map(idOf)), at, at);
        db.prepare(`INSERT INTO arc_episodes (arc_id, episode_id, added_by) VALUES (?, ?, 'eval')`).run(
          required(fields, "arc"),
          id,
        );
        break;
      }

      case "shape": {
        const arcId = required(fields, "arc");
        shapes.set(arcId, {
          hasOutcome: flag(fields.outcome),
          stepCount: fields.steps === undefined ? undefined : Number(fields.steps),
          hasLedger: flag(fields.ledger),
          obligationTo: fields.obligation as ArchetypeShape["obligationTo"],
          ownEventRatio: ratio(fields.own_ratio),
          durableAnchor: flag(fields.durable),
          recurring: flag(fields.recurring),
          cadence: fields.cadence as Cadence | undefined,
          endsAt: fields.ends_at,
        });
        break;
      }

      case "resolve":
        for (const id of list(required(fields, "loops"))) {
          db.prepare(`UPDATE loops SET state = ? WHERE id = ?`).run(required(fields, "state"), id);
        }
        break;

      case "pin":
        pinArc(required(fields, "arc"));
        break;

      case "unpin":
        unpinArc(required(fields, "arc"));
        break;

      case "sweep":
        runSweep();
        break;

      case "gold":
        goldSpaces = Number(required(fields, "spaces"));
        if (!Number.isFinite(goldSpaces) || goldSpaces <= 0) {
          throw new Error(`promotion scenario: gold spaces must be a positive count`);
        }
        break;

      case "revise": {
        const arcId = required(fields, "arc");
        const to = toArchetype(required(fields, "to"));
        if (to === null) throw new Error(`promotion scenario: unknown archetype ${fields.to}`);
        const before = (
          db.prepare(`SELECT archetype FROM arcs WHERE id = ?`).get(arcId) as { archetype: string | null }
        ).archetype;
        const write = setArchetype(
          arcId,
          to,
          (fields.source ?? "model") as ArchetypeSource,
          fields.reason ?? "shape changed",
        );
        state.archetype_revised = write.changed;
        state.transition_reason = write.transition;
        if (write.changed) {
          pushRow(output, "transitions", {
            from: before === null ? null : ARCHETYPE_NAMES[before as Archetype] ?? before,
            to: ARCHETYPE_NAMES[to],
            reason: fields.reason ?? "shape changed",
          });
        }
        break;
      }

      // ---- the snapshot every case asserts on ----------------------------
      case "report": {
        const arcId = required(fields, "arc");
        const verdict = sweep.verdicts.find((v) => v.arcId === arcId);
        const row = db.prepare(`SELECT * FROM arcs WHERE id = ?`).get(arcId) as
          | Record<string, unknown>
          | undefined;
        if (!row) throw new Error(`promotion scenario: arc ${JSON.stringify(arcId)} vanished`);

        const promoted = Number(row.promoted ?? 0) === 1;
        const archetype = row.archetype === null || row.archetype === undefined ? null : String(row.archetype);
        state.arc_id = String(row.id);
        state.promoted = promoted;
        state.promotion_reason =
          row.promotion_reason === null || row.promotion_reason === undefined
            ? null
            : String(row.promotion_reason);
        state.status = row.status === null || row.status === undefined ? null : String(row.status);
        state.archetype = archetype;
        state.archetype_name = archetype === null ? null : ARCHETYPE_NAMES[archetype as Archetype] ?? archetype;
        state.archetype_source =
          row.archetype_source === null || row.archetype_source === undefined
            ? null
            : String(row.archetype_source);
        state.arc_rows = (db.prepare(`SELECT COUNT(*) AS n FROM arcs`).get() as { n: number }).n;
        state.spaces_table = (
          db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='spaces'`).get() as {
            n: number;
          }
        ).n;
        state.retrievable = promoted;
        if (verdict) {
          state.routes = verdict.routes;
          state.lives_on = verdict.livesOn;
          state.why = explainPromotion(verdict);
          state.reason_recorded = verdict.promoted ? verdict.promotionReason !== null : true;
        }
        state.field_flips = mutationsFor("arc", arcId)
          .map((m) => m.field)
          .filter((f): f is string => f !== null);

        const bucket = promoted ? "spaces" : verdict?.party.blocked === true ? "people_context" : "threads";
        pushRow(output, bucket, {
          id: String(row.id),
          promotion_reason: state.promotion_reason,
          archetype: state.archetype_name,
          status: state.status,
        });
        break;
      }

      default:
        throw new Error(`promotion scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  const live = readSpaces();
  metrics.spaces = live.length;
  metrics.arcs = (db.prepare(`SELECT COUNT(*) AS n FROM arcs`).get() as { n: number }).n;
  state.live_spaces = live.length;
  state.all_spaces_justified = live.every((s) => s.promotionReason !== null);

  // ---- §14.2 spaces / labels gates, measured off the world that landed -----
  //
  // Only a scenario that declared gold is a reference corpus; a one-arc case
  // has no gold count and feeds nothing (no data beats a flattering zero).
  const gates: GateObservation[] = [];
  if (goldSpaces !== null) {
    const deltaPct = ((live.length - goldSpaces) / goldSpaces) * 100;
    metrics.space_count_delta_pct = deltaPct;
    gates.push({
      gate: "spaces_count_vs_gold",
      passed: Math.abs(deltaPct) <= 25,
      value: deltaPct,
      note: `${live.length} live spaces vs gold ${goldSpaces} (${deltaPct.toFixed(1)}%)`,
    });

    // Phase 3 gate box: > 90% of spaces holding a live loop or a reference
    // anchor — re-derived from `loops`/`entity_edges` rows, never from the
    // verdict that wrote them.
    const justified = spaceJustificationRate();
    if (justified !== null) {
      metrics.justified_rate = justified;
      state.justified_rate = justified;
      state.justified_over_90pct = justified > 0.9;
    }

    // §14.2 labels row, off the labels the corpus actually rendered.
    const anchorless = anchorlessLabelRate();
    if (anchorless !== null) {
      metrics.anchorless_label_rate = anchorless;
      gates.push({
        gate: "labels_anchor_entity",
        passed: anchorless <= 0.1,
        value: anchorless,
        note: `${(anchorless * 100).toFixed(1)}% of anchored space labels name no anchor entity`,
      });
    }
  }
  for (const [arcId, gold] of goldArchetypes) {
    const row = db.prepare(`SELECT archetype FROM arcs WHERE id = ?`).get(arcId) as
      | { archetype: string | null }
      | undefined;
    const actual = row?.archetype ?? null;
    gates.push({
      gate: "spaces_archetype_accuracy",
      passed: actual === gold,
      note: `${arcId}: archetype ${actual ?? "null"} vs gold ${gold}`,
    });
  }

  return { output, state, metrics, gates };
}

export const promotionExecutor: Executor = ({ fixture, response }): Produced =>
  inFreshDb(() => runScenario(fixture, response));
