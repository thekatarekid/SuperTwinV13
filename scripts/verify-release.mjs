#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const APP_NAME = "SuperTwinV13";
export const BUNDLE_ID = "com.supertwin.v13";
export const MIN_MACOS = "13.0";

export const REQUIRED_BUNDLE_FILES = [
  "Contents/MacOS/supertwinv13",
  "Contents/MacOS/node",
  "Contents/Resources/worker/worker.cjs",
  "Contents/Resources/worker/package.json",
  "Contents/Resources/worker/bin/whatsapp-go",
  "Contents/Resources/worker/bin/screenwatch",
  "Contents/Resources/bin/ffmpeg",
  "Contents/Resources/bin/whisper-cli",
  "Contents/Resources/bin/yt-dlp",
  "Contents/Resources/models/ggml-large-v3-turbo-q5_0.bin",
  "Contents/Resources/models/embeddings/Xenova/multilingual-e5-small/config.json",
  "Contents/Resources/models/embeddings/Xenova/multilingual-e5-small/tokenizer_config.json",
  "Contents/Resources/models/embeddings/Xenova/multilingual-e5-small/tokenizer.json",
  "Contents/Resources/models/embeddings/Xenova/multilingual-e5-small/onnx/model_quantized.onnx",
];

export const REQUIRED_EXECUTABLE_FILES = [
  "Contents/MacOS/supertwinv13",
  "Contents/MacOS/node",
  "Contents/Resources/worker/bin/whatsapp-go",
  "Contents/Resources/worker/bin/screenwatch",
  "Contents/Resources/bin/ffmpeg",
  "Contents/Resources/bin/whisper-cli",
  "Contents/Resources/bin/yt-dlp",
];

const CANONICAL_DMG_RE = /^SuperTwinV13_(\d+\.\d+\.\d+)_(aarch64|x64|universal)\.dmg$/;
const ARCHIVE_DMG_RE = /^SuperTwinV13_[A-Za-z0-9]+_(\d+\.\d+\.\d+)\.dmg$/;

export function dmgMetadata(name) {
  const canonical = CANONICAL_DMG_RE.exec(name);
  if (canonical) return { version: canonical[1], arch: canonical[2], canonical: true };
  const archived = ARCHIVE_DMG_RE.exec(name);
  if (archived) return { version: archived[1], arch: null, canonical: false };
  return null;
}

export function cargoPackageVersion(text, packageName = "supertwinv13") {
  for (const block of String(text).split(/\n(?=\[\[package\]\])/)) {
    if (!new RegExp(`^name = "${packageName}"$`, "m").test(block)) continue;
    return /^version = "(\d+\.\d+\.\d+)"$/m.exec(block)?.[1] ?? null;
  }
  return null;
}

export function manifestDigest(text, version) {
  for (const line of String(text).split("\n")) {
    const row = /^\|\s*(\d+\.\d+\.\d+)\s*\|[^|]*\|\s*`([a-f0-9]{64})`\s*\|$/i.exec(line);
    if (row?.[1] === version) return row[2].toLowerCase();
  }
  return null;
}

export function expectedReleaseDigest({ manifest, version, expectedSha = null }) {
  const supplied = expectedSha?.toLowerCase() ?? null;
  if (supplied && !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new Error("--expected-sha requires exactly 64 hexadecimal characters");
  }
  const recorded = manifestDigest(manifest, version);
  if (recorded && supplied && recorded !== supplied) {
    throw new Error(`expected SHA-256 ${supplied} disagrees with RELEASES.md ${recorded}`);
  }
  const expected = recorded ?? supplied;
  if (!expected) {
    throw new Error(
      `RELEASES.md has no completed digest for ${version}; pass --expected-sha for a just-built pending release`,
    );
  }
  return expected;
}

