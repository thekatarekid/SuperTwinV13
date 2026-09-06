// ===========================================================================
// [CODE] The golden gate — a model or reasoning change on a step RUNS THE
// GOLDEN SET FIRST; a regression blocks the switch (Product_V6 §9.5 / §25
// Intelligence, §18; GoldenEvals V6 P1 SET-02; V6 P1 S5.6).
//
// Shape:
//
//   Settings › Intelligence picks a model  → proposeStepChange(candidate)
//     no runner installed                  → applied at once, gate "skipped"
//                                            (the reason is on the record)
//     runner installed                     → state "running"; the runner gets
//                                            the step's categories + the
//                                            candidate as SUPERTWIN_STEP_OVERRIDES
//       COMPARE green                      → apply(), state "passed"
//       COMPARE red                        → NOT applied, state "blocked", a
//                                            decision row names the regressed
//                                            categories
//       runner threw / CLI missing         → NOT applied, state "error"
//
// The runner is a seam. Production installs `cliGoldenRunner` at boot when
// the eval harness is on disk beside the worker (a dev tree; a packaged app
// has no harness and says so). Tests install a fake. NOTHING in this module
// spawns anything on its own: with no runner installed a change applies and
// the state says "skipped: no golden runner installed" — that is what every
// unit test sees, and it is what keeps rule §1.3.5 (zero live calls) intact.
//
// One run at a time. The state lives in app_state so the Settings pane and
// the Runs pane read the same record after a restart.
// ===========================================================================

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { moduleDir } from "../module-path.js";
import { encodeStepOverrides, STEP_OVERRIDES_ENV, type StepOverrides } from "./overrides.js";
import { evalCategoriesForStep } from "./steps.js";

// ---- Runner seam ----------------------------------------------------------

export interface GoldenRunRequest {
  /** Categories to run; null = the whole set. */
  categories: readonly string[] | null;
  /** The candidate configuration under test, by step. Empty = the shipped one. */
  overrides: StepOverrides;
  /** Why this run happened — copied onto the record. */
  reason: string;
}

export interface GoldenRunResult {
  /** True when no selected category scored below its frozen rate. */
  ok: boolean;
  /** Categories below baseline (the COMPARE red list). */
  regressed: string[];
  /** One-paragraph summary for the pane. */
  summary: string;
  /** The harness exit code when known. */
  exitCode?: number;
  /** Set when the run could not be carried out at all (not a regression). */
  error?: string;
}

export type GoldenRunner = (req: GoldenRunRequest) => Promise<GoldenRunResult>;

let runner: GoldenRunner | null = null;
let runnerNote: string | null = null;

/** Install (or clear) the runner. `note` says where it came from, for the pane. */
export function installGoldenRunner(r: GoldenRunner | null, note: string | null = null): void {
  runner = r;
  runnerNote = r ? note : null;
}

export function goldenRunnerInstalled(): boolean {
  return runner !== null;
}

export function goldenRunnerNote(): string | null {
  return runnerNote;
}

// ---- State ----------------------------------------------------------------

export const GOLDEN_STATE_KEY = "intelligence.golden";

export type GoldenStatus = "idle" | "running" | "passed" | "blocked" | "error" | "skipped";

export interface GoldenState {
  status: GoldenStatus;
  started_at: string | null;
  finished_at: string | null;
  categories: string[] | null;
  /** The step whose change this run gated; null for a manual run. */
  step: string | null;
  candidate: { model?: string; thinking?: string } | null;
  /** Whether the gated change was written. */
  applied: boolean;
  regressed: string[];
  summary: string | null;
  error: string | null;
  reason: string | null;
}

const IDLE: GoldenState = {
  status: "idle",
  started_at: null,
  finished_at: null,
  categories: null,
  step: null,
  candidate: null,
  applied: false,
  regressed: [],
  summary: null,
  error: null,
  reason: null,
};

export function goldenState(): GoldenState {
  try {
    const raw = appStateGet(GOLDEN_STATE_KEY);
    if (!raw) return { ...IDLE };
    const v = JSON.parse(raw) as Partial<GoldenState>;
    return { ...IDLE, ...v, regressed: Array.isArray(v.regressed) ? v.regressed : [] };
  } catch {
    return { ...IDLE };
  }
}

function saveState(s: GoldenState): GoldenState {
  appStateSet(GOLDEN_STATE_KEY, JSON.stringify(s));
  return s;
}

/** A worker that died mid-run leaves "running" behind; boot calls this. */
export function resetStaleGoldenRun(now: Date = new Date()): void {
  const s = goldenState();
  if (s.status !== "running") return;
  saveState({
    ...s,
    status: "error",
    finished_at: now.toISOString(),
    error: "worker restarted while the golden set was running — the change was not applied",
  });
}

