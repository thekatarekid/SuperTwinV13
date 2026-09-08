import { hasBoundedRestrictionSignal } from "./restriction.js";

export interface ProbeQuotaWindow {
  usedPercent: number;
  resetAt: number | string;
}

export interface ProbeQuotaEvidence {
  planType: string;
  primary: ProbeQuotaWindow;
  secondary?: ProbeQuotaWindow;
  creditsRemaining?: number;
  healthy: boolean;
  restrictionSignal: boolean;
}

export interface ProbeQuotaComparison {
  healthyAtStart: boolean;
  healthyAtEnd: boolean;
  primaryUsedPercentDelta: number;
  secondaryUsedPercentDelta?: number;
}

const MAX_USED_PERCENT = 1_000;
const MAX_RESET_TIMESTAMP = 253_402_300_799_000;
const MAX_CREDITS_REMAINING = 1_000_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[\x20-\x7e]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

function windowFrom(value: unknown): ProbeQuotaWindow | undefined {
  const source = record(value);
  if (!source) return undefined;
  const used = source.used_percent ?? source.usedPercent;
  const reset = source.reset_at ?? source.resetAt;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > MAX_USED_PERCENT) {
    return undefined;
  }
  const safeReset = typeof reset === "number" && Number.isSafeInteger(reset) &&
      reset > 0 && reset <= MAX_RESET_TIMESTAMP
    ? reset
    : boundedMetadataString(reset);
  if (safeReset === undefined) return undefined;
  return { usedPercent: used, resetAt: safeReset };
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CREDITS_REMAINING) {
    throw new Error(`Quota response has invalid ${label}`);
  }
  return parsed;
}

function firstPresent(
  candidates: Array<[Record<string, unknown>, string]>,
): { present: boolean; value?: unknown } {
  for (const [source, key] of candidates) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return { present: true, value: source[key] };
  }
  return { present: false };
}

export function parseProbeQuota(payload: unknown): ProbeQuotaEvidence {
  const source = record(payload);
  if (!source) throw new Error("Quota response is not an object");
  const plan = boundedMetadataString(source.plan_type ?? source.planType);
  if (!plan) throw new Error("Quota response is missing a bounded plan_type");
  const limits = record(source.rate_limit) ?? record(source.rate_limits) ?? source;
  const primary = windowFrom(limits.primary_window ?? limits.primary ?? source.primary_window);
  if (!primary) throw new Error("Quota response is missing a valid primary window");
  const secondaryCandidate = firstPresent([
    [limits, "secondary_window"],
    [limits, "secondary"],
    [source, "secondary_window"],
  ]);
  const secondary = windowFrom(secondaryCandidate.value);
  if (secondaryCandidate.present && !secondary) {
    throw new Error("Quota response has an invalid secondary window");
  }
  const credits = record(source.credits);
  const creditsRemainingCandidate = credits?.remaining ?? credits?.balance ?? source.credits_remaining;
  const creditsRemaining = optionalNonNegativeNumber(creditsRemainingCandidate, "credits balance");
  const restricted = hasBoundedRestrictionSignal(source, { scanAllStrings: true });
  const healthy = !restricted && primary.usedPercent < 100 &&
    (secondary === undefined || secondary.usedPercent < 100);
  return {
    planType: plan,
    primary,
    ...(secondary ? { secondary } : {}),
    ...(creditsRemaining === undefined ? {} : { creditsRemaining }),
    healthy,
    restrictionSignal: restricted,
  };
}

export function compareProbeQuota(
  start: ProbeQuotaEvidence,
  end: ProbeQuotaEvidence,
): ProbeQuotaComparison {
  if (start.planType !== end.planType) throw new Error("Quota plan type changed during Phase 0b");
  if (!start.healthy || !end.healthy) throw new Error("Phase 0b account is quota-limited or restricted");
  if (Boolean(start.secondary) !== Boolean(end.secondary)) {
    throw new Error("Quota secondary window changed shape during Phase 0b");
  }
  return {
    healthyAtStart: true,
    healthyAtEnd: true,
    primaryUsedPercentDelta: end.primary.usedPercent - start.primary.usedPercent,
    ...(start.secondary && end.secondary
      ? { secondaryUsedPercentDelta: end.secondary.usedPercent - start.secondary.usedPercent }
      : {}),
  };
}
