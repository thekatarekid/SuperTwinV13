// ===========================================================================
// Brain root: locate ~/SuperTwinV11/brain, seed it from brain-template/ on first
// use, git-init it, and best-effort commit changes.
//
//   - brainRoot(): SUPERTWIN_BRAIN_DIR override (tests), else
//     SUPERTWIN_HOME/brain, else ~/SuperTwinV11/brain (mirrors mediaRoot()).
//   - ensureBrain(): idempotent seed + `git init` + initial commit. Seeding
//     copies brain-template/ when it can be located, and always guarantees the
//     canonical layout (spaces/ people/ workflows/ habits/ me/ + me seed
//     files) even when the template is not on disk (bundled worker).
//   - commitBrain(): `git add -A && git commit` — best-effort, NEVER throws
//     (git missing / nothing to change / no repo are all fine).
// ===========================================================================

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The canonical layout every brain must have (template or not). */
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

/**
 * Locate the repo's brain-template/ directory, if reachable from this build:
 * SUPERTWIN_BRAIN_TEMPLATE_DIR override, else walk up from this module (dev:
 * worker/src/brain -> repo root) and from cwd. Returns null when not found
 * (e.g. the bundled worker) — callers fall back to the programmatic layout.
 */
function findTemplateDir(): string | null {
  const candidates: string[] = [];
  const override = process.env.SUPERTWIN_BRAIN_TEMPLATE_DIR;
  if (override && override.trim().length > 0) candidates.push(resolve(override));

  const starts: string[] = [process.cwd()];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // CJS bundle: import.meta.url unavailable — cwd walk still applies.
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, "brain-template"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const c of candidates) {
    if (existsSync(join(c, "README.md"))) return c;
  }
  return null;
}

/** True when the directory is missing or has no entries besides `.git`. */
function isEmptyBrain(root: string): boolean {
  if (!existsSync(root)) return true;
  try {
    return readdirSync(root).filter((n) => n !== ".git").length === 0;
  } catch {
    return true;
  }
}

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

  // ---- Seed from brain-template/ when empty (first run).
  if (isEmptyBrain(root)) {
    const template = findTemplateDir();
    if (template) {
      try {
        cpSync(template, root, { recursive: true });
      } catch (err) {
        console.error(`[brain] template copy failed: ${(err as Error).message}`);
      }
    }
  }

  // ---- Guarantee the canonical layout regardless of template availability.
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
