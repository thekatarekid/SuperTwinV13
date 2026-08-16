// ===========================================================================
// The P executor's reference-corpus records (`gold|spaces=N`, `gold_archetype`)
// and the §14.2 gate observations they feed:
//
//   spaces_count_vs_gold       ±25% around the corpus's gold space count
//   spaces_archetype_accuracy  per gold-marked arc, off the row that landed
//   labels_anchor_entity       anchorless-label rate over anchored spaces
//
// Each test drives the REAL promotion engine over a real temp DB — the same
// path `npm run eval -- --only P` takes — so a passing observation here means
// the product, not the fixture, earned it.
// ===========================================================================

import { describe, expect, it } from "vitest";

import type { Fixture } from "../fixtures.js";
import { promotionExecutor } from "./promotion.js";

function fixture(response: string): { fixture: Fixture; response: string; mode: "frozen" } {
  return {
    fixture: {
      id: "P-TEST",
      category: "P",
      layer: "promotion",
      call: "[CODE]",
      mode: "steady",
      given: {
        roster: ["a1=Rahul"],
        streams: [],
        events: [{ n: 1, ts: "2026-08-16T12:00:00.000Z", who: "self", text: "clock" }],
        open: { episodes: [], loops: [] },
        db: { entities: [], claims: [], arcs: [] },
      },
      frozen_response: response,
      expect: {},
      assert: { mode: "no_throw" },
      stub: false,
      doc: { given: "", expect: "", assert: "" },
    } as unknown as Fixture,
    response,
    mode: "frozen",
  };
}

const CORPUS = [
  "entity|id=flat|type=place",
  "edge|kind=located_at|to=flat|type=place",
  "arc|id=r1|label=The Indiranagar flat|anchors=flat|gold_archetype=hld",
  "arc|id=c1|label=Commitment one|gold_archetype=mat",
  "loop|arc=c1|id=l1|state=open|owner=self|counterparty=a1",
  "arc|id=t1|label=Thin thread",
].join("\n");

describe("gold|spaces feeds spaces_count_vs_gold", () => {
  it("measures the delta against the live spaces the engine produced", async () => {
    const produced = await promotionExecutor(fixture(`${CORPUS}\ngold|spaces=2\nsweep\n`));
    const count = produced.gates?.find((g) => g.gate === "spaces_count_vs_gold");
    expect(count).toBeDefined();
    expect(count?.value).toBe(0);
    expect(count?.passed).toBe(true);
    expect(produced.metrics.spaces).toBe(2);
  });

  it("FAILS the observation when the count drifts past ±25% — the gate can fire", async () => {
    // Gold says 4 spaces; the engine honestly produces 2 → −50%.
    const produced = await promotionExecutor(fixture(`${CORPUS}\ngold|spaces=4\nsweep\n`));
    const count = produced.gates?.find((g) => g.gate === "spaces_count_vs_gold");
    expect(count?.value).toBe(-50);
    expect(count?.passed).toBe(false);
  });

  it("feeds nothing without a gold record — no data beats a flattering zero", async () => {
    const produced = await promotionExecutor(fixture(`${CORPUS}\nsweep\n`));
    expect(produced.gates?.some((g) => g.gate === "spaces_count_vs_gold")).toBe(false);
    expect(produced.gates?.some((g) => g.gate === "labels_anchor_entity")).toBe(false);
  });
});

describe("gold_archetype feeds spaces_archetype_accuracy", () => {
  it("passes when the stored archetype matches gold, fails when it does not", async () => {
    const produced = await promotionExecutor(fixture(`${CORPUS}\ngold|spaces=2\nsweep\n`));
    const arch = produced.gates?.filter((g) => g.gate === "spaces_archetype_accuracy") ?? [];
    expect(arch).toHaveLength(2); // r1 → hld, c1 → mat
    expect(arch.every((g) => g.passed)).toBe(true);

    const wrong = CORPUS.replace("gold_archetype=hld", "gold_archetype=prj");
    const drifted = await promotionExecutor(fixture(`${wrong}\ngold|spaces=2\nsweep\n`));
    const bad = drifted.gates?.filter((g) => g.gate === "spaces_archetype_accuracy") ?? [];
    expect(bad.some((g) => !g.passed)).toBe(true);
  });
});

describe("labels_anchor_entity is measured off the labels that landed", () => {
  it("reports the anchorless rate over anchored live spaces", async () => {
    const good = await promotionExecutor(fixture(`${CORPUS}\ngold|spaces=2\nsweep\n`));
    const label = good.gates?.find((g) => g.gate === "labels_anchor_entity");
    expect(label?.value).toBe(0);
    expect(label?.passed).toBe(true);

    const bad = CORPUS.replace("label=The Indiranagar flat", "label=Misc chat");
    const drifted = await promotionExecutor(fixture(`${bad}\ngold|spaces=2\nsweep\n`));
    const anchorless = drifted.gates?.find((g) => g.gate === "labels_anchor_entity");
    expect(anchorless?.value).toBe(1);
    expect(anchorless?.passed).toBe(false);
  });
});

describe("the corpus-wide spaces cap reaches the executor's sweep", () => {
  it("48 qualifying arcs land as 45 live spaces", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 48; i += 1) {
      const id = `a${String(i).padStart(2, "0")}`;
      lines.push(`arc|id=${id}|label=arc ${i}`);
      lines.push(`loop|arc=${id}|id=l${i}|state=open|owner=self|counterparty=a1`);
    }
    lines.push("sweep");
    const produced = await promotionExecutor(fixture(lines.join("\n")));
    expect(produced.metrics.spaces).toBe(45);
    expect(produced.metrics.arcs).toBe(48);
  });
});
