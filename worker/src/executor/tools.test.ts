// ===========================================================================
// P3.3 — tool registry + the code-level risky gate.
//
// EXE-04 as CODE assertions: no gated tool's handler is reachable without a
// minted, unused, unexpired approval token; a token authorizes exactly one
// invocation; a risky-named tool cannot even register as "safe".
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import {
  consumeApprovalToken,
  mintApprovalToken,
  readApprovalToken,
} from "../approvals/tokens.js";
import {
  defaultToolRegistry,
  GATED_ONLY_NAME_PATTERNS,
  GatedToolRefusedError,
  invokeTool,
  taskWorkspaceDir,
  ToolRegistry,
  type ToolContext,
} from "./tools.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-executor-tools-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { taskId: "tsk_1", workspaceDir: taskWorkspaceDir("tsk_1"), ...over };
}

describe("registry registration rules", () => {
  it("refuses a risky-named tool registered as safe (the surface stays honest)", () => {
    const r = new ToolRegistry();
    expect(() =>
      r.register({ name: "whatsapp_send", description: "x", risk: "safe", handler: async () => "" }),
    ).toThrow(/cannot be registered as risk "safe"/);
    expect(() =>
      r.register({ name: "browser_payment", description: "x", risk: "safe", handler: async () => "" }),
    ).toThrow(/risky pattern/);
  });

  it("requires gatedAction on gated tools", () => {
    const r = new ToolRegistry();
    expect(() =>
      r.register({ name: "browser_payment", description: "x", risk: "gated", handler: async () => "" }),
    ).toThrow(/gatedAction/);
  });

  it("default P3.3 registry is world-model read + drafts + files, all safe", () => {
    const r = defaultToolRegistry();
    expect(r.allowedToolNames().sort()).toEqual(
      ["draft_save", "file_read", "file_save", "world_model_read"].sort(),
    );
    for (const tool of r.list()) {
      expect(tool.risk).toBe("safe");
      expect(GATED_ONLY_NAME_PATTERNS.some((p) => p.test(tool.name))).toBe(false);
    }
  });
});

describe("EXE-04: gated tools are code-gated on approval tokens", () => {
  function gatedRegistry(calls: string[]): ToolRegistry {
    const r = defaultToolRegistry();
    r.register({
      name: "browser_payment",
      description: "P3.4 payment step placeholder",
      risk: "gated",
      gatedAction: "browser.payment",
      handler: async (input) => {
        calls.push(input);
        return "paid";
      },
    });
    return r;
  }

  it("refuses without a token — the handler never runs", async () => {
    const calls: string[] = [];
    const r = gatedRegistry(calls);
    await expect(invokeTool(r, "browser_payment", "villa B", ctx())).rejects.toThrow(
      GatedToolRefusedError,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a token minted for a different action", async () => {
    const calls: string[] = [];
    const r = gatedRegistry(calls);
    const t = mintApprovalToken("whatsapp.send");
    await expect(
      invokeTool(r, "browser_payment", "villa B", ctx({ approvalToken: t.token })),
    ).rejects.toThrow(GatedToolRefusedError);
    expect(calls).toEqual([]);
  });

  it("refuses an expired token", async () => {
    const calls: string[] = [];
    const r = gatedRegistry(calls);
    const t = mintApprovalToken("browser.payment", { ttlMs: 1_000, nowMs: 0 });
    await expect(
      invokeTool(r, "browser_payment", "villa B", ctx({ approvalToken: t.token, nowMs: 5_000 })),
    ).rejects.toThrow(GatedToolRefusedError);
    expect(calls).toEqual([]);
  });

  it("a valid token authorizes exactly ONE invocation (single-use)", async () => {
    const calls: string[] = [];
    const r = gatedRegistry(calls);
    const t = mintApprovalToken("browser.payment");
    const c = ctx({ approvalToken: t.token });
    await expect(invokeTool(r, "browser_payment", "villa B", c)).resolves.toBe("paid");
    expect(calls).toEqual(["villa B"]);
    // Same token again: refused, no second handler run.
    await expect(invokeTool(r, "browser_payment", "villa B again", c)).rejects.toThrow(
      GatedToolRefusedError,
    );
    expect(calls).toEqual(["villa B"]);
    expect(readApprovalToken(t.token)?.used_at).not.toBeNull();
  });

  it("token mint/consume single-use at the module layer", () => {
    const t = mintApprovalToken("whatsapp.send");
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(true);
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(false);
    expect(consumeApprovalToken("nonsense", "whatsapp.send")).toBe(false);
  });
});

describe("the P3.3 safe tools", () => {
  it("world_model_read returns seeded spaces and tasks", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp1','Goa trip','book villa','active')`).run();
    db.prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES ('tsk_1','sp1','Shortlist villas','open')`).run();
    const r = defaultToolRegistry();
    const out = await invokeTool(r, "world_model_read", "villa", ctx());
    expect(out).toContain('space sp1 [active] "Goa trip" — book villa');
    expect(out).toContain('task tsk_1 [open] "Shortlist villas"');
  });

  it("draft_save + file_save + file_read stay inside the task workspace", async () => {
    const r = defaultToolRegistry();
    const c = ctx();
    const saved = await invokeTool(r, "draft_save", "Hi Sameer — answers below.", c);
    expect(saved).toMatch(/^draft saved: drafts\//);
    await invokeTool(r, "file_save", "notes/a.md\nhello", c);
    await expect(invokeTool(r, "file_read", "notes/a.md", c)).resolves.toBe("hello");
  });

  it("file tools refuse paths that escape the workspace", async () => {
    const r = defaultToolRegistry();
    const c = ctx();
    writeFileSync(join(tmpDir, "secret.txt"), "no", "utf8");
    await expect(invokeTool(r, "file_read", "../../secret.txt", c)).rejects.toThrow(/escapes/);
    await expect(invokeTool(r, "file_save", "../../evil.txt\nx", c)).rejects.toThrow(/escapes/);
  });

  it("unknown tools are refused by name", async () => {
    const r = defaultToolRegistry();
    await expect(invokeTool(r, "teleport", "", ctx())).rejects.toThrow(/unknown tool/);
  });
});
