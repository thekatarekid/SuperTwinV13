// ===========================================================================
// P3.5 — task run + approval routes (stubbed provider, ZERO live model calls).
//
// Covers: GET run (empty → populated), POST execute through the real executor
// with a scripted provider, the executing double-fire 409, the question-card
// answer (evidence + decision + reopened), and POST send — the approved
// WhatsApp draft path: stored-draft-only, token forwarded into the ONLY send
// path, refusal surfaces as 403, success lands a receipt + done.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import type { Ingestion } from "../ingest/index.js";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  SendOptions,
  Usage,
} from "../providers/types.js";
import { handleExecutorRoute, type ExecutorRouteDeps } from "./executor-routes.js";

const USAGE: Usage = {
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
};

class StubProvider implements Provider {
  id = "stub";
  sent: SendOptions[] = [];
  constructor(private events: ProviderStreamEvent[]) {}
  async send(opts: SendOptions): Promise<ProviderResult> {
    this.sent.push(opts);
    for (const e of this.events) opts.onEvent(e);
    return { sessionId: "s1", usage: USAGE, freshFallback: false, status: "ok" };
  }
  cancel(): boolean {
    return false;
  }
}

const doneEvent: ProviderStreamEvent = { type: "done", sessionId: "s1", usage: USAGE };

const draftEnvelope = JSON.stringify({
  status: "needs_approval",
  criteria: ["draft matches the ask"],
  attempts: [{ approach: "drafted from tone profile", outcome: "draft ready" }],
  result: {
    result_type: "draft_preview",
    data: {
      to: "15551234567@s.whatsapp.net",
      channel: "whatsapp",
      body: "Rohan, flights look good — locking 18-21 Dec?",
    },
  },
  question: null,
  approval_request: "Send this WhatsApp message to Rohan",
  gaps: [],
  next: null,
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-exec-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  const db = getDb();
  db.prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp1','Goa trip','book it','active')`).run();
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, category, risk_class, status)
     VALUES ('tsk_1','sp1','Message Rohan about flights','communication','approve-first','open')`,
  ).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  ingestion: Ingestion | null = null,
  deps: ExecutorRouteDeps = {},
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  } as unknown as IncomingMessage;
  let status: number | null = null;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleExecutorRoute(req, res, ingestion, deps);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

const taskRow = () => getDb().prepare(`SELECT * FROM tasks WHERE id = 'tsk_1'`).get() as any;

describe("GET /api/tasks/:id/run", () => {
  it("returns the task with run:null before any execution", async () => {
    const r = await call("GET", "/api/tasks/tsk_1/run");
    expect(r.status).toBe(200);
    expect(r.body.task.id).toBe("tsk_1");
    expect(r.body.run).toBeNull();
  });

  it("404s an unknown task and ignores foreign paths", async () => {
    expect((await call("GET", "/api/tasks/nope/run")).status).toBe(404);
    expect((await call("GET", "/api/other")).handled).toBe(false);
  });
});

describe("POST /api/tasks/:id/execute", () => {
  it("runs the executor and the run becomes readable via GET /run", async () => {
    const provider = new StubProvider([{ type: "delta", text: draftEnvelope }, doneEvent]);
    const r = await call("POST", "/api/tasks/tsk_1/execute", {}, null, { executor: { provider } });
    expect(r.status).toBe(200);
    expect(r.body.task_status).toBe("needs_approval");
    expect(r.body.envelope.result.result_type).toBe("draft_preview");

    const read = await call("GET", "/api/tasks/tsk_1/run");
    expect(read.body.task.status).toBe("needs_approval");
    expect(read.body.run.envelope.approval_request).toBe("Send this WhatsApp message to Rohan");
  });

  it("refuses a double-fire while executing with 409", async () => {
    getDb().prepare(`UPDATE tasks SET status = 'executing' WHERE id = 'tsk_1'`).run();
    const r = await call("POST", "/api/tasks/tsk_1/execute", {});
    expect(r.status).toBe(409);
  });
});

describe("POST /api/tasks/:id/answer", () => {
  it("records the answer as evidence + decision and reopens the task", async () => {
    getDb().prepare(`UPDATE tasks SET status = 'needs_input' WHERE id = 'tsk_1'`).run();
    const r = await call("POST", "/api/tasks/tsk_1/answer", { answer: "aisle seats please" });
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe("open");
    expect(r.body.decision_id).toBeTruthy();

    const row = taskRow();
    expect(row.evidence_json).toContain("you answered: aisle seats please");
    const dec = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_id = 'tsk_1' AND action = 'answer'`)
      .get() as any;
    expect(dec.new_json).toContain("aisle seats please");
  });

  it("400s an empty answer", async () => {
    expect((await call("POST", "/api/tasks/tsk_1/answer", { answer: "  " })).status).toBe(400);
  });
});

describe("POST /api/tasks/:id/send", () => {
  async function primeDraft(): Promise<void> {
    const provider = new StubProvider([{ type: "delta", text: draftEnvelope }, doneEvent]);
    await call("POST", "/api/tasks/tsk_1/execute", {}, null, { executor: { provider } });
  }

  function stubIngestion(): Ingestion & { sends: { to: string; text: string; approvalToken: string }[] } {
    const sends: { to: string; text: string; approvalToken: string }[] = [];
    return {
      sends,
      async sendMessage(p: { to: string; text: string; approvalToken: string }) {
        sends.push(p);
      },
    } as unknown as Ingestion & { sends: { to: string; text: string; approvalToken: string }[] };
  }

  it("sends the STORED draft through the only send path, then done + receipt", async () => {
    await primeDraft();
    const ingestion = stubIngestion();
    const r = await call("POST", "/api/tasks/tsk_1/send", { approval_token: "tok-1" }, ingestion);
    expect(r.status).toBe(200);
    // The draft came from the stored envelope, never the request body.
    expect(ingestion.sends).toEqual([
      {
        to: "15551234567@s.whatsapp.net",
        text: "Rohan, flights look good — locking 18-21 Dec?",
        approvalToken: "tok-1",
      },
    ]);
    expect(r.body.task.status).toBe("done");
    expect(r.body.run.envelope.result.result_type).toBe("receipt");
    expect(r.body.run.envelope.result.data.summary).toContain("Rohan, flights look good");
    const dec = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_id = 'tsk_1' AND action = 'approved_send'`)
      .get();
    expect(dec).toBeTruthy();
  });

  it("403s when the gate refuses (invalid/used token) and mutates nothing", async () => {
    await primeDraft();
    const ingestion = {
      async sendMessage() {
        throw new Error("SEND_REFUSED: approval token invalid, expired, or already used");
      },
    } as unknown as Ingestion;
    const r = await call("POST", "/api/tasks/tsk_1/send", { approval_token: "bad" }, ingestion);
    expect(r.status).toBe(403);
    expect(taskRow().status).toBe("needs_approval");
  });

  it("400s without a stored whatsapp draft, 503s without an adapter", async () => {
    const ingestion = stubIngestion();
    expect(
      (await call("POST", "/api/tasks/tsk_1/send", { approval_token: "tok" }, ingestion)).status,
    ).toBe(400);
    expect((await call("POST", "/api/tasks/tsk_1/send", { approval_token: "tok" }, null)).status).toBe(
      503,
    );
    await primeDraft();
    expect((await call("POST", "/api/tasks/tsk_1/send", {}, ingestion)).status).toBe(400);
  });
});
