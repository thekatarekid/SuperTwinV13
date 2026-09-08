import { createHash, randomUUID } from "node:crypto";

import type {
  ProviderId,
  ProviderInputItem,
  ProviderStreamEvent,
} from "../providers/types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConversationBinding {
  provider: ProviderId;
  model: string;
  promptBundleHash: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ContinuationReservation {
  conversationId: string;
  /** Generation atomically reserved for this physical turn. */
  generation: number;
  /** Present only when the store proved that the complete binding matched. */
  continuation: string | null;
  provider: ProviderId | null;
  model: string | null;
  promptBundleHash: string | null;
}

export interface ConversationContinuationStore {
  getContinuation(conversationId: string): ContinuationReservation | null;
  reserveTurn(input: {
    conversationId: string;
    expectedGeneration: number;
    binding: ConversationBinding;
  }): ContinuationReservation | null;
  /** Release a reserved generation after any send/persistence failure. */
  abortTurn(input: {
    conversationId: string;
    expectedGeneration: number;
    binding: ConversationBinding;
  }): number | null;
  clearContinuation(input: {
    conversationId: string;
    expectedGeneration: number;
  }): number | null;
  rebindContinuation(input: {
    conversationId: string;
    expectedGeneration: number;
    binding: ConversationBinding;
  }): number | null;
  /** Compare-and-set the provider result into the exact reserved generation. */
  completeTurn(input: {
    conversationId: string;
    expectedGeneration: number;
    binding: ConversationBinding;
    continuation: string | null;
  }): number | null;
}

export class ConversationBusyError extends Error {
  readonly code = "CONVERSATION_BUSY";
  constructor() {
    super("CONVERSATION_BUSY: another turn is already running for this conversation");
    this.name = "ConversationBusyError";
  }
}

export class ConversationContinuationConflictError extends Error {
  readonly code = "CONTINUATION_CONFLICT";
  constructor() {
    super("CONTINUATION_CONFLICT: the conversation advanced before this turn completed");
    this.name = "ConversationContinuationConflictError";
  }
}

/** App-owned, unguessable public identity. Provider tokens never become URLs. */
export function createConversationId(newId: () => string = randomUUID): string {
  const id = newId();
  if (!UUID_V4.test(id)) throw new Error("conversation id generator did not return a UUIDv4");
  return id.toLowerCase();
}

function hashPart(hash: ReturnType<typeof createHash>, label: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${label}:${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
  hash.update("\0", "utf8");
}

/** Bind continuation reuse to the exact instruction and host-policy bytes. */
export function chatPromptBundleHash(input: {
  instructions: string;
  policy: string;
}): string {
  const hash = createHash("sha256");
  hash.update("supertwin-chat-prompt-bundle-v1\0", "utf8");
  hashPart(hash, "instructions", input.instructions);
  hashPart(hash, "policy", input.policy);
  return hash.digest("hex");
}

/**
 * ChatGPT receives the original ordered roles. Claude's current neutral
 * adapter accepts a single user item, so its reconstruction is an unambiguous
 * length-prefixed transcript instead of provider-owned continuation state.
 */
export function reconstructConversationInput(
  provider: ProviderId,
  transcript: readonly ConversationMessage[],
  currentUserText: string,
): ProviderInputItem[] {
  if (provider === "chatgpt-oauth") {
    return [...transcript, { role: "user" as const, text: currentUserText }]
      .map(({ role, text }) => ({
        type: "message" as const,
        role,
        content: [{ type: "input_text" as const, text }],
      }));
  }
  const parts = [...transcript, { role: "user" as const, text: currentUserText }]
    .map(({ role, text }) => {
      const bytes = Buffer.byteLength(text, "utf8");
      return `${role.toUpperCase()} ${bytes}\n${text}`;
    });
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `CONVERSATION TRANSCRIPT v1\n${parts.join("\n\n")}` }],
  }];
}

