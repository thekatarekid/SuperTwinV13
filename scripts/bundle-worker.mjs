// ===========================================================================
// bundle-worker.mjs — produce a SELF-CONTAINED worker artifact for the bundled
// macOS .app (no repo, no npm, no tsx at runtime).
//
// What it does:
//   1. esbuild-bundle worker/src/index.ts  ->  worker/bundle/worker.cjs
//      (CJS, node22 target, better-sqlite3 kept external so the native addon is
//      require()'d from staged node_modules at runtime rather than inlined).
//   2. Stage the runtime native deps NEXT TO worker.cjs:
//        worker/bundle/node_modules/{better-sqlite3,bindings,file-uri-to-path}
//      so `require('better-sqlite3')` resolves beside the bundle. better-sqlite3
//      is PRUNED (keep package.json + lib/ + build/Release/*.node; drop the C++
//      sources, intermediate objects, and foreign-platform prebuilds).
//   2c. Stage @huggingface/transformers and its transitive closure the same
//      way, for tier 3 of retrieval (docs/v6-spec.md §1). It is loaded by a
//      RUNTIME specifier, so esbuild never sees it and cannot bundle it — it
//      has to be next to worker.cjs or semantic search is silently dead in the
//      .app while working perfectly in the repo. Pruned to what darwin-arm64
//      actually runs: ~380 MB installed becomes ~70 MB staged.
//   3. Write worker/bundle/package.json = {"type":"commonjs"} so Node treats
//      worker.cjs (and the folder) as CommonJS unambiguously.
//   4. Verify the native addon actually landed; fail loudly otherwise.
//   5. Compile the Go WhatsApp daemon (aarch64-apple-darwin, CGO-free) INTO
//      the bundle at worker/bundle/bin/whatsapp-go, ad-hoc codesign it with the
//      app's entitlements, and verify (Mach-O arm64 + executable + signed +
//      a live mock spin). The daemon is a CHILD of the Node worker (see
//      docs/PHASE1_CONTRACT.md §0) — it is bundled INSIDE worker/bundle, NOT a
//      Tauri externalBin. The worker resolves it at runtime relative to
//      worker.cjs (join(__dirname, "bin/whatsapp-go")).
//
// The Tauri packaging step ships worker/bundle/ wholesale and runs
// `node worker/bundle/worker.cjs` via a sidecar node binary. Because Tauri
// copies bundle.resources verbatim and only signs the OUTER .app, the daemon
// must already carry a valid ad-hoc signature BEFORE `tauri build` runs — which
// it does, since this script is the beforeBuildCommand. A nested already-signed
// Mach-O stays valid inside the outer app signature.
// ===========================================================================

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// App version stamped into the bundle's package.json so the bundled worker
// reports the right /api/health version (source of truth: root package.json,
// which tracks src-tauri/tauri.conf.json). Robust fallback if it can't be read.
function resolveAppVersion() {
  for (const rel of ["package.json", join("src-tauri", "tauri.conf.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      // try the next source
    }
  }
  return "0.1.0";
}
const APP_VERSION = resolveAppVersion();

const ENTRY = join(repoRoot, "worker", "src", "index.ts");
const BUNDLE_DIR = join(repoRoot, "worker", "bundle");
const OUT_CJS = join(BUNDLE_DIR, "worker.cjs");
const NODE_MODULES_SRC = join(repoRoot, "node_modules");
const NODE_MODULES_DST = join(BUNDLE_DIR, "node_modules");

// --- Go WhatsApp daemon (contract §0): compiled INTO the bundle so the worker
// resolves it at runtime via join(__dirname_of_worker.cjs, "bin/whatsapp-go").
const GO_SRC_DIR = join(repoRoot, "sources", "whatsapp-go");
const GO_BIN_DIR = join(BUNDLE_DIR, "bin");
const GO_BIN_OUT = join(GO_BIN_DIR, "whatsapp-go");

// --- Swift screenwatch sidecar (P2.1): staged the same way — the worker
// resolves it at runtime via join(__dirname_of_worker.cjs, "bin/screenwatch").
const SCREENWATCH_SRC_DIR = join(repoRoot, "sources", "screenwatch");
const SCREENWATCH_BIN_OUT = join(GO_BIN_DIR, "screenwatch");
const KEYCHAIN_ACL_SRC = join(repoRoot, "scripts", "native-keychain-acl.m");
const KEYCHAIN_ACL_OUT = join(GO_BIN_DIR, "supertwin-keychain-acl");
// Ad-hoc signing uses the SAME entitlements as the outer app / node sidecar so
// the nested Mach-O runs under the hardened runtime once the .app is signed.
const ENTITLEMENTS = join(repoRoot, "src-tauri", "entitlements.plist");

// Runtime deps that must resolve NEXT TO worker.cjs. better-sqlite3 is native
// (kept external in esbuild); bindings + file-uri-to-path are its resolvers.
const RUNTIME_DEPS = ["better-sqlite3", "bindings", "file-uri-to-path"];

// Prune better-sqlite3 to the minimum needed to load + run the prebuilt addon.
// KEEP: package.json, lib/, build/Release/better_sqlite3.node.
// DROP: build directories that only carry C++ intermediates / sources / other
// platform prebuilds — none of which are read at runtime.
const BSQLITE_PRUNE = [
  "deps", // bundled SQLite/C sources
  "src", // C++ addon sources
  "prebuilds", // prebuilt binaries for OTHER platforms
  join("build", "Release", "obj"), // intermediate build objects
  join("build", "Release", "obj.target"),
  join("build", "Release", ".deps"),
  join("build", "Release", "sqlite3.a"),
];

// The embedding runtime for retrieval tier 3, staged as a whole dependency
// tree rather than a list: it pulls onnxruntime and protobuf, and a list would
// go stale the first time upstream added one.
const EMBEDDING_RUNTIME = "@huggingface/transformers";

/**
 * Packages inside that tree that must NOT ship.
 *
 * onnxruntime-web is 130 MB of WASM for a browser that will never run this;
 * Node resolves onnxruntime-node instead, which is verified below by loading
 * the staged copy for real. The rest are .d.ts-only packages.
 */
const EMBEDDING_SKIP = new Set([
  "onnxruntime-web",
  "@types/node",
  "undici-types",
  "type-fest",
]);

/**
 * Paths dropped from staged packages, relative to each. onnxruntime-node ships
 * a prebuilt runtime per platform (~210 MB in total) and this machine's app
 * only ever loads one of them.
 */
const EMBEDDING_PRUNE = {
  "onnxruntime-node": [
    join("bin", "napi-v6", "win32"),
    join("bin", "napi-v6", "linux"),
    join("bin", "napi-v6", "darwin", "x64"),
  ],
  "@huggingface/transformers": ["src", "types", "README.md"],
};

/** What the staged runtime is worthless without: the native ONNX binding. */
const ONNX_BINDING = join(
  "onnxruntime-node",
  "bin",
  "napi-v6",
  "darwin",
  "arm64",
  "onnxruntime_binding.node",
);

function log(msg) {
  console.log(`[bundle-worker] ${msg}`);
}

function fail(msg) {
  console.error(`[bundle-worker] ERROR: ${msg}`);
  process.exit(1);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

// Run a command, capturing combined stdout+stderr regardless of exit status.
// Never throws — callers decide how to react. Crucially this captures BOTH
// streams even on a clean exit, because tools like `codesign -dvvv` print their
// entire report to stderr while exiting 0.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    return { status: 1, out: String(res.error.message ?? res.error) };
  }
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: typeof res.status === "number" ? res.status : 1, out };
}

