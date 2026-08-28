// ===========================================================================
// [CODE] `npm run eval` — the entry point for the V13 golden set (build P0.9).
//
//   npm run eval                          every fixture in evals/v13 (live)
//   npm run eval -- --cat ROL,BND         only those categories
//   npm run eval -- --id ROL-01           one case
//   npm run eval -- --dir evals/v13/selftest --judge stub
//   npm run eval -- --liveness            TRC-03 pass-liveness job
//   npm run eval -- --materialize         re-emit evals/v13 from the docs
//
// LIVE BY CONSTRUCTION: model-facing cases run the real pass, which runs the
// real `claude` CLI, and are graded by the haiku judge. There is no frozen
// mode. Deterministic cases (`mode: "code"`) never touch a model.
//
// Exit codes: 0 clean · 1 a case failed or a hard gate breached ·
//             2 a fixture did not load / coverage short of the docs ·
//             3 the run could not be set up (bad flag).
// ===========================================================================

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerProductExecutors } from "./executors/index.js";
import { coverageGaps, loadDirectory, type Fixture } from "./fixtures.js";
import { haikuJudge, stubJudge, type Judge } from "./judge.js";
import { assessLiveness, collectRunCounts, renderLiveness } from "./liveness.js";
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
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return options;
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
    return true;
  });
}

async function runLiveness(out: (line: string) => void): Promise<number> {
  // The DB module resolves the production home (SUPERTWIN_HOME) itself.
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

  // Live-by-construction: the passes resolve the default provider from the
  // registry exactly as production does, so the CLI performs production's
  // registration step (worker/src/index.ts does the same at boot).
  const [{ register }, { claudeLocalProvider }] = await Promise.all([
    import("../providers/registry.js"),
    import("../providers/claude-local/index.js"),
  ]);
  register(claudeLocalProvider);

  await registerProductExecutors();

  let judge: Judge | undefined;
  if (options.judge === "haiku") judge = haikuJudge();
  else if (options.judge === "stub") judge = stubJudge;

  const suite = await runSuite(selectFixtures(loaded.fixtures, options), { judge });
  out(renderReport(suite, options.dir, { hideNoDataGates: options.hideNoDataGates }));

  let ok = verdict(suite).ok;
  if (options.strict) {
    const unmeasured = suite.gates.filter((g) => g.hard && g.status === "no_data").length;
    if (suite.totals.pending > 0 || unmeasured > 0) {
      out(`eval --strict: ${suite.totals.pending} pending case(s), ${unmeasured} unmeasured hard gate(s)`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
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
