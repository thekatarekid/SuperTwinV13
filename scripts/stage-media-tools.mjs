// ===========================================================================
// Stage the artefacts Tauri ships inside the .app: ffmpeg, whisper-cli, the
// bundled whisper model, yt-dlp and the retrieval encoder.
//
// v5 samples video frames and transcribes audio locally, which needs a full
// static ffmpeg (~52 MB), whisper.cpp's CLI built for arm64 with Metal (~3 MB)
// and ggml-large-v3-turbo-q5_0.bin (574 MB); v6 §4 reads YouTube caption
// tracks, which needs yt-dlp (~36 MB); v7 §7 searches chats by meaning, which
// needs multilingual-e5-small int8 (129 MB). None of them can live in git, so
// a fresh clone has none and `tauri build` dies on the missing resource paths
// the same way it did for the Node sidecar. This script produces them, and is
// idempotent: an artefact that is already present and verifies is left alone,
// so a repeat build does not re-download 574 MB or rebuild whisper.
//
// The whole point is a .dmg that works on a machine with no Homebrew, no
// ffmpeg on PATH and no network (v5 §5) — everything here is resolved at
// BUILD time and shipped.
//
// They ship as Tauri **resources**, not externalBin. externalBin is for
// binaries the Rust shell launches through its sidecar API, and it renames the
// file with a target-triple suffix; our consumer is the Node worker, which has
// no access to that API. Resources land verbatim at
//
//   Contents/Resources/bin/ffmpeg
//   Contents/Resources/bin/whisper-cli
//   Contents/Resources/bin/yt-dlp
//   Contents/Resources/models/ggml-large-v3-turbo-q5_0.bin
//   Contents/Resources/models/embeddings/<repo>/<file>
//
// next to Contents/Resources/worker/, so the worker resolves them from its own
// directory. tauri.conf.json lists each file individually rather than the two
// directories: a missing file then fails the build loudly, whereas a directory
// that exists but is empty is silently skipped by the bundler.
//
// Tauri signs only the outer .app, so — exactly like the Go daemon in
// bundle-worker.mjs — every binary is ad-hoc signed here, before packaging.
// An unsigned Mach-O does not execute on arm64 macOS at all.
//
// Every download is checked against a pinned SHA-256. A truncated or tampered
// model still loads and still emits confident-looking sentences, so a corrupt
// 574 MB file would produce garbage transcripts that read as real; a mismatch
// therefore aborts the build instead of warning.
// ===========================================================================

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const OUT_DIR = join(repoRoot, "src-tauri", "resources");
const BIN_DIR = join(OUT_DIR, "bin");
const MODEL_DIR = join(OUT_DIR, "models");
// The encoder's own root. @huggingface/transformers resolves a cached model to
// <cacheDir>/<repo id>/<file>, so the staged tree is that layout verbatim and
// the worker only has to point env.cacheDir here.
const EMBEDDING_DIR = join(MODEL_DIR, "embeddings");
// Downloads and the whisper source/build tree. Inside OUT_DIR so one gitignore
// rule covers everything, and outside every file tauri.conf.json names so none
// of it can leak into the .app.
const CACHE_DIR = join(OUT_DIR, ".cache");

const ENTITLEMENTS = join(repoRoot, "src-tauri", "entitlements.plist");

/**
 * The retrieval encoder, pinned to the same revision and the same four digests
 * the Settings download route uses (worker/src/retrieval/embedder.ts). One set
 * of bytes whether they arrive at build time or from a click, and a test holds
 * the two lists identical — a second, subtly different model would produce
 * vectors in a space where nothing looks wrong.
 */
const EMBEDDING_ID = "Xenova/multilingual-e5-small";
const EMBEDDING_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";

function embeddingFile(path, bytes, sha256) {
  return {
    path,
    bytes,
    sha256,
    url: `https://huggingface.co/${EMBEDDING_ID}/resolve/${EMBEDDING_REVISION}/${path}`,
    dest: join(EMBEDDING_DIR, ...EMBEDDING_ID.split("/"), ...path.split("/")),
  };
}

/**
 * Pinned sources. Sizes are the expected download length — used only to tell a
 * complete cached download from a half one before spending time hashing it.
 */
