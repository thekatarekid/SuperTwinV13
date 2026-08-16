// ===========================================================================
// Brain FOLDER tests: root resolution, layout, git-init idempotency, and the
// traversal-guarded GET /api/brain/file debug-export route.
//
// The markdown writers this file used to cover are gone (V2 §3.2) along with
// brain-template/ — which is why the layout assertions matter more than they
// did: there is no template to copy any more, so the programmatic seed is the
// only thing standing between a fresh install and a brain root that is not
// there when a grounded run is handed it as its cwd.
//
// Each test points SUPERTWIN_BRAIN_DIR at a fresh temp dir.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainRoot,
  commitBrain,
  ensureBrain,
  handleBrainRoute,
  resetBrainCacheForTests,
} from "./index.js";

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-brain-test-"));
  process.env.SUPERTWIN_BRAIN_DIR = join(tmpDir, "brain");
  resetBrainCacheForTests();
});

afterEach(() => {
  delete process.env.SUPERTWIN_BRAIN_DIR;
  resetBrainCacheForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- root: layout + git ------------------------------------------------------

describe("brain root", () => {
  it("brainRoot honors SUPERTWIN_BRAIN_DIR", () => {
    expect(brainRoot()).toBe(join(tmpDir, "brain"));
  });

  it("ensureBrain lays out the folder with no template on disk", () => {
    // brain-template/ was deleted with the markdown brain; the layout below is
    // created outright, so this is the whole seed path now.
    const root = ensureBrain();
    for (const dir of ["spaces", "people", "workflows", "habits", "me", join("me", "procedures")]) {
      expect(existsSync(join(root, dir)), `missing ${dir}`).toBe(true);
    }
    expect(existsSync(join(root, "me", "preferences.md"))).toBe(true);
    expect(existsSync(join(root, "me", "goals.md"))).toBe(true);
  });

  it("git init is idempotent and commitBrain never throws", () => {
    const root = ensureBrain();
    resetBrainCacheForTests();
    expect(() => ensureBrain()).not.toThrow(); // second seed pass is a no-op
    if (gitAvailable) {
      expect(existsSync(join(root, ".git"))).toBe(true);
      writeFileSync(join(root, "people", "x.md"), "# X\n", "utf8");
      expect(commitBrain("test commit")).toBe(true);
      // Nothing new to commit -> false, but no throw.
      expect(commitBrain("empty commit")).toBe(false);
    } else {
      expect(() => commitBrain("no git")).not.toThrow();
    }
  });
});

// ---- GET /api/brain/file (traversal-guarded debug export) ---------------------
//
// Mounted only when settings.debug_export is on (server/index.ts). The handler
// itself is unconditional, so what is tested here is the guard it does own: a
// path that escapes the brain root must never be served.

describe("GET /api/brain/file", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      handleBrainRoute(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns { path, content } for a file inside the brain root", async () => {
    const root = ensureBrain();
    writeFileSync(join(root, "me", "notes.md"), "# Notes\n", "utf8");
    const res = await fetch(
      `${base}/api/brain/file?path=${encodeURIComponent("me/notes.md")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe("me/notes.md");
    expect(body.content).toContain("# Notes");
  });

  it("400s on a missing path param", async () => {
    const res = await fetch(`${base}/api/brain/file`);
    expect(res.status).toBe(400);
  });

  it("403s on path traversal outside the brain root", async () => {
    ensureBrain();
    writeFileSync(join(tmpDir, "secret.txt"), "outside", "utf8");
    for (const evil of ["../secret.txt", "spaces/../../secret.txt", ".."]) {
      const res = await fetch(`${base}/api/brain/file?path=${encodeURIComponent(evil)}`);
      expect(res.status, `path=${evil}`).toBe(403);
    }
    // Encoded-slash variant must never leak the file either (it resolves to a
    // literal filename inside the root -> 404, not the outside file).
    const enc = await fetch(`${base}/api/brain/file?path=..%252Fsecret.txt`);
    expect(enc.status).not.toBe(200);
  });

  it("404s on a missing file and on a directory", async () => {
    ensureBrain();
    expect((await fetch(`${base}/api/brain/file?path=spaces/nope.md`)).status).toBe(404);
    expect((await fetch(`${base}/api/brain/file?path=spaces`)).status).toBe(404);
  });
});
