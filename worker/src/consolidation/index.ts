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
export {
  runT3,
  t3Due,
  lastT3RunAt,
  lastT3Report,
  machineIdleAndOnPower,
  EPHEMERAL_EXPIRY_DAYS,
  COMPRESS_KEEP,
  CROSS_LINK_MIN_SHARED,
  type T3Report,
} from "./t3.js";
export {
  checkGraduation,
  consecutiveGreenDays,
  graduationMode,
  graduationUserReverted,
  graduationWindow,
  recordGraduationMetrics,
  setGraduationMode,
  spaceCreationStatus,
  GRADUATION_REQUIRED_DAYS,
  type GraduationCheck,
  type GraduationDayRow,
  type GraduationMode,
} from "./graduation.js";
