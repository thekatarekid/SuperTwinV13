// ===========================================================================
// [TEST] The worker survives being a CommonJS bundle (V6 P1 W1).
//
// WHY THIS FILE EXISTS. 13.11.1 and 13.11.2 were installed, launched, and said
// "worker unreachable" on every screen. ~/SuperTwinV13/worker.log:
//
//   [worker] fatal: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must
//   be of type string or an instance of URL. Received undefined
//       at fileURLToPath (node:internal/url:1649:11)
//       at harnessRoot (…/Resources/worker/worker.cjs:39634:109)
//       at installCliGoldenRunnerIfAvailable (…worker.cjs:39693:29)
//       at main (…worker.cjs:52623:29)
//
// esbuild rewrites `import.meta` to `{}` for the CJS bundle, so
// `import.meta.url` is undefined there and `fileURLToPath` throws. The 3,700
// tests were all green: under vitest and tsx `import.meta.url` exists, so the
// whole suite tested the one shape that could not fail.
//
// So this file tests the OTHER shape, the way stage-media-tools.test.mjs does:
// a REAL esbuild CJS bundle, laid out the way Tauri lays it out
// (Contents/Resources/worker/worker.cjs), run from a cwd somewhere else
// entirely. Plus the source-level rail — no module in the bundled graph may
// call fileURLToPath/new URL on `import.meta.url` again.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_ENTRY = join(repoRoot, "worker", "src", "index.ts");

/** The .app ships better-sqlite3 beside worker.cjs; nothing here is about the DB. */
function stubNativeDeps(workerDir) {
  const stub = join(workerDir, "node_modules", "better-sqlite3");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "package.json"),
    JSON.stringify({ name: "better-sqlite3", main: "index.cjs" }),
  );
  writeFileSync(join(stub, "index.cjs"), "module.exports = class {};\n");
}

/**
 * Bundle `source` as the packaged worker would be bundled, drop it at
 * Contents/Resources/worker/worker.cjs, and run it from an unrelated cwd.
 * Returns whatever the probe printed as JSON.
 */
