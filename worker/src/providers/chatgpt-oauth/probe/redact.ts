const SENSITIVE_KEY = /(?:access|refresh|id)_?token|authorization|account(?:_|-)?id|device_auth_id|code_verifier|previous_response_id|response_?id/i;

export const REDACTED = "<redacted>";

export function redactProbeValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactProbeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactProbeValue(child, childKey),
      ]),
    );
  }
  if (typeof value === "string" && /^Bearer\s+/i.test(value)) return "Bearer <redacted>";
  return value;
}

export function redactedJson(value: unknown): string {
  return JSON.stringify(redactProbeValue(value), null, 2);
}