export function sourceVersions(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const worker = JSON.parse(readFileSync(join(root, "worker/package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  return {
    package: pkg.version,
    worker: worker.version,
    tauri: tauri.version,
    cargoToml: /^version = "(\d+\.\d+\.\d+)"$/m.exec(cargoToml)?.[1] ?? null,
    cargoLock: cargoPackageVersion(cargoLock),
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version ?? null,
    packageLockWorker: packageLock.packages?.worker?.version ?? null,
  };
}

export function assertSynchronizedVersions(versions) {
  const entries = Object.entries(versions);
  const expected = entries[0]?.[1];
  const mismatches = entries.filter(([, value]) => value !== expected);
  if (!expected || mismatches.length) {
    throw new Error(
      `version mismatch: ${entries.map(([key, value]) => `${key}=${value ?? "missing"}`).join(", ")}`,
    );
  }
  return expected;
}

export function missingBundleFiles(appPath, exists = existsSync) {
  return REQUIRED_BUNDLE_FILES.filter((rel) => !exists(join(appPath, rel)));
}

export function expectedArchitectures(dmgArch) {
  if (dmgArch === "aarch64") return ["arm64"];
  if (dmgArch === "x64") return ["x86_64"];
  if (dmgArch === "universal") return ["arm64", "x86_64"];
  return [];
}

export function nonExecutableFiles(paths, stat = statSync) {
  return paths.filter((path) => (stat(path).mode & 0o111) === 0);
}

export function architectureGaps(architecturesByFile, expected) {
  const gaps = [];
  for (const [file, architectures] of Object.entries(architecturesByFile)) {
    for (const architecture of expected) {
      if (!architectures.includes(architecture)) gaps.push(`${file}: missing ${architecture}`);
    }
  }
  return gaps;
}

export function assessDistribution({ spctlOk, signatureText, allowAdhoc }) {
  const adHoc = /Signature=adhoc/i.test(signatureText) || /TeamIdentifier=not set/i.test(signatureText);
  if (spctlOk && !adHoc) return { ready: true, localOnly: false, message: "Gatekeeper accepted" };
  const message = adHoc
    ? "ad-hoc signature: local-only build; Developer ID/notarization is not proven"
    : "Gatekeeper rejected the app; notarized distribution is not proven";
  if (!allowAdhoc) throw new Error(`${message}. Re-run with --allow-adhoc only for local testing.`);
  return { ready: false, localOnly: true, message };
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, { encoding: "utf8", ...options }).trim();
}

function newestBuiltDmg(root, version) {
  const roots = [join(root, "src-tauri/target/release/bundle/dmg")];
  const target = join(root, "src-tauri/target");
  if (existsSync(target)) {
    for (const entry of readdirSync(target)) {
      if (entry !== "release" && entry !== "debug") {
        roots.push(join(target, entry, "release/bundle/dmg"));
      }
    }
  }
  const found = roots.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => dmgMetadata(name)?.version === version)
          .map((name) => join(dir, name))
      : [],
  );
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function plistValue(plist, key) {
  return command("plutil", ["-extract", key, "raw", "-o", "-", plist]);
}

function findChromiumExecutable(appPath) {
  const chromiumRoot = join(appPath, "Contents/Resources/chromium");
  if (!existsSync(chromiumRoot)) return null;
  const stack = [chromiumRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === "Google Chrome for Testing" && path.includes("/Contents/MacOS/")) return path;
    }
  }
  return null;
}

function verifyMountedApp({ appPath, version, dmgArch, allowAdhoc }) {
  const info = join(appPath, "Contents/Info.plist");
  if (!existsSync(info)) throw new Error(`mounted image has no ${APP_NAME}.app/Contents/Info.plist`);
  const plist = {
    version: plistValue(info, "CFBundleShortVersionString"),
    buildVersion: plistValue(info, "CFBundleVersion"),
    bundleId: plistValue(info, "CFBundleIdentifier"),
    minimumMacos: plistValue(info, "LSMinimumSystemVersion"),
  };
  if (plist.version !== version || plist.buildVersion !== version) {
    throw new Error(`app plist version ${plist.version}/${plist.buildVersion} != ${version}`);
  }
  if (plist.bundleId !== BUNDLE_ID) throw new Error(`bundle id ${plist.bundleId} != ${BUNDLE_ID}`);
  if (plist.minimumMacos !== MIN_MACOS) {
    throw new Error(`minimum macOS ${plist.minimumMacos} != ${MIN_MACOS}`);
  }

  const missing = missingBundleFiles(appPath);
  if (missing.length) throw new Error(`bundle missing: ${missing.join(", ")}`);
  const chromiumExecutable = findChromiumExecutable(appPath);
  if (!chromiumExecutable) throw new Error("bundle missing Chrome for Testing executable");
  const executableEntries = [
    ...REQUIRED_EXECUTABLE_FILES.map((file) => ({ file, path: join(appPath, file) })),
    { file: "Chrome for Testing", path: chromiumExecutable },
  ];
  const notExecutable = nonExecutableFiles(executableEntries.map((entry) => entry.path));
  if (notExecutable.length) {
    throw new Error(
      `bundle files lack executable permission: ${notExecutable.map((path) => path.slice(appPath.length + 1)).join(", ")}`,
    );
  }
  const bundledWorker = JSON.parse(
    readFileSync(join(appPath, "Contents/Resources/worker/package.json"), "utf8"),
  );
  if (bundledWorker.version !== version) {
    throw new Error(`bundled worker version ${bundledWorker.version ?? "missing"} != ${version}`);
  }

  command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signatureText = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
  const spctl = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const distribution = assessDistribution({
    spctlOk: spctl.status === 0,
    signatureText,
    allowAdhoc,
  });

  const executableArchitectures = Object.fromEntries(
    executableEntries.map(({ file, path }) => [
      file,
      command("lipo", ["-archs", path]).split(/\s+/).filter(Boolean),
    ]),
  );
  const expected = expectedArchitectures(dmgArch);
  const gaps = architectureGaps(executableArchitectures, expected);
  if (gaps.length) {
    throw new Error(`DMG says ${dmgArch}, incompatible bundled executables: ${gaps.join(", ")}`);
  }
  return {
    plist,
    architectures: executableArchitectures["Contents/MacOS/supertwinv13"],
    executableArchitectures,
    distribution,
  };
}