export const MANIFEST = {
  ffmpeg: {
    // The only maintained *full* static arm64 macOS build. It is GPL but not
    // `--enable-nonfree`, so the binary may be redistributed inside the .dmg;
    // the immutable ffmpeg-static GitHub assets are nonfree and may not.
    // Upstream republishes the same filename for 8.1.x point releases, so this
    // hash goes stale on their schedule — BUILD.md says how to re-pin.
    url: "https://www.osxexperts.net/ffmpeg81arm.zip",
    version: "8.1",
    archiveBytes: 22547387,
    archiveSha256:
      "ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad",
    binarySha256:
      "9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028",
    dest: join(BIN_DIR, "ffmpeg"),
  },
  whisper: {
    // whisper.cpp publishes no macOS binary — Windows, Linux and an
    // xcframework only — so the CLI is compiled here from a pinned tarball.
    tag: "v1.9.1",
    version: "1.9.1",
    url: "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.1.tar.gz",
    archiveBytes: 9012805,
    archiveSha256:
      "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447",
    srcDirName: "whisper.cpp-1.9.1",
    dest: join(BIN_DIR, "whisper-cli"),
  },
  ytdlp: {
    // The published macOS asset: yt-dlp and a Python runtime in one PyInstaller
    // executable, universal2. GitHub release assets are immutable, so unlike
    // ffmpeg's this digest cannot go stale under us.
    //
    // It is NOT thinned to arm64 with lipo, tempting as ~19 MB is: the
    // PyInstaller archive is carried past the end of the Mach-O images, and
    // lipo rebuilds the file from the images alone — the result launches and
    // then cannot find itself.
    version: "2026.07.04",
    url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",
    bytes: 38256544,
    sha256:
      "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
    dest: join(BIN_DIR, "yt-dlp"),
  },
  model: {
    // Pinned to a repo revision rather than `main`: the file has not changed
    // since 2024-10-29 and a pin means an upstream edit cannot break the build
    // by surprise. The digest is HuggingFace's own LFS oid for the blob.
    name: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    bytes: 574041195,
    sha256:
      "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    dest: join(MODEL_DIR, "ggml-large-v3-turbo-q5_0.bin"),
  },
  embeddings: {
    // 12-layer XLM-R, 384 dims, int8 ONNX. Bundled rather than downloaded on
    // first run (v7 §7): the tier's canonical case is cold ↔ health, and a
    // machine that has to find 129 MB of network before it can answer that is
    // a machine where semantic search is simply off.
    id: EMBEDDING_ID,
    revision: EMBEDDING_REVISION,
    dim: 384,
    dir: EMBEDDING_DIR,
    files: [
      embeddingFile(
        "config.json",
        658,
        "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
      ),
      embeddingFile(
        "tokenizer_config.json",
        443,
        "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
      ),
      embeddingFile(
        "tokenizer.json",
        17082730,
        "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      ),
      embeddingFile(
        // What dtype "q8" resolves to. Naming the file rather than letting the
        // runtime choose keeps the staged set and the loaded set one set.
        "onnx/model_quantized.onnx",
        118308185,
        "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
      ),
    ],
  },
};

/** Every file that ends up in the .app, flattened — one path per resource. */
export function stagedFiles() {
  return Object.values(MANIFEST).flatMap((entry) =>
    entry.files ? entry.files.map((f) => f.dest) : [entry.dest],
  );
}

function log(msg) {
  console.log(`[stage-media] ${msg}`);
}

function fail(msg) {
  console.error(`[stage-media] ERROR: ${msg}`);
  process.exit(1);
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Capture stdout+stderr regardless of exit status: `codesign -dvvv` writes its
// whole report to stderr and still exits 0.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error) {
    return { status: 1, out: String(res.error.message ?? res.error) };
  }
  return {
    status: typeof res.status === "number" ? res.status : 1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

// For long-running steps (curl, cmake) where the user wants to see progress.
function runLive(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return typeof res.status === "number" ? res.status : 1;
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Download `url` to `dest`, resuming an interrupted attempt, then check the
 * digest. Writes through a `.part` file so an aborted run can never leave
 * something that looks staged.
 *
 * Everything is spawned with an argv array — no shell, no interpolation.
 */
async function fetchVerified({ url, dest, sha256, bytes, label }) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  // A `.part` at or past the expected length is either finished or corrupt;
  // resuming it would make curl ask for a range the server refuses (416).
  if (existsSync(part) && statSync(part).size > bytes) {
    rmSync(part, { force: true });
  }
  const resumable = existsSync(part) && statSync(part).size < bytes;

  if (!existsSync(part) || statSync(part).size !== bytes) {
    log(`downloading ${label} (${humanSize(bytes)}) from ${url}`);
    const status = runLive("curl", [
      "-fL",
      "--proto",
      "=https",
      "--retry",
      "5",
      "--retry-delay",
      "3",
      "--retry-connrefused",
      ...(resumable ? ["-C", "-"] : []),
      // A progress bar redrawn into a log file is thousands of useless lines.
      process.stdout.isTTY ? "--progress-bar" : "--no-progress-meter",
      "-o",
      part,
      url,
    ]);
    if (status !== 0 || !existsSync(part)) {
      fail(
        `download failed for ${label} (curl exit ${status}).\n` +
          `  url: ${url}\n` +
          `  A partial file is kept at ${part} and the next run resumes it.\n` +
          `  See BUILD.md → "When a download fails".`,
      );
    }
  }

  const got = await sha256File(part);
  if (got !== sha256) {
    rmSync(part, { force: true });
    fail(
      `SHA-256 mismatch for ${label} — refusing to use it.\n` +
        `  expected: ${sha256}\n` +
        `  actual  : ${got}\n` +
        `  url     : ${url}\n` +
        `  The partial download was deleted. Either the transfer was corrupt\n` +
        `  (rerun) or upstream republished the file (re-pin the digest in\n` +
        `  scripts/stage-media-tools.mjs — see BUILD.md).`,
    );
  }

  renameSync(part, dest);
  log(`verified ${label}: sha256 ${sha256}`);
}

/**
 * Ad-hoc sign with the hardened runtime and the app's entitlements, then prove
 * the binary is what we think it is. Tauri copies resources verbatim and signs
 * only the outer .app, so a nested Mach-O must already carry its own valid
 * signature before packaging — an already-signed nested binary stays valid
 * inside the outer signature.
 */
function signAndVerify(path, label) {
  if (!existsSync(ENTITLEMENTS)) {
    fail(`entitlements not found (needed to sign ${label}): ${ENTITLEMENTS}`);
  }

  chmodSync(path, 0o755);

  const sign = run("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    ENTITLEMENTS,
    path,
  ]);
  if (sign.status !== 0) {
    fail(`codesign failed for ${label} (status=${sign.status}):\n${sign.out}`);
  }

  const fileOut = run("file", [path]).out.trim();
  if (!/Mach-O/.test(fileOut) || !/arm64/.test(fileOut)) {
    fail(`${label} is not a Mach-O arm64 binary:\n  ${fileOut}`);
  }

  const dvvv = run("codesign", ["-dvvv", path]);
  if (dvvv.status !== 0 || !/Signature=adhoc/.test(dvvv.out)) {
    fail(`${label} is not ad-hoc signed:\n${dvvv.out}`);
  }

  const verify = run("codesign", ["--verify", "--verbose=2", path]);
  if (verify.status !== 0) {
    fail(`codesign --verify failed for ${label}:\n${verify.out}`);
  }

  log(`${label}: ${fileOut.replace(`${path}: `, "")}, ad-hoc signed OK`);
}

/**
 * A staged binary is trusted when it runs and reports the pinned version.
 * arm64 macOS refuses to execute a Mach-O whose signature is missing or
 * broken, so this one call covers staged, signed and working — and unlike a
 * digest it survives codesign rewriting the file, and it works for
 * whisper-cli, whose compiled bytes are not reproducible.
 */
function reportsVersion(path, args, expected) {
  if (!existsSync(path)) return false;
  const res = run(path, args);
  return res.status === 0 && res.out.includes(expected);
}

async function stageFfmpeg() {
  const { url, version, archiveBytes, archiveSha256, binarySha256, dest } =
    MANIFEST.ffmpeg;

  // Signing rewrites the binary, so the pinned digest only describes the bytes
  // as extracted. Past that point "it runs and says 8.1" is the check that
  // means anything — macOS will not execute it at all if the signature broke.
  if (reportsVersion(dest, ["-version"], `ffmpeg version ${version}`)) {
    log(`ffmpeg up to date: ${dest} (${version})`);
    return;
  }

  const archive = join(CACHE_DIR, "ffmpeg-arm64.zip");
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(archive) || (await sha256File(archive)) !== archiveSha256) {
    await fetchVerified({
      url,
      dest: archive,
      sha256: archiveSha256,
      bytes: archiveBytes,
      label: `ffmpeg ${version} (arm64 static)`,
    });
  }

  mkdirSync(BIN_DIR, { recursive: true });
  rmSync(dest, { force: true });
  // -j junks paths so the archive's __MACOSX/ resource forks stay out.
  const unzip = run("unzip", ["-o", "-q", "-j", archive, "ffmpeg", "-d", BIN_DIR]);
  if (unzip.status !== 0 || !existsSync(dest)) {
    fail(`could not extract ffmpeg from ${archive}:\n${unzip.out}`);
  }

  const got = await sha256File(dest);
  if (got !== binarySha256) {
    rmSync(dest, { force: true });
    fail(
      `extracted ffmpeg does not match the pinned digest.\n` +
        `  expected: ${binarySha256}\n` +
        `  actual  : ${got}`,
    );
  }

  signAndVerify(dest, "ffmpeg");
  if (!reportsVersion(dest, ["-version"], `ffmpeg version ${version}`)) {
    fail(`staged ffmpeg does not report version ${version}: ${dest}`);
  }
  log(`staged ffmpeg ${version} -> ${dest} (${humanSize(statSync(dest).size)})`);
}

