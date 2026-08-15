// ===========================================================================
// HTTP tests for the media toolchain surface (v5 §4): GET /api/media/tools and
// the per-model download / cancel / delete routes.
//
// The model "server" is a real localhost HTTP server serving bytes, reached
// through SUPERTWIN_WHISPER_MODEL_BASE_URL — so the download path under test is
// the real one (stream to `.part`, verify, rename) with nothing stubbed out and
// nothing leaving the machine.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports: the db module reads SUPERTWIN_DB_PATH lazily, and
// whisperModelsDir() reads SUPERTWIN_HOME on every call.
const tmpDir = mkdtempSync(join(tmpdir(), "st-media-tools-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { WHISPER_MODELS } = await import("../media/tools.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let models: Server;
let modelsBase: string;

const modelsDir = join(tmpDir, "home", "models");

/** Bodies the stub model server hands out, keyed by request path. */
const bodies = new Map<string, Buffer>();
/** Paths whose response is held open until the returned release() is called. */
const held = new Map<string, () => void>();
/** Paths that promise a full body and then drop the connection part-way. */
const truncate = new Set<string>();

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

/** Poll GET /api/media/tools until `check` holds, so a download can settle. */
async function until(
  check: (m: ModelReport) => boolean,
  id: string,
  what: string,
): Promise<ModelReport> {
  for (let i = 0; i < 200; i++) {
    const { body } = await getJson<ToolState>("/api/media/tools");
    const model = body.models.find((m) => m.id === id)!;
    if (check(model)) return model;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface ModelReport {
  id: string;
  label: string;
  bytes: number;
  bundled: boolean;
  present: boolean;
  bytesOnDisk: number | null;
  selected: boolean;
  download: {
    status: string;
    receivedBytes: number;
    totalBytes: number | null;
    error: string | null;
  } | null;
}

interface ToolState {
  ffmpeg: { path: string | null; present: boolean; version: string | null };
  whisper: { path: string | null; present: boolean; version: string | null };
  ytdlp: { path: string | null; present: boolean; version: string | null };
  models: ModelReport[];
  modelsDir: string;
}

/** A stub binary that answers a version probe, so the state is a real read. */
function stubBinary(name: string, line: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, `#!/bin/sh\necho "${line}"\n`);
  chmodSync(path, 0o755);
  return path;
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

  models = createServer((req, res) => {
    const path = req.url ?? "";
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no such model");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(truncate.has(path) ? body.length * 2 : body.length),
    });
    if (truncate.has(path)) {
      // Promise the whole model, send half, drop the connection — what a flaky
      // network actually does to a multi-gigabyte fetch.
      res.write(body, () => res.socket?.destroy());
      return;
    }
    if (held.has(path)) {
      // Send the first half, then wait to be released — this is what gives the
      // progress assertions something in flight to look at.
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      held.set(path, () => {
        res.end(body.subarray(Math.floor(body.length / 2)));
      });
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => models.listen(0, resolve));
  modelsBase = `http://127.0.0.1:${(models.address() as AddressInfo).port}`;
  process.env.SUPERTWIN_WHISPER_MODEL_BASE_URL = modelsBase;

  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  await new Promise<void>((resolve) => models.close(() => resolve()));
  delete process.env.SUPERTWIN_WHISPER_MODEL_BASE_URL;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/media/tools", () => {
  it("reports every binary missing rather than pretending they are there", async () => {
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "nope-ffmpeg");
    process.env.SUPERTWIN_WHISPER_BIN = join(tmpDir, "nope-whisper");
    process.env.SUPERTWIN_YTDLP_BIN = join(tmpDir, "nope-ytdlp");

    const { status, body } = await getJson<ToolState>("/api/media/tools");
    expect(status).toBe(200);
    expect(body.ffmpeg).toEqual({ path: null, present: false, version: null });
    expect(body.whisper).toEqual({ path: null, present: false, version: null });
    // This route rebuilds its response field by field, so a binary can resolve
    // perfectly and still never reach Settings — yt-dlp did exactly that.
    expect(body.ytdlp).toEqual({ path: null, present: false, version: null });
    expect(body.modelsDir).toBe(modelsDir);
  });

  it("reads each binary's version off the binary itself", async () => {
    const ffmpeg = stubBinary("ffmpeg-stub", "ffmpeg version 8.1 Copyright (c)");
    const whisper = stubBinary("whisper-stub", "whisper.cpp version: 1.9.1");
    process.env.SUPERTWIN_FFMPEG_BIN = ffmpeg;
    process.env.SUPERTWIN_WHISPER_BIN = whisper;

    const { body } = await getJson<ToolState>("/api/media/tools");
    expect(body.ffmpeg).toEqual({ path: ffmpeg, present: true, version: "8.1" });
    expect(body.whisper).toEqual({
      path: whisper,
      present: true,
      version: "1.9.1",
    });
  });

  it("serves the v5 §4 catalogue with sizes, one bundled default and no .en", async () => {
    const { body } = await getJson<ToolState>("/api/media/tools");
    expect(body.models.map((m) => m.id)).toEqual(WHISPER_MODELS.map((m) => m.id));
    expect(body.models.filter((m) => m.bundled)).toHaveLength(1);
    expect(body.models.find((m) => m.bundled)!.id).toBe("large-v3-turbo-q5_0");
    expect(body.models.some((m) => m.id.endsWith(".en"))).toBe(false);
    for (const m of body.models) expect(m.bytes).toBeGreaterThan(0);
  });

  it("marks a model absent until it is actually on disk", async () => {
    const { body } = await getJson<ToolState>("/api/media/tools");
    const tiny = body.models.find((m) => m.id === "tiny")!;
    expect(tiny.present).toBe(false);
    expect(tiny.bytesOnDisk).toBeNull();
    expect(tiny.download).toBeNull();
  });
});

describe("POST /api/media/models/download", () => {
  it("fetches a model, reports progress, and only names it once it is whole", async () => {
    const payload = Buffer.alloc(4096, 7);
    bodies.set("/ggml-tiny.bin", payload);
    held.set("/ggml-tiny.bin", () => {});

    const start = await postJson<{ download: { status: string } }>(
      "/api/media/models/download",
      { id: "tiny" },
    );
    expect(start.status).toBe(202);
    expect(start.body.download.status).toBe("downloading");

    const midway = await until(
      (m) => m.download?.totalBytes === payload.length,
      "tiny",
      "the declared size to arrive",
    );
    // Held open half-way: the file must not exist under its real name yet, or a
    // reader would pick up a partial model as if it were staged.
    expect(midway.present).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(false);
    expect(midway.download!.receivedBytes).toBeLessThan(payload.length);

    held.get("/ggml-tiny.bin")!();
    const done = await until((m) => m.present, "tiny", "the download to finish");
    expect(done.bytesOnDisk).toBe(payload.length);
    expect(done.download).toBeNull();
    expect(readFileSync(join(modelsDir, "ggml-tiny.bin"))).toEqual(payload);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin.part"))).toBe(false);

    held.delete("/ggml-tiny.bin");
  });

  it("answers a second request for a model already here without re-fetching", async () => {
    const { status, body } = await postJson<{ download: null }>(
      "/api/media/models/download",
      { id: "tiny" },
    );
    expect(status).toBe(200);
    expect(body.download).toBeNull();
  });

  it("records why a download failed and leaves nothing behind", async () => {
    // Nothing registered for this path, so the stub answers 404.
    const start = await postJson("/api/media/models/download", { id: "base" });
    expect(start.status).toBe(202);

    const failed = await until(
      (m) => m.download?.status === "error",
      "base",
      "the failure to be recorded",
    );
    expect(failed.download!.error).toContain("404");
    expect(failed.present).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-base.bin"))).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-base.bin.part"))).toBe(false);
  });

  it("treats a dropped connection as a failure, not a short model", async () => {
    bodies.set("/ggml-small.bin", Buffer.alloc(2048, 3));
    truncate.add("/ggml-small.bin");

    await postJson("/api/media/models/download", { id: "small" });
    const failed = await until(
      (m) => m.download?.status === "error",
      "small",
      "the short body to be rejected",
    );
    expect(failed.present).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-small.bin"))).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-small.bin.part"))).toBe(false);

    truncate.delete("/ggml-small.bin");
    bodies.delete("/ggml-small.bin");
  });

  it("rejects an id outside the catalogue before it builds any path", async () => {
    for (const id of ["../../evil", "large-v3-turbo-q5_0.bin", "tiny.en", 12]) {
      const { status, body } = await postJson<{ error: string }>(
        "/api/media/models/download",
        { id },
      );
      expect(status).toBe(400);
      expect(body.error).toContain("id must be one of");
    }
    // Nothing was written for the traversal attempt.
    expect(existsSync(join(tmpDir, "ggml-../../evil.bin"))).toBe(false);
  });
});

