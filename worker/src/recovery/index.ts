// Existing-home recovery (V6 P1 S6e · E2) — the orphaned-episode repair and
// the boot-time halt report. Both are zero-model-call reads over what is
// already on disk.
export {
  applySpaceRepair,
  deadProposals,
  orphanCensus,
  previewSpaceRepair,
  repairOnBoot,
  DEFAULT_REPAIR_LIMIT,
  REPAIR_ACTION,
  REPAIR_PASS,
  REPLAYABLE_REASON_PREFIX,
  UNPROPOSED,
  type DeadProposal,
  type OrphanCensus,
  type RepairItem,
  type RepairPlan,
  type RepairReport,
  type SpaceCounts,
} from "./space-repair.js";
export { haltReport, reportHaltOnBoot, type HaltReport } from "./halt-report.js";
