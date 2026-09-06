// ===========================================================================
// [CODE] Where a module sits on disk — in BOTH module systems (V6 P1 W1).
//
// The worker runs in two shapes and only one of them has `import.meta`:
//
//   * dev / tests — real ESM through tsx or vitest. `import.meta.url` is a
//     file: URL for THIS source file.
//   * the packaged app — one CommonJS file, `worker/bundle/worker.cjs`, built
//     by scripts/bundle-worker.mjs. esbuild rewrites every `import.meta` to an
//     empty object there, so `import.meta.url` is `undefined` and
//     `fileURLToPath(undefined)` THROWS `ERR_INVALID_ARG_TYPE`. CJS instead
//     gives the bundle its own `__dirname` (Contents/Resources/worker), which
//     is the anchor every packaged resource lookup actually wants.
//
// 13.11.1/13.11.2 shipped with `harnessRoot()` calling
// `fileURLToPath(import.meta.url)` unguarded on the boot path: it threw inside
// the .app before the HTTP server ever listened, so every screen said "worker
// unreachable" while the whole test suite stayed green — because under vitest
// `import.meta.url` exists. This module is the one answer to that question, so
// no call site has to remember which shape it is running in:
//
//     import { moduleDir } from "../module-path.js";
//     const here = moduleDir(import.meta.url);   // never throws, never null
//
// `import.meta.url` at a call site is fine — passing `undefined` is the
// bundle's normal case and is handled here. What is NOT fine is calling
// `fileURLToPath` / `new URL()` on it directly; scripts/worker-bundle.test.mjs
// fails the build if that comes back anywhere in the bundled graph.
// ===========================================================================

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory of the CommonJS module this code was compiled into, or null
 * under ESM. In the packaged app that is worker.cjs's own directory; under
 * tsx it is null; under vitest it is the source file's directory (vite-node
 * defines `__dirname` as well as `import.meta`).
 *
 * `typeof` on a possibly-undeclared identifier is safe in every module system.
 */
export function cjsModuleDir(): string | null {
  const dir = typeof __dirname === "string" ? __dirname : "";
  return dir.length > 0 ? dir : null;
}

/**
 * The pure decision, with both inputs handed in — the half worth unit-testing
 * under both module systems without a bundler.
 *
 * `metaUrl` wins when it is a usable file: URL (ESM: the exact source file).
 * Anything else — undefined (the CJS bundle), "", a non-file scheme, a
 * malformed URL — falls back to the CJS directory, and null says "neither
 * module system offered one" rather than throwing.
 */
export function resolveModuleDir(
  metaUrl: string | null | undefined,
  cjsDir: string | null,
): string | null {
  if (typeof metaUrl === "string" && metaUrl.length > 0) {
    try {
      return dirname(fileURLToPath(metaUrl));
    } catch {
      // Not a file: URL — a bundler stub, a data:/https: URL. Fall through
      // rather than take the process down from inside a boot path.
    }
  }
  return cjsDir;
}

/**
 * This module's directory, or null when neither module system offers one.
 * Callers that must distinguish "no anchor" from "some directory" (resource
 * candidate lists, for instance) want this one.
 */
export function moduleDirOrNull(metaUrl: string | null | undefined): string | null {
  return resolveModuleDir(metaUrl, cjsModuleDir());
}

/**
 * This module's directory, with `process.cwd()` as the last resort. Never
 * throws and never returns null — the shape a path lookup on the boot path
 * should have.
 */
export function moduleDir(metaUrl: string | null | undefined): string {
  return moduleDirOrNull(metaUrl) ?? process.cwd();
}
