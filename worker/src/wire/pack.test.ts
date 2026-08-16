import { describe, expect, it } from "vitest";

import { collapseNewlines, neutraliseLabel, neutraliseParticipant, packPrompt, type PackInput } from "./pack.js";

const BASE: PackInput = {
  tz: "Asia/Kolkata",
  entities: [
    { id: "ent_p", name: "Pranjali Sachdeva" },
    { id: "ent_r", name: "Rahul Arora" },
    { id: "ent_v", name: "Villa Amara", type: "place" },
  ],
  streams: [{ id: "wa:1", name: "Pranjali", kind: "dm", participantIds: ["self", "ent_p"] }],
  episodes: [
    {
      id: "epi_1",
      label: "villa shortlist for Goa",
      state: "open",
      lastActivity: "last Mon",
      entityIds: ["ent_r", "ent_v"],
    },
  ],
  loops: [{ id: "loop_1", intent: "Confirm villa to Rohan", ownerId: "self", due: "2026-08-20", state: "open" }],
  events: [
    { id: "wa:ev1", streamId: "wa:1", at: "2026-08-12T09:14:00+05:30", speakerId: "ent_p", text: "i've started bhangra classes on saturdays" },
    { id: "wa:ev2", streamId: "wa:1", at: "2026-08-12T09:15:00+05:30", speakerId: "self", text: "nice. i'll send you that villa link tonight" },
    { id: "wa:ev3", streamId: "wa:1", at: "2026-08-12T09:21:00+05:30", speakerId: "ent_p", text: "the saturday batch is full actually", replyToId: "wa:ev1" },
    { id: "wa:ev4", streamId: "wa:1", at: "2026-08-12T09:23:00+05:30", speakerId: "ent_p", text: "[voice note, transcription pending]" },
  ],
};

