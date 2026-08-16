// ===========================================================================
// The wrong-attach audit (§14.2 `wrong-attach rate`, build items 2.1 / 2.2).
//
// The point of these tests is FALSIFIABILITY. The check this module replaced
// asked whether an attach target was in the engine's own candidate list, and
// `engine.ts` only ever attaches to something from that list — so the gate
// read 0 by construction, over any corpus, broken engine or not. Every
// `ok: false` case below drives the gate off zero on purpose: if these stop
// failing, the gate has stopped being a gate.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { upsertSource, upsertStream } from "../db/ingest.js";
import { createAliasTable } from "../wire/aliases.js";
import { auditAttaches, wrongAttachRate, wrongAttaches } from "./audit.js";
import { ATTACH_CONFIDENCE_FLOOR, runEpisodePass, type EngineSession, type EpisodeJudge } from "./engine.js";
import type { OpenEpisodeCandidate } from "./store.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;
let C1 = "";
let C2 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-epaudit-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  C2 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "Family", kind: "group" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A sealed session of `streamId`, with two event ids of its own. */
function session(id: string, streamId: string): EngineSession {
  const stamp = new Date(NOW).toISOString();
  const eventIds = [`${id}_a`, `${id}_b`];
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, 'sealed', ?)`,
    )
    .run(id, streamId, stamp, stamp, JSON.stringify(eventIds), `h_${id}`);
  return { id, streamId, sourceId: "whatsapp", contentHash: `h_${id}`, eventIds, startedAt: stamp, endedAt: stamp };
}

/** An open episode of `streamId`, ready to be offered as a candidate. */
function openEpisode(id: string, streamId: string, label: string): OpenEpisodeCandidate {
  const stamp = new Date(NOW - 3_600_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', ?, 'model', '[]', '[]', '[]', 'open', ?, ?)`,
    )
    .run(id, streamId, label, stamp, stamp);
  return { id, streamId, topicLabel: label, lastActiveAt: stamp, entityIds: [] };
}

/**
 * A judge that attaches the whole session to the first candidate — the same
 * `G` line shape J-027..J-038 freeze, built over the engine's own alias table.
 */
function attachJudge(confidence: number, label: string): EpisodeJudge {
  return (req) => {
    const table = createAliasTable();
    for (const candidate of req.candidates) table.mint("episode", candidate.id, candidate.topicLabel ?? "");
    const tokens = req.session.eventIds.map((id) => parseInt(table.mintEvent(id), 36));
    return {
      response: `G|s1|${tokens.join(",")}|att|e1|${confidence}|${label}`,
      table,
      model: "sonnet-5",
    };
  };
}

describe("auditAttaches", () => {
  it("passes a same-stream attach above the floor, and says what justified it", () => {
    const ep = openEpisode("ep_e1", C1, "Goa trip");
    const result = runEpisodePass(session("s1", C1), {
      now: NOW,
      candidates: [ep],
      judge: attachJudge(0.93, "Goa trip"),
    });
    expect(result.decision).toBe("judged");
    expect(result.segments[0]!.decision).toBe("attach");

    const audits = auditAttaches();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ok).toBe(true);
    expect(audits[0]!.reason).toContain("same-stream attach at confidence 0.93");
    expect(wrongAttachRate()).toBe(0);
  });

  it("FIRES on a cross-stream attach — the invariant a candidate-list check cannot see", () => {
    // The engine trusts the candidates it is handed. Hand it an episode of
    // ANOTHER stream and the attach commits — and the old check would still
    // have called it clean, because the target IS in the list it came from.
    const foreign = openEpisode("ep_other", C2, "Goa trip");
    const result = runEpisodePass(session("s1", C1), {
      now: NOW,
      candidates: [foreign],
      judge: attachJudge(0.93, "Goa trip"),
    });
    expect(result.segments[0]!.episodeId).toBe("ep_other");

    const wrong = wrongAttaches();
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.kind).toBe("cross_stream");
    expect(wrong[0]!.reason).toContain("episodes are stream-scoped");
    expect(wrongAttachRate()).toBe(1);
  });

  it("FIRES on an attach recorded below the 0.6 confidence floor", () => {
    const ep = openEpisode("ep_e1", C1, "Goa trip");
    runEpisodePass(session("s1", C1), { now: NOW, candidates: [ep], judge: attachJudge(0.93, "Goa trip") });

    // An attach that committed under §12.3's bar, whatever produced it.
    const row = getDb().prepare(`SELECT id, output_json FROM episode_verdicts`).get() as {
      id: string;
      output_json: string;
    };
    const parsed = JSON.parse(row.output_json) as { segments: { confidence: number }[] };
    parsed.segments[0]!.confidence = ATTACH_CONFIDENCE_FLOOR - 0.1;
    getDb().prepare(`UPDATE episode_verdicts SET output_json = ? WHERE id = ?`).run(JSON.stringify(parsed), row.id);

    const wrong = wrongAttaches();
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.kind).toBe("below_floor");
    expect(wrongAttachRate()).toBe(1);
  });

  it("FIRES on an attach nobody can attribute to a verdict", () => {
    const ep = openEpisode("ep_e1", C1, "Goa trip");
    runEpisodePass(session("s1", C1), { now: NOW, candidates: [ep], judge: attachJudge(0.93, "Goa trip") });
    getDb().prepare(`UPDATE episode_sessions SET verdict_id = NULL WHERE added_by = 'attach'`).run();

    const wrong = wrongAttaches();
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.kind).toBe("no_verdict");
  });

  it("reports null — not zero — when nothing attached at all", () => {
    const result = runEpisodePass(session("s1", C1), { now: NOW, candidates: [] });
    expect(result.decision).toBe("one_to_one");
    expect(auditAttaches()).toHaveLength(0);
    // `no data`, never a flattering pass: gates.ts's rule.
    expect(wrongAttachRate()).toBeNull();
  });
});
