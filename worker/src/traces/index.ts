// Trace store public surface (build P0.7). One import for call sites:
//   withTraceContext / annotateTrace / bindTraceContext  — open + enrich scopes
//   assertTraceContext / recordProviderInvocation        — the provider's hooks
//   writeTrace / tracesRoot / ensureTracesSchema         — storage
//   compressOldTraces / startTraceRetentionJob           — 30-day retention

export {
  GhostCallError,
  annotateTrace,
  assertTraceContext,
  bindTraceContext,
  hasTraceContext,
  pendingTraceRecords,
  recordProviderInvocation,
  withTraceContext,
  type ProviderInvocation,
  type TraceAnnotations,
  type TraceMeta,
} from "./context.js";

export {
  dayFilePath,
  dayOf,
  ensureTracesSchema,
  indexedTraceIdFor,
  tracesRoot,
  usageToTokens4Way,
  writeTrace,
  writeTraceIndexRow,
  type CompressedField,
  type Tokens4Way,
  type TraceRecord,
} from "./store.js";

export {
  compressOldTraces,
  startTraceRetentionJob,
  type RetentionJobHandle,
  type RetentionOptions,
  type RetentionStats,
} from "./retention.js";