// ---------------------------------------------------------------------------
// The embedding runtime: resolve the tree, copy it, prune it, prove it loads.
// ---------------------------------------------------------------------------

/** Every package `name` needs at runtime, itself included, minus EMBEDDING_SKIP. */
function dependencyClosure(name, seen = new Set()) {
  if (seen.has(name) || EMBEDDING_SKIP.has(name)) return seen;
  const manifest = join(NODE_MODULES_SRC, name, "package.json");
  if (!existsSync(manifest)) return seen;
  seen.add(name);
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  // Optional deps are where the per-platform native packages live, and npm has
  // already installed only the ones this platform resolved.
  for (const dep of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    dependencyClosure(dep, seen);
  }
  return seen;
}

function stageEmbeddingRuntime() {
  const packages = [...dependencyClosure(EMBEDDING_RUNTIME)].sort();
  if (!packages.includes(EMBEDDING_RUNTIME)) {
    fail(
      `${EMBEDDING_RUNTIME} is not installed in repo node_modules.\n` +
        `  It is a dependency of the worker — run 'npm install' and rebuild.`,
    );
  }

  for (const name of packages) {
    cpSync(join(NODE_MODULES_SRC, name), join(NODE_MODULES_DST, name), {
      recursive: true,
      dereference: true,
    });
    for (const rel of EMBEDDING_PRUNE[name] ?? []) {
      rmSync(join(NODE_MODULES_DST, name, rel), { recursive: true, force: true });
    }
  }

  const binding = join(NODE_MODULES_DST, ONNX_BINDING);
  if (!existsSync(binding)) {
    fail(
      `the ONNX native binding did NOT stage: ${binding}\n` +
        `  Without it semantic search is dead in the .app and fine in the repo.`,
    );
  }
  log(
    `staged ${EMBEDDING_RUNTIME} + ${packages.length - 1} deps ` +
      `(${humanSize(packages.reduce((n, p) => n + dirSize(join(NODE_MODULES_DST, p)), 0))})`,
  );
}

