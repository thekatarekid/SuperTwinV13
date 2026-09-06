// ===========================================================================
// The LIVE pass (V6 Phase 1, S4.1; Build §7.1; Prompts P-01; Product P1 §6,
// §8, §18). ONE call per live bundle that understands AND decides.
//
//   pack (S3.2, code) ─► live.v1 ─► { understanding, decide }
//        understanding ─► Critic ─► commit (the S3.1 single writer)   [as orient]
//        decide        ─► tasks / closures / schedules via the per-space
//                         appliers (brain/decide-pass.ts applyDecideItems)
//                      ─► PREPARED ACTIONS → deferred_outputs rows for
//                         executor-lite (S4.2) and the surface router (S4.3)
//
// Three code properties this module owns, each asserted by LIV-0x:
//
//   SECTION INDEPENDENCE (LIV-04, LIV-05). The two sections are parsed on
//   their own. A decide section that is not an object is logged and dropped
//   while the understanding commits; an understanding whose items are broken
//   is quarantined PER ITEM (the good episodes commit, each bad one becomes a
//   decisions row) while a valid decide still runs. The runner's repair round
//   fires only when the answer is not an object at all, or when BOTH sections
//   are unusable — one section can never cost the other a model call.
//
//   LANE DISCIPLINE (LIV-02). `decide.prepared` is discarded whenever the
//   bundle's lane is not "live" — counted, decision-rowed, never persisted.
//   The history lane runs orient.v7 (no decide section) and any decide key it
//   returns is ignored there too (parseOrientOutput reads only its own keys).
//   `assist_from_history` is therefore zero by construction.
//
//   GROUNDING IS THIS FLUSH (LIV-03). A prepared action's `grounded_in` must
//   resolve through the pack's bundle alias table (e<n> → this bundle's event
//   ids). Thread history renders without aliases, so old context alone can
//   never ground an action; an action with nothing from this bundle is
//   dropped (`nudge_without_grounding` = 0).
//
// INTENT FLOOR (LIV-06). Below `assist.intent_confidence_min` (0.7 by default)
// the action is still prepared — the work is worth having — but its surface is
// "shelf": no card. The verdict travels with the row. S4.4 moved the threshold
// itself to Settings › Assist and the judgement to the output-side
// `nudgeVerdict()` (surfaces/nudge-verdict.ts), which the surface router reads
// too: writer and router can no longer hold two different floors.
//
// TWO CALLS (Build §7.3, S4.4). The S4 ship gate's item 1 is red, so the live
// lane does NOT run the merged call by default. `runLiveUnderstanding` +
// `runLiveDecide` below are the fallback: ONE pack, the frozen orient prompt,
// then live-decide.v1. Everything after parsing — grounding, the lane rule,
// the floor, the commit — is the same code in both modes.
//
// Nothing here is a nudge: the surface router (S4.3) reads the rows this
// module writes and decides WHERE, never whether.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { packOrientContext, type PackedContext, type PackOptions } from "../packer/index.js";
import { liveModeLine } from "../prompts/live.v1.js";
import { liveDecideModeLine } from "../prompts/live-decide.v1.js";
import {
  activeLiveDecidePrompt,
  activeLivePrompt,
  activeOrientPrompt,
  modelForVersionedPass,
  type LiveCallMode,
  type VersionedPrompt,
} from "../prompts/versions.js";
import { validateDecideV9Output, type DecideOutputV9 } from "../prompts/decide.v9.js";
import { nudgeThresholds, nudgeVerdict } from "../surfaces/nudge-verdict.js";
import { applyDecideItems, emptyDecideApplied, type DecideApplied } from "./decide-pass.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "./llm.js";
import { parseOrientOutput, resolveEventAliases, type OrientOutput, type OrientRun } from "./orient.js";
import type { CommitReport } from "./commit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PREPARED_KINDS = [
  "help_now",
  "done_for_you",
  "done_in_advance",
  "needs_you",
  "something_moved",
  "understanding",
] as const;
export type PreparedKind = (typeof PREPARED_KINDS)[number];

/** P-01 rule 8: the only actions. A send or a payment is never one of them. */
export const PREPARED_ACTIONS = ["compare", "research", "draft_reply", "draft_message", "brief", "question"] as const;
export type PreparedAction = (typeof PREPARED_ACTIONS)[number];

export const URGENCIES = ["now", "today", "none"] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface LivePrepared {
  kind: PreparedKind;
  intent: string;
  intent_confidence: number;
  action: PreparedAction;
  space: string | null;
  urgency: Urgency;
  deadline_at: string | null;
  inputs: Record<string, unknown>;
  /** As emitted — e<n> aliases. Resolved by groundPrepared. */
  grounded_in: string[];
  reasoning: string | null;
}

