// ===========================================================================
// Which copy of the encoder's weights wins (v7 §7), now that they ship inside
// the .app. Three things are worth pinning: the bundled copy outranks the
// download, a half-staged tree reads as absent rather than loading as a model,
// and the download directory stays the only one anything writes to or deletes
// from — removing a file from inside a signed .app breaks the app.
//
// The files are created sparse at their pinned lengths: what is being tested is
// the length check, and 129 MB of real bytes per case is not.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EMBEDDING_MODEL,
  bundledEmbeddingModelDir,
  embeddingModelBundled,
  embeddingModelDir,
  embeddingModelFilePath,
  embeddingModelFileStates,
  embeddingModelPresent,
  embeddingModelSourceDir,
} from "./embedder.js";

let tmpDir: string;
let cwd: string;

/** The tree stage-media-tools.mjs produces, under one root. */
function stage(root: string, { short }: { short?: string } = {}): string {
  const dir = join(root, "src-tauri", "resources", "models", "embeddings");
  for (const f of EMBEDDING_MODEL.files) {
    const path = join(dir, ...EMBEDDING_MODEL.id.split("/"), ...f.path.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "w");
    ftruncateSync(fd, f.path === short ? f.bytes - 1 : f.bytes);
    closeSync(fd);
  }
  return dir;
}

beforeEach(() => {
  // realpath, because a chdir here reports the resolved path back through cwd.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "st-embedder-")));
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bundled weights", () => {
  it("are not claimed when the build was never staged", () => {
    process.chdir(tmpDir);
    expect(bundledEmbeddingModelDir()).toBeNull();
    expect(embeddingModelBundled()).toBe(false);
    expect(embeddingModelPresent()).toBe(false);
    expect(embeddingModelSourceDir()).toBe(embeddingModelDir());
  });

  it("outrank the download directory once staged", () => {
    const staged = stage(tmpDir);
    process.chdir(tmpDir);

    expect(bundledEmbeddingModelDir()).toBe(staged);
    expect(embeddingModelSourceDir()).toBe(staged);
    expect(embeddingModelPresent()).toBe(true);
    expect(embeddingModelFileStates().every((f) => f.present)).toBe(true);
  });

  it("are absent when one file is short, rather than loaded as a model", () => {
    // A truncated ONNX graph does not fail loudly — it produces vectors in a
    // space where nothing looks wrong.
    stage(tmpDir, { short: "onnx/model_quantized.onnx" });
    process.chdir(tmpDir);

    expect(bundledEmbeddingModelDir()).toBeNull();
    expect(embeddingModelSourceDir()).toBe(embeddingModelDir());
    expect(embeddingModelPresent()).toBe(false);
  });

  it("are never what the download route writes to or deletes from", () => {
    // Overwriting or removing a file inside the .app breaks its signature, and
    // the bundled copy is not the download route's to remove.
    stage(tmpDir);
    process.chdir(tmpDir);

    const bundled = bundledEmbeddingModelDir()!;
    for (const f of EMBEDDING_MODEL.files) {
      const path = embeddingModelFilePath(f.path);
      expect(path.startsWith(embeddingModelDir())).toBe(true);
      expect(path.startsWith(bundled)).toBe(false);
    }
  });

  it("lose to an explicit directory, which is the whole answer", () => {
    stage(tmpDir);
    process.chdir(tmpDir);
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = join(tmpDir, "elsewhere");

    expect(bundledEmbeddingModelDir()).toBeNull();
    expect(embeddingModelSourceDir()).toBe(join(tmpDir, "elsewhere"));
  });
});

// The other half of this — that the packaged .app's tree resolves from the
// worker bundle's own directory rather than cwd — cannot be proved from a test
// file that is not itself the bundle. It is proved against a real esbuild CJS
// bundle in a simulated Contents/Resources layout, in
// scripts/stage-media-tools.test.mjs.
