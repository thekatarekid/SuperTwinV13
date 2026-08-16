// ===========================================================================
// P-EP2 — episode segmentation (arch §12.3, template §5.6). Build item 2.2.
//
// Four defects this file exists to keep out:
//   * an attach that crosses a stream boundary (evals J-039..J-043);
//   * a low-confidence attach becoming a merge nobody can undo (§12.3);
//   * segments that do not partition their session (J-015..J-026);
//   * a replay that re-judges a session that already has a verdict (J-048+).
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import type { PackEvent } from "../wire/pack.js";
import {
  buildEp2Prompt,
  buildEp2System,
  checkPartition,
  chunkSessions,
  hasEpisodeVerdict,
  oneToOneRate,
  parseEp2Response,
  persistEp2Verdicts,
  readEpisodeVerdicts,
  replayVerdicts,
  sessionsNeedingCall,
  P_EP2,
  P_EP2_SYSTEM,
  type Ep2Input,
  type Ep2Prompt,
  type Ep2Segment,
} from "./p-ep2.js";

// ---- the §12.3 fixture -----------------------------------------------------

const IST = "Asia/Kolkata";

function ev(id: string, streamId: string, at: string, speakerId: string, text: string): PackEvent {
  return { id, streamId, at, speakerId, text };
}

/** The session the doc itself walks through: villa deposit, then mom's reports. */
function docInput(): Ep2Input {
  return {
    tz: IST,
    entities: [{ id: "ent-a", name: "Rohan" }],
    streams: [{ id: "str-1", name: "Rohan", kind: "dm", participantIds: ["self", "ent-a"] }],
    episodes: [
      {
        id: "ep-villa",
        label: "villa shortlist for Goa",
        state: "open",
        lastActivity: "last Mon",
        entityIds: ["ent-a"],
        streamId: "str-1",
      },
    ],
    sessions: [
      {
        id: "sess-1",
        streamId: "str-1",
        events: [
          ev("e1", "str-1", "2026-08-13T15:10:00Z", "ent-a", "Amara confirmed 4 rooms, deposit by 20th"),
          ev("e2", "str-1", "2026-08-13T15:11:00Z", "self", "ok"),
          ev("e3", "str-1", "2026-08-13T15:14:00Z", "ent-a", "also — did your mom's reports come?"),
          ev("e4", "str-1", "2026-08-13T15:16:00Z", "self", "yes, all clear"),
        ],
      },
    ],
  };
}

function built(input: Ep2Input = docInput()): Ep2Prompt {
  const prompt = buildEp2Prompt(input);
  expect(prompt).not.toBeNull();
  return prompt as Ep2Prompt;
}

/** §12.3's EXPECTED block, verbatim. */
const DOC_ANSWER = [
  "G|s1|1,2|att|e1|0.93|villa shortlist for Goa",
  "G|s1|3,4|new|-|0.85|mom's medical reports",
].join("\n");

// ---- the prompt ------------------------------------------------------------

