// ===========================================================================
// People routes (V6 P1 S5.4) through the handler contract: the person card,
// "Who I am", the follow-up radar, merge/split by drag and their undo, the
// permanent "different people" verdict, the learned radar lead, and the
// circle inference. Temp DB, no server, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeClaimVersion } from "../claims/store.js";
import { createEntity, resolveEntityId, setCircle } from "../entities/registry.js";
import { SELF_ENTITY_ID } from "../db/migrations/0201_v6_graph.js";
import { handlePeopleRoute } from "./people-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-people-routes-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb().prepare(`INSERT INTO sources (id, type, display_name) VALUES ('src_wa', 'whatsapp', 'WhatsApp')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(method: string, path: string, body?: unknown): Promise<{ handled: boolean; status: number | null; body: any }> {
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
  const handled = await handlePeopleRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

function person(name: string): string {
  return createEntity({ type: "person", canonical: name }).id;
}

describe("handlePeopleRoute", () => {
  it("declines the paths world-model owns", async () => {
    expect((await call("GET", "/api/people")).handled).toBe(false);
    expect((await call("GET", "/api/people/ent_1/claims")).handled).toBe(false);
    expect((await call("GET", "/api/spaces/list")).handled).toBe(false);
    expect((await call("DELETE", "/api/people/merge")).handled).toBe(false);
  });

  it("GET /api/people/:id/card reads the card at request time", async () => {
    const id = person("Sameer");
    setCircle(id, "coworkers", { decidedBy: "code:circles", reason: "work vocabulary" });
    const r = await call("GET", `/api/people/${id}/card`);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ id, name: "Sameer", circle: "coworkers", circleDecidedBy: "code:circles" });
    expect(r.body.card.radarLeadDays).toMatchObject({ days: 3 });
    expect(r.body.alias_chips).toEqual([]);
    expect((await call("GET", "/api/people/ent_nope/card")).status).toBe(404);
  });

  it("GET /api/people/who-i-am says it is built by processing, not a form", async () => {
    const empty = await call("GET", "/api/people/who-i-am");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ filledBy: "processing", empty: true });
    expect(String(empty.body.emptyNote)).toContain("no form");

    writeClaimVersion({
      claimKey: "self.home",
      kind: "fact",
      subjectId: SELF_ENTITY_ID,
      text: "lives in Bengaluru",
      confidence: 0.9,
      statedAt: "2026-08-01T00:00:00.000Z",
      evidence: [{ quote: "I'm in Bengaluru", event_ids: ["e1"] }],
      decidedBy: "llm:extract",
    });
    const filled = await call("GET", "/api/people/who-i-am");
    expect(filled.body.empty).toBe(false);
    expect(filled.body.basics[0]).toMatchObject({ text: "lives in Bengaluru", claimKey: "self.home", editable: true });
  });

  it("GET /api/people/radar computes the radar at the time asked", async () => {
    const sameer = person("Sameer");
    setCircle(sameer, "coworkers", { decidedBy: "code:circles" });
    getDb()
      .prepare(`INSERT INTO streams (id, source_id, external_key, label, stream_kind) VALUES ('str_s', 'src_wa', 'sameer@s.whatsapp.net', 'Sameer', 'dm')`)
      .run();
    getDb()
      .prepare(
        `INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state, actor_entity_id, ingested_at, stream_key, actor, origin)
         VALUES ('e1', 'src_wa', 'str_s', '2026-09-01T05:00:00.000Z', 'Asia/Kolkata', 'wa.message', 'hey, done with the deck?', 0, 'none', ?, '2026-09-01T05:00:00.000Z', 'sameer@s.whatsapp.net', 'contact:sameer', 'live')`,
      )
      .run(sameer);
    const r = await call("GET", "/api/people/radar?now=2026-09-06T05:30:00.000Z");
    expect(r.body.radar).toHaveLength(1);
    expect(r.body.radar[0]).toMatchObject({ direction: "i_owe", leadDays: 3, overdue: true });
    const mine = await call("GET", `/api/people/radar?person=${sameer}&now=2026-09-06T05:30:00.000Z`);
    expect(mine.body.radar).toHaveLength(1);

    const lead = await call("POST", `/api/people/${sameer}/radar-lead`, { days: 1 });
    expect(lead.status).toBe(200);
    const after = await call("GET", `/api/people/radar?person=${sameer}&now=2026-09-06T05:30:00.000Z`);
    expect(after.body.radar[0].leadDays).toBe(1);
    expect((await call("POST", `/api/people/${sameer}/radar-lead`, { days: "soon" })).status).toBe(400);
    expect((await call("POST", "/api/people/ent_nope/radar-lead", { days: 1 })).status).toBe(404);
  });
});

