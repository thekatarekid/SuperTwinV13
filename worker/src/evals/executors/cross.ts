// ===========================================================================
// [CODE] CROSS — the large-N cross-source batch (GoldenEvals V6 P1 §5.10
// CROSS-N50; Build §7.3 ship-gate item 3). Deterministic, zero model calls.
//
// CROSS-N2 measures the COMMIT layer (two unrelated chats in one bundle stay
// two episodes) and lives on the `commit` pass. CROSS-N50 measures the whole
// live tick, because its assertion spans both halves of live.v1: the
// understanding half must keep six threads apart while joining the villa
// cluster into ONE space, and the decide half must emit EXACTLY ONE prepared
// action whose grounding spans two sources. So it runs on its own `cross`
// pass, over the LIV seeder — the same seed → real tick → read-the-database
// shape as LIV-01..06, with the fixture's per-stream `source`/`kind`/`key`
// putting the browser and screen threads on real S3.4 chain keys.
//
// THE FOUR THINGS THE SHIP GATE ASKS FOR
//   one space        the villa cluster attaches to sp_goa_dec and mints no
//                    second space; the unrelated threads mint none either
//   two episodes     sp_goa_dec gains exactly two — the WhatsApp one and the
//                    browser one
//   one nudge        exactly one prepared action out of fifty events
//   citing both      its grounded_in resolves to events on two different
//                    SOURCES (wa + browser), not two aliases of one thread
//
// CROSS-DAY (R3) is the third case and runs on the same seam: a 120-event
// HISTORY day-bundle over eight threads and three sources. Where N50 asks
// whether the batch keeps threads apart, the day asks whether anything falls
// OUT of it — every section must yield an episode or an unsorted entry, every
// alias must be placed exactly once, nothing may be held back, and a history
// bundle still nudges nobody. `assessCrossDay` grades it.
//
// WHERE THE SCREEN THREAD GOES (spec reading, §5.10 says "screen joins via
// bridge"). `events.source` is part of the stream identity (db/eventlog.ts
// v13StreamId), so a screen capture of a page the browser is also on is its
// own stream — and brain/commit.ts rule 2 refuses an episode whose members
// span two streams. "Two episodes" and "the screen joins" are therefore only
// simultaneously true if the screen thread mints NO episode of its own inside
// the space: it is covered as unsorted on its own stream, and what joins it to
// the villa work is the URL BRIDGE — a `bridges` row of kind `url` written at
// ingest between the screen capture and the Goibibo tab. The executor asserts
// that row exists, and that the screen thread put nothing in the space.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { cleanupLiv, runLivCase, type LivRun } from "./liv.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

interface StreamSpec {
  tag: string;
  key: string;
  source: string;
}

/** The fixture's declared threads, in tag order. */
function streamSpecs(setup: Record<string, unknown>): StreamSpec[] {
  const raw = Array.isArray(setup.streams) ? setup.streams.map(rec) : [];
  return raw.map((s, i) => ({
    tag: (str(s.tag) ?? `T${i + 1}`).toUpperCase(),
    key: str(s.key) ?? "",
    source: str(s.source) ?? "wa",
  }));
}

export interface CrossFacts {
  /** episode id → { streamId, spaceId, member event ids } */
  episodes: { id: string; streamId: string | null; spaceId: string | null; memberIds: string[] }[];
  /** event id → stream id */
  streamOfEvent: Map<string, string>;
  /** stream id → the fixture tag that seeded it */
  tagOfStream: Map<string, string>;
  /** stream id → source */
  sourceOfStream: Map<string, string>;
  /** Spaces that hold at least one episode committed by this tick. */
  spacesTouched: string[];
  /** Spaces that did not exist before the tick. */
  spacesCreated: string[];
  /** url-kind bridge pairs, as {leftTag, rightTag}. */
  urlBridges: { left: string; right: string }[];
}

