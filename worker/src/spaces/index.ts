// ===========================================================================
// Spaces (V6 P1 S5.1, Product_V6_Phase1 §13) — barrel.
//
//   birth       asked-for birth (instant, deduped, never proposed), woken
//               birth (dormant → active with old evidence), the sweep preview.
//   unsorted    the weekly review on change only (+ cadence helpers).
//   enrichment  content-hash ledger — the model sees a change only.
//   refile      the drag — a space into a life area, an episode into a space
//               (or back out to unsorted). One decisions row, no model call.
//   view        the list by life area and the per-space view with why-targets.
//   life-areas  the fourteen default areas.
// ===========================================================================

export {
  barLabel,
  bornAsked,
  wakeSpace,
  sweepPreview,
  resetSweepMarker,
  type AskedBirthInput,
  type AskedBirthOutcome,
  type BirthEvidence,
  type BirthMode,
  type SweepPreview,
  type WakeInput,
  type WakeOutcome,
} from "./birth.js";
export {
  reviewUnsortedWeekly,
  changedUnsortedSince,
  unsortedCandidatesFor,
  unsortedReviewDue,
  UNSORTED_LAST_REVIEW_KEY,
  UNSORTED_REVIEW_INTERVAL_MS,
  type UnsortedReviewReport,
} from "./unsorted.js";
export {
  recordEnrichmentFetch,
  refreshEnrichments,
  enrichmentsFor,
  contentHash,
  type EnrichmentInput,
  type EnrichmentOutcome,
  type EnrichmentRow,
  type Fetcher,
} from "./enrichment.js";
export { refileEpisode, refileSpace, isLifeArea, type RefileOutcome } from "./refile.js";
export { spacesList, spaceView, type SpacesList, type SpaceListRow, type SpaceView } from "./view.js";
export { LIFE_AREAS, OTHER_AREA, normalizeLifeArea, lifeAreaRank, type LifeArea } from "./life-areas.js";
