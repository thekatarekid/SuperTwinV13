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
import { createHash, randomUUID } from "node:crypto";
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
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const {
  GROUNDED_SYSTEM_PROMPT,
  buildContextBlock,
  groundedAllowedTools,
  parseCitationsFromText,
} = await import("./chat-grounding.js");

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type {
  Provider,
  ProviderStreamEvent,
  SendOptions,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock provider: records every SendOptions and streams a scripted reply.
// ---------------------------------------------------------------------------

interface Script {
  sessionId: string;
  reply: string;
}

const sends: SendOptions[] = [];
let script: Script = { sessionId: randomUUID(), reply: "hello" };

const mockProvider: Provider = {
  id: "claude-local",
  cancel: () => false,
  async send(opts: SendOptions) {
    sends.push(opts);
    const emit = (e: ProviderStreamEvent) => opts.onEvent(e);
    const sessionId = opts.sessionId ?? script.sessionId;
    emit({ type: "session", sessionId });
    for (const chunk of script.reply.match(/[\s\S]{1,20}/g) ?? []) {
      emit({ type: "delta", text: chunk });
    }
    const usage = {
      inputTokens: 10,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 3000,
      outputTokens: 5,
    };
    emit({ type: "done", sessionId, usage });
    return { sessionId, usage, freshFallback: false, status: "ok" as const };
  },
};

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

/**
 * The ungrounded prompt-bundle hash the server computes (no prompt file).
 * NOTE: the server's separator is a NUL byte, not a space.
 */
function ungroundedBundleHash(): string {
  const h = createHash("sha256");
  h.update("claude-local");
  h.update("\x00");
  h.update("");
  return h.digest("hex").slice(0, 16);
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
  register(mockProvider); // replaces "claude-local" for this file's registry
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
});

// ===========================================================================

