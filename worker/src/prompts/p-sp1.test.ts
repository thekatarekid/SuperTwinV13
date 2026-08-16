import { describe, expect, it, beforeEach } from "vitest";

import { createAliasTable } from "../wire/aliases.js";
import { resetLegendCache } from "./legend.js";
import {
  P_SP1,
  P_SP1_SYSTEM,
  SP1_ARCHETYPES,
  archetypeCode,
  buildSp1Prompt,
  buildSp1System,
  buildSp1User,
  chunkThreads,
  labelWordCount,
  parseSp1Response,
  sp1Accounts,
  sp1Assignments,
  sp1SendOptions,
  sp1Transitions,
  type Sp1Current,
  type Sp1Thread,
} from "./p-sp1.js";

beforeEach(() => {
  resetLegendCache();
});

/** §12.10's own USER block, as the doc prints it. */
const THREADS: Sp1Thread[] = [
  {
    arcId: "arc-goa",
    label: "Goa trip",
    sourceIds: ["wa", "web", "cal", "gmail", "shop"],
    anchorEntityIds: ["e-rohan", "e-villa", "e-flat"],
    promotion: "commitment",
    loops: [
      { text: "confirm villa to Rohan", due: "20 Aug" },
      { text: "compare flights" },
      { text: "split deposit" },
    ],
    quotes: ["villa held till 20 Aug", "12-15 Sep", "who pays deposit?"],
  },
  {
    arcId: "arc-broadband",
    label: "broadband renewal",
    sourceIds: ["gmail", "shop"],
    anchorEntityIds: ["e-act"],
    promotion: "cmt",
    loops: [{ text: "broadband renews", due: "28 Aug", every: "monthly" }],
  },
  {
    arcId: "arc-flat",
    label: "the Indiranagar flat",
    sourceIds: ["wa", "doc", "gmail"],
    anchorEntityIds: ["e-flat", "e-landlord"],
    promotion: "ref",
    facts: ["rent 52k", "lease to Nov 2027"],
  },
  {
    arcId: "arc-sourdough",
    label: "sourdough experiments",
    sourceIds: ["wa", "web"],
    promotion: "rec",
    note: "9 episodes over 7 weeks, user participated in all",
  },
];

describe("P-SP1 settings (§12.10)", () => {
  it("transcribes the doc's settings line", () => {
    expect(P_SP1.model).toBe("haiku-4-5");
    expect(P_SP1.turns).toBe(1);
    expect(P_SP1.tools).toBe("none");
    expect(P_SP1.thinking).toBe("off");
    expect(P_SP1.timeoutSeconds).toBe(60);
    expect(P_SP1.maxThreadsPerCall).toBe(10);
    expect(P_SP1.maxOutputTokens).toBe(800);
  });

  it("is never on the first-paint path", () => {
    expect(P_SP1.onCriticalPath).toBe(false);
  });

  it("fixes the provider knobs so no call site can raise them", () => {
    expect(sp1SendOptions()).toEqual({
      model: "haiku-4-5",
      maxTurns: 1,
      timeoutMs: 60_000,
      maxOutputTokens: 800,
      thinkingBudget: "off",
      plainCompletion: true,
    });
  });
});

describe("the SYSTEM block", () => {
  it("names all eight shapes with their codes", () => {
    for (const stored of SP1_ARCHETYPES) {
      const code = archetypeCode(stored);
      expect(code).not.toBeNull();
      expect(P_SP1_SYSTEM).toContain(`${code} ${stored}`);
    }
  });

  it("keeps the pursuit-vs-watch rule verbatim", () => {
    expect(P_SP1_SYSTEM).toContain("does the person ACT (pursuit) or OBSERVE (watch)?");
  });

  it("keeps the 4-8 word label rule and the rejected examples", () => {
    expect(P_SP1_SYSTEM).toContain("MORE THAN THREE WORDS. 4 to 8 plain words");
    expect(P_SP1_SYSTEM).toContain('BAD  "Goa trip"');
  });

  it("carries the output template", () => {
    expect(P_SP1_SYSTEM).toContain(
      "D | <n-alias> | <archetype> | <one|rec> | <ends_at | -> | <conf> | <label>",
    );
  });

  it("puts the legend first and is byte-identical across calls", () => {
    const a = buildSp1System();
    const b = buildSp1System();
    expect(a).toBe(b);
    expect(a.startsWith("WIRE FORMAT — STW-2")).toBe(true);
    expect(a.endsWith(P_SP1_SYSTEM)).toBe(true);
  });

  it("renders the archetype enum into the legend from the wire table", () => {
    expect(buildSp1System()).toContain("prj");
    expect(buildSp1System()).toContain("wch");
  });
});

