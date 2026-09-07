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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function windowFrom(value: unknown): ProbeQuotaWindow | undefined {
  const source = record(value);
  if (!source) return undefined;
  const used = source.used_percent ?? source.usedPercent;
  const reset = source.reset_at ?? source.resetAt;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  if (!(typeof reset === "number" && Number.isFinite(reset) && reset > 0) &&
      !(typeof reset === "string" && reset.trim())) return undefined;
  return { usedPercent: used, resetAt: reset as number | string };
}

const RESTRICTION_TEXT_RE = /captcha|flagged|suspended|restricted|rate.?limit(?:ed|.{0,20}(?:exceed|error))|quota.{0,20}(?:exceed|exhaust|error)|token.?revoked|subscription.{0,20}(?:warning|restrict|suspend)/i;
const RESTRICTION_BOOLEAN_KEY_RE = /^(?:(?:is_)?(?:limited|flagged|suspended|restricted)|captcha(?:_required)?|account_warning|token_revoked|rate_limited|limit_reached|restriction)$/i;

function restrictionSignal(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof value === "string") return value.length <= 4_096 && RESTRICTION_TEXT_RE.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.slice(0, 32).some((item) => restrictionSignal(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).slice(0, 128).some(([key, item]) =>
    (RESTRICTION_BOOLEAN_KEY_RE.test(key) && item === true) || restrictionSignal(item, depth + 1),
  );
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Quota response has invalid ${label}`);
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
  const plan = source.plan_type ?? source.planType;
  if (typeof plan !== "string" || !plan.trim()) throw new Error("Quota response is missing plan_type");
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
  const restricted = restrictionSignal(source);
  const healthy = !restricted && primary.usedPercent < 100 &&
    (secondary === undefined || secondary.usedPercent < 100);
  return {
    planType: plan.trim(),
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
