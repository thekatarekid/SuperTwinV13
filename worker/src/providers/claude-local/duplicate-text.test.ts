// ===========================================================================
// REGRESSION: the terminal `assistant` line must never be re-emitted as text
// when the same text already streamed as deltas — INCLUDING when both arrive
// in ONE stdout chunk.
//
// The adapter suppressed the duplicate by testing `parsed.emittedDelta`, a
// CHUNK-WIDE flag. `parser.push()` decodes every NDJSON line in the chunk into
// one ParseOutput, so a chunk carrying trailing `content_block_delta` lines
// AND the terminal `assistant` line set that flag — and the duplicate sailed
// through. `--include-partial-messages` is passed on every call, so this was
// live on every consumer, not just media.
//
// Downstream cost (media batch run id 4): the doubled block glued onto the
// previous text, destroying the duplicate's leading `@@ID:` marker and leaving
// a stray one behind. The reader saw 3 ids where 2 were sent, rejected a
// correct answer, and paid to split and retry it.
//
// Two levels are covered: the parser's per-event provenance (deterministic),
// and the adapter end-to-end against a fake CLI that deliberately emits the
// poisoned single chunk.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamJsonParser } from "./parser.js";
import type { ProviderStreamEvent } from "../types.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MSG = "msg_01Doubled";

/** Fixture lines in the real wire format (claude 2.1.197). */
const init = `{"type":"system","subtype":"init","cwd":"/x","session_id":"${SID}"}`;
const delta = (text: string): string =>
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}},"session_id":"${SID}"}`;
const assistant = (text: string): string =>
  `{"type":"assistant","message":{"id":"${MSG}","content":[{"type":"text","text":${JSON.stringify(text)}}],"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":8000,"output_tokens":10}},"session_id":"${SID}"}`;
const result = `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"${SID}","total_cost_usd":0.05,"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":8000,"output_tokens":10}}`;

// The answer's shape in the media path: an `@@ID:` marker opens each block.
// Doubling glues the copy onto the tail of the original, eating its marker.
const ANSWER = "@@ID:1 a lake at dusk\n@@ID:2 a red bicycle";

function deltaText(events: ProviderStreamEvent[]): string {
  return events
    .filter(
      (e): e is Extract<ProviderStreamEvent, { type: "delta" }> =>
        e.type === "delta",
    )
    .map((e) => e.text)
    .join("");
}

/** Replay a chunk stream through the adapter's own suppression rule. */
function replay(chunks: string[]): string {
  const parser = new StreamJsonParser();
  const emitted: ProviderStreamEvent[] = [];
  let emittedAnyDelta = false;
  for (const chunk of chunks) {
    const parsed = parser.push(chunk);
    if (parsed.emittedDelta) emittedAnyDelta = true;
    for (const ev of parsed.events) {
      if (
        ev.type === "delta" &&
        emittedAnyDelta &&
        parsed.fromAssistantLine?.has(ev)
      ) {
        continue;
      }
      emitted.push(ev);
    }
  }
  return deltaText(emitted);
}

describe("assistant-line duplicate suppression (parser provenance)", () => {
  it("flags ONLY the events decoded from an `assistant` line", () => {
    const p = new StreamJsonParser();
    const out = p.push(
      [init, delta("Hello"), delta(" world"), assistant("Hello world"), ""].join(
        "\n",
      ),
    );
    const deltas = out.events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(3);
    // The two streamed deltas are NOT from the assistant line; the third is.
    expect(out.fromAssistantLine?.has(deltas[0])).toBeFalsy();
    expect(out.fromAssistantLine?.has(deltas[1])).toBeFalsy();
    expect(out.fromAssistantLine?.has(deltas[2])).toBe(true);
  });

  it("never re-emits the same assistant text twice, even across chunks", () => {
    const p = new StreamJsonParser();
    // The CLI repeats one message id per content block; a repeat of the SAME
    // text block must not append the text a second time.
    const a = p.push(assistant("Hello world") + "\n");
    const b = p.push(assistant("Hello world") + "\n");
    expect(deltaText(a.events)).toBe("Hello world");
    expect(deltaText(b.events)).toBe("");
  });

  it("still emits two genuinely different text blocks of one message", () => {
    const p = new StreamJsonParser();
    const out = p.push(assistant("first") + "\n" + assistant("second") + "\n");
    expect(deltaText(out.events)).toBe("firstsecond");
  });
});

describe("adapter suppression rule over chunk boundaries", () => {
  it("emits the text once when deltas and `assistant` share ONE chunk", () => {
    // THE FAILING SHAPE: the last delta and the terminal assistant line are
    // glued together, so the chunk-wide `emittedDelta` flag was true.
    const chunks = [
      init + "\n" + delta("@@ID:1 a lake at dusk\n") + "\n",
      delta("@@ID:2 a red bicycle") + "\n" + assistant(ANSWER) + "\n" + result + "\n",
    ];
    expect(replay(chunks)).toBe(ANSWER);
    // And specifically: exactly the two markers that were sent.
    expect(replay(chunks).match(/@@ID:/g)).toHaveLength(2);
  });

  it("still suppresses when the assistant line arrives in its own chunk", () => {
    const chunks = [
      init + "\n" + delta("Hello") + "\n" + delta(" world") + "\n",
      assistant("Hello world") + "\n",
      result + "\n",
    ];
    expect(replay(chunks)).toBe("Hello world");
  });

  it("still emits assistant text when NO deltas streamed (partials off)", () => {
    expect(replay([init + "\n" + assistant("Hello world") + "\n" + result + "\n"])).toBe(
      "Hello world",
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real adapter, against a fake CLI that writes the
// poisoned chunk itself. Proves the wiring, not just the rule.
// ---------------------------------------------------------------------------

const stage = mkdtempSync(join(tmpdir(), "st-dup-text-"));
const fakeCli = join(stage, "fake-claude.cjs");
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  const lines = {
    init,
    d1: delta("@@ID:1 a lake at dusk\n"),
    d2: delta("@@ID:2 a red bicycle"),
    asst: assistant(ANSWER),
    result,
  };
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      `const L = ${JSON.stringify(lines)};`,
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      // Chunk 1: session + the first delta. A beat, so the reader is idle and
      // definitely does not coalesce it with chunk 2.
      "process.stdout.write(L.init + '\\n' + L.d1 + '\\n');",
      // Chunk 2 (THE POISON): a trailing delta glued to the terminal assistant
      // line, written in ONE call so it lands as one stdout chunk.
      "setTimeout(() => {",
      "  process.stdout.write(L.d2 + '\\n' + L.asst + '\\n' + L.result + '\\n');",
      "  setTimeout(() => process.exit(0), 20);",
      "}, 60);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);
  // resolveClaudeBin() caches on first use, so this must be set before the
  // provider ever spawns — which, in this file, it is.
  savedEnv.set("CLAUDE_BIN", process.env.CLAUDE_BIN);
  process.env.CLAUDE_BIN = fakeCli;
});

afterAll(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("claude-local adapter (fake CLI, one poisoned chunk)", () => {
  it("streams the assistant text exactly once", async () => {
    const { claudeLocalProvider } = await import("./index.js");
    const events: ProviderStreamEvent[] = [];
    const res = await claudeLocalProvider.send({
      runId: "dup-text-regression",
      message: "describe these",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("ok");
    const text = deltaText(events);
    expect(text).toBe(ANSWER);
    // The symptom that cost a media retry: a third `@@ID:` the model never sent.
    expect(text.match(/@@ID:/g)).toHaveLength(2);
  }, 20_000);
});
