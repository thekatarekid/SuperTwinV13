// ===========================================================================
// [TEST] The path helper answers in BOTH module systems (V6 P1 W1).
//
// WHY THIS FILE EXISTS. 13.11.1/13.11.2 shipped a worker that died on boot
// inside the .app:
//
//   TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type
//   string or an instance of URL. Received undefined
//       at fileURLToPath (node:internal/url)
//       at harnessRoot (…/Resources/worker/worker.cjs:39634)
//
// esbuild rewrites `import.meta` to `{}` for the CJS bundle, so
// `import.meta.url` is undefined there and `fileURLToPath` throws. Every unit
// test stayed green because under vitest `import.meta.url` exists — so the
// case that matters is the one with NO module URL, and it is asserted here
// directly rather than through whichever module system happens to run the
// suite. The end-to-end half (a real esbuild CJS bundle in a real .app layout)
// is scripts/worker-bundle.test.mjs.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cjsModuleDir, moduleDir, moduleDirOrNull, resolveModuleDir } from "./module-path.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("resolveModuleDir — the ESM half", () => {
  it("takes the module URL when there is one", () => {
    expect(resolveModuleDir("file:///Users/x/app/worker/src/settings/golden-gate.js", null)).toBe(
      "/Users/x/app/worker/src/settings",
    );
  });

  it("prefers the module URL over the CJS directory: it names the exact file", () => {
    // Under tsx the bundle directory does not exist; under a bundler the module
    // URL does not. Where both are offered the URL is the more precise answer.
    expect(resolveModuleDir("file:///repo/worker/src/media/tools.js", "/repo/worker/src")).toBe(
      "/repo/worker/src/media",
    );
  });
});

describe("resolveModuleDir — the CJS bundle half (the crash)", () => {
  it("falls back to __dirname when import.meta.url is undefined", () => {
    // Exactly the packaged app: esbuild emptied import.meta, and worker.cjs's
    // own directory is Contents/Resources/worker.
    const bundle = "/Applications/SuperTwinV13.app/Contents/Resources/worker";
    expect(resolveModuleDir(undefined, bundle)).toBe(bundle);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a bundler stub", "undefined"],
    ["an empty object stringified", "[object Object]"],
    ["a non-file scheme", "https://example.com/worker.js"],
    ["a path that is not a URL at all", "/Users/x/worker/src/settings/golden-gate.js"],
  ])("never throws on %s — it degrades to the CJS directory", (_label, metaUrl) => {
    const bundle = "/Applications/SuperTwinV13.app/Contents/Resources/worker";
    expect(() => resolveModuleDir(metaUrl, bundle)).not.toThrow();
    expect(resolveModuleDir(metaUrl, bundle)).toBe(bundle);
  });

  it("says null when neither module system offers a directory", () => {
    expect(resolveModuleDir(undefined, null)).toBeNull();
  });
});

describe("the exported wrappers", () => {
  it("moduleDir() resolves this test file's own directory", () => {
    expect(moduleDir(import.meta.url)).toBe(HERE);
    expect(moduleDirOrNull(import.meta.url)).toBe(HERE);
  });

  it("moduleDir() never throws and never returns null — cwd is the floor", () => {
    // With no module URL the answer is whatever the runtime offers; under
    // vitest that is vite-node's injected __dirname, under tsx it is
    // process.cwd(). Either way: a string, and no exception on the boot path.
    expect(() => moduleDir(undefined)).not.toThrow();
    expect(typeof moduleDir(undefined)).toBe("string");
    expect(moduleDir(undefined)).toBe(cjsModuleDir() ?? process.cwd());
  });

  it("moduleDirOrNull() keeps 'no anchor' distinguishable", () => {
    // media/tools.ts builds its resource candidate list off this: a null must
    // not silently become a cwd-anchored candidate.
    expect(moduleDirOrNull("file:///a/b/c.js")).toBe("/a/b");
    expect(resolveModuleDir(undefined, null)).toBeNull();
  });

  it("cjsModuleDir() reads __dirname without exploding under ESM", () => {
    const dir = cjsModuleDir();
    expect(dir === null || typeof dir === "string").toBe(true);
    // Whatever it is, it is never the empty string masquerading as a path.
    expect(dir).not.toBe("");
  });
});
