// ===========================================================================
// [LIVE] The two-call cache measurement — V6 open question 6, Build V6 P1 §9
// item 3 ("`cache_read_input_tokens` from the two-call test").
//
// The engaged S4.4 fallback sends ONE pack twice: `runLiveUnderstanding`
// (orient) then `runLiveDecide` (live-decide.v1) over the same bundle. The
// open question is whether the second call READS the cache the first created,
// i.e. whether the CLI holds a persistent cached session across two
// invocations in one lane.
//
// This script answers it with the real provider and exactly TWO `claude`
// calls. It reports, per call, the four token columns the runs ledger keeps —
// input · cache_create · cache_read · output — and the verdict:
//
//   cache_read on call 2 > 0   the session is cached across calls; the
//                              two-call fallback costs ~1 pack, not 2.
//   cache_read on call 2 = 0   each invocation re-reads the whole pack; the
//                              fallback costs two full packs (P3 decision).
//
// ISOLATED BY CONSTRUCTION: runs inside `establishEvalHome()`, which refuses
// to touch ~/SuperTwinV13 (the same rail `npm run eval` uses). Zero writes to
// any real home; the temp home is deleted on the way out.
//
//   npx tsx worker/src/evals/two-call-cache.ts [--id LIV-01] [--json FILE]
//
// Exit codes: 0 measured · 1 the calls did not complete · 3 setup failed.
// ===========================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLiveDecide, runLiveUnderstanding } from "../brain/live.js";
import { getDb, runMigrations } from "../db/connection.js";
import { registerProductExecutors } from "./executors/index.js";
import { establishEvalHome } from "./home.js";
import { cleanupLiv, LIV_NOW_ISO, seedLiv } from "./executors/liv.js";

export interface CallTokens {
  pass: string;
  model: string | null;
  status: string | null;
  inputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  outputTokens: number;
  costUsd: number;
}

export interface TwoCallMeasurement {
  fixture: string;
  calls: CallTokens[];
  /** cache_read on the SECOND call — the number the open question turns on. */
  secondCallCacheRead: number | null;
  /** True when call 2 read anything the pack put in the cache. */
  sessionCachedAcrossCalls: boolean | null;
  totalInputTokens: number;
  totalCacheRead: number;
  totalCostUsd: number;
  verdict: string;
}

/** The verdict line, kept pure so the shape is assertable without a call. */
export function verdictFor(calls: readonly CallTokens[]): TwoCallMeasurement["verdict"] {
  if (calls.length < 2) return "INCONCLUSIVE — fewer than two calls completed";
  const second = calls[1]!;
  if (second.cacheRead > 0) {
    return (
      `CACHED ACROSS CALLS — call 2 read ${second.cacheRead} cached input tokens; ` +
      `the two-call fallback costs about one pack, not two`
    );
  }
  return (
    "NOT CACHED ACROSS CALLS — call 2 read 0 cached input tokens; each invocation " +
    "pays for the whole pack (V6 open question 6 answers 'no persistent session' on this CLI)"
  );
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export async function measureTwoCall(fixtureId = "LIV-01"): Promise<TwoCallMeasurement> {
  const fixturePath = resolve(repoRoot(), "evals", "v13", `${fixtureId}.json`);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    setup?: Record<string, unknown>;
  };
  const nowMs = Date.parse(LIV_NOW_ISO);
  const seeded = seedLiv(fixtureId, fixture.setup ?? {}, nowMs);

  const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
  try {
    // The REAL provider — no deps override. Exactly two calls.
    const run = await runLiveUnderstanding(seeded.bundle, {}, { nowMs });
    await runLiveDecide(run, {}, { commit: null });
  } finally {
    // Read the ledger even if the second call failed: a partial measurement is
    // still a measurement, and the verdict says so.
  }

  const rows = getDb()
    .prepare(
      `SELECT pass, model, status, input_tokens, cache_create, cache_read, output_tokens, cost_usd
         FROM runs ORDER BY rowid LIMIT -1 OFFSET ?`,
    )
    .all(before) as {
    pass: string;
    model: string | null;
    status: string | null;
    input_tokens: number | null;
    cache_create: number | null;
    cache_read: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
  }[];

  const calls: CallTokens[] = rows.map((r) => ({
    pass: r.pass,
    model: r.model,
    status: r.status,
    inputTokens: r.input_tokens ?? 0,
    cacheCreate: r.cache_create ?? 0,
    cacheRead: r.cache_read ?? 0,
    outputTokens: r.output_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
  }));

  cleanupLiv(seeded);

  const second = calls[1] ?? null;
  return {
    fixture: fixtureId,
    calls,
    secondCallCacheRead: second ? second.cacheRead : null,
    sessionCachedAcrossCalls: second ? second.cacheRead > 0 : null,
    totalInputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    totalCacheRead: calls.reduce((a, c) => a + c.cacheRead, 0),
    totalCostUsd: calls.reduce((a, c) => a + c.costUsd, 0),
    verdict: verdictFor(calls),
  };
}

export function renderTwoCall(m: TwoCallMeasurement): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`TWO-CALL CACHE MEASUREMENT — ${m.fixture} (V6 open question 6)`);
  lines.push("");
  lines.push("  #  pass                 status    input  cache_create  cache_read  output      $");
  m.calls.forEach((c, i) => {
    lines.push(
      `  ${i + 1}  ${c.pass.padEnd(20)} ${String(c.status ?? "?").padEnd(9)} ` +
        `${String(c.inputTokens).padStart(5)}  ${String(c.cacheCreate).padStart(12)}  ` +
        `${String(c.cacheRead).padStart(10)}  ${String(c.outputTokens).padStart(6)}  ${c.costUsd.toFixed(5)}`,
    );
  });
  lines.push("");
  lines.push(`  total input ${m.totalInputTokens} · total cache_read ${m.totalCacheRead} · $${m.totalCostUsd.toFixed(5)}`);
  lines.push(`  ${m.verdict}`);
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let id = "LIV-01";
  let jsonOut: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--id") id = argv[++i] ?? id;
    else if (argv[i] === "--json") jsonOut = argv[++i] ?? null;
    else {
      console.error(`unknown flag: ${argv[i]}`);
      process.exit(3);
    }
  }
  const home = establishEvalHome();
  console.error(`two-call-cache: home ${home.home}${home.ephemeral ? " (temporary)" : ""}`);
  try {
    // Same setup the CLI does (cli.ts): the schema, the REAL provider in the
    // registry — without it every pass resolves nothing, retries its repair
    // round and quarantines with zero tokens, which looks exactly like a
    // measured "no cache" and is not one — then the containment chokepoint
    // that refuses a production DB and opens the consent gate.
    runMigrations();
    const { bootstrapBuiltInProviders } = await import("../providers/bootstrap.js");
    bootstrapBuiltInProviders();
    await registerProductExecutors();
    const m = await measureTwoCall(id);
    console.log(renderTwoCall(m));
    if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(m, null, 2)}\n`);
    process.exitCode = m.calls.length >= 2 ? 0 : 1;
  } finally {
    home.dispose();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`two-call-cache: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
