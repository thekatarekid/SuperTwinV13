// ===========================================================================
// [CODE] Eval home isolation — the containment boundary the golden harness
// was missing (defect fix, shipped 13.4.1).
//
// WHAT WENT WRONG. Every eval executor reaches for `getDb()`, and
// `resolveDbPath()` (db/connection.ts) falls through to the REAL home:
//   SUPERTWIN_DB_PATH -> SUPERTWIN_HOME/supertwinv13.db -> ~/SuperTwinV13/…
// `npm run eval` set neither variable, so the fixture seeds in
// executors/assist.ts, executors/p3.ts, executors/passes.ts and most of
// executors/p4.ts were written straight into the user's production database.
// The harness's answer to that was "seeds are eval-prefixed rows in the same
// DB the product uses, cleaned up afterwards" — but cleanup-after is not a
// boundary: it does not run when a case throws, when the process is killed,
// or over rows the seed never knew it produced (episodes, decisions, tasks
// derived downstream). 181 fixture events reached a real user's Timeline.
//
// WHAT THIS MODULE DOES. It makes the leak structurally impossible instead of
// conventionally discouraged:
//
//   establishEvalHome()      mints a throwaway SUPERTWIN_HOME (temp dir) when
//                            nothing is configured, so the default `npm run
//                            eval` CANNOT resolve to the production DB; it
//                            THROWS when the environment points at the real
//                            home and no explicit override was passed.
//   assertEvalDbIsolated()   the chokepoint assertion — called from
//                            registerProductExecutors(), so wiring the
//                            DB-touching eval executors while pointed at the
//                            production DB throws with a named remedy. A
//                            future refactor that drops the CLI call still
//                            trips this one.
//
// Pure path predicates live here too so the rule is unit-testable without
// touching anyone's filesystem.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { closeDb, resolveDbPath } from "../db/connection.js";
import {
  PRODUCTION_DB_FILENAME,
  isProductionDbPath,
  productionHome,
} from "../home-guard.js";

// The path predicates were lifted into worker/src/home-guard.ts (S0.2) so the
// worker entrypoint enforces the same boundary the harness does. Re-exported
// here so existing importers keep one module.
export {
  PRODUCTION_DB_FILENAME,
  PRODUCTION_HOME_DIRNAME,
  isProductionDbPath,
  productionDbPath,
  productionHome,
} from "../home-guard.js";

/** The flag that knowingly waives the boundary. Named in every error. */
export const ALLOW_PRODUCTION_FLAG = "--allow-production-home";

/** Thrown when the eval harness would have written to the user's real data. */
export class EvalHomeLeakError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string, what: string) {
    super(
      `${what} resolves to the PRODUCTION database (${dbPath}). ` +
        `Eval fixtures must never be written to a real home. ` +
        `Set SUPERTWIN_HOME to a scratch directory, or pass ${ALLOW_PRODUCTION_FLAG} ` +
        `if you truly intend to seed fixture data into your own SuperTwin.`,
    );
    this.name = "EvalHomeLeakError";
    this.dbPath = dbPath;
  }
}

/**
 * Set once by establishEvalHome() when the operator explicitly waived the
 * boundary, so the downstream chokepoint (assertEvalDbIsolated) honours the
 * same decision instead of re-asking.
 */
let productionHomeWaived = false;

/** Test seam: forget any waiver recorded by a previous establishEvalHome(). */
export function resetProductionHomeWaiver(): void {
  productionHomeWaived = false;
}

/**
 * The chokepoint. Throws unless the DB the worker would open right now is
 * outside the user's real home (or the waiver was explicitly granted).
 *
 * Called from registerProductExecutors(): every path that wires the
 * DB-touching eval executors — the CLI, a future runner, a unit test — must
 * pass through here first.
 */
export function assertEvalDbIsolated(what = "the eval harness"): void {
  if (productionHomeWaived) return;
  const dbPath = resolveDbPath();
  if (isProductionDbPath(dbPath)) throw new EvalHomeLeakError(dbPath, what);
}

export interface EvalHome {
  /** The database the run will use. Never inside the production home. */
  dbPath: string;
  /** The home directory backing it (db + brain + media all sandbox together). */
  home: string;
  /** True when this call minted a throwaway home that dispose() will delete. */
  ephemeral: boolean;
  /** True when the operator waived the boundary and this IS the real home. */
  production: boolean;
  /** Restore the environment (and delete the temp home, if we made one). */
  dispose(): void;
}

/**
 * Point the worker's data root somewhere the harness may safely write, and
 * refuse to run otherwise.
 *
 *   nothing configured        -> mint a temp SUPERTWIN_HOME for this run
 *   configured, non-production-> use it as-is
 *   configured to the real home (or falling through to it) with the override
 *                             -> use it, flagged `production: true`
 *   configured to the real home without the override
 *                             -> throw EvalHomeLeakError
 *
 * The returned handle MUST be disposed (the CLI does it in a finally) so a
 * long-lived process — vitest, a dev server — does not inherit the sandbox.
 */
export function establishEvalHome(opts: { allowProductionHome?: boolean } = {}): EvalHome {
  const prevHome = process.env.SUPERTWIN_HOME;
  const prevDbPath = process.env.SUPERTWIN_DB_PATH;
  const configured = resolveDbPath();

  if (!isProductionDbPath(configured)) {
    // The operator already sandboxed us (SUPERTWIN_HOME / SUPERTWIN_DB_PATH).
    productionHomeWaived = false;
    return {
      dbPath: configured,
      home: prevHome ?? dirname(configured),
      ephemeral: false,
      production: false,
      dispose: () => {},
    };
  }

  if (opts.allowProductionHome) {
    productionHomeWaived = true;
    return {
      dbPath: configured,
      home: prevHome ?? productionHome(),
      ephemeral: false,
      production: true,
      dispose: () => {
        productionHomeWaived = false;
      },
    };
  }

  // An EXPLICIT pointer at the real home is an operator mistake worth naming
  // out loud; an unset environment is just the default, and gets sandboxed.
  const explicit =
    (prevHome !== undefined && prevHome.trim().length > 0) ||
    (prevDbPath !== undefined && prevDbPath.trim().length > 0);
  if (explicit) throw new EvalHomeLeakError(configured, "SUPERTWIN_HOME/SUPERTWIN_DB_PATH");

  const home = mkdtempSync(join(tmpdir(), "supertwin-eval-home-"));
  const dbPath = join(home, PRODUCTION_DB_FILENAME);
  process.env.SUPERTWIN_HOME = home;
  process.env.SUPERTWIN_DB_PATH = dbPath;
  productionHomeWaived = false;
  // Drop any handle memoized against the old (production) path.
  closeDb();

  return {
    dbPath,
    home,
    ephemeral: true,
    production: false,
    dispose: () => {
      closeDb();
      if (prevHome === undefined) delete process.env.SUPERTWIN_HOME;
      else process.env.SUPERTWIN_HOME = prevHome;
      if (prevDbPath === undefined) delete process.env.SUPERTWIN_DB_PATH;
      else process.env.SUPERTWIN_DB_PATH = prevDbPath;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