describe("the call is built exactly as §12.3 specifies", () => {
  it("carries §12.3's SYSTEM text verbatim, after the legend", () => {
    const system = buildEp2System();
    expect(system).toContain(P_EP2_SYSTEM);
    // The legend renders the G template from the tag table, never by hand.
    expect(system).toContain("G | <session> | <events> | <decision>");
    expect(system).toContain("att=attach");
  });

  it("transcribes the §12.3 settings, thinking off and six sessions per call", () => {
    expect(P_EP2.model).toBe("sonnet-5");
    expect(P_EP2.thinking).toBe("off");
    expect(P_EP2.turns).toBe(1);
    expect(P_EP2.timeoutSeconds).toBe(120);
    expect(P_EP2.maxSessionsPerCall).toBe(6);
    expect(P_EP2.attachMinConfidence).toBe(0.6);
  });

  it("marks every session block and names the stream it belongs to", () => {
    const prompt = built();
    expect(prompt.user).toContain("#S s1 | c1 | 4 events");
    expect(prompt.user).toContain("#E e1 villa shortlist for Goa");
    expect(prompt.user).toContain("#COV c1=4");
    expect(prompt.context.sessions.get("s1")).toBe("sess-1");
    expect(prompt.context.sessionEvents.get("sess-1")).toEqual(["e1", "e2", "e3", "e4"]);
    expect(prompt.context.candidates.get("sess-1")).toEqual(["ep-villa"]);
  });

  it("offers a session only the open episodes of ITS OWN stream", () => {
    const input = docInput();
    input.streams = [
      ...input.streams,
      { id: "str-2", name: "Gargi", kind: "dm", participantIds: ["self"] },
    ];
    input.episodes = [
      ...(input.episodes ?? []),
      { id: "ep-other", label: "Goa trip with Gargi", state: "open", streamId: "str-2" },
    ];
    input.sessions = [
      ...input.sessions,
      { id: "sess-2", streamId: "str-2", events: [ev("e9", "str-2", "2026-08-13T16:00:00Z", "self", "hi")] },
    ];
    const prompt = built(input);
    // Two blocks, each with only its own stream's open episodes.
    const [block1, block2] = prompt.user.split("#S ").filter((s) => s !== "");
    expect(block1).toContain("villa shortlist for Goa");
    expect(block1).not.toContain("Goa trip with Gargi");
    expect(block2).toContain("Goa trip with Gargi");
    expect(block2).not.toContain("villa shortlist for Goa");
    expect(prompt.context.candidates.get("sess-2")).toEqual(["ep-other"]);
  });

  it("never offers an episode that cannot prove which stream it belongs to", () => {
    const input = docInput();
    input.episodes = [{ id: "ep-loose", label: "unattributed matter", state: "open" }];
    const prompt = built(input);
    expect(prompt.user).not.toContain("unattributed matter");
    expect(prompt.context.candidates.get("sess-1")).toEqual([]);
  });

  it("carries the roster even when the first session's stream is missing", () => {
    const input = docInput();
    // A session the caller passed whose stream did not come with it. It is
    // skipped — but `a1` still appears in the surviving block's `#C` line, so
    // the prompt without `#R` would be asking the model to read an alias that
    // was never defined.
    input.sessions = [{ id: "ghost", streamId: "str-gone", events: [] }, ...input.sessions];
    const prompt = built(input);
    expect(prompt.user).toContain("#R a1=Rohan");
    expect(prompt.user).toContain("#S s1 | c1 | 4 events");
    expect(prompt.stats.sessions).toBe(1);
    expect(prompt.context.sessions.get("s1")).toBe("sess-1");
  });

  it("mints the roster once, on the first block only", () => {
    const input = docInput();
    input.sessions = [
      ...input.sessions,
      { id: "sess-2", streamId: "str-1", events: [ev("e9", "str-1", "2026-08-13T16:00:00Z", "self", "hi")] },
    ];
    const prompt = built(input);
    expect(prompt.user.split("#R ").length - 1).toBe(1);
  });

  it("chunks at six sessions per call", () => {
    const sessions = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      streamId: "str-1",
      events: [],
    }));
    expect(chunkSessions(sessions).map((c) => c.length)).toEqual([6, 6, 1]);
  });
});

// ---- the answer ------------------------------------------------------------

