// ===========================================================================
// PHASE 3 GATE — the five global invariants, asserted in one place.
//
// Each of these is already true somewhere: `promote-store.test.ts` proves the
// schema has no `spaces`, `supersede.test.ts` proves precedence is `stated_at`,
// `state.test.ts` proves nothing is born past-due as open, `codefacts.test.ts`
// proves no foreign loop reaches Tasks, and `state.test.ts` proves
// `possibly_done` is not a loop state.
//
// This file exists because those are all UNIT proofs, and three of the five
// are stated in the gate as properties of the WHOLE codebase, not of one
// module. A unit test proves the module that owns the rule obeys it. It cannot
// prove that no OTHER module quietly reintroduced it — a second migration that
// creates `spaces`, a new query that orders by `ingested_at`, a new loop writer
// that parks a row in `possibly_done`. So the assertions here are deliberately
// cross-cutting: they run against the fully-migrated schema and against the
// shipped source tree, not against a hand-built fixture.
//
// Nothing here is a substitute for the unit tests. It is the belt to their
// braces, and the thing that fails when a later phase regresses the gate.
// ===========================================================================

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loopCodeFacts, nonSelfLoopsInTasks, tasksFrom, type TaskViewRow } from "./claims/codefacts.js";
import { activeVersion, precedenceOf, type ClaimVersionLike } from "./claims/supersede.js";
import { closeDb, getDb, runMigrations } from "./db/connection.js";
import type { PartySession } from "./entities/party.js";
import { ABOLISHED_STATES, LOOP_STATES, isLoopState, pastDueOpenViolations } from "./loops/state.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-08-16T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-phase3-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- source-tree walk ------------------------------------------------------

/** Every shipped `.ts` under `worker/src`, excluding tests and generated dirs. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * Source lines with `//` comments and whole-line `*` doc bodies removed, so a
 * scan sees CODE and not the paragraphs explaining why the code is the way it
 * is. The rules below are all stated at length in comments; a scanner that
 * cannot tell prose from a statement would flag every explanation.
 */
function codeLines(file: string): { line: number; text: string }[] {
  const raw = readFileSync(file, "utf8").split("\n");
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  raw.forEach((text, i) => {
    let t = text;
    if (inBlock) {
      const end = t.indexOf("*/");
      if (end === -1) return;
      t = t.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = t.indexOf("/*");
      if (open === -1) break;
      const close = t.indexOf("*/", open + 2);
      if (close === -1) {
        t = t.slice(0, open);
        inBlock = true;
        break;
      }
      t = t.slice(0, open) + t.slice(close + 2);
    }
    const slash = t.indexOf("//");
    if (slash !== -1) t = t.slice(0, slash);
    if (t.trim() === "") return;
    out.push({ line: i + 1, text: t });
  });
  return out;
}

// ---- 1. no `spaces` table --------------------------------------------------

describe("INVARIANT — no `spaces` table exists", () => {
  it("the fully-migrated schema has arcs, and nothing named spaces", () => {
    const objects = getDb()
      .prepare(`SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
      .all() as { name: string; type: string }[];
    const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
    expect(tables).toContain("arcs");
    expect(tables).not.toContain("spaces");
    // Not a view either — a view named `spaces` would read as a table to
    // every caller and would reintroduce the concept through the back door.
    expect(objects.map((o) => o.name)).not.toContain("spaces");
  });

  it("promotion is a FIELD on arcs, which is what makes the table unnecessary", () => {
    const cols = (getDb().prepare(`PRAGMA table_info(arcs)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("promoted");
  });

  it("no migration anywhere creates one", () => {
    const dir = join(SRC, "db", "migrations");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".sql") && !name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(dir, name), "utf8");
      expect(source, `${name} creates a spaces table`).not.toMatch(
        /CREATE\s+(TABLE|VIEW)(\s+IF\s+NOT\s+EXISTS)?\s+["'`]?spaces["'`]?\b/i,
      );
    }
  });
});

// ---- 2. claims supersede by stated_at only ---------------------------------

