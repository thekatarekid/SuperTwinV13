// ===========================================================================
// World-model read routes (build P1.1): people (+ open merge questions),
// per-person claims + edges, spaces, per-space claims, claim history, tone.
// Exercised through the handler contract (returns false for unclaimed paths).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeClaimVersion, linkClaimToSpace, upsertToneProfile } from "../claims/store.js";
import { METADATA_DECIDER, writeEdge } from "../entities/edges.js";
import { createEntity, setCircle } from "../entities/registry.js";
import { handleWorldModelRoute } from "./worldmodel-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-wm-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ handled: boolean; status: number | null; body: unknown }> {
  const req = { method: "GET", url: path } as IncomingMessage;
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
  const handled = await handleWorldModelRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

describe("handleWorldModelRoute", () => {
  it("declines paths it does not own", async () => {
    expect((await get("/api/health")).handled).toBe(false);
    const post = { method: "POST", url: "/api/people" } as IncomingMessage;
    expect(await handleWorldModelRoute(post, {} as ServerResponse)).toBe(false);
  });

  it("serves people with circles and per-person claims + edges", async () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    const tanvi = createEntity({ type: "person", canonical: "Tanvi" });
    setCircle(rohan.id, "close_friends");
    writeEdge({
      kind: "related_to",
      subtype: "friend",
      srcEntityId: rohan.id,
      dstEntityId: tanvi.id,
      confidence: 0.9,
      decidedBy: METADATA_DECIDER,
    });
    writeClaimVersion({
      claimKey: "rohan.pref",
      kind: "preference",
      subjectId: rohan.id,
      text: "prefers filter coffee",
      confidence: 0.9,
      statedAt: "2026-08-01T10:00:00Z",
      evidence: [{ event_ids: ["e1"], quote: "filter coffee only" }],
      decidedBy: "llm:extract",
    });

    const people = await get("/api/people");
    expect(people.status).toBe(200);
    const list = (people.body as { people: { name: string; circle: string | null }[] }).people;
    expect(list.map((p) => p.name).sort()).toEqual(["Rohan", "Tanvi"]);
    expect(list.find((p) => p.name === "Rohan")!.circle).toBe("close_friends");

    const detail = await get(`/api/people/${rohan.id}/claims`);
    const body = detail.body as { circle: string; claims: unknown[]; edges: unknown[] };
    expect(body.circle).toBe("close_friends");
    expect(body.claims).toHaveLength(1);
    expect(body.edges).toHaveLength(1);
  });

  it("serves spaces (with status filter), space claims, claim history and tone", async () => {
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa','Goa trip with Rohan in December','active')`)
      .run();
    getDb().prepare(`INSERT INTO spaces (id, label) VALUES ('sp_x','Diwali gifts for the family')`).run();
    writeClaimVersion({
      claimKey: "goa.dates",
      kind: "fact",
      text: "trip is 18-21 Dec",
      confidence: 0.93,
      statedAt: "2026-08-25T19:42:00Z",
      evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
      decidedBy: "llm:extract",
    });
    linkClaimToSpace("sp_goa", "goa.dates", "orient");

    expect(((await get("/api/spaces")).body as { spaces: unknown[] }).spaces).toHaveLength(2);
    expect(((await get("/api/spaces?status=active")).body as { spaces: unknown[] }).spaces).toHaveLength(1);
    expect(((await get("/api/spaces/sp_goa/claims")).body as { claims: unknown[] }).claims).toHaveLength(1);

    const claim = await get("/api/claims/goa.dates");
    expect((claim.body as { active: { text: string } }).active.text).toBe("trip is 18-21 Dec");
    expect((await get("/api/claims/nope")).status).toBe(404);

    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    upsertToneProfile({ personEntityId: rohan.id, register: "casual" });
    const tone = await get(`/api/tone?person=${rohan.id}`);
    expect((tone.body as { profile: { register: string } }).profile.register).toBe("casual");
    expect((await get("/api/tone")).status).toBe(400);
  });
});