describe("the answer is read only against the table that built the prompt", () => {
  it("parses §12.3's own expected output into two segments", () => {
    const prompt = built();
    const answer = parseEp2Response(DOC_ANSWER, prompt.context);
    expect(answer.violations).toEqual([]);
    expect(answer.segments).toHaveLength(2);

    const [first, second] = answer.segments;
    expect(first.sessionId).toBe("sess-1");
    expect(first.eventIds).toEqual(["e1", "e2"]);
    expect(first.decision).toBe("attach");
    expect(first.episodeId).toBe("ep-villa");
    expect(first.demoted).toBeNull();
    expect(first.confidence).toBe(0.93);
    expect(first.label).toBe("villa shortlist for Goa");

    expect(second.eventIds).toEqual(["e3", "e4"]);
    expect(second.decision).toBe("new");
    expect(second.episodeId).toBeNull();
    expect(second.label).toBe("mom's medical reports");
  });

  it("keeps the model's line byte-for-byte on every segment", () => {
    const prompt = built();
    const answer = parseEp2Response(DOC_ANSWER, prompt.context);
    expect(answer.segments.map((s) => s.raw)).toEqual(DOC_ANSWER.split("\n"));
  });

  it("prefers new when an attach is under 0.6 confidence, keeping what was said", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1-4|att|e1|0.55|villa shortlist for Goa", prompt.context);
    const [seg] = answer.segments;
    expect(seg.decision).toBe("new");
    expect(seg.episodeId).toBeNull();
    expect(seg.demoted).toBe("low_confidence");
    // Nothing the model said is lost — only what code ACTS on changed.
    expect(seg.statedDecision).toBe("attach");
    expect(seg.statedEpisodeId).toBe("ep-villa");
    expect(seg.statedEpisodeAlias).toBe("e1");
    expect(seg.confidence).toBe(0.55);
  });

  it("attaches at exactly 0.6 — the rule is strictly below", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1-4|att|e1|0.6|villa shortlist", prompt.context);
    expect(answer.segments[0].decision).toBe("attach");
    expect(answer.segments[0].demoted).toBeNull();
  });

  it("refuses an attach that would cross a stream boundary", () => {
    const input = docInput();
    input.streams = [
      ...input.streams,
      { id: "str-2", name: "Gargi", kind: "dm", participantIds: ["self"] },
    ];
    input.sessions = [
      ...input.sessions,
      { id: "sess-2", streamId: "str-2", events: [ev("e9", "str-2", "2026-08-13T16:00:00Z", "self", "goa again")] },
    ];
    const prompt = built(input);
    // s2 lives in str-2; e1 is str-1's episode. Same topic, different stream.
    const answer = parseEp2Response("G|s2|5|att|e1|0.95|Goa trip", prompt.context);
    const [seg] = answer.segments;
    expect(seg.sessionId).toBe("sess-2");
    expect(seg.decision).toBe("new");
    expect(seg.episodeId).toBeNull();
    expect(seg.demoted).toBe("cross_stream");
    expect(seg.statedEpisodeId).toBe("ep-villa");
  });

  it("never resolves an out-of-range e-alias to the nearest episode", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1-4|att|e7|0.99|villa shortlist", prompt.context);
    const [seg] = answer.segments;
    expect(seg.decision).toBe("new");
    expect(seg.statedEpisodeId).toBeNull();
    expect(seg.demoted).toBe("unknown_episode");
  });

  it("treats an attach with no alias as new", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1-4|att|-|0.99|villa shortlist", prompt.context);
    expect(answer.segments[0].decision).toBe("new");
    expect(answer.segments[0].demoted).toBe("no_episode");
  });

  it("reports a segment whose session is not in this call rather than reassigning it", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s9|1,2|new|-|0.8|something else", prompt.context);
    expect(answer.segments).toEqual([]);
    expect(answer.orphans).toHaveLength(1);
    expect(answer.orphans[0].sessionToken).toBe("s9");
    expect(answer.orphans[0].sessionId).toBeNull();
  });

  it("reports an event token the table cannot place, and keeps the rest", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1,2,z|new|-|0.8|mixed", prompt.context);
    expect(answer.segments[0].eventIds).toEqual(["e1", "e2"]);
    expect(answer.segments[0].unresolvedEvents).toEqual(["z"]);
  });

  it("counts a tag this call may not emit instead of discarding it", () => {
    const prompt = built();
    const answer = parseEp2Response(
      ["G|s1|1-4|new|-|0.8|villa", "Q|s1|which mom?"].join("\n"),
      prompt.context,
    );
    expect(answer.segments).toHaveLength(1);
    expect(answer.otherRecords).toHaveLength(1);
    expect(answer.otherRecords[0].tag).toBe("Q");
  });

  it("turns a damaged line into a violation quoting the model, and never throws", () => {
    const prompt = built();
    const answer = parseEp2Response(
      ["G|s1|1-4|maybe|e1|0.8|villa", "G|s1|1-4|new|-|0.8|fine"].join("\n"),
      prompt.context,
    );
    expect(answer.segments).toHaveLength(1);
    expect(answer.violations).toHaveLength(1);
    expect(answer.violations[0].rule).toBe("bad_enum");
    expect(answer.violations[0].raw).toBe("G|s1|1-4|maybe|e1|0.8|villa");
    expect(() => parseEp2Response(null, prompt.context)).not.toThrow();
    expect(() => parseEp2Response("|||||", prompt.context)).not.toThrow();
  });
});

