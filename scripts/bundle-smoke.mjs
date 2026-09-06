#!/usr/bin/env node
// ===========================================================================
// bundle-smoke.mjs — boot the REAL artifact the DMG carries (V6 P1, W2).
//
// WHY THIS EXISTS
// ---------------
// 13.11.1 and 13.11.2 shipped a .app whose worker died on line one of main():
//
//   [worker] fatal: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must
//     be of type string or an instance of URL. Received undefined
//       at fileURLToPath (node:internal/url:1649:11)
//       at harnessRoot (.../Resources/worker/worker.cjs:39634:109)
//       at installCliGoldenRunnerIfAvailable (...)
//       at main (...)
//
// `import.meta.url` is undefined once esbuild bundles the worker to CommonJS
// (scripts/bundle-worker.mjs), so the HTTP server never listened, every request
// 404'd at the Tauri shell, and both Home and Settings sat on "worker
// unreachable" / "loading…". The 3,700-test suite was green throughout —
// because NOTHING in it ever executed the bundled artifact. Tests ran the
// TypeScript under tsx/vitest, where `import.meta.url` exists.
//
// This script closes that hole. It runs the real bundler, boots the real
// worker.cjs with the real staged node sidecar, with the exact environment
// src-tauri/src/lib.rs `build_worker_command` sets in release, and refuses to
// pass unless /api/health answers with the right version over a database whose
// migrations actually ran.
//
// PROCESS RULES (build plan §1.3) honoured by construction:
//   1. SUPERTWIN_HOME is a throwaway scratch dir under os.tmpdir(); the
//      production home (~/SuperTwinV13) is refused before anything spawns —
//      belt and braces, because this is the one harness that deliberately sets
//      SUPERTWIN_LAUNCHED_BY=app, the token that waives the worker's own home
//      guard.
//   2. The port is OS-assigned; 8013 is refused.
//   3. The worker is a CHILD with piped stdio — never detached — reaped on
//      every exit path, and the port is confirmed closed before we return.
//   5. ZERO model calls: a fresh scratch home has no consent rows, so no
//      adapter starts, no dispatcher bundle exists and no lane has anything to
//      spend on. The run ASSERTS this by counting the `runs` ledger at the end.
//
// Usage:
//   node scripts/bundle-smoke.mjs [--force-bundle] [--keep-home] [--port N]
//   (and as part of `npm run test:scripts` via scripts/bundle-smoke.test.mjs)
// ===========================================================================

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "..");

export const PRODUCTION_PORT = 8013;
export const PRODUCTION_HOME = join(homedir(), "SuperTwinV13");

/** How long the bundled worker gets to answer /api/health. Observed: ~0.6 s. */
export const HEALTH_TIMEOUT_MS = 90_000;
/** How long it gets to exit after SIGTERM before we SIGKILL. */
export const KILL_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------
// The packaged layout
//
// Tauri copies `bundle.resources` into `SuperTwinV13.app/Contents/Resources/`
// under the destination each entry names, and puts `externalBin` next to the
// main executable. The bundled worker resolves everything it needs RELATIVE TO
// worker.cjs (`join(__dirname, "..", …)` — see worker/src/media/tools.ts
// `resourceCandidates`, worker/src/browser/chromium.ts `chromiumPath`,
// worker/src/retrieval/embedder.ts `bundledEmbeddingModelDir`), because cwd is
// not a thing you can rely on inside a Finder-launched .app.
//
// So: every path below is Contents/Resources-relative, and must be produced by
// a declared resource entry whose SOURCE exists in the repo. A path the worker
// resolves but tauri.conf.json never declares is a feature that works in the
// repo and is silently dead in the .app — which has happened before (the
// embedding weights, the media tools). This table is the standing check.
// ---------------------------------------------------------------------------

/** Boot-critical: the worker cannot start without these. */
export const BOOT_RESOURCES = [
  ["worker/worker.cjs", "the esbuild CJS bundle the node sidecar executes"],
  ["worker/package.json", '{"type":"commonjs"} + the stamped app version'],
  [
    "worker/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "the native addon every DB read goes through",
  ],
];

