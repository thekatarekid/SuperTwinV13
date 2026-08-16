import { describe, expect, it } from "vitest";

import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { KIND_DEFAULTS, resolvePolicy, type SessionPolicy } from "./policies.js";
import {
  ceilingDeadline,
  debounceDeadline,
  hashGate,
  recomputeTimers,
  sealDue,
  sealSession,
  sealStream,
  textIndex,
  type HashableEvent,
} from "./seal.js";
import { segment, type SegEvent, type SegSession } from "./segment.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const T0 = Date.parse("2026-08-10T04:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const POLICY: SessionPolicy = resolvePolicy({
  kind: "conversation",
  segmentation: WHATSAPP_MANIFEST.segmentation,
  lane: "dm",
  actor_model: "multi_actor",
});

function ev(n: number, offsetMs: number, actor = "a1", over: Partial<SegEvent> = {}): SegEvent {
  return { external_id: `e${n}`, ts: at(offsetMs), actor, kind: "message", text: `msg ${n}`, ...over };
}

function walk(events: SegEvent[], policy = POLICY): SegSession[] {
  return segment({ stream: { key: "c1", tz: "UTC" }, policy, events, run_mode: "steady" }).sessions;
}

function texts(events: SegEvent[]): Map<string, HashableEvent> {
  return textIndex(events.map((e) => ({ external_id: e.external_id, text: e.text, enrichment_text: e.enrichment_text })));
}

describe("bootstrap seals immediately — the next row is already known", () => {
  const events = [ev(1, 0, "self"), ev(2, 7 * HOUR, "a1"), ev(3, 7 * HOUR + MINUTE, "self")];

  it("seals every session but the newest, with seal_mode immediate", () => {
    const r = sealStream(
      walk(events),
      // Still inside the newest session's debounce, so only the older one is
      // eligible — and it seals AT ONCE, not on a clock.
      { policy: POLICY, run_mode: "bootstrap", now: T0 + 7 * HOUR + 3 * MINUTE },
      texts(events),
    );
    expect(r.sessions.map((s) => s.status)).toEqual(["sealed", "open"]);
    expect(r.sessions[0]!.seal_mode).toBe("immediate");
    expect(r.sessions[0]!.boundary_reason_end).toBe("gap");
    expect(r.sessions[0]!.boundary_params.end).toEqual({ gap_ms: 7 * HOUR, threshold_ms: 6 * HOUR });
  });

  it("hands the newest session to the steady rules still open", () => {
    const r = sealStream(
      walk(events),
      { policy: POLICY, run_mode: "bootstrap", now: T0 + 7 * HOUR + 2 * MINUTE },
      texts(events),
    );
    expect(r.handed_to_steady).toBe(true);
    expect(r.open?.status).toBe("open");
    expect(r.open?.seal_mode).toBeNull();
    expect(r.open?.content_hash).toBeNull();
  });

  it("still seals that newest session when the import finished long after it", () => {
    const r = sealStream(
      walk(events),
      { policy: POLICY, run_mode: "bootstrap", now: T0 + 9 * HOUR },
      texts(events),
    );
    expect(r.handed_to_steady).toBe(true);
    expect(r.open).toBeNull();
    // Sealed by the STEADY rule it was handed to, not by "immediate".
    expect(r.sessions[1]!.seal_mode).toBe("debounce");
    expect(r.sessions[1]!.boundary_reason_end).toBe("debounce");
  });
});

describe("steady seals on the debounce", () => {
  const events = [ev(1, 0, "self")];
  const open = walk(events)[0]!;

  const idleCases: [number, boolean][] = [
    [20 * MINUTE, false],
    [44 * MINUTE, false],
    [45 * MINUTE, true],
    [46 * MINUTE, true],
    [90 * MINUTE, true],
  ];

  for (const [idle, seals] of idleCases) {
    it(`${idle / MINUTE}m of silence ${seals ? "seals" : "does not seal"} at debounce 45m`, () => {
      const decision = sealDue(open, { policy: POLICY, run_mode: "steady", now: T0 + idle });
      expect(decision.seal).toBe(seals);
      expect(decision.measured.debounce_ms).toBe(45 * MINUTE);
      if (seals) {
        expect(decision.mode).toBe("debounce");
        expect(decision.reason).toBe("debounce");
      }
    });
  }

  it("records the debounce reason and its measured idle on the sealed session", () => {
    const r = sealStream(
      walk(events),
      { policy: POLICY, run_mode: "steady", now: T0 + 46 * MINUTE },
      texts(events),
    );
    expect(r.sessions[0]!.seal_mode).toBe("debounce");
    expect(r.sessions[0]!.boundary_params.end).toEqual({ idle_ms: 46 * MINUTE, debounce_ms: 45 * MINUTE });
  });

  it("reports the BOUNDARY, not the clock, for a session a rule already cut", () => {
    const cut = [ev(1, 0, "self"), ev(2, 7 * HOUR, "a1")];
    const r = sealStream(
      walk(cut),
      // `now` is a year later: every ceiling and debounce is long past, and the
      // seal must still name the gap that actually ended the session.
      { policy: POLICY, run_mode: "steady", now: T0 + 365 * 24 * HOUR },
      texts(cut),
    );
    expect(r.sessions[0]!.boundary_reason_end).toBe("gap");
    expect(r.sessions[0]!.seal_mode).toBe("debounce");
  });
});

