// ===========================================================================
// [CODE] Home guard — the worker refuses to boot against the user's real home
// without an explicit signal (build V6 P1 S0.2, backlog T0-6; plan §1.3 rules
// 1 and 6).
//
// WHY. The 13.4.x incident: a worker booted by hand from a shell inherited the
// default home (`~/SuperTwinV13`), ran the real pipeline against the real
// database for nine hours, and spent real money. Nothing in the tree asked
// "are you sure?". The eval harness got its boundary in 13.4.1
// (evals/home.ts); the worker entrypoint itself never did.
//
// WHAT. Pure path predicates (lifted out of evals/home.ts, which re-exports
// them) plus one decision function and one enforcer:
//
//   homeGuardDecision(env, home)  -> { allowed, reason, dbPath }   (pure)
//   enforceHomeGuard()            -> throws HomeGuardError          (main() line 1)
//
// The rule: booting with the DB inside `~/SuperTwinV13` is allowed ONLY when
//   - the app launched us  (SUPERTWIN_LAUNCHED_BY=app, set in src-tauri/src/lib.rs), or
//   - the operator waived   (SUPERTWIN_ALLOW_PRODUCTION_HOME=1).
// Anything else — `npm run worker:live` without the waiver, `tsx src/index.ts`
// from a shell, a test that forgot SUPERTWIN_HOME — exits non-zero BEFORE the
// home layout is touched, before migrations, before any adapter spawns.
//
// A scratch home (SUPERTWIN_HOME / SUPERTWIN_DB_PATH outside the real home) is
// always allowed; that is what scripts/dev-worker.mjs sets up.
// ===========================================================================

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { resolveDbPath } from "./db/connection.js";

/** The real home directory name the installed app uses. */
export const PRODUCTION_HOME_DIRNAME = "SuperTwinV13";
/** The DB filename inside a home. Mirrors db/connection.ts / home.ts. */
export const PRODUCTION_DB_FILENAME = "supertwinv13.db";

/** The env token the Tauri shell sets on the sidecar it spawns. */
export const LAUNCHED_BY_ENV = "SUPERTWIN_LAUNCHED_BY";
export const LAUNCHED_BY_APP = "app";
/** The operator's explicit waiver for a hand-started production boot. */
export const ALLOW_PRODUCTION_HOME_ENV = "SUPERTWIN_ALLOW_PRODUCTION_HOME";

/** `~/SuperTwinV13` — the installed app's home. */
export function productionHome(home: string = homedir()): string {
  return join(home, PRODUCTION_HOME_DIRNAME);
}

/** `~/SuperTwinV13/supertwinv13.db` — the user's real database. */
export function productionDbPath(home: string = homedir()): string {
  return join(productionHome(home), PRODUCTION_DB_FILENAME);
}

/**
 * True when `dbPath` lives inside the installed app's home. Directory
 * containment, not string equality: `~/SuperTwinV13/anything.db` is still the
 * user's data, and a temp dir that merely *starts with* the same characters
 * (`~/SuperTwinV13-eval`) is not.
 */
export function isProductionDbPath(dbPath: string, home: string = homedir()): boolean {
  const root = resolve(productionHome(home));
  const p = resolve(dbPath);
  return p === root || p.startsWith(root + sep);
}

export type HomeGuardReason =
  | "scratch-home"
  | "launched-by-app"
  | "waived"
  | "production-home-unauthorised";

export interface HomeGuardDecision {
  allowed: boolean;
  reason: HomeGuardReason;
  /** The DB the worker would open. */
  dbPath: string;
}

/** The subset of the environment the decision reads. */
export interface HomeGuardEnv {
  SUPERTWIN_LAUNCHED_BY?: string;
  SUPERTWIN_ALLOW_PRODUCTION_HOME?: string;
}

/**
 * Pure decision. `dbPath` defaults to what db/connection.ts would resolve
 * from the current environment; `home` to the OS home dir. Both are
 * parameters so the rule is unit-testable without touching a filesystem.
 */
export function homeGuardDecision(
  env: HomeGuardEnv = process.env,
  dbPath: string = resolveDbPath(),
  home: string = homedir(),
): HomeGuardDecision {
  if (!isProductionDbPath(dbPath, home)) {
    return { allowed: true, reason: "scratch-home", dbPath };
  }
  if (env.SUPERTWIN_LAUNCHED_BY === LAUNCHED_BY_APP) {
    return { allowed: true, reason: "launched-by-app", dbPath };
  }
  if (env.SUPERTWIN_ALLOW_PRODUCTION_HOME === "1") {
    return { allowed: true, reason: "waived", dbPath };
  }
  return { allowed: false, reason: "production-home-unauthorised", dbPath };
}

/** Thrown by enforceHomeGuard(); main() lets it fall through to exit 1. */
export class HomeGuardError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(
      `refusing to boot against the PRODUCTION home (${dbPath}). ` +
        `A hand-started worker must run in a scratch home: use \`npm run worker\` ` +
        `(scripts/dev-worker.mjs) or set SUPERTWIN_HOME=<scratch dir> and ` +
        `SUPERTWIN_WORKER_PORT to something other than 8013. ` +
        `If you truly mean the real home, set ${ALLOW_PRODUCTION_HOME_ENV}=1 ` +
        `(the app itself sets ${LAUNCHED_BY_ENV}=${LAUNCHED_BY_APP}).`,
    );
    this.name = "HomeGuardError";
    this.dbPath = dbPath;
  }
}

/**
 * The enforcer — the first statement of the worker's main(). Throws before
 * anything else runs; the entrypoint's fatal handler turns that into a
 * non-zero exit. Returns the decision so the boot log can name why it passed.
 */
export function enforceHomeGuard(): HomeGuardDecision {
  const decision = homeGuardDecision();
  if (!decision.allowed) throw new HomeGuardError(decision.dbPath);
  return decision;
}
