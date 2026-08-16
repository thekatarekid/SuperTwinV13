// ===========================================================================
// Salience score + the stage that writes `events.salience`
// (build item 1.3, arch §10.2 stage ③).
//
// The acceptance is "stage present, no behaviour change for WhatsApp", and the
// load-bearing test is the round trip: insert a real WhatsApp event, run the
// stage over it, and assert that every column of that row is byte-identical
// afterwards EXCEPT `salience`, which is 1.0. That is what "pass-through" has
// to mean at the storage layer, and it is the thing a future ambient source
// could quietly break.
//
// The rest covers the generic half — a source that DOES have a noise problem
// gets a real blend — and the two invariants that outlive any weighting:
// nothing is dropped, and an event we know nothing about is not called noise.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { closeDb, runMigrations } from "../db/connection.js";
import { getDb } from "../db/index.js";
import { insertEvent, upsertSource, upsertStream } from "../db/ingest.js";
import {
  DEFAULT_SALIENCE_GATE,
  DUPLICATE_PENALTY,
  PASS_THROUGH_SALIENCE,
  gateForEnrichment,
  isPassThrough,
  orderBySalience,
  passesGate,
  runSalienceStage,
  scoreEvent,
  scoreEvents,
  writeSalience,
  type SalienceInput,
} from "./score.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-salience-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedWhatsappEvent(externalId = "mom@x/A"): string {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  const streamId = upsertStream({
    sourceId: "whatsapp",
    sourceExtId: "mom@x",
    name: "Mom",
    kind: "dm",
  });
  return insertEvent({
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId,
    actorId: null,
    ts: "2026-08-01T10:00:00.000Z",
    kind: "message",
    text: "khaana kha liya?",
    mediaPath: null,
    rawJson: null,
  }).id;
}

function readEventRow(id: string): Record<string, unknown> {
  return getDb().prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Record<string, unknown>;
}

// ---- The acceptance -------------------------------------------------------

describe("WhatsApp — the stage is present and changes nothing", () => {
  it("the manifest still declares no prefilter and a conversation lane", () => {
    expect(WHATSAPP_MANIFEST.salience.prefilter).toBe("none");
    expect(WHATSAPP_MANIFEST.stream_kind_of({ external_key: "mom@x", kind: "dm" })).toBe(
      "conversation",
    );
  });

  it("scores 1.0 and says why, without consulting a single signal", () => {
    const v = scoreEvent({
      event_id: "whatsapp:mom@x/A",
      stream_kind: "conversation",
      prefilter: "none",
      // Deliberately the noisiest signal set possible. A pass-through must
      // ignore all of it — this is the regression that would bite if someone
      // "improved" the stage into scoring conversations too.
      signals: {
        text_density: 0,
        novelty: 0,
        user_input_present: false,
        known_entity_present: false,
        dedupe: { duplicate: true },
        vad: { speech: false, speech_ratio: 0 },
      },
    });
    expect(v.salience).toBe(PASS_THROUGH_SALIENCE);
    expect(v.pass_through).toBe(true);
    expect(v.reasons).toEqual(["pass-through: conversation stream"]);
  });

  it("leaves every other column of a stored event untouched", () => {
    const id = seedWhatsappEvent();
    const before = readEventRow(id);
    expect(before.salience).toBeNull();

    const result = runSalienceStage(getDb(), [
      { event_id: id, stream_kind: "conversation", prefilter: "none" },
    ]);
    expect(result.written).toBe(1);
    expect(result.verdicts[0].salience).toBe(1);

    const after = readEventRow(id);
    expect(after.salience).toBe(1);
    for (const column of Object.keys(before)) {
      if (column === "salience") continue;
      expect({ column, value: after[column] }).toEqual({ column, value: before[column] });
    }
  });

  it("is idempotent — running the stage twice writes the same 1.0", () => {
    const id = seedWhatsappEvent();
    const input: SalienceInput = {
      event_id: id,
      stream_kind: "conversation",
      prefilter: "none",
    };
    runSalienceStage(getDb(), [input]);
    const once = readEventRow(id);
    runSalienceStage(getDb(), [input]);
    expect(readEventRow(id)).toEqual(once);
  });

  it("never removes a row — the event count is the same before and after", () => {
    const ids = ["mom@x/A", "mom@x/B", "mom@x/C"].map(seedWhatsappEvent);
    const count = () =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    expect(count()).toBe(3);
    runSalienceStage(
      getDb(),
      ids.map((id) => ({ event_id: id, stream_kind: "conversation", prefilter: "none" }) as const),
    );
    expect(count()).toBe(3);
  });
});

// ---- The generic half -----------------------------------------------------

describe("pass-through rules", () => {
  it("a conversation passes through whatever the manifest asks for", () => {
    expect(isPassThrough("conversation", "dedupe")).toBe(true);
    expect(scoreEvent({ event_id: "e", stream_kind: "conversation", prefilter: "vad" }).salience)
      .toBe(1);
  });

  it('prefilter "none" passes through whatever the lane shape is', () => {
    expect(isPassThrough("activity", "none")).toBe(true);
    const v = scoreEvent({ event_id: "e", stream_kind: "activity", prefilter: "none" });
    expect(v.pass_through).toBe(true);
    expect(v.reasons).toEqual(['pass-through: prefilter "none"']);
  });

  it("an ambient lane with a real prefilter does NOT pass through", () => {
    expect(isPassThrough("ambient", "dedupe")).toBe(false);
  });
});

