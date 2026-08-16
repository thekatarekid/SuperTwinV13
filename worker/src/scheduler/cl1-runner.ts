// ===========================================================================
// [LLM-M] The real P-CL1 transport — arch §12.4, §11.3, §11.6. The caller item
// 3.1 declared and nothing ever wrote.
//
// `prompts/p-cl1.ts` builds the call, `claims/extract.ts` reads the answer,
// `claims/write.ts` + `loops/state.ts` dispose of it — and until this file
// there was NO GLUE BETWEEN THEM. `grep "runPrompt(" --exclude=*.test.ts`
// returned exactly one production caller (`ep2RunnerInvoke`), which is why a
// live install ships zero rows in `claim_versions`, `claims_active` and
// `evidence`, and therefore empty Claims / Spaces / Tasks / People surfaces.
//
// THE CHAIN, END TO END
//
//   episodes ─► cl1Batches ─► buildCl1Prompt ─► runPrompt ─► parseCl1Response
//                                                              │
//                          ┌───────────────────────────────────┘
//                          ├─ claims ─► writeClaim   (P-AG3 on a near hit)
//                          └─ loops  ─► loopCodeFacts + the `loops` upsert
//
// FIVE PROPERTIES IT IS BUILT AROUND
//
//   1. THE WRITE SHAPE IS NOT INVENTED HERE. `confluence/pipeline.ts`'s
//      `applyFrozenExtractions` substitutes FROZEN_CLAIMS / FROZEN_LOOPS for
//      exactly this stage, and it is the authoritative spec: claim before loop,
//      per unit, through `writeClaim` and the loop state function. This file
//      produces the same effect from LIVE model output. The one deliberate
//      improvement is that the code facts come from `claims/codefacts.ts`
//      (speaker, stated_at, attribution downgrade, party_pair, triage) rather
//      than being assembled inline — those are the §11.4 rules, and there is
//      no reason for a second copy of them.
//
//   2. PARALLEL BY EPISODE, APPLY SERIALIZED (§12.4). Calls fan out through
//      `extractInParallel`; the answers come back in INPUT ORDER and are
//      written one batch at a time, which is what keeps the graph confluent.
//
//   3. EVERY CALL IS CHARGED BEFORE IT IS MADE. P-CL1 is the dominant cost of
//      the whole pipeline, so one wallet counts P-CL1 AND P-AG3 and refuses
//      rather than overspends. Nothing here can call a provider off-budget.
//
//   4. A MALFORMED ANSWER FAILS LOUDLY, ONE LINE AT A TIME. A batch whose call
//      failed, whose parse accounted for nothing, or whose every record was
//      unsupported is an ERROR on the report — never a silent zero. But the
//      unit of failure is the LINE, not the answer: the runner quarantines a
//      unit whose violations survived the repair round, and reading that status
//      as "no answer" threw away every VALID claim line the same response
//      carried. One live tick lost a whole batch — $0.32 for zero rows —
//      because one `T` line came back with a shifted field. `salvageAnswer`
//      below makes the RECORDS the authority rather than the status: an answer
//      with usable wire lines is applied, its bad lines stay quarantined with
//      their original bytes, and both halves are counted (`partialAnswers`,
//      `quarantinedLines`). Isolation of the blast radius — never tolerance.
//
//   5. P-AG3 FIRES ONLY ON A NEAR HIT. The near-hit rung is [ML]: it needs a
//      calibrated `claim_text` floor and a vector per stored claim. NOTHING
//      writes `claim_embeddings` yet, so `defaultNearCandidates` (./cl1-apply.ts)
//      honestly reports the rung as blocked, `writeClaim` inserts, and no P-AG3
//      call is bought. `ag3RunnerInvoke` below is nevertheless REAL — hand the
//      apply half candidates and it runs — so the day the claim indexer lands,
//      neither file changes.
//
// THE WRITE HALF IS `./cl1-apply.ts`: the packer input, the claim/loop rows and
// the code facts. This file owns WHEN a call happens, WHAT it costs and WHERE
// the work comes from; that one owns what the answer becomes. Both are
// re-exported from here, so a caller has one import site.
//
// NOT IN SCOPE, STATED: P-CL1 emits no edge tag (`P_CL1_TAGS` is
// Y F P B O I R H W T Q). `FROZEN_EDGES` is P-EP1's output (§12.1 "L EDGES"),
// and P-EP1 has no production runner either. This stage writes claims and loops
// and does not pretend to write edges.
// ===========================================================================

