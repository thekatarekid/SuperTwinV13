// ===========================================================================
// [CODE] SPC — spaces (GoldenEvals V6 P1 §5.19 SPC-01..08; V6 P1 S5.1).
//
// Deterministic, zero model calls. Each case drives the PRODUCT code the
// surface reaches, not a copy of it:
//
//   SPC-01  inferred birth in propose-only — the real commit path
//           (brain/commit.ts, via the CMT harness) with a canned Orient
//           proposal: the space is born 'proposed' with born_via='inferred',
//           and the proposal card's sweep PREVIEW (retrieval only) names the
//           three unsorted items approving it would pull in.
//   SPC-02  asked-for is never proposed — spaces/birth.ts bornAsked() while
//           the install is still in propose-only: active, created_by user,
//           swept, and in the list.
//   SPC-03  birth dedupe on user-created — the same call against a live
//           `sp_goa_dec` returns an ASK and writes nothing.
//   SPC-04  woken — wakeSpace() on a dormant space: the SAME row goes active
//           with its old evidence, the sweep marker is re-armed, Decide is
//           re-queued. Nothing is re-derived.
//   SPC-05  the justifying utterance — the birth evidence is the sentence
//           verbatim, and the decisions row + bar thread are what "why?" reads.
//   SPC-06  graduation — consolidation/graduation.ts: fourteen green measured
//           days flip propose → auto (one decisions row); a later false
//           auto-merge flips it back and resets the streak.
//   SPC-07  unsorted reviewed on change only — reviewUnsortedWeekly() with a
//           COUNTING stub provider: an unchanged pile skips outright (zero
//           calls); one new row buys exactly one call for the one space whose
//           terms match.
//   SPC-08  enrichment on change only — recordEnrichmentFetch(): an unchanged
//           content hash is bookkeeping, never a queued Decide row.
//
// Every case removes its own rows and restores every app_state key it moved.
// ===========================================================================

import { randomBytes } from "node:crypto";

import type { JsonPassDeps } from "../../brain/llm.js";
import {
  GRADUATION_BY_KEY,
  GRADUATION_MODE_KEY,
  GRADUATION_REQUIRED_DAYS,
  GRADUATION_REVERTED_KEY,
  checkGraduation,
  consecutiveGreenDays,
  graduationMode,
  recordGraduationMetrics,
  spaceCreationStatus,
} from "../../consolidation/graduation.js";
import { getDb } from "../../db/connection.js";
import { decisionsFor } from "../../db/decisions.js";
import { appStateGet, appStateSet } from "../../db/ingest.js";
import type { ProviderV2, Usage } from "../../providers/types.js";
import { providerRequestText, providerV2TestDouble } from "../../providers/test-support.js";
import { bornAsked, sweepPreview, wakeSpace } from "../../spaces/birth.js";
import { recordEnrichmentFetch } from "../../spaces/enrichment.js";
import { reviewUnsortedWeekly, UNSORTED_LAST_REVIEW_KEY } from "../../spaces/unsorted.js";
import { spaceView, spacesList } from "../../spaces/view.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { runCmtCase } from "./cmt.js";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, dflt: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function deleteAppState(key: string): void {
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(key);
}

/** Save / restore an app_state key around a case. */
function withAppState<T>(keys: readonly string[], run: () => T): T {
  const before = keys.map((k) => [k, appStateGet(k)] as const);
  try {
    return run();
  } finally {
    for (const [k, v] of before) {
      if (v === null) deleteAppState(k);
      else appStateSet(k, v);
    }
  }
}

async function withAppStateAsync<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
  const before = keys.map((k) => [k, appStateGet(k)] as const);
  try {
    return await run();
  } finally {
    for (const [k, v] of before) {
      if (v === null) deleteAppState(k);
      else appStateSet(k, v);
    }
  }
}

// ---- the counting stub provider --------------------------------------------

const USAGE: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };

/** Answers `responses` in order (last repeats) and counts every call made. */
function stubProvider(responses: readonly string[]): ProviderV2 & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(providerV2TestDouble(async (opts) => {
      calls.push(providerRequestText(opts));
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" as const };
  }), { calls });
}