async function stageWhisper() {
  const { tag, version, url, archiveBytes, archiveSha256, srcDirName, dest } =
    MANIFEST.whisper;

  if (reportsVersion(dest, ["--version"], `whisper.cpp version: ${version}`)) {
    log(`whisper-cli up to date: ${dest} (${version})`);
    return;
  }

  if (run("cmake", ["--version"]).status !== 0) {
    fail(
      `cmake is required to build whisper-cli (whisper.cpp ships no macOS\n` +
        `  binary). Install it with 'brew install cmake' and rerun.`,
    );
  }

  const archive = join(CACHE_DIR, `whisper.cpp-${tag}.tar.gz`);
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(archive) || (await sha256File(archive)) !== archiveSha256) {
    await fetchVerified({
      url,
      dest: archive,
      sha256: archiveSha256,
      bytes: archiveBytes,
      label: `whisper.cpp ${tag} source`,
    });
  }

  const srcDir = join(CACHE_DIR, srcDirName);
  const buildDir = join(CACHE_DIR, "whisper-build");
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
  const untar = run("tar", ["-xzf", archive, "-C", CACHE_DIR]);
  if (untar.status !== 0 || !existsSync(srcDir)) {
    fail(`could not unpack ${archive}:\n${untar.out}`);
  }

  log(`building whisper-cli ${version} (arm64, Metal)`);
  const configure = runLive("cmake", [
    "-S",
    srcDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    // One self-contained executable: the default shared build would scatter
    // libwhisper/libggml dylibs that nothing inside the .app sets up an rpath
    // for.
    "-DBUILD_SHARED_LIBS=OFF",
    // ggml defaults to -mcpu=native, which tunes for whichever Mac ran the
    // build. This binary ships to other people's machines, so it must target
    // the arm64 baseline instead.
    "-DGGML_NATIVE=OFF",
    "-DGGML_METAL=ON",
    // Without this the Metal kernels are loaded from a default.metallib file
    // beside the executable, which is not one of the resources we ship.
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_SDL2=OFF",
    "-DWHISPER_CURL=OFF",
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    // Matches bundle.macOS.minimumSystemVersion in tauri.conf.json.
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
  ]);
  if (configure !== 0) fail(`cmake configure failed (status=${configure})`);

  const built = runLive("cmake", [
    "--build",
    buildDir,
    "--config",
    "Release",
    "--target",
    "whisper-cli",
    "-j",
    String(process.availableParallelism?.() ?? 4),
  ]);
  if (built !== 0) fail(`whisper-cli build failed (status=${built})`);

  const out = join(buildDir, "bin", "whisper-cli");
  if (!existsSync(out)) fail(`cmake reported success but ${out} is missing`);

  mkdirSync(BIN_DIR, { recursive: true });
  rmSync(dest, { force: true });
  renameSync(out, dest);

  signAndVerify(dest, "whisper-cli");
  if (!reportsVersion(dest, ["--version"], `whisper.cpp version: ${version}`)) {
    fail(`staged whisper-cli does not report version ${version}: ${dest}`);
  }
  // Metal lives in the binary, so linkage against the framework is the honest
  // proof that the Metal backend was compiled in rather than silently dropped.
  const linked = run("otool", ["-L", dest]).out;
  if (!/Metal\.framework/.test(linked)) {
    fail(
      `staged whisper-cli was built without Metal — it links no Metal.framework:\n${linked}`,
    );
  }

  // The build tree is ~250 MB of objects that nothing reads again; the
  // verified tarball stays so a rebuild does not re-download.
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });

  log(
    `staged whisper-cli ${version} -> ${dest} (${humanSize(statSync(dest).size)}, Metal)`,
  );
}