import { getProcessEnabled, getSelectedModel } from "../db/settings.js";
import { getDb } from "../db/connection.js";
import { extractInParallel, parseCl1Response, type Cl1Answer } from "../claims/extract.js";
import { readEpisode, readEpisodesOfSession, type EpisodeRow } from "../episodes/store.js";
import { P_AG3, P_AG3_SYSTEM, ag3Legend } from "../prompts/p-ag3.js";
import { P_CL1, P_CL1_SYSTEM, cl1Batches, cl1Legend } from "../prompts/p-cl1.js";
import {
  runPrompt,
  type PromptRunResult,
  type PromptRunStatus,
  type QuarantineReason,
  type RunnerDeps,
} from "../prompts/runner.js";
import { computePriority, horizonFor, isTier, type Tier } from "../tiers/priority.js";
// TYPE ONLY, and it has to stay that way: `bootstrap.ts` imports this file at
// runtime to fill its own seam, so a value import here would close the loop.
import type { ExtractOutcome } from "./bootstrap.js";
import type { Cohort } from "./cohorts.js";
import {
  applyCl1Answer,
  buildCl1Call,
  emptyApply,
  type AsyncPromptInvoke,
  type Cl1ApplyReport,
  type Cl1Context,
  type NearHitScorer,
} from "./cl1-apply.js";
import {
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  type EnqueueOutcome,
} from "./queue.js";

// The write half is a separate FILE, not a separate module to hunt for: one
// import site serves every caller (the pattern `claims/write.ts` uses).
export * from "./cl1-apply.js";

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/**
 * `runs.cohort_id` is a FOREIGN KEY onto `cohorts`, so a label that is not a
 * real cohort row ("steady", "-") fails the constraint and LOSES the call it
 * was meant to account for. `PromptCallSpec.cohortId` is nullable for exactly
 * that reason: a call that belongs to no cohort says so, in NULL.
 */
function cohortPart(cohortId: string | null | undefined): string | null {
  return typeof cohortId === "string" && cohortId !== "" ? cohortId : null;
}

/** `?,?,?` for an `IN (…)` of `n` values. */
function marks(n: number): string {
  return new Array(n).fill("?").join(",");
}

// ---------------------------------------------------------------------------
// The transports
// ---------------------------------------------------------------------------

/**
 * What ONE P-CL1 (or P-AG3) attempt actually cost — the fact a `string | null`
 * return destroys.
 *
 * `providerCalls` is BILLED calls, retries included. One logical invocation
 * routinely bills two (`retried`, then `ok`), and P-CL1 is the dominant cost of
 * the pipeline, so a wallet that counts invocations here caps at roughly half
 * of what it pays — and `bootstrap.ts` charges its whole extraction budget on
 * the number this stage reports back. `status`/`error` are carried for the same
 * reason `Ep2CallOutcome` carries them: a failure that reaches the caller as a
 * bare null is a failure nobody can name.
 */
export interface Cl1CallOutcome {
  providerCalls: number;
  /** The runner's terminal status, or `disabled` when the process is off. */
  status: PromptRunStatus | "disabled";
  error: { code: string; message: string } | null;
  /**
   * Set when the unit was QUARANTINED and still handed back usable wire lines.
   * Not an error — the answer is being applied — and not nothing either, which
   * is why it is its own field rather than a silent `error: null`.
   */
  partial: Cl1Partial | null;
}

