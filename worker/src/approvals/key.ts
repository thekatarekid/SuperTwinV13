// ===========================================================================
// The approval signing key (V6 P1 S4.5; Product_V6 §23.7 rule 2, §22 TRUST).
//
// A gated action needs a token that is SIGNED, not merely random: the Go
// daemon is a separate process and must be able to decide, on its own, that a
// `send_message` carries a real tap's authority for exactly this recipient and
// exactly this text. It cannot read the worker's SQLite table, so the only
// thing that crosses the boundary is the token itself — which means the token
// has to carry its own proof.
//
// The proof is an HMAC over the token's fields under a per-install secret that
// lives beside the other trust material:
//
//     <home>/trust/approval.key      32 random bytes, hex, mode 0600
//
// It is created on first use and never rotated automatically (rotating it
// would invalidate every in-flight approval; nothing in P1 needs that). The
// worker hands the same value to the daemon in its spawn environment as
// SUPERTWIN_APPROVAL_KEY, so the two processes verify against one secret
// without the key ever touching the wire protocol or a log line.
// ===========================================================================

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { homeRoot } from "../home.js";

/** Env var the daemon reads the same secret from (adapter sets it on spawn). */
export const APPROVAL_KEY_ENV = "SUPERTWIN_APPROVAL_KEY";

/** 32 bytes → 64 hex characters. */
const KEY_BYTES = 32;

let cache: { path: string; key: string } | null = null;

/** `<home>/trust/approval.key`. */
export function approvalKeyPath(): string {
  return join(homeRoot(), "trust", "approval.key");
}

/**
 * The install's approval-signing secret as a hex string, created on first use.
 *
 * An explicit SUPERTWIN_APPROVAL_KEY in the environment wins — that is how a
 * child process (the daemon) and a test share one key without a file — and it
 * is never written to disk.
 */
export function approvalKey(): string {
  const fromEnv = process.env[APPROVAL_KEY_ENV];
  if (fromEnv && /^[0-9a-f]{32,}$/i.test(fromEnv.trim())) return fromEnv.trim().toLowerCase();

  // A test that forgot to sandbox its home must not create trust material in
  // the real one. Under vitest with no SUPERTWIN_HOME the key is ephemeral:
  // signing still works end to end, it simply does not outlive the process.
  if (process.env.VITEST && !(process.env.SUPERTWIN_HOME ?? "").trim()) {
    if (!cache || cache.path !== "<ephemeral>") {
      cache = { path: "<ephemeral>", key: randomBytes(KEY_BYTES).toString("hex") };
    }
    return cache.key;
  }

  const path = approvalKeyPath();
  if (cache && cache.path === path) return cache.key;

  let key: string;
  try {
    key = readFileSync(path, "utf8").trim();
  } catch {
    key = "";
  }
  if (!/^[0-9a-f]{32,}$/i.test(key)) {
    key = randomBytes(KEY_BYTES).toString("hex");
    mkdirSync(join(homeRoot(), "trust"), { recursive: true });
    writeFileSync(path, key + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      // writeFileSync's mode only applies at creation; force it for a file that
      // already existed with a wider mode.
      chmodSync(path, 0o600);
    } catch {
      /* best effort — a filesystem without modes is not a reason to refuse */
    }
  }
  key = key.toLowerCase();
  cache = { path, key };
  return key;
}

/** Test seam: forget the memoized key (a new home dir needs a new read). */
export function resetApprovalKeyCache(): void {
  cache = null;
}
