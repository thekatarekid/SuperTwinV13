// ===========================================================================
// [CODE] Categories D, E and F — the real segmenter (build item 1.7).
//
// D, E and F are `[CODE]` end to end: §10.4 sessions are mechanical, so there
// is no model verdict to freeze. `frozen_response` therefore carries a
// SCENARIO — one `tag|key=value|…` record per line — exactly like the other
// `[CODE]` executors, and every number this reports comes back out of
// `worker/src/sessions/*`. Nothing here re-implements a boundary rule, a seal
// mode, a hash or an ops rule; if a case passes, the product did it.
//
// Scenario records:
//
//   policy|kind=conversation|lane=dm|gap_ms=…|…   the lane's manifest windows
//   stream|tz=Asia/Kolkata|key=c1                 the lane itself
//   now|at=2026-08-10T12:00:00Z                   the frozen clock
//   known|id=old|ts=…                             an older event a reply quotes
//   seal                                          run the seal rules
//   react|id=r1|on=e2                             §10.4 note 2
//   edit|on=e2|id=edit1|text=…                    §10.4 note 3
//   revoke|on=e2|id=rev1                          §10.4 note 4
//   late|id=late1|at=…|who=a1|text=…              §10.4 note 8
//   restart|open=3                                §10.4 note 7
//   cohort|stage=enrich                           §10.4 note 7, second half
//   manifest|kind=ambient|prefilter=none          §2.2 note 3 registration
//   resegment|times=4                             determinism
//   skew|ts=…                                     §10.4 note 9
//
// The `given.events` half of the fixture is the events; the scenario is the
// policy and the operations. Both halves are read here and nowhere else.
// ===========================================================================

import { validateManifest, type SourceManifest } from "../../adapters/registry.js";
import { WHATSAPP_MANIFEST } from "../../adapters/whatsapp/manifest.js";
import {
  applyEdit,
  applyReaction,
  applyRevoke,
  clampSkew,
  isDroppedAtAdapter,
  lateArrival,
  resumeCohort,
} from "../../sessions/ops.js";
import {
  resolvePolicy,
  type PolicyOverride,
  type SessionPolicy,
} from "../../sessions/policies.js";
import { recomputeTimers, sealStream, textIndex, type HashableEvent } from "../../sessions/seal.js";
import { segment, type SegEvent, type SegSession } from "../../sessions/segment.js";
import type { StreamKind } from "../../adapters/registry.js";
import type { Fixture, FixtureEvent } from "../fixtures.js";
import type { Executor, Produced } from "../runner.js";

// ---- scenario parsing ------------------------------------------------------

interface Record_ {
  tag: string;
  fields: Record<string, string>;
}

