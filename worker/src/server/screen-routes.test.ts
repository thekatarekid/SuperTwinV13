// ===========================================================================
// HTTP tests for the screen source surface (build P2.1) — real server, real
// temp DB, ScreenAdapter driven by a fake sidecar child (no spawn, no
// Accessibility). Verifies the exact surface the onboarding screen and the
// Library privacy controls consume.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-screen-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");
const { startScreenWatcher, MemoryScreenSink } = await import("../adapters/screen/index.js");
type ChildLike = import("../adapters/screen/index.js").ChildLike;

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly writes: string[] = [];
  pid = 778;
  stdin = { write: (chunk: string) => void this.writes.push(chunk), end: () => {} };
  kill(): boolean {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
  line(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let child: FakeChild;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  child = new FakeChild();
  startScreenWatcher({
    spawn: () => child,
    sink: new MemoryScreenSink(),
    autoRestart: false,
    mock: true,
  });
  child.line({ t: "ready", mock: "true" });
  child.line({ t: "status", state: "need_permission" });
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("screen routes", () => {
  it("GET /api/screen/status surfaces permission state + settings deep link", async () => {
    const res = await fetch(`${base}/api/screen/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.running).toBe(true);
    expect(body.state).toBe("need_permission");
    expect(body.permission).toBe(false);
    expect(String(body.settingsUrl)).toContain("Privacy_Accessibility");
  });

  it("POST /api/screen/pause toggles the kill-switch", async () => {
    child.line({ t: "status", state: "capturing" });
    const res = await fetch(`${base}/api/screen/pause`, {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.paused).toBe(true);
    expect(body.state).toBe("paused");
    expect(child.writes.some((w) => w.includes('"pause"'))).toBe(true);

    const bad = await fetch(`${base}/api/screen/pause`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  it("POST /api/screen/pause-app pauses one bundle id", async () => {
    const res = await fetch(`${base}/api/screen/pause-app`, {
      method: "POST",
      body: JSON.stringify({ bundle_id: "com.apple.Mail", paused: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pausedApps: string[] };
    expect(body.pausedApps).toContain("com.apple.mail");
    expect(child.writes.some((w) => w.includes("pause_app"))).toBe(true);

    const bad = await fetch(`${base}/api/screen/pause-app`, {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    });
    expect(bad.status).toBe(400);
  });
});