describe("the ceiling", () => {
  it("seals a live session at 24h even with nothing new arriving", () => {
    const open = walk([ev(1, 0, "self")])[0]!;
    const decision = sealDue(open, { policy: POLICY, run_mode: "steady", now: T0 + 25 * HOUR });
    expect(decision.seal).toBe(true);
    expect(decision.mode).toBe("ceiling");
    expect(decision.reason).toBe("ceiling");
    expect(decision.measured).toEqual({ span_ms: 25 * HOUR, ceiling_ms: 24 * HOUR });
  });

  it("carries seal_mode ceiling when the WALK cut on the ceiling too", () => {
    const trickle = Array.from({ length: 11 }, (_, i) => ev(i + 1, i * 3 * HOUR, "a1"));
    const sessions = walk(trickle, resolvePolicy({ kind: "conversation", override: { day_boundary: false } }));
    expect(sessions[0]!.boundary_reason_end).toBe("ceiling");
    const r = sealStream(sessions, { policy: POLICY, run_mode: "steady", now: T0 + 40 * HOUR }, texts(trickle));
    expect(r.sessions[0]!.seal_mode).toBe("ceiling");
  });

  it("seals a 16-minute ambient focus at the 15-minute ceiling", () => {
    const amb = KIND_DEFAULTS.ambient;
    const frames = Array.from({ length: 33 }, (_, i) => ({
      external_id: `f${i + 1}`,
      ts: at(i * 30_000),
      actor: "screen",
      kind: "frame",
      text: "",
      phash: "abababababababab",
    }));
    const sessions = segment({
      stream: { key: "s1", tz: "UTC" },
      policy: amb,
      events: frames,
      run_mode: "steady",
    }).sessions;
    const decision = sealDue(sessions[0]!, { policy: amb, run_mode: "steady", now: T0 + 16 * MINUTE });
    expect(decision.mode).toBe("ceiling");
    expect(decision.measured.ceiling_ms).toBe(15 * MINUTE);
  });

  it("computes deadlines from the data, not from a timer object", () => {
    const open = walk([ev(1, 0, "self"), ev(2, 10 * MINUTE, "a1")])[0]!;
    expect(debounceDeadline(open, POLICY)).toBe(T0 + 10 * MINUTE + 45 * MINUTE);
    expect(ceilingDeadline(open, POLICY)).toBe(T0 + 24 * HOUR);
    expect(ceilingDeadline(open, KIND_DEFAULTS.bounded)).toBe(Infinity);
  });
});