export function parseArgs(args) {
  const allowAdhoc = args.includes("--allow-adhoc");
  const dmgIndex = args.indexOf("--dmg");
  const shaIndex = args.indexOf("--expected-sha");
  if (dmgIndex !== -1 && (!args[dmgIndex + 1] || args[dmgIndex + 1].startsWith("--"))) {
    throw new Error("--dmg requires a path");
  }
  if (shaIndex !== -1 && (!args[shaIndex + 1] || args[shaIndex + 1].startsWith("--"))) {
    throw new Error("--expected-sha requires a digest");
  }
  const unknown = args.filter((arg, index) =>
    arg !== "--allow-adhoc" &&
    arg !== "--dmg" &&
    arg !== "--expected-sha" &&
    !(dmgIndex !== -1 && index === dmgIndex + 1) &&
    !(shaIndex !== -1 && index === shaIndex + 1),
  );
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const expectedSha = shaIndex === -1 ? null : args[shaIndex + 1].toLowerCase();
  if (expectedSha && !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error("--expected-sha requires exactly 64 hexadecimal characters");
  }
  return { allowAdhoc, dmg: dmgIndex === -1 ? null : args[dmgIndex + 1], expectedSha };
}

export function verifyRelease({ root, dmg, allowAdhoc = false, expectedSha = null }) {
  if (process.platform !== "darwin") throw new Error("release verification requires macOS");
  const versions = sourceVersions(root);
  const version = assertSynchronizedVersions(versions);
  const dmgCandidate = dmg ?? newestBuiltDmg(root, version);
  if (!dmgCandidate) throw new Error(`no built DMG found for ${version}`);
  const dmgPath = resolve(dmgCandidate);
  if (!existsSync(dmgPath)) throw new Error(`DMG not found: ${dmgPath}`);
  const metadata = dmgMetadata(basename(dmgPath));
  if (!metadata) throw new Error(`unexpected DMG name: ${basename(dmgPath)}`);
  if (metadata.version !== version) throw new Error(`DMG version ${metadata.version} != ${version}`);

  command("hdiutil", ["verify", dmgPath]);
  const digest = sha256File(dmgPath);
  const expectedDigest = expectedReleaseDigest({
    manifest: readFileSync(join(root, "RELEASES.md"), "utf8"),
    version,
    expectedSha,
  });
  if (digest !== expectedDigest) throw new Error(`DMG SHA-256 ${digest} != manifest ${expectedDigest}`);

  const mount = mkdtempSync(join(tmpdir(), "supertwin-verify-"));
  let attached = false;
  try {
    command("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmgPath]);
    attached = true;
    const appPath = join(mount, `${APP_NAME}.app`);
    const app = verifyMountedApp({ appPath, version, dmgArch: metadata.arch, allowAdhoc });
    return { version, dmgPath, sha256: digest, bytes: statSync(dmgPath).size, ...app };
  } finally {
    if (attached) {
      const detached = spawnSync("hdiutil", ["detach", mount], { encoding: "utf8" });
      if (detached.status !== 0) {
        process.stderr.write(`verify-release: warning: failed to detach ${mount}: ${detached.stderr}\n`);
      }
    }
    rmSync(mount, { recursive: true, force: true });
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  try {
    const root = resolve(dirname(thisFile), "..");
    const args = parseArgs(process.argv.slice(2));
    const result = verifyRelease({
      root,
      dmg: args.dmg,
      allowAdhoc: args.allowAdhoc,
      expectedSha: args.expectedSha,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.distribution.localOnly) {
      process.stderr.write(`verify-release: LOCAL-ONLY — ${result.distribution.message}\n`);
    } else {
      process.stdout.write("verify-release: DISTRIBUTION-READY\n");
    }
  } catch (error) {
    process.stderr.write(`verify-release: FAIL — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