function deps(provider: ProviderV2): JsonPassDeps {
  return { provider, recordRun: () => `run_${randomBytes(6).toString("hex")}`, sleep: async () => {} };
}

// ---- a per-case world ------------------------------------------------------

/** Rows one case owns; removed afterwards so the harness DB stays clean. */
class SpcWorld {
  readonly prefix: string;
  readonly spaces: string[] = [];
  readonly episodes: string[] = [];
  readonly tasks: string[] = [];
  readonly decisionIds: string[] = [];
  readonly metricDays: string[] = [];
  constructor(caseId: string) {
    this.prefix = `${caseId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
  }
  key(k: string): string {
    return `${this.prefix}${k}`;
  }
  space(id: string, label: string, o: { status?: string; area?: string | null; goal?: string | null } = {}): string {
    const sid = this.key(id);
    getDb()
      .prepare(`INSERT INTO spaces (id, label, life_area, goal, status) VALUES (?, ?, ?, ?, ?)`)
      .run(sid, label, o.area ?? null, o.goal ?? null, o.status ?? "active");
    this.spaces.push(sid);
    return sid;
  }
  episode(id: string, summary: string, o: { spaceId?: string | null; unsorted?: boolean; createdAt?: string } = {}): string {
    const eid = this.key(id);
    const db = getDb();
    db.prepare(
      `INSERT INTO episodes (id, space_id, state, summary, first_ts, last_ts) VALUES (?, ?, 'open', ?, ?, ?)`,
    ).run(eid, o.spaceId ?? null, summary, "2026-08-20T10:00:00.000Z", "2026-08-20T10:00:00.000Z");
    this.episodes.push(eid);
    if (o.unsorted) {
      db.prepare(
        `INSERT INTO unsorted (id, episode_id, reason, status, created_at) VALUES (?, ?, 'no goal evidence', 'open', ?)`,
      ).run(`un_${eid}`, eid, o.createdAt ?? "2026-08-20T10:00:00.000Z");
    }
    return eid;
  }
  task(id: string, title: string, spaceId: string): string {
    const tid = this.key(id);
    getDb()
      .prepare(`INSERT INTO tasks (id, space_id, title, type, status) VALUES (?, ?, ?, 'explicit', 'open')`)
      .run(tid, spaceId, title);
    this.tasks.push(tid);
    return tid;
  }
  /** A decisions row the graduation metric reads back. */
  gradDecision(id: string, pass: string, target: string, action: string, reversedAt: string | null, createdAt: string): void {
    const did = this.key(id);
    getDb()
      .prepare(
        `INSERT INTO decisions (id, pass, target_kind, target_id, action, reversed_at, created_at)
         VALUES (?, ?, 'space', ?, ?, ?, ?)`,
      )
      .run(did, pass, this.key(target), action, reversedAt, createdAt);
    this.decisionIds.push(did);
  }
  cleanup(): void {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const id of this.episodes) {
        db.prepare(`DELETE FROM unsorted WHERE episode_id = ?`).run(id);
        db.prepare(`DELETE FROM second_look WHERE episode_id = ?`).run(id);
        db.prepare(`DELETE FROM episode_events WHERE episode_id = ?`).run(id);
        db.prepare(`DELETE FROM episodes WHERE id = ?`).run(id);
      }
      for (const id of this.tasks) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      for (const id of this.spaces) {
        db.prepare(`DELETE FROM decide_queue WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM space_enrichments WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM t2_review_queue WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM space_bridge_keys WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM space_entities WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id);
      }
      db.prepare(`DELETE FROM decisions WHERE target_id LIKE ?`).run(`${this.prefix}%`);
      for (const day of this.metricDays) db.prepare(`DELETE FROM graduation_metrics WHERE day = ?`).run(day);
      db.prepare(`DELETE FROM decisions WHERE target_kind = 'setting' AND target_id = ?`).run(GRADUATION_MODE_KEY);
    });
    try {
      tx();
    } catch {
      /* a leftover row never fails the case */
    }
  }
}