async function packagedProbe(root, source) {
  const resources = join(root, "Contents", "Resources");
  const workerDir = join(resources, "worker");
  mkdirSync(workerDir, { recursive: true });
  stubNativeDeps(workerDir);

  // The daemon and the sidecar ship INSIDE the worker bundle dir
  // (scripts/bundle-worker.mjs steps 5 and 6).
  mkdirSync(join(workerDir, "bin"), { recursive: true });
  writeFileSync(join(workerDir, "bin", "whatsapp-go"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(workerDir, "bin", "screenwatch"), "#!/bin/sh\n", { mode: 0o755 });

  await build({
    stdin: { contents: source, resolveDir: repoRoot, loader: "ts" },
    outfile: join(workerDir, "worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["better-sqlite3"],
    logLevel: "silent",
  });

  // Somewhere else entirely: not the repo, not the .app. The packaged app
  // happens to chdir into the worker dir today — a resolution that only works
  // because of that is one `current_dir` edit away from being broken again.
  const elsewhere = mkdtempSync(join(tmpdir(), "st-cwd-"));
  const res = spawnSync(process.execPath, [join(workerDir, "worker.cjs")], {
    cwd: elsewhere,
    encoding: "utf8",
    env: {
      ...process.env,
      SUPERTWIN_HOME: join(root, "home"),
      // Not the repo's: the probe must not accidentally find real binaries.
      SUPERTWIN_WHATSAPP_BIN: "",
      SUPERTWIN_SCREENWATCH_BIN: "",
    },
  });
  rmSync(elsewhere, { recursive: true, force: true });
  if (res.status !== 0) {
    throw new Error(`probe exited ${res.status}: ${res.stderr || res.stdout}`);
  }
  return { ...JSON.parse(res.stdout), resources, workerDir };
}

describe("the boot path inside a CJS bundle", () => {
  // The exact call chain from the crash log, plus every other module-anchored
  // lookup that runs during boot. Each one used to answer with either a throw
  // or process.cwd().
  const PROBE = `
    import { harnessPresent, harnessRoot, goldenRunnerInstalled, installCliGoldenRunnerIfAvailable } from "./worker/src/settings/golden-gate.js";
    import { resolveWhatsAppBin } from "./worker/src/adapters/whatsapp/adapter.js";
    import { resolveScreenwatchBin } from "./worker/src/adapters/screen/adapter.js";
    import { resourceCandidates } from "./worker/src/media/tools.js";
    import { moduleDir } from "./worker/src/module-path.js";

    const note = installCliGoldenRunnerIfAvailable({});
    console.log(JSON.stringify({
      cwd: process.cwd(),
      moduleDir: moduleDir(import.meta.url),
      harnessRoot: harnessRoot(),
      harnessPresent: harnessPresent(),
      note,
      runnerInstalled: goldenRunnerInstalled(),
      whatsapp: resolveWhatsAppBin(),
      screenwatch: resolveScreenwatchBin(),
      ffmpegCandidates: resourceCandidates("bin", "ffmpeg"),
    }));
  `;

  it("boots the golden gate instead of dying on it, and resolves off the bundle", async () => {
    // realpath: node resolves the module's own directory through /var's symlink.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "st-app-")));
    try {
      const out = await packagedProbe(root, PROBE);

      // The bundle is the anchor — not the cwd, which is a temp dir far away.
      expect(out.cwd).not.toContain(root);
      expect(out.moduleDir).toBe(out.workerDir);

      // harnessRoot() is what threw. It answers, and answers off the bundle.
      expect(out.harnessRoot).toBe(resolve(out.workerDir, "..", "..", ".."));
      expect(out.harnessPresent).toBe(false);

      // ...so the packaged app installs no runner and says why — the behaviour
      // the module always documented and never reached inside a .app.
      expect(out.runnerInstalled).toBe(false);
      expect(out.note).toMatch(/eval harness not found/);

      // The daemon and the sidecar are found beside worker.cjs, cwd elsewhere.
      expect(out.whatsapp).toEqual({ bin: join(out.workerDir, "bin", "whatsapp-go"), found: true });
      expect(out.screenwatch).toEqual({ bin: join(out.workerDir, "bin", "screenwatch"), found: true });

      // Contents/Resources/bin/ffmpeg, one hop up from the worker dir.
      expect(out.ffmpegCandidates).toContain(join(out.resources, "bin", "ffmpeg"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps answering when the .app is somewhere unusual", async () => {
    // The negative control for "it only worked because the path looked right":
    // a second layout, same assertions about where the answers come from.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "st app with spaces-")));
    try {
      const out = await packagedProbe(root, PROBE);
      expect(out.moduleDir).toBe(out.workerDir);
      expect(out.harnessPresent).toBe(false);
      expect(out.whatsapp.found).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("the bundled graph never touches import.meta directly", () => {
  // The rail. `import.meta.url` at a call site is fine — it is undefined in the
  // bundle and module-path.ts handles that. Handing it to fileURLToPath or
  // new URL() is the bug, and it is invisible in every ESM test.
  const FORBIDDEN = [
    [/fileURLToPath\(\s*import\.meta\.url/, "fileURLToPath(import.meta.url)"],
    [/new URL\(\s*import\.meta\.url/, "new URL(import.meta.url)"],
    [/import\.meta\.dirname/, "import.meta.dirname"],
    [/import\.meta\.resolve/, "import.meta.resolve"],
  ];

  it("no module esbuild pulls into worker.cjs resolves a path off import.meta", async () => {
    const res = await build({
      entryPoints: [WORKER_ENTRY],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["better-sqlite3"],
      metafile: true,
      write: false,
      logLevel: "silent",
    });

    const offenders = [];
    for (const input of Object.keys(res.metafile.inputs)) {
      if (!input.endsWith(".ts") || input.includes("node_modules")) continue;
      const source = readFileSync(join(repoRoot, input), "utf8");
      for (const [pattern, label] of FORBIDDEN) {
        // The comment blocks in module-path.ts and its callers explain the very
        // thing being banned, so only real code counts.
        const code = source
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        if (pattern.test(code)) offenders.push(`${input}: ${label}`);
      }
    }

    expect(offenders, "use moduleDir(import.meta.url) from worker/src/module-path.ts instead").toEqual([]);
  }, 120_000);

  it("still bundles the entrypoint at all (the graph above is not empty)", async () => {
    const res = await build({
      entryPoints: [WORKER_ENTRY],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["better-sqlite3"],
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const workerInputs = Object.keys(res.metafile.inputs).filter((f) => f.startsWith("worker/src/"));
    expect(workerInputs.length).toBeGreaterThan(100);
    expect(workerInputs).toContain("worker/src/settings/golden-gate.ts");
    expect(workerInputs).toContain("worker/src/module-path.ts");
  }, 120_000);
});
