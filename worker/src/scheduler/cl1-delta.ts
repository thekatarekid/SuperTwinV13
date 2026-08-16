// ===========================================================================
// [LLM-M] The P-CL1Δ session-delta runner — arch §8.3 (near-realtime), §12.5;
// the consumer `scheduler/steady.ts`'s `SteadyDeps.extract` seam declared and
// refused to run without.
//
// `prompts/p-cl1d.ts` builds the delta call, `claims/extract.ts` parses it
// (`parseCl1DeltaResponse`, Z lines enabled), `./cl1-apply.ts` disposes of it —
// and until this file NOTHING INVOKED, which is why a due delta pass refused
// with `provider_outage` rather than advance `sessions.last_delta_at` over
// events no model would ever read.
//
// THE CHAIN, END TO END
//
//   fired pass ─► buildCl1DeltaCall ─► runPrompt ─► parseCl1DeltaResponse
//   (steady.ts)        │                                   │
//                      │              ┌────────────────────┘
//                      │              ├─ claims ─► writeClaim   (cl1-apply)
//                      │              ├─ loops  ─► loop upsert  (cl1-apply)
//                      │              └─ updates (Z) ─ counted, not yet applied
//                      └─ the SAME roster/entity verification as cl1-pack:
//                         verified ids or `unbound:` tokens, never a bare
//                         actor id an entity foreign key would accept.
//
// FOUR PROPERTIES, INHERITED ON PURPOSE
//
//   1. THE WRITE SHAPE IS `./cl1-apply.ts`'s, UNTOUCHED. Attribution, the
//      EntityId boundary, refusal over mis-attribution, per-line error
//      isolation — all of it is the same code path P-CL1 uses, which is what
//      makes "items update in place, they do not stack" (§8.3) true: the
//      deterministic keys and the reinforce-on-exact-hit are shared.
//
//   2. EVERY CALL GOES THROUGH `runPrompt`. The `runs` row, the
//      `extraction_runs` mirror, the lane slot, the bounded repair round and
//      the quarantine are the shared runner's; this file never talks to a
//      provider directly, and `salvageAnswer` gives a quarantined-but-usable
//      answer the same one-bad-line blast radius the full pass has.
//
//   3. THE QUEUE ROW IS CONSUMED HERE. `runLiveTick` files one
//      `extract`/`session` row per fired pass; `drainExtractQueue` was
//      narrowed to `unitKinds: ['episode']` precisely so those rows wait for
//      this runner. Success marks the row done; a failure puts it back with a
//      retry ticket — failing loudly and losing the work are different things.
//
//   4. Z LINES ARE COUNTED, NOT APPLIED — STATED, NOT HIDDEN. §12.5's own
//      NOTES carry the reason this is survivable: the corrected fact arrives
//      as a fresh H line whose `stated_at`/`valid_from` ordering closes the
//      old window through the ordinary write path. The Z annotation itself
//      (ctr/dat/cmp/cnl/rfn against a stored id) has no applier anywhere in
//      the codebase yet; this runner surfaces the count on its report so the
//      gap is a visible number, never a silent drop.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { getProcessEnabled, getSelectedModel } from "../db/settings.js";
import { parseCl1DeltaResponse } from "../claims/extract.js";
import { meEntityId } from "../entities/binding.js";
import { getEntity } from "../entities/registry.js";
import { readEpisode, readEpisodesOfSession, type EpisodeRow } from "../episodes/store.js";
import { P_CL1D, P_CL1D_SYSTEM, buildCl1dPrompt, cl1dLegend, type Cl1dPrompt } from "../prompts/p-cl1d.js";
import { runPrompt, type RunnerDeps } from "../prompts/runner.js";
import { get as getProvider, DEFAULT_PROVIDER_ID } from "../providers/registry.js";
import type { PackEntity, PackEvent, PackStream } from "../wire/pack.js";
// TYPE ONLY — `steady.ts` imports this file at runtime to fill its seam, and
// `bootstrap.ts` sits behind it; a value import here would close the loop.
import type { ExtractOutcome } from "./bootstrap.js";
import {
  ag3RunnerInvoke,
  applyCl1Answer,
  emptyApply,
  salvageAnswer,
  toEntityId,
  unboundToken,
  type AsyncPromptInvoke,
  type Cl1ApplyReport,
  type Cl1Context,
  type EntityId,
  type EventRow,
  type NearHitScorer,
} from "./cl1-runner.js";
import { completeWork, failWork, workId } from "./queue.js";
import { extractedItemsFor } from "./reprocess.js";

