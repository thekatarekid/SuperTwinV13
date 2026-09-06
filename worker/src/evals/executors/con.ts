// ===========================================================================
// [CODE] CON / IDEM — consolidation on change and idempotence (GoldenEvals
// V6 P1 §5.18; V6 P1 S3.9).
//
// Deterministic, zero model calls: the pair judge and the second-look judge
// are a stub provider that answers the fixture's canned verdict, so what is
// asserted is the CODE around the call — whether it is made at all (CON-01),
// what it is allowed to do (CON-02), what it never does (CON-03), and whether
// a second identical run writes anything (IDEM-01).
//
//   CON-01  an hour with no writes → the hourly roll skips outright, no call
//           (`clock_only_call` = the judge calls made on an unchanged store);
//           one write wakes it and the touched pair is judged once.
//   CON-02  near-duplicate spaces → a merge QUESTION (suggest_merge decision +
//           open questions row), never a silent merge (`false_auto_merge`).
//   CON-03  old claim versions get an END DATE; no row is removed.
//   IDEM-01 a fixture batch (eval-origin events → commit → T2 → T3) run twice:
//           zero new episodes, claims, tasks or spaces on the second run, and
//           the content tables hash identically (`idempotency`, hard).
//
// The V1-era prose CON fixtures (setup as one line, judged live) still route
// to the legacy executor in executors/passes.ts, so a directory that mixes the
// two shapes keeps working. Every case removes its own rows afterwards.
// ===========================================================================

import { createHash } from "node:crypto";

import { commitTick } from "../../brain/commit.js";
import type { JsonPassDeps } from "../../brain/llm.js";
import { parseOrientOutput } from "../../brain/orient.js";
import { claimHistory, writeClaimVersion } from "../../claims/store.js";
import {
  mergeQuestionId,
  runT2,
  T2_CHANGE_SOURCES,
  T2_LAST_ROLL_KEY,
  type T2Report,
} from "../../consolidation/t2.js";
import { COMPRESS_KEEP, runT3, T3_CLOSED_BY } from "../../consolidation/t3.js";
import { getDb } from "../../db/connection.js";
import { decisionsFor } from "../../db/decisions.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { appStateGet, appStateSet } from "../../db/ingest.js";
import { collectTick, markDispatchedEvents, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import type { Provider, Usage } from "../../providers/types.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { consolidateExecutor as legacyConsolidateExecutor } from "./passes.js";

const T0 = Date.parse("2026-08-28T19:40:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

// ---- The stub judge --------------------------------------------------------

const USAGE: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };

/** A provider that answers `responses` in order (last one repeats) and counts calls. */
export function stubJudge(responses: readonly string[]): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "stub-judge",
    calls,
    cancel: () => false,
    async send(opts) {
      calls.push(opts.message);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" };
    },
  };
}

const MERGE_VERDICT = (survivor: string, confidence: number): string =>
  JSON.stringify({ verdict: "merge", survivor, confidence, reason: "same trip tracked twice" });

// ---- The case world --------------------------------------------------------

/** Rows one case owns; removed afterwards so the harness DB stays clean. */
class ConWorld {
  readonly spaces: string[] = [];
  readonly episodes: string[] = [];
  readonly tasks: string[] = [];
  readonly claimKeys: string[] = [];
  readonly events: string[] = [];
  readonly streams: string[] = [];
  readonly flags: string[] = [];
  constructor(readonly caseId: string) {}

  /** Labels are per case, so the roll's twin lookup only ever pairs this case's spaces. */
  label(text: string): string {
    return `${this.caseId.toLowerCase()} ${text}`;
  }

  space(id: string, label: string, status = "active"): string {
    const sid = `${id}_${this.caseId.toLowerCase().replace("-", "")}`;
    getDb().prepare(`INSERT INTO spaces (id, label, status, goal) VALUES (?, ?, ?, 'a goal')`).run(sid, this.label(label), status);
    this.spaces.push(sid);
    return sid;
  }

  episode(id: string, spaceId: string | null, state = "open"): string {
    const eid = `${id}_${this.caseId.toLowerCase().replace("-", "")}`;
    getDb().prepare(`INSERT INTO episodes (id, space_id, state, summary) VALUES (?, ?, ?, ?)`).run(eid, spaceId, state, `${this.caseId} ${id}`);
    this.episodes.push(eid);
    return eid;
  }

