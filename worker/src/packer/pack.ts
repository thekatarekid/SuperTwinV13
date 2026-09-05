// ===========================================================================
// The pack (V6 P1 S3.2; Build §6.1 "Packer rewrite"; Product_V6_Phase1 §7;
// Product_V6 §23.7 rules 9, 10, 15).
//
// Assembled by code at T0 — zero model calls — for every bundle, in this
// order:
//
//   [NOW]               current time · lane · band (+ the band policy)
//   [ROSTER]            resolved people, relationships, nicknames; unresolved
//   [OPEN TASKS]        live tasks of the pack's spaces
//   [CALENDAR]          what falls due or fires in the next days
//   [CANDIDATE SPACES]  from retrieval, hard cap 5, with exemplars — NEVER an
//                       enumeration of the spaces table
//   <untrusted>         ── everything captured sits inside this ONE block ──
//   [BRIDGED]           bridges touching the bundle + related cross-source
//                       episodes
//   [THREAD S<k>]       episode-bounded history, one section per stream
//                       (5 streams, ~1,500 chars each); quoted messages always
//   [EPISODES]          open + recently dormant episodes of those streams
//   [BUNDLE]            the new events, e1..eN in log order, sectioned by
//                       stream; every head carries time (with seconds) ·
//                       source · actor · kind · app · title · doc; text is
//                       budgeted from the remaining allowance (floor 400,
//                       ceiling 4,000)
//   </untrusted>
//
// Budget: the whole pack targets 16,000 chars and is flat as the user's data
// grows — every block reads a bounded set (caps, retrieval, membership), so
// 104 spaces cost the same as 4. Thin context (no history, no episode, no
// candidate) is flagged; the hold-once policy keeps the bundle one flush,
// then sends it with the insufficient-context instruction (PCK-06).
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { DeltaBundle, BundleEvent } from "../scheduler/dispatch.js";
import { ftsProjection, type EventEnvelope } from "../db/eventlog.js";
import {
  newServeCounters,
  readCachedDigest,
  renderDigestLine,
  serveContent,
  type ServeCounters,
} from "./digest.js";
import {
  crossSourceEpisodes,
  streamEpisodes,
  streamFacts,
  threadHistory,
  HISTORY_CHARS_PER_STREAM,
  HISTORY_STREAMS,
  type EpisodeSummary,
  type HistoryEvent,
  type StreamFacts,
} from "./history.js";
import { candidateSpaces, MAX_CANDIDATE_SPACES, type CandidateSpace } from "./spaces.js";
import { buildRoster, renderRosterEntry, type Roster } from "./roster.js";
import { calendarItems, openTasks, renderCalendarItem, renderOpenTask } from "./agenda.js";
import { bridgedBlock } from "./bridged.js";
import {
  clip,
  clipBody,
  eventAllowance,
  historyAllowance,
  EVENT_TEXT_FLOOR,
  HISTORY_QUOTED_MIN,
  PACK_BUDGET_CHARS,
} from "./budget.js";
import {
  clearThinHold,
  decideThin,
  holdThinOnce,
  THIN_BUNDLE_CHARS,
  THIN_BUNDLE_EVENTS,
  THIN_CONTEXT_INSTRUCTION,
  type ThinPolicy,
} from "./thin.js";
import {
  collapseVisitRuns,
  isVisitRun,
  visitRunBody,
  visitRunHead,
  visitRunSpan,
} from "../adapters/browser/render.js";

export interface PackOptions {
  /** Whole-pack budget, chars. Default PACK_BUDGET_CHARS. */
  maxChars?: number;
  nowMs?: number;
  /** Candidate spaces returned (never above 5). */
  candidateLimit?: number;
  /** What to do with a thin pack. Default hold-once. */
  thinPolicy?: ThinPolicy;
}

/** Kept for callers that size against the budget. */
export const DEFAULT_PACK_MAX_CHARS = PACK_BUDGET_CHARS;

export const UNTRUSTED_OPEN = "<untrusted>";
export const UNTRUSTED_CLOSE = "</untrusted>";

