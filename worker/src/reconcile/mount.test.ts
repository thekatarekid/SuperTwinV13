// ===========================================================================
// Item 2.6 — the manual cadence really is mounted on the real server.
//
// `routes.test.ts` proves the handler. This proves the WIRE: the third caller
// named in the item ("POST /api/reconcile/run") has to be reachable over HTTP,
// not merely exported. A handler that is correct and unmounted is the same
// thing to a user as no handler at all, and the router's catch-all 404 sits
// below the reconcile block, so a misplaced mount fails silently.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "st-reconcile-mount-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("../server/index.js");
const { writeProvisionalArc } = await import("../arcs/provisional.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

beforeAll(async () => {
  runMigrations();
  // startServer refuses to boot without a default provider; nothing here sends.
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      text: "",
    }),
  } as never);

  const { getDb } = await import("../db/connection.js");
  const db = getDb();
  for (const id of ["a1", "a2"]) {
    db.prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, merged_into) VALUES (?, 'person', ?, NULL)`).run(
      id,
      id,
    );
  }
  for (const [id, source] of [
    ["ep_wa", "whatsapp"],
    ["ep_cal", "calendar"],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, ?, 'Goa trip', '["a1","a2"]', '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z')`,
    ).run(id, source);
  }
  writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "x", episodeIds: ["ep_wa"], now: NOW });
  writeProvisionalArc({ batchId: "c2", arcKeyCandidate: "y", episodeIds: ["ep_cal"], now: NOW });

  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the reconcile routes are mounted on the real server", () => {
  it("GET /api/reconcile/status answers, and starts nothing", async () => {
    const res = await fetch(`${base}/api/reconcile/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendingProvisionals: number; lastRun: unknown };
    expect(body.pendingProvisionals).toBe(2);
    expect(body.lastRun).toBeNull();
  });

  it("POST /api/reconcile/run reconciles once, and the second call is a no-op", async () => {
    const first = (await (
      await fetch(`${base}/api/reconcile/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "bootstrap" }),
      })
    ).json()) as { runId: string; changes: number; noop: boolean };
    expect(first.runId).toMatch(/^rec_/);
    expect(first.changes).toBeGreaterThan(0);

    // ACCEPTANCE: running reconcile twice changes nothing the second time —
    // over the wire, not just through the function.
    const second = (await (
      await fetch(`${base}/api/reconcile/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "bootstrap" }),
      })
    ).json()) as { runId: string; changes: number; noop: boolean };
    expect(second.changes).toBe(0);
    expect(second.noop).toBe(true);
    expect(second.runId).not.toBe(first.runId);
  });

  it("status then shows the last run the manual call minted", async () => {
    const body = (await (await fetch(`${base}/api/reconcile/status`)).json()) as {
      pendingProvisionals: number;
      lastRun: { runId: string } | null;
    };
    expect(body.pendingProvisionals).toBe(0);
    expect(body.lastRun?.runId).toMatch(/^rec_/);
  });
});
