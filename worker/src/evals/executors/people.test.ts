// ===========================================================================
// ROL / CIR / CRM executors (V6 P1 S5.4): all nineteen cases run against the
// real fixtures in evals/v13 through the real people code — sandboxed DB,
// zero model calls, and every case leaves the store as it found it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { circlesExecutor, crmExecutor, rolesExecutor } from "./people.js";
import { registerProductExecutors } from "./index.js";
import type { Executor, ExecutorResult } from "../runner.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-people-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_EVAL_DRAFTS_DIR = join(tmpDir, "eval-drafts");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function tableCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function run(executor: Executor, id: string, pass: string): Promise<ExecutorResult> {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe(pass);
  const r = await executor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // The ledger is the truth: a code case that spent a call would have a run row.
  expect(tableCount("runs")).toBe(0);
  return r;
}

const out = (r: ExecutorResult): Record<string, unknown> => r.output as Record<string, unknown>;

describe("registration", () => {
  it("wires orient+extract (the baseline had none), circles and crm", async () => {
    await registerProductExecutors();
    const passes = registeredPasses();
    expect(passes).toContain("orient+extract");
    expect(passes).toContain("circles");
    expect(passes).toContain("crm");
  });
});

describe("ROL — the resolution ladder", () => {
  it("ROL-01: @mention places the task on Karan, self never owns it, and self's answer closes", async () => {
    const r = await run(rolesExecutor, "ROL-01", "orient+extract");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const roles = out(r).roles as Record<string, unknown>[];
    expect(roles[0]).toMatchObject({ message: "e1", receiver: ["k1"], rung: "structural" });
    expect(roles[2]).toMatchObject({ message: "e3", receiver: ["self"], rung: "named" });
    expect(out(r).closure).toMatchObject({ closes: true });
    expect(r.metrics!.model_rungs_used).toBe(0);
  });

  it("ROL-02: an unaddressed broadcast reaches the whole audience", async () => {
    const r = await run(rolesExecutor, "ROL-02", "orient+extract");
    expect(r.violations).toEqual([]);
    const roles = out(r).roles as Record<string, unknown>[];
    expect(new Set(roles[0]!.receiver as string[])).toEqual(new Set(["self", "rohan", "k1"]));
    expect(roles[0]).toMatchObject({ rung: "broadcast", status: "resolved" });
  });

  it("ROL-03: the audience test is code — Tanvi receives, Dev is a third party", async () => {
    const r = await run(rolesExecutor, "ROL-03", "orient+extract");
    expect(r.violations).toEqual([]);
    const roles = out(r).roles as Record<string, unknown>[];
    expect(roles[0]).toMatchObject({ receiver: ["tanvi"], third_parties: ["dev"] });
    expect(r.metrics!.model_rungs_used).toBe(0);
  });

  it("ROL-04: the pronoun chain lands on Isha, not Ma", async () => {
    const r = await run(rolesExecutor, "ROL-04", "orient+extract");
    expect(r.violations).toEqual([]);
    const pronouns = out(r).pronouns as Record<string, { subject: string; confidence: number }>;
    expect(pronouns.e2!.subject).toBe("isha");
    expect(pronouns.e2!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(pronouns.e3!.subject).toBe("isha");
  });

  it("ROL-05: two candidates queue a question and attribute nothing", async () => {
    const r = await run(rolesExecutor, "ROL-05", "orient+extract");
    expect(r.violations).toEqual([]);
    const o = out(r);
    expect((o.pronoun as { status: string }).status).toBe("unknown");
    expect(o.question).toMatchObject({ kind: "pronoun", status: "open" });
    expect(o.claims_written).toBe(0);
  });

  it("ROL-06: 'bro' is generic — context decides, and with none the ladder asks", async () => {
    const r = await run(rolesExecutor, "ROL-06", "orient+extract");
    expect(r.violations).toEqual([]);
    const o = out(r);
    expect(o.address_term).toMatchObject({ class: "generic", mapsTo: null });
    expect(o.with_context).toMatchObject({ receiver: ["rohan"], rung: "context" });
    expect((o.without_context as { status: string }).status).toBe("unknown");
    expect(o.relationship_claims_written).toBe(0);
  });

  it("ROL-07: six observations make 'boss' discriminating, and the ladder reads the record", async () => {
    const r = await run(rolesExecutor, "ROL-07", "orient+extract");
    expect(r.violations).toEqual([]);
    expect(out(r).address_term).toMatchObject({ class: "discriminating", mapsTo: "sameer" });
    expect((out(r).roles as Record<string, unknown>[])[0]).toMatchObject({ receiver: ["sameer"], rung: "address_term" });
  });

  it("ROL-08: the reply marker beats recency", async () => {
    const r = await run(rolesExecutor, "ROL-08", "orient+extract");
    expect(r.violations).toEqual([]);
    expect((out(r).roles as Record<string, unknown>[])[0]).toMatchObject({ bound_to: "e11", receiver: ["tanvi"], rung: "reply" });
  });

  it("ROL-09: the mention mints a provisional person; 'he' finds them; the hint is not a claim", async () => {
    const r = await run(rolesExecutor, "ROL-09", "orient+extract");
    expect(r.violations).toEqual([]);
    const o = out(r);
    expect(o.person).toMatchObject({ name: "Vivaan", provisional: true });
    expect(o.hint_confidence).toBeLessThan(1);
    expect(String(o.hint_reason)).toMatch(/likely child of isha/);
    expect((o.pronoun as { subject: string }).subject).toBe((o.person as { id: string }).id);
    expect(o.visible_in_people).toBe(true);
    expect(o.relationship_claims_written).toBe(0);
  });

  it("ROL-10: the confirmation writes a new row and keeps the 0.65", async () => {
    const r = await run(rolesExecutor, "ROL-10", "orient+extract");
    expect(r.violations).toEqual([]);
    const history = out(r).history as { id: string; confidence: number; status: string; revised_from: string | null; evidence: number }[];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ confidence: 0.65, status: "revised" });
    expect(history[1]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(history[1]!.revised_from).toBe(history[0]!.id);
    expect(history[1]!.evidence).toBe(2);
    expect(out(r).closure).toMatchObject({ confirms: true });
  });
});

