// ===========================================================================
// critic.v3 — the CRITIC pass prompt (Phase 1 gate remediation, round 2b).
//
// The spec §8.2 core is UNCHANGED (verbatim via v1). v3 = v2 plus the
// downgrade/reject boundary the r5 run blurred (CRI-02): content that does
// not belong in its target space DOWNGRADES to unsorted citing the
// mismatch; reject is reserved for fabrication and invalid writes. The
// verdict vocabulary and JSON shape stay byte-compatible with v1.
// ===========================================================================

import { CRITIC_V1_CORE } from "./critic.v1.js";

export { CRITIC_V1_CORE as CRITIC_V3_CORE };

/** The output schema block — v1 shape, sharpened verdict guidance. */
export const CRITIC_V3_SCHEMA = `Schema:
{"verdicts":[{"item":<1-based item number from the input>,
  "verdict":"commit"|"reject"|"downgrade_to_unsorted"|"flag_overlap",
  "reason":"<required for reject>",
  "space_id":"<required for flag_overlap>"}]}
Every numbered item gets exactly one verdict.
Verdict discipline:
- An item with a verbatim quote, sane confidence and a matching target
  COMMITS. You gate fabrication and contamination — you do not block
  sound writes for stylistic taste. Blocking everything is as useless
  as blocking nothing.
- When a CORRECT write also half-fits another space in view, the
  verdict is "flag_overlap" with that other space's id — the write
  still commits and the flag queues a Tier-2 review immediately.
  Never silently commit past a visible overlap; never reject for it.
- DOWNGRADE vs REJECT: an episode whose CONTENT does not match its
  target space (lunch plans filed into a work project) is
  "downgrade_to_unsorted" — cite the evidence mismatch. "reject" is
  reserved for fabrication (quote not in the cited events) and
  structurally invalid writes.
- A rejection's reason NAMES THE SPECIFIC RULE violated (e.g. 'label
  rule: 4-8 specific words — "Travel" is one generic word'). You never
  rewrite: no corrected label, no suggested replacement content.`;

export const CRITIC_V3 = {
  pass: "critic.v3",
  version: 3,
  system: `${CRITIC_V1_CORE}\n\n${CRITIC_V3_SCHEMA}`,
} as const;
