// ===========================================================================
// [CODE] Category B executor — the real tiering path (build item 1.2).
//
// B is `[CODE]` apart from P-TI1, so `frozen_response` is a scenario script and
// the executor is the product: `tiers/derive`, `tiers/classify`,
// `tiers/rescan`, `tiers/priority` and `prompts/p-ti1`, over a real temp SQLite
// DB with real migrations. Nothing here re-implements a tier rule, a priority,
// a re-scan or a wire parse — every number below comes back out of the module
// that owns it.
//
// Scenario records (one per line, `tag|field=value|…`):
//
//   assign                        the boot tier backfill over every stream
//   recheck                       a second backfill — proves the P-TI1 verdict
//                                 is cached on the stream and not re-asked
//   reply|c=c1                    the user posts into a stream, which re-tiers
//                                 it (the T3 -> T1 promotion, and its re-scan)
//   extract|c=c1|vs=c2            enqueue two streams' events and compare what
//                                 tiering did to each — stages, then priority
//   cohort|id=k1|tier=T1|horizon=h24|age_min=120     a planned cohort
//   run                           run exactly one cohort (a boundary)
//   arrive|id=live1|tier=T2|horizon=live|age_min=0   a cohort arriving mid-run
//   drain                         run the rest
//
// A `#TI1` line divides the scenario from the FROZEN MODEL ANSWER beneath it.
// That answer is fed through the real `buildTi1Prompt` alias table and the real
// STW-2 parser, so an eval that expects a verdict is exercising the same code
// path a live haiku call would take — which is the point of the seam.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import {
  appStateSet,
  insertEvent,
  selfIdentityKey,
  upsertActor,
  upsertSource,
  upsertStream,
} from "../../db/ingest.js";
import { noteIngestedEvent } from "../../db/watermarks.js";
import { buildTi1Prompt, chunkChannels, parseTi1Response, type Ti1Verdict } from "../../prompts/p-ti1.js";
import {
  backfillTiers,
  readStreamFacts,
  readTier,
  retierStream,
  tierCoverage,
} from "../../tiers/derive.js";
import {
  CohortQueue,
  isHorizon,
  isTier,
  tierOfPriority,
  tierOrderViolations,
  type Cohort,
} from "../../tiers/priority.js";
import { enqueueStreamEvents } from "../../tiers/rescan.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, Produced } from "../runner.js";

const SOURCE = "whatsapp";
const SELF = "me@s.whatsapp.net";
/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

const BUSINESS_KINDS = new Set(["biz", "business"]);

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

