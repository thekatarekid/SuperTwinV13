// ===========================================================================
// P3.3 — session protocol tests (stubbed provider, ZERO live model calls).
//
// Covers: the protocol round trip (envelope → task status → decision row →
// result_ref), budget exhaustion → best-partial (EXE-05), schema validation
// on emit, structural protocol rules, and the session-level EXE-04 assertion:
// a gated tool reached from inside a session is refused without a token and
// the refusal is recorded on the invocation log.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { mintApprovalToken, readApprovalToken } from "../approvals/tokens.js";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  SendOptions,
  Usage,
} from "../providers/types.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import { defaultToolRegistry } from "./tools.js";
import { bestPartialEnvelope, parseEnvelope, runExecutorTask, taskStatusFor } from "./session.js";

const USAGE: Usage = {
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
};

/** Scripted provider: replays events, records the SendOptions it was given. */
class StubProvider implements Provider {
  id = "stub";
  sent: SendOptions[] = [];
  constructor(
    private events: ProviderStreamEvent[],
    private result: Partial<ProviderResult> = {},
  ) {}
  async send(opts: SendOptions): Promise<ProviderResult> {
    this.sent.push(opts);
    for (const e of this.events) opts.onEvent(e);
    return {
      sessionId: "s1",
      usage: USAGE,
      freshFallback: false,
      status: "ok",
      ...this.result,
    };
  }
  cancel(): boolean {
    return false;
  }
}

const doneEvent = (stopReason?: string): ProviderStreamEvent => ({
  type: "done",
  sessionId: "s1",
  usage: USAGE,
  ...(stopReason ? { stopReason } : {}),
});

const envelopeText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    status: "done",
    criteria: ["3 options", "in budget"],
    attempts: [{ approach: "world model first", outcome: "found context" }],
    result: {
      result_type: "comparison_table",
      data: { title: "Villas", columns: ["name", "price"], rows: [["A", "5k"], ["B", "6k"]] },
    },
    question: null,
    approval_request: null,
    gaps: [],
    next: null,
    ...over,
  });

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-executor-session-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  getDb()
    .prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp1','Goa trip','book villa','active')`)
    .run();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, category, risk_class, status)
       VALUES ('tsk_1','sp1','Shortlist 3 villas near Anjuna','research','advise-only','open')`,
    )
    .run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

const taskRow = () =>
  getDb().prepare(`SELECT * FROM tasks WHERE id = 'tsk_1'`).get() as Record<string, unknown>;

describe("session protocol", () => {
  it("done envelope with a valid result → task done, result_ref, decision row", async () => {
    const provider = new StubProvider([{ type: "delta", text: envelopeText() }, doneEvent()]);
    const res = await runExecutorTask("tsk_1", { provider });

    expect(res.envelope.status).toBe("done");
    expect(res.envelope.criteria).toEqual(["3 options", "in budget"]);
    expect(res.envelope.result?.result_type).toBe("comparison_table");
    expect(res.taskStatus).toBe("done");

    const row = taskRow();
    expect(row.status).toBe("done");
    expect(row.closed_at).not.toBeNull();
    expect(existsSync(String(row.result_ref))).toBe(true);
    const persisted = JSON.parse(readFileSync(String(row.result_ref), "utf8"));
    expect(persisted.envelope.result.result_type).toBe("comparison_table");

    const decisions = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_kind='task' AND target_id='tsk_1'`)
      .all() as Record<string, unknown>[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("execute");
    expect(decisions[0].pass).toBe("executor");
  });

  it("passes the tool whitelist and the max-turns budget to the CLI adapter", async () => {
    const provider = new StubProvider([{ type: "delta", text: envelopeText() }, doneEvent()]);
    await runExecutorTask("tsk_1", { provider, budget: { maxTurns: 7, costUsd: 2 } });
    expect(provider.sent).toHaveLength(1);
    const opts = provider.sent[0];
    expect(opts.maxTurns).toBe(7);
    expect(opts.allowedTools?.sort()).toEqual(
      ["draft_save", "file_read", "file_save", "world_model_read"].sort(),
    );
    expect(opts.sessionId).toBeNull(); // one FRESH session per task
    expect(opts.systemPromptFile).toBeTruthy();
    expect(opts.message).toContain("Shortlist 3 villas near Anjuna");
    expect(opts.message).toContain("space: Goa trip — goal: book villa");
  });

  it("needs_input with a question pauses the task at needs_input (EXE-02)", async () => {
    const provider = new StubProvider([
      { type: "delta", text: envelopeText({ status: "needs_input", result: null, question: "Pickup from home or office?" }) },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider });
    expect(res.envelope.status).toBe("needs_input");
    expect(res.envelope.question).toBe("Pickup from home or office?");
    expect(taskRow().status).toBe("needs_input");
  });

  it("needs_approval with a stated request parks at needs_approval (EXE-04 surface)", async () => {
    const provider = new StubProvider([
      {
        type: "delta",
        text: envelopeText({
          status: "needs_approval",
          result: {
            result_type: "approval_card",
            data: { action: "browser.payment", summary: "Pay ₹18,240 for Villa B, 18–21 Dec" },
          },
          approval_request: "Pay ₹18,240 for Villa B, 18–21 Dec",
        }),
      },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider });
    expect(res.envelope.status).toBe("needs_approval");
    expect(taskRow().status).toBe("needs_approval");
  });

  it("needs_approval WITHOUT a stated request is downgraded to partial (code rule)", async () => {
    const provider = new StubProvider([
      { type: "delta", text: envelopeText({ status: "needs_approval", result: null }) },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider });
    expect(res.envelope.status).toBe("partial");
    expect(res.envelope.gaps.join(" ")).toMatch(/did not state what will happen/);
  });

  it("a result failing its schema is downgraded on emit, never persisted as done", async () => {
    const provider = new StubProvider([
      {
        type: "delta",
        text: envelopeText({
          result: { result_type: "comparison_table", data: { title: "Villas" } },
        }),
      },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider });
    expect(res.envelope.status).toBe("partial");
    expect(res.envelope.result).toBeNull();
    expect(res.envelope.gaps.some((g) => g.includes("schema validation"))).toBe(true);
    expect(taskRow().status).toBe("needs_input"); // parked, visible
  });
});