  task(id: string, spaceId: string, title: string): string {
    const tid = `${id}_${this.caseId.toLowerCase().replace("-", "")}`;
    getDb().prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES (?, ?, ?, 'open')`).run(tid, spaceId, title);
    this.tasks.push(tid);
    return tid;
  }

  flag(id: string, spaceId: string, overlapId: string): string {
    const fid = `${id}_${this.caseId.toLowerCase().replace("-", "")}`;
    getDb()
      .prepare(`INSERT INTO t2_review_queue (id, kind, space_id, overlap_space_id) VALUES (?, 'flag_overlap', ?, ?)`)
      .run(fid, spaceId, overlapId);
    this.flags.push(fid);
    return fid;
  }

  claimVersion(claimKey: string, subjectId: string, statedAt: string, text: string): void {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES (?, 'person', ?)`).run(subjectId, subjectId);
    writeClaimVersion({
      claimKey,
      kind: "fact",
      subjectId,
      text,
      confidence: 0.9,
      statedAt,
      evidence: [{ event_ids: [`ev_${claimKey}`], quote: text }],
      decidedBy: "eval:con",
    });
    if (!this.claimKeys.includes(claimKey)) this.claimKeys.push(claimKey);
  }

  cleanup(): void {
    const db = getDb();
    const tx = db.transaction(() => {
      const ph = (xs: readonly string[]) => xs.map(() => "?").join(",");
      if (this.episodes.length > 0) {
        db.prepare(`DELETE FROM second_look WHERE episode_id IN (${ph(this.episodes)})`).run(...this.episodes);
        db.prepare(`DELETE FROM unsorted WHERE episode_id IN (${ph(this.episodes)})`).run(...this.episodes);
        db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph(this.episodes)})`).run(...this.episodes);
        db.prepare(`DELETE FROM episodes WHERE id IN (${ph(this.episodes)})`).run(...this.episodes);
      }
      if (this.tasks.length > 0) db.prepare(`DELETE FROM tasks WHERE id IN (${ph(this.tasks)})`).run(...this.tasks);
      if (this.flags.length > 0) db.prepare(`DELETE FROM t2_review_queue WHERE id IN (${ph(this.flags)})`).run(...this.flags);
      for (const sp of this.spaces) {
        db.prepare(`DELETE FROM questions WHERE target_kind = 'space' AND target_id = ?`).run(sp);
        db.prepare(`DELETE FROM decisions WHERE target_kind = 'space' AND target_id = ?`).run(sp);
        db.prepare(`DELETE FROM decide_queue WHERE space_id = ?`).run(sp);
        db.prepare(`DELETE FROM space_links WHERE a_space_id = ? OR b_space_id = ?`).run(sp, sp);
        db.prepare(`DELETE FROM space_claims WHERE space_id = ?`).run(sp);
        db.prepare(`DELETE FROM t2_review_queue WHERE space_id = ? OR overlap_space_id = ?`).run(sp, sp);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(sp);
      }
      for (const ck of this.claimKeys) {
        db.prepare(`DELETE FROM decisions WHERE target_kind = 'claim' AND target_id = ?`).run(ck);
        db.prepare(`DELETE FROM claim_versions WHERE claim_key = ?`).run(ck);
        db.prepare(`DELETE FROM claims WHERE claim_key = ?`).run(ck);
      }
      if (this.events.length > 0) db.prepare(`DELETE FROM events WHERE id IN (${ph(this.events)})`).run(...this.events);
      for (const sid of this.streams) {
        db.prepare(`DELETE FROM bundle_attempts WHERE stream_id = ?`).run(sid);
        db.prepare(`DELETE FROM streams WHERE id = ?`).run(sid);
      }
    });
    try {
      tx();
    } catch {
      /* a leftover row never fails the case */
    }
  }
}

type CaseFn = (fixture: Fixture, w: ConWorld) => Promise<ExecutorResult>;

function deps(provider: Provider): JsonPassDeps {
  return { provider };
}

// ---- CON-01 · consolidation skips when nothing changed -----------------------

export interface Con01Output {
  unchanged: { rollSkipped: boolean; changedRows: number; modelCalls: number; providerCalls: number; questions: number };
  changed: { rollSkipped: boolean; changedRows: number; modelCalls: number; merged: number; mergeQuestions: number };
}

const con01: CaseFn = async (fixture, w) => {
  const exp = rec(fixture.expected);
  const a = w.space("sp_a", "goa trip");
  const b = w.space("sp_b", "goa trip"); // the near-duplicate the judge WOULD be asked about
  w.episode("ep_a0", a, "closed");
  // "An hour with no writes": the last roll happened after every write above.
  const previousRoll = appStateGet(T2_LAST_ROLL_KEY);
  const quietCutoff = new Date(Date.now() + 1_000).toISOString();
  appStateSet(T2_LAST_ROLL_KEY, quietCutoff);
  const judge = stubJudge([MERGE_VERDICT(a, 0.99)]);
  const before = count(`SELECT COUNT(*) AS n FROM questions WHERE target_id = ?`, b);
  const quiet = await runT2(deps(judge));
  const unchanged: Con01Output["unchanged"] = {
    rollSkipped: quiet.rollSkipped,
    changedRows: quiet.changedRows,
    modelCalls: quiet.modelCalls,
    providerCalls: judge.calls.length,
    questions: count(`SELECT COUNT(*) AS n FROM questions WHERE target_id = ?`, b) - before,
  };
  // When the quiet roll runs anyway, name WHICH source woke it — measured here,
  // while the cutoff still stands and before the second phase writes. In a
  // whole-suite run this case shares one home with 150 others, and a single row
  // another fixture stamped in the FUTURE is indistinguishable from "the store
  // changed"; the counts below name the table instead of leaving the next agent
  // to bisect categories (Stage 4 gate).
  const wokeBy: string[] = [];
  if (!unchanged.rollSkipped && unchanged.changedRows > 0) {
    for (const src of T2_CHANGE_SOURCES) {
      const n = count(
        `SELECT COUNT(*) AS n FROM ${src.table} WHERE ${src.column} >= ?${src.where ? ` AND ${src.where}` : ""}`,
        quietCutoff,
      );
      if (n > 0) wokeBy.push(`${src.table}=${n}`);
    }
  }

  // One write since the last roll wakes it: the touched pair is judged once.
  appStateSet(T2_LAST_ROLL_KEY, new Date(Date.now() - 1_000).toISOString());
  w.episode("ep_a1", a);
  const woke = await runT2(deps(judge));
  const changed: Con01Output["changed"] = {
    rollSkipped: woke.rollSkipped,
    changedRows: woke.changedRows,
    modelCalls: woke.modelCalls,
    merged: woke.merged,
    mergeQuestions: woke.mergeSuggestions,
  };
  if (previousRoll !== null) appStateSet(T2_LAST_ROLL_KEY, previousRoll);

  const violations: Violation[] = [];
  if (unchanged.modelCalls > 0 || unchanged.providerCalls > 0) {
    violations.push({ label: "clock-driven-call", note: `${unchanged.providerCalls} judge call(s) with nothing written` });
  }
  if (changed.merged > 0) violations.push({ label: "silent-merge" });
  const expUnchanged = rec(exp.unchanged);
  const expChanged = rec(exp.changed);
  const ok =
    unchanged.rollSkipped === (expUnchanged.roll_skipped ?? true) &&
    unchanged.modelCalls === num(expUnchanged.model_calls, 0) &&
    unchanged.questions === 0 &&
    changed.rollSkipped === false &&
    changed.changedRows > 0 &&
    changed.modelCalls === num(expChanged.model_calls, 1) &&
    changed.mergeQuestions === num(expChanged.merge_questions, 1) &&
    changed.merged === num(expChanged.merged, 0);
  return {
    ok,
    output: { unchanged, changed } satisfies Con01Output,
    violations,
    metrics: { clock_only_call: unchanged.providerCalls, model_calls: judge.calls.length },
    notes: [
      `unchanged store: roll ${unchanged.rollSkipped ? "skipped" : "RAN"}, ${unchanged.providerCalls} judge call(s)` +
        (wokeBy.length ? ` — woken by rows dated after the cutoff: ${wokeBy.join(", ")}` : ""),
      `after one write: ${changed.changedRows} changed row(s), ${changed.modelCalls} judge call(s), ${changed.mergeQuestions} merge question(s)`,
    ],
  };
};

// ---- CON-02 · near-duplicate spaces → a merge question -----------------------

export interface Con02Output {
  report: Pick<T2Report, "flagsProcessed" | "merged" | "mergeSuggestions" | "modelCalls">;
  question: { id: string; kind: string | null; status: string | null; options: string[] } | null;
  suggestMergeDecision: boolean;
  loserStatus: string | null;
  episodeStillInLoser: boolean;
  taskStillInLoser: boolean;
  secondRunWrites: number;
}

const con02: CaseFn = async (fixture, w) => {
  const exp = rec(fixture.expected);
  const confidence = num(rec(fixture.setup).judge_confidence, 0.95);
  const a = w.space("sp_goa_dec", "goa december vacation");
  const b = w.space("sp_goa_dup", "goa december vacation");
  const ep = w.episode("ep_dup", b);
  const tsk = w.task("tsk_dup", b, "book cab to airport");
  w.flag("flag_dup", a, b);
  const judge = stubJudge([MERGE_VERDICT(a, confidence)]);
  const report = await runT2(deps(judge), { flagsOnly: true });

  const qid = mergeQuestionId(a, b);
  const qRow = getDb().prepare(`SELECT kind, status, options_json FROM questions WHERE id = ?`).get(qid) as
    | { kind: string | null; status: string | null; options_json: string | null }
    | undefined;
  let options: string[] = [];
  try {
    options = (JSON.parse(qRow?.options_json ?? "[]") as { id: string }[]).map((o) => o.id);
  } catch {
    options = [];
  }
  const question = qRow ? { id: qid, kind: qRow.kind, status: qRow.status, options } : null;
  const loserStatus = (getDb().prepare(`SELECT status FROM spaces WHERE id = ?`).get(b) as { status: string } | undefined)?.status ?? null;
  const episodeStillInLoser = (getDb().prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(ep) as { space_id: string }).space_id === b;
  const taskStillInLoser = (getDb().prepare(`SELECT space_id FROM tasks WHERE id = ?`).get(tsk) as { space_id: string }).space_id === b;
  const suggestMergeDecision = decisionsFor("space", b).some((d) => d.action === "suggest_merge");

  // The same flag again: nothing pending, one open question stays one.
  const again = await runT2(deps(judge), { flagsOnly: true });
  const secondRunWrites = again.flagsProcessed + again.merged + again.mergeSuggestions;
  const questionsForPair = count(`SELECT COUNT(*) AS n FROM questions WHERE id = ?`, qid);

  const violations: Violation[] = [];
  if (report.merged > 0 || loserStatus === "archived" || !episodeStillInLoser || !taskStillInLoser) {
    violations.push({ label: "silent-merge", note: `merged=${report.merged} loser=${loserStatus}` });
  }
  if (question === null || question.status !== "open") violations.push({ label: "no-question" });
  const ok =
    report.flagsProcessed === 1 &&
    report.merged === num(exp.merged, 0) &&
    report.mergeSuggestions === num(exp.merge_questions, 1) &&
    question?.kind === "merge" &&
    question.status === "open" &&
    options.includes("merge") &&
    options.includes("keep") &&
    suggestMergeDecision &&
    loserStatus === "active" &&
    secondRunWrites === 0 &&
    questionsForPair === 1;
  return {
    ok,
    output: {
      report: { flagsProcessed: report.flagsProcessed, merged: report.merged, mergeSuggestions: report.mergeSuggestions, modelCalls: report.modelCalls },
      question,
      suggestMergeDecision,
      loserStatus,
      episodeStillInLoser,
      taskStillInLoser,
      secondRunWrites,
    } satisfies Con02Output,
    violations,
    metrics: { false_auto_merge: report.merged, model_calls: judge.calls.length },
    notes: [`verdict merge @ ${confidence} → ${report.merged} merge(s), ${report.mergeSuggestions} question(s); loser ${loserStatus}`],
  };
};

// ---- CON-03 · nothing deleted --------------------------------------------------

export interface Con03Output {
  versionsBefore: number;
  versionsAfter: number;
  ended: { text: string; valid_to: string | null; closed_by: string | null }[];
  openEnded: number;
  compressDecisions: number;
  secondRunEnded: number;
}

const con03: CaseFn = async (fixture, w) => {
  const exp = rec(fixture.expected);
  const versions = num(rec(fixture.setup).versions, 6);
  const key = `ck_${w.caseId.toLowerCase().replace("-", "")}_rent`;
  const since = new Date(Date.now() - 60_000).toISOString();
  for (let i = 1; i <= versions; i++) {
    w.claimVersion(key, `ent_${w.caseId.toLowerCase()}`, `2026-08-${String(i).padStart(2, "0")}T00:00:00Z`, `rent is ${20 + i}k`);
  }
  const versionsBefore = claimHistory(key).length;
  const first = await runT3({ since, evalHook: () => {} });
  const rows = getDb()
    .prepare(`SELECT text, valid_to, closed_by FROM claim_versions WHERE claim_key = ? ORDER BY stated_at`)
    .all(key) as { text: string; valid_to: string | null; closed_by: string | null }[];
  const versionsAfter = rows.length;
  const ended = rows.filter((r) => r.closed_by === T3_CLOSED_BY);
  const openEnded = rows.filter((r) => r.closed_by === null && r.valid_to === null).length;
  const compressDecisions = count(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind = 'claim' AND action = 'compress' AND target_id = ?`, key);
  const second = await runT3({ since, evalHook: () => {} });

  const expectedEnded = Math.max(0, versions - 1 - COMPRESS_KEEP);
  const violations: Violation[] = [];
  if (versionsAfter < versionsBefore) violations.push({ label: "deleted-rows", note: `${versionsBefore} → ${versionsAfter}` });
  if (ended.some((r) => r.valid_to === null)) violations.push({ label: "ended-without-date" });
  const ok =
    versionsBefore === versions &&
    versionsAfter === versions &&
    first.claimVersionsCompressed === num(exp.ended, expectedEnded) &&
    ended.length === num(exp.ended, expectedEnded) &&
    ended.every((r) => r.valid_to !== null) &&
    openEnded === versions - ended.length &&
    compressDecisions === 1 &&
    second.claimVersionsCompressed === 0 &&
    claimHistory(key).length === versions;
  return {
    ok,
    output: { versionsBefore, versionsAfter, ended, openEnded, compressDecisions, secondRunEnded: second.claimVersionsCompressed } satisfies Con03Output,
    violations,
    metrics: { deleted_rows: Math.max(0, versionsBefore - versionsAfter), model_calls: 0 },
    notes: [`${versions} versions → ${ended.length} given an end date, ${versionsAfter} rows remain`],
  };
};

