// ===========================================================================
// [CODE] Episode topic TEXT — what an episode is compared BY. Arch §11.1,
// §10.3 ¶4 ("never compare bare short strings"), build item 2.3.
//
// Split out of `./embed.ts` so the vector half — storage, the embed call, the
// calibrated attach gate — stays readable without SQL and string budgets in
// the middle of it, and so the composition rules can be tested on plain values
// with no embedder anywhere. `./embed.ts` re-exports everything here, so a
// caller still has ONE import site.
//
// The composition is item 2.3's, literally: `topic_label` + the last 2 session
// summaries + the top entity names. Every part matters. A topic label alone is
// three tokens of nothing in a 384-dimensional space and scores high against
// every other label, which is how two unrelated afternoons become one episode.
//
// Nothing here embeds and nothing here scores. Text in, text out.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { buildRichText, isRichText } from "../retrieval/calibration.js";
import { readEpisode } from "./store.js";

/** Item 2.3: the last TWO session summaries, newest first. */
export const EPISODE_SUMMARY_COUNT = 2;

/** "Top entity names" — enough context to separate topics, not a roster dump. */
export const MAX_TOPIC_ENTITIES = 8;

/** One summary's budget. A whole session in a vector is a blurred vector. */
export const MAX_SUMMARY_CHARS = 320;

/** The composed text's budget, applied last so no single part can crowd out the rest. */
export const MAX_TOPIC_TEXT_CHARS = 1200;

/** How many of an episode's events a mention scan will look at. */
export const MAX_MENTION_SCAN_EVENTS = 400;

/**
 * Enrichment placeholders ("[image, description pending]") carry no topic
 * signal (§12.3) and are dropped before composing, exactly as the drift
 * pre-flag drops placeholder events.
 */
const PLACEHOLDER_RE = /^\[[^\]]*\b(pending|failed|unavailable)\]$/i;

// ---- Composition -----------------------------------------------------------

export interface EpisodeTopicParts {
  topicLabel: string | null;
  /** Newest first, already trimmed to `EPISODE_SUMMARY_COUNT`. */
  summaries: string[];
  /** Canonical names of the episode's most-mentioned entities. */
  entityNames: string[];
}

function tidy(text: string | null | undefined, cap: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "" || PLACEHOLDER_RE.test(flat)) return "";
  return flat.length > cap ? flat.slice(0, cap).trimEnd() : flat;
}

/**
 * The text an episode is compared BY. Field order is stable so the same episode
 * composes byte-identically on a replay — a vector that moves between runs
 * makes every downstream verdict irreproducible.
 */
export function buildEpisodeTopicText(parts: EpisodeTopicParts): string {
  const summaries = parts.summaries
    .map((s) => tidy(s, MAX_SUMMARY_CHARS))
    .filter((s) => s.length > 0)
    .slice(0, EPISODE_SUMMARY_COUNT);
  const names = parts.entityNames
    .map((n) => tidy(n, 80))
    .filter((n) => n.length > 0)
    .slice(0, MAX_TOPIC_ENTITIES);
  const text = buildRichText({
    name: tidy(parts.topicLabel, 160),
    cooccurring: names,
    context: summaries.join(" ⁘ "),
  });
  return text.length > MAX_TOPIC_TEXT_CHARS ? text.slice(0, MAX_TOPIC_TEXT_CHARS).trimEnd() : text;
}

/**
 * Whether a composition is worth embedding at all. `isRichText`, not a throw:
 * a brand-new episode of two "ok"s is a real state of the world, and the right
 * answer is to store no vector for it, not to crash the pass. The THROW lives
 * on the comparison path, where a bare string would actually corrupt a verdict.
 */
export function episodeTopicTextIsUsable(text: string): boolean {
  return isRichText(text);
}

// ---- Gathering the parts from the database ---------------------------------

interface SessionRow {
  id: string;
  started_at: string | null;
  event_ids: string | null;
}

function parseIdArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A session's summary, derived from what its events actually say. There is no
 * stored `sessions.summary` column in §6 — so rather than invent one, this
 * composes the session's own text and lets a caller override with something
 * better via `EpisodeTopicOptions.summarize`.
 */