/**
 * Load the STAGED runtime in a child process, from the bundle directory, the
 * way the packaged worker will. Importing it in this process would prove only
 * that the repo's copy works — which is exactly the thing that was true while
 * the feature was unreachable.
 */
function verifyEmbeddingRuntime() {
  const probe = `
    import(${JSON.stringify(EMBEDDING_RUNTIME)})
      .then((m) => {
        if (typeof m.pipeline !== "function") throw new Error("no pipeline export");
        // Touching env proves the backend resolved, not just that a file parsed.
        m.env.allowRemoteModels = false;
        console.log("ok");
      })
      .catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
  `;
  const res = run(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: BUNDLE_DIR,
  });
  if (res.status !== 0 || !res.out.includes("ok")) {
    fail(`the staged ${EMBEDDING_RUNTIME} does not load:\n${res.out.trim()}`);
  }
  log(`${EMBEDDING_RUNTIME} loads from the bundle (verified)`);
}

// ---------------------------------------------------------------------------
// Go WhatsApp daemon: compile -> chmod -> ad-hoc sign -> verify.
// All paths are absolute (derived from this script's location) so the build is
// robust regardless of the caller's cwd.
// ---------------------------------------------------------------------------
function bundleGoDaemon() {
  if (!existsSync(GO_SRC_DIR)) {
    fail(`Go daemon source not found: ${GO_SRC_DIR}`);
  }
  if (!existsSync(ENTITLEMENTS)) {
    fail(`entitlements not found (needed to sign the daemon): ${ENTITLEMENTS}`);
  }

  mkdirSync(GO_BIN_DIR, { recursive: true });

  // --- Compile: pure-Go (CGO_ENABLED=0), cross-target aarch64-apple-darwin.
  // -trimpath + -ldflags="-s -w" strip build paths and the symbol table for a
  // smaller, reproducible, self-contained binary. Run WITH cwd = GO_SRC_DIR.
  log(`go build (arm64/darwin) ${GO_SRC_DIR} -> ${GO_BIN_OUT}`);
  const goBuild = run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      GO_BIN_OUT,
      ".",
    ],
    {
      cwd: GO_SRC_DIR,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "darwin",
        GOARCH: "arm64",
      },
    },
  );
  if (goBuild.status !== 0 || !existsSync(GO_BIN_OUT)) {
    fail(`go build failed (status=${goBuild.status}):\n${goBuild.out}`);
  }

  // --- Make it executable.
  chmodSync(GO_BIN_OUT, 0o755);

  // --- Ad-hoc codesign WITH entitlements + hardened runtime so the nested
  // Mach-O stays valid (and runnable) inside the outer ad-hoc-signed .app.
  //   --force            re-sign even if already signed
  //   --sign -           ad-hoc identity (no cert)
  //   --timestamp=none   no trusted timestamp (offline / ad-hoc)
  //   --options runtime  hardened runtime (matches the node sidecar)
  //   --entitlements ... the same plist the node sidecar/app use
  log(`codesign (ad-hoc, hardened runtime) ${GO_BIN_OUT}`);
  const sign = run("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    ENTITLEMENTS,
    GO_BIN_OUT,
  ]);
  if (sign.status !== 0) {
    fail(`codesign failed (status=${sign.status}):\n${sign.out}`);
  }

  verifyGoDaemon();
}

