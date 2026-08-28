// ===========================================================================
// [CODE] Eval fixture schema + loader — evals doc §1–§3.
//
// One row of `SuperTwinV13_GoldenEvals_V2.md` materialises to one fixture at
// `evals/fixtures/<ID>.json`, in EXACTLY the shape of evals doc §2. This module
// is the only place that shape is known, and it validates on every read.
//
// The loader is deliberately unforgiving. A fixture that is slightly wrong is
// worse than a fixture that is missing: a missing one is a visible hole in the
// coverage table, a wrong one silently scores a gate. So every field is checked
// and every problem is reported with its JSON path and the file it came from —
// all of them at once, because fixing one typo per run is nobody's afternoon.
// ===========================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { isGateId } from "./gates.js";

/** evals doc §3. */
export const ASSERT_MODES = [
  "exact",
  "set_equal",
  "contains",
  "absent",
  "state",
  "no_throw",
  "budget",
] as const;
export type AssertMode = (typeof ASSERT_MODES)[number];

/** Which scheduling regime the case is posed in. */
export const RUN_MODES = ["bootstrap", "backfill", "steady", "live"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** evals doc §4 — the 22 categories and their case counts. */
export const CATEGORIES: readonly { cat: string; name: string; n: number; layer: string }[] = [
  { cat: "A", name: "INGEST", n: 30, layer: "ingest" },
  { cat: "B", name: "TIERS", n: 50, layer: "tiers" },
  { cat: "C", name: "ENRICH", n: 40, layer: "enrichment" },
  { cat: "D", name: "SESS-CONV", n: 75, layer: "sessions" },
  { cat: "E", name: "SESS-OTHER", n: 40, layer: "sessions" },
  { cat: "F", name: "SESS-OPS", n: 40, layer: "sessions" },
  { cat: "G", name: "IDENTITY", n: 70, layer: "entities" },
  { cat: "H", name: "MENTIONS", n: 40, layer: "mentions" },
  { cat: "I", name: "EDGES", n: 40, layer: "edges" },
  { cat: "J", name: "EPISODES", n: 55, layer: "episodes" },
  { cat: "K", name: "BRIDGES", n: 30, layer: "bridges" },
  { cat: "L", name: "ARCS", n: 45, layer: "arcs" },
  { cat: "M", name: "CLAIMS", n: 95, layer: "claims" },
  { cat: "N", name: "LOOPS", n: 75, layer: "loops" },
  { cat: "O", name: "PARTY", n: 45, layer: "party" },
  { cat: "P", name: "PROMOTION", n: 50, layer: "promotion" },
  { cat: "Q", name: "TASKS", n: 30, layer: "tasks" },
  { cat: "R", name: "WRITE", n: 40, layer: "write" },
  { cat: "S", name: "WIRE", n: 50, layer: "wire" },
  { cat: "T", name: "SCHED", n: 30, layer: "scheduler" },
  { cat: "U", name: "ACCT", n: 15, layer: "accounting" },
  { cat: "V", name: "CALIB", n: 15, layer: "calib" },
];

export const TOTAL_CASES = CATEGORIES.reduce((sum, c) => sum + c.n, 0);

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.cat));

export interface FixtureStream {
  alias: string;
  name: string;
  kind: string;
  participants: string[];
}

export interface FixtureEvent {
  n: number;
  ts: string;
  who: string;
  text: string;
  [extra: string]: unknown;
}

export interface FixtureGiven {
  /** `"a1=Pranjali Sachdeva"` — alias to roster label. */
  roster: string[];
  streams: FixtureStream[];
  events: FixtureEvent[];
  open: { episodes: unknown[]; loops: unknown[] };
  db: { entities: unknown[]; claims: unknown[]; arcs: unknown[] };
}

export interface FixtureAssert {
  mode: AssertMode;
  /** Fields the set comparison projects onto. Absent = every expected key. */
  on?: string[];
  /** A §14.2 gate id, validated against the registry. null = feeds no gate. */
  gate?: string | null;
  /**
   * `budget` bounds, keyed by metric name. Not in evals doc §2 (which shows no
   * budget example) — §3 defines the mode as "a measured value is within
   * bound", and the bound has to live somewhere.
   */
  bound?: Record<string, { max?: number; min?: number }>;
}

export interface Fixture {
  id: string;
  category: string;
  layer: string;
  /** Prompt id (`P-CL1`) or `[CODE]` for a deterministic row. */
  call: string;
  mode: RunMode;
  given: FixtureGiven;
  /** The frozen model verdict — what makes the suite runnable with no network. */
  frozen_response: string;
  expect: Record<string, unknown>;
  assert: FixtureAssert;
  /** Generated from the doc table, not yet filled in with real payloads. */
  stub?: boolean;
  /** The doc row this fixture came from, kept verbatim for the human. */
  doc?: { given: string; expect: string; assert: string };
}

