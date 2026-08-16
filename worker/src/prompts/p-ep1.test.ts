// ===========================================================================
// P-EP1 — the entity pass (build item 1.10, arch §12.1).
//
// The §12.1 worked example leads: its USER block packs to the shape the doc
// prints, and its EXPECTED answer parses to exactly the three records the doc
// shows and nothing more — events 2 and 3 produce nothing, because an
// acknowledgement carries no entities and a pending placeholder is unknown
// content rather than empty content.
//
// After that: temp ids. `k1` is a token, not an id, and this file proves that
// a `k` with no N line stays a hole rather than becoming a guess.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { getEntity, listEntities } from "../entities/registry.js";
import { ENUMS } from "../wire/tolerance.js";
import {
  P_EP1,
  P_EP1_SYSTEM,
  buildEp1Prompt,
  ep1Legend,
  isProposedAlias,
  mintProposals,
  parseEp1Response,
  resolveProposed,
  targetEntityId,
  type Ep1Answer,
} from "./p-ep1.js";
import { resetLegendCache } from "./legend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-p-ep1-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  resetLegendCache();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  resetLegendCache();
});

/** The §12.1 USER example, rebuilt from its parts. */
function docPrompt() {
  return buildEp1Prompt({
    tz: "Asia/Kolkata",
    entities: [
      { id: "ent_rahul", name: "Rahul Arora" },
      { id: "ent_pranjali", name: "Pranjali Sachdeva" },
      { id: "ent_indiranagar", name: "Indiranagar", type: "place" },
      { id: "ent_gharplus", name: "Ghar+", type: "group" },
    ],
    streams: [
      {
        id: "str_ghar",
        name: "Ghar+",
        kind: "group",
        participantIds: ["self", "ent_rahul", "ent_pranjali"],
      },
    ],
    events: [
      {
        id: "ev1",
        streamId: "str_ghar",
        at: "2026-08-11T13:34:00Z",
        speakerId: "ent_rahul",
        text: "shifting to Indiranagar next month, the broker found a 2BHK near the metro",
      },
      { id: "ev2", streamId: "str_ghar", at: "2026-08-11T13:36:00Z", speakerId: "self", text: "nice, congrats" },
      {
        id: "ev3",
        streamId: "str_ghar",
        at: "2026-08-11T13:41:00Z",
        speakerId: "ent_rahul",
        text: "[voice note, transcription pending]",
      },
    ],
  })!;
}

describe("the §12.1 settings and prompt", () => {
  it("transcribes the settings row", () => {
    expect(P_EP1.model).toBe("sonnet-5");
    expect(P_EP1.turns).toBe(1);
    expect(P_EP1.tools).toBe("none");
    expect(P_EP1.thinking).toBe("off");
    expect(P_EP1.timeoutSeconds).toBe(120);
    expect(P_EP1.maxSessionsPerCall).toBe(6);
    expect(P_EP1.maxInputTokens).toBe(8_000);
    expect(P_EP1.maxOutputTokens).toBe(3_000);
  });

  it("keeps UNKNOWN BEATS WRONG and the pending-placeholder rule verbatim", () => {
    expect(P_EP1_SYSTEM).toContain("UNKNOWN BEATS WRONG");
    expect(P_EP1_SYSTEM).toContain("[voice note, transcription pending]");
    expect(P_EP1_SYSTEM).toContain("every k you cite needs its own N line");
    expect(P_EP1_SYSTEM).toContain("Every edge REQUIRES a quote");
  });

  it("lists exactly the type and edge codes the decoder accepts", () => {
    // A legend that says one thing while the codec accepts another is how a
    // model gets blamed for a parser's drift. So the doc's own value line is
    // checked against the enum tables, code for code.
    const types = ENUMS.entity_type.entries.map((e) => e.code).join("|");
    const edges = ENUMS.edge_kind.entries.map((e) => e.code).join("|");
    expect(P_EP1_SYSTEM).toContain(`type = ${types}`);
    expect(P_EP1_SYSTEM).toContain(`edge = ${edges}`);
  });

  it("packs the §12.1 USER block", () => {
    const prompt = docPrompt();
    expect(prompt.user).toContain(
      "#R a1=Rahul Arora | a2=Pranjali Sachdeva | a3=Indiranagar [plc] | a4=Ghar+ [grp]",
    );
    expect(prompt.user).toContain("#C c1 Ghar+ | grp | self,a1,a2");
    expect(prompt.user).toContain("#D 2026-08-11 Tue | Asia/Kolkata");
    expect(prompt.user).toContain(
      "1 19:04 a1 shifting to Indiranagar next month, the broker found a 2BHK near the metro",
    );
    expect(prompt.user).toContain("#COV c1=3");
  });

  it("renders the legend from the tag table and appends the SYSTEM half", () => {
    const prompt = docPrompt();
    expect(prompt.system.startsWith(ep1Legend())).toBe(true);
    expect(prompt.system.endsWith(P_EP1_SYSTEM)).toBe(true);
    // Only the four tags this call may emit.
    expect(prompt.system).toContain("M | <events> | <surface> | <entity> | <confidence> | [<hint>]");
    expect(prompt.system).not.toContain("claim.fact");
  });

  it("refuses a roster over the packer's cap rather than truncating it", () => {
    const entities = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, name: `Person ${i}` }));
    const prompt = buildEp1Prompt({ entities, streams: [] }, { maxRoster: 120 });
    expect(prompt).toBeNull();
  });
});

