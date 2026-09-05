// ===========================================================================
// Accessibility permission probe (V6 P1 S1.3, backlog T4-3 / T4-8).
//
// The screen sidecar used to be spawned at boot and began capturing the
// instant `AXIsProcessTrusted()` flipped true (Live.swift) — the permission
// prompt WAS the "start recording" step. The V6 flow is three explicit steps:
//
//   consent row (state 'connected')  →  Accessibility granted  →  the user's
//   explicit "Record from now on"  →  only THEN the capturing sidecar spawns.
//
// Step two needs an answer to "is Accessibility granted?" WITHOUT spawning
// the capturing sidecar to find out. `screenwatch --check-permission` prints
// exactly one frame — {"t":"permission","granted":"true"|"false"} — and
// exits; it observes nothing. This module runs that probe with a timeout and
// classifies every other outcome as "not granted, and here is why", so a
// missing binary, a binary that predates the flag (it would ignore the flag
// and start live capture — killed on its first `ready` frame, before any
// sink exists) or a hang can never be mistaken for permission.
//
// Zero model calls. Spawn is injected for the tests.
// ===========================================================================

import { spawn as nodeSpawn } from "node:child_process";

import type { ChildLike, SpawnFn } from "./adapter.js";
import { resolveScreenwatchBin } from "./adapter.js";

export const CHECK_PERMISSION_FLAG = "--check-permission";
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type AccessibilityProbeReason =
  | "granted"
  | "denied"
  /** No screenwatch binary on this machine (dev tree without a build). */
  | "binary-missing"
  /** The binary answered with a live-mode frame: it predates --check-permission. */
  | "probe-unsupported"
  | "spawn-failed"
  | "timeout"
  /** Exited without a permission frame. */
  | "no-answer";

export interface AccessibilityProbe {
  granted: boolean;
  reason: AccessibilityProbeReason;
  detail?: string;
}

export interface ProbeOptions {
  spawn?: SpawnFn;
  binPath?: string;
  timeoutMs?: number;
}

const defaultSpawn: SpawnFn = (bin, args, opts) =>
  nodeSpawn(bin, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildLike;

/**
 * Ask the sidecar whether Accessibility is granted, without capturing.
 * Never throws; `granted` is true only on an explicit `permission: true`.
 */
export function probeAccessibility(opts: ProbeOptions = {}): Promise<AccessibilityProbe> {
  const { bin, found } = resolveScreenwatchBin(opts.binPath);
  if (!found) {
    return Promise.resolve({ granted: false, reason: "binary-missing", detail: bin });
  }
  const spawnFn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise<AccessibilityProbe>((resolve) => {
    let child: ChildLike;
    try {
      child = spawnFn(bin, [CHECK_PERMISSION_FLAG], { env: { ...process.env } });
    } catch (err) {
      resolve({ granted: false, reason: "spawn-failed", detail: (err as Error).message });
      return;
    }

    let settled = false;
    let buf = "";
    const finish = (result: AccessibilityProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ granted: false, reason: "timeout" }), timeoutMs);
    timer.unref?.();

    const onLine = (line: string): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg["t"] === "permission") {
        const granted = msg["granted"] === "true" || msg["granted"] === true;
        finish({ granted, reason: granted ? "granted" : "denied" });
        return;
      }
      // Any live-mode frame (`ready`, `status`, a snapshot) means the binary
      // ignored the flag: it predates the probe. Kill it before it captures.
      finish({
        granted: false,
        reason: "probe-unsupported",
        detail: `screenwatch answered t=${String(msg["t"])} to ${CHECK_PERMISSION_FLAG}; rebuild sources/screenwatch`,
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
        if (settled) return;
      }
    });
    child.on("error", (err: Error) => finish({ granted: false, reason: "spawn-failed", detail: err.message }));
    child.on("exit", (code: number | null) => {
      if (buf.trim()) onLine(buf.trim());
      finish({ granted: false, reason: "no-answer", detail: `exit ${code ?? "null"}` });
    });
  });
}
