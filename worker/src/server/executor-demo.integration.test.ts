// ===========================================================================
// P3.5 acceptance — the full demo path, end to end:
//
//   chat message → (Decide, stubbed) task → (executor, stubbed provider)
//   needs_approval draft → approval modal's routes: mint token → send →
//   the REAL Go daemon in --mock mode performs the WhatsApp send.
//
// The model transports are scripted (unit tests make ZERO live model calls);
// the send gate is real on both sides — the worker consumes the single-use
// token inside Ingestion.sendMessage and the daemon refuses replays on its
// own. Skipped cleanly when the Go toolchain is unavailable (same posture as
// adapters/whatsapp/mock-e2e.test.ts).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import { runDecidePass } from "../brain/decide-pass.js";
import { Ingestion } from "../ingest/index.js";
import { WhatsAppAdapter } from "../adapters/whatsapp/adapter.js";
import type { StatusUpdate } from "../adapters/types.js";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  SendOptions,
  Usage,
} from "../providers/types.js";
import { handleSourceRoute } from "./whatsapp-routes.js";
import { handleExecutorRoute, type ExecutorRouteDeps } from "./executor-routes.js";
import { buildDaemon, goAvailable } from "../testing/go-daemon.js";

// ---- scripted model transport ---------------------------------------------

const USAGE: Usage = {
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
};

function stubProvider(responses: string[]): Provider {
  let n = 0;
  return {
    id: "stub",
    cancel: () => false,
    async send(opts: SendOptions): Promise<ProviderResult> {
      const text = responses[Math.min(n++, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text } as ProviderStreamEvent);
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" };
    },
  };
}

// ---- http harness over the route handlers ---------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

async function call(
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number | null; body: any }> {
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
  await handler(req, res);
  return { status, body: payload === "" ? null : JSON.parse(payload) };
}

function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      if (pred()) return resolvePromise();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ---- fixtures --------------------------------------------------------------

const ROHAN_JID = "15551234567@s.whatsapp.net";

const DECIDE_ANSWER = JSON.stringify({
  space: "sp_goa",
  chapters: [],
  tasks: [
    {
      title: "Message Rohan to lock Goa flights 18-21 Dec",
      type: "explicit",
      category: "communication",
      risk_class: "approve-first",
      owner: "self",
      chapter: null,
      due: null,
      evidence: [{ event_ids: ["e_wa_1"], quote: "lets lock goa 18-21 dec" }],
      confidence: 0.9,
    },
  ],
  schedules: [],
  closures: [],
  followups: [],
  plan: { next: ["confirm dates with Rohan"] },
});

const EXECUTOR_ENVELOPE = JSON.stringify({
  status: "needs_approval",
  criteria: ["draft matches Rohan's message", "dates 18-21 Dec"],
  attempts: [{ approach: "drafted from tone profile", outcome: "draft ready" }],
  result: {
    result_type: "draft_preview",
    data: {
      to: ROHAN_JID,
      channel: "whatsapp",
      body: "locking goa 18-21 dec then? 🔥",
    },
  },
  question: null,
  approval_request: "Send this WhatsApp draft to Rohan",
  gaps: [],
  next: null,
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-demo-e2e-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed the chat message leg: one WhatsApp event inside a committed episode. */
function seedChatMessage(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO spaces (id, label, status, goal) VALUES ('sp_goa','Goa trip with Rohan','active','trip 18-21 dec')`,
  ).run();
  db.prepare(
    `INSERT INTO episodes (id, space_id, state, summary) VALUES ('ep_1','sp_goa','open','goa dates chatter')`,
  ).run();
  db.prepare(
    `INSERT INTO events (id, ts, actor, text) VALUES ('e_wa_1','2026-08-25T10:00:00Z','Rohan','lets lock goa 18-21 dec')`,
  ).run();
  const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = 'e_wa_1'`).get() as { r: number }).r;
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
     VALUES ('ee_1','ep_1','e_wa_1','e_wa_1',?,?)`,
  ).run(rowid, rowid);
}

describe.skipIf(!goAvailable)("P3.5 demo path (stubbed models + real --mock daemon)", () => {
  it(
    "chat message → task → executor → approval mint → token → whatsapp mock send; replay refused",
    async () => {
      // 1. Chat message → task (Decide with a scripted transport).
      seedChatMessage();
      const decide = await runDecidePass("sp_goa", ["ep_1"], {
        provider: stubProvider([DECIDE_ANSWER]),
      });
      expect(decide.status).toBe("ok");
      expect(decide.applied.tasksCreated).toBe(1);
      const task = getDb()
        .prepare(`SELECT id, status, risk_class FROM tasks WHERE space_id = 'sp_goa'`)
        .get() as { id: string; status: string; risk_class: string };
      expect(task.risk_class).toBe("approve-first");

      // 2. Executor run (scripted session) parks the task at needs_approval
      //    with the draft the approval modal will display.
      const execDeps: ExecutorRouteDeps = {
        executor: { provider: stubProvider([EXECUTOR_ENVELOPE]) },
      };
      const executed = await call(
        (req, res) => handleExecutorRoute(req, res, null, execDeps),
        "POST",
        `/api/tasks/${task.id}/execute`,
        {},
      );
      expect(executed.status).toBe(200);
      expect(executed.body.task_status).toBe("needs_approval");
      expect(executed.body.envelope.result.result_type).toBe("draft_preview");

      // 3. Boot the REAL daemon in --mock mode behind the real adapter.
      const adapter = new WhatsAppAdapter({
        binPath: await buildDaemon(),
        mock: true,
        home: tmpDir,
        autoRestart: false,
      });
      const ingestion = new Ingestion(adapter);
      ingestion.start();
      const frames: StatusUpdate[] = [];
      ingestion.subscribeStatus((s) => frames.push(s));
      const sendResults = () =>
        frames.filter((f) => f.type === "send_result") as Array<
          Extract<StatusUpdate, { type: "send_result" }>
        >;

      try {
        await adapter.connect();
        await adapter.startPairing();
        await waitFor(() => frames.some((f) => f.type === "paired"), 15_000, "pairing");

        // 4. Approve tap → mint the single-use token (the modal's only mint).
        const minted = await call(
          (req, res) => handleSourceRoute(req, res, ingestion),
          "POST",
          "/api/approvals/mint",
          { action: "whatsapp.send" },
        );
        expect(minted.status).toBe(200);
        expect(minted.body.token).toMatch(/^[0-9a-f]{64}$/);

        // 5. Token → the send route → the daemon actually sends.
        const sent = await call(
          (req, res) => handleExecutorRoute(req, res, ingestion),
          "POST",
          `/api/tasks/${task.id}/send`,
          { approval_token: minted.body.token },
        );
        expect(sent.status).toBe(200);
        await waitFor(() => sendResults().length >= 1, 10_000, "send_result");
        expect(sendResults()[0].ok).toBe(true);

        // The task closed with a receipt of exactly what was performed.
        expect(sent.body.task.status).toBe("done");
        expect(sent.body.run.envelope.result.result_type).toBe("receipt");
        expect(sent.body.run.envelope.result.data.summary).toContain("locking goa 18-21 dec");

        // 6. Replay: the consumed token authorizes nothing again — the worker
        //    gate inside the ONLY send path refuses before the adapter is
        //    reached (daemon-side replay refusal is covered by mock-e2e).
        await expect(
          ingestion.sendMessage({
            to: ROHAN_JID,
            text: "replay attempt",
            approvalToken: minted.body.token,
          }),
        ).rejects.toThrow(/SEND_REFUSED/);
      } finally {
        await adapter.disconnect();
      }
    },
    120_000,
  );
});