function packed(input: PackInput = BASE): string {
  const result = packPrompt(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.text;
}

describe("packPrompt — the §5.5 input format", () => {
  it("emits #R #C #E #T #D, the events and #COV in order", () => {
    // NB: §5.5 spells the #E state out and the #T state as a code; the packer
    // emits the code in both places, and the decoder accepts either.
    expect(packed()).toBe(
      [
        "#R a1=Pranjali Sachdeva | a2=Rahul Arora | a3=Villa Amara [plc]",
        "#C c1 Pranjali | dm | self,a1",
        "#E e1 villa shortlist for Goa | op | last Mon | a2,a3",
        "#T t1 Confirm villa to Rohan | me | 2026-08-20 | op",
        "#D 2026-08-12 Wed | Asia/Kolkata",
        "1 09:14 a1 i've started bhangra classes on saturdays",
        "2 +1 self nice. i'll send you that villa link tonight",
        "3 +6 a1 ^1 the saturday batch is full actually",
        "4 +2 a1 [voice note, transcription pending]",
        "#COV c1=4",
      ].join("\n"),
    );
  });

  it("hands back the alias table that resolves what the model writes", () => {
    const result = packPrompt(BASE);
    if (!result.ok) throw new Error("refused");
    expect(result.table.resolve("a1").resolved?.id).toBe("ent_p");
    expect(result.table.resolve("a4").unresolved).toBe("a4");
    expect(result.table.resolve("3").resolved?.id).toBe("wa:ev3");
    expect(result.table.resolve("e1").resolved?.id).toBe("epi_1");
    expect(result.stats).toMatchObject({ roster: 3, streams: 1, events: 4, dayBlocks: 1 });
  });

  it("resets deltas at every #D and falls back to absolute time when a delta is unusable", () => {
    const text = packed({
      ...BASE,
      episodes: [],
      loops: [],
      events: [
        { id: "e1", streamId: "wa:1", at: "2026-08-12T09:14:00+05:30", speakerId: "self", text: "one" },
        { id: "e2", streamId: "wa:1", at: "2026-08-12T09:16:00+05:30", speakerId: "self", text: "two" },
        // next day → new #D block, delta resets
        { id: "e3", streamId: "wa:1", at: "2026-08-13T08:00:00+05:30", speakerId: "self", text: "three" },
        // out of order → negative delta → absolute HH:MM
        { id: "e4", streamId: "wa:1", at: "2026-08-13T07:00:00+05:30", speakerId: "self", text: "four" },
        // > 999 minutes later on the same day → absolute HH:MM
        { id: "e5", streamId: "wa:1", at: "2026-08-13T23:59:00+05:30", speakerId: "self", text: "five" },
      ],
    });
    const lines = text.split("\n");
    expect(lines).toContain("#D 2026-08-12 Wed | Asia/Kolkata");
    expect(lines).toContain("#D 2026-08-13 Thu | Asia/Kolkata");
    expect(lines).toContain("1 09:14 self one");
    expect(lines).toContain("2 +2 self two");
    expect(lines).toContain("3 08:00 self three");
    expect(lines).toContain("4 07:00 self four");
    expect(lines).toContain("5 23:59 self five");
  });

  it("counts coverage per stream so a silent drop is detectable", () => {
    const text = packed({
      ...BASE,
      streams: [
        ...BASE.streams,
        { id: "wa:2", name: "Rahul", kind: "group", participantIds: ["self", "ent_r"] },
      ],
    });
    expect(text).toContain("#COV c1=4");
    expect(text).toContain("#COV c2=0");
    expect(text).toContain("#C c2 Rahul | grp | self,a2");
  });

  it("refuses when the roster is over cap so the call can fall back to JSON", () => {
    const entities = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, name: `Person ${i}` }));
    const result = packPrompt({ ...BASE, entities }, { maxRoster: 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ reason: "roster_over_cap", count: 5, cap: 4 });
  });

  it("skips events whose timestamp cannot be read rather than throwing", () => {
    const text = packed({
      ...BASE,
      episodes: [],
      loops: [],
      events: [{ id: "e1", streamId: "wa:1", at: "not a date", speakerId: "self", text: "x" }],
    });
    expect(text).toContain("#COV c1=1");
    expect(text).not.toContain("not a date");
  });

  it("never throws on hostile input", () => {
    expect(() => packPrompt({ streams: [] })).not.toThrow();
    expect(() => packPrompt({ streams: [{ id: "s", name: "", kind: "", participantIds: [] }] })).not.toThrow();
    expect(() => packPrompt({ tz: "Not/AZone", streams: [], events: [] })).not.toThrow();
  });
});

describe("separator neutralisation (§5.5)", () => {
  it("turns | into / in labels", () => {
    expect(neutraliseLabel("Goa | villa | shortlist")).toBe("Goa / villa / shortlist");
  });

  it("turns , into a space in participant names", () => {
    expect(neutraliseParticipant("Arora, Rahul")).toBe("Arora Rahul");
  });

  it("collapses every newline run to a single space", () => {
    expect(collapseNewlines("a\n\n\nb\r\nc")).toBe("a b c");
  });

  it("applies them where the field actually needs it", () => {
    const text = packed({
      tz: "UTC",
      entities: [{ id: "x", name: "Ravi | Kumar, Jr" }],
      streams: [{ id: "s", name: "Family | Group", kind: "group", participantIds: ["self", "x"] }],
      events: [{ id: "e1", streamId: "s", at: "2026-08-12T00:00:00Z", speakerId: "x", text: "line one\n\nline two" }],
    });
    expect(text).toContain("#R a1=Ravi / Kumar, Jr");
    expect(text).toContain("#C c1 Family / Group | grp | self,a1");
    expect(text).toContain("1 00:00 a1 line one line two");
  });

  it("names an off-roster participant inline at first mention", () => {
    const text = packed({
      tz: "UTC",
      entities: [],
      streams: [{ id: "s", name: "Chat", kind: "dm", participantIds: ["self", "ghost"] }],
    });
    expect(text).toContain("#C c1 Chat | dm | self,a1");
  });
});