/**
 * A quarantined answer that survived as model output. `records` is what is
 * about to be applied, `lines` is what the quarantine kept instead; the
 * `quarantineId` is the row a replay starts from, so the number on the report
 * and the row on disk name the same event.
 */
export interface Cl1Partial {
  records: number;
  lines: number;
  reason: QuarantineReason | null;
  quarantineId: string | null;
}

/** Told about every attempt, before its answer reaches the caller. */
export type Cl1Observer = (outcome: Cl1CallOutcome) => void;

/** What one runner result is worth: text to apply, plus what it cost in lines. */
export interface SalvagedAnswer {
  /** Every round's words, or null when there was nothing readable at all. */
  text: string | null;
  partial: Cl1Partial | null;
  error: { code: string; message: string } | null;
}

/**
 * THE RECORDS ARE THE AUTHORITY, NOT THE STATUS.
 *
 * `PromptRunner` quarantines a unit whose violations survived the bounded
 * repair round (§5.8.2) — and it does that whether ONE line was malformed or
 * forty were. Reading `status === "quarantined"` as "no answer" therefore
 * discarded an entire paid response over a single shifted field: a live tick
 * spent $0.32, quarantined `bad_enum: stake=shr` / `field_count: T expects 11
 * fields, got 10`, and wrote zero of the perfectly valid claim lines that came
 * back on the same response.
 *
 * `outcome.records` is the merged, ACCEPTED set — round-1 records the repair
 * kept, plus whatever the repair fixed. If it is non-empty the model said
 * something readable, and code does not get to throw model output away because
 * a neighbouring line was wrong (build rule 9). So:
 *
 *   - `failed` (cancelled) is the one status with no answer, ever;
 *   - zero accepted records is no answer, and is reported as an ERROR — a fully
 *     malformed response still fails loudly and still stops the batch;
 *   - anything else yields the raw rounds, which the caller re-parses. The
 *     malformed lines fail the SAME parser a second time and land in
 *     `answer.violations`, so nothing is tolerated that was not tolerated
 *     before — the bad line is still rejected, still quarantined, still
 *     recorded byte-for-byte by the runner. Only the blast radius changed.
 */
export function salvageAnswer(result: PromptRunResult, whenEmpty: string): SalvagedAnswer {
  const cancelled = result.status === "failed";
  const records = result.records.length;
  if (cancelled || records === 0) {
    return {
      text: null,
      partial: null,
      error: {
        code: result.error?.code ?? (cancelled ? "NO_ANSWER" : "EMPTY_RESPONSE"),
        message: result.error?.message ?? whenEmpty,
      },
    };
  }
  const quarantined = result.status === "quarantined";
  return {
    text: result.responses.join("\n"),
    partial: quarantined
      ? {
          records,
          // Line-scoped only: the single `no_wire_lines` verdict is a judgment
          // on a whole response, and a response with records never carries one.
          lines: result.violations.filter((v) => v.scope === "line").length,
          reason: result.quarantineReason ?? null,
          quarantineId: result.quarantineId ?? null,
        }
      : null,
    error: null,
  };
}

/**
 * P-CL1 through the shared prompt runner (item 1.9), which owns the `runs` row,
 * the lane slot, the bounded repair round and quarantine. Returns every round's
 * words (§5.8 keeps them all) or null — and null is all a transport failure is
 * allowed to say, because the caller reports it rather than writing nothing
 * quietly. `observe` is how the caller hears what it actually cost.
 */
