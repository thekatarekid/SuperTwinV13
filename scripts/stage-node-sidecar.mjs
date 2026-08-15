// ===========================================================================
// Stage the Node sidecar that Tauri ships inside the .app.
//
// tauri.conf.json declares `externalBin: ["binaries/node"]`. Tauri resolves
// that to `src-tauri/binaries/node-<target-triple>` at bundle time and fails
// the build with
//
//   resource path `binaries/node-aarch64-apple-darwin` doesn't exist
//
// if the file is missing. The binary is ~113 MB, so it is gitignored and never
// committed — which means a fresh clone has no sidecar and cannot package.
// Historically it was copied by hand; this script does it as part of the build
// so a clean checkout can go straight to `npm run build:app`.
//
// Source: whatever `node` is running this script (process.execPath, symlinks
// resolved). That is the same "system node" the packaging step always used.
// The copy is idempotent — an existing file of identical size is left alone,
// so repeat builds do not re-copy 113 MB.
//
// Tauri's macOS bundler signs this binary itself, applying
// src-tauri/entitlements.plist (allow-jit et al) so V8 can start under the
// hardened runtime. We only place the file.
// ===========================================================================

import { copyFileSync, chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "src-tauri", "binaries");

/**
 * The Rust target triple Tauri will look for. `rustc -vV` is authoritative —
 * it reports the exact host triple the build will use. Fall back to a
 * platform/arch map when rustc is unavailable (e.g. someone runs this script
 * alone on a machine without the Rust toolchain).
 */
function targetTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = /^host:\s*(\S+)$/m.exec(out);
    if (host) return host[1];
  } catch {
    // rustc missing or not on PATH — fall through to the static map.
  }

  const byPlatform = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  const key = `${process.platform}:${process.arch}`;
  const triple = byPlatform[key];
  if (!triple) {
    console.error(
      `[stage-node] ERROR: no known target triple for ${key}. ` +
        `Install Rust so 'rustc -vV' can report the host triple.`,
    );
    process.exit(1);
  }
  return triple;
}

const triple = targetTriple();
const suffix = process.platform === "win32" ? ".exe" : "";
const dest = join(outDir, `node-${triple}${suffix}`);

// Resolve symlinks: on Homebrew/nvm, `node` is a symlink into a versioned dir.
// We want the real executable, not a link that will dangle inside the .app.
const src = realpathSync(process.execPath);

if (src === dest) {
  console.log("[stage-node] source and destination are the same file — nothing to do");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const srcSize = statSync(src).size;
if (existsSync(dest) && statSync(dest).size === srcSize) {
  console.log(
    `[stage-node] up to date: ${dest} (${(srcSize / 1024 / 1024).toFixed(1)} MB)`,
  );
  process.exit(0);
}

console.log(
  `[stage-node] ${src} -> ${dest} (${(srcSize / 1024 / 1024).toFixed(1)} MB)`,
);
copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`[stage-node] staged node sidecar for ${triple}`);
