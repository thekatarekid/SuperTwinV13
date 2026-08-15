// The embedding-model registry and its download manager (task 5.4).
//
// Two things are worth pinning here, and they are the two that cost money to
// get wrong:
//
//   - The CATALOGUE is well-formed: one bundled default, one recommendation,
//     no duplicate ids, and a real 64-hex digest on every single file. A
//     placeholder digest would reject every honest download; a missing one
//     would accept every dishonest one.
//   - The DIGEST GATE actually rejects. The "encoder host" below is a real
//     localhost server serving real bytes, so the path under test is the real
//     one — stream to `.part`, hash, rename — with nothing stubbed.
//
// The catalogue's own digests are of files hundreds of megabytes long, so the
// download tests pin their own tiny catalogue over one entry: what is being
// tested is that a mismatch is caught, not what the real weights hash to.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-model-registry-"));
const MODEL_DIR = join(tmpRoot, "home", "models", "embeddings");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");

// The download directory is pinned EXPLICITLY, not inherited from
// SUPERTWIN_HOME. `embeddingModelDir()` falls back to `$SUPERTWIN_HOME/models/
// embeddings`, and process.env is shared by every test file vitest runs
// concurrently in this worker — a neighbour re-pointing SUPERTWIN_HOME between
// this file's `startEmbeddingDownload` and its `deleteEmbeddingModelFiles` sent
// the write and the read to two different directories. The override resolves to
// the same path this file already used, so nothing about the layout changes;
// it just stops belonging to whoever wrote SUPERTWIN_HOME last.
process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = MODEL_DIR;

const { closeDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const {
  ACTIVE_EMBEDDING_MODEL_KEY,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_E5_BASE,
  EMBEDDING_MODEL_GEMMA,
  activeEmbeddingModel,
  activeEmbeddingModelId,
  findEmbeddingModel,
  listEmbeddingModels,
  setActiveEmbeddingModelId,
} = await import("./model-registry.js");
type EmbeddingModelSpec = typeof EMBEDDING_MODEL;
const { embeddingModelFilePath, embeddingModelPresent } = await import("./embedder.js");
const {
  cancelEmbeddingDownload,
  deleteEmbeddingModelFiles,
  embeddingDownloadFor,
  resetEmbeddingDownloadsForTests,
  startEmbeddingDownload,
} = await import("./downloads.js");
const { getDb } = await import("../db/connection.js");

// ---- The stub encoder host ------------------------------------------------

/** Bodies the host hands out, keyed by request path. */
const bodies = new Map<string, Buffer>();
/** Paths whose handler must ignore a Range header and answer 200. */
const ignoreRange = new Set<string>();
/** Byte ranges the host was actually asked for, in order. */
let served: { path: string; range: string | null }[] = [];

let origin: Server;

const CANDIDATE = EMBEDDING_MODEL_E5_BASE;
const REAL_FILES = CANDIDATE.files;

type Catalogue = { files: EmbeddingModelSpec["files"] };

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
  (CANDIDATE as Catalogue).files = files;
}

