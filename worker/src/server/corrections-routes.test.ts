// ===========================================================================
// Corrections pipeline (build P1.7, spec §14.4): drag-move, chips, and
// "Tell the twin" all run the same path — mutation + corrections row +
// decisions row + auto-drafted eval case. No live model calls: the utterance
// parser is injected (the production parser is the traced runPrompt path).
// Covers the FIX-01/02/05 unit shapes and the parse-output contract.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { claimHistory, claimsAbout, writeClaimVersion } from "../claims/store.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { circleOf, createEntity } from "../entities/registry.js";
import { parseCorrectionOutput } from "../prompts/correction-parse.v1.js";
import { handleCorrectionsRoute, type CorrectionParser } from "./corrections-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-corrections-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_EVAL_DRAFTS_DIR = join(tmpDir, "eval-drafts");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  parser?: CorrectionParser,
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as IncomingMessage;
  (req as any).method = method;
  (req as any).url = path;
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
  const neverParse: CorrectionParser = async () => {
    throw new Error("parser should not be called for structured corrections");
  };
  const handled = await handleCorrectionsRoute(req, res, parser ?? neverParse);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

function seedTaskAndSpaces(): void {
  const db = getDb();
  db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_falcon', 'Project Falcon', 'active')`).run();
  db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_side', 'Side project', 'active')`).run();
  db.prepare(
    `INSERT INTO tasks (id, title, status, space_id, owner) VALUES ('t1', 'book badminton court', 'open', 'sp_falcon', 'self')`,
  ).run();
}

describe("parseCorrectionOutput (correction-parse.v1)", () => {
  it("parses the one-line JSON contract", () => {
    expect(parseCorrectionOutput(`{"type":"wrong_person","owner":"Karan"}`)).toEqual({
      type: "wrong_person",
      owner: "Karan",
    });
  });

  it("tolerates prose/fences around the object but rejects garbage", () => {
    expect(parseCorrectionOutput('Here: {"type":"cancel"}')).toEqual({ type: "cancel" });
    expect(parseCorrectionOutput("no json at all")).toBeNull();
    expect(parseCorrectionOutput(`{"type":"explode"}`)).toBeNull();
  });
});

