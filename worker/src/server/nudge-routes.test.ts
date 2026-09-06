// ===========================================================================
// The surface router's endpoints (V6 P1 S4.3). Sandboxed database, pinned
// clock, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { createArtifact } from "../surfaces/artifacts.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { handleNudgeRoute } from "./nudge-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-nudge-routes-"));
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

async function call(method: string, path: string): Promise<Captured | null> {
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
  const handled = await handleNudgeRoute({ method, url: path } as IncomingMessage, res);
  return handled ? captured : null;
}

function screenNow(): void {
  getDb().prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('screen','screen','Screen')`).run();
  getDb()
    .prepare(`INSERT INTO events (id, source_id, source_type, ts, kind, text) VALUES ('ev_now','screen','screen',?,'ax','w')`)
    .run(new Date().toISOString());
}

describe("handleNudgeRoute", () => {
  it("claims only /api/surfaces/", async () => {
    expect(await call("GET", "/api/assist/nudge")).toBeNull();
    expect((await call("GET", "/api/surfaces/nope"))?.status).toBe(404);
  });

  it("answers with no card and a zero counter on an empty world", async () => {
    const out = await call("GET", "/api/surfaces/nudge");
    expect(out?.status).toBe(200);
    expect(out?.body.card).toBeNull();
    expect(out?.body.unread).toBe(0);
    expect(out?.body.presence).toBe("away");
  });

  it("shows one card, counts it unread, then clears it on open", async () => {
    screenNow();
    getDb().prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_goa','Goa trip','active','t')`).run();
    const { artifact } = createArtifact({
      kind: "comparison",
      title: "villa comparison",
      intent: "comparing villas in Anjuna",
      spaceId: "sp_goa",
      producer: "executor",
    });

    const view = await call("GET", "/api/surfaces/nudge");
    expect((view?.body.card as { id: string }).id).toBe(artifact.id);
    expect(view?.body.presence).toBe("mac_active");
    expect(view?.body.cardDurationMs).toBe(60_000);

    const shown = await call("POST", `/api/surfaces/nudge/${artifact.id}/shown`);
    expect(shown?.body.unread).toBe(1);

    const closed = await call("POST", `/api/surfaces/nudge/${artifact.id}/auto-close`);
    expect(closed?.body.unread).toBe(1);

    const opened = await call("POST", `/api/surfaces/nudge/${artifact.id}/opened`);
    expect(opened?.body.unread).toBe(0);
  });

  it("refuses to stamp a card the router is not showing", async () => {
    const out = await call("POST", "/api/surfaces/nudge/art_nope/shown");
    expect(out?.status).toBe(409);
    expect(out?.body.unread).toBe(0);
  });

  it("'not now' ranks the kind down and keeps the work", async () => {
    screenNow();
    const { artifact } = createArtifact({ kind: "comparison", title: "fare alert", producer: "executor" });
    const out = await call("POST", `/api/surfaces/nudge/${artifact.id}/not-now`);
    expect(out?.body.dismissals).toBe(1);
    const row = getDb().prepare(`SELECT status FROM artifacts WHERE id = ?`).get(artifact.id) as { status: string };
    expect(row.status).toBe("seen");
  });

  it("exposes the whole plan on /route", async () => {
    createArtifact({ kind: "comparison", title: "cart built", producer: "executor" });
    const out = await call("GET", "/api/surfaces/route");
    expect(out?.status).toBe(200);
    expect((out?.body.items as unknown[]).length).toBe(1);
    expect(out?.body.withheld).toBe(0);
  });
});