describe("chunkThreads", () => {
  it("caps a call at ten threads", () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ arcId: `a${i}`, label: `t${i}` }));
    const chunks = chunkThreads(many);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 3]);
  });

  it("never produces a zero-sized chunk", () => {
    expect(chunkThreads([{ arcId: "a", label: "l" }], 0)).toEqual([[{ arcId: "a", label: "l" }]]);
  });
});

describe("buildSp1User (§12.10 shape)", () => {
  it("prints the header, loops and quotes in the doc's layout", () => {
    const table = createAliasTable();
    const lines = buildSp1User(THREADS, table).split("\n");
    expect(lines[0]).toBe("n1 Goa trip | wa,web,cal,gmail,shop | anchors a1,a2,a3 | promo cmt");
    expect(lines[1]).toBe(
      "   loops: confirm villa to Rohan (due 20 Aug) · compare flights (-) · split deposit (-)",
    );
    expect(lines[2]).toBe('   "villa held till 20 Aug" / "12-15 Sep" / "who pays deposit?"');
  });

  it("prints a recurring loop with its due date and cadence word", () => {
    const table = createAliasTable();
    const text = buildSp1User([THREADS[1]!], table);
    expect(text).toContain("loops: broadband renews (due 28 Aug, monthly)");
  });

  it("prints `loops: -` with facts for a thread with no open loops", () => {
    const table = createAliasTable();
    const text = buildSp1User([THREADS[2]!], table);
    expect(text).toContain("loops: - | facts: rent 52k, lease to Nov 2027");
  });

  it("prints the gloss note after the loops", () => {
    const table = createAliasTable();
    const text = buildSp1User([THREADS[3]!], table);
    expect(text).toContain("loops: - | 9 episodes over 7 weeks, user participated in all");
    expect(text).toContain("anchors -");
  });

  it("accepts the promotion enum in code or stored form", () => {
    const table = createAliasTable();
    const text = buildSp1User(
      [
        { arcId: "x", label: "a", promotion: "recurrence" },
        { arcId: "y", label: "b", promotion: "usr" },
        { arcId: "z", label: "c", promotion: "nonsense" },
      ],
      table,
    );
    expect(text).toContain("promo rec");
    expect(text).toContain("promo usr");
    expect(text).toContain("promo -");
  });

  it("sends arc ids as n-aliases and never as raw ids", () => {
    const table = createAliasTable();
    const text = buildSp1User(THREADS, table);
    for (const thread of THREADS) expect(text).not.toContain(thread.arcId);
  });

  it("prints self unnumbered among the anchors", () => {
    const table = createAliasTable();
    const text = buildSp1User([{ arcId: "q", label: "l", anchorEntityIds: ["self", "e1"] }], table);
    expect(text).toContain("anchors self,a1");
  });
});

describe("buildSp1Prompt", () => {
  it("returns the alias map the answer must be read against", () => {
    const prompt = buildSp1Prompt(THREADS);
    expect(prompt.aliases).toEqual({
      "arc-goa": "n1",
      "arc-broadband": "n2",
      "arc-flat": "n3",
      "arc-sourdough": "n4",
    });
    expect(prompt.system).toBe(buildSp1System());
  });
});

// ---------------------------------------------------------------------------

const EXPECTED = [
  "D|n1|evt|one|2026-09-15|0.9|Goa trip with Rohan in September",
  "D|n2|adm|rec|-|0.95|ACT broadband renewal each month",
  "D|n3|rhy|rec|-|0.92|Weekend lunches with Rajat and Mansi",
  "D|n4|hld|one|2027-11-30|0.9|The Indiranagar flat and its lease",
].join("\n");

