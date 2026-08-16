import { describe, expect, it } from "vitest";

import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { KIND_DEFAULTS, resolvePolicy, type SessionPolicy } from "./policies.js";
import {
  charsOf,
  contentHashOf,
  contextKeyOf,
  HASH_VERSION,
  orderEvents,
  segment,
  sessionIdOf,
  type SegEvent,
  type SegmentResult,
} from "./segment.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const T0 = Date.parse("2026-08-10T04:00:00.000Z"); // 09:30 IST — mid-morning
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const WA = WHATSAPP_MANIFEST.segmentation;

function dmPolicy(over: Partial<SessionPolicy> = {}): SessionPolicy {
  return resolvePolicy({
    kind: "conversation",
    segmentation: WA,
    lane: "dm",
    actor_model: "multi_actor",
    override: over,
  });
}

function groupPolicy(): SessionPolicy {
  return resolvePolicy({ kind: "conversation", segmentation: WA, lane: "group", actor_model: "multi_actor" });
}

function ev(n: number, offsetMs: number, actor = "a1", over: Partial<SegEvent> = {}): SegEvent {
  return { external_id: `e${n}`, ts: at(offsetMs), actor, kind: "message", text: "msg", ...over };
}

function run(events: SegEvent[], policy = dmPolicy(), tz = "Asia/Kolkata"): SegmentResult {
  return segment({ stream: { key: "c1", tz, source_id: "whatsapp" }, policy, events, run_mode: "steady" });
}

const reasons = (r: SegmentResult): (string | null)[] => r.sessions.map((s) => s.boundary_reason_end);

// ===========================================================================
// D — SESS-CONV
// ===========================================================================

describe("D · the silence gap is strict: gap > G cuts, exactly G does not", () => {
  const cases: [string, number, boolean][] = [
    ["5h59m", 5 * HOUR + 59 * MINUTE, false],
    ["6h00m exactly", 6 * HOUR, false],
    ["6h01m", 6 * HOUR + MINUTE, true],
    ["30m", 30 * MINUTE, false],
    ["2h", 2 * HOUR, false],
    ["5h30m", 5 * HOUR + 30 * MINUTE, false],
    ["6h30m", 6 * HOUR + 30 * MINUTE, true],
    ["7h", 7 * HOUR, true],
    ["12h", 12 * HOUR, true],
  ];

  for (const [label, gap, cuts] of cases) {
    it(`${label} on a 6h dm ${cuts ? "cuts" : "does not cut"}`, () => {
      const r = run([ev(1, 0), ev(2, gap)]);
      expect(r.sessions).toHaveLength(cuts ? 2 : 1);
      if (cuts) {
        expect(r.sessions[0]!.boundary_reason_end).toBe("gap");
        expect(r.sessions[0]!.boundary_params.end).toEqual({ gap_ms: gap, threshold_ms: 6 * HOUR });
      }
    });
  }

  it("uses the GROUP override on a group lane, so 4h10m cuts where 3h50m does not", () => {
    expect(run([ev(1, 0), ev(2, 3 * HOUR + 50 * MINUTE)], groupPolicy()).sessions).toHaveLength(1);
    const cut = run([ev(1, 0), ev(2, 4 * HOUR + 10 * MINUTE)], groupPolicy());
    expect(cut.sessions).toHaveLength(2);
    expect(cut.sessions[0]!.boundary_params.end).toEqual({
      gap_ms: 4 * HOUR + 10 * MINUTE,
      threshold_ms: 4 * HOUR,
    });
  });
});

describe("D · local midnight cuts in the stream's tz, not in UTC", () => {
  it("cuts 23:50 → 00:01 in Asia/Kolkata", () => {
    const r = run([
      { external_id: "e1", ts: "2026-08-10T18:20:00.000Z", actor: "a1", kind: "message", text: "x" },
      { external_id: "e2", ts: "2026-08-10T18:31:00.000Z", actor: "a1", kind: "message", text: "y" },
    ]);
    expect(reasons(r)).toEqual(["day_boundary", null]);
    expect(r.sessions[0]!.boundary_params.end).toEqual({
      tz: "Asia/Kolkata",
      from_day: "2026-08-10",
      to_day: "2026-08-11",
    });
  });

  it("does not cut the same two events on a UTC stream", () => {
    const r = run(
      [
        { external_id: "e1", ts: "2026-08-10T18:20:00.000Z", actor: "a1", kind: "message", text: "x" },
        { external_id: "e2", ts: "2026-08-10T18:31:00.000Z", actor: "a1", kind: "message", text: "y" },
      ],
      dmPolicy(),
      "UTC",
    );
    expect(r.sessions).toHaveLength(1);
  });
});