/** Every key the schema knows. Anything else is a typo, and typos fail loudly. */
const FIXTURE_KEYS = new Set([
  "id",
  "category",
  "layer",
  "call",
  "mode",
  "given",
  "frozen_response",
  "expect",
  "assert",
  "stub",
  "doc",
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
 * `M-014`. Numbers 900+ are a reserved block for the harness's own self-test
 * fixtures — they are real fixtures, validated by the same loader, but they are
 * not gold cases and never count towards the §4 coverage table.
 */
const ID_RE = /^[A-V]-\d{3}$/;

export function isSelfTestId(id: string): boolean {
  return ID_RE.test(id) && Number(id.slice(2)) >= 900;
}

const ROSTER_RE = /^(?:self|[a-z][0-9a-z]*)=.+$/;
const LAYER_RE = /^[a-z][a-z0-9_]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

  strArray(v: unknown, path: string): string[] {
    const arr = this.array(v, path);
    const out: string[] = [];
    arr.forEach((item, i) => out.push(this.str(item, `${path}[${i}]`)));
    return out;
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

function checkGiven(c: Checker, raw: unknown): FixtureGiven {
  const g = c.record(raw, "given");
  const roster = c.strArray(g.roster, "given.roster");
  roster.forEach((entry, i) => {
    if (entry && !ROSTER_RE.test(entry)) {
      c.fail(`given.roster[${i}]`, `must look like "a1=Name", got ${JSON.stringify(entry)}`);
    }
  });

  const streams = c.array(g.streams, "given.streams").map((s, i) => {
    const rec = c.record(s, `given.streams[${i}]`);
    return {
      alias: c.str(rec.alias, `given.streams[${i}].alias`),
      name: c.str(rec.name, `given.streams[${i}].name`),
      kind: c.str(rec.kind, `given.streams[${i}].kind`),
      participants: c.strArray(rec.participants, `given.streams[${i}].participants`),
    };
  });

  const seen = new Set<number>();
  const events = c.array(g.events, "given.events").map((e, i) => {
    const rec = c.record(e, `given.events[${i}]`);
    const n = rec.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      c.fail(`given.events[${i}].n`, `must be a positive integer, got ${describe(n)}`);
    } else if (seen.has(n)) {
      c.fail(`given.events[${i}].n`, `duplicate event number ${n}`);
    } else {
      seen.add(n);
    }
    return {
      ...rec,
      n: typeof n === "number" ? n : 0,
      ts: c.str(rec.ts, `given.events[${i}].ts`),
      who: c.str(rec.who, `given.events[${i}].who`),
      text: c.str(rec.text, `given.events[${i}].text`),
    } as FixtureEvent;
  });

  const open = c.record(g.open, "given.open");
  const db = c.record(g.db, "given.db");
  return {
    roster,
    streams,
    events,
    open: {
      episodes: c.array(open.episodes, "given.open.episodes"),
      loops: c.array(open.loops, "given.open.loops"),
    },
    db: {
      entities: c.array(db.entities, "given.db.entities"),
      claims: c.array(db.claims, "given.db.claims"),
      arcs: c.array(db.arcs, "given.db.arcs"),
    },
  };
}

function checkAssert(c: Checker, raw: unknown): FixtureAssert {
  const a = c.record(raw, "assert");
  const mode = c.str(a.mode, "assert.mode") as AssertMode;
  if (mode && !(ASSERT_MODES as readonly string[]).includes(mode)) {
    c.fail("assert.mode", `must be one of ${ASSERT_MODES.join(" ")}, got ${JSON.stringify(mode)}`);
  }

  let on: string[] | undefined;
  if (a.on !== undefined) {
    on = c.strArray(a.on, "assert.on");
    if (on.length === 0) c.fail("assert.on", "must be a non-empty array when present");
    if (new Set(on).size !== on.length) c.fail("assert.on", "must not repeat a field");
  }

  let gate: string | null | undefined;
  if (a.gate !== undefined) {
    if (a.gate === null) {
      gate = null;
    } else {
      gate = c.str(a.gate, "assert.gate");
      if (gate && !isGateId(gate)) {
        c.fail("assert.gate", `${JSON.stringify(gate)} is not a gate in architecture §14.2`);
      }
    }
  }

  let bound: FixtureAssert["bound"];
  if (a.bound !== undefined) {
    const rec = c.record(a.bound, "assert.bound");
    bound = {};
    for (const [key, value] of Object.entries(rec)) {
      const b = c.record(value, `assert.bound.${key}`);
      const entry: { max?: number; min?: number } = {};
      for (const side of ["max", "min"] as const) {
        if (b[side] === undefined) continue;
        if (typeof b[side] !== "number" || !Number.isFinite(b[side])) {
          c.fail(`assert.bound.${key}.${side}`, `must be a finite number, got ${describe(b[side])}`);
        } else {
          entry[side] = b[side] as number;
        }
      }
      if (entry.max === undefined && entry.min === undefined) {
        c.fail(`assert.bound.${key}`, "needs a max or a min");
      }
      bound[key] = entry;
    }
  }
  if (mode === "budget" && (!bound || Object.keys(bound).length === 0)) {
    c.fail("assert.bound", "is required for mode 'budget'");
  }

  const out: FixtureAssert = { mode };
  if (on) out.on = on;
  if (gate !== undefined) out.gate = gate;
  if (bound) out.bound = bound;
  return out;
}

/** Validates one parsed fixture object. Throws `FixtureError` listing everything wrong. */
export function validateFixture(raw: unknown, file: string): Fixture {
  const c = new Checker();
  const o = c.record(raw, "<root>");
  if (c.problems.length > 0) throw new FixtureError(file, c.problems);

  for (const key of Object.keys(o)) {
    if (!FIXTURE_KEYS.has(key)) c.fail(key, "is not a field of the §2 fixture schema");
  }

  const id = c.str(o.id, "id");
  if (id && !ID_RE.test(id)) c.fail("id", `must look like "M-014", got ${JSON.stringify(id)}`);
  const category = c.str(o.category, "category");
  if (category && !CATEGORY_IDS.has(category)) {
    c.fail("category", `${JSON.stringify(category)} is not one of the 22 categories in §4`);
  }
  if (id && category && ID_RE.test(id) && id[0] !== category) {
    c.fail("category", `${JSON.stringify(category)} does not match the id prefix of ${id}`);
  }

  const layer = c.str(o.layer, "layer");
  if (layer && !LAYER_RE.test(layer)) c.fail("layer", `must be a lowercase token, got ${JSON.stringify(layer)}`);

  const call = c.str(o.call, "call");
  if (call.trim() === "") c.fail("call", "must not be blank — use \"[CODE]\" for a deterministic row");

  const mode = c.str(o.mode, "mode") as RunMode;
  if (mode && !(RUN_MODES as readonly string[]).includes(mode)) {
    c.fail("mode", `must be one of ${RUN_MODES.join(" ")}, got ${JSON.stringify(mode)}`);
  }

  const given = checkGiven(c, o.given);
  const frozen = typeof o.frozen_response === "string" ? o.frozen_response : "";
  if (typeof o.frozen_response !== "string") {
    c.fail("frozen_response", `must be a string, got ${describe(o.frozen_response)}`);
  }
  const expect = c.record(o.expect, "expect");
  const assertion = checkAssert(c, o.assert);

  let stub: boolean | undefined;
  if (o.stub !== undefined) {
    if (typeof o.stub !== "boolean") c.fail("stub", `must be a boolean, got ${describe(o.stub)}`);
    else stub = o.stub;
  }

  let doc: Fixture["doc"];
  if (o.doc !== undefined) {
    const d = c.record(o.doc, "doc");
    doc = {
      given: c.str(d.given, "doc.given"),
      expect: c.str(d.expect, "doc.expect"),
      assert: c.str(d.assert, "doc.assert"),
    };
  }

  // `no_throw` asserts on the absence of an exception and `budget` on measured
  // metrics — neither needs an `expect` body. Every other mode compares against
  // one, and an empty one would silently pass.
  const expectOptional = assertion.mode === "no_throw" || assertion.mode === "budget";
  if (!stub && !expectOptional && Object.keys(expect).length === 0) {
    c.fail("expect", `is empty — a '${assertion.mode}' assertion has nothing to compare`);
  }

  if (c.problems.length > 0) throw new FixtureError(file, c.problems);

  const fixture: Fixture = {
    id,
    category,
    layer,
    call,
    mode,
    given,
    frozen_response: frozen,
    expect,
    assert: assertion,
  };
  if (stub !== undefined) fixture.stub = stub;
  if (doc) fixture.doc = doc;
  return fixture;
}

/** Parses + validates. JSON syntax errors carry the file name too. */
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

/** Loads every `*.json` under `dir`, sorted by id. Never throws on a bad one —
 * it collects, so the caller can print all of them and exit once. */
export function loadDirectory(dir: string): LoadReport {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const fixtures: Fixture[] = [];
  const errors: FixtureError[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
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
  return { fixtures, errors, files: files.length };
}

/** Per-category counts against the evals doc §4 coverage table. */
export function coverageGaps(fixtures: readonly Fixture[]): string[] {
  const counts = new Map<string, number>();
  for (const f of fixtures) {
    if (isSelfTestId(f.id)) continue;
    counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  }
  const gaps: string[] = [];
  for (const c of CATEGORIES) {
    const have = counts.get(c.cat) ?? 0;
    if (have !== c.n) gaps.push(`${c.cat} (${c.name}): ${have} fixtures, §4 says ${c.n}`);
  }
  return gaps;
}
