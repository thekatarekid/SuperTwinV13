// ===========================================================================
// Executor (build P3.3, spec §11.4) — public surface.
//
//   session.ts — one tool-enabled Claude Code session per task, traced,
//                budgeted, always terminating in a typed envelope.
//   tools.ts   — the tool registry + the code-level gated/approval-token
//                choke point (EXE-04). P3.4's browser tools register here.
//   schemas.ts — the seven {result_type, data} schemas, validated on emit.
//   lite.ts    — executor-lite (V6 P1 S4.2): the bounded 3-8 turn loop over
//                web_fetch / world_read / world_write_draft that finishes ONE
//                prepared action from the live pass, with its cycle and money
//                ceilings enforced as refusals and recorded in the trace.
//
// Approval tokens themselves live in ../approvals/tokens.ts (P0.6); the mint
// route is POST /api/approvals/mint (server/whatsapp-routes.ts), wired to the
// approval modal in P3.5.
// ===========================================================================

export {
  runExecutorTask,
  parseEnvelope,
  bestPartialEnvelope,
  packTaskContext,
  taskStatusFor,
  type ExecutorEnvelope,
  type ExecutorRunDeps,
  type ExecutorRunResult,
  type EnvelopeStatus,
  type AttemptEntry,
  type TaskRow,
} from "./session.js";

export {
  ToolRegistry,
  defaultToolRegistry,
  invokeTool,
  taskWorkspaceDir,
  GatedToolRefusedError,
  GATED_ONLY_NAME_PATTERNS,
  type ExecutorTool,
  type ToolContext,
  type ToolInvocation,
  type ToolRisk,
} from "./tools.js";

export {
  LITE_ARTIFACT_TYPES,
  LITE_FETCH_MAX_BYTES,
  LITE_FETCH_TIMEOUT_MS,
  LITE_STATUSES,
  LITE_TOOL_NAMES,
  LOGIN_STATUSES,
  REQUIRED_INPUTS,
  TRANSIENT_STATUSES,
  askCombinedQuestion,
  groundArtifact,
  liteGaps,
  liteToolRegistry,
  liteWorkspaceDir,
  normaliseUrl,
  packPreparedAction,
  parseArtifact,
  parseLiteOutput,
  questionLine,
  runPreparedAction,
  runPreparedQueue,
  type FetchRecord,
  type LiteArtifact,
  type LiteArtifactType,
  type LiteCitation,
  type LiteGap,
  type LiteOutput,
  type LiteRefusal,
  type LiteRunDeps,
  type LiteRunResult,
  type LiteStatus,
} from "./lite.js";

export {
  DEFAULT_LITE_BUDGET,
  LITE_MAX_TURNS,
  LITE_MIN_TURNS,
  LITE_V1,
  clampLiteBudget,
  liteSystemPrompt,
  type LiteBudget,
} from "../prompts/lite.v1.js";

export {
  RESULT_TYPES,
  RESULT_SCHEMAS,
  validateResult,
  emitResult,
  isResultType,
  ResultSchemaError,
  type ExecutorResult,
  type ResultType,
} from "./schemas.js";

export {
  EXECUTOR_V1,
  EXECUTOR_V1_CORE,
  executorSystemPrompt,
  DEFAULT_EXECUTOR_BUDGET,
  type ExecutorBudget,
} from "../prompts/executor.v1.js";