// ---- the partition invariant -----------------------------------------------

describe("segments must partition the session", () => {
  it("passes a clean split and reports it covered", () => {
    const prompt = built();
    const answer = parseEp2Response(DOC_ANSWER, prompt.context);
    const [report] = checkPartition(prompt.context, answer.segments);
    expect(report.ok).toBe(true);
    expect(report.covered).toEqual(["e1", "e2", "e3", "e4"]);
    expect(report.missing).toEqual([]);
    expect(report.duplicated).toEqual([]);
  });

  it("reports a hole rather than inventing a segment for it", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1,2|new|-|0.8|villa", prompt.context);
    const [report] = checkPartition(prompt.context, answer.segments);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["e3", "e4"]);
    // The segment itself is untouched.
    expect(answer.segments[0].eventIds).toEqual(["e1", "e2"]);
  });

  it("reports an event claimed by two segments", () => {
    const prompt = built();
    const answer = parseEp2Response(
      ["G|s1|1,2|new|-|0.8|villa", "G|s1|2-4|new|-|0.8|reports"].join("\n"),
      prompt.context,
    );
    const [report] = checkPartition(prompt.context, answer.segments);
    expect(report.duplicated).toEqual(["e2"]);
    expect(report.ok).toBe(false);
  });

  it("reports an event that belongs to another session as foreign", () => {
    const input = docInput();
    input.sessions = [
      ...input.sessions,
      { id: "sess-2", streamId: "str-1", events: [ev("e9", "str-1", "2026-08-14T05:00:00Z", "self", "later")] },
    ];
    const prompt = built(input);
    // Event 5 is sess-2's; s1 must not claim it.
    const answer = parseEp2Response("G|s1|1-5|new|-|0.8|villa", prompt.context);
    const reports = checkPartition(prompt.context, answer.segments);
    const first = reports.find((r) => r.sessionId === "sess-1");
    expect(first?.foreign).toEqual(["e9"]);
    expect(first?.ok).toBe(false);
  });

  it("measures the 1:1 default rate over the sessions in the call", () => {
    const prompt = built();
    const oneToOne = parseEp2Response("G|s1|1-4|new|-|0.8|villa", prompt.context);
    expect(oneToOneRate(checkPartition(prompt.context, oneToOne.segments), oneToOne.segments)).toBe(1);
    const split = parseEp2Response(DOC_ANSWER, prompt.context);
    expect(oneToOneRate(checkPartition(prompt.context, split.segments), split.segments)).toBe(0);
  });
});

// ---- verdicts --------------------------------------------------------------