describe("D · size caps", () => {
  it("cuts at event 40, so the first session holds exactly the cap", () => {
    const events = Array.from({ length: 41 }, (_, i) => ev(i + 1, i * 5 * MINUTE, i % 2 ? "a1" : "self"));
    const r = run(events);
    expect(r.sessions.map((s) => s.event_count)).toEqual([40, 1]);
    expect(r.sessions[0]!.boundary_reason_end).toBe("size_cap");
    expect(r.sessions[0]!.boundary_params.end).toEqual({ events: 40, cap_events: 40 });
  });

  it("cuts at the same place for 55 and 80 messages — the cap is the cap", () => {
    for (const n of [55, 80]) {
      const events = Array.from({ length: n }, (_, i) => ev(i + 1, i * 5 * MINUTE, i % 2 ? "a1" : "self"));
      expect(run(events).sessions[0]!.event_count).toBe(40);
    }
  });

  it("cuts on the token cap before the event cap when the text is long", () => {
    // Four 2,000-token pastes: the first three land on exactly 6,000 tokens.
    const paste = "x".repeat(2_000 * 4);
    const events = [0, 1, 2, 3].map((i) => ev(i + 1, i * MINUTE, "a1", { text: paste }));
    const r = run(events);
    expect(r.sessions.map((s) => s.tokens)).toEqual([6_000, 2_000]);
    expect(r.sessions[0]!.boundary_reason_end).toBe("size_cap");
    expect(r.sessions[0]!.boundary_params.end).toMatchObject({ tokens: 6_000, cap_tokens: 6_000 });
  });

  it("counts enrichment text (a caption) against the cap", () => {
    const photo = ev(1, 0, "a1", { kind: "image", text: "", enrichment_text: "a caption" });
    expect(charsOf(photo)).toBe("a caption".length);
  });
});

describe("D · participant shift is a CONJUNCTION (gap ≥ shift_min_gap AND a flip)", () => {
  it("cuts when a 90m gap is followed by the other person opening", () => {
    const r = run([ev(1, 0, "self"), ev(2, 5 * MINUTE, "a1"), ev(3, 95 * MINUTE, "a1")]);
    expect(reasons(r)).toEqual(["participant_shift", null]);
    expect(r.sessions[0]!.boundary_params.end).toEqual({
      gap_ms: 90 * MINUTE,
      shift_min_gap_ms: HOUR,
      initiator: "self",
      actor: "a1",
    });
  });

  it("does NOT cut on a flip below the minimum gap — that is turn-taking", () => {
    for (const gap of [MINUTE, 20 * MINUTE, 59 * MINUTE]) {
      expect(run([ev(1, 0, "self"), ev(2, gap, "a1")]).sessions).toHaveLength(1);
    }
  });

  it("does NOT cut on a long gap with no flip below the silence gap", () => {
    const r = run([ev(1, 0, "self"), ev(2, 90 * MINUTE, "self")]);
    expect(r.sessions).toHaveLength(1);
  });

  it("is disabled on a single-actor lane, so only the gap cuts", () => {
    const notes = resolvePolicy({
      kind: "conversation",
      segmentation: WA,
      lane: "dm",
      actor_model: "single_actor",
    });
    expect(notes.participant_shift).toBe(false);
    expect(run([ev(1, 0, "self"), ev(2, 20 * MINUTE, "self")], notes).sessions).toHaveLength(1);
    expect(run([ev(1, 0, "self"), ev(2, 6 * HOUR + 5 * MINUTE, "self")], notes).sessions).toHaveLength(2);
    expect(run([ev(1, 0, "self"), ev(2, 10 * HOUR, "self")], notes).sessions).toHaveLength(2);
  });

  it("never fires on a one-sided business broadcast — nothing flips", () => {
    // Five bank notices over three days: cut by gap, never by participant shift.
    const events = [0, 1, 2, 3, 4].map((i) => ev(i + 1, i * 18 * HOUR, "hdfc"));
    const r = run(events);
    expect(r.sessions).toHaveLength(5);
    expect(reasons(r)).toEqual(["gap", "gap", "gap", "gap", null]);
  });
});