describe("CIR — circles", () => {
  it("CIR-01: the quiet family group outranks the chatty memes group", async () => {
    const r = await run(circlesExecutor, "CIR-01", "circles");
    expect(r.violations).toEqual([]);
    const circles = out(r).circles as { id: string; circle: string }[];
    expect(circles.find((c) => c.id === "fam")!.circle).toBe("family");
    const priority = out(r).priority as { id: string; score: number }[];
    expect(priority.map((p) => p.id)).toEqual(["fam", "memes"]);
  });

  it("CIR-02: sparse service traffic is important-services with a monthly recurrence candidate", async () => {
    const r = await run(circlesExecutor, "CIR-02", "circles");
    expect(r.violations).toEqual([]);
    expect((out(r).inference as { circle: string }).circle).toBe("important_services");
    expect(out(r).recurrence_candidate).toMatchObject({ candidate: true, cadence: "monthly" });
  });

  it("CIR-03: the society broadcast is a note, Ma's ask is a task", async () => {
    const r = await run(circlesExecutor, "CIR-03", "circles");
    expect(r.violations).toEqual([]);
    const streams = out(r).streams as Record<string, { verdict: string; reason: string; direct_address: boolean }>;
    expect(streams.society!.verdict).toBe("note");
    expect(streams.society!.direct_address).toBe(false);
    expect(streams.family!.verdict).toBe("task");
    expect(streams.family!.direct_address).toBe(true);
    expect(streams.society!.reason).not.toBe("");
  });

  it("CIR-04: the drag applies, drafts a case, shifts downstream, and code never undoes it", async () => {
    const r = await run(circlesExecutor, "CIR-04", "circles");
    expect(r.violations).toEqual([]);
    const o = out(r);
    expect(o.correction).toMatchObject({ status: "applied" });
    expect(typeof (o.correction as { eval_draft: unknown }).eval_draft).toBe("string");
    expect(o.circle_after).toBe("close_friends");
    const p = o.priority as { before: number; after: number };
    expect(p.after).toBeGreaterThan(p.before);
    expect(o.dates).toMatchObject({ mode: "plan", leadDays: 7 });
    expect(o.re_inference).toMatchObject({ why: "user-set" });
  });
});

