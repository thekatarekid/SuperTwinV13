import { beforeEach, describe, expect, it } from "vitest";

import { bootstrapBuiltInProviders } from "./bootstrap.js";
import {
  get,
  getV2,
  list,
  listV2,
  resetProviderRegistryForTests,
} from "./registry.js";

beforeEach(resetProviderRegistryForTests);

describe("built-in provider bootstrap", () => {
  it("registers both Claude facades once under the same identity", () => {
    const facades = bootstrapBuiltInProviders();
    expect(facades.legacy.id).toBe("claude-local");
    expect(facades.v2.id).toBe("claude-local");
    expect(get("claude-local")).toBe(facades.legacy);
    expect(getV2("claude-local")).toBe(facades.v2);
    expect(list()).toEqual([facades.legacy]);
    expect(listV2()).toEqual([facades.v2]);
    expect(Object.isFrozen(facades)).toBe(true);
  });

  it("is idempotent and never duplicates shutdown registry entries", () => {
    const first = bootstrapBuiltInProviders();
    const second = bootstrapBuiltInProviders();
    expect(second.legacy).toBe(first.legacy);
    expect(second.v2).toBe(first.v2);
    expect(list()).toHaveLength(1);
    expect(listV2()).toHaveLength(1);
  });
});
