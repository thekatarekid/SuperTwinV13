// ===========================================================================
// POST /api/screen/record — the explicit "Record from now on" (V6 P1 S1.3,
// T4-8). Real server, real temp DB (0200 consents + app_state), a fake
// screenwatch binary on SUPERTWIN_SCREENWATCH_BIN standing in for the
// Accessibility probe, and a spy screen driver on the source supervisor —
// so the test proves the ORDER of the three gates without spawning the real
// sidecar or touching Accessibility. Zero model calls.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-screen-record-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
const fakeBin = join(tmpDir, "screenwatch");
const prevBinEnv = process.env.SUPERTWIN_SCREENWATCH_BIN;
process.env.SUPERTWIN_SCREENWATCH_BIN = fakeBin;

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");
const { grantConsent } = await import("../db/v6core.js");
const { appStateGet } = await import("../db/ingest.js");
const {
  SCREEN_RECORD_FROM_KEY,
  setSourceSupervisor,
  SourceSupervisor,
} = await import("../adapters/supervisor.js");
type StartContext = import("../adapters/supervisor.js").StartContext;

/** Point the probe at a script that answers with the given verdict. */
function fakeProbe(granted: boolean): void {
  writeFileSync(
    fakeBin,
    `#!/bin/sh\necho '{"t":"permission","granted":"${granted ? "true" : "false"}"}'\n`,
    { mode: 0o755 },
  );
}

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
const screenStarts: StartContext[] = [];

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  fakeProbe(false);
  setSourceSupervisor(
    new SourceSupervisor({
      drivers: {
        screen: {
          start: (ctx) => void screenStarts.push(ctx),
          stop: () => {},
        },
      },
    }),
  );
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  setSourceSupervisor(null);
  if (prevBinEnv === undefined) delete process.env.SUPERTWIN_SCREENWATCH_BIN;
  else process.env.SUPERTWIN_SCREENWATCH_BIN = prevBinEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function post(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/screen/record — consent → Accessibility → record", () => {
  it("status before anything: not running, no consent, no recordFrom", async () => {
    const res = await fetch(`${base}/api/screen/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.running).toBe(false);
    expect(body.state).toBe("not_started");
    expect(body.consent).toBe(false);
    expect(body.recordFrom).toBeNull();
  });

  it("gate 1 — no connected consent row: 409 no-consent, nothing written, nothing spawned", async () => {
    const { status, body } = await post("/api/screen/record");
    expect(status).toBe(409);
    expect(body.error).toBe("no-consent");
    expect(appStateGet(SCREEN_RECORD_FROM_KEY)).toBeNull();
    expect(screenStarts).toHaveLength(0);
  });

  it("gate 2 — consent present, Accessibility denied: 409 need_permission with the settings deep link; still nothing spawned", async () => {
    grantConsent({ source: "screen" });
    const { status, body } = await post("/api/screen/record");
    expect(status).toBe(409);
    expect(body.error).toBe("need_permission");
    expect(body.reason).toBe("denied");
    expect(String(body.settingsUrl)).toContain("Privacy_Accessibility");
    expect(appStateGet(SCREEN_RECORD_FROM_KEY)).toBeNull();
    expect(screenStarts).toHaveLength(0);
  });

  it("GET /api/screen/permission reports the probe without spawning the sidecar", async () => {
    const res = await fetch(`${base}/api/screen/permission`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.granted).toBe(false);
    expect(body.reason).toBe("denied");
    expect(screenStarts).toHaveLength(0);
  });

  it("gate 3 — consent + Accessibility + the explicit record: app_state written, the source started ONCE", async () => {
    fakeProbe(true);
    const before = Date.now();
    const { status, body } = await post("/api/screen/record");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.running).toBe(true);
    const from = String(body.recordFrom);
    expect(Date.parse(from)).toBeGreaterThanOrEqual(before - 1);
    expect(appStateGet(SCREEN_RECORD_FROM_KEY)).toBe(from);
    expect(screenStarts).toHaveLength(1);
    expect(screenStarts[0]!.recordFrom).toBe(from);
    expect(screenStarts[0]!.consent?.source).toBe("screen");

    // A second press re-stamps the instant but does not spawn a second sidecar.
    const again = await post("/api/screen/record");
    expect(again.status).toBe(200);
    expect(screenStarts).toHaveLength(1);

    const st = (await (await fetch(`${base}/api/screen/status`)).json()) as Record<string, unknown>;
    expect(st.consent).toBe(true);
    expect(st.recordFrom).toBe(String(again.body.recordFrom));
  });
});
