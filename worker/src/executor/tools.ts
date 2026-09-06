// ===========================================================================
// Executor tool registry (build P3.3, spec §11.4 item 3, §2.13).
//
// The registry is the executor's COMPLETE capability surface and its single
// enforcement choke point. Every tool an executor session may call is a row
// here; every invocation — however it arrives (local dispatch today, the P3.4
// browser MCP server tomorrow) — goes through invokeTool(), where the risky
// gate lives IN CODE:
//
//   - risk "safe"  → runs. Read/compose only; a safe tool whose NAME matches
//     a risky pattern cannot even be REGISTERED (throws at registration).
//   - risk "gated" → runs ONLY after atomically consuming a minted, unused,
//     unexpired single-use approval token for its declared action
//     (worker/src/approvals/tokens.ts). No token, no handler call —
//     GatedToolRefusedError before any side effect. This is the EXE-04 /
//     risky_without_token=0 enforcement point; the prompt's rule 4 is only
//     defense in depth.
//
// Registered now: world-model read + drafts + files (P3.3). P3.4's browser
// tools slot into the same registry — its payment-class steps register as
// "gated" and inherit the token gate with zero new mechanism.
// ===========================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

import { getDb } from "../db/connection.js";
import { homeRoot } from "../home.js";
import { consumeApprovalToken } from "../approvals/tokens.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** The task this session executes. */
  taskId: string;
  /** Per-task scratch dir; files/drafts tools stay inside it. */
  workspaceDir: string;
  /** Single-use token supplied by an approval (P3.5 modal → mint route). */
  approvalToken?: string;
  nowMs?: number;
}

export type ToolRisk = "safe" | "gated";

export interface ExecutorTool {
  name: string;
  description: string;
  risk: ToolRisk;
  /** Approval-token action a gated tool consumes (e.g. "browser.payment"). */
  gatedAction?: string;
  handler: (input: string, ctx: ToolContext) => Promise<string>;
}

export interface ToolInvocation {
  tool: string;
  input: string;
  status: "ok" | "refused" | "error";
  /** Set on refused/error. */
  detail?: string;
  at: string;
}