/** Resolved lazily after boot; absent means a dead feature, not a dead worker. */
export const RUNTIME_RESOURCES = [
  ["worker/bin/whatsapp-go", "sources/whatsapp-go, resolved as join(__dirname, 'bin/whatsapp-go')"],
  ["worker/bin/screenwatch", "sources/screenwatch, same shape"],
  [
    "worker/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
    "retrieval tier 3 — the embedding runtime's native backend",
  ],
  ["bin/ffmpeg", "media/tools.ts resolveFfmpegBin"],
  ["bin/whisper-cli", "media/tools.ts resolveWhisperBin"],
  ["bin/yt-dlp", "media/tools.ts resolveYtDlpBin"],
  ["models/ggml-large-v3-turbo-q5_0.bin", "media/tools.ts resolveWhisperModel (bundled default)"],
  [
    "models/embeddings/Xenova/multilingual-e5-small/onnx/model_quantized.onnx",
    "retrieval/embedder.ts bundledEmbeddingModelDir",
  ],
  [
    "chromium/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "browser/chromium.ts chromiumPath",
  ],
];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested by scripts/bundle-smoke.test.mjs — no boot needed)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { forceBundle: false, keepHome: false, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--force-bundle") opts.forceBundle = true;
    else if (a === "--keep-home") opts.keepHome = true;
    else if (a === "--port") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--port needs a value");
      i += 1;
      opts.port = Number(v);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port <= 0)) {
    throw new Error(`--port ${opts.port} is not a port`);
  }
  return opts;
}

/** `bundle.resources` as an ordered [{ src, dest }] list, src relative to src-tauri/. */
export function parseResourceMap(conf) {
  const res = conf?.bundle?.resources;
  if (!res) return [];
  if (Array.isArray(res)) return res.map((src) => ({ src, dest: src }));
  return Object.entries(res).map(([src, dest]) => ({ src, dest }));
}

/**
 * Which declared resource entry produces `rel` (a Contents/Resources-relative
 * path), and what repo file it comes from. `null` means NOTHING declares it —
 * the path exists in the repo and is missing from the .app.
 *
 * A file entry matches its destination exactly; a directory entry matches any
 * path beneath it, and the remainder is appended to the source.
 */
export function resolveResourceSource(entries, rel, tauriDir) {
  let best = null;
  for (const entry of entries) {
    const dest = entry.dest.replace(/\/+$/, "");
    let remainder = null;
    if (rel === dest) remainder = "";
    else if (rel.startsWith(`${dest}/`)) remainder = rel.slice(dest.length + 1);
    if (remainder === null) continue;
    // Longest destination wins, so a file entry beats a directory containing it.
    if (best === null || dest.length > best.dest.length) {
      best = { ...entry, dest, remainder };
    }
  }
  if (!best) return null;
  return { entry: best, src: resolve(join(tauriDir, best.src), best.remainder) };
}

/**
 * The migration ids worker/src/db/schema.ts declares, in order. The bundled
 * worker must have applied every one of them — that is what "migrations ran"
 * means, and it is the only form of the assertion that survives another lane
 * appending a migration while this test is being written.
 */
export function migrationIdsFromSchema(text) {
  const body = text.slice(text.indexOf("export const MIGRATIONS"));
  return [...body.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** The rail: a scratch home under tmpdir, never the real one. Throws otherwise. */
export function assertScratchHome(home) {
  if (typeof home !== "string" || home.trim().length === 0) {
    throw new Error("bundle-smoke: SUPERTWIN_HOME must be a non-empty scratch path");
  }
  const abs = resolve(home);
  if (abs === resolve(PRODUCTION_HOME)) {
    throw new Error(
      `bundle-smoke: refusing the production home ${PRODUCTION_HOME} (plan §1.3 rules 1 and 6)`,
    );
  }
  if (!abs.startsWith(resolve(tmpdir()))) {
    throw new Error(`bundle-smoke: ${abs} is not under ${tmpdir()} — refusing to boot`);
  }
  return abs;
}

/** The rail: never the app's port. Throws otherwise. */
export function assertSmokePort(port) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`bundle-smoke: ${port} is not a port`);
  }
  if (port === PRODUCTION_PORT) {
    throw new Error(
      `bundle-smoke: refusing port ${PRODUCTION_PORT} — that is the app (plan §1.3 rule 1)`,
    );
  }
  return port;
}

