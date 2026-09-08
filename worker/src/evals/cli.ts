// ===========================================================================
// [CODE] `npm run eval` — the entry point for the V13 golden set (build P0.9).
//
//   npm run eval                          every fixture in evals/v13 (live)
//   npm run eval -- --cat ROL,BND         only those categories
//   npm run eval -- --id ROL-01           one case
//   npm run eval -- --dir evals/v13/selftest --judge stub
//   npm run eval -- --liveness            TRC-03 pass-liveness job
//   npm run eval -- --materialize         re-emit evals/v13 from the docs
//   npm run eval -- --mode code           only deterministic cases (zero model calls)
//   npm run eval -- --baseline            print the frozen evals/baseline/v13.json
//   npm run eval -- ... --compare-baseline fail when a category scores below its
//                       frozen rate (GoldenEvals V6P1 §3.1 "ORIENT >= baseline")
//   npm run eval -- ... --ast-parity      after the run, check that every assertion
//                       the retiring assist/ lane proved has a green home among the
//                       V6 cases (Build V6 P1 §7.3 ship-gate item 2)
//   npm run eval -- ... --record-baseline merge this run's tallies into that file
//                       [--calls-log FILE | --model-calls N] [--note "..."]
//                       (--calls-log: a file a CLAUDE_BIN counting shim appends one
//                        line to per invocation; the run records the line delta)
//
// ISOLATED BY CONSTRUCTION: a fixture run gets its OWN home (a temp
// SUPERTWIN_HOME, printed at the top of the report) and refuses to start when
// the environment points at ~/SuperTwinV13 — see evals/home.ts for the leak
// this closes. `--allow-production-home` waives it, loudly, for the rare case
// where you actually want fixture data in your own SuperTwin.
//
// LIVE BY CONSTRUCTION: model-facing cases run the real pass, which runs the
// real `claude` CLI, and are graded by the haiku judge. There is no frozen
// mode. Deterministic cases (`mode: "code"`) never touch a model.
//
// Exit codes: 0 clean · 1 a case failed or a hard gate breached ·
//             2 a fixture did not load / coverage short of the docs ·
//             3 the run could not be set up (bad flag).
// ===========================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  baselinePath,
  compareBaseline,
  gitShortSha,
  readBaseline,
  recordBaseline,
  renderBaseline,
  renderCompare,
  writeBaseline,
} from "./baseline.js";
import { registerProductExecutors } from "./executors/index.js";
import { coverageGaps, FIXTURE_MODES, loadDirectory, type Fixture, type FixtureMode } from "./fixtures.js";
import { ALLOW_PRODUCTION_FLAG, establishEvalHome, EvalHomeLeakError } from "./home.js";
import { haikuJudge, stubJudge, type Judge } from "./judge.js";
import { assessLiveness, collectRunCounts, renderLiveness } from "./liveness.js";
import { assessAstParity, renderAstParity } from "./parity.js";
import { materialize } from "./materialize.js";
import { renderReport, verdict } from "./report.js";
import { runSuite } from "./runner.js";

export interface CliOptions {
  dir: string;
  cats: string[] | null;
  ids: string[] | null;
  judge: "haiku" | "stub" | "none";
  hideNoDataGates: boolean;
  checkCoverage: boolean;
  /** Also fail on a pending case or an unmeasured hard gate. */
  strict: boolean;
  liveness: boolean;
  materialize: boolean;
  /** Waive the eval-home boundary and seed fixtures into ~/SuperTwinV13. */
  allowProductionHome: boolean;
  /** Only cases of this mode (`code` = zero model calls). null = both. */
  mode: FixtureMode | null;
  /** Print evals/baseline/v13.json and exit. */
  baseline: boolean;
  /** After the run, merge this run's per-category tallies into the baseline file. */
  recordBaseline: boolean;
  /** After the run, fail when a selected category scored below its frozen rate. */
  compareBaseline: boolean;
  /** After the run, print + assert the AST→V6 parity ledger (§7.3 item 2). */
  astParity: boolean;
  /** Operator-counted `claude` invocations for --record-baseline; null = not counted. */
  modelCalls: number | null;
  /** File that grows one line per `claude` invocation; the run records its line delta. */
  callsLog: string | null;
  /** Free-text method note stored with the recorded run. */
  note: string | null;
}

