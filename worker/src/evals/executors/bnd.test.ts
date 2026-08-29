import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../../db/connection.js";
import { goodFixture } from "../testutil.js";
import { registeredPasses } from "../runner.js";
import { bndExecutor, bndHookAvailable, BND_HOOK_EXPORT, BND_HOOK_MODULE, resetBndHookCache } from "./bnd.js";
import { registerProductExecutors } from "./index.js";

// registerProductExecutors() refuses to wire the DB-touching executors while
// the resolved DB is the user's real home (evals/home.ts). Sandbox this suite
// the way the CLI sandboxes a run.
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bndexec-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const bndFixture = () =>
  goodFixture({ id: "BND-01", category: "BND", pass: "scheduler.dispatch", mode: "code" });

describe("BND executor seam (P0.5 lands the other side)", () => {
  it("names the contract: scheduler/eval-hooks.js must export runBndCase", () => {
    expect(BND_HOOK_MODULE).toBe("../../scheduler/eval-hooks.js");
    expect(BND_HOOK_EXPORT).toBe("runBndCase");
  });

  it("registers scheduler.dispatch only when the hook exists — pending, not fail, until then", async () => {
    resetBndHookCache();
    const available = await bndHookAvailable();
    await registerProductExecutors();
    const passes = registeredPasses();
    expect(passes).toContain("selftest.stub");
    expect(passes.includes("scheduler.dispatch")).toBe(available);
    if (!available) {
      // The executor itself, if forced, says exactly what is missing.
      await expect(bndExecutor({ fixture: bndFixture() })).rejects.toThrow(/scheduler eval hook missing/);
    } else {
      // The scheduler landed its hook: BND cases run the real dispatcher.
      const result = await bndExecutor({ fixture: bndFixture() });
      expect(typeof result.ok).toBe("boolean");
    }
  });
});
