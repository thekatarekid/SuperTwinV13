// ===========================================================================
// [CODE] V13 eval fixture schema + loader — GoldenEvals V2 header, build P0.9.
//
// One case of `SuperTwinV13_GoldenEvals_V1.md` / `_V2.md` materialises to one
// fixture at `evals/v13/<ID>.json` in the shape the V2 doc's header shows:
// `{ id, pass, mode, setup, input_events, expected, wrong[], gates[] }`.
//
// There is NO `frozen_response`. Model-facing cases run against the real model
// (the executor drives the real pass, which drives the real `claude` CLI) and
// are graded by an LLM judge against the case's `expected` rubric plus code
// assertions for `wrong[]`. Deterministic cases (`mode: "code"`) are asserted
// purely by the executor's code.
//
// `setup` / `expected` may be a structured object (the header's full example)
// or a compact prose rubric (how the doc writes its cases); `input_events` is
// a list of events, each either structured or prose. The judge consumes both
// forms; a code executor that needs structure demands it and fails loudly on
// prose.
//
// The loader stays unforgiving: every field checked, every problem reported
// with its JSON path and file, all at once.
// ===========================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Live cases go to the model + judge; code cases are asserted by code alone. */
export const FIXTURE_MODES = ["live", "code"] as const;
export type FixtureMode = (typeof FIXTURE_MODES)[number];

export interface CategoryInfo {
  /** Three-letter id prefix, e.g. "ROL". */
  cat: string;
  name: string;
  /** Case count per the doc's category table. */
  n: number;
  /** Which eval doc defines it. */
  doc: "V1" | "V2";
  /** The pass/executor key its cases run against. */
  pass: string;
  /**
   * Hand-authored fixtures (GoldenEvals V6 P1 §5) — not parsed out of the V1/V2
   * docs, so `--materialize` neither produces nor overwrites them.
   */
  authored?: boolean;
}

/**
 * V1 doc categories (SEG skipped — BND replaces it) + V2 doc categories.
 * Counts come from each doc's category table.
 */
