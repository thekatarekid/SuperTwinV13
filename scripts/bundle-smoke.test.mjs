// ===========================================================================
// scripts/bundle-smoke.test.mjs (V6 P1, W2) — the test that would have caught
// the 13.11.1 / 13.11.2 dead worker.
//
// The whole 3,700-test suite was green while /Applications/SuperTwinV13.app
// showed "worker unreachable" on Home and a permanent "loading…" on Settings,
// because nothing in it ever executed the artifact the DMG carries. The source
// ran fine under tsx/vitest — where `import.meta.url` exists — and died the
// moment esbuild bundled it to CommonJS, where it does not:
//
//   at fileURLToPath (node:internal/url) / at harnessRoot (worker.cjs:39634)
//   / at installCliGoldenRunnerIfAvailable / at main
//
// So this file runs scripts/bundle-worker.mjs for real, boots the real
// worker.cjs with the real staged node sidecar and the exact environment
// src-tauri sets in release, and fails LOUDLY — with the child's own stderr,
// because that stderr was the whole diagnosis — if the worker does not answer
// /api/health over a migrated database.
//
// Cost: ZERO model calls. A fresh scratch home has no consent row, so nothing
// dispatches; the run asserts the `runs` ledger is empty before it passes.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOOT_RESOURCES,
  PRODUCTION_HOME,
  PRODUCTION_PORT,
  REPO,
  RUNTIME_RESOURCES,
  assertScratchHome,
  assertSmokePort,
  freePort,
  migrationIdsFromSchema,
  parseArgs,
  parseResourceMap,
  probeWorker,
  resolveResourceSource,
  runBundleSmoke,
} from "./bundle-smoke.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(repoRoot, "src-tauri");
const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// The rails, as pure functions. These are the guards that make it safe for this
// harness — alone in the tree — to set SUPERTWIN_LAUNCHED_BY=app.
// ---------------------------------------------------------------------------

