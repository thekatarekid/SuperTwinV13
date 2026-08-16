// ===========================================================================
// [CODE] Category L executor — the real arc engine (build item 2.5).
//
// L is `[CODE]` everywhere except the P-AG2 answer itself, so `frozen_response`
// carries a SCENARIO — one `tag|key=value|…` record per line — and, beneath an
// `#AG2 <episode>` header, the frozen model answer for that episode. Every
// number below comes back out of `worker/src/arcs/*` over a real temp SQLite DB
// with real migrations: nothing here re-implements a rung, a bar, the arc key,
// the two-phase commit or the clock.
//
// Scenario records:
//
//   calib|floor=0            the frozen `arc_topic` floor. floor 0 makes the
//                            normalised score equal the cosine, which is how a
//                            case can state "calibrated sim 0.68" and mean it.
//                            `calib|none=1` poses an UNCALIBRATED model.
//   entity|id=a1|type=person
//   episode|id=ep1|entities=a1,a2|label=…|source=whatsapp|ambient=0
//   arc|id=n1|label=…|anchors=a1,a2|sources=wa,cal|episodes=ep0|cosine=0.8
//       |quiet_days=21|pinned=1
//   bridge|from=ep1|to=ep0|kind=url|value=site0.com/x|conf=1
//   place|episode=ep1        run the ladder for that episode and apply it
//   prov|batch=c1|episodes=ep1,ep2      a provisional arc, as a parallel cohort
//                                       would have left it
//   split|arc=n1|episodes=ep2           a user split — a HARD WALL
//   move|arc=n1|episodes=ep2            a user move — a HARD WALL
//   reconcile|batch=c1|times=4          reconcile, optionally repeated so the
//                                       id-stability rows can be asserted
//
// The adjudicator is injected and answers from the frozen block, against a
// prompt built by the REAL `buildAg2Prompt` — so the alias table the answer is
// read through is the one the model would have been given.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLadderResult,
  arcEpisodeIds,
  commitArc,
  readArc,
  readArcCandidates,
  readArcs,
  readProvisionalArcs,
  writeProvisionalArc,
} from "../../arcs/provisional.js";
import { arcKey } from "../../arcs/key.js";
import {
  bridgeRung,
  dbBridgeReader,
  runArcLadder,
  type ArcAdjudicator,
  type LadderCandidate,
  type LadderEpisode,
  type LadderResult,
} from "../../arcs/ladder.js";
import { reconcile, type ReconcileResult } from "../../arcs/reconcile.js";
import { bridgeId, persistBridges } from "../../bridges/extract.js";
import { putCalib } from "../../db/calib.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { logMutation } from "../../entities/merge.js";
import { buildAg2Prompt } from "../../prompts/p-ag2.js";
import { MIN_CALIB_PAIRS } from "../../retrieval/calibration-floor.js";
import type { Executor, GateObservation, Produced } from "../runner.js";
import { correctionsObservations } from "./corrections-corpus.js";

const EMBEDDER = "eval-embedder";
/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

interface Line {
  tag: string;
  fields: Record<string, string>;
}

/** Splits the scenario from the frozen P-AG2 answers, keyed by episode. */
function split(text: string): { scenario: Line[]; answers: Map<string, string> } {
  const scenario: Line[] = [];
  const answers = new Map<string, string>();
  let current: string | null = null;
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#AG2")) {
      current = line.slice(4).trim();
      answers.set(current, "");
      continue;
    }
    if (current !== null) {
      answers.set(current, `${answers.get(current) ?? ""}${answers.get(current) ? "\n" : ""}${line}`);
      continue;
    }
    if (line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`arcs scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    scenario.push({ tag, fields });
  }
  return { scenario, answers };
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const arcsExecutor: Executor = ({ response }) => {
  const first = inFreshDb(() => runScenario(response));

  // §2.5's claim is that a full RE-DERIVATION rebinds to the SAME arc ids.
  // Reconciling one database twice cannot show that: `readArcByKey` finds the
  // row already there and hands back its id without `arcIdForKey` ever being
  // called, so a randomly-minted id would survive that check untouched. The
  // only arrangement that exercises derivation is a second, EMPTY database —
  // the scenario replayed from nothing, and the two id sets compared.
  const second = inFreshDb(() => runScenario(response));
  const before = arcIdsOf(first);
  const after = arcIdsOf(second);
  if (before.length > 0) {
    const stable = before.length === after.length && before.every((id, i) => id === after[i]);
    first.gates = [
      ...(first.gates ?? []),
      {
        gate: "arcs_id_stability",
        passed: stable,
        note: stable
          ? `re-derivation on an empty database reproduced ${before.length} arc id(s)`
          : `ids drifted across a full re-derivation: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      },
    ];
  }

  // §14.2's "user corrections surviving re-derivation" needs a correction, a
  // full re-derive and a read-back — a scenario, not a fixture. It rides with
  // the first L case that completes (once per suite, see corrections-corpus.ts).
  first.gates = [...(first.gates ?? []), ...correctionsObservations()];
  return first;
};

