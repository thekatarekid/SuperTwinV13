// ===========================================================================
// DIG — the weekly digest executor (GoldenEvals V6 P1 §5.18; V6 P1 S3.8).
// Against the REAL scheduler/v6/digest.ts planner and brain/digest-pass.ts
// (digest.v2) over the real single writer:
//
//   DIG-01  weekly digest only on new weeks           code: a tier-3 stream
//           over 3 weeks, week 2 empty → exactly 2 digest calls, then none
//           (the provider is a canned-JSON stub at the provider layer)
//   DIG-02  digest output shape                       live: summary, claims,
//           recurrences — never a task surfaced as active; asserted by code
//           on what reaches the world (result keys, decisions, tables), the
//           judge grades the prose on top
//
// `empty_week_call` is measured on every case: a digest call whose bundle
// holds no event, or a call for a week the planner should have skipped.
// Registered under pass `digest`; fixtures that are not DIG-* fall through to
// the legacy CAT digest executor (executors/passes.ts).
// ===========================================================================

import { runDigestPass, type DigestPassDeps, type DigestPassReport } from "../../brain/digest-pass.js";
import { getDb } from "../../db/connection.js";
import { DIGEST_FORBIDDEN_KEYS } from "../../prompts/digest.v2.js";
import type { Provider, ProviderResult, SendOptions } from "../../providers/types.js";
import { markDispatched, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import { planDigest, weekKey } from "../../scheduler/v6/digest.js";
import { append, MIN, msgAt, setStreamTier, streamIdOf } from "../../scheduler/v6/testutil.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { CaseWorld } from "./bnd.js";
import { digestExecutor as legacyDigestExecutor } from "./passes.js";

const DAY = 86_400_000;
/** Wednesday 2026-08-26 12:00Z — the week of Mon 08-24 is current and waits. */
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The society group's three weeks; week 2 (Mon 08-10) is empty. */
export const DIG01_WEEKS: Record<string, string[]> = {
  "2026-08-03": ["Water tank cleaning on Thursday 10am-1pm, please store water", "Lift B under maintenance till Saturday"],
  "2026-08-10": [],
  "2026-08-17": ["Reminder: maintenance for Sept due by 5th. UPI to society@okaxis", "Diwali fund collection starts 1 Oct", "Parking stickers ready at the office"],
};

/** The P-06 example week (Mon 2026-08-24 … 08-30), for DIG-02; `now` is past it. */
const DIG02_WEEK = "2026-08-24";
const DIG02_NOW = Date.parse("2026-09-02T09:00:00.000Z");
const DIG02_LINES = [
  ["2026-08-25T09:00:00Z", "Water tank cleaning this Thursday 10am-1pm. Please store water in advance."],
  ["2026-08-26T18:20:00Z", "Lift B will be under maintenance till Saturday. Use lift A."],
  ["2026-08-27T08:30:00Z", "Reminder: maintenance for Sept due by 5th. Pay by UPI to society@okaxis or at the office."],
  ["2026-08-28T19:05:00Z", "Ganpati decoration volunteers needed for the 6th — reply here if free."],
  ["2026-08-30T10:00:00Z", "Parking: sticker renewal for 2026-27 starts Monday at the office, Rs.500 per car."],
] as const;

/** The digest calls a case made, in order. */
export interface DigestCall {
  week: string;
  events: number;
  report: DigestPassReport;
}

/** Plan and run every due digest for the case's streams, marking on success — the dispatcher's digest sink, without the dispatcher. */
async function runDueDigests(w: CaseWorld, nowMs: number, deps: DigestPassDeps): Promise<DigestCall[]> {
  const calls: DigestCall[] = [];
  const plan = planDigest({ nowMs, streamKeyPrefix: w.prefix });
  for (const bundle of plan) {
    const report = await runDigestPass(bundle, deps);
    calls.push({ week: weekOf(bundle), events: bundle.events.length, report });
    if (report.status === "ok") markDispatched(bundle, nowMs);
  }
  return calls;
}

function weekOf(b: DeltaBundle): string {
  const first = b.events.find((e) => e.ts);
  return first?.ts ? weekKey(Date.parse(first.ts)) : b.day ?? "?";
}

function emptyWeekCalls(calls: readonly DigestCall[], seededWeeks: Readonly<Record<string, string[]>>): number {
  return calls.filter((c) => c.events === 0 || (c.week in seededWeeks && seededWeeks[c.week]!.length === 0)).length;
}

type CaseFn = (fixture: Fixture, w: CaseWorld, deps: DigestPassDeps) => Promise<ExecutorResult>;

const dig01: CaseFn = async (fixture, w, deps) => {
  const weeks = rec(fixture.setup).weeks;
  const seeded: Record<string, string[]> =
    weeks && typeof weeks === "object" && !Array.isArray(weeks)
      ? Object.fromEntries(Object.entries(weeks as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []]))
      : DIG01_WEEKS;
  const key = w.key("sunrise-402@g.us");
  const envs = [];
  for (const [week, lines] of Object.entries(seeded)) {
    const monday = Date.parse(`${week}T00:00:00.000Z`);
    lines.forEach((text, i) => envs.push(msgAt(key, monday + (1 + i) * DAY + 9 * 60 * MIN, text, { actor: "contact:secretary", origin: "backfill" })));
  }
  // The current week has a message too — it waits (the week has not ended).
  envs.push(msgAt(key, NOW - 2 * 60 * MIN, "Gate 2 closed for repairs today", { actor: "contact:secretary" }));
  append(envs, NOW);
  const sid = streamIdOf("wa", key);
  setStreamTier(sid, "T3");

  const expectedCalls = Object.values(seeded).filter((l) => l.length > 0).length;
  const planned = planDigest({ nowMs: NOW, streamKeyPrefix: w.prefix }).map((b) => ({ week: weekOf(b), events: b.events.length }));
  const first = await runDueDigests(w, NOW, deps);
  const again = await runDueDigests(w, NOW, deps); // nothing new → nothing planned
  const laterWeekCalls = await runDueDigests(w, NOW + 7 * DAY, deps); // the once-current week has ended → one more

  const violations: Violation[] = [];
  const empty = emptyWeekCalls([...first, ...again, ...laterWeekCalls], seeded);
  if (empty > 0) violations.push({ label: "empty-week-call", note: `${empty} digest call(s) for a week with nothing new` });
  if (again.length > 0) violations.push({ label: "redigest", note: `${again.length} call(s) re-digesting weeks already served` });
  const ok =
    violations.length === 0 &&
    first.length === expectedCalls &&
    first.every((c) => c.report.status === "ok") &&
    planned.length === expectedCalls &&
    laterWeekCalls.length === 1;
  return {
    ok,
    output: {
      planned,
      calls: first.map((c) => ({ week: c.week, events: c.events, status: c.report.status, proposals: c.report.proposals })),
      rerun_calls: again.length,
      next_week_calls: laterWeekCalls.map((c) => ({ week: c.week, events: c.events })),
      expected_calls: expectedCalls,
    },
    violations,
    metrics: { digest_calls: first.length, empty_week_call: empty, model_calls: first.length + again.length + laterWeekCalls.length },
    gateObservations: [{ gateId: "empty_week_call", passed: empty === 0, counted: true }],
  };
};

