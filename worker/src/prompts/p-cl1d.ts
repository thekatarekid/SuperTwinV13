// ===========================================================================
// [LLM-M] P-CL1Δ — claims + loops, delta — arch §12.5. Build item 3.1.
//
// Used by the live trigger (every ~30 s on an open session, item 3.4) and by
// the enrichment completion pass. Same rules and tags as P-CL1, plus `Z`.
//
// WHY THIS CALL EXISTS AT ALL
//
//   Re-running P-CL1 over a growing session is O(n²): event 40 gets read forty
//   times. The delta call is O(n) — it reads the ► events and nothing else —
//   which is why §3.4 makes delta extraction mandatory rather than an option.
//
// CONTEXT MODE (§12.5, `enrichment.delta_context_mode`)
//
//   summary     (default)  the Y summary + the extracted ids + only the ►
//                          events. ~20 % of a full call. The summary is FREE:
//                          P-CL1 already emitted it as a Y line in pass 1.
//   raw_events             the full original event list + the ► events. ~100 %.
//                          Faithful — a media caption is read against the
//                          exact surrounding text it landed in.
//
// TWO THINGS THE BUILDER GUARANTEES
//
//   ► NUMBERING CONTINUES.  Event aliases for the prior events are minted in
//        BOTH modes and printed in only one. In `summary` mode the prior
//        events are absent from the prompt but their numbers are still spent,
//        so a newly-readable attachment keeps the number it will keep forever
//        and lands "as if it had always been there, in its true position".
//
//   THE ► MARK IS THE ONLY EDIT.  Marking is a prefix on the packer's own
//        line. Nothing is reordered, retimed or rewritten: the events are the
//        packer's, byte-for-byte, with two characters in front.
//
// Nothing here writes a row. `claims/extract.ts` reads the answer.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { neutraliseLabel, packPrompt, type PackEntity, type PackEvent, type PackLoop, type PackResult, type PackStream } from "../wire/pack.js";
import { legendFor } from "./legend.js";
import { P_CL1, P_CL1_SYSTEM, P_CL1_TAGS } from "./p-cl1.js";

/** §12.5 "Settings", transcribed. */
export const P_CL1D = {
  id: "P-CL1D",
  role: "extract",
  model: "sonnet-5",
  turns: 1,
  tools: "none",
  thinking: "off",
  /** "90 s". */
  timeoutSeconds: 90,
  /** "1 episode". */
  maxEpisodesPerCall: 1,
  /** "2,500 max out". */
  maxOutputTokens: 2_500,
} as const;

/** P-CL1's tags plus `Z`, the update line. */
export const P_CL1D_TAGS = [...P_CL1_TAGS, "Z"] as const;

// ---- context mode ----------------------------------------------------------

export const DELTA_CONTEXT_MODES = ["summary", "raw_events"] as const;
export type DeltaContextMode = (typeof DELTA_CONTEXT_MODES)[number];

/** §12.5 — the setting that controls what the delta call is allowed to see. */
export const DELTA_CONTEXT_MODE_KEY = "enrichment.delta_context_mode";
/** Default `summary`: ~20 % of a full call, and pass 1 already paid for it. */
export const DEFAULT_DELTA_CONTEXT_MODE: DeltaContextMode = "summary";

export function isDeltaContextMode(v: unknown): v is DeltaContextMode {
  return typeof v === "string" && (DELTA_CONTEXT_MODES as readonly string[]).includes(v);
}

/**
 * Read the mode. An unset row and an unrecognised value both read as the
 * default — this is a cost/fidelity dial, and a typo in `app_state` must not
 * be able to stop enrichment.
 */
export function getDeltaContextMode(read: (key: string) => string | null = appStateGet): DeltaContextMode {
  const raw = read(DELTA_CONTEXT_MODE_KEY);
  return isDeltaContextMode(raw) ? raw : DEFAULT_DELTA_CONTEXT_MODE;
}

export function setDeltaContextMode(
  mode: DeltaContextMode,
  write: (key: string, value: string) => void = appStateSet,
): void {
  if (!isDeltaContextMode(mode)) throw new Error(`unknown delta context mode: ${String(mode)}`);
  write(DELTA_CONTEXT_MODE_KEY, mode);
}