describe("scoring an ambient capture", () => {
  const ambient = (signals: SalienceInput["signals"]): number =>
    scoreEvent({ event_id: "e", stream_kind: "ambient", prefilter: "threshold", signals }).salience;

  it("blends the §10.2 signals", () => {
    // All five present and maxed → 1; all five present and zeroed → 0.
    expect(
      ambient({
        text_density: 1,
        app_category: 1,
        user_input_present: true,
        known_entity_present: true,
        novelty: 1,
      }),
    ).toBe(1);
    expect(
      ambient({
        text_density: 0,
        app_category: 0,
        user_input_present: false,
        known_entity_present: false,
        novelty: 0,
      }),
    ).toBe(0);
  });

  it("renormalises over the signals a source can actually measure", () => {
    // text_density alone at 0.5 is 0.5, not 0.125 — a screen recorder with no
    // entity resolver must not be punished for the axes it cannot see.
    expect(ambient({ text_density: 0.5 })).toBeCloseTo(0.5);
    expect(ambient({ text_density: 1, novelty: 0 })).toBeCloseTo(0.25 / 0.45);
  });

  it("scores an event it knows nothing about HIGH, not low", () => {
    const v = scoreEvent({ event_id: "e", stream_kind: "ambient", prefilter: "threshold" });
    expect(v.salience).toBe(1);
    expect(v.pass_through).toBe(false);
    expect(v.reasons).toContain("no signals supplied");
  });

  it("penalises a duplicate without zeroing it — the row still exists", () => {
    const base = ambient({ text_density: 1, novelty: 1 });
    const dup = ambient({ text_density: 1, novelty: 1, dedupe: { duplicate: true } });
    expect(dup).toBeCloseTo(base * DUPLICATE_PENALTY);
    expect(dup).toBeGreaterThan(0);
  });

  it("zeroes a silent clip and scales a partly-silent one", () => {
    expect(ambient({ text_density: 1, vad: { speech: false, speech_ratio: 0 } })).toBe(0);
    expect(ambient({ text_density: 1, vad: { speech: true, speech_ratio: 0.5 } })).toBeCloseTo(0.5);
  });

  it("clamps nonsense signals instead of emitting a nonsense score", () => {
    expect(ambient({ text_density: 42 })).toBe(1);
    expect(ambient({ text_density: -7 })).toBe(0);
    expect(ambient({ text_density: Number.NaN })).toBe(1); // unreadable → no signal
  });

  it("returns exactly one verdict per input, in order", () => {
    const inputs: SalienceInput[] = [
      { event_id: "a", stream_kind: "ambient", prefilter: "dedupe", signals: { novelty: 0.1 } },
      { event_id: "b", stream_kind: "conversation", prefilter: "none" },
    ];
    expect(scoreEvents(inputs).map((v) => v.event_id)).toEqual(["a", "b"]);
  });
});

// ---- Persistence, ordering, gating ----------------------------------------

describe("writeSalience", () => {
  it("reports zero changes for an id that no longer exists, without throwing", () => {
    const written = writeSalience(getDb(), [
      { event_id: "whatsapp:gone", salience: 1, pass_through: true, reasons: [] },
    ]);
    expect(written).toBe(0);
  });

  it("is a no-op on an empty batch", () => {
    expect(writeSalience(getDb(), [])).toBe(0);
  });

  it("stores a fractional score and clamps an out-of-range one", () => {
    const id = seedWhatsappEvent();
    writeSalience(getDb(), [
      { event_id: id, salience: 0.25, pass_through: false, reasons: [] },
    ]);
    expect(readEventRow(id).salience).toBeCloseTo(0.25);
    writeSalience(getDb(), [{ event_id: id, salience: 9, pass_through: false, reasons: [] }]);
    expect(readEventRow(id).salience).toBe(1);
  });
});

describe("ordering and gating — salience orders, it never drops", () => {
  const items = [
    { id: "a", salience: 0.2 },
    { id: "b", salience: 1 },
    { id: "c", salience: 1 },
    { id: "d", salience: 0 },
  ];

  it("sorts high to low and keeps ties in input order", () => {
    expect(orderBySalience(items).map((i) => i.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("does not mutate the array it was handed", () => {
    const copy = [...items];
    orderBySalience(items);
    expect(items).toEqual(copy);
  });

  it("admits everything at the default gate, including a score of 0", () => {
    expect(DEFAULT_SALIENCE_GATE).toBe(0);
    expect(passesGate(0)).toBe(true);
    const { admitted, deferred } = gateForEnrichment(items);
    expect(admitted).toHaveLength(4);
    expect(deferred).toHaveLength(0);
  });

  it("defers rather than discards when the gate is raised", () => {
    const { admitted, deferred } = gateForEnrichment(items, 0.5);
    expect(admitted.map((i) => i.id)).toEqual(["b", "c"]);
    expect(deferred.map((i) => i.id)).toEqual(["a", "d"]);
    // The partition loses nothing: raise or lower the gate and the same four
    // rows are re-partitioned, never fewer.
    expect(admitted.length + deferred.length).toBe(items.length);
  });
});