export interface PackStats {
  chars: number;
  /** Text allowance applied to each bundle event. */
  eventAllowance: number;
  /** Streams that got a [THREAD] section. */
  historyStreams: number;
  historyEvents: number;
  candidates: number;
  /** Retrieval inside the packer never calls a model. Always 0. */
  modelCalls: 0;
  tookMs: number;
  /** Chars per block, for the size gate. */
  blocks: Record<string, number>;
}

export interface PackedContext {
  /** The packed user half of the Orient call. */
  user: string;
  /** Alias -> event id for the bundle (e1..eN, log order). */
  eventAliases: Map<string, string>;
  /** Section tag -> stream id (S1..Sk; S1 is the bundle's own stream). */
  streamAliases: Map<string, string>;
  /** Candidate space ids offered, in rank order (≤ 5). */
  candidateSpaceIds: string[];
  /** Episode ids offered (all sections). */
  episodeIds: string[];
  /** Fidelity-level serve counts for the run ledger. */
  serveCounters: ServeCounters;
  /** True when the pack had to give ground below its soft budgets. */
  trimmed: boolean;
  /** The pack could not assemble enough (PCK-06). */
  thin: boolean;
  thinReasons: string[];
  /** hold-once: this flush is the hold — do not call the model, leave the events unmarked. */
  held: boolean;
  stats: PackStats;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-08-28T19:42:07.000Z" -> "2026-08-28 19:42:07" (seconds kept — T8-4). */
export function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "?";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?/.exec(ts);
  if (!m) return ts;
  return `${m[1]} ${m[2]}${m[3] ?? ":00"}`;
}

/**
 * The identity part of an event head (V6 S1.6 / T6-7, SRC-03): app · window
 * title · doc key for a screen snapshot, tab title · URL for a browser visit,
 * nothing for a chat message.
 */
export function eventIdentityHead(payload: Record<string, unknown>): string {
  const id = ftsProjection(payload);
  const parts = [id.app, id.windowTitle, id.docKey].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  return uniq.map((p) => p.slice(0, 160)).join(" · ");
}

/** Captured text can never close the untrusted block. */
export function neutralise(text: string): string {
  return text.replace(/<(\/?)untrusted/gi, "<$1​untrusted");
}