export function repoRoot(): string {
  // worker/src/evals -> worker/src -> worker -> repo root (same shape in dist/).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    dir: process.env.EVAL_FIXTURES ?? resolve(repoRoot(), "evals", "v13"),
    cats: null,
    ids: null,
    judge: "haiku",
    hideNoDataGates: false,
    checkCoverage: true,
    strict: false,
    liveness: false,
    materialize: false,
    allowProductionHome: false,
    mode: null,
    baseline: false,
    recordBaseline: false,
    compareBaseline: false,
    astParity: false,
    modelCalls: null,
    callsLog: null,
    note: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--cat":
      case "--only":
        options.cats = next()
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        options.checkCoverage = false;
        break;
      case "--id":
        options.ids = next()
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        options.checkCoverage = false;
        break;
      case "--dir":
        options.dir = resolve(process.cwd(), next());
        options.checkCoverage = false;
        break;
      case "--judge": {
        const judge = next();
        if (judge !== "haiku" && judge !== "stub" && judge !== "none") {
          throw new Error(`--judge must be haiku|stub|none, got ${judge}`);
        }
        options.judge = judge;
        break;
      }
      case "--measured":
        options.hideNoDataGates = true;
        break;
      case "--no-coverage":
        options.checkCoverage = false;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--liveness":
        options.liveness = true;
        break;
      case "--materialize":
        options.materialize = true;
        break;
      case "--mode": {
        const mode = next();
        if (!(FIXTURE_MODES as readonly string[]).includes(mode)) {
          throw new Error(`--mode must be ${FIXTURE_MODES.join("|")}, got ${mode}`);
        }
        options.mode = mode as FixtureMode;
        options.checkCoverage = false;
        break;
      }
      case "--baseline":
        options.baseline = true;
        break;
      case "--record-baseline":
        options.recordBaseline = true;
        break;
      case "--compare-baseline":
        options.compareBaseline = true;
        break;
      case "--ast-parity":
        options.astParity = true;
        break;
      case "--model-calls": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0) throw new Error("--model-calls needs a non-negative integer");
        options.modelCalls = n;
        break;
      }
      case "--calls-log":
        options.callsLog = resolve(process.cwd(), next());
        break;
      case "--note":
        options.note = next();
        break;
      case ALLOW_PRODUCTION_FLAG:
        options.allowProductionHome = true;
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  if (options.callsLog !== null && options.modelCalls !== null) {
    throw new Error("--calls-log and --model-calls are exclusive");
  }
  return options;
}

/** Lines in a file (0 when it does not exist yet). */
export function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.split("\n").filter((l) => l.length > 0).length;
}

export function selectFixtures(fixtures: readonly Fixture[], options: CliOptions): Fixture[] {
  // Self-test fixtures (evals/v13/selftest/) prove the harness, not the
  // product: they run only when the load found nothing else — i.e. when their
  // directory was targeted with --dir.
  const onlySelftest = fixtures.every((f) => f.selftest === true);
  return fixtures.filter((f) => {
    if (f.selftest && !onlySelftest) return false;
    if (options.cats && !options.cats.includes(f.category)) return false;
    if (options.ids && !options.ids.includes(f.id)) return false;
    if (options.mode && f.mode !== options.mode) return false;
    return true;
  });
}

async function runLiveness(out: (line: string) => void): Promise<number> {
  // Deliberately NOT sandboxed, and the one path that isn't: TRC-03 asks
  // whether every pass has run IN PRODUCTION inside the window, so it must
  // read the production home the DB module resolves on its own. It is a pure
  // count over extraction_runs — it registers no executors and seeds nothing,
  // which is why it is safe where a fixture run is not.
  const { getDb } = await import("../db/connection.js");
  const counts = collectRunCounts(getDb());
  const report = assessLiveness(counts);
  out(renderLiveness(report));
  return report.ok ? 0 : 1;
}