describe("rails (plan §1.3)", () => {
  it("refuses the production home, and anything outside tmpdir", () => {
    expect(() => assertScratchHome(PRODUCTION_HOME)).toThrow(/production home/);
    expect(() => assertScratchHome(join(homedir(), "SuperTwinV13"))).toThrow(/production home/);
    expect(() => assertScratchHome(join(homedir(), "elsewhere"))).toThrow(/not under/);
    expect(() => assertScratchHome("")).toThrow(/non-empty/);
    const scratch = mkdtempSync(join(tmpdir(), "bundle-smoke-rail-"));
    expect(assertScratchHome(scratch)).toBe(scratch);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("refuses port 8013 and accepts any other", () => {
    expect(PRODUCTION_PORT).toBe(8013);
    expect(() => assertSmokePort(PRODUCTION_PORT)).toThrow(/8013/);
    expect(() => assertSmokePort(0)).toThrow(/not a port/);
    expect(assertSmokePort(8113)).toBe(8113);
  });

  it("parses its own flags", () => {
    expect(parseArgs([])).toEqual({ forceBundle: false, keepHome: false, port: null });
    expect(parseArgs(["--force-bundle", "--keep-home"])).toMatchObject({ forceBundle: true, keepHome: true });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
  });
});

// ---------------------------------------------------------------------------
// The packaged layout. Pure — no boot, no 1.3 GB of staged resources needed.
// ---------------------------------------------------------------------------

describe("Contents/Resources layout", () => {
  const entries = parseResourceMap(conf);

  it("maps the worker bundle to Resources/worker (what every runtime path is relative to)", () => {
    expect(entries).toContainEqual({ src: "../worker/bundle", dest: "worker" });
  });

  it("declares every path the packaged worker resolves at runtime", () => {
    const undeclared = [];
    for (const [rel, why] of [...BOOT_RESOURCES, ...RUNTIME_RESOURCES]) {
      if (!resolveResourceSource(entries, rel, tauriDir)) undeclared.push(`${rel} (${why})`);
    }
    expect(undeclared).toEqual([]);
  });

  it("resolves a directory entry's children back to their repo source", () => {
    const hit = resolveResourceSource(entries, "worker/bin/whatsapp-go", tauriDir);
    expect(hit.src).toBe(join(repoRoot, "worker", "bundle", "bin", "whatsapp-go"));
    // A file entry beats the directory that would otherwise contain it.
    const ff = resolveResourceSource(entries, "bin/ffmpeg", tauriDir);
    expect(ff.src).toBe(join(tauriDir, "resources", "bin", "ffmpeg"));
    expect(resolveResourceSource(entries, "nothing/declares/this", tauriDir)).toBeNull();
  });

  it("stages the node sidecar Tauri declares as externalBin", () => {
    expect(conf.bundle.externalBin).toContain("binaries/node");
  });
});

describe("migration ids", () => {
  it("reads the ordered MIGRATIONS list out of worker/src/db/schema.ts", () => {
    const ids = migrationIdsFromSchema(
      readFileSync(join(repoRoot, "worker", "src", "db", "schema.ts"), "utf8"),
    );
    expect(ids.length).toBeGreaterThan(20);
    expect(ids[0]).toBe("0001_init");
    expect(new Set(ids).size).toBe(ids.length);
    // Comment-only mentions of retired ids must not be picked up as migrations.
    expect(ids).not.toContain("0004_phase2");
  });

  it("ignores prose that merely names an id", () => {
    expect(
      migrationIdsFromSchema('export const MIGRATIONS = [\n// 0004_phase2 is retired\n{ id: "0001_init", sql: X },\n]'),
    ).toEqual(["0001_init"]);
  });
});

// ---------------------------------------------------------------------------
// The failure path, deterministically.
//
// A smoke test is only worth its runtime if it fails LOUDLY and hands you the
// child's stderr — that stderr was the entire diagnosis of the shipped 13.11.1
// worker. So the failure path gets its own test, driven by a stub that dies
// exactly the way the .app's worker died: a throw out of main(), before any
// listen, with the stack on stderr and nothing on the port.
// ---------------------------------------------------------------------------

describe("a worker that dies before it listens", () => {
  it("fails with the exit code and the child's own stderr", async () => {
    const stage = mkdtempSync(join(tmpdir(), "bundle-smoke-dead-"));
    const stub = join(stage, "dead-worker.cjs");
    writeFileSync(
      stub,
      [
        'console.error("[worker] home /scratch (launched-by-app) pid 1 ppid 0");',
        'const err = new TypeError(\'The "path" argument must be of type string or an instance of URL. Received undefined\');',
        'console.error("[worker] fatal:", err.message, "\\n    at harnessRoot (worker.cjs:39634:109)");',
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    const port = await freePort();

    await expect(
      probeWorker({
        nodeBin: process.execPath,
        entry: stub,
        cwd: stage,
        env: { ...process.env },
        port,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(
      // the verdict, the exit code, and the stack the child printed
      /exited before it served \/api\/health[\s\S]*code=1[\s\S]*worker stderr[\s\S]*at harnessRoot/,
    );

    rmSync(stage, { recursive: true, force: true });
  }, 30_000);

  it("fails when the worker never answers within the deadline, and still reaps it", async () => {
    const stage = mkdtempSync(join(tmpdir(), "bundle-smoke-hung-"));
    const stub = join(stage, "hung-worker.cjs");
    // Listens on nothing, exits on SIGTERM: the "silently alive but not serving"
    // shape, which is just as fatal to the app as a crash.
    writeFileSync(
      stub,
      [
        'console.error("[worker] wedged before startServer()");',
        "setInterval(() => {}, 1000);",
        'process.on("SIGTERM", () => process.exit(0));',
      ].join("\n"),
      "utf8",
    );
    const port = await freePort();

    await expect(
      probeWorker({
        nodeBin: process.execPath,
        entry: stub,
        cwd: stage,
        env: { ...process.env },
        port,
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow(/never answered \/api\/health[\s\S]*wedged before startServer/);

    rmSync(stage, { recursive: true, force: true });
  }, 30_000);

  it("refuses to probe the app's own port before it spawns anything", async () => {
    await expect(
      probeWorker({
        nodeBin: process.execPath,
        entry: "/nonexistent.cjs",
        cwd: tmpdir(),
        env: {},
        port: PRODUCTION_PORT,
      }),
    ).rejects.toThrow(/refusing port 8013/);
  });
});

// ---------------------------------------------------------------------------
// The smoke itself: the real bundle, the real sidecar, a real HTTP surface.
// ---------------------------------------------------------------------------

describe("the bundled worker boots and serves", () => {
  it(
    "answers /api/health at the app version over a migrated DB, then exits and frees its port",
    async () => {
      const report = await runBundleSmoke({ log: (line) => console.error(`[bundle-smoke] ${line}`) });

      // The bug: main() threw before server.listen(), so this never answered.
      expect(report.version).toBe(pkg.version);
      expect(report.builtThroughPhase).toBeTruthy();
      expect(report.quotaStatus).toBe(200);

      // Migrations ran against the scratch home — every id schema.ts declares.
      expect(report.migrationsApplied).toBeGreaterThan(20);

      // Plan §1.3: never 8013, closed in the same run, and nothing spent.
      expect(report.port).not.toBe(PRODUCTION_PORT);
      expect(report.portClosed).toBe(true);
      expect(report.modelCalls).toBe(0);

      // Boot-critical resources were all present (the run throws otherwise).
      for (const [rel] of BOOT_RESOURCES) {
        expect(report.layout.find((l) => l.rel === rel)?.present).toBe(true);
      }
    },
    // Bundle (~12 s: esbuild + staged deps + go + swift + codesign) plus boot
    // (~3 s) plus teardown. Generous, but nowhere near a couple of minutes.
    240_000,
  );
});

// The smoke script must stay reachable from `npm test`, or the hole reopens.
describe("wiring", () => {
  it("is covered by npm run test:scripts, which npm test runs", () => {
    expect(pkg.scripts["test:scripts"]).toContain("scripts/vitest.config.mjs");
    expect(pkg.scripts.test).toContain("npm run test:scripts");
    const vitestConf = readFileSync(join(repoRoot, "scripts", "vitest.config.mjs"), "utf8");
    expect(vitestConf).toContain("scripts/**/*.test.mjs");
    expect(REPO).toBe(repoRoot);
  });
});
