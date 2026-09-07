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

function restrictionSignal(source: Record<string, unknown>): boolean {
  const candidates = [
    source.status,
    source.account_status,
    source.warning,
    source.error,
    record(source.error)?.code,
    record(source.error)?.message,
  ];
  return candidates.some((value) => typeof value === "string" &&
    /captcha|flagged|suspended|restricted|rate.?limit(?:ed)?|quota.?exceeded|token.?revoked|subscription.?warning/i.test(value));
}

export function parseProbeQuota(payload: unknown): ProbeQuotaEvidence {
  const source = record(payload);
  if (!source) throw new Error("Quota response is not an object");
  const plan = source.plan_type ?? source.planType;
  if (typeof plan !== "string" || !plan.trim()) throw new Error("Quota response is missing plan_type");
  const limits = record(source.rate_limit) ?? record(source.rate_limits) ?? source;
  const primary = windowFrom(limits.primary_window ?? limits.primary ?? source.primary_window);
  if (!primary) throw new Error("Quota response is missing a valid primary window");
  const secondary = windowFrom(limits.secondary_window ?? limits.secondary ?? source.secondary_window);
  const credits = record(source.credits);
  const creditsRemainingCandidate = credits?.remaining ?? credits?.balance ?? source.credits_remaining;
  const creditsRemaining = typeof creditsRemainingCandidate === "number" &&
    Number.isFinite(creditsRemainingCandidate) && creditsRemainingCandidate >= 0
    ? creditsRemainingCandidate
    : undefined;
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
  return {
    healthyAtStart: true,
    healthyAtEnd: true,
    primaryUsedPercentDelta: end.primary.usedPercent - start.primary.usedPercent,
    ...(start.secondary && end.secondary
      ? { secondaryUsedPercentDelta: end.secondary.usedPercent - start.secondary.usedPercent }
      : {}),
  };
}
