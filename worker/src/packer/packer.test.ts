// ===========================================================================
// Packer tests (build P1.2): candidate-space lanes, thread history elasticity
// + reply-quote fetch, the assembled Orient block (snapshot), and the
// prompt-size cap.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/dispatch.js";
import { candidateSpaces, recentContextSpaces } from "./spaces.js";
import { threadHistory, streamEpisodes, streamContext } from "./history.js";
import { packOrientContext, DEFAULT_PACK_MAX_CHARS } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-packer-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T10:00:00.000Z");

function waMessage(i: number, text: string, actor = "contact:rohan"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa-gang@g.us",
    actor,
    roles: { sender: actor, audience: ["self", "ent_rohan"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `x${i}` },
  };
}

function seedSpace(
  id: string,
  label: string,
  extras: { goal?: string; updatedAt?: string; exemplars?: string[] } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, updated_at)
       VALUES (?, ?, 'Travel', ?, 'active', ?, ?)`,
    )
    .run(
      id,
      label,
      extras.goal ?? null,
      JSON.stringify(extras.exemplars ?? []),
      extras.updatedAt ?? new Date(T0).toISOString(),
    );
}

function bundleFor(streamKey: string): DeltaBundle {
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles.find((b) => b.streamKey === streamKey);
  if (!bundle) throw new Error(`no bundle for ${streamKey}`);
  return bundle;
}

describe("candidateSpaces — the four lanes", () => {
  it("nominates via FTS, entity overlap, and bridges, with the bridge lane strongest", async () => {
    appendEvents([
      waMessage(1, "guys lets lock goa 18-21 dec, villa hunt continues"),
      waMessage(2, "sharing https://www.goibibo.com/hotels/goa-listing me too"),
    ]);
    seedSpace("sp_goa", "Goa trip with Rohan in December", {
      goal: "18-21 Dec trip",
      exemplars: ["dates locked", "flight compare"],
    });
    seedSpace("sp_diwali", "Diwali gifts for family");
    // Bridge lane: the space holds the same normalised URL the event carries.
    const key = getDb()
      .prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE kind = 'url' LIMIT 1`)
      .get() as { kind: string; value_norm: string } | undefined;
    expect(key).toBeDefined();
    getDb()
      .prepare(`INSERT INTO space_bridge_keys (space_id, kind, value_norm) VALUES (?, ?, ?)`)
      .run("sp_goa", key!.kind, key!.value_norm);

    const bundle = bundleFor("goa-gang@g.us");
    const candidates = await candidateSpaces(bundle.events, { nowMs: T0 + 3_600_000 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].id).toBe("sp_goa");
    expect(candidates[0].lanes).toContain("bridge");
    expect(candidates[0].lanes).toContain("fts");
    expect(candidates[0].exemplars).toEqual(["dates locked", "flight compare"]);
  });

  it("caps the list at the top 3–5 and excludes archived spaces", async () => {
    appendEvents([waMessage(1, "goa goa goa trip plans and villas and flights")]);
    for (let i = 0; i < 8; i++) seedSpace(`sp_${i}`, `Goa plan variant ${i}`);
    getDb().prepare(`UPDATE spaces SET status = 'archived' WHERE id = 'sp_7'`).run();
    const bundle = bundleFor("goa-gang@g.us");
    const candidates = await candidateSpaces(bundle.events, { nowMs: T0 + 3_600_000 });
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates.map((c) => c.id)).not.toContain("sp_7");
  });

  it("recent-context spaces surface as weak hints, excluding real candidates", () => {
    seedSpace("sp_recent", "Side project database work", {
      updatedAt: new Date(T0 + 3_000_000).toISOString(),
    });
    seedSpace("sp_old", "Old thing", { updatedAt: new Date(T0 - 30 * 86_400_000).toISOString() });
    const recents = recentContextSpaces({ nowMs: T0 + 3_600_000 });
    expect(recents.map((r) => r.id)).toEqual(["sp_recent"]);
    expect(
      recentContextSpaces({ nowMs: T0 + 3_600_000, excludeIds: ["sp_recent"] }),
    ).toEqual([]);
  });
});

describe("threadHistory — elastic 20–40 with reply-quotes", () => {
  it("returns the last ~20 events and always fetches the quoted message", () => {
    const envs: EventEnvelope[] = [];
    for (let i = 0; i < 60; i++) envs.push(waMessage(i, `msg number ${i}`));
    const appended = appendEvents(envs);
    const quotedId = appended.ids[2]; // an OLD message, far outside the window
    // The newest message replies to it.
    const reply = waMessage(61, "yes that one ^^");
    reply.payload.quote_id = quotedId;
    appendEvents([reply]);

    const bundle = bundleFor("goa-gang@g.us");
    // Simulate: everything but the last reply already dispatched.
    const last = bundle.events[bundle.events.length - 1];
    const history = threadHistory(bundle.streamId, [last]);
    expect(history.length).toBeGreaterThanOrEqual(20);
    expect(history.length).toBeLessThanOrEqual(41);
    const quoted = history.find((h) => h.id === quotedId);
    expect(quoted).toBeDefined();
    expect(quoted!.quoted).toBe(true);
  });
});

