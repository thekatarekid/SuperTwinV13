// ===========================================================================
// Grounded chat (Phase 2 T4, retrieval rebuilt in v6 §1) — server tests with a
// MOCK provider.
//
// Covers:
//   - retrieval injection: the conversation around the hits (including the
//     description of an attached image or document) lands in the dispatched
//     prompt, and the raw user message is what's persisted,
//   - that NOTHING is materialised under the brain root: the plaintext dump of
//     the full history that used to be written there is gone (V2 §3.2), so a
//     grounded turn must leave no second copy of the messages on disk,
//   - run config: cwd = brain root, read-only allowedTools, grounded system
//     prompt file on fresh sessions,
//   - citations: trailing `CITATIONS: [...]` line parsed, stripped from the
//     persisted text, emitted as a final `{type:"citations"}` SSE frame, and
//     persisted with the message (visible via GET /api/chat/sessions/:id),
//   - backward compat: old ungrounded sessions resume with the Phase-0 config
//     (sandbox cwd, no tools, no injection, no citations frame),
//   - unit coverage for parseCitationsFromText / buildContextBlock.
// ===========================================================================

// Pinned: the block renders message times in the user's local time, so the
// assertions on them are only stable against a known zone.
process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Env BEFORE importing db/server modules (each vitest file has its own
// module registry, so these are scoped to this file).
const tmpRoot = mkdtempSync(join(tmpdir(), "st-grounded-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
process.env.SUPERTWIN_CHAT_CWD = join(tmpRoot, "sandbox");
process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";
delete process.env.SUPERTWIN_SYSTEM_PROMPT_FILE;

const db = await import("../db/index.js");
const { registerV2 } = await import("../providers/index.js");
const { providerV2TestDouble } = await import("../providers/test-support.js");
const { startServer } = await import("./index.js");
const {
  GROUNDED_SYSTEM_PROMPT,
  buildContextBlock,
  groundedAllowedTools,
  parseCitationsFromText,
} = await import("./chat-grounding.js");

import { existsSync, mkdirSync } from "node:fs";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock provider: records every SendOptions and streams a scripted reply.
// ---------------------------------------------------------------------------

interface Script {
  continuation: string;
  reply: string;
  status?: "ok" | "error";
  errorCode?: "CANCELLED" | "AUTH_EXPIRED";
  throwCode?: "TRANSPORT_ERROR";
}

const sends: ProviderRequest[] = [];
let script: Script = { continuation: "continuation-initial", reply: "hello" };
let sendBarrier: Promise<void> | null = null;

const mockProvider = providerV2TestDouble(
  async (opts: ProviderRequest) => {
    sends.push(opts);
    if (sendBarrier) await sendBarrier;
    if (script.throwCode) {
      throw Object.assign(new Error("secret provider failure detail"), {
        code: script.throwCode,
      });
    }
    const emit = (e: ProviderStreamEvent) => opts.onEvent(e);
    for (const chunk of script.reply.match(/[\s\S]{1,20}/g) ?? []) {
      emit({ type: "delta", text: chunk });
    }
    const usage = {
      inputTokens: 10,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 3000,
      outputTokens: 5,
    };
    const status = script.status ?? "ok";
    if (status === "ok") emit({ type: "done", continuation: script.continuation, usage });
    return {
      continuation: status === "ok" ? script.continuation : null,
      usage,
      freshFallback: false,
      status,
      ...(status === "error" ? { errorCode: script.errorCode ?? "CANCELLED" } : {}),
    };
  },
  {
    capabilities: { hostTools: true, continuation: true },
    model: { supportsHostTools: true },
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

async function postChat(body: unknown): Promise<Frame[]> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
    }
  }
  return frames;
}

function requestText(request: ProviderRequest): string {
  return request.input
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .filter((part) => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");
}

function seedData(): void {
  const d = db.getDb();
  // The media columns arrive with the media migration; add the one the hit
  // query reads when this DB does not have it yet.
  const cols = d.pragma("table_info(events)") as { name: string }[];
  if (!cols.some((c) => c.name === "media_description")) {
    d.exec(`ALTER TABLE events ADD COLUMN media_description TEXT`);
  }
  d.prepare(
    `INSERT INTO channels (id, name, kind) VALUES ('ch_goa', 'Goa Trip 2026', 'group')`,
  ).run();
  d.prepare(
    `INSERT INTO actors (id, display_name) VALUES ('act_alice', 'Alice')`,
  ).run();
  d.prepare(`
    INSERT INTO events (id, channel_id, actor_id, ts, kind, text)
    VALUES ('evt_flights', 'ch_goa', 'act_alice', '2026-06-20T10:00:00.000Z',
            'message', 'Flights for the Goa trip are still pending booking')
  `).run();
  d.prepare(`
    INSERT INTO events (id, channel_id, actor_id, ts, kind, text)
    VALUES ('evt_hotel', 'ch_goa', 'act_alice', '2026-06-21T10:00:00.000Z',
            'message', 'Hotel for Goa is booked, flights next')
  `).run();
  d.prepare(`
    INSERT INTO events (id, channel_id, actor_id, ts, kind, text, media_description)
    VALUES ('evt_menu', 'ch_goa', 'act_alice', '2026-06-22T10:00:00.000Z',
            'message', 'Menu from the caterer',
            'A printed menu listing paneer tikka and dal makhani.')
  `).run();
}

// ---------------------------------------------------------------------------

type ServerHandle = { port: number; close(): Promise<void> };
let server: ServerHandle;
let base: string;

beforeAll(async () => {
  mkdirSync(process.env.SUPERTWIN_CHAT_CWD as string, { recursive: true });
  db.runMigrations();
  seedData();
  registerV2(mockProvider); // replaces "claude-local" for this file's registry
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
});

// ===========================================================================

describe("grounded chat (server, mock provider)", () => {
  it("fresh grounded run: cwd=brain, read-only tools, grounded prompt, retrieval injected", async () => {
    const conversationId = randomUUID();
    script = {
      continuation: "continuation-grounded-1",
      reply:
        'Flights are still pending [1].\nCITATIONS: [{"n":1,"kind":"event","id":"evt_flights","label":"Alice · Goa Trip 2026 · flights pending"}]',
    };
    sends.length = 0;

    const frames = await postChat({
      runId: "grounded-1",
      conversationId,
      message: "what's pending for the goa trip flights?",
    });

    // ---- Run config assertions.
    expect(sends.length).toBe(1);
    const opts = sends[0];
    expect(opts.cwd).toBe(resolve(process.env.SUPERTWIN_BRAIN_DIR as string));
    expect(opts.hostTools).toEqual(groundedAllowedTools());
    // Read-only: no write/edit/bash tools ever.
    for (const t of opts.hostTools ?? []) {
      expect(["Read", "Grep", "Glob"]).toContain(t);
    }
    expect(opts.instructions).toBe(GROUNDED_SYSTEM_PROMPT);

    // ---- Retrieval injection: the hit, its chat, and today's date.
    const sentText = requestText(opts);
    expect(sentText).toContain("<supertwin-context>");
    expect(sentText).toContain("evt_flights");
    expect(sentText).toContain("## Goa Trip 2026 —"); // chat name heads its section
    expect(sentText).toMatch(/Today is \w+ \d{4}-\d{2}-\d{2}\./);
    // The conversation AROUND the hit, which is what v6 §1 added: the answer to
    // "what's pending" is the next message, and it shares no word with it.
    expect(sentText).toContain("evt_hotel");
    // The raw user message is still the trailing part.
    expect(sentText.endsWith("what's pending for the goa trip flights?")).toBe(true);

    // ---- Nothing was written to the brain folder. The plaintext message dump
    // that used to be materialised there is gone (V2 §3.2): a grounded turn
    // reads SQLite and leaves no second copy of the history on disk.
    expect(existsSync(join(process.env.SUPERTWIN_BRAIN_DIR as string, "corpus"))).toBe(
      false,
    );
    expect(sentText).not.toContain("corpus/");

    // ---- Citations frame emitted, after done.
    const types = frames.map((f) => f.type);
    expect(types).not.toContain("session");
    expect(frames).toContainEqual({ type: "conversation", conversationId });
    expect(JSON.stringify(frames)).not.toContain(script.continuation);
    expect(types).toContain("done");
    expect(types.indexOf("citations")).toBeGreaterThan(types.indexOf("done"));
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: Array<Record<string, unknown>>;
    };
    expect(cframe.citations).toEqual([
      {
        n: 1,
        kind: "event",
        id: "evt_flights",
        label: "Alice · Goa Trip 2026 · flights pending",
      },
    ]);

    // ---- Persistence: CITATIONS line stripped; citations_json stored; the
    // persisted user message is the RAW one (no injected context).
    const messages = db.getChatMessages(conversationId);
    const user = messages.find((m) => m.role === "user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(user?.content).toBe("what's pending for the goa trip flights?");
    expect(assistant?.content).toBe("Flights are still pending [1].");
    expect(assistant?.content).not.toContain("CITATIONS:");
    expect(JSON.parse(assistant?.citationsJson ?? "[]")).toHaveLength(1);

    // ---- Session flagged grounded; detail endpoint exposes citations.
    const session = db.getChatSession(conversationId);
    expect(session?.grounded).toBe(true);
    const detail = (await (await fetch(`${base}/api/chat/sessions/${conversationId}`)).json()) as {
      session: { grounded: boolean };
      messages: Array<{ role: string; citations: unknown[] | null }>;
    };
    expect(detail.session.grounded).toBe(true);
    const asst = detail.messages.find((m) => m.role === "assistant");
    expect(asst?.citations).toHaveLength(1);
  });

  it("resuming a grounded session keeps the grounded config", async () => {
    const prior = db.listChatSessions().find((s) => s.grounded);
    expect(prior).toBeTruthy();
    script = { continuation: "continuation-grounded-2", reply: "still on it\nCITATIONS: []" };
    sends.length = 0;

    const frames = await postChat({
      runId: "grounded-2",
      conversationId: prior!.conversationId,
      message: "any update on flights?",
    });

    expect(sends.length).toBe(1);
    expect(sends[0].continuation).toEqual({ token: "continuation-grounded-1" });
    expect(sends[0].cwd).toBe(resolve(process.env.SUPERTWIN_BRAIN_DIR as string));
    expect(sends[0].hostTools).toEqual(groundedAllowedTools());
    expect(requestText(sends[0])).toContain("<supertwin-context>");
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: unknown[];
    };
    expect(cframe.citations).toEqual([]);
  });

  it("old ungrounded sessions resume with the Phase-0 config (no injection, no citations)", async () => {
    const conversationId = randomUUID();
    db.createChatSession({
      conversationId,
      provider: "claude-local",
      model: "claude-test-model",
      cwd: process.env.SUPERTWIN_CHAT_CWD as string,
      promptBundleHash: "0".repeat(64),
      title: "old chat",
      grounded: false,
      userMessage: { content: "old hello", runId: "old-run" },
    });
    script = { continuation: "continuation-ungrounded-1", reply: "plain answer" };
    sends.length = 0;

    const frames = await postChat({
      runId: "ungrounded-1",
      conversationId,
      message: "hello again",
    });

    expect(sends.length).toBe(1);
    const opts = sends[0];
    expect(opts.continuation).toBeUndefined(); // mismatched bundle reconstructs
    expect(opts.cwd).toBe(process.env.SUPERTWIN_CHAT_CWD);
    expect(opts.hostTools).toEqual([]);
    expect(requestText(opts)).toContain("hello again"); // no retrieval block
    expect(frames.some((f) => f.type === "citations")).toBe(false);

    const assistant = db
      .getChatMessages(conversationId)
      .find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("plain answer");
    expect(assistant?.citationsJson).toBeNull();
    expect(db.getChatSession(conversationId)?.grounded).toBe(false);
  });

  it("fresh chat with grounded:false opts out", async () => {
    const conversationId = randomUUID();
    script = { continuation: "continuation-optout", reply: "sandboxed" };
    sends.length = 0;
    await postChat({ runId: "optout-1", conversationId, message: "hi", grounded: false });
    expect(sends[0].cwd).toBe(process.env.SUPERTWIN_CHAT_CWD);
    expect(sends[0].hostTools).toEqual([]);
    expect(requestText(sends[0])).toContain("hi");
    expect(db.getChatSession(conversationId)?.grounded).toBe(false);
  });

  // REGRESSION: chat used to dispatch WITHOUT --setting-sources "", so the CLI
  // walked the user's whole Claude Code config (skills/plugins/MCP/hooks)
  // synchronously before opening a socket and was killed at the timeout with 0
  // tokens. Both modes must opt out; the sandbox cwd and the brain root have no
  // settings worth loading, and chat's instructions arrive via the system
  // prompt file instead.
  it("every chat run skips the user's Claude Code settings (grounded + ungrounded)", async () => {
    script = { continuation: "continuation-neutral-1", reply: "ok" };
    sends.length = 0;
    await postChat({ runId: "neutral-1", message: "hi", grounded: false });
    expect(sends[0].skipHostSettings).toBe(true);

    script = { continuation: "continuation-neutral-2", reply: "ok" };
    sends.length = 0;
    await postChat({ runId: "neutral-2", message: "hi", grounded: true });
    expect(sends[0].skipHostSettings).toBe(true);
    // The grounded instructions must still reach the CLI another way.
    expect(sends[0].instructions).toBe(GROUNDED_SYSTEM_PROMPT);
  });

  it("citations of a kind the UI cannot resolve never reach the client", async () => {
    script = {
      continuation: "continuation-kinds",
      reply:
        'Two sources [1][2].\nCITATIONS: [{"n":1,"kind":"event","id":"evt_hotel","label":"Alice · hotel"},{"n":2,"kind":"space","id":"space_goa","label":"Goa Trip"}]',
    };
    sends.length = 0;
    const conversationId = randomUUID();
    const frames = await postChat({ runId: "kinds-1", conversationId, message: "hotel and goa" });
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: Array<Record<string, unknown>>;
    };
    expect(cframe.citations).toEqual([
      { n: 1, kind: "event", id: "evt_hotel", label: "Alice · hotel" },
    ]);
    const assistant = db
      .getChatMessages(conversationId)
      .find((m) => m.role === "assistant");
    expect(JSON.parse(assistant?.citationsJson ?? "[]")).toEqual(cframe.citations);
  });

  it("a grounded reply WITHOUT a citations line still streams and persists intact", async () => {
    const conversationId = randomUUID();
    script = { continuation: "continuation-nocite", reply: "I could not find anything." };
    sends.length = 0;
    const frames = await postChat({ runId: "nocite-1", conversationId, message: "obscure question" });
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: unknown[];
    };
    expect(cframe.citations).toEqual([]); // frame still sent (empty)
    const assistant = db
      .getChatMessages(conversationId)
      .find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("I could not find anything.");
    expect(assistant?.citationsJson).toBeNull();
  });

  it("rejects a concurrent conversation turn before send or user-message append", async () => {
    const conversationId = randomUUID();
    script = { continuation: "continuation-concurrent", reply: "first answer" };
    let unblock!: () => void;
    sendBarrier = new Promise<void>((resolveBarrier) => { unblock = resolveBarrier; });
    sends.length = 0;
    const first = postChat({
      runId: "concurrent-first",
      conversationId,
      message: "first question",
      grounded: false,
    });
    while (sends.length === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 0));

    try {
      const loser = await postChat({
        runId: "concurrent-loser",
        conversationId,
        message: "must not persist",
        grounded: false,
      });
      expect(loser).toContainEqual(expect.objectContaining({
        type: "error",
        code: "CONVERSATION_BUSY",
      }));
      expect(sends).toHaveLength(1);
      expect(db.getChatMessages(conversationId).map((item) => item.content))
        .toEqual(["first question"]);
    } finally {
      unblock();
      await first;
      sendBarrier = null;
    }
    expect(db.getChatMessages(conversationId).map((item) => item.content))
      .toEqual(["first question", "first answer"]);
  });

  it("rejects conflicting public-id aliases before opening a stream", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: randomUUID(),
        sessionId: randomUUID(),
        message: "must not send",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "conversationId and sessionId must match" });
  });

  it("emits a fixed typed error when a failed result emitted no error event", async () => {
    const conversationId = randomUUID();
    script = {
      continuation: "secret-must-not-stream",
      reply: "",
      status: "error",
      errorCode: "AUTH_EXPIRED",
    };
    sends.length = 0;
    const frames = await postChat({
      runId: "silent-error",
      conversationId,
      message: "hello",
      grounded: false,
    });
    expect(frames).toContainEqual({
      type: "error",
      code: "AUTH_EXPIRED",
      message: "provider request failed (AUTH_EXPIRED)",
    });
    expect(JSON.stringify(frames)).not.toContain(script.continuation);
    expect(db.getChatMessages(conversationId).map((item) => item.role)).toEqual(["user"]);
    script = { continuation: "continuation-after-error", reply: "ok" };
  });

  it("aborts a thrown send reservation and permits deterministic reconstruction retry", async () => {
    const conversationId = randomUUID();
    script = {
      continuation: "secret-thrown-continuation",
      reply: "",
      throwCode: "TRANSPORT_ERROR",
    };
    sends.length = 0;
    const failed = await postChat({
      runId: "throw-first",
      conversationId,
      message: "failed question",
      grounded: false,
    });
    expect(failed).toContainEqual({
      type: "error",
      code: "TRANSPORT_ERROR",
      message: "provider request failed (TRANSPORT_ERROR)",
    });
    expect(JSON.stringify(failed)).not.toMatch(/secret provider failure detail|secret-thrown/);
    expect(db.getChatContinuation(conversationId)).toMatchObject({
      continuation: null,
      generation: expect.any(Number),
    });
    expect(db.getChatContinuation(conversationId)!.generation % 2).toBe(1);
    expect(db.getChatMessages(conversationId).map((item) => item.role)).toEqual(["user"]);

    script = { continuation: "continuation-retry", reply: "retry answer" };
    const retried = await postChat({
      runId: "throw-retry",
      conversationId,
      message: "retry question",
      grounded: false,
    });
    expect(retried.some((frame) => frame.type === "done")).toBe(true);
    expect(sends).toHaveLength(2);
    expect(sends[1].continuation).toBeUndefined();
    expect(requestText(sends[1])).toContain("failed question");
    expect(db.getChatMessages(conversationId).map((item) => item.role))
      .toEqual(["user", "user", "assistant"]);
  });

  it("GET /api/events/:id returns citation provenance; 404 on unknown", async () => {
    const res = await fetch(`${base}/api/events/evt_flights`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: Record<string, unknown> };
    expect(body.event.id).toBe("evt_flights");
    expect(body.event.actor_name).toBe("Alice");
    expect(body.event.channel_name).toBe("Goa Trip 2026");
    expect(body.event.text).toContain("pending booking");

    const missing = await fetch(`${base}/api/events/nope`);
    expect(missing.status).toBe(404);
  });
});

