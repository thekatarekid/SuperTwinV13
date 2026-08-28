import { describe, expect, it } from "vitest";

import { goodFixture } from "../testutil.js";
import { registeredPasses } from "../runner.js";
import { bndExecutor, bndHookAvailable, BND_HOOK_EXPORT, BND_HOOK_MODULE, resetBndHookCache } from "./bnd.js";
import { registerProductExecutors } from "./index.js";

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
