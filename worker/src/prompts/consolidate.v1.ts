// ===========================================================================
// CONSOLIDATE v1 (build P1.5, spec §15.2) — the T2 space-pair judge: given two
// space cards with exemplar episodes, decide merge / keep / split. Haiku by
// default. The HARD gates live in code, not here: false_auto_merge = 0 means
// only a ≥0.9 merge verdict is auto-applied; anything less is a proposal.
// ===========================================================================

export const CONSOLIDATE_V1_ID = "consolidate.v1";

export const CONSOLIDATE_V1_SYSTEM = `You judge whether TWO spaces are the same undertaking.
Both space cards (label, goal, exemplar episodes, chapters) follow.
- merge: they are ONE goal split in two ("Goa trip" + "Goa December
  flights" tracking the same trip). Name which space should survive.
- keep: related but distinct goals stay distinct. Similar topic,
  different undertaking = keep ("Goa trip 2025" vs "Goa trip 2026").
- split: ONE of them clearly contains two unrelated goals — name it.
- confidence is YOUR belief in the verdict (0..1). A false merge
  destroys structure; when unsure, keep.
JSON only.

OUTPUT SHAPE (one JSON object, nothing else):
{"verdict":"keep","survivor":null,"split_space":null,
 "confidence":0.7,"reason":"same beach, different years"}
verdict is "merge", "keep" or "split"; survivor is the surviving space id
when verdict=merge; split_space names the overloaded space when verdict=split.`;

export interface ConsolidateVerdict {
  verdict: "merge" | "keep" | "split";
  survivor: string | null;
  splitSpace: string | null;
  confidence: number;
  reason: string | null;
  /** consolidate.v2: lifecycle outcomes alongside the verdict. */
  stateChanges: { space: string; set: "dormant" | "archived" }[];
  /** consolidate.v2: aggregated summary when evidence is folded together. */
  evidenceSummary: string | null;
  /** consolidate.v2: every event id a compressed claim still cites. */
  retainedEventIds: string[];
}

export function validateConsolidateOutput(parsed: unknown): ConsolidateVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a single JSON object with "verdict" and "confidence"');
  }
  const r = parsed as Record<string, unknown>;
  const verdictRaw = typeof r.verdict === "string" ? r.verdict : "";
  // Conservative on nonsense: an unknown verdict is a keep, never a merge.
  const verdict = verdictRaw === "merge" || verdictRaw === "split" ? verdictRaw : "keep";
  const confidence =
    typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0;
  const stateChanges: { space: string; set: "dormant" | "archived" }[] = [];
  if (Array.isArray(r.state_changes)) {
    for (const s of r.state_changes) {
      if (typeof s !== "object" || s === null) continue;
      const o = s as Record<string, unknown>;
      const space = typeof o.space === "string" && o.space !== "" ? o.space : null;
      const set = o.set === "dormant" || o.set === "archived" ? o.set : null;
      if (space && set) stateChanges.push({ space, set });
    }
  }
  return {
    verdict,
    survivor: typeof r.survivor === "string" && r.survivor !== "" ? r.survivor : null,
    splitSpace:
      typeof r.split_space === "string" && r.split_space !== "" ? r.split_space : null,
    confidence,
    reason: typeof r.reason === "string" && r.reason !== "" ? r.reason : null,
    stateChanges,
    evidenceSummary:
      typeof r.evidence_summary === "string" && r.evidence_summary !== ""
        ? r.evidence_summary
        : null,
    retainedEventIds: Array.isArray(r.retained_event_ids)
      ? r.retained_event_ids.filter((x): x is string => typeof x === "string")
      : [],
  };
}
