// ===========================================================================
// Claude CLI stream-json NDJSON parser.
//
// Turns the raw `claude --print --output-format stream-json --verbose` byte
// stream into normalized ProviderStreamEvents. Kept separate from the adapter
// so it is trivially unit-testable with fixture lines (including partial-chunk
// splitting across `push()` calls).
//
// ---------------------------------------------------------------------------
// OBSERVED WIRE SHAPES (claude 2.1.197, verified via real runs — see the
// STEP-0 investigation). NDJSON: one JSON object per line. Types seen:
//
//   {"type":"system","subtype":"init", ..., "session_id":"<uuid>"}
//        -> canonical session_id source. (session_id ALSO appears on every
//           other line, including the earlier "hook_started" line, so we grab
//           it from the first line that carries one.)
//
//   {"type":"stream_event","event":{"type":"content_block_delta","index":0,
//        "delta":{"type":"text_delta","text":"1"}}, "session_id":...}
//        -> token delta. ONLY present when the CLI is invoked with
//           --include-partial-messages (the adapter enables it by default).
//        -> content_block_start with event.content_block.type==="tool_use"
//           carries a tool_use block; content_block_stop / message_* are noise.
//
//   {"type":"assistant","message":{"id":"msg_…","content":[{"type":"text",
//        "text":"Hey"}],"usage":{...}}, "session_id":...}
//        -> full assistant message. This is the ONLY text source when
//           --include-partial-messages is NOT set. When partials ARE on, this
//           duplicates text already streamed via deltas, so the adapter tracks
//           whether any delta was emitted and, if so, does NOT re-emit the
//           assistant block as a delta (avoids double text). With partials on
//           the SAME message id is also repeated once per content block, each
//           carrying an identical usage snapshot.
//
//   {"type":"stream_event","event":{"type":"message_start","message":{"usage":
//        {"input_tokens":10,"cache_creation_input_tokens":10472,
//         "cache_read_input_tokens":18764,"output_tokens":4}}}}
//   {"type":"stream_event","event":{"type":"message_delta","usage":{...,
//         "output_tokens":149,"iterations":[...]}}}
//   {"type":"stream_event","event":{"type":"message_stop"}}
//        -> per-turn accounting. message_start already carries the real (and
//           dominant) input/cache counts with a placeholder output_tokens;
//           message_delta restates the turn with its final output_tokens;
//           message_stop closes it.
//
//   {"type":"result","subtype":"success","is_error":false,"session_id":...,
//        "total_cost_usd":0.097,"num_turns":1,"stop_reason":"end_turn",
//        "usage":{"input_tokens":11098,"output_tokens":10, ...}}
//        -> terminal. usage + cost live here. This is what "done" is built from.
//        -> MEASURED on a 2-turn run: this usage is the run TOTAL, not the last
//           turn — all four token fields equal the sum over turns exactly
//           (18/10651/48000/206 vs 10+8 / 10472+179 / 18764+29236 / 149+57).
//           Its `iterations` array holds only the FINAL turn, so it is not a
//           per-turn breakdown. Adding turns to this would double-count.
//
//   POISON signature (resume of a nonexistent/expired session):
//        stderr: "No conversation found with session ID: <id>"
//        {"type":"result","subtype":"error_during_execution","is_error":true,
//         "num_turns":0,"errors":["No conversation found ..."], ...}
//        -> NOTE: process still exits 0. Poison MUST be detected from the
//           result object (is_error && num_turns===0), not the exit code.
//
//   Noise types safely ignored: rate_limit_event, system/hook_started,
//   system/hook_response, system/post_turn_summary, system/status,
//   stream_event/(content_block_stop|message_start|message_delta|message_stop).
// ---------------------------------------------------------------------------

import type { ProviderStreamEvent, Usage } from "../types.js";
import { emptyUsage, sumUsage } from "../usage.js";

/** Extra terminal detail the adapter needs but that isn't a stream event. */
export interface ParsedResult {
  sessionId: string | null;
  usage: Usage;
  isError: boolean;
  numTurns: number;
  stopReason?: string;
  /** Present on error results, e.g. ["No conversation found ..."]. */
  errors?: string[];
  subtype?: string;
}

