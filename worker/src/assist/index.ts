// ===========================================================================
// worker/src/assist — the assist lane (build P2.2, spec §10).
//
// Trigger gate IN CODE (gate.ts) -> one haiku evaluator (evaluator.ts) ->
// executor-lite with a risk-free tool table (executor-lite.ts) -> durable
// artifact + nudge (artifacts.ts). watcher.ts is the production loop over
// the event-log tail; index.ts (worker boot) starts it.
// ===========================================================================

export {
  gateVerdict,
  noteDismissed,
  noteNudged,
  noteReopened,
  readTopic,
  readyTopics,
  recordEvent,
  topicCategory,
  topicKeyFor,
  type GateVerdict,
  type RecordOutcome,
  type TopicState,
} from "./gate.js";
export {
  isActionable,
  packAssistInput,
  parseAssistEvaluation,
  runAssistEvaluator,
  type AssistEvaluation,
} from "./evaluator.js";
export {
  ASSIST_TOOL_TABLE,
  MAX_STEPS,
  RISKY_TOOL_NAME_PATTERNS,
  runExecutorLite,
  urlsInAction,
  type ExecutorLiteResult,
} from "./executor-lite.js";
export {
  contentKeyFor,
  createArtifact,
  expireMomentBound,
  getArtifact,
  graduateArtifact,
  latestUnseen,
  listArtifacts,
  markNudged,
  recordSignal,
  setArtifactStatus,
  signalScore,
  SIGNAL_WEIGHTS,
  type ArtifactRow,
  type ArtifactStatus,
} from "./artifacts.js";
export {
  assistTick,
  ASSIST_TICK_INTERVAL_MS,
  readAssistCursor,
  startAssistLane,
  writeAssistCursor,
  type AssistLaneHandle,
  type AssistTickReport,
} from "./watcher.js";
export {
  assistThreshold,
  getAssistEnabled,
  getCapturePausedUntil,
  inQuietHours,
  isCapturePaused,
  setAssistEnabled,
  setAssistThreshold,
  setCapturePausedUntil,
} from "./settings.js";
