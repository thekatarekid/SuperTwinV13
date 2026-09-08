// Provider-neutral chat persistence. SQLite only; zero network/model calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { closeDb } from "./connection.js";
import {
  abortChatTurn,
  appendChatUserMessage,
  clearChatContinuation,
  commitAssistantTurn,
  createChatSession,
  createSession,
  getChatContinuation,
  getChatMessages,
  getChatSession,
  getDb,
  listChatSessions,
  rebindChatContinuation,
  reserveChatTurn,
  runMigrations,
} from "./index.js";

const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "supertwin-chat-v2-"));
  process.env.SUPERTWIN_DB_PATH = join(scratch, "chat.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(scratch, { recursive: true, force: true });
});

function create(conversationId = CONVERSATION_A) {
  return createChatSession({
    conversationId,
    provider: "claude-local",
    model: "claude-sonnet-5",
    cwd: "/safe/brain",
    promptBundleHash: HASH_A,
    title: "Private continuation test",
    grounded: true,
    userMessage: { content: "hello", runId: "run-user-1" },
  });
}

describe("provider-neutral chat session API", () => {
  it("surfaces a migrated unbound row as reconstructable generation zero", () => {
    createSession({
      sessionId: "legacy-provider-session-secret",
      provider: "claude-local",
      cwd: "/legacy",
      promptBundleHash: "legacy-hash",
      title: "Migrated chat",
    });
    const conversationId = getDb().prepare(`
      SELECT conversation_id FROM chat_sessions WHERE session_id = ?
    `).pluck().get("legacy-provider-session-secret") as string;

    expect(getChatContinuation(conversationId)).toEqual({
      conversationId,
      provider: null,
      model: null,
      promptBundleHash: null,
      continuation: null,
      generation: 0,
    });
    expect(rebindChatContinuation({
      conversationId,
      expectedGeneration: 0,
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
    })).toBe(1);
    expect(getChatContinuation(conversationId)).toMatchObject({
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
      continuation: null,
      generation: 1,
    });
    expect(JSON.stringify(getChatSession(conversationId))).not.toContain("legacy-provider-session-secret");
  });

  it("creates the public conversation and first user message atomically", () => {
    const session = create();
    const stored = getDb().prepare(`
      SELECT session_id, conversation_id, provider_continuation,
             continuation_generation
        FROM chat_sessions
    `).get() as Record<string, unknown>;

    expect(session).toMatchObject({
      conversationId: CONVERSATION_A,
      provider: "claude-local",
      cwd: "/safe/brain",
      promptBundleHash: HASH_A,
      title: "Private continuation test",
      grounded: true,
      status: "active",
    });
    expect(stored.conversation_id).toBe(CONVERSATION_A);
    expect(stored.session_id).not.toBe(CONVERSATION_A);
    expect(stored.provider_continuation).toBeNull();
    expect(stored.continuation_generation).toBe(1);
    expect(session).not.toHaveProperty("sessionId");
    expect(session).not.toHaveProperty("continuation");
    expect(JSON.stringify(session)).not.toContain(String(stored.session_id));

    expect(getChatMessages(CONVERSATION_A)).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_A,
        role: "user",
        content: "hello",
        runId: "run-user-1",
      }),
    ]);

    expect(() => createChatSession({
      conversationId: CONVERSATION_B,
      provider: "claude-local",
      model: "claude-sonnet-5",
      cwd: "/safe/brain",
      promptBundleHash: "not-a-sha256",
      userMessage: { content: "must roll back" },
    })).toThrow();
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chat_sessions`).get()).toEqual({ n: 1 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get()).toEqual({ n: 1 });

    expect(() => createChatSession({
      conversationId: CONVERSATION_B,
      provider: "claude-local",
      model: "claude-sonnet-5",
      cwd: "/safe/brain",
      promptBundleHash: HASH_A,
      userMessage: { content: null as unknown as string },
    })).toThrow(/NOT NULL/);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chat_sessions`).get()).toEqual({ n: 1 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get()).toEqual({ n: 1 });
  });

  it("queries, lists, and appends exclusively by public conversation id", () => {
    create();
    const internalKey = getDb().prepare(`SELECT session_id FROM chat_sessions`).pluck().get() as string;

    appendChatUserMessage({
      conversationId: CONVERSATION_A,
      content: "second question",
      runId: "run-user-2",
    });
    expect(getChatSession(CONVERSATION_A)?.conversationId).toBe(CONVERSATION_A);
    expect(getChatSession(internalKey)).toBeNull();
    expect(listChatSessions().map((session) => session.conversationId)).toEqual([CONVERSATION_A]);
    expect(getChatMessages(CONVERSATION_A).map((message) => message.content)).toEqual([
      "hello",
      "second question",
    ]);
    expect(getChatMessages(internalKey)).toEqual([]);
    expect(() => appendChatUserMessage({ conversationId: internalKey, content: "no" })).toThrow(
      /conversation not found/,
    );
  });

  it("commits assistant text and continuation together under an exact generation and binding CAS", () => {
    create();
    expect(getChatContinuation(CONVERSATION_A)).toEqual({
      conversationId: CONVERSATION_A,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: null,
      generation: 1,
    });

    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 1,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: "unreserved-token",
      assistantMessage: { content: "must reserve before sending" },
    })).toBeNull();
    expect(getChatMessages(CONVERSATION_A)).toHaveLength(1);

    expect(reserveChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 1,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
    })).toEqual({
      conversationId: CONVERSATION_A,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: null,
      generation: 2,
    });

    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: "opaque-provider-token",
      assistantMessage: {
        content: "hello back",
        runId: "run-assistant-1",
        usageJson: '{"inputTokens":4,"outputTokens":2}',
        citationsJson: "[]",
      },
    })).toBe(3);
    expect(getChatMessages(CONVERSATION_A).map((message) => message.content)).toEqual([
      "hello",
      "hello back",
    ]);
    expect(getChatContinuation(CONVERSATION_A)?.continuation).toBe("opaque-provider-token");
    expect(JSON.stringify(getChatSession(CONVERSATION_A))).not.toContain("opaque-provider-token");
    expect(JSON.stringify(listChatSessions())).not.toContain("opaque-provider-token");
    expect(JSON.stringify(getChatMessages(CONVERSATION_A))).not.toContain("opaque-provider-token");

    // Both a stale generation and binding drift fail without an orphan reply.
    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: "stale-token",
      assistantMessage: { content: "must not persist" },
    })).toBeNull();
    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 3,
      provider: "claude-local",
      model: "wrong-model",
      promptBundleHash: HASH_A,
      continuation: "wrong-binding-token",
      assistantMessage: { content: "must not persist either" },
    })).toBeNull();
    expect(getChatMessages(CONVERSATION_A)).toHaveLength(2);
    expect(getChatContinuation(CONVERSATION_A)).toMatchObject({
      continuation: "opaque-provider-token",
      generation: 3,
    });
  });

  it("requires clear-before-rebind and advances the CAS generation at every transition", () => {
    create();
    expect(reserveChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 1,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
    })?.generation).toBe(2);
    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: "claude-token",
      assistantMessage: { content: "first answer" },
    })).toBe(3);

    expect(rebindChatContinuation({
      conversationId: CONVERSATION_A,
      expectedGeneration: 3,
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
    })).toBeNull();
    expect(clearChatContinuation({ conversationId: CONVERSATION_A, expectedGeneration: 3 })).toBe(5);
    expect(clearChatContinuation({ conversationId: CONVERSATION_A, expectedGeneration: 3 })).toBeNull();
    expect(rebindChatContinuation({
      conversationId: CONVERSATION_A,
      expectedGeneration: 5,
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
    })).toBe(7);
    expect(getChatContinuation(CONVERSATION_A)).toEqual({
      conversationId: CONVERSATION_A,
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
      continuation: null,
      generation: 7,
    });
    expect(getChatSession(CONVERSATION_A)).toMatchObject({
      conversationId: CONVERSATION_A,
      provider: "chatgpt-oauth",
      promptBundleHash: HASH_B,
    });
  });

  it("rolls back the continuation update when the assistant-side transaction fails", () => {
    create(CONVERSATION_A);
    create(CONVERSATION_B);
    for (const conversationId of [CONVERSATION_A, CONVERSATION_B]) {
      expect(reserveChatTurn({
        conversationId,
        expectedGeneration: 1,
        provider: "claude-local",
        model: "claude-sonnet-5",
        promptBundleHash: HASH_A,
      })?.generation).toBe(2);
    }
    const first = {
      expectedGeneration: 2,
      provider: "claude-local" as const,
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
      continuation: "provider-token-owned-once",
    };
    expect(commitAssistantTurn({
      conversationId: CONVERSATION_A,
      ...first,
      assistantMessage: { content: "first owner" },
    })).toBe(3);

    expect(() => commitAssistantTurn({
      conversationId: CONVERSATION_B,
      ...first,
      assistantMessage: { content: "must roll back" },
    })).toThrow(/UNIQUE/);
    expect(getChatContinuation(CONVERSATION_B)).toMatchObject({ continuation: null, generation: 2 });
    expect(getChatMessages(CONVERSATION_B).map((message) => message.content)).toEqual(["hello"]);
  });

  it("allows exactly one process to reserve a generation before provider send", () => {
    create();
    expect(reserveChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 1,
      provider: "claude-local",
      model: "wrong-model",
      promptBundleHash: HASH_A,
    })).toBeNull();
    expect(getChatContinuation(CONVERSATION_A)?.generation).toBe(1);
    const second = new Database(process.env.SUPERTWIN_DB_PATH!);
    try {
      second.pragma("foreign_keys = ON");
      const stale = second.prepare(`
        SELECT continuation_generation AS generation
          FROM chat_sessions WHERE conversation_id = ?
      `).get(CONVERSATION_A) as { generation: number };
      expect(stale.generation).toBe(1);

      const winner = reserveChatTurn({
        conversationId: CONVERSATION_A,
        expectedGeneration: stale.generation,
        provider: "claude-local",
        model: "claude-sonnet-5",
        promptBundleHash: HASH_A,
      });
      expect(winner).toMatchObject({ continuation: null, generation: 2 });

      const loser = second.prepare(`
        UPDATE chat_sessions
           SET continuation_generation = continuation_generation + 1
         WHERE conversation_id = @conversationId
           AND continuation_generation = @expectedGeneration
           AND continuation_generation % 2 = 1
           AND continuation_provider = @provider
           AND continuation_model = @model
           AND continuation_prompt_bundle_hash = @promptBundleHash
        RETURNING continuation_generation
      `).get({
        conversationId: CONVERSATION_A,
        expectedGeneration: stale.generation,
        provider: "claude-local",
        model: "claude-sonnet-5",
        promptBundleHash: HASH_A,
      });
      expect(loser).toBeUndefined();

      const fresh = second.prepare(`
        SELECT continuation_generation AS generation
          FROM chat_sessions WHERE conversation_id = ?
      `).get(CONVERSATION_A) as { generation: number };
      expect(fresh.generation).toBe(2);
      const freshLoser = second.prepare(`
        UPDATE chat_sessions
           SET continuation_generation = continuation_generation + 1
         WHERE conversation_id = @conversationId
           AND continuation_generation = @expectedGeneration
           AND continuation_generation % 2 = 1
           AND continuation_provider = @provider
           AND continuation_model = @model
           AND continuation_prompt_bundle_hash = @promptBundleHash
        RETURNING continuation_generation
      `).get({
        conversationId: CONVERSATION_A,
        expectedGeneration: fresh.generation,
        provider: "claude-local",
        model: "claude-sonnet-5",
        promptBundleHash: HASH_A,
      });
      expect(freshLoser).toBeUndefined();
    } finally {
      second.close();
    }

    expect(clearChatContinuation({ conversationId: CONVERSATION_A, expectedGeneration: 2 })).toBeNull();
    expect(rebindChatContinuation({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "chatgpt-oauth",
      model: "gpt-5.6-sol",
      promptBundleHash: HASH_B,
    })).toBeNull();
    expect(abortChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "claude-local",
      model: "wrong-model",
      promptBundleHash: HASH_A,
    })).toBeNull();
    expect(abortChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 2,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
    })).toBe(3);

    // A restarted stale caller also fails closed rather than dispatching.
    closeDb();
    expect(reserveChatTurn({
      conversationId: CONVERSATION_A,
      expectedGeneration: 1,
      provider: "claude-local",
      model: "claude-sonnet-5",
      promptBundleHash: HASH_A,
    })).toBeNull();
    expect(getChatContinuation(CONVERSATION_A)).toMatchObject({ continuation: null, generation: 3 });
  });
});
