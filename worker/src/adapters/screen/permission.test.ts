// ===========================================================================
// Accessibility probe (V6 P1 S1.3 / T4-8) — every outcome but an explicit
// `permission: true` frame is "not granted", with the reason named. Fake
// spawn; no sidecar, no Accessibility, no model calls.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildLike, SpawnFn } from "./adapter.js";
import {
  CHECK_PERMISSION_FLAG,
  REQUEST_PERMISSION_FLAG,
  invalidateAccessibilityProbeCache,
  probeAccessibility,
  probeAccessibilityCached,
  requestAccessibility,
} from "./permission.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = null;
  killed: NodeJS.Signals | number | null = null;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
  line(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

/** A binary path that exists, so resolution does not short-circuit to binary-missing. */
function existingBin(): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "st-perm-"));
  const bin = join(dir, "screenwatch");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function harness(): { spawn: SpawnFn; child: FakeChild; calls: Array<{ bin: string; args: string[] }> } {
  const child = new FakeChild();
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    return child;
  };
  return { spawn, child, calls };
}

describe("probeAccessibility", () => {
  it("granted: the permission frame says true; the probe child is reaped", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child, calls } = harness();
      const p = probeAccessibility({ spawn, binPath: bin });
      child.line({ t: "permission", granted: "true" });
      expect(await p).toEqual({ granted: true, reason: "granted", prompted: false });
      expect(calls).toEqual([{ bin, args: [CHECK_PERMISSION_FLAG] }]);
      expect(child.killed).toBe("SIGTERM");
    } finally {
      cleanup();
    }
  });

  it("denied: granted=false with reason denied", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child } = harness();
      const p = probeAccessibility({ spawn, binPath: bin });
      child.line({ t: "permission", granted: "false" });
      expect(await p).toEqual({ granted: false, reason: "denied", prompted: false });
    } finally {
      cleanup();
    }
  });

  it("an old binary that ignores the flag and starts live capture is killed on its first frame — never 'granted'", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child } = harness();
      const p = probeAccessibility({ spawn, binPath: bin });
      child.line({ t: "ready", mock: "false" });
      child.line({ t: "status", state: "capturing" });
      const r = await p;
      expect(r.granted).toBe(false);
      expect(r.reason).toBe("probe-unsupported");
      expect(r.detail).toContain("rebuild sources/screenwatch");
      expect(child.killed).toBe("SIGTERM");
    } finally {
      cleanup();
    }
  });

  it("exit without an answer → no-answer; a hang → timeout; spawn throw → spawn-failed", async () => {
    const { bin, cleanup } = existingBin();
    try {
      let h = harness();
      let p = probeAccessibility({ spawn: h.spawn, binPath: bin });
      h.child.emit("exit", 1, null);
      expect(await p).toEqual({ granted: false, reason: "no-answer", detail: "exit 1" });

      h = harness();
      p = probeAccessibility({ spawn: h.spawn, binPath: bin, timeoutMs: 20 });
      expect(await p).toEqual({ granted: false, reason: "timeout" });
      expect(h.child.killed).toBe("SIGTERM");

      const throwing: SpawnFn = () => {
        throw new Error("EACCES");
      };
      expect(await probeAccessibility({ spawn: throwing, binPath: bin })).toEqual({
        granted: false,
        reason: "spawn-failed",
        detail: "EACCES",
      });
    } finally {
      cleanup();
    }
  });

  it("no binary anywhere → binary-missing, and nothing is spawned", async () => {
    const prev = process.env.SUPERTWIN_SCREENWATCH_BIN;
    delete process.env.SUPERTWIN_SCREENWATCH_BIN;
    try {
      const { spawn, calls } = harness();
      const r = await probeAccessibility({ spawn, binPath: join(tmpdir(), "definitely-missing", "screenwatch"), timeoutMs: 20 });
      // The repo's own build may or may not be present on this machine; either
      // way an explicit missing path never spawns anything when no fallback exists.
      if (r.reason === "binary-missing") {
        expect(r.granted).toBe(false);
        expect(calls).toHaveLength(0);
      } else {
        // A fallback binary was found (dev tree with a build): the probe ran it.
        expect(calls).toHaveLength(1);
      }
    } finally {
      if (prev === undefined) delete process.env.SUPERTWIN_SCREENWATCH_BIN;
      else process.env.SUPERTWIN_SCREENWATCH_BIN = prev;
    }
  });
});