/** Thrown when a gated tool is invoked without a valid single-use token. */
export class GatedToolRefusedError extends Error {
  constructor(tool: string, action: string) {
    super(
      `gated tool "${tool}" refused: no valid unused approval token for action "${action}" ` +
        `(risky steps execute only on approval — spec §11.4)`,
    );
    this.name = "GatedToolRefusedError";
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Tool NAMES that may never be registered as risk "safe". Kept in code next
 * to the registry so the EXE-04 assertion and the capability surface evolve
 * together (the posture the retired assist lane's risky-name patterns held).
 */
export const GATED_ONLY_NAME_PATTERNS: readonly RegExp[] = [
  /send/i,
  /pay/i,
  /purchase/i,
  /book/i,
  /order/i,
  /transfer/i,
  /checkout/i,
  /submit/i,
  /whatsapp/i,
  /email/i,
  /post/i,
  /delete/i,
  /account/i,
];

export class ToolRegistry {
  private readonly tools = new Map<string, ExecutorTool>();

  register(tool: ExecutorTool): void {
    if (!tool.name.trim()) throw new Error("tool name required");
    if (tool.risk === "gated" && !tool.gatedAction?.trim()) {
      throw new Error(`gated tool "${tool.name}" must declare gatedAction`);
    }
    if (tool.risk === "safe") {
      const hit = GATED_ONLY_NAME_PATTERNS.find((p) => p.test(tool.name));
      if (hit) {
        throw new Error(
          `tool "${tool.name}" matches risky pattern ${hit} and cannot be ` +
            `registered as risk "safe" — declare it "gated" with a gatedAction`,
        );
      }
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ExecutorTool | undefined {
    return this.tools.get(name);
  }

  list(): ExecutorTool[] {
    return [...this.tools.values()];
  }

  /** Names for the CLI --allowedTools whitelist. */
  allowedToolNames(): string[] {
    return [...this.tools.keys()];
  }
}

// ---------------------------------------------------------------------------
// invokeTool — the single choke point
// ---------------------------------------------------------------------------

/**
 * Invoke one tool by name. The gated check happens HERE, before the handler:
 * a gated tool without a consumable token throws GatedToolRefusedError and
 * its handler is never entered. Token consumption is the atomic single-use
 * UPDATE in approvals/tokens.ts, so a token authorizes at most one invocation
 * even under races.
 */
export async function invokeTool(
  registry: ToolRegistry,
  name: string,
  input: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`unknown tool "${name}" (not in the executor registry)`);
  if (tool.risk === "gated") {
    const action = tool.gatedAction!;
    const ok =
      typeof ctx.approvalToken === "string" &&
      ctx.approvalToken !== "" &&
      consumeApprovalToken(ctx.approvalToken, action, { nowMs: ctx.nowMs });
    if (!ok) throw new GatedToolRefusedError(name, action);
  }
  return tool.handler(input, ctx);
}

// ---------------------------------------------------------------------------
// The P3.3 tools: world-model read + drafts + files
// ---------------------------------------------------------------------------

/** Per-task workspace under <home>/executor/<taskId>/ (created on demand). */
export function taskWorkspaceDir(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(homeRoot(), "executor", safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a relative path INSIDE the workspace; escapes are refused. */
function insideWorkspace(workspaceDir: string, rel: string): string {
  const abs = resolve(workspaceDir, normalize(rel));
  const root = resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path "${rel}" escapes the task workspace`);
  }
  return abs;
}

async function worldModelRead(input: string, ctx: ToolContext): Promise<string> {
  const db = getDb();
  const q = `%${input.trim()}%`;
  const spaces = db
    .prepare(
      `SELECT id, label, goal, status FROM spaces
       WHERE status != 'archived' AND (label LIKE ? OR goal LIKE ? OR ? = '%%')
       ORDER BY updated_at DESC, created_at DESC LIMIT 6`,
    )
    .all(q, q, q) as { id: string; label: string; goal: string | null; status: string }[];
  const tasks = db
    .prepare(
      `SELECT id, title, status, due FROM tasks
       WHERE status IN ('open','scheduled','executing','needs_input','needs_approval')
         AND (title LIKE ? OR id = ? OR ? = '%%') LIMIT 8`,
    )
    .all(q, ctx.taskId, q) as { id: string; title: string; status: string; due: string | null }[];
  let claims: { id: string; text: string }[] = [];
  try {
    claims = db
      .prepare(
        `SELECT claim_id AS id, text FROM claims_active WHERE text LIKE ? LIMIT 8`,
      )
      .all(q) as { id: string; text: string }[];
  } catch {
    claims = []; // claims_active view absent in a minimal test db
  }
  return [
    ...spaces.map((s) => `space ${s.id} [${s.status}] "${s.label}"${s.goal ? ` — ${s.goal}` : ""}`),
    ...tasks.map((t) => `task ${t.id} [${t.status}] "${t.title}"${t.due ? ` due ${t.due}` : ""}`),
    ...claims.map((c) => `claim ${c.id}: ${c.text}`),
  ].join("\n");
}

async function draftSave(input: string, ctx: ToolContext): Promise<string> {
  // A draft is TEXT in the workspace — composing is safe; SENDING it is a
  // separate gated action that does not exist in this tool.
  const dir = join(ctx.workspaceDir, "drafts");
  mkdirSync(dir, { recursive: true });
  const name = `draft-${Date.now()}.md`;
  const path = join(dir, name);
  writeFileSync(path, input, "utf8");
  return `draft saved: drafts/${name}`;
}

async function fileRead(input: string, ctx: ToolContext): Promise<string> {
  const abs = insideWorkspace(ctx.workspaceDir, input.trim());
  return readFileSync(abs, "utf8");
}

async function fileWrite(input: string, ctx: ToolContext): Promise<string> {
  // Input convention: first line = relative path, rest = content.
  const nl = input.indexOf("\n");
  if (nl < 0) throw new Error(`file_save: input must be "<relative path>\\n<content>"`);
  const rel = input.slice(0, nl).trim();
  const abs = insideWorkspace(ctx.workspaceDir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, input.slice(nl + 1), "utf8");
  return `file saved: ${rel}`;
}

/** Build the default P3.3 registry. P3.4 registers browser tools onto it. */
export function defaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "world_model_read",
    description:
      "Read-only world-model slices: active spaces, open tasks, active claims matching a query.",
    risk: "safe",
    handler: worldModelRead,
  });
  registry.register({
    name: "draft_save",
    description:
      "Save composed draft text into the task workspace. Drafts are never sent by this tool.",
    risk: "safe",
    handler: draftSave,
  });
  registry.register({
    name: "file_read",
    description: "Read a file inside the task workspace (relative path).",
    risk: "safe",
    handler: fileRead,
  });
  registry.register({
    name: "file_save",
    description:
      'Save a file inside the task workspace. Input: "<relative path>\\n<content>".',
    risk: "safe",
    handler: fileWrite,
  });
  return registry;
}
