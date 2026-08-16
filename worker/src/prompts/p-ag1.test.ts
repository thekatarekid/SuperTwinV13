// ===========================================================================
// P-AG1 — the identity resolver (build item 1.10, arch §12.2; evals G-039..044).
//
// The §12.2 worked example leads: its USER block builds to the shape the doc
// prints, and its EXPECTED line parses to the verdict the doc shows, evidence
// tail and all.
//
// Then the four settings that are enforced rather than trusted — three tools,
// read-only, three turns, sixty seconds — and the one honesty rule: with the
// [ML] rung disabled the prompt says the score is unavailable and WHY. It
// never prints a number nobody measured.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { recordMention } from "../entities/binding.js";
import { writeEdge } from "../entities/edges.js";
import { putIdentity } from "../entities/identities.js";
import { createEntity } from "../entities/registry.js";
import { createAliasTable } from "../wire/aliases.js";
import {
  AG1_EVENT_LIMIT,
  AG1_SEARCH_LIMIT,
  AG1_TOOL_NAMES,
  P_AG1,
  P_AG1_SYSTEM,
  WriteScopeViolation,
  ag1AllowedTools,
  ag1SendOptions,
  assertReadOnly,
  buildAg1Prompt,
  buildAg1User,
  createAg1Tools,
  parseAg1Response,
  readEntityCard,
  readEventTexts,
  searchEntities,
  type Ag1Pair,
} from "./p-ag1.js";
import { resetLegendCache } from "./legend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-p-ag1-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  resetLegendCache();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  resetLegendCache();
});

/** The §12.2 pair, as its worked example prints it. */
function docPair(): Ag1Pair {
  return {
    left: {
      entityId: "ent_papa_jio",
      name: "Papa (new number Jio)",
      type: "per",
      identities: ["jid 919812…21"],
      seen: "seen from 2026-07-28",
      groupIds: ["ent_ghar"],
    },
    right: {
      entityId: "ent_papa",
      name: "Papa",
      type: "per",
      identities: ["jid 919425…07", "phone +919425…07"],
      seen: "last event 2026-07-24",
      groupIds: ["ent_ghar", "ent_family"],
    },
    score: 0.62,
    shared: ["both in a4", 'both addressed as "Papa"', "B silent since A appeared"],
  };
}

describe("the §12.2 settings", () => {
  it("transcribes the settings row", () => {
    expect(P_AG1.model).toBe("sonnet-5");
    expect(P_AG1.turns).toBe(3);
    expect(P_AG1.timeoutSeconds).toBe(60);
    expect(P_AG1.maxTotalTokens).toBe(8_000);
    expect(P_AG1.thinking).toBe("off");
    expect(P_AG1.writeScope).toBe("none");
    expect(P_AG1.onCriticalPath).toBe(false);
  });

  it("keeps the evidence rule and the `un` escape verbatim", () => {
    expect(P_AG1_SYSTEM).toContain("Evidence beats name similarity");
    expect(P_AG1_SYSTEM).toContain("The same first name alone is weak");
    expect(P_AG1_SYSTEM).toContain('Insufficient or conflicting evidence → "un"');
    expect(P_AG1_SYSTEM).toContain("Never force");
  });

  it("names exactly three tools, and caps two of them", () => {
    expect([...AG1_TOOL_NAMES]).toEqual(["search_entities", "read_entity", "read_events"]);
    expect(AG1_SEARCH_LIMIT).toBe(10);
    expect(AG1_EVENT_LIMIT).toBe(10);
  });

  it("builds a send shape nothing can raise", () => {
    const send = ag1SendOptions();
    expect(send.maxTurns).toBe(3);
    expect(send.timeoutMs).toBe(60_000);
    expect(send.thinkingBudget).toBe("off");
    expect(send.allowedTools).toEqual(ag1AllowedTools());
  });

  it("refuses any tool outside the read-only three (write scope none)", () => {
    expect(() => assertReadOnly(ag1AllowedTools())).not.toThrow();
    expect(() => assertReadOnly(["search_entities"])).not.toThrow();
    expect(() => assertReadOnly([...ag1AllowedTools(), "Write"])).toThrow(WriteScopeViolation);
    expect(() => assertReadOnly(["Bash"])).toThrow(/write scope none/);
  });
});

