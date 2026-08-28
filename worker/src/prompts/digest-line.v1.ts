// ===========================================================================
// digest-line.v1 — the content-economy digest call (build P1.2, spec §4.5.1).
//
// One haiku-class call per UNIQUE content-hash, cached forever. Code computes
// title/domain/token_count/content_ref; the model supplies the judgment half:
// doc_type, key_entities, gist ≤25 words. Changing this prompt = new version
// module + eval run (build convention 3).
// ===========================================================================

export const DIGEST_LINE_V1 = {
  pass: "digest-line.v1",
  version: 1,
  system: `You write ONE structured digest line for a captured page or screen.
Given the content, answer with strict JSON only:
{"doc_type":"article|listing|form|chat|code|dashboard|email|doc|video|social|other",
 "key_entities":["up to 8 proper nouns / products / people / places"],
 "gist":"what this content IS and says, 25 words or fewer"}
Rules: the gist is factual, specific, and never speculative. key_entities are
verbatim from the content. No prose outside the JSON object.`,
} as const;