describe("packOrientContext", () => {
  function seedScenario(): DeltaBundle {
    appendEvents([
      waMessage(1, "guys lets lock goa 18-21 dec"),
      waMessage(2, "did anyone pay the diwali pool??", "contact:tanvi"),
    ]);
    seedSpace("sp_goa", "Goa trip with Rohan in December", {
      goal: "18-21 Dec trip",
      exemplars: ["dates locked"],
    });
    const db = getDb();
    db.prepare(
      `UPDATE streams SET label = 'Goa gang', stream_kind = 'group', tier = 'T1',
              category = 'cat1', engagement_score = 0.8, reply_count = 12
        WHERE external_key = 'goa-gang@g.us'`,
    ).run();
    db.prepare(
      `INSERT INTO episodes (id, stream_id, space_id, state, summary, last_ts)
       VALUES ('ep_412', (SELECT id FROM streams WHERE external_key = 'goa-gang@g.us'),
               'sp_goa', 'open', 'villa shortlist', ?)`,
    ).run(new Date(T0).toISOString());
    return bundleFor("goa-gang@g.us");
  }

  it("assembles every §6.4 block in order (snapshot of the shape)", async () => {
    const bundle = seedScenario();
    const packed = await packOrientContext(bundle, { nowMs: T0 + 3_600_000 });
    const lines = packed.user.split("\n");
    expect(lines[0]).toBe("[BAND] A live   [MODE] propose-only");
    // Block order is the §6.4 order.
    const order = ["[BAND]", "[ROSTER]", "[STREAM]", "[THREAD HISTORY]", "[EPISODES here]", "[CANDIDATE SPACES]", "[NEW BUNDLE]"];
    let cursor = -1;
    for (const marker of order) {
      const at = packed.user.indexOf(marker);
      expect(at, `${marker} present`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(packed.user).toContain('[STREAM] group "Goa gang" · tier T1 · category cat1');
    expect(packed.user).toContain('ep_412 "villa shortlist" open');
    expect(packed.user).toContain('sp_goa "Goa trip with Rohan in December"');
    expect(packed.user).toContain("e1 ");
    expect(packed.user).toContain("lets lock goa 18-21 dec");
    expect(packed.eventAliases.get("e1")).toBe(bundle.events[0].id);
    expect(packed.candidateSpaceIds).toContain("sp_goa");
    expect(packed.episodeIds).toEqual(["ep_412"]);
    expect(packed.trimmed).toBe(false);
  });

  it("is deterministic — same world, byte-identical pack", async () => {
    const bundle = seedScenario();
    const a = await packOrientContext(bundle, { nowMs: T0 + 3_600_000 });
    const b = await packOrientContext(bundle, { nowMs: T0 + 3_600_000 });
    expect(a.user).toBe(b.user);
  });

  it("enforces the prompt-size cap without ever trimming the bundle", async () => {
    const envs: EventEnvelope[] = [];
    for (let i = 0; i < 80; i++) {
      envs.push(waMessage(i, `a long filler message about many things number ${i} ${"x".repeat(220)}`));
    }
    appendEvents(envs);
    const bundle = bundleFor("goa-gang@g.us");
    // Keep only the last 5 events as "the bundle"; the rest are history.
    const smallBundle = { ...bundle, events: bundle.events.slice(-5) };
    const cap = 6_000;
    const packed = await packOrientContext(smallBundle, { nowMs: T0 + 3_600_000, maxChars: cap });
    expect(packed.user.length).toBeLessThanOrEqual(cap);
    expect(packed.trimmed).toBe(true);
    // The bundle block survives whole.
    for (const e of smallBundle.events) {
      const alias = [...packed.eventAliases.entries()].find(([, id]) => id === e.id);
      expect(alias).toBeDefined();
    }
    expect(packed.user).toContain("[NEW BUNDLE] 5 events");
    expect(DEFAULT_PACK_MAX_CHARS).toBeGreaterThan(cap);
  });
});

describe("streamContext", () => {
  it("carries roster, circles, tier and engagement stats", () => {
    appendEvents([waMessage(1, "hello")]);
    const db = getDb();
    db.prepare(
      `INSERT INTO entities (id, type, canonical, provisional, circle)
       VALUES ('ent_rohan', 'person', 'Rohan Mehta', 0, 'close_friends')`,
    ).run();
    db.prepare(
      `UPDATE streams SET participant_entity_ids = '["ent_rohan"]', tier = 'T1',
              engagement_score = 0.5, reply_count = 3
        WHERE external_key = 'goa-gang@g.us'`,
    ).run();
    const id = (
      db.prepare(`SELECT id FROM streams WHERE external_key = 'goa-gang@g.us'`).get() as {
        id: string;
      }
    ).id;
    const ctx = streamContext(id);
    expect(ctx).not.toBeNull();
    expect(ctx!.roster).toEqual([
      { ref: "ent_rohan", name: "Rohan Mehta", circle: "close_friends", provisional: false },
    ]);
    expect(ctx!.tier).toBe("T1");
    expect(ctx!.engagementScore).toBe(0.5);
    expect(streamEpisodes(id)).toEqual([]);
  });
});
