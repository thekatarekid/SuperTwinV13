import { describe, expect, it, vi } from "vitest";

import type { ConversationContinuationStore } from "./chat-continuation.js";
import {
  ConversationBusyError,
  ConversationContinuationConflictError,
  ConversationInFlightGuard,
  abortConversationTurn,
  chatPromptBundleHash,
  completeConversationTurn,
  createConversationId,
  prepareConversationTurn,
  publicChatEvent,
} from "./chat-continuation.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const binding = {
  provider: "claude-local" as const,
  model: "claude-test",
  promptBundleHash: chatPromptBundleHash({ instructions: "system\n", policy: "tools:none" }),
};

function store(over: Partial<ConversationContinuationStore> = {}): ConversationContinuationStore {
  const state = {
    conversationId: ID,
    generation: 4,
    continuation: "provider-secret-token",
    provider: binding.provider,
    model: binding.model,
    promptBundleHash: binding.promptBundleHash,
  };
  return {
    getContinuation: () => state,
    reserveTurn: ({ conversationId }) => ({ ...state, conversationId, generation: 5 }),
    abortTurn: () => 6,
    clearContinuation: () => 5,
    rebindContinuation: () => 6,
    completeTurn: () => 6,
    ...over,
  };
}

describe("conversation identity and binding", () => {
  it("accepts only app-owned UUIDv4 identities", () => {
    expect(createConversationId(() => ID)).toBe(ID);
    expect(() => createConversationId(() => "provider-session-1")).toThrow(/UUIDv4/);
  });

  it("hashes exact instruction and policy bytes with unambiguous boundaries", () => {
    expect(chatPromptBundleHash({ instructions: "ab", policy: "c" }))
      .not.toBe(chatPromptBundleHash({ instructions: "a", policy: "bc" }));
    expect(chatPromptBundleHash({ instructions: "x\n", policy: "p" }))
      .not.toBe(chatPromptBundleHash({ instructions: "x", policy: "p" }));
  });
});