describe("parseSp1Response", () => {
  it("reads §12.10's EXPECTED block back into stored long forms", () => {
    const prompt = buildSp1Prompt(THREADS);
    const answer = parseSp1Response(EXPECTED, prompt.table, THREADS);
    expect(answer.violations).toEqual([]);
    expect(answer.derivations.map((d) => [d.arcId, d.archetype, d.cadence, d.endsAt])).toEqual([
      ["arc-goa", "event", "one_off", "2026-09-15"],
      ["arc-broadband", "admin", "recurrence", null],
      ["arc-flat", "rhythm", "recurrence", null],
      ["arc-sourdough", "holding", "one_off", "2027-11-30"],
    ]);
    expect(answer.derivations[0]!.label).toBe("Goa trip with Rohan in September");
    expect(answer.derivations[0]!.confidence).toBe(0.9);
    expect(answer.missing).toEqual([]);
  });

  it("classifies all eight shapes", () => {
    const threads = SP1_ARCHETYPES.map((a, i) => ({ arcId: `arc-${a}`, label: `thread ${i}` }));
    const prompt = buildSp1Prompt(threads);
    const wire = SP1_ARCHETYPES.map(
      (a, i) => `D|n${i + 1}|${archetypeCode(a)}|one|-|0.8|a four word label ${i}`,
    ).join("\n");
    const answer = parseSp1Response(wire, prompt.table, threads);
    expect(answer.derivations.map((d) => d.archetype)).toEqual([...SP1_ARCHETYPES]);
    expect(answer.derivations.every((d) => d.arcId !== null)).toBe(true);
  });

  it("flags a short label without changing it", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|evt|one|-|0.9|Goa trip", prompt.table, [THREADS[0]!]);
    const d = answer.derivations[0]!;
    expect(d.label).toBe("Goa trip");
    expect(d.labelWords).toBe(2);
    expect(d.labelTooShort).toBe(true);
  });

  it("does not flag a label of four words or more", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response(
      "D|n1|evt|one|-|0.9|Goa trip with Rohan in September",
      prompt.table,
      [THREADS[0]!],
    );
    expect(answer.derivations[0]!.labelTooShort).toBe(false);
    expect(answer.derivations[0]!.labelWords).toBe(6);
  });

  it("keeps a label containing a pipe intact — prose is the last field", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|evt|one|-|0.9|Goa trip | Rohan | September", prompt.table);
    expect(answer.derivations[0]!.label).toBe("Goa trip | Rohan | September");
  });

  it("reports an out-of-roster alias instead of guessing the nearest thread", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n9|evt|one|-|0.9|some four word label", prompt.table, [
      THREADS[0]!,
    ]);
    expect(answer.derivations).toEqual([]);
    expect(answer.unresolved).toHaveLength(1);
    expect(answer.unresolved[0]!.alias).toBe("n9");
    expect(answer.unresolved[0]!.arcId).toBeNull();
    expect(answer.missing).toEqual(["arc-goa"]);
  });

  it("keeps a second line for the same arc rather than dropping it", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response(
      ["D|n1|evt|one|-|0.9|first four word label", "D|n1|prj|rec|-|0.5|second four word label"].join(
        "\n",
      ),
      prompt.table,
      [THREADS[0]!],
    );
    expect(answer.derivations).toHaveLength(1);
    expect(answer.derivations[0]!.archetype).toBe("event");
    expect(answer.duplicates).toHaveLength(1);
    expect(answer.duplicates[0]!.archetype).toBe("project");
  });

  it("turns a bad archetype into a violation and never throws", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|zzz|one|-|0.9|four plain words here", prompt.table, [
      THREADS[0]!,
    ]);
    expect(answer.derivations).toEqual([]);
    expect(answer.violations.length).toBeGreaterThan(0);
    expect(answer.violations[0]!.raw).toContain("zzz");
    expect(answer.missing).toEqual(["arc-goa"]);
  });

  it("counts a tag this call may not emit rather than discarding it", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response(
      ["D|n1|evt|one|-|0.9|Goa trip with Rohan", "C|m1|a photo of the villa"].join("\n"),
      prompt.table,
      [THREADS[0]!],
    );
    expect(answer.derivations).toHaveLength(1);
    expect(answer.otherRecords).toHaveLength(1);
    expect(answer.otherRecords[0]!.tag).toBe("C");
  });

  it("balances its books — nothing the parser saw is discarded", () => {
    const prompt = buildSp1Prompt(THREADS);
    const answer = parseSp1Response(
      [EXPECTED, "C|m1|a caption", "D|n9|evt|one|-|0.9|out of roster label", "hello there"].join(
        "\n",
      ),
      prompt.table,
      THREADS,
    );
    const accounts = sp1Accounts(answer);
    expect(accounts.balanced).toBe(true);
    expect(accounts.seen).toBe(accounts.kept);
  });

  it("handles an empty answer", () => {
    const prompt = buildSp1Prompt(THREADS);
    const answer = parseSp1Response("", prompt.table, THREADS);
    expect(answer.derivations).toEqual([]);
    expect(answer.missing).toEqual(THREADS.map((t) => t.arcId));
  });
});