export interface PreparedConversationTurn {
  reservation: ContinuationReservation;
  input: ProviderInputItem[];
  continuation?: { token: string };
  reconstructed: boolean;
}

/** Reserve once, then either resume an exact binding or reconstruct fresh. */
export function prepareConversationTurn(input: {
  conversationId: string;
  binding: ConversationBinding;
  transcript: readonly ConversationMessage[];
  currentUserText: string;
  store: ConversationContinuationStore;
}): PreparedConversationTurn {
  if (!UUID_V4.test(input.conversationId)) throw new Error("conversation id must be a UUIDv4");
  const conversationId = input.conversationId.toLowerCase();
  const initial = input.store.getContinuation(conversationId);
  if (!initial) throw new ConversationContinuationConflictError();
  const bindingMatched =
    initial.provider === input.binding.provider &&
    initial.model === input.binding.model &&
    initial.promptBundleHash === input.binding.promptBundleHash;
  let expectedGeneration = initial.generation;
  if (!bindingMatched) {
    if (initial.continuation !== null) {
      const cleared = input.store.clearContinuation({ conversationId, expectedGeneration });
      if (cleared === null) throw new ConversationContinuationConflictError();
      expectedGeneration = cleared;
    }
    const rebound = input.store.rebindContinuation({
      conversationId,
      expectedGeneration,
      binding: input.binding,
    });
    if (rebound === null) throw new ConversationContinuationConflictError();
    expectedGeneration = rebound;
  }
  const reservation = input.store.reserveTurn({
    conversationId,
    expectedGeneration,
    binding: input.binding,
  });
  if (!reservation) throw new ConversationContinuationConflictError();
  const mayResume = bindingMatched && reservation.continuation !== null;
  return {
    reservation,
    input: mayResume
      ? [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.currentUserText }],
        }]
      : reconstructConversationInput(
          input.binding.provider,
          input.transcript,
          input.currentUserText,
        ),
    ...(mayResume ? { continuation: { token: reservation.continuation! } } : {}),
    reconstructed: !mayResume,
  };
}

/** A failed physical send must release its reserved generation before retry. */
export function abortConversationTurn(input: {
  prepared: PreparedConversationTurn;
  binding: ConversationBinding;
  store: ConversationContinuationStore;
}): void {
  const generation = input.store.abortTurn({
    conversationId: input.prepared.reservation.conversationId,
    expectedGeneration: input.prepared.reservation.generation,
    binding: input.binding,
  });
  if (generation === null) throw new ConversationContinuationConflictError();
}

/** Store success only if no other writer advanced the reserved generation. */
export function completeConversationTurn(input: {
  prepared: PreparedConversationTurn;
  binding: ConversationBinding;
  continuation: string | null;
  store: ConversationContinuationStore;
}): void {
  const generation = input.store.completeTurn({
    conversationId: input.prepared.reservation.conversationId,
    expectedGeneration: input.prepared.reservation.generation,
    binding: input.binding,
    continuation: input.continuation,
  });
  if (generation === null) throw new ConversationContinuationConflictError();
}

/** One physical chat turn per public conversation, always released in finally. */
export class ConversationInFlightGuard {
  readonly #active = new Set<string>();

  acquire(conversationId: string): () => void {
    if (this.#active.has(conversationId)) throw new ConversationBusyError();
    this.#active.add(conversationId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(conversationId);
    };
  }

  async run<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const release = this.acquire(conversationId);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Remove provider-owned state before an event crosses the HTTP/SSE boundary. */
export function publicChatEvent(event: ProviderStreamEvent): Record<string, unknown> | null {
  if (event.type === "continuation" || event.type === "session") return null;
  if (event.type === "done") {
    const { continuation: _continuation, sessionId: _sessionId, ...safe } = event;
    return safe;
  }
  if (event.type === "error") {
    return {
      type: "error",
      code: event.code,
      message: `provider request failed (${event.code})`,
    };
  }
  return { ...event };
}