describe("EXE-05: budget exhaustion → best partial, never silent death", () => {
  it("max_turns with no envelope synthesizes a checklist partial with the gap named", async () => {
    const provider = new StubProvider([
      { type: "tool_use", name: "world_model_read", input: "villa" },
      { type: "delta", text: "…still comparing tabs…" },
      doneEvent("max_turns"),
    ]);
    const res = await runExecutorTask("tsk_1", { provider, budget: { maxTurns: 6, costUsd: 1 } });
    expect(res.envelope.status).toBe("partial");
    expect(res.envelope.gaps[0]).toMatch(/budget exhausted \(6 turns\)/);
    expect(res.envelope.result?.result_type).toBe("checklist");
    expect(res.taskStatus).toBe("needs_input");
    expect(taskRow().status).toBe("needs_input");
    // The successful tool step shows as done in the best-partial checklist.
    const items = (res.envelope.result?.data.items ?? []) as { label: string; state: string }[];
    expect(items.some((i) => i.label.startsWith("world_model_read") && i.state === "done")).toBe(true);
  });

  it("a transport error also lands as a visible partial", async () => {
    const provider = new StubProvider(
      [{ type: "error", code: "TIMEOUT", message: "cli timed out" }],
      { status: "error", errorCode: "TIMEOUT" },
    );
    const res = await runExecutorTask("tsk_1", { provider });
    expect(res.envelope.status).toBe("partial");
    expect(res.envelope.gaps[0]).toMatch(/session error: TIMEOUT/);
    expect(taskRow().status).toBe("needs_input");
  });
});

describe("EXE-04: risky tool reached from a session is refused without a token", () => {
  function registryWithPayment() {
    const registry = defaultToolRegistry();
    const calls: string[] = [];
    registry.register({
      name: "browser_payment",
      description: "payment step",
      risk: "gated",
      gatedAction: "browser.payment",
      handler: async (input) => {
        calls.push(input);
        return "paid";
      },
    });
    return { registry, calls };
  }

  it("no token → invocation logged as refused, handler never runs", async () => {
    const { registry, calls } = registryWithPayment();
    const provider = new StubProvider([
      { type: "tool_use", name: "browser_payment", input: "villa B ₹18,240" },
      { type: "delta", text: envelopeText() },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider, registry });
    expect(calls).toEqual([]); // risky_without_token = 0, in code
    const inv = res.invocations.find((i) => i.tool === "browser_payment");
    expect(inv?.status).toBe("refused");
    expect(inv?.detail).toMatch(/no valid unused approval token/);
  });

  it("a minted token authorizes the step once and is consumed", async () => {
    const { registry, calls } = registryWithPayment();
    const t = mintApprovalToken("browser.payment");
    const provider = new StubProvider([
      { type: "tool_use", name: "browser_payment", input: "villa B" },
      { type: "tool_use", name: "browser_payment", input: "villa B AGAIN" },
      { type: "delta", text: envelopeText() },
      doneEvent(),
    ]);
    const res = await runExecutorTask("tsk_1", { provider, registry, approvalToken: t.token });
    expect(calls).toEqual(["villa B"]); // exactly one execution
    const statuses = res.invocations
      .filter((i) => i.tool === "browser_payment")
      .map((i) => i.status);
    expect([...statuses].sort()).toEqual(["ok", "refused"]); // one executed, one refused
    expect(readApprovalToken(t.token)?.used_at).not.toBeNull();
  });
});

describe("envelope helpers", () => {
  it("parseEnvelope tolerates fenced JSON and rejects garbage", () => {
    expect(parseEnvelope("```json\n" + envelopeText() + "\n```")).not.toBeNull();
    expect(parseEnvelope("no json here")).toBeNull();
    expect(parseEnvelope(JSON.stringify({ status: "flying" }))).toBeNull();
  });

  it("done without a result is downgraded — no fake completions", () => {
    const env = parseEnvelope(envelopeText({ result: null }));
    expect(env?.status).toBe("partial");
    expect(env?.gaps.join(" ")).toMatch(/without a typed result/);
  });

  it("bestPartialEnvelope always yields a schema-valid checklist", () => {
    const env = bestPartialEnvelope("budget", [], "tail");
    expect(env.result?.result_type).toBe("checklist");
    expect(taskStatusFor(env.status)).toBe("needs_input");
  });
});
