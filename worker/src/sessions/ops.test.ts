import { describe, expect, it } from "vitest";

import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { resolvePolicy, type SessionPolicy } from "./policies.js";
import {
  applyEdit,
  applyReaction,
  applyRevoke,
  clampSkew,
  COHORT_STAGES,
  isCohortStage,
  isDroppedAtAdapter,
  lateArrival,
  resumeCohort,
  SKEW_TOLERANCE_MS,
  supersede,
} from "./ops.js";
import { debounceDeadline, sealSession, sealStream, textIndex, type HashableEvent } from "./seal.js";
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

function texts(events: SegEvent[]): Map<string, HashableEvent> {
  return textIndex(events.map((e) => ({ external_id: e.external_id, text: e.text })));
}

function world(events: SegEvent[], seal: boolean): { sessions: SegSession[]; texts: Map<string, HashableEvent> } {
  const t = texts(events);
  const walked = segment({ stream: { key: "c1", tz: "UTC" }, policy: POLICY, events, run_mode: "steady" }).sessions;
  if (!seal) return { sessions: walked, texts: t };
  const sealed = sealStream(walked, { policy: POLICY, run_mode: "bootstrap", now: T0 + 48 * HOUR }, t);
  return { sessions: sealed.sessions, texts: t };
}

// ---- note 5 + note 9: the adapter's guards --------------------------------

describe("§10.4 note 5 · read receipts and delivery events are not events", () => {
  it("drops protocol chatter and keeps content", () => {
    for (const kind of ["receipt", "read_receipt", "delivery", "typing", "presence"]) {
      expect(isDroppedAtAdapter(kind)).toBe(true);
    }
    for (const kind of ["message", "image", "reaction", "revoked", "call"]) {
      expect(isDroppedAtAdapter(kind)).toBe(false);
    }
  });
});

describe("§10.4 note 9 · clock skew is clamped and flagged", () => {
  it("accepts anything at or under now + 5 min verbatim", () => {
    expect(clampSkew(at(0), T0 + HOUR).clamped).toBe(false);
    expect(clampSkew(at(SKEW_TOLERANCE_MS), T0).clamped).toBe(false);
  });

  it("clamps a further future and keeps what the source claimed", () => {
    const verdict = clampSkew(at(3 * HOUR), T0);
    expect(verdict.clamped).toBe(true);
    expect(verdict.ts).toBe(at(0));
    expect(verdict.clamped_from).toBe(at(3 * HOUR));
  });
});

// ---- note 2: reactions ----------------------------------------------------

describe("§10.4 note 2 · reactions attach, never open, never reset the debounce", () => {
  const events = [ev(1, 0, "self"), ev(2, MINUTE, "a1")];

  for (const hours of [3, 4, 5, 6, 7, 8]) {
    it(`a reaction ${hours}h after its parent attaches to the SEALED parent session`, () => {
      const w = world(events, true);
      const before = w.sessions[0]!;
      const r = applyReaction(w.sessions, {
        external_id: `r${hours}`,
        parent_external_id: "e2",
      });
      expect(r.attached_to).toBe(before.id);
      expect(r.new_sessions).toBe(0);
      expect(r.debounce_reset).toBe(false);
      expect(r.membership_changed).toBe(false);
      expect(r.hash_changed).toBe(false);

      const after = r.sessions[0]!;
      expect(after.attachments).toEqual([`r${hours}`]);
      // Membership and hash are exactly what they were.
      expect(after.event_ids).toEqual(before.event_ids);
      expect(after.content_hash).toBe(before.content_hash);
      // And the debounce deadline has not moved — a 👍 is not a turn.
      expect(debounceDeadline(after, POLICY)).toBe(debounceDeadline(before, POLICY));
    });
  }

  it("attaches to an OPEN session too, still without resetting anything", () => {
    const w = world(events, false);
    const r = applyReaction(w.sessions, { external_id: "r1", parent_external_id: "e1" });
    expect(r.attached_to).toBe(w.sessions[0]!.id);
    expect(r.sessions[0]!.event_ids).toEqual(["e1", "e2"]);
    expect(debounceDeadline(r.sessions[0]!, POLICY)).toBe(debounceDeadline(w.sessions[0]!, POLICY));
  });

  it("attaches nothing when the parent is not in any session", () => {
    const w = world(events, true);
    const r = applyReaction(w.sessions, { external_id: "r1", parent_external_id: "ghost" });
    expect(r.attached_to).toBeNull();
    expect(r.sessions[0]!.attachments).toEqual([]);
  });

  it("is idempotent — the same reaction delivered twice attaches once", () => {
    const w = world(events, true);
    const once = applyReaction(w.sessions, { external_id: "r1", parent_external_id: "e1" });
    const twice = applyReaction(once.sessions, { external_id: "r1", parent_external_id: "e1" });
    expect(twice.sessions[0]!.attachments).toEqual(["r1"]);
  });
});

