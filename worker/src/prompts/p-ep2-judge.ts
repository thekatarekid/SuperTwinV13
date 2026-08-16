// ===========================================================================
// [LLM-M] The P-EP2 judge adapter — build item 2.2, the seam item 2.1 declared.
//
// `episodes/engine.ts` ends its P-EP2 branch with
//
//     export type EpisodeJudge = (req: JudgeRequest) => JudgeResult | null;
//     /** Item 2.2 (P-EP2) implements this. The engine never builds a prompt. */
//
// and nothing implemented it: `p-ep2.ts` spoke a multi-session `Ep2Input`
// while the engine asks one session at a time, so the prompt was real, tested,
// and reachable from nothing but its own test file. The engine's only judge
// was the eval harness's frozen-answer stub, which is how a whole category can
// go green while the call it is named after never runs.
//
// This file is the conversion, and only the conversion:
//
//   JudgeRequest  ──► Ep2Input ──► buildEp2Prompt ──► <the model> ──► JudgeResult
//
// WHY THE ENGINE STILL PARSES THE ANSWER. `p-ep2.ts` has its own reader
// (`parseEp2Response`), and it is the richer one — it keeps the stated
// decision beside the acted one. But the engine has to apply the partition
// repair and write the tables, and two readers disagreeing about one answer is
// how the two-writers bug in `episode_verdicts` happened. So exactly one
// reader runs per pass: the engine's. What this adapter hands back is the
// model's words and THE ALIAS TABLE THE PROMPT WAS BUILT WITH, which is the
// only thing that makes `e1` and `3` mean anything downstream.
//
// A prompt that cannot be built is `null`, never a guess: a truncated roster
// is how a model gets blamed for attaching to the wrong episode (§5.9.3), and
// `runEpisodePass` reads a null judge as "fall back to 1:1", which is the safe
// direction (a wrong split is repairable; a wrong merge destroys).
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { EpisodeJudge, JudgeRequest } from "../episodes/engine.js";
import type { PackEpisode, PackEvent, PackStream } from "../wire/pack.js";
import { P_EP2, buildEp2Prompt, type Ep2Input } from "./p-ep2.js";

/**
 * What actually talks to the model. Returns the answer verbatim, or null when
 * the call could not be made — a quota pause, a timeout, a dry run. Injected
 * so this file never reaches for a provider and stays testable offline.
 */
export type Ep2Invoke = (prompt: { system: string; user: string; model: string }) => string | null;

interface StreamRow {
  id: string;
  label: string | null;
  stream_kind: string | null;
  participant_entity_ids: string | null;
}

interface EventRow {
  id: string;
  stream_id: string | null;
  ts: string | null;
  actor_id: string | null;
  text: string | null;
}

function parseIds(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The stream the session was sealed in, as `#C` wants it. */
function streamOf(streamId: string): PackStream | null {
  const row = getDb()
    .prepare(`SELECT id, label, stream_kind, participant_entity_ids FROM streams WHERE id = ?`)
    .get(streamId) as StreamRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.label ?? row.id,
    kind: row.stream_kind ?? "dm",
    participantIds: parseIds(row.participant_entity_ids),
  };
}

/**
 * The session's events, IN SESSION ORDER — `session.eventIds` is the order the
 * seal froze, and re-sorting by `ts` here would hand the model a different
 * sequence than the one the engine will read the answer against.
 */
function eventsOf(session: JudgeRequest["session"]): PackEvent[] {
  if (session.eventIds.length === 0) return [];
  const marks = session.eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, stream_id, ts, actor_id, text FROM events WHERE id IN (${marks})`)
    .all(...session.eventIds) as EventRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PackEvent[] = [];
  for (const id of session.eventIds) {
    const row = byId.get(id);
    if (row === undefined) continue;
    out.push({
      id: row.id,
      streamId: row.stream_id ?? session.streamId,
      at: row.ts ?? session.startedAt ?? "",
      speakerId: row.actor_id ?? "self",
      ...(row.text === null ? {} : { text: row.text }),
    });
  }
  return out;
}

/** The open episodes of this stream, as `#E` lines. Stream-scoped, always. */
function episodesOf(req: JudgeRequest): PackEpisode[] {
  return req.candidates
    .filter((c) => c.streamId === req.session.streamId)
    .map((c) => ({
      id: c.id,
      label: c.topicLabel ?? "",
      state: "open",
      ...(c.lastActiveAt === null ? {} : { lastActivity: c.lastActiveAt }),
      entityIds: [...c.entityIds],
      streamId: c.streamId ?? req.session.streamId,
    }));
}

/** The `Ep2Input` for one session, or null when the stream is unreadable. */
export function ep2InputFor(req: JudgeRequest, tz?: string): Ep2Input | null {
  const stream = streamOf(req.session.streamId);
  if (stream === null) return null;
  const events = eventsOf(req.session);
  if (events.length === 0) return null;
  return {
    ...(tz === undefined ? {} : { tz }),
    streams: [stream],
    episodes: episodesOf(req),
    sessions: [{ id: req.session.id, streamId: req.session.streamId, events }],
  };
}

/**
 * The `EpisodeJudge` item 2.1 left a hole for. Give it something that can talk
 * to a model and `runEpisodePass` runs the real P-EP2 call.
 */
export function ep2Judge(invoke: Ep2Invoke, opts: { tz?: string } = {}): EpisodeJudge {
  return (req) => {
    const input = ep2InputFor(req, opts.tz);
    if (input === null) return null;
    const prompt = buildEp2Prompt(input);
    if (prompt === null || prompt.stats.sessions === 0) return null;
    const response = invoke({ system: prompt.system, user: prompt.user, model: P_EP2.model });
    if (response === null) return null;
    return { response, table: prompt.context.table, model: P_EP2.model, calls: 1 };
  };
}
