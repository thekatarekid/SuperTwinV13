// ===========================================================================
// [CODE] The first-paint critical path — arch §9.5 in full; build item 1.8.
//
// §9.5's whole argument is that SERIAL DEPTH, not call count, is the
// constraint: the calls form a dependency chain and parallelism cannot flatten
// it. So the chain is cut to ONE.
//
//   ON THE PATH          P-CL1 only
//   DEFERRED, always     P-EP1 · P-TR1 · P-SP1 · media enrichment
//   NEVER ON THE PATH    P-AG1 · P-AG2 · P-AG3   (rule, not cold-DB luck)
//
// The three adjudicators are BARRED BY RULE. §9.5.1 rule 4 is explicit about
// why: on a cold database they mostly would not fire anyway — no prior
// entities, arcs or claims to compare against — "but that is luck, and the
// guarantee must not rest on it." So `admit()` refuses them with a reason, and
// the refusal is a counted violation feeding gate
// `latency_adjudicator_before_paint`.
//
// LINE STREAMING IS THE LARGEST WIN AND IT IS STRUCTURAL. §9.5.2: every `\n` in
// STW-2 is a complete, independently parseable record, so claims render AS THEY
// STREAM rather than after the call returns. JSON cannot do this — you need the
// closing brace. `LineStream` therefore emits on every newline it sees and
// records the instant of the first one; a surface that waited for call
// completion would throw the format's only latency advantage away.
//
// LATENCY IS DRIVEN BY ACTUAL OUTPUT TOKENS, NOT THE MAX-OUTPUT CAP (§9.5).
// A 6,000-token budget on P-CL1 does not mean 6,000 tokens are generated.
// Confusing the two is how a latency target quietly becomes unreachable, so the
// budget model below runs on the ACTUAL column of §9.5's table.
//
// Everything here is measured, not asserted from memory (§9.5.3 rule 4): TTFT
// and tokens/sec are recorded per model per call type so a regression surfaces
// at the call that caused it rather than as a mysterious end-to-end failure.
// ===========================================================================

import { resolveClaudeBin } from "../providers/claude-local/cli.js";

/** Every prompt the scheduler can be asked to dispatch during first paint. */
export const PAINT_CALLS = [
  "P-CL1",
  "P-EP1",
  "P-TR1",
  "P-SP1",
  "P-AG1",
  "P-AG2",
  "P-AG3",
  "enrich",
] as const;
export type PaintCall = (typeof PAINT_CALLS)[number];

/** §9.5.1 — the one call on the path. */
export const ON_PATH: readonly PaintCall[] = ["P-CL1"];
/** §9.5.1 — deferred, always. Not skipped: deferred. They run at t=35+. */
export const DEFERRED: readonly PaintCall[] = ["P-EP1", "P-TR1", "P-SP1", "enrich"];
/** §9.5.1 rule 4 — barred by rule, never by luck. */
export const BARRED: readonly PaintCall[] = ["P-AG1", "P-AG2", "P-AG3"];

/** Why each deferred call is safe to defer — §9.5.1 rules 1–3, in one line each. */
export const DEFER_REASON: Record<string, string> = {
  "P-EP1":
    "structural binding already resolves participants; an absent mention becomes '-' plus a hint and resolves on the next delta pass",
  "P-TR1": "triage is code-derivable for first paint; the safe default is never 'auto'",
  "P-SP1": "archetype is cosmetic; a space renders with a neutral default and refines within the minute",
  enrich: "text is understood now and enrichment updates the same chunk later (§9.6) — there is no barrier",
};

export type Admission = "on_path" | "deferred" | "barred";

export interface AdmissionResult {
  call: PaintCall;
  admission: Admission;
  reason: string;
}

/**
 * What may run before the user has something on screen.
 *
 * Once first paint is complete every call is admitted — the deferred ones are
 * deferred, not dropped (§9.5.1: "DEFERRED, always" names the path, not the
 * pipeline). The adjudicators stay barred only for the duration of the path.
 */
