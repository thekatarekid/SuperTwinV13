#!/usr/bin/env node
// ===========================================================================
// screen-dedup-rate.mjs — the screen half of the Stage 6 week-one telemetry
// (Build V6 P1 §9 item 3: "screen events per day after content-hash dedup —
// the 725/day assumption").
//
// Replays a screenwatch fixture through the REAL sidecar pipeline
// (`screenwatch --mock --fixture <path>` — the same Dedup.swift the live walk
// uses) and reports what survived:
//
//   captures        what the walk saw
//   policy drops    never-list refusals (private window, password manager) —
//                   these were never events, so they are NOT dedup
//   snapshots       what became an event
//   suppressed      captures the content+tree hash (or the switch new-chars
//                   floor) swallowed
//
// The dedup RATE is suppressed / policy-allowed: what fraction of the captures
// that were allowed to become events did not, because nothing changed. That is
// the multiplier the 725/day assumption needs — but the fixture is a fixture:
// only a real day answers the events-per-day half, which is why §9 item 3 is a
// week-one measurement and this script is only its lower half.
//
// Zero model calls. Zero network. Builds nothing — run sources/screenwatch/build.sh
// first if ./screenwatch is missing.
//
//   node scripts/screen-dedup-rate.mjs [--fixture PATH] [--json FILE]
//   node scripts/screen-dedup-rate.mjs --builtin
// ===========================================================================

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "..");
export const SCREENWATCH_DIR = join(REPO, "sources", "screenwatch");

export function parseArgs(argv) {
  const opts = { fixture: join(SCREENWATCH_DIR, "fixtures", "basic.json"), builtin: false, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--fixture") opts.fixture = argv[++i];
    else if (a === "--builtin") opts.builtin = true;
    else if (a === "--json") opts.json = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

/**
 * Tally emitted frames against the captures that went in. Pure — the frames
 * and the capture count are the only inputs, so the arithmetic is testable
 * without running the sidecar.
 */
export function tally(captures, frames) {
  const snapshots = frames.filter((f) => f.t === "snapshot");
  const drops = frames.filter((f) => f.t === "drop");
  const allowed = captures - drops.length;
  const suppressed = allowed - snapshots.length;
  return {
    captures,
    policyDrops: drops.length,
    dropReasons: [...new Set(drops.map((d) => d.reason))].sort(),
    allowed,
    snapshots: snapshots.length,
    suppressed,
    dedupRate: allowed > 0 ? suppressed / allowed : null,
  };
}

export function renderTally(t, label) {
  const pct = t.dedupRate === null ? "—" : `${(t.dedupRate * 100).toFixed(1)}%`;
  return [
    "",
    `SCREEN DEDUP — ${label}`,
    `  captures                 ${t.captures}`,
    `  policy drops             ${t.policyDrops}${t.dropReasons.length ? `  (${t.dropReasons.join(", ")})` : ""}`,
    `  policy-allowed           ${t.allowed}`,
    `  snapshots emitted        ${t.snapshots}`,
    `  suppressed by dedup      ${t.suppressed}`,
    `  DEDUP RATE               ${pct}  (suppressed / policy-allowed)`,
    "",
    "  The events-per-day half of the 725/day assumption needs a REAL day of",
    "  captures — this measures the algorithm, not the user. Week-one item.",
    "",
  ].join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bin = join(SCREENWATCH_DIR, "screenwatch");
  if (!existsSync(bin)) {
    console.error(`screen-dedup-rate: ${bin} missing — run sources/screenwatch/build.sh first`);
    process.exitCode = 2;
    return;
  }
  const args = opts.builtin ? ["--mock"] : ["--mock", "--fixture", opts.fixture];
  const out = execFileSync(bin, args, { cwd: SCREENWATCH_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const frames = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  let captures;
  let label;
  if (opts.builtin) {
    // The built-in fixture is compiled in; its capture count is what the
    // sidecar reports it replayed (snapshots + drops + suppressed), so we
    // cannot read it off disk. Count the frames it produced and say so.
    captures = frames.filter((f) => f.t === "snapshot" || f.t === "drop").length;
    label = "built-in fixture (capture count inferred from emitted frames)";
  } else {
    captures = JSON.parse(readFileSync(opts.fixture, "utf8")).captures.length;
    label = opts.fixture;
  }
  const t = tally(captures, frames);
  console.log(renderTally(t, label));
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify({ fixture: label, ...t }, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