/**
 * What a single parsed NDJSON line yields. `events` are forwarded to the
 * caller's onEvent; `sessionId` is set the first time we see one; `result`
 * is set on the terminal result line.
 */
export interface ParseOutput {
  events: ProviderStreamEvent[];
  sessionId?: string;
  result?: ParsedResult;
  /** True if this CHUNK produced a streamed text delta. Chunk-wide by nature —
   * `push()` decodes every line in the chunk into one ParseOutput — so it says
   * nothing about an individual event. Use `fromAssistantLine` for that. */
  emittedDelta?: boolean;
  /**
   * The events in `events` that were decoded from a full `assistant` line,
   * identified by object identity. With partials ON these duplicate text the
   * caller already streamed, so the adapter drops exactly these rather than
   * judging the whole chunk: a chunk carrying trailing content_block_deltas
   * AND the terminal assistant line sets `emittedDelta`, and testing that flag
   * let the duplicate through — the doubled block then swallowed the marker
   * that opened it. Absent when the chunk held no assistant line.
   */
  fromAssistantLine?: Set<ProviderStreamEvent>;
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Normalize a CLI `usage` object (result, message_start/delta, or assistant
 * message) into Usage. `cost` is taken separately because `total_cost_usd`
 * sits on the result line itself, not inside its usage object.
 */
export function extractUsage(usage: unknown, cost?: unknown): Usage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const out: Usage = {
    inputTokens: toNum(u.input_tokens),
    cacheCreationInputTokens: toNum(u.cache_creation_input_tokens),
    cacheReadInputTokens: toNum(u.cache_read_input_tokens),
    outputTokens: toNum(u.output_tokens),
  };
  // `cache_creation` splits the write half by TTL, and the two TTLs bill at
  // different multiples (1.25x vs 2.0x), so the split is the difference between
  // a correct billable figure and a 31% under-count. It rides on message_start
  // and message_delta but NOT on the terminal `result` line, whose usage is the
  // run total — see StreamJsonParser.carryTurnSplit, which carries it across.
  // Left absent when the line has no breakdown: 0/0 would claim the wire said
  // the writes were neither.
  const split = u.cache_creation;
  if (split !== null && typeof split === "object") {
    const c = split as Record<string, unknown>;
    out.cacheCreation5mInputTokens = toNum(c.ephemeral_5m_input_tokens);
    out.cacheCreation1hInputTokens = toNum(c.ephemeral_1h_input_tokens);
  }
  if (typeof cost === "number" && Number.isFinite(cost)) out.costUsd = cost;
  return out;
}

/**
 * Stateful, chunk-tolerant NDJSON parser. Feed raw stdout chunks (any
 * boundaries) via `push`; it buffers partial lines and returns the events
 * decoded so far. Call `flush()` once the stream closes to drain a trailing
 * partial line (CLI always newline-terminates, but be safe).
 */
export class StreamJsonParser {
  private buffer = "";
  private sawSession = false;
  private completedTurns: Usage = emptyUsage();
  private currentTurn: Usage | null = null;
  /** Set once a message_start is seen: per-turn usage comes from the stream. */
  private sawTurnStream = false;
  /** Assistant-line ids already billed (partials-off fallback path only). */
  private readonly billedMessages = new Set<string>();
  /**
   * `<message id> <text>` for every assistant-line text block already
   * emitted. The CLI repeats one message id once per content block, so a
   * re-stated text block is a duplicate of text the caller already has —
   * appending it twice is what corrupts a marker-delimited answer. Keyed on
   * the text as well as the id so a message with two GENUINELY different text
   * blocks still streams both.
   */
  private readonly emittedTextBlocks = new Set<string>();

  /**
   * Everything accounted for so far, INCLUDING a turn still in flight. The
   * adapter reads this when a run is killed before the result line, so a
   * timeout or cancel records what was really spent instead of 0.
   */
  usageSoFar(): Usage {
    return this.currentTurn
      ? sumUsage(this.completedTurns, this.currentTurn)
      : this.completedTurns;
  }