describe("the §12.1 EXPECTED answer", () => {
  function parseDocAnswer(): { answer: Ep1Answer; prompt: ReturnType<typeof docPrompt> } {
    const prompt = docPrompt();
    const answer = parseEp1Response(
      [
        "M|1|Indiranagar|a3|0.95",
        "M|1|the broker|-|0.9|Rahul's broker, unnamed",
        "L|1|a1|loc|current|a3|0.7|shifting to Indiranagar next month",
      ].join("\n"),
      prompt.table,
    );
    return { answer, prompt };
  }

  it("parses the three records the doc prints and no fourth", () => {
    const { answer } = parseDocAnswer();
    expect(answer.mentions).toHaveLength(2);
    expect(answer.links).toHaveLength(1);
    expect(answer.proposals).toHaveLength(0);
    expect(answer.questions).toHaveLength(0);
    expect(answer.violations).toHaveLength(0);
    expect(answer.otherRecords).toHaveLength(0);
  });

  it("links the roster hit and leaves the unknown one unlinked with a hint", () => {
    const { answer } = parseDocAnswer();
    const [indiranagar, broker] = answer.mentions;
    expect(indiranagar.surface).toBe("Indiranagar");
    expect(targetEntityId(indiranagar.target)).toBe("ent_indiranagar");
    expect(indiranagar.confidence).toBe(0.95);
    expect(indiranagar.eventIds).toEqual(["ev1"]);

    // "the broker" — the referent is unclear, so `-` and a hint. That is an
    // answer, not a failure, and it must never resolve to an entity.
    expect(broker.target.kind).toBe("absent");
    expect(targetEntityId(broker.target)).toBeNull();
    expect(broker.hint).toBe("Rahul's broker, unnamed");
  });

  it("reads the edge with its quote and its endpoints", () => {
    const { answer } = parseDocAnswer();
    const [edge] = answer.links;
    expect(edge.kind).toBe("located_at");
    expect(edge.subtype).toBe("current");
    expect(targetEntityId(edge.src)).toBe("ent_rahul");
    expect(targetEntityId(edge.dst)).toBe("ent_indiranagar");
    expect(edge.confidence).toBe(0.7);
    expect(edge.quote).toBe("shifting to Indiranagar next month");
  });

  it("holds an edge with no quote apart — §12.1's one hard requirement", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("L|1|a1|loc|current|a3|0.7|", prompt.table);
    expect(answer.links).toHaveLength(0);
    expect(answer.quotelessLinks).toHaveLength(1);
  });
});

