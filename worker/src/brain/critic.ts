// ===========================================================================
// The CRITIC pass (build P1.3, spec §8.2; V6 P1 S3.5) — grades the tick's
// writes BEFORE commit. One cheap haiku-class call per tick; fresh context,
// precision-biased. Input: Orient's decisions as numbered items + retrieved
// near-duplicates + the rubric baked into the prompt. Output: one verdict per
// item; a missing verdict defaults to commit (flags and rejects must be
// stated, silence never blocks the lane).
//
// V6 S3.5 adds the MECHANICAL layer (Product P1 §9 rule 3, backlog T7-2):
// code measures what code can — coverage (every bundle alias in exactly one
// of episodes/unsorted), non-verbatim quotes, items spanning two streams,
// and the bridge edges the commit will write (exact matches: 1.0 or nothing).
// The measurements ride into the critic.v5 input as [MECHANICAL] / [EDGES]
// and come back out as authoritative code verdicts merged over the model's:
// a model "commit" never overrides a mechanical reject. critic.v4 (frozen
// baseline) still sees its byte-identical v4 input; the mechanical report is
// computed either way and exposed on the run.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { bridgesAmong, type BridgeGraphEdge } from "../bridges/edges.js";
import { activeCriticPrompt, modelForVersionedPass, type VersionedPrompt } from "../prompts/versions.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "./llm.js";
import { resolveEventAliases, type OrientOutput, type OrientRun } from "./orient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CriticVerdictKind =
  | "commit"
  | "reject"
  | "downgrade_to_unsorted"
  | "flag_overlap";

export interface CriticVerdict {
  /** 1-based item number: episodes first, then proposals, then edges, input order. */
  item: number;
  verdict: CriticVerdictKind;
  reason?: string;
  /** flag_overlap's overlapping space (or the near-duplicate a reject names). */
  space_id?: string;
}

export interface CriticOutput {
  verdicts: CriticVerdict[];
  /** critic.v5: bundle aliases placed in no episode and no unsorted item. */
  uncovered?: string[];
}

/** Validate + narrow the Critic's JSON. Throws with a repairable message. */
export function parseCriticOutput(parsed: unknown): CriticOutput {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected {verdicts:[...]}");
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.verdicts)) throw new Error("verdicts must be an array");
  const verdicts: CriticVerdict[] = [];
  for (const raw of o.verdicts) {
    if (typeof raw !== "object" || raw === null) continue;
    const v = raw as Record<string, unknown>;
    const item = typeof v.item === "number" && Number.isInteger(v.item) ? v.item : NaN;
    if (!Number.isFinite(item) || item < 1) throw new Error("verdicts[].item must be a 1-based number");
    const kind = v.verdict;
    if (
      kind !== "commit" &&
      kind !== "reject" &&
      kind !== "downgrade_to_unsorted" &&
      kind !== "flag_overlap"
    ) {
      throw new Error(
        `verdicts[].verdict must be commit|reject|downgrade_to_unsorted|flag_overlap`,
      );
    }
    if (kind === "reject" && (typeof v.reason !== "string" || v.reason.trim() === "")) {
      throw new Error("a reject verdict needs a reason");
    }
    verdicts.push({
      item,
      verdict: kind,
      ...(typeof v.reason === "string" && v.reason.trim() !== "" ? { reason: v.reason } : {}),
      ...(typeof v.space_id === "string" && v.space_id.trim() !== ""
        ? { space_id: v.space_id }
        : {}),
    });
  }
  if (o.uncovered !== undefined && !Array.isArray(o.uncovered)) {
    throw new Error("uncovered must be an array of event aliases");
  }
  const uncovered = Array.isArray(o.uncovered)
    ? o.uncovered.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase())
    : undefined;
  return { verdicts, ...(uncovered !== undefined ? { uncovered } : {}) };
}

/** The effective verdict for a 1-based item — silence commits. */
export function verdictFor(output: CriticOutput, item: number): CriticVerdict {
  return output.verdicts.find((v) => v.item === item) ?? { item, verdict: "commit" };
}