describe("CRM — the personal CRM", () => {
  it("CRM-01: Sameer's Tuesday ask starts acting on Friday", async () => {
    const r = await run(crmExecutor, "CRM-01", "crm");
    expect(r.violations).toEqual([]);
    const radar = out(r).radar as { direction: string; lead_days: number; follow_up_at: string; overdue: boolean }[];
    expect(radar).toHaveLength(1);
    expect(radar[0]).toMatchObject({ direction: "i_owe", lead_days: 3, overdue: true });
    expect(radar[0]!.follow_up_at.slice(0, 10)).toBe("2026-09-04");
    expect(out(r).card_radar).toBe(1);
  });

  it("CRM-02: a 180-member broadcast is not a debt", async () => {
    const r = await run(crmExecutor, "CRM-02", "crm");
    expect(r.violations).toEqual([]);
    expect(out(r).radar).toEqual([]);
  });

  it("CRM-03: the identifier merges the mention-born person forward; two candidates ask", async () => {
    const r = await run(crmExecutor, "CRM-03", "crm");
    expect(r.violations).toEqual([]);
    expect(out(r).merge_forward).toMatchObject({ outcome: "merged" });
    expect(out(r).ambiguous).toMatchObject({ outcome: "queued", candidates: 2 });
  });

  it("CRM-04: 'bro' carries nothing, 'chotu' maps to one person", async () => {
    const r = await run(crmExecutor, "CRM-04", "crm");
    expect(r.violations).toEqual([]);
    const terms = out(r).terms as Record<string, { class: string; mapsTo: string | null }>;
    expect(terms.bro).toMatchObject({ class: "generic", mapsTo: null });
    expect(terms.chotu).toMatchObject({ class: "discriminating", mapsTo: "vivaan" });
    expect((out(r).generic_message as { status: string }).status).toBe("unknown");
    expect(out(r).discriminating_message).toMatchObject({ receiver: ["vivaan"], rung: "address_term" });
  });

  it("CRM-05: quiet family outranks chatty batchmates", async () => {
    const r = await run(crmExecutor, "CRM-05", "crm");
    expect(r.violations).toEqual([]);
    expect((out(r).priority as { id: string }[]).map((p) => p.id)).toEqual(["family", "batchmates"]);
  });
});

describe("every case leaves the store as it found it", () => {
  it("runs all nineteen and writes no lasting rows", async () => {
    const before = {
      entities: tableCount("entities"),
      streams: tableCount("streams"),
      events: tableCount("events"),
      tone: tableCount("tone_profiles"),
      questions: tableCount("questions"),
      resolutions: tableCount("role_resolutions"),
    };
    for (const id of ["ROL-01", "ROL-02", "ROL-03", "ROL-04", "ROL-05", "ROL-06", "ROL-07", "ROL-08", "ROL-09", "ROL-10"]) {
      await rolesExecutor({ fixture: loadFixture(join(FIX, `${id}.json`)) });
    }
    for (const id of ["CIR-01", "CIR-02", "CIR-03", "CIR-04"]) {
      await circlesExecutor({ fixture: loadFixture(join(FIX, `${id}.json`)) });
    }
    for (const id of ["CRM-01", "CRM-02", "CRM-03", "CRM-04", "CRM-05"]) {
      await crmExecutor({ fixture: loadFixture(join(FIX, `${id}.json`)) });
    }
    expect({
      entities: tableCount("entities"),
      streams: tableCount("streams"),
      events: tableCount("events"),
      tone: tableCount("tone_profiles"),
      questions: tableCount("questions"),
      resolutions: tableCount("role_resolutions"),
    }).toEqual(before);
    expect(tableCount("runs")).toBe(0);
  });
});