describe("merge and split by drag, with undo", () => {
  it("merges on a drag and splits back on undo", async () => {
    const a = person("Rahul Mehta");
    const b = person("Rahul M");
    const merged = await call("POST", "/api/people/merge", { loser: b, winner: a });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ ok: true, action: "merge", winner: a, loser: b });
    expect(resolveEntityId(b)).toBe(a);
    const card = await call("GET", `/api/people/${b}/card`);
    expect(card.body.card.id).toBe(a);
    expect(card.body.alias_chips).toEqual([{ id: b, name: "Rahul M" }]);
    const aliases = await call("GET", "/api/people/aliases");
    expect(aliases.body.aliases[a]).toEqual([{ id: b, name: "Rahul M" }]);

    const undone = await call("POST", "/api/people/undo", { mutation_id: merged.body.undoId });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ ok: true, action: "split" });
    expect(resolveEntityId(b)).toBe(b);

    const again = await call("POST", "/api/people/undo", { mutation_id: merged.body.undoId });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("already_applied");
  });

  it("splits an alias out and merges it back on undo, through the negative pair", async () => {
    const a = person("Rahul Mehta");
    const b = person("Rahul M");
    await call("POST", "/api/people/merge", { loser: b, winner: a });
    const split = await call("POST", "/api/people/split", { entity_id: b });
    expect(split.status).toBe(200);
    expect(resolveEntityId(b)).toBe(b);
    const undone = await call("POST", "/api/people/undo", { mutation_id: split.body.undoId });
    expect(undone.body).toMatchObject({ ok: true, action: "merge" });
    expect(resolveEntityId(b)).toBe(a);
  });

  it("refuses a merge through a recorded 'different', and says which rule refused it", async () => {
    const a = person("Rahul Arora");
    const b = person("Rahul Mehta");
    expect((await call("POST", "/api/people/different", { a, b })).status).toBe(200);
    const merged = await call("POST", "/api/people/merge", { loser: b, winner: a });
    expect(merged.status).toBe(409);
    expect(merged.body).toMatchObject({ ok: false, refused: "negative_pair" });
    expect(String(merged.body.summary)).toContain("different people");
    expect(resolveEntityId(b)).toBe(b);
  });

  it("validates its inputs instead of guessing", async () => {
    expect((await call("POST", "/api/people/merge", { loser: "x" })).status).toBe(400);
    expect((await call("POST", "/api/people/split", {})).status).toBe(400);
    expect((await call("POST", "/api/people/undo", {})).status).toBe(400);
    expect((await call("POST", "/api/people/different", { a: "x" })).status).toBe(400);
    expect((await call("POST", "/api/people/undo", { mutation_id: "mut_nope" })).status).toBe(409);
  });
});

describe("circle inference", () => {
  it("assigns the unassigned and never overwrites a user's drag", async () => {
    const maid = person("Sunita");
    writeClaimVersion({
      claimKey: `person.${maid}.relationship`,
      kind: "relationship",
      subjectId: maid,
      text: "our maid",
      confidence: 0.9,
      statedAt: "2026-03-01T00:00:00.000Z",
      evidence: [{ quote: "aunty maid coming at 4", event_ids: [] }],
      decidedBy: "llm:extract",
    });
    const priya = person("Priya");
    setCircle(priya, "close_friends", { decidedBy: "user", reason: "drag in People" });
    setCircle(priya, null, { decidedBy: "user", reason: "cleared" });

    const r = await call("POST", "/api/people/circles/infer", {});
    expect(r.status).toBe(200);
    expect(r.body.assigned.map((a: { id: string }) => a.id)).toContain(maid);
    expect(r.body.skipped.find((s: { id: string }) => s.id === priya)).toMatchObject({ why: "user-set" });
  });
});