describe("the field flip", () => {
  it("writes archetype and archetype_source = model", () => {
    const prompt = buildSp1Prompt(THREADS);
    const answer = parseSp1Response(EXPECTED, prompt.table, THREADS);
    const flip = sp1Assignments(answer);
    expect(flip.held).toEqual([]);
    expect(flip.assignments[0]).toEqual({
      arcId: "arc-goa",
      archetype: "event",
      archetypeSource: "model",
      cadence: "one_off",
      endsAt: "2026-09-15",
      label: "Goa trip with Rohan in September",
      confidence: 0.9,
      labelTooShort: false,
    });
    expect(flip.assignments.every((a) => a.archetypeSource === "model")).toBe(true);
  });

  it("never overwrites a user-set archetype", () => {
    const prompt = buildSp1Prompt(THREADS);
    const answer = parseSp1Response(EXPECTED, prompt.table, THREADS);
    const current = new Map<string, Sp1Current>([
      ["arc-goa", { archetype: "project", archetypeSource: "user" }],
    ]);
    const flip = sp1Assignments(answer, current);
    expect(flip.assignments.map((a) => a.arcId)).not.toContain("arc-goa");
    expect(flip.held).toHaveLength(1);
    expect(flip.held[0]!.archetype).toBe("event");
  });
});

describe("sp1Transitions", () => {
  it("records a first classification as a transition from null", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|evt|one|-|0.9|Goa trip with Rohan", prompt.table);
    const t = sp1Transitions(answer)[0]!;
    expect(t).toEqual({
      arcId: "arc-goa",
      from: null,
      to: "event",
      source: "model",
      reason: "D|n1|evt|one|-|0.9|Goa trip with Rohan",
      confidence: 0.9,
    });
  });

  it("records a revision with the model's own line as the reason", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|prj|rec|-|0.8|Goa trip planning with Rohan", prompt.table);
    const current = new Map<string, Sp1Current>([
      ["arc-goa", { archetype: "event", archetypeSource: "model" }],
    ]);
    const t = sp1Transitions(answer, current)[0]!;
    expect(t.from).toBe("event");
    expect(t.to).toBe("project");
    expect(t.reason).toBe("D|n1|prj|rec|-|0.8|Goa trip planning with Rohan");
  });

  it("emits nothing when the shape is unchanged", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|evt|one|-|0.9|Goa trip with Rohan", prompt.table);
    const current = new Map<string, Sp1Current>([
      ["arc-goa", { archetype: "event", archetypeSource: "model" }],
    ]);
    expect(sp1Transitions(answer, current)).toEqual([]);
  });

  it("emits nothing for a user-held archetype", () => {
    const prompt = buildSp1Prompt([THREADS[0]!]);
    const answer = parseSp1Response("D|n1|prj|rec|-|0.8|Goa trip planning with Rohan", prompt.table);
    const current = new Map<string, Sp1Current>([
      ["arc-goa", { archetype: "event", archetypeSource: "user" }],
    ]);
    expect(sp1Transitions(answer, current)).toEqual([]);
  });
});

describe("labelWordCount", () => {
  it("counts plain words and ignores surrounding space", () => {
    expect(labelWordCount("  Goa trip with Rohan  ")).toBe(4);
    expect(labelWordCount("")).toBe(0);
  });
});