// ---- the SYSTEM half -------------------------------------------------------

/** §12.5's DELTA MODE block, verbatim. Appended to the P-CL1 prompt. */
export const P_CL1D_DELTA_BLOCK = `DELTA MODE
You are re-reading an episode you have already partly processed. You receive
either a summary or the full prior events, the already-extracted items, and
the NEW or NEWLY-READABLE events marked ►.

- Extract ONLY from ► events. Never re-emit an item already listed.
- Prior context is for resolving references ("she", "that place") only.
- If a ► event CHANGES an existing item — contradicts it, dates it, completes
  it, cancels it, refines it — emit a Z line instead of a corrected copy.
- A newly-readable attachment is a ► event. Read it as if it had always been
  there, in its true position.
- The conversation may still be in progress. Extract what was said; do not
  anticipate where it is going.

  Z | <claim|loop alias> | <ctr|dat|cmp|cnl|rfn> | <events> | <note>`;

/** "the P-CL1 prompt plus the Z update line" — §12.5, in that order. */
export const P_CL1D_SYSTEM = `${P_CL1_SYSTEM}\n\n${P_CL1D_DELTA_BLOCK}`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function cl1dLegend(): string {
  return legendFor({
    callType: P_CL1D.id,
    tags: [...P_CL1D_TAGS],
    aliases: ["entity", "stream", "episode", "loop"],
  });
}

export function buildCl1dSystem(): string {
  return [cl1dLegend(), P_CL1D_SYSTEM].join("\n\n");
}

// ---- the call --------------------------------------------------------------

/** One item pass 1 already extracted, as the model will see it named. */
export interface Cl1dExtractedItem {
  /** The alias the model cites on a Z line — `H1`, `P1`, `T1`. */
  alias: string;
  /** The real `claim_versions.id` / `loops.id`. Never sent; used to resolve Z. */
  id?: string;
  /** The item's own words, verbatim as pass 1 wrote them. */
  text: string;
  /** A short parenthetical — a loop's state, say. Printed as `(op)`. */
  note?: string;
}

export interface Cl1dInput {
  /** Omit to read `enrichment.delta_context_mode`. */
  mode?: DeltaContextMode;
  tz?: string;
  entities?: readonly PackEntity[];
  /** In practice one — the stream the open session belongs to. */
  streams: readonly PackStream[];
  loops?: readonly PackLoop[];
  /** The episode being re-read, and the Y line pass 1 emitted for it. */
  episode: { id: string; summary?: string | null; label?: string | null };
  /** What pass 1 already extracted. "Never re-emit an item already listed." */
  extracted?: readonly Cl1dExtractedItem[];
  /**
   * Events pass 1 already read. Their aliases are minted in both modes; they
   * are PRINTED only in `raw_events`.
   */
  priorEvents?: readonly PackEvent[];
  /** The NEW or NEWLY-READABLE events. These are the ► lines. */
  newEvents: readonly PackEvent[];
  maxRoster?: number;
}

export interface Cl1dPrompt {
  system: string;
  user: string;
  table: AliasTable;
  mode: DeltaContextMode;
  /** The e-alias the Y line and any episode reference use. */
  episodeAlias: string;
  /** `H1` → the real id it stands for, for resolving Z lines. */
  itemIds: Record<string, string>;
  /** Event alias → id, for the ► events only. */
  newEventTokens: string[];
  stats: Extract<PackResult, { ok: true }>["stats"];
}