describe("handleCorrectionsRoute", () => {
  it("declines paths it does not own", async () => {
    expect((await call("GET", "/api/health")).handled).toBe(false);
  });

  it("FIX-05: drag-move runs the full pipeline — mutation, decision, eval draft, undo", async () => {
    seedTaskAndSpaces();
    const moved = await call("POST", "/api/corrections", {
      target: { kind: "task", id: "t1" },
      structured: { type: "move", to_space_id: "sp_side" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("applied");

    // Not a ui-only-move: the world model row changed…
    expect(getDb().prepare(`SELECT space_id FROM tasks WHERE id = 't1'`).get()).toEqual({
      space_id: "sp_side",
    });
    // …a decision row holds the undo payload…
    const decision = getDb()
      .prepare(`SELECT * FROM decisions WHERE id = ?`)
      .get(moved.body.decision_id) as any;
    expect(decision.action).toBe("move");
    expect(JSON.parse(decision.old_json).space_id).toBe("sp_falcon");
    // …and an eval case was auto-drafted with the original context.
    const drafts = readdirSync(join(tmpDir, "eval-drafts"));
    expect(drafts.length).toBe(1);
    const fixture = JSON.parse(readFileSync(join(tmpDir, "eval-drafts", drafts[0]!), "utf8"));
    expect(fixture.status).toBe("draft");
    expect(fixture.category).toBe("FIX");
    expect(fixture.setup.before.space_id).toBe("sp_falcon");

    // Undo restores the previous filing and marks the decision reversed.
    const undo = await call("POST", `/api/corrections/${moved.body.correction_id}/undo`);
    expect(undo.status).toBe(200);
    expect(getDb().prepare(`SELECT space_id FROM tasks WHERE id = 't1'`).get()).toEqual({
      space_id: "sp_falcon",
    });
    expect(
      (getDb().prepare(`SELECT reversed_by FROM decisions WHERE id = ?`).get(moved.body.decision_id) as any)
        .reversed_by,
    ).toBe(moved.body.correction_id);
  });

  it("FIX-01: 'this is karan's task, not mine' parses to wrong_person and mutates", async () => {
    seedTaskAndSpaces();
    const parser: CorrectionParser = async (_t, _s, utterance) => {
      expect(utterance).toContain("karan");
      return { type: "wrong_person", owner: "Karan" };
    };
    const out = await call(
      "POST",
      "/api/corrections",
      { target: { kind: "task", id: "t1" }, utterance: "this is karan's task, not mine" },
      parser,
    );
    expect(out.body.status).toBe("applied"); // not parse-to-nothing
    expect(getDb().prepare(`SELECT owner FROM tasks WHERE id = 't1'`).get()).toEqual({ owner: "Karan" });
    expect(getDb().prepare(`SELECT status FROM corrections`).get()).toEqual({ status: "applied" });
  });

  it("FIX-02: cancelling a space closes tasks as CANCELLED (not done) and deletes nothing", async () => {
    seedTaskAndSpaces();
    const parser: CorrectionParser = async () => ({ type: "cancel" });
    const out = await call(
      "POST",
      "/api/corrections",
      { target: { kind: "space", id: "sp_falcon" }, utterance: "we cancelled this, planning jan instead" },
      parser,
    );
    expect(out.body.status).toBe("applied");
    expect(getDb().prepare(`SELECT status FROM tasks WHERE id = 't1'`).get()).toEqual({
      status: "cancelled", // false-victory (done) would be wrong
    });
    expect(getDb().prepare(`SELECT status FROM spaces WHERE id = 'sp_falcon'`).get()).toEqual({
      status: "dormant",
    });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });
  });

  it("a parse that yields nothing is recorded pending, never dropped", async () => {
    seedTaskAndSpaces();
    const parser: CorrectionParser = async () => null;
    const out = await call(
      "POST",
      "/api/corrections",
      { target: { kind: "task", id: "t1" }, utterance: "hmm interesting" },
      parser,
    );
    expect(out.body.status).toBe("pending");
    expect(getDb().prepare(`SELECT status FROM corrections`).get()).toEqual({ status: "pending" });
    // Still drafts the eval case — pending parses are what humans review.
    expect(readdirSync(join(tmpDir, "eval-drafts")).length).toBe(1);
  });

  it("CIR-04: dragging a person between circles is a correction — logged, applied at once, eval-drafted, undoable", async () => {
    // Priya auto-inferred "friends"; the user drags her to "close friends".
    createEntity({ type: "person", canonical: "Priya", id: "ent_priya0000000000000000", seenAt: "2026-08-01T00:00:00Z" });
    getDb().prepare(`UPDATE entities SET circle = 'friends' WHERE id = 'ent_priya0000000000000000'`).run();

    const out = await call("POST", "/api/corrections", {
      target: { kind: "person", id: "ent_priya0000000000000000" },
      structured: { type: "set_circle", circle: "close_friends" },
    });
    expect(out.body.status).toBe("applied");
    // The circle shifts immediately — nudge thresholds / brief inclusion /
    // applicability all read this stored field, so downstream reflects it now.
    expect(circleOf("ent_priya0000000000000000")).toBe("close_friends");
    // Correction event logged + decisions row (the change is reversible).
    expect(getDb().prepare(`SELECT status, target_kind FROM corrections`).get()).toEqual({
      status: "applied",
      target_kind: "person",
    });
    expect(out.body.decision_id).toBeTruthy();
    // An eval case is auto-drafted from the correction (promotion loop).
    const drafts = readdirSync(join(tmpDir, "eval-drafts"));
    expect(drafts.length).toBe(1);
    const fixture = JSON.parse(readFileSync(join(tmpDir, "eval-drafts", drafts[0]!), "utf8"));
    expect(JSON.stringify(fixture)).toContain("set_circle");
    // edit-ignored would be the failure mode; undo restores the old circle.
    const undo = await call("POST", `/api/corrections/${out.body.correction_id}/undo`);
    expect(undo.body.undone).toBe(true);
    expect(circleOf("ent_priya0000000000000000")).toBe("friends");
  });

  it("FIX-03: 'she's my cousin, not a coworker' supersedes the claim (validity end, kept) and moves the circle", async () => {
    // Riya misclaimed as coworker.
    createEntity({ type: "person", canonical: "Riya", id: "ent_riya00000000000000000", seenAt: "2026-08-01T00:00:00Z" });
    getDb().prepare(`UPDATE entities SET circle = 'coworkers' WHERE id = 'ent_riya00000000000000000'`).run();
    const old = writeClaimVersion({
      claimKey: "person.riya.relationship",
      kind: "relationship",
      subjectId: "ent_riya00000000000000000",
      text: "coworker",
      confidence: 0.7,
      statedAt: "2026-08-10T00:00:00Z",
      evidence: [{ quote: "riya from office joined", event_ids: ["e9"] }],
      decidedBy: "llm:extract",
    });

    const out = await call("POST", "/api/corrections", {
      target: { kind: "person", id: "ent_riya00000000000000000" },
      structured: { type: "set_relationship", relation: "cousin", circle: "family" },
    });
    expect(out.body.status).toBe("applied");

    // Old claim superseded — validity end + closed_by, NEVER deleted
    // (silent-overwrite is the wrong[] here; history keeps both versions).
    const history = claimHistory("person.riya.relationship");
    expect(history.length).toBe(2);
    const oldRow = history.find((v) => v.id === old.id)!;
    expect(oldRow.closedBy).toBe("user");
    expect(oldRow.validTo).not.toBeNull();
    // The new relationship claim is the active one.
    const active = claimsAbout("ent_riya00000000000000000", "relationship");
    expect(active.length).toBe(1);
    expect(active[0]!.text).toBe("cousin");
    // Circle moved to family → dependent judgments (tone, applicability,
    // nudge thresholds) read the new circle immediately.
    expect(circleOf("ent_riya00000000000000000")).toBe("family");
    // Correction evented + eval case drafted.
    expect(getDb().prepare(`SELECT status FROM corrections`).get()).toEqual({ status: "applied" });
    expect(readdirSync(join(tmpDir, "eval-drafts")).length).toBe(1);
  });

  it("set_circle rejects a value outside the nine circles (recorded pending, never applied)", async () => {
    createEntity({ type: "person", canonical: "Dev", id: "ent_dev000000000000000000", seenAt: null });
    const out = await call("POST", "/api/corrections", {
      target: { kind: "person", id: "ent_dev000000000000000000" },
      structured: { type: "set_circle", circle: "besties" },
    });
    expect(out.body.status).toBe("pending");
    expect(circleOf("ent_dev000000000000000000")).toBeNull();
  });

  it("validates the request shape", async () => {
    expect((await call("POST", "/api/corrections", {})).status).toBe(400);
    expect(
      (await call("POST", "/api/corrections", { target: { kind: "task", id: "t1" } })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/corrections", {
          target: { kind: "task", id: "ghost" },
          structured: { type: "already_done" },
        })
      ).status,
    ).toBe(404);
  });
});