async function stageYtDlp() {
  const { version, url, bytes, sha256, dest } = MANIFEST.ytdlp;

  if (reportsVersion(dest, ["--version"], version)) {
    log(`yt-dlp up to date: ${dest} (${version})`);
    return;
  }

  // Kept in the cache and copied out, like ffmpeg's zip: signing rewrites the
  // staged file, so the pinned digest only ever describes the download.
  const download = join(CACHE_DIR, `yt-dlp_macos-${version}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(download) || (await sha256File(download)) !== sha256) {
    await fetchVerified({
      url,
      dest: download,
      sha256,
      bytes,
      label: `yt-dlp ${version} (macOS)`,
    });
  }

  mkdirSync(BIN_DIR, { recursive: true });
  rmSync(dest, { force: true });
  copyFileSync(download, dest);

  // Upstream ships it ad-hoc signed but without the hardened runtime; the .app
  // has it, and a nested binary that lacks the entitlements for JIT and
  // unsigned executable memory cannot start a Python interpreter inside it.
  signAndVerify(dest, "yt-dlp");
  if (!reportsVersion(dest, ["--version"], version)) {
    fail(`staged yt-dlp does not report version ${version}: ${dest}`);
  }
  log(`staged yt-dlp ${version} -> ${dest} (${humanSize(statSync(dest).size)})`);
}

async function stageModel() {
  const { name, url, bytes, sha256, dest } = MANIFEST.model;

  if (existsSync(dest) && statSync(dest).size === bytes) {
    const got = await sha256File(dest);
    if (got === sha256) {
      log(`model up to date: ${dest} (${humanSize(bytes)})`);
      return;
    }
    fail(
      `the staged model is corrupt — sha256 ${got}, expected ${sha256}.\n` +
        `  Delete ${dest} and rerun to fetch it again.`,
    );
  }

  await fetchVerified({ url, dest, sha256, bytes, label: `model ${name}` });
  log(`staged ${name} -> ${dest} (${humanSize(statSync(dest).size)})`);
}

async function stageEmbeddings() {
  const { id, dir, files } = MANIFEST.embeddings;
  let total = 0;

  for (const { path, url, bytes, sha256, dest } of files) {
    total += bytes;
    if (existsSync(dest) && statSync(dest).size === bytes) {
      const got = await sha256File(dest);
      if (got === sha256) {
        log(`${id}/${path} up to date (${humanSize(bytes)})`);
        continue;
      }
      fail(
        `the staged ${id}/${path} is corrupt — sha256 ${got}, expected ${sha256}.\n` +
          `  Delete ${dest} and rerun to fetch it again.`,
      );
    }
    await fetchVerified({ url, dest, sha256, bytes, label: `${id}/${path}` });
  }

  log(`staged ${id} -> ${dir} (${humanSize(total)})`);
}

/**
 * End-to-end proof that the three artefacts work together and offline: build a
 * second of silence with the staged ffmpeg, run it through the staged
 * whisper-cli against the staged model, and require the Metal backend to come
 * up. Whisper invents text on silence, so the transcript itself is ignored —
 * only "it loaded the model on the GPU and exited cleanly" is asserted.
 */
function smokeTest() {
  const scratch = join(CACHE_DIR, ".smoke");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const wav = join(scratch, "silence.wav");

  const encode = run(MANIFEST.ffmpeg.dest, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "1",
    "-c:a",
    "pcm_s16le",
    "-y",
    wav,
  ]);
  if (encode.status !== 0 || !existsSync(wav)) {
    rmSync(scratch, { recursive: true, force: true });
    fail(`ffmpeg could not produce a 16 kHz mono WAV:\n${encode.out}`);
  }

  const transcribe = run(MANIFEST.whisper.dest, [
    "-m",
    MANIFEST.model.dest,
    "-nt",
    "-t",
    "2",
    wav,
  ]);
  rmSync(scratch, { recursive: true, force: true });
  if (transcribe.status !== 0) {
    fail(
      `whisper-cli could not transcribe with the staged model ` +
        `(status=${transcribe.status}):\n${transcribe.out}`,
    );
  }
  if (!/metal/i.test(transcribe.out)) {
    fail(
      `whisper-cli ran without the Metal backend — transcription would fall ` +
        `back to the CPU:\n${transcribe.out}`,
    );
  }
  log("smoke test: ffmpeg -> 16 kHz WAV -> whisper-cli (Metal) -> exit 0 (OK)");

  // yt-dlp is only ever asked for YouTube captions, and a caption fetch needs
  // the network. What can be proved offline is that the one extractor it is
  // bundled for is compiled into it — a build without it would fail silently,
  // link by link, and look like videos that happen to have no captions.
  const extractors = run(MANIFEST.ytdlp.dest, ["--list-extractors"]);
  if (extractors.status !== 0 || !/^youtube$/im.test(extractors.out)) {
    fail(
      `the staged yt-dlp has no YouTube extractor (status=${extractors.status}):\n` +
        extractors.out.slice(0, 500),
    );
  }
  log("smoke test: yt-dlp lists the YouTube extractor (OK)");
}

/**
 * The same proof for the encoder: load the staged files with the runtime the
 * app ships and embed one string. `allowRemoteModels` is false, so a tree the
 * loader cannot resolve fails HERE, at build time, instead of becoming a silent
 * fetch on someone's first chat turn — or, offline, a tier that is simply dead.
 *
 * A unit vector of the declared width is the assertion: a model that loaded but
 * produced the wrong shape is a wrong answer in a space where nothing looks
 * wrong.
 */
const EMBEDDING_PROBE = `
import { env, pipeline } from "@huggingface/transformers";

env.cacheDir = process.env.STAGED_MODEL_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = false;

const pipe = await pipeline("feature-extraction", process.env.STAGED_MODEL_ID, {
  dtype: "q8",
});
const out = await pipe(["query: is the bundled encoder here"], {
  pooling: "mean",
  normalize: true,
});
const v = Array.from(out.data);
const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
console.log(JSON.stringify({ len: v.length, norm: Number(norm.toFixed(4)) }));
`;

function embeddingSmokeTest() {
  const { id, dim, dir } = MANIFEST.embeddings;
  const res = run(
    process.execPath,
    ["--input-type=module", "-e", EMBEDDING_PROBE],
    {
      // A bare specifier under --eval resolves from cwd, and the runtime is a
      // worker dependency hoisted into the repo's node_modules — the same copy
      // bundle-worker.mjs stages next to worker.cjs.
      cwd: repoRoot,
      env: { ...process.env, STAGED_MODEL_DIR: dir, STAGED_MODEL_ID: id },
    },
  );

  const line = /\{"len":[^}]*\}/.exec(res.out);
  if (res.status !== 0 || !line) {
    fail(
      `the staged encoder does not load (status=${res.status}):\n` +
        `${res.out.trim().slice(0, 2000)}\n` +
        `  If @huggingface/transformers is missing, run 'npm ci' and rerun.`,
    );
  }
  const { len, norm } = JSON.parse(line[0]);
  if (len !== dim || Math.abs(norm - 1) > 0.001) {
    fail(
      `the staged encoder produced a ${len}-float vector of norm ${norm}; ` +
        `expected ${dim} floats of norm 1.`,
    );
  }
  log(`smoke test: ${id} -> ${dim}-d unit vector, offline (OK)`);
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail(
      `this stages arm64 macOS artefacts; running on ${process.platform}/${process.arch}.`,
    );
  }

  await stageFfmpeg();
  await stageWhisper();
  await stageYtDlp();
  await stageModel();
  await stageEmbeddings();
  smokeTest();
  embeddingSmokeTest();

  const total = stagedFiles().reduce((sum, dest) => sum + statSync(dest).size, 0);
  log(`bundled artefacts: ${stagedFiles().length} files, ${humanSize(total)} total`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
