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
// V6 P1 S6d (L4): the probe alone could never get the permission GRANTED.
// macOS lists an app in Privacy & Security › Accessibility only when a process
// calls AXIsProcessTrustedWithOptions with the prompt option; a prompt-free
// check registers nothing, so the pane the UI deep-links to had no SuperTwin
// row and the user could not tick anything. `requestAccessibility()` runs
// `screenwatch --request-permission`, which makes that call — attributed by
// TCC to the responsible process, SuperTwinV13.app (measured; see
// sources/screenwatch/Sources/ScreenwatchCore/Permission.swift). The host app
// asks the same thing directly (src-tauri/src/accessibility.rs); both land on
// the one row.
//
// Zero model calls. Spawn is injected for the tests.
// ===========================================================================

import { spawn as nodeSpawn } from "node:child_process";

import type { ChildLike, SpawnFn } from "./adapter.js";
import { resolveScreenwatchBin } from "./adapter.js";

export const CHECK_PERMISSION_FLAG = "--check-permission";
/** The ASK. Registers the app in System Settings; captures nothing. */
export const REQUEST_PERMISSION_FLAG = "--request-permission";
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/**
 * How long a probe answer may be reused. The panel polls trust state every
 * second or two so it can flip to "capturing" without a restart; spawning a
 * process per poll (and per /status hit, which the onboarding banner also
 * polls) is waste. Short enough that a tick in System Settings still shows up
 * as fast as a human can look back at the window.
 */
export const PROBE_CACHE_MS = 1_500;

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
  /**
   * True when this run ASKED (`--request-permission`), i.e. when macOS was
   * told to put up its dialog and create the Accessibility row. `granted:
   * false, prompted: true` is "asked, waiting for the tick" — not a failure.
   */
  prompted?: boolean;
}

export interface ProbeOptions {
  spawn?: SpawnFn;
  binPath?: string;
  timeoutMs?: number;
  /**
   * Ask instead of check. Only ever set from an explicit user action: a dialog
   * the user did not ask for is exactly what this product does not do.
   */
  request?: boolean;
}

const defaultSpawn: SpawnFn = (bin, args, opts) =>
  nodeSpawn(bin, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildLike;

/**
 * Ask the sidecar whether Accessibility is granted, without capturing.
 * Never throws; `granted` is true only on an explicit `permission: true`.
 */
export function probeAccessibility(opts: ProbeOptions = {}): Promise<AccessibilityProbe> {
  const { bin, found } = resolveScreenwatchBin(opts.binPath);
  const asking = opts.request === true;
  if (!found) {
    return Promise.resolve({ granted: false, reason: "binary-missing", detail: bin, prompted: false });
  }
  const spawnFn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const flag = asking ? REQUEST_PERMISSION_FLAG : CHECK_PERMISSION_FLAG;

  return new Promise<AccessibilityProbe>((resolve) => {
    let child: ChildLike;
    try {
      child = spawnFn(bin, [flag], { env: { ...process.env } });
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
        // A binary that predates --request-permission ignores the unknown flag
        // and falls through to LIVE capture, which is caught below. One that
        // knows the flag echoes `prompted`; older ones answering the CHECK
        // simply omit it, and an ask we cannot prove happened is not one we
        // report as having happened.
        const prompted = asking && (msg["prompted"] === "true" || msg["prompted"] === true);
        finish({ granted, reason: granted ? "granted" : "denied", prompted });
        return;
      }
      // Any live-mode frame (`ready`, `status`, a snapshot) means the binary
      // ignored the flag: it predates the probe. Kill it before it captures.
      finish({
        granted: false,
        reason: "probe-unsupported",
        detail: `screenwatch answered t=${String(msg["t"])} to ${flag}; rebuild sources/screenwatch`,
        prompted: false,
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

/**
 * ASK macOS for Accessibility (`screenwatch --request-permission`).
 *
 * This is the call that makes SuperTwin appear in System Settings › Privacy &
 * Security › Accessibility. It returns the trust state as it stands at the
 * moment of asking — `granted: false, prompted: true` on a first ask, because
 * the dialog and the row are created asynchronously and the user has yet to
 * tick anything. The caller polls `probeAccessibility()` afterwards.
 *
 * Only ever called from an explicit user action.
 */
export function requestAccessibility(opts: ProbeOptions = {}): Promise<AccessibilityProbe> {
  invalidateAccessibilityProbeCache();
  return probeAccessibility({ ...opts, request: true });
}

// ---- Cached probe ----------------------------------------------------------
// Every probe is a process spawn. The panel polls trust state so it can flip to
// "capturing" the moment the user ticks the row — without this, that poll would
// fork screenwatch once or twice a second, and /api/screen/status (polled by
// the onboarding banner too) would join in. One in-flight probe is shared by
// every concurrent caller; its answer is reused for PROBE_CACHE_MS.

interface CacheEntry {
  at: number;
  probe: AccessibilityProbe;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<AccessibilityProbe> | null = null;

/** Drop the memo — after an ask, and in tests between cases. */
export function invalidateAccessibilityProbeCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * `probeAccessibility()` with a short memo and single-flight. Never asks.
 * `ttlMs: 0` forces a fresh probe (the /record gate does, so a stale "granted"
 * can never arm a recording).
 */
export function probeAccessibilityCached(
  opts: ProbeOptions & { ttlMs?: number } = {},
): Promise<AccessibilityProbe> {
  const ttl = opts.ttlMs ?? PROBE_CACHE_MS;
  const now = Date.now();
  if (ttl > 0 && cached && now - cached.at < ttl) return Promise.resolve(cached.probe);
  if (inFlight) return inFlight;
  const run = probeAccessibility(opts).then(
    (probe) => {
      cached = { at: Date.now(), probe };
      inFlight = null;
      return probe;
    },
    (err: unknown) => {
      inFlight = null;
      throw err;
    },
  );
  inFlight = run;
  return run;
}
