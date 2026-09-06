// ===========================================================================
// tier.v1 — P-07, the business split (Prompts_V6_Phase1 P-07; V6 P1 S3.8).
//
// ONE business sender, a sample of its messages, one answer: tier 2 / 3 / 4.
// Code decides everything else about a stream (did the user reply) and never
// asks the model; this prompt exists only for the split code cannot make —
// "does this business have an active relationship with the user, a past one,
// or none at all". The result is CACHED on the stream (tiers/tiering.ts) and
// re-asked only when the channel changes character.
//
// Versioned module per build convention 1.3: a changed word means tier.v2.
// ===========================================================================

export const TIER_V1_ID = "tier.v1";

/** P-07 system prompt, verbatim. */
export const TIER_V1_SYSTEM = `Classify ONE business sender from a sample of its messages. Tier 2: the user
transacts with them and they send updates (orders, OTPs, bookings, bills).
Tier 3: past interaction, no active relationship. Tier 4: marketing the user
never interacted with. Reply: {"tier":2|3|4,"reason":"…","confidence":0.0}`;

export type BusinessTier = 2 | 3 | 4;

export interface TierV1Input {
  /** The sender's display name, when known. */
  name: string | null;
  /** Sampled messages, newest first, exactly as stored. */
  sample: readonly string[];
  /** How many messages the channel holds in total. */
  totalMessages?: number;
  /** Did the user ever write into this channel (code knows; the model is told). */
  userMessages?: number;
}

export interface TierV1Result {
  tier: BusinessTier;
  reason: string;
  confidence: number;
}

export interface TierV1Parse {
  result: TierV1Result | null;
  violations: string[];
}

/** Cap on sampled lines sent — a business sender is a business sender by message ten. */
export const TIER_SAMPLE_MAX = 12;
/** Per-line cap; a bill statement does not need its footer. */
const LINE_MAX = 400;

/**
 * The variable half. Captured text sits in ONE <untrusted> block (Prompts
 * appendix): nothing in a bank's SMS is an instruction to the twin.
 */
export function packTierUser(input: TierV1Input): string {
  const lines = input.sample
    .filter((m) => typeof m === "string" && m.trim() !== "")
    .slice(0, TIER_SAMPLE_MAX)
    .map((m, i) => `${i + 1}. ${m.replace(/\s+/g, " ").trim().slice(0, LINE_MAX)}`);
  const head = [
    `BUSINESS SENDER ${input.name ?? "(unnamed)"}`,
    `${input.totalMessages ?? lines.length} messages in total · ${input.userMessages ?? 0} from the user · ${lines.length} sampled (newest first)`,
  ].join("\n");
  return `${head}\n<untrusted>\n${lines.join("\n")}\n</untrusted>`;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse one P-07 answer. Anything but a clean 2|3|4 is `null` — code then defaults (unsure → tier 2). */
export function parseTierV1(raw: string): TierV1Parse {
  const violations: string[] = [];
  const obj = extractJsonObject(raw);
  if (!obj) return { result: null, violations: ["unparseable"] };
  const tierRaw = obj.tier;
  const tier = typeof tierRaw === "number" ? tierRaw : typeof tierRaw === "string" ? Number(tierRaw) : NaN;
  if (tier !== 2 && tier !== 3 && tier !== 4) {
    violations.push(`tier-out-of-range:${String(tierRaw)}`);
    return { result: null, violations };
  }
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  if (reason === "") violations.push("missing-reason");
  let confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : NaN;
  if (Number.isNaN(confidence)) {
    violations.push("missing-confidence");
    confidence = 0.5;
  }
  confidence = Math.max(0, Math.min(1, confidence));
  return { result: { tier: tier as BusinessTier, reason, confidence }, violations };
}
