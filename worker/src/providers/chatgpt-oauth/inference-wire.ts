export const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_RESPONSES_URL = `${CHATGPT_BACKEND_BASE_URL}/responses`;

export interface ChatGptInferenceWireInput {
  accessToken: string;
  accountId: string;
  userAgent: string;
  sessionId: string;
  requestId: string;
  bodyText: string;
  signal?: AbortSignal;
}

/** Pure single source of truth for the production and Phase 0b inference wire. */
export function buildChatGptInferenceWire(input: ChatGptInferenceWireInput): RequestInit {
  return {
    method: "POST",
    redirect: "error",
    ...(input.signal ? { signal: input.signal } : {}),
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "ChatGPT-Account-ID": input.accountId,
      "User-Agent": input.userAgent,
      originator: "supertwinv13",
      Accept: "application/json",
      "Content-Type": "application/json",
      session_id: input.sessionId,
      "x-client-request-id": input.requestId,
    },
    body: input.bodyText,
  };
}