// ---------------------------------------------------------------------------
// Mechanical layer (V6 S3.5 · T7-2) — code measures, code decides
// ---------------------------------------------------------------------------

/** An edge the commit will write for this bundle, numbered after the proposals. */
export interface CriticEdgeItem {
  /** `bridge:url` · `bridge:phone` · `mention` · `relates_to` … */
  kind: string;
  /** Endpoints as the pack names them (event aliases, entity ids). */
  src: string;
  dst: string;
  confidence: number;
}

/** Edge kinds that are exact literal matches — 1.0 or nothing (Product_V6 §23.5). */
export const BRIDGE_EDGE_PREFIX = "bridge:";
export const BRIDGE_EXACT_CONFIDENCE = 1;

export interface MechanicalInput {
  output: OrientOutput;
  /** Alias -> event id for the bundle (e1..eN). */
  aliases: ReadonlyMap<string, string>;
  /** Alias -> verbatim text, when known; quotes are checked only against known texts. */
  eventTexts?: ReadonlyMap<string, string>;
  /** Alias -> section tag (S1..Sk), when the pack rendered sections. */
  eventStreams?: ReadonlyMap<string, string>;
  edges?: readonly CriticEdgeItem[];
}

export interface MechanicalReport {
  /** Bundle aliases in no episode, no proposal and no unsorted item. */
  uncovered: string[];
  /** Bundle aliases placed by more than one item. */
  duplicated: string[];
  /** Item numbers whose quote is not verbatim in a cited event's text. */
  notVerbatim: number[];
  /** Item numbers whose events span two sections, or whose tag names another section. */
  multiStream: number[];
  /** Code verdicts: bridge edges below 1.0 (item-numbered after the proposals). */
  edgeVerdicts: CriticVerdict[];
  /** Numbered items in total: episodes + proposals + edges. */
  items: number;
}

function expand(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const t = token.trim().toLowerCase();
    const range = /^e(\d+)\s*-\s*e?(\d+)$/.exec(t);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) out.push(`e${i}`);
      continue;
    }
    if (t !== "") out.push(t);
  }
  return out;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The mechanical check. Deterministic, DB-free — the callers supply what
 * they know (texts, sections, edges); an unknown text is not a fabrication.
 */
export function mechanicalCriticCheck(input: MechanicalInput): MechanicalReport {
  const { output, aliases } = input;
  const bundleAliases = [...aliases.keys()].map((a) => a.toLowerCase());
  const placements = new Map<string, number>();
  const place = (tokens: readonly string[]): void => {
    for (const a of new Set(expand(tokens))) placements.set(a, (placements.get(a) ?? 0) + 1);
  };
  for (const e of output.episodes) place(e.events);
  for (const p of output.proposals) place(p.episode_events);
  for (const u of output.unsorted) place(u.events);
  const uncovered = bundleAliases.filter((a) => (placements.get(a) ?? 0) === 0);
  const duplicated = bundleAliases.filter((a) => (placements.get(a) ?? 0) > 1);

  const notVerbatim: number[] = [];
  const multiStream: number[] = [];
  let n = 0;
  const check = (events: readonly string[], evidence: OrientOutput["episodes"][number]["evidence"], tag?: string): void => {
    n++;
    if (input.eventTexts) {
      for (const ev of evidence) {
        const cited = expand(ev.event_ids).map((a) => input.eventTexts!.get(a)).filter((t): t is string => typeof t === "string");
        if (cited.length > 0 && !cited.some((t) => norm(t).includes(norm(ev.quote)))) {
          notVerbatim.push(n);
          break;
        }
      }
    }
    if (input.eventStreams) {
      const tags = new Set(expand(events).map((a) => input.eventStreams!.get(a)).filter((t): t is string => typeof t === "string"));
      const own = tag?.trim().toUpperCase();
      if (tags.size > 1 || (own && tags.size === 1 && !tags.has(own))) multiStream.push(n);
    }
  };
  for (const e of output.episodes) check(e.events, e.evidence, e.stream);
  for (const p of output.proposals) check(p.episode_events, p.evidence, p.stream);

  const edgeVerdicts: CriticVerdict[] = [];
  for (const edge of input.edges ?? []) {
    n++;
    if (edge.kind.startsWith(BRIDGE_EDGE_PREFIX) && edge.confidence < BRIDGE_EXACT_CONFIDENCE) {
      edgeVerdicts.push({
        item: n,
        verdict: "reject",
        reason: `${edge.kind} edge at ${edge.confidence} — bridges are exact: 1.0 or nothing`,
      });
    }
  }
  return { uncovered, duplicated, notVerbatim, multiStream, edgeVerdicts, items: n };
}

