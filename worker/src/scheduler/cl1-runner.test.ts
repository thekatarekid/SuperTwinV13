// ===========================================================================
// The P-CL1 stage — the wiring that finally turns a model answer into rows.
//
// What is tested is the RUNNER, not the prompt (prompts/p-cl1.test.ts owns
// that) and not the write path (claims/write.test.ts owns that): the enabled
// gate, the batching, the order claims and loops land in, the fields code
// derives rather than the model, the budget, and — the one this whole build
// exists because of — that a silent zero is impossible. A call that failed and
// a call that legitimately found nothing must never read the same.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { setProcessEnabled } from "../db/settings.js";
import { activeClaims, evidenceOf } from "../claims/store.js";
import { ensureMeEntity, setEventActorEntity } from "../entities/binding.js";
import { createEntity } from "../entities/registry.js";
import { readEpisode, type EpisodeRow } from "../episodes/store.js";
import type { PromptRunResult } from "../prompts/runner.js";
import { lineViolations, parseWire } from "../wire/index.js";
import {
  buildCl1Call,
  cl1RunnerInvoke,
  enqueueExtractions,
  pendingExtractionEpisodes,
  projectCl1Calls,
  runCl1ForEpisodes,
  salvageAnswer,
  type AsyncPromptInvoke,
} from "./cl1-runner.js";
import { planBootstrap } from "./bootstrap.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;
let C1 = "";
let ME = "";
let ROHAN = "";

/** One stream, one counterpart, `n` events, one episode over all of them. */
function seedEpisode(id: string, texts: readonly string[]): string[] {
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
  const eventIds = texts.map((text, i) => {
    const eventId = insertEvent({
      externalId: `${id}-ev${i + 1}`,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: C1,
      actorId: actor,
      ts: new Date(NOW - (texts.length - i) * 60_000).toISOString(),
      kind: "message",
      text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    }).id;
    // Alternate the speaker so the batch has both `self` and a roster alias.
    setEventActorEntity(eventId, i % 2 === 0 ? ROHAN : ME);
    return eventId;
  });
  const stamp = new Date(NOW).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', 'Lease renewal', 'model', '[]', ?, ?, 'open', ?, ?)`,
    )
    .run(id, C1, JSON.stringify(eventIds), JSON.stringify([ME, ROHAN]), stamp, stamp);
  return eventIds;
}

/** A realistic P-CL1 answer: one summary, one claim, one loop. */
const ANSWER = [
  "Y | e1 | Rohan raised the lease renewal. The user agreed to send the draft this week.",
  "F | 1 | a1 | ao | 0.90 |  | Rents a flat in Koramangala",
  "T | 2 | self | a1 | ex | i2t | m | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft",
].join("\n");

function replay(text: string | null, seen: string[] = []): AsyncPromptInvoke {
  return async (prompt) => {
    seen.push(prompt.user);
    return text;
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cl1-runner-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  ME = ensureMeEntity();
  ROHAN = createEntity({ type: "person", canonical: "Rohan Mehta", provisional: false }).id;
  getDb()
    .prepare(`UPDATE streams SET participant_entity_ids = ?, tz = 'Asia/Kolkata' WHERE id = ?`)
    .run(JSON.stringify([ME, ROHAN]), C1);
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildCl1Call", () => {
  it("packs the roster, the stream, the episode and the events of a batch", () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    const ctx = buildCl1Call([readEpisode("ep1") as EpisodeRow]);
    expect(ctx).not.toBeNull();
    expect(ctx?.prompt.user).toContain("#R a1=Rohan Mehta");
    expect(ctx?.prompt.user).toContain("#C c1 Rohan");
    expect(ctx?.prompt.user).toContain("#E e1 Lease renewal");
    expect(ctx?.prompt.user).toContain("Asia/Kolkata");
    expect(ctx?.prompt.stats.events).toBe(2);
    // `self` is the reserved alias and is never numbered onto the roster.
    expect(ctx?.prompt.user).not.toContain("a2=");
  });

  it("returns null rather than a truncated prompt when there is nothing to send", () => {
    expect(buildCl1Call([])).toBeNull();
  });
});

describe("the enabled gate", () => {
  it("makes no call at all when the extract process is switched off", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    setProcessEnabled("extract", false);
    const report = await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: cl1RunnerInvoke() });
    // The gate returns null, which the runner reports as a failure — never as
    // "the model found nothing".
    expect(report.errors.length).toBe(1);
    expect(report.claimsWritten).toBe(0);
    expect(activeClaims()).toHaveLength(0);
  });
});