export function summariseSession(sessionId: string, cap = MAX_SUMMARY_CHARS): string | null {
  const row = getDb()
    .prepare(`SELECT event_ids FROM sessions WHERE id = ?`)
    .get(sessionId) as { event_ids: string | null } | undefined;
  const eventIds = parseIdArray(row?.event_ids).slice(0, MAX_MENTION_SCAN_EVENTS);
  if (eventIds.length === 0) return null;

  const rows = getDb()
    .prepare(
      `SELECT id, text, transcript, media_description, link_title
         FROM events
        WHERE id IN (${eventIds.map(() => "?").join(", ")})`,
    )
    .all(...eventIds) as {
    id: string;
    text: string | null;
    transcript: string | null;
    media_description: string | null;
    link_title: string | null;
  }[];

  // Session order, not row order: a summary is a conversation, not a set.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts: string[] = [];
  let used = 0;
  for (const id of eventIds) {
    const r = byId.get(id);
    if (!r) continue;
    for (const field of [r.text, r.transcript, r.media_description, r.link_title]) {
      const piece = tidy(field, cap);
      if (piece === "") continue;
      parts.push(piece);
      used += piece.length + 3;
      break;
    }
    if (used >= cap) break;
  }
  const joined = parts.join(" · ");
  if (joined === "") return null;
  return joined.length > cap ? joined.slice(0, cap).trimEnd() : joined;
}

/** The episode's entities, most-mentioned first, resolved to canonical names. */
export function topEntityNames(
  entityIds: readonly string[],
  eventIds: readonly string[],
  limit = MAX_TOPIC_ENTITIES,
): string[] {
  if (entityIds.length === 0) return [];
  const db = getDb();
  const scan = eventIds.slice(0, MAX_MENTION_SCAN_EVENTS);
  const counts = new Map<string, number>();
  if (scan.length > 0) {
    const rows = db
      .prepare(
        `SELECT entity_id AS id, COUNT(*) AS n FROM mentions
          WHERE entity_id IS NOT NULL AND event_id IN (${scan.map(() => "?").join(", ")})
          GROUP BY entity_id`,
      )
      .all(...scan) as { id: string; n: number }[];
    for (const row of rows) counts.set(row.id, row.n);
  }

  // Ties keep the episode's own order — deterministic, and that order is
  // roughly first-seen, which is the next best proxy for prominence.
  const ordered = entityIds
    .map((id, index) => ({ id, index, n: counts.get(id) ?? 0 }))
    .sort((a, b) => (b.n - a.n) || (a.index - b.index));

  const names: string[] = [];
  for (const item of ordered) {
    if (names.length >= limit) break;
    const name = canonicalName(item.id);
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

function canonicalName(entityId: string): string | null {
  const row = getDb()
    .prepare(`SELECT canonical, merged_into FROM entities WHERE id = ?`)
    .get(entityId) as { canonical: string | null; merged_into: string | null } | undefined;
  if (!row) return null;
  if (row.merged_into) {
    // One hop only: a merged entity's name is the survivor's name, and a
    // redirect chain deep enough to matter is a bug for reconcile, not here.
    const target = getDb()
      .prepare(`SELECT canonical FROM entities WHERE id = ?`)
      .get(row.merged_into) as { canonical: string | null } | undefined;
    const merged = tidy(target?.canonical, 80);
    if (merged !== "") return merged;
  }
  const name = tidy(row.canonical, 80);
  return name === "" ? null : name;
}

export interface EpisodeTopicOptions {
  /** Override the derived summary — a real summariser, when one exists. */
  summarize?: (sessionId: string) => string | null;
}

/** Read one episode's topic parts: label, last two summaries, top entities. */
export function collectEpisodeTopicParts(
  episodeId: string,
  opts: EpisodeTopicOptions = {},
): EpisodeTopicParts | null {
  const episode = readEpisode(episodeId);
  if (episode === null) return null;

  const rows =
    episode.sessionIds.length === 0
      ? []
      : (getDb()
          .prepare(
            `SELECT id, started_at, event_ids FROM sessions
              WHERE id IN (${episode.sessionIds.map(() => "?").join(", ")})`,
          )
          .all(...episode.sessionIds) as SessionRow[]);

  // Newest first. Sessions with no `started_at` sort last rather than winning
  // the slot by accident of NULL comparison.
  const order = new Map(episode.sessionIds.map((id, i) => [id, i]));
  const newest = rows
    .slice()
    .sort((a, b) => {
      const ta = a.started_at ? Date.parse(a.started_at) : Number.NEGATIVE_INFINITY;
      const tb = b.started_at ? Date.parse(b.started_at) : Number.NEGATIVE_INFINITY;
      if (tb !== ta) return tb - ta;
      return (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
    })
    .slice(0, EPISODE_SUMMARY_COUNT);

  const summarize = opts.summarize ?? ((id: string) => summariseSession(id));
  const summaries: string[] = [];
  for (const row of newest) {
    const summary = tidy(summarize(row.id), MAX_SUMMARY_CHARS);
    if (summary !== "") summaries.push(summary);
  }

  return {
    topicLabel: episode.topicLabel,
    summaries,
    entityNames: topEntityNames(episode.entityIds, episode.eventIds),
  };
}