// ---------------------------------------------------------------------------
// Verify the bundled daemon: exists, arm64 Mach-O, executable, ad-hoc signed,
// signature valid, and a real mock spin from the bundle path exits cleanly.
// Any failure aborts the whole bundle.
// ---------------------------------------------------------------------------
function verifyGoDaemon() {
  if (!existsSync(GO_BIN_OUT)) fail(`daemon missing after build: ${GO_BIN_OUT}`);

  // 1. Executable bit.
  const mode = statSync(GO_BIN_OUT).mode;
  if (!(mode & 0o111)) fail(`daemon is not executable: ${GO_BIN_OUT}`);

  // 2. Mach-O arm64 (via `file`).
  const fileOut = run("file", [GO_BIN_OUT]).out.trim();
  if (!/Mach-O/.test(fileOut) || !/arm64/.test(fileOut)) {
    fail(`daemon is not a Mach-O arm64 binary:\n  ${fileOut}`);
  }
  log(`file: ${fileOut.replace(`${GO_BIN_OUT}: `, "")}`);

  // 3. Ad-hoc signed (Signature=adhoc) — read the signing info from stderr.
  const dvvv = run("codesign", ["-dvvv", GO_BIN_OUT]);
  if (dvvv.status !== 0) {
    fail(`codesign -dvvv failed (unsigned?):\n${dvvv.out}`);
  }
  if (!/Signature=adhoc/.test(dvvv.out)) {
    fail(`daemon is not ad-hoc signed:\n${dvvv.out}`);
  }

  // 4. Signature actually verifies.
  const vfy = run("codesign", ["--verify", "--verbose=2", GO_BIN_OUT]);
  if (vfy.status !== 0) {
    fail(`codesign --verify failed:\n${vfy.out}`);
  }

  // 5. Live mock spin FROM THE BUNDLE PATH: feed a `shutdown` command on stdin
  // in --mock mode. A clean exit 0 proves the compiled binary loads and speaks
  // the NDJSON protocol. (The daemon has no --help; --media-dir is required, so
  // this is the correct minimal smoke test.)
  const scratch = join(BUNDLE_DIR, ".daemon-smoke");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "media"), { recursive: true });
  const spin = run(
    GO_BIN_OUT,
    [
      "--mock",
      "--session-db",
      join(scratch, "session.db"),
      "--media-dir",
      join(scratch, "media"),
    ],
    { input: '{"cmd":"shutdown"}\n' },
  );
  rmSync(scratch, { recursive: true, force: true });
  if (spin.status !== 0) {
    fail(
      `daemon mock spin did not exit cleanly (status=${spin.status}):\n${spin.out}`,
    );
  }
  log("mock spin: shutdown -> exit 0 (OK)");
}

// ---------------------------------------------------------------------------
// Swift screenwatch sidecar (P2.1): build.sh (arm64) -> copy -> chmod ->
// ad-hoc sign -> verify — the whatsapp-go recipe, swiftc instead of go.
// ---------------------------------------------------------------------------
function bundleScreenwatch() {
  if (!existsSync(SCREENWATCH_SRC_DIR)) {
    fail(`screenwatch source not found: ${SCREENWATCH_SRC_DIR}`);
  }
  if (!existsSync(ENTITLEMENTS)) {
    fail(`entitlements not found (needed to sign screenwatch): ${ENTITLEMENTS}`);
  }

  mkdirSync(GO_BIN_DIR, { recursive: true });

  log(`swift build (arm64/darwin) ${SCREENWATCH_SRC_DIR} -> ${SCREENWATCH_BIN_OUT}`);
  const swiftBuild = run("bash", ["build.sh", "arm64"], {
    cwd: SCREENWATCH_SRC_DIR,
  });
  const built = join(SCREENWATCH_SRC_DIR, "screenwatch");
  if (swiftBuild.status !== 0 || !existsSync(built)) {
    fail(`screenwatch build failed (status=${swiftBuild.status}):\n${swiftBuild.out}`);
  }
  cpSync(built, SCREENWATCH_BIN_OUT);
  chmodSync(SCREENWATCH_BIN_OUT, 0o755);

  log(`codesign (ad-hoc, hardened runtime) ${SCREENWATCH_BIN_OUT}`);
  const sign = run("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    ENTITLEMENTS,
    SCREENWATCH_BIN_OUT,
  ]);
  if (sign.status !== 0) {
    fail(`codesign failed (status=${sign.status}):\n${sign.out}`);
  }

  verifyScreenwatch();
}

