// ===========================================================================
// Spaces routes (V6 P1 S5.1) through the handler contract: list by life area,
// the view, the sweep preview, wake, enrichment and the re-file drag. Temp
// DB, no server, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { bornAsked } from "../spaces/birth.js";
import { handleSpacesRoute } from "./spaces-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-spaces-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
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
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = path;
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
  const handled = await handleSpacesRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

function mkSpace(id: string, label: string, area: string | null, status = "active"): void {
  getDb()
    .prepare(`INSERT INTO spaces (id, label, life_area, status) VALUES (?, ?, ?, ?)`)
    .run(id, label, area, status);
}

describe("handleSpacesRoute", () => {
  it("declines paths it does not own — including world-model's /api/spaces and :id/claims", async () => {
    expect((await call("GET", "/api/spaces")).handled).toBe(false);
    expect((await call("GET", "/api/spaces/sp_1/claims")).handled).toBe(false);
    expect((await call("GET", "/api/people")).handled).toBe(false);
    expect((await call("DELETE", "/api/spaces/list")).handled).toBe(false);
  });

  it("lists by life area with the dormant bucket apart", async () => {
    mkSpace("sp_a", "goa trip", "Travel");
    mkSpace("sp_b", "tax filing", "Money");
    mkSpace("sp_c", "old thing", "Travel", "dormant");
    const r = await call("GET", "/api/spaces/list");
    expect(r.status).toBe(200);
    expect(r.body.areas.map((a: { area: string }) => a.area)).toEqual(["Money", "Travel"]);
    expect(r.body.dormant.map((s: { id: string }) => s.id)).toEqual(["sp_c"]);
  });

  it("views a space and 404s a missing one", async () => {
    mkSpace("sp_a", "goa trip", "Travel");
    const r = await call("GET", "/api/spaces/sp_a/view");
    expect(r.status).toBe(200);
    expect(r.body.space.label).toBe("goa trip");
    expect(r.body.birth).toMatchObject({ via: null, evidence: [] });
    expect((await call("GET", "/api/spaces/sp_nope/view")).status).toBe(404);
  });

  it("previews the sweep without a model call", async () => {
    mkSpace("sp_a", "goa trip", "Travel");
    const r = await call("GET", "/api/spaces/sp_a/sweep-preview");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ spaceId: "sp_a", count: 0, line: "nothing related yet" });
  });

  it("wakes a dormant space, and 409s one that is already awake", async () => {
    mkSpace("sp_sleep", "ma's birthday", "People", "dormant");
    const r = await call("POST", "/api/spaces/sp_sleep/wake", { signal: "calendar lead time T-14" });
    expect(r.status).toBe(200);
    expect(r.body.woke).toBe(true);
    expect((await call("POST", "/api/spaces/sp_sleep/wake", {})).status).toBe(409);
  });

  it("records an enrichment fetch and validates its body", async () => {
    mkSpace("sp_a", "goa trip", "Travel");
    const first = await call("POST", "/api/spaces/sp_a/enrichment", {
      kind: "fare",
      url: "https://x/fare",
      content: "₹4,300",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, queued: true });
    const same = await call("POST", "/api/spaces/sp_a/enrichment", {
      kind: "fare",
      url: "https://x/fare",
      content: "₹4,300",
    });
    expect(same.body).toMatchObject({ changed: false, queued: false });
    expect((await call("POST", "/api/spaces/sp_a/enrichment", { kind: "fare" })).status).toBe(400);
    expect(
      (await call("POST", "/api/spaces/sp_nope/enrichment", { kind: "f", url: "u", content: "c" })).status,
    ).toBe(404);
  });

  it("re-files a space between life areas and rejects an invented area", async () => {
    mkSpace("sp_a", "goa trip", "Money");
    const r = await call("POST", "/api/spaces/sp_a/refile", { life_area: "Travel" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ moved: true, from: "Money", to: "Travel" });
    expect((await call("POST", "/api/spaces/sp_a/refile", { life_area: "Nonsense" })).status).toBe(400);
    expect((await call("POST", "/api/spaces/sp_a/refile", {})).status).toBe(400);
    // A drop on the group it already sits in is a no-op, not an error page.
    expect((await call("POST", "/api/spaces/sp_a/refile", { life_area: "Travel" })).status).toBe(409);
  });

  it("re-files one episode into another space and back out to unsorted", async () => {
    mkSpace("sp_a", "a", "Travel");
    mkSpace("sp_b", "b", "Travel");
    getDb().prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep_1', 'sp_a', 'open')`).run();
    const into = await call("POST", "/api/spaces/sp_a/refile", { episode_id: "ep_1", to_space_id: "sp_b" });
    expect(into.status).toBe(200);
    expect(into.body).toMatchObject({ moved: true, from: "sp_a", to: "sp_b" });
    const out = await call("POST", "/api/spaces/sp_b/refile", { episode_id: "ep_1", to_space_id: null });
    expect(out.body).toMatchObject({ moved: true, to: null });
    expect(
      (getDb().prepare(`SELECT status FROM unsorted WHERE episode_id = 'ep_1'`).get() as { status: string }).status,
    ).toBe("open");
    expect(
      (await call("POST", "/api/spaces/sp_a/refile", { episode_id: "ep_1", to_space_id: 7 })).status,
    ).toBe(400);
  });

  it("serves the birth block an asked-for space was created with (SPC-05)", async () => {
    const created = bornAsked({ label: "plan hampi trek", utterance: "plan hampi trek in october", threadId: "th_7" });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") return;
    const r = await call("GET", `/api/spaces/${created.spaceId}/view`);
    expect(r.body.birth).toMatchObject({ via: "asked", thread_id: "th_7" });
    expect(r.body.birth.evidence[0].quote).toBe("plan hampi trek in october");
  });
});
