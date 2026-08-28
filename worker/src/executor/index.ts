// ===========================================================================
// Executor (build P3.3, spec §11.4) — public surface.
//
//   session.ts — one tool-enabled Claude Code session per task, traced,
//                budgeted, always terminating in a typed envelope.
//   tools.ts   — the tool registry + the code-level gated/approval-token
//                choke point (EXE-04). P3.4's browser tools register here.
//   schemas.ts — the seven {result_type, data} schemas, validated on emit.
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