/** `EXTRACTED  H1 Attends bhangra … | T1 Send the villa link (op)` — §12.5. */
export function renderExtracted(items: readonly Cl1dExtractedItem[]): string[] {
  const rendered = items
    .map((item) => {
      const alias = neutraliseLabel(item.alias);
      const text = neutraliseLabel(item.text);
      if (alias === "" && text === "") return "";
      const note = item.note ? ` (${neutraliseLabel(item.note)})` : "";
      return `${alias} ${text}${note}`.trim();
    })
    .filter((s) => s !== "");
  if (rendered.length === 0) return [];
  const lines: string[] = [];
  // Two per line, as §12.5 prints it — long enough to be compact, short enough
  // that a re-read does not have to scan a wall.
  for (let i = 0; i < rendered.length; i += 2) {
    const chunk = rendered.slice(i, i + 2).join(" | ");
    lines.push(i === 0 ? `EXTRACTED  ${chunk}` : `           ${chunk}`);
  }
  return lines;
}

/** The `►` prefix goes on the packer's own line and changes nothing else. */
function markNewEvents(lines: readonly string[], tokens: ReadonlySet<string>): string[] {
  return lines.map((line) => {
    if (line.startsWith("#")) return line;
    const token = line.slice(0, line.indexOf(" ") === -1 ? line.length : line.indexOf(" "));
    return tokens.has(token) ? `► ${line}` : line;
  });
}

/**
 * Build the delta call.
 *
 * Both modes share one table and one packer pass. The difference is exactly
 * which events reach the packer: `raw_events` sends prior + ►, `summary` mints
 * the prior aliases and sends only ►, with the `Y` line standing in for the
 * text that was left out.
 *
 * Returns `null` when the packer refuses (roster over cap) — a truncated
 * roster is never sent (§5.9.3).
 */
export function buildCl1dPrompt(input: Cl1dInput): Cl1dPrompt | null {
  const mode = input.mode ?? getDeltaContextMode();
  const table = createAliasTable();
  const episodeAlias = table.mint("episode", input.episode.id, input.episode.label ?? undefined);

  const prior = [...(input.priorEvents ?? [])];
  const fresh = [...input.newEvents];

  // Mint prior event aliases FIRST in both modes: the ► numbering continues
  // from where pass 1 stopped, whether or not those events are printed.
  if (mode === "summary") for (const e of prior) table.mintEvent(e.id);

  const packed = packPrompt(
    {
      tz: input.tz,
      entities: [...(input.entities ?? [])],
      streams: [...input.streams],
      loops: [...(input.loops ?? [])],
      events: mode === "raw_events" ? [...prior, ...fresh] : fresh,
    },
    { table, ...(input.maxRoster === undefined ? {} : { maxRoster: input.maxRoster }) },
  );
  if (!packed.ok) return null;

  const newTokens = new Set<string>();
  for (const e of fresh) {
    const token = table.eventToken(e.id);
    if (token) newTokens.add(token);
  }

  const lines = markNewEvents(packed.text.split("\n"), newTokens);

  // Context block: the Y line (summary mode only — raw_events shows the events
  // themselves) and the already-extracted items, ahead of the first day block.
  const context: string[] = [];
  const summary = typeof input.episode.summary === "string" ? neutraliseLabel(input.episode.summary) : "";
  if (mode === "summary" && summary !== "") context.push(`Y|${episodeAlias}|${summary}`);
  context.push(...renderExtracted(input.extracted ?? []));

  if (context.length > 0) {
    const at = lines.findIndex((l) => l.startsWith("#D"));
    if (at === -1) lines.push(...context);
    else lines.splice(at, 0, ...context);
  }

  const itemIds: Record<string, string> = {};
  for (const item of input.extracted ?? []) {
    if (item.id) itemIds[item.alias.trim().toUpperCase()] = item.id;
  }

  return {
    system: buildCl1dSystem(),
    user: lines.join("\n"),
    table,
    mode,
    episodeAlias,
    itemIds,
    newEventTokens: [...newTokens],
    stats: packed.stats,
  };
}

/** The provider knobs §12.5 fixes. */
export interface Cl1dSendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  plainCompletion: true;
}

export function cl1dSendOptions(): Cl1dSendShape {
  return {
    model: P_CL1D.model,
    maxTurns: P_CL1D.turns,
    timeoutMs: P_CL1D.timeoutSeconds * 1_000,
    maxOutputTokens: P_CL1D.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

/** The delta call is the same role and lane as the full one (§12.4 / §12.5). */
export const CL1_ROLE = P_CL1.role;
