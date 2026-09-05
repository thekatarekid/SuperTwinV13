// ===========================================================================
// Home guard (S0.2, T0-6): a bare boot against ~/SuperTwinV13 is refused; the
// app token and the operator waiver let it through; a scratch home always
// boots. Pure decisions first, then the enforcer against the real env.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  ALLOW_PRODUCTION_HOME_ENV,
  HomeGuardError,
  LAUNCHED_BY_ENV,
  enforceHomeGuard,
  homeGuardDecision,
  isProductionDbPath,
  productionDbPath,
  productionHome,
} from "./home-guard.js";
import { isProductionDbPath as viaEvals, productionHome as evalsHome } from "./evals/home.js";

const FAKE_HOME = "/Users/someone";
const PROD_DB = productionDbPath(FAKE_HOME);

const KEYS = ["SUPERTWIN_HOME", "SUPERTWIN_DB_PATH", LAUNCHED_BY_ENV, ALLOW_PRODUCTION_HOME_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("path predicates (lifted from evals/home.ts)", () => {
  it("names the real home and DB", () => {
    expect(productionHome(FAKE_HOME)).toBe(join(FAKE_HOME, "SuperTwinV13"));
    expect(PROD_DB).toBe(join(FAKE_HOME, "SuperTwinV13", "supertwinv13.db"));
  });
  it("is directory containment, not a prefix match", () => {
    expect(isProductionDbPath(PROD_DB, FAKE_HOME)).toBe(true);
    expect(isProductionDbPath(join(FAKE_HOME, "SuperTwinV13", "sub", "x.db"), FAKE_HOME)).toBe(true);
    expect(isProductionDbPath(join(FAKE_HOME, "SuperTwinV13-eval", "x.db"), FAKE_HOME)).toBe(false);
    expect(isProductionDbPath("/tmp/supertwin-dev-home-abc/supertwinv13.db", FAKE_HOME)).toBe(false);
  });
  it("evals/home.ts re-exports the same functions", () => {
    expect(viaEvals).toBe(isProductionDbPath);
    expect(evalsHome).toBe(productionHome);
  });
});

describe("homeGuardDecision", () => {
  it("a scratch home always boots", () => {
    const d = homeGuardDecision({}, "/tmp/scratch/supertwinv13.db", FAKE_HOME);
    expect(d).toMatchObject({ allowed: true, reason: "scratch-home" });
  });
  it("a bare boot against the production home is refused", () => {
    const d = homeGuardDecision({}, PROD_DB, FAKE_HOME);
    expect(d).toMatchObject({ allowed: false, reason: "production-home-unauthorised", dbPath: PROD_DB });
  });
  it("the app token boots", () => {
    const d = homeGuardDecision({ SUPERTWIN_LAUNCHED_BY: "app" }, PROD_DB, FAKE_HOME);
    expect(d).toMatchObject({ allowed: true, reason: "launched-by-app" });
  });
  it("the operator waiver boots", () => {
    const d = homeGuardDecision({ SUPERTWIN_ALLOW_PRODUCTION_HOME: "1" }, PROD_DB, FAKE_HOME);
    expect(d).toMatchObject({ allowed: true, reason: "waived" });
  });
  it("other tokens do not count", () => {
    expect(homeGuardDecision({ SUPERTWIN_LAUNCHED_BY: "shell" }, PROD_DB, FAKE_HOME).allowed).toBe(false);
    expect(homeGuardDecision({ SUPERTWIN_ALLOW_PRODUCTION_HOME: "yes" }, PROD_DB, FAKE_HOME).allowed).toBe(false);
    expect(homeGuardDecision({ SUPERTWIN_ALLOW_PRODUCTION_HOME: "0" }, PROD_DB, FAKE_HOME).allowed).toBe(false);
  });
});

describe("enforceHomeGuard (real env, real home)", () => {
  it("throws HomeGuardError on a bare production boot — the entrypoint exits non-zero", () => {
    // Nothing configured: resolveDbPath() falls through to ~/SuperTwinV13.
    expect(() => enforceHomeGuard()).toThrow(HomeGuardError);
    try {
      enforceHomeGuard();
    } catch (err) {
      expect((err as HomeGuardError).message).toContain("npm run worker");
      expect((err as HomeGuardError).message).toContain(ALLOW_PRODUCTION_HOME_ENV);
      expect((err as HomeGuardError).dbPath).toBe(productionDbPath());
    }
  });
  it("passes with SUPERTWIN_LAUNCHED_BY=app", () => {
    process.env[LAUNCHED_BY_ENV] = "app";
    expect(enforceHomeGuard().reason).toBe("launched-by-app");
  });
  it("passes with the waiver", () => {
    process.env[ALLOW_PRODUCTION_HOME_ENV] = "1";
    expect(enforceHomeGuard().reason).toBe("waived");
  });
  it("passes with a scratch SUPERTWIN_HOME", () => {
    process.env.SUPERTWIN_HOME = "/tmp/supertwin-scratch-home";
    expect(enforceHomeGuard().reason).toBe("scratch-home");
  });
});