function bundleKeychainHelper() {
  mkdirSync(GO_BIN_DIR, { recursive: true });
  const aclCompile = run("/usr/bin/clang", ["-fobjc-arc", "-arch", "arm64", "-mmacosx-version-min=13.0",
    "-framework", "Foundation", "-framework", "Security", KEYCHAIN_ACL_SRC, "-o", KEYCHAIN_ACL_OUT]);
  if (aclCompile.status !== 0) fail(`Keychain ACL helper build failed:\n${aclCompile.out}`);
  chmodSync(KEYCHAIN_ACL_OUT, 0o755);
  const aclSign = run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
    "--identifier", "in.adityakatare.SuperTwinV13.keychain-acl", KEYCHAIN_ACL_OUT]);
  if (aclSign.status !== 0) fail(`Keychain ACL helper signing failed:\n${aclSign.out}`);
  const aclVerify = run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", KEYCHAIN_ACL_OUT]);
  if (aclVerify.status !== 0) fail(`Keychain ACL helper signature verification failed:\n${aclVerify.out}`);
}

function verifyScreenwatch() {
  if (!existsSync(SCREENWATCH_BIN_OUT)) {
    fail(`screenwatch missing after build: ${SCREENWATCH_BIN_OUT}`);
  }
  const mode = statSync(SCREENWATCH_BIN_OUT).mode;
  if (!(mode & 0o111)) fail(`screenwatch is not executable: ${SCREENWATCH_BIN_OUT}`);

  const fileOut = run("file", [SCREENWATCH_BIN_OUT]).out.trim();
  if (!/Mach-O/.test(fileOut) || !/arm64/.test(fileOut)) {
    fail(`screenwatch is not a Mach-O arm64 binary:\n  ${fileOut}`);
  }
  log(`file: ${fileOut.replace(`${SCREENWATCH_BIN_OUT}: `, "")}`);

  const dvvv = run("codesign", ["-dvvv", SCREENWATCH_BIN_OUT]);
  if (dvvv.status !== 0) {
    fail(`codesign -dvvv failed (unsigned?):\n${dvvv.out}`);
  }
  if (!/Signature=adhoc/.test(dvvv.out)) {
    fail(`screenwatch is not ad-hoc signed:\n${dvvv.out}`);
  }

  const vfy = run("codesign", ["--verify", "--verbose=2", SCREENWATCH_BIN_OUT]);
  if (vfy.status !== 0) {
    fail(`codesign --verify failed:\n${vfy.out}`);
  }

  // Mock spin FROM THE BUNDLE PATH: `shutdown` on stdin in --mock mode; a
  // clean exit 0 proves the binary loads and speaks the NDJSON protocol.
  const spin = run(SCREENWATCH_BIN_OUT, ["--mock"], {
    input: '{"cmd":"shutdown"}\n',
  });
  if (spin.status !== 0) {
    fail(
      `screenwatch mock spin did not exit cleanly (status=${spin.status}):\n${spin.out}`,
    );
  }
  log("screenwatch mock spin: shutdown -> exit 0 (OK)");

  // S6d/L4: the bundled sidecar must be new enough to ASK for Accessibility.
  // `--check-permission` never asks, so this is a side-effect-free probe of
  // the BUILD: only the version that also understands --request-permission
  // (the AXIsProcessTrustedWithOptions prompt — the call that puts SuperTwin in
  // the System Settings list) reports the `prompted` field. A stale binary
  // here is the `probe-unsupported` trap: it ignores the unknown flag and
  // starts live capture instead of answering.
  const probe = run(SCREENWATCH_BIN_OUT, ["--check-permission"]);
  if (probe.status !== 0) {
    fail(`screenwatch --check-permission did not exit cleanly (status=${probe.status}):\n${probe.out}`);
  }
  const frame = probe.out.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed;
  try {
    parsed = JSON.parse(frame);
  } catch {
    fail(`screenwatch --check-permission did not answer with one JSON frame:\n${probe.out}`);
  }
  if (parsed.t !== "permission") {
    fail(`screenwatch ignored --check-permission and answered t=${parsed.t} — stale binary:\n${probe.out}`);
  }
  if (parsed.prompted === undefined) {
    fail(
      "screenwatch predates --request-permission (no `prompted` field): the bundled sidecar " +
        "could not ask macOS for Accessibility, so the app would never appear in the " +
        "Accessibility list. Rebuild sources/screenwatch.",
    );
  }
  log(`screenwatch --check-permission: ${frame} (OK)`);
}