/** Read back the graph this tick left behind, keyed by the fixture's tags. */
export function readCrossFacts(run: LivRun, specs: readonly StreamSpec[]): CrossFacts {
  const db = getDb();
  const eventIds = run.seeded.eventIds;
  const ph = eventIds.map(() => "?").join(",") || "''";
  const eventRows = (
    eventIds.length > 0
      ? (db.prepare(`SELECT id, stream_id, source_id FROM events WHERE id IN (${ph})`).all(...eventIds) as {
          id: string;
          stream_id: string | null;
          source_id: string | null;
        }[])
      : []
  );
  const streamOfEvent = new Map<string, string>();
  const sourceOfStream = new Map<string, string>();
  for (const r of eventRows) {
    if (r.stream_id) {
      streamOfEvent.set(r.id, r.stream_id);
      if (r.source_id) sourceOfStream.set(r.stream_id, r.source_id);
    }
  }
  // The seeder's stream id scheme is "<source>:st:<externalKey>" (db/eventlog).
  const tagOfStream = new Map<string, string>();
  for (const s of specs) tagOfStream.set(`${s.source}:st:${s.key}`, s.tag);

  const idOfAlias = run.seeded.alias;
  const episodes = run.episodes.map((e) => {
    const memberIds = e.members.map((m) => idOfAlias.get(m) ?? m);
    const row = db.prepare(`SELECT stream_id, space_id FROM episodes WHERE id = ?`).get(e.id) as
      | { stream_id: string | null; space_id: string | null }
      | undefined;
    return { id: e.id, streamId: row?.stream_id ?? null, spaceId: row?.space_id ?? null, memberIds };
  });

  const spacesTouched = [...new Set(episodes.map((e) => e.spaceId).filter((s): s is string => typeof s === "string"))];
  const seededSpaces = new Set(run.seeded.spaceIds);
  const spacesCreated = spacesTouched.filter((s) => !seededSpaces.has(s));

  const bridgeRows =
    eventIds.length > 0
      ? (db
          .prepare(
            `SELECT left_id, right_id FROM bridges
              WHERE kind = 'url' AND left_id IN (${ph}) AND right_id IN (${eventIds.map(() => "?").join(",")})`,
          )
          .all(...eventIds, ...eventIds) as { left_id: string; right_id: string }[])
      : [];
  const tagOfEvent = (id: string): string => tagOfStream.get(streamOfEvent.get(id) ?? "") ?? "?";
  const urlBridges = bridgeRows.map((b) => ({ left: tagOfEvent(b.left_id), right: tagOfEvent(b.right_id) }));

  return { episodes, streamOfEvent, tagOfStream, sourceOfStream, spacesTouched, spacesCreated, urlBridges };
}

export interface CrossAssessment {
  violations: Violation[];
  metrics: Record<string, number>;
  detail: Record<string, unknown>;
}

/**
 * Grade one CROSS-N<k> run. Pure over the read-back facts so the vitest suite
 * can assert the grader itself, not only a green fixture.
 */