// ---------------------------------------------------------------------------
// Building ONE delta call — rows in, prompt out
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  stream_id: string | null;
  event_ids: string | null;
}

interface StreamRow {
  id: string;
  label: string | null;
  stream_kind: string | null;
  tz: string | null;
  participant_entity_ids: string | null;
}

function parseIds(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function marks(n: number): string {
  return new Array(n).fill("?").join(",");
}

/** The me entity as the wire's reserved `self` token (§5.2) — cl1-pack's rule. */
function selfToken(entityId: string | null, me: string | null): string | null {
  if (entityId === null) return null;
  return me !== null && entityId === me ? "self" : entityId;
}

export interface Cl1DeltaCall {
  prompt: Cl1dPrompt;
  /** The apply half's context — same shape, same EntityId discipline. */
  ctx: Cl1Context;
}

/**
 * Build ONE P-CL1Δ call over a session's delta window.
 *
 * `newEventIds` is the fired pass's window (`deltaEventIds`' answer); every
 * other event of the session is PRIOR context — aliases minted in both modes,
 * printed only in `raw_events` (§12.5). The EXTRACTED block is
 * `extractedItemsFor` over the WHOLE session's events, so "never re-emit an
 * item already listed" covers everything any earlier pass wrote, not only the
 * last one.
 *
 * The roster discipline is cl1-pack's, deliberately: verified entity ids or
 * `unbound:` tokens, `self` reserved, and null rather than a truncated prompt
 * when the packer refuses (§5.9.3).
 */
export function buildCl1DeltaCall(sessionId: string, newEventIds: readonly string[]): Cl1DeltaCall | null {
  if (newEventIds.length === 0) return null;
  const db = getDb();
  const me = toEntityId(meEntityId());

  const session = db
    .prepare(`SELECT id, stream_id, event_ids FROM sessions WHERE id = ?`)
    .get(sessionId) as SessionRow | undefined;
  if (session === undefined || session.stream_id === null) return null;

  const stream = db
    .prepare(`SELECT id, label, stream_kind, tz, participant_entity_ids FROM streams WHERE id = ?`)
    .get(session.stream_id) as StreamRow | undefined;
  if (stream === undefined) return null;

  const sessionEventIds = parseIds(session.event_ids);
  const allIds = [...new Set([...sessionEventIds, ...newEventIds])];
  if (allIds.length === 0) return null;
  const eventRows = db
    .prepare(
      `SELECT id, stream_id, ts, actor_id, actor_entity_id, text, reply_to_external_id
         FROM events WHERE id IN (${marks(allIds.length)}) ORDER BY ts, id`,
    )
    .all(...allIds) as EventRow[];
  if (eventRows.length === 0) return null;
  const events = new Map(eventRows.map((r) => [r.id, r]));

  // The roster: stream participants plus every event actor, VERIFIED on the
  // way in — an id that is not an `entities` row is never minted an `a<n>`.
  const bound = new Map<string, EntityId | null>();
  const boundId = (id: string | null): EntityId | null => {
    if (id === null) return null;
    if (!bound.has(id)) bound.set(id, toEntityId(id));
    return bound.get(id) ?? null;
  };
  const roster = new Set<EntityId>();
  const enrol = (id: string | null): void => {
    const entityId = boundId(id);
    if (entityId !== null) roster.add(entityId);
  };
  for (const id of parseIds(stream.participant_entity_ids)) enrol(id);
  for (const row of eventRows) enrol(row.actor_entity_id);

  const entities: PackEntity[] = [];
  const participants: EntityId[] = [];
  for (const id of [...roster].sort()) {
    participants.push(id);
    if (me !== null && id === me) continue;
    const entity = getEntity(id);
    if (entity === null) continue;
    entities.push({ id, name: entity.canonical ?? id, type: entity.type ?? "person" });
  }

  const streams: PackStream[] = [
    {
      id: stream.id,
      name: stream.label ?? stream.id,
      kind: stream.stream_kind ?? "dm",
      participantIds: parseIds(stream.participant_entity_ids)
        .map((id) => selfToken(boundId(id), me))
        .filter((id): id is string => id !== null),
    },
  ];

  // A speaker with no bound entity packs under `unbound:` — cl1-pack's rule,
  // for cl1-pack's reason: nothing the model can cite back may resolve to
  // something an entity foreign key would accept.
  const unboundActors = new Map<string, string>();
  const packOne = (row: EventRow): PackEvent | null => {
    const actorEntityId = boundId(row.actor_entity_id);
    let speaker = selfToken(actorEntityId, me);
    if (speaker === null && row.actor_id !== null) {
      speaker = unboundToken(row.actor_id);
      unboundActors.set(speaker, row.actor_id);
    }
    if (row.stream_id === null || speaker === null) return null;
    return {
      id: row.id,
      streamId: row.stream_id,
      at: row.ts ?? "",
      speakerId: speaker,
      ...(row.text === null ? {} : { text: row.text }),
    };
  };

  const windowSet = new Set(newEventIds);
  const priorEvents: PackEvent[] = [];
  const newEvents: PackEvent[] = [];
  for (const row of eventRows) {
    const packed = packOne(row);
    if (packed === null) continue;
    if (windowSet.has(row.id)) newEvents.push(packed);
    else priorEvents.push(packed);
  }
  if (newEvents.length === 0) return null;

  // The episode being re-read. An OPEN session may not have an episode row yet
  // — the understanding rung mints those at seal — so the session stands in,
  // and evidence simply carries a NULL `episode_id` until then.
  const episodes = readEpisodesOfSession(sessionId)
    .map((id) => readEpisode(id))
    .filter((ep): ep is EpisodeRow => ep !== null);
  const episodeOfEvent = new Map<string, string>();
  for (const ep of episodes) for (const id of ep.eventIds) if (!episodeOfEvent.has(id)) episodeOfEvent.set(id, ep.id);

  const { items } = extractedItemsFor(allIds);
  const prompt = buildCl1dPrompt({
    tz: stream.tz ?? "UTC",
    entities,
    streams,
    episode: {
      id: episodes[0]?.id ?? sessionId,
      // The Y summary pass 1 emitted is not persisted anywhere (`summaries` is
      // a count, not a table), so the honest input is none: `summary` mode then
      // sends the EXTRACTED block and the ► events, which is still §12.5-legal.
      summary: null,
      label: episodes[0]?.topicLabel ?? stream.label ?? null,
    },
    extracted: items,
    priorEvents,
    newEvents,
  });
  if (prompt === null || prompt.stats.events === 0) return null;

  return {
    prompt,
    // A `Cl1dPrompt` carries everything `Cl1Context.prompt` requires (system,
    // user, table, stats) plus its own delta fields — the apply half reads
    // only the shared four.
    ctx: { prompt, episodes, events, me, participants, episodeOfEvent, unboundActors },
  };
}

// ---------------------------------------------------------------------------
// The transport — P-CL1Δ through the shared prompt runner
// ---------------------------------------------------------------------------

/** What one delta attempt reported back — `Cl1Observer`'s vocabulary, reused. */
export interface Cl1dTransportOpts {
  unitId?: string;
  deps?: RunnerDeps;
  observe?: (outcome: { providerCalls: number; partialLines: number; error: string | null }) => void;
}

/**
 * P-CL1Δ through `runPrompt` — the `runs` row, the `extraction_runs` mirror,
 * the repair round and the quarantine all come from the shared runner, exactly
 * as `cl1RunnerInvoke` gets them. `cohortId` is an explicit null: a live pass
 * belongs to no import cohort, and `runs.cohort_id` is a real foreign key.
 */
export function cl1dRunnerInvoke(opts: Cl1dTransportOpts = {}): AsyncPromptInvoke {
  return async (prompt) => {
    if (!getProcessEnabled("extract")) {
      opts.observe?.({ providerCalls: 0, partialLines: 0, error: null });
      return null;
    }
    const result = await runPrompt(
      {
        callType: P_CL1D.id,
        legend: cl1dLegend(),
        instructions: P_CL1D_SYSTEM,
        user: prompt.user,
        role: P_CL1D.role,
        cohortId: null,
        model: getSelectedModel("extract"),
        unit: { kind: "session", id: opts.unitId ?? "-" },
        lane: "understanding",
        timeoutMs: P_CL1D.timeoutSeconds * 1000,
      },
      opts.deps ?? {},
    );
    const salvaged = salvageAnswer(result, "the P-CL1Δ call produced no usable answer");
    opts.observe?.({
      providerCalls: result.runIds.length,
      partialLines: salvaged.partial?.lines ?? 0,
      error: salvaged.error === null ? null : `${salvaged.error.code}: ${salvaged.error.message}`,
    });
    return salvaged.text;
  };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface Cl1DeltaInput {
  sessionId: string;
  streamId: string;
  /** The delta window the fired pass covers — `deltaEventIds`' answer. */
  eventIds: readonly string[];
  /** HARD cap on model calls (P-CL1Δ and P-AG3 both) for this pass. */
  budget: number;
  now: number;
}

export interface Cl1DeltaRunOptions {
  runId?: string | null;
  /** Test/replay seams. Default to the real runner-backed transports. */
  invoke?: AsyncPromptInvoke;
  ag3?: AsyncPromptInvoke;
  scoreNearHits?: NearHitScorer;
  deps?: RunnerDeps;
}

export interface Cl1DeltaReport extends Cl1ApplyReport {
  sessionId: string;
  /** Model calls actually BILLED — P-CL1Δ plus any P-AG3, retries included. */
  calls: number;
  /** Z lines the answer carried. Counted here, applied nowhere yet — stated. */
  updates: number;
  /** Lines quarantined out of a partially-accepted answer — paid, not written. */
  quarantinedLines: number;
}

function emptyDeltaReport(sessionId: string): Cl1DeltaReport {
  return { ...emptyApply(), sessionId, calls: 0, updates: 0, quarantinedLines: 0 };
}

function log(line: string): void {
  console.error(`[cl1d] ${line}`);
}

/** How long a failed pass's queue row waits before it is offered again. */
const RETRY_BACKOFF_MS = 60_000;

/**
 * Run ONE fired delta pass end to end: claim the session's `extract` queue
 * row, build the delta prompt, buy the call, parse, apply, settle the row.
 *
 * IDEMPOTENT AND RESUMABLE BY THE SAME MEANS AS THE FULL PASS: the write path's
 * deterministic keys make a re-run of the same answer a REINFORCE, never a
 * fork, and the queue row's done/retry state carries the resumption. A
 * genuinely empty answer — zero parsed records — is an ERROR on the report and
 * a retry ticket on the row, never a quiet zero: "the model found nothing in
 * these events" is records > 0 with empty buckets, and a refusal is not that.
 */
export async function runCl1DeltaForSession(
  input: Cl1DeltaInput,
  opts: Cl1DeltaRunOptions = {},
): Promise<Cl1DeltaReport> {
  const report = emptyDeltaReport(input.sessionId);
  const cap = Number.isFinite(input.budget) ? Math.floor(input.budget) : 0;
  if (cap < 1) return report; // the tick's wallet said no — its report says "budget"
  const db = getDb();

  // The row `runLiveTick` filed for this pass. Claimed for the bookkeeping
  // (running + attempts), but its absence does not stop the pass: the fired
  // pass's input is authoritative, and a row can be missing on a replay.
  const rowId = workId("extract", "session", input.sessionId);
  db.prepare(`UPDATE work_queue SET state = 'running', attempts = attempts + 1 WHERE id = ? AND state = 'ready'`).run(
    rowId,
  );
  const settle = (ok: boolean): void => {
    if (ok) completeWork(rowId);
    else failWork(rowId, { action: "retry", notBeforeAt: new Date(input.now + RETRY_BACKOFF_MS).toISOString() });
  };

  const call = buildCl1DeltaCall(input.sessionId, input.eventIds);
  if (call === null) {
    // Loud, on purpose: the tick fired this pass over a non-empty window, so a
    // prompt that cannot be built is a defect, not "no work".
    report.errors.push(
      `delta prompt could not be built for session ${input.sessionId} (${input.eventIds.length} event(s) in window)`,
    );
    settle(false);
    return report;
  }

  // THE ONE SPEND GATE — cl1-runner's shape. Every P-CL1Δ and P-AG3 call in
  // this pass is charged before it is made, and retries are added by the
  // observer so the caller's wallet hears the BILLED number.
  const spend = (): boolean => {
    if (report.calls >= cap) return false;
    report.calls += 1;
    return true;
  };
  const observe: Cl1dTransportOpts["observe"] = (outcome) => {
    report.calls += Math.max(0, outcome.providerCalls - 1);
    if (outcome.partialLines > 0) {
      report.quarantinedLines += outcome.partialLines;
      log(`WARN partial answer — ${outcome.partialLines} line(s) quarantined, the rest applied`);
    }
    if (outcome.error !== null) report.errors.push(outcome.error);
  };
  const invoke =
    opts.invoke ??
    cl1dRunnerInvoke({ unitId: input.sessionId, observe, ...(opts.deps === undefined ? {} : { deps: opts.deps }) });
  const ag3 = opts.ag3 ?? ag3RunnerInvoke({ cohortId: null, unitId: input.sessionId });

  try {
    if (!spend()) {
      settle(false);
      return report;
    }
    const response = await invoke({
      system: call.prompt.system,
      user: call.prompt.user,
      model: P_CL1D.model,
    });
    if (response === null) throw new Error(`no response for session ${input.sessionId}`);
    const answer = parseCl1DeltaResponse(response, call.prompt.table, call.prompt.itemIds);
    if (answer.parse.records.length === 0) {
      throw new Error(
        `unparseable delta answer for session ${input.sessionId} ` +
          `(${answer.parse.skipped.length} skipped, ${answer.violations.length} violations)`,
      );
    }
    report.updates = answer.updates.length;
    if (report.updates > 0) {
      log(
        `WARN ${report.updates} Z update line(s) received and counted, not applied — ` +
          `no Z applier exists yet; the corrected facts arrive as fresh H lines either way (§12.5 NOTES)`,
      );
    }
    // THE COUNTERS ARE THIS REPORT'S and are folded by `applyCl1Answer` as it
    // goes — rows already committed are counted even if the apply throws out.
    await applyCl1Answer(
      answer,
      call.ctx,
      {
        now: input.now,
        runId: opts.runId ?? null,
        cohortId: null,
        ag3,
        ...(opts.scoreNearHits === undefined ? {} : { scoreNearHits: opts.scoreNearHits }),
        spend,
      },
      report,
    );
  } catch (err) {
    report.errors.push(`delta(${input.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
  }

  settle(report.errors.length === 0);
  log(
    `session=${input.sessionId} window=${input.eventIds.length} calls=${report.calls}/${cap} ` +
      `claims=${report.claimsWritten}+${report.claimsReinforced} loops=${report.loopsWritten} ` +
      `updates=${report.updates} unsupported=${report.unsupported} errors=${report.errors.length}`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// The seam filler — and the A2-shaped readiness check
// ---------------------------------------------------------------------------

/**
 * Bootstrap's A2 rule, restated for the steady tick: the provider must exist
 * BEFORE anything is allowed to fire, because `runLiveTick` advances delta
 * cursors on fire and a cursor advanced over calls that can only die is a
 * silently unread message. `steady.ts` asks this BEFORE any cursor moves; a
 * caller that injected its own transport never goes through the registry and
 * correctly never sees this check (`steadyDepsWithDefaults` wires it only when
 * the default runner-backed stage was defaulted in).
 */
export function deltaProviderMissing(): string | null {
  if (getProvider(DEFAULT_PROVIDER_ID) !== undefined) return null;
  return (
    `provider "${DEFAULT_PROVIDER_ID}" is not registered — call register(claudeLocalProvider) ` +
    `before starting the steady driver (worker/src/index.ts does this in main()). Refusing to fire: ` +
    `every P-CL1Δ call would fail after the delta cursor had already advanced`
  );
}

/**
 * The `SteadyDeps.extract` seam `scheduler/steady.ts` declared and refused
 * without — and which `startSteadyDriver` now fills with this by default,
 * exactly as `cl1ExtractStage` fills bootstrap's.
 *
 * Reports the model calls spent (BILLED, retries included) for the tick's
 * wallet, and hands the failures back rather than only logging them: a pass
 * whose call died and a pass that found nothing to say must never be the same
 * `0` on a report that cannot see them.
 */
export function cl1DeltaExtractStage(
  opts: Cl1DeltaRunOptions = {},
): (input: Cl1DeltaInput) => Promise<ExtractOutcome> {
  return async (input) => {
    const report = await runCl1DeltaForSession(input, opts);
    for (const error of report.errors) log(`ERROR session=${input.sessionId} — ${error}`);
    return { calls: report.calls, errors: report.errors };
  };
}