describe("resume versus reconstruction", () => {
  it("resumes only a store-proven exact binding and sends only the new turn", () => {
    const prepared = prepareConversationTurn({
      conversationId: ID,
      binding,
      transcript: [{ role: "assistant", text: "old answer" }],
      currentUserText: "new question",
      store: store(),
    });
    expect(prepared.continuation).toEqual({ token: "provider-secret-token" });
    expect(prepared.reconstructed).toBe(false);
    expect(JSON.stringify(prepared.input)).toContain("new question");
    expect(JSON.stringify(prepared.input)).not.toContain("old answer");
  });

  it.each([
    ["null continuation", null, true],
    ["binding mismatch", "provider-secret-token", false],
  ])("reconstructs the complete transcript on %s", (_name, continuation, bindingMatched) => {
    const prepared = prepareConversationTurn({
      conversationId: ID,
      binding,
      transcript: [
        { role: "user", text: "old question" },
        { role: "assistant", text: "old answer" },
      ],
      currentUserText: "new question",
      store: store(bindingMatched
        ? {
            getContinuation: () => ({
              conversationId: ID,
              generation: 7,
              continuation,
              provider: binding.provider,
              model: binding.model,
              promptBundleHash: binding.promptBundleHash,
            }),
            reserveTurn: ({ conversationId }) => ({
              conversationId,
              generation: 8,
              continuation,
              provider: binding.provider,
              model: binding.model,
              promptBundleHash: binding.promptBundleHash,
            }),
          }
        : {
            getContinuation: () => ({
              conversationId: ID,
              generation: 7,
              continuation,
              provider: "chatgpt-oauth",
              model: "different",
              promptBundleHash: "0".repeat(64),
            }),
            reserveTurn: ({ conversationId }) => ({
              conversationId,
              generation: continuation === null ? 9 : 10,
              continuation: null,
              provider: binding.provider,
              model: binding.model,
              promptBundleHash: binding.promptBundleHash,
            }),
          }),
    });
    expect(prepared).not.toHaveProperty("continuation");
    expect(prepared.reconstructed).toBe(true);
    expect(JSON.stringify(prepared.input)).toContain("old question");
    expect(JSON.stringify(prepared.input)).toContain("old answer");
    expect(JSON.stringify(prepared.input)).toContain("new question");
  });

  it("preserves ordered user and assistant roles for ChatGPT reconstruction", () => {
    const chatgptBinding = { ...binding, provider: "chatgpt-oauth" as const };
    const prepared = prepareConversationTurn({
      conversationId: ID,
      binding: chatgptBinding,
      transcript: [
        { role: "user", text: "old question" },
        { role: "assistant", text: "old answer" },
      ],
      currentUserText: "new question",
      store: store({
        getContinuation: () => ({
          conversationId: ID,
          generation: 0,
          continuation: null,
          provider: null,
          model: null,
          promptBundleHash: null,
        }),
        rebindContinuation: () => 1,
        reserveTurn: () => ({
          conversationId: ID,
          generation: 2,
          continuation: null,
          provider: chatgptBinding.provider,
          model: chatgptBinding.model,
          promptBundleHash: chatgptBinding.promptBundleHash,
        }),
      }),
    });
    expect(prepared.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "old question" }] },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "old answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new question" }] },
    ]);
  });

  it("releases failed reservations with the exact binding and generation", () => {
    const abortTurn = vi.fn(() => 6);
    const prepared = prepareConversationTurn({
      conversationId: ID,
      binding,
      transcript: [],
      currentUserText: "hello",
      store: store(),
    });
    abortConversationTurn({ prepared, binding, store: store({ abortTurn }) });
    expect(abortTurn).toHaveBeenCalledWith({
      conversationId: ID,
      expectedGeneration: 5,
      binding,
    });
  });

  it("requires CAS success and never includes a token in the conflict", () => {
    const prepared = prepareConversationTurn({
      conversationId: ID,
      binding,
      transcript: [],
      currentUserText: "hello",
      store: store(),
    });
    expect(() => completeConversationTurn({
      prepared,
      binding,
      continuation: "rotated-provider-secret",
      store: store({ completeTurn: () => null }),
    })).toThrow(ConversationContinuationConflictError);
    try {
      completeConversationTurn({
        prepared,
        binding,
        continuation: "rotated-provider-secret",
        store: store({ completeTurn: () => null }),
      });
    } catch (error) {
      expect(String(error)).not.toContain("rotated-provider-secret");
    }
  });
});

describe("concurrency and public events", () => {
  it("permits only one turn per conversation and releases after failure", async () => {
    const guard = new ConversationInFlightGuard();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = guard.run(ID, () => blocked);
    await expect(guard.run(ID, async () => "second")).rejects.toBeInstanceOf(ConversationBusyError);
    expect(await guard.run("223e4567-e89b-42d3-a456-426614174000", async () => "other"))
      .toBe("other");
    release();
    await first;
    expect(await guard.run(ID, async () => "after" )).toBe("after");
  });

  it("never exposes continuation or deprecated session tokens", () => {
    expect(publicChatEvent({ type: "continuation", token: "secret-a" })).toBeNull();
    expect(publicChatEvent({ type: "session", sessionId: "secret-b" })).toBeNull();
    const done = publicChatEvent({
      type: "done",
      continuation: "secret-c",
      sessionId: "secret-d",
      usage: { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 },
    });
    expect(JSON.stringify(done)).not.toMatch(/secret-[cd]/);
    const error = publicChatEvent({
      type: "error",
      code: "AUTH_EXPIRED",
      message: "sign in again with secret-e",
      continuation: "secret-e",
      sessionId: "secret-f",
    });
    expect(JSON.stringify(error)).not.toMatch(/secret-[ef]/);
    expect(error).toEqual({
      type: "error",
      code: "AUTH_EXPIRED",
      message: "provider request failed (AUTH_EXPIRED)",
    });
  });
});