// ---- IDEM-01 · rerun is byte-identical -----------------------------------------

const CONTENT_TABLES: readonly { table: string; order: string }[] = [
  { table: "spaces", order: "id" },
  { table: "episodes", order: "id" },
  { table: "episode_events", order: "episode_id, event_id" },
  { table: "tasks", order: "id" },
  { table: "claims", order: "claim_key" },
  { table: "claim_versions", order: "id" },
  { table: "questions", order: "id" },
  { table: "space_links", order: "a_space_id, b_space_id" },
];

export interface IdemCounts {
  episodes: number;
  claims: number;
  claimVersions: number;
  tasks: number;
  spaces: number;
  questions: number;
  decisions: number;
  eventsUndispatched: number;
}

function idemCounts(): IdemCounts {
  return {
    episodes: count(`SELECT COUNT(*) AS n FROM episodes`),
    claims: count(`SELECT COUNT(*) AS n FROM claims`),
    claimVersions: count(`SELECT COUNT(*) AS n FROM claim_versions`),
    tasks: count(`SELECT COUNT(*) AS n FROM tasks`),
    spaces: count(`SELECT COUNT(*) AS n FROM spaces`),
    questions: count(`SELECT COUNT(*) AS n FROM questions`),
    decisions: count(`SELECT COUNT(*) AS n FROM decisions`),
    eventsUndispatched: count(`SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NULL`),
  };
}