describe("batching", () => {
  it("splits at §12.4's cap of 4 episodes per call", () => {
    expect(projectCl1Calls(0)).toBe(0);
    expect(projectCl1Calls(1)).toBe(1);
    expect(projectCl1Calls(4)).toBe(1);
    expect(projectCl1Calls(5)).toBe(2);
    expect(projectCl1Calls(9)).toBe(3);
  });

  it("buys one call per batch, not one per episode", async () => {
    for (let i = 1; i <= 5; i += 1) seedEpisode(`ep${i}`, [`message ${i}`]);
    const seen: string[] = [];
    const report = await runCl1ForEpisodes(["ep1", "ep2", "ep3", "ep4", "ep5"], {
      now: NOW,
      invoke: replay(ANSWER, seen),
    });
    expect(report.episodes).toBe(5);
    expect(report.batches).toBe(2);
    expect(report.calls).toBe(2);
    expect(seen).toHaveLength(2);
  });
});

describe("the write", () => {
  it("writes the claim, then the loop, with the fields CODE derives", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    const report = await runCl1ForEpisodes(["ep1"], { now: NOW, runId: "run_test", invoke: replay(ANSWER) });

    expect(report.errors).toEqual([]);
    expect(report.claimsWritten).toBe(1);
    expect(report.loopsWritten).toBe(1);
    expect(report.summaries).toBe(1);

    const claims = activeClaims();
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.kind).toBe("fact");
    expect(claim.text).toBe("Rents a flat in Koramangala");
    // The subject is the roster alias resolved to a REAL entity id.
    expect(claim.subjectId).toBe(ROHAN);
    expect(claim.attribution).toBe("about_other");
    // stated_at is the cited event's ts — never `ingested_at`, never now.
    expect(claim.statedAt).toBe(new Date(NOW - 2 * 60_000).toISOString());
    expect(claim.decidedBy).toBe("llm:p-cl1");
    // Evidence is the EVENT's words, attached to the event the model cited.
    expect(evidenceOf(claim.id)).toHaveLength(1);
    const quote = getDb()
      .prepare(`SELECT quote, episode_id FROM evidence WHERE subject_kind = 'claim' AND subject_id = ?`)
      .get(claim.id) as { quote: string; episode_id: string | null };
    expect(quote.quote).toBe("is the lease up for renewal?");
    expect(quote.episode_id).toBe("ep1");

    const loop = getDb()
      .prepare(`SELECT * FROM loops`)
      .get() as Record<string, unknown>;
    expect(loop.intent).toBe("Send Rohan the lease draft");
    expect(loop.owner_id).toBe(ME);
    expect(loop.counterparty_id).toBe(ROHAN);
    expect(loop.origin).toBe("explicit");
    expect(loop.due_utc).toBe("2026-08-20");
    // State, horizon, triage and party_pair are CODE's, never the model's.
    expect(loop.state).toBe("open");
    expect(loop.state_reason).toBe("due_future");
    expect(loop.horizon).toBe("week");
    expect(loop.triage).toBe("auto");
    expect(loop.party_pair).toBe("so");
    // A loop cites events too, so it carries evidence of its own.
    const loopEvidence = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM evidence WHERE subject_kind = 'loop'`)
      .get() as { n: number };
    expect(loopEvidence.n).toBe(1);
  });

  it("re-running the same answer reinforces and never forks", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: replay(ANSWER) });
    const second = await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: replay(ANSWER) });
    expect(second.claimsWritten).toBe(0);
    expect(second.claimsReinforced).toBe(1);
    expect(activeClaims()).toHaveLength(1);
    const loops = getDb().prepare(`SELECT COUNT(*) AS n FROM loops`).get() as { n: number };
    expect(loops.n).toBe(1);
  });

  it("keeps an item citing no event of this prompt out of the tables, and counts it", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    // `zz` is not an event token this prompt minted.
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | zz | a1 | ao | 0.9 |  | Rents a flat in Koramangala"),
    });
    expect(report.unsupported).toBe(1);
    expect(report.claimsWritten).toBe(0);
    expect(activeClaims()).toHaveLength(0);
  });
});

describe("failing loudly", () => {
  it("reports a transport failure as an error, not as zero claims", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    const report = await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: replay(null) });
    expect(report.calls).toBe(1);
    expect(report.claimsWritten).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("no response");
  });

  it("reports an unparseable answer as an error, not as zero claims", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("I'm sorry, I can't help with that."),
    });
    expect(report.claimsWritten).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("unparseable");
  });

  it("one bad batch never stops the others", async () => {
    for (let i = 1; i <= 5; i += 1) seedEpisode(`ep${i}`, [`message ${i}`]);
    let call = 0;
    const report = await runCl1ForEpisodes(["ep1", "ep2", "ep3", "ep4", "ep5"], {
      now: NOW,
      invoke: async () => {
        call += 1;
        return call === 1 ? null : ANSWER;
      },
    });
    expect(report.errors).toHaveLength(1);
    expect(report.claimsWritten).toBe(1);
  });
});

describe("the budget", () => {
  it("refuses rather than overspends, and says how much it skipped", async () => {
    for (let i = 1; i <= 5; i += 1) seedEpisode(`ep${i}`, [`message ${i}`]);
    const report = await runCl1ForEpisodes(["ep1", "ep2", "ep3", "ep4", "ep5"], {
      now: NOW,
      maxCalls: 1,
      invoke: replay(ANSWER),
    });
    expect(report.calls).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.errors).toEqual([]);
  });

  it("a zero budget makes no provider call at all", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    let calls = 0;
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      maxCalls: 0,
      invoke: async () => {
        calls += 1;
        return ANSWER;
      },
    });
    expect(calls).toBe(0);
    expect(report.calls).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

describe("P-AG3", () => {
  it("is never bought without a near-hit candidate", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    let ag3 = 0;
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay(ANSWER),
      ag3: async () => {
        ag3 += 1;
        return "V.claim | A | B | dup | 0.9 | same thing";
      },
    });
    // The [ML] rung is blocked (nothing writes `claim_embeddings`), so the
    // default scorer offers no candidate and the write inserts.
    expect(ag3).toBe(0);
    expect(report.ag3Calls).toBe(0);
    expect(report.claimsWritten).toBe(1);
  });

  it("fires once when a near hit IS scored, and charges the same wallet", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    // A stored claim about the same subject and kind, with a different key.
    await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay("F | 1 | a1 | ao | 0.9 |  | Rents a flat in Indiranagar"),
    });
    const stored = activeClaims()[0]!;

    let ag3 = 0;
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      invoke: replay(ANSWER),
      scoreNearHits: () => [{ claimId: stored.id, similarity: 0.95 }],
      ag3: async () => {
        ag3 += 1;
        return "V.claim | A | B | ctr | 0.9 | a move";
      },
    });
    expect(ag3).toBe(1);
    expect(report.ag3Calls).toBe(1);
    expect(report.claimsAdjudicated).toBe(1);
    // 1 P-CL1 + 1 P-AG3, through the one wallet.
    expect(report.calls).toBe(2);
  });
});

describe("the bootstrap projection", () => {
  it("reports a REAL cl1 call count — the number the user authorises a run on", () => {
    const eventIds = seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    const stamp = new Date(NOW).toISOString();
    const db = getDb();
    db.prepare(`UPDATE streams SET tier = 'T1' WHERE id = ?`).run(C1);
    db.prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES ('s1', ?, 'whatsapp', ?, ?, ?, 'sealed', 'h_s1')`,
    ).run(C1, stamp, stamp, JSON.stringify(eventIds));
    db.prepare(
      `INSERT INTO episode_sessions (episode_id, session_id, added_by) VALUES ('ep1', 's1', 'new')`,
    ).run();

    // One episode already bound to the cohort's session and never extracted,
    // plus at most one more from the session P-EP2 has yet to judge: both fit
    // in a single §12.4 batch.
    const plan = planBootstrap({}, { now: NOW });
    expect(plan.llmCallsProjected.ep2).toBe(1);
    expect(plan.llmCallsProjected.cl1).toBe(1);
    // The [ML] near-hit rung is blocked, so a run provably buys no P-AG3.
    expect(plan.llmCallsProjected.ag3).toBe(0);
  });
});

