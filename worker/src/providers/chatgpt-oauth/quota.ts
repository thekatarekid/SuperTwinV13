import { createHash } from "node:crypto";

import { parseChatGptQuota, type ChatGptQuotaSnapshot } from "./usage.js";
import { enforceGoldenChatGptMetadata } from "../../evals/provider-golden-rail.js";

export const CHATGPT_ACCOUNT_QUOTA_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CHATGPT_QUOTA_MAX_RESPONSE_BYTES = 256 * 1024;

interface QuotaAuthorization {
  authorization(signal: AbortSignal): Promise<{ accessToken: string; accountId: string }>;
}

export interface ChatGptQuotaPollResult {
  identity: string;
  snapshot: ChatGptQuotaSnapshot;
}

function identity(accountId: string): string {
  return createHash("sha256").update("supertwin.chatgpt-quota-account.v1\0").update(accountId).digest("hex");
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("ChatGPT quota polling failed"));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("ChatGPT quota polling failed"));
    signal.addEventListener("abort", stop, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", stop); resolve(value); },
      () => { signal.removeEventListener("abort", stop); reject(new Error("ChatGPT quota polling failed")); },
    );
  });
}

/** One bounded authenticated metadata GET. It performs no retry and no inference. */
export async function pollChatGptQuota(options: {
  session: QuotaAuthorization;
  fetch: typeof fetch;
  userAgent: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ChatGptQuotaPollResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!/^SuperTwinV13\/[0-9A-Za-z.+-]{1,128}$/.test(options.userAgent) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) {
    throw new Error("ChatGPT quota polling configuration is invalid");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const authorization = await abortable(options.session.authorization(signal), signal);
  let response: Response;
  try {
    enforceGoldenChatGptMetadata("quota", authorization.accountId);
    response = await options.fetch(CHATGPT_ACCOUNT_QUOTA_URL, {
      method: "GET", redirect: "error", signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authorization.accessToken}`,
        "ChatGPT-Account-ID": authorization.accountId,
        "User-Agent": options.userAgent,
        originator: "supertwinv13",
      },
    });
  } catch { throw new Error("ChatGPT quota polling failed"); }
  if (!response.ok || !response.body || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("ChatGPT quota polling failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CHATGPT_QUOTA_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("ChatGPT quota polling failed");
      }
      chunks.push(chunk.value);
    }
  } catch { throw new Error("ChatGPT quota polling failed"); }
  finally { reader.releaseLock(); }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
    return { identity: identity(authorization.accountId), snapshot: parseChatGptQuota(value) };
  } catch { throw new Error("ChatGPT quota polling failed"); }
}