/** sha256 over every row of the content tables, volatile bookkeeping columns excluded. */
export function contentDigest(): string {
  const db = getDb();
  const h = createHash("sha256");
  const volatile = new Set(["updated_at", "created_at", "ingested_at", "asked_at", "last_seen_at", "captured_at"]);
  for (const t of CONTENT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.order}`).all() as Record<string, unknown>[];
    for (const r of rows) {
      const stable = Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
      h.update(t.table).update(JSON.stringify(stable)).update("\n");
    }
  }
  return h.digest("hex");
}

export interface IdemRun {
  committedEpisodes: number;
  createdSpaces: number;
  stamped: number;
  t2: Pick<T2Report, "flagsProcessed" | "merged" | "mergeSuggestions" | "modelCalls" | "rollSkipped">;
  t3Ended: number;
  counts: IdemCounts;
  digest: string;
}

export interface IdemOutput {
  first: IdemRun;
  second: IdemRun;
  newRows: Partial<Record<keyof IdemCounts, number>>;
  byteIdentical: boolean;
}

/**
 * One fixture batch: the fixture's events land as `origin='eval'` rows on one
 * stream, the harness path bundles them, the canned Orient output commits ONE
 * episode into the seeded space, the handled events are stamped, then the
 * consolidation pair runs — T2 (flags + roll) over what changed, T3 over items
 * touched since the batch began.
 */
async function idemBatch(w: ConWorld, streamKey: string, texts: readonly string[], space: string, judge: Provider, since: string): Promise<IdemRun> {
  const envelopes: EventEnvelope[] = texts.map((text, i) => ({
    ts: new Date(T0 + (i + 1) * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "eval",
    streamKey,
    actor: i % 2 === 0 ? "contact:rohan" : "contact:karan",
    roles: { sender: i % 2 === 0 ? "contact:rohan" : "contact:karan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `${w.caseId}:${i + 1}` },
  }));
  // The same external ids twice: the log's own dedupe keeps the first row.
  const appended = appendEvents(envelopes, T0 + 3_600_000);
  for (const id of appended.ids) if (id !== "" && !w.events.includes(id)) w.events.push(id);

  let committedEpisodes = 0;
  let createdSpaces = 0;
  let stamped = 0;
  const plan = collectTick(T0 + 3_600_000);
  const mine = plan.bundles.find((b) => b.streamKey === streamKey);
  if (mine) {
    if (!w.streams.includes(mine.streamId)) w.streams.push(mine.streamId);
    const events = mine.events.filter((e) => w.events.includes(e.id)).sort((x, y) => x.rowid - y.rowid);
    const bundle: DeltaBundle = { ...mine, events };
    const aliases = new Map(events.map((e, i) => [`e${i + 1}`, e.id]));
    const streamAliases = new Map([["S1", mine.streamId]]);
    const orient = parseOrientOutput({
      episodes: [
        {
          action: "new",
          space,
          stream: "S1",
          events: events.map((_, i) => `e${i + 1}`),
          summary: "Goa dates and the villa advance settled",
          evidence: [{ event_ids: ["e1"], quote: texts[0] ?? "" }],
          confidence: 0.9,
        },
      ],
      proposals: [],
      unsorted: [],
      questions: [],
    });
    const report = commitTick({ bundle, orient, critic: { verdicts: [] }, aliases, streamAliases, runId: null });
    committedEpisodes = report.committedEpisodes.length;
    createdSpaces = report.createdSpaces.length;
    for (const e of report.committedEpisodes) if (!w.episodes.includes(e.episodeId)) w.episodes.push(e.episodeId);
    for (const s of report.createdSpaces) if (!w.spaces.includes(s)) w.spaces.push(s);
    stamped = markDispatchedEvents(bundle, report.handledEventIds, T0 + 3_700_000).stamped;
  }

  const t2 = await runT2({ provider: judge });
  const t3 = await runT3({ since, evalHook: () => {} });
  return {
    committedEpisodes,
    createdSpaces,
    stamped,
    t2: { flagsProcessed: t2.flagsProcessed, merged: t2.merged, mergeSuggestions: t2.mergeSuggestions, modelCalls: t2.modelCalls, rollSkipped: t2.rollSkipped },
    t3Ended: t3.claimVersionsCompressed,
    counts: idemCounts(),
    digest: contentDigest(),
  };
}

const idem01: CaseFn = async (fixture, w) => {
  const texts = fixture.input_events.map((e) => (typeof e === "string" ? e : String(rec(e).text ?? "")));
  const a = w.space("sp_goa", "goa trip");
  w.space("sp_goa_twin", "goa trip"); // a pair the roll will ask about — once
  w.task("tsk_adv", a, "collect advance from Karan");
  const key = `ck_${w.caseId.toLowerCase().replace("-", "")}_villa`;
  for (let i = 1; i <= 5; i++) w.claimVersion(key, `ent_${w.caseId.toLowerCase()}`, `2026-08-0${i}T00:00:00Z`, `villa advance is ${i * 5}k`);
  const streamKey = `${w.caseId.toLowerCase()}-goa-gang@g.us`;
  const since = new Date(Date.now() - 60_000).toISOString();
  const previousRoll = appStateGet(T2_LAST_ROLL_KEY);
  appStateSet(T2_LAST_ROLL_KEY, since);
  const judge = stubJudge([MERGE_VERDICT(a, 0.9)]);

  const first = await idemBatch(w, streamKey, texts, a, judge, since);
  const second = await idemBatch(w, streamKey, texts, a, judge, since);
  if (previousRoll !== null) appStateSet(T2_LAST_ROLL_KEY, previousRoll);

  const newRows: IdemOutput["newRows"] = {};
  for (const k of Object.keys(first.counts) as (keyof IdemCounts)[]) {
    const delta = second.counts[k] - first.counts[k];
    if (delta !== 0) newRows[k] = delta;
  }
  const byteIdentical = first.digest === second.digest;
  const violations: Violation[] = [];
  const grown = (["episodes", "claims", "claimVersions", "tasks", "spaces", "questions"] as const).filter((k) => (newRows[k] ?? 0) > 0);
  if (grown.length > 0) violations.push({ label: "double-apply", note: grown.map((k) => `${k}+${newRows[k]}`).join(" ") });
  if (!byteIdentical) violations.push({ label: "drift", note: `${first.digest.slice(0, 12)} → ${second.digest.slice(0, 12)}` });
  const ok =
    first.committedEpisodes === 1 &&
    second.committedEpisodes === 0 &&
    second.stamped === 0 &&
    grown.length === 0 &&
    (newRows.decisions ?? 0) === 0 &&
    byteIdentical &&
    first.t2.merged === 0 &&
    second.t2.merged === 0;
  return {
    ok,
    output: { first, second, newRows, byteIdentical } satisfies IdemOutput,
    violations,
    metrics: {
      idempotency: grown.length + (byteIdentical ? 0 : 1),
      model_calls: judge.calls.length,
      second_run_new_rows: Object.values(newRows).reduce((s, n) => s + Math.max(0, n ?? 0), 0),
    },
    notes: [
      `run 1: ${first.committedEpisodes} episode(s), ${first.t2.mergeSuggestions} merge question(s), ${first.t3Ended} version(s) ended`,
      `run 2: ${second.committedEpisodes} episode(s), new rows ${JSON.stringify(newRows)}, digest ${byteIdentical ? "identical" : "DIFFERS"}`,
    ],
  };
};

// ---- Dispatch ----------------------------------------------------------------

const CASES: Record<string, CaseFn> = {
  "CON-01": con01,
  "CON-02": con02,
  "CON-03": con03,
  "IDEM-01": idem01,
};

/** True for the V6 P1 structured code fixtures; the V1 prose cases fall through. */
export function isV6ConFixture(fixture: Fixture): boolean {
  return fixture.mode === "code" && (fixture.id in CASES || fixture.category === "IDEM");
}

export const conExecutor: Executor = async ({ fixture }) => {
  if (!isV6ConFixture(fixture)) return legacyConsolidateExecutor({ fixture });
  const fn = CASES[fixture.id];
  if (!fn) return { output: null, pending: `${fixture.id}: no CON/IDEM code case registered` };
  const w = new ConWorld(fixture.id);
  try {
    return await fn(fixture, w);
  } finally {
    w.cleanup();
  }
};