describe("POST /api/media/models/cancel", () => {
  it("stops an in-flight download and leaves no partial file", async () => {
    const payload = Buffer.alloc(8192, 5);
    bodies.set("/ggml-medium-q5_0.bin", payload);
    held.set("/ggml-medium-q5_0.bin", () => {});

    await postJson("/api/media/models/download", { id: "medium-q5_0" });
    await until(
      (m) => m.download?.status === "downloading",
      "medium-q5_0",
      "the download to start",
    );

    const { status, body } = await postJson<{ cancelled: boolean }>(
      "/api/media/models/cancel",
      { id: "medium-q5_0" },
    );
    expect(status).toBe(200);
    expect(body.cancelled).toBe(true);

    const after = await until(
      (m) => m.download === null,
      "medium-q5_0",
      "the cancelled download to clear",
    );
    // A cancel is the user's answer, not a failure to report back at them.
    expect(after.present).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(modelsDir, "ggml-medium-q5_0.bin.part"))).toBe(false);

    held.get("/ggml-medium-q5_0.bin")?.();
    held.delete("/ggml-medium-q5_0.bin");
    bodies.delete("/ggml-medium-q5_0.bin");
  });
});

describe("POST /api/media/models/delete", () => {
  it("removes a downloaded model", async () => {
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(true);

    const { status, body } = await postJson<{ deleted: boolean; models: ModelReport[] }>(
      "/api/media/models/delete",
      { id: "tiny" },
    );
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.models.find((m) => m.id === "tiny")!.present).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(false);
  });

  it("is a no-op for a model that was never downloaded", async () => {
    const { status, body } = await postJson<{ deleted: boolean }>(
      "/api/media/models/delete",
      { id: "large-v3" },
    );
    expect(status).toBe(200);
    expect(body.deleted).toBe(false);
  });

  it("refuses the bundled model, which lives inside the app", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/media/models/delete",
      { id: "large-v3-turbo-q5_0" },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("bundled");
  });

  it("refuses the model transcription is set to use", async () => {
    await postJson("/api/settings/media", { whisper_model: "large-v3-q5_0" });

    const { status, body } = await postJson<{ error: string }>(
      "/api/media/models/delete",
      { id: "large-v3-q5_0" },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("select another one first");

    await postJson("/api/settings/media", { whisper_model: "large-v3-turbo-q5_0" });
  });

  it("rejects an id outside the catalogue", async () => {
    const { status } = await postJson<{ error: string }>(
      "/api/media/models/delete",
      { id: "../../../etc/passwd" },
    );
    expect(status).toBe(400);
  });
});
