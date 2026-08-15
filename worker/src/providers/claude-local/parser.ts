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
  /** True if this line produced a text delta (adapter dedupes assistant text). */
  emittedDelta?: boolean;
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
        if (ev.usage) this.currentTurn = extractUsage(ev.usage);
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
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        const b = (block ?? {}) as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.length) {
          out.events.push({ type: "delta", text: b.text });
        } else if (b.type === "tool_use") {
          out.events.push({
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
      const usage = extractUsage(obj.usage, obj.total_cost_usd);
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

  private commitTurn(): void {
    if (!this.currentTurn) return;
    this.completedTurns = sumUsage(this.completedTurns, this.currentTurn);
    this.currentTurn = null;
  }
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
