// ===========================================================================
// P-AG2 — arc adjudication (§12.6, item 2.5). The settings are transcribed
// from the doc and asserted, the USER block is built in §12.6's shape, and the
// answer is read through the shared STW-2 parser with the off-roster refusal
// §5.8.6 requires.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { createAliasTable } from "../wire/aliases.js";
import {
  AG2_MAX_CANDIDATES,
  P_AG2,
  P_AG2_SYSTEM,
  ag2SendOptions,
  buildAg2Prompt,
  parseAg2Response,
  type Ag2Input,
} from "./p-ag2.js";

const INPUT: Ag2Input = {
  episode: {
    id: "ep_villas",
    label: "booking.com villa session",
    sourceIds: ["browser"],
    span: "11–12 Aug",
    anchorEntityIds: ["ent_amara", "ent_goa"],
    summary: "user compared 3 villas, opened Amara twice",
  },
  candidates: [
    {
      arcId: "arc_goa",
      label: "Goa trip",
      sourceIds: ["wa", "cal"],
      anchorEntityIds: ["ent_rohan", "ent_goa"],
      bridge: "url booking.com/villa-amara (browser↔wa)",
      overlap: 0.66,
      similarity: 0.81,
    },
    {
      arcId: "arc_lunch",
      label: "weekend lunches",
      sourceIds: ["wa"],
      anchorEntityIds: ["ent_kabir"],
      bridge: null,
      overlap: 0,
      similarity: 0.28,
    },
  ],
};

describe("settings (§12.6)", () => {
  it("is a one-turn, tool-free sonnet-5 call with a 60 s wall and 400 max out", () => {
    expect(P_AG2.model).toBe("sonnet-5");
    expect(P_AG2.turns).toBe(1);
    expect(P_AG2.tools).toBe("none");
    expect(P_AG2.thinking).toBe("off");
    expect(P_AG2.timeoutSeconds).toBe(60);
    expect(P_AG2.maxEpisodesPerCall).toBe(1);
    expect(P_AG2.maxOutputTokens).toBe(400);
    expect(P_AG2.role).toBe("arc");
  });

  it("is NOT on the first-paint path — the whole point of provisional arcs", () => {
    expect(P_AG2.onCriticalPath).toBe(false);
  });

  it("hands the provider knobs no call site can raise", () => {
    const send = ag2SendOptions();
    expect(send.maxTurns).toBe(1);
    expect(send.timeoutMs).toBe(60_000);
    expect(send.maxOutputTokens).toBe(400);
    expect(send.thinkingBudget).toBe("off");
    expect(send.plainCompletion).toBe(true);
  });

  it("carries §12.6's rules verbatim, including the refusal to force an answer", () => {
    expect(P_AG2_SYSTEM).toContain("Bridges (shared url, order id, file id, attendee set) are near-proof.");
    expect(P_AG2_SYSTEM).toContain("Same people ALONE is");
    expect(P_AG2_SYSTEM).toContain('Evidence genuinely underdetermines it → "un". Never force.');
    expect(P_AG2_SYSTEM).toContain("V | <ep> | <jn|nw|un> | <n-alias | -> | <conf> | <reason>");
  });
});