// ---- The gate --------------------------------------------------------------

export interface StepChange {
  step: string;
  label: string;
  model?: string;
  thinking?: string;
}

export interface ProposeResult {
  status: GoldenStatus;
  state: GoldenState;
}

let inFlight: Promise<GoldenState> | null = null;

/** Resolves when the current run (if any) has settled. Tests and the ops route use it. */
export async function awaitGoldenRun(): Promise<GoldenState> {
  return inFlight ? inFlight : goldenState();
}

export function goldenRunning(): boolean {
  return inFlight !== null;
}

function candidateOf(change: StepChange): StepOverrides {
  const o: StepOverrides = { [change.step]: {} };
  if (change.model) o[change.step]!.model = change.model;
  if (change.thinking) o[change.step]!.thinking = change.thinking;
  return o;
}

/**
 * Propose a change. `apply` writes it (app_state + the decision row) and is
 * called ONLY when the gate lets it through — immediately when no runner is
 * installed, after a green compare when one is.
 */
export async function proposeStepChange(
  change: StepChange,
  apply: () => void,
  now: () => Date = () => new Date(),
): Promise<ProposeResult> {
  const candidate = { ...(change.model ? { model: change.model } : {}), ...(change.thinking ? { thinking: change.thinking } : {}) };
  const what = change.model ? `model ${change.model}` : `reasoning ${change.thinking ?? "?"}`;
  const reason = `${change.label}: ${what}`;
  const categories = evalCategoriesForStep(change.step);

  if (!runner) {
    apply();
    const state = saveState({
      ...IDLE,
      status: "skipped",
      started_at: now().toISOString(),
      finished_at: now().toISOString(),
      categories: categories ? [...categories] : null,
      step: change.step,
      candidate,
      applied: true,
      summary: "golden set not run — no golden runner installed in this build; the change was applied and the set is marked due",
      reason,
    });
    return { status: "skipped", state };
  }

  if (inFlight) {
    return { status: "running", state: goldenState() };
  }

  const started = now().toISOString();
  saveState({
    ...IDLE,
    status: "running",
    started_at: started,
    categories: categories ? [...categories] : null,
    step: change.step,
    candidate,
    reason,
  });

  const run = (async (): Promise<GoldenState> => {
    let result: GoldenRunResult;
    try {
      result = await runner!({ categories, overrides: candidateOf(change), reason });
    } catch (err) {
      result = { ok: false, regressed: [], summary: "", error: err instanceof Error ? err.message : String(err) };
    }
    const finished = now().toISOString();
    const base = goldenState();
    if (result.error) {
      writeDecision({
        pass: "user",
        targetKind: "setting",
        targetId: `golden_gate_${change.step}`,
        action: "error",
        new: candidate,
        reason: `golden set could not run for ${reason}: ${result.error} — change NOT applied`,
      });
      return saveState({ ...base, status: "error", finished_at: finished, applied: false, error: result.error, summary: result.summary || null });
    }
    if (!result.ok) {
      writeDecision({
        pass: "user",
        targetKind: "setting",
        targetId: `golden_gate_${change.step}`,
        action: "blocked",
        new: candidate,
        reason: `golden set regressed (${result.regressed.join(", ") || "see summary"}) for ${reason} — change NOT applied`,
      });
      return saveState({ ...base, status: "blocked", finished_at: finished, applied: false, regressed: result.regressed, summary: result.summary });
    }
    apply();
    return saveState({ ...base, status: "passed", finished_at: finished, applied: true, regressed: [], summary: result.summary });
  })().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return { status: "running", state: goldenState() };
}

/**
 * The manual run (Settings › Intelligence "Run golden set", Runs pane). No
 * change is gated; the shipped configuration is measured against the
 * baseline. Refuses without a runner and while another run is in flight.
 */