export function admit(call: PaintCall, firstPaintComplete = false): AdmissionResult {
  if (firstPaintComplete) return { call, admission: "on_path", reason: "first paint complete — normal scheduling" };
  if (ON_PATH.includes(call)) return { call, admission: "on_path", reason: "the one call on the critical path" };
  if (BARRED.includes(call)) {
    return {
      call,
      admission: "barred",
      reason: "adjudicators are barred from the first-paint path by rule, not by cold-DB luck (§9.5.1 rule 4)",
    };
  }
  return { call, admission: "deferred", reason: DEFER_REASON[call] ?? "deferred to after first paint" };
}

/**
 * The path a set of requested calls actually takes.
 *
 * `onPath.length` is gate `latency_first_paint_calls` (fails above 1) and
 * `barred.length` is gate `latency_adjudicator_before_paint` (fails above 0).
 * Both are counts of what the scheduler DID, not declarations of what it
 * intended.
 */
export function planFirstPaint(requested: readonly PaintCall[]): {
  onPath: AdmissionResult[];
  deferred: AdmissionResult[];
  barred: AdmissionResult[];
  executed: PaintCall[];
} {
  const results = requested.map((call) => admit(call, false));
  const onPath = results.filter((r) => r.admission === "on_path");
  return {
    onPath,
    deferred: results.filter((r) => r.admission === "deferred"),
    barred: results.filter((r) => r.admission === "barred"),
    // Only what is on the path is executed before paint. This is the list the
    // adjudicator gate reads, and it must never contain a P-AG.
    executed: onPath.map((r) => r.call),
  };
}

// ---------------------------------------------------------------------------
// Line streaming (§9.5.2)
// ---------------------------------------------------------------------------

export interface StreamedLine {
  index: number;
  text: string;
  /** Milliseconds since the call was dispatched. */
  atMs: number;
  /** True when the line was only emitted because the call ended. */
  afterCallComplete: boolean;
}

/**
 * Parse each `\n` as it arrives and emit immediately. Do not wait for call
 * completion.
 *
 * The `afterCallComplete` flag exists so the eval can tell the two behaviours
 * apart: a buffering implementation produces the same LINES, just all of them
 * flagged, and a test that only counted lines would pass on a JSON-shaped
 * pipeline that lost the entire latency win.
 */
export class LineStream {
  private buffer = "";
  private index = 0;
  private firstAt: number | null = null;
  private readonly lines: StreamedLine[] = [];
  private closed = false;

  constructor(private readonly emit: (line: StreamedLine) => void = () => {}) {}

  /** Feed a chunk that arrived at `atMs` after dispatch. */
  push(chunk: string, atMs: number): StreamedLine[] {
    if (this.closed) throw new Error("LineStream.push after end()");
    this.buffer += chunk;
    const out: StreamedLine[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const text = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (text.trim().length > 0) out.push(this.record(text, atMs, false));
      nl = this.buffer.indexOf("\n");
    }
    return out;
  }

  /**
   * Close the stream. A trailing fragment with no newline is emitted here and
   * flagged — it is the one record that genuinely could not be seen earlier,
   * and flagging it keeps the gate honest instead of hiding it.
   */
  end(atMs: number): StreamedLine[] {
    if (this.closed) return [];
    this.closed = true;
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim().length === 0) return [];
    return [this.record(rest, atMs, true)];
  }

  private record(text: string, atMs: number, afterCallComplete: boolean): StreamedLine {
    const line: StreamedLine = { index: this.index++, text, atMs, afterCallComplete };
    if (this.firstAt === null) this.firstAt = atMs;
    this.lines.push(line);
    this.emit(line);
    return line;
  }

  /** Milliseconds from dispatch to the FIRST rendered line — the §9.5.2 win. */
  get firstLineMs(): number | null {
    return this.firstAt;
  }

  get all(): StreamedLine[] {
    return [...this.lines];
  }

  /** Lines that only appeared because the call ended. Must be empty in STW-2. */
  get buffered(): StreamedLine[] {
    return this.lines.filter((l) => l.afterCallComplete);
  }
}