describe("the USER block (§12.6)", () => {
  it("opens with the EP line and its indented gloss, then one line per candidate", () => {
    const prompt = buildAg2Prompt(INPUT);
    const lines = prompt.user.split("\n");
    expect(lines[0]).toContain("EP e1 booking.com villa session");
    expect(lines[0]).toContain("browser");
    expect(lines[0]).toContain("11–12 Aug");
    expect(lines[1]).toBe("   user compared 3 villas, opened Amara twice");
    expect(lines[2]).toContain("n1 Goa trip");
    expect(lines[2]).toContain("bridge url booking.com/villa-amara (browser↔wa)");
    expect(lines[2]).toContain("overlap 0.66");
    expect(lines[2]).toContain("sim 0.81");
    expect(lines[3]).toContain("n2 weekend lunches");
    expect(lines[3]).toContain("bridge -");
  });

  it("prints an unmeasured similarity as '-', never as a number", () => {
    const prompt = buildAg2Prompt({
      episode: INPUT.episode,
      candidates: [{ arcId: "arc_x", label: "x", similarity: null, overlap: null }],
    });
    expect(prompt.user).toContain("sim -");
    expect(prompt.user).toContain("overlap -");
  });

  it("sends ids as aliases and never as themselves", () => {
    const prompt = buildAg2Prompt(INPUT);
    expect(prompt.user).not.toContain("arc_goa");
    expect(prompt.user).not.toContain("ep_villas");
    expect(prompt.user).not.toContain("ent_goa");
    expect(prompt.aliases).toEqual({ arc_goa: "n1", arc_lunch: "n2" });
    expect(prompt.episodeAlias).toBe("e1");
  });

  it("neutralises a pipe inside a label so it cannot forge a field", () => {
    const prompt = buildAg2Prompt({
      episode: { id: "e", label: "a | b" },
      candidates: [{ arcId: "arc_x", label: "c | d" }],
    });
    expect(prompt.user).toContain("a / b");
    expect(prompt.user).toContain("c / d");
  });

  it("reports a trimmed roster instead of silently shortening it", () => {
    const many = Array.from({ length: AG2_MAX_CANDIDATES + 2 }, (_, i) => ({
      arcId: `arc_${i}`,
      label: `arc ${i}`,
    }));
    const prompt = buildAg2Prompt({ episode: INPUT.episode, candidates: many });
    expect(prompt.trimmed).toEqual([`arc_${AG2_MAX_CANDIDATES}`, `arc_${AG2_MAX_CANDIDATES + 1}`]);
  });

  it("opens the system block with the shared legend", () => {
    const prompt = buildAg2Prompt(INPUT);
    expect(prompt.system).toContain("WIRE FORMAT — STW-2");
    expect(prompt.system).toContain(P_AG2_SYSTEM);
  });
});

describe("the answer", () => {
  it("reads §12.6's own EXPECTED line", () => {
    const prompt = buildAg2Prompt(INPUT);
    const answer = parseAg2Response(
      "V|e1|jn|n1|0.97|exact url bridge to the same villa page already in that thread",
      prompt.table,
      "ep_villas",
    );
    expect(answer.verdict?.verdict).toBe("join");
    expect(answer.verdict?.arcId).toBe("arc_goa");
    expect(answer.verdict?.episodeId).toBe("ep_villas");
    expect(answer.verdict?.confidence).toBe(0.97);
    expect(answer.verdict?.reason).toContain("url bridge");
  });

  it("reads nw and un", () => {
    const prompt = buildAg2Prompt(INPUT);
    expect(parseAg2Response("V|e1|nw|-|0.8|different matter", prompt.table).verdict?.verdict).toBe("new");
    expect(parseAg2Response("V|e1|un|n1|0.4|cannot tell", prompt.table).verdict?.verdict).toBe("unsure");
  });

  it("resolves an off-roster n-alias to null rather than to whatever was closest", () => {
    const prompt = buildAg2Prompt(INPUT);
    const answer = parseAg2Response("V|e1|jn|n9|0.99|sure", prompt.table, "ep_villas");
    expect(answer.verdict?.verdict).toBe("join");
    expect(answer.verdict?.arcId).toBeNull();
    expect(answer.verdict?.arcAlias).toBe("n9");
  });

  it("files a verdict about another episode as an orphan, never applies it", () => {
    const table = createAliasTable();
    const prompt = buildAg2Prompt(INPUT, table);
    table.mint("episode", "ep_other", "another");
    const answer = parseAg2Response("V|e2|jn|n1|0.9|not this episode", prompt.table, "ep_villas");
    expect(answer.verdict).toBeNull();
    expect(answer.orphans).toHaveLength(1);
    expect(answer.orphans[0]?.episodeId).toBe("ep_other");
  });

  it("keeps a second verdict rather than deleting it — code orders, never censors", () => {
    const prompt = buildAg2Prompt(INPUT);
    const answer = parseAg2Response(
      "V|e1|jn|n1|0.9|first\nV|e1|nw|-|0.5|second thoughts",
      prompt.table,
      "ep_villas",
    );
    expect(answer.verdict?.verdict).toBe("join");
    expect(answer.extra).toHaveLength(1);
    expect(answer.extra[0]?.raw).toBe("V|e1|nw|-|0.5|second thoughts");
  });

  it("never throws on garbage; it reports it", () => {
    const prompt = buildAg2Prompt(INPUT);
    const answer = parseAg2Response("I think it probably belongs to the Goa thread.", prompt.table);
    expect(answer.verdict).toBeNull();
    expect(answer.violations.length + answer.otherRecords.length).toBeGreaterThan(0);
  });

  it("keeps the model's line byte-for-byte", () => {
    const prompt = buildAg2Prompt(INPUT);
    const line = "V|e1|jn|n1|0.97|exact url bridge";
    expect(parseAg2Response(line, prompt.table, "ep_villas").verdict?.raw).toBe(line);
  });
});