/** The Rust target triple stage-node-sidecar.mjs stages the node binary for. */
export function targetTriple() {
  const res = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = res.status === 0 ? /^host:\s*(\S+)$/m.exec(res.stdout ?? "") : null;
  if (host) return host[1];
  const byPlatform = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  const triple = byPlatform[`${process.platform}:${process.arch}`];
  if (!triple) throw new Error(`no known target triple for ${process.platform}:${process.arch}`);
  return triple;
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** Newest mtime under `dir`, skipping node_modules and dot-dirs. */
function newestMtime(dir, newest = 0) {
  let out = newest;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out = newestMtime(p, out);
    else if (e.isFile()) {
      const m = statSync(p).mtimeMs;
      if (m > out) out = m;
    }
  }
  return out;
}

/**
 * Is worker/bundle/worker.cjs newer than every input that goes into it? A stale
 * bundle is the exact failure mode this whole file exists to catch, so the
 * default is "rebuild unless provably fresh".
 */
export function bundleIsFresh(repoRoot = REPO) {
  const out = join(repoRoot, "worker", "bundle", "worker.cjs");
  if (!existsSync(out)) return false;
  const built = statSync(out).mtimeMs;
  let newest = 0;
  for (const dir of [
    join(repoRoot, "worker", "src"),
    join(repoRoot, "sources", "whatsapp-go"),
    join(repoRoot, "sources", "screenwatch"),
  ]) {
    newest = newestMtime(dir, newest);
  }
  for (const file of [
    join(repoRoot, "scripts", "bundle-worker.mjs"),
    join(repoRoot, "package.json"),
    join(repoRoot, "src-tauri", "tauri.conf.json"),
  ]) {
    if (existsSync(file)) newest = Math.max(newest, statSync(file).mtimeMs);
  }
  return built >= newest;
}

