// ===========================================================================
// Brain root: locate ~/SuperTwinV11/brain, lay it out, git-init it, and
// best-effort commit changes.
//
// This is what survived the markdown brain (V2 §3.2). Nothing writes wiki pages
// here any more; the folder is kept because it is the cwd a grounded run is
// given and the destination of the DEBUG EXPORT — the only path allowed to put
// message text on disk, and only when `settings.debug_export` is on.
//
//   - brainRoot(): SUPERTWIN_BRAIN_DIR override (tests), else
//     SUPERTWIN_HOME/brain, else ~/SuperTwinV11/brain (mirrors mediaRoot()).
//   - ensureBrain(): idempotent layout + `git init` + initial commit. The layout
//     is created programmatically; the repo's brain-template/ is gone, so there
//     is nothing to copy and nothing to go missing in the bundled worker.
//   - commitBrain(): `git add -A && git commit` — best-effort, NEVER throws
//     (git missing / nothing to change / no repo are all fine).
// ===========================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Roots already seeded+git-initialized this process (keyed by resolved path). */
const readyRoots = new Set<string>();

/** Resolve the brain directory: SUPERTWIN_BRAIN_DIR override, else HOME/brain. */
export function brainRoot(): string {
  const override = process.env.SUPERTWIN_BRAIN_DIR;
  if (override && override.trim().length > 0) return resolve(override);
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV11");
  return resolve(join(home, "brain"));
}

/** The canonical layout every brain has. */
const LAYOUT_DIRS = [
  "spaces",
  "people",
  "workflows",
  "habits",
  "me",
  join("me", "procedures"),
];

const ME_SEEDS: Record<string, string> = {
  [join("me", "preferences.md")]:
    "---\ntype: preferences\nstatus: active\n---\n\n# Preferences\n\n" +
    "Feedback-derived rules and personal defaults. One bullet per preference,\n" +
    "with an `evt:<id>` source link when observed rather than stated.\n\n" +
    "<!-- st:begin:preferences -->\n<!-- st:end:preferences -->\n",
  [join("me", "goals.md")]:
    "---\ntype: goals\nstatus: active\n---\n\n# Goals\n\n" +
    "Top-level personal goals (spaces link back here with [[wikilinks]]).\n",
};

/** Run git in `cwd`; returns true on exit 0. Never throws (git may be absent). */
function git(cwd: string, ...args: string[]): boolean {
  try {
    const r = spawnSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        // Never block on identity config; commits always have an author.
        GIT_AUTHOR_NAME: "SuperTwinV11",
        GIT_AUTHOR_EMAIL: "supertwin@localhost",
        GIT_COMMITTER_NAME: "SuperTwinV11",
        GIT_COMMITTER_EMAIL: "supertwin@localhost",
      },
      timeout: 10_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the brain directory exists, is seeded, and is a git repo. Idempotent
 * and cheap after the first call per root. Returns the resolved root path.
 */
export function ensureBrain(): string {
  const root = brainRoot();
  if (readyRoots.has(root)) return root;

  mkdirSync(root, { recursive: true });

  // ---- The canonical layout, created outright. There is no template to copy.
  for (const dir of LAYOUT_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [rel, content] of Object.entries(ME_SEEDS)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) writeFileSync(abs, content, "utf8");
  }

  // ---- git init + initial commit (skip gracefully if git is missing).
  if (!existsSync(join(root, ".git"))) {
    if (git(root, "init")) {
      git(root, "add", "-A");
      git(root, "commit", "-m", "brain: initial scaffold");
    } else {
      console.error("[brain] git unavailable — history disabled (files still written)");
    }
  }

  readyRoots.add(root);
  return root;
}

/**
 * Best-effort commit of all pending brain changes. Never throws; returns true
 * only when a commit was actually created (false covers: git missing, not a
 * repo, nothing to commit).
 */
export function commitBrain(message: string): boolean {
  try {
    const root = ensureBrain();
    if (!existsSync(join(root, ".git"))) return false;
    if (!git(root, "add", "-A")) return false;
    return git(root, "commit", "-m", message);
  } catch {
    return false;
  }
}

/** Test hook: forget seeded roots so a new SUPERTWIN_BRAIN_DIR re-seeds. */
export function resetBrainCacheForTests(): void {
  readyRoots.clear();
}