describe("D · reply-chain break", () => {
  for (const days of [2, 3, 4, 5]) {
    it(`a reply quoting a message ${days} days old opens a new session`, () => {
      const r = run([
        ev(1, -days * DAY, "a1", { external_id: "old" }),
        ev(2, 0, "self"),
        ev(3, MINUTE, "a1", { reply_to_external_id: "old" }),
      ]);
      const last = r.sessions[r.sessions.length - 1]!;
      expect(last.boundary_reason_start).toBe("reply_break");
      expect(last.boundary_params.start).toMatchObject({ target: "old", threshold_ms: 6 * HOUR });
      // The old session is untouched; the reply never reaches back into it.
      expect(r.sessions[0]!.event_ids).toEqual(["old"]);
    });
  }

  it("does not fire for a reply to something inside the same session", () => {
    const r = run([ev(1, 0, "self"), ev(2, 10 * MINUTE, "a1", { reply_to_external_id: "e1" })]);
    expect(r.sessions).toHaveLength(1);
  });

  it("does not fire when the quoted event is unknown — an unmeasurable rule must not cut", () => {
    const r = run([ev(1, 0, "self"), ev(2, MINUTE, "a1", { reply_to_external_id: "nowhere" })]);
    expect(r.sessions).toHaveLength(1);
  });

  it("reads a target the walk does not carry from known_event_ts", () => {
    const r = segment({
      stream: { key: "c1", tz: "Asia/Kolkata" },
      policy: dmPolicy(),
      events: [ev(1, 0, "self"), ev(2, MINUTE, "a1", { reply_to_external_id: "ancient" })],
      run_mode: "steady",
      known_event_ts: new Map([["ancient", at(-3 * DAY)]]),
    });
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.boundary_reason_start).toBe("reply_break");
  });
});

describe("D · media bursts are events", () => {
  for (const n of [4, 5, 6, 7]) {
    it(`${n} photos two minutes apart stay ONE session`, () => {
      const events = Array.from({ length: n }, (_, i) =>
        ev(i + 1, i * 2 * MINUTE, "a1", { kind: "image", text: "", enrichment_text: "a photo of the sea" }),
      );
      const r = run(events);
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]!.event_count).toBe(n);
      // Caption text is counted — the session is not "empty" just because the
      // messages carried no typed body.
      expect(r.sessions[0]!.chars).toBe(n * "a photo of the sea".length);
    });
  }
});

describe("D · the 24h ceiling", () => {
  it("seals a slow trickle at 24h even though no gap ever exceeds G", () => {
    // One message every 3h for 30h: every gap is 3h, well under the 6h window.
    // The day cut is off here so the ceiling is the only rule that can fire.
    const events = Array.from({ length: 11 }, (_, i) => ev(i + 1, i * 3 * HOUR, "a1"));
    const r = run(events, dmPolicy({ day_boundary: false }));
    expect(r.sessions[0]!.boundary_reason_end).toBe("ceiling");
    expect(r.sessions[0]!.boundary_params.end).toEqual({ span_ms: 27 * HOUR, ceiling_ms: 24 * HOUR });
  });
});

describe("D · one segmenter, ordered by ts and never by insertion order", () => {
  const events = [ev(1, 0, "self"), ev(2, 7 * HOUR, "a1"), ev(3, 7 * HOUR + MINUTE, "self")];

  it("sorts by (ts, external_id)", () => {
    const shuffled = [events[2]!, events[0]!, events[1]!];
    expect(orderEvents(shuffled).map((e) => e.external_id)).toEqual(["e1", "e2", "e3"]);
  });

  it("breaks a ts tie on external_id, so equal stamps are still stable", () => {
    const a = ev(1, 0, "self", { external_id: "zzz" });
    const b = ev(2, 0, "self", { external_id: "aaa" });
    expect(orderEvents([a, b]).map((e) => e.external_id)).toEqual(["aaa", "zzz"]);
    expect(orderEvents([b, a]).map((e) => e.external_id)).toEqual(["aaa", "zzz"]);
  });

  it("lands on the same boundaries whatever order the backfill hands them over in", () => {
    const forward = run(events);
    const backward = run([...events].reverse());
    const shuffled = run([events[1]!, events[2]!, events[0]!]);
    expect(JSON.stringify(backward.sessions)).toBe(JSON.stringify(forward.sessions));
    expect(JSON.stringify(shuffled.sessions)).toBe(JSON.stringify(forward.sessions));
  });

  it("is byte-identical on a re-run with identical params", () => {
    expect(JSON.stringify(run(events).sessions)).toBe(JSON.stringify(run(events).sessions));
  });
});

