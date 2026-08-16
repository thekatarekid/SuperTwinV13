// ===========================================================================
// [LLM-M] P-AG2 — arc adjudication — arch §12.6. Build item 2.5.
//
// Rung ④ of the binding ladder (§11.2), and the LAST rung before the user is
// asked. It is reached only when the three [CODE]/[ML] rungs above it could
// not settle the question: no bridge, entity overlap under 0.5, and a
// calibrated `arc_topic` score that nominated the candidate without proving
// it. One episode, one call, one line back:
//
//     V | <ep> | <jn|nw|un> | <n-alias> | <conf> | <reason>
//
// FOUR THINGS THIS FILE HOLDS
//
//   NOT ON THE FIRST-PAINT PATH.  §9.5.1 — an agent turn is never what the
//        user is waiting on. `onCriticalPath: false` is not decoration: the
//        ladder treats a MISSING adjudicator as "defer", parks the episode in
//        `provisional_arcs`, and first paint proceeds with zero model calls.
//        Adjudication happens at reconcile, off the paint path, or never.
//
//   ONE EPISODE PER CALL.  §12.6 settings: "1 episode · 400 max out". A call
//        that carried two episodes would let one episode's evidence colour the
//        other's verdict, and the arc verdict table has one row per episode.
//
//   THE CANDIDATE ROSTER IS THE WHOLE WORLD.  A `jn` naming an n-alias that
//        was not offered resolves to null and is reported, never guessed at
//        (§5.8.6). The ladder then treats it as `nw`, with the reason kept.
//
//   `un` IS AN ANSWER.  "Evidence genuinely underdetermines it → 'un'. Never
//        force." An unsure verdict becomes a question for the user, not a
//        silent new arc and not a retry.
//
// Nothing here writes a row and nothing here decides anything: this module
// builds the call and reads the answer. `arcs/ladder.ts` disposes.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import { neutraliseLabel } from "../wire/pack.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.6 "Settings", transcribed. */
export const P_AG2 = {
  id: "P-AG2",
  /** A valid `runs.role` (§4.4.4.4) — this call's spend is arc spend. */
  role: "arc",
  model: "sonnet-5",
  /** "1 turn". */
  turns: 1,
  /** "none" — this call reads what it is given and nothing else. */
  tools: "none",
  thinking: "off",
  /** "60 s". */
  timeoutSeconds: 60,
  /** "1 episode". */
  maxEpisodesPerCall: 1,
  /** "400 max out". */
  maxOutputTokens: 400,
  /** §9.5.1 — never what the user is waiting on. */
  onCriticalPath: false,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_AG2_TAGS = ["V.arc"] as const;

/**
 * §11.2 rule 3 for candidate sets — a roster the model can actually read. The
 * ladder nominates at most this many arcs; the rest are reported as trimmed.
 */
export const AG2_MAX_CANDIDATES = 8;

/** §12.6 SYSTEM, verbatim. */
export const P_AG2_SYSTEM = `You decide whether an episode belongs to an existing thread — a cross-source
strand of one person's life.

RULES
- Bridges (shared url, order id, file id, attendee set) are near-proof.
- Same people + the same concrete matter → same thread. Same people ALONE is
  not enough; friends discuss many things.
- Different concrete matters stay separate even with identical participants.
- Episodes may be processed newest-first, so a candidate thread can be newer
  than the episode. Judge by matter, not by order of arrival.
- Evidence genuinely underdetermines it → "un". Never force.

OUTPUT
  V | <ep> | <jn|nw|un> | <n-alias | -> | <conf> | <reason>`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function ag2Legend(): string {
  return legendFor({
    callType: P_AG2.id,
    tags: [...P_AG2_TAGS],
    aliases: ["episode", "arc", "entity"],
  });
}

/** legend + §12.6 SYSTEM. Byte-identical on every call, so it caches (§5.9.4). */
export function buildAg2System(): string {
  return [ag2Legend(), P_AG2_SYSTEM].join("\n\n");
}

// ---- the call --------------------------------------------------------------

/** The episode being placed. One per call (§12.6). */
export interface Ag2Episode {
  /** The real `episodes.id`. Never sent; the e-alias stands in for it. */
  id: string;
  label: string | null;
  /** Source ids this episode came from — `browser`, `wa`, `cal`. */
  sourceIds?: readonly string[];
  /** "11–12 Aug" — already rendered by the caller, in the user's tz. */
  span?: string | null;
  /** Anchor entity ids. They ride as a-aliases on the shared table. */
  anchorEntityIds?: readonly string[];
  /** "user compared 3 villas, opened Amara twice" — the indented gloss. */
  summary?: string | null;
}

/** One arc the ladder nominated. Everything the rungs measured travels with it. */
export interface Ag2Candidate {
  arcId: string;
  label: string | null;
  sourceIds?: readonly string[];
  anchorEntityIds?: readonly string[];
  /** "url booking.com/villa-amara (browser↔wa)", or null for no bridge. */
  bridge?: string | null;
  /** Rung ②'s weighted Jaccard. */
  overlap?: number | null;
  /** Rung ③'s CALIBRATED score. Never a raw cosine, never a guess. */
  similarity?: number | null;
}

export interface Ag2Input {
  episode: Ag2Episode;
  candidates: readonly Ag2Candidate[];
  /** Override the roster cap. Tests only. */
  maxCandidates?: number;
}

export interface Ag2Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** e-alias for the episode, `a`/`n` aliases for everything else. */
  episodeAlias: string;
  /** arc id → the n-alias it was minted as. The roster, and its whole extent. */
  aliases: Record<string, string>;
  /** Candidates beyond the cap. Reported so a trim is never silent. */
  trimmed: string[];
}