export function assessCross(
  run: LivRun,
  facts: CrossFacts,
  expected: Record<string, unknown>,
  specs: readonly StreamSpec[],
): CrossAssessment {
  const violations: Violation[] = [];
  const tagOf = (streamId: string | null): string => (streamId ? (facts.tagOfStream.get(streamId) ?? "?") : "?");
  const specByTag = new Map(specs.map((s) => [s.tag, s]));

  // The fixture names its threads by its OWN tags (T1..T6); `expected` names
  // the PACK's section tags (S1..Sn), which are assigned in first-event order.
  // The seeder puts the fixture's events in log order, so Sn == Tn here; the
  // mapping is computed rather than assumed so a re-ordered fixture still
  // grades correctly.
  const sectionOrder: string[] = [];
  for (const eid of run.seeded.eventIds) {
    const sid = facts.streamOfEvent.get(eid);
    if (!sid) continue;
    const tag = facts.tagOfStream.get(sid);
    if (tag && !sectionOrder.includes(tag)) sectionOrder.push(tag);
  }
  const tagForSection = (section: string): string => {
    const i = Number.parseInt(section.replace(/^S/i, ""), 10);
    return Number.isFinite(i) && i >= 1 ? (sectionOrder[i - 1] ?? section) : section;
  };

  // ---- 1. No episode may span two threads (the invented-cross-thread wrong).
  let multiStream = 0;
  for (const ep of facts.episodes) {
    const streams = [...new Set(ep.memberIds.map((id) => facts.streamOfEvent.get(id) ?? "?"))];
    if (streams.length > 1) {
      multiStream += 1;
      violations.push({
        label: "invented-cross-thread",
        note: `episode ${ep.id} spans ${streams.map(tagOf).join(", ")}`,
      });
    }
  }

  // ---- 2. One space, two episodes.
  const spaceId = str(expected.space) ?? run.seeded.spaceIds[0] ?? "";
  const inSpace = facts.episodes.filter((e) => e.spaceId === spaceId);
  const wantEpisodes = num(expected.episodes_in_space, 2);
  if (inSpace.length !== wantEpisodes) {
    violations.push({
      label: "invented-cross-thread",
      note: `${spaceId} holds ${inSpace.length} episode(s), expected ${wantEpisodes}`,
    });
  }
  if (facts.spacesCreated.length > 0) {
    violations.push({
      label: "invented-cross-thread",
      note: `a second space was created: ${facts.spacesCreated.join(", ")}`,
    });
  }
  const wantStreams = (Array.isArray(expected.episode_streams_in_space) ? expected.episode_streams_in_space : [])
    .filter((s): s is string => typeof s === "string")
    .map(tagForSection);
  if (wantStreams.length > 0) {
    const got = inSpace.map((e) => tagOf(e.streamId)).sort();
    if (got.join(",") !== [...wantStreams].sort().join(",")) {
      violations.push({
        label: "invented-cross-thread",
        note: `the space's episodes are on ${got.join(", ") || "(none)"} — expected ${wantStreams.join(", ")}`,
      });
    }
  }

  // ---- 3. Exactly one nudge.
  const wantPrepared = num(expected.prepared, 1);
  if (run.prepared.length !== wantPrepared) {
    violations.push({
      label: run.prepared.length > wantPrepared ? "two-nudges" : "no-prepared",
      note: `${run.prepared.length} prepared action(s) out of ${run.seeded.bundle.events.length} events, expected ${wantPrepared}`,
    });
  }

  // ---- 4. It cites both sources, and nothing from an unrelated thread.
  const groundedSources = new Set<string>();
  const groundedTags = new Set<string>();
  for (const p of run.prepared) {
    for (const eid of p.payload.groundedEventIds) {
      const sid = facts.streamOfEvent.get(eid);
      if (!sid) continue;
      groundedTags.add(facts.tagOfStream.get(sid) ?? "?");
      groundedSources.add(facts.sourceOfStream.get(sid) ?? "?");
    }
  }
  const wantSources = (Array.isArray(expected.grounded_sources) ? expected.grounded_sources : [])
    .filter((s): s is string => typeof s === "string");
  for (const src of wantSources) {
    if (!groundedSources.has(src)) {
      violations.push({
        label: "no-prepared",
        note: `the nudge cites no ${src} event — grounded in ${[...groundedTags].join(", ") || "(nothing)"}`,
      });
    }
  }
  const unrelated = (Array.isArray(expected.unrelated_streams) ? expected.unrelated_streams : [])
    .filter((s): s is string => typeof s === "string")
    .map(tagForSection);
  for (const tag of unrelated) {
    if (groundedTags.has(tag)) {
      violations.push({ label: "falcon-cited", note: `the nudge is grounded in the unrelated thread ${tag}` });
    }
    const spec = specByTag.get(tag);
    const streamId = spec ? `${spec.source}:st:${spec.key}` : null;
    const inSpaceFromUnrelated = inSpace.filter((e) => e.streamId === streamId);
    if (inSpaceFromUnrelated.length > 0) {
      violations.push({ label: "falcon-cited", note: `${tag} put an episode in ${spaceId}` });
    }
  }

  // ---- 5. The screen thread joined by the URL bridge, not by an episode.
  const bridge = rec(expected.bridge);
  const between = (Array.isArray(bridge.between) ? bridge.between : [])
    .filter((s): s is string => typeof s === "string")
    .map(tagForSection);
  if (between.length === 2) {
    const [a, b] = between as [string, string];
    const found = facts.urlBridges.some(
      (br) => (br.left === a && br.right === b) || (br.left === b && br.right === a),
    );
    if (!found) {
      violations.push({
        label: "invented-cross-thread",
        note: `no url bridge between ${a} and ${b} — the screen thread joined by nothing`,
      });
    }
    const spec = specByTag.get(b);
    const streamId = spec ? `${spec.source}:st:${spec.key}` : null;
    if (inSpace.some((e) => e.streamId === streamId)) {
      violations.push({
        label: "invented-cross-thread",
        note: `${b} minted an episode inside ${spaceId} instead of joining by the bridge`,
      });
    }
  }

  // ---- 6. Nothing silently dropped.
  const uncovered = run.report.commit?.coverage.uncovered ?? [];
  if (uncovered.length > 0) {
    violations.push({ label: "invented-cross-thread", note: `${uncovered.length} event(s) placed nowhere` });
  }

  return {
    violations,
    metrics: {
      model_calls: 0,
      events: run.seeded.bundle.events.length,
      threads: specs.length,
      sources: new Set(specs.map((s) => s.source)).size,
      episodes_committed: facts.episodes.length,
      episodes_in_space: inSpace.length,
      spaces_created: facts.spacesCreated.length,
      multi_stream_episodes: multiStream,
      prepared_persisted: run.prepared.length,
      grounded_sources: groundedSources.size,
      url_bridges: facts.urlBridges.length,
      uncovered: uncovered.length,
      nudge_without_grounding: run.prepared.filter((p) => p.payload.groundedEventIds.length === 0).length,
    },
    detail: {
      space: spaceId,
      episodes: facts.episodes.map((e) => ({
        id: e.id,
        thread: tagOf(e.streamId),
        space: e.spaceId,
        events: e.memberIds.length,
      })),
      prepared: run.prepared.map((p) => ({
        kind: p.payload.kind,
        action: p.payload.action,
        intent: p.payload.intent,
        surface: p.payload.surface,
        grounded_threads: [...groundedTags],
        grounded_sources: [...groundedSources],
      })),
      url_bridges: facts.urlBridges,
      section_order: sectionOrder,
    },
  };
}

