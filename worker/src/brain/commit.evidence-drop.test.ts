// ===========================================================================
// FIX-C2 — one bad quote costs the quote, not the pass.
//
// THE DEFECT. `bundle_attempts.last_error` on the 13.11.5 install was
// dominated by `evidence_not_verbatim`. Each one rejected the whole item, held
// its events, failed the bundle, and bought two more full-context attempts
// before the bundle dead-lettered — three ~22K-token Orient passes spent over
// a span the model had punctuated rather than invented.
//
// THE RULE IS UNCHANGED (Product_V6_Phase1 §17.3 / §21.4): no write without
// evidence. An item whose evidence ALL fails still rejects, with the same
// reason and the same detail bytes as before. What changed is that an item
// with one good quote and one bad one now files on the good one and says so.
//
// No provider is reached: commitTick is driven with canned Orient output.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { parseOrientOutput, type OrientOutput } from "./orient.js";
import { commitTick } from "./commit.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-evdrop-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  // A resolvable sender, so the bundle is not held as thin context.
  getDb().prepare(`INSERT INTO entities (id, type, canonical, provisional) VALUES ('ent_rohan','person','Rohan Mehta',0)`).run();
  getDb().prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('ei_rohan','ent_rohan','wa','handle','contact:rohan')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T19:40:00.000Z");
const S1 = "goa-gang@g.us";

function wa(i: number, text: string): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: S1,
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `${S1}:${i}` },
  };
}

interface World {
  bundle: DeltaBundle;
  aliases: Map<string, string>;
  streamAliases: Map<string, string>;
}

function seed(texts: string[]): World {
  appendEvents(texts.map((t, i) => wa(i + 1, t)));
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles[0]!;
  const aliases = new Map<string, string>();
  bundle.events.forEach((e, i) => aliases.set(`e${i + 1}`, e.id));
  return { bundle, aliases, streamAliases: new Map([["S1", bundle.streamId]]) };
}

function commit(w: World, raw: Record<string, unknown>) {
  return commitTick({
    bundle: w.bundle,
    orient: parseOrientOutput({ episodes: [], proposals: [], unsorted: [], questions: [], ...raw }) as OrientOutput,
    critic: { verdicts: [] },
    aliases: w.aliases,
    streamAliases: w.streamAliases,
  });
}

const db = () => getDb();

describe("evidence that does not verify is dropped, not fatal", () => {
  it("one good quote and one bad one: the episode commits on the good one, and the drop is on the record", () => {
    const w = seed(["lets lock goa 18-21 dec", "advance aaj chahiye"]);
    const r = commit(w, {
      episodes: [
        {
          action: "new",
          events: ["e1", "e2"],
          stream: "S1",
          summary: "Goa dates and the advance",
          evidence: [
            { event_ids: ["e1"], quote: "lets lock goa 18-21 dec" },
            { event_ids: ["e2"], quote: "I already transferred it" },
          ],
          confidence: 0.9,
        },
      ],
    });

    expect(r.rejected).toBe(0);
    expect(r.committedEpisodes).toHaveLength(1);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 1 });

    // Named, not swallowed.
    expect(r.evidenceDropped).toEqual([
      expect.objectContaining({
        item: 1,
        kind: "episode",
        reason: "evidence_not_verbatim",
        quote: "I already transferred it",
      }),
    ]);
  });

  it("an entry whose event ids resolve to nothing is dropped the same way", () => {
    const w = seed(["villa sol advance aaj chahiye"]);
    const r = commit(w, {
      episodes: [
        {
          action: "new",
          events: ["e1"],
          stream: "S1",
          summary: "advance",
          evidence: [
            { event_ids: ["e42"], quote: "villa sol" },
            { event_ids: ["e1"], quote: "advance aaj chahiye" },
          ],
          confidence: 0.9,
        },
      ],
    });
    expect(r.rejected).toBe(0);
    expect(r.evidenceDropped.map((d) => d.reason)).toEqual(["evidence_unresolved"]);
  });

  it("an item where NOTHING verifies still rejects, with the same reason and detail as before", () => {
    const w = seed(["thinking about booking the villa"]);
    const r = commit(w, {
      episodes: [
        {
          action: "new",
          events: ["e1"],
          stream: "S1",
          summary: "Villa booked",
          evidence: [{ event_ids: ["e1"], quote: "booked the villa" }],
          confidence: 0.9,
        },
      ],
    });
    expect(r.rejected).toBe(1);
    expect(r.rejections[0]).toEqual(
      expect.objectContaining({ reason: "evidence_not_verbatim", detail: '"booked the villa" is not in e1' }),
    );
    expect(r.evidenceDropped).toEqual([]);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 0 });
    // Its events are held for the next tick, exactly as they were.
    expect(r.heldEventIds).toEqual([w.aliases.get("e1")]);
  });

  it("a born space remembers only the evidence that survived", () => {
    const w = seed(["guys lets lock goa 18-21 dec", "flights kal book karte hain"]);
    const r = commit(w, {
      proposals: [
        {
          label: "Goa trip in December",
          episode_events: ["e1", "e2"],
          stream: "S1",
          summary: "December Goa trip",
          evidence: [
            { event_ids: ["e1"], quote: "lets lock goa 18-21 dec" },
            { event_ids: ["e2"], quote: "flights are booked and paid" },
          ],
          confidence: 0.9,
        },
      ],
    });
    expect(r.rejected).toBe(0);
    expect(r.createdSpaces).toHaveLength(1);
    expect(r.evidenceDropped.map((d) => d.kind)).toEqual(["proposal"]);

    const row = db()
      .prepare(`SELECT birth_evidence_json AS j FROM spaces WHERE id = ?`)
      .get(r.createdSpaces[0]) as { j: string };
    const kept = JSON.parse(row.j) as { quote: string }[];
    // The claim the code could not find is not written down as if it were one.
    expect(kept.map((k) => k.quote)).toEqual(["lets lock goa 18-21 dec"]);
  });

  it("the matcher's new tolerance is live in the commit path: an elision and a stitch both verify", () => {
    const w = seed(["Kaam start naui hua ab tak... Abhi tak to meeting stakeholders", "Are waah"]);
    const r = commit(w, {
      episodes: [
        {
          action: "new",
          events: ["e1", "e2"],
          stream: "S1",
          summary: "work has not started",
          evidence: [
            { event_ids: ["e1"], quote: "Kaam start naui hua ab tak… meeting stakeholders" },
            { event_ids: ["e1", "e2"], quote: "meeting stakeholders; Are waah" },
          ],
          confidence: 0.8,
        },
      ],
    });
    expect(r.rejected).toBe(0);
    expect(r.evidenceDropped).toEqual([]);
  });
});