function parsePayload(json: string | null | undefined): Record<string, unknown> {
  try {
    const p = JSON.parse(json ?? "{}") as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toEnvelope(e: BundleEvent, streamKey: string, source: string, contentHash?: string): EventEnvelope {
  const payload = parsePayload(e.payloadJson);
  let roles = { sender: e.actor ?? "?", audience: [], receiver: [], mentions: [] };
  try {
    const r = JSON.parse(e.rolesJson ?? "null");
    if (r && typeof r === "object") roles = { ...roles, ...r };
  } catch {
    /* structural default */
  }
  return {
    id: e.id,
    ts: e.ts ?? "",
    source,
    kind: e.kind ?? "",
    origin: e.origin,
    ageBand: e.ageBand,
    streamKey,
    actor: e.actor ?? "?",
    roles,
    payload,
    contentHash: contentHash ?? (typeof payload.content_hash === "string" ? payload.content_hash : undefined),
  };
}

/** content_hash per bundle event id (the rows the dispatcher hands over omit it). */
function contentHashes(eventIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (eventIds.length === 0) return out;
  const ph = eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, content_hash FROM events WHERE id IN (${ph})`)
    .all(...eventIds) as { id: string; content_hash: string | null }[];
  for (const r of rows) if (r.content_hash) out.set(r.id, r.content_hash);
  return out;
}

/** The stream each bundle event belongs to (a live bundle may span streams). */
function streamOfEvents(eventIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (eventIds.length === 0) return out;
  const ph = eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, stream_id FROM events WHERE id IN (${ph})`)
    .all(...eventIds) as { id: string; stream_id: string | null }[];
  for (const r of rows) if (r.stream_id) out.set(r.id, r.stream_id);
  return out;
}

function sourceOf(e: BundleEvent, facts: StreamFacts | null, streamId: string): string {
  if (e.sourceId) return e.sourceId;
  if (facts?.sourceId) return facts.sourceId;
  const i = streamId.indexOf(":st:");
  return i > 0 ? streamId.slice(0, i) : "?";
}

function renderEpisode(tag: string, ep: EpisodeSummary): string {
  const space = ep.spaceId ? ` → ${ep.spaceId}${ep.spaceLabel ? ` "${clip(ep.spaceLabel, 60)}"` : ""}` : "";
  return `${tag} ${ep.id} "${clip(ep.summary ?? "(no summary)", 140)}" ${ep.state} ${fmtTs(ep.lastTs)}${space}`;
}

function renderCandidate(idx: number, c: CandidateSpace): string {
  const bits = [`${idx}. ${c.id} "${clip(c.label, 80)}"`];
  if (c.lifeArea) bits.push(c.lifeArea);
  if (c.status !== "active") bits.push(c.status);
  if (c.goal) bits.push(`goal: ${clip(c.goal, 120)}`);
  bits.push(`via ${c.lanes.join("+")}`);
  if (c.exemplars.length > 0) bits.push(`exemplars: ${c.exemplars.map((e) => `"${clip(e, 80)}"`).join(", ")}`);
  return bits.join(" · ");
}

/**
 * Spec §5.3 rendered into the pack: the age-band policy travels WITH the band
 * letter, so the model never has to remember the table. Band A adds nothing.
 */
export function bandPolicyLine(band: string): string {
  switch (band) {
    case "A":
      return "[BAND POLICY] A (0-30d): extract everything.";
    case "B":
      return "[BAND POLICY] B (1-6mo): spaces, claims, recurrences; tasks ONLY with verified still-open evidence. Never stale-task spam.";
    case "C":
      return "[BAND POLICY] C (6mo-2y): claims, CRM, recurrences (renewals, birthdays), life events. Never live tasks - recurrence templates only.";
    case "D":
      return "[BAND POLICY] D (2y+): coarse claims, relationships, narrative only. Never tasks; never spaces (unless clearly alive).";
    default:
      return `[BAND POLICY] ${band}: unknown band - extract conservatively; no tasks.`;
  }
}

/** Bundle identity for the thin hold (same shape as the consumer's key). */
export function packBundleKey(bundle: DeltaBundle): string {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const e of bundle.events) {
    if (e.rowid < min) min = e.rowid;
    if (e.rowid > max) max = e.rowid;
  }
  if (!Number.isFinite(min)) min = 0;
  return `${bundle.streamId}:${min}-${max}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  tag: string;
  streamId: string;
  facts: StreamFacts | null;
  events: BundleEvent[];
  history: HistoryEvent[];
  episodes: EpisodeSummary[];
}

function sectionHead(s: Section): string {
  const source = s.facts?.sourceId ?? sourceOf(s.events[0] ?? ({} as BundleEvent), s.facts, s.streamId);
  const label = s.facts?.label ? ` "${clip(s.facts.label, 60)}"` : "";
  const key = s.facts?.streamKey ?? s.streamId;
  const kind = s.facts?.kind ? ` ${s.facts.kind}` : "";
  return `${s.tag} · ${source}${kind}${label} · ${key}`;
}

function historyLine(h: HistoryEvent, allowance: number): string {
  const identity = eventIdentityHead(parsePayload(h.payloadJson));
  const max = h.quoted ? Math.max(allowance, HISTORY_QUOTED_MIN) : allowance;
  const flags = h.quoted ? "quoted" : h.inEpisode ? "" : "run-up";
  const head = `${fmtTs(h.ts)} · ${h.actor ?? "?"}${flags ? ` (${flags})` : ""}${identity ? ` · ${clip(identity, 80)}` : ""}`;
  return `  ${head}: ${neutralise(clip(h.text, max))}`;
}

function renderThread(s: Section, budget: number): string {
  if (s.history.length === 0) return `[THREAD ${sectionHead(s)}] (no history)`;
  const inEpisode = s.history.filter((h) => h.inEpisode).length;
  const quoted = s.history.filter((h) => h.quoted).length;
  const counts = [
    inEpisode > 0 ? `open episode ${inEpisode}` : "",
    s.history.length - inEpisode - quoted > 0 ? `run-up ${s.history.length - inEpisode - quoted}` : "",
    quoted > 0 ? `quoted ${quoted}` : "",
  ]
    .filter((c) => c !== "")
    .join(" + ");
  const allowance = historyAllowance(budget, s.history.length);
  return (
    `[THREAD ${sectionHead(s)}] ${s.history.length} events (${counts})\n` +
    s.history.map((h) => historyLine(h, allowance)).join("\n")
  );
}

// ---------------------------------------------------------------------------
// The packer
// ---------------------------------------------------------------------------

/** Assemble the Orient user block for one bundle. */
export async function packOrientContext(
  bundle: DeltaBundle,
  opts: PackOptions = {},
): Promise<PackedContext> {
  const started = performance.now();
  const maxChars = opts.maxChars ?? PACK_BUDGET_CHARS;
  const nowMs = opts.nowMs ?? Date.now();
  const thinPolicy = opts.thinPolicy ?? "hold-once";
  const counters = newServeCounters();
  const events = [...bundle.events].sort((a, b) => a.rowid - b.rowid);

  // ---- Sections: S1 is the bundle's stream; the rest in first-rowid order.
  const streamOf = streamOfEvents(events.map((e) => e.id));
  const order: string[] = [bundle.streamId];
  for (const e of events) {
    const sid = streamOf.get(e.id) ?? bundle.streamId;
    if (!order.includes(sid)) order.push(sid);
  }
  const sections: Section[] = order.map((streamId, i) => {
    const mine = events.filter((e) => (streamOf.get(e.id) ?? bundle.streamId) === streamId);
    return {
      tag: `S${i + 1}`,
      streamId,
      facts: streamFacts(streamId),
      events: mine,
      history: i < HISTORY_STREAMS ? threadHistory(streamId, mine) : [],
      episodes: streamEpisodes(streamId, { nowMs }),
    };
  });
  const streamAliases = new Map(sections.map((s) => [s.tag, s.streamId]));
  const sectionOf = new Map<string, Section>();
  for (const s of sections) for (const e of s.events) sectionOf.set(e.id, s);

  // ---- Aliases: e1..eN in log order.
  const eventAliases = new Map<string, string>();
  events.forEach((e, i) => eventAliases.set(`e${i + 1}`, e.id));
  const aliasOfId = new Map([...eventAliases].map(([a, id]) => [id, a]));

  // ---- Retrieval (T0, zero model calls) + world-model reads.
  const candidates = await candidateSpaces(events, {
    limit: Math.min(opts.candidateLimit ?? MAX_CANDIDATE_SPACES, MAX_CANDIDATE_SPACES),
    nowMs,
  });
  const historyAll = sections.flatMap((s) => s.history);
  const roster: Roster = buildRoster({
    participantIds: sections.flatMap((s) => s.facts?.participantIds ?? []),
    eventIds: [...events.map((e) => e.id), ...historyAll.map((h) => h.id)],
    actors: [...events.map((e) => e.actor ?? ""), ...historyAll.map((h) => h.actor ?? "")],
  });
  const episodes = sections.flatMap((s) => s.episodes);
  const packSpaceIds = [
    ...candidates.map((c) => c.id),
    ...episodes.map((e) => e.spaceId).filter((id): id is string => id !== null),
  ];
  const tasks = openTasks({ spaceIds: packSpaceIds, ownerRefs: ["self", ...roster.entries.map((r) => r.ref)] });
  const calendar = calendarItems(nowMs);
  const bridged = bridgedBlock(events.map((e) => e.id));
  const related = crossSourceEpisodes(order, events);

  // ---- Thin context.
  const bundleActors = new Set(events.map((e) => e.actor ?? "").filter((a) => a !== "" && a !== "self"));
  const thin = decideThin({
    noHistory: sections[0]!.history.length === 0,
    noCandidates: candidates.length === 0,
    noEpisodes: episodes.length === 0,
    unresolvedSenders: roster.unresolved.filter((a) => bundleActors.has(a)),
    smallBundle:
      events.length <= THIN_BUNDLE_EVENTS &&
      events.reduce((n, e) => n + (e.text ?? "").length, 0) < THIN_BUNDLE_CHARS,
  });
  let held = false;
  let instruct = false;
  const key = packBundleKey(bundle);
  if (thin.thin) {
    if (thinPolicy === "hold-once") {
      held = holdThinOnce(key, nowMs);
      instruct = !held;
    } else if (thinPolicy === "instruct") {
      instruct = true;
    }
  } else if (thinPolicy === "hold-once") {
    clearThinHold(key);
  }

  // ---- Blocks above the bundle (each bounded by construction).
  const blocks: Record<string, string> = {};
  const nowIso = new Date(nowMs).toISOString();
  blocks.now =
    `[NOW] ${nowIso} ${WEEKDAYS[new Date(nowMs).getUTCDay()]} · lane ${bundle.lane} · band ${bundle.ageBand} · mode propose-only` +
    (bundle.category ? ` · ${bundle.category}` : "") +
    (bundle.ageBand === "A" ? "" : `\n${bandPolicyLine(bundle.ageBand)}`) +
    (instruct ? `\n${THIN_CONTEXT_INSTRUCTION}` : "") +
    (thin.thin && !instruct ? `\n[THIN CONTEXT] flagged: ${thin.reasons.join("; ")}` : "");

  blocks.roster =
    roster.entries.length === 0 && roster.unresolved.length === 0
      ? "[ROSTER] (none resolved)"
      : `[ROSTER] ${roster.entries.length} resolved` +
        (roster.entries.length > 0 ? "\n" + roster.entries.map((r) => `  ${renderRosterEntry(r)}`).join("\n") : "") +
        (roster.unresolved.length > 0 ? `\n  unresolved: ${roster.unresolved.join(", ")}` : "");

  blocks.tasks =
    tasks.length === 0
      ? "[OPEN TASKS] (none in these spaces)"
      : `[OPEN TASKS] ${tasks.length}\n` + tasks.map((t) => `  ${renderOpenTask(t)}`).join("\n");

  blocks.calendar =
    calendar.length === 0
      ? "[CALENDAR] (nothing dated in the next 7 days)"
      : `[CALENDAR] next 7 days\n` + calendar.map((c) => `  ${renderCalendarItem(c)}`).join("\n");

  blocks.candidates =
    candidates.length === 0
      ? "[CANDIDATE SPACES] (none from retrieval)"
      : `[CANDIDATE SPACES] ${candidates.length} from retrieval (top ${MAX_CANDIDATE_SPACES}; the full list is never shown)\n` +
        candidates.map((c, i) => `  ${renderCandidate(i + 1, c)}`).join("\n");

  const relatedLines = related.map((e) => `- episode ${renderEpisode(e.streamKey ? `[${e.streamKey}]` : "[?]", e)}`);
  blocks.bridged =
    bridged === "" && relatedLines.length === 0
      ? "[BRIDGED] (none)"
      : [bridged === "" ? "[BRIDGED]" : neutralise(bridged), ...relatedLines].join("\n");

  const withHistory = sections.filter((_, i) => i < HISTORY_STREAMS);
  const renderThreads = (): string => withHistory.map((s) => renderThread(s, HISTORY_CHARS_PER_STREAM)).join("\n");
  blocks.threads = renderThreads();

  blocks.episodes =
    episodes.length === 0
      ? "[EPISODES] (none open or recent)"
      : "[EPISODES]\n" +
        sections
          .flatMap((s) => s.episodes.map((ep) => `  ${renderEpisode(s.tag, ep)}`))
          .join("\n");

  // ---- Give ground if the context alone leaves the bundle below its floor:
  // history run-ups go first, then the oldest non-quoted episode members.
  let trimmed = false;
  const contextChars = (): number =>
    [blocks.now, blocks.roster, blocks.tasks, blocks.calendar, blocks.candidates, UNTRUSTED_OPEN, blocks.bridged, blocks.threads, blocks.episodes]
      .reduce((n, b) => n + b.length + 1, 0);
  const bundleFloor = events.length * EVENT_TEXT_FLOOR + 64;
  if (contextChars() + bundleFloor > maxChars) {
    for (const s of withHistory) {
      if (contextChars() + bundleFloor <= maxChars) break;
      if (s.history.some((h) => !h.inEpisode && !h.quoted)) {
        s.history = s.history.filter((h) => h.inEpisode || h.quoted);
        trimmed = true;
        blocks.threads = renderThreads();
      }
    }
    let guard = 0;
    while (contextChars() + bundleFloor > maxChars && guard++ < 32) {
      const s = withHistory.reduce<Section | null>(
        (best, cur) => (cur.history.filter((h) => !h.quoted).length > (best?.history.filter((h) => !h.quoted).length ?? 8) ? cur : best),
        null,
      );
      if (!s) break;
      const rest = s.history.filter((h) => !h.quoted);
      const keep = new Set(rest.slice(Math.ceil(rest.length / 2)).map((h) => h.id));
      s.history = s.history.filter((h) => h.quoted || keep.has(h.id));
      trimmed = true;
      blocks.threads = renderThreads();
    }
  }

  // ---- The bundle: allowance from what is left.
  const bundleHeader =
    `[BUNDLE] ${events.length} events · ${sections.length} stream${sections.length === 1 ? "" : "s"}` +
    (bundle.partCount > 1 ? ` (part ${bundle.part}/${bundle.partCount})` : "") +
    (bundle.predecessorSummary ? `\n  predecessor: ${neutralise(clip(bundle.predecessorSummary, 300))}` : "");
  const remaining = maxChars - contextChars() - bundleHeader.length - UNTRUSTED_CLOSE.length - 2;
  const allowance = eventAllowance(remaining, events.length);

  const hashes = contentHashes(events.map((e) => e.id));
  const bundleLines: string[] = [];
  for (const s of sections) {
    if (s.events.length === 0) continue;
    bundleLines.push(`  ${sectionHead(s)}`);
    for (const run of collapseVisitRuns(s.events)) {
      if (isVisitRun(run)) {
        // V6 S1.4 (SRC-10): a run of visits to ONE url within 30 s is one line.
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const alias = run.length > 1 ? `${aliasOfId.get(first.id)}–${aliasOfId.get(last.id)}` : aliasOfId.get(first.id);
        const source = sourceOf(first, s.facts, s.streamId);
        bundleLines.push(
          `  ${alias} ${fmtTs(first.ts)} (${visitRunSpan(run)}) · ${source} · ${first.actor ?? "self"} [browser.visit] ${neutralise(visitRunHead(run))} ${neutralise(visitRunBody(run, allowance))}`,
        );
        continue;
      }
      const e = run[0]!;
      const source = sourceOf(e, s.facts, s.streamId);
      const env = toEnvelope(e, s.facts?.streamKey ?? bundle.streamKey, source, hashes.get(e.id));
      const digest = env.contentHash ? readCachedDigest(env.contentHash) : null;
      const body = serveContent(env, "L1", { counters, consumer: "packer.orient", digest });
      const identity = eventIdentityHead(env.payload);
      const replyRefs = [env.payload.quote_id, env.payload.quoted_id, env.payload.reply_to, env.payload.quoted_event_id]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .map((v) => aliasOfId.get(v) ?? v);
      const head =
        `  ${aliasOfId.get(e.id)} ${fmtTs(e.ts)} · ${source} · ${e.actor ?? "?"} [${e.kind ?? "?"}]` +
        (identity ? ` · ${neutralise(identity)}` : "") +
        (replyRefs.length > 0 ? ` ↩ ${replyRefs.join(",")}` : "");
      if (digest) {
        bundleLines.push(`${head} ${neutralise(renderDigestLine(digest))}\n    ${neutralise(clipBody(body, allowance)).replace(/\n/g, "\n    ")}`);
      } else {
        bundleLines.push(`${head}: ${neutralise(clipBody(body || (e.text ?? ""), allowance))}`);
      }
    }
  }
  blocks.bundle = `${bundleHeader}\n${bundleLines.join("\n")}`;

  const user = [
    blocks.now,
    blocks.roster,
    blocks.tasks,
    blocks.calendar,
    blocks.candidates,
    UNTRUSTED_OPEN,
    blocks.bridged,
    blocks.threads,
    blocks.episodes,
    blocks.bundle,
    UNTRUSTED_CLOSE,
  ].join("\n");

  return {
    user,
    eventAliases,
    streamAliases,
    candidateSpaceIds: candidates.map((c) => c.id),
    episodeIds: episodes.map((e) => e.id),
    serveCounters: counters,
    trimmed: trimmed || user.length > maxChars,
    thin: thin.thin,
    thinReasons: thin.reasons,
    held,
    stats: {
      chars: user.length,
      eventAllowance: allowance,
      historyStreams: withHistory.filter((s) => s.history.length > 0).length,
      historyEvents: withHistory.reduce((n, s) => n + s.history.length, 0),
      candidates: candidates.length,
      modelCalls: 0,
      tookMs: performance.now() - started,
      blocks: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.length])),
    },
  };
}
