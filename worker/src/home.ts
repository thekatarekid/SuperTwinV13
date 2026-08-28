// ===========================================================================
// SuperTwinV13 home layout (build P0.1).
//
// One module owns the identity constants of the install:
//   - homeRoot(): SUPERTWIN_HOME override, else ~/SuperTwinV13 — the same
//     precedence brainRoot()/logsDir()/resolveDbPath() use, so a single env
//     var sandboxes every piece of worker data together.
//   - DB_FILENAME / DEFAULT_WORKER_PORT: the V13 db name and port (8013 —
//     deliberately not the V11 port, so a still-running V11 never collides).
//   - ensureHomeLayout(): mkdir -p the canonical subdirs at boot
//     (media/ logs/ browser-profile/ traces/). Idempotent, called from the
//     worker entrypoint before anything opens the DB.
// ===========================================================================

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The V13 database file name, under homeRoot(). */
export const DB_FILENAME = "supertwinv13.db";

/** Default worker HTTP port (SUPERTWIN_WORKER_PORT overrides). */
export const DEFAULT_WORKER_PORT = 8013;

/** Canonical subdirectories every install has under homeRoot(). */
export const HOME_SUBDIRS = [
  "media",
  "logs",
  "browser-profile",
  "traces",
] as const;

/** Resolve the data home: SUPERTWIN_HOME override, else ~/SuperTwinV13. */
export function homeRoot(): string {
  const home = process.env.SUPERTWIN_HOME;
  if (home && home.trim().length > 0) return resolve(home);
  return resolve(join(homedir(), "SuperTwinV13"));
}

/**
 * mkdir -p the home root and its canonical subdirs. Idempotent; returns the
 * resolved home root.
 */
export function ensureHomeLayout(): string {
  const root = homeRoot();
  for (const sub of HOME_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return root;
}
