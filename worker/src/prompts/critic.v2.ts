// ===========================================================================
// critic.v2 — the CRITIC pass prompt (Phase 1 gate remediation, round 2).
//
// The spec §8.2 core is UNCHANGED (verbatim via v1). v2 sharpens the schema
// guidance for the three CRI failure modes r4 still showed: well-evidenced
// writes commit without nitpicking (CRI-04 paranoid-gate), an overlap in
// view is FLAGGED alongside the commit rather than silently passed (CRI-05
// silent-flag), and a rejection cites the specific rule violated without
// proposing replacement content (CRI-06). The verdict vocabulary and JSON
// shape are byte-compatible with v1 — parseCriticOutput is unchanged.
// ===========================================================================

import { CRITIC_V1_CORE } from "./critic.v1.js";

export { CRITIC_V1_CORE as CRITIC_V2_CORE };

/** The output schema block — v1 shape, sharpened verdict guidance. */
export const CRITIC_V2_SCHEMA = `Schema:
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
- A rejection's reason NAMES THE SPECIFIC RULE violated (e.g. 'label
  rule: 4-8 specific words — "Travel" is one generic word'). You never
  rewrite: no corrected label, no suggested replacement content.`;

export const CRITIC_V2 = {
  pass: "critic.v2",
  version: 2,
  system: `${CRITIC_V1_CORE}\n\n${CRITIC_V2_SCHEMA}`,
} as const;