// ===========================================================================
// E — SESS-OTHER
// ===========================================================================

describe("E · DOCUMENT", () => {
  const doc = KIND_DEFAULTS.document;

  it("cuts a revision gap over 45m and not under it", () => {
    expect(run([ev(1, 0), ev(2, 20 * MINUTE)], doc).sessions).toHaveLength(1);
    expect(run([ev(1, 0), ev(2, 40 * MINUTE)], doc).sessions).toHaveLength(1);
    expect(run([ev(1, 0), ev(2, 50 * MINUTE)], doc).sessions).toHaveLength(2);
    expect(run([ev(1, 0), ev(2, 2 * HOUR)], doc).sessions).toHaveLength(2);
  });

  it("cuts on an author shift with NO minimum gap — a co-author is a new sitting", () => {
    const r = run([ev(1, 0, "self"), ev(2, 10 * MINUTE, "a1")], doc);
    expect(reasons(r)).toEqual(["author_shift", null]);
    expect(r.sessions[0]!.boundary_params.end).toMatchObject({ author: "a1", previous_author: "self" });
  });

  it("reads an explicit author over the actor", () => {
    const r = run([ev(1, 0, "svc", { author: "self" }), ev(2, MINUTE, "svc", { author: "a1" })], doc);
    expect(r.sessions).toHaveLength(2);
  });

  it("cuts at the 200-revision cap", () => {
    for (const n of [210, 250, 290]) {
      const events = Array.from({ length: n }, (_, i) => ev(i + 1, i * MINUTE, "self"));
      const r = run(events, doc);
      expect(r.sessions[0]!.event_count).toBe(200);
      expect(r.sessions[0]!.boundary_params.end).toEqual({ events: 200, cap_events: 200 });
    }
  });
});

describe("E · ACTIVITY", () => {
  const act = KIND_DEFAULTS.activity;
  const visit = (n: number, ms: number, url: string): SegEvent =>
    ev(n, ms, "self", { kind: "visit", text: "", url });

  it("cuts a burst gap over 30m and not under it", () => {
    expect(run([visit(1, 0, "https://airbnb.com/a"), visit(2, 25 * MINUTE, "https://airbnb.com/b")], act).sessions)
      .toHaveLength(1);
    expect(run([visit(1, 0, "https://airbnb.com/a"), visit(2, 35 * MINUTE, "https://airbnb.com/b")], act).sessions)
      .toHaveLength(2);
  });

  it("cuts on a registrable-domain change four minutes into a burst", () => {
    const events = [
      ...Array.from({ length: 12 }, (_, i) => visit(i + 1, i * MINUTE, `https://www.airbnb.com/rooms/${i}`)),
      visit(13, 16 * MINUTE, "https://www.zomato.com/x"),
    ];
    const r = run(events, act);
    expect(reasons(r)).toEqual(["context_shift", null]);
    expect(r.sessions[0]!.boundary_params.end).toEqual({
      context: "zomato.com",
      previous_context: "airbnb.com",
    });
    expect(r.sessions[0]!.event_count).toBe(12);
  });

  it("does not cut between two paths on the same registrable domain", () => {
    const r = run([visit(1, 0, "https://www.zomato.com/a"), visit(2, MINUTE, "https://order.zomato.com/b")], act);
    expect(r.sessions).toHaveLength(1);
  });

  it("seals a transaction as its OWN single-event session, mid-burst", () => {
    const events = [
      visit(1, 0, "https://zomato.com/a"),
      visit(2, MINUTE, "https://zomato.com/b"),
      ev(3, 2 * MINUTE, "self", { kind: "order", text: "Zomato order 8812", transaction: true }),
      visit(4, 3 * MINUTE, "https://zomato.com/c"),
      visit(5, 4 * MINUTE, "https://zomato.com/d"),
    ];
    const r = run(events, act);
    expect(r.sessions.map((s) => s.event_count)).toEqual([2, 1, 2]);
    const order = r.sessions[1]!;
    expect(order.event_ids).toEqual(["e3"]);
    expect(order.boundary_reason_start).toBe("record_bounded");
    expect(order.boundary_params.start).toEqual({ rule: "transaction", kind: "order" });
    expect(order.boundary_reason_end).toBe("record_bounded");
  });
});

