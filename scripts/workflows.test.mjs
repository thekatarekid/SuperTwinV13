// A duplicate top-level key in a workflow file is invisible to every other
// check in this repo: `tsc` and `vitest` never read YAML, and GitHub does not
// report it as a failing job — the run is created with zero jobs and a bare
// `failure` conclusion, which reads on the PR as "no checks ran". CI silently
// stopped validating anything for 23 commits that way.
//
// Deliberately dependency-free: no YAML parser is installed, and adding one to
// devDependencies for a dozen lines of scanning is not worth the supply chain.
// Top-level keys in these files always sit at column 0, so a line scan finds
// exactly the failure mode that bit us.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = join(root, ".github", "workflows");

function workflowFiles() {
  return readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

/** Top-level keys, in order, ignoring comments and any indented content. */
export function topLevelKeys(source) {
  const keys = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const m = /^([A-Za-z_][\w-]*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

export function duplicates(list) {
  const seen = new Set();
  const dupes = new Set();
  for (const k of list) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes];
}

describe("workflow files", () => {
  const files = workflowFiles();

  it("finds at least one workflow to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s has no duplicate top-level keys", (file) => {
    const keys = topLevelKeys(readFileSync(join(workflowDir, file), "utf8"));
    expect(duplicates(keys)).toEqual([]);
  });

  it.each(files)("%s declares the keys a workflow needs", (file) => {
    const keys = topLevelKeys(readFileSync(join(workflowDir, file), "utf8"));
    expect(keys).toContain("name");
    expect(keys).toContain("jobs");
    // `on:` is the YAML 1.1 boolean `true`, so it never matches the key regex —
    // assert on the raw text instead.
    expect(readFileSync(join(workflowDir, file), "utf8")).toMatch(/^on:/m);
  });
});

describe("the scanner itself", () => {
  it("catches the exact duplicate that disabled CI", () => {
    const broken = [
      "name: CI",
      "on:",
      "  push:",
      "concurrency:",
      "  group: a",
      "permissions:",
      "  contents: read",
      "concurrency:",
      "  group: b",
      "jobs:",
    ].join("\n");
    expect(duplicates(topLevelKeys(broken))).toEqual(["concurrency"]);
  });

  it("does not flag repeated keys nested under different parents", () => {
    const fine = ["jobs:", "  a:", "    runs-on: x", "  b:", "    runs-on: x"].join("\n");
    expect(duplicates(topLevelKeys(fine))).toEqual([]);
  });

  it("ignores commented-out keys", () => {
    expect(duplicates(topLevelKeys("name: x\n# name: y\njobs:\n"))).toEqual([]);
  });
});
