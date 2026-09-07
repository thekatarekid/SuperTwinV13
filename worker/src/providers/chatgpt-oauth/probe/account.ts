import { createHash } from "node:crypto";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error("OAuth access token has an invalid JWT payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAuth access token JWT payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

/** Decode only the account-routing claim; this does not treat an unsigned decode as verification. */
export function accountIdFromAccessToken(accessToken: string): string {
  const segments = accessToken.split(".");
  if (segments.length !== 3 || !segments[1]) throw new Error("OAuth access token is not a JWT");
  const claims = decodeBase64UrlJson(segments[1]);
  const auth = claims[OPENAI_AUTH_CLAIM];
  const accountId =
    auth && typeof auth === "object" && !Array.isArray(auth)
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("OAuth access token is missing chatgpt_account_id");
  }
  return accountId;
}

export function accountFingerprint(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
}
