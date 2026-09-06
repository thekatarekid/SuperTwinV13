// ===========================================================================
// [TEST] /api/health names what did not start (V6 P1 W1).
//
// The fix for the 13.11.1/13.11.2 dead worker is that an optional subsystem
// degrades instead of taking the process down. Degrading in silence is the
// next version of the same bug — the app would look healthy while a lane was
// missing — so the boot's degradations ride on the one endpoint the shell
// already polls.
// ===========================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (the db module reads SUPERTWIN_DB_PATH lazily).
const tmpDir = mkdtempSync(join(tmpdir(), "st-health-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");
const { clearBootDegradations, optionalStep } = await import("../boot-guard.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  clearBootDegradations();
});

afterAll(async () => {
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const health = async (): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;

describe("GET /api/health", () => {
  it("says nothing about degradation on a clean boot", async () => {
    const body = await health();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("degraded");
  });

  it("names the subsystem that failed, and why", async () => {
    optionalStep(
      "golden gate",
      () => {
        throw new TypeError(`The "path" argument must be of type string or an instance of URL. Received undefined`);
      },
      { log: () => {} },
    );

    const body = await health();
    // Still ok: the worker IS up, which is the whole point of the change.
    expect(body.ok).toBe(true);
    expect(body.degraded).toEqual([
      {
        name: "golden gate",
        error: `The "path" argument must be of type string or an instance of URL. Received undefined`,
      },
    ]);
  });

  it("carries every failure, in the order they happened", async () => {
    optionalStep("dispatcher", () => { throw new Error("a"); }, { log: () => {} });
    optionalStep("brief", () => { throw new Error("b"); }, { log: () => {} });
    const body = await health();
    expect((body.degraded as { name: string }[]).map((d) => d.name)).toEqual(["dispatcher", "brief"]);
  });
});