function scoreText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function sourceText(ids: readonly string[] | undefined): string {
  const list = (ids ?? []).map((s) => neutraliseLabel(String(s))).filter((s) => s !== "");
  return list.length === 0 ? "-" : list.join(",");
}

/**
 * The USER block, in §12.6's shape:
 *
 *     EP e1 <label> | <sources> | <span> | <anchors>
 *        <summary>
 *     n1 <label> | <sources> | anchors … | bridge … | overlap … | sim …
 *
 * Every score printed here was MEASURED by a rung above. A candidate whose
 * similarity was never computed prints `-`, never a number: an invented score
 * is exactly the evidence this prompt must not have (§12.2's rule, same logic).
 */
export function buildAg2User(input: Ag2Input, table: AliasTable): { user: string; trimmed: string[] } {
  const ep = input.episode;
  const epAlias = table.mint("episode", ep.id, ep.label ?? undefined);
  const anchors = (ep.anchorEntityIds ?? []).map((id) => table.mint("entity", id));

  const head = [
    `EP ${epAlias} ${neutraliseLabel(ep.label ?? "-")}`,
    sourceText(ep.sourceIds),
    neutraliseLabel(ep.span ?? "-"),
    anchors.length === 0 ? "-" : anchors.join(","),
  ].join(" | ");

  const lines = [head];
  const summary = typeof ep.summary === "string" ? neutraliseLabel(ep.summary) : "";
  if (summary !== "") lines.push(`   ${summary}`);

  const cap = Math.max(1, Math.floor(input.maxCandidates ?? AG2_MAX_CANDIDATES));
  const offered = input.candidates.slice(0, cap);
  const trimmed = input.candidates.slice(cap).map((c) => c.arcId);

  for (const candidate of offered) {
    const alias = table.mint("arc", candidate.arcId, candidate.label ?? undefined);
    const candidateAnchors = (candidate.anchorEntityIds ?? []).map((id) => table.mint("entity", id));
    lines.push(
      [
        `${alias} ${neutraliseLabel(candidate.label ?? "-")}`,
        sourceText(candidate.sourceIds),
        `anchors ${candidateAnchors.length === 0 ? "-" : candidateAnchors.join(",")}`,
        `bridge ${candidate.bridge ? neutraliseLabel(candidate.bridge) : "-"}`,
        `overlap ${scoreText(candidate.overlap)}`,
        `sim ${scoreText(candidate.similarity)}`,
      ].join(" | "),
    );
  }

  return { user: lines.join("\n"), trimmed };
}

