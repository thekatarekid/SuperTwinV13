// ===========================================================================
// HTTP tests for GET/POST /api/settings/models (per-role model selection).
// Boots the real worker server on an ephemeral port with a STUB provider (no
// real `claude` CLI) and a temp SQLite DB — same lightweight pattern as
// the other route-module tests. Verifies the catalog + roles + selections are served,
// a valid per-role selection round-trips in isolation, and bad role/model 400.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-settings-model-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { MODEL_CATALOG, MODEL_ROLES } = await import(
  "../providers/claude-local/models.js"
);

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

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
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      freshFallback: false,
      status: "ok" as const,
    }),
    cancel: () => false,
  });
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

type ModelsGet = {
  models: { id: string; label: string; family: string }[];
  roles: { key: string; label: string; description: string; future: boolean }[];
  selections: Record<string, string>;
};

describe("GET /api/settings/models", () => {
  it("returns the catalog, the role list, and per-role selections", async () => {
    const { status, body } = await getJson<ModelsGet>("/api/settings/models");
    expect(status).toBe(200);
    expect(body.models).toEqual(MODEL_CATALOG);
    expect(body.roles).toEqual(MODEL_ROLES);
    // One picker per step (§4.2) — every role in the list has a selection.
    expect(Object.keys(body.selections).sort()).toEqual(
      MODEL_ROLES.map((r) => r.key).sort(),
    );
    // Chat is empty (subscription default) until something is picked; the
    // mechanical steps pin Haiku and the judgment steps pin Sonnet.
    expect(body.selections.chat).toBe("");
    expect(body.selections.media).toBe("claude-haiku-4-5-20251001");
    expect(body.selections.triage).toBe("claude-haiku-4-5-20251001");
    expect(body.selections.extract).toBe("claude-sonnet-5");
    expect(body.selections.adjudicate).toBe("claude-sonnet-5");
  });
});

describe("POST /api/settings/models", () => {
  it("persists the targeted role and reflects it on the next GET", async () => {
    const post = await postJson<{ role: string; selected: string }>(
      "/api/settings/models",
      { role: "chat", model: "claude-opus-4-8" },
    );
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ role: "chat", selected: "claude-opus-4-8" });

    const { body } = await getJson<ModelsGet>("/api/settings/models");
    expect(body.selections.chat).toBe("claude-opus-4-8");
  });

  it("persists the media role without touching chat", async () => {
    const post = await postJson<{ role: string; selected: string }>(
      "/api/settings/models",
      { role: "media", model: "sonnet" },
    );
    expect(post.status).toBe(200);

    const { body } = await getJson<ModelsGet>("/api/settings/models");
    expect(body.selections.media).toBe("sonnet");
    expect(body.selections.chat).toBe("claude-opus-4-8");
  });

  it("accepts the empty-string default for a role", async () => {
    const post = await postJson<{ role: string; selected: string }>(
      "/api/settings/models",
      { role: "chat", model: "" },
    );
    expect(post.status).toBe(200);
    expect(post.body.selected).toBe("");
  });

  it("rejects a role that no longer exists (extraction) with 400", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/settings/models",
      { role: "extraction", model: "" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid role");
  });

  it("rejects an invalid role with 400 'invalid role'", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/settings/models",
      { role: "bogus", model: "claude-opus-4-8" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid role");
  });

  it("rejects an invalid model with 400 'invalid model'", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/settings/models",
      { role: "chat", model: "gpt-4" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid model");
  });

  it("rejects a missing role with 400 (role validated first)", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/settings/models",
      { model: "claude-opus-4-8" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid role");
  });
});