function runScript(label, script, args = []) {
  const res = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: process.env,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0) {
    throw new Error(`bundle-smoke: ${label} failed (exit ${res.status}):\n${out.trim()}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

export function portClosed(port) {
  return new Promise((res) => {
    const sock = netConnect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (closed) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      res(closed);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 1_000).unref?.();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** COUNT(*) over one table, or null when the table does not exist. */
function tableCount(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The boot probe
// ---------------------------------------------------------------------------

/**
 * Spawn `nodeBin entry`, wait for /api/health, run `whileHealthy` against the
 * live server, then reap the child and confirm the port closed.
 *
 * Every failure carries the child's own stdout AND stderr, because that stderr
 * was the entire diagnosis of the 13.11.1 dead worker — a smoke test that
 * reported "timed out" and swallowed the stack would have been worth nothing.
 *
 * Separated from runBundleSmoke so the FAILURE path is itself covered by a
 * deterministic test: bundle-smoke.test.mjs boots a stub that dies the way the
 * shipped worker died and asserts the stub's stderr comes back out.
 */
export async function probeWorker({
  nodeBin,
  entry,
  cwd,
  env,
  port,
  timeoutMs = HEALTH_TIMEOUT_MS,
  whileHealthy = null,
}) {
  assertSmokePort(port);
  const child = spawn(nodeBin, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let exit = null;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  const withChildOutput = (msg) =>
    new Error(
      `${msg}\n\n--- worker stdout ---\n${stdout.trim() || "(empty)"}\n` +
        `\n--- worker stderr ---\n${stderr.trim() || "(empty)"}\n`,
    );

  const reap = async () => {
    if (exit === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + KILL_GRACE_MS;
      while (exit === null && Date.now() < deadline) await sleep(100);
      if (exit === null) {
        child.kill("SIGKILL");
        while (exit === null) await sleep(100);
      }
    }
    // Plan §1.3 rule 3: the port we opened is closed before we return.
    for (let i = 0; i < 40 && !(await portClosed(port)); i += 1) await sleep(250);
    return await portClosed(port);
  };

  let health = null;
  let extra = null;
  let bootMs = null;
  let portIsClosed = false;
  const t0 = Date.now();
  try {
    for (;;) {
      if (exit !== null) {
        throw withChildOutput(
          `the bundled worker exited before it served /api/health ` +
            `(code=${exit.code}, signal=${exit.signal}) after ${Date.now() - t0} ms.\n` +
            `  This is the 13.11.1 failure mode: main() threw before server.listen(), ` +
            `so every request 404s at the Tauri shell and the app shows "worker unreachable".`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) {
          health = await res.json();
          break;
        }
      } catch {
        /* not listening yet */
      }
      if (Date.now() - t0 > timeoutMs) {
        throw withChildOutput(
          `the bundled worker never answered /api/health on port ${port} within ${timeoutMs} ms ` +
            `(still running).`,
        );
      }
      await sleep(250);
    }
    bootMs = Date.now() - t0;
    if (whileHealthy) {
      extra = await whileHealthy({ health, port, stdout: () => stdout, withChildOutput });
    }
  } finally {
    portIsClosed = await reap();
  }

  if (exit.signal === "SIGKILL") {
    throw withChildOutput("the worker ignored SIGTERM and had to be SIGKILLed");
  }
  if (exit.code !== 0) {
    throw withChildOutput(
      `the worker exited ${exit.code} on SIGTERM instead of shutting down cleanly`,
    );
  }
  if (!portIsClosed) {
    throw new Error(
      `bundle-smoke: port ${port} is still open after the worker exited (plan §1.3 rule 3)`,
    );
  }

  return { health, extra, bootMs, stdout, stderr, exit, portClosed: portIsClosed, withChildOutput };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Boot the bundled worker exactly as the .app does and prove it serves.
 * Resolves to a report; throws with the child's stderr attached on any failure.
 */
export async function runBundleSmoke(opts = {}) {
  const log = opts.log ?? ((line) => process.stderr.write(`[bundle-smoke] ${line}\n`));
  const repoRoot = opts.repoRoot ?? REPO;
  const notes = [];

  // --- 1. The artifact: the real bundler, or a provably fresh bundle. -------
  if (opts.forceBundle || !bundleIsFresh(repoRoot)) {
    log(`bundling (${opts.forceBundle ? "forced" : "worker/bundle is stale or missing"}) …`);
    runScript("scripts/bundle-worker.mjs", "bundle-worker.mjs");
  } else {
    log("reusing worker/bundle — newer than every input");
  }
  const bundleDir = join(repoRoot, "worker", "bundle");
  const workerCjs = join(bundleDir, "worker.cjs");
  if (!existsSync(workerCjs)) throw new Error(`bundle-smoke: no bundle at ${workerCjs}`);

  // --- 2. The node sidecar Tauri ships as externalBin. ----------------------
  runScript("scripts/stage-node-sidecar.mjs", "stage-node-sidecar.mjs");
  const triple = targetTriple();
  const suffix = process.platform === "win32" ? ".exe" : "";
  const nodeSidecar = join(repoRoot, "src-tauri", "binaries", `node-${triple}${suffix}`);
  if (!existsSync(nodeSidecar)) {
    throw new Error(
      `bundle-smoke: the node sidecar is not staged at ${nodeSidecar} — ` +
        `tauri build would fail with "resource path binaries/node-${triple} doesn't exist"`,
    );
  }
  if (!(statSync(nodeSidecar).mode & 0o111)) {
    throw new Error(`bundle-smoke: the staged node sidecar is not executable: ${nodeSidecar}`);
  }
  // stage-node-sidecar.mjs copies whatever node is running it, so the .app can
  // silently ship a runtime older than the one esbuild targeted (node22). The
  // binary is about to execute the bundle for real, but say so up front.
  const sidecarVersion = spawnSync(nodeSidecar, ["--version"], { encoding: "utf8" });
  const major = Number(/^v(\d+)\./.exec((sidecarVersion.stdout ?? "").trim())?.[1]);
  if (sidecarVersion.status !== 0 || !Number.isInteger(major)) {
    throw new Error(
      `bundle-smoke: the staged node sidecar does not run: ${nodeSidecar}\n` +
        `${(sidecarVersion.stdout ?? "") + (sidecarVersion.stderr ?? "")}`.trim(),
    );
  }
  if (major < 22) {
    throw new Error(
      `bundle-smoke: the staged node sidecar is v${major}; scripts/bundle-worker.mjs ` +
        `targets node22, so the .app would ship a runtime older than the bundle it runs.`,
    );
  }

  // --- 3. The Contents/Resources layout. ------------------------------------
  const tauriDir = join(repoRoot, "src-tauri");
  const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  const entries = parseResourceMap(conf);
  const resourcesStaged = existsSync(join(tauriDir, "resources"));
  const layout = [];
  for (const [rel, why] of [...BOOT_RESOURCES, ...RUNTIME_RESOURCES]) {
    const bootCritical = BOOT_RESOURCES.some(([r]) => r === rel);
    const hit = resolveResourceSource(entries, rel, tauriDir);
    if (!hit) {
      throw new Error(
        `bundle-smoke: NOTHING in tauri.conf.json bundle.resources produces ` +
          `Contents/Resources/${rel}\n  (${why})\n` +
          `  The worker resolves that path at runtime, so it would be dead in the .app.`,
      );
    }
    const present = existsSync(hit.src);
    layout.push({ rel, src: hit.src, present, boot: bootCritical });
    if (present) continue;
    // A never-staged resources/ tree is a fresh clone that has not run
    // `npm run stage:media` (1.3 GB of downloads). A PARTIALLY staged one is a
    // real inconsistency that fails the DMG build, so it fails here too.
    if (!bootCritical && !resourcesStaged && hit.src.startsWith(join(tauriDir, "resources"))) {
      notes.push(`not staged (npm run stage:media): ${rel}`);
      continue;
    }
    throw new Error(
      `bundle-smoke: declared resource is missing on disk: ${hit.src}\n` +
        `  -> Contents/Resources/${rel} (${why})\n` +
        `  tauri build would fail, or the .app would ship without it.`,
    );
  }
  log(
    `resource layout: ${layout.length} paths declared, ` +
      `${layout.filter((l) => l.present).length} present`,
  );

  // --- 4. Boot-critical bundle contents + the version stamp. ----------------
  const bundlePkg = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (bundlePkg.type !== "commonjs") {
    throw new Error(
      `bundle-smoke: worker/bundle/package.json must say type=commonjs, got ${bundlePkg.type}`,
    );
  }
  if (bundlePkg.version !== rootPkg.version) {
    throw new Error(
      `bundle-smoke: the bundle is stamped ${bundlePkg.version} but package.json says ${rootPkg.version}`,
    );
  }

  // --- 5. The rails: a scratch home, never 8013. ----------------------------
  const home = assertScratchHome(mkdtempSync(join(tmpdir(), "supertwin-bundle-smoke-")));
  const port = assertSmokePort(opts.port ?? (await freePort()));
  log(`booting ${workerCjs}\n            node=${nodeSidecar}\n            home=${home} port=${port}`);

  // --- 6. The environment src-tauri/src/lib.rs sets in release. -------------
  const env = { ...process.env };
  // build_worker_command inherits the app's environment and adds these two.
  env.SUPERTWIN_WHATSAPP_BIN = join(bundleDir, "bin", "whatsapp-go");
  env.SUPERTWIN_LAUNCHED_BY = "app";
  // …plus our rails. SUPERTWIN_HOME is what keeps LAUNCHED_BY=app harmless.
  env.SUPERTWIN_HOME = home;
  env.SUPERTWIN_WORKER_PORT = String(port);
  // An inherited override must never drag the child back to the real database
  // or waive a guard on our behalf.
  delete env.SUPERTWIN_DB_PATH;
  delete env.SUPERTWIN_ALLOW_PRODUCTION_HOME;

  // --- 7. Boot, poll /api/health, exercise the live surface, reap. ----------
  const probe = await probeWorker({
    nodeBin: nodeSidecar,
    entry: workerCjs,
    cwd: bundleDir,
    env,
    port,
    timeoutMs: opts.timeoutMs ?? HEALTH_TIMEOUT_MS,
    whileHealthy: async ({ health: h, stdout: readStdout, withChildOutput }) => {
      if (h?.ok !== true) {
        throw withChildOutput(`/api/health did not report ok:true — ${JSON.stringify(h)}`);
      }
      if (h.version !== rootPkg.version) {
        throw withChildOutput(
          `/api/health reports version ${h.version}; package.json says ${rootPkg.version}. ` +
            `The bundle's stamped version is what the Settings screen shows.`,
        );
      }
      if (typeof h.builtThroughPhase !== "string" || h.builtThroughPhase.length === 0) {
        throw withChildOutput(`/api/health has no builtThroughPhase — ${JSON.stringify(h)}`);
      }
      if (!readStdout().includes(`WORKER_READY port=${port}`)) {
        throw withChildOutput(
          `the worker never printed "WORKER_READY port=${port}" — that line is how ` +
            `src-tauri detects readiness and emits the worker-ready event.`,
        );
      }
      // A DB-backed route: proves the staged native addon really serves a read.
      const quota = await fetch(`http://127.0.0.1:${port}/api/quota`);
      if (quota.status !== 200) {
        throw withChildOutput(
          `/api/quota answered ${quota.status} — the bundled better-sqlite3 cannot serve a read`,
        );
      }
      return { quotaStatus: quota.status };
    },
  });
  const { health, bootMs, stdout, stderr, portClosed: portIsClosed } = probe;
  log(`healthy in ${bootMs} ms — version ${health.version}, phase ${health.builtThroughPhase}`);

  // --- 8. Migrations really ran, and the run really was free. ---------------
  const dbPath = join(home, "supertwinv13.db");
  if (!existsSync(dbPath)) throw probe.withChildOutput(`the worker never created ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let applied;
  let runs;
  let missingTables;
  try {
    applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));
    missingTables = ["events", "streams", "runs", "spaces", "decisions"].filter(
      (t) => tableCount(db, t) === null,
    );
    runs = tableCount(db, "runs");
  } finally {
    db.close();
  }

  const declared = migrationIdsFromSchema(
    readFileSync(join(repoRoot, "worker", "src", "db", "schema.ts"), "utf8"),
  );
  if (declared.length === 0) {
    throw new Error("bundle-smoke: could not read MIGRATIONS out of worker/src/db/schema.ts");
  }
  const missing = declared.filter((id) => !applied.has(id));
  if (missing.length > 0) {
    throw new Error(
      `bundle-smoke: the bundled worker did not apply ${missing.length} migration(s): ${missing.join(", ")}`,
    );
  }
  if (missingTables.length > 0) {
    throw new Error(
      `bundle-smoke: migrations ran but these tables are absent: ${missingTables.join(", ")}`,
    );
  }
  // Plan §1.3 rule 5: a smoke test must not spend. A fresh home has no consent
  // row, so no lane has anything to dispatch — and now that is checked, not hoped.
  if (runs !== 0) {
    throw new Error(
      `bundle-smoke: the boot made ${runs} model call(s) — a smoke test must spend nothing`,
    );
  }

  if (opts.keepHome) log(`kept scratch home ${home}`);
  else rmSync(home, { recursive: true, force: true });

  log(
    `PASS — ${declared.length} migrations applied, 0 model calls, ` +
      `exit 0 on SIGTERM, port ${port} closed`,
  );
  for (const n of notes) log(`note: ${n}`);

  return {
    version: health.version,
    builtThroughPhase: health.builtThroughPhase,
    bootMs,
    port,
    home,
    portClosed: portIsClosed,
    migrationsApplied: declared.length,
    modelCalls: runs,
    quotaStatus: probe.extra.quotaStatus,
    layout,
    notes,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  runBundleSmoke(opts).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`\n[bundle-smoke] FAIL\n${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}
