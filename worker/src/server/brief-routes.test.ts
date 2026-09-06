// ===========================================================================
// The brief's endpoints (V6 P1 S4.6). Sandboxed database, pinned rows, zero
// model calls — the on-demand compose is exercised only on a world model that
// has not moved, where it must spend nothing.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { BRIEF_TIMES_KEY } from "../brief/index.js";
import { handleBriefRoute } from "./brief-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-brief-routes-"));
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

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<Captured | null> {
  const captured: Captured = { status: 0, body: {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
    },
  } as unknown as ServerResponse;
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = path;
  const handled = await handleBriefRoute(req, res);
  return handled ? captured : null;
}

function seedBrief(id: string, slot: string, composedAt: string, text: string): void {
  getDb()
    .prepare(
      `INSERT INTO briefs (id, slot, tz, composed_at, since, delta_rows, ledger_json, text, model_calls, created_at)
       VALUES (?, ?, 'Asia/Kolkata', ?, NULL, 3, ?, ?, 1, ?)`,
    )
    .run(id, slot, composedAt, JSON.stringify({ needs_you: [], today: [], moved: [] }), text, composedAt);
}

describe("handleBriefRoute", () => {
  it("claims only its own prefix", async () => {
    expect(await call("GET", "/api/tasks")).toBeNull();
    expect(await call("GET", "/api/briefing")).toBeNull();
  });

  it("answers null before the first brief, with the set times", async () => {
    appStateSet(BRIEF_TIMES_KEY, JSON.stringify(["07:00", "19:00"]));
    const r = await call("GET", "/api/brief");
    expect(r?.status).toBe(200);
    expect(r?.body.brief).toBeNull();
    expect(r?.body.times).toEqual(["07:00", "19:00"]);
  });

  it("serves the standing card, its history, and clears the dot on open", async () => {
    seedBrief("brf_a", "2026-09-06 08:30", "2026-09-06T03:00:00.000Z", "**Needs you** · one thing");
    seedBrief("brf_b", "2026-09-06 18:30", "2026-09-06T13:00:00.000Z", "**Moved** · a fare dropped");

    const card = await call("GET", "/api/brief");
    const brief = card?.body.brief as Record<string, unknown>;
    expect(brief.id).toBe("brf_b");
    expect(brief.unread).toBe(true);
    expect(brief.text).toContain("fare dropped");

    const history = await call("GET", "/api/brief/history?limit=5");
    expect((history?.body.briefs as unknown[]).map((b) => (b as { id: string }).id)).toEqual(["brf_b", "brf_a"]);

    const opened = await call("POST", "/api/brief/brf_b/seen");
    expect((opened?.body.brief as Record<string, unknown>).unread).toBe(false);
    expect(await call("POST", "/api/brief/nope/seen")).toMatchObject({ status: 404 });
  });

  it("an on-demand compose over an unchanged world model spends nothing", async () => {
    seedBrief("brf_a", "2026-09-06 08:30", new Date(Date.now() + 1_000).toISOString(), "the last brief");
    const r = await call("POST", "/api/brief/run", {});
    expect(r?.status).toBe(200);
    expect(r?.body.status).toBe("skipped");
    expect(r?.body.reason).toBe("no_delta");
    expect(r?.body.model_calls).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM briefs`).get() as { n: number }).n).toBe(1);
  });
});
