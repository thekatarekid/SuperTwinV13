// ===========================================================================
// [TEST] An optional subsystem degrades; it does not take the boot down
// (V6 P1 W1).
//
// WHY THIS FILE EXISTS. `installCliGoldenRunnerIfAvailable()` threw inside the
// packaged app and, because it ran before `startServer()`, main() rejected and
// the process exited 1 — so every screen said "worker unreachable" over one
// optional feature. The shape of the fix is asserted here; the boot's own
// order (hard rails, listener, then everything else) is asserted in
// index.boot-order.test.ts.
// ===========================================================================

import { beforeEach, describe, expect, it } from "vitest";

import {
  bootDegradations,
  clearBootDegradations,
  degradedSubsystems,
  optionalStep,
  optionalStepAsync,
} from "./boot-guard.js";

beforeEach(() => {
  clearBootDegradations();
});

const collect = (): { lines: string[]; log: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
};

describe("optionalStep", () => {
  it("returns what the step returns when it works", () => {
    const { lines, log } = collect();
    expect(optionalStep("dispatcher", () => ({ stop: () => {} }), { log })).not.toBeNull();
    expect(lines).toEqual([]);
    expect(bootDegradations()).toEqual([]);
  });

  it("swallows a throw, logs it, and hands back null", () => {
    const { lines, log } = collect();
    const value = optionalStep(
      "golden gate",
      () => {
        // The 13.11.1 crash, verbatim in shape.
        throw new TypeError(`The "path" argument must be of type string or an instance of URL. Received undefined`);
      },
      { log, now: () => new Date("2026-09-06T12:00:00Z") },
    );

    expect(value).toBeNull();
    expect(lines[0]).toContain('optional subsystem "golden gate" did not start');
    expect(lines[0]).toContain("Received undefined");
    expect(bootDegradations()).toEqual([
      {
        name: "golden gate",
        error: `The "path" argument must be of type string or an instance of URL. Received undefined`,
        at: "2026-09-06T12:00:00.000Z",
      },
    ]);
  });

  it("logs the stack as a second line, so the next one of these is findable", () => {
    const { lines, log } = collect();
    optionalStep("tiering", () => {
      throw new Error("boom");
    }, { log });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Error: boom");
  });

  it("survives a thrown non-Error", () => {
    const { lines, log } = collect();
    expect(optionalStep("brief", () => {
      throw "a string, because someone will";
    }, { log })).toBeNull();
    expect(lines[0]).toContain("a string, because someone will");
    expect(degradedSubsystems()).toEqual(["brief"]);
  });

  it("catches a rejected promise the step returned, so unhandledRejection cannot fire", async () => {
    // process-guard.ts kills the worker on unhandledRejection (money safety).
    // A boot step that hands back a rejecting promise must not reach it.
    const { log } = collect();
    const value = optionalStep("wake-ups", () => Promise.reject(new Error("late")), { log });
    expect(value).not.toBeNull();
    await expect(value).rejects.toThrow("late");
    // The handler ran, so the rejection is accounted for rather than fatal.
    await new Promise((r) => setTimeout(r, 0));
    expect(degradedSubsystems()).toEqual(["wake-ups"]);
  });

  it("keeps every failure, in order, for /api/health to serve", () => {
    const { log } = collect();
    optionalStep("golden gate", () => { throw new Error("a"); }, { log });
    optionalStep("calendar", () => { throw new Error("b"); }, { log });
    expect(degradedSubsystems()).toEqual(["golden gate", "calendar"]);
    expect(bootDegradations().map((d) => d.error)).toEqual(["a", "b"]);
  });
});

describe("optionalStepAsync", () => {
  it("returns the awaited value when the step works", async () => {
    const { log } = collect();
    await expect(optionalStepAsync("sources", async () => "started", { log })).resolves.toBe("started");
    expect(bootDegradations()).toEqual([]);
  });

  it("swallows a rejection, logs it, and hands back null", async () => {
    const { lines, log } = collect();
    await expect(
      optionalStepAsync("source supervisor", async () => {
        throw new Error("consent read failed");
      }, { log }),
    ).resolves.toBeNull();
    expect(lines[0]).toContain('optional subsystem "source supervisor" did not start');
    expect(degradedSubsystems()).toEqual(["source supervisor"]);
  });

  it("swallows a synchronous throw from an async step too", async () => {
    const { log } = collect();
    await expect(
      optionalStepAsync("sources", (() => {
        throw new Error("threw before the first await");
      }) as () => Promise<never>, { log }),
    ).resolves.toBeNull();
    expect(degradedSubsystems()).toEqual(["sources"]);
  });
});

describe("clearBootDegradations", () => {
  it("is a test affordance: boot itself never forgets what failed", () => {
    const { log } = collect();
    optionalStep("dispatcher", () => { throw new Error("x"); }, { log });
    expect(degradedSubsystems()).toEqual(["dispatcher"]);
    clearBootDegradations();
    expect(degradedSubsystems()).toEqual([]);
  });
});
