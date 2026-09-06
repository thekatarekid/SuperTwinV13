// ===========================================================================
// POST /api/screen/request-permission + the permission field on /status
// (V6 P1 S6d / L4). Real server, real temp DB, a fake `screenwatch` on
// SUPERTWIN_SCREENWATCH_BIN that records which FLAG it was invoked with — so
// the test proves the app actually asks macOS, without touching Accessibility.
//
// The regression these guard: 13.11.5 only ever ran --check-permission, which
// reports and registers nothing. macOS lists an app in Privacy & Security ›
// Accessibility only once something calls AXIsProcessTrustedWithOptions with
// the prompt option, so SuperTwin was absent from that list entirely and the
// permission could not be granted by any route the user had. On top of that,
// /status answered with NO `permission` field when the sidecar was not
// running, so the panel could not tell "blocked" from "nothing captured yet".
//
// Zero model calls.
// ===========================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-screen-perm-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
const fakeBin = join(tmpDir, "screenwatch");
const flagLog = join(tmpDir, "flags.log");
const prevBinEnv = process.env.SUPERTWIN_SCREENWATCH_BIN;
process.env.SUPERTWIN_SCREENWATCH_BIN = fakeBin;

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");
const { grantConsent } = await import("../db/v6core.js");
const { invalidateAccessibilityProbeCache } = await import("../adapters/screen/permission.js");

/**
 * A stand-in sidecar that logs its argv and answers the way the real one does:
 * `--request-permission` echoes `prompted:"true"`, `--check-permission` does
 * not. `granted` is whatever the file was last written with.
 */
function fakeSidecar(granted: boolean): void {
  writeFileSync(
    fakeBin,
    `#!/bin/sh
echo "$1" >> '${flagLog}'
if [ "$1" = "--request-permission" ]; then
  echo '{"t":"permission","granted":"${granted ? "true" : "false"}","prompted":"true"}'
else
  echo '{"t":"permission","granted":"${granted ? "true" : "false"}","prompted":"false"}'
fi
`,
    { mode: 0o755 },
  );
}

function flags(): string[] {
  if (!existsSync(flagLog)) return [];
  return readFileSync(flagLog, "utf8").split("\n").filter(Boolean);
}

function resetFlags(): void {
  writeFileSync(flagLog, "");
}

type ServerHandle = { port: number; close(): Promise<void> };
let server: ServerHandle;
let base: string;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  fakeSidecar(false);
  resetFlags();
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  invalidateAccessibilityProbeCache();
  resetFlags();
});

afterAll(async () => {
  await server.close();
  if (prevBinEnv === undefined) delete process.env.SUPERTWIN_SCREENWATCH_BIN;
  else process.env.SUPERTWIN_SCREENWATCH_BIN = prevBinEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`);
  return (await res.json()) as Record<string, unknown>;
}

describe("the Accessibility ask", () => {
  it("POST /api/screen/request-permission runs --request-permission — the call that creates the System Settings row", async () => {
    const res = await fetch(`${base}/api/screen/request-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The whole bug in one assertion: the app must ASK, not merely check.
    expect(flags()).toEqual(["--request-permission"]);
    expect(body.prompted).toBe(true);
    // Asking does not grant: the row exists, the user has yet to switch it on.
    expect(body.granted).toBe(false);
    expect(String(body.settingsUrl)).toContain("Privacy_Accessibility");
  });

  it("GET /api/screen/permission only ever checks — a poll must never put a dialog up", async () => {
    await getJson("/api/screen/permission");
    expect(flags()).toEqual(["--check-permission"]);
  });

  it("the ask is POST-only: a GET does not reach it, so nothing asks by accident", async () => {
    const res = await fetch(`${base}/api/screen/request-permission`);
    expect(res.status).toBe(404);
    expect(flags()).toEqual([]);
  });

  it("polling /permission is memoised — the panel can poll without a spawn per tick", async () => {
    await getJson("/api/screen/permission");
    await getJson("/api/screen/permission");
    await getJson("/api/screen/permission");
    expect(flags()).toEqual(["--check-permission"]);
    // …and `?fresh=1` still forces a real probe.
    await getJson("/api/screen/permission?fresh=1");
    expect(flags()).toEqual(["--check-permission", "--check-permission"]);
  });

  it("GET /api/screen/status carries `permission` even when the sidecar is NOT running", async () => {
    const body = await getJson("/api/screen/status");
    expect(body.running).toBe(false);
    expect(body.state).toBe("not_started");
    // Before S6d this field was simply absent here, so the panel read "no
    // permission problem" and showed its empty state for a blocked source.
    expect(body.permission).toBe(false);
    expect(body.permissionReason).toBe("denied");
    expect(flags()).toEqual(["--check-permission"]);
  });

  it("once granted, /status says so and the three gates line up for the record arm", async () => {
    grantConsent({ source: "screen" });
    fakeSidecar(true);
    invalidateAccessibilityProbeCache();
    const body = await getJson("/api/screen/status");
    expect(body.consent).toBe(true);
    expect(body.permission).toBe(true);
    expect(body.permissionReason).toBe("granted");
    // Gate 3 is still outstanding: consent + permission is not recording.
    expect(body.recordFrom).toBeNull();
    expect(body.running).toBe(false);
  });
});
