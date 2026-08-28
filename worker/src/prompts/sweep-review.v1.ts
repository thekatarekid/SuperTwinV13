// ===========================================================================
// SWEEP-REVIEW v1 (build P1.5, spec §9.2) — the Orient-style review call the
// space-birth/activation sweep makes: given ONE space and candidate episodes
// pulled by retrieval over unsorted + the log, decide which candidates belong.
// Haiku by default. Also serves the second-look queue (spec §9.5): the same
// question, asked again with the space's grown state.
// ===========================================================================

export const SWEEP_REVIEW_V1_ID = "sweep-review.v1";

export const SWEEP_REVIEW_V1_SYSTEM = `You review candidate episodes for ONE space that just became active.
The space card and each candidate episode (with its evidence) follow.
For EACH candidate decide whether it belongs to this space's goal.
- Attach only on real goal evidence: same trip, same project, same
  purchase thread. Topical similarity alone is NOT membership.
- Similar-but-different is a KEEP-OUT ("a different trip" ≠ this trip).
- When unsure, do not attach — unsorted is a good answer, not a failure.
- confidence is YOUR belief the episode belongs (0..1).
JSON only.

OUTPUT SHAPE (one JSON object, nothing else):
{"attachments":[{"episode":"ep_x","attach":true,"confidence":0.8,
  "reason":"same Goa Dec trip: dates + people match"}]}
Include EVERY candidate exactly once, attach true or false.`;

export interface SweepAttachment {
  episode: string;
  attach: boolean;
  confidence: number;
  reason?: string | null;
}

export interface SweepReviewOutput {
  attachments: SweepAttachment[];
  skipped: { entry: unknown; reason: string }[];
}

export function validateSweepReviewOutput(parsed: unknown): SweepReviewOutput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a single JSON object with an "attachments" array');
  }
  const root = parsed as Record<string, unknown>;
  const out: SweepReviewOutput = { attachments: [], skipped: [] };
  for (const a of Array.isArray(root.attachments) ? root.attachments : []) {
    const r = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
    const episode = typeof r.episode === "string" && r.episode !== "" ? r.episode : null;
    if (episode === null) {
      out.skipped.push({ entry: a, reason: "missing episode id" });
      continue;
    }
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : 0;
    out.attachments.push({
      episode,
      attach: r.attach === true,
      confidence,
      reason: typeof r.reason === "string" && r.reason !== "" ? r.reason : null,
    });
  }
  return out;
}