/** Every arc id the run committed, ordered so two runs compare positionally. */
function arcIdsOf(produced: Produced): string[] {
  const arcs = (produced.output as { arcs?: readonly { id: string }[] }).arcs ?? [];
  return arcs.map((a) => a.id).sort();
}

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-arcs-"));
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

interface EpisodeSpec {
  id: string;
  label: string | null;
  sourceId: string;
  ambient: boolean;
  entityIds: string[];
  startedAt: string;
  endedAt: string;
}

function runScenario(response: string): Produced {
  runMigrations();
  const { scenario, answers } = split(response);
  const db = getDb();

  // ---- the world ---------------------------------------------------------
  const calibLine = scenario.find((l) => l.tag === "calib");
  if (calibLine?.fields.none !== "1") {
    putCalib({
      model: EMBEDDER,
      useCase: "arc_topic",
      floor: num(calibLine?.fields.floor) ?? 0,
      nPairs: MIN_CALIB_PAIRS,
      measuredAt: new Date(NOW - DAY).toISOString(),
    });
  }

  const episodes = new Map<string, EpisodeSpec>();
  const cosines = new Map<string, number>();
  const placements: LadderResult[] = [];
  const reconciles: ReconcileResult[] = [];
  const gates: GateObservation[] = [];
  const idRuns: string[][] = [];

  const insertEntity = db.prepare(
    `INSERT OR REPLACE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`,
  );
  // A `person` fallback must never overwrite a type the scenario DECLARED —
  // that would quietly turn L-017's topics back into anchors.
  const ensureEntity = db.prepare(
    `INSERT OR IGNORE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`,
  );
  const insertEpisode = db.prepare(
    `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
  );

  for (const { tag, fields } of scenario) {
    switch (tag) {
      case "calib":
        break;

      case "entity":
        insertEntity.run(fields.id ?? "", fields.type ?? "person", fields.name ?? fields.id ?? "");
        break;

      case "episode": {
        const spec: EpisodeSpec = {
          id: fields.id ?? "",
          label: fields.label ?? null,
          sourceId: fields.source ?? "whatsapp",
          ambient: fields.ambient === "1",
          entityIds: list(fields.entities),
          startedAt: fields.started ?? "2026-08-10T00:00:00Z",
          endedAt: fields.ended ?? "2026-08-11T00:00:00Z",
        };
        episodes.set(spec.id, spec);
        // Any entity named by an episode but never declared is a person: the
        // cases are about the ladder, not about entity typing.
        for (const entityId of spec.entityIds) ensureEntity.run(entityId, "person", entityId);
        insertEpisode.run(
          spec.id,
          spec.sourceId,
          spec.label,
          JSON.stringify(spec.entityIds),
          spec.startedAt,
          spec.endedAt,
        );
        break;
      }

      case "arc": {
        const id = fields.id ?? "";
        const anchors = list(fields.anchors);
        for (const entityId of anchors) ensureEntity.run(entityId, fields.anchor_type ?? "person", entityId);
        const quiet = num(fields.quiet_days);
        commitArc({
          id,
          arcKey: arcKey(
            anchors.map((entityId) => ({ entityId, type: fields.anchor_type ?? "person" })),
            fields.label ?? null,
          ),
          label: fields.label ?? null,
          labelSource: "derived",
          anchorEntityIds: anchors,
          sourceIds: list(fields.sources),
          startedAt: fields.started ?? "2026-08-01T00:00:00Z",
          lastEvidenceAt: new Date(NOW - (quiet ?? 0) * DAY).toISOString(),
          now: NOW,
        });
        if (fields.pinned === "1") db.prepare(`UPDATE arcs SET user_pinned = 1 WHERE id = ?`).run(id);
        for (const episodeId of list(fields.episodes)) {
          if (!episodes.has(episodeId)) {
            insertEpisode.run(episodeId, "whatsapp", fields.label ?? null, "[]", null, null);
          }
          db.prepare(
            `INSERT OR REPLACE INTO arc_episodes (arc_id, episode_id, added_by) VALUES (?, ?, 'seed')`,
          ).run(id, episodeId);
        }
        const cosine = num(fields.cosine);
        if (cosine !== null) cosines.set(id, cosine);
        break;
      }

      case "bridge": {
        const kind = (fields.kind ?? "url") as never;
        const valueNorm = fields.value ?? "v";
        const from = fields.from ?? "";
        const to = fields.to ?? "";
        persistBridges([
          {
            id: bridgeId(kind, valueNorm, from, to),
            kind,
            value_norm: valueNorm,
            left_kind: "episode",
            left_id: from,
            right_kind: "episode",
            right_id: to,
            confidence: num(fields.conf) ?? 1,
            decided_by: "code",
          },
        ]);
        break;
      }

      case "split":
      case "move":
        logMutation({
          actor: "user",
          targetKind: "arc",
          targetId: fields.arc ?? "",
          field: tag,
          newValue: { episodeIds: list(fields.episodes), toArcId: fields.to ?? undefined },
          reason: "posed by the fixture",
        });
        for (const episodeId of list(fields.episodes)) {
          if (tag === "split") {
            db.prepare(`DELETE FROM arc_episodes WHERE arc_id = ? AND episode_id = ?`).run(
              fields.arc ?? "",
              episodeId,
            );
          }
        }
        break;

      case "prov":
        writeProvisionalArc({
          batchId: fields.batch ?? null,
          arcKeyCandidate: fields.key ?? "pending",
          episodeIds: list(fields.episodes),
          now: NOW,
        });
        break;

      case "place": {
        const spec = episodes.get(fields.episode ?? "");
        if (!spec) throw new Error(`arcs scenario: place names unknown episode ${String(fields.episode)}`);
        const result = placeEpisode(spec, cosines, answers, gates);
        placements.push(result);
        break;
      }

      case "reconcile": {
        const times = Math.max(1, Math.floor(num(fields.times) ?? 1));
        for (let i = 0; i < times; i += 1) {
          if (i > 0) {
            // A full re-derivation: the same evidence, proposed again.
            for (const group of reconciles[reconciles.length - 1]?.groups ?? []) {
              writeProvisionalArc({
                batchId: fields.batch ?? null,
                arcKeyCandidate: group.arcKey,
                episodeIds: group.episodeIds,
                now: NOW + i,
              });
            }
          }
          reconciles.push(
            reconcile({ now: NOW + i, batchId: fields.batch, runId: fields.run }),
          );
          idRuns.push(readArcs().map((a) => a.id).sort());
        }
        break;
      }

      default:
        throw new Error(`arcs scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  // ---- what the run produced ---------------------------------------------
  const last = placements[placements.length - 1] ?? null;
  const lastReconcile = reconciles[reconciles.length - 1] ?? null;
  const arcs = readArcs();
  const joins = placements
    .filter((p) => p.decision === "join" && p.arcId !== null)
    .map((p) => ({ episode: p.episodeId, arc: p.arcId as string }));

  const stable = idRuns.length < 2 || idRuns.every((ids) => ids.join(",") === idRuns[0]!.join(","));
  if (idRuns.length > 1) {
    gates.push({
      gate: "arcs_id_stability",
      passed: stable,
      note: stable ? "every re-derivation rebound to the same ids" : `ids drifted: ${JSON.stringify(idRuns)}`,
    });
  }

  const modelCalls = placements.reduce((sum, p) => sum + p.modelCalls, 0);

  return {
    output: {
      joins,
      arcs: arcs.map((arc) => ({
        id: arc.id,
        episodes: arcEpisodeIds(arc.id),
        sources: arc.sourceIds,
      })),
    },
    state: {
      decision: last?.decision ?? null,
      rung: last?.rung ?? null,
      arc_id: last?.arcId ?? null,
      ambient: last?.ambient ?? false,
      model_calls: modelCalls,
      overlap_top: last === null || last.overlaps.length === 0 ? null : round(last.overlaps[0]!.score),
      overlap_joins: last?.overlaps.some((o) => o.joins) ?? false,
      topic_only: last?.overlaps[0]?.topicOnly ?? false,
      similarity_top:
        last === null || last.similarities.length === 0 ? null : round(last.similarities[0]!.decision.score),
      nominated: last?.nominated ?? [],
      question_opened: last?.decision === "ask_user",
      arcs: arcs.length,
      provisionals: readProvisionalArcs().length,
      groups: lastReconcile?.groups.length ?? 0,
      merged: lastReconcile?.merged ?? 0,
      minted: lastReconcile?.minted ?? 0,
      rebound: lastReconcile?.rebound ?? 0,
      aged_to: lastReconcile?.aged[0]?.to ?? null,
      split_walls: (lastReconcile?.walls ?? []).filter((w) => w.kind === "split").length,
      arc_ids_stable: stable,
      sources: [...new Set(arcs.flatMap((a) => a.sourceIds))].sort(),
      arc_state: arcs.length === 1 ? (readArc(arcs[0]!.id)?.state ?? null) : null,
    },
    metrics: {
      model_calls: modelCalls,
      arcs: arcs.length,
      joins: joins.length,
      reconciles: reconciles.length,
    },
    gates,
  };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** One ladder pass, over the REAL candidate read, then applied to the real tables. */
function placeEpisode(
  spec: EpisodeSpec,
  cosines: ReadonlyMap<string, number>,
  answers: ReadonlyMap<string, string>,
  gates: GateObservation[],
): LadderResult {
  // The anchor TYPE is what rung ② weights, so it is read off the entities the
  // scenario declared rather than assumed — L-017 turns on exactly this.
  const anchors = spec.entityIds.map((entityId) => ({
    entityId,
    type:
      (
        getDb().prepare(`SELECT type FROM entities WHERE id = ?`).get(entityId) as
          | { type: string }
          | undefined
      )?.type ?? "person",
  }));
  const episode: LadderEpisode = {
    id: spec.id,
    label: spec.label,
    sourceId: spec.sourceId,
    ambient: spec.ambient,
    anchors,
    bridgeIds: [spec.id],
    span: `${spec.startedAt} – ${spec.endedAt}`,
  };

  const candidates: LadderCandidate[] = readArcCandidates().map((c) => ({
    ...c,
    cosine: cosines.get(c.arcId) ?? null,
  }));

  const frozen = answers.get(spec.id);
  const adjudicator: ArcAdjudicator | null =
    frozen === undefined
      ? null
      : (req) => {
          const prompt = buildAg2Prompt({
            episode: { id: req.episode.id, label: req.episode.label, span: req.episode.span },
            candidates: req.candidates,
          });
          return { response: frozen, table: prompt.table, model: "sonnet-5", calls: 1 };
        };

  const result = runArcLadder(episode, candidates, {
    model: EMBEDDER,
    now: NOW,
    bridges: dbBridgeReader,
    adjudicator,
  });

  applyLadderResult(result, {
    anchors,
    label: spec.label,
    sourceId: spec.sourceId,
    startedAt: spec.startedAt,
    endedAt: spec.endedAt,
    batchId: "eval",
    model: frozen === undefined ? null : "sonnet-5",
    now: NOW,
  });

  if (spec.ambient) {
    // §11.2's flat refusal, measured per placement rather than per case: an
    // ambient episode joined on similarity alone is a violation whatever else
    // the case asserted.
    const bySimilarity = result.decision === "join" && result.rung !== "bridge" && result.rung !== "overlap";
    gates.push({
      gate: "arcs_no_similarity_only_ambient",
      passed: !bySimilarity,
      note: bySimilarity ? `ambient ${spec.id} joined via ${String(result.rung)}` : "ambient joined via ① or ② only",
    });
  }
  // Recall needs a denominator, so the question is asked of every placement a
  // bridge was actually available for — not only of the ones that bound. Ask
  // rung ① directly what it could see: if a bridge reached a candidate arc and
  // the ladder still landed on another rung, that is a miss, and a miss is the
  // whole point of a recall gate. Emitting `passed: true` only on success
  // measured nothing and padded the denominator with unfalsifiable rows.
  const available = bridgeRung(episode, candidates, dbBridgeReader);
  if (available !== null) {
    const bound = result.rung === "bridge";
    gates.push({
      gate: "arcs_bridge_recall",
      passed: bound,
      note: bound
        ? `bridge bound ${spec.id} via ${available.kind}`
        : `bridge ${available.kind}=${available.valueNorm} reached ${available.arcId} but ${spec.id} landed on ${String(result.rung)}`,
    });
  }

  return result;
}
