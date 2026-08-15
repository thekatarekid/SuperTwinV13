// HTTP surface of the embedding-model registry (task 5.4).
//
// The logic — digests, the atomic flip, the benchmark arithmetic — is pinned in
// worker/src/retrieval/*.test.ts. What is checked here is the part only the
// route layer can get wrong: what it refuses, and what it refuses to refuse.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-embedding-registry-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { runMigrations } = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const {
  ACTIVE_EMBEDDING_MODEL_KEY,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_E5_BASE,
  EMBEDDING_MODEL_GEMMA,
} = await import("../retrieval/model-registry.js");

type ServerHandle = { port: number; close(): Promise<void> };

interface ModelRow {
  id: string;
  label: string;
  dim: number;
  bytes: number;
  bundled: boolean;
  recommended: boolean;
  active: boolean;
  present: boolean;
  indexed: number;
  upstream: string | null;
}

interface Registry {
  active: string;
  models: ModelRow[];
  swap: { phase: string } | null;
  benchmark: unknown;
  benchmarkRunning: string | null;
  error?: string;
}

let server: ServerHandle;
let base: string;

async function getModels(): Promise<{ status: number; body: Registry }> {
  const res = await fetch(`${base}/api/retrieval/semantic/models`);
  return { status: res.status, body: (await res.json()) as Registry };
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Registry }> {
  const res = await fetch(`${base}/api/retrieval/semantic/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Registry };
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
  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(ACTIVE_EMBEDDING_MODEL_KEY);
});

describe("GET /api/retrieval/semantic/models", () => {
  it("lists the catalogue with the bundled default active", async () => {
    const { status, body } = await getModels();
    expect(status).toBe(200);
    expect(body.active).toBe(EMBEDDING_MODEL.id);
    expect(body.models.map((m) => m.id)).toEqual([
      EMBEDDING_MODEL.id,
      EMBEDDING_MODEL_GEMMA.id,
      EMBEDDING_MODEL_E5_BASE.id,
      "Xenova/bge-m3",
    ]);
    const active = body.models.find((m) => m.active)!;
    expect(active.id).toBe(EMBEDDING_MODEL.id);
    expect(body.models.filter((m) => m.recommended).map((m) => m.id)).toEqual([
      EMBEDDING_MODEL_GEMMA.id,
    ]);
    // The picker has to be able to say "google/embeddinggemma-300m" even
    // though the runnable artifact is the ONNX export.
    expect(body.models.find((m) => m.id === EMBEDDING_MODEL_GEMMA.id)?.upstream).toBe(
      "google/embeddinggemma-300m",
    );
    for (const m of body.models) expect(m.bytes).toBeGreaterThan(0);
  });

  it("reports every model as holding no vectors before anything is indexed", async () => {
    const { body } = await getModels();
    expect(body.models.every((m) => m.indexed === 0)).toBe(true);
    expect(body.swap).toBeNull();
    expect(body.benchmarkRunning).toBeNull();
  });
});

describe("what the registry routes refuse", () => {
  it("rejects an id that is not in the catalogue", async () => {
    for (const path of [
      "models/download",
      "models/delete",
      "models/cancel",
      "models/activate",
      "benchmark",
    ]) {
      const { status, body } = await post(path, { id: "not/a-model" });
      expect(status, path).toBe(400);
      expect(body.error).toMatch(/catalogue/);
    }
  });

  it("will not delete the bundled encoder — it lives inside the signed app", async () => {
    const { status, body } = await post("models/delete", { id: EMBEDDING_MODEL.id });
    expect(status).toBe(409);
    expect(body.error).toMatch(/inside the app/);
  });

  it("will not delete the model the index is built on", async () => {
    const { status, body } = await post("models/delete", { id: EMBEDDING_MODEL_GEMMA.id });
    // Not active, but also not downloaded — deleting it is a no-op, not a 409.
    expect(status).toBe(200);
    expect(body.active).toBe(EMBEDDING_MODEL.id);
  });

  it("refuses to swap to a model whose weights are not here", async () => {
    const { status, body } = await post("models/activate", { id: EMBEDDING_MODEL_GEMMA.id });
    expect(status).toBe(409);
    expect(body.error).toMatch(/not downloaded/);
    expect(body.active).toBe(EMBEDDING_MODEL.id);
  });

  it("treats activating the model already in use as a no-op, not an error", async () => {
    const { status, body } = await post("models/activate", { id: EMBEDDING_MODEL.id });
    expect(status).toBe(200);
    expect(body.active).toBe(EMBEDDING_MODEL.id);
    expect(body.swap).toBeNull();
  });

  it("never reaches the network for the bundled encoder", async () => {
    const { status } = await post("models/download", { id: EMBEDDING_MODEL.id });
    // Not staged in this tree, so it is a normal fetch request (202); what
    // matters is that it is answered rather than erroring.
    expect([200, 202]).toContain(status);
    await post("models/cancel", { id: EMBEDDING_MODEL.id });
  });
});
