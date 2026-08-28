// ===========================================================================
// The anti-starvation packer (build P1.2, spec §6.4).
//
// Every Orient call gets, in this order:
//   1. band + mode policy          (hard constraints)
//   2. roster + stream facts       (identities, circles, engagement, tier)
//   3. thread history              (elastic 20–40, reply-quotes always)
//   4. episodes here               (open + recently-dormant, space links)
//   5. candidate spaces            (four retrieval lanes + recency, top 3–5,
//                                   with exemplars)
//   6. recent-context spaces       (weak hints, never a join rule)
//   7. cross-source episodes       (via bridges/entities)
//   8. the new delta bundle        (aliased e1..eN; content-heavy events are
//                                   served at L1, everything contextual at L0
//                                   — spec §4.5.2)
//
// The pack is deterministic for a given world state, and capped: when the
// assembled block exceeds `maxChars`, the blocks furthest from the decision
// (history first, then cross-source, then candidates' exemplars) give ground.
// The NEW BUNDLE is never trimmed — starving the decision of its own delta is
// the one failure this module exists to prevent.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { DeltaBundle, BundleEvent } from "../scheduler/dispatch.js";
import type { EventEnvelope } from "../db/eventlog.js";
import {
  newServeCounters,
  readCachedDigest,
  renderDigestLine,
  serveContent,
  type ServeCounters,
} from "./digest.js";
import {
  crossSourceEpisodes,
  streamContext,
  streamEpisodes,
  threadHistory,
  type EpisodeSummary,
  type HistoryEvent,
} from "./history.js";
import {
  candidateSpaces,
  recentContextSpaces,
  type CandidateSpace,
} from "./spaces.js";

export interface PackOptions {
  /** Hard cap on the packed user block, chars. */
  maxChars?: number;
  nowMs?: number;
  /** Candidate spaces returned (spec: 3–5). */
  candidateLimit?: number;
}

export const DEFAULT_PACK_MAX_CHARS = 28_000;

