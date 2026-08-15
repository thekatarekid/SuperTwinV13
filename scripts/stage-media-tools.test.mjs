import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMBEDDING_MODEL,
  embeddingModelFileUrl,
} from "../worker/src/retrieval/embedder.ts";
import {
  MANIFEST,
  OUT_DIR,
  humanSize,
  sha256File,
  stagedFiles,
} from "./stage-media-tools.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(repoRoot, "src-tauri");
const tauriConf = JSON.parse(
  readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"),
);
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const SHA256 = /^[0-9a-f]{64}$/;

describe("manifest", () => {
  const digests = [
    ["ffmpeg archive", MANIFEST.ffmpeg.archiveSha256],
    ["ffmpeg binary", MANIFEST.ffmpeg.binarySha256],
    ["whisper.cpp source", MANIFEST.whisper.archiveSha256],
    ["model", MANIFEST.model.sha256],
    ...MANIFEST.embeddings.files.map((f) => [`encoder ${f.path}`, f.sha256]),
  ];

  it.each(digests)("pins a real sha-256 for the %s", (_label, digest) => {
    expect(digest).toMatch(SHA256);
  });

  it.each([
    ["ffmpeg", MANIFEST.ffmpeg.url],
    ["whisper", MANIFEST.whisper.url],
    ["model", MANIFEST.model.url],
    ...MANIFEST.embeddings.files.map((f) => [`encoder ${f.path}`, f.url]),
  ])("fetches %s over https", (_label, url) => {
    expect(url.startsWith("https://")).toBe(true);
  });

  it.each([
    ["model", MANIFEST.model.url],
    ...MANIFEST.embeddings.files.map((f) => [`encoder ${f.path}`, f.url]),
  ])("pins the %s revision so upstream cannot move it under us", (_l, url) => {
    expect(url).not.toContain("/resolve/main/");
    expect(url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });

  it("bundles the model v5 froze, at its published size", () => {
    expect(MANIFEST.model.name).toBe("ggml-large-v3-turbo-q5_0.bin");
    expect(MANIFEST.model.bytes).toBe(574041195);
  });

  it("stages everything under the gitignored resources dir", () => {
    for (const dest of stagedFiles()) {
      expect(dest.startsWith(`${OUT_DIR}/`)).toBe(true);
    }
  });
});

describe("the encoder (v7 §7)", () => {
  it("stages the files the worker loads, from the same place", () => {
    // Two lists of digests for one model is how a build ships weights that
    // load and rank nothing like the ones Settings would have fetched.
    expect(MANIFEST.embeddings.id).toBe(EMBEDDING_MODEL.id);
    expect(MANIFEST.embeddings.dim).toBe(EMBEDDING_MODEL.dim);
    expect(MANIFEST.embeddings.revision).toBe(EMBEDDING_MODEL.revision);
    expect(
      MANIFEST.embeddings.files.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
    ).toEqual(EMBEDDING_MODEL.files.map((f) => ({ ...f })));
    for (const f of MANIFEST.embeddings.files) {
      expect(f.url).toBe(embeddingModelFileUrl(f.path));
    }
  });

  it("lays them out the way the runtime resolves a cache", () => {
    // @huggingface/transformers looks a model up at <cacheDir>/<id>/<file>;
    // anything else is 129 MB inside the .app that nothing can load.
    for (const f of MANIFEST.embeddings.files) {
      expect(f.dest).toBe(join(MANIFEST.embeddings.dir, EMBEDDING_MODEL.id, f.path));
    }
    expect(MANIFEST.embeddings.dir).toBe(join(OUT_DIR, "models", "embeddings"));
  });

  it("costs the 129 MB the Settings card quotes", () => {
    const bytes = MANIFEST.embeddings.files.reduce((n, f) => n + f.bytes, 0);
    expect(Math.round(bytes / 1024 / 1024)).toBe(129);
  });
});

describe("tauri resources", () => {
  const resources = tauriConf.bundle.resources;

  it("ships each artefact as its own resource entry", () => {
    // A directory entry that exists but is empty is skipped silently by the
    // bundler; a named file that is missing fails the build.
    for (const dest of stagedFiles()) {
      expect(resources).toHaveProperty(relative(tauriDir, dest));
    }
  });

  it("lands them at the paths the worker resolves at runtime", () => {
    expect(resources[relative(tauriDir, MANIFEST.ffmpeg.dest)]).toBe("bin/ffmpeg");
    expect(resources[relative(tauriDir, MANIFEST.whisper.dest)]).toBe(
      "bin/whisper-cli",
    );
    expect(resources[relative(tauriDir, MANIFEST.model.dest)]).toBe(
      "models/ggml-large-v3-turbo-q5_0.bin",
    );
    // Contents/Resources/models/embeddings/<id>/<file>, which is one level up
    // from Contents/Resources/worker/ — where the worker anchors its lookup.
    for (const f of MANIFEST.embeddings.files) {
      expect(resources[relative(tauriDir, f.dest)]).toBe(
        join("models", "embeddings", EMBEDDING_MODEL.id, f.path),
      );
    }
  });

  it("does not sweep the download cache into the bundle", () => {
    // `.cache/` holds the verified archives and would silently double the
    // .dmg if anyone collapsed these entries into one directory key.
    for (const key of Object.keys(resources)) {
      expect(["resources", "resources/"]).not.toContain(key);
    }
  });

  it("keeps the binaries out of externalBin", () => {
    // externalBin renames files with a target-triple suffix and is reachable
    // only from Rust's sidecar API; the Node worker spawns these itself.
    expect(tauriConf.bundle.externalBin).toEqual(["binaries/node"]);
  });
});

describe("build wiring", () => {
  it.each(["build:app", "build:appbundle"])("stages media before %s packages", (script) => {
    const cmd = pkg.scripts[script];
    expect(cmd).toContain("stage:media");
    expect(cmd.indexOf("stage:media")).toBeLessThan(cmd.indexOf("tauri build"));
  });

  it("never commits the staged artefacts", () => {
    const ignored = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(ignored).toContain("src-tauri/resources/");
  });
});

describe("packaged resolution", () => {
  // This is the one that shipped inert twice. esbuild rewrites `import.meta` to
  // an empty object in the CJS worker bundle, so a resource path anchored there
  // resolves in the repo and nowhere else, and cwd inside a packaged app is not
  // the repo. So: a REAL esbuild CJS bundle, at the path Tauri puts it, against
  // the tree stage:media produces, run from a cwd somewhere else entirely.
  //
  // The weights are created sparse — what is under test is the lookup, not
  // 129 MB of bytes.
  async function packagedProbe(root, { weights }) {
    const resources = join(root, "Contents", "Resources");
    const workerDir = join(resources, "worker");
    mkdirSync(workerDir, { recursive: true });

    if (weights) {
      for (const f of MANIFEST.embeddings.files) {
        const path = join(resources, relative(join(OUT_DIR), f.dest));
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(path, "w");
        ftruncateSync(fd, f.bytes);
        closeSync(fd);
      }
    }

    // The .app ships better-sqlite3 beside worker.cjs; the bundle require()s it
    // on load and this test is not about the database.
    const stub = join(workerDir, "node_modules", "better-sqlite3");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      join(stub, "package.json"),
      JSON.stringify({ name: "better-sqlite3", main: "index.cjs" }),
    );
    writeFileSync(join(stub, "index.cjs"), "module.exports = class {};\n");

    await build({
      stdin: {
        contents: `
          import {
            bundledEmbeddingModelDir,
            embeddingModelPresent,
            embeddingModelSourceDir,
          } from "./worker/src/retrieval/embedder.js";

          console.log(JSON.stringify({
            cwd: process.cwd(),
            dir: embeddingModelSourceDir(),
            bundled: bundledEmbeddingModelDir(),
            present: embeddingModelPresent(),
          }));
        `,
        resolveDir: repoRoot,
        loader: "ts",
      },
      outfile: join(workerDir, "worker.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["better-sqlite3"],
      logLevel: "silent",
    });

    // Somewhere else entirely: not the repo, not the .app.
    const elsewhere = mkdtempSync(join(tmpdir(), "st-cwd-"));
    const res = spawnSync(process.execPath, [join(workerDir, "worker.cjs")], {
      cwd: elsewhere,
      encoding: "utf8",
      env: { ...process.env, SUPERTWIN_HOME: join(root, "home") },
    });
    rmSync(elsewhere, { recursive: true, force: true });
    if (res.status !== 0) {
      throw new Error(`probe exited ${res.status}: ${res.stderr || res.stdout}`);
    }
    return { ...JSON.parse(res.stdout), resources, elsewhere };
  }

  it("finds the bundled weights from the worker bundle, cwd elsewhere", async () => {
    // realpath: Node resolves the module's own directory through /var's
    // symlink, so a probe that reports /private/var must be compared with it.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "st-app-")));
    try {
      const out = await packagedProbe(root, { weights: true });
      expect(out.cwd).not.toContain(root);
      expect(out.cwd).not.toBe(repoRoot);
      expect(out.bundled).toBe(join(out.resources, "models", "embeddings"));
      expect(out.dir).toBe(out.bundled);
      expect(out.present).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("falls back to the download directory when nothing was staged", async () => {
    // The negative control: without it the assertion above would also pass on a
    // build that resolves everything to the same wrong place.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "st-app-")));
    try {
      const out = await packagedProbe(root, { weights: false });
      expect(out.bundled).toBeNull();
      expect(out.dir).toBe(join(root, "home", "models", "embeddings"));
      expect(out.present).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("sha256File", () => {
  it("digests file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-media-"));
    const path = join(dir, "probe.bin");
    try {
      writeFileSync(path, "supertwin");
      // echo -n supertwin | shasum -a 256
      await expect(sha256File(path)).resolves.toBe(
        "0c2f29ad2e8ae2f883330be929023dc525279991f9183608ba87f9a6820ae1e9",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("humanSize", () => {
  it("reports MiB, like the sibling build scripts", () => {
    // 574041195 bytes is the "574 MB" model everyone quotes in decimal.
    expect(humanSize(MANIFEST.model.bytes)).toBe("547.4 MB");
  });
});