describe("the §12.2 USER block", () => {
  it("prints both sides, the calibrated score and the shared signals", () => {
    const table = createAliasTable();
    const user = buildAg1User(docPair(), table);
    const lines = user.split("\n");
    expect(lines[0]).toBe(
      'A: a1 "Papa (new number Jio)" · per · jid 919812…21 · seen from 2026-07-28 · in a2',
    );
    expect(lines[1]).toBe(
      'B: a3 "Papa" · per · jid 919425…07, phone +919425…07 · last event 2026-07-24 · in a2, a4',
    );
    expect(lines[2]).toBe("ML score (calibrated): 0.62");
    expect(lines[3]).toBe('shared: both in a4; both addressed as "Papa"; B silent since A appeared');
  });

  it("says the score is unavailable, and why, rather than inventing one", () => {
    const table = createAliasTable();
    const user = buildAg1User(
      { ...docPair(), score: null, scoreUnavailableReason: "no calibration row for (e5-small, entity_name)" },
      table,
    );
    expect(user).toContain("ML score: unavailable — no calibration row for (e5-small, entity_name)");
    expect(user).not.toMatch(/ML score \(calibrated\)/);
    expect(user).not.toMatch(/0\.\d\d/);
  });

  it("carries the alias table the answer must be read against", () => {
    const prompt = buildAg1Prompt(docPair());
    expect(prompt.aliases).toEqual({ ent_papa_jio: "a1", ent_papa: "a3" });
    expect(prompt.system.endsWith(P_AG1_SYSTEM)).toBe(true);
    expect(prompt.system).toContain("verdict.entity");
    expect(prompt.allowedTools).toEqual(ag1AllowedTools());
  });
});

describe("the §12.2 EXPECTED answer", () => {
  it("parses the doc's verdict, evidence tail and all", () => {
    const prompt = buildAg1Prompt(docPair());
    const answer = parseAg1Response(
      "V|a1|a3|same|0.88|same group, same address term, old number went silent the day the new one appeared|q1,r4",
      prompt.table,
    );
    const verdict = answer.verdict!;
    expect(verdict.verdict).toBe("same");
    expect(verdict.confidence).toBe(0.88);
    expect(verdict.leftId).toBe("ent_papa_jio");
    expect(verdict.rightId).toBe("ent_papa");
    expect(verdict.reason).toBe(
      "same group, same address term, old number went silent the day the new one appeared",
    );
    expect(verdict.evidence).toEqual(["q1", "r4"]);
    expect(answer.violations).toHaveLength(0);
  });

  it("reads `un` as unsure — the answer that sends the pair to a human", () => {
    const prompt = buildAg1Prompt(docPair());
    const answer = parseAg1Response("V|a1|a3|un|0.4|two numbers, no shared group, nothing decides it", prompt.table);
    expect(answer.verdict?.verdict).toBe("unsure");
  });

  it("reads `diff` as different", () => {
    const prompt = buildAg1Prompt(docPair());
    expect(parseAg1Response("V|a1|a3|diff|0.9|different phones", prompt.table).verdict?.verdict).toBe(
      "different",
    );
  });

  it("resolves an out-of-roster alias to nothing, never to the nearest entity", () => {
    const prompt = buildAg1Prompt(docPair());
    const answer = parseAg1Response("V|a1|a9|same|0.9|hunch", prompt.table);
    expect(answer.verdict).toBeNull();
    expect(answer.unresolved).toHaveLength(1);
    expect(answer.unresolved[0].rightId).toBeNull();
  });

  it("keeps a second verdict rather than deleting it", () => {
    const prompt = buildAg1Prompt(docPair());
    const answer = parseAg1Response(
      ["V|a1|a3|same|0.88|first", "V|a1|a3|un|0.4|second thoughts"].join("\n"),
      prompt.table,
    );
    expect(answer.verdict?.reason).toBe("first");
    expect(answer.extra).toHaveLength(1);
    expect(answer.extra[0].reason).toBe("second thoughts");
  });

  it("never throws, on anything at all", () => {
    const prompt = buildAg1Prompt(docPair());
    for (const input of ["", "|||", "I think they are the same person.", null, undefined, 7]) {
      expect(() => parseAg1Response(input, prompt.table)).not.toThrow();
    }
    expect(parseAg1Response("nothing wire-shaped here", prompt.table).verdict).toBeNull();
  });
});