// ---------------------------------------------------------------------------
// Pre-warm (§9.5.3 rule 3)
// ---------------------------------------------------------------------------

export interface PrewarmRecord {
  /** When the child was spawned, relative to connect. */
  spawnedAtMs: number;
  /** When it became usable. */
  readyAtMs: number;
  /** When the first-paint clock started. */
  clockStartedAtMs: number;
  /** Spawn cost paid BEFORE the clock started, which is the whole point. */
  paidBeforeClock: boolean;
  /** Seconds of cold-spawn cost the path avoided. */
  savedSeconds: number;
}

/** A cold `claude` child costs 1–2 s to resolve and start (§9.5.3 rule 3). */
export const COLD_SPAWN_SECONDS = 1.5;

/**
 * Pay binary resolution at connect, before the first-paint clock starts.
 *
 * `resolveClaudeBin` walks five well-known install locations with `existsSync`
 * and caches the answer for the process lifetime, so calling it here means the
 * first dispatch finds it already resolved. This is the half of §9.5.3 rule 3
 * the current adapter can pre-pay: it spawns a child per invocation, so there
 * is no persistent process to hold warm yet. When the provider grows a
 * long-lived child, its spawn belongs on this call too — the record below
 * already accounts for it.
 */
export function prewarmCli(now: () => number = Date.now): { bin: string; resolvedInMs: number } {
  const started = now();
  const bin = resolveClaudeBin();
  return { bin, resolvedInMs: now() - started };
}

/**
 * Record that one CLI child was spawned at connect time.
 *
 * "Five cold spawns at 1–2 s each is real money against a 120 s budget." The
 * record exists so the eval can assert the spawn happened BEFORE the clock,
 * rather than assert that some code path calls spawn at some point.
 */
export function prewarm(spawnedAtMs: number, readyAtMs: number, clockStartedAtMs: number): PrewarmRecord {
  return {
    spawnedAtMs,
    readyAtMs,
    clockStartedAtMs,
    paidBeforeClock: readyAtMs <= clockStartedAtMs,
    savedSeconds: readyAtMs <= clockStartedAtMs ? COLD_SPAWN_SECONDS : 0,
  };
}

// ---------------------------------------------------------------------------
// TTFT instrumentation (§9.5.3 rule 4)
// ---------------------------------------------------------------------------

export interface CallTiming {
  model: string;
  callType: string;
  /** Time to first token, ms. */
  ttftMs: number;
  outputTokens: number;
  totalMs: number;
}

export interface TimingSummary extends CallTiming {
  tokensPerSecond: number;
}

/**
 * Per model per call type, so "a regression should surface at the call that
 * caused it, not as a mysterious end-to-end failure". The key is the pair; a
 * per-model-only average would hide a P-CL1 regression behind a fast P-TR1.
 */
export class TimingLog {
  private readonly entries: CallTiming[] = [];

  record(timing: CallTiming): void {
    this.entries.push(timing);
  }

  get count(): number {
    return this.entries.length;
  }

  /** Every recorded call, with tokens/sec derived rather than reported. */
  all(): TimingSummary[] {
    return this.entries.map((e) => ({
      ...e,
      tokensPerSecond: e.totalMs > 0 ? Math.round((e.outputTokens / e.totalMs) * 1000 * 10) / 10 : 0,
    }));
  }

  /** `model|callType` -> the worst TTFT seen. Worst, never mean: one breach is a breach. */
  worstTtft(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) {
      const key = `${e.model}|${e.callType}`;
      out[key] = Math.max(out[key] ?? 0, e.ttftMs);
    }
    return out;
  }

  /** True when every call recorded both halves — gate `latency_ttft_recorded`. */
  get complete(): boolean {
    return this.entries.length > 0 && this.entries.every((e) => e.ttftMs > 0 && e.totalMs > 0);
  }
}

