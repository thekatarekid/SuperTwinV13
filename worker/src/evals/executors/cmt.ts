// ===========================================================================
// [CODE] CMT — commit executor (GoldenEvals V6 P1 §5.8; V6 P1 S3.1).
//
// Deterministic, zero model calls. Each case seeds the fixture's events on
// per-case stream keys, builds the one bundle over them (several streams,
// e1..eN in log order, S1.. section tags), hands the fixture's canned Orient
// output + Critic verdicts to the REAL commit path (brain/commit.ts), then
// marks the handled events the way the consumer does (markDispatchedEvents)
// and reads the database back.
//
// Generic assertions run on every case; `expected` keys add the per-case
// ones. The case's rows are removed afterwards so the harness DB stays
// clean for the next case.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { episodeMemberIds } from "../../db/v6core.js";
import { collectTick, markDispatchedEvents, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import { commitTick, type CommitReport } from "../../brain/commit.js";
import { parseCriticOutput, type CriticOutput } from "../../brain/critic.js";
import { parseOrientOutput, type OrientOutput } from "../../brain/orient.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const T0 = Date.parse("2026-08-28T19:40:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

interface FixtureEvent {
  stream: string;
  actor: string;
  text: string;
}

function fixtureEvents(input: unknown[]): FixtureEvent[] {
  return input.map((raw, i) => {
    const o = rec(raw);
    return {
      stream: typeof o.stream === "string" ? o.stream : "S1",
      actor: typeof o.actor === "string" ? o.actor : "contact:rohan",
      text: typeof o.text === "string" ? o.text : `event ${i + 1}`,
    };
  });
}

export interface CmtRun {
  report: CommitReport;
  aliases: Map<string, string>;
  streamAliases: Map<string, string>;
  /** alias → the stream tag its event was seeded on */
  streamTagOf: Map<string, string>;
  /** alias → rowid */
  rowidOf: Map<string, number>;
  cursorRowid: number;
  stamped: string[];
  recollected: string[];
  /** committed episode id → member aliases (log order) */
  members: Map<string, string[]>;
  episodeStream: Map<string, string | null>;
  /** episode_events rows for the committed episodes */
  memberRows: Array<{ episode_id: string; event_id: string | null; start_event_id: string; end_event_id: string }>;
  unsortedRows: number;
  coverageFlags: number;
  eventText: Map<string, string>;
  cleanup: () => void;
}

/**
 * Seed, bundle, commit, mark, read back. Exported so the vitest suite can
 * drive the same path the CLI does.
 */
export function runCmtCase(id: string, setup: unknown, input: unknown[]): CmtRun {
  const db = getDb();
  const s = rec(setup);
  const orient: OrientOutput = parseOrientOutput({
    episodes: [],
    proposals: [],
    unsorted: [],
    questions: [],
    ...rec(s.orient),
  });
  const critic: CriticOutput = s.critic ? parseCriticOutput(s.critic) : { verdicts: [] };
  const events = fixtureEvents(input);
  const tags = [...new Set(events.map((e) => e.stream))];
  const keyOf = (tag: string): string => `cmt-${id.toLowerCase()}-${tag.toLowerCase()}@g.us`;

  const envelopes: EventEnvelope[] = events.map((e, i) => ({
    ts: new Date(T0 + (i + 1) * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: keyOf(e.stream),
    actor: e.actor,
    roles: { sender: e.actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: e.text, external_id: `${id}:${i + 1}` },
  }));
  const appended = appendEvents(envelopes, T0 + 3_600_000);
  const ours = new Set(appended.ids.filter((x) => x !== ""));

  const plan = collectTick(T0 + 3_600_000);
  const mine = plan.bundles.filter((b) => b.events.some((e) => ours.has(e.id)));
  const first = mine.find((b) => b.streamKey === keyOf(tags[0])) ?? mine[0];
  if (!first) throw new Error(`${id}: no bundle collected`);
  const all = mine
    .flatMap((b) => b.events.filter((e) => ours.has(e.id)))
    .sort((a, b) => a.rowid - b.rowid);
  const bundle: DeltaBundle = { ...first, events: all };

  const aliases = new Map<string, string>();
  const rowidOf = new Map<string, number>();
  const streamTagOf = new Map<string, string>();
  const streamAliases = new Map<string, string>();
  tags.forEach((t, i) => {
    const b = mine.find((x) => x.streamKey === keyOf(t));
    if (b) streamAliases.set(`S${i + 1}`, b.streamId);
  });
  const tagByStreamId = new Map([...streamAliases].map(([tag, sid]) => [sid, tag]));
  all.forEach((e, i) => {
    const alias = `e${i + 1}`;
    aliases.set(alias, e.id);
    rowidOf.set(alias, e.rowid);
    const owner = mine.find((b) => b.events.some((x) => x.id === e.id));
    streamTagOf.set(alias, owner ? tagByStreamId.get(owner.streamId) ?? "?" : "?");
  });
  const aliasOfId = new Map([...aliases].map(([a, eid]) => [eid, a]));
  const eventText = new Map<string, string>();
  events.forEach((e, i) => eventText.set(`e${i + 1}`, e.text));

  const report = commitTick({ bundle, orient, critic, aliases, streamAliases, runId: null });
  const mark = markDispatchedEvents(bundle, report.handledEventIds, T0 + 3_700_000);

  const stamped = (
    db
      .prepare(
        `SELECT id FROM events WHERE dispatched_at IS NOT NULL AND id IN (${all.map(() => "?").join(",")}) ORDER BY rowid`,
      )
      .all(...all.map((e) => e.id)) as { id: string }[]
  ).map((r) => aliasOfId.get(r.id) ?? r.id);
  const recollected = collectTick(T0 + 7_200_000)
    .bundles.flatMap((b) => b.events)
    .filter((e) => ours.has(e.id))
    .map((e) => aliasOfId.get(e.id) ?? e.id);

  const epIds = report.committedEpisodes.map((e) => e.episodeId);
  const members = new Map<string, string[]>();
  const episodeStream = new Map<string, string | null>();
  for (const epId of epIds) {
    members.set(
      epId,
      episodeMemberIds(epId).map((eid) => aliasOfId.get(eid) ?? eid),
    );
    const row = db.prepare(`SELECT stream_id FROM episodes WHERE id = ?`).get(epId) as
      | { stream_id: string | null }
      | undefined;
    episodeStream.set(epId, row?.stream_id ?? null);
  }
  const ph = epIds.map(() => "?").join(",");
  const memberRows =
    epIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT episode_id, event_id, start_event_id, end_event_id FROM episode_events WHERE episode_id IN (${ph})`,
          )
          .all(...epIds) as CmtRun["memberRows"]);
  const unsortedRows =
    epIds.length === 0
      ? 0
      : (db.prepare(`SELECT COUNT(*) AS n FROM unsorted WHERE episode_id IN (${ph})`).get(...epIds) as { n: number }).n;
  const coverageFlags = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'coverage_flag' AND target_id LIKE ?`)
      .get(`${bundle.streamId}:%`) as { n: number }
  ).n;

  const cleanup = (): void => {
    const tx = db.transaction(() => {
      if (epIds.length > 0) {
        db.prepare(`DELETE FROM second_look WHERE episode_id IN (${ph})`).run(...epIds);
        db.prepare(`DELETE FROM unsorted WHERE episode_id IN (${ph})`).run(...epIds);
        db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph})`).run(...epIds);
        db.prepare(`DELETE FROM decide_queue WHERE space_id IN (SELECT space_id FROM episodes WHERE id IN (${ph}))`).run(...epIds);
        db.prepare(`DELETE FROM episodes WHERE id IN (${ph})`).run(...epIds);
      }
      for (const sp of report.createdSpaces) {
        db.prepare(`DELETE FROM t2_review_queue WHERE space_id = ?`).run(sp);
        db.prepare(`DELETE FROM space_bridge_keys WHERE space_id = ?`).run(sp);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(sp);
      }
      const eph = all.map(() => "?").join(",");
      db.prepare(`DELETE FROM events WHERE id IN (${eph})`).run(...all.map((e) => e.id));
      for (const sid of streamAliases.values()) {
        db.prepare(`DELETE FROM bundle_attempts WHERE stream_id = ?`).run(sid);
        db.prepare(`DELETE FROM streams WHERE id = ?`).run(sid);
      }
    });
    try {
      tx();
    } catch {
      /* a leftover row never fails the case */
    }
  };

  return {
    report,
    aliases,
    streamAliases,
    streamTagOf,
    rowidOf,
    cursorRowid: mark.cursorRowid,
    stamped,
    recollected,
    members,
    episodeStream,
    memberRows,
    unsortedRows,
    coverageFlags,
    eventText,
    cleanup,
  };
}

function normalize(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "").trim();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

/** Generic + per-case assertions over a finished run. */
export function assessCmt(run: CmtRun, expected: unknown, orient: OrientOutput): ExecutorResult {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const exp = rec(expected);
  const r = run.report;
  const fail = (msg: string): void => {
    failures.push(msg);
  };

  // ---- Generic: no rowid ranges (CMT-01) ------------------------------------
  for (const row of run.memberRows) {
    if (row.event_id === null || row.start_event_id !== row.event_id || row.end_event_id !== row.event_id) {
      violations.push({ label: "rowid-ranges", note: `${row.episode_id}: ${row.start_event_id}..${row.end_event_id}` });
    }
  }

  // ---- Generic: one stream per committed episode ----------------------------
  for (const [epId, aliases] of run.members) {
    const tags = new Set(aliases.map((a) => run.streamTagOf.get(a)));
    if (tags.size > 1) violations.push({ label: "multi-stream-episode", note: `${epId}: ${[...tags].join(",")}` });
    const derived = run.episodeStream.get(epId);
    const expectedStream = run.streamAliases.get([...tags][0] ?? "");
    if (derived !== expectedStream) fail(`${epId}: stream_id ${derived} ≠ events' stream ${expectedStream}`);
  }

  // ---- Generic: membership == cited aliases of exactly one item -------------
  const itemAliases: string[][] = [
    ...orient.episodes.map((e) => expandAliases(e.events, run.aliases)),
    ...orient.proposals.map((p) => expandAliases(p.episode_events, run.aliases)),
    ...orient.unsorted.map((u) => expandAliases(u.events, run.aliases)),
  ];
  const placedCount = new Map<string, number>();
  for (const [epId, aliases] of run.members) {
    for (const a of aliases) placedCount.set(a, (placedCount.get(a) ?? 0) + 1);
    const owner = itemAliases.find((list) => aliases.every((a) => list.includes(a)));
    if (!owner) fail(`${epId}: members ${aliases.join(",")} match no item's aliases`);
  }
  for (const [a, n] of placedCount) {
    if (n > 1) violations.push({ label: "double-placement", note: `${a} is a member of ${n} episodes` });
  }

  // ---- Generic: coverage — every alias placed, held, or flagged -------------
  const heldAliases = r.heldEventIds.map((id) => aliasFor(id, run.aliases));
  for (const alias of run.aliases.keys()) {
    const placed = (placedCount.get(alias) ?? 0) > 0;
    if (!placed && !heldAliases.includes(alias) && !r.coverage.uncovered.includes(alias)) {
      violations.push({ label: "alias-uncovered-silently", note: alias });
    }
  }
  if ((r.coverage.uncovered.length > 0 || r.coverage.duplicated.length > 0) && run.coverageFlags === 0) {
    violations.push({ label: "alias-uncovered-silently", note: "coverage gap without a coverage_flag decision" });
  }

  // ---- Generic: no committed episode rests on a non-verbatim quote ----------
  let fabricated = 0;
  const committedItems = orient.episodes.filter((_, i) => !r.rejections.some((x) => x.item === i + 1));
  for (const e of committedItems) {
    for (const ev of e.evidence) {
      const q = normalize(ev.quote);
      const hit = ev.event_ids.some((a) => normalize(run.eventText.get(a) ?? "").includes(q));
      if (!hit) {
        fabricated++;
        violations.push({ label: "fabricated-evidence-committed", note: `"${ev.quote}" (${ev.event_ids.join(",")})` });
      }
    }
  }

  // ---- Generic: the cursor never passes a held event ------------------------
  for (const a of heldAliases) {
    const rowid = run.rowidOf.get(a) ?? 0;
    if (run.cursorRowid >= rowid) violations.push({ label: "cursor-skipped-held", note: `cursor ${run.cursorRowid} ≥ ${a}@${rowid}` });
    if (!run.recollected.includes(a)) violations.push({ label: "cursor-skipped-held", note: `${a} not re-collected` });
  }

  // ---- Per-case `expected` ---------------------------------------------------
  if (typeof exp.committed === "number" && r.committedEpisodes.length !== exp.committed) {
    fail(`committed ${r.committedEpisodes.length} ≠ ${exp.committed}`);
    if (r.committedEpisodes.length < exp.committed && r.rejected > 0) {
      violations.push({ label: "whole-bundle-quarantined", note: `${r.committedEpisodes.length} of ${exp.committed} committed` });
    }
  }
  if (typeof exp.rejected === "number" && r.rejected !== exp.rejected) fail(`rejected ${r.rejected} ≠ ${exp.rejected}`);
  if (typeof exp.downgraded === "number" && r.downgraded !== exp.downgraded) {
    fail(`downgraded ${r.downgraded} ≠ ${exp.downgraded}`);
    if (r.downgraded > exp.downgraded) violations.push({ label: "downgraded-not-rejected" });
  }
  if (exp.reject_reasons !== undefined) {
    const got = r.rejections.map((x) => x.reason);
    if (!sameSet(got, strs(exp.reject_reasons))) fail(`reject reasons ${got.join(",")} ≠ ${strs(exp.reject_reasons).join(",")}`);
  }
  if (exp.held !== undefined && !sameSet(heldAliases, strs(exp.held))) fail(`held ${heldAliases.join(",")} ≠ ${strs(exp.held).join(",")}`);
  if (exp.stamped !== undefined && !sameSet(run.stamped, strs(exp.stamped))) fail(`stamped ${run.stamped.join(",")} ≠ ${strs(exp.stamped).join(",")}`);
  if (exp.uncovered !== undefined && !sameSet(r.coverage.uncovered, strs(exp.uncovered))) fail(`uncovered ${r.coverage.uncovered.join(",")}`);
  if (exp.duplicated !== undefined && !sameSet(r.coverage.duplicated, strs(exp.duplicated))) fail(`duplicated ${r.coverage.duplicated.join(",")}`);
  if (exp.coverage_flag === true && run.coverageFlags === 0) fail("no coverage_flag decision");
  if (typeof exp.cursor_at === "string") {
    const want = run.rowidOf.get(exp.cursor_at) ?? -1;
    if (run.cursorRowid !== want) fail(`cursor ${run.cursorRowid} ≠ ${exp.cursor_at}@${want}`);
  }
  if (exp.recollected !== undefined && !sameSet(run.recollected, strs(exp.recollected))) fail(`re-collected ${run.recollected.join(",")}`);
  if (typeof exp.unsorted_rows === "number" && run.unsortedRows !== exp.unsorted_rows) {
    fail(`unsorted rows ${run.unsortedRows} ≠ ${exp.unsorted_rows}`);
    if (run.unsortedRows > exp.unsorted_rows) violations.push({ label: "downgraded-not-rejected" });
  }
  if (Array.isArray(exp.membership)) {
    const want = exp.membership.map((m) => strs(m));
    const got = [...run.members.values()];
    const ok = want.length === got.length && want.every((w) => got.some((g) => sameSet(g, w)));
    if (!ok) fail(`membership ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }
  if (exp.episode_streams !== undefined) {
    for (const [alias, tag] of Object.entries(rec(exp.episode_streams))) {
      const ep = [...run.members].find(([, m]) => m.includes(alias));
      const sid = ep ? run.episodeStream.get(ep[0]) : null;
      if (!ep || sid !== run.streamAliases.get(String(tag))) fail(`${alias} should sit in an episode on ${tag}`);
    }
  }

  notes.push(
    `${r.committedEpisodes.length} committed · ${r.rejected} rejected (${r.rejections.map((x) => x.reason).join(",") || "none"}) · held ${heldAliases.join(",") || "none"} · stamped ${run.stamped.join(",") || "none"} · cursor@${run.cursorRowid}`,
  );
  if (failures.length > 0) notes.push(...failures.map((f) => `FAIL ${f}`));
  return {
    ok: failures.length === 0 && violations.length === 0,
    output: {
      committed: r.committedEpisodes.length,
      rejected: r.rejected,
      rejections: r.rejections.map((x) => ({ item: x.item, kind: x.kind, reason: x.reason, detail: x.detail })),
      held: heldAliases,
      stamped: run.stamped,
      cursor_rowid: run.cursorRowid,
      recollected: run.recollected,
      membership: Object.fromEntries(run.members),
      coverage: r.coverage,
      coverage_flags: run.coverageFlags,
      unsorted_rows: run.unsortedRows,
    },
    violations,
    metrics: {
      fabricated_evidence: fabricated,
      episode_membership_explicit: run.memberRows.every((m) => m.event_id !== null) ? 1 : 0,
      held_events: heldAliases.length,
      model_calls: 0,
    },
    notes,
  };
}

function aliasFor(id: string, aliases: ReadonlyMap<string, string>): string {
  for (const [a, eid] of aliases) if (eid === id) return a;
  return id;
}

/** "e2-e4" → e2,e3,e4 (aliases the pack knows), deduped, order kept. */
function expandAliases(tokens: readonly string[], aliases: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const m = /^e(\d+)\s*-\s*e?(\d+)$/i.exec(t.trim());
    if (m) {
      for (let i = Math.min(+m[1], +m[2]); i <= Math.max(+m[1], +m[2]); i++) {
        if (aliases.has(`e${i}`) && !out.includes(`e${i}`)) out.push(`e${i}`);
      }
    } else if (aliases.has(t.trim().toLowerCase()) && !out.includes(t.trim().toLowerCase())) {
      out.push(t.trim().toLowerCase());
    }
  }
  return out;
}

/** The executor registered for pass `commit` (CMT-01..05). */
export const commitExecutor: Executor = ({ fixture }): ExecutorResult => {
  const setup = rec(fixture.setup);
  const orient = parseOrientOutput({ episodes: [], proposals: [], unsorted: [], questions: [], ...rec(setup.orient) });
  const run = runCmtCase(fixture.id, fixture.setup, fixture.input_events);
  try {
    return assessCmt(run, fixture.expected, orient);
  } finally {
    run.cleanup();
  }
};
