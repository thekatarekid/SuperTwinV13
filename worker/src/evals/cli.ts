// ===========================================================================
// [CODE] `npm run eval` — the CI entry point for the golden set (item 0.6).
//
//   npm run eval                        frozen mode, evals/fixtures, all cases
//   npm run eval -- --dir evals/selftest --measured
//   npm run eval -- --only M,N --max-diff-lines 20
//   npm run eval -- --live --live-module ./my-invoker.js
//
// FROZEN MODE MAKES NO NETWORK CALL. That is not a convention here, it is
// enforced: the guard below replaces fetch, net.connect, tls.connect and
// http(s).request with functions that throw. If any executor ever reaches for
// the network in CI, the case fails loudly instead of quietly going online.
//
// Exit codes: 0 clean · 1 a case failed or a §14.2 gate was breached ·
//             2 a fixture did not load or coverage is short of §4 ·
//             3 the run could not be set up (bad flag, live with no invoker).
// ===========================================================================

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

// Side-effect import: registers the executors that drive real product code.
// Without it every category would be PENDING, which is the runner's correct
// behaviour and the wrong thing for the CI entry point to report.
import "./executors/index.js";
import { coverageGaps, loadDirectory, TOTAL_CASES, type Fixture } from "./fixtures.js";
import { renderReport, verdict } from "./report.js";
import { runSuite, type EvalMode, type LiveInvoker } from "./runner.js";

export interface CliOptions {
  mode: EvalMode;
  dir: string;
  only: string[] | null;
  ids: string[] | null;
  hideNoDataGates: boolean;
  maxDiffLines: number;
  checkCoverage: boolean;
  liveModule: string | null;
  /** Also fail on a pending case or an unmeasured gate. For the day the layers land. */
  strict: boolean;
}

export function repoRoot(): string {
  // worker/src/evals -> worker/src -> worker -> repo root (same shape in dist/).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "frozen",
    dir: process.env.EVAL_FIXTURES ?? resolve(repoRoot(), "evals", "fixtures"),
    only: null,
    ids: null,
    hideNoDataGates: false,
    maxDiffLines: 0,
    checkCoverage: true,
    liveModule: null,
    strict: false,
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
      case "--frozen":
        options.mode = "frozen";
        break;
      case "--live":
        options.mode = "live";
        break;
      case "--dir":
        options.dir = resolve(process.cwd(), next());
        options.checkCoverage = false;
        break;
      case "--only":
        options.only = next()
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
      case "--measured":
        options.hideNoDataGates = true;
        break;
      case "--max-diff-lines":
        options.maxDiffLines = Number(next());
        break;
      case "--no-coverage":
        options.checkCoverage = false;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--live-module":
        options.liveModule = next();
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return options;
}

type Restore = () => void;

/**
 * Replaces every outbound transport with a thrower. Returns the undo, so tests
 * can prove the guard bites and then put the process back.
 */
export function installOfflineGuard(): Restore {
  const boom = (what: string) => (): never => {
    throw new Error(`offline eval run attempted a network call via ${what}`);
  };
  const g = globalThis as { fetch?: unknown };
  const originals = {
    fetch: g.fetch,
    netConnect: net.connect,
    netCreate: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    httpRequest: http.request,
    httpsRequest: https.request,
  };
  g.fetch = boom("fetch");
  (net as { connect: unknown }).connect = boom("net.connect");
  (net as { createConnection: unknown }).createConnection = boom("net.createConnection");
  (net.Socket.prototype as { connect: unknown }).connect = boom("net.Socket.connect");
  (tls as { connect: unknown }).connect = boom("tls.connect");
  (http as { request: unknown }).request = boom("http.request");
  (https as { request: unknown }).request = boom("https.request");
  return () => {
    g.fetch = originals.fetch;
    (net as { connect: unknown }).connect = originals.netConnect;
    (net as { createConnection: unknown }).createConnection = originals.netCreate;
    (net.Socket.prototype as { connect: unknown }).connect = originals.socketConnect;
    (tls as { connect: unknown }).connect = originals.tlsConnect;
    (http as { request: unknown }).request = originals.httpRequest;
    (https as { request: unknown }).request = originals.httpsRequest;
  };
}

export function selectFixtures(fixtures: readonly Fixture[], options: CliOptions): Fixture[] {
  return fixtures.filter((f) => {
    if (options.only && !options.only.includes(f.category)) return false;
    if (options.ids && !options.ids.includes(f.id)) return false;
    return true;
  });
}

async function loadLiveInvoker(modulePath: string): Promise<LiveInvoker> {
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const mod = (await import(url)) as { default?: unknown; invoke?: unknown };
  const candidate = mod.invoke ?? mod.default;
  if (typeof candidate !== "function") {
    throw new Error(`${modulePath} must export a LiveInvoker as \`invoke\` or as its default`);
  }
  return candidate as LiveInvoker;
}

export async function main(argv: readonly string[], out: (line: string) => void = console.log): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    out(`eval: ${(err as Error).message}`);
    return 3;
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
      out(`eval: fixture coverage does not match evals doc §4 (${TOTAL_CASES} cases)`);
      for (const gap of gaps) out(`  - ${gap}`);
      return 2;
    }
  }

  let live: LiveInvoker | undefined;
  if (options.mode === "live") {
    if (!options.liveModule) {
      out(
        "eval: --live needs a model invoker. Pass --live-module <path> exporting a LiveInvoker.\n" +
          "      Frozen mode is the CI mode and needs nothing.",
      );
      return 3;
    }
    try {
      live = await loadLiveInvoker(options.liveModule);
    } catch (err) {
      out(`eval: ${(err as Error).message}`);
      return 3;
    }
  }

  const restore = options.mode === "frozen" ? installOfflineGuard() : null;
  let suite;
  try {
    suite = await runSuite(selectFixtures(loaded.fixtures, options), { mode: options.mode, live });
  } finally {
    restore?.();
  }

  out(
    renderReport(suite, loaded.fixtures, options.dir, {
      hideNoDataGates: options.hideNoDataGates,
      maxDiffLines: options.maxDiffLines,
    }),
  );

  let ok = verdict(suite).ok;
  if (options.strict) {
    const unmeasured = suite.gates.filter((g) => g.status === "no_data").length;
    if (suite.totals.pending > 0 || unmeasured > 0) {
      out(`eval --strict: ${suite.totals.pending} pending case(s), ${unmeasured} unmeasured gate(s)`);
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