type CaseFn = (fixture: Fixture, w: SpcWorld) => Promise<ExecutorResult> | ExecutorResult;

// ---- SPC-01 · inferred birth in propose-only --------------------------------

const spc01: CaseFn = (fixture) =>
  withAppState([GRADUATION_MODE_KEY, GRADUATION_BY_KEY, GRADUATION_REVERTED_KEY], () => {
    appStateSet(GRADUATION_MODE_KEY, str(rec(fixture.setup).graduation_mode, "propose"));
    const run = runCmtCase(fixture.id, rec(fixture.setup), fixture.input_events);
    try {
      const db = getDb();
      const spaceId = run.report.createdSpaces[0] ?? null;
      const row = spaceId
        ? (db.prepare(`SELECT status, born_via, birth_evidence_json FROM spaces WHERE id = ?`).get(spaceId) as
            | { status: string; born_via: string | null; birth_evidence_json: string | null }
            | undefined)
        : undefined;
      // The unsorted episodes THIS case put in the pile.
      const ours = new Set(
        (
          db
            .prepare(`SELECT episode_id AS id FROM unsorted WHERE status = 'open' AND episode_id IN (${run.report.committedEpisodes.map(() => "?").join(",") || "''"})`)
            .all(...run.report.committedEpisodes.map((e) => e.episodeId)) as { id: string }[]
        ).map((r) => r.id),
      );
      const preview = spaceId ? sweepPreview(spaceId) : { count: 0, items: [], line: "", spaceId: "" };
      const mine = preview.items.filter((i) => ours.has(i.episodeId));
      const expected = rec(fixture.expected);

      const violations: Violation[] = [];
      if (!row) violations.push({ label: "auto-created", note: "no space was created at all" });
      else if (row.status !== str(expected.status, "proposed")) {
        violations.push({ label: "auto-created", note: `born ${row.status}` });
      }
      if (row && row.born_via !== str(expected.born_via, "inferred")) {
        violations.push({ label: "auto-created", note: `born_via ${row.born_via}` });
      }
      const wantCount = num(expected.sweep_preview_count, 3);
      const ok =
        row !== undefined &&
        row.status === "proposed" &&
        row.born_via === "inferred" &&
        mine.length === wantCount &&
        preview.line === `will pull in ${preview.count} related item${preview.count === 1 ? "" : "s"}`;
      return {
        ok,
        output: {
          space_id: spaceId,
          status: row?.status ?? null,
          born_via: row?.born_via ?? null,
          birth_evidence: row?.birth_evidence_json ? JSON.parse(row.birth_evidence_json) : null,
          in_review_queue: row?.status === "proposed",
          sweep_preview_count: mine.length,
          sweep_preview_line: preview.line,
          model_calls: 0,
        },
        violations,
        metrics: { model_calls: 0, sweep_preview_calls: 0 },
        notes: [
          "real brain/commit.ts through the CMT harness; the preview is retrieval only — zero model calls",
        ],
      };
    } finally {
      run.cleanup();
    }
  });

// ---- SPC-02 · asked-for is never proposed -----------------------------------