describe("temp ids", () => {
  it("recognises the k namespace and nothing else", () => {
    expect(isProposedAlias("k1")).toBe(true);
    expect(isProposedAlias("K12")).toBe(true);
    expect(isProposedAlias("a1")).toBe(false);
    expect(isProposedAlias("keerti")).toBe(false);
  });

  it("mints one entity per N line and rewrites every citation", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response(
      [
        "N|k1|Pizza 4P's|plc|restaurant",
        "M|1|Pizza 4P's|k1|0.9",
        "L|1|a1|loc|current|k1|0.6|we were at Pizza 4P's",
      ].join("\n"),
      prompt.table,
    );
    expect(answer.proposals).toHaveLength(1);
    expect(answer.danglingProposals).toEqual([]);

    const minted = mintProposals(answer.proposals);
    expect(minted.minted).toEqual(["k1"]);
    const id = minted.ids.get("k1")!;
    expect(getEntity(id)?.canonical).toBe("Pizza 4P's");
    expect(getEntity(id)?.type).toBe("place");
    expect(getEntity(id)?.subtype).toBe("restaurant");

    const resolved = resolveProposed(answer, minted.ids);
    expect(targetEntityId(resolved.mentions[0].target)).toBe(id);
    expect(targetEntityId(resolved.links[0].dst)).toBe(id);
    expect(resolved.dangling).toEqual([]);
  });

  it("dedupes two k lines that name the same thing to ONE entity", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response(
      ["N|k1|Indiranagar|plc", "N|k2|  indiranagar |plc", "M|1|Indiranagar|k2|0.8"].join("\n"),
      prompt.table,
    );
    const minted = mintProposals(answer.proposals);
    expect(minted.minted).toEqual(["k1"]);
    expect(minted.deduped).toEqual(["k2"]);
    expect(minted.ids.get("k1")).toBe(minted.ids.get("k2"));
    expect(listEntities({ type: "place" })).toHaveLength(1);
  });

  it("folds a proposal onto a roster entity rather than forking a second copy", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("N|k1|Indiranagar|plc", prompt.table);
    const minted = mintProposals(answer.proposals, {
      roster: [{ entityId: "ent_indiranagar", name: "Indiranagar", type: "place" }],
    });
    expect(minted.minted).toEqual([]);
    expect(minted.reused).toEqual(["k1"]);
    expect(minted.ids.get("k1")).toBe("ent_indiranagar");
    expect(listEntities()).toHaveLength(0);
  });

  it("does not fold on a name that is merely close — that is the ladder's job", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("N|k1|Indranagar|plc", prompt.table);
    const minted = mintProposals(answer.proposals, {
      roster: [{ entityId: "ent_indiranagar", name: "Indiranagar", type: "place" }],
    });
    expect(minted.minted).toEqual(["k1"]);
    expect(minted.ids.get("k1")).not.toBe("ent_indiranagar");
  });

  it("reports a k with no N line as dangling and never resolves it", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("M|1|the broker|k7|0.6|Rahul's broker", prompt.table);
    expect(answer.danglingProposals).toEqual(["k7"]);

    const minted = mintProposals(answer.proposals);
    expect(minted.ids.size).toBe(0);
    const resolved = resolveProposed(answer, minted.ids);
    expect(resolved.mentions[0].target.kind).toBe("proposed");
    expect(targetEntityId(resolved.mentions[0].target)).toBeNull();
    expect(resolved.dangling).toEqual(["k7"]);
    expect(listEntities()).toHaveLength(0);
  });

  it("drops a nameless proposal rather than minting an entity with no name", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("N|k1|-|plc", prompt.table);
    const minted = mintProposals(answer.proposals);
    expect(minted.dropped).toEqual(["k1"]);
    expect(listEntities()).toHaveLength(0);
  });
});

describe("totality and honesty", () => {
  it("never throws, on anything at all", () => {
    const prompt = docPrompt();
    for (const input of ["", "||||||", "hello there", null, undefined, 42, { a: 1 }]) {
      expect(() => parseEp1Response(input, prompt.table)).not.toThrow();
    }
  });

  it("resolves an out-of-roster alias to nothing, never to the nearest entity", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("M|1|Someone|a99|0.9", prompt.table);
    expect(answer.mentions[0].target.kind).toBe("unresolved");
    expect(targetEntityId(answer.mentions[0].target)).toBeNull();
  });

  it("counts a tag from another pass instead of deleting it", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("F|1|a1|ao|0.9|2026-08-11|Rahul is moving", prompt.table);
    expect(answer.otherRecords).toHaveLength(1);
    expect(answer.otherRecords[0].raw).toContain("Rahul is moving");
    expect(answer.mentions).toHaveLength(0);
  });

  it("keeps a rejected line as a violation quoting the model verbatim", () => {
    const prompt = docPrompt();
    const answer = parseEp1Response("M|1-|Indiranagar|a3|0.95", prompt.table);
    expect(answer.violations.length).toBeGreaterThan(0);
    expect(answer.violations[0].raw).toBe("M|1-|Indiranagar|a3|0.95");
  });
});
