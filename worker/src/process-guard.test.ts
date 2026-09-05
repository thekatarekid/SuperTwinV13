// ===========================================================================
// Process guard (S0.2, T0-7 / T0-15): parent loss -> 10-minute self-shutdown
// (unless SUPERTWIN_WORKER_NO_PARENT=1); startup sweep kills a pre-existing
// worker on the same home and claims the pid file; unhandled rejection kills
// children. Every OS touch is injected — nothing is spawned or signalled.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NO_PARENT_ENV,
  PARENT_LOSS_GRACE_MS,
  pidFilePath,
  releasePidFile,
  startParentWatch,
  sweepStaleWorkers,
} from "./process-guard.js";

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: Array<() => void> = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {
      timers.length = 0;
    },
    timers,
  };
}

describe("startParentWatch", () => {
  it("does nothing while the parent is alive", () => {
    const clock = fakeClock();
    let lost = 0;
    const w = startParentWatch({
      onParentLost: () => void (lost += 1),
      env: {},
      deps: { ppid: () => 4242, alive: () => true, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, log: () => {} },
    });
    for (let i = 0; i < 100; i += 1) {
      clock.advance(60_000);
      w.poll();
    }
    expect(lost).toBe(0);
    expect(w.deadline()).toBeNull();
  });

  it("exits 10 minutes after the parent goes away (re-parented to launchd)", () => {
    const clock = fakeClock();
    let ppid = 4242;
    const lost: string[] = [];
    const w = startParentWatch({
      onParentLost: (d) => lost.push(d),
      env: {},
      deps: { ppid: () => ppid, alive: (p) => p === 4242, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, log: () => {} },
    });
    ppid = 1;
    w.poll();
    expect(w.deadline()).toBe(clock.now() + PARENT_LOSS_GRACE_MS);
    expect(PARENT_LOSS_GRACE_MS).toBe(10 * 60 * 1000);
    clock.advance(PARENT_LOSS_GRACE_MS - 1);
    w.poll();
    expect(lost).toHaveLength(0);
    clock.advance(1);
    w.poll();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/parent 4242 lost/);
    // Fires once.
    clock.advance(60_000);
    w.poll();
    expect(lost).toHaveLength(1);
  });

  it("a parent that stops answering kill -0 counts as lost; one that comes back cancels", () => {
    const clock = fakeClock();
    let alive = true;
    let lost = 0;
    const w = startParentWatch({
      onParentLost: () => void (lost += 1),
      env: {},
      deps: { ppid: () => 4242, alive: () => alive, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, log: () => {} },
    });
    alive = false;
    w.poll();
    expect(w.deadline()).not.toBeNull();
    alive = true;
    clock.advance(5 * 60_000);
    w.poll();
    expect(w.deadline()).toBeNull();
    clock.advance(PARENT_LOSS_GRACE_MS);
    w.poll();
    expect(lost).toBe(0);
  });

  it("SUPERTWIN_WORKER_NO_PARENT=1 disables the watch", () => {
    let lost = 0;
    const w = startParentWatch({
      onParentLost: () => void (lost += 1),
      env: { [NO_PARENT_ENV]: "1" },
      deps: { ppid: () => 1, alive: () => false, log: () => {} },
    });
    expect(w.disabled).toBe(true);
    w.poll();
    expect(lost).toBe(0);
  });
});

describe("sweepStaleWorkers", () => {
  const home = mkdtempSync(join(tmpdir(), "supertwin-sweep-"));
  const pidFile = pidFilePath(home);

  it("claims the pid file on a clean home", () => {
    rmSync(pidFile, { force: true });
    const r = sweepStaleWorkers(home, { selfPid: 100, alive: () => false, kill: () => {}, later: () => {}, log: () => {} });
    expect(r.killed).toBeNull();
    expect(r.stale).toBe(false);
    expect(readFileSync(pidFile, "utf8").trim()).toBe("100");
  });

  it("terminates a live pre-existing worker (SIGTERM, then SIGKILL if it lingers) and takes over", () => {
    writeFileSync(pidFile, "777\n");
    const signals: Array<[number, string]> = [];
    const later: Array<() => void> = [];
    let alive777 = true;
    const r = sweepStaleWorkers(home, {
      selfPid: 100,
      alive: (p) => p === 777 && alive777,
      kill: (p, s) => signals.push([p, s]),
      later: (fn) => later.push(fn),
      log: () => {},
    });
    expect(r.killed).toBe(777);
    expect(signals).toEqual([[777, "SIGTERM"]]);
    expect(readFileSync(pidFile, "utf8").trim()).toBe("100");
    // Still alive at the grace: SIGKILL.
    later.forEach((fn) => fn());
    expect(signals).toEqual([[777, "SIGTERM"], [777, "SIGKILL"]]);
    // Gone by the grace: no SIGKILL.
    signals.length = 0;
    later.length = 0;
    writeFileSync(pidFile, "777\n");
    alive777 = true;
    sweepStaleWorkers(home, { selfPid: 100, alive: (p) => p === 777 && alive777, kill: (p, s) => signals.push([p, s]), later: (fn) => later.push(fn), log: () => {} });
    alive777 = false;
    later.forEach((fn) => fn());
    expect(signals).toEqual([[777, "SIGTERM"]]);
  });

  it("a dead pid in the file is stale, not killed", () => {
    writeFileSync(pidFile, "888\n");
    const signals: number[] = [];
    const r = sweepStaleWorkers(home, { selfPid: 100, alive: () => false, kill: (p) => signals.push(p), later: () => {}, log: () => {} });
    expect(r.stale).toBe(true);
    expect(r.killed).toBeNull();
    expect(signals).toEqual([]);
    expect(readFileSync(pidFile, "utf8").trim()).toBe("100");
  });

  it("never signals itself", () => {
    writeFileSync(pidFile, "100\n");
    const signals: number[] = [];
    const r = sweepStaleWorkers(home, { selfPid: 100, alive: () => true, kill: (p) => signals.push(p), later: () => {}, log: () => {} });
    expect(r.killed).toBeNull();
    expect(signals).toEqual([]);
  });

  it("releasePidFile removes only our own pid file", () => {
    writeFileSync(pidFile, "100\n");
    releasePidFile(home, 200);
    expect(existsSync(pidFile)).toBe(true);
    releasePidFile(home, 100);
    expect(existsSync(pidFile)).toBe(false);
  });
});
