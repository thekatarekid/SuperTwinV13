// ===========================================================================
// Honest cascading delete (build P2.4). The HARD gate: after deleting a
// screen session, NO derived row anywhere references a deleted event id —
// not by FK, not inside evidence JSON, not in a queue list, not in FTS.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { deleteScreenSpan, hardDeleteEvents } from "./delete-cascade.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cascade-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function screenEnv(ts: string, text: string, key = "screen:app:Figma"): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source: "screen",
    kind: "screen.capture",
    origin: "live",
    streamKey: key,
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, app: "Figma" },
  };
}

/**
 * Seed one screen session (3 events) + one surviving WhatsApp event, and hang
 * the full derivation off them: episode + ranges, unsorted, claims (header +
 * versions with evidence), a task, an enrichment bundle, a content digest, a
 * context escalation, embeddings, and decisions.
 */
function seed(): { doomed: string[]; survivor: string; episodeId: string } {
  const db = getDb();
  const r = appendEvents(
    [
      screenEnv("2026-08-28T10:00:00.000Z", "figma v13 mocks A"),
      screenEnv("2026-08-28T10:02:00.000Z", "figma v13 mocks B"),
      screenEnv("2026-08-28T10:04:00.000Z", "figma v13 mocks C"),
      {
        ts: "2026-08-28T09:00:00.000Z",
        capturedAt: "2026-08-28T09:00:00.000Z",
        source: "whatsapp",
        kind: "wa.message",
        origin: "live",
        streamKey: "goa@g.us",
        actor: "contact:rohan",
        roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
        payload: { text: "pool villa pls" },
      },
    ],
    NOW,
  );
  const [e1, e2, e3, wa] = r.ids;

  db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp1', 'Work v13', 'active')`).run();
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary) VALUES ('ep1', 'screen:st:screen:app:Figma', 'sp1', 'open', 'figma session')`,
  ).run();
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id) VALUES ('epe1', 'ep1', ?, ?)`,
  ).run(e1, e3);
  db.prepare(`INSERT INTO unsorted (id, episode_id, reason) VALUES ('un1', 'ep1', 'low conf')`).run();
  db.prepare(
    `INSERT INTO t2_review_queue (id, kind, episode_id, space_id) VALUES ('t2a', 'flag_overlap', 'ep1', 'sp1')`,
  ).run();
  db.prepare(
    `INSERT INTO decide_queue (space_id, pending_episode_ids) VALUES ('sp1', ?)`,
  ).run(JSON.stringify(["ep1", "ep_other"]));

  // A second episode on the WA event — must survive untouched.
  db.prepare(
    `INSERT INTO episodes (id, stream_id, state, summary) VALUES ('ep2', 'whatsapp:st:goa@g.us', 'open', 'goa chat')`,
  ).run();
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id) VALUES ('epe2', 'ep2', ?, ?)`,
  ).run(wa, wa);

  // Claims: one version fully evidenced by doomed events, one mixed.
  db.prepare(
    `INSERT INTO claims (claim_key, kind, version_count, active_version_id) VALUES ('ck_doomed', 'fact', 1, 'cv1')`,
  ).run();
  db.prepare(
    `INSERT INTO claim_versions (id, claim_key, text, stated_at, evidence_json) VALUES ('cv1', 'ck_doomed', 'works in figma', '2026-08-28T10:02:00.000Z', ?)`,
  ).run(JSON.stringify([{ event_ids: [e1, e2], quote: "figma v13 mocks" }]));
  db.prepare(
    `INSERT INTO claims (claim_key, kind, version_count, active_version_id) VALUES ('ck_mixed', 'fact', 1, 'cv2')`,
  ).run();
  db.prepare(
    `INSERT INTO claim_versions (id, claim_key, text, stated_at, evidence_json) VALUES ('cv2', 'ck_mixed', 'planning goa', '2026-08-28T10:03:00.000Z', ?)`,
  ).run(
    JSON.stringify([
      { event_ids: [e3], quote: "figma v13 mocks C" },
      { event_ids: [wa], quote: "pool villa pls" },
    ]),
  );

  // Tasks: one fully derived from the session, one mixed.
  db.prepare(
    `INSERT INTO tasks (id, title, evidence_json) VALUES ('tk_doomed', 'finish mocks', ?)`,
  ).run(JSON.stringify([{ event_ids: [e2], quote: "figma v13 mocks B" }]));
  db.prepare(
    `INSERT INTO tasks (id, title, evidence_json) VALUES ('tk_mixed', 'book villa', ?)`,
  ).run(
    JSON.stringify([
      { event_ids: [wa], quote: "pool villa pls" },
      { event_ids: [e1], quote: "figma v13 mocks A" },
    ]),
  );

  db.prepare(
    `INSERT INTO enrichment_bundles (id, event_ids_json, min_rowid, max_rowid, pending_count)
     VALUES ('bun1', ?, 1, 4, 0)`,
  ).run(JSON.stringify([e1, wa]));

  // Digest for a doomed event's content hash + one for the survivor's.
  const hashes = db
    .prepare(`SELECT id, content_hash FROM events WHERE id IN (?,?)`)
    .all(e1, wa) as { id: string; content_hash: string }[];
  for (const h of hashes) {
    db.prepare(`INSERT INTO content_digests (content_hash, digest_json) VALUES (?, ?)`).run(
      h.content_hash,
      JSON.stringify({ line: "digest" }),
    );
  }

  db.prepare(
    `INSERT INTO context_escalations (id, event_id, level, consumer) VALUES ('esc1', ?, 'L1', 'packer')`,
  ).run(e2);
  db.prepare(
    `INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, 'm', 2, x'00000000')`,
  ).run(e1);

  writeDecision({ pass: "orient", targetKind: "event", targetId: e1, action: "observe" });
  writeDecision({ pass: "orient", targetKind: "episode", targetId: "ep1", action: "create" });
  writeDecision({ pass: "extract", targetKind: "task", targetId: "tk_doomed", action: "create" });
  writeDecision({ pass: "extract", targetKind: "task", targetId: "tk_mixed", action: "create" });

  return { doomed: [e1, e2, e3], survivor: wa, episodeId: "ep1" };
}

/** Scan EVERY reference surface for a mention of the given event ids. */
function referencesAnywhere(ids: string[]): string[] {
  const db = getDb();
  const found: string[] = [];
  const check = (label: string, rows: unknown[]): void => {
    if (rows.length > 0) found.push(`${label}:${rows.length}`);
  };
  for (const id of ids) {
    check(`events`, db.prepare(`SELECT 1 FROM events WHERE id = ?`).all(id));
    check(
      `episode_events`,
      db
        .prepare(`SELECT 1 FROM episode_events WHERE start_event_id = ? OR end_event_id = ?`)
        .all(id, id),
    );
    check(`evidence`, db.prepare(`SELECT 1 FROM evidence WHERE event_id = ?`).all(id));
    check(`mentions`, db.prepare(`SELECT 1 FROM mentions WHERE event_id = ?`).all(id));
    check(
      `event_bridge_keys`,
      db.prepare(`SELECT 1 FROM event_bridge_keys WHERE event_id = ?`).all(id),
    );
    check(
      `event_embeddings`,
      db.prepare(`SELECT 1 FROM event_embeddings WHERE event_id = ?`).all(id),
    );
    check(
      `context_escalations`,
      db.prepare(`SELECT 1 FROM context_escalations WHERE event_id = ?`).all(id),
    );
    check(
      `claim_versions_json`,
      db.prepare(`SELECT 1 FROM claim_versions WHERE evidence_json LIKE ?`).all(`%${id}%`),
    );
    check(
      `tasks_json`,
      db.prepare(`SELECT 1 FROM tasks WHERE evidence_json LIKE ?`).all(`%${id}%`),
    );
    check(
      `enrichment_bundles_json`,
      db.prepare(`SELECT 1 FROM enrichment_bundles WHERE event_ids_json LIKE ?`).all(`%${id}%`),
    );
    check(
      `decisions`,
      db.prepare(`SELECT 1 FROM decisions WHERE target_kind = 'event' AND target_id = ?`).all(id),
    );
  }
  return found;
}

describe("hard delete cascade", () => {
  it("HARD: no derived row anywhere references a deleted event", () => {
    const { doomed, survivor } = seed();
    const report = hardDeleteEvents(doomed, { reason: "test span delete" });
    expect(report.events_deleted).toBe(3);
    expect(referencesAnywhere(doomed)).toEqual([]);
    // The survivor and its derivation are untouched.
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM events WHERE id = ?`).get(survivor)).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM episodes WHERE id = 'ep2'`).get()).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'tk_mixed'`).get()).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM claims WHERE claim_key = 'ck_mixed'`).get()).toBeTruthy();
  });

  it("episode shells, unsorted, queues and FTS follow the events", () => {
    const { doomed } = seed();
    const db = getDb();
    expect(db.prepare(`SELECT COUNT(*) n FROM events_fts WHERE events_fts MATCH 'figma'`).get()).toMatchObject({ n: 3 });
    hardDeleteEvents(doomed, { reason: "test" });
    expect(db.prepare(`SELECT 1 FROM episodes WHERE id = 'ep1'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM unsorted WHERE id = 'un1'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM t2_review_queue WHERE id = 't2a'`).get()).toBeUndefined();
    const dq = db
      .prepare(`SELECT pending_episode_ids FROM decide_queue WHERE space_id = 'sp1'`)
      .get() as { pending_episode_ids: string };
    expect(JSON.parse(dq.pending_episode_ids)).toEqual(["ep_other"]);
    expect(
      db.prepare(`SELECT COUNT(*) n FROM events_fts WHERE events_fts MATCH 'figma'`).get(),
    ).toMatchObject({ n: 0 });
  });

  it("claims: fully-doomed version+header deleted; mixed evidence stripped", () => {
    const { doomed, survivor } = seed();
    hardDeleteEvents(doomed, { reason: "test" });
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM claims WHERE claim_key = 'ck_doomed'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM claim_versions WHERE id = 'cv1'`).get()).toBeUndefined();
    const cv2 = db
      .prepare(`SELECT evidence_json FROM claim_versions WHERE id = 'cv2'`)
      .get() as { evidence_json: string };
    const entries = JSON.parse(cv2.evidence_json) as { event_ids: string[] }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].event_ids).toEqual([survivor]);
    const header = db
      .prepare(`SELECT version_count, active_version_id FROM claims WHERE claim_key = 'ck_mixed'`)
      .get() as { version_count: number; active_version_id: string };
    expect(header.version_count).toBe(1);
    expect(header.active_version_id).toBe("cv2");
  });

  it("tasks: fully-derived deleted (with its decisions); mixed stripped", () => {
    const { doomed, survivor } = seed();
    const report = hardDeleteEvents(doomed, { reason: "test" });
    expect(report.tasks_deleted).toBe(1);
    expect(report.tasks_stripped).toBe(1);
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'tk_doomed'`).get()).toBeUndefined();
    expect(
      db
        .prepare(`SELECT 1 FROM decisions WHERE target_kind='task' AND target_id='tk_doomed'`)
        .get(),
    ).toBeUndefined();
    // The mixed task keeps only the surviving evidence, and its decision.
    const tk = db
      .prepare(`SELECT evidence_json FROM tasks WHERE id = 'tk_mixed'`)
      .get() as { evidence_json: string };
    expect(JSON.parse(tk.evidence_json)).toEqual([{ event_ids: [survivor], quote: "pool villa pls" }]);
    expect(
      db.prepare(`SELECT 1 FROM decisions WHERE target_kind='task' AND target_id='tk_mixed'`).get(),
    ).toBeTruthy();
  });

  it("digests: doomed hash gone, survivor's kept; bundles stripped", () => {
    const { doomed, survivor } = seed();
    const report = hardDeleteEvents(doomed, { reason: "test" });
    expect(report.digests_deleted).toBe(1);
    const db = getDb();
    const survivorHash = (
      db.prepare(`SELECT content_hash FROM events WHERE id = ?`).get(survivor) as {
        content_hash: string;
      }
    ).content_hash;
    expect(
      db.prepare(`SELECT 1 FROM content_digests WHERE content_hash = ?`).get(survivorHash),
    ).toBeTruthy();
    const bun = db
      .prepare(`SELECT event_ids_json FROM enrichment_bundles WHERE id = 'bun1'`)
      .get() as { event_ids_json: string };
    expect(JSON.parse(bun.event_ids_json)).toEqual([survivor]);
  });

  it("writes ONE counts-only tombstone decision — never content", () => {
    const { doomed } = seed();
    const report = hardDeleteEvents(doomed, { reason: "user deleted a screen span" });
    expect(report.decision_id).toBeTruthy();
    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM decisions WHERE id = ?`)
      .get(report.decision_id) as { action: string; old_json: string; reason: string };
    expect(row.action).toBe("privacy_delete");
    expect(row.reason).toContain("not reversible");
    const old = JSON.parse(row.old_json) as Record<string, number>;
    expect(old.events_deleted).toBe(3);
    // Counts only: none of the deleted text appears in the tombstone.
    expect(row.old_json).not.toContain("figma");
  });

  it("deleteScreenSpan scopes by source + span and is idempotent", () => {
    const { doomed, survivor } = seed();
    const report = deleteScreenSpan({
      startTs: "2026-08-28T00:00:00.000Z",
      endTs: "2026-08-28T23:59:59.999Z",
    });
    expect(report.events_deleted).toBe(3);
    expect(referencesAnywhere(doomed)).toEqual([]);
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM events WHERE id = ?`).get(survivor)).toBeTruthy();
    // Second run: nothing left in the span, nothing changes, no tombstone.
    const again = deleteScreenSpan({
      startTs: "2026-08-28T00:00:00.000Z",
      endTs: "2026-08-28T23:59:59.999Z",
    });
    expect(again.events_deleted).toBe(0);
    expect(again.decision_id).toBeNull();
  });

  it("no-op on an empty id list", () => {
    const report = hardDeleteEvents([], { reason: "nothing" });
    expect(report.events_deleted).toBe(0);
    expect(report.decision_id).toBeNull();
  });
});