/**
 * Merge the model's verdicts with the mechanical ones. A code reject wins
 * over anything the model said for the same item; the mechanical coverage
 * list is authoritative (the model's own list is kept for the trace under
 * `modelUncovered` by the caller).
 */
export function mergeCriticVerdicts(model: CriticOutput, mechanical: MechanicalReport): CriticOutput {
  const byItem = new Map<number, CriticVerdict>();
  for (const v of model.verdicts) if (!byItem.has(v.item)) byItem.set(v.item, v);
  for (const v of mechanical.edgeVerdicts) byItem.set(v.item, v);
  const verdicts = [...byItem.values()].sort((a, b) => a.item - b.item);
  return { verdicts, uncovered: [...mechanical.uncovered] };
}

/** Render the mechanical report as the critic.v5 `[MECHANICAL]` block. */
export function renderMechanicalBlock(m: MechanicalReport): string {
  const lines = ["[MECHANICAL] measured by code — confirm, never contradict"];
  lines.push(`  uncovered aliases: ${m.uncovered.length > 0 ? m.uncovered.join(", ") : "(none — every bundle event is placed)"}`);
  if (m.duplicated.length > 0) lines.push(`  placed twice: ${m.duplicated.join(", ")}`);
  if (m.notVerbatim.length > 0) lines.push(`  quote not verbatim in cited events: items ${m.notVerbatim.join(", ")}`);
  if (m.multiStream.length > 0) lines.push(`  events span two streams / tag mismatch: items ${m.multiStream.join(", ")}`);
  if (m.edgeVerdicts.length > 0) {
    lines.push(`  bridge edges below 1.0 (rejected by code): items ${m.edgeVerdicts.map((v) => v.item).join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

/** Near-duplicate spaces for a proposal label, via spaces_fts. */
function nearMatches(label: string, limit = 3): { id: string; label: string }[] {
  const tokens = label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const match = tokens.map((t) => `"${t}"`).join(" OR ");
  try {
    return getDb()
      .prepare(
        `SELECT s.id, s.label FROM spaces_fts f JOIN spaces s ON s.id = f.space_id
          WHERE spaces_fts MATCH ? AND s.status NOT IN ('archived','rejected')
          ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as { id: string; label: string }[];
  } catch {
    return [];
  }
}

interface EventFacts {
  /** alias -> verbatim text */
  texts: Map<string, string>;
  /** alias -> stream id */
  streams: Map<string, string>;
}

/** Text and stream of every bundle alias, read once. */
function eventFacts(aliases: ReadonlyMap<string, string>): EventFacts {
  const facts: EventFacts = { texts: new Map(), streams: new Map() };
  const ids = [...aliases.values()];
  if (ids.length === 0) return facts;
  const ph = ids.map(() => "?").join(",");
  let rows: { id: string; text: string | null; stream_id: string | null }[] = [];
  try {
    rows = getDb()
      .prepare(`SELECT id, text, stream_id FROM events WHERE id IN (${ph})`)
      .all(...ids) as typeof rows;
  } catch {
    return facts;
  }
  const back = new Map(rows.map((r) => [r.id, r]));
  for (const [alias, id] of aliases) {
    const r = back.get(id);
    if (!r) continue;
    facts.texts.set(alias.toLowerCase(), r.text ?? "");
    if (r.stream_id) facts.streams.set(alias.toLowerCase(), r.stream_id);
  }
  return facts;
}

/** Verbatim texts of the cited events, so fabricated quotes are checkable. */
function citedEventTexts(
  orient: OrientOutput,
  aliases: ReadonlyMap<string, string>,
): string[] {
  const aliasTokens = new Set<string>();
  for (const e of orient.episodes) for (const ev of e.evidence) for (const a of ev.event_ids) aliasTokens.add(a);
  for (const p of orient.proposals) for (const ev of p.evidence) for (const a of ev.event_ids) aliasTokens.add(a);
  const ids = resolveEventAliases([...aliasTokens], aliases);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, text FROM events WHERE id IN (${ph})`)
    .all(...ids) as { id: string; text: string | null }[];
  const back = new Map(rows.map((r) => [r.id, r.text ?? ""]));
  const lines: string[] = [];
  for (const token of aliasTokens) {
    const [id] = resolveEventAliases([token], aliases);
    if (id) lines.push(`  ${token}: ${back.get(id) ?? ""}`);
  }
  return lines;
}

/** The bridge edges among the bundle's events, as numbered critic items. */
export function bundleEdges(aliases: ReadonlyMap<string, string>): CriticEdgeItem[] {
  const ids = [...aliases.values()];
  if (ids.length === 0) return [];
  let edges: BridgeGraphEdge[] = [];
  try {
    edges = bridgesAmong(ids);
  } catch {
    return [];
  }
  const aliasOf = new Map([...aliases].map(([a, id]) => [id, a]));
  return edges.map((e) => ({
    kind: e.label,
    src: aliasOf.get(e.srcEventId) ?? e.srcEventId,
    dst: aliasOf.get(e.dstEventId) ?? e.dstEventId,
    confidence: e.confidence,
  }));
}

export function renderEdgeItems(edges: readonly CriticEdgeItem[], firstItem: number): string[] {
  if (edges.length === 0) return [];
  const lines = ["[EDGES] the commit will write these edges — one verdict each"];
  edges.forEach((e, i) => {
    lines.push(`  ${firstItem + i}. [edge] ${e.kind} ${e.src} → ${e.dst} · conf ${e.confidence}`);
  });
  return lines;
}

export interface CriticInputOptions {
  /** Edge items numbered after the proposals (critic.v5). */
  edges?: readonly CriticEdgeItem[];
  /** The mechanical report to show the model (critic.v5). */
  mechanical?: MechanicalReport;
  /** The pack the pass saw, verbatim (critic.v5 `[PACK]`). */
  pack?: string;
}

/**
 * The Critic's packed input: Orient's decisions as numbered items, retrieved
 * near-duplicates per proposal, and the cited events' verbatim texts. With
 * options (critic.v5) it also carries the pack, the edge items and the
 * mechanical report; without them the v4 input is byte-identical to before.
 */
export function buildCriticInput(
  run: {
    bundle: DeltaBundle;
    output: OrientOutput;
    aliases: ReadonlyMap<string, string>;
  },
  options: CriticInputOptions = {},
): string {
  const { output } = run;
  const lines: string[] = [];
  if (options.pack !== undefined) lines.push("[PACK]", options.pack, "");
  lines.push(
    `[TICK] stream ${run.bundle.streamKey} · ${run.bundle.events.length} new events · mode propose-only` +
      (options.pack !== undefined ? ` · lane ${run.bundle.lane}` : ""),
    "[DECISIONS]",
  );
  let n = 0;
  for (const e of output.episodes) {
    n++;
    const target = e.action === "join" ? `join ${e.episode}` : "new episode";
    const attach = e.space ? ` → attach ${e.space}` : "";
    const tag = e.stream ? ` · stream ${e.stream}` : "";
    const quotes = e.evidence.map((ev) => `"${ev.quote}" (${ev.event_ids.join(",")})`).join(" · ");
    lines.push(
      `  ${n}. [episode] ${target}${attach}${tag} · events ${e.events.join(",")} · conf ${e.confidence}`,
      `     summary: ${e.summary}`,
      `     evidence: ${quotes || "(none)"}`,
    );
  }
  for (const p of output.proposals) {
    n++;
    const near = nearMatches(p.label);
    const tag = p.stream ? ` · stream ${p.stream}` : "";
    const quotes = p.evidence.map((ev) => `"${ev.quote}" (${ev.event_ids.join(",")})`).join(" · ");
    lines.push(
      `  ${n}. [proposal] new space "${p.label}"${p.goal ? ` · goal: ${p.goal}` : ""}${tag} · conf ${p.confidence}`,
      `     evidence: ${quotes || "(none)"}`,
      `     near-matches: ${
        near.length > 0 ? near.map((m) => `${m.id} "${m.label}"`).join(" · ") : "(none)"
      }`,
    );
  }
  if (options.edges && options.edges.length > 0) lines.push(...renderEdgeItems(options.edges, n + 1));
  if (options.mechanical) {
    if (output.unsorted.length > 0) {
      lines.push(
        "[UNSORTED] (not graded — placement only)",
        ...output.unsorted.map((u) => `  events ${u.events.join(",")}${u.stream ? ` · stream ${u.stream}` : ""}: ${u.summary}`),
      );
    }
    lines.push(renderMechanicalBlock(options.mechanical));
  }
  const cited = citedEventTexts(output, run.aliases);
  if (cited.length > 0) lines.push("[CITED EVENTS — verbatim]", ...cited);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface CriticRun {
  result: JsonPassResult<CriticOutput>;
  /** Model verdicts merged with the mechanical ones (code wins). */
  output?: CriticOutput;
  /** Number of graded items (episodes + proposals + edges). */
  items: number;
  /** What code measured before and regardless of the model. */
  mechanical: MechanicalReport;
  /** The model's own coverage list, when it gave one (critic.v5). */
  modelUncovered?: string[];
}

/** One Critic call over an Orient run's decisions. */
export async function runCritic(
  orientRun: OrientRun,
  deps: JsonPassDeps = {},
): Promise<CriticRun> {
  const output = orientRun.output;
  const prompt = activeCriticPrompt();
  const aliases = orientRun.packed.eventAliases;
  const v5 = prompt.version >= 5;
  const edges = output && v5 ? bundleEdges(aliases) : [];
  const facts = output ? eventFacts(aliases) : { texts: new Map<string, string>(), streams: new Map<string, string>() };
  const tagOfStream = new Map([...orientRun.packed.streamAliases].map(([tag, sid]) => [sid, tag]));
  const eventStreams = new Map([...facts.streams].map(([a, sid]) => [a, tagOfStream.get(sid) ?? sid]));
  const mechanical = mechanicalCriticCheck({
    output: output ?? { episodes: [], proposals: [], unsorted: [], questions: [] },
    aliases,
    eventTexts: facts.texts,
    eventStreams,
    edges,
  });
  const items = mechanical.items;
  if (!output || items === 0) {
    // Nothing to grade — an empty tick commits trivially, zero calls.
    return { result: emptyResult(prompt), output: { verdicts: [], uncovered: mechanical.uncovered }, items: 0, mechanical };
  }
  const user = buildCriticInput(
    { bundle: orientRun.bundle, output, aliases },
    v5 ? { edges, mechanical, pack: orientRun.packed.user } : {},
  );
  const result = await runJsonPass(
    {
      pass: prompt.pass,
      system: prompt.system,
      model: modelForVersionedPass(prompt),
      user,
      role: "critic",
      unit: {
        kind: "tick",
        id: `${orientRun.bundle.streamId}:${orientRun.bundle.part}`,
      },
      lane: orientRun.bundle.lane === "live" ? "live" : "understanding",
      origin: orientRun.bundle.lane === "live" ? "live" : "backfill",
      validate: parseCriticOutput,
    },
    deps,
  );
  const merged = result.output ? mergeCriticVerdicts(result.output, mechanical) : undefined;
  return {
    result,
    output: merged,
    items,
    mechanical,
    ...(result.output?.uncovered ? { modelUncovered: result.output.uncovered } : {}),
  };
}

function emptyResult(prompt: VersionedPrompt): JsonPassResult<CriticOutput> {
  return {
    pass: prompt.pass,
    status: "ok",
    output: { verdicts: [] },
    responses: [],
    runIds: [],
    usage: {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    },
  };
}
