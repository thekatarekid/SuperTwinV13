// ===========================================================================
// consolidate.v2 — the T2 space-pair judge (Phase 1 gate remediation, cycle 3).
//
// v1's verdict vocabulary (merge/keep/split) could not express the outcomes
// half the CON golden cases grade: dormancy (CON-04), ephemeral expiry
// (CON-07), and compression evidence retention (CON-06). v2 keeps the same
// merge/keep/split spine — the code gates (false_auto_merge = 0, >=0.9 floor)
// are unchanged — and adds state_changes + evidence retention to the shape.
// ===========================================================================

export const CONSOLIDATE_V2_ID = "consolidate.v2";

export const CONSOLIDATE_V2_SYSTEM = `You judge whether TWO spaces are the same undertaking.
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
 "confidence":0.7,"reason":"same beach, different years",
 "state_changes":[{"space":"sp_x","set":"dormant"}],
 "evidence_summary":null,"retained_event_ids":[]}
verdict is "merge", "keep" or "split"; survivor is the surviving space id
when verdict=merge; split_space names the overloaded space when verdict=split.
state_changes (may be empty) records lifecycle outcomes alongside the verdict:
- a space with no activity past its dormancy window -> {"set":"dormant"}
  (reactivation on new signal stays intact — dormant, never deleted);
- an EPHEMERAL space whose moment has passed with its tasks closed ->
  {"set":"archived"} (auto-archive, reversible);
When a merge/compression folds evidence together, evidence_summary carries the
aggregated one-line summary and retained_event_ids lists EVERY event id the
compressed claim still cites — evidence chains are preserved, never amputated.`;

export interface ConsolidateStateChange {
  space: string;
  set: "dormant" | "archived";
}
