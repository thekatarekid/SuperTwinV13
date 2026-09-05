// ===========================================================================
// The ORIENT pass (build P1.3, spec §8.1) — the MAP half of the tick.
//
// One Orient call per delta bundle: the packer assembles the §6.4 context,
// the traced JSON runner makes the call (parallel bundles ride the provider
// pool's llm lane), and the output is validated into typed decisions with
// every alias resolved back to real event ids. Nothing is written here — the
// Critic grades first, then brain/commit.ts writes through the single writer.
// ===========================================================================

import type { DeltaBundle } from "../scheduler/dispatch.js";
import { packOrientContext, type PackedContext, type PackOptions } from "../packer/index.js";
import { ORIENT_V6 } from "../prompts/orient.v6.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "./llm.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface OrientEvidence {
  event_ids: string[];
  quote: string;
}

export interface OrientEpisodeDecision {
  action: "join" | "new";
  /** Existing episode id (join only). */
  episode?: string;
  /** Aliases/ranges as emitted ("e1", "e4-e11"). */
  events: string[];
  summary: string;
  /** Candidate space id to attach (optional). */
  space?: string;
  /** Chain link for "same topic after a long break". */
  chain_prev?: string;
  evidence: OrientEvidence[];
  confidence: number;
}

export interface OrientProposal {
  label: string;
  life_area?: string;
  goal?: string;
  /** Spec §9 space typing (orient.v2): short|long. */
  term?: string;
  /** Spec §9 space typing (orient.v2): permanent|ephemeral. */
  persistence?: string;
  /** Spec §9 space typing (orient.v2): one-time|recurring. */
  cadence?: string;
  episode_events: string[];
  summary: string;
  evidence: OrientEvidence[];
  confidence: number;
}

export interface OrientUnsorted {
  events: string[];
  summary: string;
  reason?: string;
  confidence: number;
}

export interface OrientOutput {
  episodes: OrientEpisodeDecision[];
  proposals: OrientProposal[];
  unsorted: OrientUnsorted[];
  questions: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function conf(v: unknown): number {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.9;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function evidence(v: unknown): OrientEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: OrientEvidence[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    const quote = str(o.quote);
    if (!quote) continue;
    out.push({ event_ids: strArray(o.event_ids), quote });
  }
  return out;
}

/** Validate + narrow Orient's JSON. Throws with a repairable message. */
export function parseOrientOutput(parsed: unknown): OrientOutput {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected an object {episodes, proposals, unsorted, questions}");
  }
  const o = parsed as Record<string, unknown>;
  const episodes: OrientEpisodeDecision[] = [];
  for (const raw of Array.isArray(o.episodes) ? o.episodes : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const action = e.action === "join" || e.action === "new" ? e.action : undefined;
    if (!action) throw new Error(`episodes[].action must be "join" or "new"`);
    const events = strArray(e.events);
    if (events.length === 0) throw new Error("episodes[].events must name at least one event");
    const episode = str(e.episode);
    if (action === "join" && !episode) throw new Error(`a "join" needs an "episode" id`);
    const summary = str(e.summary);
    if (!summary) throw new Error("episodes[].summary is required");
    episodes.push({
      action,
      ...(episode ? { episode } : {}),
      events,
      summary,
      ...(str(e.space) ? { space: str(e.space) } : {}),
      ...(str(e.chain_prev) ? { chain_prev: str(e.chain_prev) } : {}),
      evidence: evidence(e.evidence),
      confidence: conf(e.confidence),
    });
  }
  const proposals: OrientProposal[] = [];
  for (const raw of Array.isArray(o.proposals) ? o.proposals : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as Record<string, unknown>;
    const label = str(p.label);
    if (!label) throw new Error("proposals[].label is required");
    const words = label.split(/\s+/).length;
    if (words > 12) throw new Error("proposals[].label must be 4-8 specific words");
    proposals.push({
      label,
      ...(str(p.life_area) ? { life_area: str(p.life_area) } : {}),
      ...(str(p.goal) ? { goal: str(p.goal) } : {}),
      ...(str(p.term) ? { term: str(p.term) } : {}),
      ...(str(p.persistence) ? { persistence: str(p.persistence) } : {}),
      ...(str(p.cadence) ? { cadence: str(p.cadence) } : {}),
      episode_events: strArray(p.episode_events ?? p.events),
      summary: str(p.summary) ?? label,
      evidence: evidence(p.evidence),
      confidence: conf(p.confidence),
    });
  }
  const unsorted: OrientUnsorted[] = [];
  for (const raw of Array.isArray(o.unsorted) ? o.unsorted : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const u = raw as Record<string, unknown>;
    unsorted.push({
      events: strArray(u.events),
      summary: str(u.summary) ?? "",
      ...(str(u.reason) ? { reason: str(u.reason) } : {}),
      confidence: conf(u.confidence),
    });
  }
  return {
    episodes,
    proposals,
    unsorted,
    questions: strArray(o.questions),
  };
}

// ---------------------------------------------------------------------------
// Alias resolution ("e1", "e4-e11" → event ids)
// ---------------------------------------------------------------------------

/** Resolve alias/range tokens against the pack's alias table, in order. */
export function resolveEventAliases(
  tokens: readonly string[],
  aliases: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const t = token.trim();
    const range = /^e(\d+)\s*-\s*e?(\d+)$/i.exec(t);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const id = aliases.get(`e${i}`);
        if (id && !out.includes(id)) out.push(id);
      }
      continue;
    }
    const id = aliases.get(t.toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface OrientRun {
  bundle: DeltaBundle;
  packed: PackedContext;
  result: JsonPassResult<OrientOutput>;
  /** The validated output, or undefined when the call quarantined/failed. */
  output?: OrientOutput;
}

/** Pack + one Orient call for a bundle. No writes — commit.ts owns those. */
export async function runOrient(
  bundle: DeltaBundle,
  deps: JsonPassDeps = {},
  packOpts: PackOptions = {},
): Promise<OrientRun> {
  const packed = await packOrientContext(bundle, packOpts);
  const result = await runJsonPass(
    {
      pass: ORIENT_V6.pass,
      system: ORIENT_V6.system,
      user: packed.user,
      role: "orient",
      unit: { kind: "bundle", id: `${bundle.streamId}:${bundle.part}` },
      lane: "understanding",
      origin: bundle.lane === "live" ? "live" : "backfill",
      validate: parseOrientOutput,
    },
    deps,
  );
  return { bundle, packed, result, output: result.output };
}