describe("E · AMBIENT", () => {
  const amb = KIND_DEFAULTS.ambient;
  const frame = (n: number, ms: number, phash: string, over: Partial<SegEvent> = {}): SegEvent =>
    ev(n, ms, "screen", { kind: "frame", text: "", phash, context: "app:vscode", ...over });

  it("collapses a run of near-identical frames before any rule runs", () => {
    for (const n of [200, 300, 400]) {
      const events = Array.from({ length: n }, (_, i) => frame(i + 1, i * 2_000, "ffffffffffffffff"));
      const r = run(events, amb);
      expect(r.collapsed).toBe(n - 1);
      expect(r.considered).toBe(1);
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]!.collapsed_count).toBe(n - 1);
      // The collapsed run keeps its DURATION — one frame, but not one instant.
      expect(Date.parse(r.sessions[0]!.ended_at) - Date.parse(r.sessions[0]!.started_at)).toBe((n - 1) * 2_000);
    }
  });

  it("cuts on silence longer than 90s and not on 90s itself", () => {
    const stable = run([frame(1, 0, "0000000000000000"), frame(2, 90_000, "0000000000000000")], amb);
    expect(stable.sessions).toHaveLength(1);
    for (const silence of [91_000, 120_000, 200_000]) {
      const r = run([frame(1, 0, "0000000000000000"), frame(2, silence, "0000000000000000")], amb);
      expect(reasons(r)).toEqual(["context_shift", null]);
      expect(r.sessions[0]!.boundary_params.end).toEqual({ silence_ms: silence, threshold_ms: 90_000 });
    }
  });

  it("cuts a single collapsed app focus at the 15-minute wall-clock ceiling", () => {
    // 16 minutes of one app: every frame collapses, so no ACTIVE span accrues
    // and only the ceiling can end it.
    const events = Array.from({ length: 33 }, (_, i) => frame(i + 1, i * 30_000, "abababababababab"));
    const r = run(events, amb);
    expect(r.considered).toBe(1);
    const span = Date.parse(r.sessions[0]!.ended_at) - Date.parse(r.sessions[0]!.started_at);
    expect(span).toBe(16 * MINUTE);
    expect(span).toBeGreaterThan(amb.ceiling_ms);
  });

  it("cuts a CHANGING ambient stream at the 10-minute active cap", () => {
    // Distinct frames every minute: active span accrues, so the content cap
    // fires before the wall-clock ceiling.
    const hashes = Array.from({ length: 14 }, (_, i) => i.toString(16).repeat(16).slice(0, 16));
    const events = hashes.map((h, i) => frame(i + 1, i * MINUTE, h));
    const r = run(events, amb);
    expect(r.sessions[0]!.boundary_reason_end).toBe("size_cap");
    expect(r.sessions[0]!.boundary_params.end).toMatchObject({ cap_active_ms: 10 * MINUTE });
  });

  it("collapses a long low-salience run into ONE coarse session", () => {
    for (const minutes of [30, 40, 50]) {
      // No phash: the collapse is not what is being measured here, the
      // salience floor is.
      const events = Array.from({ length: minutes }, (_, i) =>
        ev(i + 1, i * MINUTE, "screen", { kind: "frame", text: "", context: "app:x", salience: 0.05 }),
      );
      const r = segment({
        stream: { key: "c1", tz: "Asia/Kolkata" },
        policy: amb,
        events,
        run_mode: "steady",
        coarse_salience_max: 0.1,
      });
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]!.coarse).toBe(true);
      expect(r.sessions[0]!.event_count).toBe(minutes);
    }
  });
});

