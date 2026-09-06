// ===========================================================================
// Space-birth dedupe (V6 P1 S3.7, Product §13.3): a proposal that duplicates
// a live space files INTO it — via the critic's flag_overlap, or the code-side
// label match when the critic is silent. Distinct labels are still born.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { parseOrientOutput } from "./orient.js";
import type { CriticOutput } from "./critic.js";
import { commitTick } from "./commit.js";
import { findBirthDuplicate, JACCARD_MIN, normalizeLabel, resolveCriticOverlap } from "./space-birth.js";

let tmpDir: string;
const T0 = Date.parse("2026-08-28T19:40:00.000Z");
const S1 = "goa-gang@g.us";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-space-birth-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function space(id: string, label: string, status = "active"): void {
  getDb().prepare(`INSERT INTO spaces (id, label, status) VALUES (?, ?, ?)`).run(id, label, status);
}

describe("findBirthDuplicate", () => {
  it("normalizes labels (case, punctuation, diacritics)", () => {
    expect(normalizeLabel("  Goa Trip — with Rohan!! ")).toBe("goa trip with rohan");
  });

  it("finds an exact-normalized live label; ignores archived/rejected spaces", () => {
    space("sp_goa", "Goa trip with Rohan in December");
    space("sp_old", "Goa trip 2024", "archived");
    expect(findBirthDuplicate("goa trip with rohan in december")).toMatchObject({ spaceId: "sp_goa", via: "exact_label" });
    expect(findBirthDuplicate("Goa trip 2024")).toBeNull();
  });

  it("finds a near-identical label by token overlap at the conservative floor, and nothing below it", () => {
    space("sp_goa", "Goa trip with Rohan in December");
    expect(JACCARD_MIN).toBeGreaterThanOrEqual(0.75);
    expect(findBirthDuplicate("December Goa trip with Rohan")).toMatchObject({ spaceId: "sp_goa", via: "token_overlap" });
    expect(findBirthDuplicate("Goa trip")).toBeNull(); // 2 of 4 tokens — a different scope, possibly
    expect(findBirthDuplicate("Renew Airtel postpaid plan")).toBeNull();
  });

  it("resolveCriticOverlap only accepts a live space id", () => {
    space("sp_goa", "Goa trip");
    space("sp_gone", "Old", "rejected");
    expect(resolveCriticOverlap("sp_goa")).toMatchObject({ via: "critic" });
    expect(resolveCriticOverlap("sp_gone")).toBeNull();
    expect(resolveCriticOverlap("sp_nope")).toBeNull();
    expect(resolveCriticOverlap(null)).toBeNull();
  });
});

// ---- The commit path -------------------------------------------------------

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

function world(texts: string[]): { bundle: DeltaBundle; aliases: Map<string, string>; streamAliases: Map<string, string> } {
  appendEvents(texts.map((t, i) => wa(i + 1, t)));
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles.find((b) => b.streamKey === S1)!;
  const aliases = new Map(bundle.events.map((e, i) => [`e${i + 1}`, e.id]));
  return { bundle, aliases, streamAliases: new Map([["S1", bundle.streamId]]) };
}

function proposal(label: string) {
  return parseOrientOutput({
    episodes: [],
    proposals: [
      {
        label,
        goal: "4 people, 18-21 Dec",
        stream: "S1",
        episode_events: ["e1"],
        summary: "Goa dates discussed",
        evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
        confidence: 0.9,
      },
    ],
    unsorted: [],
    questions: [],
  });
}

const silent: CriticOutput = { verdicts: [] };

describe("commit: space-birth dedupe", () => {
  it("files a same-label proposal into the existing space (code backstop, critic silent)", () => {
    space("sp_goa", "Goa trip with Rohan in December");
    const w = world(["lets lock goa 18-21 dec"]);
    const report = commitTick({ ...w, orient: proposal("goa trip with rohan in december"), critic: silent });
    expect(report.createdSpaces).toEqual([]);
    expect(report.dedupedBirths).toBe(1);
    expect(report.committedEpisodes).toHaveLength(1);
    expect(report.committedEpisodes[0].spaceId).toBe("sp_goa");
    const db = getDb();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT space_id FROM episodes`).get() as { space_id: string }).space_id).toBe("sp_goa");
    expect(db.prepare(`SELECT 1 FROM decisions WHERE action = 'dedupe_birth' AND target_id = 'sp_goa'`).get()).toBeTruthy();
  });

  it("files a proposal into the space the critic's flag_overlap names, even with a different label", () => {
    space("sp_goa", "Goa trip with Rohan in December");
    const w = world(["lets lock goa 18-21 dec"]);
    const critic: CriticOutput = { verdicts: [{ item: 1, verdict: "flag_overlap", space_id: "sp_goa", reason: "same trip" }] };
    const report = commitTick({ ...w, orient: proposal("December beach weekend"), critic });
    expect(report.createdSpaces).toEqual([]);
    expect(report.dedupedBirths).toBe(1);
    expect(report.committedEpisodes[0].spaceId).toBe("sp_goa");
  });

  it("a flag_overlap naming a dead space still births (old behaviour) and a distinct label is born", () => {
    space("sp_goa", "Goa trip with Rohan in December", "archived");
    const w = world(["lets lock goa 18-21 dec"]);
    const critic: CriticOutput = { verdicts: [{ item: 1, verdict: "flag_overlap", space_id: "sp_goa", reason: "?" }] };
    const report = commitTick({ ...w, orient: proposal("Renew Airtel postpaid plan"), critic });
    expect(report.createdSpaces).toHaveLength(1);
    expect(report.dedupedBirths).toBe(0);
    expect(report.flagged).toBe(1);
  });
});