/**
 * Grade CROSS-DAY. N50 asks whether the batch keeps threads APART; the day
 * bundle asks the other half — whether anything falls OUT of it. Three things,
 * all read off the database the real commit path wrote:
 *
 *   every section lands   each declared thread yields at least one episode or
 *                         one unsorted entry; a section the answer never
 *                         mentions is a silent drop, not a clean day
 *   coverage 100%         every alias sits in exactly one committed item —
 *                         `coverage.uncovered` and `coverage.duplicated` both
 *                         empty — and nothing is held back for a later tick
 *   nothing invented      no episode spans two threads, and a history bundle
 *                         still prepares no action (assist_from_history)
 */
export function assessCrossDay(
  run: LivRun,
  facts: CrossFacts,
  expected: Record<string, unknown>,
  specs: readonly StreamSpec[],
): CrossAssessment {
  const violations: Violation[] = [];
  const tagOf = (streamId: string | null): string => (streamId ? (facts.tagOfStream.get(streamId) ?? "?") : "?");
  const unsortedIds = new Set(run.unsortedEpisodeIds);

  // ---- 1. No episode may span two threads.
  let multiStream = 0;
  for (const ep of facts.episodes) {
    const streams = [...new Set(ep.memberIds.map((id) => facts.streamOfEvent.get(id) ?? "?"))];
    if (streams.length > 1) {
      multiStream += 1;
      violations.push({ label: "invented-cross-thread", note: `episode ${ep.id} spans ${streams.map(tagOf).join(", ")}` });
    }
  }

  // ---- 2. Every section yields at least one episode or unsorted entry.
  const perTag = new Map<string, { episodes: number; unsorted: number }>();
  for (const s of specs) perTag.set(s.tag, { episodes: 0, unsorted: 0 });
  for (const ep of facts.episodes) {
    const tag = tagOf(ep.streamId);
    const row = perTag.get(tag);
    if (!row) continue;
    if (unsortedIds.has(ep.id)) row.unsorted += 1;
    else row.episodes += 1;
  }
  const silent = [...perTag].filter(([, c]) => c.episodes + c.unsorted === 0).map(([tag]) => tag);
  for (const tag of silent) {
    violations.push({ label: "silent-drop", note: `section ${tag} yielded neither an episode nor an unsorted entry` });
  }

  // ---- 3. Coverage: every alias placed exactly once, nothing held.
  const commit = run.report.commit;
  const uncovered = commit?.coverage.uncovered ?? [];
  const duplicated = commit?.coverage.duplicated ?? [];
  if (uncovered.length > 0) {
    violations.push({ label: "silent-drop", note: `${uncovered.length} event(s) placed nowhere: ${uncovered.slice(0, 8).join(", ")}${uncovered.length > 8 ? " …" : ""}` });
  }
  if (duplicated.length > 0) {
    violations.push({ label: "double-placement", note: `${duplicated.length} event(s) placed twice: ${duplicated.slice(0, 8).join(", ")}${duplicated.length > 8 ? " …" : ""}` });
  }
  const held = commit?.heldEventIds.length ?? 0;
  if (held !== num(expected.held, 0)) {
    violations.push({ label: "silent-drop", note: `${held} event(s) held back for a later tick, expected ${num(expected.held, 0)}` });
  }

  // ---- 4. The day is the size the fixture says it is (a shrunken bundle
  //         would make "coverage 100%" mean nothing).
  const events = run.seeded.bundle.events.length;
  if (events !== num(expected.events, events)) {
    violations.push({ label: "silent-drop", note: `${events} events in the bundle, the fixture declares ${num(expected.events, events)}` });
  }
  if (specs.length !== num(expected.sections, specs.length)) {
    violations.push({ label: "silent-drop", note: `${specs.length} threads seeded, expected ${num(expected.sections, specs.length)}` });
  }
  const committedEpisodes = facts.episodes.filter((e) => !unsortedIds.has(e.id)).length;
  const committedUnsorted = facts.episodes.filter((e) => unsortedIds.has(e.id)).length;
  if (committedEpisodes !== num(expected.episodes_committed, committedEpisodes)) {
    violations.push({ label: "silent-drop", note: `${committedEpisodes} episode(s) committed, expected ${num(expected.episodes_committed, committedEpisodes)}` });
  }
  if (committedUnsorted !== num(expected.unsorted_committed, committedUnsorted)) {
    violations.push({ label: "silent-drop", note: `${committedUnsorted} unsorted entr(y/ies), expected ${num(expected.unsorted_committed, committedUnsorted)}` });
  }

  // ---- 5. A history day-bundle nudges nobody.
  if (run.prepared.length !== num(expected.prepared, 0)) {
    violations.push({ label: "history-nudge", note: `${run.prepared.length} prepared action(s) out of a history day-bundle` });
  }

  const placed = events - uncovered.length;
  return {
    violations,
    metrics: {
      model_calls: 0,
      events,
      threads: specs.length,
      sources: new Set(specs.map((s) => s.source)).size,
      episodes_committed: committedEpisodes,
      unsorted_committed: committedUnsorted,
      sections_with_nothing: silent.length,
      multi_stream_episodes: multiStream,
      uncovered: uncovered.length,
      duplicated: duplicated.length,
      held,
      coverage: events > 0 ? placed / events : 1,
      prepared_persisted: run.prepared.length,
      assist_from_history: run.seeded.bundle.lane === "live" ? 0 : run.prepared.length,
    },
    detail: {
      lane: run.seeded.bundle.lane,
      coverage: `${placed}/${events} placed`,
      per_section: [...perTag].map(([tag, c]) => ({
        thread: tag,
        source: specs.find((s) => s.tag === tag)?.source ?? "?",
        episodes: c.episodes,
        unsorted: c.unsorted,
      })),
      episodes: facts.episodes.map((e) => ({
        id: e.id,
        thread: tagOf(e.streamId),
        space: e.spaceId,
        events: e.memberIds.length,
        filed_as: unsortedIds.has(e.id) ? "unsorted" : "episode",
      })),
      uncovered,
      duplicated,
    },
  };
}

