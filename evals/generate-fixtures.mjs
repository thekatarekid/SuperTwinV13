#!/usr/bin/env node
// ===========================================================================
// [CODE] Fixture stub generator — evals doc §1.2 ("each row materialises to a
// fixture at evals/fixtures/<ID>.json").
//
// The 1,000 gold cases live as markdown tables in SuperTwinV11_GoldenEvals_V2.md.
// Hand-writing 1,000 JSON files from them is how rows go missing, so this
// parses the tables and writes one stub per row. A stub carries:
//
//   * the row's identity (id, category, layer, call, run mode),
//   * the doc's own Given / Expect / Assert text, verbatim, in `doc`,
//   * `stub: true` — which makes the runner report it PENDING, never PASS.
//
// The payloads (`given.events`, `frozen_response`, `expect`) are filled in by
// the item that builds each layer. Until then the honest report is "1,000
// fixtures load and validate, 0 asserted", not a green suite.
//
// The `assert.mode` and `assert.gate` on a stub are INFERRED from the row text
// and are a starting point for those items, not a verdict.
//
// OWNERSHIP. Because payloads are authored by hand and the doc rows are not,
// this generator owns only the identity half of every fixture:
//
//   doc-owned  id, category, layer, call, mode, doc   ← regenerated, always
//   authored   given, frozen_response, expect, assert, stub
//
// A fixture that still says `stub: true` is wholly owned here and must stay
// byte-identical to what this script emits — that is what stops an untouched
// row from silently drifting. A fixture that says `stub: false` has been filled
// in by the item that owns its layer: its payload is preserved on a rewrite and
// only the doc-owned half is checked, so `--check` still catches a renamed
// layer, a moved row or a fixture with no row behind it.
//
//   node evals/generate-fixtures.mjs [--check]
//     --check  parse and diff against what is on disk; write nothing.
// ===========================================================================

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOC = join(ROOT, "SuperTwinV11_GoldenEvals_V2.md");
const OUT = join(HERE, "fixtures");

/** evals doc §4 — category, expected count, and the layer it exercises. */
const CATEGORIES = {
  A: { n: 30, layer: "ingest", gate: null },
  B: { n: 50, layer: "tiers", gate: "tiers_all_assigned" },
  C: { n: 40, layer: "enrichment", gate: "enrich_executor_routing" },
  D: { n: 75, layer: "sessions", gate: "sessions_boundary_f1" },
  E: { n: 40, layer: "sessions", gate: "sessions_boundary_f1" },
  F: { n: 40, layer: "sessions", gate: "sessions_boundary_f1" },
  G: { n: 70, layer: "entities", gate: "entities_precision" },
  H: { n: 40, layer: "mentions", gate: "entities_mention_linking" },
  I: { n: 40, layer: "edges", gate: "entities_edge_precision" },
  J: { n: 55, layer: "episodes", gate: "episodes_split_attach_accuracy" },
  K: { n: 30, layer: "bridges", gate: "arcs_bridge_recall" },
  L: { n: 45, layer: "arcs", gate: "arcs_precision" },
  M: { n: 95, layer: "claims", gate: "claim_subject_accuracy" },
  N: { n: 75, layer: "loops", gate: "loops_explicit_precision" },
  O: { n: 45, layer: "party", gate: "party_pairs_correct" },
  P: { n: 50, layer: "promotion", gate: "promotion_route_accuracy" },
  Q: { n: 30, layer: "tasks", gate: null },
  R: { n: 40, layer: "write", gate: "claims_out_of_order_supersession" },
  S: { n: 50, layer: "wire", gate: "wire_round_trip" },
  T: { n: 30, layer: "scheduler", gate: null },
  U: { n: 15, layer: "accounting", gate: "acct_total_input_identity" },
  V: { n: 15, layer: "calib", gate: "calib_stale_or_absent" },
};

const ROW_RE = /^\|\s*([A-V]-\d{3})\s*\|(.*)\|(.*)\|(.*)\|\s*$/;
const CALL_RE = /\bP-[A-Z]{2}\d\b/;

export function parseCases(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## 5. Cases"));
  if (start === -1) throw new Error("evals doc has no '## 5. Cases' section");
  const cases = [];
  for (const line of lines.slice(start)) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    cases.push({
      id: m[1],
      given: m[2].trim(),
      expect: m[3].trim(),
      assert: m[4].trim(),
    });
  }
  return cases;
}

/** `<= 30s`, `>= 0.7`, `<= 120 s`, `> 90s` → a budget bound, or null. */
export function inferBound(text) {
  const m = /(<=|>=|≤|≥)\s*([\d.]+)\s*(ms|s\b|seconds?|tokens?|calls?|%)?/i.exec(text);
  if (!m) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[3] ?? "").toLowerCase();
  const key = unit.startsWith("ms")
    ? "latency_ms"
    : unit.startsWith("s")
      ? "latency_s"
      : unit.startsWith("token")
        ? "tokens"
        : unit.startsWith("call")
          ? "calls"
          : unit === "%"
            ? "pct"
            : "value";
  const side = m[1] === "<=" || m[1] === "≤" ? "max" : "min";
  return { [key]: { [side]: value } };
}

export function inferAssert(row) {
  const text = `${row.expect} ${row.assert}`.toLowerCase();
  if (/throw|exception|crash/.test(text)) return { mode: "no_throw" };
  const bound = inferBound(`${row.expect} ${row.assert}`);
  if (bound) return { mode: "budget", bound };
  if (/\bno\b|\bnot\b|does not|never|dropped|skipped|0 orphan|absent|refus/.test(text)) {
    return { mode: "absent" };
  }
  if (/\[code\]|byte-identical|exact|identical/.test(text)) return { mode: "exact" };
  if (/=\S/.test(row.expect)) return { mode: "state" };
  return { mode: "set_equal" };
}