describe("E · BOUNDED — the record is the session and caps do not apply", () => {
  const bounded = KIND_DEFAULTS.bounded;

  it("gives each record its own session with boundary record_bounded", () => {
    const records: SegEvent[] = [
      ev(1, 0, "self", { kind: "calendar", text: "Standup", ts_end: at(15 * MINUTE) }),
      ev(2, 6 * HOUR, "self", { kind: "calendar", text: "Dr Shreedhar", ts_end: at(6 * HOUR + 30 * MINUTE) }),
      ev(3, 10 * HOUR, "self", { kind: "calendar", text: "Flight", ts_end: at(11 * HOUR + 15 * MINUTE) }),
    ];
    const r = run(records, bounded);
    expect(r.sessions).toHaveLength(3);
    expect(r.sessions.map((s) => s.boundary_reason_start)).toEqual([
      "record_bounded",
      "record_bounded",
      "record_bounded",
    ]);
    // The record's own end is the session's end. Nothing is inferred.
    expect(r.sessions[0]!.ended_at).toBe(at(15 * MINUTE));
    expect(r.sessions[2]!.ended_at).toBe(at(11 * HOUR + 15 * MINUTE));
  });

  it("keeps a long transcript as ONE session however many utterances it holds", () => {
    for (const [minutes, utterances] of [
      [30, 80],
      [50, 120],
      [70, 160],
    ] as const) {
      // A meeting transcript is ONE record with many events. Both §10.4 caps —
      // 40 events and 6k tokens — are exceeded, and neither may fire.
      const step = (minutes * MINUTE) / utterances;
      const events = Array.from({ length: utterances }, (_, i) =>
        ev(i + 1, Math.round(i * step), i % 3 === 0 ? "self" : "a1", {
          kind: "utterance",
          text: "a line of talk in the meeting ".repeat(12),
          record_id: "meeting-1",
          ts_end: at(minutes * MINUTE),
        }),
      );
      const r = run(events, bounded);
      expect(r.sessions).toHaveLength(1);
      expect(bounded.caps_apply).toBe(false);
      expect(r.sessions[0]!.event_count).toBe(utterances);
      expect(r.sessions[0]!.event_count).toBeGreaterThan(KIND_DEFAULTS.conversation.size_cap_events);
      expect(r.sessions[0]!.chars).toBeGreaterThan(KIND_DEFAULTS.conversation.size_cap_chars);
      expect(r.sessions[0]!.ended_at).toBe(at(minutes * MINUTE));
    }
  });

  it("cuts between two records even when they touch", () => {
    const r = run(
      [
        ev(1, 0, "self", { kind: "utterance", text: "a", record_id: "m1" }),
        ev(2, MINUTE, "self", { kind: "utterance", text: "b", record_id: "m1" }),
        ev(3, 2 * MINUTE, "self", { kind: "utterance", text: "c", record_id: "m2" }),
      ],
      bounded,
    );
    expect(r.sessions.map((s) => s.event_count)).toEqual([2, 1]);
    expect(r.sessions[1]!.boundary_params.start).toEqual({ rule: "record_bounded", record: "m2" });
  });
});

// ===========================================================================
// hashing, ids, helpers
// ===========================================================================

describe("the content hash", () => {
  const members = [
    { external_id: "b", text: "second" },
    { external_id: "a", text: "first" },
  ];

  it("is a property of the SET, not of the order the walk saw", () => {
    expect(contentHashOf(members)).toBe(contentHashOf([...members].reverse()));
  });

  it("moves when enrichment text arrives — that is the reprocess signal", () => {
    const before = contentHashOf([{ external_id: "a", text: "" }]);
    const after = contentHashOf([{ external_id: "a", text: "", enrichment_text: "a photo of a bill" }]);
    expect(after).not.toBe(before);
  });

  it("moves when a member's text changes and when membership changes", () => {
    const base = contentHashOf(members);
    expect(contentHashOf([{ external_id: "b", text: "second!" }, members[1]!])).not.toBe(base);
    expect(contentHashOf([...members, { external_id: "c", text: "third" }])).not.toBe(base);
  });

  it("is a 64-char sha256 carrying a version", () => {
    expect(contentHashOf(members)).toMatch(/^[0-9a-f]{64}$/);
    expect(HASH_VERSION).toBe("stw2-sess-1");
  });
});

describe("session ids are derived, never minted", () => {
  it("is the same id for the same stream, start and first event", () => {
    expect(sessionIdOf("c1", at(0), "e1")).toBe(sessionIdOf("c1", at(0), "e1"));
    expect(sessionIdOf("c1", at(0), "e1")).not.toBe(sessionIdOf("c2", at(0), "e1"));
    expect(sessionIdOf("c1", at(0), "e1")).toMatch(/^sess:[0-9a-f]{24}$/);
  });
});

describe("helpers", () => {
  it("prefers an explicit context key over a derived domain", () => {
    expect(contextKeyOf(ev(1, 0, "self", { context: "app:vscode", url: "https://x.com" }))).toBe("app:vscode");
    expect(contextKeyOf(ev(1, 0, "self", { url: "https://www.x.com/y" }))).toBe("x.com");
    expect(contextKeyOf(ev(1, 0, "self"))).toBeNull();
  });

  it("keeps reactions out of the walk entirely", () => {
    const r = run([ev(1, 0, "self"), ev(2, 7 * HOUR, "a1", { kind: "reaction", text: "👍" })]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.event_ids).toEqual(["e1"]);
  });

  it("returns nothing at all for an empty stream", () => {
    const r = run([]);
    expect(r.sessions).toEqual([]);
    expect(r.open).toBeNull();
  });
});