describe("the queue", () => {
  it("offers only episodes nothing has been extracted from", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    seedEpisode("ep2", ["separately: dinner on friday?"]);
    expect(pendingExtractionEpisodes().sort()).toEqual(["ep1", "ep2"]);

    await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: replay(ANSWER) });
    expect(pendingExtractionEpisodes()).toEqual(["ep2"]);
  });

  it("never re-enqueues a unit already marked done", () => {
    seedEpisode("ep1", ["is the lease up for renewal?"]);
    expect(enqueueExtractions(["ep1"], { now: NOW })[0]?.action).toBe("inserted");
    getDb().prepare(`UPDATE work_queue SET state = 'done'`).run();
    expect(enqueueExtractions(["ep1"], { now: NOW })[0]?.action).toBe("skipped_done");
  });
});

// ===========================================================================
// One bad line is one bad line (G2)
//
// A live tick spent $0.32 and wrote nothing: the model shifted a field on one
// `T` line, the runner quarantined the unit, and the transport read
// `status === "quarantined"` as "no answer" — discarding the valid claim lines
// that came back on the same response. The unit of failure is the LINE.
// ===========================================================================

/** Round 1 as the real run had it: a good summary, a good claim, one bad loop. */
const SHIFTED_STAKE =
  "T | 2 | self | a1 | ex | i2t | shr | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft";
