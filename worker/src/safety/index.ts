// ===========================================================================
// Safety — V6 Phase 1 S4.7. Captured content is data, never instruction.
//
//   injection.ts  the detector, the flag ledger, the card, and §10's
//                 `injection_acted` reading.
//   tool-args.ts  the world-model check on a tool argument that originated in
//                 captured text (INJ-03).
// ===========================================================================

export {
  INJECTION_ARTIFACT_KIND,
  INJECTION_SCAN_MAX_CHARS,
  INJECTION_CATEGORIES,
  detectInjection,
  injectionActed,
  instructionChannelOf,
  listInjectionFlags,
  looksLikeInjection,
  resetInjectionStore,
  scanEventsForInjection,
  surfaceInjection,
  surfaceReportedInjections,
  type CapturedEvent,
  type InjectionActedReading,
  type InjectionCategory,
  type InjectionFlag,
  type InjectionHit,
  type InstructionChannel,
  type ScanResult,
} from "./injection.js";

export {
  URL_ARG_TOOLS,
  checkToolArg,
  hostOfValueNorm,
  untrustedArgumentQuestion,
  urlProvenance,
  worldModelToolArgCheck,
  type ToolArgVerdict,
  type UrlCarrier,
  type UrlProvenance,
} from "./tool-args.js";
