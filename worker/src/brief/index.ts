// ===========================================================================
// The brief lane (V6 P1 S4.6) — one card at each set time, composed by code,
// phrased by one brief.v2 call, and only when the world model moved.
// ===========================================================================

export { BRIEF_CHANGE_SOURCES, briefDeltaSince, type BriefDelta } from "./delta.js";
export {
  BRIEF_PARTS,
  PART_CAP,
  PART_LABELS,
  composeLedger,
  ledgerIsEmpty,
  ledgerItemCount,
  packBriefV2User,
  renderLedgerFallback,
  type BriefItem,
  type BriefLedger,
  type BriefPart,
} from "./ledger.js";
export {
  BRIEF_TIMES_KEY,
  DEFAULT_BRIEF_TIMES,
  SLOT_GRACE_MS,
  briefTimes,
  dueSlot,
  normaliseTime,
  slotInstantMs,
  slotKey,
  type DueSlot,
} from "./schedule.js";
export {
  BRIEF_LAST_SLOT_KEY,
  getBrief,
  insertBrief,
  lastBriefAt,
  lastSlot,
  latestBrief,
  listBriefs,
  markBriefSeen,
  setLastSlot,
  type BriefRow,
} from "./store.js";
export {
  BRIEF_STEP,
  briefTick,
  readBriefTimes,
  runBrief,
  type BriefReport,
  type BriefTickReport,
} from "./run.js";
export { BRIEF_TICK_INTERVAL_MS, startBriefJob, type BriefJob } from "./job.js";
