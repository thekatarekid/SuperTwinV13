// ===========================================================================
// Perceptual dedupe scaffold (build item 1.3, arch §10.2 stage ②).
//
// Three claims:
//   - with the no-op hasher (WhatsApp) nothing is ever a duplicate;
//   - with a real hasher near neighbours inside the window are REPORTED, and
//     reporting is all that happens — `admit` has no way to delete anything;
//   - streams are kept apart, so the same picture in two chats stays two events.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEDUPE_DISTANCE,
  DedupeError,
  NO_OP_HASHER,
  NO_OP_HASHER_ID,
  PerceptualDedupe,
  getHasher,
  hamming,
  isPhash,
  listHashers,
  registerHasher,
  resetHashers,
  type Phash,
  type PerceptualHashInput,
  type PerceptualHasher,
} from "./dedupe.js";

/** A hasher that just echoes a hash planted on the input's `path`. */
function scriptedHasher(id = "scripted"): PerceptualHasher {
  return {
    id,
    hashes: true,
    hash(input: PerceptualHashInput): Phash | null {
      return (input.path as Phash | undefined) ?? null;
    },
  };
}

const A: Phash = "0000000000000000";
const A_NEAR: Phash = "0000000000000003"; // 2 bits away
const A_FAR: Phash = "ffffffffffffffff"; // 64 bits away
const frame = (hash: string): PerceptualHashInput => ({ media_kind: "frame", path: hash });

describe("phash primitives", () => {
  it("accepts 16 lowercase hex chars and nothing else", () => {
    expect(isPhash(A)).toBe(true);
    expect(isPhash("ABCDEF0123456789")).toBe(false);
    expect(isPhash("0123")).toBe(false);
    expect(isPhash(null)).toBe(false);
  });

  it("counts bit distance", () => {
    expect(hamming(A, A)).toBe(0);
    expect(hamming(A, A_NEAR)).toBe(2);
    expect(hamming(A, A_FAR)).toBe(64);
  });

  it("throws on a malformed hash rather than reporting max distance", () => {
    expect(() => hamming(A, "nope" as Phash)).toThrow(DedupeError);
  });
});

describe("the WhatsApp no-op", () => {
  it("hashes nothing", () => {
    expect(NO_OP_HASHER.hashes).toBe(false);
    expect(NO_OP_HASHER.hash({ media_kind: "image", path: "/x.jpg" })).toBeNull();
  });

  it("never reports a duplicate, not even for the identical frame twice", () => {
    const d = new PerceptualDedupe();
    expect(d.active).toBe(false);
    const first = d.admit("st:mom", "ev1", frame(A));
    const second = d.admit("st:mom", "ev2", frame(A));
    for (const v of [first, second]) {
      expect(v.duplicate).toBe(false);
      expect(v.of_event_id).toBeNull();
      expect(v.hash).toBeNull();
      expect(v.hasher).toBe(NO_OP_HASHER_ID);
    }
  });

  it("keeps no window at all, so an idle source costs no memory", () => {
    const d = new PerceptualDedupe();
    d.admit("st:mom", "ev1", frame(A));
    expect(d.size("st:mom")).toBe(0);
  });
});

describe("with a real hasher", () => {
  it("reports a near neighbour and names the event it repeats", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher() });
    expect(d.admit("st:screen", "ev1", frame(A)).duplicate).toBe(false);
    const v = d.admit("st:screen", "ev2", frame(A_NEAR));
    expect(v.duplicate).toBe(true);
    expect(v.of_event_id).toBe("ev1");
    expect(v.distance).toBe(2);
    expect(v.hash).toBe(A_NEAR);
  });

  it("leaves a distant frame alone", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher() });
    d.admit("st:screen", "ev1", frame(A));
    const v = d.admit("st:screen", "ev2", frame(A_FAR));
    expect(v.duplicate).toBe(false);
    expect(v.of_event_id).toBeNull();
    expect(v.hash).toBe(A_FAR);
  });

  it("honours a tightened threshold", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher(), max_distance: 1 });
    d.admit("st:screen", "ev1", frame(A));
    expect(d.admit("st:screen", "ev2", frame(A_NEAR)).duplicate).toBe(false);
  });

  it("does not collapse the same picture shared in two streams", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher() });
    d.admit("st:mom", "ev1", frame(A));
    expect(d.admit("st:work", "ev2", frame(A)).duplicate).toBe(false);
  });

  it("compares against the most recent frame in a drifting run", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher(), max_distance: 2 });
    d.admit("st:screen", "ev1", frame("0000000000000000"));
    const second = d.admit("st:screen", "ev2", frame("0000000000000003"));
    const third = d.admit("st:screen", "ev3", frame("000000000000000f"));
    expect(second.of_event_id).toBe("ev1");
    expect(third.of_event_id).toBe("ev2");
  });

  it("keeps the window bounded", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher(), window: 2 });
    d.admit("st:screen", "ev1", frame(A));
    d.admit("st:screen", "ev2", frame("ffffffffffffffff"));
    d.admit("st:screen", "ev3", frame("fffffffffffffffc"));
    expect(d.size("st:screen")).toBe(2);
    // ev1 has aged out, so an exact repeat of it is no longer a duplicate.
    expect(d.admit("st:screen", "ev4", frame(A)).duplicate).toBe(false);
  });

  it("forgets a stream on request and clears everything on reset", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher() });
    d.admit("st:a", "ev1", frame(A));
    d.admit("st:b", "ev2", frame(A));
    d.forget("st:a");
    expect(d.size("st:a")).toBe(0);
    expect(d.size("st:b")).toBe(1);
    d.clear();
    expect(d.size("st:b")).toBe(0);
  });

  it("rejects a hasher that answers with the wrong width", () => {
    const bad: PerceptualHasher = { id: "bad", hashes: true, hash: () => "xyz" as Phash };
    const d = new PerceptualDedupe({ hasher: bad });
    expect(() => d.admit("st:screen", "ev1", frame(A))).toThrow(/16 lowercase hex/);
  });

  it("treats a null hash as 'cannot answer', not as an error", () => {
    const d = new PerceptualDedupe({ hasher: scriptedHasher() });
    const v = d.admit("st:screen", "ev1", { media_kind: "doc" });
    expect(v.duplicate).toBe(false);
    expect(v.hash).toBeNull();
  });

  it("validates its own options", () => {
    expect(() => new PerceptualDedupe({ max_distance: 65 })).toThrow(DedupeError);
    expect(() => new PerceptualDedupe({ window: 0 })).toThrow(DedupeError);
    expect(DEFAULT_DEDUPE_DISTANCE).toBe(6);
  });
});

describe("hasher registry", () => {
  it("resolves a registered hasher and refuses to shadow the no-op", () => {
    const h = scriptedHasher("phash64");
    registerHasher(h);
    expect(getHasher("phash64")).toBe(h);
    expect(() => registerHasher(scriptedHasher(NO_OP_HASHER_ID))).toThrow(/reserved/);
    resetHashers();
    expect(listHashers()).toEqual([NO_OP_HASHER_ID]);
  });

  it("throws on an unknown id", () => {
    expect(() => getHasher("dhash")).toThrow(DedupeError);
  });
});
