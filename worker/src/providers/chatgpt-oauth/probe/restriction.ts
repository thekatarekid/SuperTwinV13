const RESTRICTION_TEXT_RE = /captcha|flagged|suspended|restricted|rate.?limit(?:ed|.{0,20}(?:exceed|error))|quota.{0,20}(?:exceed|exhaust|error)|token.?revoked|subscription.{0,20}(?:warning|restrict|suspend)/i;
const RESTRICTION_BOOLEAN_KEY_RE = /^(?:(?:is_)?(?:limited|flagged|suspended|restricted)|captcha(?:_required)?|account_warning|token_revoked|rate_limited|limit_reached|restriction)$/i;
const STRUCTURAL_RESTRICTION_KEY_RE = /^(?:account|auth|authentication|error|errors|restriction|restrictions|security|status|warning|warnings)$/i;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_FIELDS = 128;
const MAX_INSPECTED_TEXT = 4_096;

export interface RestrictionScanOptions {
  ignoreContainerKeys?: readonly string[];
  ignoreRootArray?: boolean;
  ignoreTextKeys?: readonly string[];
  scanAllStrings?: boolean;
}

/** Inspect only bounded, allowlisted structural signals; raw values are never retained. */
export function hasBoundedRestrictionSignal(
  value: unknown,
  options: RestrictionScanOptions = {},
): boolean {
  const ignoredContainers = new Set((options.ignoreContainerKeys ?? []).map((key) => key.toLowerCase()));
  const ignoredTextKeys = new Set((options.ignoreTextKeys ?? []).map((key) => key.toLowerCase()));

  const scan = (candidate: unknown, depth: number, inspectText: boolean, root = false): boolean => {
    if (candidate === null || candidate === undefined) return false;
    if (depth > MAX_DEPTH) return true;
    if (typeof candidate === "string") {
      if (!inspectText) return false;
      return candidate.length > MAX_INSPECTED_TEXT || RESTRICTION_TEXT_RE.test(candidate);
    }
    if (typeof candidate !== "object") return false;
    if (Array.isArray(candidate)) {
      if (root && options.ignoreRootArray) return false;
      if (candidate.length > MAX_ARRAY_ITEMS) return true;
      return candidate.slice(0, MAX_ARRAY_ITEMS).some((item) => scan(item, depth + 1, inspectText));
    }

    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_FIELDS) return true;
    return entries.slice(0, MAX_OBJECT_FIELDS).some(([key, child]) => {
      const normalizedKey = key.toLowerCase();
      if (ignoredContainers.has(normalizedKey)) return false;
      if (RESTRICTION_BOOLEAN_KEY_RE.test(key) && child === true) return true;
      if (ignoredTextKeys.has(normalizedKey) && typeof child === "string") return false;
      const inspectChildText = Boolean(
        options.scanAllStrings || inspectText || STRUCTURAL_RESTRICTION_KEY_RE.test(key),
      );
      return scan(child, depth + 1, inspectChildText);
    });
  };

  return scan(value, 0, Boolean(options.scanAllStrings), true);
}