export async function startGoldenRun(
  categories: readonly string[] | null,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<{ started: boolean; state: GoldenState; error?: string }> {
  if (!runner) {
    return { started: false, state: goldenState(), error: "no golden runner installed in this build (the eval harness is not on disk beside the worker)" };
  }
  if (inFlight) return { started: false, state: goldenState(), error: "a golden run is already in flight" };
  saveState({
    ...IDLE,
    status: "running",
    started_at: now().toISOString(),
    categories: categories ? [...categories] : null,
    reason,
  });
  const run = (async (): Promise<GoldenState> => {
    let result: GoldenRunResult;
    try {
      result = await runner!({ categories, overrides: {}, reason });
    } catch (err) {
      result = { ok: false, regressed: [], summary: "", error: err instanceof Error ? err.message : String(err) };
    }
    const base = goldenState();
    const finished = now().toISOString();
    if (result.error) return saveState({ ...base, status: "error", finished_at: finished, error: result.error, summary: result.summary || null });
    return saveState({
      ...base,
      status: result.ok ? "passed" : "blocked",
      finished_at: finished,
      regressed: result.regressed,
      summary: result.summary,
    });
  })().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return { started: true, state: goldenState() };
}

// ---- The production runner: the eval CLI in a child process ----------------

/**
 * worker/src/settings → worker/src → worker → repo root (same shape in dist/).
 *
 * In the packaged app there is no repo above the module at all: the answer is
 * three levels above Contents/Resources/worker, which does not hold a harness,
 * so `harnessPresent()` says no and the gate records "skipped" — the packaged
 * behaviour this module's header describes.
 *
 * It resolves through module-path.ts BECAUSE of what this line used to be:
 * `fileURLToPath(import.meta.url)` threw inside the CJS bundle (esbuild
 * empties `import.meta`), and since this runs on the boot path it took the
 * worker down before the HTTP server listened — 13.11.1 and 13.11.2 shipped
 * an app whose every screen said "worker unreachable" (V6 P1 W1).
 */
export function harnessRoot(): string {
  return resolve(moduleDir(import.meta.url), "..", "..", "..");
}

/** The harness is present when the CLI source and the fixture directory are both on disk. */
export function harnessPresent(root: string = harnessRoot()): boolean {
  return existsSync(join(root, "worker", "src", "evals", "cli.ts")) && existsSync(join(root, "evals", "v13"));
}

/** Pull the red list out of `renderCompare`'s last line. */
export function parseCompareOutput(text: string): { ok: boolean; regressed: string[] } | null {
  const m = text.match(/^COMPARE: (green|red)(?: — below baseline: (.*))?/m);
  if (!m) return null;
  if (m[1] === "green") return { ok: true, regressed: [] };
  return {
    ok: false,
    regressed: (m[2] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export interface CliRunnerOptions {
  root?: string;
  /** Wall-clock cap for one run. Default 45 minutes. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * `npm run eval -- --cat <cats> --compare-baseline` with the candidate in
 * SUPERTWIN_STEP_OVERRIDES. The harness sandboxes its own home (evals/home.ts);
 * this runner never touches the worker's database. It SPENDS MODEL CALLS —
 * which is the point of the gate, and why only boot installs it.
 */
export function cliGoldenRunner(opts: CliRunnerOptions = {}): GoldenRunner {
  const root = opts.root ?? harnessRoot();
  const timeoutMs = opts.timeoutMs ?? 45 * 60_000;
  const log = opts.log ?? (() => {});
  return (req) =>
    new Promise<GoldenRunResult>((resolveRun) => {
      const args = ["run", "eval", "--", "--compare-baseline"];
      if (req.categories && req.categories.length > 0) args.push("--cat", req.categories.join(","));
      const env = { ...process.env, [STEP_OVERRIDES_ENV]: encodeStepOverrides(req.overrides) };
      log(`[golden] ${req.reason} → npm ${args.join(" ")}`);
      let out = "";
      const child = spawn("npm", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolveRun({ ok: false, regressed: [], summary: out.slice(-4000), error: `golden run exceeded ${Math.round(timeoutMs / 60_000)} min and was stopped` });
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolveRun({ ok: false, regressed: [], summary: out.slice(-4000), error: `could not start the eval harness: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const compare = parseCompareOutput(out);
        const tail = out.split("\n").slice(-40).join("\n");
        if (compare) {
          resolveRun({ ok: compare.ok, regressed: compare.regressed, summary: tail, exitCode: code ?? undefined });
          return;
        }
        resolveRun({
          ok: false,
          regressed: [],
          summary: tail,
          exitCode: code ?? undefined,
          error: `the harness exited ${code ?? "?"} without a COMPARE verdict`,
        });
      });
    });
}

/**
 * Boot: install the CLI runner when the harness is on disk; otherwise leave
 * the seam empty and say why. Returns the note the pane shows.
 */
export function installCliGoldenRunnerIfAvailable(opts: CliRunnerOptions = {}): string {
  const root = opts.root ?? harnessRoot();
  if (!harnessPresent(root)) {
    installGoldenRunner(null);
    return `golden gate: eval harness not found under ${root} — model changes apply without a golden run (recorded as skipped)`;
  }
  installGoldenRunner(cliGoldenRunner({ ...opts, root }), `eval harness at ${root}`);
  return `golden gate: eval harness at ${root} — a model or reasoning change runs its categories first`;
}