export interface PackedContext {
  /** The packed user half of the Orient call. */
  user: string;
  /** Alias -> event id for the bundle (e1..eN, bundle order). */
  eventAliases: Map<string, string>;
  /** Candidate space ids offered, in rank order. */
  candidateSpaceIds: string[];
  /** Episode ids offered (this stream). */
  episodeIds: string[];
  /** Fidelity-level serve counts for the run ledger (spec §4.5.4). */
  serveCounters: ServeCounters;
  /** True when the cap forced trimming. */
  trimmed: boolean;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function short(ts: string | null): string {
  if (!ts) return "?";
  // "2026-08-28T19:42:00.000Z" -> "08-28 19:42"
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

function toEnvelope(e: BundleEvent, streamKey: string, contentHash?: string): EventEnvelope {
  let payload: Record<string, unknown> = {};
  let roles = { sender: e.actor ?? "?", audience: [], receiver: [], mentions: [] };
  try {
    payload = JSON.parse(e.payloadJson ?? "{}") as Record<string, unknown>;
  } catch {
    /* empty */
  }
  try {
    const r = JSON.parse(e.rolesJson ?? "null");
    if (r && typeof r === "object") roles = { ...roles, ...r };
  } catch {
    /* structural default */
  }
  return {
    id: e.id,
    ts: e.ts ?? "",
    source: "",
    kind: e.kind ?? "",
    origin: e.origin,
    ageBand: e.ageBand,
    streamKey,
    actor: e.actor ?? "?",
    roles,
    payload,
    contentHash:
      contentHash ??
      (typeof payload.content_hash === "string" ? payload.content_hash : undefined),
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

function renderEpisode(ep: EpisodeSummary): string {
  const space = ep.spaceId ? ` → ${ep.spaceId}${ep.spaceLabel ? ` "${ep.spaceLabel}"` : ""}` : "";
  const from = ep.streamKey ? ` [${ep.streamKey}]` : "";
  return `${ep.id} "${ep.summary ?? "(no summary)"}" ${ep.state} ${short(ep.lastTs)}${space}${from}`;
}

function renderCandidate(idx: number, c: CandidateSpace): string {
  const ex = c.exemplars.length > 0 ? ` · exemplars: ${c.exemplars.map((e) => `"${e}"`).join(", ")}` : "";
  const goal = c.goal ? ` · goal: ${c.goal}` : "";
  const area = c.lifeArea ? ` · ${c.lifeArea}` : "";
  return `${idx}. ${c.id} "${c.label}"${area}${goal} · via ${c.lanes.join("+")}${ex}`;
}

// ---------------------------------------------------------------------------
// The packer
// ---------------------------------------------------------------------------

/**
 * Spec §5.3 rendered into the pack (§6.4 item 8): the age-band policy the
 * prompts call a "hard constraint" travels WITH the band letter, so the model
 * never has to remember the table. Band A adds nothing (everything allowed).
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

/** Assemble the Orient user block for one delta bundle (spec §6.4). */
export async function packOrientContext(
  bundle: DeltaBundle,
  opts: PackOptions = {},
): Promise<PackedContext> {
  const maxChars = opts.maxChars ?? DEFAULT_PACK_MAX_CHARS;
  const nowMs = opts.nowMs ?? Date.now();
  const counters = newServeCounters();

  const stream = streamContext(bundle.streamId);
  const history = threadHistory(bundle.streamId, bundle.events);
  const episodes = streamEpisodes(bundle.streamId, { nowMs });
  const candidates = await candidateSpaces(bundle.events, {
    limit: opts.candidateLimit ?? 5,
    nowMs,
  });
  const recents = recentContextSpaces({
    nowMs,
    excludeIds: candidates.map((c) => c.id),
  });
  const related = crossSourceEpisodes(bundle.streamId, bundle.events);

  // ---- Aliases: e1..eN in bundle order.
  const eventAliases = new Map<string, string>();
  bundle.events.forEach((e, i) => eventAliases.set(`e${i + 1}`, e.id));

  // ---- Blocks (assembled independently so the cap can trim by priority).
  const bandLine =
    `[BAND] ${bundle.ageBand} ${bundle.lane}   [MODE] propose-only` +
    (bundle.ageBand === "A" ? "" : `\n${bandPolicyLine(bundle.ageBand)}`);

  const rosterLine = stream
    ? `[ROSTER] ${
        stream.roster.length > 0
          ? stream.roster
              .map(
                (r) =>
                  `${r.ref}=${r.name}${r.circle ? ` (${r.circle})` : ""}${r.provisional ? " ?" : ""}`,
              )
              .join(" · ")
          : "(none resolved)"
      }`
    : "[ROSTER] (unknown stream)";

  const streamLine = stream
    ? `[STREAM] ${stream.kind ?? "stream"} "${stream.label ?? stream.streamKey}" · ` +
      `tier ${stream.tier ?? "?"} · category ${stream.category ?? "?"} · ` +
      `engagement ${stream.engagementScore.toFixed(2)} (${stream.replyCount} replies)`
    : `[STREAM] ${bundle.streamKey}`;

  const renderHistory = (rows: HistoryEvent[]): string =>
    rows.length === 0
      ? "[THREAD HISTORY] (none)"
      : `[THREAD HISTORY] ${rows.length} msgs\n` +
        rows
          .map(
            (h) =>
              `  ${short(h.ts)} ${h.actor ?? "?"}${h.quoted ? " (quoted)" : ""}: ${(h.text ?? "").slice(0, 300)}`,
          )
          .join("\n");

  const episodesBlock =
    episodes.length === 0
      ? "[EPISODES here] (none)"
      : "[EPISODES here]\n" + episodes.map((e) => `  ${renderEpisode(e)}`).join("\n");

  const candidatesBlock =
    candidates.length === 0
      ? "[CANDIDATE SPACES] (none)"
      : "[CANDIDATE SPACES]\n" +
        candidates.map((c, i) => `  ${renderCandidate(i + 1, c)}`).join("\n");

  const recentBlock =
    recents.length === 0
      ? ""
      : "[RECENT CONTEXT] " +
        recents.map((r) => `${r.id} "${r.label}" (active ${short(r.lastActive)})`).join(" · ");

  const relatedBlock =
    related.length === 0
      ? ""
      : "[CROSS-SOURCE]\n" + related.map((e) => `  ${renderEpisode(e)}`).join("\n");

  const predecessorBlock = bundle.predecessorSummary
    ? `[PREDECESSOR] ${bundle.predecessorSummary}`
    : "";

  // The bundle itself: directly-processed events serve at L1; the digest line
  // (L0) rides along for content-heavy events so the model sees the shape.
  const hashes = contentHashes(bundle.events.map((e) => e.id));
  const bundleLines = bundle.events.map((e, i) => {
    const env = toEnvelope(e, bundle.streamKey, hashes.get(e.id));
    const digest = env.contentHash ? readCachedDigest(env.contentHash) : null;
    const body = serveContent(env, "L1", { counters, consumer: "packer.orient", digest });
    const head = `e${i + 1} ${short(e.ts)} ${e.actor ?? "?"}`;
    if (digest) {
      // Heavy event: L0 digest line up top, L1 distillation beneath.
      return `${head} [${e.kind}] ${renderDigestLine(digest)}\n    ${body.replace(/\n/g, "\n    ")}`;
    }
    return `${head}: ${(body || (e.text ?? "")).slice(0, 1200)}`;
  });
  const bundleBlock =
    `[NEW BUNDLE] ${bundle.events.length} events` +
    (bundle.partCount > 1 ? ` (part ${bundle.part}/${bundle.partCount})` : "") +
    "\n" +
    bundleLines.map((l) => `  ${l}`).join("\n");

  // ---- Assemble under the cap: history gives ground first, then cross-source,
  // then exemplars (candidates shrink to bare labels). The bundle never trims.
  const assemble = (histRows: HistoryEvent[], withRelated: boolean, bareCandidates: boolean): string => {
    const cands = bareCandidates
      ? candidates.length === 0
        ? "[CANDIDATE SPACES] (none)"
        : "[CANDIDATE SPACES]\n" +
          candidates.map((c, i) => `  ${i + 1}. ${c.id} "${c.label}"`).join("\n")
      : candidatesBlock;
    return [
      bandLine,
      rosterLine,
      streamLine,
      renderHistory(histRows),
      episodesBlock,
      cands,
      recentBlock,
      withRelated ? relatedBlock : "",
      predecessorBlock,
      bundleBlock,
    ]
      .filter((b) => b !== "")
      .join("\n");
  };

  let trimmed = false;
  let user = assemble(history, true, false);
  if (user.length > maxChars) {
    trimmed = true;
    // Step 1: halve history down to the minimum, keeping quoted rows.
    let rows = history;
    while (user.length > maxChars && rows.length > 8) {
      const keepQuoted = rows.filter((r) => r.quoted);
      const rest = rows.filter((r) => !r.quoted);
      rows = [...rest.slice(Math.ceil(rest.length / 2)), ...keepQuoted].sort(
        (a, b) => a.rowid - b.rowid,
      );
      user = assemble(rows, true, false);
    }
    // Step 2: drop cross-source; step 3: bare candidates.
    if (user.length > maxChars) user = assemble(rows, false, false);
    if (user.length > maxChars) user = assemble(rows, false, true);
    // Step 4: hard truncate everything above the bundle (last resort — the
    // bundle itself is sacred).
    if (user.length > maxChars) {
      const idx = user.indexOf("[NEW BUNDLE]");
      const head = user.slice(0, Math.max(0, maxChars - (user.length - idx)));
      user = head + user.slice(idx);
    }
  }

  return {
    user,
    eventAliases,
    candidateSpaceIds: candidates.map((c) => c.id),
    episodeIds: episodes.map((e) => e.id),
    serveCounters: counters,
    trimmed,
  };
}
