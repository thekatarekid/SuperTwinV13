// ===========================================================================
// Browser routes — build P3.4. The manager and HTTP surface answer honestly
// when the staged Chromium is absent (dev/test), and the kill-switch route
// flips the flag every harness action honors (menu-bar wiring).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { BrowserManager, handleBrowserRoute } from "./routes.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-browser-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  // Ensure no staged Chromium is picked up from a real build tree.
  process.env.SUPERTWIN_CHROMIUM_PATH = join(tmpDir, "no-such-chromium");
  closeDb();
  runMigrations();
});
afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_CHROMIUM_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Spin the route onto a real http server so the request/response plumbing is
// exercised, then hit it with fetch.
async function withServer(
  manager: BrowserManager,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    handleBrowserRoute(req, res, manager).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("browser routes", () => {
  it("reports unavailable + not running when no Chromium is staged", async () => {
    const manager = new BrowserManager();
    await withServer(manager, async (base) => {
      const res = await fetch(`${base}/api/browser/status`);
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.available).toBe(false);
      expect(body.running).toBe(false);
      expect(body.killSwitch).toBe(false);
      expect(body.profileDir).toContain("browser-profile");
    });
  });

  it("flips the kill-switch (menu-bar wiring) and persists it", async () => {
    const manager = new BrowserManager();
    await withServer(manager, async (base) => {
      const on = await fetch(`${base}/api/browser/kill-switch`, {
        method: "POST",
        body: JSON.stringify({ on: true }),
      });
      expect(((await on.json()) as any).killSwitch).toBe(true);
      expect(manager.safety.killSwitch).toBe(true);

      const status = (await (await fetch(`${base}/api/browser/status`)).json()) as any;
      expect(status.killSwitch).toBe(true);

      await fetch(`${base}/api/browser/kill-switch`, {
        method: "POST",
        body: JSON.stringify({ on: false }),
      });
      expect(manager.safety.killSwitch).toBe(false);
    });
  });

  it("rejects a malformed kill-switch body", async () => {
    const manager = new BrowserManager();
    await withServer(manager, async (base) => {
      const res = await fetch(`${base}/api/browser/kill-switch`, {
        method: "POST",
        body: JSON.stringify({ on: "yes" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("lists the connectable services (connect-your-accounts catalogue)", async () => {
    const manager = new BrowserManager();
    await withServer(manager, async (base) => {
      const body = (await (await fetch(`${base}/api/browser/services`)).json()) as any;
      const ids = body.services.map((s: { id: string }) => s.id);
      expect(ids).toEqual(["youtube", "x", "chatgpt", "gemini", "instagram"]);
    });
  });

  it("returns 503 with a stated reason when a connect needs the absent browser", async () => {
    const manager = new BrowserManager();
    await withServer(manager, async (base) => {
      const res = await fetch(`${base}/api/browser/connect`, {
        method: "POST",
        body: JSON.stringify({ service: "x" }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toMatch(/unavailable|staged Chromium/);
    });
  });

  it("resume clears a standing stop", async () => {
    const manager = new BrowserManager();
    // Force a standing stop, then resume via the route.
    (manager.safety as unknown as { stoppedReason: unknown }).stoppedReason = {
      at: 1,
      kind: "challenge",
      site: "x.com",
      message: "m",
    };
    await withServer(manager, async (base) => {
      const res = await fetch(`${base}/api/browser/resume`, {
        method: "POST",
        body: JSON.stringify({ site: "x.com" }),
      });
      expect(res.status).toBe(200);
      expect(manager.safety.stopped).toBeNull();
    });
  });
});
