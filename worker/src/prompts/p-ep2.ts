// ===========================================================================
// [LLM-M] P-EP2 — episode segmentation — arch §12.3, template §5.6.
// Build item 2.2. Model: sonnet-5, thinking off.
//
// One call carries up to six SEALED sessions. For each one the model answers
// two questions and nothing else:
//
//   1. one topic or several?      -> the session splits into segments
//   2. per segment: attach or new? -> continue an OPEN episode of THAT stream,
//                                     or start a fresh one
//
// FOUR INVARIANTS THIS FILE EXISTS TO HOLD:
//
//   STREAM-SCOPED ONLY.  An episode is offered to a session only when it
//        belongs to that session's stream, and an attach naming an episode from
//        another stream is refused here even if the model asked for it. The
//        same topic in two chats is TWO episodes; joining them is arc work
//        (evals J-039..J-043). Nothing here ever compares two streams.
//
//   A WRONG MERGE DESTROYS, A WRONG SPLIT IS REPAIRABLE.  §12.3's own rule. An
//        attach under 0.6 confidence becomes a new episode; so does an attach
//        to an alias outside the roster range, and one with no alias at all.
//        Every demotion keeps what the model SAID beside what code ACTED ON —
//        `statedDecision`/`statedEpisodeId` survive, and `raw` is the line
//        byte-for-byte (build rule 9).
//
//   VERDICTS ARE PERSISTED, NEVER RE-JUDGED.  `episode_verdicts` holds one row
//        per segment with the whole segment in `output_json`, so run #2 over
//        the same sealed sessions makes ZERO calls and produces identical
//        episodes (evals J-048..J-051, arch §9.7 rule 5).
//
//   SEGMENTS PARTITION THE SESSION.  `checkPartition` reports missing,
//        duplicated and foreign event ids. It REPORTS — it does not edit the
//        model's segments. The engine (item 2.1) decides about a hole.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import {
  packPrompt,
  type PackEntity,
  type PackEpisode,
  type PackEvent,
  type PackStream,
} from "../wire/pack.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.3 "Settings", transcribed. */
export const P_EP2 = {
  id: "P-EP2",
  /** A valid `runs.role` (§4.4.4.4) — this call's spend is episode spend. */
  role: "episode",
  model: "sonnet-5",
  turns: 1,
  tools: "none",
  thinking: "off",
  timeoutSeconds: 120,
  /** "≤6 sessions / 8k in" — whichever cap is hit first closes the call. */
  maxSessionsPerCall: 6,
  maxInputTokens: 8_000,
  maxOutputTokens: 3_000,
  /** §12.3: "Confidence < 0.6 on an attach → prefer new." */
  attachMinConfidence: 0.6,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_EP2_TAGS = ["G"] as const;

/**
 * §12.3 SYSTEM, hardened after the proof4 run: the OUTPUT block is now the
 * legend-shaped template (one shape, not two — the old ad-hoc line embedded
 * bare "|" inside placeholders and taught field-boundary miscounts), carries a
 * worked example and an explicit no-prose/no-questions rule (the describe.ts
 * fix, which measurably stopped preamble leakage), and restates the closed
 * e-alias list at the answer site so an invented alias is a stated violation,
 * not a plausible reading. Field semantics are unchanged; the wire format is
 * untouched.
 */
export const P_EP2_SYSTEM = `You segment sealed sessions into topical episodes.

FOR EACH SESSION
1. One topic or several? Split only when the topic genuinely changes
   ("dinner plans" → "her surgery"). Small asides do not split. A segment
   needs ≥2 events or ≥1 substantial event.
2. Per segment: does it continue an OPEN episode of THAT stream, or start new?
   attach — the same ongoing matter, even days later
   new    — a different matter, even if the same people appear

RULES
- Segments MUST partition the session. Every event id appears exactly once.
- Attach only to e-aliases listed for that session's stream. Never invent one.
- Label: 2-6 plain words, concrete ("villa shortlist for Goa", not "travel talk").
  Episode labels are SHORT — they name a topic inside one stream. Thread/space
  names are longer (4-8 words) because they must be unique across a whole life.
- Sessions may arrive newer-first, so an open episode can be NEWER than the
  session you are placing. Judge by subject matter, never by order.
- Placeholders carry no topic signal. Never split or attach on one.
- Confidence < 0.6 on an attach → prefer new. A wrong merge destroys; a wrong
  split is repairable.

OUTPUT — G lines only, one per segment. Nothing before, between or after
them: no preamble, no explanation, no questions, no closing remark. If
anything is unclear, do not ask — emit new with low confidence instead.

  G | <session> | <events> | <decision> | <episode> | <confidence> | <topic>

  <session>    the block's s-token, copied verbatim (s1, s2, ...)
  <events>     the segment's event numbers — base-36, commas and ranges
  <decision>   att or new — nothing else
  <episode>    on att: ONE e-alias copied verbatim from that session's own
               #E lines (e1, e2, ...). Never invent one, never write words
               or the episode's label here. On new: exactly "-".
  <confidence> a decimal in [0,1]
  <topic>      the 2-6 word label — the ONLY field that may contain words

EXAMPLE — session s1: events 1-2 continue open episode e1, events 3-4 start
a new matter. The complete answer is exactly these two lines:
  G|s1|1,2|att|e1|0.93|villa shortlist for Goa
  G|s1|3,4|new|-|0.85|mom's medical reports`;

/**
 * §5.5's input grammar has no session marker — it packs streams, not sessions —
 * and P-EP2 is the only call whose output names a session. One `#S` line per
 * session block supplies that name. Additive to §5.5, constant, and therefore
 * still part of the stable cacheable prefix (§5.9.4).
 */
export const P_EP2_SESSION_MARKER = `INPUT — one block per sealed session, newest first:
  #S <s-token> | <c-alias> | <n> events    the session this block is
Everything under an #S line belongs to that session. Use its s-token in the
<session> field. The stream's open episodes are the #E lines in its block, and
they are the ONLY e-aliases that session may attach to.`;

/** legend + §12.3 SYSTEM + the `#S` gloss. Byte-identical on every call. */
export function buildEp2System(): string {
  return [ep2Legend(), P_EP2_SYSTEM, P_EP2_SESSION_MARKER].join("\n\n");
}

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function ep2Legend(): string {
  return legendFor({
    callType: P_EP2.id,
    tags: [...P_EP2_TAGS],
    aliases: ["stream", "episode"],
  });
}

// ---- the call --------------------------------------------------------------

export interface Ep2Session {
  /** The real `sessions.id`. Never sent to the model; the s-token stands in. */
  id: string;
  /** The stream this session was sealed in. Episode matching never leaves it. */
  streamId: string;
  /** The session's events, in order. Events of another stream are ignored. */
  events: readonly PackEvent[];
}

export interface Ep2Input {
  tz?: string;
  entities?: readonly PackEntity[];
  streams: readonly PackStream[];
  /**
   * Open episodes. An episode with no `streamId` is offered to NO session:
   * an unattributed episode cannot be proven to belong to this stream, and
   * "unsure which stream" is exactly the case that must not become an attach.
   */
  episodes?: readonly PackEpisode[];
  /** Sealed sessions, ≤6 per call. Newest first is fine (§12.3). */
  sessions: readonly Ep2Session[];
}

/** Everything the answer has to be read against. Thrown away with the prompt. */
export interface Ep2Context {
  table: AliasTable;
  /** `s1` -> real session id. */
  sessions: ReadonlyMap<string, string>;
  /** session id -> `s1`. */
  tokens: ReadonlyMap<string, string>;
  /** session id -> stream id. */
  sessionStreams: ReadonlyMap<string, string>;
  /** episode id -> stream id — the never-cross-streams check. */
  episodeStreams: ReadonlyMap<string, string>;
  /** session id -> the event ids it actually holds, in order. */
  sessionEvents: ReadonlyMap<string, readonly string[]>;
  /** session id -> the open episode ids offered to it. */
  candidates: ReadonlyMap<string, readonly string[]>;
}

export interface Ep2Prompt {
  system: string;
  user: string;
  context: Ep2Context;
  stats: { sessions: number; events: number; candidates: number };
}

/** §12.3 caps the call at six sessions; this is where that cap is applied. */
export function chunkSessions(
  sessions: readonly Ep2Session[],
  size: number = P_EP2.maxSessionsPerCall,
): Ep2Session[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Ep2Session[][] = [];
  for (let i = 0; i < sessions.length; i += limit) out.push(sessions.slice(i, i + limit));
  return out;
}

/**
 * Build the call. One packed block per session, all sharing ONE alias table so
 * a stream, an entity or an open episode carries the same alias everywhere in
 * the prompt. The roster rides on the first block only; later blocks resolve
 * against aliases it already minted.
 *
 * Returns `null` when the roster is over the packer's cap — a truncated roster
 * is how a model gets blamed for attaching to the wrong episode (§5.9.3).
 */
export function buildEp2Prompt(input: Ep2Input): Ep2Prompt | null {
  const table = createAliasTable();
  const sessions = new Map<string, string>();
  const tokens = new Map<string, string>();
  const sessionStreams = new Map<string, string>();
  const episodeStreams = new Map<string, string>();
  const sessionEvents = new Map<string, readonly string[]>();
  const candidates = new Map<string, readonly string[]>();

  for (const ep of input.episodes ?? []) {
    if (ep.streamId) episodeStreams.set(ep.id, ep.streamId);
  }

  const blocks: string[] = [];
  let events = 0;
  let offered = 0;

  for (const session of input.sessions) {
    const stream = input.streams.find((s) => s.id === session.streamId);
    if (!stream) continue;
    const token = `s${sessions.size + 1}`;
    // STREAM-SCOPED: only this stream's open episodes are ever shown.
    const open = (input.episodes ?? []).filter((ep) => ep.streamId === session.streamId);
    const own = session.events.filter((e) => e.streamId === session.streamId);

    // Roster on the first block ACTUALLY EMITTED — keying off the loop index
    // drops `#R` whenever session[0] is skipped, leaving `#C` speaking in
    // aliases the model was never given (§5.9.3).
    const packed = packPrompt({
      tz: input.tz,
      entities: blocks.length === 0 ? [...(input.entities ?? [])] : [],
      streams: [stream],
      episodes: [...open],
      events: [...own],
    }, { table });
    if (!packed.ok) return null;

    const streamToken = table.tokenFor("stream", stream.id) ?? "-";
    blocks.push(`#S ${token} | ${streamToken} | ${own.length} events\n${packed.text}`);

    sessions.set(token, session.id);
    tokens.set(session.id, token);
    sessionStreams.set(session.id, session.streamId);
    sessionEvents.set(session.id, own.map((e) => e.id));
    candidates.set(session.id, open.map((ep) => ep.id));
    events += own.length;
    offered += open.length;
  }

  return {
    system: buildEp2System(),
    user: blocks.join("\n"),
    context: { table, sessions, tokens, sessionStreams, episodeStreams, sessionEvents, candidates },
    stats: { sessions: sessions.size, events, candidates: offered },
  };
}

// ---- the answer ------------------------------------------------------------

export type Ep2Decision = "attach" | "new";

/** Why the acted decision is not the stated one. `null` = they agree. */
export type Ep2Demotion = "low_confidence" | "cross_stream" | "unknown_episode" | "no_episode";

export interface Ep2Segment {
  /** The s-token the model wrote, verbatim. */
  sessionToken: string;
  /** The session it names, or `null` when it names one not in this call. */
  sessionId: string | null;
  eventIds: string[];
  /** Event tokens the table could not place. Reported, never guessed. */
  unresolvedEvents: string[];
  /** What the model said. Preserved whatever code then decides. */
  statedDecision: Ep2Decision;
  statedEpisodeAlias: string | null;
  statedEpisodeId: string | null;
  /** What code will act on, after §12.3's attach rules. */
  decision: Ep2Decision;
  episodeId: string | null;
  demoted: Ep2Demotion | null;
  confidence: number | null;
  label: string;
  /** The model's own line, byte-for-byte. */
  raw: string;
}

export interface Ep2Answer {
  segments: Ep2Segment[];
  /** Segments whose s-token names no session in this call. Never reassigned. */
  orphans: Ep2Segment[];
  /** Lines the parser judged but this call may not emit — counted, not dropped. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  parse: WireParseResult;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function eventsFor(
  raw: unknown,
  table: AliasTable,
): { eventIds: string[]; unresolvedEvents: string[] } {
  const numbers = Array.isArray(raw) ? (raw as number[]) : [];
  const eventIds: string[] = [];
  const unresolvedEvents: string[] = [];
  for (const n of numbers) {
    const token = Number.isInteger(n) ? n.toString(36) : String(n);
    const id = table.eventId(token);
    if (id) eventIds.push(id);
    else unresolvedEvents.push(token);
  }
  return { eventIds, unresolvedEvents };
}

/**
 * §12.3's attach rules, in the order a wrong merge gets caught earliest.
 *
 *   no alias        -> new   the model said attach and named nobody
 *   alias unknown   -> new   outside the roster range; NEVER the nearest one
 *   other stream    -> new   episodes do not cross streams, ever
 *   conf < 0.6      -> new   "a wrong merge destroys; a wrong split is repairable"
 */
function decide(
  stated: Ep2Decision,
  episodeId: string | null,
  aliasWritten: boolean,
  confidence: number | null,
  sessionStream: string | null,
  episodeStreams: ReadonlyMap<string, string>,
): { decision: Ep2Decision; episodeId: string | null; demoted: Ep2Demotion | null } {
  if (stated !== "attach") return { decision: "new", episodeId: null, demoted: null };
  if (!aliasWritten) return { decision: "new", episodeId: null, demoted: "no_episode" };
  if (episodeId === null) return { decision: "new", episodeId: null, demoted: "unknown_episode" };
  const stream = episodeStreams.get(episodeId);
  if (sessionStream !== null && stream !== undefined && stream !== sessionStream) {
    return { decision: "new", episodeId: null, demoted: "cross_stream" };
  }
  if (confidence !== null && confidence < P_EP2.attachMinConfidence) {
    return { decision: "new", episodeId: null, demoted: "low_confidence" };
  }
  return { decision: "attach", episodeId, demoted: null };
}

/**
 * Parse a P-EP2 answer. Never throws (§5.8): a rejected line comes back as a
 * violation quoting the model verbatim, ready for the ONE repair round, and a
 * tag this call may not emit is counted in `otherRecords` rather than dropped.
 */
export function parseEp2Response(response: unknown, context: Ep2Context): Ep2Answer {
  const parse = parseWire(response);
  const segments: Ep2Segment[] = [];
  const orphans: Ep2Segment[] = [];
  const otherRecords: WireRecord[] = [];

  for (const record of parse.records) {
    if (record.tag !== "G") {
      otherRecords.push(record);
      continue;
    }
    const v = record.values;
    const sessionToken = str(v.session).trim();
    const sessionId = context.sessions.get(sessionToken) ?? null;
    const sessionStream = sessionId === null ? null : (context.sessionStreams.get(sessionId) ?? null);

    const stored = str(v.decision);
    // A blank decision is not an attach. Absent means "not stated" (§5.1).
    const statedDecision: Ep2Decision = stored === "attach" ? "attach" : "new";

    const aliasRaw = str(v.episode).trim();
    const aliasWritten = aliasRaw !== "" && aliasRaw !== "-";
    const resolution = context.table.resolve(aliasRaw);
    const ref = resolution.resolved;
    const statedEpisodeId = ref && ref.kind === "episode" ? ref.id : null;

    const confidence = typeof v.confidence === "number" ? v.confidence : null;
    const acted = decide(
      statedDecision,
      statedEpisodeId,
      aliasWritten,
      confidence,
      sessionStream,
      context.episodeStreams,
    );

    const segment: Ep2Segment = {
      sessionToken,
      sessionId,
      ...eventsFor(v.events, context.table),
      statedDecision,
      statedEpisodeAlias: aliasWritten ? aliasRaw : null,
      statedEpisodeId,
      decision: acted.decision,
      episodeId: acted.episodeId,
      demoted: acted.demoted,
      confidence,
      label: str(v.topic).trim(),
      raw: record.raw,
    };
    if (sessionId === null) orphans.push(segment);
    else segments.push(segment);
  }

  return { segments, orphans, otherRecords, violations: parse.violations, parse };
}

// ---- the partition invariant -----------------------------------------------

export interface Ep2PartitionReport {
  sessionId: string;
  /** The session's own event ids, in order. */
  expected: string[];
  /** Covered exactly once. */
  covered: string[];
  /** In the session, in no segment. */
  missing: string[];
  /** In more than one segment. */
  duplicated: string[];
  /** In a segment, not in the session. */
  foreign: string[];
  ok: boolean;
}

/**
 * §12.3: "Segments MUST partition the session. Every event id appears exactly
 * once." This REPORTS the three ways that fails; it never edits or drops a
 * segment. A repair round re-asks the model, it does not invent the answer.
 */
export function checkPartition(
  context: Ep2Context,
  segments: readonly Ep2Segment[],
): Ep2PartitionReport[] {
  const out: Ep2PartitionReport[] = [];
  for (const [sessionId, expected] of context.sessionEvents) {
    const own = new Set(expected);
    const seen = new Map<string, number>();
    const foreign: string[] = [];
    for (const seg of segments) {
      if (seg.sessionId !== sessionId) continue;
      for (const id of seg.eventIds) {
        if (!own.has(id)) {
          if (!foreign.includes(id)) foreign.push(id);
          continue;
        }
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    const covered = expected.filter((id) => seen.get(id) === 1);
    const missing = expected.filter((id) => !seen.has(id));
    const duplicated = expected.filter((id) => (seen.get(id) ?? 0) > 1);
    out.push({
      sessionId,
      expected: [...expected],
      covered,
      missing,
      duplicated,
      foreign,
      ok: missing.length === 0 && duplicated.length === 0 && foreign.length === 0,
    });
  }
  return out;
}

// ---- verdicts: persist once, replay forever --------------------------------
//
// ONE ROW PER SESSION, `output_json = { segments: [...] }`.
//
// This shape is not a choice — it is the shape `episodes/engine.ts` reads.
// `storedSegments()` there requires `output_json` to be an object carrying a
// `segments` ARRAY, and `readVerdictForHash()` takes the newest row for a
// content hash. An earlier version of this file wrote ONE ROW PER SEGMENT with
// `output_json` set to a bare `Ep2Segment`, which made `storedSegments()`
// return null: the hash gate would miss, the session would be silently
// RE-JUDGED, and the one rule this call exists to keep ("verdicts are
// persisted, never re-judged") would break in exactly the case it is for.
// Two writers, one table, one readable shape.
//
// Nothing is lost by nesting: the whole `Ep2Segment` rides inside the array,
// so `statedDecision`, `demoted` and the model's verbatim `raw` line all still
// survive the round trip, and the engine reads the fields it knows about.

function verdictId(): string {
  return `epv_${randomBytes(12).toString("hex")}`;
}

export interface Ep2VerdictRow {
  id: string;
  episodeId: string | null;
  sessionId: string;
  runId: string | null;
  decision: string;
  candidates: string[];
  /** Every segment of this session's verdict, in the order it was judged. */
  segments: Ep2Segment[];
  model: string | null;
  createdAt: string;
}

/** True when this session already has a verdict — the replay gate (§9.7 r5). */
export function hasEpisodeVerdict(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS hit FROM episode_verdicts WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as { hit: number } | undefined;
  return row !== undefined;
}

/** The sessions in `ids` that still need a call. The others are already judged. */
export function sessionsNeedingCall(ids: readonly string[]): string[] {
  return ids.filter((id) => !hasEpisodeVerdict(id));
}

interface RawVerdictRow {
  id: string;
  episode_id: string | null;
  session_id: string;
  run_id: string | null;
  decision: string | null;
  candidates_json: string | null;
  output_json: string | null;
  model: string | null;
  created_at: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Every stored verdict for a session, in the order it was written. */
export function readEpisodeVerdicts(sessionId: string): Ep2VerdictRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, episode_id, session_id, run_id, decision, candidates_json, output_json, model, created_at
         FROM episode_verdicts WHERE session_id = ? ORDER BY rowid`,
    )
    .all(sessionId) as RawVerdictRow[];
  return rows.map((r) => {
    const output = parseJson<{ segments?: unknown }>(r.output_json);
    const list = output !== null && Array.isArray(output.segments) ? (output.segments as Ep2Segment[]) : [];
    return {
      id: r.id,
      episodeId: r.episode_id,
      sessionId: r.session_id,
      runId: r.run_id,
      decision: r.decision ?? "new",
      candidates: parseJson<string[]>(r.candidates_json) ?? [],
      segments: list,
      model: r.model,
      createdAt: r.created_at,
    };
  });
}

/**
 * Rebuild the segments this session was judged into, from disk. Replay reuses
 * these and makes no call at all, which is what makes run #2 over the same
 * sealed sessions produce identical episodes (evals J-048..J-051).
 */
export function replayVerdicts(sessionId: string): Ep2Segment[] {
  return readEpisodeVerdicts(sessionId).flatMap((row) => row.segments);
}

export interface PersistEp2Params {
  sessionId: string;
  segments: readonly Ep2Segment[];
  runId?: string | null;
  model?: string | null;
  /** The open episode ids this session was offered, for later audit. */
  candidates?: readonly string[];
}

export interface PersistEp2Result {
  ids: string[];
  /** True when a verdict already existed and nothing was written. */
  reused: boolean;
}

/**
 * One row for the session — the acted decision, the candidates it chose from,
 * and every segment under `output_json.segments` so the stated decision, the
 * demotion and the model's own line all survive the round trip IN THE SHAPE
 * `episodes/engine.ts` reads back. Idempotent: a session that already carries
 * a verdict is NOT re-judged and NOT re-written.
 */
export function persistEp2Verdicts(params: PersistEp2Params): PersistEp2Result {
  const existing = readEpisodeVerdicts(params.sessionId);
  if (existing.length > 0) return { ids: existing.map((r) => r.id), reused: true };

  const segments = [...params.segments];
  const id = verdictId();
  // The row's own `decision` summarises the session: `new` unless something
  // attached. The per-segment decisions are all inside `segments`.
  const decision = segments.some((s) => s.decision === "attach") ? "attach" : "new";
  getDb()
    .prepare(
      `INSERT INTO episode_verdicts
         (id, episode_id, session_id, run_id, decision, candidates_json, output_json, model)
       VALUES (@id, @episodeId, @sessionId, @runId, @decision, @candidatesJson, @outputJson, @model)`,
    )
    .run({
      id,
      episodeId: segments.find((s) => s.episodeId !== null)?.episodeId ?? null,
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      decision,
      candidatesJson: JSON.stringify([...(params.candidates ?? [])]),
      outputJson: JSON.stringify({ segments }),
      model: params.model ?? P_EP2.model,
    });
  return { ids: [id], reused: false };
}

/** The share of sessions that came out 1:1 — one segment, `new` (evals J-001+). */
export function oneToOneRate(reports: readonly Ep2PartitionReport[], segments: readonly Ep2Segment[]): number {
  if (reports.length === 0) return 0;
  let hits = 0;
  for (const report of reports) {
    const own = segments.filter((s) => s.sessionId === report.sessionId);
    if (own.length === 1 && own[0].decision === "new") hits += 1;
  }
  return hits / reports.length;
}