export const crossExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  const specs = streamSpecs(setup);
  const run = await runLivCase(fixture.id, setup);
  try {
    const facts = readCrossFacts(run, specs);
    const { violations, metrics, detail } =
      fixture.id === "CROSS-DAY"
        ? assessCrossDay(run, facts, rec(fixture.expected), specs)
        : assessCross(run, facts, rec(fixture.expected), specs);
    const result: ExecutorResult = {
      ok: violations.length === 0,
      output: {
        tick: { status: run.report.status, lane: run.seeded.bundle.lane },
        ...detail,
        rejected: run.report.commit?.rejected ?? 0,
      },
      violations,
      metrics,
      gateObservations: [
        {
          gateId: "episode_membership_explicit",
          passed: (metrics.multi_stream_episodes ?? 0) === 0,
          counted: true,
        },
        // Only claimed when there was a prepared action to measure: a day
        // bundle prepares nothing, and a gate with no measurement is "no
        // data", never a free pass.
        ...(run.prepared.length > 0
          ? [
              {
                gateId: "nudge_without_grounding",
                passed: (metrics.nudge_without_grounding ?? 0) === 0,
                counted: true,
              },
            ]
          : []),
        {
          gateId: "assist_from_history",
          passed: run.seeded.bundle.lane === "live" || run.prepared.length === 0,
          counted: true,
        },
      ],
      notes: [
        fixture.id === "CROSS-DAY"
          ? "recorded understanding through the real tick (pack → live.v1 → critic → commit); a 120-event HISTORY day-bundle " +
            `over ${specs.length} threads and ${new Set(specs.map((s) => s.source)).size} sources; every section landed and coverage is read off brain/commit.ts`
          : "recorded live.v1 output through the real tick (pack → live.v1 → critic → commit → applyLiveDecide); " +
            "six threads over three sources in one live bundle; clock pinned to the fixture's [NOW]",
      ],
    };
    return result;
  } finally {
    cleanupCross(run);
  }
};

/** LIV cleanup plus the bridge rows ingest wrote for this fixture's URLs. */
export function cleanupCross(run: LivRun): void {
  const db = getDb();
  const ids = run.seeded.eventIds;
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM bridges WHERE left_id IN (${ph}) OR right_id IN (${ph})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM event_bridge_keys WHERE event_id IN (${ph})`).run(...ids);
  }
  cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? []);
}