const spc02: CaseFn = (fixture, w) =>
  withAppState([GRADUATION_MODE_KEY, GRADUATION_BY_KEY, GRADUATION_REVERTED_KEY], () => {
    const setup = rec(fixture.setup);
    appStateSet(GRADUATION_MODE_KEY, str(setup.graduation_mode, "propose"));
    const bornStatusWouldBe = spaceCreationStatus();
    const utterance = str(setup.utterance, "plan hampi trek in october");
    const outcome = bornAsked({
      label: utterance,
      utterance,
      threadId: str(setup.thread_id, "th_bar_1"),
    });
    if (outcome.outcome !== "created") {
      return {
        ok: false,
        output: { outcome: outcome.outcome },
        violations: [{ label: "proposed-anyway", note: "the bar's create path did not create" }],
        metrics: { model_calls: 0 },
      };
    }
    w.spaces.push(outcome.spaceId);
    const row = getDb()
      .prepare(`SELECT status, born_via, created_by, label FROM spaces WHERE id = ?`)
      .get(outcome.spaceId) as { status: string; born_via: string; created_by: string; label: string };
    const shown = spacesList()
      .areas.flatMap((a) => a.spaces)
      .some((s) => s.id === outcome.spaceId);
    const expected = rec(fixture.expected);
    const violations: Violation[] = [];
    if (row.status !== "active") violations.push({ label: "proposed-anyway", note: `born ${row.status}` });
    const ok =
      row.status === str(expected.status, "active") &&
      row.born_via === str(expected.born_via, "asked") &&
      row.created_by === str(expected.created_by, "user") &&
      row.label === str(expected.label, "hampi trek in october") &&
      shown === (expected.shown_in_list !== false) &&
      bornStatusWouldBe === "proposed";
    return {
      ok,
      output: {
        inferred_would_be: bornStatusWouldBe,
        status: row.status,
        born_via: row.born_via,
        created_by: row.created_by,
        label: row.label,
        shown_in_list: shown,
        swept: outcome.preview.count >= 0,
        sweep_preview_line: outcome.preview.line,
        model_calls: 0,
      },
      violations,
      metrics: { model_calls: 0 },
      notes: ["propose-only governs inference, not instruction: the bar's space is born active"],
    };
  });

// ---- SPC-03 · birth dedupe on user-created ----------------------------------

const spc03: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const existing = rec(setup.existing_space);
  const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n;
  const liveId = w.space(str(existing.id, "sp_goa_dec"), str(existing.label, "goa trip"));
  const utterance = str(setup.utterance, "plan a goa trip");
  const outcome = bornAsked({ label: utterance, utterance, threadId: "th_bar_dup" });
  if (outcome.outcome === "created") w.spaces.push(outcome.spaceId);
  const after = (getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n;
  const violations: Violation[] = [];
  if (outcome.outcome === "created") violations.push({ label: "duplicate-space", note: outcome.spaceId });
  const filed =
    outcome.outcome === "ask" &&
    decisionsFor("space", liveId).some((d) => d.action === "create" || d.action === "attach");
  if (filed) violations.push({ label: "silent-attach" });
  return {
    ok: outcome.outcome === "ask" && after === before + 1 && !filed,
    output: {
      outcome: outcome.outcome,
      duplicate_of: outcome.outcome === "ask" ? outcome.duplicate.spaceId : null,
      duplicate_via: outcome.outcome === "ask" ? outcome.duplicate.via : null,
      spaces_after: after - before,
      model_calls: 0,
    },
    violations,
    metrics: { model_calls: 0 },
    notes: ["the bar consults the same code-side dedupe the commit path does — an ask, never a second row"],
  };
};

// ---- SPC-04 · woken ---------------------------------------------------------