describe("INVARIANT — claims supersede by stated_at only", () => {
  const v = (id: string, statedAt: string): ClaimVersionLike => ({ id, claimKey: "k", statedAt });

  it("the later-SAID version is active regardless of the order it was handed over", () => {
    const older = v("c_zzz", "2026-01-01T00:00:00.000Z");
    const newer = v("c_aaa", "2026-06-01T00:00:00.000Z");
    // Id order and arrival order both favour the OLDER claim here, so if
    // either one leaked into the comparison this would pick the wrong row.
    expect(activeVersion([older, newer], "2026-08-16T12:00:00.000Z")?.id).toBe("c_aaa");
    expect(activeVersion([newer, older], "2026-08-16T12:00:00.000Z")?.id).toBe("c_aaa");
    expect(precedenceOf(older, newer)).toBe("incoming_later");
    expect(precedenceOf(newer, older)).toBe("stored_later");
  });

  it("the precedence algebra cannot see `ingested_at` at all", () => {
    // supersede.ts is the module that decides who wins. The column may not
    // appear in it in ANY form — not a read, not a write, not a fallback for
    // a missing stated_at (§11.6 rule 5, evals R-027).
    const source = readFileSync(join(SRC, "claims", "supersede.ts"), "utf8");
    for (const { text } of codeLines(join(SRC, "claims", "supersede.ts"))) {
      expect(text).not.toMatch(/ingested_at|ingestedAt/);
    }
    // And the comment block still has to SAY so, because the rule has been
    // got wrong before and the explanation is what stops the fourth time.
    expect(source).toMatch(/ingested_at/);
  });

  it("no shipped claims or loops module COMPARES or ORDERS BY `ingested_at`", () => {
    // The column is written for audit — `write.ts` inserts it and that is
    // legitimate. What may never happen is a read on the precedence path: an
    // ORDER BY, a WHERE, or a JS comparison. That is the regression this
    // catches, and it is narrower than "the word never appears" on purpose.
    const READ_CONTEXT = /ORDER\s+BY|WHERE|GROUP\s+BY|HAVING|[<>]=?|={2,3}|!==?|localeCompare|Date\.parse/i;
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (!rel.startsWith("claims/") && !rel.startsWith("loops/")) continue;
      for (const { line, text } of codeLines(file)) {
        if (!/ingested_at|ingestedAt/.test(text)) continue;
        if (READ_CONTEXT.test(text)) offenders.push(`${rel}:${line}: ${text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the active-claim view orders by stated_at, never by arrival", () => {
    const sql = (
      getDb().prepare(`SELECT sql FROM sqlite_master WHERE name = 'claims_active'`).get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(sql, "claims_active view is missing").toBeTruthy();
    expect(sql!).toMatch(/stated_at\s+DESC/i);
    expect(sql!).not.toMatch(/ingested_at/i);
  });
});

// ---- 3. zero tasks born past-due as open -----------------------------------

describe("INVARIANT — zero tasks born past-due as open", () => {
  it("a past-due loop is only ever open through a projected FUTURE occurrence", () => {
    const corpus = [
      { id: "l1", due_utc: "2024-05-02T18:00:00Z", intent: "book tickets" },
      { id: "l2", due_utc: "2019-01-01T00:00:00Z", recurrence: "none" },
      { id: "l3", due_utc: "2021-07-07T00:00:00Z", recurrence: "unparseable gibberish" },
      { id: "l4", due_utc: "2025-03-04T00:00:00Z", recurrence: "annual" },
      { id: "l5", due_utc: "2015-02-02T00:00:00Z", recurrence: "monthly" },
      {
        id: "l6",
        due_utc: "2010-01-01T00:00:00Z",
        recurrence: "annual",
        recurrence_ends_at: "2012-01-01T00:00:00Z",
      },
    ];
    expect(pastDueOpenViolations(corpus, NOW)).toEqual([]);
  });

  it("holds for a loop due one millisecond ago — the boundary, not just the easy cases", () => {
    const justPast = new Date(NOW - 1).toISOString();
    expect(pastDueOpenViolations([{ id: "edge", due_utc: justPast }], NOW)).toEqual([]);
  });
});

// ---- 4. zero non-self tasks ------------------------------------------------

describe("INVARIANT — zero non-self tasks", () => {
  const ME = "ent_me";
  const PRANJALI = "ent_pranjali";
  const ROHAN = "ent_rohan";
  const SESSION: PartySession = { selfEntityId: ME, participantEntityIds: [ME, PRANJALI] };
  const iso = (ms: number): string => new Date(ms).toISOString();

  const loops = [
    { id: "mine", ownerId: ME, counterpartyId: PRANJALI, origin: "explicit", dueUtc: iso(NOW + 86_400_000) },
    { id: "hers", ownerId: PRANJALI, counterpartyId: ME, origin: "explicit", dueUtc: iso(NOW + 86_400_000) },
    { id: "theirs", ownerId: PRANJALI, counterpartyId: ROHAN, origin: "explicit", dueUtc: iso(NOW + 86_400_000) },
    { id: "third", ownerId: ROHAN, counterpartyId: ROHAN, origin: "implicit", dueUtc: iso(NOW + 86_400_000) },
  ];

  it("only the loop I own reaches Tasks — the other three are context", () => {
    const tasks = tasksFrom(loops, SESSION, NOW);
    expect(tasks.map((t) => t.loop.id)).toEqual(["mine"]);
  });

  it("the audit over the real view is empty, and is not vacuously empty", () => {
    const tasks = tasksFrom(loops, SESSION, NOW);
    expect(nonSelfLoopsInTasks(tasks)).toEqual([]);
    // Proof the audit can fail: hand it the loops the view REJECTED and it
    // names them. An always-[] function would prove nothing above.
    const rejected: TaskViewRow<{ id: string }>[] = loops
      .filter((l) => l.id !== "mine")
      .map((l) => ({ loop: { id: l.id }, facts: loopCodeFacts(l, SESSION, NOW) }));
    expect(nonSelfLoopsInTasks(rejected).length).toBeGreaterThan(0);
  });

  it("every loop owned by someone else is triaged context, so both filters agree", () => {
    for (const loop of loops) {
      if (loop.ownerId === ME) continue;
      expect(loopCodeFacts(loop, SESSION, NOW).triage).toBe("context");
    }
  });
});

// ---- 5. `possibly_done` does not exist -------------------------------------

describe("INVARIANT — `possibly_done` does not exist", () => {
  it("is not a loop state, by either the list or the predicate", () => {
    expect(LOOP_STATES as readonly string[]).not.toContain("possibly_done");
    expect(isLoopState("possibly_done")).toBe(false);
    expect(ABOLISHED_STATES).toContain("possibly_done");
  });

  it("appears in no shipped statement outside the abolition registry", () => {
    // Prose may say the word — the codebase explains at length WHY the state
    // is gone, and deleting the explanation would be the worse outcome. What
    // may not exist is a STATEMENT mentioning it: an assignment, a comparison,
    // a string literal in a query. The two exemptions are the registry that
    // names it as abolished and the guard that reads that registry.
    const allowed = new Set(["loops/state.ts", "loops/done.ts"]);
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (allowed.has(rel)) continue;
      for (const { line, text } of codeLines(file)) {
        if (text.includes("possibly_done")) offenders.push(`${rel}:${line}: ${text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the two exempt files mention it only to abolish it", () => {
    const stateLines = codeLines(join(SRC, "loops", "state.ts")).filter((l) =>
      l.text.includes("possibly_done"),
    );
    // Exactly one statement: the ABOLISHED_STATES registry.
    expect(stateLines).toHaveLength(1);
    expect(stateLines[0]!.text).toMatch(/ABOLISHED_STATES/);

    const doneLines = codeLines(join(SRC, "loops", "done.ts")).filter((l) =>
      l.text.includes("possibly_done"),
    );
    // done.ts names it only as the RULE label it reports when it refuses one.
    for (const l of doneLines) {
      expect(l.text, `done.ts:${l.line}`).toMatch(/possibly_done_does_not_exist/);
    }
  });

  it("no migration writes it into the schema", () => {
    const dir = join(SRC, "db", "migrations");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".sql") && !name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts")) continue;
      expect(readFileSync(join(dir, name), "utf8"), name).not.toContain("possibly_done");
    }
  });
});