describe("verdicts are persisted once and replayed forever", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-p-ep2-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO sessions (id, status) VALUES ('sess-1', 'sealed')`).run();
    db.prepare(`INSERT INTO sessions (id, status) VALUES ('sess-2', 'sealed')`).run();
    db.prepare(`INSERT INTO episodes (id, topic_label) VALUES ('ep-villa', 'villa shortlist for Goa')`).run();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function docSegments(): Ep2Segment[] {
    const prompt = built();
    return parseEp2Response(DOC_ANSWER, prompt.context).segments;
  }

  it("writes one row per SESSION, with every segment recoverable", () => {
    const segments = docSegments();
    const result = persistEp2Verdicts({
      sessionId: "sess-1",
      segments,
      runId: "run-1",
      candidates: ["ep-villa"],
    });
    expect(result.reused).toBe(false);
    expect(result.ids).toHaveLength(1);

    const rows = readEpisodeVerdicts("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].segments.map((s) => s.decision)).toEqual(["attach", "new"]);
    expect(rows[0].segments[0].episodeId).toBe("ep-villa");
    expect(rows[0].segments[1].episodeId).toBeNull();
    expect(rows[0].episodeId).toBe("ep-villa");
    expect(rows[0].candidates).toEqual(["ep-villa"]);
    expect(rows[0].model).toBe("sonnet-5");
    expect(rows[0].runId).toBe("run-1");
  });

  it("writes the shape the ENGINE reads back — `{ segments: [...] }`, not a bare segment", () => {
    // The regression this guards: one row per SEGMENT with `output_json` set to
    // a bare `Ep2Segment` parses fine here and is invisible to
    // `episodes/engine.ts`'s `storedSegments()`, which needs a `segments`
    // ARRAY. The hash gate would then miss and the session would be silently
    // re-judged — breaking the one rule this call exists to keep.
    persistEp2Verdicts({ sessionId: "sess-1", segments: docSegments(), candidates: ["ep-villa"] });
    const raw = getDb().prepare(`SELECT output_json FROM episode_verdicts`).all() as {
      output_json: string;
    }[];
    expect(raw).toHaveLength(1);
    const parsed = JSON.parse(raw[0].output_json) as { segments?: unknown };
    expect(Array.isArray(parsed.segments)).toBe(true);
    for (const seg of parsed.segments as { eventIds?: unknown }[]) {
      expect(Array.isArray(seg.eventIds) && (seg.eventIds as unknown[]).length > 0).toBe(true);
    }
  });

  it("replays byte-identical segments with no call at all", () => {
    const segments = docSegments();
    persistEp2Verdicts({ sessionId: "sess-1", segments, candidates: ["ep-villa"] });
    expect(replayVerdicts("sess-1")).toEqual(segments);
  });

  it("keeps the demoted attach's stated decision across the round trip", () => {
    const prompt = built();
    const answer = parseEp2Response("G|s1|1-4|att|e1|0.4|villa shortlist", prompt.context);
    persistEp2Verdicts({ sessionId: "sess-1", segments: answer.segments });
    const [replayed] = replayVerdicts("sess-1");
    expect(replayed.decision).toBe("new");
    expect(replayed.demoted).toBe("low_confidence");
    expect(replayed.statedDecision).toBe("attach");
    expect(replayed.statedEpisodeId).toBe("ep-villa");
    expect(replayed.raw).toBe("G|s1|1-4|att|e1|0.4|villa shortlist");
  });

  it("never re-judges a session that already has a verdict", () => {
    const segments = docSegments();
    const first = persistEp2Verdicts({ sessionId: "sess-1", segments });
    const second = persistEp2Verdicts({ sessionId: "sess-1", segments });
    expect(second.reused).toBe(true);
    expect(second.ids).toEqual(first.ids);
    expect(readEpisodeVerdicts("sess-1")).toHaveLength(1);
    expect(replayVerdicts("sess-1")).toHaveLength(2);
  });

  it("reports which sessions still need a call", () => {
    expect(hasEpisodeVerdict("sess-1")).toBe(false);
    persistEp2Verdicts({ sessionId: "sess-1", segments: docSegments() });
    expect(hasEpisodeVerdict("sess-1")).toBe(true);
    expect(sessionsNeedingCall(["sess-1", "sess-2"])).toEqual(["sess-2"]);
  });
});