const spc04: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const spaceRow = rec(setup.space);
  const spaceId = w.space(str(spaceRow.id, "sp_ma_bday"), str(spaceRow.label, "ma's birthday"), {
    status: "dormant",
    area: str(spaceRow.life_area, "People"),
  });
  const episodes = num(setup.episodes, 1);
  for (let i = 0; i < episodes; i++) w.episode(`ep${i}`, `cake order ${i}`, { spaceId });
  const openTasks = num(setup.open_tasks, 1);
  for (let i = 0; i < openTasks; i++) w.task(`t${i}`, `order the cake ${i}`, spaceId);
  // A stale sweep marker: waking must re-arm it.
  const db = getDb();
  db.prepare(
    `INSERT INTO decisions (id, pass, target_kind, target_id, action) VALUES (?, 'sweep', 'space', ?, 'sweep')`,
  ).run(w.key("d_sweep"), spaceId);

  const outcome = wakeSpace({ spaceId, signal: str(setup.signal, "calendar lead time T-14") });
  const after = db.prepare(`SELECT status, woken_at FROM spaces WHERE id = ?`).get(spaceId) as {
    status: string;
    woken_at: string | null;
  };
  const stillAttached = (
    db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE space_id = ?`).get(spaceId) as { n: number }
  ).n;
  const requeued = (
    db.prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = ?`).get(spaceId) as { n: number }
  ).n;
  const markerOpen = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE target_kind = 'space' AND target_id = ? AND action = 'sweep' AND reversed_at IS NULL`,
      )
      .get(spaceId) as { n: number }
  ).n;
  const spacesForLabel = (
    db.prepare(`SELECT COUNT(*) AS n FROM spaces WHERE label = ?`).get(str(spaceRow.label, "ma's birthday")) as {
      n: number;
    }
  ).n;

  const violations: Violation[] = [];
  if (spacesForLabel !== 1) violations.push({ label: "reborn", note: `${spacesForLabel} spaces carry the label` });
  if (stillAttached !== episodes || outcome.oldEvidence.openTasks !== openTasks) {
    violations.push({ label: "evidence-lost", note: JSON.stringify(outcome.oldEvidence) });
  }
  return {
    ok:
      outcome.woke &&
      after.status === "active" &&
      after.woken_at !== null &&
      stillAttached === episodes &&
      markerOpen === 0 &&
      requeued === 1 &&
      violations.length === 0,
    output: {
      woke: outcome.woke,
      status: after.status,
      old_evidence: { episodes: outcome.oldEvidence.episodes, open_tasks: outcome.oldEvidence.openTasks },
      episodes_still_attached: stillAttached,
      sweep_rearmed: markerOpen === 0,
      decide_requeued: requeued,
      model_calls: 0,
    },
    violations,
    metrics: { model_calls: 0 },
    notes: ["the SAME row goes active; the episodes and open tasks it slept with ARE its evidence"],
  };
};

// ---- SPC-05 · the justifying utterance --------------------------------------

const spc05: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const utterance = str(setup.utterance, "start tracking the ITR filing for FY26");
  const threadId = str(setup.thread_id, "th_bar_9");
  const outcome = bornAsked({ label: utterance, utterance, threadId });
  if (outcome.outcome !== "created") {
    return { ok: false, output: { outcome: outcome.outcome }, metrics: { model_calls: 0 } };
  }
  w.spaces.push(outcome.spaceId);
  const view = spaceView(outcome.spaceId)!;
  const quote = view.birth.evidence[0]?.quote ?? null;
  const decision = decisionsFor("space", outcome.spaceId).find((d) => d.action === "create") ?? null;
  const violations: Violation[] = [];
  if (quote !== utterance) violations.push({ label: "paraphrased-evidence", note: String(quote) });
  if (view.birth.thread_id !== threadId) violations.push({ label: "orphan-why", note: String(view.birth.thread_id) });
  return {
    ok: violations.length === 0 && decision !== null && (decision?.reason ?? "").includes(utterance),
    output: {
      birth_via: view.birth.via,
      evidence_quote: quote,
      thread_id: view.birth.thread_id,
      why_decision_action: decision?.action ?? null,
      why_decision_reason: decision?.reason ?? null,
      model_calls: 0,
    },
    violations,
    metrics: { model_calls: 0 },
    notes: ["the utterance is the evidence; the thread id is what \"why?\" reopens"],
  };
};

// ---- SPC-06 · graduation ----------------------------------------------------

function dayStr(base: Date, back: number): string {
  return new Date(base.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

const spc06: CaseFn = (fixture, w) =>
  withAppState([GRADUATION_MODE_KEY, GRADUATION_BY_KEY, GRADUATION_REVERTED_KEY], () => {
    const setup = rec(fixture.setup);
    deleteAppState(GRADUATION_MODE_KEY);
    deleteAppState(GRADUATION_BY_KEY);
    deleteAppState(GRADUATION_REVERTED_KEY);
    const now = new Date("2026-08-28T09:00:00.000Z");
    const days = num(setup.clean_days, GRADUATION_REQUIRED_DAYS);
    const perDay = num(setup.proposals_per_day, 3);
    for (let back = 1; back <= days; back++) {
      const day = dayStr(now, back);
      for (let i = 0; i < perDay; i++) {
        w.gradDecision(`p_${day}_${i}`, "orient", `sp_${day}_${i}`, "propose", null, `${day}T10:00:00.000Z`);
      }
      w.metricDays.push(day);
      recordGraduationMetrics(day);
    }
    const green = consecutiveGreenDays(now);
    const first = checkGraduation(now);
    const modeAfterClean = graduationMode();
    const bornAfterClean = spaceCreationStatus();

    // Two days later a reversed auto-merge lands on "yesterday".
    const later = new Date(now.getTime() + 2 * 86_400_000);
    const badDay = dayStr(later, 1);
    w.gradDecision(`p_${badDay}_0`, "orient", `sp_${badDay}_0`, "propose", null, `${badDay}T10:00:00.000Z`);
    w.gradDecision(`m_${badDay}_0`, "code:t2", `sp_${badDay}_0`, "merge", `${badDay}T12:00:00.000Z`, `${badDay}T09:00:00.000Z`);
    w.metricDays.push(badDay);
    const second = checkGraduation(later);

    const flips = (
      getDb()
        .prepare(
          `SELECT new_json FROM decisions WHERE target_kind = 'setting' AND target_id = ? ORDER BY rowid`,
        )
        .all(GRADUATION_MODE_KEY) as { new_json: string }[]
    ).map((r) => (JSON.parse(r.new_json) as { mode: string }).mode);

    const violations: Violation[] = [];
    if (first.windowProposals === 0 && first.flipped === "graduated") {
      violations.push({ label: "graduates-on-silence" });
    }
    if (second.mode !== "propose") violations.push({ label: "clock-not-reset", note: second.mode });
    return {
      ok:
        green === days &&
        first.flipped === "graduated" &&
        modeAfterClean === "auto" &&
        bornAfterClean === "active" &&
        second.flipped === "reset" &&
        second.mode === "propose" &&
        second.consecutiveGreen === 0 &&
        spaceCreationStatus() === "proposed" &&
        JSON.stringify(flips) === JSON.stringify(["auto", "propose"]),
      output: {
        consecutive_green: green,
        after_clean_weeks: { flipped: first.flipped, mode: modeAfterClean, born_status: bornAfterClean },
        after_false_merge: {
          flipped: second.flipped,
          mode: second.mode,
          born_status: spaceCreationStatus(),
          consecutive_green: second.consecutiveGreen,
        },
        decision_flips: flips,
        model_calls: 0,
      },
      violations,
      metrics: { model_calls: 0, false_auto_merge: 0 },
      notes: ["graduation is code over the decisions ledger — no model is consulted either way"],
    };
  });

// ---- SPC-07 · unsorted reviewed on change only ------------------------------

const spc07: CaseFn = async (fixture, w) =>
  withAppStateAsync([UNSORTED_LAST_REVIEW_KEY], async () => {
    const setup = rec(fixture.setup);
    const lastReview = str(setup.last_review_at, "2026-09-01T00:00:00.000Z");
    const now = new Date(str(setup.now, "2026-09-10T00:00:00.000Z"));
    const spaceId = w.space("sp_goa", "goa trip", { goal: "goa flights" });
    for (let i = 0; i < num(setup.unsorted_open, 1); i++) {
      w.episode(`ep_old${i}`, "goa flights on the 18th", { unsorted: true, createdAt: "2026-08-25T10:00:00.000Z" });
    }
    appStateSet(UNSORTED_LAST_REVIEW_KEY, lastReview);

    const quiet = stubProvider(["{}"]);
    const unchanged = await reviewUnsortedWeekly(deps(quiet), { now });

    // One new row lands the day after that review, and the review fires again.
    const fresh = w.episode("ep_new", "goa flights refund window", {
      unsorted: true,
      createdAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    const noisy = stubProvider([
      JSON.stringify({ attachments: [{ episode: fresh, attach: true, confidence: 0.9, reason: "same trip" }] }),
    ]);
    const changed = await reviewUnsortedWeekly(deps(noisy), {
      now: new Date(now.getTime() + 8 * 86_400_000),
    });

    const violations: Violation[] = [];
    if (quiet.calls.length > 0) violations.push({ label: "clock-driven-call", note: `${quiet.calls.length} calls` });
    if (noisy.calls.length > 1) violations.push({ label: "every-row-every-space", note: `${noisy.calls.length} calls` });
    return {
      ok:
        unchanged.skipped &&
        quiet.calls.length === 0 &&
        !changed.skipped &&
        noisy.calls.length === 1 &&
        changed.spacesReviewed === 1 &&
        (
          getDb().prepare(`SELECT space_id AS s FROM episodes WHERE id = ?`).get(fresh) as { s: string | null }
        ).s === spaceId,
      output: {
        unchanged: { skipped: unchanged.skipped, model_calls: quiet.calls.length, changed_rows: unchanged.changedRows },
        changed: {
          skipped: changed.skipped,
          model_calls: noisy.calls.length,
          spaces_reviewed: changed.spacesReviewed,
          attached: changed.attached,
        },
      },
      violations,
      metrics: { model_calls: quiet.calls.length + noisy.calls.length, clock_only_call: quiet.calls.length },
      notes: ["the change watermark answers before a provider is touched"],
    };
  });

// ---- SPC-08 · enrichment on change only -------------------------------------

const spc08: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const spaceRow = rec(setup.space);
  const spaceId = w.space(str(spaceRow.id, "sp_goa_enrich"), str(spaceRow.label, "goa trip"));
  const kind = str(setup.kind, "fare");
  const url = str(setup.url, "https://example.invalid/ccu-goi");
  const texts = fixture.input_events.map((e, i) => {
    const o = rec(e);
    return str(o.text, `fetch ${i}`);
  });
  const db = getDb();

  const first = recordEnrichmentFetch({ spaceId, kind, url, content: texts[0]! });
  const decisionsAfterFirst = decisionsFor("space", spaceId).length;
  const queuedAfterFirst = (
    db.prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = ?`).get(spaceId) as { n: number }
  ).n;

  const unchanged = recordEnrichmentFetch({ spaceId, kind, url, content: texts[1] ?? texts[0]! });
  const decisionsAfterUnchanged = decisionsFor("space", spaceId).length;
  const queuedAfterUnchanged = (
    db.prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = ?`).get(spaceId) as { n: number }
  ).n;

  const moved = recordEnrichmentFetch({ spaceId, kind, url, content: texts[2] ?? `${texts[0]!} changed` });

  const violations: Violation[] = [];
  if (unchanged.queued || queuedAfterUnchanged !== queuedAfterFirst) {
    violations.push({ label: "unchanged-fetch-calls", note: `queue ${queuedAfterFirst} → ${queuedAfterUnchanged}` });
  }
  if (unchanged.changed) violations.push({ label: "reflow-is-a-change" });
  return {
    ok:
      first.changed &&
      first.queued &&
      !unchanged.changed &&
      !unchanged.queued &&
      decisionsAfterUnchanged === decisionsAfterFirst &&
      moved.changed &&
      moved.queued &&
      violations.length === 0,
    output: {
      first: { changed: first.changed, queued: first.queued },
      unchanged: {
        changed: unchanged.changed,
        queued: unchanged.queued,
        model_calls: 0,
        new_decisions: decisionsAfterUnchanged - decisionsAfterFirst,
      },
      moved: { changed: moved.changed, queued: moved.queued },
    },
    violations,
    metrics: { model_calls: 0 },
    notes: ["the hash is compared in code; only a moved hash re-queues the space"],
  };
};

const CASES: Record<string, CaseFn> = {
  "SPC-01": spc01,
  "SPC-02": spc02,
  "SPC-03": spc03,
  "SPC-04": spc04,
  "SPC-05": spc05,
  "SPC-06": spc06,
  "SPC-07": spc07,
  "SPC-08": spc08,
};

/** The executor registered for pass `space` (SPC-01..08). */
export const spacesExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`SPC executor: no case for ${fixture.id}`);
  const w = new SpcWorld(fixture.id);
  try {
    return await run(fixture, w);
  } finally {
    w.cleanup();
  }
};
