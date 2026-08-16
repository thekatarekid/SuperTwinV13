// ===========================================================================
// P-CL1 attribution and the entity foreign key — the three failures a live run
// on real WhatsApp history exposed, each pinned by the case that produced it.
//
//   F2  a roster alias resolved to an ACTOR id and was written straight into
//       `claim_versions.subject_id`, a FK onto `entities`. `SqliteError:
//       FOREIGN KEY constraint failed` aborted the batch mid-flight, so every
//       later claim AND EVERY LOOP of that batch was lost — which is why a run
//       that wrote 13 claims wrote 0 loops.
//   F1  with no entities there was no roster, so claims came back with a NULL
//       subject and `first_person` intact: the COUNTERPARTY's own facts, filed
//       as the user's. On a personal history that is worse than no data.
//   F3  the throw escaped before the counters were folded, so the run logged
//       `claims=0+0 loops=0` while 13 claims and 20 evidence rows sat on disk.
//
// The seeds are the two states that matter: BOUND (identity binding has run,
// every speaker is an entity) and UNBOUND (a fresh install, `entities` empty
// and every speaker still just an `actors` row).
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { parseCl1Response } from "../claims/extract.js";
import { activeClaims } from "../claims/store.js";
import { ensureMeEntity, setEventActorEntity } from "../entities/binding.js";
import { createEntity } from "../entities/registry.js";
import { readEpisode, type EpisodeRow } from "../episodes/store.js";
import {
  applyCl1Answer,
  buildCl1Call,
  drainExtractQueue,
  emptyApply,
  enqueueExtractions,
  entityFk,
  runCl1ForEpisodes,
  toEntityId,
  unboundToken,
  type AsyncPromptInvoke,
} from "./cl1-runner.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;
let C1 = "";
let ME = "";
let ROHAN = "";
let ROHAN_ACTOR = "";

/**
 * One episode. `bind` is the whole difference between the two installs: with
 * it, every event's actor carries an entity; without it, `entities` stays empty
 * and the packer has nothing but `actors` rows to name a speaker with.
 */
function seedEpisode(id: string, texts: readonly string[], opts: { bind: boolean }): string[] {
  const me = upsertActor({ sourceId: "whatsapp", sourceExtId: "me", displayName: "Me" });
  const eventIds = texts.map((text, i) => {
    const eventId = insertEvent({
      externalId: `${id}-ev${i + 1}`,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: C1,
      // Even events are Rohan's, odd ones are the user's.
      actorId: i % 2 === 0 ? ROHAN_ACTOR : me,
      ts: new Date(NOW - (texts.length - i) * 60_000).toISOString(),
      kind: "message",
      text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    }).id;
    if (opts.bind) setEventActorEntity(eventId, i % 2 === 0 ? ROHAN : ME);
    return eventId;
  });
  const stamp = new Date(NOW).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', 'Flat hunting', 'model', '[]', ?, ?, 'open', ?, ?)`,
    )
    .run(id, C1, JSON.stringify(eventIds), JSON.stringify(opts.bind ? [ME, ROHAN] : []), stamp, stamp);
  if (opts.bind) {
    getDb()
      .prepare(`UPDATE streams SET participant_entity_ids = ? WHERE id = ?`)
      .run(JSON.stringify([ME, ROHAN]), C1);
  }
  return eventIds;
}

function replay(text: string | null): AsyncPromptInvoke {
  return async () => text;
}