  /** Feed a raw chunk. Returns everything decodable from complete lines. */
  push(chunk: string): ParseOutput {
    this.buffer += chunk;
    const out: ParseOutput = { events: [] };

    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line, out);
    }
    return out;
  }

  /** Drain any buffered trailing line (no newline) at stream end. */
  flush(): ParseOutput {
    const out: ParseOutput = { events: [] };
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.handleLine(rest, out);
    return out;
  }

  private handleLine(rawLine: string, out: ParseOutput): void {
    const line = rawLine.trim();
    if (!line) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Tolerate a non-JSON line (shouldn't happen for stdout, but never throw).
      return;
    }

    // session_id rides on essentially every line; capture the first one.
    const sid = obj.session_id;
    if (!this.sawSession && typeof sid === "string" && sid.length > 0) {
      this.sawSession = true;
      out.sessionId = sid;
      out.events.push({ type: "session", sessionId: sid });
    }

    const type = obj.type;

    // --- token deltas + tool_use (only present with --include-partial-messages)
    if (type === "stream_event") {
      const ev = (obj.event ?? {}) as Record<string, unknown>;
      const evType = ev.type;

      if (evType === "content_block_delta") {
        const delta = (ev.delta ?? {}) as Record<string, unknown>;
        const text = delta.text;
        if (typeof text === "string" && text.length > 0) {
          out.events.push({ type: "delta", text });
          out.emittedDelta = true;
        }
      } else if (evType === "content_block_start") {
        const block = (ev.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use") {
          out.events.push({
            type: "tool_use",
            name: typeof block.name === "string" ? block.name : "unknown",
            input: block.input ?? {},
          });
        }
      } else if (evType === "message_start") {
        const msg = (ev.message ?? {}) as Record<string, unknown>;
        this.sawTurnStream = true;
        this.currentTurn = extractUsage(msg.usage);
      } else if (evType === "message_delta") {
        // Same turn restated with its real output_tokens; replace, never add.
        // The restatement drops the `cache_creation` breakdown that
        // message_start carried, so it is inherited back — otherwise the split
        // would vanish on every turn that actually streamed.
        if (ev.usage) {
          this.currentTurn = inheritCacheSplit(
            extractUsage(ev.usage),
            this.currentTurn,
          );
        }
      } else if (evType === "message_stop") {
        this.commitTurn();
      }
      // content_block_stop: noise.
      return;
    }

    // --- full assistant message (the text source when partials are OFF; a
    //     duplicate when partials are ON — adapter decides whether to emit).
    if (type === "assistant") {
      const message = (obj.message ?? {}) as Record<string, unknown>;
      // Only the accounting source when partials are OFF. With partials ON the
      // stream_event turns already carry it and this same message is repeated
      // per content block, so billing here would multiply the turn by its
      // block count.
      if (!this.sawTurnStream) {
        const id = typeof message.id === "string" ? message.id : null;
        if (id === null || !this.billedMessages.has(id)) {
          if (id !== null) this.billedMessages.add(id);
          this.completedTurns = sumUsage(
            this.completedTurns,
            extractUsage(message.usage),
          );
        }
      }
      const msgId = typeof message.id === "string" ? message.id : "";
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        const b = (block ?? {}) as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.length) {
          // Second guard against doubled text, independent of the adapter's
          // suppression: the same block of the same message is emitted once.
          const key = `${msgId} ${b.text}`;
          if (this.emittedTextBlocks.has(key)) continue;
          this.emittedTextBlocks.add(key);
          this.markFromAssistant(out, { type: "delta", text: b.text });
        } else if (b.type === "tool_use") {
          this.markFromAssistant(out, {
            type: "tool_use",
            name: typeof b.name === "string" ? b.name : "unknown",
            input: b.input ?? {},
          });
        }
      }
      return;
    }

    // --- terminal result: carries usage, cost, error flags.
    if (type === "result") {
      // Already the run total (see the wire-shape note above), so it stands in
      // for the per-turn accumulator rather than adding to it.
      const usage = this.carryTurnSplit(
        extractUsage(obj.usage, obj.total_cost_usd),
      );
      const errors = Array.isArray(obj.errors)
        ? (obj.errors.filter((e) => typeof e === "string") as string[])
        : undefined;
      out.result = {
        sessionId: typeof sid === "string" ? sid : null,
        usage,
        isError: obj.is_error === true,
        numTurns: toNum(obj.num_turns),
        stopReason:
          typeof obj.stop_reason === "string" ? obj.stop_reason : undefined,
        errors,
        subtype: typeof obj.subtype === "string" ? obj.subtype : undefined,
      };
      out.events.push({ type: "usage", usage });
      return;
    }

    // system/init, rate_limit_event, hooks, post_turn_summary, status: ignored.
  }

  /**
   * The result line states the run's TOTAL cache-write tokens but carries no
   * `cache_creation` breakdown, while every message_start does. When the turns
   * we saw add up to exactly the result's write total, they are the same
   * tokens, so their split describes the total too and is carried across.
   * When the two disagree (a turn that never streamed) the split is left
   * absent and `billableTokens` prices the remainder at the 1-hour rate.
   */
  private carryTurnSplit(u: Usage): Usage {
    return inheritCacheSplit(u, this.usageSoFar());
  }

  /**
   * Emit an event AND record that it came from a full `assistant` line, so the
   * caller can drop the duplicate text without judging the whole chunk.
   */
  private markFromAssistant(out: ParseOutput, ev: ProviderStreamEvent): void {
    out.events.push(ev);
    (out.fromAssistantLine ??= new Set<ProviderStreamEvent>()).add(ev);
  }

  private commitTurn(): void {
    if (!this.currentTurn) return;
    this.completedTurns = sumUsage(this.completedTurns, this.currentTurn);
    this.currentTurn = null;
  }
}

