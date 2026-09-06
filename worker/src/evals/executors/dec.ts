// ===========================================================================
// [CODE] DEC — decide executor (GoldenEvals V6 P1 §5.17 DEC-01..06; S3.7).
//
// Deterministic, zero model calls. Each case seeds one space (card, chapters,
// open tasks, episodes with real event rows), hands the fixture's canned
// decide.v9 output to the REAL pass (brain/decide-pass.ts → decide-apply →
// scheduler/v6/schedule-policy → brain/closure-check.ts) through a stub
// provider with the clock pinned to FIXTURE_NOW, then reads the database
// back. What is graded is the CODE around the model: routing to a stage,
// closure discipline, the schedule gate (never early, auto only for a
// read-only check), ownership, and "milestones only if staged".
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { addEpisodeEvents } from "../../db/v6core.js";
import { runDecidePass, type DecidePassResult } from "../../brain/decide-pass.js";
import { runClosureChecks, CLOSURE_CHECK_KIND, type ClosureCheckReport } from "../../brain/closure-check.js";
import type { JsonPassDeps } from "../../brain/llm.js";
import type { Provider, Usage } from "../../providers/types.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { FIXTURE_NOW, fixtureNow } from "./clock.js";

const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

/** A provider that answers every call with the fixture's canned JSON. */
function cannedProvider(text: string): Provider & { calls: number } {
  const p = {
    id: "eval-canned",
    calls: 0,
    cancel: () => false,
    async send(opts: Parameters<Provider["send"]>[0]) {
      p.calls += 1;
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "eval", usage: USAGE });
      return { sessionId: "eval", usage: USAGE, freshFallback: false, status: "ok" as const };
    },
  };
  return p;
}

interface TaskRow {
  id: string;
  title: string;
  type: string;
  category: string | null;
  risk_class: string;
  owner: string;
  status: string;
  due: string | null;
  schedule_json: string | null;
  chapter_id: string | null;
}

interface Seeded {
  spaceId: string;
  eventIds: string[];
  episodeIds: string[];
  /** fixture alias (e1..) → event id */
  alias: Map<string, string>;
}