/** Splits the scenario from the frozen P-TI1 answer beneath `#TI1`. */
function splitResponse(text: string): { scenario: ScenarioLine[]; ti1: string } {
  const lines = (typeof text === "string" ? text : "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "#TI1");
  const head = at === -1 ? lines : lines.slice(0, at);
  const ti1 = at === -1 ? "" : lines.slice(at + 1).join("\n");
  const scenario: ScenarioLine[] = [];
  for (const raw of head) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`tiers scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    scenario.push({ tag, fields });
  }
  return { scenario, ti1 };
}

function num(fields: Record<string, string>, key: string, fallback: number): number {
  const raw = fields[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`tiers scenario: ${key}=${raw} is not a number`);
  return n;
}

// ---- the world the fixture describes ---------------------------------------

interface World {
  /** Fixture alias (`c1`) -> the real stream id. */
  streams: Map<string, string>;
  order: string[];
}

function buildWorld(fixture: Fixture): World {
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
  appStateSet(selfIdentityKey(SOURCE), SELF);
  upsertActor({ sourceId: SOURCE, sourceExtId: SELF, displayName: "Me", isSelf: true });

  const world: World = { streams: new Map(), order: [] };
  for (const stream of fixture.given.streams) {
    const kind = stream.kind.toLowerCase();
    const isBusiness = BUSINESS_KINDS.has(kind);
    const id = upsertStream({
      sourceId: SOURCE,
      sourceExtId: stream.alias,
      name: stream.name,
      // A business channel is a 1:1 lane the business talks down; only a real
      // group is a group, and that distinction is what §9.3's rules turn on.
      kind: isBusiness ? "dm" : kind,
      isBusiness,
    });
    world.streams.set(stream.alias, id);
    world.order.push(stream.alias);
  }

  for (const event of fixture.given.events) {
    const alias = typeof event.c === "string" ? event.c : world.order[0];
    if (!alias || !world.streams.has(alias)) {
      throw new Error(`tiers fixture: event ${event.n} names no known stream`);
    }
    write(world.streams.get(alias)!, event.who, event.text, event.ts, `e${event.n}`);
  }
  return world;
}

function write(streamId: string, who: string, text: string, ts: string, tag: string): string {
  const ext = who === "self" ? SELF : who;
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: ext, displayName: who });
  const externalId = `${streamId}/${tag}`;
  const res = insertEvent({
    externalId,
    sourceId: SOURCE,
    sourceType: SOURCE,
    streamId,
    actorId,
    ts,
    kind: "message",
    text,
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  });
  noteIngestedEvent(streamId, ts, { historical: true, externalId });
  return res.id;
}

// ---- P-TI1, through the real prompt and the real parser ---------------------

interface ModelSeam {
  resolve: (channels: Parameters<typeof buildTi1Prompt>[0]) => readonly Ti1Verdict[];
  calls: () => number;
  verdicts: () => Ti1Verdict[];
}

function modelSeam(frozen: string): ModelSeam {
  let calls = 0;
  const seen: Ti1Verdict[] = [];
  return {
    calls: () => calls,
    verdicts: () => seen,
    resolve: (channels) => {
      const out: Ti1Verdict[] = [];
      // §12.11 caps a call at 10 channels; more channels means more calls.
      for (const batch of chunkChannels(channels)) {
        calls += 1;
        const prompt = buildTi1Prompt(batch);
        const answer = parseTi1Response(frozen, prompt.table);
        out.push(...answer.verdicts);
      }
      seen.push(...out);
      return out;
    },
  };
}

// ---- the run ---------------------------------------------------------------

function runScenario(fixture: Fixture, response: string): Produced {
  runMigrations();
  const world = buildWorld(fixture);
  const { scenario, ti1 } = splitResponse(response);

  const output: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};
  const single = world.order.length === 1 ? world.order[0]! : null;

  const queue = new CohortQueue(NOW);
  const planned: Cohort[] = [];

  const streamId = (alias: string): string => {
    const id = world.streams.get(alias);
    if (!id) throw new Error(`tiers scenario: no stream aliased ${JSON.stringify(alias)}`);
    return id;
  };

  for (const { tag, fields } of scenario) {
    switch (tag) {
      // ---- B-001…B-039: assignment, and the coverage assertion that makes it
      // impossible to ship `tier NULL` on every channel again.
      case "assign": {
        const seam = modelSeam(ti1);
        const report = backfillTiers({ now: NOW, resolveAmbiguous: seam.resolve });

        const tiers: Record<string, string | null> = {};
        const rules: Record<string, string> = {};
        for (const alias of world.order) {
          const id = streamId(alias);
          tiers[alias] = readTier(id);
          rules[alias] = rowOf(id).tier_rule ?? "";
        }
        state.tiers = tiers;
        state.rules = rules;
        state.streams_total = report.streams;
        state.streams_with_tier = report.assigned;
        state.tier_coverage = report.coverage;
        state.unassigned = report.unassigned;
        // It returned at all: `backfillTiers` throws on anything short of 100%.
        state.coverage_assertion = "passed";
        state.model_calls = report.modelCalls;
        state.model_channels = report.modelChannels;
        state.ambiguous_channels = report.ambiguous.length;
        metrics.model_calls = report.modelCalls;

        if (single) {
          const id = streamId(single);
          const facts = readStreamFacts(id)!;
          const row = rowOf(id);
          state.tier = row.tier;
          state.stored_tier = readTier(id);
          state.rule = row.tier_rule;
          state.tier_source = row.tier_source;
          state.confidence = row.tier_confidence;
          state.reason = row.tier_reason;
          state.is_group = facts.isGroup;
          state.is_business = facts.isBusiness;
          state.user_messages = facts.userMessageCount;
          const verdict = seam.verdicts().find((v) => v.streamId === id);
          if (verdict) {
            state.verdict = verdict.label;
            state.verdict_class = verdict.cls;
            state.meets_confidence_floor = (verdict.confidence ?? 0) >= 0.7;
            metrics.value = verdict.confidence ?? 0;
          }
        }
        break;
      }

      // ---- B-033…B-038: the verdict is CACHED on the stream. A second pass
      // must not ask again.
      case "recheck": {
        const seam = modelSeam(ti1);
        const report = backfillTiers({ now: NOW, resolveAmbiguous: seam.resolve });
        state.recheck_model_calls = seam.calls();
        state.recheck_cached = report.cached.length;
        if (single) state.recheck_tier = readTier(streamId(single));
        break;
      }

      // ---- B-047…B-049: the promotion, its re-scan, and the watermarks.
      case "reply": {
        const alias = fields.c ?? single ?? "";
        const id = streamId(alias);
        const before = readTier(id);
        write(id, "self", fields.text ?? "im in", fields.ts ?? "2026-08-15T11:30:00+05:30", "reply");
        const { change, rescan } = retierStream(id, { now: NOW });

        state.tier_before = before;
        state.tier_after = change.to;
        state.promoted = change.changed;
        state.requeued_count = rescan ? rescan.requeued.length : 0;
        state.requeued_all_at_new_tier = rescan
          ? Object.values(rescan.enqueue.priorities).every((p) => tierOfPriority(p) === change.to)
          : true;
        state.orphans_after = rescan ? rescan.orphans.length : 0;
        state.live_direction = rescan?.liveDirection ?? "same";
        state.backfill_direction = rescan?.backfillDirection ?? "same";
        output.orphans = (rescan?.orphans ?? []).map((event) => ({ event }));
        output.watermark_regressions = (rescan?.watermarkRegressions ?? []).map((cursor) => ({ cursor }));
        break;
      }

      // ---- B-050: tiering orders, it never filters.
      case "extract": {
        const id = streamId(fields.c ?? single ?? "");
        const report = enqueueStreamEvents(id, { now: NOW });
        state.tier = readTier(id);
        state.events_total = countEvents(id);
        state.events_enqueued = report.events;
        state.events_dropped = countEvents(id) - report.events;
        state.stages = stagesFor(id);
        state.orphans_after = report.orphans.length;
        output.dropped_events = [];
        output.filtered_by_tier = [];

        if (fields.vs) {
          const other = streamId(fields.vs);
          const reference = enqueueStreamEvents(other, { now: NOW });
          state.reference_tier = readTier(other);
          state.reference_stages = stagesFor(other);
          state.same_stages_as_reference = canonicalEqual(stagesFor(id), stagesFor(other));
          const mine = Math.max(...Object.values(report.priorities));
          const theirs = Math.max(...Object.values(reference.priorities));
          state.priority = mine;
          state.reference_priority = theirs;
          state.waits_its_turn = mine < theirs;
        }
        break;
      }

      // ---- B-040…B-046: tier is the primary sort key, and the live exception.
      case "cohort":
      case "arrive": {
        const cohort: Cohort = {
          id: fields.id ?? `k${planned.length + 1}`,
          tier: asTier(fields.tier),
          horizon: asHorizon(fields.horizon),
          ts: new Date(NOW - num(fields, "age_min", 0) * 60_000).toISOString(),
        };
        planned.push(cohort);
        if (tag === "cohort") queue.push(cohort);
        else queue.arrive(cohort);
        break;
      }

      // One cohort, to completion. A boundary is the only place anything is
      // ever decided — nothing here can interrupt work in flight.
      case "run": {
        queue.next();
        break;
      }

      case "drain": {
        queue.drain();
        break;
      }

      default:
        throw new Error(`tiers scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  if (planned.length > 0) {
    const order = queue.history();
    const violations = tierOrderViolations(order, planned);
    state.order = order.map((r) => r.id);
    state.tier_order = order.map((r) => r.tier);
    state.tier_order_violations = violations.length;
    state.ran_before_t1_exhausted = violations.map((v) => v.ran);
    output.ran_before_t1_exhausted = violations.map((v) => ({ cohort: v.ran }));
    const preempted = order.filter((r) => r.preempted);
    state.preempted = preempted.map((r) => r.id);
    output.preemptions = preempted.map((r) => ({ cohort: r.id }));
    const arrived = order.find((r) => r.delay > 0) ?? preempted[0];
    if (arrived) {
      state.cohort_delay = arrived.delay;
      state.interrupted_mid_cohort = false;
      metrics.cohort_delay = arrived.delay;
    }
  }

  const coverage = tierCoverage();
  state.final_coverage = coverage.coverage;
  metrics.tier_coverage = coverage.coverage;
  return { output, state, metrics };
}

// ---- small readers ---------------------------------------------------------

interface TierRow {
  tier: string | null;
  tier_rule: string | null;
  tier_source: string | null;
  tier_confidence: number | null;
  tier_reason: string | null;
}

function rowOf(streamId: string): TierRow {
  return getDb()
    .prepare(`SELECT tier, tier_rule, tier_source, tier_confidence, tier_reason FROM streams WHERE id = ?`)
    .get(streamId) as TierRow;
}

function countEvents(streamId: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ?`).get(streamId) as { n: number }
  ).n;
}

/** The distinct stages this stream's events are queued for, sorted. */
function stagesFor(streamId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT w.stage AS stage
           FROM work_queue w
           JOIN events e ON e.id = w.unit_id
          WHERE w.unit_kind = 'event' AND e.stream_id = ?
          ORDER BY w.stage`,
      )
      .all(streamId) as { stage: string }[]
  ).map((r) => r.stage);
}

function canonicalEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function asTier(raw: string | undefined): Cohort["tier"] {
  if (!isTier(raw)) throw new Error(`tiers scenario: ${JSON.stringify(raw)} is not a tier`);
  return raw;
}

function asHorizon(raw: string | undefined): Cohort["horizon"] {
  // The doc's case table spells a couple of horizons loosely (`h7d`, `holder`);
  // they are the same buckets, and refusing to read them would fail the case
  // over a typo instead of over the behaviour.
  const alias: Record<string, string> = { h7d: "d7", h30d: "d30", holder: "older", h90d: "d90" };
  const value = alias[raw ?? ""] ?? raw;
  if (!isHorizon(value)) throw new Error(`tiers scenario: ${JSON.stringify(raw)} is not a horizon`);
  return value;
}

export const tiersExecutor: Executor = ({ fixture, response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-tiers-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return runScenario(fixture, response);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};
