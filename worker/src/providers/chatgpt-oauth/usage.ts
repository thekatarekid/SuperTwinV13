import type { Usage } from "../types.js";

const MAX_USED_PERCENT = 1_000;
const MAX_RESET_TIMESTAMP_MS = 253_402_300_799_000;
const MAX_WINDOW_SECONDS = 31_622_400;
const MAX_CREDITS = 1_000_000_000;
const MAX_USAGE_COUNTER = 10_000_000;
const MAX_TOTAL_TOKENS = 20_000_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 2_048;
const MAX_SCAN_STRING_BYTES = 4_096;

const RESTRICTION_BOOLEAN_KEYS = new Set([
  "account_flagged", "account_restricted", "account_suspended", "account_warning",
  "captcha", "captcha_required",
  "flagged", "is_flagged", "is_limited", "is_restricted", "is_suspended",
  "limit_reached", "limited", "rate_limited", "restricted", "restriction",
  "suspended", "token_revoked", "warning",
]);
const RESTRICTION_TEXT_KEYS = new Set([
  "code", "error", "reason", "restriction", "state", "status", "type", "warning",
]);
const RESTRICTION_STATES = new Set([
  "account_flagged", "account_restricted", "account_suspended", "account_warning",
  "captcha_required",
  "flagged", "limit_reached", "quota_exceeded", "quota_exhausted", "rate_limited",
  "restricted", "subscription_restricted", "subscription_suspended", "suspended",
  "suspicious_activity", "token_revoked",
]);

export class ChatGptUsageError extends Error {
  readonly code = "BACKEND_UNSUPPORTED" as const;

  constructor(message: string) {
    super(`BACKEND_UNSUPPORTED: ${message}`);
    this.name = "ChatGptUsageError";
  }
}

export interface ChatGptUsageProjection {
  usage: Usage;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface ChatGptQuotaWindow {
  usedPercent: number;
  resetAt?: number | string;
  limitWindowSeconds?: number;
}

export interface ChatGptQuotaSnapshot {
  planType: string;
  primary: ChatGptQuotaWindow;
  secondary?: ChatGptQuotaWindow;
  creditsRemaining?: number;
  healthy: boolean;
  restrictionSignal: boolean;
}

function fail(label: string): never {
  throw new ChatGptUsageError(`invalid ${label}`);
}

function rethrowSafe(error: unknown): never {
  if (error instanceof ChatGptUsageError) throw error;
  throw new ChatGptUsageError("invalid response structure");
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(label);
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) fail(label);
    clone[key] = descriptor.value;
  }
  return clone;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value === undefined || value === null ? null : plainRecord(value, "object");
}

function arrayValues(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail(label);
  }
  const length = lengthDescriptor.value as number;
  const names = Object.keys(descriptors);
  if (length > 256 || Object.getOwnPropertySymbols(value).length > 0 || names.some((name) =>
    name !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length))) {
    fail(label);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail(label);
    result.push(descriptor.value);
  }
  return result;
}

function counter(
  source: Record<string, unknown>,
  key: string,
  maximum = MAX_USAGE_COUNTER,
): number | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail("usage counter");
  }
  return value as number;
}

/** Normalize one backend usage object without inventing cost or Claude cache fields. */
export function parseChatGptUsage(value: unknown): ChatGptUsageProjection {
  try {
    return parseChatGptUsageUnchecked(value);
  } catch (error) {
    rethrowSafe(error);
  }
}

function parseChatGptUsageUnchecked(value: unknown): ChatGptUsageProjection {
  const source = plainRecord(value, "usage payload");
  const inputTokens = counter(source, "input_tokens");
  const outputTokens = counter(source, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) fail("usage counters");
  const inputDetails = optionalRecord(source.input_tokens_details);
  const outputDetails = optionalRecord(source.output_tokens_details);
  const cachedInputTokens = (inputDetails ? counter(inputDetails, "cached_tokens") : undefined) ??
    counter(source, "cached_input_tokens");
  const reasoningTokens = (outputDetails ? counter(outputDetails, "reasoning_tokens") : undefined) ??
    counter(source, "reasoning_tokens");
  const totalTokens = counter(source, "total_tokens", MAX_TOTAL_TOKENS);
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) fail("cached token count");
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) fail("reasoning token count");
  if (totalTokens !== undefined && totalTokens !== inputTokens + outputTokens) fail("total token count");
  return {
    usage: {
      inputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    },
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function metadataString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(label);
  const trimmed = value.trim();
  if (!/^[\x20-\x7e]{1,128}$/.test(trimmed)) fail(label);
  return trimmed;
}

function resetValue(value: unknown): number | string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RESET_TIMESTAMP_MS) fail("quota reset");
    return value;
  }
  const text = metadataString(value, "quota reset");
  if (!Number.isFinite(Date.parse(text))) fail("quota reset");
  return text;
}