/** Build the call. One episode in, one alias table out, nothing persisted. */
export function buildAg2Prompt(input: Ag2Input, table?: AliasTable): Ag2Prompt {
  const aliasTable = table ?? createAliasTable();
  const { user, trimmed } = buildAg2User(input, aliasTable);
  const aliases: Record<string, string> = {};
  for (const candidate of input.candidates) {
    const token = aliasTable.tokenFor("arc", candidate.arcId);
    if (token) aliases[candidate.arcId] = token;
  }
  return {
    system: buildAg2System(),
    user,
    table: aliasTable,
    episodeAlias: aliasTable.tokenFor("episode", input.episode.id) ?? "-",
    aliases,
    trimmed,
  };
}

/** The provider knobs §12.6 fixes. Built here so no call site can raise them. */
export interface Ag2SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  /** No tools: a plain completion, not an agent turn. */
  plainCompletion: true;
}

export function ag2SendOptions(): Ag2SendShape {
  return {
    model: P_AG2.model,
    maxTurns: P_AG2.turns,
    timeoutMs: P_AG2.timeoutSeconds * 1_000,
    maxOutputTokens: P_AG2.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

// ---- the answer ------------------------------------------------------------

export type Ag2VerdictKind = "join" | "new" | "unsure";

export interface Ag2Verdict {
  /** The aliases, verbatim — what the model actually wrote. */
  episodeAlias: string;
  arcAlias: string | null;
  /** Resolved ids, or null when an alias was outside the roster. */
  episodeId: string | null;
  arcId: string | null;
  verdict: Ag2VerdictKind;
  confidence: number | null;
  reason: string;
  /** The model's own line, byte-for-byte (build rule 9). */
  raw: string;
}

export interface Ag2Answer {
  /** §12.6: ONE line. The first well-formed verdict is the answer. */
  verdict: Ag2Verdict | null;
  /** Extra verdicts, kept rather than deleted — code orders, never censors. */
  extra: Ag2Verdict[];
  /** Verdicts naming an episode this call was not about. Never reassigned. */
  orphans: Ag2Verdict[];
  /** Lines the parser judged but this call may not emit — counted, not dropped. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  parse: WireParseResult;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a P-AG2 answer. Never throws.
 *
 * `episodeId` is what separates an answer from an orphan: a verdict whose
 * e-alias is not this call's episode is reported, never applied to the episode
 * that WAS asked about. A `jn` whose n-alias is off-roster keeps `arcId: null`,
 * and the ladder demotes it to `new` with the model's own words attached.
 */
export function parseAg2Response(response: unknown, table: AliasTable, episodeId?: string): Ag2Answer {
  const parse = parseWire(response);
  const good: Ag2Verdict[] = [];
  const orphans: Ag2Verdict[] = [];
  const otherRecords: WireRecord[] = [];

  for (const record of parse.records) {
    if (record.variant !== "V.arc") {
      otherRecords.push(record);
      continue;
    }
    const values = record.values;
    const stored = str(values.verdict);
    if (stored !== "join" && stored !== "new" && stored !== "unsure") {
      otherRecords.push(record);
      continue;
    }

    const episodeAlias = str(values.episode);
    const arcToken = str(values.arc);
    const episodeRef = table.resolve(episodeAlias).resolved;
    const arcRef = arcToken === "" ? null : table.resolve(arcToken).resolved;

    const verdict: Ag2Verdict = {
      episodeAlias,
      arcAlias: arcToken === "" ? null : arcToken,
      episodeId: episodeRef && episodeRef.kind === "episode" ? episodeRef.id : null,
      arcId: arcRef && arcRef.kind === "arc" ? arcRef.id : null,
      verdict: stored,
      confidence: typeof values.confidence === "number" ? values.confidence : null,
      reason: str(values.reason),
      raw: record.raw,
    };

    const mine = episodeId === undefined || verdict.episodeId === episodeId;
    if (mine) good.push(verdict);
    else orphans.push(verdict);
  }

  return {
    verdict: good[0] ?? null,
    extra: good.slice(1),
    orphans,
    otherRecords,
    violations: parse.violations,
    parse,
  };
}
