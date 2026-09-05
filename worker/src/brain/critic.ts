// ===========================================================================
// The CRITIC pass (build P1.3, spec §8.2) — grades the tick's writes BEFORE
// commit. One cheap haiku-class call per tick; fresh context, precision-
// biased. Input: Orient's decisions as numbered items + retrieved near-
// duplicates + the rubric baked into the prompt. Output: one verdict per
// item; a missing verdict defaults to commit (flags and rejects must be
// stated, silence never blocks the lane).
// ===========================================================================

import { getDb } from "../db/connection.js";
import { CRITIC_V4 } from "../prompts/critic.v4.js";
import type { DeltaBundle } from "../scheduler/dispatch.js";
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
  /** 1-based item number: episodes first, then proposals, input order. */
  item: number;
  verdict: CriticVerdictKind;
  reason?: string;
  /** flag_overlap's overlapping space. */
  space_id?: string;
}

export interface CriticOutput {
  verdicts: CriticVerdict[];
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
  return { verdicts };
}

/** The effective verdict for a 1-based item — silence commits. */
export function verdictFor(output: CriticOutput, item: number): CriticVerdict {
  return output.verdicts.find((v) => v.item === item) ?? { item, verdict: "commit" };
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

/**
 * The Critic's packed input: Orient's decisions as numbered items, retrieved
 * near-duplicates per proposal, and the cited events' verbatim texts.
 */
export function buildCriticInput(run: {
  bundle: DeltaBundle;
  output: OrientOutput;
  aliases: ReadonlyMap<string, string>;
}): string {
  const { output } = run;
  const lines: string[] = [
    `[TICK] stream ${run.bundle.streamKey} · ${run.bundle.events.length} new events · mode propose-only`,
    "[DECISIONS]",
  ];
  let n = 0;
  for (const e of output.episodes) {
    n++;
    const target = e.action === "join" ? `join ${e.episode}` : "new episode";
    const attach = e.space ? ` → attach ${e.space}` : "";
    const quotes = e.evidence.map((ev) => `"${ev.quote}" (${ev.event_ids.join(",")})`).join(" · ");
    lines.push(
      `  ${n}. [episode] ${target}${attach} · events ${e.events.join(",")} · conf ${e.confidence}`,
      `     summary: ${e.summary}`,
      `     evidence: ${quotes || "(none)"}`,
    );
  }
  for (const p of output.proposals) {
    n++;
    const near = nearMatches(p.label);
    const quotes = p.evidence.map((ev) => `"${ev.quote}" (${ev.event_ids.join(",")})`).join(" · ");
    lines.push(
      `  ${n}. [proposal] new space "${p.label}"${p.goal ? ` · goal: ${p.goal}` : ""} · conf ${p.confidence}`,
      `     evidence: ${quotes || "(none)"}`,
      `     near-matches: ${
        near.length > 0 ? near.map((m) => `${m.id} "${m.label}"`).join(" · ") : "(none)"
      }`,
    );
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
  output?: CriticOutput;
  /** Number of graded items (episodes + proposals). */
  items: number;
}

/** One Critic call over an Orient run's decisions. */
export async function runCritic(
  orientRun: OrientRun,
  deps: JsonPassDeps = {},
): Promise<CriticRun> {
  const output = orientRun.output;
  const items = output ? output.episodes.length + output.proposals.length : 0;
  if (!output || items === 0) {
    // Nothing to grade — an empty tick commits trivially, zero calls.
    return { result: emptyResult(), output: { verdicts: [] }, items: 0 };
  }
  const user = buildCriticInput({
    bundle: orientRun.bundle,
    output,
    aliases: orientRun.packed.eventAliases,
  });
  const result = await runJsonPass(
    {
      pass: CRITIC_V4.pass,
      system: CRITIC_V4.system,
      user,
      role: "critic",
      unit: {
        kind: "tick",
        id: `${orientRun.bundle.streamId}:${orientRun.bundle.part}`,
      },
      lane: "understanding",
      origin: orientRun.bundle.lane === "live" ? "live" : "backfill",
      validate: parseCriticOutput,
    },
    deps,
  );
  return { result, output: result.output, items };
}

function emptyResult(): JsonPassResult<CriticOutput> {
  return {
    pass: CRITIC_V4.pass,
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
