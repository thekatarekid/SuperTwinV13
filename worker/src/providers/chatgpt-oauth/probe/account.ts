import { createHash, timingSafeEqual } from "node:crypto";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
export const EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV =
  "SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT";

export interface DedicatedProbeAccount {
  /** Kept in process memory solely for the required routing header. Never log this. */
  accountId: string;
  fingerprint: string;
}

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

/** Bind a decoded OAuth account to the dedicated test account selected out of band. */
export function assertExpectedProbeAccount(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): DedicatedProbeAccount {
  // Decode first so comparison is always against the account actually represented by the token.
  const accountId = accountIdFromAccessToken(accessToken);
  const actual = accountFingerprint(accountId);
  const configured = env[EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]?.trim().toLowerCase();
  if (!configured || !/^[a-f0-9]{12}$/.test(configured)) {
    throw new Error(
      `REFUSED: ${EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV} must be the dedicated test account's 12-hex fingerprint`,
    );
  }
  if (!timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(configured, "ascii"))) {
    throw new Error("REFUSED: authenticated ChatGPT account is not the dedicated Phase 0b test account");
  }
  return { accountId, fingerprint: actual };
}
