// ===========================================================================
// HTTP tests for the Settings "extras" wired in this stage:
//   - GET  /api/brain/info           → { dir, fileCount }
//   - POST /api/brain/reveal         → { ok }  (best-effort `open <brainRoot>`)
//   - GET  /api/brain/file           → 404 unless settings.debug_export is on
//   - GET  /api/settings/models      → now carries enabledByRole (per-process)
//   - POST /api/settings/models/enabled { role, enabled } → per-process on/off
//   - the chat kill-switch: chat disabled → notice, provider NEVER called.
//
// Boots the real worker server on an ephemeral port with a stub provider (that
// counts sends) over a temp SQLite DB + temp SUPERTWIN_HOME (brain + logs). The
// reveal routes take an injected `openPath` stub (StartServerOptions) so reveal
// never shells the real macOS `open` / pops Finder / races temp-dir teardown;
// the brain's git seeding (spawnSync) stays fully real.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db/brain/logs read these lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-brain-folder-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = tmpDir; // brain + logs → tmpDir

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const store = await import("../db/settings.js");
const { ensureBrain, brainRoot, resetBrainCacheForTests } = await import("../brain/index.js");

import type { Provider, ProviderResult, SendOptions } from "../providers/index.js";

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let chatSends = 0;
/** Records reveal-route folder opens; no real `open`/Finder is ever spawned. */
const revealed: string[] = [];

function stubProvider(): Provider {
  return {
    id: "claude-local",
    async send(opts: SendOptions): Promise<ProviderResult> {
      chatSends += 1;
      opts.onEvent({ type: "delta", text: "hi" });
      return {
        sessionId: "s",
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        },
        freshFallback: false,
        status: "ok",
      };
    },
    cancel: () => false,
  };
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  runMigrations();
  resetBrainCacheForTests();
  ensureBrain(); // seed the canonical brain layout so fileCount > 0
  register(stubProvider());
  server = await startServer({
    port: 0,
    // Inject a reveal stub so /api/brain/reveal never shells the real `open`.
    openPath: (dir) => revealed.push(dir),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  resetBrainCacheForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/brain/info", () => {
  it("returns the brain dir + a recursive file count", async () => {
    const { status, body } = await getJson<{ dir: string; fileCount: number }>("/api/brain/info");
    expect(status).toBe(200);
    expect(body.dir).toBe(brainRoot());
    expect(body.dir).toContain("brain");
    // ensureBrain() seeds me/preferences.md + me/goals.md at minimum.
    expect(body.fileCount).toBeGreaterThan(0);
  });
});

describe("POST /api/brain/reveal", () => {
  it("is best-effort ok and reveals brainRoot via the injected stub (no real Finder)", async () => {
    revealed.length = 0;
    const { status, body } = await postJson<{ ok: boolean }>("/api/brain/reveal");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The route called the injected reveal with the brain root — no real `open`.
    expect(revealed).toEqual([brainRoot()]);
  });
});

describe("GET /api/brain/file (debug export, V2 §3.2)", () => {
  it("is not on the default router — reading the brain has to be asked for", async () => {
    // The markdown brain is not a product surface any more, so a default
    // install must not serve message text out of the folder over HTTP at all.
    store.setDebugExportEnabled(false);
    writeFileSync(join(brainRoot(), "me", "notes.md"), "# Notes\n", "utf8");
    const { status } = await getJson<{ error?: string }>(
      "/api/brain/file?path=me/notes.md",
    );
    expect(status).toBe(404);
  });

  it("serves the file once settings.debug_export is on, and stops again when it is off", async () => {
    store.setDebugExportEnabled(true);
    const on = await getJson<{ path: string; content: string }>(
      "/api/brain/file?path=me/notes.md",
    );
    expect(on.status).toBe(200);
    expect(on.body.content).toContain("# Notes");

    // The flag is read per request, so turning it off takes effect at once
    // rather than at the next boot.
    store.setDebugExportEnabled(false);
    const off = await getJson<{ error?: string }>("/api/brain/file?path=me/notes.md");
    expect(off.status).toBe(404);
  });

  it("leaves the brain FOLDER routes alone — those are not the export", async () => {
    store.setDebugExportEnabled(false);
    const { status } = await getJson<{ dir: string }>("/api/brain/info");
    expect(status).toBe(200);
  });
});

describe("GET /api/settings/models (enabledByRole)", () => {
  it("carries an enabled flag per role, all true by default", async () => {
    const { status, body } = await getJson<{
      roles: { key: string }[];
      enabledByRole: Record<string, boolean>;
    }>("/api/settings/models");
    expect(status).toBe(200);
    // V8 serves two roles — chat and media reading.
    expect(Object.keys(body.enabledByRole).sort()).toEqual(["chat", "media"]);
    for (const r of body.roles) expect(body.enabledByRole[r.key]).toBe(true);
  });
});

describe("POST /api/settings/models/enabled", () => {
  it("flips a role and reflects it on the next GET", async () => {
    const post = await postJson<{ role: string; enabled: boolean }>(
      "/api/settings/models/enabled",
      { role: "chat", enabled: false },
    );
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ role: "chat", enabled: false });

    const { body } = await getJson<{ enabledByRole: Record<string, boolean> }>(
      "/api/settings/models",
    );
    expect(body.enabledByRole.chat).toBe(false);

    // Flip back on.
    const on = await postJson<{ enabled: boolean }>("/api/settings/models/enabled", {
      role: "chat",
      enabled: true,
    });
    expect(on.body.enabled).toBe(true);
  });

  it("400 on a role that no longer exists (extraction)", async () => {
    const { status } = await postJson<{ error: string }>(
      "/api/settings/models/enabled",
      { role: "extraction", enabled: false },
    );
    expect(status).toBe(400);
  });

  it("400 on an invalid role", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/settings/models/enabled",
      { role: "bogus", enabled: false },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid role");
  });

  it("400 on a non-boolean enabled", async () => {
    const { status } = await postJson("/api/settings/models/enabled", {
      role: "chat",
      enabled: "yes",
    });
    expect(status).toBe(400);
  });
});

describe("chat kill-switch (chat disabled in Settings)", () => {
  it("returns a notice and NEVER calls the provider", async () => {
    const before = chatSends;
    store.setProcessEnabled("chat", false);
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello there", grounded: false }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Chat is turned off in Settings.");
      expect(chatSends).toBe(before); // provider never invoked
    } finally {
      store.setProcessEnabled("chat", true); // restore for isolation
    }
  });
});
