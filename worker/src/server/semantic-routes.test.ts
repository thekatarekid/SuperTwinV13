// HTTP tests for the semantic-retrieval surface (docs/v6-spec.md §1, tier 3):
// GET /api/retrieval/semantic and the enable / download / cancel / delete
// routes behind the Settings card.
//
// The encoder "server" is a real localhost HTTP server serving real bytes,
// reached through SUPERTWIN_EMBEDDING_MODEL_BASE_URL — so the path under test
// is the real one (stream to `.part`, hash, rename) with nothing stubbed and
// nothing leaving the machine. The catalogue's digests are of the actual
// 118 MB encoder, so this suite pins its own tiny catalogue over them: what is
// being tested is that a mismatch is caught, not what the real files hash to.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-semantic-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");
// Force the switch to follow the stored setting rather than an inherited env.
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { EMBEDDING_MODEL, embeddingModelFilePath, forgetEmbedder } = await import(
  "../retrieval/embedder.js"
);
type EmbeddingModelSpec = typeof EMBEDDING_MODEL;
const { setSemanticRetrievalEnabled } = await import("../db/settings.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let origin: Server;

/** Bodies the stub encoder host hands out, keyed by request path. */
const bodies = new Map<string, Buffer>();
/** Paths that promise a full body and then drop the connection part-way. */
const truncate = new Set<string>();

interface FileReport {
  path: string;
  bytes: number;
  present: boolean;
  bytesOnDisk: number | null;
}

interface Report {
  availability: string;
  enabled: boolean;
  model: string;
  dim: number;
  reason: string;
  indexed: number;
  embeddable: number;
  runtimeInstalled: boolean;
  modelBytes: number;
  modelDir: string;
  bundled: boolean;
  present: boolean;
  files: FileReport[];
  download: {
    status: string;
    receivedBytes: number;
    totalBytes: number;
    file: string;
    error: string | null;
  } | null;
}

async function get(): Promise<{ status: number; body: Report }> {
  const res = await fetch(`${base}/api/retrieval/semantic`);
  return { status: res.status, body: (await res.json()) as Report };
}

async function post(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Report & { error?: string; deleted?: number; cancelled?: boolean } }> {
  const res = await fetch(`${base}/api/retrieval/semantic/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/** Poll the report until `check` holds, so a download can settle. */
async function until(check: (r: Report) => boolean, what: string): Promise<Report> {
  for (let i = 0; i < 200; i++) {
    const { body } = await get();
    if (check(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Replace the catalogue with files small enough to serve from memory. Mutating
 * the shared spec is the point: the routes must build their paths, URLs and
 * digests from the catalogue and from nothing else.
 */
type Catalogue = { files: EmbeddingModelSpec["files"] };
const REAL_FILES = EMBEDDING_MODEL.files;

function stubCatalogue(contents: Record<string, string>): void {
  bodies.clear();
  const files = Object.entries(contents).map(([path, text]) => {
    const buf = Buffer.from(text, "utf8");
    bodies.set(`/${path}`, buf);
    return {
      path,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  });
  (EMBEDDING_MODEL as Catalogue).files = files;
}

function clearDisk(): void {
  rmSync(join(tmpDir, "home", "models", "embeddings"), {
    recursive: true,
    force: true,
  });
}

beforeAll(async () => {
  runMigrations();
  // startServer refuses to boot without one; nothing here sends a message.
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

  origin = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404).end("no such file");
      return;
    }
    if (truncate.has(path)) {
      res.writeHead(200, { "content-length": String(body.length * 2) });
      res.write(body);
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  process.env.SUPERTWIN_EMBEDDING_MODEL_BASE_URL = `http://127.0.0.1:${
    (origin.address() as AddressInfo).port
  }`;

  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  (EMBEDDING_MODEL as Catalogue).files = REAL_FILES;
  delete process.env.SUPERTWIN_EMBEDDING_MODEL_BASE_URL;
  await server.close();
  await new Promise<void>((r) => origin.close(() => r()));
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  truncate.clear();
  clearDisk();
  forgetEmbedder();
  setSemanticRetrievalEnabled(false);
  stubCatalogue({
    "config.json": `{"model_type":"bert"}`,
    "onnx/model_quantized.onnx": "not really a graph, but the right bytes",
  });
});

describe("GET /api/retrieval/semantic", () => {
  it("reports off, absent and unusable before anything is asked of it", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.present).toBe(false);
    expect(body.model).toBe("Xenova/multilingual-e5-small");
    expect(body.dim).toBe(384);
    expect(body.files.map((f) => f.present)).toEqual([false, false]);
    expect(body.modelBytes).toBe(body.files.reduce((n, f) => n + f.bytes, 0));
    // The runtime is a real dependency, so this is the one half that IS here.
    expect(body.runtimeInstalled).toBe(true);
    // v7 §7 ships the encoder inside the .app, but this suite's catalogue is
    // its own — so nothing staged can match it, and the card is told to offer
    // the download rather than to claim the bundle it is not reading from.
    expect(body.bundled).toBe(false);
    expect(body.modelDir).toContain(join("models", "embeddings"));
  });

  it("counts what could be indexed without an encoder anywhere near it", async () => {
    const { body } = await get();
    expect(body.indexed).toBe(0);
    expect(body.embeddable).toBeGreaterThanOrEqual(0);
  });
});

describe("POST /api/retrieval/semantic/enable", () => {
  it("turns on, and says the weights are still missing rather than claiming ready", async () => {
    const { status, body } = await post("enable", { on: true });
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.availability).toBe("no-model");
    expect(body.reason).toContain("not downloaded yet");
  });

  it("turns off again", async () => {
    await post("enable", { on: true });
    const { body } = await post("enable", { on: false });
    expect(body.enabled).toBe(false);
    expect(body.availability).toBe("disabled");
  });

  it("rejects anything that is not a boolean", async () => {
    const { status, body } = await post("enable", { on: "yes" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/true or false/);
    expect((await get()).body.enabled).toBe(false);
  });
});

describe("POST /api/retrieval/semantic/download", () => {
  it("fetches every file, verifies it, and only then reports it present", async () => {
    const { status } = await post("download");
    expect(status).toBe(202);

    const done = await until((r) => r.present, "the encoder to land");
    expect(done.files.every((f) => f.present)).toBe(true);
    expect(done.download).toBeNull();
    for (const f of EMBEDDING_MODEL.files) {
      expect(existsSync(embeddingModelFilePath(f.path))).toBe(true);
      expect(existsSync(`${embeddingModelFilePath(f.path)}.part`)).toBe(false);
    }
  });

  it("answers 200 rather than an error when it is already here", async () => {
    await post("download");
    await until((r) => r.present, "the encoder to land");
    const { status, body } = await post("download");
    expect(status).toBe(200);
    expect(body.present).toBe(true);
  });

  it("refuses a file whose bytes are not the pinned ones, and leaves nothing behind", async () => {
    bodies.set("/config.json", Buffer.from(`{"model_type":"something else"}`));

    await post("download");
    const failed = await until((r) => r.download?.status === "error", "the mismatch");
    expect(failed.download?.error).toMatch(/checksum/);
    expect(failed.present).toBe(false);
    expect(existsSync(embeddingModelFilePath("config.json"))).toBe(false);
    expect(existsSync(`${embeddingModelFilePath("config.json")}.part`)).toBe(false);
  });

  it("treats a body that stops early as a failure, not a shorter model", async () => {
    truncate.add("/onnx/model_quantized.onnx");

    await post("download");
    const failed = await until((r) => r.download?.status === "error", "the short read");
    expect(failed.present).toBe(false);
    expect(existsSync(embeddingModelFilePath("onnx/model_quantized.onnx"))).toBe(false);
  });

  it("a file that is already on disk is not fetched again", async () => {
    await post("download");
    await until((r) => r.present, "the encoder to land");

    // Only the second file is missing now; the first must not be re-requested.
    rmSync(embeddingModelFilePath("onnx/model_quantized.onnx"));
    bodies.delete("/config.json");

    await post("download");
    const done = await until((r) => r.present, "the missing file to land");
    expect(done.present).toBe(true);
  });
});

describe("POST /api/retrieval/semantic/cancel and /delete", () => {
  it("a cancel is an answer, not a failure", async () => {
    await post("download");
    const { body } = await post("cancel");
    expect(body.cancelled).toBe(true);
    // Whatever it reports, it must never be a half file that reads as a model.
    const after = await until((r) => r.download === null, "the abort to settle");
    expect(existsSync(`${embeddingModelFilePath("config.json")}.part`)).toBe(false);
    expect(after.download).toBeNull();
  });

  it("delete removes the files and drops the tier back to not-downloaded", async () => {
    await post("enable", { on: true });
    await post("download");
    await until((r) => r.present, "the encoder to land");

    const { body } = await post("delete");
    expect(body.deleted).toBe(EMBEDDING_MODEL.files.length);
    expect(body.present).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.availability).toBe("no-model");
    for (const f of EMBEDDING_MODEL.files) {
      expect(existsSync(embeddingModelFilePath(f.path))).toBe(false);
    }
  });

  it("deleting what was never here is not an error", async () => {
    const { status, body } = await post("delete");
    expect(status).toBe(200);
    expect(body.deleted).toBe(0);
  });
});