// ---------------------------------------------------------------------------
// The budget (§9.5.4)
// ---------------------------------------------------------------------------

export interface PaintPhase {
  name: string;
  /** Seconds from connect at which the phase starts and ends. */
  startS: number;
  endS: number;
  executor: "[CODE]" | "[LLM-M]" | "[LLM-S]";
}

export interface PaintBudgetInput {
  /** Seconds for the adapter's first page, ingest and structural binding. */
  ingestSeconds?: number;
  /** Seconds to seal cohort 0. Immediate, no debounce. */
  sealSeconds?: number;
  /** Seconds from dispatch to the first streamed line (TTFT). */
  ttftSeconds?: number;
  /** Expected output tokens for cohort 0's P-CL1 (§9.5.3 rule 2: ~600). */
  outputTokens?: number;
  /** Measured, never assumed (§9.5.3 rule 4). */
  tokensPerSecond?: number;
  /** Seconds of code work after extraction: facts, write path, promotion. */
  writePathSeconds?: number;
  /** True when a child was already warm at connect (§9.5.3 rule 3). */
  prewarmed?: boolean;
}

export interface PaintBudget {
  phases: PaintPhase[];
  /** ★ FIRST CLAIM RENDERS — seconds from connect. Gate: <= 30 s. */
  firstClaimSeconds: number;
  /** ★ SPACES AND TASKS VISIBLE — seconds from connect. Gate: <= 120 s. */
  firstTripleSeconds: number;
  /** Calls on the path. Gate: <= 1. */
  callsOnPath: number;
  /** Seconds the extraction call spends streaming its remaining lines. */
  streamSeconds: number;
}

/**
 * §9.5.4's timeline, computed rather than transcribed.
 *
 * The figures default to §9.5.4's own budget, but every one of them is an
 * input: the point of the section is that these numbers are MEASURED and gated
 * per call, so a model that has become slower must move this function's output
 * rather than be papered over by a constant.
 */
export function paintBudget(input: PaintBudgetInput = {}): PaintBudget {
  const ingest = input.ingestSeconds ?? 10;
  const seal = input.sealSeconds ?? 4;
  const spawn = input.prewarmed ?? true ? 0 : COLD_SPAWN_SECONDS;
  // §9.5.4: t=14–16 dispatch. Dispatch is the ~2 s of prompt assembly and hand-
  // off; a cold child adds its spawn on top, which is what pre-warming buys.
  const dispatch = 2 + spawn;
  const ttft = input.ttftSeconds ?? 2;
  const output = input.outputTokens ?? 600;
  const rate = input.tokensPerSecond ?? 50;
  const stream = rate > 0 ? output / rate : 0;
  const writePath = input.writePathSeconds ?? 4;

  const sealEnd = ingest + seal;
  const dispatchEnd = sealEnd + dispatch;
  const firstClaim = dispatchEnd + ttft;
  const streamEnd = firstClaim + stream;
  const tripleEnd = streamEnd + writePath;

  return {
    phases: [
      { name: "ingest + structural binding", startS: 0, endS: ingest, executor: "[CODE]" },
      { name: "cohort 0 sealed (immediate, no debounce)", startS: ingest, endS: sealEnd, executor: "[CODE]" },
      { name: "P-CL1 dispatched to a pre-warmed child", startS: sealEnd, endS: dispatchEnd, executor: "[LLM-M]" },
      { name: "first claim renders (streamed, line by line)", startS: dispatchEnd, endS: firstClaim, executor: "[LLM-M]" },
      { name: "remaining claims and loops stream in", startS: firstClaim, endS: streamEnd, executor: "[LLM-M]" },
      { name: "code facts · write path · promotion routes", startS: streamEnd, endS: tripleEnd, executor: "[CODE]" },
    ],
    firstClaimSeconds: round1(firstClaim),
    firstTripleSeconds: round1(tripleEnd),
    callsOnPath: ON_PATH.length,
    streamSeconds: round1(stream),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
