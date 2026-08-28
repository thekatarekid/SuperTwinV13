// ===========================================================================
// Brain folder module. The markdown wiki that used to be written here is gone
// (V2 §3.2): a file tree is a single hierarchy, a life is a graph, and one
// entity legitimately belongs in six places — it was also a second source of
// truth. What is left is the FOLDER: the cwd a grounded run is given, and the
// debug-export path.
//
// `handleBrainRoute` is NOT part of the default router. server/index.ts mounts
// it only when `settings.debug_export` is on (db/settings.ts).
// ===========================================================================

export { brainRoot, commitBrain, ensureBrain, resetBrainCacheForTests } from "./root.js";
export { handleBrainRoute } from "./routes.js";

// ---- The V13 understanding lane (build P1.3) -------------------------------
export {
  runJsonPass,
  modelForPass,
  stableSystemPrompt,
  DEFAULT_PASS_MODEL,
  type JsonPassDeps,
  type JsonPassResult,
  type JsonPassSpec,
} from "./llm.js";
export {
  runOrient,
  parseOrientOutput,
  resolveEventAliases,
  type OrientOutput,
  type OrientRun,
} from "./orient.js";
export {
  runCritic,
  parseCriticOutput,
  buildCriticInput,
  verdictFor,
  type CriticOutput,
  type CriticVerdict,
} from "./critic.js";
export {
  commitTick,
  proposedStatus,
  SECOND_LOOK_MIN,
  SECOND_LOOK_MAX,
  type CommitInput,
  type CommitReport,
} from "./commit.js";
export {
  runBrainTick,
  startBrainConsumer,
  type BrainConsumer,
  type TickReport,
} from "./consumer.js";
