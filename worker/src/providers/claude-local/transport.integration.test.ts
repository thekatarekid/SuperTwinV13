// ===========================================================================
// SPD-04 / SPD-05 (GoldenEvals V6 P1) against the REAL `claude` CLI — S0.4.
//
// ONE live call. It spends money, which is why it is an *.integration.test.ts
// gated exactly like adapter.integration.test.ts: skipped only when the binary
// is absent. It proves what the fake-CLI suites cannot — that the transport
// flags are accepted by the installed CLI and that the bill comes back shaped
// the way stage 1+2 promises:
//   SPD-04  cost per call ≤ $0.006 (wrong: `double-prompt`)
//   SPD-05  cache_create_1h = 0 — the 5-minute TTL is what gets written
//
// MEASURED at S0.4 (claude 2.1.251, model haiku, this exact call, two runs
// 34 s apart):
//   cold   cache_create_5m 21k-ish, 1h 0, cost $0.0266
//   warm   cache_read 17,234 · cache_create_5m 3,979 · 1h 0 · cost $0.0068
// Stage 1+2 gets SPD-05 outright and takes the steady-state call from the
// $0.0286 the backlog measured to $0.0068 (−76%). It does NOT reach the
// ≤ $0.006 fixture target: the 3,979-token write every warm call still pays is
// the CLI's per-call dynamic system-prompt tail, which only stage 3
// (`--system-prompt-file` + `--exclude-dynamic-system-prompt-sections`, T1-3,
// gated by the plan on a full eval pass) removes. So this ONE-call gate asserts
// what stage 1+2 guarantees — no 1-hour writes, and a cost bound that a
// regression to the 1-hour tier (cold ≈ $0.042) or a re-doubled prompt would
// break — and the ≤ $0.006 line stays SPD-04's target for T1-3 to close.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { claudeLocalProvider } from "./index.js";
import { skipWithoutRealCli } from "../../testing/real-cli.js";
import type { ProviderStreamEvent } from "../types.js";

const TURN_TIMEOUT = 120_000;

/**
 * SPD-04's fixture target. Not met by stage 1+2 (see header) — kept here so
 * the gap is a named number, not a forgotten one.
 */
export const SPD04_TARGET_USD = 0.006;
/** What one cold stage-1+2 call costs with headroom; a 1h-tier write breaks it. */
const STAGE_1_2_COLD_CEILING_USD = 0.03;

describe.skipIf(skipWithoutRealCli)("claude-local transport stage 1+2 (real CLI, ONE call)", () => {
  let savedEnforce: string | undefined;
  beforeAll(() => {
    savedEnforce = process.env.SUPERTWIN_TRACE_ENFORCE;
    process.env.SUPERTWIN_TRACE_ENFORCE = "0";
  });
  afterAll(() => {
    if (savedEnforce === undefined) delete process.env.SUPERTWIN_TRACE_ENFORCE;
    else process.env.SUPERTWIN_TRACE_ENFORCE = savedEnforce;
  });

  it(
    "SPD-05 cache_create_1h = 0, and the stage-1+2 cost bound, on one bare pass (SPD-04 target pending T1-3)",
    async () => {
      const events: ProviderStreamEvent[] = [];
      const res = await claudeLocalProvider.send({
        runId: "it-transport-spd",
        message: 'Reply with exactly this JSON and nothing else: {"ok":true}',
        plainCompletion: true,
        // The pipeline's pass model; SPD-04's ≤ $0.006 target (backlog T1-2)
        // was priced on it.
        model: "haiku",
        onEvent: (e) => events.push(e),
      });

      // The evidence a reviewer wants next to the pass/fail — printed FIRST,
      // so a failing assertion still leaves the numbers behind.
      // eslint-disable-next-line no-console
      console.log("[SPD-04/05] usage", JSON.stringify(res.usage), "status", res.status, res.errorCode ?? "");

      expect(res.status).toBe("ok");
      expect(res.usage.outputTokens).toBeGreaterThan(0);

      // SPD-05: nothing written at the 1-hour tier. The wire carries the TTL
      // split whenever a cache write happened; a run with no cache write at
      // all also satisfies the invariant.
      expect(res.usage.cacheCreation1hInputTokens ?? 0).toBe(0);

      // SPD-04: the ledger cost. The CLI prices the run itself
      // (total_cost_usd); the budget ledger records exactly this number. See
      // the header for why the bound is the stage-1+2 one and not the target.
      expect(res.usage.costUsd).toBeDefined();
      expect(res.usage.costUsd as number).toBeLessThanOrEqual(STAGE_1_2_COLD_CEILING_USD);
      if ((res.usage.costUsd as number) > SPD04_TARGET_USD) {
        // eslint-disable-next-line no-console
        console.warn(
          `[SPD-04] $${res.usage.costUsd} > $${SPD04_TARGET_USD} target — expected at stage 1+2; T1-3 closes it`,
        );
      }
    },
    TURN_TIMEOUT,
  );
});