export function cl1RunnerInvoke(
  opts: { cohortId?: string | null; unitId?: string; deps?: RunnerDeps; observe?: Cl1Observer } = {},
): AsyncPromptInvoke {
  return async (prompt) => {
    if (!getProcessEnabled("extract")) {
      opts.observe?.({ providerCalls: 0, status: "disabled", error: null, partial: null });
      return null;
    }
    const result = await runPrompt(
      {
        callType: P_CL1.id,
        legend: cl1Legend(),
        instructions: P_CL1_SYSTEM,
        user: prompt.user,
        role: P_CL1.role,
        cohortId: cohortPart(opts.cohortId),
        model: getSelectedModel("extract"),
        unit: { kind: "episode", id: opts.unitId ?? "-" },
        lane: "understanding",
        timeoutMs: P_CL1.timeoutSeconds * 1000,
      },
      opts.deps ?? {},
    );
    return report(result, opts.observe, "the P-CL1 call produced no usable answer");
  };
}

/**
 * P-AG3 through the same runner. Reached ONLY from a near hit (§11.6), so a
 * pipeline with the [ML] rung blocked never buys one of these at all.
 */
export function ag3RunnerInvoke(
  opts: { cohortId?: string | null; unitId?: string; deps?: RunnerDeps; observe?: Cl1Observer } = {},
): AsyncPromptInvoke {
  return async (prompt) => {
    if (!getProcessEnabled("adjudicate")) {
      opts.observe?.({ providerCalls: 0, status: "disabled", error: null, partial: null });
      return null;
    }
    const result = await runPrompt(
      {
        callType: P_AG3.id,
        legend: ag3Legend(),
        instructions: P_AG3_SYSTEM,
        user: prompt.user,
        role: "adjudicate",
        cohortId: cohortPart(opts.cohortId),
        model: getSelectedModel("adjudicate"),
        unit: { kind: "claim_pair", id: opts.unitId ?? "-" },
        lane: "understanding",
        timeoutMs: P_AG3.timeoutSeconds * 1000,
      },
      opts.deps ?? {},
    );
    return report(result, opts.observe, "the P-AG3 call produced no usable answer");
  };
}

/**
 * The one place a runner result becomes an answer plus an observation. Both
 * transports share it so they cannot drift on what "usable" means — see
 * {@link salvageAnswer}, which owns that judgment and is exported so the rule
 * can be tested without a provider.
 */