/** DIG-02's one-week seed + one digest.v2 call; exported so a test can stub the provider. */
export async function runDig02(w: CaseWorld, deps: DigestPassDeps): Promise<{ calls: DigestCall[]; streamId: string }> {
  const key = w.key("sunrise-apartments-402@g.us");
  append(
    DIG02_LINES.map(([ts, text]) => msgAt(key, Date.parse(ts), text, { actor: "contact:secretary", origin: "backfill" })),
    DIG02_NOW,
  );
  const sid = streamIdOf("wa", key);
  setStreamTier(sid, "T3");
  const calls = await runDueDigests(w, DIG02_NOW, deps);
  return { calls, streamId: sid };
}

const dig02: CaseFn = async (_fixture, w, deps) => {
  const { calls, streamId } = await runDig02(w, deps);
  const call = calls[0];
  const report = call?.report;
  const result = report?.result;
  const violations: Violation[] = [];
  const activeViolations = (report?.violations ?? []).filter((v) => v.startsWith("digest-active:"));
  const inflation = (report?.violations ?? []).filter((v) => v.startsWith("digest-inflation:"));
  // What reached the world: nothing active, nothing minted.
  const tables = Object.fromEntries(
    ["tasks", "spaces", "episodes"].map((t) => [t, (getDb().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE created_by = 'digest' OR id LIKE ?`).get(`%${w.prefix}%`) as { n: number }).n]),
  );
  const decisions = getDb()
    .prepare(`SELECT action FROM decisions WHERE pass = 'digest' AND target_id LIKE ?`)
    .all(`${streamId}%`) as { action: string }[];
  const nonPropose = decisions.filter((d) => !["digest_summary", "propose", "propose_recurrence"].includes(d.action));
  if (tables.tasks > 0 || nonPropose.length > 0) violations.push({ label: "active-task", note: `${tables.tasks} task row(s), ${nonPropose.length} non-propose decision(s)` });
  if (result && DIGEST_FORBIDDEN_KEYS.some((k) => k in result)) violations.push({ label: "digest-inflation", note: "a forbidden key reached the parsed result" });
  const resultKeys = result ? Object.keys(result).sort() : [];
  const shape = Boolean(result) && resultKeys.join(",") === "claims,recurrences,summary" && (result?.summary ?? "").trim() !== "";
  const ok = calls.length === 1 && report?.status === "ok" && shape && violations.length === 0;
  return {
    ok,
    output: {
      week: call?.week ?? DIG02_WEEK,
      status: report?.status ?? "not-run",
      error: report?.error,
      digest: result ?? null,
      stripped: inflation,
      active_markers_stripped: activeViolations,
      other_violations: (report?.violations ?? []).filter((v) => !v.startsWith("digest-")),
      decisions: decisions.map((d) => d.action),
      tables,
    },
    seededContext: DIG02_LINES.map(([ts, text], i) => `e${i + 1} ${ts} contact:secretary: ${text}`).join("\n"),
    violations,
    metrics: {
      model_calls: calls.length,
      digest_inflation: inflation.length + activeViolations.length,
      claims: result?.claims.length ?? 0,
      recurrences: result?.recurrences.length ?? 0,
      empty_week_call: emptyWeekCalls(calls, {}),
    },
    gateObservations: [
      { gateId: "digest_inflation", passed: inflation.length + activeViolations.length === 0, counted: Boolean(report) },
      { gateId: "empty_week_call", passed: emptyWeekCalls(calls, {}) === 0, counted: true },
    ],
    notes: inflation.length + activeViolations.length > 0 ? [`the parser stripped and named: ${[...inflation, ...activeViolations].join(", ")}`] : [],
  };
};

const CASES: Record<string, CaseFn> = {
  "DIG-01": dig01,
  "DIG-02": dig02,
};

function cleanupDecisions(w: CaseWorld): void {
  getDb().prepare(`DELETE FROM decisions WHERE pass = 'digest' AND target_id LIKE ?`).run(`%:st:${w.prefix}%`);
}

/**
 * The provider-layer stub a `mode: code` DIG case runs against (GoldenEvals
 * §2.3: code cases never call a model; mocks inject at the provider JSON
 * layer). A valid P-06 answer whose evidence quotes a line every seeded week
 * contains nothing of — so claims resolve to nothing and only the summary
 * lands; the COUNT of calls is the assertion, not the prose.
 */
export function cannedDigestProvider(): Provider {
  const answer = JSON.stringify({ summary: "Society notices for the week.\nNothing needed a reply.", claims: [], recurrences: [] });
  return {
    id: "dig-canned",
    async send(opts: SendOptions): Promise<ProviderResult> {
      opts.onEvent({ type: "delta", text: answer });
      return {
        sessionId: "canned",
        usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        freshFallback: false,
        status: "ok",
      };
    },
    cancel: () => false,
  };
}

/** One DIG case; `deps` lets a test hand in a stub provider (the CLI passes none → the real one for live cases, the canned stub for code cases). */
export async function runDigCase(fixture: Fixture, deps: DigestPassDeps = {}): Promise<ExecutorResult> {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`DIG executor: no case for ${fixture.id}`);
  const w = new CaseWorld(fixture.id);
  const effective: DigestPassDeps = fixture.mode === "code" && !deps.provider ? { ...deps, provider: cannedDigestProvider() } : deps;
  try {
    const result = await run(fixture, w, effective);
    const note = fixture.mode === "code" ? "planner + digest.v2 pass with a provider-layer stub; the count is the assertion" : "digest.v2 through the traced, pooled provider path; shape asserted by code, prose by the judge";
    return { ...result, notes: [...(result.notes ?? []), note] };
  } finally {
    cleanupDecisions(w);
    w.cleanup();
  }
}

export const isDigFixture = (fixture: Fixture): boolean => fixture.category === "DIG";

/** Registered under pass `digest`: DIG-* here, everything else to the legacy CAT executor. */
export const digExecutor: Executor = async (ctx) => (isDigFixture(ctx.fixture) ? runDigCase(ctx.fixture) : legacyDigestExecutor(ctx));