export const CATEGORIES: readonly CategoryInfo[] = [
  // -- GoldenEvals V1 (skip SEG) --
  { cat: "TOP", name: "Episode formation & topic split", n: 10, doc: "V1", pass: "orient" },
  { cat: "ASN", name: "Space match / attach", n: 14, doc: "V1", pass: "orient" },
  { cat: "CRE", name: "Space proposal", n: 10, doc: "V1", pass: "orient" },
  { cat: "CLM", name: "Extract — claims", n: 13, doc: "V1", pass: "extract" },
  { cat: "TSK", name: "Decide — task extraction", n: 13, doc: "V1", pass: "decide" },
  { cat: "CLS", name: "Decide — closure detection", n: 8, doc: "V1", pass: "decide" },
  { cat: "EXE", name: "Executor (agentic)", n: 6, doc: "V1", pass: "executor" },
  { cat: "AGE", name: "Age-band backfill policy", n: 4, doc: "V1", pass: "scheduler.backfill" },
  // -- GoldenEvals V2 --
  // V6 P1 S3.3: BND is re-authored against the V6 P1 doc (§5.5, 12 cases) — the
  // V2 per-stream-window cases were replaced ("the call unit is time, not stream").
  { cat: "BND", name: "Bundling (V6 P1)", n: 12, doc: "V2", pass: "bundle", authored: true },
  { cat: "ROL", name: "People role resolution", n: 10, doc: "V2", pass: "orient+extract" },
  { cat: "CIR", name: "Circles & relationship value", n: 4, doc: "V2", pass: "circles" },
  { cat: "CAT", name: "Category 1/2, promotion, Digest", n: 6, doc: "V2", pass: "digest" },
  { cat: "CHP", name: "Chapters", n: 6, doc: "V2", pass: "decide" },
  { cat: "AST", name: "Assist lane", n: 9, doc: "V2", pass: "assist" },
  { cat: "SCH", name: "Scheduled / routine tasks", n: 8, doc: "V2", pass: "schedule" },
  { cat: "FUP", name: "Follow-up tasks", n: 5, doc: "V2", pass: "decide" },
  { cat: "USR", name: "User-created objects & grounded bar", n: 6, doc: "V2", pass: "user-objects" },
  { cat: "FIX", name: "“Tell the twin” correction parsing", n: 6, doc: "V2", pass: "feedback" },
  { cat: "BRW", name: "SuperTwin Browser agent + capture", n: 8, doc: "V2", pass: "browser" },
  { cat: "TIM", name: "Time resolution", n: 4, doc: "V2", pass: "time" },
  { cat: "TRC", name: "Traces & liveness", n: 3, doc: "V2", pass: "traces" },
  // -- GoldenEvals V6 Phase 1 (§5.3) — carried under the V2 doc tag because the
  // fixture schema names two docs; the section field says "V6P1 §5.3". --
  { cat: "SRC", name: "Source quality (V6 P1)", n: 6, doc: "V2", pass: "source-quality", authored: true },
  // GoldenEvals V6 Phase 1 §5.8 — commit (S3.1). Code-asserted against brain/commit.ts.
  { cat: "CMT", name: "Commit (V6 P1)", n: 5, doc: "V2", pass: "commit", authored: true },
  // GoldenEvals V6 Phase 1 §5.7 — the pack (S3.2). Code-asserted against packer/pack.ts.
  { cat: "PCK", name: "The pack (V6 P1)", n: 7, doc: "V2", pass: "pack", authored: true },
  // GoldenEvals V6 Phase 1 §5.6 — the state gate (S3.3). Code-asserted against scheduler/v6.
  { cat: "GATE", name: "The state gate (V6 P1)", n: 10, doc: "V2", pass: "gate", authored: true },
  // GoldenEvals V6 Phase 1 §5.9 — the critic (S3.5). Re-authored against critic.v5 +
  // the mechanical layer; the V1 CRI-01..08 prose cases were replaced.
  { cat: "CRI", name: "Critic (V6 P1)", n: 4, doc: "V2", pass: "critic", authored: true },
  // GoldenEvals V6 Phase 1 §5.16 — claims and typed fields (S3.6, extract.v6). Code-asserted
  // against brain/extract-pass.ts with recorded model outputs.
  { cat: "FACT", name: "Claims — supersede, coexist, provenance (V6 P1)", n: 6, doc: "V2", pass: "claims", authored: true },
  { cat: "TYP", name: "Claims — typed fields (V6 P1)", n: 3, doc: "V2", pass: "claims", authored: true },
  // GoldenEvals V6 Phase 1 §5.18 — tiers and the weekly digest (S3.8). TIER-01/02/04 and
  // DIG-01 are code against tiers/tiering.ts + promote.ts and scheduler/v6/digest.ts;
  // TIER-03 (tier.v1) and DIG-02 (digest.v2) are live with code-asserted shape.
  { cat: "TIER", name: "Tier assignment (V6 P1)", n: 4, doc: "V2", pass: "tier", authored: true },
  { cat: "DIG", name: "Weekly digest (V6 P1)", n: 2, doc: "V2", pass: "digest", authored: true },
  // GoldenEvals V6 Phase 1 §5.17 — decide (S3.7, decide.v9). Code-asserted against
  // brain/decide-pass.ts (+ decide-apply, schedule-policy, closure-check) with canned outputs.
  { cat: "DEC", name: "Decide — one space (V6 P1)", n: 6, doc: "V2", pass: "decide-space", authored: true },
  // GoldenEvals V6 Phase 1 §5.18 — consolidation on change and idempotence (S3.9).
  // Re-authored as code cases against consolidation/t2.ts + t3.ts and the harness
  // commit path; the V1 CON-01..08 prose cases were replaced.
  { cat: "CON", name: "Consolidation on change (V6 P1)", n: 3, doc: "V2", pass: "consolidate", authored: true },
  { cat: "IDEM", name: "Idempotence (V6 P1)", n: 1, doc: "V2", pass: "consolidate", authored: true },
  // GoldenEvals V6 Phase 1 §5.10 — cross-source batching (S3 gate). CROSS-N2 is code
  // against brain/commit.ts (two unrelated chats in one bundle → two episodes, never
  // merged); CROSS-N50 / CROSS-DAY are the S4 ship gate.
  { cat: "CROSS", name: "Cross-source batching (V6 P1)", n: 1, doc: "V2", pass: "commit", authored: true },
  // GoldenEvals V6 Phase 1 §5.11 — the live call (S4.1, live.v1). LIV-01..06 are code
  // against brain/live.ts + the consumer with recorded live.v1 outputs; LIV-07..10 land
  // with S4.2–S4.4 (executor-lite, nudge, assist retirement).
  { cat: "LIV", name: "The live call (V6 P1)", n: 6, doc: "V2", pass: "live", authored: true },
  // GoldenEvals V6 Phase 1 — the derived calendar (S5.3). Code-asserted against
  // calendar/{clocks,store,layers}.ts: tentative until confirmed, lead time by
  // circle, the March deadline, recurrence as a rule, layers separable.
  { cat: "CAL", name: "Calendar — derived (V6 P1)", n: 5, doc: "V2", pass: "calendar", authored: true },
  // GoldenEvals V6 Phase 1 §5.19 — spaces (S5.1). Code against brain/commit.ts (the
  // inferred birth), spaces/{birth,unsorted,enrichment,view}.ts and consolidation/
  // graduation.ts: the three birth modes, the sweep preview, the weekly review on
  // change only, enrichment on change only, and graduation with its reset.
  { cat: "SPC", name: "Spaces (V6 P1)", n: 8, doc: "V2", pass: "space", authored: true },
];

