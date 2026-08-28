// Server integration test — boots the real worker server on an ephemeral port
// against a temp SQLite DB, registers the real provider, and drives one
// happy-path SSE chat end-to-end (real `claude` CLI).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipWithoutRealCli } from "../testing/real-cli.js";

// Point the DB at a temp file BEFORE importing the db/server modules (the db
// module reads SUPERTWIN_DB_PATH at load). vitest gives each test file its own
// module registry, so this env set is scoped to this file.
const tmpDir = mkdtempSync(join(tmpdir(), "st-server-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_CHAT_CWD = tmpDir;

const { runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

/** fetch + JSON with a caller-supplied type (res.json() is Promise<unknown>). */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  return (await res.json()) as T;
}

/** Parse an SSE response body into an array of decoded JSON events. */
async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
    }
  }
  return events;
}

describe.skipIf(skipWithoutRealCli)("worker server (real CLI)", () => {
  beforeAll(async () => {
    runMigrations();
    register(claudeLocalProvider);
    server = await startServer({ port: 0 }); // ephemeral
    base = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it("prints a real port and answers /api/health", async () => {
    expect(server.port).toBeGreaterThan(0);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it(
    "runs a /api/chat SSE happy path (session + delta + done) and persists it",
    async () => {
      const runId = "srv-chat-1";
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, message: "Reply with exactly: PONG" }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const events = await readSse(res);
      const types = events.map((e) => e.type);
      expect(types).toContain("session");
      expect(types).toContain("delta");
      expect(types).toContain("done");

      const sessionEv = events.find((e) => e.type === "session");
      expect(sessionEv).toBeTruthy();
      const sessionId = sessionEv!.sessionId as string;

      // /api/chat/sessions shows it.
      const list = await getJson<
        Array<{ sessionId: string; messageCount: number }>
      >(`${base}/api/chat/sessions`);
      expect(Array.isArray(list)).toBe(true);
      const found = list.find((s) => s.sessionId === sessionId);
      expect(found).toBeTruthy();
      expect(found!.messageCount).toBeGreaterThanOrEqual(2); // user + assistant

      // /api/chat/sessions/:id returns the transcript.
      const detail = await getJson<{
        session: { sessionId: string };
        messages: Array<{ role: string }>;
      }>(`${base}/api/chat/sessions/${sessionId}`);
      expect(detail.session.sessionId).toBe(sessionId);
      const roles = detail.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");

      // /api/quota reflects usage accumulated from the run.
      const quota = await getJson<{
        runCount: number;
        inputTokens: number;
        outputTokens: number;
      }>(`${base}/api/quota`);
      expect(quota.runCount).toBeGreaterThanOrEqual(1);
      expect(quota.inputTokens + quota.outputTokens).toBeGreaterThan(0);
    },
    120_000,
  );

  it("POST /api/cancel returns { ok: true }", async () => {
    const res = await fetch(`${base}/api/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "nonexistent-run" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects a chat with no message (400)", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/chat/sessions/new returns a null-session marker", async () => {
    const res = await fetch(`${base}/api/chat/sessions/new`, { method: "POST" });
    const body = (await res.json()) as { sessionId: string | null };
    expect(body.sessionId).toBeNull();
  });
});

// ===========================================================================
// V2 surface routes — the "is it actually mounted?" guard
//
// Every V2 tab test injects a fake worker client, so before this suite existed
// NOTHING in the repo drove a V2 route against the real router. That is exactly
// how eight route modules shipped fully written and mounted nowhere: each tab
// suite was green against its fake while every surface 404'd in the real app.
//
// This suite is deliberately NOT inside the `skipIf(skipWithoutRealCli)` block
// above. The router is the thing under test, not the `claude` binary, so gating
// it on the CLI would let CI go green on precisely the bug it exists to catch.
// ===========================================================================

describe("V2 surface routes are mounted and serving", () => {
  let v2: ServerHandle;
  let v2Base: string;

  beforeAll(async () => {
    runMigrations();
    // startServer rejects unless the default provider is registered. Registering
    // is a Map.set on a plain object — it does not touch the CLI.
    register(claudeLocalProvider);
    v2 = await startServer({ port: 0, media: false });
    v2Base = `http://127.0.0.1:${v2.port}`;
  }, 30_000);

  afterAll(async () => {
    if (v2) await v2.close();
  });

  /**
   * GET a surface path and hand back the parsed body, failing loudly on the one
   * status that means "no handler owns this": the router's terminal 404.
   */
  async function getPage<T>(path: string): Promise<T> {
    const res = await fetch(`${v2Base}${path}`);
    expect(res.status, `${path} answered ${res.status} — handler not mounted?`).not.toBe(404);
    expect(res.status, `${path} answered ${res.status}`).toBe(200);
    return (await res.json()) as T;
  }

  // The control for the assertion above: `not.toBe(404)` is only evidence that a
  // route is mounted if an unowned path really does still 404.
  it("still 404s a path no module owns", async () => {
    const res = await fetch(`${v2Base}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  // The other half of that move: the chat list it displaced still answers, on
  // its new path, in its own (bare-array) shape.
  it("GET /api/chat/sessions still returns the Phase-0 bare array", async () => {
    const body = await getPage<unknown[]>("/api/chat/sessions");
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/coverage returns a coverage snapshot", async () => {
    const body = await getPage<{
      mode: string;
      rows: unknown[];
      pausedLabel: string | null;
      remainingMinutes: number | null;
    }>("/api/coverage");
    expect(Array.isArray(body)).toBe(false);
    expect(typeof body.mode).toBe("string");
    expect(Array.isArray(body.rows)).toBe(true);
  });

});