// ---- note 3: edits --------------------------------------------------------

describe("§10.4 note 3 · edits", () => {
  const events = [ev(1, 0, "self"), ev(2, MINUTE, "a1")];

  for (const n of [1, 2, 3, 4]) {
    it(`edit ${n} to a message in an OPEN session mutates in place; no hash exists yet`, () => {
      const w = world(events, false);
      const r = applyEdit(w.sessions, w.texts, { target_external_id: "e2", text: `edited ${n}` });
      expect(r.was_sealed).toBe(false);
      expect(r.mutated_in_place).toBe(true);
      expect(r.superseded).toBe(false);
      expect(r.membership_changed).toBe(false);
      expect(r.content_hash).toBeNull();
      expect(w.texts.get("e2")!.text).toBe(`edited ${n}`);

      // Sealing AFTER the edit hashes the edited text — the old body was never
      // published, so nothing was superseded.
      const sealed = sealSession(r.sessions[0]!, {
        mode: "debounce",
        reason: "debounce",
        at: T0 + HOUR,
        texts: w.texts,
      });
      expect(sealed.superseded_hash).toBeNull();
      expect(sealed.event_ids).toEqual(["e1", "e2"]);
    });
  }

  for (const n of [1, 2, 3, 4]) {
    it(`edit ${n} arriving AFTER the seal supersedes without touching membership`, () => {
      const w = world(events, true);
      const before = w.sessions[0]!;
      const r = applyEdit(w.sessions, w.texts, {
        target_external_id: "e2",
        external_id: `edit${n}`,
        text: `edited ${n}`,
      });
      expect(r.was_sealed).toBe(true);
      expect(r.mutated_in_place).toBe(false);
      expect(r.superseded).toBe(true);
      expect(r.membership_changed).toBe(false);
      expect(r.previous_hash).toBe(before.content_hash);
      expect(r.content_hash).not.toBe(before.content_hash);
      expect(r.attached_to_parent).toBe(true);

      const after = r.sessions[0]!;
      expect(after.superseded_hash).toBe(before.content_hash);
      expect(after.content_hash).toBe(r.content_hash);
      expect(after.event_ids).toEqual(before.event_ids);
      expect(after.attachments).toEqual([`edit${n}`]);
      expect(after.status).toBe("sealed");
    });
  }

  it("does not move the hash when the edit changed nothing", () => {
    const w = world(events, true);
    const before = w.sessions[0]!;
    const r = applyEdit(w.sessions, w.texts, { target_external_id: "e2", text: "msg 2" });
    expect(r.content_hash).toBe(before.content_hash);
    expect(r.sessions[0]!.superseded_hash).toBeNull();
  });

  it("reports nothing when the edited event belongs to no session", () => {
    const w = world(events, true);
    const r = applyEdit(w.sessions, w.texts, { target_external_id: "ghost", text: "x" });
    expect(r.session_id).toBeNull();
    expect(r.superseded).toBe(false);
  });
});

// ---- note 4: revokes ------------------------------------------------------

describe("§10.4 note 4 · revokes", () => {
  const events = [ev(1, 0, "self"), ev(2, MINUTE, "a1")];

  it("clears the body of an event in an OPEN session, membership unchanged", () => {
    const w = world(events, false);
    const r = applyRevoke(w.sessions, w.texts, { target_external_id: "e2" });
    expect(r.was_sealed).toBe(false);
    expect(r.membership_changed).toBe(false);
    expect(w.texts.get("e2")!.text).toBe("");
    expect(r.sessions[0]!.event_ids).toEqual(["e1", "e2"]);
  });

  for (const n of [1, 2]) {
    it(`revoke ${n} in a SEALED session sets superseded_hash and keeps membership`, () => {
      const w = world(events, true);
      const before = w.sessions[0]!;
      const r = applyRevoke(w.sessions, w.texts, { target_external_id: "e2", external_id: `rev${n}` });
      expect(r.was_sealed).toBe(true);
      expect(r.superseded).toBe(true);
      expect(r.membership_changed).toBe(false);
      expect(r.sessions[0]!.superseded_hash).toBe(before.content_hash);
      expect(r.sessions[0]!.event_ids).toEqual(before.event_ids);
      expect(w.texts.get("e2")!.text).toBe("");
    });
  }

  it("supersede is a no-op when the content did not actually move", () => {
    const w = world(events, true);
    const sealed = w.sessions[0]!;
    const same = supersede(sealed, [
      { external_id: "e1", text: "msg 1" },
      { external_id: "e2", text: "msg 2" },
    ]);
    expect(same).toBe(sealed);
  });
});

