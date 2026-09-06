// ===========================================================================
// [CODE] Fixture materializer — turns the two eval docs into JSON fixtures.
//
// One `### ID · Title` case in `SuperTwinV13_GoldenEvals_V1.md` (SEG skipped —
// BND replaces it) or `_V2.md` becomes one fixture at `evals/v13/<ID>.json`.
// The docs write cases compactly (Setup/Input/Expected/Wrong/Gates as prose);
// the fixtures carry that prose verbatim — the judge grades Expected as a
// rubric, exactly as both docs prescribe — so materialization is a PARSE, not
// an authoring step, and re-running it after a doc edit is safe and
// deterministic.
//
// Invoked via `npm run eval -- --materialize` (the CLI). The emitted fixtures
// are validated with the loader's own `validateFixture` before a single file
// is written; a doc drift that breaks the shape fails the run, not the suite.
// ===========================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CATEGORIES, validateFixture, type Fixture, type WrongMode } from "./fixtures.js";

const CASE_RE = /^### ([A-Z]{3}-\d{2}) · (.+)$/;
const SECTION_RE = /^## ([A-Z]{3}) — /;
const BULLET_RE = /^- (Setup|Input|Expected|Wrong|Gates):\s*(.*)$/;

interface RawCase {
  id: string;
  title: string;
  fields: Record<string, string>;
  doc: "V1" | "V2";
}

const BY_CAT = new Map(CATEGORIES.filter((c) => !c.authored).map((c) => [c.cat, c]));

/** Extracts every case of the categories we materialize from one doc. */
export function parseDoc(markdown: string, doc: "V1" | "V2"): RawCase[] {
  const cases: RawCase[] = [];
  let category: string | null = null;
  let current: RawCase | null = null;
  let field: string | null = null;

  const flush = () => {
    if (current) cases.push(current);
    current = null;
    field = null;
  };

  for (const line of markdown.split("\n")) {
    const section = SECTION_RE.exec(line);
    if (section) {
      flush();
      category = BY_CAT.has(section[1]!) ? section[1]! : null; // SEG et al: skipped
      continue;
    }
    if (line.startsWith("## ")) {
      // A non-category section ("## Coverage map — …") ends parsing of cases.
      flush();
      category = null;
      continue;
    }
    const head = CASE_RE.exec(line);
    if (head) {
      flush();
      if (!category) continue;
      if (head[1]!.slice(0, 3) !== category) {
        throw new Error(`${doc}: case ${head[1]} appears under section ${category}`);
      }
      current = { id: head[1]!, title: head[2]!.trim(), fields: {}, doc };
      continue;
    }
    if (!current) continue;
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      field = bullet[1]!;
      current.fields[field] = bullet[2]!.trim();
      continue;
    }
    // Continuation of the current bullet (the docs wrap with indented lines).
    if (field && line.trim() !== "" && !line.startsWith("#") && !line.startsWith("* * *")) {
      current.fields[field] = `${current.fields[field]} ${line.trim()}`.trim();
    }
  }
  flush();
  return cases;
}

/** "`time-blender` (one mega-bundle) · `stream-shatter` (…)" → WrongMode[]. */
export function parseWrong(text: string): WrongMode[] {
  const out: WrongMode[] = [];
  for (const part of text.split("·")) {
    const chunk = part.trim().replace(/\.$/, "");
    if (chunk === "") continue;
    const label = /`([^`]+)`/.exec(chunk)?.[1];
    if (!label) {
      // A prose-only wrong mode: slug the head, keep the whole text as detail.
      const slug = chunk
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .slice(0, 4)
        .join("-");
      if (slug) out.push({ label: slug, assert_absent: chunk });
      continue;
    }
    const detail = chunk
      .replace(/`[^`]+`/, "")
      .trim()
      .replace(/^\(/, "")
      .replace(/\)$/, "")
      .replace(/^[—–-]\s*/, "")
      .trim();
    out.push({
      label: label.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      assert_absent: detail || `the '${label}' failure mode`,
    });
  }
  return out;
}

/** "containment, bundle_purity." / "trace_coverage = 100% (hard)." → ids. */
export function parseGates(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,·]/)) {
    const token = /[a-z][a-z0-9_]*/.exec(part.trim())?.[0];
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/** A parenthetical containing "code" in the title marks a deterministic case. */
export function isCodeCase(cat: string, title: string): boolean {
  if (cat === "BND") return true; // every bundling case is code-asserted (authored since S3.3; kept for the doc parser)
  return /\([^)]*\bcode\b[^)]*\)/i.test(title);
}

/**
 * The V2 doc's header carries ONE case in full structured form ("shown once,
 * then cases are written compactly") — its body in the ROL section just says
 * "(Full fixture above.)". This pulls that fenced JSON example so ROL-01
 * materializes from it.
 */