// ===========================================================================

describe("chat-grounding unit helpers", () => {
  it("buildContextBlock includes the hits and the chat they are in", () => {
    const block = buildContextBlock("goa flights pending");
    expect(block.startsWith("<supertwin-context>")).toBe(true);
    expect(block).toContain("* [evt evt_flights]"); // * marks a search hit
    expect(block).toContain("Alice");
    expect(block.endsWith("</supertwin-context>")).toBe(true);
  });

  it("buildContextBlock renders an attachment description on the hit line", () => {
    const block = buildContextBlock("caterer menu");
    // 2026-06-22T10:00Z is 15:30 in Asia/Kolkata: message times are the user's,
    // which is the same clock their question about "sunday" is on.
    expect(block).toContain("[evt evt_menu] 2026-06-22 15:30 · Alice: ");
    expect(block).toContain(
      "[attachment description: A printed menu listing paneer tikka and dal makhani.]",
    );
  });

  it("buildContextBlock writes nothing to disk", () => {
    const unwritten = join(tmpRoot, "brain-unwritten");
    const previous = process.env.SUPERTWIN_BRAIN_DIR;
    process.env.SUPERTWIN_BRAIN_DIR = unwritten;
    try {
      buildContextBlock("goa flights pending");
      expect(existsSync(unwritten)).toBe(false);
    } finally {
      process.env.SUPERTWIN_BRAIN_DIR = previous;
    }
  });

  it("buildContextBlock is empty when nothing matches; empty db-side query is safe", () => {
    expect(buildContextBlock("zzz-no-such-token-zzz")).toBe("");
    // Whitespace-only queries never produce an FTS error.
    expect(buildContextBlock("   ")).toBe("");
  });

  it("parseCitationsFromText strips the line and keeps only event citations", () => {
    const text =
      'Answer [1] and [2].\nCITATIONS: [{"n":1,"kind":"event","id":"evt_x","label":"a"},{"n":2,"kind":"space","id":"space_y","label":"b"},{"n":3,"kind":"bogus","id":"z","label":"c"},{"n":4,"kind":"event","id":"","label":"d"}]';
    const { display, citations } = parseCitationsFromText(text);
    expect(display).toBe("Answer [1] and [2].");
    expect(citations).toEqual([{ n: 1, kind: "event", id: "evt_x", label: "a" }]);
  });

  it("parseCitationsFromText tolerates missing/malformed lines", () => {
    expect(parseCitationsFromText("no line here")).toEqual({
      display: "no line here",
      citations: null,
    });
    const malformed = "text\nCITATIONS: [not json";
    expect(parseCitationsFromText(malformed).citations).toBeNull();
    expect(parseCitationsFromText(malformed).display).toBe(malformed);
    expect(parseCitationsFromText("empty\nCITATIONS: []")).toEqual({
      display: "empty",
      citations: [],
    });
  });
});