// ---- note 8: late arrivals ------------------------------------------------

describe("§10.4 note 8 · a sealed session is never reopened", () => {
  const events = [ev(1, 0, "self"), ev(2, 30 * MINUTE, "a1"), ev(3, 60 * MINUTE, "self")];

  for (const minutes of [5, 15, 25, 40, 55]) {
    it(`an event backfilled at +${minutes}m inside a sealed range becomes a NEW late_arrival session`, () => {
      const w = world(events, true);
      const sealed = w.sessions[0]!;
      expect(sealed.status).toBe("sealed");

      const late = ev(99, minutes * MINUTE, "a1", { external_id: "late1", text: "arrived late" });
      const r = lateArrival(w.sessions, late, { key: "c1", tz: "UTC" }, POLICY);

      expect(r.reopened).toBe(false);
      expect(r.overlap_of).toBe(sealed.id);
      expect(r.session!.late_arrival).toBe(true);
      expect(r.session!.overlap_of).toBe(sealed.id);
      expect(r.session!.boundary_reason_start).toBe("late_arrival");
      expect(r.session!.event_ids).toEqual(["late1"]);
      expect(r.session!.boundary_params.start).toMatchObject({
        rule: "late_arrival",
        overlap_of: sealed.id,
      });

      // The sealed session is byte-for-byte what it was.
      expect(w.sessions[0]!.event_ids).toEqual(sealed.event_ids);
      expect(w.sessions[0]!.content_hash).toBe(sealed.content_hash);
      expect(w.sessions[0]!.status).toBe("sealed");
    });
  }

  it("does nothing for an event that lands outside every sealed range", () => {
    const w = world(events, true);
    const later = ev(99, 10 * HOUR, "a1", { external_id: "later" });
    const r = lateArrival(w.sessions, later, { key: "c1", tz: "UTC" }, POLICY);
    expect(r.session).toBeNull();
    expect(r.overlap_of).toBeNull();
  });

  it("ignores an OPEN session's range — only a sealed one forces a late arrival", () => {
    const w = world(events, false);
    const late = ev(99, 10 * MINUTE, "a1", { external_id: "late1" });
    expect(lateArrival(w.sessions, late, { key: "c1", tz: "UTC" }, POLICY).session).toBeNull();
  });
});

// ---- note 7 (second half): cohort resume ----------------------------------

describe("§10.4 note 7 · an in-flight cohort resumes at its last completed stage", () => {
  it("lists the stages the work queue documents", () => {
    expect([...COHORT_STAGES]).toEqual([
      "enrich",
      "entity",
      "segment",
      "episode",
      "arc",
      "extract",
      "triage",
      "derive",
      "done",
    ]);
    expect(isCohortStage("enrich")).toBe(true);
    expect(isCohortStage("vibes")).toBe(false);
  });

  for (const [stage, lastCompleted, reused] of [
    ["enrich", null, []],
    ["entity", "enrich", ["enrich"]],
    ["segment", "entity", ["enrich", "entity"]],
    ["episode", "segment", ["enrich", "entity", "segment"]],
    ["extract", "arc", ["enrich", "entity", "segment", "episode", "arc"]],
  ] as const) {
    it(`quitting at '${stage}' resumes there and reuses ${reused.length} stage(s)`, () => {
      const r = resumeCohort(stage);
      expect(r.resume_at).toBe(stage);
      expect(r.last_completed).toBe(lastCompleted);
      expect(r.reused).toEqual([...reused]);
      // Nothing is re-judged. A stored verdict is what the model actually said.
      expect(r.rejudged).toEqual([]);
    });
  }

  it("starts from the beginning when the stage is not one we know", () => {
    const r = resumeCohort("nonsense");
    expect(r.resume_at).toBe("enrich");
    expect(r.last_completed).toBeNull();
    expect(r.reused).toEqual([]);
  });
});

// ---- determinism ----------------------------------------------------------

describe("determinism across ops", () => {
  const events = [ev(1, 0, "self"), ev(2, MINUTE, "a1")];

  for (const run of [1, 2, 3, 4]) {
    it(`the same ops over the same sessions produce identical bytes (run ${run})`, () => {
      const a = world(events, true);
      const b = world(events, true);
      const opsA = applyEdit(
        applyReaction(a.sessions, { external_id: "r1", parent_external_id: "e1" }).sessions,
        a.texts,
        { target_external_id: "e2", external_id: "edit1", text: "edited" },
      );
      const opsB = applyEdit(
        applyReaction(b.sessions, { external_id: "r1", parent_external_id: "e1" }).sessions,
        b.texts,
        { target_external_id: "e2", external_id: "edit1", text: "edited" },
      );
      expect(JSON.stringify(opsB.sessions)).toBe(JSON.stringify(opsA.sessions));
    });
  }
});