/** The repair round's answer: still wrong, and now a field short. */
const SHORT_LOOP = "T | 2 | self | a1 | ex | shr | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft";

const PARTIAL_ANSWER = [
  "Y | e1 | Rohan raised the lease renewal. The user agreed to send the draft this week.",
  "F | 1 | a1 | ao | 0.90 |  | Rents a flat in Koramangala",
  SHIFTED_STAKE,
].join("\n");

/** A `PromptRunResult` in the shape the runner really hands back. */
function runResult(parts: Partial<PromptRunResult> & { status: PromptRunResult["status"] }): PromptRunResult {
  return {
    callType: "P-CL1",
    records: [],
    violations: [],
    skipped: [],
    rounds: 1,
    coverage: { asked: 0, answered: 0, unanswered: 0, pairingCertain: true },
    responses: [],
    runIds: ["r1"],
    usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
    ...parts,
  };
}

describe("salvageAnswer — the records are the authority, not the status", () => {
  it("keeps a quarantined answer that still carried wire lines, and says what it lost", () => {
    const first = parseWire(PARTIAL_ANSWER);
    const second = parseWire(SHORT_LOOP);
    const result = runResult({
      status: "quarantined",
      records: [...first.records, ...second.records],
      violations: lineViolations(second),
      responses: [PARTIAL_ANSWER, SHORT_LOOP],
      quarantineReason: "violations",
      quarantineId: "q1",
    });

    const salvaged = salvageAnswer(result, "nothing usable");
    // The whole response, verbatim — the caller re-parses it and the bad line
    // fails the SAME parser again. Nothing was tolerated to get here.
    expect(salvaged.text).toContain("Rents a flat in Koramangala");
    expect(salvaged.error).toBeNull();
    expect(salvaged.partial).toEqual({ records: 2, lines: 1, reason: "violations", quarantineId: "q1" });
  });

  it("still fails loudly when the quarantined answer carried NO usable line", () => {
    const salvaged = salvageAnswer(
      runResult({ status: "quarantined", responses: ["I'm sorry, I can't help with that."] }),
      "the P-CL1 call produced no usable answer",
    );
    expect(salvaged.text).toBeNull();
    expect(salvaged.partial).toBeNull();
    expect(salvaged.error?.code).toBe("EMPTY_RESPONSE");
  });

  it("never salvages a cancelled call, however much text arrived", () => {
    const salvaged = salvageAnswer(
      runResult({
        status: "failed",
        records: parseWire(PARTIAL_ANSWER).records,
        responses: [PARTIAL_ANSWER],
        error: { code: "CANCELLED", message: "user stopped the run" },
      }),
      "nothing usable",
    );
    expect(salvaged.text).toBeNull();
    expect(salvaged.error?.code).toBe("CANCELLED");
  });

  it("reports a clean answer as neither partial nor error", () => {
    const parse = parseWire(ANSWER);
    const salvaged = salvageAnswer(
      runResult({ status: "ok", records: parse.records, responses: [ANSWER] }),
      "nothing usable",
    );
    expect(salvaged.partial).toBeNull();
    expect(salvaged.error).toBeNull();
    expect(salvaged.text).toBe(ANSWER);
  });
});

describe("applying an answer with one malformed line", () => {
  it("writes the valid claim and counts the rejected line, rather than losing both", async () => {
    seedEpisode("ep1", ["is the lease up for renewal?", "yes — I'll send the draft"]);
    const report = await runCl1ForEpisodes(["ep1"], { now: NOW, invoke: replay(PARTIAL_ANSWER) });

    // The claim line is on disk — the row a $0.32 tick threw away.
    expect(report.claimsWritten).toBe(1);
    expect(activeClaims()).toHaveLength(1);
    // …and the loop line is NOT, because it is still genuinely malformed.
    expect(report.loopsWritten).toBe(0);
    expect(getDb().prepare(`SELECT id FROM loops`).all()).toHaveLength(0);
    // The rejection is counted, not swallowed.
    expect(report.violations).toBe(1);
    // COUNTERS MATCH THE ROW DELTAS. A partial apply that reported zero — or
    // reported one and wrote none — is the same class of defect either way.
    expect(getDb().prepare(`SELECT id FROM claim_versions`).all()).toHaveLength(report.claimsWritten);
    expect(getDb().prepare(`SELECT rowid FROM evidence`).all()).toHaveLength(report.evidenceRows);
  });
});