export async function main(argv: readonly string[], out: (line: string) => void = console.log): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    out(`eval: ${(err as Error).message}`);
    return 3;
  }

  if (options.materialize) {
    try {
      const result = materialize(repoRoot());
      out(`eval: materialized ${result.written.length} fixtures into evals/v13/`);
      return 0;
    } catch (err) {
      out(`eval: materialize failed — ${(err as Error).message}`);
      return 2;
    }
  }

  if (options.liveness) return runLiveness(out);

  if (options.baseline) {
    const path = baselinePath(repoRoot());
    let file;
    try {
      file = readBaseline(path);
    } catch (err) {
      out(`eval: ${(err as Error).message}`);
      return 2;
    }
    if (!file) {
      out(`eval: no baseline at ${path} — record one with \`npm run eval -- --record-baseline\``);
      return 2;
    }
    out(renderBaseline(file, path));
    return 0;
  }

  const loaded = loadDirectory(options.dir);
  if (loaded.errors.length > 0) {
    out(`eval: ${loaded.errors.length} fixture(s) failed validation in ${options.dir}`);
    for (const error of loaded.errors) out(error.message);
    return 2;
  }
  if (loaded.fixtures.length === 0) {
    out(`eval: no fixtures found in ${options.dir}`);
    return 2;
  }
  if (options.checkCoverage) {
    const gaps = coverageGaps(loaded.fixtures);
    if (gaps.length > 0) {
      out("eval: fixture coverage does not match the eval docs");
      for (const gap of gaps) out(`  - ${gap}`);
      return 2;
    }
  }

  // ISOLATION FIRST — before a single executor is wired, let alone run. The
  // fixture seeds write through getDb(), so the data root has to be pointed
  // somewhere disposable BEFORE anything can touch it.
  let home;
  try {
    home = establishEvalHome({ allowProductionHome: options.allowProductionHome });
  } catch (err) {
    if (err instanceof EvalHomeLeakError) {
      out(`eval: ${err.message}`);
      return 3;
    }
    throw err;
  }
  out(
    home.production
      ? `eval: ${ALLOW_PRODUCTION_FLAG} — seeding fixtures into your REAL home ${home.dbPath}`
      : `eval home: ${home.home}${home.ephemeral ? " (temporary, deleted after the run)" : ""}`,
  );

  try {
    // Live-by-construction: the passes resolve the default provider from the
    // registry exactly as production does, so the CLI performs production's
    // registration step (worker/src/index.ts does the same at boot).
    const { bootstrapBuiltInProviders } = await import("../providers/bootstrap.js");
    bootstrapBuiltInProviders();

    await registerProductExecutors();

    let judge: Judge | undefined;
    if (options.judge === "haiku") judge = haikuJudge();
    else if (options.judge === "stub") judge = stubJudge;

    const callsBefore = options.callsLog ? countLines(options.callsLog) : 0;
    const suite = await runSuite(selectFixtures(loaded.fixtures, options), { judge });
    out(renderReport(suite, options.dir, { hideNoDataGates: options.hideNoDataGates }));

    // The compare reads the file AS IT WAS before this run's --record-baseline
    // merge (a run recorded on top of itself would always read "ok").
    let compareError: string | null = null;
    let frozen = null;
    if (options.compareBaseline) {
      try {
        frozen = readBaseline(baselinePath(repoRoot()));
      } catch (err) {
        compareError = (err as Error).message;
      }
    }

    if (options.recordBaseline) {
      const path = baselinePath(repoRoot());
      const previous = readBaseline(path);
      const modelCalls = options.callsLog ? countLines(options.callsLog) - callsBefore : options.modelCalls;
      const file = recordBaseline(previous, suite, {
        git: gitShortSha(repoRoot()),
        argv,
        modelCalls,
        ...(options.note ? { note: options.note } : {}),
      });
      writeBaseline(path, file);
      out("");
      out(
        `eval: recorded ${suite.categories.length} category tally(ies) into ${path} (model calls: ${modelCalls ?? "not counted"})`,
      );
    }

    let ok = verdict(suite).ok;
    if (options.compareBaseline) {
      if (compareError) {
        out(`eval: ${compareError}`);
        ok = false;
      }
      const compare = compareBaseline(frozen, suite);
      out("");
      out(renderCompare(compare, baselinePath(repoRoot())));
      if (!compare.ok) ok = false;
    }
    if (options.astParity) {
      // §7.3 item 2. Static gaps are read off the WHOLE corpus (a home that
      // does not exist is a gap however the run was selected); the pass/fail
      // half is read off the cases this run actually measured.
      const parity = assessAstParity(suite.results, loaded.fixtures.map((f) => f.id));
      out("");
      out(renderAstParity(parity));
      if (!parity.ok) ok = false;
    }
    if (options.strict) {
      const unmeasured = suite.gates.filter((g) => g.hard && g.status === "no_data").length;
      if (suite.totals.pending > 0 || unmeasured > 0) {
        out(`eval --strict: ${suite.totals.pending} pending case(s), ${unmeasured} unmeasured hard gate(s)`);
        ok = false;
      }
    }
    return ok ? 0 : 1;
  } finally {
    home.dispose();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`eval: ${(err as Error).stack ?? String(err)}`);
      process.exitCode = 3;
    });
}
