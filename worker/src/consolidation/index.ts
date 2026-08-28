// ===========================================================================
// Consolidation (build P1.5, spec §15) — barrel.
//
//   T1 inline lives with the Critic (Lane A); here: the space-activation
//   sweep, the T2 job (flags + hourly roll: merge/split/dormancy, second-look,
//   unsorted review), decision reversal, and the boot-wired job.
// ===========================================================================

export { startConsolidationJob, type ConsolidationJobHandle } from "./job.js";
export { sweepSpaceOnActivation, sweepCandidates, unsweptActiveSpaces, attachEpisode, sweepDone } from "./sweep.js";
export { runT2, mergeSpaces, applyDormancy, reviewUnsorted, AUTO_MERGE_FLOOR, type T2Report } from "./t2.js";
export { reverseDecision } from "./reversal.js";
