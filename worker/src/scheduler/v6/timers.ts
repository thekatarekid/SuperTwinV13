// ===========================================================================
// Schedule timer service (build P3.2, spec §11.2.3 + SCH-08).
//
// Deterministic timer: fires due schedules → enqueues executor tasks. The
// model never fires anything — a task fires because its row says
// status='scheduled' with a due fire_at, and it says that only after the
// code-side policy gate (P3.1) or an explicit user confirmation.
//
//   FIRE      status 'scheduled' + fire_at ≤ now → atomic claim (the UPDATE
//             ... WHERE status='scheduled' is the double-fire guard) → a
//             durable executor_run row + a decisions row → status
//             'executing'. The executor (P3.3) drains executor_run rows —
//             or is injected as the sink directly.
//   LATE      a fire missed while the machine slept executes on the next
//             tick with late=true, as long as its validity window (polling
//             .until, else the task's due, else fire_at + the default late
//             window) still holds (SCH-08 "late-execute if valid").
//   EXPIRED   past the window → the fire is SKIPPED with a note: the task
//             returns to 'open', a decisions row says why, nothing enqueues
//             (SCH-08 "skip+note if expired"). No lost-fire either way: a
//             schedule row is always resolved to fired or skipped.
//   POLLING   {intervalMs, until, maxPolls} (capped at write time by
//             schedule-policy): each poll fire re-arms fire_at += interval
//             and stays 'scheduled' until the cap/until/terminal fire —
//             an executor that completes the task ends the loop early
//             because the task leaves 'scheduled'.
//
// Everything takes `now` as a parameter — the tests are clock-mocked; the
// production service just calls tick on an interval and once at boot (which
// also opens the P1 deferred pen via replayDeferredOutputs).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { replayDeferredOutputs, type ScheduleJson } from "../../brain/decide-apply.js";
import { getDb } from "../../db/connection.js";
import { writeDecision } from "../../db/decisions.js";
import { classifyFire, type FireClass } from "./schedule-policy.js";

/** One fire handed to the executor sink. */
export interface TimerFire {
  taskId: string;
  spaceId: string | null;
  title: string;
  /** True when this fire executes past its window start (SCH-08 "late" flag). */
  late: boolean;
  /** How far past fire_at this fire executed, ms (0 when on time) — SCH-03 "delay shown". */
  delayMs: number;
  /** 1-based poll count for polling schedules; null for a one-shot fire. */
  poll: number | null;
  /** The schedule's own derivation note, for the executor's context. */
  reason: string | null;
  firedAt: string;
}

export type TimerSink = (fire: TimerFire) => void;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

/**
 * The default executor handoff: a durable `deferred_outputs` row (kind
 * 'executor_run') the executor (P3.3) drains. Durable on purpose — a crash
 * between fire and execution loses nothing; the fire is already traced.
 */
export function defaultExecutorSink(fire: TimerFire): void {
  getDb()
    .prepare(
      `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, created_by)
       VALUES (?, ?, ?, 'executor_run', ?, 'timer')`,
    )
    .run(mintId("def"), fire.spaceId, fire.taskId, JSON.stringify(fire));
}

interface ScheduledRow {
  id: string;
  space_id: string | null;
  title: string;
  due: string | null;
  schedule_json: string;
}

function parseSchedule(json: string): ScheduleJson | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as ScheduleJson) : null;
  } catch {
    return null;
  }
}

