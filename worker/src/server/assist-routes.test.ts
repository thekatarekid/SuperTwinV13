// ===========================================================================
// Assist artifact + nudge routes (build P2.3, spec §14.7): panel snapshot
// composition, artifact status transitions over HTTP, reconcile signals,
// capture quick-pause — and the acceptance flow the build plan names:
// dismiss → Prepared/older → reopen → graduation (Critic-gated, stubbed).
// No live model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import type { Usage } from "../providers/types.js";
import { providerV2TestDouble } from "../providers/test-support.js";
import {
  createArtifact,
  getArtifact,
  graduateArtifact,
  markNudged,
} from "../surfaces/artifacts.js";
import { getCapturePausedUntil } from "../settings/assist-settings.js";
import { handleAssistRoute, panelSnapshot } from "./assist-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-assist-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
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
  const handled = await handleAssistRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

function mintArtifact(over: Partial<Parameters<typeof createArtifact>[0]> = {}) {
  return createArtifact({
    kind: "comparison",
    title: "Villa comparison",
    summary: "3 fit budget",
    intent: "Goa villas",
    topicKey: "stream:s",
    contentKey: `ck-${Math.random()}`,
    ...over,
  }).artifact;
}

describe("handleAssistRoute", () => {
  it("declines paths it does not own", async () => {
    expect((await call("GET", "/api/health")).handled).toBe(false);
    expect((await call("GET", "/api/home")).handled).toBe(false);
  });

  it("serves the §14.7 panel snapshot: needs-you, prepared, older, today, nudge", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, status, risk_class) VALUES ('t1', 'flights ₹18,340', 'needs_approval', 'approve-final')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, status, risk_class) VALUES ('t2', 'cab from home or office?', 'needs_input', 'advise-only')`,
    ).run();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO tasks (id, title, status, risk_class, due) VALUES ('t3', 'pool payment due', 'open', 'advise-only', ?)`,
    ).run(`${today}T18:00:00Z`);
    const fresh = mintArtifact();
    markNudged(fresh.id);
    const dismissed = mintArtifact({ title: "Old draft" });
    await call("POST", `/api/artifacts/${dismissed.id}/dismiss`);

    const { handled, status, body } = await call("GET", "/api/assist/panel");
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body.needs_you.approvals.map((a: any) => a.id)).toEqual(["t1"]);
    expect(body.needs_you.questions.map((q: any) => q.id)).toEqual(["t2"]);
    expect(body.prepared.map((a: any) => a.id)).toEqual([fresh.id]);
    expect(body.older.map((a: any) => a.id)).toEqual([dismissed.id]);
    expect(body.nudge.id).toBe(fresh.id);
    expect(body.today.map((t: any) => t.id)).toEqual(["t3"]);
    expect(body.capture_paused_until).toBeNull();
  });

  it("GET /api/assist/nudge returns the newest unseen artifact, then null once seen", async () => {
    const a = mintArtifact();
    expect((await call("GET", "/api/assist/nudge")).body.artifact.id).toBe(a.id);
    await call("POST", `/api/artifacts/${a.id}/seen`);
    expect((await call("GET", "/api/assist/nudge")).body.artifact).toBeNull();
  });

  it("lists artifacts with a status filter and rejects unknown statuses", async () => {
    mintArtifact();
    expect((await call("GET", "/api/artifacts?status=new")).body.artifacts.length).toBe(1);
    expect((await call("GET", "/api/artifacts?status=seen")).body.artifacts.length).toBe(0);
    expect((await call("GET", "/api/artifacts?status=bogus")).status).toBe(400);
  });

  it("records graded signals and 404s unknown artifacts", async () => {
    const a = mintArtifact();
    const ok = await call("POST", `/api/artifacts/${a.id}/signal`, { signal: "edited" });
    expect(ok.status).toBe(200);
    expect(ok.body.weight).toBe(1);
    const bad = await call("POST", `/api/artifacts/${a.id}/signal`, { signal: "nope" });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/api/artifacts/art_missing/seen")).status).toBe(404);
  });

  it("capture quick-pause sets + clears the pause with a decision row", async () => {
    const paused = await call("POST", "/api/assist/pause", { minutes: 30 });
    expect(paused.status).toBe(200);
    expect(paused.body.capture_paused_until).not.toBeNull();
    expect(getCapturePausedUntil()).toBe(paused.body.capture_paused_until);
    const resumed = await call("POST", "/api/assist/pause", { until: null });
    expect(resumed.body.capture_paused_until).toBeNull();
    const decisions = getDb()
      .prepare(`SELECT action FROM decisions WHERE target_kind = 'capture' ORDER BY created_at`)
      .all() as { action: string }[];
    expect(decisions.map((d) => d.action)).toEqual(["pause", "resume"]);
    // The panel reflects it.
    expect(panelSnapshot().capture_paused_until).toBeNull();
  });

  it("acceptance: dismiss → Prepared/older → reopen → graduation", async () => {
    const a = mintArtifact();
    // Dismiss: parks in the older drawer; nothing vanishes.
    await call("POST", `/api/artifacts/${a.id}/dismiss`);
    let panel = panelSnapshot();
    expect((panel.older as any[]).map((r) => r.id)).toEqual([a.id]);
    expect((panel.prepared as any[]).length).toBe(0);

    // Reopen: back into Prepared as seen (restarts positive signal).
    const reopened = await call("POST", `/api/artifacts/${a.id}/reopen`);
    expect(reopened.body.artifact.status).toBe("seen");
    panel = panelSnapshot();
    expect((panel.prepared as any[]).map((r) => r.id)).toEqual([a.id]);
    expect((panel.older as any[]).length).toBe(0);

    // Graduate through the Critic gate (stubbed commit verdict).
    const provider = providerV2TestDouble(async (opts) => {
        const usage: Usage = {
          inputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        };
        opts.onEvent({
          type: "delta",
          text: JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] }),
        });
        opts.onEvent({ type: "done", continuation: null, usage });
        return { continuation: null, usage, freshFallback: false, status: "ok" as const };
    });
    const result = await graduateArtifact(a.id, {
      provider,
      recordRun: () => "run-1",
      quarantine: () => {},
    });
    expect(result.status).toBe("graduated");
    expect(getArtifact(a.id)!.status).toBe("graduated");
    // Graduated work leaves the Prepared list (it is a durable task now).
    panel = panelSnapshot();
    expect((panel.prepared as any[]).length).toBe(0);
  });
});