/**
 * Carry a `cache_creation` breakdown from `from` onto `onto`, when `onto` has
 * none of its own and the two agree on the write TOTAL they describe. Equal
 * totals mean the same tokens, so the same split describes both. Unequal ones
 * mean `from` describes something else — a turn that never streamed, say — and
 * the split is left absent rather than guessed at.
 *
 * Needed twice, because the CLI drops the breakdown at two different points:
 * message_delta restates a turn without it, and the terminal result line
 * carries the run total without it.
 */
function inheritCacheSplit(onto: Usage, from: Usage | null): Usage {
  if (
    onto.cacheCreation5mInputTokens !== undefined ||
    onto.cacheCreation1hInputTokens !== undefined
  ) {
    return onto;
  }
  if (from === null) return onto;
  const m5 = from.cacheCreation5mInputTokens;
  const m1h = from.cacheCreation1hInputTokens;
  if (m5 === undefined && m1h === undefined) return onto;
  if ((m5 ?? 0) + (m1h ?? 0) !== onto.cacheCreationInputTokens) return onto;
  return {
    ...onto,
    cacheCreation5mInputTokens: m5 ?? 0,
    cacheCreation1hInputTokens: m1h ?? 0,
  };
}

/**
 * The CLI stopped on its own turn cap — a SOFT stop, not a broken run (FIX-C2).
 *
 * OBSERVED (claude 2.1.x, `--max-turns 1`): the process exits 0 and the
 * terminal line is
 *   {"type":"result","subtype":"error_max_turns","is_error":true,
 *    "errors":["Reached maximum number of turns (1)"], ...}
 * with real turns and real spend behind it. The subtype is matched first; the
 * message is matched as a fallback because it is what actually landed in
 * `runs.error_msg` on the 13.11.5 install and older/newer CLIs word the
 * subtype differently.
 *
 * A poison result (num_turns 0, "No conversation found") is checked FIRST by
 * the adapter and is a different animal: that one re-runs fresh, this one
 * never re-issues the same call blind.
 */
export function isMaxTurnsResult(r: ParsedResult): boolean {
  if (!r.isError) return false;
  if (typeof r.subtype === "string" && r.subtype.toLowerCase().includes("max_turns")) return true;
  const joined = (r.errors ?? []).join(" ").toLowerCase();
  return joined.includes("maximum number of turns");
}

/**
 * Decide whether a `result` object represents a POISONED resume — i.e. the
 * requested session did not exist / could not be resumed. Exit code is 0 in
 * this case, so this is the authoritative check.
 */
export function isPoisonResult(r: ParsedResult): boolean {
  if (!r.isError) return false;
  if (r.numTurns > 0) return false; // a real turn happened; not a resume-miss
  const joined = (r.errors ?? []).join(" ").toLowerCase();
  if (joined.includes("no conversation found")) return true;
  if (joined.includes("session id")) return true;
  // error_during_execution with zero turns after a resume == unusable session.
  return r.subtype === "error_during_execution" || r.errors !== undefined;
}