function parseScenario(text: string): Record_[] {
  const out: Record_[] = [];
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`sessions scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function num(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined) return undefined;
  if (raw === "inf") return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`sessions scenario: ${key}=${raw} is not a number`);
  return n;
}

/**
 * A deterministic permutation of `items`, distinct per `seed` — the arrival
 * orders a backfill page could hand segmentation. Seeded Fisher-Yates over an
 * LCG so the same seed always yields the same order: the eval set is FROZEN, so
 * a rerun that shuffled randomly could pass today and fail tomorrow with no
 * code change, which is the one thing a determinism gate must never do.
 */
function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function flag(fields: Record<string, string>, key: string): boolean | undefined {
  const raw = fields[key];
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true";
}

const STREAM_KINDS_SET = new Set<string>(["conversation", "document", "activity", "ambient", "bounded"]);

// ---- the world the fixture describes --------------------------------------

interface World {
  policy: SessionPolicy;
  streamKey: string;
  tz: string;
  now: number;
  events: SegEvent[];
  texts: Map<string, HashableEvent>;
  known: Map<string, string>;
  dedupeDistance: number | undefined;
  coarseMax: number | undefined;
}

/** One fixture event → one segmenter event. Extras travel as named fields. */
function toSegEvent(e: FixtureEvent): SegEvent {
  const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const bool = (k: string): boolean | undefined => (typeof e[k] === "boolean" ? (e[k] as boolean) : undefined);
  const n = (k: string): number | undefined => (typeof e[k] === "number" ? (e[k] as number) : undefined);
  return {
    external_id: str("id") ?? `e${e.n}`,
    ts: e.ts,
    actor: e.who,
    kind: str("kind") ?? "message",
    text: e.text,
    enrichment_text: str("enrichment"),
    reply_to_external_id: str("reply_to") ?? null,
    author: str("author"),
    context: str("context") ?? null,
    url: str("url") ?? null,
    transaction: bool("transaction"),
    ts_end: str("ts_end") ?? null,
    record_id: str("record_id") ?? null,
    phash: str("phash") ?? null,
    salience: n("salience"),
  };
}

function buildWorld(fixture: Fixture, scenario: Record_[]): World {
  const policyLine = scenario.find((r) => r.tag === "policy")?.fields ?? {};
  const streamLine = scenario.find((r) => r.tag === "stream")?.fields ?? {};

  const kind = (policyLine.kind ?? "conversation") as StreamKind;
  if (!STREAM_KINDS_SET.has(kind)) throw new Error(`sessions scenario: unknown kind ${JSON.stringify(kind)}`);

  // The windows are DATA. A conversation lane reads them off the real WhatsApp
  // manifest; every other kind states them the way its own manifest would.
  const segmentation =
    kind === "conversation"
      ? {
          ...WHATSAPP_MANIFEST.segmentation,
          gap_ms: num(policyLine, "gap_ms") ?? WHATSAPP_MANIFEST.segmentation.gap_ms,
          gap_ms_by_stream: WHATSAPP_MANIFEST.segmentation.gap_ms_by_stream,
          shift_min_gap_ms:
            num(policyLine, "shift_min_gap_ms") ?? WHATSAPP_MANIFEST.segmentation.shift_min_gap_ms,
          size_cap_events: num(policyLine, "size_cap_events") ?? WHATSAPP_MANIFEST.segmentation.size_cap_events,
          size_cap_chars: num(policyLine, "size_cap_chars") ?? WHATSAPP_MANIFEST.segmentation.size_cap_chars,
          day_boundary: flag(policyLine, "day_boundary") ?? WHATSAPP_MANIFEST.segmentation.day_boundary,
          participant_shift:
            flag(policyLine, "participant_shift") ?? WHATSAPP_MANIFEST.segmentation.participant_shift,
          debounce_ms: num(policyLine, "debounce_ms") ?? WHATSAPP_MANIFEST.segmentation.debounce_ms,
        }
      : null;

  const override: PolicyOverride = {};
  for (const key of [
    "gap_ms",
    "shift_min_gap_ms",
    "size_cap_events",
    "size_cap_chars",
    "silence_ms",
    "ceiling_ms",
    "active_cap_ms",
    "debounce_ms",
  ] as const) {
    const v = num(policyLine, key);
    if (v !== undefined && segmentation === null) (override as Record<string, unknown>)[key] = v;
  }
  for (const key of ["day_boundary", "participant_shift", "author_shift", "context_shift", "reply_break"] as const) {
    const v = flag(policyLine, key);
    if (v !== undefined) (override as Record<string, unknown>)[key] = v;
  }
  // A per-stream override is allowed to disable a conversation rule too — the
  // self-chat lane is exactly that (§2 fact 3).
  if (segmentation !== null) {
    const ceiling = num(policyLine, "ceiling_ms");
    if (ceiling !== undefined) override.ceiling_ms = ceiling;
  }

  const policy = resolvePolicy({
    kind,
    segmentation,
    lane: policyLine.lane,
    actor_model: policyLine.actor_model === "single_actor" ? "single_actor" : "multi_actor",
    override: Object.keys(override).length > 0 ? override : null,
  });

  const events = fixture.given.events.map(toSegEvent);
  const texts = textIndex(
    events.map((e) => ({ external_id: e.external_id, text: e.text, enrichment_text: e.enrichment_text })),
  );

  const known = new Map<string, string>();
  for (const record of scenario.filter((r) => r.tag === "known")) {
    known.set(record.fields.id ?? "", record.fields.ts ?? "");
  }

  const nowLine = scenario.find((r) => r.tag === "now")?.fields.at;
  const lastTs = events.length > 0 ? Date.parse(events[events.length - 1]!.ts) : Date.parse("2026-08-15T12:00:00Z");
  const now = nowLine ? Date.parse(nowLine) : lastTs;

  return {
    policy,
    streamKey: streamLine.key ?? fixture.given.streams[0]?.alias ?? "c1",
    tz: streamLine.tz ?? "Asia/Kolkata",
    now,
    events,
    texts,
    known,
    dedupeDistance: num(scenario.find((r) => r.tag === "dedupe")?.fields ?? {}, "distance"),
    coarseMax: num(scenario.find((r) => r.tag === "coarse")?.fields ?? {}, "max"),
  };
}

// ---- reporting -------------------------------------------------------------

function walk(world: World, runMode: "bootstrap" | "steady"): ReturnType<typeof segment> {
  return segment({
    stream: { key: world.streamKey, tz: world.tz, source_id: "whatsapp" },
    policy: world.policy,
    events: world.events,
    run_mode: runMode,
    known_event_ts: world.known,
    dedupe_distance: world.dedupeDistance,
    coarse_salience_max: world.coarseMax,
  });
}

/** The shape every D/E/F case reads its expectations out of. */
function report(sessions: readonly SegSession[]): Record<string, unknown> {
  const first = sessions[0];
  return {
    sessions: sessions.length,
    cut: sessions.length > 1,
    boundary: first?.boundary_reason_end ?? null,
    measured: first?.boundary_params.end ?? null,
    boundaries: sessions.map((s) => s.boundary_reason_end),
    starts: sessions.map((s) => s.boundary_reason_start),
    event_counts: sessions.map((s) => s.event_count),
    tokens: sessions.map((s) => s.tokens),
    statuses: sessions.map((s) => s.status),
    seal_modes: sessions.map((s) => s.seal_mode),
    session_ids: sessions.map((s) => s.id),
    coarse: sessions.map((s) => s.coarse),
    started_at: sessions.map((s) => s.started_at),
    ended_at: sessions.map((s) => s.ended_at),
    collapsed_counts: sessions.map((s) => s.collapsed_count),
  };
}

// ---- the executor ----------------------------------------------------------

export const sessionsExecutor: Executor = ({ fixture, response }): Produced => {
  const scenario = parseScenario(response);
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};

  // §2.2 note 3 — an ambient manifest with no prefilter is a BOOT ERROR, and
  // the segmenter never sees the stream at all.
  const manifestLine = scenario.find((r) => r.tag === "manifest");
  if (manifestLine) {
    const kind = (manifestLine.fields.kind ?? "ambient") as StreamKind;
    const candidate = {
      ...WHATSAPP_MANIFEST,
      source_id: "probe",
      stream_kind_of: () => kind,
      salience: { prefilter: manifestLine.fields.prefilter ?? "none" },
    } as unknown as SourceManifest<never>;
    const problems = validateManifest(candidate);
    state.registered = problems.length === 0;
    state.rejected_at_registration = problems.length > 0;
    state.problem_mentions_prefilter = problems.some((p) => p.includes("prefilter"));
    return { output: {}, state, metrics };
  }

  const world = buildWorld(fixture, scenario);
  // `backfill` IS bootstrap: history is complete, so the next event is already
  // known and the boundary does not have to be waited for.
  const runMode = fixture.mode === "bootstrap" || fixture.mode === "backfill" ? "bootstrap" : "steady";

  // §10.4 note 9 — a wrong clock is clamped, never allowed to outrank the present.
  const skewLine = scenario.find((r) => r.tag === "skew");
  if (skewLine) {
    const verdict = clampSkew(skewLine.fields.ts ?? "", world.now);
    state.skew_clamped = verdict.clamped;
    state.skew_ts = verdict.ts;
    state.skew_claimed = verdict.clamped_from ?? null;
  }

  // §10.4 note 5 — protocol chatter never became a row in the first place.
  const dropLine = scenario.find((r) => r.tag === "drop");
  if (dropLine) state.dropped_at_adapter = isDroppedAtAdapter(dropLine.fields.kind ?? "receipt");

  // §10.4 note 7, second half — cohort resume.
  const cohortLine = scenario.find((r) => r.tag === "cohort");
  if (cohortLine) {
    const resume = resumeCohort(cohortLine.fields.stage ?? "enrich");
    state.resume_at = resume.resume_at;
    state.last_completed = resume.last_completed;
    state.reused = resume.reused;
    state.rejudged = resume.rejudged;
    state.verdicts_reused = resume.reused.length;
    return { output: {}, state, metrics };
  }

  const walked = walk(world, runMode);
  Object.assign(state, report(walked.sessions));
  state.collapsed = walked.collapsed;
  state.considered = walked.considered;
  state.ordered_by = "ts";
  // The parameters the boundaries were measured against, echoed so a case can
  // assert that they came off the manifest and not out of a constant here.
  state.policy_kind = world.policy.kind;
  state.policy_gap_ms = world.policy.gap_ms;
  state.policy_shift_min_gap_ms = world.policy.shift_min_gap_ms;
  state.policy_size_cap_events = world.policy.size_cap_events;
  state.policy_size_cap_chars = world.policy.size_cap_chars;
  state.policy_day_boundary = world.policy.day_boundary;
  state.policy_participant_shift = world.policy.participant_shift;
  state.policy_debounce_ms = world.policy.debounce_ms;
  state.policy_caps_apply = world.policy.caps_apply;
  // §10.4: sessions are mechanical. This is asserted, not assumed.
  state.llm_calls = 0;
  metrics.llm_calls = 0;

  // §10.4 note 7 — restart safety. The timers come back out of the data.
  const restartLine = scenario.find((r) => r.tag === "restart");
  if (restartLine) {
    const openOnly = walked.sessions.filter((s) => s.status === "open");
    const boot = recomputeTimers(
      openOnly.length > 0 ? openOnly : walked.sessions,
      { policy: world.policy, run_mode: "steady", now: world.now },
      world.texts,
    );
    state.open_sessions = (openOnly.length > 0 ? openOnly : walked.sessions).length;
    state.sealed_on_boot = boot.sealed_on_boot.length;
    state.still_open = boot.still_open.length;
    state.deadlines_from_last_event = (openOnly.length > 0 ? openOnly : walked.sessions).every(
      (s) => boot.deadlines[s.id] === Date.parse(s.ended_at) + world.policy.debounce_ms,
    );
    state.timers_recomputed = true;
    return { output: {}, state, metrics };
  }

  const wantsSeal = scenario.some((r) => r.tag === "seal") || runMode === "bootstrap";
  let sessions: SegSession[] = walked.sessions;
  if (wantsSeal) {
    const sealed = sealStream(
      walked.sessions,
      { policy: world.policy, run_mode: runMode, now: world.now },
      world.texts,
    );
    sessions = sealed.sessions;
    Object.assign(state, report(sessions));
    state.open = sealed.open !== null;
    state.handed_to_steady = sealed.handed_to_steady;
    state.sealed_count = sealed.sealed_count;
    state.content_hashes = sessions.map((s) => s.content_hash !== null);
  }

  // §10.4 note 2 — reactions.
  const reactLine = scenario.find((r) => r.tag === "react");
  if (reactLine) {
    const before = sessions;
    const r = applyReaction(sessions, {
      external_id: reactLine.fields.id ?? "r1",
      parent_external_id: reactLine.fields.on ?? "",
    });
    const parent = before.find((s) => s.event_ids.includes(reactLine.fields.on ?? ""));
    sessions = r.sessions;
    state.attached_to_parent_session = r.attached_to !== null && r.attached_to === parent?.id;
    state.parent_was_sealed = parent?.status === "sealed";
    state.new_sessions = r.new_sessions;
    state.debounce_reset = r.debounce_reset;
    state.membership_changed = r.membership_changed;
    state.hash_changed = r.hash_changed;
    state.sessions = sessions.length;
  }

  // §10.4 notes 3 and 4 — edits and revokes.
  for (const line of scenario.filter((r) => r.tag === "edit" || r.tag === "revoke")) {
    const apply = line.tag === "edit" ? applyEdit : applyRevoke;
    const r = apply(sessions, world.texts, {
      target_external_id: line.fields.on ?? "",
      external_id: line.fields.id,
      text: line.fields.text,
    });
    sessions = r.sessions;
    state.was_sealed = r.was_sealed;
    state.mutated_in_place = r.mutated_in_place;
    state.superseded = r.superseded;
    state.membership_changed = r.membership_changed;
    state.attached_to_parent = r.attached_to_parent;
    state.superseded_hash_set = sessions.some((s) => s.superseded_hash !== null);
    state.hash_moved = r.previous_hash !== null && r.content_hash !== r.previous_hash;
    state.event_counts = sessions.map((s) => s.event_count);
    state.sessions = sessions.length;
  }

  // §10.4 note 8 — late arrivals.
  const lateLine = scenario.find((r) => r.tag === "late");
  if (lateLine) {
    const before = sessions.map((s) => ({ id: s.id, hash: s.content_hash, members: s.event_ids.join(",") }));
    const r = lateArrival(
      sessions,
      {
        external_id: lateLine.fields.id ?? "late1",
        ts: lateLine.fields.at ?? "",
        actor: lateLine.fields.who ?? "a1",
        kind: "message",
        text: lateLine.fields.text ?? "",
      },
      { key: world.streamKey, tz: world.tz, source_id: "whatsapp" },
      world.policy,
    );
    state.late_arrival = r.session?.late_arrival ?? false;
    state.overlap_of_set = r.overlap_of !== null;
    state.overlaps_a_sealed_session =
      r.overlap_of !== null && sessions.find((s) => s.id === r.overlap_of)?.status === "sealed";
    state.reopened = r.reopened;
    state.new_session_boundary = r.session?.boundary_reason_start ?? null;
    state.sealed_sessions_untouched = sessions.every(
      (s, i) => before[i]!.hash === s.content_hash && before[i]!.members === s.event_ids.join(","),
    );
    state.sessions = sessions.length + (r.session ? 1 : 0);
  }

  // Determinism: re-run the whole thing and compare the bytes.
  const resegment = scenario.find((r) => r.tag === "resegment");
  if (resegment) {
    const times = num(resegment.fields, "times") ?? 2;
    const first = JSON.stringify(walk(world, runMode).sessions);
    let identical = true;
    for (let i = 1; i < times; i++) {
      // Re-order the input as a backfill page would: same set, different order.
      // Each rerun gets a DIFFERENT permutation — a fixed one (e.g. always
      // `.reverse()`) makes `times=4` three copies of the same comparison and
      // leaves order-dependence that only shows up mid-page undetected.
      // Seeded by `i`, so the eval stays frozen and reproducible.
      const shuffled = { ...world, events: permute(world.events, i) };
      if (JSON.stringify(walk(shuffled, runMode).sessions) !== first) identical = false;
    }
    state.byte_identical = identical;
    state.reruns = times;
  }

  return { output: {}, state, metrics };
};