export function extractHeaderExample(markdown: string): Record<string, unknown> | null {
  const fence = /```json\n([\s\S]*?)```/.exec(markdown);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function toFixture(raw: RawCase, headerExample?: Record<string, unknown> | null): Fixture {
  const cat = raw.id.slice(0, 3);
  const info = BY_CAT.get(cat);
  if (!info) throw new Error(`${raw.id}: category ${cat} is not materialized`);

  if (headerExample && headerExample.id === raw.id) {
    const ex = headerExample as {
      setup?: unknown;
      input_events?: unknown[];
      expected?: unknown;
      wrong?: WrongMode[];
      gates?: string[];
    };
    return validateFixture(
      {
        id: raw.id,
        category: cat,
        title: raw.title,
        pass: info.pass,
        mode: isCodeCase(cat, raw.title) ? "code" : "live",
        setup: ex.setup,
        input_events: ex.input_events,
        expected: ex.expected,
        wrong: ex.wrong,
        gates: ex.gates,
        source: { doc: raw.doc, section: `${raw.id} · ${raw.title} (full fixture in the doc header)` },
      },
      `<materialize:${raw.id}>`,
    );
  }

  const missing = ["Setup", "Input", "Expected", "Wrong", "Gates"].filter((f) => !raw.fields[f]);
  if (missing.length > 0) throw new Error(`${raw.id}: doc case is missing ${missing.join(", ")}`);
  const fixture = {
    id: raw.id,
    category: cat,
    title: raw.title,
    pass: info.pass,
    mode: isCodeCase(cat, raw.title) ? "code" : "live",
    setup: raw.fields.Setup,
    input_events: [raw.fields.Input],
    expected: raw.fields.Expected,
    wrong: parseWrong(raw.fields.Wrong!),
    gates: parseGates(raw.fields.Gates!),
    source: { doc: raw.doc, section: `${raw.id} · ${raw.title}` },
  };
  // Validate with the loader's own checker so a doc drift fails HERE.
  return validateFixture(fixture, `<materialize:${raw.id}>`);
}

export interface MaterializeResult {
  fixtures: Fixture[];
  written: string[];
}

/**
 * True when the fixture file on disk is a case of the GoldenEvals V6 P1 SEED
 * GOLD SET (§5) written by hand at an id the V1/V2 docs also define — kept,
 * never regenerated. Today that is exactly TSK-01/02, SCH-01..03 and FUP-01
 * (§5.17, build S5.2): every other §5 category is `authored: true` in
 * `CATEGORIES` and so never reaches the doc parser at all.
 *
 * The §5 anchor matters: carried V2 cases (ROL, CIR) carry a
 * "GoldenEvals V6P1 §1.1 (carried)" section and must keep regenerating.
 */
export function isV6P1Authored(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { source?: { section?: unknown } };
    const section = parsed.source?.section;
    return typeof section === "string" && /^GoldenEvals V6 ?P1 §5\b/i.test(section);
  } catch {
    return false; // missing or unreadable → regenerate as before
  }
}

export function materializeDocs(v1Markdown: string, v2Markdown: string): Fixture[] {
  const example = extractHeaderExample(v2Markdown);
  const raws = [...parseDoc(v1Markdown, "V1"), ...parseDoc(v2Markdown, "V2")];
  const fixtures = raws.map((raw) => toFixture(raw, example));
  const perCat = new Map<string, number>();
  for (const f of fixtures) perCat.set(f.category, (perCat.get(f.category) ?? 0) + 1);
  for (const c of CATEGORIES) {
    if (c.authored) continue; // V6 P1 hand-authored categories (SRC…) live outside the two docs
    const have = perCat.get(c.cat) ?? 0;
    if (have !== c.n) {
      throw new Error(`materialize: ${c.cat} produced ${have} cases, the ${c.doc} doc's table says ${c.n}`);
    }
  }
  return fixtures;
}

/** Reads both docs from the repo root and writes `evals/v13/<ID>.json`. */
export function materialize(repoRoot: string): MaterializeResult {
  const v1 = readFileSync(join(repoRoot, "SuperTwinV13_GoldenEvals_V1.md"), "utf8");
  const v2 = readFileSync(join(repoRoot, "SuperTwinV13_GoldenEvals_V2.md"), "utf8");
  const fixtures = materializeDocs(v1, v2);
  const dir = join(repoRoot, "evals", "v13");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const fixture of fixtures) {
    const path = join(dir, `${fixture.id}.json`);
    // A V1/V2 id re-authored by GoldenEvals V6 P1 §5 (TSK-01/02, SCH-01..03,
    // FUP-01 — S5.2) is hand-written code; the doc parser must not clobber it.
    if (isV6P1Authored(path)) continue;
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    written.push(path);
  }
  return { fixtures, written };
}