export interface LiveDecide {
  tasks: DecideOutputV9["tasks"];
  closures: DecideOutputV9["closures"];
  schedules: DecideOutputV9["schedules"];
  prepared: LivePrepared[];
  /** Prepared entries that failed shape validation (kind/action/intent). */
  preparedInvalid: number;
  /** Prepared entries discarded because the lane is not live. */
  preparedDiscardedForLane: number;
}

export interface RejectedUnderstandingItem {
  kind: "episode" | "proposal" | "unsorted";
  index: number;
  reason: string;
}

export interface LiveOutput {
  /** The orient-compatible section; undefined when it was not an object. */
  understanding?: OrientOutput;
  understandingError?: string;
  /** Items the per-item parse threw out (the rest committed). */
  understandingRejected: RejectedUnderstandingItem[];
  /** The decide section; undefined when it was not an object. */
  decide?: LiveDecide;
  decideError?: string;
  /** MODE: insufficient-context — everything but unsorted/questions stripped. */
  insufficientContext: boolean;
  stripped: { episodes: number; proposals: number; tasks: number; prepared: number };
}

export interface ParseLiveOptions {
  lane: DeltaBundle["lane"];
  /** The pack sent the insufficient-context instruction (thin, second sight). */
  insufficientContext?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing — section-independent
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function num01(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * P-01 renders questions as {kind,text,event_ids}; orient.v7 (and every
 * reader downstream) takes strings. Objects fold to "<kind>: <text>" — an
 * injection report keeps the "injection:" prefix the critic and the S4.7
 * detector look for. Strings pass through untouched.
 */
export function normaliseQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const q of raw) {
    if (typeof q === "string") {
      if (q.trim() !== "") out.push(q);
      continue;
    }
    const r = rec(q);
    if (!r) continue;
    const text = str(r.text);
    if (!text) continue;
    const kind = str(r.kind);
    const ids = strs(r.event_ids);
    const body = ids.length > 0 && !text.includes(ids[0]!) ? `${text} (${ids.join(", ")})` : text;
    out.push(kind && !text.toLowerCase().startsWith(`${kind.toLowerCase()}:`) ? `${kind}: ${body}` : body);
  }
  return out;
}

/**
 * Parse the understanding section ITEM BY ITEM with the orient parser: every
 * episode, proposal and unsorted entry is validated alone, so one broken item
 * costs itself and nothing else (LIV-05). Returns undefined output only when
 * the section is not an object at all.
 */
export function parseUnderstandingPerItem(raw: unknown): {
  output?: OrientOutput;
  rejected: RejectedUnderstandingItem[];
  error?: string;
} {
  const u = rec(raw);
  if (!u) return { rejected: [], error: `understanding is ${raw === undefined ? "missing" : "not an object"}` };
  const rejected: RejectedUnderstandingItem[] = [];
  const output: OrientOutput = { episodes: [], proposals: [], unsorted: [], questions: normaliseQuestions(u.questions) };
  const lists: Array<[RejectedUnderstandingItem["kind"], "episodes" | "proposals" | "unsorted"]> = [
    ["episode", "episodes"],
    ["proposal", "proposals"],
    ["unsorted", "unsorted"],
  ];
  for (const [kind, key] of lists) {
    const items = Array.isArray(u[key]) ? (u[key] as unknown[]) : [];
    items.forEach((item, index) => {
      if (rec(item) === null) {
        rejected.push({ kind, index, reason: `${key}[${index}] is not an object` });
        return;
      }
      try {
        const one = parseOrientOutput({ episodes: [], proposals: [], unsorted: [], questions: [], [key]: [item] });
        output[key].push(...(one[key] as never[]));
      } catch (err) {
        rejected.push({ kind, index, reason: err instanceof Error ? err.message : String(err) });
      }
    });
  }
  return { output, rejected };
}

function parsePrepared(raw: unknown): LivePrepared | null {
  const r = rec(raw);
  if (!r) return null;
  const kind = str(r.kind);
  const action = str(r.action);
  const intent = str(r.intent);
  if (!kind || !(PREPARED_KINDS as readonly string[]).includes(kind)) return null;
  // Rule 8: a send / pay / any action outside the list is not a prepared action.
  if (!action || !(PREPARED_ACTIONS as readonly string[]).includes(action)) return null;
  if (!intent) return null;
  const urgency = str(r.urgency);
  const inputs = rec(r.inputs) ?? {};
  return {
    kind: kind as PreparedKind,
    intent,
    // A missing confidence is not a confident action: it reads as 0 and shelves.
    intent_confidence: num01(r.intent_confidence) ?? 0,
    action: action as PreparedAction,
    space: str(r.space),
    urgency: urgency && (URGENCIES as readonly string[]).includes(urgency) ? (urgency as Urgency) : "none",
    deadline_at: str(r.deadline_at),
    inputs,
    grounded_in: strs(r.grounded_in),
    reasoning: str(r.reasoning),
  };
}