function loopRows(): Record<string, unknown>[] {
  return getDb().prepare(`SELECT * FROM loops`).all() as Record<string, unknown>[];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cl1-attr-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  ROHAN_ACTOR = upsertActor({ sourceId: "whatsapp", sourceExtId: "919731006976", displayName: "Rohan" });
  ME = ensureMeEntity();
  ROHAN = createEntity({ type: "person", canonical: "Rohan Mehta", provisional: false }).id;
  getDb().prepare(`UPDATE streams SET tz = 'Asia/Kolkata' WHERE id = ?`).run(C1);
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("the entity foreign key", () => {
  it("names the offending value rather than letting SQLite report a constraint", () => {
    expect(() => entityFk("claim_versions.subject_id", ROHAN_ACTOR)).toThrow(/subject_id/);
    expect(() => entityFk("claim_versions.subject_id", ROHAN_ACTOR)).toThrow(ROHAN_ACTOR);
    expect(() => entityFk("loops.owner_id", unboundToken(ROHAN_ACTOR))).toThrow(/no bound entity/);
    // Null is a legal answer in every entity column, and a real entity passes.
    expect(entityFk("claim_versions.subject_id", null)).toBeNull();
    expect(entityFk("claim_versions.subject_id", ROHAN)).toBe(ROHAN);
    // The check is the ROW, not the shape — a plausible id with no row is not one.
    expect(toEntityId("ent_000000000000000000000000")).toBeNull();
  });

  it("never puts an unbound speaker on the roster, and never packs it as a bare actor id", () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: false });
    const ctx = buildCl1Call([readEpisode("ep1") as EpisodeRow]);
    expect(ctx).not.toBeNull();
    // The actor id is not in the prompt at all, and there is no `#R` line to
    // cite: an entity nobody has bound is an entity nobody may be given.
    expect(ctx?.prompt.user).not.toContain(ROHAN_ACTOR);
    expect(ctx?.prompt.user).not.toContain("#R ");
    expect(ctx?.participants).toEqual([]);
    expect([...(ctx?.unboundActors.values() ?? [])]).toContain(ROHAN_ACTOR);
    // The words survive — the transcript is still packed, speakers distinguished.
    expect(ctx?.prompt.stats.events).toBe(2);
  });

  it("an alias that resolves to an actor is refused, not written and not thrown", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: false });
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay(
        [
          "F | 1 | a1 | 1p | 0.90 |  | Does not need a 3BHK apartment.",
          "T | 1 | a1 | self | ex | i2t | m | w | 2026-08-20 | - | 0.80 | Shortlist 2BHK flats",
        ].join("\n"),
      ),
    });

    // The old failure was `SqliteError: FOREIGN KEY constraint failed` here.
    expect(report.errors).toEqual([]);
    expect(report.claimsWritten).toBe(0);
    expect(report.claimsRefused).toBe(1);
    expect(report.unresolvedRefs).toBeGreaterThanOrEqual(1);
    expect(activeClaims()).toEqual([]);

    // AND THE LOOP SURVIVED. Under the FK throw the batch aborted at the claim
    // and every loop after it was lost — the reason `loops` was empty on a live
    // install. Its owner is NULL, so it can never reach the user's Tasks.
    const loops = loopRows();
    expect(loops).toHaveLength(1);
    expect(loops[0]?.owner_id).toBeNull();
    expect(loops[0]?.triage).toBe("context");
  });
});

// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("files a counterparty's first-person claim on the counterparty, never on the user", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: true });
    // Event 1 is Rohan's. `-` is "the model did not name a subject", and `1p`
    // says the speaker is talking about himself — so the subject IS the speaker.
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | 1 | - | 1p | 0.90 |  | Does not need a 3BHK apartment."),
    });
    expect(report.errors).toEqual([]);
    expect(report.claimsWritten).toBe(1);

    const claim = activeClaims()[0]!;
    expect(claim.subjectId).toBe(ROHAN);
    expect(claim.subjectId).not.toBe(ME);
    expect(claim.speakerId).toBe(ROHAN);
    expect(claim.attribution).toBe("first_person");
    // role(speaker) ‖ role(subject) — both the other party, neither the user.
    expect(claim.partyPair).toBe("oo");
  });

  it("keeps the user's own first-person claim the user's", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "I want to stay in Indiranagar"], { bind: true });
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("P | 2 | - | 1p | 0.90 |  | Prefers to live in Indiranagar."),
    });
    expect(report.errors).toEqual([]);
    const claim = activeClaims()[0]!;
    expect(claim.subjectId).toBe(ME);
    expect(claim.speakerId).toBe(ME);
    expect(claim.attribution).toBe("first_person");
    expect(claim.partyPair).toBe("ss");
  });

  it("downgrades a first-person claim whose subject is not the speaker (§11.4)", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: true });
    // Rohan spoke, the model said the subject is the user: `1p` cannot stand.
    await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | 1 | self | 1p | 0.90 |  | Does not need a 3BHK apartment."),
    });
    const claim = activeClaims()[0]!;
    expect(claim.subjectId).toBe(ME);
    expect(claim.attribution).toBe("about_other");
    expect(claim.partyPair).toBe("os");
  });

  it("never writes an unverifiable first_person: a hinted subject is downgraded", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: false });
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | 1 | +Rohan Mehta | 1p | 0.90 |  | Does not need a 3BHK apartment."),
    });
    expect(report.claimsWritten).toBe(1);
    const claim = activeClaims()[0]!;
    // NULL + hint is what §11.3 allows when the subject has no id. What it must
    // not be is `first_person` — with no id on either end there is nothing to
    // check "the subject is the speaker" against.
    expect(claim.subjectId).toBeNull();
    expect(claim.subjectHint).toBe("Rohan Mehta");
    expect(claim.attribution).toBe("about_other");
  });

  it("refuses a claim that names nobody at all rather than filing it under the user", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: false });
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | 1 | - | 1p | 0.90 |  | Does not need a 3BHK apartment."),
    });
    expect(report.claimsRefused).toBe(1);
    expect(report.claimsWritten).toBe(0);
    expect(activeClaims()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("partial batches", () => {
  it("counts and keeps the work that landed when a later item throws", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: true });
    const answer = [
      "F | 1 | - | 1p | 0.90 |  | Does not need a 3BHK apartment.",
      "F | 1 | - | 1p | 0.90 |  | Boom goes the batch.",
      "T | 2 | self | a1 | ex | i2t | m | w | 2026-08-20 | - | 0.80 | Shortlist 2BHK flats",
    ].join("\n");
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay(answer),
      // The near-hit rung runs per claim, which is a faithful stand-in for the
      // FK throw that used to abort here.
      scoreNearHits: (input) => {
        if (input.text.startsWith("Boom")) throw new Error("boom");
        return [];
      },
    });

    // The first claim and the loop are on disk, and the report says so — the
    // live run said `claims=0+0 loops=0` with both already written.
    expect(report.claimsWritten).toBe(1);
    expect(activeClaims()).toHaveLength(1);
    expect(report.loopsWritten).toBe(1);
    expect(loopRows()).toHaveLength(1);
    // And the failure is still LOUD. Accurate counters never mean a quiet error.
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/boom/);
  });

  it("accumulates into the caller's report, so a throw cannot discard it", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: true });
    const ctx = buildCl1Call([readEpisode("ep1") as EpisodeRow])!;
    const answer = parseCl1Response(
      "F | 1 | - | 1p | 0.90 |  | Does not need a 3BHK apartment.",
      ctx.prompt.table,
    );
    const part = emptyApply();
    const returned = await applyCl1Answer(answer, ctx, { now: NOW }, part);
    // Same object: the counters live with the caller, not in the frame that
    // may throw on its way out.
    expect(returned).toBe(part);
    expect(part.claimsWritten).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the queue", () => {
  it("retries an episode refused for want of an identity rather than retiring it", async () => {
    seedEpisode("ep1", ["but I don't need a 3bhk", "noted"], { bind: false });
    enqueueExtractions(["ep1"], { now: NOW });
    const report = await drainExtractQueue({
      now: NOW,
      invoke: replay("F | 1 | - | 1p | 0.90 |  | Does not need a 3BHK apartment."),
    });
    expect(report.claimsRefused).toBe(1);
    const row = getDb()
      .prepare(`SELECT state, attempts, not_before_at FROM work_queue WHERE stage = 'extract'`)
      .get() as { state: string; attempts: number; not_before_at: string | null };
    // Not `done`: `pendingExtractionEpisodes` skips a done unit forever, and
    // this episode's claims are still extractable once binding has run.
    expect(row.state).toBe("ready");
    expect(row.not_before_at).not.toBeNull();
  });
});