// ===========================================================================
// THE ASK (V6 P1 S6d / L4). `--check-permission` reports and registers
// nothing, which is why SuperTwin never appeared in System Settings › Privacy
// & Security › Accessibility and the permission could not be granted at all.
// `requestAccessibility()` runs the flag that calls
// AXIsProcessTrustedWithOptions(prompt) — these tests pin the contract of that
// call: the right flag, an honest `prompted`, and no memo standing in for it.
// ===========================================================================

describe("requestAccessibility — the ask", () => {
  it("runs --request-permission, not --check-permission", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child, calls } = harness();
      const p = requestAccessibility({ spawn, binPath: bin });
      child.line({ t: "permission", granted: "false", prompted: "true" });
      const r = await p;
      expect(calls).toEqual([{ bin, args: [REQUEST_PERMISSION_FLAG] }]);
      // The normal first answer: the row now exists, the user has not
      // switched it on yet. Not a failure, and not "granted".
      expect(r).toEqual({ granted: false, reason: "denied", prompted: true });
    } finally {
      cleanup();
    }
  });

  it("an ask a binary is too old to have made is never reported as prompted", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child } = harness();
      const p = requestAccessibility({ spawn, binPath: bin });
      // An old binary that happens to answer the check frame shape without the
      // prompted field: we cannot claim macOS was asked.
      child.line({ t: "permission", granted: "false" });
      expect((await p).prompted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("an old binary that ignores the flag and starts capturing is killed, not trusted", async () => {
    const { bin, cleanup } = existingBin();
    try {
      const { spawn, child } = harness();
      const p = requestAccessibility({ spawn, binPath: bin });
      child.line({ t: "ready", mock: "false" });
      const r = await p;
      expect(r.granted).toBe(false);
      expect(r.reason).toBe("probe-unsupported");
      expect(String(r.detail)).toContain(REQUEST_PERMISSION_FLAG);
      expect(child.killed).toBe("SIGTERM");
    } finally {
      cleanup();
    }
  });
});

describe("probeAccessibilityCached", () => {
  it("one spawn serves concurrent callers, and the answer is reused inside the ttl", async () => {
    const { bin, cleanup } = existingBin();
    invalidateAccessibilityProbeCache();
    try {
      const { spawn, child, calls } = harness();
      const a = probeAccessibilityCached({ spawn, binPath: bin });
      const b = probeAccessibilityCached({ spawn, binPath: bin });
      child.line({ t: "permission", granted: "true" });
      expect((await a).granted).toBe(true);
      expect((await b).granted).toBe(true);
      // The panel polls this while the permission card is up; a spawn per poll
      // is exactly what the memo exists to prevent.
      const c = await probeAccessibilityCached({ spawn, binPath: bin });
      expect(c.granted).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      invalidateAccessibilityProbeCache();
      cleanup();
    }
  });

  it("ttlMs 0 is a gate: it re-probes rather than trusting the memo", async () => {
    const { bin, cleanup } = existingBin();
    invalidateAccessibilityProbeCache();
    try {
      const first = harness();
      const seed = probeAccessibilityCached({ spawn: first.spawn, binPath: bin });
      first.child.line({ t: "permission", granted: "false" });
      expect((await seed).granted).toBe(false);

      const second = harness();
      const fresh = probeAccessibilityCached({ spawn: second.spawn, binPath: bin, ttlMs: 0 });
      second.child.line({ t: "permission", granted: "true" });
      expect((await fresh).granted).toBe(true);
      expect(second.calls).toHaveLength(1);

      // …and the fresh answer replaces the memo, so the next poll agrees.
      const after = await probeAccessibilityCached({ spawn: second.spawn, binPath: bin });
      expect(after.granted).toBe(true);
      expect(second.calls).toHaveLength(1);
    } finally {
      invalidateAccessibilityProbeCache();
      cleanup();
    }
  });

  it("the ask drops the memo, so a stale 'denied' cannot survive the grant", async () => {
    const { bin, cleanup } = existingBin();
    invalidateAccessibilityProbeCache();
    try {
      const seedH = harness();
      const seed = probeAccessibilityCached({ spawn: seedH.spawn, binPath: bin });
      seedH.child.line({ t: "permission", granted: "false" });
      await seed;

      const askH = harness();
      const ask = requestAccessibility({ spawn: askH.spawn, binPath: bin });
      askH.child.line({ t: "permission", granted: "true", prompted: "true" });
      expect((await ask).granted).toBe(true);

      const nextH = harness();
      const next = probeAccessibilityCached({ spawn: nextH.spawn, binPath: bin });
      nextH.child.line({ t: "permission", granted: "true" });
      expect((await next).granted).toBe(true);
      expect(nextH.calls).toHaveLength(1);
    } finally {
      invalidateAccessibilityProbeCache();
      cleanup();
    }
  });
});