/** Parse the decide section; undefined only when it is not an object. */
export function parseLiveDecide(raw: unknown, lane: DeltaBundle["lane"]): { decide?: LiveDecide; error?: string } {
  const d = rec(raw);
  if (!d) return { error: `decide is ${raw === undefined ? "missing" : "not an object"}` };
  let v9: DecideOutputV9;
  try {
    // The v9 validator is tolerant per entry (bad entries → skipped) and
    // throws only on a non-object, which rec() already excluded.
    v9 = validateDecideV9Output({
      summary: null,
      latest: null,
      plan: null,
      milestones: [],
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      closures: Array.isArray(d.closures) ? d.closures : [],
      schedules: Array.isArray(d.schedules) ? d.schedules : [],
      follow_ups: [],
      questions: [],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const prepared: LivePrepared[] = [];
  let preparedInvalid = 0;
  const rawPrepared = Array.isArray(d.prepared) ? d.prepared : [];
  for (const p of rawPrepared) {
    const parsed = parsePrepared(p);
    if (parsed) prepared.push(parsed);
    else preparedInvalid += 1;
  }
  // LIV-02: prepared actions exist on the live lane only. Counted, dropped.
  const preparedDiscardedForLane = lane === "live" ? 0 : prepared.length;
  return {
    decide: {
      tasks: v9.tasks,
      closures: v9.closures,
      schedules: v9.schedules,
      prepared: lane === "live" ? prepared : [],
      preparedInvalid,
      preparedDiscardedForLane,
    },
  };
}

/**
 * The live.v1 validator: section-independent. Throws (→ the runner's one
 * repair round) only when the answer is not an object or BOTH sections are
 * unusable — the model then answered with nothing the code can use.
 */
export function parseLiveOutput(parsed: unknown, opts: ParseLiveOptions): LiveOutput {
  const root = rec(parsed);
  if (!root) throw new Error('expected one JSON object with "understanding" and "decide"');
  // Byte-compatibility cuts both ways: an answer in the BARE orient.v7 shape
  // (no "understanding" key, the orient keys at the root) is a usable
  // understanding with no decide section — never a repair round.
  const bareOrient =
    root.understanding === undefined &&
    ["episodes", "proposals", "unsorted", "questions"].some((k) => Array.isArray(root[k]));
  const u = parseUnderstandingPerItem(bareOrient ? root : root.understanding);
  const d = parseLiveDecide(root.decide, opts.lane);
  if (!u.output && !d.decide) {
    throw new Error(`neither section is usable — ${u.error}; ${d.error}`);
  }
  const out: LiveOutput = {
    ...(u.output ? { understanding: u.output } : {}),
    ...(u.error ? { understandingError: u.error } : {}),
    understandingRejected: u.rejected,
    ...(d.decide ? { decide: d.decide } : {}),
    ...(d.error ? { decideError: d.error } : {}),
    insufficientContext: opts.insufficientContext === true,
    stripped: { episodes: 0, proposals: 0, tasks: 0, prepared: 0 },
  };
  if (out.insufficientContext) {
    // Rule 5 / LIV-10: only unsorted + questions survive; the rest is rejected by code.
    if (out.understanding) {
      out.stripped.episodes = out.understanding.episodes.length;
      out.stripped.proposals = out.understanding.proposals.length;
      out.understanding = { ...out.understanding, episodes: [], proposals: [] };
    }
    if (out.decide) {
      out.stripped.tasks = out.decide.tasks.length + out.decide.closures.length + out.decide.schedules.length;
      out.stripped.prepared = out.decide.prepared.length;
      out.decide = { ...out.decide, tasks: [], closures: [], schedules: [], prepared: [] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grounding and the intent floor
// ---------------------------------------------------------------------------

export interface GroundedPrepared extends LivePrepared {
  /** Real event ids of THIS bundle the action cites. Non-empty by construction. */
  groundedEventIds: string[];
}

/**
 * Resolve `grounded_in` through the bundle alias table. Only e<n> aliases of
 * this flush resolve; a raw event id (old context, a hallucinated id) does
 * not. Actions left with nothing are dropped (LIV-03).
 */
export function groundPrepared(
  prepared: readonly LivePrepared[],
  aliases: ReadonlyMap<string, string>,
): { grounded: GroundedPrepared[]; ungrounded: LivePrepared[] } {
  const grounded: GroundedPrepared[] = [];
  const ungrounded: LivePrepared[] = [];
  for (const p of prepared) {
    const ids = resolveEventAliases(p.grounded_in, aliases);
    if (ids.length === 0) ungrounded.push(p);
    else grounded.push({ ...p, groundedEventIds: ids });
  }
  return { grounded, ungrounded };
}

export type PreparedSurface = "card" | "shelf";

/**
 * LIV-06: a card must name the right goal. Below the intent floor the action
 * is prepared and shelved (panel / Prepared shelf / space / timeline), never
 * a card. The router (S4.3) decides where among those; this decides the floor.
 *
 * S4.4: the judgement itself moved OUT of this module to the output-side
 * `nudgeVerdict()` (surfaces/nudge-verdict.ts), which the router reads too, so
 * the writer and the router can no longer disagree about the floor. This
 * wrapper is the writer's view of that one verdict.
 */
export function preparedSurface(
  p: Pick<LivePrepared, "intent_confidence"> & Partial<Pick<LivePrepared, "kind">>,
  floor: number,
  blockedKinds: readonly string[] = [],
): PreparedSurface {
  return nudgeVerdict({ kind: p.kind ?? "", intentConfidence: p.intent_confidence }, { intentFloor: floor, blockedKinds }).surface;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface LiveRun extends OrientRun {
  /**
   * How many calls this bundle cost: "merged" is S4.1's one live.v1 call,
   * "two-call" is the Build §7.3 fallback (orient, then live-decide.v1 over
   * the same pack).
   */
  mode: LiveCallMode;
  /** The live prompt that ran (null: live pass switched off — orient ran instead). */
  prompt: VersionedPrompt | null;
  liveResult: JsonPassResult<LiveOutput>;
  live?: LiveOutput;
}

function orientShaped(result: JsonPassResult<LiveOutput>, understanding: OrientOutput | undefined): JsonPassResult<OrientOutput> {
  const { output: _drop, ...rest } = result;
  return { ...rest, ...(understanding ? { output: understanding } : {}) };
}

/** Pack + one live.v1 call for a bundle. No writes — commit.ts and applyLiveDecide own those. */
export async function runLive(
  bundle: DeltaBundle,
  deps: JsonPassDeps = {},
  packOpts: PackOptions = {},
  prompt: VersionedPrompt | null = activeLivePrompt(),
): Promise<LiveRun> {
  if (!prompt) throw new Error("runLive called with the live pass switched off");
  const packed: PackedContext = await packOrientContext(bundle, packOpts);
  const zero = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
  if (packed.held) {
    // Thin context, first sight (PCK-06): held one flush, no call.
    const liveResult: JsonPassResult<LiveOutput> = {
      pass: prompt.pass,
      status: "failed",
      responses: [],
      runIds: [],
      usage: zero,
      error: { code: "thin_context_held", message: packed.thinReasons.join("; ") },
    };
    return { bundle, packed, mode: "merged", prompt, liveResult, result: orientShaped(liveResult, undefined) };
  }
  const insufficient = packed.thin && !packed.held;
  const liveResult = await runJsonPass<LiveOutput>(
    {
      pass: prompt.pass,
      system: prompt.system,
      model: modelForVersionedPass(prompt),
      user: `${liveModeLine(insufficient)}\n${packed.user}`,
      role: "orient",
      unit: { kind: "bundle", id: `${bundle.streamId}:${bundle.part}` },
      lane: bundle.lane === "live" ? "live" : "understanding",
      origin: bundle.lane === "live" ? "live" : "backfill",
      validate: (parsed) => parseLiveOutput(parsed, { lane: bundle.lane, insufficientContext: insufficient }),
    },
    deps,
  );
  const live = liveResult.output;
  return {
    bundle,
    packed,
    mode: "merged",
    prompt,
    liveResult,
    ...(live ? { live } : {}),
    result: orientShaped(liveResult, live?.understanding),
    ...(live?.understanding ? { output: live.understanding } : {}),
  };
}

// ---------------------------------------------------------------------------
// The §7.3 fallback — the merged pack, two calls
// ---------------------------------------------------------------------------
//
// CALL 1 is the orient call, byte for byte: the active orient prompt over the
// pack, with nothing prepended. That matters — it is the pass the ORIENT
// golden set measures, so under the fallback the live lane's understanding is
// exactly what the gate scores, and no production filing rides on prompt text
// item 1 could not clear. The validator is the live one only so an answer that
// wraps itself in "understanding" is still usable; any decide half a
// understanding-only call volunteers is dropped (call 2 owns that section).
//
// CALL 2 is live-decide.v1 over the SAME `packed.user` plus an [UNDERSTANDING]
// block naming what call 1 just committed, so the decide half can attach to
// real space and episode ids. It runs AFTER the commit — the consumer holds
// the two halves apart — which is also why a bad decide can never cost the
// understanding anything: by the time it is asked, the writing is done.

/** The understanding half as a stand-alone call (call 1 of the fallback). */
export async function runLiveUnderstanding(
  bundle: DeltaBundle,
  deps: JsonPassDeps = {},
  packOpts: PackOptions = {},
  prompt: VersionedPrompt = activeOrientPrompt(),
): Promise<LiveRun> {
  const packed: PackedContext = await packOrientContext(bundle, packOpts);
  const zero = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
  if (packed.held) {
    const liveResult: JsonPassResult<LiveOutput> = {
      pass: prompt.pass,
      status: "failed",
      responses: [],
      runIds: [],
      usage: zero,
      error: { code: "thin_context_held", message: packed.thinReasons.join("; ") },
    };
    return { bundle, packed, mode: "two-call", prompt: null, liveResult, result: orientShaped(liveResult, undefined) };
  }
  const insufficient = packed.thin && !packed.held;
  const liveResult = await runJsonPass<LiveOutput>(
    {
      pass: prompt.pass,
      system: prompt.system,
      model: modelForVersionedPass(prompt),
      user: packed.user,
      role: "orient",
      unit: { kind: "bundle", id: `${bundle.streamId}:${bundle.part}` },
      lane: bundle.lane === "live" ? "live" : "understanding",
      origin: bundle.lane === "live" ? "live" : "backfill",
      validate: (parsed) => {
        const out = parseLiveOutput(parsed, { lane: bundle.lane, insufficientContext: insufficient });
        // An understanding-only call that produced no understanding is a
        // failure worth the runner's one repair round.
        if (!out.understanding) throw new Error(out.understandingError ?? "no understanding section");
        const { decide: _d, decideError: _e, ...rest } = out;
        return rest;
      },
    },
    deps,
  );
  const live = liveResult.output;
  return {
    bundle,
    packed,
    mode: "two-call",
    prompt: null,
    liveResult,
    ...(live ? { live } : {}),
    result: orientShaped(liveResult, live?.understanding),
    ...(live?.understanding ? { output: live.understanding } : {}),
  };
}

/**
 * Render what call 1 filed, for call 2's [UNDERSTANDING] block. Ids come from
 * the commit (real rows) when there is one; otherwise the parsed summaries,
 * which still tell the decide half what this flush was about.
 */
export function renderUnderstandingBlock(
  understanding: OrientOutput | undefined,
  commit?: Pick<CommitReport, "committedEpisodes"> | null,
): string {
  const lines: string[] = [];
  const summaries = understanding?.episodes ?? [];
  (commit?.committedEpisodes ?? []).forEach((ep, i) => {
    const summary = summaries[i]?.summary ?? "";
    lines.push(`episode ${ep.episodeId}${ep.spaceId ? ` · space ${ep.spaceId}` : " · no space"}${summary ? ` · ${summary}` : ""}`);
  });
  if (lines.length === 0) {
    for (const ep of summaries) {
      lines.push(`episode (uncommitted)${ep.space ? ` · space ${ep.space}` : ""} · ${ep.summary}`);
    }
  }
  for (const p of understanding?.proposals ?? []) lines.push(`proposed space "${p.label}" · ${p.summary}`);
  for (const u of understanding?.unsorted ?? []) lines.push(`unsorted · ${u.summary}`);
  for (const q of understanding?.questions ?? []) lines.push(`question · ${q}`);
  const body = lines.length > 0 ? lines.slice(0, 40).join("\n") : "nothing was filed from this bundle.";
  return `[UNDERSTANDING]\n${body}`;
}

/**
 * Parse call 2's answer. Never throws on a missing or broken decide section —
 * "a bad decide never blocks a commit", and by call 2 the commit has already
 * happened, so a repair round here would buy nothing. Only an answer that is
 * not a JSON object at all earns the runner's repair round.
 */
export function parseLiveDecideAnswer(
  parsed: unknown,
  opts: ParseLiveOptions,
): { decide?: LiveDecide; decideError?: string } {
  const root = rec(parsed);
  if (!root) throw new Error('expected one JSON object with a "decide" section');
  // A present-but-broken "decide" is an ERROR, not an excuse to read the root:
  // that is the LIV-04 contract, and it is what puts a `drop_decide` row in
  // the ledger. Only a MISSING key falls back to a bare decide object.
  let section: unknown;
  if (root.decide !== undefined) section = root.decide;
  else if (["tasks", "closures", "schedules", "prepared"].some((k) => Array.isArray(root[k]))) section = root;
  else return { decideError: "decide is missing" };
  const d = parseLiveDecide(section, opts.lane);
  if (!d.decide) return { ...(d.error ? { decideError: d.error } : {}) };
  if (opts.insufficientContext) {
    // Rule 4 / LIV-10: an insufficient-context flush decides nothing.
    return { decide: { ...d.decide, tasks: [], closures: [], schedules: [], prepared: [] } };
  }
  return { decide: d.decide };
}

export interface LiveDecideCallResult {
  result: JsonPassResult<{ decide?: LiveDecide; decideError?: string }>;
  /** The understanding half from call 1 with the decide half filled in. */
  live: LiveOutput;
}

/** The decide half as a stand-alone call (call 2 of the fallback). */
export async function runLiveDecide(
  run: LiveRun,
  deps: JsonPassDeps = {},
  opts: { commit?: Pick<CommitReport, "committedEpisodes"> | null; prompt?: VersionedPrompt } = {},
): Promise<LiveDecideCallResult> {
  const prompt = opts.prompt ?? activeLiveDecidePrompt();
  const bundle = run.bundle;
  const base: LiveOutput = run.live ?? {
    understandingRejected: [],
    insufficientContext: run.packed.thin && !run.packed.held,
    stripped: { episodes: 0, proposals: 0, tasks: 0, prepared: 0 },
  };
  const insufficient = base.insufficientContext;
  const user = [
    liveDecideModeLine(insufficient),
    run.packed.user,
    "",
    renderUnderstandingBlock(base.understanding, opts.commit),
  ].join("\n");
  const result = await runJsonPass<{ decide?: LiveDecide; decideError?: string }>(
    {
      pass: prompt.pass,
      system: prompt.system,
      model: modelForVersionedPass(prompt),
      user,
      role: "orient",
      unit: { kind: "bundle", id: `${bundle.streamId}:${bundle.part}` },
      lane: bundle.lane === "live" ? "live" : "understanding",
      origin: bundle.lane === "live" ? "live" : "backfill",
      validate: (parsed) => parseLiveDecideAnswer(parsed, { lane: bundle.lane, insufficientContext: insufficient }),
    },
    deps,
  );
  const answer = result.output ?? {
    decideError: result.error ? `${result.error.code}: ${result.error.message}` : "the decide call returned nothing",
  };
  const live: LiveOutput = {
    ...base,
    ...(answer.decide ? { decide: answer.decide } : {}),
    ...(answer.decideError ? { decideError: answer.decideError } : {}),
    stripped: {
      ...base.stripped,
      ...(insufficient && answer.decide
        ? { tasks: base.stripped.tasks, prepared: base.stripped.prepared }
        : {}),
    },
  };
  return { result, live };
}

// ---------------------------------------------------------------------------
// Applying the decide section
// ---------------------------------------------------------------------------

/** deferred_outputs.kind for a prepared action awaiting executor-lite (S4.2). */
export const PREPARED_ACTION_KIND = "prepared_action";

export interface PreparedActionRow {
  id: string;
  spaceId: string | null;
  taskId: string | null;
  status: string;
  createdAt: string;
  payload: PreparedActionPayload;
}

export interface PreparedActionPayload extends GroundedPrepared {
  surface: PreparedSurface;
  intentFloor: number;
  bundleKey: string;
  lane: DeltaBundle["lane"];
  runId: string | null;
  contentKey: string;
  preparedAt: string;
}

export interface LiveApplyReport {
  decide: DecideApplied;
  /** Decide items that named no resolvable space (dropped, decision-rowed). */
  unspaced: { tasks: number; closures: number; schedules: number };
  prepared: {
    persisted: number;
    cards: number;
    shelved: number;
    deduped: number;
    droppedUngrounded: number;
    droppedInvalid: number;
    discardedForLane: number;
  };
  understandingRejected: number;
  preparedIds: string[];
}

export function emptyLiveApplyReport(): LiveApplyReport {
  return {
    decide: emptyDecideApplied(),
    unspaced: { tasks: 0, closures: 0, schedules: 0 },
    prepared: { persisted: 0, cards: 0, shelved: 0, deduped: 0, droppedUngrounded: 0, droppedInvalid: 0, discardedForLane: 0 },
    understandingRejected: 0,
    preparedIds: [],
  };
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function liveBundleKey(bundle: DeltaBundle): string {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const e of bundle.events) {
    if (e.rowid < min) min = e.rowid;
    if (e.rowid > max) max = e.rowid;
  }
  if (!Number.isFinite(min)) min = 0;
  return `${bundle.streamId}:${min}-${max}`;
}

function spaceExists(id: string | null | undefined): string | null {
  if (!id) return null;
  const row = getDb().prepare(`SELECT id FROM spaces WHERE id = ? AND status != 'rejected'`).get(id) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The space of an open task named by id or exact title, anywhere. */
function spaceOfTask(ref: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT space_id FROM tasks
        WHERE (id = ? OR LOWER(title) = LOWER(?))
          AND status NOT IN ('done','cancelled','dismissed')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ref, ref) as { space_id: string | null } | undefined;
  return row?.space_id ?? null;
}

/** Map evidence aliases to real ids so tasks store event ids, never e<n>. */
function resolveEvidence<T extends { evidence: { event_ids: string[]; quote: string }[] }>(item: T, aliases: ReadonlyMap<string, string>): T {
  return {
    ...item,
    evidence: item.evidence.map((ev) => ({ ...ev, event_ids: resolveEventAliases(ev.event_ids, aliases) })),
  };
}

export interface ApplyLiveInput {
  bundle: DeltaBundle;
  live: LiveOutput;
  aliases: ReadonlyMap<string, string>;
  /** What the understanding half committed this tick (the fallback space). */
  commit?: Pick<CommitReport, "committedEpisodes"> | null;
  runId?: string | null;
  now?: Date;
  /** The intent floor; default Settings › Assist (0.7). */
  intentFloor?: number;
}

/**
 * Apply a parsed live output's decide half. Tasks / closures / schedules go
 * through the per-space appliers; prepared actions are grounded, floored and
 * persisted for executor-lite. Every drop is a decisions row. Idempotent per
 * bundle: a prepared action re-seen for the same bundle key + intent + action
 * (a re-collected bundle after a quarantine) does not mint a second row.
 */
export function applyLiveDecide(input: ApplyLiveInput): LiveApplyReport {
  const report = emptyLiveApplyReport();
  const { bundle, live, aliases } = input;
  const runId = input.runId ?? null;
  const now = input.now ?? new Date();
  const key = liveBundleKey(bundle);
  report.understandingRejected = live.understandingRejected.length;
  for (const rej of live.understandingRejected) {
    writeDecision({
      runId,
      pass: "live",
      targetKind: "bundle",
      targetId: key,
      action: "quarantine_item",
      new: { kind: rej.kind, index: rej.index },
      reason: rej.reason,
    });
  }
  if (live.decideError) {
    writeDecision({ runId, pass: "live", targetKind: "bundle", targetId: key, action: "drop_decide", reason: live.decideError });
  }
  const decide = live.decide;
  if (!decide) return report;

  // ---- The fallback space: the one space this tick's understanding touched.
  const touched = [...new Set((input.commit?.committedEpisodes ?? []).map((e) => e.spaceId).filter((s): s is string => s !== null))];
  const fallbackSpace = touched.length === 1 ? touched[0]! : null;
  const dropUnspaced = (section: "tasks" | "closures" | "schedules", what: unknown): void => {
    report.unspaced[section] += 1;
    writeDecision({
      runId,
      pass: "live",
      targetKind: "bundle",
      targetId: key,
      action: "drop_unspaced",
      new: { section, item: what },
      reason: "decide item names no known space and the tick touched none (or several)",
    });
  };

  for (const task of decide.tasks) {
    const spaceId = spaceExists(task.space) ?? fallbackSpace;
    if (!spaceId) {
      dropUnspaced("tasks", { title: task.title });
      continue;
    }
    applyDecideItems(spaceId, { tasks: [resolveEvidence(task, aliases)] }, runId, now, report.decide);
  }
  for (const closure of decide.closures) {
    const spaceId = spaceOfTask(closure.task) ?? fallbackSpace;
    if (!spaceId) {
      dropUnspaced("closures", { task: closure.task });
      continue;
    }
    applyDecideItems(spaceId, { closures: [resolveEvidence(closure, aliases)] }, runId, now, report.decide);
  }
  for (const schedule of decide.schedules) {
    const spaceId = spaceOfTask(schedule.task) ?? fallbackSpace;
    if (!spaceId) {
      dropUnspaced("schedules", { task: schedule.task });
      continue;
    }
    applyDecideItems(spaceId, { schedules: [resolveEvidence(schedule, aliases)] }, runId, now, report.decide);
  }

  // ---- Prepared actions.
  report.prepared.droppedInvalid = decide.preparedInvalid;
  report.prepared.discardedForLane = decide.preparedDiscardedForLane;
  if (decide.preparedDiscardedForLane > 0) {
    writeDecision({
      runId,
      pass: "live",
      targetKind: "bundle",
      targetId: key,
      action: "discard_prepared_for_lane",
      new: { lane: bundle.lane, count: decide.preparedDiscardedForLane },
      reason: "prepared actions exist on the live lane only (history never nudges)",
    });
  }
  if (bundle.lane !== "live" || decide.prepared.length === 0) return report;

  const { grounded, ungrounded } = groundPrepared(decide.prepared, aliases);
  report.prepared.droppedUngrounded = ungrounded.length;
  for (const p of ungrounded) {
    writeDecision({
      runId,
      pass: "live",
      targetKind: "bundle",
      targetId: key,
      action: "drop_ungrounded_prepared",
      new: { kind: p.kind, intent: p.intent, action: p.action, grounded_in: p.grounded_in },
      reason: "grounded_in names no event of this bundle — old context alone never grounds an action",
    });
  }
  const thresholds = input.intentFloor === undefined
    ? nudgeThresholds()
    : { intentFloor: input.intentFloor, blockedKinds: nudgeThresholds().blockedKinds };
  const floor = thresholds.intentFloor;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'deferred', 'live', ?)`,
  );
  const dupe = db.prepare(
    `SELECT id FROM deferred_outputs
      WHERE kind = ? AND status != 'dismissed' AND json_extract(payload_json, '$.contentKey') = ?
      LIMIT 1`,
  );
  for (const p of grounded) {
    const contentKey = createHash("sha256")
      .update([key, p.kind, p.action, p.intent.trim().toLowerCase(), ...[...p.groundedEventIds].sort()].join("␟"))
      .digest("hex")
      .slice(0, 32);
    if (dupe.get(PREPARED_ACTION_KIND, contentKey)) {
      report.prepared.deduped += 1;
      continue;
    }
    const verdict = nudgeVerdict({ kind: p.kind, intentConfidence: p.intent_confidence }, thresholds);
    const surface = verdict.surface;
    const spaceId = spaceExists(p.space) ?? fallbackSpace;
    const taskRef = typeof p.inputs.task === "string" ? p.inputs.task : null;
    const taskId = taskRef
      ? ((db.prepare(`SELECT id FROM tasks WHERE id = ? OR LOWER(title) = LOWER(?) LIMIT 1`).get(taskRef, taskRef) as { id: string } | undefined)?.id ?? null)
      : null;
    const payload: PreparedActionPayload = {
      ...p,
      space: spaceId,
      surface,
      intentFloor: floor,
      bundleKey: key,
      lane: bundle.lane,
      runId,
      contentKey,
      preparedAt: now.toISOString(),
    };
    const id = mintId("prep");
    insert.run(id, spaceId, taskId, PREPARED_ACTION_KIND, JSON.stringify(payload), now.toISOString());
    writeDecision({
      runId,
      pass: "live",
      targetKind: "prepared_action",
      targetId: id,
      action: surface === "card" ? "prepare" : "prepare_shelved",
      new: { kind: p.kind, action: p.action, intent: p.intent, urgency: p.urgency, deadline_at: p.deadline_at, space: spaceId, grounded: p.groundedEventIds },
      reason: surface === "card" ? p.reasoning : verdict.reason,
      confidence: p.intent_confidence,
    });
    report.prepared.persisted += 1;
    if (surface === "card") report.prepared.cards += 1;
    else report.prepared.shelved += 1;
    report.preparedIds.push(id);
  }
  return report;
}

/** Prepared actions awaiting executor-lite, newest first. */
export function listPreparedActions(opts: { status?: string; limit?: number } = {}): PreparedActionRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const rows = getDb()
    .prepare(
      `SELECT id, space_id, task_id, status, created_at, payload_json FROM deferred_outputs
        WHERE kind = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(PREPARED_ACTION_KIND, opts.status ?? "deferred", limit) as {
    id: string;
    space_id: string | null;
    task_id: string | null;
    status: string;
    created_at: string;
    payload_json: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    taskId: r.task_id,
    status: r.status,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload_json) as PreparedActionPayload,
  }));
}