function validUntilOf(sched: ScheduleJson, due: string | null): Date | null {
  const untilIso = sched.polling?.until ?? due;
  if (untilIso === null || untilIso === undefined) return null;
  const ms = Date.parse(untilIso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export interface TimerTickReport {
  fired: TimerFire[];
  skipped: { taskId: string; reason: string }[];
  /** Poll fires that re-armed for another round. */
  rearmed: string[];
}

/**
 * One timer tick at `now`: resolve every due schedule to a fire or a skip.
 * Idempotent per fire: the atomic status claim means a concurrent tick (or a
 * re-run at the same instant) cannot double-fire (SCH-08 double-fire guard).
 */
export function tickTimers(now: Date, sink: TimerSink = defaultExecutorSink): TimerTickReport {
  const db = getDb();
  const report: TimerTickReport = { fired: [], skipped: [], rearmed: [] };
  const rows = db
    .prepare(
      `SELECT id, space_id, title, due, schedule_json FROM tasks
        WHERE status = 'scheduled' AND schedule_json IS NOT NULL
        ORDER BY id`,
    )
    .all() as ScheduledRow[];

  for (const row of rows) {
    const sched = parseSchedule(row.schedule_json);
    if (sched === null || sched.mode !== "auto" || sched.fire_at === null) continue;
    const fireMs = Date.parse(sched.fire_at);
    if (Number.isNaN(fireMs) || fireMs > now.getTime()) continue;

    const fireAt = new Date(fireMs);
    const klass: FireClass = classifyFire(fireAt, now, validUntilOf(sched, row.due));

    if (klass === "expired") {
      // Skip + note — never a silent lost fire (SCH-08).
      const claimed = db
        .prepare(
          `UPDATE tasks SET status = 'open', schedule_json = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status = 'scheduled'`,
        )
        .run(JSON.stringify({ ...sched, skipped_at: now.toISOString() }), row.id);
      if (claimed.changes === 0) continue; // someone else resolved it
      const reason =
        `fire ${sched.fire_at} missed and its window passed by ` +
        `${now.toISOString()} — skipped, not executed late`;
      writeDecision({
        runId: null,
        pass: "timer",
        targetKind: "task",
        targetId: row.id,
        action: "schedule_skipped",
        old: { status: "scheduled", scheduleJson: sched },
        new: { status: "open", skippedAt: now.toISOString() },
        reason,
      });
      report.skipped.push({ taskId: row.id, reason });
      continue;
    }

    const late = klass === "late";
    const polling = sched.polling ?? null;
    const pollsDone = sched.polls_done ?? 0;
    const isPoll = polling !== null;
    const nextFireMs = fireMs + (polling?.intervalMs ?? 0);
    const untilMs =
      polling?.until != null && !Number.isNaN(Date.parse(polling.until))
        ? Date.parse(polling.until)
        : null;
    const rearm =
      isPoll && pollsDone + 1 < polling.maxPolls && (untilMs === null || nextFireMs <= untilMs);

    const nextSched: ScheduleJson = {
      ...sched,
      fired_at: now.toISOString(),
      ...(late ? { late: true } : {}),
      ...(isPoll ? { polls_done: pollsDone + 1 } : {}),
      // A re-armed poll advances its fire_at and stays 'scheduled'.
      ...(rearm ? { fire_at: new Date(nextFireMs).toISOString() } : {}),
    };
    // THE double-fire guard: only the tick that flips the row owns the fire.
    const claimed = db
      .prepare(
        `UPDATE tasks SET status = ?, schedule_json = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'scheduled'`,
      )
      .run(rearm ? "scheduled" : "executing", JSON.stringify(nextSched), row.id);
    if (claimed.changes === 0) continue;

    const delayMs = late ? Math.max(0, now.getTime() - fireMs) : 0;
    const fire: TimerFire = {
      taskId: row.id,
      spaceId: row.space_id,
      title: row.title,
      late,
      delayMs,
      poll: isPoll ? pollsDone + 1 : null,
      reason: sched.reason ?? null,
      firedAt: now.toISOString(),
    };
    writeDecision({
      runId: null,
      pass: "timer",
      targetKind: "task",
      targetId: row.id,
      action: "fire_schedule",
      old: { status: "scheduled", fireAt: sched.fire_at },
      new: { status: rearm ? "scheduled" : "executing", fire },
      reason: late
        ? `late fire: due ${sched.fire_at}, executed ${now.toISOString()} — ${Math.round(delayMs / 60_000)} min late (still inside the window)`
        : null,
    });
    sink(fire);
    report.fired.push(fire);
    if (rearm) report.rearmed.push(row.id);
  }
  return report;
}

/**
 * Boot-time pass: open the P1 deferred pen (replay held schedule/follow-up
 * candidates through the live policy) and run one immediate tick — which is
 * also the sleep-wake recovery path: everything missed while the process was
 * down resolves to a late fire or a skip+note right here.
 */
export function bootTimers(now: Date = new Date(), sink: TimerSink = defaultExecutorSink): TimerTickReport {
  replayDeferredOutputs(now);
  return tickTimers(now, sink);
}

export interface TimerService {
  stop(): void;
  /** Run one tick immediately (returns its report). */
  tickNow(): TimerTickReport;
}

export const TIMER_TICK_INTERVAL_MS = 30_000;

/**
 * The production service: boot (replay + immediate tick), then tick on an
 * interval. A wall-clock gap much larger than the interval (sleep) needs no
 * special case — the next tick sees the overdue fire_at values and the
 * late/expired classification does the rest — but it is logged for the trace.
 */
export function startTimerService(
  opts: {
    intervalMs?: number;
    now?: () => Date;
    sink?: TimerSink;
    log?: (line: string) => void;
  } = {},
): TimerService {
  const intervalMs = opts.intervalMs ?? TIMER_TICK_INTERVAL_MS;
  const nowFn = opts.now ?? (() => new Date());
  const sink = opts.sink ?? defaultExecutorSink;
  const log = opts.log ?? ((line: string) => console.error(line));

  let lastTick = nowFn().getTime();
  const boot = bootTimers(nowFn(), sink);
  if (boot.fired.length > 0 || boot.skipped.length > 0) {
    log(
      `[timers] boot recovery: ${boot.fired.length} fired ` +
        `(${boot.fired.filter((f) => f.late).length} late), ${boot.skipped.length} skipped`,
    );
  }

  const handle = setInterval(() => {
    const now = nowFn();
    if (now.getTime() - lastTick > intervalMs * 4) {
      log(`[timers] wake: ${Math.round((now.getTime() - lastTick) / 1000)}s since last tick — recovering`);
    }
    lastTick = now.getTime();
    try {
      tickTimers(now, sink);
    } catch (err) {
      log(`[timers] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, intervalMs);
  handle.unref?.();

  return {
    stop(): void {
      clearInterval(handle);
    },
    tickNow(): TimerTickReport {
      const now = nowFn();
      lastTick = now.getTime();
      return tickTimers(now, sink);
    },
  };
}