/** Seed the fixture's world: space, chapters, tasks, events, episodes. */
function seed(id: string, setup: Record<string, unknown>): Seeded {
  const db = getDb();
  const sp = rec(setup.space);
  const spaceId = str(sp.id) ?? `sp_${id.toLowerCase()}`;
  db.prepare(
    `INSERT INTO spaces (id, label, goal, status, plan_json, summary, latest, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'eval', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(
    spaceId,
    str(sp.label) ?? `eval ${id}`,
    str(sp.goal),
    str(sp.status) ?? "active",
    sp.plan === undefined ? null : JSON.stringify(sp.plan),
    str(sp.summary),
    str(sp.latest),
  );
  for (const c of list(setup.chapters)) {
    db.prepare(
      `INSERT INTO chapters (id, space_id, label, status, target_date, created_by) VALUES (?, ?, ?, ?, ?, 'eval')`,
    ).run(str(c.id) ?? `ch_${id}_${Math.random().toString(36).slice(2, 8)}`, spaceId, str(c.label) ?? "stage", str(c.status) ?? "active", str(c.target));
  }
  for (const t of list(setup.tasks)) {
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due, status, evidence_json, created_by, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'eval', ?)`,
    ).run(
      str(t.id) ?? `tsk_${id}_${Math.random().toString(36).slice(2, 8)}`,
      spaceId,
      str(t.title) ?? "task",
      str(t.type) ?? "explicit",
      str(t.category),
      str(t.risk_class) ?? "advise-only",
      str(t.owner) ?? "self",
      str(t.due),
      str(t.status) ?? "open",
      typeof t.confidence === "number" ? t.confidence : 0.9,
    );
  }

  // Events on one per-case stream, one minute apart, all before FIXTURE_NOW.
  const events = list(setup.events);
  const streamKey = `dec-${id.toLowerCase()}@g.us`;
  const t0 = FIXTURE_NOW.getTime() - (events.length + 5) * 60_000;
  const envelopes: EventEnvelope[] = events.map((e, i) => ({
    ts: new Date(t0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: str(e.stream) ?? streamKey,
    actor: str(e.actor) ?? "self",
    roles: { sender: str(e.actor) ?? "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: str(e.text) ?? `event ${i + 1}`, external_id: `${id}:${i + 1}` },
  }));
  const appended = envelopes.length > 0 ? appendEvents(envelopes, FIXTURE_NOW.getTime()) : { ids: [] as string[] };
  const alias = new Map<string, string>();
  const eventIds: string[] = [];
  appended.ids.forEach((eid, i) => {
    if (eid === "") return;
    alias.set(str(events[i]?.alias) ?? `e${i + 1}`, eid);
    eventIds.push(eid);
  });

  const episodeIds: string[] = [];
  for (const ep of list(setup.episodes)) {
    const epId = str(ep.id) ?? `ep_${id}_${Math.random().toString(36).slice(2, 8)}`;
    const members = (Array.isArray(ep.events) ? ep.events : [])
      .map((a) => alias.get(String(a)))
      .filter((x): x is string => typeof x === "string");
    const streamRow = members.length > 0
      ? (db.prepare(`SELECT stream_id, ts FROM events WHERE id = ?`).get(members[0]) as { stream_id: string | null; ts: string | null })
      : { stream_id: null, ts: null };
    db.prepare(
      `INSERT INTO episodes (id, stream_id, space_id, chapter_id, state, summary, confidence, first_ts, last_ts, created_by)
       VALUES (?, ?, ?, ?, 'open', ?, 0.9, ?, ?, 'eval')`,
    ).run(epId, streamRow.stream_id, spaceId, str(ep.chapter), str(ep.summary) ?? "", streamRow.ts, streamRow.ts);
    addEpisodeEvents(epId, members, "eval");
    episodeIds.push(epId);
  }
  return { spaceId, eventIds, episodeIds, alias };
}

function cleanup(s: Seeded): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM deferred_outputs WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM decide_queue WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM tasks WHERE space_id = ?`).run(s.spaceId);
    if (s.episodeIds.length > 0) {
      const ph = s.episodeIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph})`).run(...s.episodeIds);
    }
    db.prepare(`DELETE FROM episodes WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM chapters WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM spaces WHERE id = ?`).run(s.spaceId);
    if (s.eventIds.length > 0) {
      const ph = s.eventIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM events WHERE id IN (${ph})`).run(...s.eventIds);
    }
  })();
}

/** Resolve e-aliases inside the canned output's evidence to real event ids. */
function resolveAliases(text: string, alias: Map<string, string>): string {
  return text.replace(/"(e\d+)"/g, (m, a: string) => (alias.has(a) ? `"${alias.get(a)}"` : m));
}

export interface DecRun {
  seeded: Seeded;
  result: DecidePassResult;
  tasks: TaskRow[];
  chapters: { id: string; label: string; status: string }[];
  episodes: { id: string; chapter_id: string | null }[];
  checks: { id: string; task_id: string | null; status: string; payload: Record<string, unknown> }[];
  closureRun?: ClosureCheckReport;
  decisions: { action: string; target_id: string; new_json: string | null }[];
  providerCalls: number;
}

/** Seed, run the real pass on the canned output, read back. */
export async function runDecCase(id: string, setup: unknown, now: Date = fixtureNow()): Promise<DecRun> {
  const s = rec(setup);
  const seeded = seed(id, s);
  const canned = resolveAliases(JSON.stringify(s.decide ?? {}), seeded.alias);
  const provider = cannedProvider(canned);
  const deps: JsonPassDeps = {
    provider,
    now: () => new Date(now.getTime()),
    // No ledger rows for a canned answer: the eval DB never counts this as a model call.
    recordRun: () => `eval-${id}`,
    logExtractionRun: () => undefined,
  };
  const result = await runDecidePass(seeded.spaceId, seeded.episodeIds, deps);
  const db = getDb();
  const read = (): Omit<DecRun, "seeded" | "result" | "providerCalls" | "closureRun"> => ({
    tasks: db
      .prepare(
        `SELECT id, title, type, category, risk_class, owner, status, due, schedule_json, chapter_id
           FROM tasks WHERE space_id = ? ORDER BY created_at, rowid`,
      )
      .all(seeded.spaceId) as TaskRow[],
    chapters: db.prepare(`SELECT id, label, status FROM chapters WHERE space_id = ? ORDER BY created_at, rowid`).all(seeded.spaceId) as DecRun["chapters"],
    episodes: db.prepare(`SELECT id, chapter_id FROM episodes WHERE space_id = ?`).all(seeded.spaceId) as DecRun["episodes"],
    checks: (
      db
        .prepare(`SELECT id, task_id, status, payload_json FROM deferred_outputs WHERE space_id = ? AND kind = ?`)
        .all(seeded.spaceId, CLOSURE_CHECK_KIND) as { id: string; task_id: string | null; status: string; payload_json: string }[]
    ).map((r) => ({ id: r.id, task_id: r.task_id, status: r.status, payload: rec(JSON.parse(r.payload_json)) })),
    decisions: db
      .prepare(
        `SELECT action, target_id, new_json FROM decisions
          WHERE target_id = ? OR target_id IN (SELECT id FROM tasks WHERE space_id = ?)
             OR target_id IN (SELECT id FROM episodes WHERE space_id = ?)
          ORDER BY rowid`,
      )
      .all(seeded.spaceId, seeded.spaceId, seeded.spaceId) as DecRun["decisions"],
  });
  let closureRun: ClosureCheckReport | undefined;
  if (typeof s.advance_clock_to === "string") {
    closureRun = runClosureChecks(new Date(s.advance_clock_to));
  }
  return { seeded, result, ...read(), ...(closureRun ? { closureRun } : {}), providerCalls: provider.calls };
}

const chapterLabel = (run: DecRun, chapterId: string | null): string | null =>
  run.chapters.find((c) => c.id === chapterId)?.label ?? null;

const taskLike = (run: DecRun, re: RegExp): TaskRow | undefined => run.tasks.find((t) => re.test(t.title));

/** Per-case assertions; each returns the violations it found. */
function assertCase(id: string, run: DecRun, expected: Record<string, unknown>): Violation[] {
  const v: Violation[] = [];
  switch (id) {
    case "DEC-01": {
      const want = str(expected.chapter) ?? "Stay";
      const epId = str(expected.episode) ?? run.seeded.episodeIds[0] ?? "";
      const ep = run.episodes.find((e) => e.id === epId);
      const got = ep ? chapterLabel(run, ep.chapter_id) : null;
      if (got !== want) v.push({ label: "misrouted", note: `episode ${epId} landed in ${got ?? "(no stage)"}, expected ${want}` });
      if (run.chapters.length < 2) v.push({ label: "misrouted", note: `staged goal wrote ${run.chapters.length} stage(s)` });
      break;
    }
    case "DEC-02": {
      const flights = taskLike(run, /book flights/i);
      if (!flights || flights.status !== "done") v.push({ label: "missed-closure", note: `book flights is ${flights?.status ?? "missing"}` });
      const checkin = taskLike(run, /check[\s-]?in/i);
      if (!checkin) {
        v.push({ label: "missed-entailment", note: "no web check-in task" });
      } else {
        if (checkin.type !== "implicit") v.push({ label: "missed-entailment", note: `check-in typed ${checkin.type}` });
        const sched = checkin.schedule_json ? rec(JSON.parse(checkin.schedule_json)) : null;
        const wantFire = str(expected.checkin_fire_at) ?? "2026-12-16T01:30:00.000Z";
        if (!sched || sched.mode !== "auto" || checkin.status !== "scheduled") {
          v.push({ label: "confirm-for-obvious", note: `check-in schedule ${sched ? JSON.stringify(sched) : "missing"} status ${checkin.status}` });
        }
        if (sched && sched.fire_at !== wantFire) v.push({ label: "early-fire", note: `fire_at ${String(sched.fire_at)} ≠ ${wantFire}` });
      }
      const cab = taskLike(run, /cab/i);
      if (!cab || cab.type !== "suggested") v.push({ label: "missed-entailment", note: `cab task ${cab ? `typed ${cab.type}` : "missing"}` });
      else if (cab.due !== null && !cab.due.startsWith("2026-12-18")) v.push({ label: "wrong-date", note: `cab due ${cab.due}` });
      break;
    }
    case "DEC-03": {
      const task = run.tasks.find((t) => t.id === (str(expected.task) ?? "tsk_karan_pay"));
      if (!task || task.status !== "open") v.push({ label: "one-sided-close", note: `task is ${task?.status ?? "missing"}` });
      const wantCheck = str(expected.check_at) ?? "2026-08-30T03:30:00.000Z";
      const check = run.checks[0];
      if (!check) v.push({ label: "one-sided-close", note: "no closure check scheduled" });
      else if (check.payload.checkAt !== wantCheck) v.push({ label: "wrong-date", note: `check at ${String(check.payload.checkAt)} ≠ ${wantCheck}` });
      const cr = run.closureRun;
      if (!cr) v.push({ label: "clock-only-call", note: "closure check never ran" });
      else {
        if (cr.modelCalls !== 0 || cr.escalated !== 0) v.push({ label: "clock-only-call", note: `check escalated ${cr.escalated} with no new evidence` });
        if (cr.asked !== 1) v.push({ label: "one-sided-close", note: `expected the "done?" card once, got ${cr.asked}` });
        if (!run.decisions.some((d) => d.action === "ask_done")) v.push({ label: "one-sided-close", note: "no ask_done decision row" });
      }
      break;
    }
    case "DEC-04": {
      const task = run.tasks.find((t) => t.id === (str(expected.task) ?? "tsk_hotel"));
      if (task?.status === "done") v.push({ label: "closed-as-done", note: "cancellation closed as done" });
      if (task?.status !== "cancelled") v.push({ label: "closed-as-done", note: `task is ${task?.status ?? "missing"}, expected cancelled` });
      break;
    }
    case "DEC-05": {
      const theirs = run.tasks.filter((t) => /book the cab/i.test(t.title) && !/^Follow up/i.test(t.title));
      for (const t of theirs) {
        if (t.owner === "self") v.push({ label: "task-theft", note: `"${t.title}" owned by self` });
        if (t.risk_class !== "advise-only") v.push({ label: "task-theft", note: `"${t.title}" risk ${t.risk_class}` });
      }
      const monitor = run.tasks.find((t) => t.category === "monitoring" && t.owner === "self" && /karan/i.test(t.title));
      if (!monitor) v.push({ label: "no-follow-up", note: "the user got no monitoring follow-up" });
      else if (monitor.risk_class !== "advise-only") v.push({ label: "task-theft", note: `monitor risk ${monitor.risk_class}` });
      break;
    }
    case "DEC-06": {
      if (run.chapters.length !== 0) v.push({ label: "phantom-milestones", note: `${run.chapters.length} stage(s) on a one-shot goal` });
      if (run.result.applied.milestonesDropped < 1) v.push({ label: "phantom-milestones", note: "the lone milestone was not dropped" });
      break;
    }
    default:
      v.push({ label: "unknown-case", note: `no DEC assertions for ${id}` });
  }
  if (run.result.status !== "ok" && run.result.status !== "repaired") {
    v.push({ label: "pass-failed", note: `decide status ${run.result.status}: ${run.result.error?.message ?? ""}` });
  }
  return v;
}

export const decideSpaceExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  const run = await runDecCase(fixture.id, setup);
  try {
    const violations = assertCase(fixture.id, run, rec(fixture.expected));
    const result: ExecutorResult = {
      ok: violations.length === 0,
      output: {
        applied: run.result.applied,
        tasks: run.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          category: t.category,
          risk_class: t.risk_class,
          owner: t.owner,
          status: t.status,
          due: t.due,
          schedule: t.schedule_json ? JSON.parse(t.schedule_json) : null,
          chapter: chapterLabel(run, t.chapter_id),
        })),
        milestones: run.chapters,
        episodes: run.episodes.map((e) => ({ id: e.id, chapter: chapterLabel(run, e.chapter_id) })),
        closure_checks: run.checks,
        ...(run.closureRun ? { closure_check_run: run.closureRun } : {}),
        decisions: run.decisions.map((d) => d.action),
      },
      violations,
      metrics: {
        model_calls: 0,
        canned_answers: run.providerCalls,
        tasks: run.tasks.length,
        milestones: run.chapters.length,
        checks_scheduled: run.result.applied.checksScheduled,
        tasks_monitored: run.result.applied.tasksMonitored,
        milestones_dropped: run.result.applied.milestonesDropped,
      },
      notes: ["canned decide.v9 output through the real pass; clock pinned to FIXTURE_NOW (2026-08-29 09:00 IST)"],
    };
    return result;
  } finally {
    cleanup(run.seeded);
  }
};