export const TOTAL_CASES = CATEGORIES.reduce((sum, c) => sum + c.n, 0);
/** Cases the V1/V2 docs materialize — everything not hand-authored. */
export const MATERIALIZED_CASES = CATEGORIES.filter((c) => !c.authored).reduce((sum, c) => sum + c.n, 0);

const BY_CAT = new Map(CATEGORIES.map((c) => [c.cat, c]));

export function categoryInfo(cat: string): CategoryInfo | undefined {
  return BY_CAT.get(cat);
}

/** A named failure mode asserted absent — a hit is a hard fail. */
export interface WrongMode {
  /** Stable kebab-ish label, e.g. "task-theft". */
  label: string;
  /** What must not appear, prose. The judge and code both assert against it. */
  assert_absent: string;
}

export interface Fixture {
  /** `ROL-01`. */
  id: string;
  /** Id prefix — `ROL`. Derived, but stored for greppability. */
  category: string;
  /** The doc's case title. */
  title: string;
  /** Executor key — which pass runs this case (`orient`, `scheduler.dispatch`, …). */
  pass: string;
  mode: FixtureMode;
  /** World state before. Structured object or prose rubric. */
  setup: unknown;
  /** Events/state fed in. Each element structured or prose. */
  input_events: unknown[];
  /** Expected behaviour (not exact strings). Structured or prose rubric. */
  expected: unknown;
  wrong: WrongMode[];
  /** Gate ids this case feeds (see gates.ts — hard gates asserted, rest tracked). */
  gates: string[];
  /** Where the case came from. */
  source: { doc: "V1" | "V2"; section: string };
  /** Self-test fixtures never count toward doc coverage. */
  selftest?: boolean;
}

const FIXTURE_KEYS = new Set([
  "id",
  "category",
  "title",
  "pass",
  "mode",
  "setup",
  "input_events",
  "expected",
  "wrong",
  "gates",
  "source",
  "selftest",
]);