describe("what a seal freezes", () => {
  const events = [ev(1, 0, "self"), ev(2, MINUTE, "a1")];
  const open = walk(events)[0]!;
  const sealed = sealSession(open, { mode: "debounce", reason: "debounce", at: T0 + HOUR, texts: texts(events) });

  it("computes a content hash over the members, including enrichment text", () => {
    expect(sealed.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const withCaption = sealSession(open, {
      mode: "debounce",
      reason: "debounce",
      at: T0 + HOUR,
      texts: texts([events[0]!, { ...events[1]!, enrichment_text: "a photo of a bill" }]),
    });
    expect(withCaption.content_hash).not.toBe(sealed.content_hash);
  });

  it("records the mode, the time and the reason", () => {
    expect(sealed.status).toBe("sealed");
    expect(sealed.seal_mode).toBe("debounce");
    expect(sealed.sealed_at).toBe(at(HOUR));
    expect(sealed.boundary_reason_end).toBe("debounce");
  });

  it("never mutates the session it sealed — immutability is not a convention", () => {
    expect(open.status).toBe("open");
    expect(open.content_hash).toBeNull();
    sealed.event_ids.push("intruder");
    expect(open.event_ids).toEqual(["e1", "e2"]);
  });

  it("hashes a member with no text rather than dropping it", () => {
    const partial = sealSession(open, {
      mode: "immediate",
      reason: "gap",
      at: T0,
      texts: textIndex([{ external_id: "e1", text: "msg 1" }]),
    });
    expect(partial.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(partial.event_ids).toEqual(["e1", "e2"]);
  });
});

describe("restart safety (§10.4 note 7)", () => {
  function openSessions(n: number): { sessions: SegSession[]; events: SegEvent[] } {
    const sessions: SegSession[] = [];
    const events: SegEvent[] = [];
    for (let i = 0; i < n; i++) {
      const e = ev(i + 1, i * 12 * HOUR, "a1");
      events.push(e);
      sessions.push(
        segment({ stream: { key: `c${i}`, tz: "UTC" }, policy: POLICY, events: [e], run_mode: "steady" })
          .sessions[0]!,
      );
    }
    return { sessions, events };
  }

  for (const n of [1, 2, 3, 4, 5]) {
    it(`recomputes ${n} open session timer(s) from the last event ts`, () => {
      const { sessions, events } = openSessions(n);
      const boot = recomputeTimers(
        sessions,
        { policy: POLICY, run_mode: "steady", now: T0 + (n - 1) * 12 * HOUR + MINUTE },
        texts(events),
      );
      // The deadline is derived, not restarted: every session's is exactly
      // 45 minutes after its own last event.
      for (const session of sessions) {
        expect(boot.deadlines[session.id]).toBe(Date.parse(session.ended_at) + 45 * MINUTE);
      }
      // Everything overdue sealed on boot; only the newest is still live.
      expect(boot.sealed_on_boot).toHaveLength(n - 1);
      expect(boot.still_open).toHaveLength(1);
      for (const id of boot.sealed_on_boot) {
        const sealed = boot.sessions.find((s) => s.id === id)!;
        expect(sealed.status).toBe("sealed");
        expect(sealed.content_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  }

  it("seals nothing when the worker comes back inside every window", () => {
    const { sessions, events } = openSessions(3);
    const boot = recomputeTimers(sessions, { policy: POLICY, run_mode: "steady", now: T0 }, texts(events));
    expect(boot.sealed_on_boot).toEqual([]);
    expect(boot.still_open).toHaveLength(3);
  });

  it("does not restart the debounce clock — a reboot is invisible to the outcome", () => {
    const { sessions, events } = openSessions(1);
    const late = T0 + 46 * MINUTE;
    const first = recomputeTimers(sessions, { policy: POLICY, run_mode: "steady", now: late }, texts(events));
    const second = recomputeTimers(sessions, { policy: POLICY, run_mode: "steady", now: late }, texts(events));
    expect(first.sealed_on_boot).toEqual(second.sealed_on_boot);
    expect(first.sessions[0]!.sealed_at).toBe(second.sessions[0]!.sealed_at);
  });
});

describe("the hash gate", () => {
  const events = [ev(1, 0, "self")];
  const sealed = sealSession(walk(events)[0]!, {
    mode: "immediate",
    reason: "gap",
    at: T0,
    texts: texts(events),
  });

  it("skips a session already understood at this hash", () => {
    expect(hashGate(sealed, new Set([sealed.content_hash!])).skip).toBe(true);
  });

  it("does not skip an unseen hash, or an unsealed session", () => {
    expect(hashGate(sealed, new Set(["other"])).skip).toBe(false);
    expect(hashGate(walk(events)[0]!, new Set([sealed.content_hash!])).skip).toBe(false);
  });
});

describe("determinism", () => {
  const events = [ev(1, 0, "self"), ev(2, 7 * HOUR, "a1"), ev(3, 7 * HOUR + MINUTE, "self")];

  for (const run of [1, 2, 3, 4]) {
    it(`re-segmenting and re-sealing with identical params is byte-identical (run ${run})`, () => {
      const once = sealStream(walk(events), { policy: POLICY, run_mode: "bootstrap", now: T0 + 9 * HOUR }, texts(events));
      const twice = sealStream(
        walk([...events].reverse()),
        { policy: POLICY, run_mode: "bootstrap", now: T0 + 9 * HOUR },
        texts(events),
      );
      expect(JSON.stringify(twice.sessions)).toBe(JSON.stringify(once.sessions));
    });
  }
});