async function main() {
  // --- Clean slate so stale artifacts never leak into the bundle.
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });

  // --- 1. esbuild bundle -> CJS.
  log(`esbuild ${ENTRY} -> ${OUT_CJS}`);
  await build({
    entryPoints: [ENTRY],
    outfile: OUT_CJS,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Native/optional module: require it at runtime from staged node_modules.
    external: ["better-sqlite3"],
    sourcemap: false,
    logLevel: "info",
  });

  if (!existsSync(OUT_CJS)) fail(`esbuild did not produce ${OUT_CJS}`);

  // --- 2. Stage runtime deps beside worker.cjs.
  mkdirSync(NODE_MODULES_DST, { recursive: true });
  for (const dep of RUNTIME_DEPS) {
    const src = join(NODE_MODULES_SRC, dep);
    const dst = join(NODE_MODULES_DST, dep);
    if (!existsSync(src)) {
      fail(`missing runtime dep in repo node_modules: ${dep} (expected ${src})`);
    }
    cpSync(src, dst, { recursive: true, dereference: true });
    log(`staged node_modules/${dep}`);
  }

  // --- 2b. Prune better-sqlite3 to keep the bundle small.
  const bsqliteDst = join(NODE_MODULES_DST, "better-sqlite3");
  for (const rel of BSQLITE_PRUNE) {
    const p = join(bsqliteDst, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
    }
  }
  // Drop any stray *.o object files left under build/.
  const buildDir = join(bsqliteDst, "build");
  if (existsSync(buildDir)) {
    const dropObjects = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) dropObjects(p);
        else if (entry.isFile() && entry.name.endsWith(".o")) {
          rmSync(p, { force: true });
        }
      }
    };
    dropObjects(buildDir);
  }

  // --- 2c. Stage the embedding runtime for retrieval tier 3.
  stageEmbeddingRuntime();

  // --- 3. Force CJS interpretation of the bundle folder AND stamp the app
  // version so the bundled worker's /api/health reports it (server/index.ts
  // reads the nearest package.json with a real version).
  writeFileSync(
    join(BUNDLE_DIR, "package.json"),
    `${JSON.stringify({ type: "commonjs", version: APP_VERSION }, null, 2)}\n`,
  );
  log(`stamped bundle version: ${APP_VERSION}`);

  // --- 4. Verify the native addon actually landed (the whole point).
  const addon = join(
    bsqliteDst,
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(addon)) {
    fail(
      `native addon NOT staged: ${addon}\n` +
        `  Pruning removed too much, or the prebuilt .node was missing in repo node_modules.`,
    );
  }

  // --- 4b. And that the embedding runtime loads from where it now lives.
  verifyEmbeddingRuntime();

  // --- 5. Compile + sign + verify the Go WhatsApp daemon INTO the bundle.
  bundleGoDaemon();

  // --- 6. Compile + sign + verify the Swift screenwatch sidecar (P2.1).
  bundleScreenwatch();

  // --- 7. Compile and sign the metadata-only Keychain ACL inspector.
  bundleKeychainHelper();

  // --- Summary.
  const bundleBytes = statSync(OUT_CJS).size;
  const addonBytes = statSync(addon).size;
  const daemonBytes = statSync(GO_BIN_OUT).size;
  const screenBytes = statSync(SCREENWATCH_BIN_OUT).size;
  const totalBytes = dirSize(BUNDLE_DIR);
  log("----------------------------------------------------------------");
  log(`worker.cjs         : ${humanSize(bundleBytes)}`);
  log(`better_sqlite3.node: ${humanSize(addonBytes)} (staged OK)`);
  log(`bin/whatsapp-go    : ${humanSize(daemonBytes)} (arm64, ad-hoc signed OK)`);
  log(`bin/screenwatch    : ${humanSize(screenBytes)} (arm64, ad-hoc signed OK)`);
  log(`bundle/ total      : ${humanSize(totalBytes)}`);
  log(`entry              : worker/bundle/worker.cjs`);
  log("----------------------------------------------------------------");
  log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