export class FixtureError extends Error {
  readonly file: string;
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: invalid fixture\n  - ${problems.join("\n  - ")}`);
    this.name = "FixtureError";
    this.file = file;
    this.problems = problems;
  }
}

/**
 * `ROL-01`, the four-letter V6 P1 categories (`GATE-01`), and the CROSS
 * fixtures the GoldenEvals V6P1 §5.10 names by shape (`CROSS-N2`, `CROSS-N50`,
 * `CROSS-DAY`).
 */
const ID_RE = /^[A-Z]{3,5}-(\d{2}|N\d{1,3}|DAY)$/;
const PASS_RE = /^[a-z][a-z0-9.+_-]*$/;
const GATE_RE = /^[a-z][a-z0-9_]*$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

class Checker {
  readonly problems: string[] = [];
  fail(path: string, msg: string): void {
    this.problems.push(`${path} ${msg}`);
  }
  str(v: unknown, path: string): string {
    if (typeof v !== "string") {
      this.fail(path, `must be a string, got ${describe(v)}`);
      return "";
    }
    return v;
  }
  array(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, `must be an array, got ${describe(v)}`);
      return [];
    }
    return v;
  }
  record(v: unknown, path: string): Record<string, unknown> {
    if (!isRecord(v)) {
      this.fail(path, `must be an object, got ${describe(v)}`);
      return {};
    }
    return v;
  }
}

/** True when the value carries content for a judge/executor to work with. */
function hasContent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** Validates one parsed fixture. Throws `FixtureError` listing everything wrong. */
export function validateFixture(raw: unknown, file: string): Fixture {
  const c = new Checker();
  const o = c.record(raw, "<root>");
  if (c.problems.length > 0) throw new FixtureError(file, c.problems);

  for (const key of Object.keys(o)) {
    if (!FIXTURE_KEYS.has(key)) c.fail(key, "is not a field of the V13 fixture schema");
  }

  const id = c.str(o.id, "id");
  if (id && !ID_RE.test(id)) c.fail("id", `must look like "ROL-01", got ${JSON.stringify(id)}`);
  const category = c.str(o.category, "category");
  const prefix = id.split("-")[0] ?? "";

  let selftest: boolean | undefined;
  if (o.selftest !== undefined) {
    if (typeof o.selftest !== "boolean") c.fail("selftest", `must be a boolean, got ${describe(o.selftest)}`);
    else selftest = o.selftest;
  }

  if (category && ID_RE.test(id) && category !== prefix) {
    c.fail("category", `${JSON.stringify(category)} does not match the id prefix of ${id}`);
  }
  if (category && !selftest && !BY_CAT.has(category)) {
    c.fail("category", `${JSON.stringify(category)} is not a category of either eval doc (and not selftest)`);
  }

  const title = c.str(o.title, "title");
  if (title.trim() === "") c.fail("title", "must not be blank");

  const pass = c.str(o.pass, "pass");
  if (pass && !PASS_RE.test(pass)) c.fail("pass", `must be a lowercase pass key, got ${JSON.stringify(pass)}`);

  const mode = c.str(o.mode, "mode") as FixtureMode;
  if (mode && !(FIXTURE_MODES as readonly string[]).includes(mode)) {
    c.fail("mode", `must be one of ${FIXTURE_MODES.join(" ")}, got ${JSON.stringify(mode)}`);
  }

  if (!hasContent(o.setup)) c.fail("setup", "must carry content (prose or structured)");
  const inputEvents = c.array(o.input_events, "input_events");
  if (inputEvents.length === 0) c.fail("input_events", "must have at least one event");
  if (!hasContent(o.expected)) c.fail("expected", "must carry content (prose or structured)");

  const wrong: WrongMode[] = c.array(o.wrong, "wrong").map((w, i) => {
    const rec = c.record(w, `wrong[${i}]`);
    const label = c.str(rec.label, `wrong[${i}].label`);
    if (label && !LABEL_RE.test(label)) {
      c.fail(`wrong[${i}].label`, `must be a kebab-case label, got ${JSON.stringify(label)}`);
    }
    const absent = c.str(rec.assert_absent, `wrong[${i}].assert_absent`);
    if (absent.trim() === "") c.fail(`wrong[${i}].assert_absent`, "must not be blank");
    for (const key of Object.keys(rec)) {
      if (key !== "label" && key !== "assert_absent") c.fail(`wrong[${i}].${key}`, "is not a field of a wrong mode");
    }
    return { label, assert_absent: absent };
  });
  {
    const seen = new Set<string>();
    wrong.forEach((w, i) => {
      if (seen.has(w.label)) c.fail(`wrong[${i}].label`, `duplicate label ${JSON.stringify(w.label)}`);
      seen.add(w.label);
    });
  }

  const gates = c.array(o.gates, "gates").map((g, i) => {
    const gate = c.str(g, `gates[${i}]`);
    if (gate && !GATE_RE.test(gate)) c.fail(`gates[${i}]`, `must be a snake_case gate id, got ${JSON.stringify(gate)}`);
    return gate;
  });

  const src = c.record(o.source, "source");
  const doc = c.str(src.doc, "source.doc");
  if (doc !== "V1" && doc !== "V2") c.fail("source.doc", `must be "V1" or "V2", got ${JSON.stringify(doc)}`);
  const section = c.str(src.section, "source.section");

  if (c.problems.length > 0) throw new FixtureError(file, c.problems);

  const fixture: Fixture = {
    id,
    category,
    title,
    pass,
    mode,
    setup: o.setup,
    input_events: inputEvents,
    expected: o.expected,
    wrong,
    gates,
    source: { doc: doc as "V1" | "V2", section },
  };
  if (selftest !== undefined) fixture.selftest = selftest;
  return fixture;
}

export function parseFixture(text: string, file: string): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new FixtureError(file, [`is not valid JSON: ${(err as Error).message}`]);
  }
  return validateFixture(raw, file);
}

export function loadFixture(path: string): Fixture {
  const fixture = parseFixture(readFileSync(path, "utf8"), path);
  const expected = `${fixture.id}.json`;
  if (basename(path) !== expected) {
    throw new FixtureError(path, [`id ${fixture.id} requires the file to be named ${expected}`]);
  }
  return fixture;
}

export interface LoadReport {
  fixtures: Fixture[];
  errors: FixtureError[];
  files: number;
}

/**
 * Loads every `*.json` under `dir` (one level of subdirectories included, so
 * `evals/v13/selftest/` rides along), sorted by id. Collects errors instead of
 * throwing, so the caller prints all of them and exits once.
 */
export function loadDirectory(dir: string): LoadReport {
  const paths: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const sub of readdirSync(path).sort()) {
        if (sub.endsWith(".json")) paths.push(join(path, sub));
      }
    } else if (entry.endsWith(".json")) {
      paths.push(path);
    }
  }

  const fixtures: Fixture[] = [];
  const errors: FixtureError[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    try {
      const fixture = loadFixture(path);
      const prior = seen.get(fixture.id);
      if (prior) {
        errors.push(new FixtureError(path, [`duplicate id ${fixture.id}, already loaded from ${prior}`]));
        continue;
      }
      seen.set(fixture.id, path);
      fixtures.push(fixture);
    } catch (err) {
      if (err instanceof FixtureError) errors.push(err);
      else errors.push(new FixtureError(path, [(err as Error).message]));
    }
  }
  fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { fixtures, errors, files: paths.length };
}

/** Per-category counts against the docs' category tables. */
export function coverageGaps(fixtures: readonly Fixture[]): string[] {
  const counts = new Map<string, number>();
  for (const f of fixtures) {
    if (f.selftest) continue;
    counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  }
  const gaps: string[] = [];
  for (const c of CATEGORIES) {
    const have = counts.get(c.cat) ?? 0;
    if (have !== c.n) gaps.push(`${c.cat} (${c.name}): ${have} fixtures, the ${c.doc} doc says ${c.n}`);
  }
  return gaps;
}
