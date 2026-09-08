// ===========================================================================
// [TEST] The boot order IS the contract (V6 P1 W1).
//
// WHY THIS FILE EXISTS. 13.11.1/13.11.2 booted like this:
//
//   home guard → migrations → GOLDEN GATE → jobs → startServer()
//
// so a throw inside the golden gate — an "if available" step — killed the
// process before anything listened, and the whole app read "worker
// unreachable". Nothing caught it: every unit test exercised the pieces, and
// no test asserted the ORDER they run in.
//
// This reads the entrypoint's source, which is the only place that order
// exists. Two invariants:
//
//   1. every optional subsystem starts AFTER the listener;
//   2. the hard rails — home guard, pid claim, migrations, provider registry,
//      adapter manifest, the listener itself — are NOT wrapped in a guard that
//      would let a boot they should refuse continue (plan §1.3 rules 1 and 6;
//      providers/budget.ts is the money half of the same idea).
// ===========================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { moduleDir } from "./module-path.js";

const SOURCE = readFileSync(join(moduleDir(import.meta.url), "index.ts"), "utf8");

/** Where a snippet first appears, asserted to exist so a rename fails loudly. */
function at(needle: string): number {
  const i = SOURCE.indexOf(needle);
  expect(i, `entrypoint no longer contains ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe("hard rails come first, and stay hard", () => {
  it.each([
    ["the home guard", "const guard = enforceHomeGuard();"],
    ["the home layout", "const home = ensureHomeLayout();"],
    ["the crash-kill hook", "installCrashKill("],
    ["the stale-worker sweep", "sweepStaleWorkers(home)"],
    ["migrations", "runMigrations();"],
    ["the provider registry", "bootstrapBuiltInProviders();"],
    ["the adapter manifest", "registerSource({"],
  ])("%s runs before the listener", (_label, needle) => {
    expect(at(needle)).toBeLessThan(at("await startServer("));
  });

  it.each([
    ["enforceHomeGuard", "enforceHomeGuard"],
    ["runMigrations", "runMigrations"],
    ["bootstrapBuiltInProviders", "bootstrapBuiltInProviders"],
    ["sweepStaleWorkers", "sweepStaleWorkers"],
    ["registerSource", "registerSource"],
    ["startServer", "startServer"],
  ])("%s is never wrapped in optionalStep — a rail that can be swallowed is not a rail", (_l, name) => {
    // The wrapper's shape is optionalStep("<name>", () => <call>, …); a rail
    // inside one would read `() => enforceHomeGuard()` on the same line.
    expect(SOURCE).not.toMatch(new RegExp(`optionalStep[^\\n]*\\(\\)\\s*=>\\s*${name}\\b`));
    expect(SOURCE).not.toMatch(new RegExp(`optionalStepAsync[^\\n]*\\(\\)\\s*=>\\s*${name}\\b`));
  });
});

describe("optional subsystems come after the listener", () => {
  const listener = (): number => at("await startServer(");

  it.each([
    ["the golden gate", 'optionalStep("golden gate"'],
    ["the spend heartbeat", 'optionalStep("spend heartbeat"'],
    ["the source supervisor's consent sweep", 'optionalStepAsync("source supervisor"'],
    ["tiering", 'optionalStep("tiering"'],
    ["the calendar job", 'optionalStep("calendar"'],
    ["wake-ups", 'optionalStep("wake-ups"'],
    ["the brief", 'optionalStep("brief"'],
    ["the category backfill", 'optionalStep("category backfill"'],
    ["trace retention", 'optionalStep("trace retention"'],
    ["the dispatcher", 'optionalStep("dispatcher"'],
    ["consolidation", 'optionalStep("consolidation"'],
    ["the prepared-action queue", 'optionalStep("prepared-action queue"'],
  ])("%s starts after it, and is guarded", (_label, needle) => {
    expect(at(needle)).toBeGreaterThan(listener());
  });

  it("installs the golden runner ONLY inside a guard — the exact 13.11.1 step", () => {
    const install = at("installCliGoldenRunnerIfAvailable({");
    const guard = at('optionalStep("golden gate"');
    expect(install).toBeGreaterThan(guard);
    expect(install).toBeGreaterThan(listener());
  });

  it.each([
    "ensureLogsDir();",
    "teeConsole();",
    "installCliGoldenRunnerIfAvailable(",
    "startSpendHeartbeat(",
    "supervisor.startConsented(",
    "startTieringJob(",
    "startCalendarJob(",
    "startWakeupJob(",
    "startBriefJob(",
    "backfillChatCategories(",
    "startTraceRetentionJob(",
    "startDispatcher(",
    "startConsolidationJob(",
    "startPreparedQueueJob(",
    "startParentWatch(",
    "new Ingestion(",
  ])("%s is called from inside a guard, never bare on the boot path", (call) => {
    // A bare start on the boot path is the next 13.11.1: one throw between it
    // and main(). Look at what encloses the call, not just where it sits.
    const body = SOURCE.slice(at("async function main("));
    const i = body.indexOf(call);
    expect(i, `entrypoint no longer calls ${call}`).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, i - 400), i)).toMatch(/optionalStep(Async)?\(/);
  });
});

describe("shutdown survives a degraded boot", () => {
  it("fans provider cleanup out before subsystem shutdown and catches aggregate failures", () => {
    const kill = at("killAllRegisteredProviders();");
    expect(kill).toBeLessThan(at("parentWatch?.stop()"));
    expect(SOURCE.slice(kill, at("parentWatch?.stop()"))).toContain("catch (error)");
  });

  it("the fatal main path also fans out provider cleanup before exit", () => {
    const fatal = at('console.error("[worker] fatal:", err);');
    const tail = SOURCE.slice(fatal);
    expect(tail).toContain("killAllRegisteredProviders();");
    expect(tail.indexOf("killAllRegisteredProviders();")).toBeLessThan(tail.indexOf("process.exit(1);"));
    expect(tail).toContain("catch (error)");
  });

  it.each([
    "parentWatch?.stop()",
    "dispatcher?.stop()",
    "consolidation?.stop()",
    "spendHeartbeat?.stop()",
    "traceRetention?.stop()",
    "tiering?.stop()",
    "calendarJob?.stop()",
    "wakeups?.stop()",
    "briefJob?.stop()",
    "preparedQueue?.stop()",
  ])("%s is optional-chained — a null handle must not throw on SIGTERM", (needle) => {
    expect(SOURCE).toContain(needle);
  });
});