function window(value: unknown, label: string): ChatGptQuotaWindow {
  const source = plainRecord(value, label);
  const used = Object.hasOwn(source, "used_percent") ? source.used_percent : source.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > MAX_USED_PERCENT) {
    fail(label);
  }
  const rawReset = Object.hasOwn(source, "reset_at") ? source.reset_at : source.resetAt;
  const resetAt = resetValue(rawReset);
  const rawWindow = Object.hasOwn(source, "limit_window_seconds")
    ? source.limit_window_seconds
    : source.limitWindowSeconds;
  let limitWindowSeconds: number | undefined;
  if (rawWindow !== undefined && rawWindow !== null) {
    if (!Number.isSafeInteger(rawWindow) || Number(rawWindow) <= 0 || Number(rawWindow) > MAX_WINDOW_SECONDS) {
      fail("quota window duration");
    }
    limitWindowSeconds = rawWindow as number;
  }
  return {
    usedPercent: used,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(limitWindowSeconds === undefined ? {} : { limitWindowSeconds }),
  };
}

function normalizedRestrictionState(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function scanRestriction(value: unknown): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) fail("quota structure");
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_SCAN_STRING_BYTES) fail("quota metadata");
      return false;
    }
    if (candidate === null || typeof candidate === "number" || typeof candidate === "boolean") return false;
    if (Array.isArray(candidate)) {
      return arrayValues(candidate, "quota structure").some((item) => visit(item, depth + 1));
    }
    const source = plainRecord(candidate, "quota structure");
    const entries = Object.entries(source);
    if (entries.length > 256) fail("quota structure");
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > 128) fail("quota metadata");
      const normalizedKey = normalizedRestrictionState(key);
      if (RESTRICTION_BOOLEAN_KEYS.has(normalizedKey) && item === true) {
        return true;
      }
      if (RESTRICTION_TEXT_KEYS.has(normalizedKey) && typeof item === "string" &&
          RESTRICTION_STATES.has(normalizedRestrictionState(item))) {
        return true;
      }
      if (visit(item, depth + 1)) return true;
    }
    return false;
  };
  return visit(value, 0);
}

function optionalCredits(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CREDITS) fail("credits balance");
  return parsed;
}

/** Strict bounded projection of the account usage/quota response. */
export function parseChatGptQuota(value: unknown): ChatGptQuotaSnapshot {
  try {
    return parseChatGptQuotaUnchecked(value);
  } catch (error) {
    rethrowSafe(error);
  }
}

function parseChatGptQuotaUnchecked(value: unknown): ChatGptQuotaSnapshot {
  const source = plainRecord(value, "quota payload");
  const planType = metadataString(
    Object.hasOwn(source, "plan_type") ? source.plan_type : source.planType,
    "quota plan",
  );
  const limits = optionalRecord(source.rate_limit) ?? optionalRecord(source.rate_limits) ?? source;
  const primaryValue = Object.hasOwn(limits, "primary_window")
    ? limits.primary_window
    : Object.hasOwn(limits, "primary")
      ? limits.primary
      : source.primary_window;
  const primary = window(primaryValue, "primary quota window");
  const secondaryPresent = Object.hasOwn(limits, "secondary_window") ||
    Object.hasOwn(limits, "secondary") || Object.hasOwn(source, "secondary_window");
  const secondaryValue = Object.hasOwn(limits, "secondary_window")
    ? limits.secondary_window
    : Object.hasOwn(limits, "secondary")
      ? limits.secondary
      : source.secondary_window;
  const secondary = secondaryPresent && secondaryValue !== null
    ? window(secondaryValue, "secondary quota window")
    : undefined;
  const credits = optionalRecord(source.credits);
  const creditsRemaining = optionalCredits(
    credits
      ? Object.hasOwn(credits, "remaining") ? credits.remaining : credits.balance
      : source.credits_remaining,
  );
  const restrictionSignal = scanRestriction(source);
  const healthy = !restrictionSignal && primary.usedPercent < 100 &&
    (secondary === undefined || secondary.usedPercent < 100);
  return {
    planType,
    primary,
    ...(secondary === undefined ? {} : { secondary }),
    ...(creditsRemaining === undefined ? {} : { creditsRemaining }),
    healthy,
    restrictionSignal,
  };
}

export interface HeaderReader {
  get(name: string): string | null;
}

/** Parse a bounded Retry-After delay; malformed/unreasonable values stay unusable. */
export function retryAfterMs(
  headers: HeaderReader,
  nowMs: number = Date.now(),
): number | null {
  try {
    const raw = headers.get("retry-after");
    if (raw === null || typeof raw !== "string" || raw.length === 0 ||
        raw !== raw.trim() || raw.length > 128) return null;
    let delay: number;
    if (/^\d+$/.test(raw)) {
      const seconds = Number(raw);
      if (!Number.isSafeInteger(seconds)) return null;
      delay = seconds * 1_000;
    } else {
      const timestamp = Date.parse(raw);
      if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return null;
      delay = Math.max(0, timestamp - nowMs);
    }
    return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RETRY_AFTER_MS
      ? delay
      : null;
  } catch {
    return null;
  }
}