describe("grounded chat (server, mock provider)", () => {
  it("fresh grounded run: cwd=brain, read-only tools, grounded prompt, retrieval injected", async () => {
    const sessionId = randomUUID();
    script = {
      sessionId,
      reply:
        'Flights are still pending [1].\nCITATIONS: [{"n":1,"kind":"event","id":"evt_flights","label":"Alice · Goa Trip 2026 · flights pending"}]',
    };
    sends.length = 0;

    const frames = await postChat({
      runId: "grounded-1",
      message: "what's pending for the goa trip flights?",
    });

    // ---- Run config assertions.
    expect(sends.length).toBe(1);
    const opts = sends[0];
    expect(opts.cwd).toBe(resolve(process.env.SUPERTWIN_BRAIN_DIR as string));
    expect(opts.allowedTools).toEqual(groundedAllowedTools());
    // Read-only: no write/edit/bash tools ever.
    for (const t of opts.allowedTools ?? []) {
      expect(["Read", "Grep", "Glob"]).toContain(t);
    }
    expect(opts.systemPromptFile).toBeTruthy();
    expect(readFileSync(opts.systemPromptFile as string, "utf8")).toBe(
      GROUNDED_SYSTEM_PROMPT,
    );

    // ---- Retrieval injection: the hit, its chat, and today's date.
    expect(opts.message).toContain("<supertwin-context>");
    expect(opts.message).toContain("evt_flights");
    expect(opts.message).toContain("## Goa Trip 2026 —"); // chat name heads its section
    expect(opts.message).toMatch(/Today is \w+ \d{4}-\d{2}-\d{2}\./);
    // The conversation AROUND the hit, which is what v6 §1 added: the answer to
    // "what's pending" is the next message, and it shares no word with it.
    expect(opts.message).toContain("evt_hotel");
    // The raw user message is still the trailing part.
    expect(opts.message.endsWith("what's pending for the goa trip flights?")).toBe(true);

    // ---- Nothing was written to the brain folder. The plaintext message dump
    // that used to be materialised there is gone (V2 §3.2): a grounded turn
    // reads SQLite and leaves no second copy of the history on disk.
    expect(existsSync(join(process.env.SUPERTWIN_BRAIN_DIR as string, "corpus"))).toBe(
      false,
    );
    expect(opts.message).not.toContain("corpus/");

    // ---- Citations frame emitted, after done.
    const types = frames.map((f) => f.type);
    expect(types).toContain("session");
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
    const messages = db.getMessages(sessionId);
    const user = messages.find((m) => m.role === "user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(user?.content).toBe("what's pending for the goa trip flights?");
    expect(assistant?.content).toBe("Flights are still pending [1].");
    expect(assistant?.content).not.toContain("CITATIONS:");
    expect(JSON.parse(assistant?.citationsJson ?? "[]")).toHaveLength(1);

    // ---- Session flagged grounded; detail endpoint exposes citations.
    const session = db.getSession(sessionId);
    expect(session?.grounded).toBe(true);
    const detail = (await (await fetch(`${base}/api/chat/sessions/${sessionId}`)).json()) as {
      session: { grounded: boolean };
      messages: Array<{ role: string; citations: unknown[] | null }>;
    };
    expect(detail.session.grounded).toBe(true);
    const asst = detail.messages.find((m) => m.role === "assistant");
    expect(asst?.citations).toHaveLength(1);
  });

  it("resuming a grounded session keeps the grounded config", async () => {
    const prior = db.listSessions().find((s) => s.grounded);
    expect(prior).toBeTruthy();
    script = { sessionId: prior!.sessionId, reply: "still on it\nCITATIONS: []" };
    sends.length = 0;

    const frames = await postChat({
      runId: "grounded-2",
      sessionId: prior!.sessionId,
      message: "any update on flights?",
    });

    expect(sends.length).toBe(1);
    expect(sends[0].sessionId).toBe(prior!.sessionId); // resumed
    expect(sends[0].cwd).toBe(resolve(process.env.SUPERTWIN_BRAIN_DIR as string));
    expect(sends[0].allowedTools).toEqual(groundedAllowedTools());
    expect(sends[0].message).toContain("<supertwin-context>");
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: unknown[];
    };
    expect(cframe.citations).toEqual([]);
  });

  it("old ungrounded sessions resume with the Phase-0 config (no injection, no citations)", async () => {
    const oldId = randomUUID();
    db.createSession({
      sessionId: oldId,
      provider: "claude-local",
      cwd: process.env.SUPERTWIN_CHAT_CWD as string,
      promptBundleHash: ungroundedBundleHash(),
      title: "old chat",
      grounded: false,
    });
    script = { sessionId: oldId, reply: "plain answer" };
    sends.length = 0;

    const frames = await postChat({
      runId: "ungrounded-1",
      sessionId: oldId,
      message: "hello again",
    });

    expect(sends.length).toBe(1);
    const opts = sends[0];
    expect(opts.sessionId).toBe(oldId); // resumed, not fresh-fallback
    expect(opts.cwd).toBe(process.env.SUPERTWIN_CHAT_CWD);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.message).toBe("hello again"); // no retrieval block
    expect(frames.some((f) => f.type === "citations")).toBe(false);

    const assistant = db
      .getMessages(oldId)
      .find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("plain answer");
    expect(assistant?.citationsJson).toBeNull();
    expect(db.getSession(oldId)?.grounded).toBe(false);
  });

  it("fresh chat with grounded:false opts out", async () => {
    script = { sessionId: randomUUID(), reply: "sandboxed" };
    sends.length = 0;
    await postChat({ runId: "optout-1", message: "hi", grounded: false });
    expect(sends[0].cwd).toBe(process.env.SUPERTWIN_CHAT_CWD);
    expect(sends[0].allowedTools).toEqual([]);
    expect(sends[0].message).toBe("hi");
    expect(db.getSession(script.sessionId)?.grounded).toBe(false);
  });

  // REGRESSION: chat used to dispatch WITHOUT --setting-sources "", so the CLI
  // walked the user's whole Claude Code config (skills/plugins/MCP/hooks)
  // synchronously before opening a socket and was killed at the timeout with 0
  // tokens. Both modes must opt out; the sandbox cwd and the brain root have no
  // settings worth loading, and chat's instructions arrive via the system
  // prompt file instead.
  it("every chat run skips the user's Claude Code settings (grounded + ungrounded)", async () => {
    script = { sessionId: randomUUID(), reply: "ok" };
    sends.length = 0;
    await postChat({ runId: "neutral-1", message: "hi", grounded: false });
    expect(sends[0].skipUserSettings).toBe(true);

    script = { sessionId: randomUUID(), reply: "ok" };
    sends.length = 0;
    await postChat({ runId: "neutral-2", message: "hi", grounded: true });
    expect(sends[0].skipUserSettings).toBe(true);
    // The grounded instructions must still reach the CLI another way.
    expect(sends[0].systemPromptFile).toBeTruthy();
  });

  it("citations of a kind the UI cannot resolve never reach the client", async () => {
    script = {
      sessionId: randomUUID(),
      reply:
        'Two sources [1][2].\nCITATIONS: [{"n":1,"kind":"event","id":"evt_hotel","label":"Alice · hotel"},{"n":2,"kind":"space","id":"space_goa","label":"Goa Trip"}]',
    };
    sends.length = 0;
    const frames = await postChat({ runId: "kinds-1", message: "hotel and goa" });
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: Array<Record<string, unknown>>;
    };
    expect(cframe.citations).toEqual([
      { n: 1, kind: "event", id: "evt_hotel", label: "Alice · hotel" },
    ]);
    const assistant = db
      .getMessages(script.sessionId)
      .find((m) => m.role === "assistant");
    expect(JSON.parse(assistant?.citationsJson ?? "[]")).toEqual(cframe.citations);
  });

  it("a grounded reply WITHOUT a citations line still streams and persists intact", async () => {
    script = { sessionId: randomUUID(), reply: "I could not find anything." };
    sends.length = 0;
    const frames = await postChat({ runId: "nocite-1", message: "obscure question" });
    const cframe = frames.find((f) => f.type === "citations") as {
      citations: unknown[];
    };
    expect(cframe.citations).toEqual([]); // frame still sent (empty)
    const assistant = db
      .getMessages(script.sessionId)
      .find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("I could not find anything.");
    expect(assistant?.citationsJson).toBeNull();
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