async function settle(id: string): Promise<ReturnType<typeof embeddingDownloadFor>> {
  for (let i = 0; i < 400; i++) {
    const state = embeddingDownloadFor(id);
    if (state === null || state.status === "error") return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${id}`);
}

beforeAll(async () => {
  runMigrations();
  origin = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const range = req.headers.range ?? null;
    served.push({ path, range });
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404).end("no such file");
      return;
    }
    const match = !ignoreRange.has(path) && range ? /^bytes=(\d+)-/.exec(range) : null;
    if (match) {
      const from = Number(match[1]);
      const slice = body.subarray(from);
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  process.env.SUPERTWIN_EMBEDDING_MODEL_BASE_URL = `http://127.0.0.1:${
    (origin.address() as AddressInfo).port
  }`;
});

afterAll(async () => {
  (CANDIDATE as Catalogue).files = REAL_FILES;
  delete process.env.SUPERTWIN_EMBEDDING_MODEL_BASE_URL;
  // Do not leave a pointer to a directory this file is about to delete.
  delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
  await new Promise<void>((r) => origin.close(() => r()));
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Re-assert the env every test: a neighbour file can clear it between two of
  // ours, and every path assertion below depends on it.
  process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
  process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
  process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = MODEL_DIR;
  served = [];
  ignoreRange.clear();
  resetEmbeddingDownloadsForTests();
  rmSync(MODEL_DIR, { recursive: true, force: true });
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(ACTIVE_EMBEDDING_MODEL_KEY);
  stubCatalogue({
    "config.json": `{"model_type":"xlm-roberta"}`,
    "onnx/model_quantized.onnx": "not really a graph, but the right bytes",
  });
});

afterEach(() => {
  resetEmbeddingDownloadsForTests();
});

// ===========================================================================

describe("the catalogue", () => {
  it("offers the bundled default, the recommended upgrade, and two more", () => {
    const ids = listEmbeddingModels().map((m) => m.id);
    expect(ids).toContain("Xenova/multilingual-e5-small");
    expect(ids).toContain("Xenova/multilingual-e5-base");
    expect(ids).toContain("Xenova/bge-m3");
    // google/embeddinggemma-300m is a GATED repo with no ONNX weights, so the
    // runnable artifact is the community export. The registry says both.
    expect(EMBEDDING_MODEL_GEMMA.upstream).toBe("google/embeddinggemma-300m");
    expect(ids).toContain(EMBEDDING_MODEL_GEMMA.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has exactly one bundled entry and exactly one recommendation", () => {
    const models = listEmbeddingModels();
    expect(models.filter((m) => m.bundled).map((m) => m.id)).toEqual([
      DEFAULT_EMBEDDING_MODEL_ID,
    ]);
    expect(models.filter((m) => m.recommended).map((m) => m.id)).toEqual([
      EMBEDDING_MODEL_GEMMA.id,
    ]);
  });

  it("pins a real length and a real sha256 on every file", () => {
    for (const model of listEmbeddingModels()) {
      // The candidate's files are stubbed for the download tests below; its
      // real catalogue is checked through REAL_FILES instead.
      const files = model === CANDIDATE ? REAL_FILES : model.files;
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.bytes).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(model.dim).toBeGreaterThan(0);
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.label.length).toBeGreaterThan(0);
    }
  });
});

describe("which model is active", () => {
  it("is the bundled one until something says otherwise", () => {
    expect(activeEmbeddingModelId()).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(activeEmbeddingModel()).toBe(EMBEDDING_MODEL);
  });

  it("follows the stored pointer once it is set", () => {
    setActiveEmbeddingModelId(EMBEDDING_MODEL_GEMMA.id);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
  });

  it("falls back rather than pointing at a model this build does not have", () => {
    getDb()
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(ACTIVE_EMBEDDING_MODEL_KEY, "some/model-from-a-later-build");
    expect(activeEmbeddingModelId()).toBe(DEFAULT_EMBEDDING_MODEL_ID);
  });

  it("refuses to point at something that is not in the catalogue", () => {
    expect(() => setActiveEmbeddingModelId("not/a-model")).toThrow(/unknown embedding model/);
    expect(findEmbeddingModel("not/a-model")).toBeNull();
  });
});

describe("downloading a model", () => {
  it("fetches every file, verifies it, and only then reports it present", async () => {
    startEmbeddingDownload(CANDIDATE);
    expect(await settle(CANDIDATE.id)).toBeNull();

    expect(embeddingModelPresent(CANDIDATE)).toBe(true);
    for (const file of CANDIDATE.files) {
      const path = embeddingModelFilePath(file.path, CANDIDATE);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.part`)).toBe(false);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(file.sha256);
    }
  });

  it("keeps each model in its own directory, so two can be here at once", async () => {
    startEmbeddingDownload(CANDIDATE);
    await settle(CANDIDATE.id);
    expect(embeddingModelFilePath("config.json", CANDIDATE)).toContain(
      join("Xenova", "multilingual-e5-base"),
    );
    expect(embeddingModelFilePath("config.json", EMBEDDING_MODEL)).toContain(
      join("Xenova", "multilingual-e5-small"),
    );
    expect(embeddingModelPresent(EMBEDDING_MODEL)).toBe(false);
  });

  it("REJECTS a file whose bytes are not the pinned ones, and leaves nothing behind", async () => {
    // The host now serves something else entirely under the same name — a
    // poisoned mirror, or a repo that moved.
    bodies.set("/config.json", Buffer.from(`{"model_type":"something else"}`));

    startEmbeddingDownload(CANDIDATE);
    const failed = await settle(CANDIDATE.id);

    expect(failed?.status).toBe("error");
    expect(failed?.error).toMatch(/checksum/);
    expect(embeddingModelPresent(CANDIDATE)).toBe(false);
    const path = embeddingModelFilePath("config.json", CANDIDATE);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("resumes a partial file with a range request rather than fetching it twice", async () => {
    const file = CANDIDATE.files.find((f) => f.path === "onnx/model_quantized.onnx")!;
    const whole = bodies.get("/onnx/model_quantized.onnx")!;
    const half = Math.floor(whole.length / 2);

    // What a quit halfway through leaves behind.
    const dest = embeddingModelFilePath(file.path, CANDIDATE);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, whole.subarray(0, half));

    startEmbeddingDownload(CANDIDATE);
    expect(await settle(CANDIDATE.id)).toBeNull();

    const asked = served.find((s) => s.path === "/onnx/model_quantized.onnx");
    expect(asked?.range).toBe(`bytes=${half}-`);
    expect(readFileSync(dest).equals(whole)).toBe(true);
    expect(embeddingModelPresent(CANDIDATE)).toBe(true);
  });

  it("starts over rather than splicing when the host ignores the range", async () => {
    const file = CANDIDATE.files.find((f) => f.path === "onnx/model_quantized.onnx")!;
    const whole = bodies.get("/onnx/model_quantized.onnx")!;
    const dest = embeddingModelFilePath(file.path, CANDIDATE);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, whole.subarray(0, 5));
    ignoreRange.add("/onnx/model_quantized.onnx");

    startEmbeddingDownload(CANDIDATE);
    expect(await settle(CANDIDATE.id)).toBeNull();

    // Spliced, this would be 5 bytes too long and would fail the digest.
    expect(readFileSync(dest).equals(whole)).toBe(true);
  });

  it("does not fetch what is already here", async () => {
    startEmbeddingDownload(CANDIDATE);
    await settle(CANDIDATE.id);
    served = [];
    expect(startEmbeddingDownload(CANDIDATE)).toBeNull();
    expect(served).toEqual([]);
  });

  it("a cancel bins the partial rather than leaving something half-loadable", async () => {
    startEmbeddingDownload(CANDIDATE);
    cancelEmbeddingDownload(CANDIDATE.id);
    await settle(CANDIDATE.id);
    for (const file of CANDIDATE.files) {
      expect(existsSync(`${embeddingModelFilePath(file.path, CANDIDATE)}.part`)).toBe(false);
    }
  });

  it("a cancel followed straight away by a restart still installs every file", async () => {
    // The cancelled attempt bins its partial ASYNCHRONOUSLY, well after
    // cancelEmbeddingDownload() has returned. If the restart does not wait for
    // that, the old `rm` unlinks the new attempt's `.part` — the writer keeps
    // filling an unlinked inode and the rename fails with ENOENT, leaving the
    // model half-installed with no error the user could act on.
    startEmbeddingDownload(CANDIDATE);
    cancelEmbeddingDownload(CANDIDATE.id);
    startEmbeddingDownload(CANDIDATE);

    expect(await settle(CANDIDATE.id)).toBeNull();
    expect(embeddingModelPresent(CANDIDATE)).toBe(true);
    for (const file of CANDIDATE.files) {
      const path = embeddingModelFilePath(file.path, CANDIDATE);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.part`)).toBe(false);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(file.sha256);
    }
  });

  it("delete reclaims the space and says how much it found", async () => {
    startEmbeddingDownload(CANDIDATE);
    // Assert the fetch actually landed: a download that errored here would
    // otherwise surface as a confusing "reclaimed 1 of 2" below.
    expect(await settle(CANDIDATE.id)).toBeNull();

    expect(await deleteEmbeddingModelFiles(CANDIDATE)).toBe(CANDIDATE.files.length);
    expect(embeddingModelPresent(CANDIDATE)).toBe(false);
    // Deleting what was never here is not an error.
    expect(await deleteEmbeddingModelFiles(CANDIDATE)).toBe(0);
  });
});
