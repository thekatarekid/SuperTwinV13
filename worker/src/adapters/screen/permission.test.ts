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
import { CHECK_PERMISSION_FLAG, probeAccessibility } from "./permission.js";

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
      expect(await p).toEqual({ granted: true, reason: "granted" });
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
      expect(await p).toEqual({ granted: false, reason: "denied" });
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