export function inferRunMode(given) {
  const text = given.toLowerCase();
  if (/\blive\b/.test(text)) return "live";
  if (/\bboot\b|cold connect|restart|bootstrap|first run/.test(text)) return "bootstrap";
  if (/backfill|history|resync|re-scan|old|\bpage \d/.test(text)) return "backfill";
  return "steady";
}

export function buildFixture(row) {
  const meta = CATEGORIES[row.id[0]];
  if (!meta) throw new Error(`${row.id}: unknown category`);
  const call = CALL_RE.exec(`${row.given} ${row.expect} ${row.assert}`);
  const assertion = inferAssert(row);
  return {
    id: row.id,
    category: row.id[0],
    layer: meta.layer,
    call: call ? call[0] : "[CODE]",
    mode: inferRunMode(row.given),
    given: {
      roster: [],
      streams: [],
      events: [],
      open: { episodes: [], loops: [] },
      db: { entities: [], claims: [], arcs: [] },
    },
    frozen_response: "",
    expect: {},
    assert: { ...assertion, gate: meta.gate },
    stub: true,
    doc: { given: row.given, expect: row.expect, assert: row.assert },
  };
}

function main() {
  const check = process.argv.includes("--check");
  const cases = parseCases(readFileSync(DOC, "utf8"));

  const counts = {};
  for (const row of cases) counts[row.id[0]] = (counts[row.id[0]] ?? 0) + 1;
  const problems = [];
  let expectedTotal = 0;
  for (const [cat, meta] of Object.entries(CATEGORIES)) {
    expectedTotal += meta.n;
    if ((counts[cat] ?? 0) !== meta.n) {
      problems.push(`${cat}: parsed ${counts[cat] ?? 0} rows, §4 says ${meta.n}`);
    }
  }
  const ids = new Set();
  for (const row of cases) {
    if (ids.has(row.id)) problems.push(`${row.id}: duplicate row in the doc`);
    ids.add(row.id);
  }
  if (cases.length !== expectedTotal) problems.push(`total: parsed ${cases.length}, §4 says ${expectedTotal}`);
  if (problems.length > 0) {
    console.error(`generate-fixtures: the doc does not match §4:\n  - ${problems.join("\n  - ")}`);
    process.exitCode = 2;
    return;
  }

  const fixtures = cases.map(buildFixture);
  if (check) {
    const onDisk = new Set(readdirSync(OUT).filter((f) => f.endsWith(".json")));
    const drift = [];
    let authored = 0;
    for (const fixture of fixtures) {
      const name = `${fixture.id}.json`;
      onDisk.delete(name);
      let current;
      try {
        current = readFileSync(join(OUT, name), "utf8");
      } catch {
        drift.push(`${name}: missing`);
        continue;
      }
      let existing = null;
      try {
        existing = JSON.parse(current);
      } catch (err) {
        drift.push(`${name}: is not valid JSON (${err.message})`);
        continue;
      }
      if (existing?.stub === false) {
        // Authored: the payload belongs to the item that filled it in, so only
        // the doc-owned half is this script's to verify.
        authored += 1;
        for (const key of DOC_OWNED) {
          if (canonical(existing[key]) !== canonical(fixture[key])) {
            drift.push(
              `${name}: ${key} differs from the doc (doc has ${canonical(fixture[key])}, file has ${canonical(existing[key])})`,
            );
          }
        }
      } else if (current !== render(fixture)) {
        drift.push(`${name}: differs from the doc`);
      }
    }
    for (const extra of onDisk) drift.push(`${extra}: not a row in the doc`);
    if (drift.length > 0) {
      console.error(`generate-fixtures --check: ${drift.length} problem(s)\n  - ${drift.join("\n  - ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`generate-fixtures --check: ${fixtures.length} fixtures match the doc (${authored} authored)`);
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const keep = new Set(fixtures.map((f) => `${f.id}.json`));
  for (const file of readdirSync(OUT)) {
    // A file with no row behind it is deleted; authored payloads are not, which
    // is why this is a targeted unlink and not an rm -rf of the directory.
    if (file.endsWith(".json") && !keep.has(file)) rmSync(join(OUT, file));
  }
  let authored = 0;
  for (const fixture of fixtures) {
    const path = join(OUT, `${fixture.id}.json`);
    const merged = mergeAuthored(fixture, path);
    if (merged !== fixture) authored += 1;
    writeFileSync(path, render(merged));
  }
  const byMode = {};
  for (const f of fixtures) byMode[f.assert.mode] = (byMode[f.assert.mode] ?? 0) + 1;
  console.log(`generate-fixtures: wrote ${fixtures.length} fixtures to ${OUT} (${authored} authored payloads preserved)`);
  console.log(
    `  stub assert modes: ${Object.entries(byMode)
      .sort()
      .map(([m, n]) => `${m}=${n}`)
      .join(" ")}`,
  );
}

/** The half of a fixture this script owns. Everything else is authored. */
const DOC_OWNED = ["id", "category", "layer", "call", "mode", "doc"];

/** Stable stringify, so key order cannot masquerade as drift. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

/**
 * Re-stamp the doc-owned half onto an authored fixture, keeping its payload.
 * Returns the plain stub when nothing on disk has been filled in yet.
 */
function mergeAuthored(fixture, path) {
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fixture;
  }
  if (existing?.stub !== false) return fixture;
  return {
    id: fixture.id,
    category: fixture.category,
    layer: fixture.layer,
    call: fixture.call,
    mode: fixture.mode,
    given: existing.given,
    frozen_response: existing.frozen_response,
    expect: existing.expect,
    assert: existing.assert,
    stub: false,
    doc: fixture.doc,
  };
}

function render(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