function report(
  result: PromptRunResult,
  observe: Cl1Observer | undefined,
  whenEmpty: string,
): string | null {
  const salvaged = salvageAnswer(result, whenEmpty);
  observe?.({
    // Every provider call pushes its run id, retries included — so this is the
    // billed count, not the invocation count.
    providerCalls: result.runIds.length,
    status: result.status,
    error: salvaged.error,
    partial: salvaged.partial,
  });
  return salvaged.text;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface Cl1RunOptions {
  now?: number;
  runId?: string | null;
  cohortId?: string | null;
  /** HARD cap on model calls (P-CL1 AND P-AG3) for this run. */
  maxCalls?: number;
  /** §13: 4 bootstrap, 2 steady. */
  parallelism?: number;
  /** Test/replay seams. Default to the real runner-backed transports. */
  invoke?: AsyncPromptInvoke;
  ag3?: AsyncPromptInvoke;
  scoreNearHits?: NearHitScorer;
  deps?: RunnerDeps;
}

export interface Cl1Report extends Cl1ApplyReport {
  episodes: number;
  batches: number;
  /** Model calls actually spent — P-CL1 plus P-AG3. */
  calls: number;
  /** Episodes a call was never bought for, because the budget ran out. */
  skipped: number;
  /**
   * Answers that were QUARANTINED and applied anyway, because they still
   * carried valid wire lines. A run with `partialAnswers > 0` bought a full
   * answer and kept part of it, and saying so is the difference between a claim
   * count that is complete and one that merely looks it.
   */
  partialAnswers: number;
  /**
   * Lines quarantined out of those answers — model output this run paid for and
   * did NOT write. `violations` counts every rejection the re-parse saw;
   * this counts the ones that survived the repair round into the quarantine
   * table, and so is the number a replay would work from.
   */
  quarantinedLines: number;
  /** Every batch that failed, with the episodes it was carrying. NEVER empty
   *  on a silent zero: an unparseable answer is an error, not "no claims". */
  errors: string[];
}

function emptyReport(): Cl1Report {
  return {
    ...emptyApply(),
    episodes: 0,
    batches: 0,
    calls: 0,
    skipped: 0,
    partialAnswers: 0,
    quarantinedLines: 0,
    errors: [],
  };
}

function fold(report: Cl1Report, part: Cl1ApplyReport): void {
  report.claimsWritten += part.claimsWritten;
  report.claimsReinforced += part.claimsReinforced;
  report.claimsAdjudicated += part.claimsAdjudicated;
  report.loopsWritten += part.loopsWritten;
  report.evidenceRows += part.evidenceRows;
  report.ag3Calls += part.ag3Calls;
  report.unsupported += part.unsupported;
  report.claimsRefused += part.claimsRefused;
  report.unresolvedRefs += part.unresolvedRefs;
  report.summaries += part.summaries;
  report.questions += part.questions;
  report.violations += part.violations;
  report.errors.push(...part.errors);
}

function log(line: string): void {
  console.error(`[cl1] ${line}`);
}

/** How many P-CL1 calls `n` episodes buy, at §12.4's cap. Batching's own count. */
export function projectCl1Calls(episodes: number): number {
  const n = Math.max(0, Math.floor(episodes));
  return n === 0 ? 0 : cl1Batches(new Array<null>(n).fill(null)).length;
}

/**
 * Run P-CL1 over a set of episodes.
 *
 * Batched at §12.4's cap, fanned out at `parallelism`, and APPLIED SERIALIZED in
 * input order — the property that makes the graph confluent (item 3.1).
 *
 * A batch whose call returned null, or whose answer parsed to nothing at all,
 * is an ERROR on the report. That distinction is the whole point: "the model
 * found no claims here" is `records > 0` with empty buckets, and "the call
 * never happened" is not the same fact and must never read like it.
 */
export async function runCl1ForEpisodes(
  episodeIds: readonly string[],
  opts: Cl1RunOptions = {},
): Promise<Cl1Report> {
  const report = emptyReport();
  const now = opts.now ?? Date.now();
  const cap = typeof opts.maxCalls === "number" && opts.maxCalls >= 0 ? Math.floor(opts.maxCalls) : Number.MAX_SAFE_INTEGER;

  const episodes = episodeIds
    .map((id) => readEpisode(id))
    .filter((ep): ep is EpisodeRow => ep !== null && ep.streamId !== null && ep.eventIds.length > 0);
  report.episodes = episodes.length;
  if (episodes.length === 0) return report;

  const batches = cl1Batches(episodes);
  report.batches = batches.length;

  // THE ONE SPEND GATE. Every P-CL1 and every P-AG3 call in this run passes
  // through it, and it refuses rather than overspends.
  const spend = (): boolean => {
    if (report.calls >= cap) return false;
    report.calls += 1;
    return true;
  };

  // What the transports really billed, charged to the SAME counter the gate
  // reads. One invocation is charged by `spend()` above; a repair round and
  // every transport retry are separate provider calls and separate money, and a
  // stage that reports invocations hands `bootstrap.ts` half the true number to
  // charge its budget with. Adding it here rather than after the fan-out keeps
  // the gate honest mid-run and is safe under `extractInParallel` — it is a sum
  // of per-call excesses, never a snapshot difference. An injected `invoke`
  // observes nothing and correctly stays at one.
  const observe: Cl1Observer = (outcome) => {
    report.calls += Math.max(0, outcome.providerCalls - 1);
    // A partial is NOT an error and is deliberately not pushed onto `errors`:
    // the answer is being applied, and `drainExtractQueue` reads a non-empty
    // `errors` as "this batch was lost" and buys the whole batch again. Paying
    // twice for lines that are already on disk is not visibility, it is spend.
    // It is loud on its own counter and in the log instead.
    if (outcome.partial !== null) {
      report.partialAnswers += 1;
      report.quarantinedLines += outcome.partial.lines;
      log(
        `WARN partial answer — ${outcome.partial.records} line(s) applied, ` +
          `${outcome.partial.lines} quarantined (${outcome.partial.reason ?? "violations"}` +
          `${outcome.partial.quarantineId === null ? "" : `, quarantine=${outcome.partial.quarantineId}`})`,
      );
    }
    if (outcome.error !== null) report.errors.push(`${outcome.error.code}: ${outcome.error.message}`);
  };
  const transport = { cohortId: opts.cohortId ?? null, observe, ...(opts.deps === undefined ? {} : { deps: opts.deps }) };
  /**
   * One transport PER BATCH, so the `quarantine` row names the unit it parked —
   * `ti1-runner.ts` names a batch by its first unit and this follows it. A
   * shared transport left `unit_id = '-'` on every parked row, and a
   * quarantined line nobody can trace back to an episode is not replayable.
   * That was survivable while a quarantine voided the whole answer and the
   * batch was retried wholesale; now that the answer is applied and the LINE is
   * what stays parked, the row has to say which episode lost it.
   */
  const invokeFor = (batch: readonly EpisodeRow[]): AsyncPromptInvoke =>
    opts.invoke ?? cl1RunnerInvoke({ ...transport, unitId: batch[0]?.id ?? "-" });
  const ag3 = opts.ag3 ?? ag3RunnerInvoke(transport);

  interface BatchResult {
    ctx: Cl1Context;
    answer: Cl1Answer;
  }

  const slots = await extractInParallel<EpisodeRow[], BatchResult | null>(
    batches,
    async (batch) => {
      const ctx = buildCl1Call(batch);
      if (ctx === null) throw new Error(`prompt could not be built for ${batch.map((e) => e.id).join(",")}`);
      if (!spend()) return null;
      const response = await invokeFor(batch)({
        system: ctx.prompt.system,
        user: ctx.prompt.user,
        model: P_CL1.model,
      });
      if (response === null) throw new Error(`no response for ${batch.map((e) => e.id).join(",")}`);
      const answer = parseCl1Response(response, ctx.prompt.table);
      if (answer.parse.records.length === 0) {
        // Loud, on purpose. A zero-record answer is either a refusal or a
        // grammar the parser could not see, and BOTH have to be visible.
        throw new Error(
          `unparseable answer for ${batch.map((e) => e.id).join(",")} ` +
            `(${answer.parse.skipped.length} skipped, ${answer.violations.length} violations)`,
        );
      }
      return { ctx, answer };
    },
    Math.max(1, Math.floor(opts.parallelism ?? 4)),
  );

  // Apply serialized, in INPUT order — never in completion order.
  for (const slot of slots) {
    if (!slot.ok) {
      report.errors.push(slot.error?.message ?? "unknown extraction failure");
      continue;
    }
    if (slot.value === null || slot.value === undefined) {
      report.skipped += batches[slot.index]?.length ?? 0;
      continue;
    }
    const { ctx, answer } = slot.value;
    // THE COUNTERS BELONG TO THE CALLER, and they are folded in a `finally`.
    // `applyCl1Answer` writes rows as it goes; a throw on its way out used to
    // discard the whole batch's counters along with the frame, which is how a
    // run logged `claims=0+0 loops=0` with 13 claims and 20 evidence rows
    // already committed to disk. Work that reached the database is reported
    // whether or not the batch finished — and the error is reported too.
    const part = emptyApply();
    try {
      await applyCl1Answer(
        answer,
        ctx,
        {
          now,
          runId: opts.runId ?? null,
          cohortId: opts.cohortId ?? null,
          ag3,
          ...(opts.scoreNearHits === undefined ? {} : { scoreNearHits: opts.scoreNearHits }),
          spend,
        },
        part,
      );
    } catch (err) {
      part.errors.push(`apply(${ctx.episodes.map((e) => e.id).join(",")}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      fold(report, part);
    }
  }

  log(
    `episodes=${report.episodes} batches=${report.batches} calls=${report.calls} ` +
      `claims=${report.claimsWritten}+${report.claimsReinforced} loops=${report.loopsWritten} ` +
      `unsupported=${report.unsupported} refused=${report.claimsRefused} ` +
      `unresolved=${report.unresolvedRefs} partial=${report.partialAnswers}/${report.quarantinedLines} ` +
      `errors=${report.errors.length}`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// The queue: episodes in, claims and loops out
// ---------------------------------------------------------------------------

/**
 * Episodes with no extraction yet — the catch-up query.
 *
 * "Extracted" is a property of the ROWS: an episode whose events carry no
 * `evidence` row is one nothing has been read out of. It is derived, never
 * remembered, so a kill -9 mid-cohort costs the in-flight batch and nothing
 * else (§9.7 rule 5), and the `work_queue` `done` state carries the rest.
 */
export function pendingExtractionEpisodes(opts: { limit?: number; sessionIds?: readonly string[] } = {}): string[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 500));
  const db = getDb();
  const scoped = opts.sessionIds !== undefined;
  const ids = scoped ? [...new Set((opts.sessionIds ?? []).flatMap((s) => readEpisodesOfSession(s)))] : [];
  if (scoped && ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT e.id AS id
         FROM episodes e
        WHERE ${scoped ? `e.id IN (${marks(ids.length)}) AND` : ""}
              NOT EXISTS (SELECT 1 FROM evidence v WHERE v.episode_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM work_queue w
                           WHERE w.stage = 'extract' AND w.unit_kind = 'episode'
                             AND w.unit_id = e.id AND w.state = 'done')
        ORDER BY COALESCE(e.ended_at, e.started_at) DESC, e.id
        LIMIT ?`,
    )
    .all(...(scoped ? ids : []), limit) as { id: string }[];
  return rows.map((r) => r.id);
}

/** §9.3 priority for one episode, off its stream's tier and its recency. */
function episodePriority(episodeId: string, now: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(e.ended_at, e.started_at) AS ts_hi, st.tier AS tier
         FROM episodes e LEFT JOIN streams st ON st.id = e.stream_id
        WHERE e.id = ?`,
    )
    .get(episodeId) as { ts_hi: string | null; tier: string | null } | undefined;
  const rawTier = row?.tier;
  const tier: Tier = isTier(rawTier) ? rawTier : "T3";
  const ts = row?.ts_hi ?? now;
  return computePriority({ tier, horizon: horizonFor(ts, now), ts, now });
}

/** Put episodes on the shared queue at stage `extract`. A `done` row is left alone. */
export function enqueueExtractions(
  episodeIds: readonly string[],
  opts: { cohortId?: string | null; now?: number } = {},
): EnqueueOutcome[] {
  const now = opts.now ?? Date.now();
  return episodeIds.map((episodeId) =>
    enqueueWork({
      unitKind: "episode",
      unitId: episodeId,
      stage: "extract",
      priority: episodePriority(episodeId, now),
      cohortId: opts.cohortId ?? null,
    }),
  );
}

/**
 * Work the `extract` stage of the queue, highest priority first. Units whose
 * batch failed are put back with a retry ticket rather than marked done —
 * failing loudly and losing the work are different things.
 */
export async function drainExtractQueue(
  opts: Cl1RunOptions & { limit?: number } = {},
): Promise<Cl1Report> {
  const now = opts.now ?? Date.now();
  const items = claimWork({
    stages: ["extract"],
    // EPISODE UNITS ONLY. The `extract` stage also carries SESSION units — the
    // live delta (scheduler/live.ts) and the pass-2 completion
    // (media/enrich-pass.ts) — and claiming by stage alone hands their session
    // ids to `runCl1ForEpisodes` as episode ids, which retries them forever.
    unitKinds: ["episode"],
    limit: Math.max(1, Math.floor(opts.limit ?? 8)),
    nowIso: new Date(now).toISOString(),
  });
  if (items.length === 0) return emptyReport();
  const report = await runCl1ForEpisodes(items.map((i) => i.unitId), opts);
  const failed = report.errors.length > 0 || report.skipped > 0;
  // A pass that refused claims for want of an identity is not a pass that
  // FINISHED. `pendingExtractionEpisodes` skips any unit this queue marked
  // `done`, so marking one done while identity binding was still empty would
  // retire that episode permanently — its claims would never be extracted
  // again, no matter how good the roster later became. It goes back for one
  // more try instead, on an hour's backoff and BOUNDED by attempts, because a
  // re-extraction costs a real P-CL1 call and a loop that never converges is
  // its own bug.
  const unbound = !failed && report.claimsRefused > 0;
  for (const item of items) {
    if (failed) failWork(item.id, { action: "retry", notBeforeAt: new Date(now + 60_000).toISOString() });
    else if (unbound && item.attempts < IDENTITY_ATTEMPTS) {
      failWork(item.id, { action: "retry", notBeforeAt: new Date(now + 3_600_000).toISOString() });
    } else completeWork(item.id);
  }
  return report;
}

/** How many times an episode may wait for identity binding before it is retired. */
const IDENTITY_ATTEMPTS = 2;

/**
 * The `deps.extract` seam `scheduler/bootstrap.ts` declared and left unfilled —
 * and which `startBootstrapDriver` now fills with this by default.
 *
 * Reports the model calls spent (BILLED, retries included), which the tick
 * charges to the same wallet every other stage draws on, and hands the failures
 * back rather than only logging them: a stage whose every call died and a stage
 * that found nothing to say are the same `0` on a report that cannot see them.
 */
export function cl1ExtractStage(
  opts: Omit<Cl1RunOptions, "maxCalls" | "now" | "cohortId"> = {},
): (input: {
  cohort: Cohort;
  sessionIds: readonly string[];
  budget: number;
  now: number;
}) => Promise<ExtractOutcome> {
  return async ({ cohort, sessionIds, budget, now }) => {
    const episodes = pendingExtractionEpisodes({ sessionIds });
    if (episodes.length === 0) return { calls: 0, errors: [] };
    enqueueExtractions(episodes, { cohortId: cohort.id, now });
    const report = await drainExtractQueue({
      ...opts,
      now,
      cohortId: cohort.id,
      runId: cohort.id,
      maxCalls: budget,
      limit: episodes.length,
    });
    for (const error of report.errors) log(`ERROR cohort=${cohort.id} — ${error}`);
    // A partially applied answer is neither an error nor a clean run. The rows
    // it produced are real and the lines it lost are parked in `quarantine`,
    // replayable — but a claim count that quietly understates the corpus is the
    // defect this stage keeps re-learning, so the shortfall is said out loud
    // rather than left to be inferred.
    if (report.partialAnswers > 0) {
      log(
        `WARN cohort=${cohort.id} — ${report.partialAnswers} answer(s) applied in part; ` +
          `${report.quarantinedLines} line(s) quarantined and NOT written`,
      );
    }
    // A refusal is not an error and is not reported as one — no call failed and
    // nothing was lost. It IS the difference between "this history had nothing
    // to say" and "nobody in it has been identified yet", so it is said out
    // loud rather than left to be inferred from a claim count.
    if (report.claimsRefused > 0) {
      log(
        `WARN cohort=${cohort.id} — ${report.claimsRefused} claim(s) refused for want of a subject; ` +
          `identity binding has not reached ${report.unresolvedRefs} reference(s) in these episodes`,
      );
    }
    return { calls: report.calls, errors: report.errors };
  };
}