describe("the three read-only tools", () => {
  function seed(): { papa: string; jio: string; ghar: string; eventId: string } {
    const papa = createEntity({ type: "person", canonical: "Papa", provisional: false }).id;
    const jio = createEntity({ type: "person", canonical: "Papa (new number Jio)", provisional: true }).id;
    const ghar = createEntity({ type: "group", canonical: "Ghar+", provisional: false }).id;
    putIdentity({
      entityId: papa,
      sourceId: "whatsapp",
      kind: "jid",
      value: "919425000007@s.whatsapp.net",
      confidence: 1,
      decidedBy: "code:mint",
    });
    writeEdge({
      kind: "affiliated_with",
      subtype: "member",
      srcEntityId: papa,
      dstEntityId: ghar,
      confidence: 1,
      decidedBy: "code:metadata",
    });
    const streamId = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Ghar+", kind: "group" });
    const actorId = upsertActor({ sourceId: "whatsapp", sourceExtId: "919425000007", displayName: "Papa" });
    const eventId = insertEvent({
      externalId: "c1/e1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId,
      ts: "2026-07-24T10:00:00Z",
      kind: "message",
      text: "Papa said he would call\nafter lunch",
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    }).id;
    recordMention({ eventId, surface: "Papa", entityId: papa, confidence: 0.95, decidedBy: "code:roster" });
    return { papa, jio, ghar, eventId };
  }

  it("search_entities matches on name, filters by type and caps at ten", () => {
    seed();
    for (let i = 0; i < 15; i += 1) createEntity({ type: "person", canonical: `Papa ${i}`, provisional: true });
    expect(searchEntities("papa").length).toBe(AG1_SEARCH_LIMIT);
    expect(searchEntities("ghar", "group").map((m) => m.name)).toEqual(["Ghar+"]);
    expect(searchEntities("nobody at all")).toEqual([]);
  });

  it("read_entity returns identities, edges and top mentions with quotes", () => {
    const { papa, ghar } = seed();
    const card = readEntityCard(papa)!;
    expect(card.name).toBe("Papa");
    expect(card.identities.map((i) => i.kind)).toContain("jid");
    expect(card.edges).toEqual([
      { kind: "affiliated_with", subtype: "member", otherId: ghar, otherName: "Ghar+", direction: "out" },
    ]);
    expect(card.mentions[0].surface).toBe("Papa");
    // Newlines are collapsed so a quote stays one line on the wire.
    expect(card.mentions[0].quote).toBe("Papa said he would call after lunch");
  });

  it("read_entity follows a merge redirect, and answers null for a stranger", () => {
    const { papa } = seed();
    expect(readEntityCard(papa)?.id).toBe(papa);
    expect(readEntityCard("ent_nope")).toBeNull();
  });

  it("read_events returns raw text and refuses more than ten ids", () => {
    const { eventId } = seed();
    expect(readEventTexts([eventId])[0].text).toBe("Papa said he would call\nafter lunch");
    const ids = Array.from({ length: 25 }, (_, i) => `ev${i}`);
    // The cap is applied to the REQUEST, so an over-long list cannot widen the
    // read; none of these exist, so nothing comes back either.
    expect(readEventTexts([...ids, eventId])).toEqual([]);
    expect(readEventTexts([])).toEqual([]);
  });

  it("exposes exactly the three, and every one of them only reads", () => {
    const { papa } = seed();
    const tools = createAg1Tools();
    expect(Object.keys(tools).sort()).toEqual(["read_entity", "read_events", "search_entities"]);
    const before = readEntityCard(papa);
    tools.search_entities("papa");
    tools.read_entity(papa);
    tools.read_events([]);
    expect(readEntityCard(papa)).toEqual(before);
  });
});
